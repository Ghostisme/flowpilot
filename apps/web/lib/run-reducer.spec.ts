import { describe, expect, it } from "vitest";
import { LEAD_WORKFLOW, type RunEvent, type WorkflowRun } from "@flowpilot/contracts";
import { applyRunEvent } from "./run-reducer";

const run: WorkflowRun = {
  id: "run_1",
  workflowId: "lead-intake",
  status: "queued",
  driver: "simulator",
  input: {
    name: "Sarah",
    company: "Northstar",
    email: "sarah@example.com",
    message: "We need workflow automation now.",
    source: "website",
  },
  selectedBranches: [],
  nodes: Object.fromEntries(LEAD_WORKFLOW.nodes.map((node) => [node.id, { nodeId: node.id, status: "pending" }])),
  createdAt: "2026-09-09T00:00:00.000Z",
};

function event(patch: Partial<RunEvent>): RunEvent {
  return {
    id: "evt_1",
    sequence: 1,
    type: "node.started",
    runId: "run_1",
    workflowId: "lead-intake",
    createdAt: "2026-09-09T00:00:01.000Z",
    ...patch,
  };
}

describe("applyRunEvent", () => {
  it("updates node output without mutating the source run", () => {
    const next = applyRunEvent(
      run,
      event({ type: "node.completed", nodeId: "normalize", status: "success", output: { clean: true } }),
    );
    expect(next.nodes.normalize?.status).toBe("success");
    expect(next.nodes.normalize?.output).toEqual({ clean: true });
    expect(run.nodes.normalize?.status).toBe("pending");
  });

  it("tracks selected workflow branches", () => {
    const next = applyRunEvent(run, event({ type: "branch.selected", branch: "high" }));
    expect(next.selectedBranches).toEqual(["high"]);
  });
});
