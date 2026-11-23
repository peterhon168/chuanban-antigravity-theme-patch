#!/usr/bin/env node
/**
 * 上游船板内核安全单向同步器 (sync-upstream.mjs)
 * 用途：从 upstream (https://github.com/Anarcadia/chuanban-antigravity-theme-patch.git)
 *      仅同步 core/ 内核更新（主题、字体、汉化词典、运行时），
 *      100% 物理锁定并保护本仓库的 user/（「完成了么」HUD、collab-bridge 状态桥与三套策略模板）、
 *      专属 README.md / SKILL.md 以及 install.mjs 的联动安装钩子，绝不被上游覆盖。
 *
 * 用法：
 *   node sync-upstream.mjs [--check]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPSTREAM_URL = 'https://github.com/Anarcadia/chuanban-antigravity-theme-patch.git';
const CHECK_ONLY = process.argv.includes('--check');

function git(args, allowFail = false) {
  try {
    return execFileSync('git', args, {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    if (allowFail) return '';
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
}

// 1. 确保 upstream remote 存在且指向船板原仓库
const remotes = git(['remote']).split(/\r?\n/).filter(Boolean);
if (!remotes.includes('upstream')) {
  git(['remote', 'add', 'upstream', UPSTREAM_URL]);
} else {
  git(['remote', 'set-url', 'upstream', UPSTREAM_URL]);
}

console.log('[SyncUpstream] Fetching upstream/main...');
git(['fetch', 'upstream', 'main', '--tags']);

const upstreamHead = git(['rev-parse', '--short', 'upstream/main']);
const upstreamSubject = git(['log', '-1', '--format=%s', 'upstream/main']);
const coreDiff = git(['diff', '--name-status', 'HEAD..upstream/main', '--', 'core/']);

if (!coreDiff) {
  console.log(`[SyncUpstream] core/ 内核已与 upstream/main (${upstreamHead}: ${upstreamSubject}) 完全一致，无需更新。`);
  process.exit(0);
}

console.log(`[SyncUpstream] 检测到 upstream/main (${upstreamHead}: ${upstreamSubject}) 的 core/ 变更：\n${coreDiff}`);

if (CHECK_ONLY) {
  console.log('[SyncUpstream] --check 模式结束，未修改本地文件。');
  process.exit(0);
}

// 2. 仅检出 upstream/main 的 core/ 目录，绝不触碰 user/、README.md、SKILL.md
git(['checkout', 'upstream/main', '--', 'core/']);

// 3. 二次校验 user/ 目录零污染
const userDirty = git(['status', '--porcelain', '--', 'user/']);
if (userDirty) {
  console.warn('[SyncUpstream] 检测到 user/ 存在未提交改动（已保留，不会被覆盖）。');
}

const manifestPath = path.join(__dirname, 'core', 'manifest.json');
let upstreamVer = 'unknown';
try {
  upstreamVer = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))?.version || 'unknown';
} catch {}

console.log(
  `[SyncUpstream] 已安全同步 core/ 内核至 v${upstreamVer} (upstream ${upstreamHead})，user/（「完成了么」HUD 与 collab-bridge 三套策略）已 100% 保持完整。`
);
console.log('请运行 `git status` 检查后执行 `git commit -m "chore(core): sync upstream core"`。');
