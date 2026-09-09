import type {
  ApprovalRequest,
  LeadInput,
  RunEvent,
  WorkflowDefinition,
  WorkflowRun,
} from "@flowpilot/contracts";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001/api";
const EVENT_TRANSPORT = process.env.NEXT_PUBLIC_EVENT_TRANSPORT
  ?? (API_BASE.includes("localhost") ? "sse" : "polling");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchWorkflow(): Promise<WorkflowDefinition> {
  return request<WorkflowDefinition>("/workflows/lead-intake");
}

export async function fetchRuns(): Promise<WorkflowRun[]> {
  const response = await request<{ runs: WorkflowRun[] }>("/runs");
  return response.runs;
}

export async function fetchRun(runId: string): Promise<WorkflowRun> {
  const response = await request<{ run: WorkflowRun }>(`/runs/${runId}`);
  return response.run;
}

export async function fetchRunEvents(runId: string): Promise<RunEvent[]> {
  const response = await request<{ events: RunEvent[] }>(`/runs/${runId}/events`);
  return response.events;
}

export async function createRun(input: LeadInput): Promise<WorkflowRun> {
  const response = await request<{ run: WorkflowRun }>("/workflows/lead-intake/runs", {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  return response.run;
}

export async function approveRun(runId: string, decision: ApprovalRequest): Promise<WorkflowRun> {
  const response = await request<{ run: WorkflowRun }>(`/runs/${runId}/approve`, {
    method: "POST",
    body: JSON.stringify(decision),
  });
  return response.run;
}

export function subscribeToRun(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onConnection: (connected: boolean) => void,
  onError: (error: Error) => void,
): () => void {
  if (EVENT_TRANSPORT === "polling") {
    return subscribeToRunByPolling(runId, onEvent, onConnection, onError);
  }
  const source = new EventSource(`${API_BASE}/runs/${runId}/events/stream`);
  source.onopen = () => onConnection(true);
  source.addEventListener("run-event", (message) => {
    try {
      const event = JSON.parse((message as MessageEvent<string>).data) as RunEvent;
      onEvent(event);
      if (event.type === "run.completed" || event.type === "run.failed") {
        source.close();
        onConnection(false);
      }
    } catch {
      onError(new Error("Received an invalid workflow event"));
    }
  });
  source.onerror = () => {
    onConnection(false);
    if (source.readyState === EventSource.CLOSED) onError(new Error("Live event stream closed"));
  };
  return () => source.close();
}

function subscribeToRunByPolling(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onConnection: (connected: boolean) => void,
  onError: (error: Error) => void,
): () => void {
  let stopped = false;
  let connected = false;
  let timer: number | undefined;
  const seen = new Set<string>();

  const poll = async () => {
    if (stopped) return;
    try {
      const [run, history] = await Promise.all([fetchRun(runId), fetchRunEvents(runId)]);
      if (!connected) {
        connected = true;
        onConnection(true);
      }
      for (const event of history) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        onEvent(event);
      }
      if (run.status === "succeeded" || run.status === "failed") {
        stopped = true;
        if (timer !== undefined) window.clearInterval(timer);
        onConnection(false);
      }
    } catch (cause) {
      if (!stopped) onError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };

  void poll();
  timer = window.setInterval(() => void poll(), 1000);
  return () => {
    stopped = true;
    if (timer !== undefined) window.clearInterval(timer);
    onConnection(false);
  };
}
