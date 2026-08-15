PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_user_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_states (
  state_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_states_expires_at_idx ON auth_states(expires_at);

CREATE TABLE IF NOT EXISTS user_installations (
  user_id INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  repository_selection TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, installation_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS user_installations_installation_id_idx
  ON user_installations(installation_id);

CREATE TABLE IF NOT EXISTS guards (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  workflow_id INTEGER NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT 'main',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  expected_hour INTEGER NOT NULL DEFAULT 0,
  expected_minute INTEGER NOT NULL DEFAULT 17,
  grace_minutes INTEGER NOT NULL DEFAULT 90,
  cooldown_minutes INTEGER NOT NULL DEFAULT 90,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT NOT NULL DEFAULT 'new',
  last_error TEXT,
  last_checked_at TEXT,
  last_action_at TEXT,
  attempts_today INTEGER NOT NULL DEFAULT 0,
  attempt_date TEXT,
  last_success_date TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, installation_id, repo_id, workflow_id)
);
CREATE INDEX IF NOT EXISTS guards_enabled_idx ON guards(enabled);
CREATE INDEX IF NOT EXISTS guards_user_id_idx ON guards(user_id);
