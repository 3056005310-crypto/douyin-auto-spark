import type { GuardRecord, InstallationRecord, SessionUser } from "./types";

const SESSION_COOKIE = "watchdog_session";
const STATE_COOKIE = "watchdog_oauth_state";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(data);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;

  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function secureCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createAuthState(db: D1Database): Promise<{
  state: string;
  cookie: string;
}> {
  const state = randomToken();
  const stateHash = await sha256Hex(state);
  const now = Date.now();
  const expiresAt = new Date(now + 10 * 60_000).toISOString();

  await db
    .prepare(
      `INSERT INTO auth_states (state_hash, created_at, expires_at)
       VALUES (?, ?, ?)`,
    )
    .bind(stateHash, new Date(now).toISOString(), expiresAt)
    .run();

  return {
    state,
    cookie: secureCookie(STATE_COOKIE, state, 10 * 60),
  };
}

export async function consumeAuthState(
  db: D1Database,
  request: Request,
  returnedState: string,
): Promise<boolean> {
  const cookieState = cookieValue(request, STATE_COOKIE);
  if (!cookieState || cookieState !== returnedState) return false;

  const stateHash = await sha256Hex(returnedState);
  const row = await db
    .prepare(
      `SELECT state_hash
       FROM auth_states
       WHERE state_hash = ? AND expires_at > ?`,
    )
    .bind(stateHash, new Date().toISOString())
    .first<{ state_hash: string }>();

  if (!row) return false;
  await db.prepare("DELETE FROM auth_states WHERE state_hash = ?").bind(stateHash).run();
  return true;
}

export async function upsertUser(
  db: D1Database,
  githubUser: { id: number; login: string; avatar_url: string | null },
): Promise<number> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO users (github_user_id, login, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(github_user_id) DO UPDATE SET
         login = excluded.login,
         avatar_url = excluded.avatar_url,
         updated_at = excluded.updated_at`,
    )
    .bind(githubUser.id, githubUser.login, githubUser.avatar_url, now, now)
    .run();

  const row = await db
    .prepare("SELECT id FROM users WHERE github_user_id = ?")
    .bind(githubUser.id)
    .first<{ id: number }>();

  if (!row) throw new Error("Failed to persist GitHub user");
  return row.id;
}

export async function replaceInstallations(
  db: D1Database,
  userId: number,
  installations: InstallationRecord[],
): Promise<void> {
  await db.prepare("DELETE FROM user_installations WHERE user_id = ?").bind(userId).run();
  const now = new Date().toISOString();

  for (const installation of installations) {
    await db
      .prepare(
        `INSERT INTO user_installations (
          user_id, installation_id, account_login, account_type,
          repository_selection, permissions_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId,
        installation.installationId,
        installation.accountLogin,
        installation.accountType,
        installation.repositorySelection,
        JSON.stringify(installation.permissions),
        now,
      )
      .run();
  }
}

export async function createSession(db: D1Database, userId: number): Promise<string> {
  const raw = randomToken();
  const hash = await sha256Hex(raw);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000);

  await db
    .prepare(
      `INSERT INTO sessions (id_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(hash, userId, now.toISOString(), expiresAt.toISOString())
    .run();

  return secureCookie(SESSION_COOKIE, raw, 30 * 24 * 60 * 60);
}

export async function getSessionUser(
  db: D1Database,
  request: Request,
): Promise<SessionUser | null> {
  const raw = cookieValue(request, SESSION_COOKIE);
  if (!raw) return null;
  const hash = await sha256Hex(raw);

  const row = await db
    .prepare(
      `SELECT u.id, u.github_user_id, u.login, u.avatar_url
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .bind(hash, new Date().toISOString())
    .first<{
      id: number;
      github_user_id: number;
      login: string;
      avatar_url: string | null;
    }>();

  if (!row) return null;
  return {
    id: row.id,
    githubUserId: row.github_user_id,
    login: row.login,
    avatarUrl: row.avatar_url,
  };
}

export async function deleteSession(db: D1Database, request: Request): Promise<void> {
  const raw = cookieValue(request, SESSION_COOKIE);
  if (!raw) return;
  const hash = await sha256Hex(raw);
  await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(hash).run();
}

export async function listUserInstallations(
  db: D1Database,
  userId: number,
): Promise<InstallationRecord[]> {
  const result = await db
    .prepare(
      `SELECT installation_id, account_login, account_type,
              repository_selection, permissions_json
       FROM user_installations
       WHERE user_id = ?
       ORDER BY account_login`,
    )
    .bind(userId)
    .all<{
      installation_id: number;
      account_login: string;
      account_type: string;
      repository_selection: string;
      permissions_json: string;
    }>();

  return result.results.map((row) => ({
    installationId: row.installation_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection: row.repository_selection,
    permissions: JSON.parse(row.permissions_json) as Record<string, string>,
  }));
}

export async function userOwnsInstallation(
  db: D1Database,
  userId: number,
  installationId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM user_installations
       WHERE user_id = ? AND installation_id = ?`,
    )
    .bind(userId, installationId)
    .first<{ ok: number }>();
  return Boolean(row);
}

export async function listUserGuards(db: D1Database, userId: number): Promise<GuardRecord[]> {
  const result = await db
    .prepare("SELECT * FROM guards WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<GuardRecord>();
  return result.results;
}

export async function cleanupExpiredRows(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all([
    db.prepare("DELETE FROM auth_states WHERE expires_at <= ?").bind(now).run(),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run(),
  ]);
}
