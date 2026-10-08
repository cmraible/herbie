CREATE TABLE IF NOT EXISTS goals (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  repository text NOT NULL,
  prompt text NOT NULL,
  test_command jsonb NOT NULL,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  attempt_count integer NOT NULL DEFAULT 0,
  mode text NOT NULL CHECK (mode IN ('demo', 'live')),
  state text NOT NULL CHECK (state IN ('queued','running','paused','awaiting_review','completed','cancelled','failed','needs_attention')),
  stop_requested text CHECK (stop_requested IN ('pause','cancel')),
  pull_request jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS goals_one_active_repository ON goals (lower(repository))
  WHERE state IN ('queued','running','paused','awaiting_review','needs_attention');
CREATE TABLE IF NOT EXISTS goal_requests (
  owner_id text NOT NULL,
  request_key uuid NOT NULL,
  fingerprint text NOT NULL,
  goal_id uuid NOT NULL REFERENCES goals(id),
  PRIMARY KEY (owner_id, request_key)
);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  goal_id uuid NOT NULL REFERENCES goals(id),
  cycle integer NOT NULL CHECK (cycle BETWEEN 1 AND 5),
  branch text NOT NULL UNIQUE,
  stage text NOT NULL CHECK (stage IN ('queued','running','ready','publishing','awaiting_review','completed','cancelled','failed','needs_attention')),
  artifact jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  eligible_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (goal_id, cycle)
);
CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs(stage, eligible_at, created_at);
CREATE TABLE IF NOT EXISTS goal_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  goal_id uuid NOT NULL REFERENCES goals(id),
  type text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS goal_events_goal ON goal_events(goal_id, id);
