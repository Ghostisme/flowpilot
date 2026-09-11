import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";
import type {
  ApprovalRequest,
  LeadInput,
  NodeStatus,
  RunEvent,
  RunEventType,
  RunStatus,
  WorkflowRun,
} from "@flowpilot/contracts";
import { LEAD_WORKFLOW } from "@flowpilot/contracts";
import { ReplaySubject } from "rxjs";
import { PersistenceService } from "../database/persistence.service";

type EventPatch = Omit<Partial<RunEvent>, "id" | "sequence" | "createdAt" | "runId" | "workflowId">;

interface ApprovalWaiter {
  resolve: (request: ApprovalRequest) => void;
}

interface Qualification {
  score: number;
  route: "high" | "medium" | "low";
  intent: string;
  confidence: number;
  signals: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

@Injectable()
export class WorkflowRunsService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowRunsService.name);
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly events = new Map<string, RunEvent[]>();
  private readonly subjects = new Map<string, ReplaySubject<RunEvent>>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(private readonly database: PersistenceService) {}

  async onModuleInit(): Promise<void> {
    const persisted = await this.database.loadState();
    for (const state of persisted) {
      this.runs.set(state.run.id, state.run);
      this.events.set(state.run.id, state.events);
      const stream = new ReplaySubject<RunEvent>(250);
      for (const event of state.events) stream.next(event);
      this.subjects.set(state.run.id, stream);
    }
    if (persisted.length > 0) this.logger.log(`Restored ${persisted.length} workflow runs`);
  }

  getDefinition() {
    return LEAD_WORKFLOW;
  }

  async listRuns(): Promise<WorkflowRun[]> {
    if (this.database.isEnabled()) {
      const persisted = await this.database.loadState();
      for (const state of persisted) this.hydrate(state);
    }
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((run) => clone(run));
  }

  async getRun(runId: string): Promise<WorkflowRun> {
    await this.refreshRun(runId);
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundException(`Run ${runId} was not found`);
    return clone(run);
  }

  async getEvents(runId: string): Promise<RunEvent[]> {
    await this.refreshRun(runId);
    if (!this.runs.has(runId)) throw new NotFoundException(`Run ${runId} was not found`);
    return clone(this.events.get(runId) ?? []);
  }

  subscribe(runId: string): ReplaySubject<RunEvent> {
    if (!this.runs.has(runId)) throw new NotFoundException(`Run ${runId} was not found`);
    let subject = this.subjects.get(runId);
    if (!subject) {
      subject = new ReplaySubject<RunEvent>(250);
      this.subjects.set(runId, subject);
    }
    return subject;
  }

  async createRun(input: LeadInput): Promise<WorkflowRun> {
    const runId = id("run");
    const createdAt = now();
    const nodeStates = Object.fromEntries(
      LEAD_WORKFLOW.nodes.map((node) => [node.id, { nodeId: node.id, status: "pending" as const }]),
    );
    const run: WorkflowRun = {
      id: runId,
      workflowId: LEAD_WORKFLOW.id,
      status: "queued",
      driver: (process.env.WORKFLOW_DRIVER ?? "simulator") === "n8n" ? "n8n" : "simulator",
      input: clone(input),
      selectedBranches: [],
      nodes: nodeStates,
      createdAt,
    };
    this.runs.set(runId, run);
    this.events.set(runId, []);
    this.subjects.set(runId, new ReplaySubject<RunEvent>(250));
    await this.persistRun(run);

    const execution = this.execute(runId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Run ${runId} crashed: ${message}`);
      this.appendEvent(runId, "run.failed", { status: "failed", error: message });
    });
    if (run.driver === "n8n") {
      // n8n's public webhook uses responseMode=onReceived. Awaiting it only
      // confirms that the external runtime accepted the execution; the long
      // workflow and approval wait continue in n8n after Vercel responds.
      await execution;
      await this.flushPersistence(runId);
    } else {
      void execution;
    }

    return clone(run);
  }

  async resolveApproval(runId: string, request: ApprovalRequest): Promise<WorkflowRun> {
    const run = await this.refreshRun(runId);
    if (run.status !== "waiting") {
      throw new ConflictException("This run is not waiting for approval");
    }
    if (run.driver === "n8n") {
      const approvalEvent = [...(this.events.get(runId) ?? [])]
        .reverse()
        .find((event) => event.type === "approval.required");
      const resumeUrl = approvalEvent?.metadata?.resumeUrl;
      if (typeof resumeUrl !== "string" || !resumeUrl.startsWith("http")) {
        throw new ConflictException("The n8n wait node did not provide a resume URL");
      }
      await this.resumeN8nApproval(resumeUrl, request);
      return clone(this.requireRun(runId));
    }
    if (!this.approvalWaiters.has(runId)) {
      throw new ConflictException("The simulator approval waiter is no longer active");
    }
    this.appendEvent(runId, "approval.resolved", {
      nodeId: "approval",
      status: "running",
      output: request,
      metadata: { note: request.note ?? null },
    });
    this.approvalWaiters.get(runId)?.resolve(request);
    this.approvalWaiters.delete(runId);
    return clone(this.requireRun(runId));
  }

  async receiveExternalEvent(event: Omit<RunEvent, "id" | "sequence" | "createdAt">): Promise<RunEvent> {
    await this.refreshRun(event.runId);
    const run = this.requireRun(event.runId);
    if (event.workflowId !== run.workflowId) throw new BadRequestException("Workflow ID does not match the run");
    const accepted = this.appendEvent(event.runId, event.type, event);
    await this.flushPersistence(event.runId);
    return accepted;
  }

  private async execute(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (run.driver === "n8n") {
      await this.executeN8n(runId);
      return;
    }
    this.appendEvent(runId, "run.started", { status: "running" });
    await this.executeSimulator(runId);
  }

  private async executeN8n(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    if (!webhookUrl) {
      this.appendEvent(runId, "run.failed", { status: "failed", error: "N8N_WEBHOOK_URL is not configured" });
      return;
    }
    try {
      await this.waitForN8nReady(webhookUrl);
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-flowpilot-event-secret": process.env.N8N_EVENT_SECRET ?? "",
        },
        body: JSON.stringify({ runId, workflowId: run.workflowId, input: run.input }),
        signal: AbortSignal.timeout(Number(process.env.N8N_WEBHOOK_TIMEOUT_MS ?? 10_000)),
      });
      if (!response.ok) {
        throw new Error(`n8n webhook returned ${response.status}`);
      }
      const body = (await response.json().catch(() => ({}))) as { executionId?: string };
      if (body.executionId) {
        run.executionId = body.executionId;
      }
      await this.persistRun(run);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendEvent(runId, "run.failed", { status: "failed", error: message });
    }
  }

  private async executeSimulator(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const input = run.input;
    await this.node(runId, "webhook", "success", { received: true, source: input.source });
    await this.node(runId, "normalize", "success", {
      normalizedEmail: input.email.toLowerCase(),
      idempotencyKey: `${input.email.toLowerCase()}:${input.company.toLowerCase()}`,
    });

    const scenario = input.scenario ?? "custom";
    if (scenario === "invalid") {
      await this.node(runId, "validate", "success", { valid: false, missing: ["email"] });
      this.appendEvent(runId, "branch.selected", { branch: "invalid", nodeId: "validate", output: { reason: "invalid_payload" } });
      this.skipNodes(runId, ["dedupe", "ai_extract", "score", "route", "crm", "slack", "approval", "nurture"]);
      await this.node(runId, "error", "success", { code: "VALIDATION_ERROR", message: "Email is required" });
      await this.node(runId, "audit", "success", { outcome: "rejected", reason: "invalid_payload" });
      await this.node(runId, "response", "success", { accepted: false, reason: "invalid_payload" });
      this.appendEvent(runId, "run.completed", {
        status: "succeeded",
        output: { outcome: "rejected", reason: "invalid_payload" },
      });
      return;
    }

    await this.node(runId, "validate", "success", { valid: true, fields: ["name", "company", "email", "message"] });
    this.skipNodes(runId, ["error"]);
    await this.node(runId, "dedupe", "success", { duplicate: scenario === "duplicate" });
    if (scenario === "duplicate") {
      this.appendEvent(runId, "branch.selected", { branch: "duplicate", nodeId: "dedupe", output: { existingLeadId: "crm_lead_existing_042" } });
      this.skipNodes(runId, ["ai_extract", "score", "route", "crm", "slack", "approval", "nurture"]);
      await this.node(runId, "audit", "success", { outcome: "skipped_duplicate", existingLeadId: "crm_lead_existing_042" });
      await this.node(runId, "response", "success", { accepted: true, outcome: "skipped_duplicate" });
      this.appendEvent(runId, "run.completed", {
        status: "succeeded",
        output: { outcome: "skipped_duplicate", existingLeadId: "crm_lead_existing_042" },
      });
      return;
    }

    const qualification = this.qualify(input);
    await this.node(runId, "ai_extract", "success", {
      intent: qualification.intent,
      confidence: qualification.confidence,
      signals: qualification.signals,
      adapter: { provider: "deterministic", model: "flowpilot-rules-v1" },
    });
    await this.node(runId, "score", "success", {
      score: qualification.score,
      route: qualification.route,
      explanation: this.scoreExplanation(qualification),
    });
    await this.node(runId, "route", "success", {
      score: qualification.score,
      route: qualification.route,
    });
    this.appendEvent(runId, "branch.selected", {
      nodeId: "route",
      branch: qualification.route,
      output: { score: qualification.score, route: qualification.route },
    });

    if (qualification.route === "medium") {
      this.skipNodes(runId, ["nurture"]);
      await this.node(runId, "approval", "waiting", {
        requestedBy: "lead-routing-policy",
        reason: "Medium-intent leads require human review before CRM side effects.",
      }, false);
      this.appendEvent(runId, "approval.required", {
        nodeId: "approval",
        status: "waiting",
        output: { score: qualification.score, decision: "pending" },
      });
      const decision = await new Promise<ApprovalRequest>((resolve) => {
        this.approvalWaiters.set(runId, { resolve });
      });
      this.appendEvent(runId, "node.completed", {
        nodeId: "approval",
        status: "success",
        output: decision,
      });
      if (decision.decision === "rejected") {
        this.appendEvent(runId, "branch.selected", { nodeId: "approval", branch: "rejected" });
        this.skipNodes(runId, ["crm", "slack"]);
        await this.node(runId, "audit", "success", { outcome: "rejected_by_human", note: decision.note ?? null });
        await this.node(runId, "response", "success", { accepted: true, outcome: "rejected_by_human" });
        this.appendEvent(runId, "run.completed", {
          status: "succeeded",
          output: { outcome: "rejected_by_human", note: decision.note ?? null },
        });
        return;
      }
      this.appendEvent(runId, "branch.selected", { nodeId: "approval", branch: "approved" });
      await this.node(runId, "crm", "success", { recordId: `crm_lead_${id("mid").slice(-8)}`, status: "approved" });
      await this.node(runId, "slack", "success", { channel: "#sales-triage", delivered: true });
      await this.node(runId, "audit", "success", { outcome: "approved_and_routed", score: qualification.score });
      await this.node(runId, "response", "success", { accepted: true, outcome: "approved_and_routed" });
      this.appendEvent(runId, "run.completed", {
        status: "succeeded",
        output: { outcome: "approved_and_routed", score: qualification.score },
      });
      return;
    }

    if (qualification.route === "high") {
      this.skipNodes(runId, ["approval", "nurture"]);
      await this.node(runId, "crm", "success", { recordId: `crm_lead_${id("high").slice(-8)}`, priority: "high" });
      await this.node(runId, "slack", "success", { channel: "#sales-hot-leads", delivered: true });
      await this.node(runId, "audit", "success", { outcome: "routed_to_sales", score: qualification.score });
      await this.node(runId, "response", "success", { accepted: true, outcome: "routed_to_sales" });
      this.appendEvent(runId, "run.completed", {
        status: "succeeded",
        output: { outcome: "routed_to_sales", score: qualification.score },
      });
      return;
    }

    this.skipNodes(runId, ["crm", "slack", "approval"]);
    await this.node(runId, "nurture", "success", { campaign: "ai-workflow-education", delivered: true });
    await this.node(runId, "audit", "success", { outcome: "nurture_started", score: qualification.score });
    await this.node(runId, "response", "success", { accepted: true, outcome: "nurture_started" });
    this.appendEvent(runId, "run.completed", {
      status: "succeeded",
      output: { outcome: "nurture_started", score: qualification.score },
    });
  }

  private async node(
    runId: string,
    nodeId: string,
    status: NodeStatus,
    output: unknown,
    delay = true,
  ): Promise<void> {
    this.appendEvent(runId, "node.started", { nodeId, status: "running" });
    const started = Date.now();
    const baseDelay = Math.max(0, Number(process.env.SIMULATOR_NODE_DELAY_MS ?? 130));
    if (delay && baseDelay > 0) await sleep(baseDelay + Math.round(Math.random() * baseDelay));
    this.appendEvent(runId, status === "waiting" ? "node.waiting" : "node.completed", {
      nodeId,
      status,
      durationMs: Math.max(1, Date.now() - started),
      output,
    });
  }

  private qualify(input: LeadInput): Qualification {
    if (input.scenario === "high") {
      return {
        score: 87,
        route: "high",
        intent: "buying_workflow_automation",
        confidence: 0.96,
        signals: ["clear business problem", "integration request", "near-term project language"],
      };
    }
    if (input.scenario === "medium") {
      return {
        score: 62,
        route: "medium",
        intent: "exploring_workflow_options",
        confidence: 0.82,
        signals: ["specific use case", "unclear timeline", "needs qualification"],
      };
    }
    if (input.scenario === "low") {
      return {
        score: 28,
        route: "low",
        intent: "early_research",
        confidence: 0.77,
        signals: ["general inquiry", "low urgency", "no buying signal"],
      };
    }
    const text = `${input.company} ${input.message}`.toLowerCase();
    const highSignal = ["budget", "integration", "automate", "workflow", "urgent"].some((word) => text.includes(word));
    const score = highSignal ? 78 : 42;
    return {
      score,
      route: score >= 70 ? "high" : "low",
      intent: highSignal ? "workflow_automation" : "general_inquiry",
      confidence: 0.71,
      signals: highSignal ? ["workflow vocabulary", "action-oriented request"] : ["needs further discovery"],
    };
  }

  private skipNodes(runId: string, nodeIds: string[]): void {
    for (const nodeId of nodeIds) {
      const current = this.requireRun(runId).nodes[nodeId];
      if (!current || current.status !== "pending") continue;
      this.appendEvent(runId, "node.skipped", {
        nodeId,
        status: "skipped",
        output: { reason: "branch_not_selected" },
      });
    }
  }

  private scoreExplanation(qualification: Qualification): string {
    return `${qualification.score}/100 because ${qualification.signals.join(", ")}.`;
  }

  private appendEvent(runId: string, type: RunEventType, patch: EventPatch): RunEvent {
    const run = this.requireRun(runId);
    const eventList = this.events.get(runId) ?? [];
    const event: RunEvent = {
      id: id("evt"),
      sequence: eventList.length + 1,
      type,
      runId,
      workflowId: run.workflowId,
      createdAt: now(),
      ...clone(patch),
    };
    eventList.push(event);
    this.events.set(runId, eventList);
    this.applyEvent(run, event);
    this.subjects.get(runId)?.next(event);
    this.queuePersistence(event, run);
    return event;
  }

  private applyEvent(run: WorkflowRun, event: RunEvent): void {
    if (event.executionId) run.executionId = event.executionId;
    if (event.type === "run.started") {
      run.status = "running";
      run.startedAt ??= event.createdAt;
    }
    if (event.type === "run.completed") {
      run.status = "succeeded";
      run.finishedAt = event.createdAt;
      run.durationMs = this.duration(run.startedAt, run.finishedAt);
      run.result = (event.output as Record<string, unknown> | undefined) ?? {};
    }
    if (event.type === "run.failed") {
      run.status = "failed";
      run.finishedAt = event.createdAt;
      run.durationMs = this.duration(run.startedAt, run.finishedAt);
      run.error = event.error ?? "Workflow failed";
    }
    if (event.type === "node.waiting" || event.type === "approval.required") run.status = "waiting";
    if (event.type === "approval.resolved") run.status = "running";
    if (event.type === "branch.selected" && event.branch && !run.selectedBranches.includes(event.branch)) {
      run.selectedBranches.push(event.branch);
    }
    if (event.nodeId && event.status) {
      const existing = run.nodes[event.nodeId] ?? { nodeId: event.nodeId, status: "pending" as const };
      run.nodes[event.nodeId] = {
        ...existing,
        status: event.status as NodeStatus,
        startedAt: event.type === "node.started" ? event.createdAt : existing.startedAt,
        finishedAt: ["node.completed", "node.skipped", "node.failed"].includes(event.type)
          ? event.createdAt
          : existing.finishedAt,
        durationMs: event.durationMs ?? existing.durationMs,
        attempt: event.attempt ?? existing.attempt,
        input: event.input ?? existing.input,
        output: event.output ?? existing.output,
        error: event.error ?? existing.error,
      };
    }
  }

  private requireRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundException(`Run ${runId} was not found`);
    return run;
  }

  private async refreshRun(runId: string): Promise<WorkflowRun> {
    if (this.database.isEnabled()) {
      await this.flushPersistence(runId);
      const persisted = await this.database.loadRunState(runId);
      if (persisted) this.hydrate(persisted);
    }
    return this.requireRun(runId);
  }

  private hydrate(state: { run: WorkflowRun; events: RunEvent[] }): void {
    this.runs.set(state.run.id, state.run);
    this.events.set(state.run.id, state.events);
    let stream = this.subjects.get(state.run.id);
    if (!stream) {
      stream = new ReplaySubject<RunEvent>(250);
      for (const event of state.events) stream.next(event);
      this.subjects.set(state.run.id, stream);
    }
  }

  private duration(start?: string, end?: string): number | undefined {
    if (!start || !end) return undefined;
    return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  }

  private n8nResumeUrl(resumeUrl: string): string {
    const internalBase = process.env.N8N_INTERNAL_BASE_URL;
    if (!internalBase) return resumeUrl;
    const source = new URL(resumeUrl);
    const target = new URL(internalBase);
    source.protocol = target.protocol;
    source.host = target.host;
    return source.toString();
  }

  private async waitForN8nReady(runtimeUrl: string): Promise<void> {
    const timeoutMs = Number(process.env.N8N_COLD_START_TIMEOUT_MS ?? 0);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

    const healthUrl = process.env.N8N_HEALTHCHECK_URL?.trim()
      || new URL("/healthz", runtimeUrl).toString();
    const pollMs = Math.max(100, Number(process.env.N8N_COLD_START_POLL_MS ?? 2_000));
    const deadline = Date.now() + timeoutMs;
    let lastFailure = "no response";

    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      try {
        const response = await fetch(healthUrl, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remainingMs))),
        });
        const contentType = response.headers.get("content-type") ?? "";
        if (response.ok && contentType.toLowerCase().includes("application/json")) {
          const body = (await response.json().catch(() => undefined)) as { status?: string } | undefined;
          if (body?.status === "ok") return;
        }
        lastFailure = `health check returned ${response.status}`;
      } catch (error: unknown) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }

      const waitMs = Math.min(pollMs, Math.max(0, deadline - Date.now()));
      if (waitMs > 0) await sleep(waitMs);
    }

    throw new Error(`n8n did not become ready within ${timeoutMs}ms (${lastFailure})`);
  }

  private async resumeN8nApproval(resumeUrl: string, request: ApprovalRequest): Promise<void> {
    const target = this.n8nResumeUrl(resumeUrl);
    await this.waitForN8nReady(target);
    let lastStatus = 0;
    // `approval.required` is emitted immediately before the n8n Wait node. On a
    // fast UI click, n8n can still be committing the waiting execution and
    // briefly answers 404/409. Retry only those transient registration states.
    await sleep(100);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      lastStatus = response.status;
      if (![404, 409].includes(response.status)) break;
      await sleep(100);
    }
    throw new BadGatewayException(`n8n approval webhook returned ${lastStatus || "no response"}`);
  }

  private async persistRun(run: WorkflowRun): Promise<void> {
    await this.database.upsertRun(run);
  }

  private async persistEvent(event: RunEvent, run: WorkflowRun): Promise<void> {
    await this.database.insertEvent(event);
    await this.persistRun(run);
  }

  private queuePersistence(event: RunEvent, run: WorkflowRun): void {
    if (!this.database.isEnabled()) return;
    const snapshot = clone(run);
    const previous = this.pendingWrites.get(event.runId) ?? Promise.resolve();
    const next = previous.then(() => this.persistEvent(event, snapshot));
    this.pendingWrites.set(event.runId, next);
    void next.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Persistence failed for ${event.runId}: ${message}`);
    });
  }

  private async flushPersistence(runId: string): Promise<void> {
    const pending = this.pendingWrites.get(runId);
    if (!pending) return;
    await pending;
    if (this.pendingWrites.get(runId) === pending) this.pendingWrites.delete(runId);
  }
}
