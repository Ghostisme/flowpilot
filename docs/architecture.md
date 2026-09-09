# FlowPilot architecture

## Run lifecycle

1. The console posts a typed `LeadInput` to the API.
2. The API creates a `WorkflowRun` with all graph nodes in `pending` state.
3. The selected driver executes the workflow:
   - **Simulator**: runs the same business branches in-process with short observable delays.
   - **n8n**: posts the run envelope to the imported webhook workflow.
4. Each node/branch transition becomes a `RunEvent`.
5. The API applies events to the run read model and persists them in the configured MySQL or PostgreSQL store.
6. The console consumes a replayable RxJS SSE stream locally, or polls the durable database-backed read model when deployed as stateless Vercel Functions.
7. The console reduces events into graph colors, timeline rows, metrics, and approval controls.

## Event contract

The event protocol intentionally separates immutable history from the mutable run projection.

```ts
interface RunEvent {
  id: string;
  sequence: number;
  type: "run.started" | "node.started" | "node.completed" | "node.skipped"
    | "node.waiting" | "branch.selected" | "approval.required"
    | "approval.resolved" | "run.completed" | "run.failed";
  runId: string;
  workflowId: string;
  nodeId?: string;
  status?: string;
  branch?: string;
  output?: unknown;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
```

The internal n8n endpoint accepts either one event, an event batch, or the `{ context, events }` envelope emitted by the reusable sub-workflow. It returns the unwrapped context so the calling n8n node can continue with the original run state.

## Why the API owns the event protocol

n8n is excellent at orchestration and integrations, but a portfolio-grade console still needs a stable product contract. Keeping the run/event model in the API means:

- the UI is not coupled to n8n's internal execution tables;
- the simulator and n8n driver produce the same observable shape;
- the approval UI can resume either an in-process waiter or an n8n Wait node;
- audit storage and retention can evolve independently of workflow editing.

## Vercel and shared MySQL

FlowPilot Web and FlowPilot API are separate Vercel projects rooted at `apps/web` and `apps/api`. The NestJS entrypoint remains `apps/api/src/main.ts`, which Vercel packages as one function. The API rehydrates a requested run from durable storage before reads, n8n callbacks, and approval actions, so correctness does not depend on a callback reaching the same warm function instance that created the run.

The recommended cloud driver is MySQL using the same `MYSQL_*` connection variables as Agent Studio. Isolation is enforced at the table boundary: FlowPilot defaults to the `flowpilot_` prefix and only creates `flowpilot_workflow_runs` and `flowpilot_workflow_events`.

n8n remains a long-running external runtime. Its public trigger acknowledges immediately and continues execution asynchronously; every state transition is sent back to the authenticated FlowPilot callback. This prevents a Vercel request from staying open while a workflow is paused on human approval.

## Adding a real integration

1. Add a provider adapter under `apps/api/src/integrations` or replace the corresponding n8n HTTP node.
2. Keep the adapter response nested under a stable key (`crmResult`, `slackResult`, or `emailResult`).
3. Emit a `node.completed` event with provider-safe metadata; do not put secrets into event output.
4. Add one simulator branch test and one contract-level event assertion.
