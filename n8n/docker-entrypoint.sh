#!/bin/sh
set -eu

if [ -n "${PORT:-}" ] && [ -z "${N8N_PORT:-}" ]; then
  export N8N_PORT="$PORT"
fi

if [ -n "${RENDER_EXTERNAL_URL:-}" ]; then
  RENDER_PUBLIC_URL="${RENDER_EXTERNAL_URL%/}"
  export N8N_HOST="${N8N_HOST:-${RENDER_EXTERNAL_HOSTNAME:-0.0.0.0}}"
  export N8N_PROTOCOL="${N8N_PROTOCOL:-https}"
  export N8N_WEBHOOK_URL="${N8N_WEBHOOK_URL:-$RENDER_PUBLIC_URL/}"
  export N8N_EDITOR_BASE_URL="${N8N_EDITOR_BASE_URL:-$RENDER_PUBLIC_URL/}"
  export N8N_PROXY_HOPS="${N8N_PROXY_HOPS:-1}"
  echo "Configured n8n public URL from Render: $RENDER_PUBLIC_URL"
fi

MARKER="/home/node/.n8n/.flowpilot-workflows.sha256"
CURRENT_CHECKSUM="$(sha256sum /opt/flowpilot/workflows/*.json | sha256sum | awk '{print $1}')"
IMPORTED_CHECKSUM="$(cat "$MARKER" 2>/dev/null || true)"

if [ "$CURRENT_CHECKSUM" != "$IMPORTED_CHECKSUM" ]; then
  echo "Importing FlowPilot workflows..."
  n8n import:workflow --separate --input=/opt/flowpilot/workflows
  n8n publish:workflow --id=flowpilot-emit-event
  n8n publish:workflow --id=flowpilot-lead-intake
  n8n publish:workflow --id=flowpilot-error-handler
  printf '%s' "$CURRENT_CHECKSUM" > "$MARKER"
fi

exec n8n start
