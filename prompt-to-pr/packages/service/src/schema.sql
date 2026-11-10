CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  repository jsonb NOT NULL,
  installation_id bigint NOT NULL,
  prompt text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','no_changes','failed','needs_attention')),
  stage text NOT NULL DEFAULT 'queued',
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  base_sha text,
  sandbox_id text,
  artifact jsonb,
  cleanup_complete boolean NOT NULL DEFAULT false,
  expected_sha text,
  pull_request jsonb,
  summary text,
  error jsonb,
  failure_diagnostic jsonb,
  UNIQUE(owner_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs ((true)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS runs_owner_created ON runs(owner_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS run_events (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  stage text NOT NULL,
  message text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS events_run_id ON run_events(run_id, id);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS failure_diagnostic jsonb;
