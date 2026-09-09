import type { NodeRunState, RunEvent, WorkflowRun } from "@flowpilot/contracts";

export function applyRunEvent(run: WorkflowRun, event: RunEvent): WorkflowRun {
  const next: WorkflowRun = {
    ...run,
    nodes: { ...run.nodes },
    selectedBranches: [...run.selectedBranches],
  };
  if (event.executionId) next.executionId = event.executionId;

  if (event.type === "run.started") {
    next.status = "running";
    next.startedAt ??= event.createdAt;
  }
  if (event.type === "run.completed") {
    next.status = "succeeded";
    next.finishedAt = event.createdAt;
    next.durationMs = elapsed(next.startedAt, next.finishedAt);
    next.result = (event.output as Record<string, unknown> | undefined) ?? {};
  }
  if (event.type === "run.failed") {
    next.status = "failed";
    next.finishedAt = event.createdAt;
    next.durationMs = elapsed(next.startedAt, next.finishedAt);
    next.error = event.error ?? "Workflow failed";
  }
  if (event.type === "node.waiting" || event.type === "approval.required") next.status = "waiting";
  if (event.type === "approval.resolved") next.status = "running";
  if (event.type === "branch.selected" && event.branch && !next.selectedBranches.includes(event.branch)) {
    next.selectedBranches.push(event.branch);
  }

  if (event.nodeId && event.status) {
    const current: NodeRunState = next.nodes[event.nodeId] ?? {
      nodeId: event.nodeId,
      status: "pending",
    };
    next.nodes[event.nodeId] = {
      ...current,
      status: event.status as NodeRunState["status"],
      startedAt: event.type === "node.started" ? event.createdAt : current.startedAt,
      finishedAt: ["node.completed", "node.skipped", "node.failed"].includes(event.type)
        ? event.createdAt
        : current.finishedAt,
      durationMs: event.durationMs ?? current.durationMs,
      attempt: event.attempt ?? current.attempt,
      input: event.input ?? current.input,
      output: event.output ?? current.output,
      error: event.error ?? current.error,
    };
  }

  return next;
}

function elapsed(start?: string, finish?: string): number | undefined {
  if (!start || !finish) return undefined;
  return Math.max(0, new Date(finish).getTime() - new Date(start).getTime());
}
