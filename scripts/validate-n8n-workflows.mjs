import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = resolve(root, "n8n/workflows");
const files = readdirSync(directory).filter((file) => file.endsWith(".json")).sort();
const ids = new Set();

for (const file of files) {
  const path = resolve(directory, file);
  const workflow = JSON.parse(readFileSync(path, "utf8"));
  if (!workflow.id || !workflow.name || !Array.isArray(workflow.nodes) || !workflow.connections) {
    throw new Error(`${file}: missing workflow envelope`);
  }
  if (ids.has(workflow.id)) throw new Error(`${file}: duplicate workflow id ${workflow.id}`);
  ids.add(workflow.id);
  const names = new Set(workflow.nodes.map((node) => node.name));
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  if (names.size !== workflow.nodes.length) throw new Error(`${file}: duplicate node name`);
  if (nodeIds.size !== workflow.nodes.length) throw new Error(`${file}: duplicate node id`);
  for (const [source, connection] of Object.entries(workflow.connections)) {
    if (!names.has(source)) throw new Error(`${file}: connection source does not exist: ${source}`);
    for (const output of connection.main ?? []) {
      for (const edge of output) {
        if (!names.has(edge.node)) throw new Error(`${file}: connection target does not exist: ${edge.node}`);
      }
    }
  }
  if (workflow.id === "flowpilot-lead-intake") {
    const trigger = workflow.nodes.find((node) => node.name === "Receive Lead");
    if (trigger?.parameters?.responseMode !== "onReceived") {
      throw new Error(`${file}: the public webhook must acknowledge immediately for Vercel compatibility`);
    }
    if (workflow.nodes.some((node) => node.type === "n8n-nodes-base.respondToWebhook")) {
      throw new Error(`${file}: Respond to Webhook would keep the Vercel start request open during approval`);
    }
  }
  console.log(`${file}: ${workflow.nodes.length} nodes, ${Object.keys(workflow.connections).length} connection sources`);
}

if (files.length !== 3) throw new Error(`Expected 3 workflow files, found ${files.length}`);
console.log(`Validated ${files.length} n8n workflow files.`);
