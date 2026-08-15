export interface Env {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  WATCHDOG_BASE_URL?: string;
}

export interface SessionUser {
  id: number;
  githubUserId: number;
  login: string;
  avatarUrl: string | null;
}

export interface InstallationRecord {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  permissions: Record<string, string>;
}

export interface GuardRecord {
  id: string;
  user_id: number;
  installation_id: number;
  repo_id: number;
  owner: string;
  repo: string;
  workflow_id: number;
  workflow_name: string;
  workflow_path: string;
  ref: string;
  timezone: string;
  expected_hour: number;
  expected_minute: number;
  grace_minutes: number;
  cooldown_minutes: number;
  max_attempts: number;
  enabled: number;
  last_status: string;
  last_error: string | null;
  last_checked_at: string | null;
  last_action_at: string | null;
  attempts_today: number;
  attempt_date: string | null;
  last_success_date: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface GithubInstallation {
  id: number;
  app_id: number;
  account: {
    login: string;
    id: number;
    type: string;
  };
  repository_selection: string;
  permissions: Record<string, string>;
}

export interface GithubRepository {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  owner: {
    login: string;
  };
  private: boolean;
}

export interface GithubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface GithubWorkflowRun {
  id: number;
  event: string;
  head_branch: string | null;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  run_attempt: number;
  html_url: string;
}
