#!/usr/bin/env node
/**
 * 跨平台受限 Codex 派活与两级代码审查封装 (bin/codex-worker.mjs)
 * 支持 Windows / macOS / Linux，强制使用 workspace-write 沙箱；
 * Windows 下自动强制覆盖 windows.sandbox=unelevated，避免在 Antigravity 嵌套终端沙箱中触发
 * elevated helper 的 "setup refresh had errors" 导致所有子命令 exited -1。
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';

function printHelp() {
  console.log(`用法:
  codex-worker --cd <工作目录> [--model <模型>] [--effort low|medium|high|xhigh] [--resume <会话ID>] [--skip-git-repo-check] [--ephemeral] "<任务说明>"
  codex-worker --review --cd <工作目录> [--base <分支>] [--model <模型>] [--effort low|medium|high|xhigh] ["<补充审查要求>"]

说明:
  - 强制 -s workspace-write 沙箱，禁用越权免审批参数。
  - Windows 自动追加 -c windows.sandbox=unelevated，规避嵌套沙箱下 setup refresh 失败。
  - 默认推理档位 high；涉及资金/权限/登录/对外发送时显式传 --effort xhigh。
  - --review 模式强制输出「阻塞级 (P0)」与「建议级 (P1)」两级审查清单。`);
}

function parseArgs(argv) {
  const opts = {
    review: false,
    cd: process.cwd(),
    model: '',
    effort: 'high',
    resume: '',
    base: '',
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
    } else if (a === '--resume') {
      opts.resume = argv[++i] || '';
    } else if (a === '--base') {
      opts.base = argv[++i] || '';
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

const rawPrompt = opts.promptParts.join(' ').trim();
if (!opts.review && !rawPrompt) {
  console.error('错误: 请提供任务说明，或使用 --review 启动代码审查。');
  printHelp();
  process.exit(2);
}

const isWin = process.platform === 'win32';
const targetDir = path.resolve(opts.cd);
let finalPrompt = '';
const args = ['exec'];

// 不使用双引号的裸字符串字面量，规避 Windows cmd.exe 引号剥离
const commonConfigArgs = ['-c', `model_reasoning_effort=${opts.effort}`];
if (isWin) {
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
  args.push('resume', opts.resume, '-s', 'workspace-write', ...commonConfigArgs);
  if (opts.model) args.push('-m', opts.model);
  finalPrompt = rawPrompt;
  args.push('-');
} else {
  args.push('-C', targetDir, '-s', 'workspace-write', ...commonConfigArgs);
  if (opts.model) args.push('-m', opts.model);
  finalPrompt = [
    '【受限工作区任务边界】',
    '- 仅在当前指定目录内完成任务，严格遵守给定接口与验收标准。',
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
