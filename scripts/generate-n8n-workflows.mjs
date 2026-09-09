import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "n8n/workflows");
mkdirSync(outputDir, { recursive: true });

const emitWorkflowId = "flowpilot-emit-event";

function stableUuid(seed) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20, 32).join(""),
  ].join("-");
}

function node(name, type, typeVersion, position, parameters) {
  return { id: stableUuid(`flowpilot-node:${name}`), name, type, typeVersion, position, parameters };
}

function code(name, position, jsCode) {
  return node(name, "n8n-nodes-base.code", 2, position, { jsCode });
}

function emit(name, position) {
  return node(name, "n8n-nodes-base.executeWorkflow", 1.3, position, {
    operation: "call_workflow",
    source: "database",
    workflowId: { __rl: true, value: emitWorkflowId, mode: "id" },
    mode: "once",
    options: { waitForSubWorkflow: true },
  });
}

function http(name, position, url, bodyExpression) {
  return node(name, "n8n-nodes-base.httpRequest", 4.2, position, {
    method: "POST",
    url,
    sendBody: true,
    contentType: "raw",
    rawContentType: "application/json",
    body: bodyExpression,
    options: { timeout: 15000 },
  });
}

function condition(name, position, leftValue) {
  return node(name, "n8n-nodes-base.if", 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [
        {
          id: stableUuid(`flowpilot-condition:${name}`),
          leftValue,
          rightValue: "",
          operator: { type: "boolean", operation: "true", singleValue: true },
        },
      ],
      combinator: "and",
    },
    options: {},
  });
}

function connect(connections, from, to, output = 0) {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: "main", index: 0 });
}

const webhook = node("Receive Lead", "n8n-nodes-base.webhook", 2.1, [-1560, 40], {
  httpMethod: "POST",
  path: "flowpilot-lead-intake",
  // A Vercel API function only needs confirmation that n8n accepted the run.
  // Execution continues in n8n and publishes durable events back to the API.
  responseMode: "onReceived",
  options: {},
});
webhook.webhookId = stableUuid("flowpilot-webhook:lead-intake");

const mainNodes = [
  webhook,
  code("Initialize Context", [-1340, 40], `const body = $json.body ?? $json;
const input = body.input ?? body;
return [{ json: {
  runId: body.runId,
  workflowId: body.workflowId ?? 'lead-intake',
  executionId: $execution.id,
  input,
  receivedAt: new Date().toISOString()
} }];`),
  code("Prepare Run Started", [-1120, 40], `const context = $json;
return [{ json: { context, events: [
  { type: 'run.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, status: 'running' },
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'webhook', status: 'success', output: { source: context.input.source } },
  { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'normalize', status: 'running' }
] } }];`),
  emit("Emit Run Started", [-900, 40]),
  code("Normalize Input", [-680, 40], `const input = $json.input;
return [{ json: { ...$json, input: {
  ...input,
  name: String(input.name ?? '').trim(),
  company: String(input.company ?? '').trim(),
  email: String(input.email ?? '').trim().toLowerCase(),
  message: String(input.message ?? '').trim()
}, idempotencyKey: String(input.email ?? '').trim().toLowerCase() + ':' + String(input.company ?? '').trim().toLowerCase() } }];`),
  code("Prepare Normalized", [-460, 40], `const context = $json;
return [{ json: { context, events: [
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'normalize', status: 'success', output: { normalizedEmail: context.input.email, idempotencyKey: context.idempotencyKey } },
  { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'validate', status: 'running' }
] } }];`),
  emit("Emit Normalized", [-240, 40]),
  code("Validate Fields", [-20, 40], `const input = $json.input;
const errors = [];
if (!input.name) errors.push('name is required');
if (!input.company) errors.push('company is required');
if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(input.email)) errors.push('valid email is required');
if (!input.message || input.message.length < 10) errors.push('message is too short');
return [{ json: { ...$json, validation: { valid: errors.length === 0 && input.scenario !== 'invalid', errors: input.scenario === 'invalid' ? ['valid email is required'] : errors } } }];`),
  condition("Payload Valid?", [200, 40], "={{ $json.validation.valid }}"),
  code("Prepare Valid", [420, -60], `const context = $json;
return [{ json: { context, events: [
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'validate', status: 'success', output: context.validation },
  { type: 'branch.selected', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'validate', branch: 'valid' },
  { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'dedupe', status: 'running' }
] } }];`),
  emit("Emit Valid", [640, -60]),
  code("Check Duplicate", [860, -60], `const duplicate = $json.input.scenario === 'duplicate' || $json.input.email.includes('duplicate');
return [{ json: { ...$json, deduplication: { duplicate, existingLeadId: duplicate ? 'crm_lead_existing_042' : null } } }];`),
  condition("Duplicate Lead?", [1080, -60], "={{ $json.deduplication.duplicate }}"),
  code("Prepare New Lead", [1300, 20], `const context = $json;
return [{ json: { context, events: [
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'dedupe', status: 'success', output: context.deduplication },
  { type: 'branch.selected', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'dedupe', branch: 'new' },
  { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'ai_extract', status: 'running' }
] } }];`),
  emit("Emit New Lead", [1520, 20]),
  http("AI Qualify Lead", [1740, 20], "={{ $env.FLOWPILOT_API_URL + '/api/integrations/ai/qualify' }}", "={{ JSON.stringify({ context: $json, input: $json.input }) }}"),
  code("Prepare Qualification", [1960, 20], `const context = $json;
return [{ json: { context, events: [
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'ai_extract', status: 'success', output: { ...context.qualification, adapter: context.aiResult } },
  { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'score', status: 'running' }
] } }];`),
  emit("Emit Qualification", [2180, 20]),
  code("Score Lead", [2400, 20], `const q = $json.qualification;
return [{ json: { ...$json, scoring: { score: q.score, route: q.route, explanation: q.score + '/100 because ' + q.signals.join(', ') } } }];`),
  code("Prepare Score", [2620, 20], `const context = $json;
const nextNode = context.qualification.route === 'high' ? 'crm' : context.qualification.route === 'medium' ? 'approval' : 'nurture';
return [{ json: { context, events: [
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'score', status: 'success', output: context.scoring },
  { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'route', status: 'running' },
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'route', status: 'success', output: { route: context.qualification.route, score: context.qualification.score } },
  { type: 'branch.selected', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'route', branch: context.qualification.route },
  { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: nextNode, status: 'running' }
] } }];`),
  emit("Emit Score", [2840, 20]),
  condition("High Intent?", [3060, 20], "={{ $json.qualification.route === 'high' }}"),
  condition("Needs Approval?", [3280, 140], "={{ $json.qualification.route === 'medium' }}"),
  http("Create CRM Lead", [3280, -100], "={{ $env.FLOWPILOT_API_URL + '/api/integrations/crm/leads' }}", "={{ JSON.stringify({ context: $json, lead: $json.input }) }}"),
  code("Prepare CRM Complete", [3500, -100], `const context = $json;
return [{ json: { context, events: [
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'crm', status: 'success', output: context.crmResult },
  { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'slack', status: 'running' }
] } }];`),
  emit("Emit CRM Complete", [3720, -100]),
  http("Notify Sales", [3940, -100], "={{ $env.FLOWPILOT_API_URL + '/api/integrations/slack/messages' }}", "={{ JSON.stringify({ context: $json, channel: '#sales-hot-leads', lead: $json.input }) }}"),
  code("Build Sales Result", [4160, -100], `return [{ json: { ...$json, result: { accepted: true, outcome: $json.approval ? 'approved_and_routed' : 'routed_to_sales', score: $json.qualification.score, crmLeadId: $json.crmResult.record.id } } }];`),
  code("Prepare Approval", [3500, 140], `const context = $json;
return [{ json: { context, events: [
  { type: 'node.waiting', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'approval', status: 'waiting', output: { reason: 'human_review_required' } },
  { type: 'approval.required', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'approval', status: 'waiting', metadata: { resumeUrl: $execution.resumeUrl } }
] } }];`),
  emit("Emit Approval Required", [3720, 140]),
  node("Wait for Approval", "n8n-nodes-base.wait", 1.1, [3940, 140], {
    resume: "webhook",
    httpMethod: "POST",
    responseMode: "onReceived",
    options: {},
  }),
  code("Restore Approval Context", [4160, 140], `const context = $('Emit Approval Required').first().json;
const approval = $json.body ?? $json;
return [{ json: { ...context, approval, approved: approval.decision !== 'rejected' } }];`),
  code("Prepare Approval Resolution", [4380, 140], `const context = $json;
return [{ json: { context, events: [
  { type: 'approval.resolved', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'approval', status: 'running', output: context.approval },
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'approval', status: 'success', output: context.approval }
] } }];`),
  emit("Emit Approval Resolution", [4600, 140]),
  condition("Approved?", [4820, 140], "={{ $json.approved }}"),
  code("Prepare Approved", [5040, 60], `const context = $json;
return [{ json: { context, events: [
  { type: 'branch.selected', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'approval', branch: 'approved' },
  { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'crm', status: 'running' }
] } }];`),
  emit("Emit Approved", [5260, 60]),
  code("Build Rejected Result", [5040, 220], `return [{ json: { ...$json, result: { accepted: true, outcome: 'rejected_by_human', note: $json.approval.note ?? null }, terminalBranch: 'rejected' } }];`),
  http("Send Nurture Email", [3500, 360], "={{ $env.FLOWPILOT_API_URL + '/api/integrations/email/send' }}", "={{ JSON.stringify({ context: $json, to: $json.input.email, campaign: 'workflow-education' }) }}"),
  code("Build Nurture Result", [3720, 360], `return [{ json: { ...$json, result: { accepted: true, outcome: 'nurture_started', score: $json.qualification.score, emailId: $json.emailResult.email.id } } }];`),
  code("Build Duplicate Result", [1300, -180], `return [{ json: { ...$json, result: { accepted: true, outcome: 'skipped_duplicate', existingLeadId: $json.deduplication.existingLeadId }, terminalBranch: 'duplicate' } }];`),
  code("Build Invalid Result", [420, 180], `return [{ json: { ...$json, result: { accepted: false, outcome: 'rejected', reason: 'invalid_payload', errors: $json.validation.errors }, terminalBranch: 'invalid' } }];`),
  code("Write Audit Trail", [4380, -100], `return [{ json: { ...$json, audit: { runId: $json.runId, executionId: $json.executionId, outcome: $json.result.outcome, writtenAt: new Date().toISOString() } } }];`),
  code("Prepare Final Events", [4600, -100], `const context = $json;
const events = [];
if (context.terminalBranch === 'invalid') {
  events.push(
    { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'validate', status: 'success', output: context.validation },
    { type: 'branch.selected', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'validate', branch: 'invalid' },
    { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'error', status: 'running' },
    { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'error', status: 'success', output: { code: 'VALIDATION_ERROR' } }
  );
}
if (context.terminalBranch === 'duplicate') {
  events.push(
    { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'dedupe', status: 'success', output: context.deduplication },
    { type: 'branch.selected', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'dedupe', branch: 'duplicate' }
  );
}
if (context.terminalBranch === 'rejected') {
  events.push({ type: 'branch.selected', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'approval', branch: 'rejected' });
}
if (context.slackResult) events.push({ type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'slack', status: 'success', output: context.slackResult });
if (context.emailResult) events.push({ type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'nurture', status: 'success', output: context.emailResult });
const skippedByOutcome = {
  routed_to_sales: ['approval', 'nurture', 'error'],
  approved_and_routed: ['nurture', 'error'],
  rejected_by_human: ['crm', 'slack', 'nurture', 'error'],
  nurture_started: ['crm', 'slack', 'approval', 'error'],
  skipped_duplicate: ['ai_extract', 'score', 'route', 'crm', 'slack', 'approval', 'nurture', 'error'],
  rejected: ['dedupe', 'ai_extract', 'score', 'route', 'crm', 'slack', 'approval', 'nurture']
};
for (const nodeId of skippedByOutcome[context.result.outcome] ?? []) {
  events.push({ type: 'node.skipped', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId, status: 'skipped', output: { reason: 'branch_not_selected' } });
}
events.push(
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'audit', status: 'success', output: context.audit },
  { type: 'node.started', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'response', status: 'running' },
  { type: 'node.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, nodeId: 'response', status: 'success', output: context.result },
  { type: 'run.completed', runId: context.runId, workflowId: context.workflowId, executionId: context.executionId, status: 'succeeded', output: context.result }
);
return [{ json: { context, events } }];`),
  emit("Emit Run Completed", [4820, -100]),
  code("Finish Workflow", [5040, -100], `return [{ json: { runId: $json.runId, executionId: $json.executionId, ...$json.result } }];`),
];

const mainConnections = {};
connect(mainConnections, "Receive Lead", "Initialize Context");
connect(mainConnections, "Initialize Context", "Prepare Run Started");
connect(mainConnections, "Prepare Run Started", "Emit Run Started");
connect(mainConnections, "Emit Run Started", "Normalize Input");
connect(mainConnections, "Normalize Input", "Prepare Normalized");
connect(mainConnections, "Prepare Normalized", "Emit Normalized");
connect(mainConnections, "Emit Normalized", "Validate Fields");
connect(mainConnections, "Validate Fields", "Payload Valid?");
connect(mainConnections, "Payload Valid?", "Prepare Valid", 0);
connect(mainConnections, "Payload Valid?", "Build Invalid Result", 1);
connect(mainConnections, "Prepare Valid", "Emit Valid");
connect(mainConnections, "Emit Valid", "Check Duplicate");
connect(mainConnections, "Check Duplicate", "Duplicate Lead?");
connect(mainConnections, "Duplicate Lead?", "Build Duplicate Result", 0);
connect(mainConnections, "Duplicate Lead?", "Prepare New Lead", 1);
connect(mainConnections, "Prepare New Lead", "Emit New Lead");
connect(mainConnections, "Emit New Lead", "AI Qualify Lead");
connect(mainConnections, "AI Qualify Lead", "Prepare Qualification");
connect(mainConnections, "Prepare Qualification", "Emit Qualification");
connect(mainConnections, "Emit Qualification", "Score Lead");
connect(mainConnections, "Score Lead", "Prepare Score");
connect(mainConnections, "Prepare Score", "Emit Score");
connect(mainConnections, "Emit Score", "High Intent?");
connect(mainConnections, "High Intent?", "Create CRM Lead", 0);
connect(mainConnections, "High Intent?", "Needs Approval?", 1);
connect(mainConnections, "Needs Approval?", "Prepare Approval", 0);
connect(mainConnections, "Needs Approval?", "Send Nurture Email", 1);
connect(mainConnections, "Prepare Approval", "Emit Approval Required");
connect(mainConnections, "Emit Approval Required", "Wait for Approval");
connect(mainConnections, "Wait for Approval", "Restore Approval Context");
connect(mainConnections, "Restore Approval Context", "Prepare Approval Resolution");
connect(mainConnections, "Prepare Approval Resolution", "Emit Approval Resolution");
connect(mainConnections, "Emit Approval Resolution", "Approved?");
connect(mainConnections, "Approved?", "Prepare Approved", 0);
connect(mainConnections, "Approved?", "Build Rejected Result", 1);
connect(mainConnections, "Prepare Approved", "Emit Approved");
connect(mainConnections, "Emit Approved", "Create CRM Lead");
connect(mainConnections, "Create CRM Lead", "Prepare CRM Complete");
connect(mainConnections, "Prepare CRM Complete", "Emit CRM Complete");
connect(mainConnections, "Emit CRM Complete", "Notify Sales");
connect(mainConnections, "Notify Sales", "Build Sales Result");
connect(mainConnections, "Send Nurture Email", "Build Nurture Result");
connect(mainConnections, "Build Invalid Result", "Write Audit Trail");
connect(mainConnections, "Build Duplicate Result", "Write Audit Trail");
connect(mainConnections, "Build Sales Result", "Write Audit Trail");
connect(mainConnections, "Build Nurture Result", "Write Audit Trail");
connect(mainConnections, "Build Rejected Result", "Write Audit Trail");
connect(mainConnections, "Write Audit Trail", "Prepare Final Events");
connect(mainConnections, "Prepare Final Events", "Emit Run Completed");
connect(mainConnections, "Emit Run Completed", "Finish Workflow");

const mainWorkflow = {
  id: "flowpilot-lead-intake",
  name: "FlowPilot — AI Lead Intake & Routing",
  active: true,
  nodes: mainNodes,
  connections: mainConnections,
  settings: {
    executionOrder: "v1",
    saveManualExecutions: true,
    saveExecutionProgress: true,
    saveDataSuccessExecution: "all",
    saveDataErrorExecution: "all",
    errorWorkflow: "flowpilot-error-handler",
  },
  versionId: stableUuid("flowpilot-version:lead-intake"),
  meta: { templateCredsSetupCompleted: true },
  pinData: {},
  tags: [],
};

const emitTrigger = node("When Executed by Another Workflow", "n8n-nodes-base.executeWorkflowTrigger", 1.2, [-260, 0], {
  inputSource: "passthrough",
});
const emitHttp = node("Publish FlowPilot Events", "n8n-nodes-base.httpRequest", 4.2, [0, 0], {
  method: "POST",
  url: "={{ $env.FLOWPILOT_API_URL + '/api/internal/n8n/events' }}",
  sendHeaders: true,
  headerParameters: { parameters: [{ name: "x-flowpilot-event-secret", value: "={{ $env.N8N_EVENT_SECRET }}" }] },
  sendBody: true,
  contentType: "raw",
  rawContentType: "application/json",
  body: "={{ JSON.stringify($json) }}",
  options: { timeout: 15000 },
});
const emitWorkflow = {
  id: emitWorkflowId,
  name: "FlowPilot — Emit Workflow Event",
  active: false,
  // The API responds with the unwrapped `context` object. Keeping the HTTP node
  // as the terminal node means every caller receives that context unchanged.
  nodes: [emitTrigger, emitHttp],
  connections: {
    "When Executed by Another Workflow": { main: [[{ node: "Publish FlowPilot Events", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1", saveManualExecutions: true },
  versionId: stableUuid("flowpilot-version:emit-event"),
  meta: { templateCredsSetupCompleted: true },
  pinData: {},
  tags: [],
};

const errorTrigger = node("Workflow Error Trigger", "n8n-nodes-base.errorTrigger", 1, [-300, 0], {});
const errorPayload = code("Format Error Alert", [-80, 0], `const source = $json;
return [{ json: {
  context: source,
  channel: '#workflow-alerts',
  text: 'FlowPilot workflow failed',
  executionId: source.execution?.id ?? null,
  workflow: source.workflow?.name ?? 'unknown',
  lastNode: source.execution?.lastNodeExecuted ?? null,
  error: source.execution?.error?.message ?? source.error?.message ?? 'Unknown workflow error'
} }];`);
const errorAlert = http("Send Error Alert", [140, 0], "={{ $env.FLOWPILOT_API_URL + '/api/integrations/slack/messages' }}", "={{ JSON.stringify($json) }}");
const errorWorkflow = {
  id: "flowpilot-error-handler",
  name: "FlowPilot — Workflow Error Handler",
  active: true,
  nodes: [errorTrigger, errorPayload, errorAlert],
  connections: {
    "Workflow Error Trigger": { main: [[{ node: "Format Error Alert", type: "main", index: 0 }]] },
    "Format Error Alert": { main: [[{ node: "Send Error Alert", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1", saveManualExecutions: true, saveDataErrorExecution: "all" },
  versionId: stableUuid("flowpilot-version:error-handler"),
  meta: { templateCredsSetupCompleted: true },
  pinData: {},
  tags: [],
};

for (const [fileName, workflow] of [
  ["01-emit-workflow-event.json", emitWorkflow],
  ["02-workflow-error-handler.json", errorWorkflow],
  ["03-lead-intake.json", mainWorkflow],
]) {
  writeFileSync(resolve(outputDir, fileName), `${JSON.stringify(workflow, null, 2)}\n`);
}

console.log(`Generated 3 n8n workflows in ${outputDir}`);
