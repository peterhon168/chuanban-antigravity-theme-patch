#!/usr/bin/env node
/**
 * Antigravity PreInvocation Hook 静默策略同步器 (pre-invocation-hook.mjs)
 * 按当前 modelName 自动同步 ~/.gemini/GEMINI.md（含策略模板 + 锁模规则 + 当前模式 A/B 协同规范），
 * 并输出空对象 {}，不在对话气泡或工具输出尾部追加任何可见噪音文本。
 */

import fs from 'node:fs';
import {
  readState,
  applyPolicyToGeminiMd,
  detectPolicyFromModelName
} from './policy-manager.mjs';

function readStdinSafe() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const rawIn = readStdinSafe();
let payload = {};
if (rawIn.trim()) {
  try {
    payload = JSON.parse(rawIn);
  } catch {
    payload = {};
  }
}

const curState = readState();
const detectedPolicy = detectPolicyFromModelName(payload?.modelName);

if (detectedPolicy === 'opus') {
  applyPolicyToGeminiMd('opus', { mode: curState.mode, source: 'hook:pre-invocation:opus' });
} else if (detectedPolicy === 'sonnet') {
  applyPolicyToGeminiMd('sonnet', { mode: curState.mode, source: 'hook:pre-invocation:sonnet' });
} else if (detectedPolicy === 'gemini') {
  const isLockedForClaude =
    curState.policy !== 'gemini' &&
    typeof curState.policyLockUntil === 'number' &&
    curState.policyLockUntil > Date.now();
  if (!isLockedForClaude) {
    applyPolicyToGeminiMd('gemini', { mode: curState.mode, lockMs: 0, source: 'hook:pre-invocation:gemini' });
  }
}

process.stdout.write('{}\n');
