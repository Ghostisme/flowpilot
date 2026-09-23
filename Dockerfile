# syntax=docker/dockerfile:1.7
# ═══════════════════════════════════════════════════════════════════════
#  FlowPilot 多阶段构建 —— 一个 Dockerfile 产出两个镜像
#
#    docker build --target api -t flowpilot-api .
#    docker build --target web -t flowpilot-web .
#
#  构建顺序是 contracts → api → web（根 package.json 的 build 脚本已经
#  串好了这个顺序）。contracts 必须先编译出 dist/，因为另外两个包是通过
#  workspace:* 依赖它的编译产物，而不是源码。
#
#  关于镜像体积：runtime 阶段整体拷贝 /app（含 devDependencies）。
#  在 pnpm workspace + node-linker=hoisted 下，依赖被提升到根 node_modules，
#  想精确裁剪出"仅生产依赖"需要用 pnpm deploy 重新组装依赖树，一旦路径
#  推断出错就是构建期失败。这里选择用磁盘换确定性 —— VPS 磁盘足够，而
#  一条会偶发失败的流水线代价高得多。
# ═══════════════════════════════════════════════════════════════════════

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# 版本号与根 package.json 的 packageManager 字段严格对齐，
# 避免 CI 和本地装出不同的依赖树
RUN corepack enable && corepack prepare pnpm@11.23.0 --activate

WORKDIR /app

# ── 依赖层 ────────────────────────────────────────────────────────────
#  先只拷各包的清单文件再 install，这是「源码变更」和「依赖变更」在构建
#  层面的分界线：只改业务代码时这一整层命中缓存，不用重装整个 monorepo
#  的依赖（那要好几分钟）。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

# cache mount 专门优化「依赖变更」那种情况：lockfile 一改，上面那层缓存
# 就失效、install 必然重跑，但 pnpm store 被挂成持久缓存后，已经下载过的
# 包不用再从网上拉一遍，只装真正新增或变更的那几个。
RUN --mount=type=cache,id=pnpm-store-flowpilot,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

COPY apps ./apps
COPY packages ./packages

# ⚠️ 构建期变量：Next.js 会把它内联进客户端 bundle。
# 运行时再改这个环境变量是无效的，必须重新构建镜像。
ARG NEXT_PUBLIC_API_BASE=http://localhost:3001/api
ARG NEXT_PUBLIC_EVENT_TRANSPORT=sse
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_EVENT_TRANSPORT=$NEXT_PUBLIC_EVENT_TRANSPORT
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm build


# ── 公共运行时层 ───────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# node 镜像自带 uid/gid 1000 的 node 用户，直接用它而不是新建一个。
# 两个服务都是面向公网的 HTTP 服务，没有任何理由跑在 root 下。
COPY --from=build --chown=node:node /app /app

USER node


# ── NestJS API ────────────────────────────────────────────────────────
FROM runtime AS api

ENV PORT=3001
EXPOSE 3001

# 这个镜像能正常监听端口的前提是 apps/api/src/main.ts 里的判断已经从
# `NODE_ENV !== "production"` 改成了「是否在 Serverless 环境」。
# 否则这里 NODE_ENV=production 会让进程启动后不 listen 任何端口 ——
# 容器状态是 running、日志干净、退出码 0，但反代只会拿到 502。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]


# ── Next.js 前端 ──────────────────────────────────────────────────────
FROM runtime AS web

ENV PORT=3000 \
    HOSTNAME=0.0.0.0
EXPOSE 3000

WORKDIR /app/apps/web

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3000"]
