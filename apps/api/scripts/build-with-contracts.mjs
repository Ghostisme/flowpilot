#!/usr/bin/env node
/**
 * Vercel 构建脚本:在构建 API 之前先构建 contracts 包
 *
 * 当 Vercel Root Directory 设置为 apps/api 时,pnpm workspace
 * 无法访问父目录的 packages/contracts,所以我们:
 * 1. 检测是否在 Vercel 环境(有 ../../packages/contracts)
 * 2. 如果是,先构建 contracts 包到其 dist 目录
 * 3. API 的 node_modules/@flowpilot/contracts 通过 pnpm 链接访问
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(__dirname, '../../../packages/contracts');

// 检查是否存在 contracts 包(非 Vercel 或 monorepo 根目录构建)
if (existsSync(contractsDir)) {
  console.log('[Build] Found contracts package, building it first...');

  try {
    // 进入 contracts 目录并构建
    execSync('pnpm build', {
      cwd: contractsDir,
      stdio: 'inherit'
    });

    console.log('[Build] ✓ Contracts built successfully');
  } catch (error) {
    console.error('[Build] ✗ Failed to build contracts:', error.message);
    process.exit(1);
  }
} else {
  console.log('[Build] Contracts package not found (probably standalone deployment), skipping...');
}
