CREATE TABLE IF NOT EXISTS goals (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  repository text NOT NULL,
  prompt text NOT NULL,
  -- Retained for older deployments; new goals no longer supply a test command.
  test_command jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  mode text NOT NULL CHECK (mode IN ('demo', 'live')),
  state text NOT NULL CHECK (state IN ('queued','running','paused','awaiting_review','completed','cancelled','failed','needs_attention')),
  stop_requested text CHECK (stop_requested IN ('pause','cancel')),
  pull_request jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DROP INDEX IF EXISTS goals_one_active_repository;
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
  cycle integer NOT NULL CHECK (cycle >= 1),
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

ALTER TABLE goals ADD COLUMN IF NOT EXISTS cleanup_status text NOT NULL DEFAULT 'not_required' CHECK (cleanup_status IN ('not_required','pending','complete','needs_attention'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancelled_worker text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancel_cleanup_deadline timestamptz;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS publication_retry_count integer NOT NULL DEFAULT 0 CHECK (publication_retry_count >= 0);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS publication_blocked boolean NOT NULL DEFAULT false;
ALTER TABLE goals ALTER COLUMN test_command DROP NOT NULL;

ALTER TABLE goals ADD COLUMN IF NOT EXISTS name text;
UPDATE goals SET name=COALESCE(NULLIF(regexp_replace(left(regexp_replace(replace(prompt,'[demo:fail]',''),'^[[:space:]]+|[[:space:]]+$','','g'),120),'[[:space:]]+$',''),''),'Untitled goal') WHERE name IS NULL;
ALTER TABLE goals ALTER COLUMN name SET NOT NULL;

ALTER TABLE goals DROP COLUMN IF EXISTS max_attempts;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_cycle_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_cycle_check CHECK (cycle >= 1);

ALTER TABLE goals ADD COLUMN IF NOT EXISTS max_wip integer NOT NULL DEFAULT 1 CHECK (max_wip > 0);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pull_request jsonb;
-- Older coordinators can still publish or reconcile while draining after this migration.
CREATE OR REPLACE FUNCTION sync_goal_pull_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE jobs SET pull_request=NEW.pull_request
    WHERE goal_id=NEW.id AND branch=NEW.pull_request->>'branch'
      AND pull_request IS DISTINCT FROM NEW.pull_request;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sync_goal_pull_request ON goals;
CREATE TRIGGER sync_goal_pull_request AFTER INSERT OR UPDATE OF pull_request ON goals
  FOR EACH ROW EXECUTE FUNCTION sync_goal_pull_request();
UPDATE jobs j SET pull_request=g.pull_request FROM goals g
  WHERE j.goal_id=g.id AND j.branch=g.pull_request->>'branch' AND j.pull_request IS NULL;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ci_review_requested boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS ci_repairs (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  head text NOT NULL,
  state text NOT NULL CHECK (state IN ('running','completed','failed')),
  lease_owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  artifact jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(job_id, head)
);
CREATE UNIQUE INDEX IF NOT EXISTS ci_repairs_one_running ON ci_repairs(job_id) WHERE state='running';

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ci_reviewed_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS readiness_pending boolean NOT NULL DEFAULT false;

ALTER TABLE ci_repairs DROP CONSTRAINT IF EXISTS ci_repairs_state_check;
ALTER TABLE ci_repairs ADD CONSTRAINT ci_repairs_state_check CHECK (state IN ('running','waiting','completed','failed'));

ALTER TABLE ci_repairs ADD COLUMN IF NOT EXISTS publication_started boolean NOT NULL DEFAULT false;

ALTER TABLE goal_events ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES jobs(id);

-- Transactional notifications cross API/worker process boundaries. Only IDs leave
-- the database; each WebSocket reads data through the existing owner-scoped store.
CREATE OR REPLACE FUNCTION notify_goal_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='goals' THEN
    PERFORM pg_notify('herbie_changes', NEW.id::text);
  ELSIF TG_TABLE_NAME='goal_events' THEN
    PERFORM pg_notify('herbie_changes', NEW.goal_id::text || ':' || NEW.id::text);
  ELSE
    PERFORM pg_notify('herbie_changes', NEW.goal_id::text);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS notify_goal_change ON goals;
CREATE TRIGGER notify_goal_change AFTER INSERT OR UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION notify_goal_change();
DROP TRIGGER IF EXISTS notify_goal_change ON jobs;
CREATE TRIGGER notify_goal_change AFTER INSERT OR UPDATE OF stage, pull_request ON jobs
  FOR EACH ROW EXECUTE FUNCTION notify_goal_change();
DROP TRIGGER IF EXISTS notify_goal_change ON goal_events;
CREATE TRIGGER notify_goal_change AFTER INSERT ON goal_events
  FOR EACH ROW EXECUTE FUNCTION notify_goal_change();
