#!/usr/bin/env node
/**
 * Antigravity PreToolUse Hook 策略预切换器 (pre-tool-use-hook.mjs)
 * 在主会话通过 swarm、post_message 或 run_command (agy CLI) 调用 Claude Opus / Sonnet 前，
 * 提前将 ~/.gemini/GEMINI.md 原子切换为 opus v2.md 或 Sonnet v2.md。
 */

import fs from 'node:fs';
import { applyPolicyToGeminiMd } from './policy-manager.mjs';

function readStdinSafe() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function detectTargetClaudePolicy(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const name = String(toolCall.name || '').toLowerCase();
  const args = toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : {};

  if (name === 'swarm') {
    const combined = `${args.model || ''} ${args.name || ''} ${args.action || ''}`.toLowerCase();
    if (combined.includes('opus')) return 'opus';
    if (combined.includes('sonnet')) return 'sonnet';
  } else if (name === 'post_message') {
    const combined = `${args.Recipient || args.recipient || ''} ${args.Message || args.message || ''}`.toLowerCase();
    if (combined.includes('opus')) return 'opus';
    if (combined.includes('sonnet')) return 'sonnet';
  } else if (name === 'run_command') {
    const cmd = String(args.CommandLine || args.command || '').toLowerCase();
    if (cmd.includes('agy') || cmd.includes('claude')) {
      if (cmd.includes('claude-opus') || cmd.includes('opus-agent')) return 'opus';
      if (cmd.includes('claude-sonnet') || cmd.includes('sonnet-agent')) return 'sonnet';
    }
  }
  return '';
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

const targetPolicy = detectTargetClaudePolicy(payload?.toolCall);
if (targetPolicy === 'opus' || targetPolicy === 'sonnet') {
  try {
    applyPolicyToGeminiMd(targetPolicy, {
      lockMs: 180000,
      source: `hook:pre-tool:${payload?.toolCall?.name || 'tool'}-${targetPolicy}`
    });
  } catch {}
}

process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
