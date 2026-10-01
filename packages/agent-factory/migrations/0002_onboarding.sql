CREATE TABLE identities (sub TEXT PRIMARY KEY, domain TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, verified_at INTEGER NOT NULL);
ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended'));
CREATE TABLE domain_challenges (
 id TEXT PRIMARY KEY, sub TEXT NOT NULL REFERENCES identities(sub), domain TEXT NOT NULL,
 workspace TEXT NOT NULL UNIQUE, name TEXT NOT NULL, token TEXT NOT NULL, expires INTEGER NOT NULL,
 consumed INTEGER NOT NULL DEFAULT 0, UNIQUE(sub,domain)
);
CREATE TABLE workspace_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL REFERENCES workspaces(id), actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE github_states (hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE, sub TEXT NOT NULL, workspace TEXT NOT NULL REFERENCES workspaces(id), verifier TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE github_proposals (id TEXT PRIMARY KEY, sub TEXT NOT NULL, workspace TEXT NOT NULL REFERENCES workspaces(id), body TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
