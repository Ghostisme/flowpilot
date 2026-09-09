# Event protocol quick reference

## Browser transport

`GET /api/runs/:runId/events/stream` returns Server-Sent Events with the custom event name `run-event`.

```text
event: run-event
id: evt_mtt...
data: {"type":"node.completed", ...}
```

The stream replays the recent run history and then stays open for live events. The browser deduplicates by event ID.

For Vercel, set `NEXT_PUBLIC_EVENT_TRANSPORT=polling`. The browser polls `GET /api/runs/:runId` and `GET /api/runs/:runId/events`; each API instance reloads the run from MySQL, so n8n callbacks and browser reads can safely land on different stateless functions.

## n8n callback envelope

```json
{
  "context": {
    "runId": "run_demo",
    "workflowId": "lead-intake",
    "executionId": "123",
    "input": { "...": "..." }
  },
  "events": [
    {
      "type": "node.completed",
      "runId": "run_demo",
      "workflowId": "lead-intake",
      "executionId": "123",
      "nodeId": "normalize",
      "status": "success",
      "output": { "normalizedEmail": "sarah@northstar.example" }
    }
  ]
}
```

The callback requires `x-flowpilot-event-secret` to match `N8N_EVENT_SECRET`. In local Compose it is internal container traffic. With a Vercel API it is a public machine-to-machine endpoint and must never be called from browser code or expose the shared secret through a `NEXT_PUBLIC_*` variable.
