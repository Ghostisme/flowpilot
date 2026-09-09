import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { RunEvent, WorkflowRun } from "@flowpilot/contracts";
import { createPool, type Pool as MysqlPool, type RowDataPacket } from "mysql2/promise";
import { Pool as PostgresPool } from "pg";

export type PersistenceDriver = "memory" | "mysql" | "postgres";

export interface PersistedWorkflowState {
  run: WorkflowRun;
  events: RunEvent[];
}

interface StoredRunRow {
  id: string;
  workflow_id: string;
  execution_id: string | null;
  status: WorkflowRun["status"];
  driver: WorkflowRun["driver"];
  input: WorkflowRun["input"] | string;
  result: WorkflowRun["result"] | string | null;
  error: string | null;
  selected_branches: string[] | string;
  node_states: WorkflowRun["nodes"] | string;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  duration_ms: number | null;
}

interface StoredEventRow {
  id: string;
  run_id: string;
  workflow_id: string;
  sequence: number;
  type: RunEvent["type"];
  execution_id: string | null;
  node_id: string | null;
  status: RunEvent["status"] | null;
  branch: string | null;
  attempt: number | null;
  duration_ms: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: Date | string;
}

type MysqlRunRow = StoredRunRow & RowDataPacket;
type MysqlEventRow = StoredEventRow & RowDataPacket;
type SqlValue = string | number | null | Date | boolean | Buffer;

function parseJson<T>(value: T | string | null, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function tablePrefix(): string {
  const prefix = process.env.FLOWPILOT_TABLE_PREFIX?.trim() || "flowpilot_";
  if (!/^[a-zA-Z0-9_]+$/.test(prefix)) {
    throw new Error("FLOWPILOT_TABLE_PREFIX may only contain letters, numbers, and underscores");
  }
  return prefix;
}

function persistenceDriver(): PersistenceDriver {
  const configured = process.env.PERSISTENCE_DRIVER?.trim().toLowerCase();
  if (configured === "memory" || configured === "mysql" || configured === "postgres") return configured;
  // Copying Agent Studio's MYSQL_* variables is enough to opt in locally and on Vercel.
  if (process.env.MYSQL_HOST) return "mysql";
  if (process.env.DATABASE_URL) return "postgres";
  return "memory";
}

@Injectable()
export class PersistenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PersistenceService.name);
  private readonly driver = persistenceDriver();
  private readonly prefix = tablePrefix();
  private readonly runsTable = `${this.prefix}workflow_runs`;
  private readonly eventsTable = `${this.prefix}workflow_events`;
  private readonly postgres = this.createPostgresPool();
  private readonly mysql = this.createMysqlPool();
  private schemaReady?: Promise<void>;

  async onModuleInit(): Promise<void> {
    this.assertConfiguration();
    await this.ensureSchema();
    if (this.driver !== "memory") {
      this.logger.log(`${this.driver === "mysql" ? "MySQL" : "PostgreSQL"} persistence enabled (${this.prefix}* tables)`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.postgres?.end(), this.mysql?.end()]);
  }

  isEnabled(): boolean {
    return this.driver !== "memory";
  }

  getDriver(): PersistenceDriver {
    return this.driver;
  }

  getTablePrefix(): string {
    return this.prefix;
  }

  async upsertRun(run: WorkflowRun): Promise<void> {
    await this.ensureSchema();
    if (this.postgres) {
      await this.postgres.query(
        `INSERT INTO ${this.runsTable} (
          id, workflow_id, execution_id, status, driver, input, result, error,
          selected_branches, node_states, created_at, started_at, finished_at, duration_ms
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET
          execution_id = EXCLUDED.execution_id,
          status = EXCLUDED.status,
          result = EXCLUDED.result,
          error = EXCLUDED.error,
          selected_branches = EXCLUDED.selected_branches,
          node_states = EXCLUDED.node_states,
          started_at = EXCLUDED.started_at,
          finished_at = EXCLUDED.finished_at,
          duration_ms = EXCLUDED.duration_ms`,
        this.runValues(run),
      );
      return;
    }
    if (this.mysql) {
      await this.mysql.execute(
        `INSERT INTO \`${this.runsTable}\` (
          id, workflow_id, execution_id, status, driver, input, result, error,
          selected_branches, node_states, created_at, started_at, finished_at, duration_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          execution_id = VALUES(execution_id),
          status = VALUES(status),
          result = VALUES(result),
          error = VALUES(error),
          selected_branches = VALUES(selected_branches),
          node_states = VALUES(node_states),
          started_at = VALUES(started_at),
          finished_at = VALUES(finished_at),
          duration_ms = VALUES(duration_ms)`,
        this.runValues(run, true),
      );
    }
  }

  async insertEvent(event: RunEvent): Promise<void> {
    await this.ensureSchema();
    const values = [
      event.id,
      event.runId,
      event.sequence,
      event.type,
      event.executionId ?? null,
      event.nodeId ?? null,
      event.status ?? null,
      event.branch ?? null,
      event.attempt ?? null,
      event.durationMs ?? null,
      event.input === undefined ? null : JSON.stringify(event.input),
      event.output === undefined ? null : JSON.stringify(event.output),
      event.error ?? null,
      event.metadata === undefined ? null : JSON.stringify(event.metadata),
      this.driver === "mysql" ? this.mysqlDate(event.createdAt) : event.createdAt,
    ];
    if (this.postgres) {
      await this.postgres.query(
        `INSERT INTO ${this.eventsTable} (
          id, run_id, sequence, type, execution_id, node_id, status, branch,
          attempt, duration_ms, input, output, error, metadata, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15)
        ON CONFLICT (run_id, sequence) DO NOTHING`,
        values as SqlValue[],
      );
      return;
    }
    if (this.mysql) {
      await this.mysql.execute(
        `INSERT IGNORE INTO \`${this.eventsTable}\` (
          id, run_id, sequence, type, execution_id, node_id, status, branch,
          attempt, duration_ms, input, output, error, metadata, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        values,
      );
    }
  }

  async loadState(limit = 100): Promise<PersistedWorkflowState[]> {
    await this.ensureSchema();
    if (this.postgres) {
      const runResult = await this.postgres.query(
        `SELECT * FROM ${this.runsTable} ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      const eventResult = await this.postgres.query(
        `SELECT events.*, runs.workflow_id
         FROM ${this.eventsTable} events
         JOIN ${this.runsTable} runs ON runs.id = events.run_id
         WHERE events.run_id = ANY($1::text[])
         ORDER BY events.run_id, events.sequence`,
        [(runResult.rows as StoredRunRow[]).map((row) => row.id)],
      );
      return this.mapStates(runResult.rows as StoredRunRow[], eventResult.rows as StoredEventRow[]);
    }
    if (this.mysql) {
      const [runs] = await this.mysql.query<MysqlRunRow[]>(
        `SELECT * FROM \`${this.runsTable}\` ORDER BY created_at DESC LIMIT ?`,
        [limit],
      );
      if (runs.length === 0) return [];
      const placeholders = runs.map(() => "?").join(",");
      const [events] = await this.mysql.query<MysqlEventRow[]>(
        `SELECT events.*, runs.workflow_id
         FROM \`${this.eventsTable}\` events
         JOIN \`${this.runsTable}\` runs ON runs.id = events.run_id
         WHERE events.run_id IN (${placeholders})
         ORDER BY events.run_id, events.sequence`,
        runs.map((row) => row.id),
      );
      return this.mapStates(runs, events);
    }
    return [];
  }

  async loadRunState(runId: string): Promise<PersistedWorkflowState | undefined> {
    await this.ensureSchema();
    if (this.postgres) {
      const [runResult, eventResult] = await Promise.all([
        this.postgres.query(`SELECT * FROM ${this.runsTable} WHERE id = $1`, [runId]),
        this.postgres.query(
          `SELECT events.*, runs.workflow_id
           FROM ${this.eventsTable} events
           JOIN ${this.runsTable} runs ON runs.id = events.run_id
           WHERE events.run_id = $1 ORDER BY events.sequence`,
          [runId],
        ),
      ]);
      return this.mapStates(runResult.rows as StoredRunRow[], eventResult.rows as StoredEventRow[])[0];
    }
    if (this.mysql) {
      const [[runs], [events]] = await Promise.all([
        this.mysql.query<MysqlRunRow[]>(`SELECT * FROM \`${this.runsTable}\` WHERE id = ?`, [runId]),
        this.mysql.query<MysqlEventRow[]>(
          `SELECT events.*, runs.workflow_id
           FROM \`${this.eventsTable}\` events
           JOIN \`${this.runsTable}\` runs ON runs.id = events.run_id
           WHERE events.run_id = ? ORDER BY events.sequence`,
          [runId],
        ),
      ]);
      return this.mapStates(runs, events)[0];
    }
    return undefined;
  }

  private createPostgresPool(): PostgresPool | undefined {
    if (this.driver !== "postgres") return undefined;
    return process.env.DATABASE_URL
      ? new PostgresPool({ connectionString: process.env.DATABASE_URL, max: 5 })
      : undefined;
  }

  private createMysqlPool(): MysqlPool | undefined {
    if (this.driver !== "mysql" || !process.env.MYSQL_HOST) return undefined;
    const sslEnabled = process.env.MYSQL_SSL?.trim().toLowerCase() === "true";
    const ca = process.env.MYSQL_SSL_CA?.replace(/\\n/g, "\n").trim();
    return createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DB ?? "defaultdb",
      waitForConnections: true,
      connectionLimit: Math.max(1, Number(process.env.MYSQL_POOL_SIZE ?? 2)),
      maxIdle: Math.max(1, Number(process.env.MYSQL_POOL_SIZE ?? 2)),
      idleTimeout: 30_000,
      enableKeepAlive: true,
      timezone: "Z",
      dateStrings: true,
      ssl: sslEnabled ? { ca: ca || undefined, rejectUnauthorized: Boolean(ca) } : undefined,
    });
  }

  private assertConfiguration(): void {
    if (this.driver === "postgres" && !this.postgres) {
      throw new Error("DATABASE_URL is required when PERSISTENCE_DRIVER=postgres");
    }
    if (this.driver === "mysql" && !this.mysql) {
      throw new Error("MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DB are required when PERSISTENCE_DRIVER=mysql");
    }
  }

  private async ensureSchema(): Promise<void> {
    if (this.driver === "memory") return;
    this.schemaReady ??= this.postgres ? this.ensurePostgresSchema() : this.ensureMysqlSchema();
    await this.schemaReady;
  }

  private async ensurePostgresSchema(): Promise<void> {
    if (!this.postgres) return;
    await this.postgres.query(`
      CREATE TABLE IF NOT EXISTS ${this.runsTable} (
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
      CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
        id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES ${this.runsTable}(id) ON DELETE CASCADE,
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
      CREATE INDEX IF NOT EXISTS ${this.runsTable}_created_idx ON ${this.runsTable}(created_at DESC);
      CREATE INDEX IF NOT EXISTS ${this.eventsTable}_run_idx ON ${this.eventsTable}(run_id, sequence);
    `);
  }

  private async ensureMysqlSchema(): Promise<void> {
    if (!this.mysql) return;
    await this.mysql.query(`
      CREATE TABLE IF NOT EXISTS \`${this.runsTable}\` (
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
        KEY \`${this.runsTable}_created_idx\` (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await this.mysql.query(`
      CREATE TABLE IF NOT EXISTS \`${this.eventsTable}\` (
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
        UNIQUE KEY \`${this.eventsTable}_run_sequence_uq\` (run_id, sequence),
        KEY \`${this.eventsTable}_run_idx\` (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES \`${this.runsTable}\` (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  private runValues(run: WorkflowRun, mysql = false): SqlValue[] {
    const date = (value?: string): string | null => {
      if (!value) return null;
      return mysql ? this.mysqlDate(value) : value;
    };
    return [
      run.id,
      run.workflowId,
      run.executionId ?? null,
      run.status,
      run.driver,
      JSON.stringify(run.input),
      run.result ? JSON.stringify(run.result) : null,
      run.error ?? null,
      JSON.stringify(run.selectedBranches),
      JSON.stringify(run.nodes),
      date(run.createdAt),
      date(run.startedAt),
      date(run.finishedAt),
      run.durationMs ?? null,
    ];
  }

  private mapStates(runRows: StoredRunRow[], eventRows: StoredEventRow[]): PersistedWorkflowState[] {
    const eventsByRun = new Map<string, RunEvent[]>();
    for (const row of eventRows) {
      const list = eventsByRun.get(row.run_id) ?? [];
      list.push({
        id: row.id,
        sequence: Number(row.sequence),
        type: row.type,
        runId: row.run_id,
        workflowId: row.workflow_id,
        executionId: row.execution_id ?? undefined,
        nodeId: row.node_id ?? undefined,
        status: row.status ?? undefined,
        branch: row.branch ?? undefined,
        attempt: row.attempt === null ? undefined : Number(row.attempt),
        durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
        input: parseJson(row.input as string | null, undefined),
        output: parseJson(row.output as string | null, undefined),
        error: row.error ?? undefined,
        metadata: parseJson(row.metadata, undefined),
        createdAt: this.iso(row.created_at),
      });
      eventsByRun.set(row.run_id, list);
    }
    return runRows.map((row) => ({
      run: {
        id: row.id,
        workflowId: row.workflow_id,
        executionId: row.execution_id ?? undefined,
        status: row.status,
        driver: row.driver,
        input: parseJson(row.input, {} as WorkflowRun["input"]),
        result: parseJson(row.result, undefined),
        error: row.error ?? undefined,
        selectedBranches: parseJson(row.selected_branches, []),
        nodes: parseJson(row.node_states, {}),
        createdAt: this.iso(row.created_at),
        startedAt: row.started_at ? this.iso(row.started_at) : undefined,
        finishedAt: row.finished_at ? this.iso(row.finished_at) : undefined,
        durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      },
      events: eventsByRun.get(row.id) ?? [],
    }));
  }

  private iso(value: Date | string): string {
    if (value instanceof Date) return value.toISOString();
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
    return new Date(normalized).toISOString();
  }

  private mysqlDate(value: string): string {
    return new Date(value).toISOString().slice(0, 23).replace("T", " ");
  }
}
