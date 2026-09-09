"use client";

import type { RunEvent, WorkflowNodeDefinition, WorkflowRun } from "@flowpilot/contracts";
import { formatClock, formatDuration, formatJson, shortId } from "@/lib/format";

export function RunInspector({
  run,
  events,
  selectedNode,
  onApprove,
  onReject,
}: {
  run?: WorkflowRun;
  events: RunEvent[];
  selectedNode?: WorkflowNodeDefinition;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  if (!run) {
    return (
      <aside className="inspector empty-inspector">
        <div className="empty-icon">◎</div>
        <p>Select a run or start the workflow to inspect execution data.</p>
      </aside>
    );
  }

  const state = selectedNode ? run.nodes[selectedNode.id] : undefined;
  const nodeEvents = selectedNode ? events.filter((event) => event.nodeId === selectedNode.id) : events.slice(-6);
  const canApprove = run.status === "waiting" && selectedNode?.id === "approval";

  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div>
          <p className="eyebrow">{selectedNode ? "Node inspector" : "Run activity"}</p>
          <h2>{selectedNode?.label ?? "Latest events"}</h2>
        </div>
        {selectedNode && <span className={`mini-status status-${state?.status ?? "pending"}`}>{state?.status ?? "pending"}</span>}
      </div>

      {selectedNode && (
        <div className="inspector-block">
          <p className="muted">{selectedNode.description}</p>
          <div className="inspector-grid">
            <Metric label="Integration" value={selectedNode.integration ?? "—"} />
            <Metric label="Duration" value={formatDuration(state?.durationMs)} />
            <Metric label="Started" value={formatClock(state?.startedAt)} />
            <Metric label="Attempt" value={String(state?.attempt ?? 1)} />
          </div>
          {canApprove && (
            <div className="approval-actions">
              <button type="button" className="button button-primary" onClick={onApprove}>Approve lead</button>
              <button type="button" className="button button-quiet" onClick={onReject}>Reject</button>
            </div>
          )}
          <CodePanel title="Output" value={state?.output} />
          {state?.error && <div className="error-panel">{state.error}</div>}
        </div>
      )}

      {!selectedNode && (
        <div className="inspector-block">
          <div className="inspector-grid">
            <Metric label="Run ID" value={shortId(run.id)} />
            <Metric label="n8n execution" value={shortId(run.executionId)} />
            <Metric label="Driver" value={run.driver} />
            <Metric label="Duration" value={formatDuration(run.durationMs)} />
          </div>
          {run.result && <CodePanel title="Final result" value={run.result} />}
          {run.error && <div className="error-panel">{run.error}</div>}
        </div>
      )}

      <div className="timeline">
        <div className="timeline-header">
          <span>Event timeline</span>
          <span className="muted">{events.length} events</span>
        </div>
        <div className="timeline-list">
          {nodeEvents.length === 0 && <p className="muted">Events will appear as the workflow runs.</p>}
          {nodeEvents.map((event) => (
            <div className="timeline-item" key={event.id}>
              <span className={`timeline-dot dot-${event.status ?? "default"}`} />
              <div>
                <strong>{event.type.replaceAll(".", " ")}</strong>
                <p>
                  {event.nodeId ?? "workflow"} · {formatClock(event.createdAt)}
                  {event.branch ? ` · ${event.branch}` : ""}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function CodePanel({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="code-panel">
      <div className="code-panel-heading"><span>{title}</span><span className="copy-hint">JSON</span></div>
      <pre>{formatJson(value)}</pre>
    </div>
  );
}
