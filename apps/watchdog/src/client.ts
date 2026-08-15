import "./styles.css";

type Installation = {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  permissions: Record<string, string>;
};

type Me = {
  user: {
    id: number;
    githubUserId: number;
    login: string;
    avatarUrl: string | null;
  };
  installations: Installation[];
  appSlug: string;
};

type Repository = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
};

type Workflow = {
  id: number;
  name: string;
  path: string;
  state: string;
};

type Guard = {
  id: string;
  installationId: number;
  repoId: number;
  owner: string;
  repo: string;
  workflowId: number;
  workflowName: string;
  workflowPath: string;
  ref: string;
  timezone: string;
  expectedHour: number;
  expectedMinute: number;
  graceMinutes: number;
  cooldownMinutes: number;
  maxAttempts: number;
  enabled: boolean;
  lastStatus: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  lastActionAt: string | null;
  attemptsToday: number;
  attemptDate: string | null;
  lastSuccessDate: string | null;
};

const app = requiredElement<HTMLElement>("#app");

let me: Me | null = null;
let guards: Guard[] = [];
let repositories: Repository[] = [];
let workflows: Workflow[] = [];

void boot();

async function boot(): Promise<void> {
  try {
    me = await api<Me>("/api/me");
    const guardPayload = await api<{ guards: Guard[] }>("/api/guards");
    guards = guardPayload.guards;
    renderConnected();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      renderSignedOut();
      return;
    }
    renderFatal(error);
  }
}

function renderSignedOut(): void {
  app.innerHTML = `
    <section class="shell hero-shell">
      <div class="eyebrow">GitHub Actions reliability layer</div>
      <h1>Watchdog</h1>
      <p class="lead">
        盯住每天应该成功的 workflow。漏跑、失败或超时后，自动补一次。
      </p>
      <div class="hero-actions">
        <a class="button primary" href="/api/auth/start">安装并连接 GitHub App</a>
        <a class="button ghost" href="/api/auth/start?mode=login">我已经安装过，只重新登录</a>
      </div>
      <p class="muted compact">
        不需要粘贴 PAT。Watchdog 只保存 installation 元数据和登录 session；真正调用 Actions 时使用短期 installation token。
      </p>
    </section>
  `;
}

function renderConnected(): void {
  if (!me) return;

  const installationOptions = me.installations
    .map(
      (installation) =>
        `<option value="${installation.installationId}">${escapeHtml(installation.accountLogin)} · ${escapeHtml(installation.accountType)}</option>`,
    )
    .join("");

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div>
          <div class="eyebrow">Douyin Auto Spark</div>
          <h1>Watchdog</h1>
        </div>
        <div class="account">
          ${me.user.avatarUrl ? `<img src="${escapeAttr(me.user.avatarUrl)}" alt="" />` : ""}
          <span>@${escapeHtml(me.user.login)}</span>
          <button id="logout" class="button ghost small" type="button">退出</button>
        </div>
      </header>

      <section class="summary-grid">
        <article class="summary-card">
          <span>Installations</span>
          <strong>${me.installations.length}</strong>
        </article>
        <article class="summary-card">
          <span>Guards</span>
          <strong>${guards.length}</strong>
        </article>
        <article class="summary-card">
          <span>Healthy today</span>
          <strong>${guards.filter((guard) => guard.lastStatus === "healthy").length}</strong>
        </article>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>添加守护</h2>
            <p>定义“今天应该成功一次”的 workflow 和恢复策略。</p>
          </div>
          <a class="button ghost small" href="/api/auth/start">刷新 GitHub 授权</a>
        </div>
        ${
          me.installations.length === 0
            ? `<div class="empty">没有找到当前用户可访问的 Watchdog installation。<a href="/api/auth/start">安装 GitHub App</a></div>`
            : `
          <form id="guard-form" class="form-grid">
            <label>
              <span>Installation</span>
              <select id="installation" name="installationId" required>${installationOptions}</select>
            </label>
            <label>
              <span>Repository</span>
              <select id="repository" name="repository" required disabled>
                <option>正在加载...</option>
              </select>
            </label>
            <label class="wide">
              <span>Workflow</span>
              <select id="workflow" name="workflowId" required disabled>
                <option>先选择仓库</option>
              </select>
            </label>
            <label>
              <span>Expected time</span>
              <input name="expectedTime" type="time" value="00:17" required />
            </label>
            <label>
              <span>Timezone</span>
              <input name="timezone" value="Asia/Shanghai" required />
            </label>
            <label>
              <span>Grace (minutes)</span>
              <input name="graceMinutes" type="number" min="0" max="720" value="90" required />
            </label>
            <label>
              <span>Cooldown (minutes)</span>
              <input name="cooldownMinutes" type="number" min="1" max="1440" value="90" required />
            </label>
            <label>
              <span>Max attempts / day</span>
              <input name="maxAttempts" type="number" min="1" max="10" value="3" required />
            </label>
            <label>
              <span>Ref</span>
              <input id="ref" name="ref" value="main" required />
            </label>
            <div class="wide form-actions">
              <button class="button primary" type="submit">开启 Watchdog</button>
              <span id="form-status" class="muted"></span>
            </div>
          </form>`
        }
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>正在守护</h2>
            <p>Cloudflare Cron 每 30 分钟扫一次；未到 grace window 不会触发恢复。</p>
          </div>
        </div>
        <div id="guard-list" class="guard-list">
          ${guards.length ? guards.map(renderGuard).join("") : `<div class="empty">还没有 guard。</div>`}
        </div>
      </section>
    </div>
  `;

  wireConnectedEvents();
}

function renderGuard(guard: Guard): string {
  const expected = `${pad2(guard.expectedHour)}:${pad2(guard.expectedMinute)}`;
  const badgeClass = statusClass(guard.lastStatus);
  return `
    <article class="guard-card" data-guard-id="${escapeAttr(guard.id)}">
      <div class="guard-main">
        <div class="guard-title-row">
          <div>
            <h3>${escapeHtml(guard.owner)}/${escapeHtml(guard.repo)}</h3>
            <code>${escapeHtml(guard.workflowName)}</code>
          </div>
          <span class="badge ${badgeClass}">${escapeHtml(guard.lastStatus)}</span>
        </div>
        <dl class="guard-meta">
          <div><dt>Expected</dt><dd>${expected} ${escapeHtml(guard.timezone)}</dd></div>
          <div><dt>Grace</dt><dd>${guard.graceMinutes} min</dd></div>
          <div><dt>Cooldown</dt><dd>${guard.cooldownMinutes} min</dd></div>
          <div><dt>Attempts</dt><dd>${guard.attemptsToday}/${guard.maxAttempts}</dd></div>
          <div><dt>Last success</dt><dd>${escapeHtml(guard.lastSuccessDate ?? "—")}</dd></div>
          <div><dt>Last check</dt><dd>${formatDate(guard.lastCheckedAt)}</dd></div>
        </dl>
        ${guard.lastError ? `<p class="error-box">${escapeHtml(guard.lastError)}</p>` : ""}
      </div>
      <div class="guard-actions">
        <button class="button ghost small" data-action="check" type="button">立即检查</button>
        <button class="button ghost small" data-action="toggle" type="button">${guard.enabled ? "暂停" : "启用"}</button>
        <button class="button danger small" data-action="delete" type="button">删除</button>
      </div>
    </article>
  `;
}

function wireConnectedEvents(): void {
  document.querySelector<HTMLButtonElement>("#logout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.reload();
  });

  const installationSelect = document.querySelector<HTMLSelectElement>("#installation");
  installationSelect?.addEventListener("change", () => void loadRepositories());

  const repositorySelect = document.querySelector<HTMLSelectElement>("#repository");
  repositorySelect?.addEventListener("change", () => void loadWorkflows());

  document.querySelector<HTMLFormElement>("#guard-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitGuard(event.currentTarget as HTMLFormElement);
  });

  document.querySelector("#guard-list")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
    const card = button?.closest<HTMLElement>("[data-guard-id]");
    if (!button || !card) return;
    const id = card.dataset.guardId;
    const action = button.dataset.action;
    if (!id || !action) return;
    void handleGuardAction(id, action, button);
  });

  if (me?.installations.length) void loadRepositories();
}

async function loadRepositories(): Promise<void> {
  const installation = document.querySelector<HTMLSelectElement>("#installation");
  const repository = document.querySelector<HTMLSelectElement>("#repository");
  const workflow = document.querySelector<HTMLSelectElement>("#workflow");
  if (!installation || !repository || !workflow) return;

  repository.disabled = true;
  workflow.disabled = true;
  repository.innerHTML = `<option>正在加载...</option>`;
  workflow.innerHTML = `<option>先选择仓库</option>`;

  try {
    const payload = await api<{ repositories: Repository[] }>(
      `/api/repos?installation_id=${encodeURIComponent(installation.value)}`,
    );
    repositories = payload.repositories;
    repository.innerHTML = repositories.length
      ? repositories
          .map(
            (repo) =>
              `<option value="${repo.id}">${escapeHtml(repo.fullName)}${repo.private ? " · private" : ""}</option>`,
          )
          .join("")
      : `<option value="">没有可访问仓库</option>`;
    repository.disabled = repositories.length === 0;
    if (repositories.length) {
      syncRef();
      await loadWorkflows();
    }
  } catch (error) {
    repository.innerHTML = `<option>加载失败</option>`;
    showFormStatus(errorMessage(error), true);
  }
}

async function loadWorkflows(): Promise<void> {
  const installation = document.querySelector<HTMLSelectElement>("#installation");
  const repository = document.querySelector<HTMLSelectElement>("#repository");
  const workflow = document.querySelector<HTMLSelectElement>("#workflow");
  if (!installation || !repository || !workflow) return;

  const selectedRepo = repositories.find((repo) => repo.id === Number(repository.value));
  if (!selectedRepo) return;
  syncRef();
  workflow.disabled = true;
  workflow.innerHTML = `<option>正在加载...</option>`;

  try {
    const params = new URLSearchParams({
      installation_id: installation.value,
      owner: selectedRepo.owner,
      repo: selectedRepo.name,
    });
    const payload = await api<{ workflows: Workflow[] }>(`/api/workflows?${params}`);
    workflows = payload.workflows;
    workflow.innerHTML = workflows.length
      ? workflows
          .map(
            (item) =>
              `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.path)}</option>`,
          )
          .join("")
      : `<option value="">没有 active workflow</option>`;
    workflow.disabled = workflows.length === 0;
  } catch (error) {
    workflow.innerHTML = `<option>加载失败</option>`;
    showFormStatus(errorMessage(error), true);
  }
}

function syncRef(): void {
  const repository = document.querySelector<HTMLSelectElement>("#repository");
  const ref = document.querySelector<HTMLInputElement>("#ref");
  if (!repository || !ref) return;
  const selected = repositories.find((repo) => repo.id === Number(repository.value));
  if (selected) ref.value = selected.defaultBranch;
}

async function submitGuard(form: HTMLFormElement): Promise<void> {
  const installation = document.querySelector<HTMLSelectElement>("#installation");
  const repository = document.querySelector<HTMLSelectElement>("#repository");
  const workflow = document.querySelector<HTMLSelectElement>("#workflow");
  if (!installation || !repository || !workflow) return;

  const selectedRepo = repositories.find((repo) => repo.id === Number(repository.value));
  const selectedWorkflow = workflows.find((item) => item.id === Number(workflow.value));
  if (!selectedRepo || !selectedWorkflow) return;

  const data = new FormData(form);
  const [hour, minute] = String(data.get("expectedTime") ?? "00:17")
    .split(":")
    .map(Number);

  showFormStatus("保存中...");
  try {
    await api("/api/guards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId: Number(installation.value),
        repoId: selectedRepo.id,
        owner: selectedRepo.owner,
        repo: selectedRepo.name,
        workflowId: selectedWorkflow.id,
        ref: String(data.get("ref")),
        timezone: String(data.get("timezone")),
        expectedHour: hour,
        expectedMinute: minute,
        graceMinutes: Number(data.get("graceMinutes")),
        cooldownMinutes: Number(data.get("cooldownMinutes")),
        maxAttempts: Number(data.get("maxAttempts")),
      }),
    });
    const payload = await api<{ guards: Guard[] }>("/api/guards");
    guards = payload.guards;
    renderConnected();
  } catch (error) {
    showFormStatus(errorMessage(error), true);
  }
}

async function handleGuardAction(
  id: string,
  action: string,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    if (action === "check") {
      await api(`/api/guards/${encodeURIComponent(id)}/check`, { method: "POST" });
    } else if (action === "delete") {
      if (!confirm("删除这个 guard？")) return;
      await api(`/api/guards/${encodeURIComponent(id)}`, { method: "DELETE" });
    } else if (action === "toggle") {
      const guard = guards.find((item) => item.id === id);
      if (!guard) return;
      await api(`/api/guards/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !guard.enabled }),
      });
    }

    const payload = await api<{ guards: Guard[] }>("/api/guards");
    guards = payload.guards;
    renderConnected();
  } catch (error) {
    alert(errorMessage(error));
  } finally {
    button.disabled = false;
  }
}

function showFormStatus(message: string, error = false): void {
  const element = document.querySelector<HTMLElement>("#form-status");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("text-error", error);
}

function renderFatal(error: unknown): void {
  app.innerHTML = `
    <section class="shell hero-shell">
      <div class="eyebrow">Watchdog</div>
      <h1>启动失败</h1>
      <p class="error-box">${escapeHtml(errorMessage(error))}</p>
      <a class="button ghost" href="/">重试</a>
    </section>
  `;
}

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as { error?: string }) : {};
  if (!response.ok) {
    throw new ApiError(response.status, payload.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} not found`);
  return element;
}

function statusClass(status: string): string {
  if (status === "healthy") return "success";
  if (["error", "exhausted"].includes(status)) return "danger";
  if (["rerun_requested", "dispatch_requested", "running"].includes(status)) return "active";
  return "neutral";
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
