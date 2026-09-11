# FlowPilot n8n workflows

The JSON files in this directory are generated from [`scripts/generate-n8n-workflows.mjs`](../scripts/generate-n8n-workflows.mjs).

## Files

- `01-emit-workflow-event.json` — reusable sub-workflow that posts `{ context, events }` to the API and returns the API's unwrapped context.
- `02-workflow-error-handler.json` — n8n Error Trigger plus a local Slack adapter alert.
- `03-lead-intake.json` — webhook-driven lead intake, validation, deduplication, AI qualification adapter, score routing, signed Wait approval, mock side effects, audit event, and response.

## Regenerate and validate

```powershell
pnpm workflows:generate
pnpm workflows:validate
```

The generator uses stable UUIDs, so repeated generation does not create noisy diffs.

The custom container entrypoint stores a checksum in the n8n data volume. It re-imports and republishes the workflows only when the checked-in JSON changes.

## Import manually

```powershell
n8n import:workflow --separate --input .\n8n\workflows
```

Keep the workflow IDs unchanged. The main workflow references `flowpilot-emit-event` as a database sub-workflow and `flowpilot-error-handler` as its error workflow.

## Runtime assumptions

- `FLOWPILOT_API_URL` points to the API from inside the n8n container.
- `N8N_EVENT_SECRET` is shared by n8n and the API.
- The Wait node sends its generated `$execution.resumeUrl` to the API as part of `approval.required` metadata.
- The API can rewrite that URL with `N8N_INTERNAL_BASE_URL` when the URL advertised by n8n is browser-facing (`localhost`) but the API runs in another container.

## Free hosted runtime

The Next.js console and NestJS API can both run on Vercel, but n8n needs a container host. The repository root contains `render.yaml` for a Render Free web service. Use a separate Aiven Free PostgreSQL service as n8n's database; do not point n8n at FlowPilot's MySQL service because self-hosted n8n supports SQLite or PostgreSQL for its internal state.

Render provides `RENDER_EXTERNAL_URL` and `RENDER_EXTERNAL_HOSTNAME`. The custom entrypoint converts them into `N8N_WEBHOOK_URL`, `N8N_EDITOR_BASE_URL`, and `N8N_HOST`, so the generated Render domain works without hardcoding it before the first deployment.

The Blueprint prompts for the Aiven PostgreSQL fields, a stable n8n encryption key, and these FlowPilot values:


```text
N8N_ENCRYPTION_KEY=a-long-random-value-that-you-save-for-redeploys
FLOWPILOT_API_URL=https://YOUR-FLOWPILOT-API.vercel.app
N8N_EVENT_SECRET=the-same-value-configured-on-the-api
```

Render Free sleeps after an idle period and has an ephemeral filesystem. PostgreSQL preserves the n8n owner account, workflows, credentials, and executions across sleeps and redeploys. Configure the Vercel API with `N8N_COLD_START_TIMEOUT_MS=90000`; the API waits for `/healthz` before workflow and approval POST requests.

The lead webhook acknowledges immediately (`responseMode=onReceived`). Execution continues in n8n and publishes durable state to the FlowPilot API, so the Vercel function does not stay open during a human approval wait.
