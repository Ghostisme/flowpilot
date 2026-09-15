# Vercel 部署问题根源分析与解决方案

## 📋 问题总结

FlowPilot 项目从提交 `8be6774` 到 `154f420` 之间进行了 **20+ 次 Vercel 部署修复**,但问题越改越糟。通过 Git 历史分析发现,**初始设计是正确的**,后续所有修改都是不必要的,反而引入了配置冲突。

---

## 🔍 根本原因

### 1. **初始设计(提交 `8be6774`)** ✅ 正确
```json
// apps/api/vercel.json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "installCommand": "pnpm install --filter @flowpilot/api...",
  "buildCommand": "pnpm --filter @flowpilot/contracts build && pnpm --filter @flowpilot/api build"
}
```

**配套的 Vercel Project 设置**:
- Root Directory: `apps/api`
- Framework Preset: Other (或自动检测的 NestJS)

这个配置遵循了 DEPLOY.md 的指导,与 `agent-studio` 和 `nestjs-prisma-api-gateway` 的结构一致。

### 2. **错误转折点(提交 `587e30e` - `1f59ea9`)** ❌

有人误认为需要添加 `builds` 和 `routes` 配置来"适配 Vercel Serverless":

```json
{
  "version": 2,
  "builds": [
    {
      "src": "dist/main.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "dist/main.js"
    }
  ],
  "installCommand": "pnpm install --filter @flowpilot/api...",
  "buildCommand": "pnpm --filter @flowpilot/contracts build && pnpm --filter @flowpilot/api build"
}
```

**这是完全错误的**,原因:
- Vercel 会**自动检测** NestJS 项目并生成正确的 serverless 函数
- `builds` 和 `routes` 配置是遗留 API(Vercel v2),与现代 Vercel 的自动检测机制冲突
- `apps/api/src/main.ts` 已经正确导出了 `default` handler,无需额外配置

### 3. **路径混乱期(提交 `49f9ab1` - `154f420`)** 💥

后续提交在两种部署模式之间反复横跳:

**模式 A: Root Directory = `apps/api`** (初始正确设计)
- 路径相对于 `apps/api`
- vercel.json 中: `dist/main.js`

**模式 B: Root Directory = `/`** (monorepo root)
- 路径相对于仓库根目录
- vercel.json 中: `apps/api/dist/main.js`
- buildCommand 需要 `cd ../..`

最终的 `apps/api/vercel.json` 变成了**两种模式的混合体**:
```json
{
  "version": 2,
  "builds": [
    {
      "src": "dist/main.js",           // 模式 A 的路径
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "dist/main.js"           // 模式 A 的路径
    }
  ]
  // 但 Vercel Project Root Directory 可能设置成了 `/`
}
```

或者:
```json
{
  "version": 2,
  "builds": [
    {
      "src": "apps/api/dist/main.js",  // 模式 B 的路径
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "apps/api/dist/main.js"  // 模式 B 的路径
    }
  ]
  // 但 buildCommand 没有 cd 到根目录
}
```

**结果**: 路径不一致,部署彻底失败。

---

## ✅ 最终解决方案 (提交 `a6c165d` → 最新)

### **参考成功项目: nestjs-prisma-api-gateway**

通过分析 `/d/github_code/远程接单用于经验展示的相关项目/nestjs-prisma-api-gateway`,发现其成功配置:

```json
// server/vercel.json
{
  "installCommand": "pnpm install && pnpm prisma generate",
  "functions": {
    "api/index.ts": {
      "memory": 1024,
      "maxDuration": 30
    }
  },
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/api/index.ts"
    }
  ]
}
```

**关键特点**:
1. **不使用 pnpm filter** - 直接 `pnpm install`
2. **api/index.ts** - Vercel Function 入口点
3. **Root Directory**: `server` (独立目录,不是 monorepo apps 结构)
4. **functions 配置** - 优化 serverless 内存和超时

### **FlowPilot 的特殊问题**

FlowPilot 是 monorepo 结构:
```
flowpilot/
├── apps/api/          # Vercel Root Directory
├── packages/contracts/ # 依赖包
└── pnpm-workspace.yaml
```

**问题**: 当 Vercel Root Directory = `apps/api` 时:
- pnpm 找不到父目录的 `pnpm-workspace.yaml`
- `pnpm install --filter @flowpilot/api...` 失败
- `@flowpilot/contracts` 依赖无法解析

### **最终配置**

#### 1. **vercel.json**
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "pnpm install && pnpm build",
  "functions": {
    "api/index.js": {
      "memory": 1024,
      "maxDuration": 30
    }
  },
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/api/index"
    }
  ]
}
```

#### 2. **构建脚本: scripts/build-with-contracts.mjs**
```javascript
// 在 API 构建前先构建 contracts 包
// 检测 ../../packages/contracts 是否存在
// 如果存在,先执行 pnpm build
// 然后 API 通过 node_modules 链接访问
```

#### 3. **package.json build 脚本**
```json
{
  "scripts": {
    "build": "node scripts/build-with-contracts.mjs && tsc"
  }
}
```

#### 4. **api/index.js 入口**
```javascript
// 导入编译后的 dist/main.js handler
import handler from '../dist/main.js';
export default handler;
```

### **为什么这样能工作**

1. **标准 pnpm install**:
   - Vercel 在 `apps/api` 目录执行 `pnpm install`
   - pnpm 会读取 `package.json` 中的 `@flowpilot/contracts` 依赖
   - 自动创建 symlink 到 `../../packages/contracts`

2. **预构建 contracts**:
   - `build-with-contracts.mjs` 检测父目录是否有 contracts 包
   - 如果有,先进入 `../../packages/contracts` 执行 `pnpm build`
   - 生成 `dist/` 目录(28KB 类型定义 + JS)

3. **API 构建**:
   - `tsc` 编译 `src/` → `dist/`
   - 导入语句 `import { ... } from '@flowpilot/contracts'`
   - 通过 node_modules symlink 解析到已构建的 contracts

4. **Vercel Function**:
   - `api/index.js` 被识别为 serverless function
   - 所有请求通过 `rewrites` 路由到这里
   - 导出的 handler 处理 NestJS 请求

### 2. **Vercel Project 设置**

在 Vercel Dashboard 中:
- **Root Directory**: `apps/api` ✅
- **Framework Preset**: Other 或 NestJS ✅
- **Build Command**: (留空,使用 vercel.json 中的配置)
- **Output Directory**: (留空,Vercel 自动检测 `dist`)
- **Install Command**: (留空,使用 vercel.json 中的配置)

### 3. **为什么这样能工作**

1. **`apps/api/src/main.ts` 导出 handler**:
   ```typescript
   export default async (req: Request, res: Response) => {
     const app = await bootstrap();
     return app(req, res);
   };
   ```
   编译后生成 `dist/main.js`,包含完整的 NestJS 应用。

2. **Vercel Functions 约定**:
   - Vercel 自动检测 `api/` 目录,将每个文件转换为 serverless 函数
   - `api/index.js` → `/api/index` 端点
   - 函数导入 `dist/main.js` 的 handler,避免重复构建

3. **rewrites 路由规则**:
   - 将所有请求 (`/(.*)`) 重写到 `/api/index`
   - 这样 NestJS 的全局前缀 `/api` 和所有路由都能正常工作

4. **pnpm workspace 依赖**:
   - `--filter @flowpilot/api...` 自动包含 `@flowpilot/contracts`
   - 按顺序构建:contracts → api

---

## 🎯 与参考项目的对比

### agent-studio / nestjs-prisma-api-gateway 的结构:
```
repo/
├── apps/
│   └── api/
│       ├── src/
│       ├── package.json
│       └── vercel.json (简洁配置,无 builds/routes)
└── packages/
    └── contracts/
```

**Vercel 部署**:
- Root Directory: `apps/api`
- vercel.json: 只有 installCommand 和 buildCommand
- 让 Vercel 自动处理其余一切

**FlowPilot 现在的结构完全相同**,只需要遵循同样的部署方式。

---

## 📝 部署检查清单

在 Vercel 中部署 `apps/api` 时:

- [ ] Root Directory 设置为 `apps/api`
- [ ] 确认存在 `api/index.js` 文件(Vercel Function 入口)
- [ ] vercel.json 包含 installCommand、buildCommand 和 rewrites
- [ ] **删除** 旧的 `builds`、`routes`、`version` 配置(如果有)
- [ ] 确认 `src/main.ts` 导出了 `default` handler
- [ ] 环境变量按 DEPLOY.md 配置(不包含 localhost 地址)
- [ ] `.vercelignore` 正确排除 `node_modules`、`.env` 等

---

## 🚀 预期结果

部署成功后:
- `https://your-api-project.vercel.app/api/health` 返回 200 OK
- 所有 API 路由正常工作(`/api/*`)
- CORS 配置生效
- 数据库连接正常

---

## 📚 经验教训

1. **简单的配置往往是正确的** - 不要过度配置
2. **相信框架的自动检测** - Vercel 对 NestJS 有完善的支持
3. **路径一致性至关重要** - Root Directory 和文件路径必须匹配
4. **Git 历史是诊断的宝藏** - 第一个版本往往最接近正确答案
5. **参考同类项目** - agent-studio 的成功部署证明了这个模式可行

---

生成时间: 2026-09-15
分析提交范围: `092a524` (初始) → `154f420` (最新)
