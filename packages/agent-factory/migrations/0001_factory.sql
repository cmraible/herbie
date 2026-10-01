PRAGMA foreign_keys = ON;
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  billing_status TEXT NOT NULL DEFAULT 'trial' CHECK(billing_status IN ('trial','active','suspended')),
  max_goals INTEGER NOT NULL DEFAULT 10
);
-- Provisioned by the service operator after independent company/domain verification.
CREATE TABLE company_domains (
  domain TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id),
  verified_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);
CREATE TABLE members (
  workspace TEXT NOT NULL REFERENCES workspaces(id), sub TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
  PRIMARY KEY(workspace,sub)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, sub TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE repositories (
  workspace TEXT NOT NULL REFERENCES workspaces(id), repo TEXT NOT NULL,
  installation INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  PRIMARY KEY(workspace,repo), UNIQUE(installation,repo)
);
CREATE TABLE goals (
  id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id),
  repo TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
  FOREIGN KEY(workspace,repo) REFERENCES repositories(workspace,repo)
);
CREATE INDEX goals_workspace ON goals(workspace);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY, received INTEGER NOT NULL, body TEXT NOT NULL, event TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE model_usage (
  run TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0
);
