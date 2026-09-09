const apiBase = (process.env.FLOWPILOT_API_BASE ?? "http://localhost:3001/api").replace(/\/$/, "");
const stamp = Date.now().toString(36);

const cases = [
  { label: "high", scenario: "high", outcome: "routed_to_sales" },
  { label: "medium-approved", scenario: "medium", decision: "approved", outcome: "approved_and_routed" },
  { label: "medium-rejected", scenario: "medium", decision: "rejected", outcome: "rejected_by_human" },
  { label: "low", scenario: "low", outcome: "nurture_started" },
  { label: "duplicate", scenario: "duplicate", outcome: "skipped_duplicate" },
  { label: "invalid", scenario: "invalid", outcome: "rejected" },
];

async function request(path, init) {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitForRun(runId, acceptedStatuses, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { run } = await request(`/runs/${runId}`);
    if (acceptedStatuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Run ${runId} did not reach ${acceptedStatuses.join("/")} within ${timeoutMs}ms`);
}

async function executeCase(testCase, index) {
  const { run: created } = await request("/workflows/lead-intake/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: {
        name: `Smoke ${testCase.label}`,
        company: `${testCase.label} Labs`,
        email: `flowpilot-${stamp}-${index}@example.com`,
        message: "Validate observable workflow routing, side effects, approvals, and audit events.",
        source: "website",
        scenario: testCase.scenario,
      },
    }),
  });

  let run = await waitForRun(created.id, ["waiting", "succeeded", "failed"]);
  if (testCase.decision) {
    if (run.status !== "waiting") throw new Error(`${testCase.label} expected waiting, received ${run.status}`);
    await request(`/runs/${run.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: testCase.decision, note: `Smoke ${testCase.decision}` }),
    });
    run = await waitForRun(run.id, ["succeeded", "failed"]);
  }

  const { events } = await request(`/runs/${run.id}/events`);
  const pending = Object.values(run.nodes).filter((node) => node.status === "pending");
  const startedEvents = events.filter((event) => event.type === "run.started");
  if (run.status !== "succeeded") throw new Error(`${testCase.label} finished with ${run.status}: ${run.error ?? "unknown error"}`);
  if (run.result?.outcome !== testCase.outcome) {
    throw new Error(`${testCase.label} expected ${testCase.outcome}, received ${run.result?.outcome}`);
  }
  if (pending.length > 0) throw new Error(`${testCase.label} left ${pending.length} graph nodes pending`);
  if (startedEvents.length !== 1) throw new Error(`${testCase.label} emitted ${startedEvents.length} run.started events`);

  return {
    case: testCase.label,
    driver: run.driver,
    status: run.status,
    outcome: run.result.outcome,
    events: events.length,
    durationMs: run.durationMs,
  };
}

const health = await request("/health");
const results = [];
for (const [index, testCase] of cases.entries()) results.push(await executeCase(testCase, index));

console.log(`FlowPilot smoke test passed (${health.driver}/${health.persistence}).`);
console.table(results);
