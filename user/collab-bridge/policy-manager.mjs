#!/usr/bin/env node
/**
 * 跨平台 ~/.gemini/GEMINI.md 策略与协同模式原子切换管理器 (policy-manager.mjs)
 * 支持 Windows / macOS / Linux，所有路径基于 os.homedir() 动态解析：
 *   - gemini : 原版 Gemini 4 Operating Policy + 锁模规则 + 当前模式(A/B)协同规范
 *   - opus   : Anthropic/opus v2.md + 锁模规则 + 当前模式(A/B)协同规范
 *   - sonnet : Anthropic/Sonnet v2.md + 锁模规则 + 当前模式(A/B)协同规范
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HOME_DIR = os.homedir();
export const GEMINI_ROOT = path.join(HOME_DIR, '.gemini');
export const GEMINI_MD_PATH = path.join(GEMINI_ROOT, 'GEMINI.md');
export const STATE_PATH = path.join(__dirname, 'state.json');
export const POLICIES_DIR = path.join(__dirname, 'policies');
export const BIN_DIR = path.join(__dirname, 'bin');

const IS_WIN = process.platform === 'win32';
export const CODEX_WORKER_CMD = path.join(BIN_DIR, IS_WIN ? 'codex-worker.cmd' : 'codex-worker');
export const AGY_ASK_CMD = path.join(BIN_DIR, IS_WIN ? 'agy-ask.cmd' : 'agy-ask');

const VALID_POLICIES = new Set(['gemini', 'opus', 'sonnet']);

export function normalizePolicyName(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'opus' || s === 'opus-v2' || s === 'opus_v2') return 'opus';
  if (s === 'sonnet' || s === 'sonnet-v2' || s === 'sonnet_v2') return 'sonnet';
  if (s === 'gemini') return 'gemini';
  return '';
}

export function detectPolicyFromModelName(modelName) {
  const m = String(modelName || '').trim().toLowerCase();
  if (!m) return '';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet') || m.includes('claude')) return 'sonnet';
  if (m.includes('gemini')) return 'gemini';
  return '';
}

export function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return {
        mode: 'A',
        policy: 'gemini',
        policyLockUntil: 0,
        updatedAt: new Date().toISOString(),
        source: 'default'
      };
    }
    const raw = fs.readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    const mode = parsed?.mode === 'B' ? 'B' : 'A';
    const policy = VALID_POLICIES.has(parsed?.policy) ? parsed.policy : mode === 'B' ? 'opus' : 'gemini';
    const policyLockUntil = Number.isFinite(parsed?.policyLockUntil) ? parsed.policyLockUntil : 0;
    return {
      mode,
      policy,
      policyLockUntil,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      source: typeof parsed?.source === 'string' ? parsed.source : 'disk'
    };
  } catch {
    return {
      mode: 'A',
      policy: 'gemini',
      policyLockUntil: 0,
      updatedAt: new Date().toISOString(),
      source: 'fallback'
    };
  }
}

export function writeStateAtomic(patch = {}) {
  const cur = readState();
  const nextMode = patch.mode === 'B' ? 'B' : patch.mode === 'A' ? 'A' : cur.mode;
  const normPol = normalizePolicyName(patch.policy);
  const nextPolicy = normPol || cur.policy || (nextMode === 'B' ? 'opus' : 'gemini');
  const nextLockUntil =
    typeof patch.policyLockUntil === 'number' ? patch.policyLockUntil : cur.policyLockUntil || 0;

  const next = {
    mode: nextMode,
    policy: nextPolicy,
    policyLockUntil: nextLockUntil,
    updatedAt: new Date().toISOString(),
    source: String(patch.source || cur.source || 'api').slice(0, 64)
  };
  const tmpPath = path.join(__dirname, `state.json.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, STATE_PATH);
  return next;
}

/**
 * 构建当前模式 (A/B) 对应的三模型协同章节，直接嵌入 GEMINI.md 底部，静默生效且不污染对话气泡
 */
export function buildCollabModeSection(mode, policy) {
  if (mode === 'B') {
    return [
      `## 三模型协同当前模式：模式 B（全功率协同 | 策略: ${policy}）`,
      '',
      '1. **大方案双盲独立规划**：涉及架构设计或复杂改造时，主控先独立规划，同时后台调用只读顾问（或跨模型独立会话）仅凭用户原话与必要背景出第二份方案，交叉核验后合并交用户拍板：',
      `   - 只读顾问命令：\`${AGY_ASK_CMD} --dir "<工作目录>" --prompt-file "<需求文件>"\`（短文本可直接传参，长/多行务必用 \`--prompt-file\`）`,
      '   - 前端界面文案与交互初版完成后，可加 `--copy` 请 Gemini 润色，核实无误后采纳。',
      '2. **前端视觉/动效与架构二审（自动+手动兼顾）**：',
      '   - 若当前主会话为 Gemini：高审美前端 UI、视觉动效及关键架构二审，按上方真实锁模规则通过 `swarm` 精确拉起 `opus-worker`（`claude-opus-5-5-high`，精准传路径与边界，短上下文用完即休眠或清理）。',
      '   - 若当前主会话已手动切至 Claude / Orchestrator(Opus)：由 Claude 直接主笔前端视觉与总控验收。',
      '3. **成块后端与两级代码审查门禁**：',
      `   - 接口已定死的独立后端/算法/数据处理模块及合并前两级审查（仅算错钱/丢数据/越权/破坏上线且能说明触发路径为阻塞级，最多 2 轮），派本机 Codex：\`${CODEX_WORKER_CMD} --cd "<工作目录>" --prompt-file "<任务文件>"\`（长/多行任务用 \`--prompt-file\` 防截断；审查传 \`--review\`）。`,
      '4. **改全与机械护栏**：纠正过一次或审查退回的问题，优先在同一提交内固化为类型检查、守卫测试或目录结构约束；交付前全局核实同类入口与真实运行结果。'
    ].join('\n');
  }

  return [
    `## 三模型协同当前模式：模式 A（日常省额默认 | 策略: ${policy}）`,
    '',
    '1. **日常总控与省额原则**：当前主会话负责需求沟通、代码探索、文案交互与普通改动；严格保护 Claude 独立配额，除非用户明确点名或遇到高审美前端视觉/动效任务，否则不主动拉起 Opus/Sonnet。',
    '2. **成块后端与两级代码审查外包 Codex**：',
    `   - 接口已定死的独立后端/算法/数据处理/复杂排障及合并前代码审查（按阻塞级与建议级两级输出，最多 2 轮），优先派本机 Codex 执行：\`${CODEX_WORKER_CMD} --cd "<工作目录>" "<任务>"\`（长/多行任务用 \`--prompt-file <文件>\` 防截断；审查传 \`--review\`）。`,
    '3. **核实与防幻觉**：所有结论、符号名、路径与线上状态必须以工具实测输出为准，严禁猜测；交付前核实同类入口改全。'
  ].join('\n');
}

/**
 * 组装指定策略与模式对应的 GEMINI.md 完整文本，并在内容变化时原子替换 ~/.gemini/GEMINI.md
 */
export function applyPolicyToGeminiMd(targetPolicy, options = {}) {
  const cur = readState();
  const policy = normalizePolicyName(targetPolicy) || cur.policy || 'gemini';
  const mode = options.mode === 'B' ? 'B' : options.mode === 'A' ? 'A' : cur.mode;
  const policyFile = path.join(POLICIES_DIR, `${policy}.md`);
  const footerFile = path.join(POLICIES_DIR, 'common-footer.md');

  if (!fs.existsSync(policyFile) || !fs.existsSync(footerFile)) {
    return { switched: false, policy, mode, error: 'policy template missing' };
  }

  const bodyText = fs.readFileSync(policyFile, 'utf8').replace(/\r\n/g, '\n').trim();
  const footerText = fs.readFileSync(footerFile, 'utf8').replace(/\r\n/g, '\n').trim();
  const modeSection = buildCollabModeSection(mode, policy);
  const expectedContent = `${bodyText}\n\n\n${footerText}\n\n${modeSection}\n`;

  let currentContent = '';
  try {
    if (fs.existsSync(GEMINI_MD_PATH)) {
      currentContent = fs.readFileSync(GEMINI_MD_PATH, 'utf8').replace(/\r\n/g, '\n');
    }
  } catch {}

  let fileWritten = false;
  if (currentContent !== expectedContent) {
    fs.mkdirSync(path.dirname(GEMINI_MD_PATH), { recursive: true });
    const tmpMd = `${GEMINI_MD_PATH}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpMd, expectedContent, 'utf8');
    fs.renameSync(tmpMd, GEMINI_MD_PATH);
    fileWritten = true;
  }

  const statePatch = {
    mode,
    policy,
    source: options.source || `policy:${policy}`
  };
  if (typeof options.lockMs === 'number') {
    statePatch.policyLockUntil = options.lockMs > 0 ? Date.now() + options.lockMs : 0;
  }
  const savedState = writeStateAtomic(statePatch);
  return { switched: fileWritten, policy, mode, state: savedState };
}
