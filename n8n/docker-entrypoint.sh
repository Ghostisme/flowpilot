#!/bin/sh
set -eu

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
