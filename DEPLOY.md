# FlowPilot 部署说明

FlowPilot 现在按照 Agent Studio 的方式拆成两个 Vercel Project：

```text
GitHub: Ghostisme/flowpilot
    ├── apps/web  → Vercel Project: FlowPilot Web
    └── apps/api  → Vercel Project: FlowPilot API

托管 n8n → Render Free 容器 + Aiven Free PostgreSQL
MySQL 服务 → 复用 Agent Studio 的连接服务和凭据，但使用独立的 `flowpilot` 数据库
```

Vercel 负责 Next.js 控制台和 NestJS API；n8n 不放进 Vercel，因为它需要持续运行的 webhook、Wait 审批执行和工作流存储。FlowPilot 可以复用 Agent Studio 当前的 MySQL 服务、主机、端口、用户、密码和 SSL 配置，但 `MYSQL_DB` 固定使用你新建的 `flowpilot` 数据库。FlowPilot 只在这个数据库创建 `flowpilot_*` 表，不读取或修改 Agent Studio 的 `defaultdb` / `ip_blocklist`。

## 0. 推送独立仓库

在本地项目目录执行：

```powershell
Set-Location 'C:\Users\Administrator\Desktop\创业\flowpilot'
git add .
git commit -m "feat: use dedicated FlowPilot MySQL database"
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
MYSQL_DB=flowpilot
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

这里的连接变量名和行为与 Agent Studio 的 `server/.env` 对齐，但不要复制 Agent Studio 的数据库名：FlowPilot 使用 `MYSQL_DB=flowpilot`。不要把密码写进 Git；从 Agent Studio 的本地 `.env` 或现有托管环境中复制连接凭据到 Vercel API Project 的 Environment Variables 即可。

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

脚本会复制 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_SSL`，并把 FlowPilot 的 `MYSQL_DB` 强制设为 `flowpilot`；不会沿用 Agent Studio 的 `defaultdb`。

## 2. 部署 n8n

### 方案 A：Render Free + Aiven Free PostgreSQL（推荐）

这条路线不需要 Railway，也不需要 n8n Cloud 付费计划：

```text
Render Free Web Service → 运行仓库里的 n8n Docker 镜像
Aiven Free PostgreSQL   → 保存 n8n 用户、工作流、凭据和执行记录
Aiven MySQL/flowpilot   → 继续只保存 FlowPilot 的运行审计数据
```

注意：n8n 自身的数据库支持 SQLite 或 PostgreSQL，不能直接使用现有的 Aiven MySQL。需要在 Aiven 中另外创建一个 **PostgreSQL Free** 服务；这不是再创建一个 MySQL database。

#### 2.1 创建免费的 n8n PostgreSQL

1. 打开 [Aiven Console](https://console.aiven.io/)。
2. Create service，选择 **PostgreSQL**。
3. 计划选择 **Free**，区域优先选新加坡或与你的 Render 服务相近的区域。
4. 创建完成后打开 Connection information，保留以下值：

```text
Host
Port
Database name（通常是 defaultdb）
User（通常是 avnadmin）
Password
```

这个 PostgreSQL 只给 n8n 使用。FlowPilot API 仍然使用已经创建好的 MySQL `flowpilot` 数据库，两者不要混填。

#### 2.2 用 Blueprint 发布 Render 免费容器

仓库根目录已经提供 [`render.yaml`](render.yaml)，其中固定了 `n8n/Dockerfile`、新加坡区域、免费实例、健康检查以及低内存并发限制。

1. 打开 [Render Dashboard](https://dashboard.render.com/)，选择 **New → Blueprint**。
2. 连接并选择 `Ghostisme/flowpilot` 仓库。
3. Blueprint 文件使用仓库根目录的 `render.yaml`。
4. Render 会要求填写以下没有写入 Git 的变量：

```text
DB_POSTGRESDB_HOST=<Aiven PostgreSQL Host>
DB_POSTGRESDB_PORT=<Aiven PostgreSQL Port>
DB_POSTGRESDB_DATABASE=<Aiven PostgreSQL Database name，通常 defaultdb>
DB_POSTGRESDB_USER=<Aiven PostgreSQL User>
DB_POSTGRESDB_PASSWORD=<Aiven PostgreSQL Password>

N8N_ENCRYPTION_KEY=<本地生成并长期保存的随机字符串>
FLOWPILOT_API_URL=https://<你的-api-project>.vercel.app
N8N_EVENT_SECRET=<随机长字符串，必须与 FlowPilot API 完全相同>
```

在本地 PowerShell 可以一次生成两个值：

```powershell
$encryptionKey = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$eventSecret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

分别填入 `N8N_ENCRYPTION_KEY` 和 `N8N_EVENT_SECRET`。保存好 `N8N_ENCRYPTION_KEY`，以后迁移或重建 Render 服务时必须继续使用同一个值，否则 n8n 无法解密以前保存的凭据。

5. 点击 Apply / Deploy。首次构建会自动导入并发布三个 FlowPilot 工作流。
6. 部署成功后会得到类似 `https://flowpilot-n8n-xxxx.onrender.com` 的域名。

仓库入口脚本会读取 Render 自动提供的公网 URL，所以不需要在第一次部署前猜 `N8N_HOST`、`N8N_WEBHOOK_URL` 或 `N8N_EDITOR_BASE_URL`。

#### 2.3 初始化并检查 n8n

打开 Render 的 n8n 域名，第一次进入时创建 n8n owner 账号。然后确认下面三个工作流存在并处于 Published / Active 状态：

```text
FlowPilot — Emit Workflow Event
FlowPilot — Error Handler
FlowPilot — AI Lead Intake & Routing
```

检查：

```text
https://<你的-n8n-域名>/healthz
https://<你的-n8n-域名>/webhook/flowpilot-lead-intake
```

`/healthz` 应返回 `{"status":"ok"}`。第二个地址只接受 POST，浏览器 GET 出现 404/405 不代表部署失败。

#### 2.4 回填 Vercel API

在 FlowPilot API Project 中设置并重新部署：

```text
WORKFLOW_DRIVER=n8n
N8N_WEBHOOK_URL=https://<你的-n8n-域名>/webhook/flowpilot-lead-intake
N8N_INTERNAL_BASE_URL=https://<你的-n8n-域名>
N8N_HEALTHCHECK_URL=https://<你的-n8n-域名>/healthz
N8N_COLD_START_TIMEOUT_MS=90000
N8N_WEBHOOK_TIMEOUT_MS=30000
N8N_EVENT_SECRET=<与 Render 完全相同>
```

Render Free 空闲约 15 分钟会休眠，唤醒通常需要约一分钟。FlowPilot API 会先用无副作用的 `/healthz` 唤醒 n8n，确认返回 JSON 后才触发工作流或恢复审批，因此不要把 `N8N_COLD_START_TIMEOUT_MS` 留成 `0`。

Render 免费实例的文件系统会在休眠、重启或重新部署后丢失；这里没有使用本地 SQLite，n8n 状态放在 Aiven PostgreSQL，所以不会跟着容器文件系统消失。Render 自己的免费 PostgreSQL 目前会在 30 天后过期，因此这里不采用它。

### 方案 B：n8n Cloud

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

### 方案 C：其他长期运行的容器平台

如果后续改成付费常驻平台，继续使用仓库中的 n8n 配置：

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
1. 准备 Agent Studio 当前 MySQL 连接配置，并确认 `flowpilot` 数据库已创建
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

本地 PostgreSQL 使用 `flowpilot_*` 表，云端 `flowpilot` MySQL 数据库也使用同样的 `flowpilot_*` 表前缀；云端不会写入 Agent Studio 的 `defaultdb`。
