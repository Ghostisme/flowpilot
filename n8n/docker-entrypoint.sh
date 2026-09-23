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

# 工作流自动导入。
#
# 用 checksum 做幂等标记：只有 workflows/*.json 的内容真的变了才重新导入，
# 所以容器日常重启不会反复覆盖你在编辑器里做的临时调整，而镜像里带了新版
# 工作流时又能自动同步过去。
#
# 这一步失败不阻断启动（|| echo WARNING）：n8n 起不来的话连编辑器都进不去，
# 那就完全没法排查了。宁可让它带着「工作流没导入」的状态启动，也不要在
# entrypoint 里挂掉。导入结果可以在编辑器的 Workflows 列表里确认。
if [ "$CURRENT_CHECKSUM" != "$IMPORTED_CHECKSUM" ]; then
  echo "==> Importing FlowPilot workflows (checksum changed)..."

  if n8n import:workflow --separate --input=/opt/flowpilot/workflows; then
    # import:workflow 一律把导入的工作流置为「未发布」，JSON 里的
    # "active": true 不会被采纳（--activeState=fromJson 只在 multi-main /
    # queue 模式下可用，我们是单实例）。所以必须显式逐个发布，
    # 否则 lead-intake 的 webhook 不会注册，API 调进来只会 404。
    #
    # n8n 2.0 用 publish/unpublish 取代了 active 开关，update:workflow
    # 虽然还能用但已标记废弃。
    for wf in flowpilot-emit-event flowpilot-lead-intake flowpilot-error-handler; do
      n8n publish:workflow --id="$wf" \
        || echo "WARNING: failed to publish $wf"
    done

    printf '%s' "$CURRENT_CHECKSUM" > "$MARKER"
    echo "==> Workflows imported and published"
  else
    echo "WARNING: workflow import failed — 请进编辑器手工导入 /opt/flowpilot/workflows"
  fi
else
  echo "==> Workflows already up to date (checksum unchanged), skipping import"
fi

echo "==> Starting n8n..."
echo "==> Final environment check:"
echo "    N8N_PORT: ${N8N_PORT:-not set}"
echo "    N8N_LISTEN_ADDRESS: ${N8N_LISTEN_ADDRESS:-not set}"
echo "    N8N_PROTOCOL: ${N8N_PROTOCOL:-not set}"
echo ""

exec n8n start
