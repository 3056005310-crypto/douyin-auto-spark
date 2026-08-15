import {
  cleanupExpiredRows,
  clearCookie,
  consumeAuthState,
  createAuthState,
  createSession,
  deleteSession,
  getSessionUser,
  listUserGuards,
  listUserInstallations as listStoredInstallations,
  replaceInstallations,
  upsertUser,
  userOwnsInstallation,
} from "./db";
import {
  exchangeOAuthCode,
  getAuthenticatedUser,
  listInstallationRepositories,
  listUserInstallations,
  listWorkflows,
} from "./github";
import type { Env, GuardRecord, InstallationRecord } from "./types";
import { checkGuard, runScheduledWatchdog } from "./watchdog";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 404 });
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/auth/start") {
        return startAuth(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/auth/callback") {
        return finishAuth(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        await deleteSession(env.DB, request);
        const headers = new Headers(JSON_HEADERS);
        headers.append("Set-Cookie", clearCookie("watchdog_session"));
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      const user = await getSessionUser(env.DB, request);
      if (!user) return json({ error: "unauthorized" }, 401);

      if (request.method === "GET" && url.pathname === "/api/me") {
        const installations = await listStoredInstallations(env.DB, user.id);
        return json({
          user,
          installations,
          appSlug: env.GITHUB_APP_SLUG,
        });
      }

      if (request.method === "GET" && url.pathname === "/api/repos") {
        const installationId = positiveInt(url.searchParams.get("installation_id"));
        await requireInstallation(env, user.id, installationId);
        const repositories = await listInstallationRepositories(env, installationId);
        return json({
          repositories: repositories.map((repo) => ({
            id: repo.id,
            name: repo.name,
            fullName: repo.full_name,
            owner: repo.owner.login,
            defaultBranch: repo.default_branch,
            private: repo.private,
          })),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/workflows") {
        const installationId = positiveInt(url.searchParams.get("installation_id"));
        const owner = requiredText(url.searchParams.get("owner"), "owner");
        const repo = requiredText(url.searchParams.get("repo"), "repo");
        await requireInstallation(env, user.id, installationId);
        const workflows = await listWorkflows(env, installationId, owner, repo);
        return json({
          workflows: workflows
            .filter((workflow) => workflow.state === "active")
            .map((workflow) => ({
              id: workflow.id,
              name: workflow.name,
              path: workflow.path,
              state: workflow.state,
            })),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/guards") {
        const guards = await listUserGuards(env.DB, user.id);
        return json({ guards: guards.map(serializeGuard) });
      }

      if (request.method === "POST" && url.pathname === "/api/guards") {
        return createGuard(request, env, user.id);
      }

      const guardMatch = url.pathname.match(/^\/api\/guards\/([^/]+)$/u);
      if (guardMatch && request.method === "PATCH") {
        const guard = await requireGuard(env.DB, user.id, guardMatch[1]);
        const body = (await request.json()) as { enabled?: boolean };
        if (typeof body.enabled !== "boolean") {
          return json({ error: "enabled must be boolean" }, 400);
        }
        await env.DB.prepare(
          "UPDATE guards SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        )
          .bind(body.enabled ? 1 : 0, new Date().toISOString(), guard.id, user.id)
          .run();
        return json({ ok: true });
      }

      if (guardMatch && request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM guards WHERE id = ? AND user_id = ?")
          .bind(guardMatch[1], user.id)
          .run();
        return json({ ok: true });
      }

      const checkMatch = url.pathname.match(/^\/api\/guards\/([^/]+)\/check$/u);
      if (checkMatch && request.method === "POST") {
        const guard = await requireGuard(env.DB, user.id, checkMatch[1]);
        return json(await checkGuard(env, guard));
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 500);
    }
  },

  scheduled(_controller, env, ctx): void {
    ctx.waitUntil(cleanupExpiredRows(env.DB).then(() => runScheduledWatchdog(env)));
  },
} satisfies ExportedHandler<Env>;

async function startAuth(request: Request, env: Env): Promise<Response> {
  const { state, cookie } = await createAuthState(env.DB);
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") === "login" ? "login" : "install";
  const callback = `${baseUrl(request, env)}/api/auth/callback`;

  const target =
    mode === "login"
      ? new URL("https://github.com/login/oauth/authorize")
      : new URL(
          `https://github.com/apps/${encodeURIComponent(requiredText(env.GITHUB_APP_SLUG, "GITHUB_APP_SLUG"))}/installations/new`,
        );

  if (mode === "login") {
    target.searchParams.set("client_id", requiredText(env.GITHUB_CLIENT_ID, "GITHUB_CLIENT_ID"));
    target.searchParams.set("redirect_uri", callback);
  }
  target.searchParams.set("state", state);

  const headers = new Headers({ Location: target.toString() });
  headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

async function finishAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = requiredText(url.searchParams.get("code"), "code");
  const state = requiredText(url.searchParams.get("state"), "state");

  if (!(await consumeAuthState(env.DB, request, state))) {
    return json({ error: "invalid_or_expired_oauth_state" }, 400);
  }

  const userToken = await exchangeOAuthCode(env, code);
  const [githubUser, githubInstallations] = await Promise.all([
    getAuthenticatedUser(userToken),
    listUserInstallations(userToken),
  ]);

  const appId = Number(requiredText(env.GITHUB_APP_ID, "GITHUB_APP_ID"));
  const installations: InstallationRecord[] = githubInstallations
    .filter((installation) => installation.app_id === appId)
    .map((installation) => ({
      installationId: installation.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
      repositorySelection: installation.repository_selection,
      permissions: installation.permissions,
    }));

  const userId = await upsertUser(env.DB, githubUser);
  await replaceInstallations(env.DB, userId, installations);
  const sessionCookie = await createSession(env.DB, userId);

  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", sessionCookie);
  headers.append("Set-Cookie", clearCookie("watchdog_oauth_state"));
  return new Response(null, { status: 302, headers });
}

async function createGuard(request: Request, env: Env, userId: number): Promise<Response> {
  const body = (await request.json()) as {
    installationId?: number;
    repoId?: number;
    owner?: string;
    repo?: string;
    workflowId?: number;
    ref?: string;
    timezone?: string;
    expectedHour?: number;
    expectedMinute?: number;
    graceMinutes?: number;
    cooldownMinutes?: number;
    maxAttempts?: number;
  };

  const installationId = positiveInt(body.installationId);
  const repoId = positiveInt(body.repoId);
  const workflowId = positiveInt(body.workflowId);
  const owner = requiredText(body.owner, "owner");
  const repo = requiredText(body.repo, "repo");
  await requireInstallation(env, userId, installationId);

  const repositories = await listInstallationRepositories(env, installationId);
  const repository = repositories.find(
    (candidate) =>
      candidate.id === repoId && candidate.owner.login === owner && candidate.name === repo,
  );
  if (!repository) return json({ error: "repository_not_in_installation" }, 400);

  const workflows = await listWorkflows(env, installationId, owner, repo);
  const workflow = workflows.find(
    (candidate) => candidate.id === workflowId && candidate.state === "active",
  );
  if (!workflow) return json({ error: "workflow_not_found_or_inactive" }, 400);

  const expectedHour = intRange(body.expectedHour ?? 0, 0, 23, "expectedHour");
  const expectedMinute = intRange(body.expectedMinute ?? 17, 0, 59, "expectedMinute");
  const graceMinutes = intRange(body.graceMinutes ?? 90, 0, 12 * 60, "graceMinutes");
  const cooldownMinutes = intRange(body.cooldownMinutes ?? 90, 1, 24 * 60, "cooldownMinutes");
  const maxAttempts = intRange(body.maxAttempts ?? 3, 1, 10, "maxAttempts");
  const timezone = requiredText(body.timezone ?? "Asia/Shanghai", "timezone");
  validateTimezone(timezone);
  const ref = requiredText(body.ref ?? repository.default_branch, "ref");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO guards (
      id, user_id, installation_id, repo_id, owner, repo,
      workflow_id, workflow_name, workflow_path, ref, timezone,
      expected_hour, expected_minute, grace_minutes, cooldown_minutes,
      max_attempts, enabled, last_status, attempts_today, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'new', 0, ?, ?)
    ON CONFLICT(user_id, installation_id, repo_id, workflow_id) DO UPDATE SET
      workflow_name = excluded.workflow_name,
      workflow_path = excluded.workflow_path,
      ref = excluded.ref,
      timezone = excluded.timezone,
      expected_hour = excluded.expected_hour,
      expected_minute = excluded.expected_minute,
      grace_minutes = excluded.grace_minutes,
      cooldown_minutes = excluded.cooldown_minutes,
      max_attempts = excluded.max_attempts,
      enabled = 1,
      updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      userId,
      installationId,
      repository.id,
      owner,
      repo,
      workflow.id,
      workflow.name,
      workflow.path,
      ref,
      timezone,
      expectedHour,
      expectedMinute,
      graceMinutes,
      cooldownMinutes,
      maxAttempts,
      now,
      now,
    )
    .run();

  const guards = await listUserGuards(env.DB, userId);
  const saved = guards.find(
    (guard) =>
      guard.installation_id === installationId &&
      guard.repo_id === repository.id &&
      guard.workflow_id === workflow.id,
  );
  return json({ guard: saved ? serializeGuard(saved) : null }, 201);
}

async function requireInstallation(
  env: Env,
  userId: number,
  installationId: number,
): Promise<void> {
  if (!(await userOwnsInstallation(env.DB, userId, installationId))) {
    throw new Error("installation_not_available_to_user");
  }
}

async function requireGuard(db: D1Database, userId: number, id: string): Promise<GuardRecord> {
  const guard = await db
    .prepare("SELECT * FROM guards WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<GuardRecord>();
  if (!guard) throw new Error("guard_not_found");
  return guard;
}

function serializeGuard(guard: GuardRecord) {
  return {
    id: guard.id,
    installationId: guard.installation_id,
    repoId: guard.repo_id,
    owner: guard.owner,
    repo: guard.repo,
    workflowId: guard.workflow_id,
    workflowName: guard.workflow_name,
    workflowPath: guard.workflow_path,
    ref: guard.ref,
    timezone: guard.timezone,
    expectedHour: guard.expected_hour,
    expectedMinute: guard.expected_minute,
    graceMinutes: guard.grace_minutes,
    cooldownMinutes: guard.cooldown_minutes,
    maxAttempts: guard.max_attempts,
    enabled: Boolean(guard.enabled),
    lastStatus: guard.last_status,
    lastError: guard.last_error,
    lastCheckedAt: guard.last_checked_at,
    lastActionAt: guard.last_action_at,
    attemptsToday: guard.attempts_today,
    attemptDate: guard.attempt_date,
    lastSuccessDate: guard.last_success_date,
  };
}

function baseUrl(request: Request, env: Env): string {
  return (env.WATCHDOG_BASE_URL ?? new URL(request.url).origin).replace(/\/$/u, "");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: JSON_HEADERS,
  });
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function positiveInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("expected positive integer");
  }
  return parsed;
}

function intRange(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new Error("invalid_timezone");
  }
}
