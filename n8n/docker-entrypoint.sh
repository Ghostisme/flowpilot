#!/bin/sh
set -eu

# Render 提供 PORT，确保 n8n 使用它
if [ -n "${PORT:-}" ]; then
  export N8N_PORT="$PORT"
  echo "==> N8N_PORT set to: $N8N_PORT"
fi

# 确保 n8n 监听在所有网络接口上
export N8N_LISTEN_ADDRESS="${N8N_LISTEN_ADDRESS:-0.0.0.0}"
echo "==> N8N_LISTEN_ADDRESS set to: $N8N_LISTEN_ADDRESS"

# 打印关键配置用于调试
echo "==> Database config:"
echo "    DB_TYPE: ${DB_TYPE:-not set}"
echo "    DB_POSTGRESDB_HOST: ${DB_POSTGRESDB_HOST:-not set}"
echo "    DB_POSTGRESDB_PORT: ${DB_POSTGRESDB_PORT:-not set}"
echo "    DB_POSTGRESDB_DATABASE: ${DB_POSTGRESDB_DATABASE:-not set}"

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
