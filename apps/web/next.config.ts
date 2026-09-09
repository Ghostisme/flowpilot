import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@flowpilot/contracts"],
  agentRules: false,
};

export default nextConfig;
