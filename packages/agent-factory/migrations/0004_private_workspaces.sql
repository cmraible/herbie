-- One private workspace creation receipt per verified identity.
-- Legacy domains and pending DNS challenges are retained as historical data only.
CREATE TABLE private_workspaces (
 sub TEXT PRIMARY KEY REFERENCES identities(sub),
 workspace TEXT NOT NULL UNIQUE REFERENCES workspaces(id)
);
