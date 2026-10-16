-- Upgrade the persisted goal vocabulary in place so existing IDs, requests,
-- jobs, and activity history remain attached to the same projects.
DO $project_rename$
BEGIN
  IF to_regclass('projects') IS NULL AND to_regclass('goals') IS NOT NULL THEN
    ALTER TABLE goals RENAME TO projects;
  END IF;
  IF to_regclass('project_requests') IS NULL AND to_regclass('goal_requests') IS NOT NULL THEN
    ALTER TABLE goal_requests RENAME TO project_requests;
  END IF;
  IF to_regclass('project_events') IS NULL AND to_regclass('goal_events') IS NOT NULL THEN
    ALTER TABLE goal_events RENAME TO project_events;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='jobs' AND column_name='goal_id') THEN
    ALTER TABLE jobs RENAME COLUMN goal_id TO project_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_requests' AND column_name='goal_id') THEN
    ALTER TABLE project_requests RENAME COLUMN goal_id TO project_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_events' AND column_name='goal_id') THEN
    ALTER TABLE project_events RENAME COLUMN goal_id TO project_id;
  END IF;
END;
$project_rename$;

-- Renamed tables keep their old triggers; replace them with project-named ones.
DROP INDEX IF EXISTS goals_one_active_repository;
DROP INDEX IF EXISTS goal_events_goal;

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  repository text NOT NULL,
  prompt text NOT NULL,
  -- Retained for older deployments; new projects no longer supply a test command.
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
DROP INDEX IF EXISTS projects_one_active_repository;
CREATE TABLE IF NOT EXISTS project_requests (
  owner_id text NOT NULL,
  request_key uuid NOT NULL,
  fingerprint text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  PRIMARY KEY (owner_id, request_key)
);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  cycle integer NOT NULL CHECK (cycle >= 1),
  branch text NOT NULL UNIQUE,
  stage text NOT NULL CHECK (stage IN ('queued','running','ready','publishing','awaiting_review','completed','cancelled','failed','needs_attention')),
  artifact jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  eligible_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, cycle)
);
CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs(stage, eligible_at, created_at);
CREATE TABLE IF NOT EXISTS project_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  type text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS project_events_project ON project_events(project_id, id);

DROP TRIGGER IF EXISTS sync_goal_pull_request ON projects;
DROP TRIGGER IF EXISTS notify_goal_change ON projects;
DROP TRIGGER IF EXISTS notify_goal_change ON jobs;
DROP TRIGGER IF EXISTS notify_goal_change ON project_events;
DROP FUNCTION IF EXISTS sync_goal_pull_request();
DROP FUNCTION IF EXISTS notify_goal_change();

ALTER TABLE projects ADD COLUMN IF NOT EXISTS cleanup_status text NOT NULL DEFAULT 'not_required' CHECK (cleanup_status IN ('not_required','pending','complete','needs_attention'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancelled_worker text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancel_cleanup_deadline timestamptz;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS publication_retry_count integer NOT NULL DEFAULT 0 CHECK (publication_retry_count >= 0);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS publication_blocked boolean NOT NULL DEFAULT false;
ALTER TABLE projects ALTER COLUMN test_command DROP NOT NULL;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS name text;
UPDATE projects SET name=COALESCE(NULLIF(regexp_replace(left(regexp_replace(replace(prompt,'[demo:fail]',''),'^[[:space:]]+|[[:space:]]+$','','g'),120),'[[:space:]]+$',''),''),'Untitled project') WHERE name IS NULL;
ALTER TABLE projects ALTER COLUMN name SET NOT NULL;

ALTER TABLE projects DROP COLUMN IF EXISTS max_attempts;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_cycle_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_cycle_check CHECK (cycle >= 1);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_wip integer NOT NULL DEFAULT 1 CHECK (max_wip > 0);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pull_request jsonb;
-- Older coordinators can still publish or reconcile while draining after this migration.
CREATE OR REPLACE FUNCTION sync_project_pull_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE jobs SET pull_request=NEW.pull_request
    WHERE project_id=NEW.id AND branch=NEW.pull_request->>'branch'
      AND pull_request IS DISTINCT FROM NEW.pull_request;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sync_project_pull_request ON projects;
CREATE TRIGGER sync_project_pull_request AFTER INSERT OR UPDATE OF pull_request ON projects
  FOR EACH ROW EXECUTE FUNCTION sync_project_pull_request();
UPDATE jobs j SET pull_request=g.pull_request FROM projects g
  WHERE j.project_id=g.id AND j.branch=g.pull_request->>'branch' AND j.pull_request IS NULL;

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
ALTER TABLE ci_repairs ADD CONSTRAINT ci_repairs_state_check CHECK (state IN ('running','waiting','completed','failed','superseded'));

ALTER TABLE ci_repairs ADD COLUMN IF NOT EXISTS publication_started boolean NOT NULL DEFAULT false;

ALTER TABLE project_events ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES jobs(id);

-- Transactional notifications cross API/worker process boundaries. Only IDs leave
-- the database; each WebSocket reads data through the existing owner-scoped store.
CREATE OR REPLACE FUNCTION notify_project_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='projects' THEN
    PERFORM pg_notify('herbie_changes', NEW.id::text);
  ELSIF TG_TABLE_NAME='project_events' THEN
    PERFORM pg_notify('herbie_changes', NEW.project_id::text || ':' || NEW.id::text);
  ELSE
    PERFORM pg_notify('herbie_changes', NEW.project_id::text);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS notify_project_change ON projects;
CREATE TRIGGER notify_project_change AFTER INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION notify_project_change();
DROP TRIGGER IF EXISTS notify_project_change ON jobs;
CREATE TRIGGER notify_project_change AFTER INSERT OR UPDATE OF stage, pull_request ON jobs
  FOR EACH ROW EXECUTE FUNCTION notify_project_change();
DROP TRIGGER IF EXISTS notify_project_change ON project_events;
CREATE TRIGGER notify_project_change AFTER INSERT ON project_events
  FOR EACH ROW EXECUTE FUNCTION notify_project_change();

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS feedback_requested boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS feedback_reviewed_at timestamptz;
CREATE TABLE IF NOT EXISTS pr_feedback (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  kind text NOT NULL,
  external_id bigint NOT NULL,
  revision text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','running','completed','failed')),
  lease_owner text,
  lease_expires_at timestamptz,
  artifact jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(job_id, kind, external_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_feedback_one_running ON pr_feedback(job_id) WHERE state='running';

-- Manual retries retain the failed attempt and get a fresh lease/artifact identity.
ALTER TABLE ci_repairs ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false;
ALTER TABLE ci_repairs ADD COLUMN IF NOT EXISTS retry_of uuid REFERENCES ci_repairs(id);
ALTER TABLE ci_repairs DROP CONSTRAINT IF EXISTS ci_repairs_job_id_head_key;
CREATE UNIQUE INDEX IF NOT EXISTS ci_repairs_active_head ON ci_repairs(job_id, head) WHERE state <> 'superseded';
-- Recover cleanup evidence for failures recorded before retryability was persisted.
UPDATE ci_repairs r SET retryable=true
WHERE r.state='failed' AND NOT r.publication_started AND NOT r.retryable
  AND NOT EXISTS (SELECT 1 FROM ci_repairs newer WHERE newer.job_id=r.job_id AND newer.created_at>r.created_at)
  AND (SELECT e.message FROM project_events e WHERE e.job_id=r.job_id AND e.type='ci_repair'
       AND e.created_at>=r.created_at ORDER BY e.id DESC LIMIT 1) LIKE 'Deletion confirmed for sandbox %';
