import type { NextConfig } from "next";

/**
 * FlowPilot Web 构建配置。
 *
 * 部署形态：生产不跑 Node 运行时，站点静态导出后交给 nginx 镜像托管
 * （见仓库根 Dockerfile.web-static）。因此需要 output: "export"。
 *
 * 该选项会让 `next start` 失效，所以做成按需开启——仅当构建镜像时显式设置
 * NEXT_OUTPUT=export 才导出，本地 dev/start 与根 Dockerfile 的 web target
 * 行为完全不受影响。
 */
const isStaticExport = process.env.NEXT_OUTPUT === "export";

const nextConfig: NextConfig = {
  transpilePackages: ["@flowpilot/contracts"],
  agentRules: false,

  ...(isStaticExport
    ? {
        output: "export" as const,

        // 静态导出无服务端，next/image 的按需优化不可用，必须关闭否则构建报错。
        images: { unoptimized: true },

        // 导出为 <route>/index.html，nginx 用目录索引即可命中，无需额外 rewrite。
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
