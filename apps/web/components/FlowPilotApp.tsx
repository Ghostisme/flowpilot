"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DemoScenario, LeadInput, RunEvent, WorkflowDefinition, WorkflowRun } from "@flowpilot/contracts";
import { approveRun, createRun, fetchRun, fetchRunEvents, fetchRuns, fetchWorkflow, subscribeToRun } from "@/lib/api";
import { applyRunEvent } from "@/lib/run-reducer";
import { formatDuration, shortId } from "@/lib/format";
import { RunInspector } from "./RunInspector";
import { WorkflowGraph } from "./WorkflowGraph";

const SCENARIOS: Record<Exclude<DemoScenario, "custom">, { label: string; input: LeadInput }> = {
  high: {
    label: "High-intent lead",
    input: {
      name: "Sarah Chen",
      company: "Northstar Labs",
      email: "sarah@northstar.example",
      message: "We need an AI workflow integrated with our CRM for a near-term rollout.",
      source: "website",
      scenario: "high",
    },
  },
  medium: {
    label: "Needs approval",
    input: {
      name: "Daniel Moore",
      company: "Cedar & Co.",
      email: "daniel@cedar.example",
      message: "We are exploring workflow automation and would like to understand the options.",
      source: "referral",
      scenario: "medium",
    },
  },
  low: {
    label: "Early research",
    input: {
      name: "Maya Patel",
      company: "Brightline Studio",
      email: "maya@brightline.example",
      message: "Could you send some information about what an automation platform can do?",
      source: "linkedin",
      scenario: "low",
    },
  },
  duplicate: {
    label: "Duplicate lead",
    input: {
      name: "Sarah Chen",
      company: "Northstar Labs",
      email: "sarah@northstar.example",
      message: "Following up on the workflow integration request from last week.",
      source: "website",
      scenario: "duplicate",
    },
  },
  invalid: {
    label: "Invalid payload",
    input: {
      name: "Missing Email",
      company: "Broken Payload Inc.",
      email: "invalid.example",
      message: "This payload demonstrates the validation and error workflow.",
      source: "event",
      scenario: "invalid",
    },
  },
};

export function FlowPilotApp() {
  const [definition, setDefinition] = useState<WorkflowDefinition | undefined>();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [currentRun, setCurrentRun] = useState<WorkflowRun>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [input, setInput] = useState<LeadInput>(SCENARIOS.high.input);
  const [scenario, setScenario] = useState<DemoScenario>("high");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await fetchRuns());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void Promise.all([fetchWorkflow(), fetchRuns()])
      .then(async ([workflow, workflowRuns]) => {
        setDefinition(workflow);
        setRuns(workflowRuns);
        if (workflowRuns[0]) {
          const latest = workflowRuns[0];
          const [fresh, history] = await Promise.all([fetchRun(latest.id), fetchRunEvents(latest.id)]);
          setCurrentRun(fresh);
          setEvents(history);
          setInput(fresh.input);
          setScenario(fresh.input.scenario ?? "custom");
        }
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!currentRun || (currentRun.status !== "queued" && currentRun.status !== "running" && currentRun.status !== "waiting")) {
      setConnected(false);
      return;
    }
    const stop = subscribeToRun(
      currentRun.id,
      (event) => {
        setEvents((previous) => (previous.some((item) => item.id === event.id) ? previous : [...previous, event]));
        setCurrentRun((previous) => (previous ? applyRunEvent(previous, event) : previous));
        if (event.type === "run.completed" || event.type === "run.failed") {
          setRunning(false);
          void refreshRuns();
        }
      },
      setConnected,
      (streamError) => setError(streamError.message),
    );
    return stop;
  }, [currentRun?.id, refreshRuns]);

  const selectScenario = (next: Exclude<DemoScenario, "custom">) => {
    setScenario(next);
    setInput({ ...SCENARIOS[next].input });
    setCurrentRun(undefined);
    setEvents([]);
    setSelectedNodeId(undefined);
    setError(undefined);
  };

  const updateInput = (patch: Partial<LeadInput>) => {
    setScenario("custom");
    setInput((previous) => ({ ...previous, ...patch, scenario: "custom" }));
    setCurrentRun(undefined);
    setEvents([]);
    setSelectedNodeId(undefined);
  };

  const selectRun = async (run: WorkflowRun) => {
    setCurrentRun(run);
    setInput(run.input);
    setScenario(run.input.scenario ?? "custom");
    setSelectedNodeId(undefined);
    try {
      const fresh = await fetchRun(run.id);
      setCurrentRun(fresh);
      setEvents(await fetchRunEvents(run.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const startRun = async () => {
    setError(undefined);
    setRunning(true);
    setEvents([]);
    setSelectedNodeId(undefined);
    try {
      const run = await createRun({ ...input, scenario: scenario === "custom" ? undefined : scenario });
      setCurrentRun(run);
    } catch (cause) {
      setRunning(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const approve = async (decision: "approved" | "rejected") => {
    if (!currentRun) return;
    try {
      const next = await approveRun(currentRun.id, { decision, note: decision === "approved" ? "Reviewed in FlowPilot" : "Rejected in FlowPilot" });
      setCurrentRun(next);
      setRunning(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectedNode = useMemo(
    () => definition?.nodes.find((node) => node.id === selectedNodeId),
    [definition, selectedNodeId],
  );
  const completedCount = currentRun ? Object.values(currentRun.nodes).filter((node) => node.status === "success").length : 0;
  const activeRun = currentRun?.status === "running" || currentRun?.status === "waiting" || running;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">fp</div>
          <div>
            <div className="brand-name">FlowPilot</div>
            <div className="brand-subtitle">Workflow operations console</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="engine-pill"><span className="engine-dot" /> n8n runtime</div>
          <div className={`connection-pill ${connected ? "is-connected" : ""}`}>
            <span className="connection-dot" /> {connected ? "Live events" : "Ready"}
          </div>
          <a className="docs-link" href="https://n8n.io/" target="_blank" rel="noreferrer">n8n ↗</a>
        </div>
      </header>

      <section className="workspace-heading">
        <div>
          <div className="breadcrumb"><span>Workflows</span><span>/</span><strong>Lead intake</strong></div>
          <h1>AI Lead Intake &amp; Routing</h1>
          <p>Qualify inbound demand, route the right next action, and keep every side effect auditable.</p>
        </div>
        <div className="heading-actions">
          <div className="driver-badge"><span className="badge-label">Driver</span><strong>{currentRun?.driver ?? "simulator"}</strong></div>
          <button type="button" className="button button-primary run-button" onClick={() => void startRun()} disabled={loading || activeRun}>
            <span className="play-icon">{activeRun ? "◌" : "▶"}</span>
            {activeRun ? "Workflow running" : "Run workflow"}
          </button>
        </div>
      </section>

      {error && <div className="global-error"><span>!</span>{error}<button type="button" onClick={() => setError(undefined)}>Dismiss</button></div>}

      <section className="metrics-strip">
        <MetricCard label="Run status" value={currentRun?.status ?? "idle"} accent={currentRun?.status ?? "idle"} />
        <MetricCard label="Nodes completed" value={currentRun ? `${completedCount}/${definition?.nodes.length ?? 0}` : "—"} />
        <MetricCard label="Duration" value={formatDuration(currentRun?.durationMs)} />
        <MetricCard label="Branch" value={currentRun?.selectedBranches.at(-1) ?? "waiting"} />
        <MetricCard label="Run ID" value={shortId(currentRun?.id)} wide />
      </section>

      <section className="main-grid">
        <aside className="control-panel panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Trigger payload</p><h2>Lead input</h2></div>
            <span className="input-chip">JSON</span>
          </div>
          <div className="scenario-list">
            {(Object.keys(SCENARIOS) as Exclude<DemoScenario, "custom">[]).map((key) => (
              <button type="button" key={key} className={`scenario-button ${scenario === key ? "selected" : ""}`} onClick={() => selectScenario(key)}>
                <span className={`scenario-dot dot-${key}`} />
                <span>{SCENARIOS[key].label}</span>
                {scenario === key && <span className="scenario-check">✓</span>}
              </button>
            ))}
          </div>
          <div className="form-stack">
            <Field label="Name" value={input.name} onChange={(value) => updateInput({ name: value })} />
            <Field label="Company" value={input.company} onChange={(value) => updateInput({ company: value })} />
            <Field label="Email" value={input.email} onChange={(value) => updateInput({ email: value })} />
            <label className="field"><span>Message</span><textarea value={input.message} onChange={(event) => updateInput({ message: event.target.value })} rows={4} /></label>
            <label className="field"><span>Source</span><select value={input.source} onChange={(event) => updateInput({ source: event.target.value as LeadInput["source"] })}><option value="website">Website</option><option value="linkedin">LinkedIn</option><option value="referral">Referral</option><option value="event">Event</option></select></label>
          </div>
          <button type="button" className="button button-primary full-width" onClick={() => void startRun()} disabled={loading || activeRun}><span>{activeRun ? "◌" : "▶"}</span>{activeRun ? "Running..." : "Run this payload"}</button>
          <p className="panel-footnote"><span className="lock-icon">⌁</span> Synthetic data · side effects are local mock adapters</p>
        </aside>

        <section className="graph-panel panel">
          <div className="panel-heading graph-heading">
            <div><p className="eyebrow">Live execution topology</p><h2>Workflow graph</h2></div>
            <div className="graph-legend"><span><i className="legend-dot legend-running" />Running</span><span><i className="legend-dot legend-success" />Completed</span><span><i className="legend-dot legend-waiting" />Waiting</span></div>
          </div>
          {loading || !definition ? <div className="graph-loading"><span className="loading-ring" />Loading workflow definition…</div> : <WorkflowGraph definition={definition} run={currentRun} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} />}
        </section>
      </section>

      <section className="bottom-grid">
        <div className="run-history panel">
          <div className="panel-heading"><div><p className="eyebrow">Recent activity</p><h2>Run history</h2></div><button type="button" className="text-button" onClick={() => void refreshRuns()}>Refresh ↻</button></div>
          <div className="run-list">
            {runs.length === 0 && <div className="empty-list">No runs yet. Choose a scenario to create the first trace.</div>}
            {runs.slice(0, 6).map((run) => (
              <button type="button" className={`run-row ${currentRun?.id === run.id ? "selected" : ""}`} key={run.id} onClick={() => void selectRun(run)}>
                <span className={`run-status status-${run.status}`} />
                <span className="run-row-copy"><strong>{run.input.company}</strong><small>{shortId(run.id)} · {run.input.scenario ?? "custom"}</small></span>
                <span className="run-row-branch">{run.selectedBranches.at(-1) ?? "—"}</span>
                <span className="run-row-duration">{formatDuration(run.durationMs)}</span>
              </button>
            ))}
          </div>
        </div>
        <RunInspector run={currentRun} events={events} selectedNode={selectedNode} onApprove={() => void approve("approved")} onReject={() => void approve("rejected")} />
      </section>
      <footer className="footer"><span>FlowPilot v0.1</span><span>Observable automation, not black-box automation.</span><span>n8n-backed · NestJS · Next.js</span></footer>
    </main>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function MetricCard({ label, value, accent, wide }: { label: string; value: string; accent?: string; wide?: boolean }) {
  return <div className={`metric-card ${wide ? "wide" : ""}`}><span>{label}</span><strong className={accent ? `value-${accent}` : ""}>{value}</strong></div>;
}
