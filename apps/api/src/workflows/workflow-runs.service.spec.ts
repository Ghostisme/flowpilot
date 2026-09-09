import { describe, expect, it } from "vitest";
import { WorkflowRunsService } from "./workflow-runs.service";

function service(): WorkflowRunsService {
  return new WorkflowRunsService({
    isEnabled: () => false,
    loadState: async () => [],
    loadRunState: async () => undefined,
    upsertRun: async () => undefined,
    insertEvent: async () => undefined,
  } as never);
}

process.env.SIMULATOR_NODE_DELAY_MS = "1";

async function waitFor(run: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!(await run())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for workflow state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const input = {
  name: "Sarah Chen",
  company: "Northstar Labs",
  email: "sarah@northstar.example",
  message: "We need an AI workflow integrated with our CRM.",
  source: "website" as const,
  scenario: "high" as const,
};

describe("WorkflowRunsService", () => {
  it("completes the high-intent route and records side effects", async () => {
    const runs = service();
    const run = await runs.createRun(input);
    await waitFor(async () => (await runs.getRun(run.id)).status === "succeeded");
    const completed = await runs.getRun(run.id);
    expect(completed.status).toBe("succeeded");
    expect(completed.selectedBranches).toContain("high");
    expect(completed.nodes.crm?.status).toBe("success");
    expect(completed.nodes.slack?.status).toBe("success");
    expect(completed.nodes.route?.status).toBe("success");
    expect(completed.nodes.error?.status).toBe("skipped");
    expect((await runs.getEvents(run.id)).filter((event) => event.type === "run.started")).toHaveLength(1);
  });

  it("waits for and resolves a medium-intent approval", async () => {
    const runs = service();
    const run = await runs.createRun({ ...input, scenario: "medium" });
    await waitFor(async () => (await runs.getRun(run.id)).status === "waiting");
    expect((await runs.getRun(run.id)).status).toBe("waiting");
    await runs.resolveApproval(run.id, { decision: "approved", note: "Looks relevant" });
    await waitFor(async () => (await runs.getRun(run.id)).status === "succeeded");
    expect((await runs.getRun(run.id)).status).toBe("succeeded");
    expect((await runs.getRun(run.id)).result?.outcome).toBe("approved_and_routed");
    expect((await runs.getRun(run.id)).selectedBranches).toContain("approved");
  });

  it("records a rejected human approval without running side effects", async () => {
    const runs = service();
    const run = await runs.createRun({ ...input, scenario: "medium" });
    await waitFor(async () => (await runs.getRun(run.id)).status === "waiting");
    await runs.resolveApproval(run.id, { decision: "rejected", note: "Not a fit" });
    await waitFor(async () => (await runs.getRun(run.id)).status === "succeeded");
    const completed = await runs.getRun(run.id);
    expect(completed.result?.outcome).toBe("rejected_by_human");
    expect(completed.selectedBranches).toContain("rejected");
    expect(completed.nodes.crm?.status).toBe("skipped");
    expect(completed.nodes.slack?.status).toBe("skipped");
  });

  it.each([
    ["low", "nurture_started", "nurture"],
    ["duplicate", "skipped_duplicate", "audit"],
    ["invalid", "rejected", "error"],
  ] as const)("completes the %s terminal route", async (scenario, outcome, completedNode) => {
    const runs = service();
    const run = await runs.createRun({ ...input, scenario });
    await waitFor(async () => (await runs.getRun(run.id)).status === "succeeded");
    const completed = await runs.getRun(run.id);
    expect(completed.result?.outcome).toBe(outcome);
    expect(completed.nodes[completedNode]?.status).toBe("success");
  });
});
