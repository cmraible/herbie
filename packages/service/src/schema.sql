-- Upgrade persisted goal/job terminology in place, preserving IDs and history.
DO $project_run_rename$
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
  IF to_regclass('project_runs') IS NULL AND to_regclass('jobs') IS NOT NULL THEN
    ALTER TABLE jobs RENAME TO project_runs;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_runs' AND column_name='goal_id') THEN
    ALTER TABLE project_runs RENAME COLUMN goal_id TO project_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_requests' AND column_name='goal_id') THEN
    ALTER TABLE project_requests RENAME COLUMN goal_id TO project_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_events' AND column_name='goal_id') THEN
    ALTER TABLE project_events RENAME COLUMN goal_id TO project_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='projects' AND column_name='attempt_count') THEN
    ALTER TABLE projects RENAME COLUMN attempt_count TO run_count;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_events' AND column_name='job_id') THEN
    ALTER TABLE project_events RENAME COLUMN job_id TO run_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ci_repairs' AND column_name='job_id') THEN
    ALTER TABLE ci_repairs RENAME COLUMN job_id TO run_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='pr_feedback' AND column_name='job_id') THEN
    ALTER TABLE pr_feedback RENAME COLUMN job_id TO run_id;
  END IF;
  IF to_regclass('projects') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('projects') AND conname='projects_attempt_count_check') THEN
    ALTER TABLE projects RENAME CONSTRAINT projects_attempt_count_check TO projects_run_count_check;
  END IF;
  IF to_regclass('project_runs') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('project_runs') AND conname='jobs_pkey') THEN
    ALTER TABLE project_runs RENAME CONSTRAINT jobs_pkey TO project_runs_pkey;
  END IF;
  IF to_regclass('project_runs') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('project_runs') AND conname='jobs_project_id_fkey') THEN
    ALTER TABLE project_runs RENAME CONSTRAINT jobs_project_id_fkey TO project_runs_project_id_fkey;
  END IF;
  IF to_regclass('project_runs') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('project_runs') AND conname='jobs_goal_id_fkey') THEN
    ALTER TABLE project_runs RENAME CONSTRAINT jobs_goal_id_fkey TO project_runs_project_id_fkey;
  END IF;
  IF to_regclass('project_runs') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('project_runs') AND conname='jobs_branch_key') THEN
    ALTER TABLE project_runs RENAME CONSTRAINT jobs_branch_key TO project_runs_branch_key;
  END IF;
  IF to_regclass('project_runs') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('project_runs') AND conname='jobs_project_id_cycle_key') THEN
    ALTER TABLE project_runs RENAME CONSTRAINT jobs_project_id_cycle_key TO project_runs_project_id_cycle_key;
  END IF;
  IF to_regclass('project_events') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('project_events') AND conname='project_events_job_id_fkey') THEN
    ALTER TABLE project_events RENAME CONSTRAINT project_events_job_id_fkey TO project_events_run_id_fkey;
  END IF;
  IF to_regclass('ci_repairs') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('ci_repairs') AND conname='ci_repairs_job_id_fkey') THEN
    ALTER TABLE ci_repairs RENAME CONSTRAINT ci_repairs_job_id_fkey TO ci_repairs_run_id_fkey;
  END IF;
  IF to_regclass('pr_feedback') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('pr_feedback') AND conname='pr_feedback_job_id_fkey') THEN
    ALTER TABLE pr_feedback RENAME CONSTRAINT pr_feedback_job_id_fkey TO pr_feedback_run_id_fkey;
  END IF;
  IF to_regclass('pr_feedback') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('pr_feedback') AND conname='pr_feedback_job_id_kind_external_id_revision_key') THEN
    ALTER TABLE pr_feedback RENAME CONSTRAINT pr_feedback_job_id_kind_external_id_revision_key TO pr_feedback_run_id_kind_external_id_revision_key;
  END IF;
END;
$project_run_rename$;

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
  run_count integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
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
CREATE TABLE IF NOT EXISTS project_runs (
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
DROP INDEX IF EXISTS jobs_claimable;
CREATE INDEX IF NOT EXISTS project_runs_claimable ON project_runs(stage, eligible_at, created_at);
CREATE TABLE IF NOT EXISTS project_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  type text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS project_events_project ON project_events(project_id, id);

UPDATE project_events SET type=CASE type WHEN 'attempt' THEN 'run' WHEN 'attempt_started' THEN 'run_started' END
WHERE type IN ('attempt','attempt_started');

DROP TRIGGER IF EXISTS sync_goal_pull_request ON projects;
DROP TRIGGER IF EXISTS notify_goal_change ON projects;
DROP TRIGGER IF EXISTS notify_goal_change ON project_runs;
DROP TRIGGER IF EXISTS notify_goal_change ON project_events;
DROP FUNCTION IF EXISTS sync_goal_pull_request();
DROP FUNCTION IF EXISTS notify_goal_change();

ALTER TABLE projects ADD COLUMN IF NOT EXISTS cleanup_status text NOT NULL DEFAULT 'not_required' CHECK (cleanup_status IN ('not_required','pending','complete','needs_attention'));
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS cancelled_worker text;
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS cancel_cleanup_deadline timestamptz;

ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS publication_retry_count integer NOT NULL DEFAULT 0 CHECK (publication_retry_count >= 0);
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS publication_blocked boolean NOT NULL DEFAULT false;
ALTER TABLE projects ALTER COLUMN test_command DROP NOT NULL;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS name text;
UPDATE projects SET name=COALESCE(NULLIF(regexp_replace(left(regexp_replace(replace(prompt,'[demo:fail]',''),'^[[:space:]]+|[[:space:]]+$','','g'),120),'[[:space:]]+$',''),''),'Untitled project') WHERE name IS NULL;
ALTER TABLE projects ALTER COLUMN name SET NOT NULL;

ALTER TABLE projects DROP COLUMN IF EXISTS max_attempts;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_run_count_check;
ALTER TABLE projects ADD CONSTRAINT projects_run_count_check CHECK (run_count >= 0);
ALTER TABLE project_runs DROP CONSTRAINT IF EXISTS jobs_cycle_check;
ALTER TABLE project_runs DROP CONSTRAINT IF EXISTS project_runs_cycle_check;
ALTER TABLE project_runs ADD CONSTRAINT project_runs_cycle_check CHECK (cycle >= 1);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_wip integer NOT NULL DEFAULT 1 CHECK (max_wip > 0);
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS pull_request jsonb;
-- Keep the project's summary PR aligned with the corresponding run record.
CREATE OR REPLACE FUNCTION sync_project_pull_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE project_runs SET pull_request=NEW.pull_request
    WHERE project_id=NEW.id AND branch=NEW.pull_request->>'branch'
      AND pull_request IS DISTINCT FROM NEW.pull_request;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sync_project_pull_request ON projects;
CREATE TRIGGER sync_project_pull_request AFTER INSERT OR UPDATE OF pull_request ON projects
  FOR EACH ROW EXECUTE FUNCTION sync_project_pull_request();
UPDATE project_runs j SET pull_request=g.pull_request FROM projects g
  WHERE j.project_id=g.id AND j.branch=g.pull_request->>'branch' AND j.pull_request IS NULL;

ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS ci_review_requested boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS ci_repairs (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES project_runs(id),
  head text NOT NULL,
  state text NOT NULL CHECK (state IN ('running','completed','failed')),
  lease_owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  artifact jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(run_id, head)
);
CREATE UNIQUE INDEX IF NOT EXISTS ci_repairs_one_running ON ci_repairs(run_id) WHERE state='running';

ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS ci_reviewed_at timestamptz;
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS readiness_pending boolean NOT NULL DEFAULT false;

ALTER TABLE ci_repairs DROP CONSTRAINT IF EXISTS ci_repairs_state_check;
ALTER TABLE ci_repairs ADD CONSTRAINT ci_repairs_state_check CHECK (state IN ('running','waiting','completed','failed','superseded'));

ALTER TABLE ci_repairs ADD COLUMN IF NOT EXISTS publication_started boolean NOT NULL DEFAULT false;

ALTER TABLE project_events ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES project_runs(id);

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
DROP TRIGGER IF EXISTS notify_project_change ON project_runs;
CREATE TRIGGER notify_project_change AFTER INSERT OR UPDATE OF stage, pull_request ON project_runs
  FOR EACH ROW EXECUTE FUNCTION notify_project_change();
DROP TRIGGER IF EXISTS notify_project_change ON project_events;
CREATE TRIGGER notify_project_change AFTER INSERT ON project_events
  FOR EACH ROW EXECUTE FUNCTION notify_project_change();

ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS feedback_requested boolean NOT NULL DEFAULT false;
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS feedback_reviewed_at timestamptz;
CREATE TABLE IF NOT EXISTS pr_feedback (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES project_runs(id),
  kind text NOT NULL,
  external_id bigint NOT NULL,
  revision text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','running','completed','failed')),
  lease_owner text,
  lease_expires_at timestamptz,
  artifact jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(run_id, kind, external_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_feedback_one_running ON pr_feedback(run_id) WHERE state='running';

-- Manual retries retain the failed attempt and get a fresh lease/artifact identity.
ALTER TABLE ci_repairs ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false;
ALTER TABLE ci_repairs ADD COLUMN IF NOT EXISTS retry_of uuid REFERENCES ci_repairs(id);
ALTER TABLE ci_repairs DROP CONSTRAINT IF EXISTS ci_repairs_job_id_head_key;
ALTER TABLE ci_repairs DROP CONSTRAINT IF EXISTS ci_repairs_run_id_head_key;
CREATE UNIQUE INDEX IF NOT EXISTS ci_repairs_active_head ON ci_repairs(run_id, head) WHERE state <> 'superseded';
-- Recover cleanup evidence for failures recorded before retryability was persisted.
UPDATE ci_repairs r SET retryable=true
WHERE r.state='failed' AND NOT r.publication_started AND NOT r.retryable
  AND NOT EXISTS (SELECT 1 FROM ci_repairs newer WHERE newer.run_id=r.run_id AND newer.created_at>r.created_at)
  AND (SELECT e.message FROM project_events e WHERE e.run_id=r.run_id AND e.type='ci_repair'
       AND e.created_at>=r.created_at ORDER BY e.id DESC LIMIT 1) LIKE 'Deletion confirmed for sandbox %';

ALTER TABLE projects ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'gpt-6-luna';
