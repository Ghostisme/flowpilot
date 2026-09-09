-- Safe to run in the same MYSQL_DB used by Agent Studio.
-- FlowPilot never reads or changes Agent Studio's ip_blocklist table.

CREATE TABLE IF NOT EXISTS flowpilot_workflow_runs (
  id varchar(80) PRIMARY KEY,
  workflow_id varchar(100) NOT NULL,
  execution_id varchar(120) NULL,
  status varchar(24) NOT NULL,
  driver varchar(24) NOT NULL,
  input json NOT NULL,
  result json NULL,
  error text NULL,
  selected_branches json NOT NULL,
  node_states json NOT NULL,
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at datetime(3) NULL,
  finished_at datetime(3) NULL,
  duration_ms int NULL,
  KEY flowpilot_workflow_runs_created_idx (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flowpilot_workflow_events (
  id varchar(80) PRIMARY KEY,
  run_id varchar(80) NOT NULL,
  sequence int NOT NULL,
  type varchar(40) NOT NULL,
  execution_id varchar(120) NULL,
  node_id varchar(100) NULL,
  status varchar(24) NULL,
  branch varchar(80) NULL,
  attempt int NULL,
  duration_ms int NULL,
  input json NULL,
  output json NULL,
  error text NULL,
  metadata json NULL,
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY flowpilot_workflow_events_run_sequence_uq (run_id, sequence),
  KEY flowpilot_workflow_events_run_idx (run_id, sequence),
  FOREIGN KEY (run_id) REFERENCES flowpilot_workflow_runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
