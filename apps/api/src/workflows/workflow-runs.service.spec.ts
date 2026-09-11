import { describe, expect, it, vi } from "vitest";
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

  it("wakes a sleeping n8n runtime before triggering a workflow", async () => {
    const previous = {
      driver: process.env.WORKFLOW_DRIVER,
      webhookUrl: process.env.N8N_WEBHOOK_URL,
      coldStartTimeout: process.env.N8N_COLD_START_TIMEOUT_MS,
      coldStartPoll: process.env.N8N_COLD_START_POLL_MS,
      webhookTimeout: process.env.N8N_WEBHOOK_TIMEOUT_MS,
    };
    process.env.WORKFLOW_DRIVER = "n8n";
    process.env.N8N_WEBHOOK_URL = "https://flowpilot-n8n.onrender.com/webhook/flowpilot-lead-intake";
    process.env.N8N_COLD_START_TIMEOUT_MS = "1000";
    process.env.N8N_COLD_START_POLL_MS = "1";
    process.env.N8N_WEBHOOK_TIMEOUT_MS = "1000";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("starting", { status: 503, headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(Response.json({ status: "ok" }))
      .mockResolvedValueOnce(Response.json({ message: "Workflow was started" }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const runs = service();
      const run = await runs.createRun(input);

      expect(run.driver).toBe("n8n");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://flowpilot-n8n.onrender.com/healthz");
      expect(fetchMock.mock.calls[1]?.[0]).toBe("https://flowpilot-n8n.onrender.com/healthz");
      expect(fetchMock.mock.calls[2]?.[0]).toBe(process.env.N8N_WEBHOOK_URL);
      expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    } finally {
      vi.unstubAllGlobals();
      for (const [key, value] of Object.entries({
        WORKFLOW_DRIVER: previous.driver,
        N8N_WEBHOOK_URL: previous.webhookUrl,
        N8N_COLD_START_TIMEOUT_MS: previous.coldStartTimeout,
        N8N_COLD_START_POLL_MS: previous.coldStartPoll,
        N8N_WEBHOOK_TIMEOUT_MS: previous.webhookTimeout,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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
