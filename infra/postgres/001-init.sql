CREATE TABLE IF NOT EXISTS flowpilot_workflow_runs (
  id text PRIMARY KEY,
  workflow_id text NOT NULL,
  execution_id text,
  status text NOT NULL,
  driver text NOT NULL,
  input jsonb NOT NULL,
  result jsonb,
  error text,
  selected_branches jsonb NOT NULL DEFAULT '[]'::jsonb,
  node_states jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer
);

CREATE TABLE IF NOT EXISTS flowpilot_workflow_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES flowpilot_workflow_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  type text NOT NULL,
  execution_id text,
  node_id text,
  status text,
  branch text,
  attempt integer,
  duration_ms integer,
  input jsonb,
  output jsonb,
  error text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, sequence)
);

CREATE INDEX IF NOT EXISTS flowpilot_workflow_runs_created_idx ON flowpilot_workflow_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS flowpilot_workflow_events_run_idx ON flowpilot_workflow_events(run_id, sequence);
