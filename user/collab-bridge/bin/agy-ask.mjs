#!/usr/bin/env node
/**
 * 跨平台只读顾问调用封装 (bin/agy-ask.mjs)
 * 支持 Windows / macOS / Linux，调用本机 agy -p --output-format json。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function printHelp() {
  console.log(`用法:
  agy-ask [--dir <目录>] [--model <模型ID>] [--copy] "<原始需求或待润色内容>"

选项:
  --dir <目录>      指定参考工作目录（默认当前目录）
  --model <模型ID>  指定调用模型（默认 gemini-4-neon-high）
  --copy            切换为界面文案与交互顾问模板`);
}

function resolveAgyExe() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const candidate = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  if (process.platform === 'darwin') {
    const macCandidates = [
      path.join(os.homedir(), '.local', 'bin', 'agy'),
      '/usr/local/bin/agy',
      '/opt/homebrew/bin/agy'
    ];
    for (const c of macCandidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return 'agy';
}

function parseArgs(argv) {
  const opts = {
    dir: process.cwd(),
    model: 'gemini-4-neon-high',
    copy: false,
    help: false,
    parts: []
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '--dir') {
      opts.dir = argv[++i] || opts.dir;
    } else if (a === '--model' || a === '-m') {
      opts.model = argv[++i] || opts.model;
    } else if (a === '--copy') {
      opts.copy = true;
    } else {
      opts.parts.push(a);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  printHelp();
  process.exit(0);
}

const userText = opts.parts.join(' ').trim();
if (!userText) {
  console.error('错误: 请提供问题、原始需求或待润色文案。');
  printHelp();
  process.exit(2);
}

const targetDir = path.resolve(opts.dir);
const wrappedPrompt = opts.copy
  ? [
      '【严格只读 · 界面文案与交互顾问】',
      '禁止修改任何文件或执行写命令。请面向真实最终用户，用简洁、自然、无人味/无黑话的中文给出界面文案与交互改进建议；凡属推测请显式标注。',
      '',
      userText
    ].join('\n')
  : [
      '【严格只读 · 独立方案顾问（双盲对比）】',
      '禁止修改任何文件、禁止执行写命令。请仅根据以下原始需求与仓库事实独立输出方案、关键风险与取舍建议；未核实的推断请显式标出「推测」。',
      '',
      userText
    ].join('\n');

const agyExe = resolveAgyExe();
const res = spawnSync(
  agyExe,
  ['-p', wrappedPrompt, '--model', opts.model, '--output-format', 'json'],
  {
    cwd: targetDir,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 4 * 1024 * 1024
  }
);

if (res.error) {
  console.error('[agy-ask] 启动失败:', res.error.message);
  process.exit(1);
}

const stdout = (res.stdout || '').trim();
if (stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed?.response === 'string') {
      console.log(parsed.response.trim());
    } else {
      console.log(stdout);
    }
  } catch {
    console.log(stdout);
  }
}
if (res.stderr && res.status !== 0) {
  console.error(res.stderr.trim());
}
process.exit(res.status ?? 0);
