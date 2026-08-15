import type {
  Env,
  GithubInstallation,
  GithubRepository,
  GithubWorkflow,
  GithubWorkflowRun,
} from "./types";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";

function githubHeaders(token?: string): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "douyin-auto-spark-watchdog",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function githubRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = githubHeaders(token);
  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function exchangeOAuthCode(env: Env, code: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: required(env.GITHUB_CLIENT_ID, "GITHUB_CLIENT_ID"),
    client_secret: required(env.GITHUB_CLIENT_SECRET, "GITHUB_CLIENT_SECRET"),
    code,
  });

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? "GitHub OAuth exchange failed");
  }

  return payload.access_token;
}

export async function getAuthenticatedUser(userToken: string): Promise<{
  id: number;
  login: string;
  avatar_url: string | null;
}> {
  return githubRequest("/user", userToken);
}

export async function listUserInstallations(userToken: string): Promise<GithubInstallation[]> {
  const installations: GithubInstallation[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const payload = await githubRequest<{ installations: GithubInstallation[] }>(
      `/user/installations?per_page=100&page=${page}`,
      userToken,
    );
    installations.push(...payload.installations);
    if (payload.installations.length < 100) break;
  }

  return installations;
}

export async function createInstallationToken(env: Env, installationId: number): Promise<string> {
  const jwt = await createAppJwt(env);
  const payload = await githubRequest<{ token: string }>(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: "POST", body: "{}" },
  );
  return payload.token;
}

export async function listInstallationRepositories(
  env: Env,
  installationId: number,
): Promise<GithubRepository[]> {
  const token = await createInstallationToken(env, installationId);
  const repositories: GithubRepository[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const payload = await githubRequest<{ repositories: GithubRepository[] }>(
      `/installation/repositories?per_page=100&page=${page}`,
      token,
    );
    repositories.push(...payload.repositories);
    if (payload.repositories.length < 100) break;
  }

  return repositories;
}

export async function listWorkflows(
  env: Env,
  installationId: number,
  owner: string,
  repo: string,
): Promise<GithubWorkflow[]> {
  const token = await createInstallationToken(env, installationId);
  const workflows: GithubWorkflow[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const payload = await githubRequest<{ workflows: GithubWorkflow[] }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows?per_page=100&page=${page}`,
      token,
    );
    workflows.push(...payload.workflows);
    if (payload.workflows.length < 100) break;
  }

  return workflows;
}

export async function listWorkflowRuns(
  env: Env,
  guard: {
    installation_id: number;
    owner: string;
    repo: string;
    workflow_id: number;
  },
): Promise<GithubWorkflowRun[]> {
  const token = await createInstallationToken(env, guard.installation_id);
  const payload = await githubRequest<{ workflow_runs: GithubWorkflowRun[] }>(
    `/repos/${encodeURIComponent(guard.owner)}/${encodeURIComponent(guard.repo)}/actions/workflows/${guard.workflow_id}/runs?per_page=50`,
    token,
  );
  return payload.workflow_runs;
}

export async function rerunWorkflow(
  env: Env,
  guard: {
    installation_id: number;
    owner: string;
    repo: string;
  },
  runId: number,
): Promise<void> {
  const token = await createInstallationToken(env, guard.installation_id);
  await githubRequest<void>(
    `/repos/${encodeURIComponent(guard.owner)}/${encodeURIComponent(guard.repo)}/actions/runs/${runId}/rerun`,
    token,
    { method: "POST", body: "{}" },
  );
}

export async function dispatchWorkflow(
  env: Env,
  guard: {
    installation_id: number;
    owner: string;
    repo: string;
    workflow_id: number;
    ref: string;
  },
): Promise<void> {
  const token = await createInstallationToken(env, guard.installation_id);
  await githubRequest<void>(
    `/repos/${encodeURIComponent(guard.owner)}/${encodeURIComponent(guard.repo)}/actions/workflows/${guard.workflow_id}/dispatches`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ ref: guard.ref }),
    },
  );
}

async function createAppJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: required(env.GITHUB_CLIENT_ID, "GITHUB_CLIENT_ID"),
  });
  const unsigned = `${header}.${payload}`;
  const key = await importPrivateKey(
    required(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY"),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function pemBodyToBytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/gu, "")
    .replace(/-----END [^-]+-----/gu, "")
    .replace(/\s+/gu, "");
  const binary = atob(body);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importPrivateKey(rawPem: string): Promise<CryptoKey> {
  const pem = rawPem.replaceAll("\\n", "\n").trim();
  let keyData = pemBodyToBytes(pem);

  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    keyData = wrapPkcs1AsPkcs8(keyData);
  }

  return crypto.subtle.importKey(
    "pkcs8",
    keyData as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const rsaAlgorithmIdentifier = Uint8Array.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const privateKey = derWrap(0x04, pkcs1);
  return derWrap(0x30, concat(version, rsaAlgorithmIdentifier, privateKey));
}

function derWrap(tag: number, value: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  if (length <= 0xff) return Uint8Array.of(0x81, length);
  if (length <= 0xffff) return Uint8Array.of(0x82, length >> 8, length & 0xff);
  return Uint8Array.of(0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const size = arrays.reduce((total, array) => total + array.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }
  return output;
}
