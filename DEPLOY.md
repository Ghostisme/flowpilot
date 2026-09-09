# FlowPilot 部署说明

FlowPilot 现在按照 Agent Studio 的方式拆成两个 Vercel Project：

```text
GitHub: Ghostisme/flowpilot
    ├── apps/web  → Vercel Project: FlowPilot Web
    └── apps/api  → Vercel Project: FlowPilot API

托管 n8n → n8n Cloud 或 Railway / Render 上的长驻 n8n
共享数据库 → 使用 Agent Studio 现有的 MYSQL_* 连接配置
```

Vercel 负责 Next.js 控制台和 NestJS API；n8n 不放进 Vercel，因为它需要持续运行的 webhook、Wait 审批执行和工作流存储。数据库可以直接使用 Agent Studio 当前的 MySQL 实例，但 FlowPilot 只创建 `flowpilot_*` 表，不读取或修改 Agent Studio 的 `ip_blocklist` 表。

## 0. 推送独立仓库

在本地项目目录执行：

```powershell
Set-Location 'C:\Users\Administrator\Desktop\创业\flowpilot'
git add .
git commit -m "feat: prepare FlowPilot for Vercel and shared MySQL"
git push origin main
```

如果你还不想提交，可以先在 Vercel 连接当前 GitHub 仓库的工作分支；本地工作树目前没有自动提交或推送。

## 1. 先部署 API Project

在 Vercel 创建第一个 Project：

1. Import `Ghostisme/flowpilot`。
2. **Root Directory** 选择 `apps/api`。
3. Framework Preset 保持自动识别的 NestJS / Other。
4. 不要把本地 Docker 的 `DATABASE_URL`、`N8N_WEBHOOK_URL` 或 `localhost` 地址带到 Vercel。
5. 添加下面的环境变量。

### API 环境变量

```text
PERSISTENCE_DRIVER=mysql
FLOWPILOT_TABLE_PREFIX=flowpilot_

MYSQL_HOST=<与 Agent Studio 相同>
MYSQL_PORT=<与 Agent Studio 相同>
MYSQL_USER=<与 Agent Studio 相同>
MYSQL_PASSWORD=<与 Agent Studio 相同>
MYSQL_DB=<与 Agent Studio 相同>
MYSQL_SSL=true
MYSQL_SSL_CA=<可选；没有时仍使用加密连接>
MYSQL_POOL_SIZE=2

WORKFLOW_DRIVER=n8n
N8N_WEBHOOK_URL=https://<你的-n8n-域名>/webhook/flowpilot-lead-intake
N8N_INTERNAL_BASE_URL=https://<你的-n8n-域名>
N8N_EVENT_SECRET=<随机长字符串>

CORS_ORIGINS=https://<你的-web-project>.vercel.app
OPENAI_API_KEY=<可选>
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

这里的 `MYSQL_*` 变量名和行为与 Agent Studio 的 `server/.env` 对齐。不要把密码写进 Git；从 Agent Studio 的本地 `.env` 或现有 Vercel/Railway 环境中复制到 Vercel API Project 的 Environment Variables 即可。

如果此时还没有 n8n 公网域名，第一次部署 API 时可以暂时使用：

```text
WORKFLOW_DRIVER=simulator
```

先取得 API Project URL，部署完 n8n 后再把它切换成 `n8n`，补齐两个 n8n URL 并重新部署 API。这样不会产生 API 与 n8n 互相等待公网地址的循环。

API 部署完成后，先打开：

```text
https://<你的-api-project>.vercel.app/api/health
```

应该看到类似：

```json
{
  "status": "ok",
  "service": "flowpilot-api",
  "driver": "n8n",
  "persistence": "mysql",
  "tablePrefix": "flowpilot_"
}
```

第一次启动会自动创建：

```text
flowpilot_workflow_runs
flowpilot_workflow_events
```

也可以在本地使用已经保存的 Agent Studio 配置生成 `.env`（不会打印密码）：

```powershell
Set-Location 'C:\Users\Administrator\Desktop\创业\flowpilot'
pnpm db:reuse-agent-studio
```

脚本读取：

```text
C:\Users\Administrator\Desktop\创业\agent-studio\server\.env
```

并只复制 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DB`、`MYSQL_SSL` 到 FlowPilot 的本地 `.env`。

## 2. 部署 n8n

### 方案 A：n8n Cloud

导入以下生成好的工作流：

```text
C:\Users\Administrator\Desktop\创业\flowpilot\n8n\workflows\01-emit-workflow-event.json
C:\Users\Administrator\Desktop\创业\flowpilot\n8n\workflows\02-workflow-error-handler.json
C:\Users\Administrator\Desktop\创业\flowpilot\n8n\workflows\03-lead-intake.json
```

在 n8n 中设置：

```text
FLOWPILOT_API_URL=https://<你的-api-project>.vercel.app
N8N_EVENT_SECRET=<必须与 Vercel API 相同>
```

如果当前 n8n Cloud 计划不允许工作流直接读取 `$env`，就在导入后把 HTTP Request 节点中的 API 地址改为 API Project URL，并把 `x-flowpilot-event-secret` 改为相同的 secret。自托管 n8n 可以直接使用 `$env`。

### 方案 B：Railway / Render 自托管 n8n

使用仓库中的 n8n 配置：

```text
C:\Users\Administrator\Desktop\创业\flowpilot\n8n\Dockerfile
C:\Users\Administrator\Desktop\创业\flowpilot\n8n\docker-entrypoint.sh
```

设置这些变量：

```text
FLOWPILOT_API_URL=https://<你的-api-project>.vercel.app
N8N_EVENT_SECRET=<与 API 相同>
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
N8N_ENCRYPTION_KEY=<随机长字符串>
```

部署完成后，把 n8n 的公网域名填回 Vercel API：

```text
N8N_WEBHOOK_URL=https://<你的-n8n-域名>/webhook/flowpilot-lead-intake
N8N_INTERNAL_BASE_URL=https://<你的-n8n-域名>
```

`N8N_INTERNAL_BASE_URL` 是给人工审批恢复 Wait 节点用的；不能填 Vercel API 地址。

## 3. 部署 Web Project

在 Vercel 创建第二个 Project：

1. 继续 Import `Ghostisme/flowpilot`。
2. **Root Directory** 选择 `apps/web`。
3. Framework Preset 选择 Next.js（通常会自动识别）。
4. 添加：

```text
NEXT_PUBLIC_API_BASE=https://<你的-api-project>.vercel.app/api
NEXT_PUBLIC_EVENT_TRANSPORT=polling
```

`polling` 是有意设计的：Vercel API 是无状态函数，不保证创建 run、n8n callback、浏览器读取一定落在同一个函数实例；MySQL 是事实源，前端轮询可以跨实例稳定看到事件。Docker 本地仍可以使用默认 SSE。

部署后打开 Web Project 的域名，点击：

```text
High-intent lead
Needs approval
Early research
Duplicate lead
Invalid payload
```

中等线索会停在 n8n Wait 节点，前端出现 Approve / Reject；审批之后 n8n 继续执行并把最终事件写回 MySQL。

## 4. 部署顺序

推荐严格按这个顺序：

```text
1. 准备 Agent Studio 当前 MySQL 连接配置
2. 先以 WORKFLOW_DRIVER=simulator 部署 FlowPilot API，得到 API URL
3. 用该 API URL 部署 n8n 并导入三个工作流
4. 把 API 切换到 WORKFLOW_DRIVER=n8n，填入 n8n URL 后重新部署
5. 打开 /api/health 验证 API + MySQL
6. 部署 FlowPilot Web，填 NEXT_PUBLIC_API_BASE
7. 在 Web 控制台执行 high / medium / low 场景
```

## 5. 云端验收

本地只需要检查 API 的公网地址：

```powershell
$api = 'https://<你的-api-project>.vercel.app'
Invoke-RestMethod "$api/api/health"
Invoke-RestMethod "$api/api/workflows/lead-intake"
```

不要在 Vercel 上运行：

```text
docker compose up
docker compose down -v
pnpm smoke
```

这些命令是本地 Docker 验收命令。云端验收应该从 Web 控制台发起，或者使用公网 API 请求；n8n 必须是独立的在线运行时。

## 6. 本地 Docker 仍然保留

Vercel 改造不会破坏本地链路。默认 Docker 仍使用 PostgreSQL：

```powershell
Set-Location 'C:\Users\Administrator\Desktop\创业\flowpilot'
docker compose up -d --build
pnpm smoke
```

本地 PostgreSQL 使用 `flowpilot_*` 表，云端共享 MySQL 也使用同样的 `flowpilot_*` 表前缀；两套环境不会混用数据。
