import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Sse,
  UnauthorizedException,
} from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import { map, type Observable } from "rxjs";
import {
  LEAD_WORKFLOW,
  NODE_STATUSES,
  RUN_EVENT_TYPES,
  RUN_STATUSES,
  type RunEvent,
  type RunEventType,
} from "@flowpilot/contracts";
import { ApprovalDto } from "./dto/approval.dto";
import { CreateRunDto } from "./dto/create-run.dto";
import { WorkflowRunsService } from "./workflow-runs.service";

@Controller()
export class WorkflowsController {
  constructor(private readonly runs: WorkflowRunsService) {}

  @Get("workflows")
  listWorkflows() {
    return { workflows: [LEAD_WORKFLOW] };
  }

  @Get("workflows/:workflowId")
  getWorkflow(@Param("workflowId") workflowId: string) {
    if (workflowId !== LEAD_WORKFLOW.id) throw new NotFoundException(`Workflow ${workflowId} was not found`);
    return LEAD_WORKFLOW;
  }

  @Get("runs")
  async listRuns() {
    return { runs: await this.runs.listRuns() };
  }

  @Post("workflows/:workflowId/runs")
  async createRun(@Param("workflowId") workflowId: string, @Body() body: CreateRunDto) {
    if (workflowId !== LEAD_WORKFLOW.id) throw new NotFoundException(`Workflow ${workflowId} was not found`);
    return { run: await this.runs.createRun(body.input) };
  }

  @Get("runs/:runId")
  async getRun(@Param("runId") runId: string) {
    return { run: await this.runs.getRun(runId) };
  }

  @Get("runs/:runId/events")
  async getEvents(@Param("runId") runId: string) {
    return { events: await this.runs.getEvents(runId) };
  }

  @Sse("runs/:runId/events/stream")
  streamEvents(@Param("runId") runId: string): Observable<MessageEvent> {
    return this.runs
      .subscribe(runId)
      .pipe(map((event: RunEvent) => ({ id: event.id, type: "run-event", data: event })));
  }

  @Post("runs/:runId/approve")
  async approve(@Param("runId") runId: string, @Body() body: ApprovalDto) {
    return { run: await this.runs.resolveApproval(runId, body) };
  }

  @Post("internal/n8n/events")
  @HttpCode(202)
  async receiveN8nEvent(
    @Headers("x-flowpilot-event-secret") secret: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const expected = process.env.N8N_EVENT_SECRET ?? "flowpilot-local-secret";
    if (secret !== expected) throw new UnauthorizedException("Invalid event secret");
    const context = body.context;
    const rawEvents = Array.isArray(body.events)
      ? body.events
      : [typeof body.event === "object" && body.event !== null ? body.event : body];
    const accepted: RunEvent[] = [];
    for (const raw of rawEvents) {
      const payload = raw as Partial<RunEvent>;
      if (!payload.runId || !payload.workflowId || !payload.type) {
        throw new BadRequestException("runId, workflowId, and type are required");
      }
      if (!RUN_EVENT_TYPES.includes(payload.type as RunEventType)) {
        throw new BadRequestException(`Unsupported event type: ${payload.type}`);
      }
      if (
        payload.status
        && !NODE_STATUSES.includes(payload.status as (typeof NODE_STATUSES)[number])
        && !RUN_STATUSES.includes(payload.status as (typeof RUN_STATUSES)[number])
      ) {
        throw new BadRequestException(`Unsupported event status: ${payload.status}`);
      }
      accepted.push(await this.runs.receiveExternalEvent({
        runId: payload.runId,
        workflowId: payload.workflowId,
        type: payload.type,
        executionId: payload.executionId,
        nodeId: payload.nodeId,
        status: payload.status,
        branch: payload.branch,
        attempt: payload.attempt,
        durationMs: payload.durationMs,
        input: payload.input,
        output: payload.output,
        error: payload.error,
        metadata: payload.metadata,
      }));
    }
    return context ?? { accepted: true, eventIds: accepted.map((event) => event.id) };
  }
}
