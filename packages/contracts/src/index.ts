export const RUN_EVENT_TYPES = [
  "run.started",
  "node.started",
  "node.completed",
  "node.skipped",
  "node.waiting",
  "node.retrying",
  "node.failed",
  "branch.selected",
  "approval.required",
  "approval.resolved",
  "run.completed",
  "run.failed",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RUN_STATUSES = ["queued", "running", "waiting", "succeeded", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const NODE_STATUSES = [
  "pending",
  "running",
  "success",
  "waiting",
  "retrying",
  "skipped",
  "failed",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export type WorkflowNodeKind =
  | "trigger"
  | "transform"
  | "decision"
  | "ai"
  | "integration"
  | "approval"
  | "audit"
  | "response";

export interface WorkflowNodeDefinition {
  id: string;
  label: string;
  description: string;
  kind: WorkflowNodeKind;
  integration?: string;
  position: { x: number; y: number };
}

export interface WorkflowEdgeDefinition {
  id: string;
  source: string;
  target: string;
  label?: string;
  branch?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  engine: "n8n";
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
}

export type DemoScenario = "high" | "medium" | "low" | "duplicate" | "invalid" | "custom";

export interface LeadInput {
  name: string;
  company: string;
  email: string;
  message: string;
  source: "website" | "linkedin" | "referral" | "event";
  scenario?: DemoScenario;
}

export interface NodeRunState {
  nodeId: string;
  status: NodeStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  attempt?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  executionId?: string;
  status: RunStatus;
  driver: "simulator" | "n8n";
  input: LeadInput;
  result?: Record<string, unknown>;
  error?: string;
  selectedBranches: string[];
  nodes: Record<string, NodeRunState>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface RunEvent {
  id: string;
  sequence: number;
  type: RunEventType;
  runId: string;
  workflowId: string;
  executionId?: string;
  nodeId?: string;
  status?: NodeStatus | RunStatus;
  branch?: string;
  attempt?: number;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface StartRunResponse {
  run: WorkflowRun;
}

export interface RunListResponse {
  runs: WorkflowRun[];
}

export interface RunEventsResponse {
  events: RunEvent[];
}

export interface ApprovalRequest {
  decision: "approved" | "rejected";
  note?: string;
}

export const LEAD_WORKFLOW: WorkflowDefinition = {
  id: "lead-intake",
  name: "AI Lead Intake & Routing",
  description: "Validate, qualify, route, and audit inbound B2B leads.",
  version: "1.0.0",
  engine: "n8n",
  nodes: [
    {
      id: "webhook",
      label: "Receive Lead",
      description: "Accept a lead payload from a website or external system.",
      kind: "trigger",
      integration: "Webhook",
      position: { x: 40, y: 250 },
    },
    {
      id: "normalize",
      label: "Normalize Input",
      description: "Clean fields and create a deterministic idempotency key.",
      kind: "transform",
      integration: "Code",
      position: { x: 300, y: 250 },
    },
    {
      id: "validate",
      label: "Validate Fields",
      description: "Check required fields and basic email syntax.",
      kind: "decision",
      integration: "IF",
      position: { x: 560, y: 250 },
    },
    {
      id: "dedupe",
      label: "Deduplicate",
      description: "Look for an existing lead before creating side effects.",
      kind: "decision",
      integration: "Idempotency policy",
      position: { x: 820, y: 250 },
    },
    {
      id: "ai_extract",
      label: "AI Extract Intent",
      description: "Extract intent, industry, urgency, and buying signals.",
      kind: "ai",
      integration: "LLM",
      position: { x: 1080, y: 250 },
    },
    {
      id: "score",
      label: "Score Lead",
      description: "Convert extracted signals into a transparent score.",
      kind: "transform",
      integration: "Code",
      position: { x: 1340, y: 250 },
    },
    {
      id: "route",
      label: "Route by Score",
      description: "Choose sales, approval, or nurture based on score.",
      kind: "decision",
      integration: "Switch",
      position: { x: 1600, y: 250 },
    },
    {
      id: "crm",
      label: "Create CRM Lead",
      description: "Create or update a lead in the CRM adapter.",
      kind: "integration",
      integration: "Mock CRM",
      position: { x: 1860, y: 90 },
    },
    {
      id: "slack",
      label: "Notify Sales",
      description: "Send a concise handoff message to the sales channel.",
      kind: "integration",
      integration: "Mock Slack",
      position: { x: 2120, y: 90 },
    },
    {
      id: "approval",
      label: "Human Approval",
      description: "Pause medium-intent leads for a human decision.",
      kind: "approval",
      integration: "Wait",
      position: { x: 1860, y: 250 },
    },
    {
      id: "nurture",
      label: "Nurture Email",
      description: "Send a low-pressure follow-up for future qualification.",
      kind: "integration",
      integration: "Mock Email",
      position: { x: 1860, y: 410 },
    },
    {
      id: "audit",
      label: "Write Audit Trail",
      description: "Persist the decision, side effects, and execution metadata.",
      kind: "audit",
      integration: "MySQL / Postgres",
      position: { x: 2380, y: 250 },
    },
    {
      id: "response",
      label: "Return Result",
      description: "Return a structured result to the caller.",
      kind: "response",
      integration: "Webhook",
      position: { x: 2640, y: 250 },
    },
    {
      id: "error",
      label: "Error Handler",
      description: "Capture validation and integration failures for recovery.",
      kind: "audit",
      integration: "Error Trigger",
      position: { x: 820, y: 520 },
    },
  ],
  edges: [
    { id: "webhook-normalize", source: "webhook", target: "normalize" },
    { id: "normalize-validate", source: "normalize", target: "validate" },
    { id: "validate-dedupe", source: "validate", target: "dedupe", label: "valid", branch: "valid" },
    { id: "validate-error", source: "validate", target: "error", label: "invalid", branch: "invalid" },
    { id: "dedupe-ai", source: "dedupe", target: "ai_extract", label: "new lead", branch: "new" },
    { id: "dedupe-response", source: "dedupe", target: "response", label: "duplicate", branch: "duplicate" },
    { id: "ai-score", source: "ai_extract", target: "score" },
    { id: "score-route", source: "score", target: "route" },
    { id: "route-crm", source: "route", target: "crm", label: "high", branch: "high" },
    { id: "route-approval", source: "route", target: "approval", label: "medium", branch: "medium" },
    { id: "route-nurture", source: "route", target: "nurture", label: "low", branch: "low" },
    { id: "approval-crm", source: "approval", target: "crm", label: "approved", branch: "approved" },
    { id: "crm-slack", source: "crm", target: "slack" },
    { id: "slack-audit", source: "slack", target: "audit" },
    { id: "nurture-audit", source: "nurture", target: "audit" },
    { id: "audit-response", source: "audit", target: "response" },
    { id: "error-response", source: "error", target: "response" },
  ],
};
