#!/usr/bin/env node
/**
 * 跨平台受限 Codex 派活与两级代码审查封装 (bin/codex-worker.mjs)
 * 支持 Windows / macOS / Linux：
 *   - 支持 -f / --prompt-file <文件> 与 --stdin / - 读取完整多行任务书，免疫 Windows .cmd 换行截断；
 *   - Windows 普通写代码派活默认采用 -s danger-full-access（规避 Codex 内部 Restricted Token 导致目标工作区 Access is denied），
 *     --review 审查模式保持只读并用 -c windows.sandbox=unelevated；macOS/Linux 默认 -s workspace-write；
 *   - 可显式传入 --sandbox <read-only|workspace-write|danger-full-access> 覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function printHelp() {
  console.log(`用法:
  codex-worker --cd <工作目录> [--prompt-file <任务文件>] [--stdin] [--model <模型>] [--effort low|medium|high|xhigh] [--sandbox <模式>] [--resume <会话ID>] [--skip-git-repo-check] [--ephemeral] ["<任务说明>"]
  codex-worker --review --cd <工作目录> [--prompt-file <要求文件>] [--base <分支>] [--model <模型>] [--effort low|medium|high|xhigh] ["<补充审查要求>"]

说明:
  - -f, --prompt-file <文件> : 从 UTF-8 文件读取完整多行任务（Windows 长任务强烈推荐，防 .cmd 换行截断）。
  - --stdin 或位置参数 -     : 从标准输入读取完整多行任务。
  - --sandbox <模式>         : 覆盖沙箱模式 (read-only | workspace-write | danger-full-access)。
                               Windows 写任务默认 danger-full-access，macOS/Linux 默认 workspace-write。
  - 默认推理档位 high；涉及资金/权限/登录/对外发送时显式传 --effort xhigh。
  - --review 模式强制输出「阻塞级 (P0)」与「建议级 (P1)」两级审查清单。`);
}

function parseArgs(argv) {
  const opts = {
    review: false,
    cd: process.cwd(),
    model: '',
    effort: 'high',
    sandbox: '',
    resume: '',
    base: '',
    promptFile: '',
    useStdin: false,
    skipGitRepoCheck: false,
    ephemeral: false,
    help: false,
    promptParts: []
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '--review') {
      opts.review = true;
    } else if (a === '--cd' || a === '-C') {
      opts.cd = argv[++i] || opts.cd;
    } else if (a === '--model' || a === '-m') {
      opts.model = argv[++i] || '';
    } else if (a === '--effort') {
      const e = (argv[++i] || '').toLowerCase();
      if (e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh') {
        opts.effort = e;
      }
    } else if (a === '--sandbox' || a === '-s') {
      const s = (argv[++i] || '').toLowerCase();
      if (s === 'read-only' || s === 'workspace-write' || s === 'danger-full-access') {
        opts.sandbox = s;
      }
    } else if (a === '--resume') {
      opts.resume = argv[++i] || '';
    } else if (a === '--base') {
      opts.base = argv[++i] || '';
    } else if (a === '--prompt-file' || a === '-f') {
      opts.promptFile = argv[++i] || '';
    } else if (a === '--stdin' || a === '-') {
      opts.useStdin = true;
    } else if (a === '--skip-git-repo-check') {
      opts.skipGitRepoCheck = true;
    } else if (a === '--ephemeral') {
      opts.ephemeral = true;
    } else {
      opts.promptParts.push(a);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  printHelp();
  process.exit(0);
}

const promptSections = [];
if (opts.promptFile) {
  const pfPath = path.resolve(opts.promptFile);
  if (!fs.existsSync(pfPath)) {
    console.error(`错误: 找不到任务文件: ${pfPath}`);
    process.exit(2);
  }
  const fileText = fs.readFileSync(pfPath, 'utf8').replace(/^\uFEFF/, '').trim();
  if (fileText) promptSections.push(fileText);
}
if (opts.useStdin) {
  try {
    const stdinText = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '').trim();
    if (stdinText) promptSections.push(stdinText);
  } catch {}
}
const cliText = opts.promptParts.join(' ').trim();
if (cliText) {
  promptSections.push(cliText);
}

const rawPrompt = promptSections.join('\n\n').trim();
if (!opts.review && !rawPrompt) {
  console.error('错误: 请提供任务说明（命令行参数、--prompt-file 或 --stdin），或使用 --review 启动代码审查。');
  printHelp();
  process.exit(2);
}

const isWin = process.platform === 'win32';
const targetDir = path.resolve(opts.cd);
const effectiveSandbox = opts.sandbox || (isWin ? 'danger-full-access' : 'workspace-write');

let finalPrompt = '';
const args = ['exec'];

// 不使用双引号的裸字符串字面量，规避 Windows cmd.exe 引号剥离
const commonConfigArgs = ['-c', `model_reasoning_effort=${opts.effort}`];
if (isWin && (opts.review || effectiveSandbox !== 'danger-full-access')) {
  commonConfigArgs.push('-c', 'windows.sandbox=unelevated');
}
if (opts.skipGitRepoCheck) {
  commonConfigArgs.push('--skip-git-repo-check');
}
if (opts.ephemeral) {
  commonConfigArgs.push('--ephemeral');
}

if (opts.review) {
  args.push('review', ...commonConfigArgs);
  if (opts.model) args.push('-m', opts.model);
  if (opts.base) {
    args.push('--base', opts.base);
  } else {
    args.push('--uncommitted');
  }
  finalPrompt = [
    '请按以下两级标准输出简体中文代码审查结论（禁止修改文件、禁止 git push）：',
    '【阻塞级】仅限：算错钱/数据损坏丢失/越权鉴权漏洞/对外误发消息/导致上线或构建必挂的问题，且必须写明具体触发路径与文件行号；无则写「无」。',
    '【建议级】其余边界优化、代码风格或极低概率隐患，简明列出供参考但不阻塞合并。',
    rawPrompt ? `\n补充审查要求：\n${rawPrompt}` : ''
  ].join('\n');
  args.push('-');
} else if (opts.resume) {
  args.push('resume', opts.resume, '-s', effectiveSandbox, ...commonConfigArgs);
  if (opts.model) args.push('-m', opts.model);
  finalPrompt = rawPrompt;
  args.push('-');
} else {
  args.push('-C', targetDir, '-s', effectiveSandbox, ...commonConfigArgs);
  if (opts.model) args.push('-m', opts.model);
  finalPrompt = [
    '【受限工作区任务边界】',
    `- 仅在当前指定目录 (${targetDir}) 内完成任务，严格遵守给定接口与验收标准。`,
    '- 禁止私自安装/升级全局依赖，禁止执行 git push 或对外发布操作，禁止读取无关凭据。',
    '- 完成后清晰汇报：修改文件清单、核心变更摘要、本地验证命令及实测结果。',
    '',
    rawPrompt
  ].join('\n');
  args.push('-');
}

const res = spawnSync(
  isWin ? 'cmd.exe' : 'codex',
  isWin ? ['/d', '/s', '/c', 'codex.cmd', ...args] : args,
  {
    cwd: targetDir,
    input: finalPrompt,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit']
  }
);

if (res.error) {
  console.error('[codex-worker] 启动失败:', res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 0);
