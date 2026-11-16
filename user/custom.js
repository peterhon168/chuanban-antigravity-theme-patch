/**
 * user/custom.js — 「完成了么」真实会话进度监控与防卡死自愈 HUD (支持 Swarm 多智能体矩阵 & 子代理协作)
 * 直接接入：
 *   1. Antigravity 真实会话 DOM ([data-testid="conversation-view"], [data-testid="idle-status-text"])
 *   2. Native Swarm Board Sidecar 实时 API (plugin://swarm--swarm_board-<port>/api/swarm)
 *   3. SQLite 实时遥测 (window.__ag_last_metrics) + 后台并发会话一键跳转
 */

(function initRealAntigravityWatchdog() {
  // 0. 热重载幂等清理（同时强制清除早期残留的旧版模拟器 DOM 与定时器）
  if (typeof window.__ag_watchdog_cleanup === 'function') {
    try {
      window.__ag_watchdog_cleanup();
    } catch (e) {}
  }
  if (window.__ag_watchdog_timer) {
    try {
      clearInterval(window.__ag_watchdog_timer);
    } catch (e) {}
    window.__ag_watchdog_timer = null;
  }
  if (window.__ag_watchdog_obs) {
    try {
      window.__ag_watchdog_obs.disconnect();
    } catch (e) {}
    window.__ag_watchdog_obs = null;
  }
  document
    .querySelectorAll('#ag-watchdog-hud, #ag-watchdog-dock-pill, #ag-watchdog-reopen-btn')
    .forEach((el) => el.remove());

  const STORAGE_POS_KEY = 'ag_wd_real_pos_v2';
  const STORAGE_CFG_KEY = 'ag_wd_real_cfg_v2';
  const STORAGE_SWARM_ORIGIN_KEY = 'ag_wd_swarm_origin_v1';
  const TIMEOUT_OPTIONS = [60, 120, 180, 300];

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function loadJson(storage, key, fallback) {
    try {
      const raw = storage.getItem(key);
      return raw ? Object.assign({}, fallback, JSON.parse(raw)) : Object.assign({}, fallback);
    } catch {
      return Object.assign({}, fallback);
    }
  }

  function saveJson(storage, key, val) {
    try {
      storage.setItem(key, JSON.stringify(val));
    } catch {}
  }

  const cfg = loadJson(localStorage, STORAGE_CFG_KEY, {
    collapsed: false,
    minimized: false,
    hidden: false,
    timeoutSec: 120,
    autoHeal: false
  });

  // ============================================================================
  // 1. Swarm Sidecar Origin 自动发现与实时轮询 (/api/swarm)
  // ============================================================================
  const swarmStateMap = new Map(); // cid -> { hasSwarm, etag, snap, lastPollTs, uiSig, bizSig }
  let cachedSwarmOrigin = '';
  try {
    cachedSwarmOrigin = localStorage.getItem(STORAGE_SWARM_ORIGIN_KEY) || '';
  } catch {}

  function isSwarmSystemMember(m) {
    return Boolean(
      m &&
        (m.roleWorker ||
          m.narrator ||
          m.role === 'monitor' ||
          m.role === 'narrator' ||
          /^(?:monitor|narrator)(?:-\d+)?$/i.test(m.name || ''))
    );
  }

  function isSwarmSystemAgentName(name, members) {
    const n = String(name || '').trim();
    if (!n) return false;
    if (/^(?:monitor|narrator)(?:-\d+)?$/i.test(n)) return true;
    if (Array.isArray(members)) {
      const matched = members.find((m) => m && m.name === n);
      if (matched) return isSwarmSystemMember(matched);
    }
    return false;
  }

  // 深度分析 Swarm 健康度：识别 @monitor [stall] 未解除、全员 waiting 静默死锁与精准点名踢起话术
  function analyzeSwarmHealth(swarmSnap, now, timeoutSec = 120) {
    const empty = {
      liveMembers: [],
      coordMember: null,
      bizWorkers: [],
      workingBizWorkers: [],
      workingBizMembers: [],
      swarmMessages: [],
      lastBoardMsg: null,
      lastCoordDispatchSeq: 0,
      boardMarkedDone: false,
      coordQuotaBlocked: false,
      unresolvedStallPost: null,
      swarmDeadlocked: false,
      deadlockReason: '',
      kickPrompt: ''
    };
    if (!swarmSnap || !Array.isArray(swarmSnap.members)) return empty;

    const liveMembers = swarmSnap.members.filter((m) => m && !m.killed);
    const coordMember = liveMembers.find((m) => m.role === 'coordinator' || m.name === 'coordinator') || null;
    const bizWorkers = liveMembers.filter(
      (m) => m.role !== 'coordinator' && m.name !== 'coordinator' && !isSwarmSystemMember(m)
    );
    const workingBizWorkers = bizWorkers.filter((m) => m.status === 'working');
    const workingBizMembers = (coordMember && coordMember.status === 'working' ? [coordMember] : []).concat(
      workingBizWorkers
    );

    const swarmMessages = Array.isArray(swarmSnap.messages) ? swarmSnap.messages : [];
    const lastBoardMsg = swarmMessages.length > 0 ? swarmMessages[swarmMessages.length - 1] : null;

    let lastCoordMsg = null;
    let lastCoordDispatchSeq = 0;
    for (let i = swarmMessages.length - 1; i >= 0; i--) {
      const msg = swarmMessages[i];
      if (!msg || msg.agent !== 'coordinator') continue;
      if (!lastCoordMsg) lastCoordMsg = msg;
      if (!/\[done\]/i.test(msg.text || '')) {
        lastCoordDispatchSeq = Number(msg.seq) || 0;
        break;
      }
    }
    const boardMarkedDone = !!(lastCoordMsg && /\[done\]/i.test(lastCoordMsg.text || ''));
    const coordQuotaBlocked = !!(coordMember && coordMember.failure && coordMember.failure.kind === 'quota');

    // 1. 检测最新的未解除 @monitor [stall] 告警
    let unresolvedStallPost = null;
    for (let i = swarmMessages.length - 1; i >= 0; i--) {
      const msg = swarmMessages[i];
      if (msg && /^monitor(?:-\d+)?$/i.test(msg.agent || '') && /\[stall\]/i.test(msg.text || '')) {
        const stallSeq = Number(msg.seq) || 0;
        let hasBizPostAfter = false;
        for (let j = i + 1; j < swarmMessages.length; j++) {
          const afterMsg = swarmMessages[j];
          if (
            afterMsg &&
            (Number(afterMsg.seq) || 0) > stallSeq &&
            !isSwarmSystemAgentName(afterMsg.agent, liveMembers)
          ) {
            hasBizPostAfter = true;
            break;
          }
        }
        if (!boardMarkedDone && !hasBizPostAfter) {
          unresolvedStallPost = msg;
        }
        break;
      }
    }

    let swarmDeadlocked = false;
    let deadlockReason = '';

    if (unresolvedStallPost) {
      const stallSeq = Number(unresolvedStallPost.seq) || '';
      if (!coordMember || coordMember.status !== 'working') {
        const stallElapsedMs = unresolvedStallPost.ts
          ? Math.max(0, now - Number(unresolvedStallPost.ts))
          : 16000;
        if (stallElapsedMs >= 15000) {
          swarmDeadlocked = true;
          deadlockReason = `看板 #${stallSeq} 已报 [stall] 停滞，全员待命未响应`;
        }
      } else {
        const coordIdleSec = coordMember.transcriptMtime
          ? Math.max(0, Math.floor((now - Number(coordMember.transcriptMtime)) / 1000))
          : 0;
        if (coordIdleSec >= Math.min(timeoutSec, 90)) {
          swarmDeadlocked = true;
          deadlockReason = `看板 #${stallSeq} [stall] 后 @coordinator 已 ${coordIdleSec}s 无响应`;
        }
      }
    }

    // 2. 无 @monitor [stall] 时检测全员 waiting 静默死锁（如重启后 monitor 停止或主代理睡死）
    if (!swarmDeadlocked && !boardMarkedDone && bizWorkers.length > 0 && workingBizMembers.length === 0) {
      let latestBizMtime = coordMember ? Number(coordMember.transcriptMtime || 0) : 0;
      let maxWorkerPostSeq = 0;
      let failedWorker = null;
      for (let i = 0; i < bizWorkers.length; i++) {
        const w = bizWorkers[i];
        const mt = Number(w.transcriptMtime || 0);
        if (mt > latestBizMtime) latestBizMtime = mt;
        const lp = Number(w.lastPostSeq) || 0;
        if (lp > maxWorkerPostSeq) maxWorkerPostSeq = lp;
        if (!failedWorker && w.failure && lp <= lastCoordDispatchSeq) {
          failedWorker = w;
        }
      }
      const refTs = latestBizMtime > 0 ? latestBizMtime : lastBoardMsg && lastBoardMsg.ts ? Number(lastBoardMsg.ts) : 0;
      const allQuietSec = refTs > 0 ? Math.max(0, Math.floor((now - refTs) / 1000)) : 0;
      const coordReadSeq = coordMember ? Number(coordMember.last_read_seq) || 0 : 0;

      if (failedWorker && allQuietSec >= 20) {
        swarmDeadlocked = true;
        deadlockReason = `@${failedWorker.name} ${
          failedWorker.failure.kind === 'quota' ? '配额受限' : '异常停止'
        }，待主代理切模或重派`;
      } else if (maxWorkerPostSeq > coordReadSeq && allQuietSec >= 25) {
        swarmDeadlocked = true;
        deadlockReason = `看板 #${maxWorkerPostSeq} 回传未读且全员待命`;
      } else if (coordMember && !coordMember.replied && allQuietSec >= 25) {
        swarmDeadlocked = true;
        deadlockReason = '全员已退回 waiting 等待看板且未结项';
      }
    }

    let kickPrompt = '';
    if (swarmDeadlocked) {
      const waitingNames = bizWorkers
        .filter((w) => w.status !== 'working')
        .map((w) => '@' + w.name)
        .join(', ');
      const quotaWorkers = bizWorkers.filter((w) => w.failure && w.failure.kind === 'quota');
      const quotaHint =
        quotaWorkers.length > 0
          ? `；配额受限节点：${quotaWorkers.map((w) => '@' + w.name).join(', ')}`
          : '';
      kickPrompt = `继续：监控检测到 Swarm 停滞（${deadlockReason}；当前待命业务节点：${
        waitingNames || '请核查成员列表'
      }${quotaHint}）。请立即执行 read_board 与 swarm status 核查进度，对静默停在 waiting 或未完结的节点直接发帖 @点名派发下一步指令（若节点配额/异常请切模或重开），切勿在全员 waiting 时空等。`;
    }

    return {
      liveMembers,
      coordMember,
      bizWorkers,
      workingBizWorkers,
      workingBizMembers,
      swarmMessages,
      lastBoardMsg,
      lastCoordDispatchSeq,
      boardMarkedDone,
      coordQuotaBlocked,
      unresolvedStallPost,
      swarmDeadlocked,
      deadlockReason,
      kickPrompt
    };
  }

  function recordSwarmOrigin(rawUrlOrAuth) {
    const s = String(rawUrlOrAuth || '').trim();
    if (!s) return;
    let origin = '';
    const m1 = s.match(/^(plugin:\/\/swarm--swarm_board-[0-9a-z_-]+)/i);
    if (m1) {
      origin = m1[1];
    } else if (/^swarm--swarm_board-[0-9a-z_-]+$/i.test(s)) {
      origin = 'plugin://' + s;
    }
    if (origin && origin !== cachedSwarmOrigin) {
      cachedSwarmOrigin = origin;
      try {
        localStorage.setItem(STORAGE_SWARM_ORIGIN_KEY, origin);
      } catch {}
    }
  }

  // 拦截 window.extensions.sendAuthorities，即使尚未点开 Swarm 看板也能第一时间获知 plugin:// 域名
  if (window.extensions && typeof window.extensions.sendAuthorities === 'function' && !window.extensions.sendAuthorities.__ag_wd_wrapped) {
    const origSendAuth = window.extensions.sendAuthorities;
    const wrappedSendAuth = function (authMap) {
      try {
        if (authMap && typeof authMap === 'object') {
          for (const k of Object.keys(authMap)) {
            if (k.startsWith('swarm--swarm_board')) {
              recordSwarmOrigin(k);
            }
          }
        }
      } catch {}
      return origSendAuth.apply(this, arguments);
    };
    wrappedSendAuth.__ag_wd_wrapped = true;
    wrappedSendAuth.__ag_wd_orig = origSendAuth;
    window.extensions.sendAuthorities = wrappedSendAuth;
  }

  function discoverSwarmOriginFromDom() {
    const iframes = document.querySelectorAll('iframe[src*="swarm--swarm_board"]');
    for (let i = 0; i < iframes.length; i++) {
      const src = iframes[i].getAttribute('src') || iframes[i].src || '';
      if (src) {
        recordSwarmOrigin(src);
        break;
      }
    }
    return cachedSwarmOrigin;
  }

  let isPollingSwarm = false;
  async function pollSwarmForConversation(cid, force = false) {
    if (!cid || isPollingSwarm) return;
    const origin = discoverSwarmOriginFromDom();
    if (!origin) return;

    let entry = swarmStateMap.get(cid);
    if (!entry) {
      entry = { hasSwarm: false, etag: '', snap: null, lastPollTs: 0, uiSig: '', bizSig: '' };
      swarmStateMap.set(cid, entry);
    }

    const now = Date.now();
    const minInterval = entry.hasSwarm ? 1400 : 3200;
    if (!force && now - entry.lastPollTs < minInterval) return;
    entry.lastPollTs = now;
    isPollingSwarm = true;

    try {
      const q = new URLSearchParams();
      q.set('conversationId', cid);
      if (entry.etag) q.set('etag', entry.etag);
      const res = await fetch(`${origin}/api/swarm?${q.toString()}`, { method: 'GET' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.swarm) {
        entry.hasSwarm = false;
        entry.snap = null;
        entry.etag = '';
        entry.uiSig = '';
        entry.bizSig = '';
        return;
      }
      entry.hasSwarm = true;
      if (!data.unchanged && Array.isArray(data.members)) {
        entry.etag = data.etag || '';
        entry.snap = data;
        // 计算全 Swarm 业务节点活跃度签名（严格排除 monitor/narrator 等系统观察员，防止 [stall] 发帖反置心跳）
        const memberSig = data.members
          .filter((m) => !isSwarmSystemMember(m))
          .map(
            (m) =>
              `${m.name}:${m.status}:${m.steps || 0}:${Math.round((m.transcriptMtime || 0) / 500)}:${m.lastPostSeq || 0}:${m.activity || ''}`
          )
          .join('|');
        const msgs = Array.isArray(data.messages) ? data.messages : [];
        const bizMsgCount = msgs.filter((msg) => !isSwarmSystemAgentName(msg && msg.agent, data.members)).length;
        entry.uiSig = `${data.etag || ''}|${msgs.length}|${memberSig}`;
        entry.bizSig = `${bizMsgCount}|${memberSig}`;
      }
    } catch {
      // plugin 端口变更或未就绪时静默忽略
    } finally {
      isPollingSwarm = false;
    }
  }

  // 一键打开或聚焦当前对话的 Swarm 看板
  function openSwarmBoardUI() {
    const view = document.querySelector('[data-testid="conversation-view"]');
    if (view) {
      const btns = view.querySelectorAll('button, a, [role="button"]');
      for (let i = btns.length - 1; i >= 0; i--) {
        const txt = (btns[i].textContent || '').trim();
        if (/Open the Swarm UI|打开\s*Swarm/i.test(txt)) {
          btns[i].click();
          return true;
        }
      }
    }
    // 兜底：若顶栏有 Swarm 标签页则点击激活
    const tabs = document.querySelectorAll('[role="tab"], button');
    for (let i = 0; i < tabs.length; i++) {
      const t = (tabs[i].textContent || '').trim();
      if (/^Swarm\b/i.test(t)) {
        tabs[i].click();
        return true;
      }
    }
    return false;
  }

  // 一键聚焦内置浏览器操控页面 / 标签页
  function openBrowserPaneUI() {
    const fav = document.querySelector('[data-testid="browser-tab-favicon-agent"]');
    const tabBtn = fav ? fav.closest('button, [role="tab"]') : null;
    if (tabBtn) {
      tabBtn.click();
      return true;
    }
    const view = document.querySelector('[data-testid="conversation-view"]');
    if (view) {
      const idleEls = view.querySelectorAll('[data-testid="idle-status-text"]');
      const lastIdle = idleEls.length > 0 ? idleEls[idleEls.length - 1] : null;
      if (
        lastIdle &&
        (lastIdle.querySelector('[data-testid^="idle-status-browser"]') ||
          /Using\s+browser|正在使用浏览器|使用浏览器/i.test(lastIdle.textContent || ''))
      ) {
        lastIdle.click();
        return true;
      }
    }
    return false;
  }

  // 读取底部「排队消息 (Queued Messages)」数量与立即发送按钮
  function getQueuedMessagesCount() {
    try {
      const card = document.querySelector('[data-testid="queued-messages-card"]');
      if (!card || card.offsetParent === null) return 0;
      const badge = card.querySelector('.rounded-full');
      if (badge) {
        const n = parseInt((badge.textContent || '').trim(), 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return 1;
    } catch {
      return 0;
    }
  }

  function findQueuedSendNowBtn() {
    try {
      const decs = document.querySelectorAll('[data-testid="queued-decorators"] button');
      for (let i = 0; i < decs.length; i++) {
        const b = decs[i];
        if (b.disabled) continue;
        const a = b.getAttribute('aria-label') || '';
        const orig = b.getAttribute('data-ag-orig-aria-label') || '';
        if (/^Send\s*now\b|立即发送/i.test(orig) || /^Send\s*now\b|立即发送/i.test(a)) {
          return b;
        }
      }
    } catch {}
    return null;
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    try {
      const r = el.getBoundingClientRect();
      return !!(r && r.width > 0 && r.height > 0);
    } catch {
      return false;
    }
  }

  function extractCleanElementText(el, maxLen = 56) {
    if (!el) return '';
    try {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.sr-only, style, script').forEach((n) => n.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
    } catch {
      return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
    }
  }

  // 统一检测等待人工回答/审批的交互门禁（覆盖输入框上方 interaction-takeover-card 与全局权限弹窗）
  function detectUserInteractionGate(view, lastResp, isRunning, domSubagentsBlocked, isApprovalStatus) {
    const empty = { active: false, kind: '', title: '', progress: '', targetEl: null };
    const isMainDialogNode = (el) => !!(el && !(el.closest && el.closest('[data-testid^="side-question-"]')));

    // 1. 优先检测主对话输入框上方接管卡片 (ask_question / 权限请求 p1c / 子代理授权 z1c)
    const takeoverCards = document.querySelectorAll('[data-testid="interaction-takeover-card"]');
    for (let i = 0; i < takeoverCards.length; i++) {
      const card = takeoverCards[i];
      if (!isMainDialogNode(card) || !isElementVisible(card)) continue;

      const headerEl = card.querySelector('[data-testid="ask-question-header-text"]');
      const sourceEl = card.querySelector('[data-testid="subagent-permission-source"]');
      const progressEl = card.querySelector('[data-testid="ask-question-progress"]');

      const headerTxt = extractCleanElementText(headerEl, 56);
      const sourceTxt = extractCleanElementText(sourceEl, 28);
      const title =
        sourceTxt && headerTxt
          ? `${sourceTxt} · ${headerTxt}`.slice(0, 56)
          : headerTxt || (sourceTxt ? `子代理权限: ${sourceTxt}`.slice(0, 56) : '');
      const progress = progressEl ? (progressEl.textContent || '').replace(/\s+/g, ' ').trim() : '';

      const isPermissionCard = !!card.querySelector(
        '[data-testid="permission-target-editor"], [data-testid="permission-app-header"], [data-testid="permission-download-details"], [data-testid="subagent-permission-source"]'
      );
      const isQuestionCard =
        !isPermissionCard &&
        !!card.querySelector(
          '[data-testid="ask-question-dismiss-button"], [data-testid="ask-question-collapse-button"], [data-testid="interaction-skip-button"], [data-testid="ask-question-writein"], [data-testid="ask-question-option"]'
        );

      return {
        active: true,
        kind: isPermissionCard ? 'approval' : isQuestionCard ? 'question' : 'approval',
        title,
        progress,
        targetEl: card
      };
    }

    // 2. 检测全局及内置浏览器/终端阻塞弹窗（排除侧边栏 side-question）
    const globalBlockingRules = [
      ['[data-testid="declared-permissions-modal"]', '插件与声明权限确认'],
      ['[data-testid="computer-permissions-card"]', '系统辅助/屏幕权限授权'],
      ['[data-testid="new-sidecar-oauth-consent-prompt"]', 'OAuth 账号授权确认'],
      ['[data-testid="terminal-password-prompt-blocked"], [data-testid="terminal-allow-non-corp-password"]', '终端密码输入确认'],
      ['[data-testid="webview-prompt-card"], [data-testid="browser-cert-proceed-button"]', '内置浏览器弹窗/证书确认'],
      ['[data-testid="subagent-approve"]', '子代理操作权限审批']
    ];
    for (let i = 0; i < globalBlockingRules.length; i++) {
      const [selector, modalTitle] = globalBlockingRules[i];
      const matches = document.querySelectorAll(selector);
      for (let j = 0; j < matches.length; j++) {
        const node = matches[j];
        if (isMainDialogNode(node) && isElementVisible(node)) {
          return {
            active: true,
            kind: 'approval',
            title: modalTitle,
            progress: '',
            targetEl: node
          };
        }
      }
    }

    // 3. 兼容 idle-status-text 子代理阻塞标记
    if (domSubagentsBlocked > 0 || isApprovalStatus) {
      return {
        active: true,
        kind: 'approval',
        title: '子代理等待人工审批授权',
        progress: '',
        targetEl: null
      };
    }

    // 4. 兼容回复内联确认执行按钮
    if (isRunning && lastResp) {
      const respBtns = lastResp.querySelectorAll('button');
      for (let i = 0; i < respBtns.length; i++) {
        const btn = respBtns[i];
        if (!isElementVisible(btn)) continue;
        const bTxt = (btn.textContent || '').trim();
        const bOrig = btn.getAttribute('data-ag-orig-aria-label') || '';
        if (/^(?:确认执行|Proceed|允许|Allow|Approve|批准)$/i.test(bTxt) || /\b(?:Proceed|Allow|Approve)\b/i.test(bOrig)) {
          return {
            active: true,
            kind: 'approval',
            title: '步骤执行确认',
            progress: '',
            targetEl: btn
          };
        }
      }
    }

    return empty;
  }

  // 安全聚焦到待答题或待审批卡片（仅滚动与聚焦，绝不替用户提交或取消）
  function focusUserGateUI() {
    const view = document.querySelector('[data-testid="conversation-view"]');
    const agentResps = view ? view.querySelectorAll('[data-testid="agent-response"]') : null;
    const lastResp = agentResps && agentResps.length > 0 ? agentResps[agentResps.length - 1] : null;
    const gate = detectUserInteractionGate(view, lastResp, true, 0, false);
    if (!gate.active || !gate.targetEl) return false;
    try {
      if (typeof gate.targetEl.scrollIntoView === 'function') {
        gate.targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      const focusTarget = gate.targetEl.matches(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
        ? gate.targetEl
        : gate.targetEl.querySelector(
            '[data-testid="ask-question-option"], [data-testid="ask-question-writein"], [data-testid="permission-target-editor"], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          );
      if (focusTarget && typeof focusTarget.focus === 'function') {
        focusTarget.focus({ preventScroll: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  function buildUserGateRow(gate) {
    const isQ = gate && gate.kind === 'question';
    return {
      icon: isQ ? '💬' : '🛡️',
      spin: false,
      title: isQ
        ? `💬 等待您作答: ${(gate && gate.title) || '选择题 / 问答交互'}`
        : `🛡️ 等待您审批: ${(gate && gate.title) || '权限授权确认'}`,
      status: isQ ? (gate && gate.progress ? `进度 ${gate.progress}` : '待选择') : '待授权',
      right: isQ ? '去答题' : '去处理',
      color: '#fbbf24',
      focusGate: true
    };
  }

  function formatUserGateDisplay(gate) {
    const isQ = gate && gate.kind === 'question';
    if (isQ) {
      return {
        stateLabel: gate && gate.progress ? `💬 待答题 (${gate.progress})` : '💬 待您选择',
        subtitle: gate && gate.title ? `💬 请在输入框上方答题: ${gate.title}` : '💬 智能体正在等待您完成选择题 / 问答'
      };
    }
    return {
      stateLabel: '⏳ 待您审批',
      subtitle: gate && gate.title ? `⏸ 待您审批授权: ${gate.title}` : '⏸ 智能体正在等待您点击「允许 / 批准」'
    };
  }

  // 跨会话路由无刷跳转（直接触发侧边栏行内真实的 TanStack Router <a href="/c/..."> 链接）
  function jumpToConversation(targetCid) {
    if (!targetCid) return;
    const link =
      document.querySelector(
        `[data-testid="conversation-row-sidebar"][data-cascade-id="${targetCid}"] a[href*="${targetCid}"]`
      ) ||
      document.querySelector(
        `[data-testid="conversation-row-sidebar"][data-cascade-id="${targetCid}"] a[href^="/c/"]`
      ) ||
      document.querySelector(`a[href^="/c/${targetCid}"]`);

    if (link) {
      link.click();
      return;
    }

    try {
      const nextPath = `/c/${targetCid}${window.location.search || ''}`;
      window.history.pushState(window.history.state, '', nextPath);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch {}
  }

  // 每个会话独立的实时步骤记录表
  const turnStoreMap = new Map();

  function getCascadeId() {
    try {
      const m = window.location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
      if (m) return m[1];
      const q = new URLSearchParams(window.location.search).get('cascadeId');
      if (q && /^[0-9a-f-]{36}$/i.test(q)) return q;
      const sel = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
      if (sel) {
        const cid = sel.getAttribute('data-cascade-id');
        if (cid && /^[0-9a-f-]{36}$/i.test(cid)) return cid;
      }
    } catch {}
    return '';
  }

  // 清洗历史缓存步骤（合并每秒思考计时与通用容器兜底项，热重载立即生效）
  const RE_THINKING_LIVE =
    /^(?:Thinking(?:\s+for\s+[<0-9smhd\s]+|\s*\([<0-9smhd\s]+\))?[….]*|正在思考(?:\s*[<0-9smhd\s()]+)?[….]*|模型深度思考中)$/i;

  function isGenericWrapperStep(title) {
    return title === '正在检索上下文…' || title === '正在探索代码库';
  }

  function sanitizeLoadedSteps(steps) {
    if (!Array.isArray(steps)) return [];
    const cleaned = [];
    for (let i = 0; i < steps.length; i++) {
      const rawStep = steps[i];
      if (!rawStep || typeof rawStep !== 'object') continue;
      let title = String(rawStep.title || '').trim();
      if (!title) continue;
      if (RE_THINKING_LIVE.test(title)) {
        title = '模型深度思考中';
      } else if (title === '正在探索代码库') {
        if (cleaned.length > 0) {
          continue;
        }
        title = '检索上下文与工具调用';
      }
      const prev = cleaned.length > 0 ? cleaned[cleaned.length - 1] : null;
      if (title === '模型深度思考中' && prev && prev.title === '模型深度思考中') {
        prev.startedAt = Math.min(prev.startedAt || Date.now(), rawStep.startedAt || prev.startedAt || Date.now());
        prev.endedAt = rawStep.endedAt || prev.endedAt;
        prev.done = !!rawStep.done;
        continue;
      }
      cleaned.push(Object.assign({}, rawStep, { title }));
    }
    return cleaned;
  }

  function getTurnStore(cid) {
    const key = cid || '__global__';
    if (turnStoreMap.has(key)) return turnStoreMap.get(key);
    let initial = {
      cid: key,
      turnIdx: 0,
      sqlUserTurns: 0,
      lastPromptSig: '',
      turnStartedAt: Date.now(),
      lastActiveTs: Date.now(),
      lastStepText: '',
      lastProseLen: 0,
      lastDbSig: '',
      lastSwarmSig: '',
      lastBrowserSig: '',
      lastIdleStatusSig: '',
      wasRunning: false,
      noEffectStreak: 0,
      totalAutoHeals: 0,
      healBaselineSig: '',
      lastAutoHealSentTs: 0,
      steps: []
    };
    try {
      const cached = sessionStorage.getItem('ag_wd_turn_' + key);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.steps)) {
          parsed.steps = sanitizeLoadedSteps(parsed.steps);
          if (parsed.lastStepText === '正在探索代码库') {
            let fallbackTitle = '';
            for (let i = parsed.steps.length - 1; i >= 0; i--) {
              if (!isGenericWrapperStep(parsed.steps[i].title)) {
                fallbackTitle = parsed.steps[i].title;
                break;
              }
            }
            parsed.lastStepText = fallbackTitle;
          }
          initial = Object.assign(initial, parsed);
        }
      }
    } catch {}
    turnStoreMap.set(key, initial);
    return initial;
  }

  function persistTurnStore(store) {
    if (!store || !store.cid) return;
    try {
      sessionStorage.setItem(
        'ag_wd_turn_' + store.cid,
        JSON.stringify({
          cid: store.cid,
          turnIdx: store.turnIdx,
          sqlUserTurns: store.sqlUserTurns || 0,
          lastPromptSig: store.lastPromptSig || '',
          turnStartedAt: store.turnStartedAt,
          lastActiveTs: store.lastActiveTs,
          lastStepText: store.lastStepText,
          lastProseLen: store.lastProseLen,
          lastDbSig: store.lastDbSig,
          lastSwarmSig: store.lastSwarmSig || '',
          lastBrowserSig: store.lastBrowserSig || '',
          lastIdleStatusSig: store.lastIdleStatusSig || '',
          wasRunning: store.wasRunning,
          noEffectStreak: store.noEffectStreak || 0,
          totalAutoHeals: store.totalAutoHeals || 0,
          healBaselineSig: store.healBaselineSig || '',
          lastAutoHealSentTs: store.lastAutoHealSentTs || 0,
          steps: store.steps.slice(-12)
        })
      );
    } catch {}
  }

  // 提取干净的用户提问文本（剥离 .sr-only 无障碍前缀与 user-message-actions 时间戳后缀）
  function extractCleanUserText(userEl) {
    if (!userEl) return '';
    const targetEl = userEl.querySelector('[data-testid="user-message-content"], [data-testid="user-message-bubble"]') || userEl;
    try {
      const clone = targetEl.cloneNode(true);
      clone
        .querySelectorAll('.sr-only, [data-find-ignore="true"], [data-testid="user-message-actions"], style, script')
        .forEach((n) => n.remove());
      return (clone.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:You\s+said|您说|你说)\s*:?\s*/i, '')
        .slice(0, 48);
    } catch {
      return (targetEl.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:You\s+said|您说|你说)\s*:?\s*/i, '')
        .slice(0, 48);
    }
  }

  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m${rem}s` : `${m}m`;
  }

  // 过滤纯计时文本（避免 "已工作 3m" -> "已工作 4m" 误重置防卡死心跳）
  const RE_PURE_TIMER =
    /^(?:已工作|Worked\s+for|已运行|Running\s+for|已思考|Thought\s+for)\s*[<0-9smhd\s]+(?:\s*·\s*\d+\s*(?:updates?|条进展))?$/i;

  // 归一化汉化前后的步骤名称
  function normalizeStepTitle(raw) {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (RE_THINKING_LIVE.test(s)) return '模型深度思考中';
    s = s
      .replace(/^Starting\s+(.+)$/i, '🚀 启动子代理: $1')
      .replace(/^Started\s+(.+)$/i, '🚀 已启动子代理: $1')
      .replace(/^Messaging\s+(.+?)\s*\(browser\)$/i, '🌐 调度浏览器: $1')
      .replace(/^Messaging\s+(.+)$/i, '📨 调度子代理: $1')
      .replace(/^(?:正在运行命令|正在运行|运行中|Running\s+command|Running)\s*:?\s*/i, (m, offset, full) =>
        full.trim().length > m.trim().length ? '运行: ' : '正在运行命令'
      )
      .replace(/^(?:正在读取|读取中|Reading)\s*:?\s*/i, (m, offset, full) =>
        full.trim().length > m.trim().length ? '读取: ' : '正在读取文件'
      )
      .replace(/^(?:正在编辑|编辑中|Editing)\s*:?\s*/i, (m, offset, full) =>
        full.trim().length > m.trim().length ? '编辑: ' : '正在编辑文件'
      )
      .replace(/^(?:正在搜索|搜索中|Searching)\s*:?\s*/i, (m, offset, full) =>
        full.trim().length > m.trim().length ? '搜索: ' : '正在搜索'
      )
      .replace(/^(?:正在探索|Exploring)\s*:?\s*/i, (m, offset, full) =>
        full.trim().length > m.trim().length ? '探索: ' : '正在检索上下文…'
      )
      .replace(/^(?:正在工作|Working)$/i, '规划调度中');
    return s;
  }

  // 解析 SQLite 指标胶囊信息
  function parseSqlMetrics(cid) {
    const m = window.__ag_last_metrics;
    if (!m || !m.hasData || (cid && m.cascadeId && m.cascadeId !== cid)) return null;
    const inlineText = String(m.inlineHtml || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const ttText = String(m.tooltipHtml || '');
    const genMatch = ttText.match(/Gen\s*#(\d+)/i);
    const turnStepsMatch = ttText.match(/本轮合计\s*\((\d+)步\)/);
    const totalTurnsMatch = ttText.match(/(\d+)\s*轮提问\s*\/\s*(\d+)\s*次有效调用/);
    return {
      sig: m.sig || '',
      inlineText,
      genNum: genMatch ? parseInt(genMatch[1], 10) : null,
      sqlTurnSteps: turnStepsMatch ? parseInt(turnStepsMatch[1], 10) : null,
      userTurns: totalTurnsMatch ? parseInt(totalTurnsMatch[1], 10) : null,
      totalCalls: totalTurnsMatch ? parseInt(totalTurnsMatch[2], 10) : null
    };
  }

  // 扫描侧边栏后台并发运行中的其他会话
  function scanBackgroundConversations(currentCid) {
    const bg = [];
    const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"]');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const hasSpinner = !!r.querySelector('[data-testid="status-loading-spinner"]');
      if (!hasSpinner) continue;
      const rCid = r.getAttribute('data-cascade-id') || '';
      const isSelected = r.getAttribute('data-selected') === 'true' || (currentCid && rCid === currentCid);
      if (!isSelected) {
        const titleEl = r.querySelector('span.truncate') || r;
        const title = (titleEl.textContent || '').trim().split('\n')[0].trim() || '后台会话';
        bg.push({ cid: rCid, title, rowEl: r });
      }
    }
    return bg;
  }

  // ============================================================================
  // 2. 核心采样：融合主对话 DOM + Swarm 协同矩阵 + 子代理状态 + SQLite 遥测
  // ============================================================================
  function sampleRealConversation() {
    const cid = getCascadeId();
    const view = document.querySelector('[data-testid="conversation-view"]');
    const bgConvs = scanBackgroundConversations(cid);

    if (!cid || !view) {
      return {
        mode: 'home',
        isSwarm: false,
        cid: '',
        convTitle: '未打开具体会话',
        stateKind: bgConvs.length > 0 ? 'running' : 'idle',
        stateLabel: bgConvs.length > 0 ? `后台 ${bgConvs.length} 个运行中` : '待命就绪',
        progress: bgConvs.length > 0 ? 50 : 100,
        subtitle: bgConvs.length > 0 ? `正在后台运行: ${bgConvs[0].title}` : '进入任意对话自动追踪真实执行流',
        sourceTag: '全局工作台',
        stageHeader: `后台并发会话 (${bgConvs.length})`,
        rows: bgConvs.length > 0
          ? bgConvs.map((b) => ({
              icon: '🔄',
              spin: true,
              title: b.title,
              status: '后台运行中',
              right: '点击跳转',
              color: '#38bdf8',
              jumpCid: b.cid
            }))
          : [{ icon: '✨', spin: false, title: '当前无正在执行的会话任务', status: '空闲', right: '100%', color: '#10b981' }],
        idleSec: 0,
        activeActor: '',
        sqlInfo: null,
        bgConvs,
        queuedCount: 0,
        coordWorking: false,
        isBrowser: false,
        browserHost: '',
        isWaitingTimer: false,
        isSubagentOnlyRunning: false,
        hasAgentBrowserTab: false,
        userGateKind: '',
        quotaBlocked: false,
        kickPrompt: '',
        progressSig: '',
        canWake: false
      };
    }

    // 触发异步非阻塞 Swarm 状态拉取
    pollSwarmForConversation(cid, false);
    const swarmEntry = swarmStateMap.get(cid);
    const swarmSnap = swarmEntry && swarmEntry.hasSwarm ? swarmEntry.snap : null;

    const store = getTurnStore(cid);
    const now = Date.now();

    // 会话标题
    let convTitle = '';
    const selRow = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"] span.truncate');
    if (selRow) convTitle = selRow.textContent.trim();
    if (!convTitle) convTitle = (document.title || '').split(' - ')[0].trim() || '当前对话';

    // 区分【主代理(Coordinator)自身运行态】与【子代理/Swarm 后台运行态】
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    const cancelBtn = inputBox ? inputBox.querySelector('[data-testid="input-cancel-button"]') : null;
    const selSidebar = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
    const sidebarSpinning = !!(selSidebar && selSidebar.querySelector('[data-testid="status-loading-spinner"]'));

    // 读取底部子代理与浏览器状态栏 [data-testid="idle-status-text"]（取末尾最新节点，兼容单智能体/子代理/定时器/浏览器）
    const idleStatusEls = view.querySelectorAll('[data-testid="idle-status-text"]');
    const idleStatusEl = idleStatusEls.length > 0 ? idleStatusEls[idleStatusEls.length - 1] : null;
    const idleStatusText = idleStatusEl ? (idleStatusEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const hasBrowserFav = !!(idleStatusEl && idleStatusEl.querySelector('[data-testid^="idle-status-browser"]'));
    const isUsingBrowserStatus = /^(?:Using\s+browser|正在使用浏览器|使用浏览器)(?:\s*·|\s*\(|\s*$)/i.test(
      idleStatusText
    );
    const isApprovalStatus = /Waiting\s+for\s+your\s+approval|等待您的批准/i.test(idleStatusText);

    let domSubagentsRunning = 0;
    const subMatch =
      idleStatusText.match(/(\d+)\s*subagents?(?:\/tasks)?\s*running/i) ||
      idleStatusText.match(/(\d+)\s*个?子代理/);
    if (subMatch) {
      domSubagentsRunning = parseInt(subMatch[1], 10) || 0;
    }

    let domBgTasksRunning = 0;
    const taskMatch =
      idleStatusText.match(/(\d+)\s*(?:subagents\/)?tasks?\s*running/i) ||
      idleStatusText.match(/(\d+)\s*个?后台任务/);
    if (taskMatch) {
      domBgTasksRunning = parseInt(taskMatch[1], 10) || 0;
    }

    let domSubagentsBlocked = 0;
    const blockedMatch = idleStatusText.match(/(\d+)\s*(?:subagents?\s+)?blocked\b/i);
    if (blockedMatch) {
      domSubagentsBlocked = parseInt(blockedMatch[1], 10) || 0;
    }

    let isWaitingTimer = false;
    let waitingTimerLabel = '';
    if (!/mentions/i.test(idleStatusText)) {
      const waitingTimerMatch = idleStatusText.match(/Waiting\s+for\s+([^,]+)/i);
      if (waitingTimerMatch) {
        isWaitingTimer = true;
        waitingTimerLabel = waitingTimerMatch[1].trim();
      }
    }

    // 采集右侧内置浏览器操控面板信号
    const stopBtn = document.querySelector('[data-testid="webview-agent-cursor-stop-button"]');
    const stopBtnRect = stopBtn ? stopBtn.getBoundingClientRect() : null;
    const stopBtnVisible = !!(stopBtn && stopBtnRect && stopBtnRect.width > 0 && stopBtnRect.height > 0);
    const cursorPillEl = document.querySelector('[data-testid="webview-agent-cursor-pill-label"]');
    const cursorPillRaw = cursorPillEl ? (cursorPillEl.textContent || '').replace(/\s+/g, ' ').trim() : '';

    const agentFavEl = document.querySelector('[data-testid="browser-tab-favicon-agent"]');
    const agentTabBtn = agentFavEl ? agentFavEl.closest('button, [role="tab"]') : null;
    let browserTabTitle = '';
    if (agentTabBtn) {
      try {
        const clone = agentTabBtn.cloneNode(true);
        clone.querySelectorAll('style, script, svg').forEach((n) => n.remove());
        browserTabTitle = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      } catch {}
    }

    const browserPane = document.querySelector('[data-testid="builtin-browser-pane"]');
    const browserPaneRect = browserPane ? browserPane.getBoundingClientRect() : null;
    const browserPaneVisible = !!(
      browserPane &&
      (browserPane.offsetParent !== null || (browserPaneRect && browserPaneRect.width > 0))
    );
    let rawBrowserUrl = '';
    let browserHost = '';
    if (browserPaneVisible) {
      const urlDisp = browserPane.querySelector('[data-testid="browser-url-display"]');
      const urlInput = browserPane.querySelector('[data-testid="browser-url-input"]');
      rawBrowserUrl = (
        (urlDisp ? urlDisp.textContent : '') ||
        (urlInput ? urlInput.value : '') ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (rawBrowserUrl) {
        const cleanHost = rawBrowserUrl.replace(/^[a-z]+:\/\//i, '').split(/[/?;#]/)[0].trim();
        browserHost = cleanHost.slice(0, 36);
      }
    }

    const userMsgs = view.querySelectorAll('[data-testid="user-message"]');
    const agentResps = view.querySelectorAll('[data-testid="agent-response"]');
    const userCount = userMsgs.length;
    const lastUserEl = userCount > 0 ? userMsgs[userCount - 1] : null;
    const lastUserText = extractCleanUserText(lastUserEl);
    const lastResp = agentResps.length > 0 ? agentResps[agentResps.length - 1] : null;

    const srHeading = lastResp ? lastResp.querySelector('h6.sr-only') : null;
    const srWorking = !!(srHeading && /working/i.test(srHeading.textContent || ''));

    // 主对话自身是否在跑 (Coordinator Turn Active)
    const coordWorking = !!(cancelBtn || srWorking);
    const queuedCount = getQueuedMessagesCount();
    const browserSubagentRowEl = lastResp ? lastResp.querySelector('[data-testid="browser-subagent-row"]') : null;
    const hasBrowserRowInResp = !!browserSubagentRowEl;
    const hasBrowserStepInStore = store.steps.some((s) => s.kind === 'browser' || /^🌐/.test(s.title || ''));

    // 检测 DOM 中是否包含 Swarm 协作特征（避免将单个普通子代理或浏览器子代理误识别为 Swarm）
    const lastRespText = lastResp ? (lastResp.textContent || '') : '';
    const domHasSwarmMarker =
      /Open the Swarm UI|Checked\s*\|\s*swarm\s+status|Checked\s+swarm\s+status|Waiting for @mentions after #\d+|Read \d+ messages? from board/i.test(
        lastRespText
      );
    const waitingMentionsMatch = lastRespText.match(/Waiting for @mentions after #(\d+)/i);
    const waitingAfterSeq = waitingMentionsMatch ? parseInt(waitingMentionsMatch[1], 10) : null;

    // Swarm 成员实时健康度与死锁深度分析（排除 monitor/narrator 系统哨兵干扰）
    const swarmHealth = analyzeSwarmHealth(swarmSnap, now, cfg.timeoutSec);
    const swarmMembers = swarmHealth.liveMembers;
    const swarmWorkingMembers = swarmHealth.workingBizMembers;
    const swarmWorkers = swarmHealth.bizWorkers;
    const swarmMessages = swarmHealth.swarmMessages;
    const lastBoardMsg = swarmHealth.lastBoardMsg;
    const boardMarkedDone = swarmHealth.boardMarkedDone;

    const effectiveSubagentsRunning = Math.max(
      domSubagentsRunning,
      swarmHealth.workingBizWorkers.length
    );

    const browserSignals = !!(
      isUsingBrowserStatus ||
      hasBrowserFav ||
      (!coordWorking && stopBtnVisible && (hasBrowserRowInResp || hasBrowserStepInStore))
    );

    const baseRunning = !!(
      coordWorking ||
      sidebarSpinning ||
      browserSignals ||
      domSubagentsRunning > 0 ||
      domBgTasksRunning > 0 ||
      isWaitingTimer ||
      swarmWorkingMembers.length > 0
    );

    const userGate = detectUserInteractionGate(view, lastResp, baseRunning, domSubagentsBlocked, isApprovalStatus);
    let waitingApproval = userGate.active;
    const isRunning = !!(baseRunning || waitingApproval);
    const isBrowserActive = isRunning && browserSignals;
    const isSwarmMode = !!(swarmSnap || domHasSwarmMarker || (!isBrowserActive && domSubagentsRunning >= 2));

    // SQLite 信号同步
    const sqlInfo = parseSqlMetrics(cid);
    let genuineActivity = false;
    if (sqlInfo && sqlInfo.sig && sqlInfo.sig !== store.lastDbSig) {
      if (store.lastDbSig !== '') genuineActivity = true;
      store.lastDbSig = sqlInfo.sig;
    }

    // Swarm API 业务签名变化同步（仅看 coordinator 与业务 worker，彻底屏蔽 monitor 告警发帖干扰）
    if (swarmEntry && swarmEntry.bizSig && swarmEntry.bizSig !== store.lastSwarmSig) {
      if (store.lastSwarmSig !== '') genuineActivity = true;
      store.lastSwarmSig = swarmEntry.bizSig;
    }

    // 真实轮次计数（抗虚拟滚动 DOM 回收）与新一轮提问判定
    const displayTurnNum = sqlInfo && sqlInfo.userTurns > 0 ? sqlInfo.userTurns : Math.max(1, userCount);
    let isNewTurn = false;
    if (sqlInfo && sqlInfo.userTurns > 0) {
      if (store.sqlUserTurns > 0 && sqlInfo.userTurns > store.sqlUserTurns) {
        isNewTurn = true;
      }
      store.sqlUserTurns = sqlInfo.userTurns;
      store.turnIdx = sqlInfo.userTurns;
    } else if (lastUserText && store.lastPromptSig && lastUserText !== store.lastPromptSig && isRunning) {
      isNewTurn = true;
      store.turnIdx = userCount || store.turnIdx + 1;
    }
    if (lastUserText) {
      store.lastPromptSig = lastUserText;
    }
    if (isNewTurn) {
      const isAutoHealTurn =
        (store.lastAutoHealSentTs > 0 && now - store.lastAutoHealSentTs < 35000) ||
        (store.noEffectStreak > 0 && /^继续(?:[：:]|\s|$)/i.test((lastUserText || '').trim()));
      store.turnStartedAt = now;
      store.lastActiveTs = now;
      store.lastStepText = '';
      store.lastProseLen = 0;
      store.lastBrowserSig = '';
      store.lastIdleStatusSig = '';
      if (!isAutoHealTurn) {
        store.noEffectStreak = 0;
        store.healBaselineSig = '';
        store.lastAutoHealSentTs = 0;
      }
      store.steps = [];
      genuineActivity = true;
    }

    // 异常中断错误信息
    let interruptedError = '';

    if (lastResp) {
      // 关键修复：仅查询真正带闪烁动画的 .animate-shimmer-text，绝不把已结束的静态 [data-testid="tool-group-collapsible"] ("已探索") 当作进行中步骤！
      const shimmerEls = lastResp.querySelectorAll('.animate-shimmer-text');
      let activeStepRaw = '';
      for (let i = shimmerEls.length - 1; i >= 0; i--) {
        if (shimmerEls[i].closest('[data-testid="idle-status-text"]')) continue;
        const txt = (shimmerEls[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (txt && !RE_PURE_TIMER.test(txt)) {
          activeStepRaw = txt;
          break;
        }
      }

      if (/等待您的批准|Waiting for your approval/i.test(activeStepRaw)) {
        waitingApproval = true;
        if (!userGate.active) {
          userGate.active = true;
          userGate.kind = 'approval';
          userGate.title = '步骤执行确认';
        }
      }

      // 仅当主代理 (Coordinator) 自身处于工作态且未进入人机等待门禁时记录主对话步骤
      const normStep = normalizeStepTitle(activeStepRaw);
      if (coordWorking && !waitingApproval && normStep && !(isGenericWrapperStep(normStep) && store.steps.length > 0)) {
        if (normStep !== store.lastStepText) {
          store.lastStepText = normStep;
          genuineActivity = true;

          if (normStep !== '规划调度中' && store.steps.length > 0) {
            const prev = store.steps[store.steps.length - 1];
            if (prev.title === '规划调度中' && now - prev.startedAt < 1800) {
              store.steps.pop();
            }
          }

          const tail = store.steps.length > 0 ? store.steps[store.steps.length - 1] : null;
          if (tail && tail.title.toLowerCase() === normStep.toLowerCase()) {
            tail.title = normStep;
            tail.done = false;
            tail.endedAt = null;
          } else {
            for (let s of store.steps) {
              if (!s.done) {
                s.done = true;
                s.endedAt = now;
              }
            }
            store.steps.push({
              key: 'step_' + now + '_' + store.steps.length,
              title: normStep,
              startedAt: now,
              endedAt: null,
              done: false
            });
          }
        }
      } else if (!coordWorking && !isBrowserActive) {
        // 主代理当前轮已结束（且非浏览器操控态），立即闭合主代理历史步骤
        for (let s of store.steps) {
          if (!s.done) {
            s.done = true;
            s.endedAt = now;
          }
        }
      }

      // 监控流式正文输出变化
      const proseEls = lastResp.querySelectorAll('.prose, .markdown');
      let proseLen = 0;
      for (let i = 0; i < proseEls.length; i++) {
        proseLen += (proseEls[i].textContent || '').trim().length;
      }
      if (proseLen !== store.lastProseLen) {
        if (proseLen > store.lastProseLen && coordWorking) {
          genuineActivity = true;
          const streamStep = store.steps.find((s) => s.key === 'prose_stream');
          if (!streamStep && proseLen > 12) {
            for (let s of store.steps) {
              if (!s.done) {
                s.done = true;
                s.endedAt = now;
              }
            }
            store.steps.push({
              key: 'prose_stream',
              title: `流式生成回复正文 (${proseLen} 字)`,
              startedAt: now,
              endedAt: null,
              done: false
            });
          } else if (streamStep) {
            streamStep.title = `流式生成回复正文 (${proseLen} 字)`;
          }
        }
        store.lastProseLen = proseLen;
      }
    }

    // 浏览器子代理实时步骤追踪与无计时心跳签名
    let currentBrowserCleanLabel = '';
    if (isBrowserActive) {
      let rawBrowserAction = isUsingBrowserStatus
        ? idleStatusText.replace(/^(?:Using\s+browser|正在使用浏览器|使用浏览器)\s*(?:·|:|-)?\s*/i, '').trim()
        : '';
      if (!rawBrowserAction) {
        rawBrowserAction = cursorPillRaw;
      }

      const secMatch = rawBrowserAction.match(/(?:\s*·\s*(\d+)s|\s*\((\d+)s\))[….]*$/i);
      const reportedSec = secMatch ? parseInt(secMatch[1] || secMatch[2], 10) || 0 : 0;
      const cleanAction = rawBrowserAction
        .replace(/(?:\s*·\s*\d+[smhd]+|\s*\(\d+[smhd]+\))[….]*$/i, '')
        .replace(/[….]+\s*$/, '')
        .trim();

      let browserPhase = 'acting';
      let actionKey = cleanAction;
      let browserStepTitle = '🌐 ' + cleanAction;
      if (!cleanAction || /^(?:Thinking|正在思考)$/i.test(cleanAction)) {
        browserPhase = cleanAction ? 'thinking' : 'starting';
        actionKey = '__browser_' + browserPhase + '__';
        browserStepTitle = cleanAction
          ? '🌐 浏览器页面解析与下一步规划中…'
          : '🌐 正在连接并操控内置浏览器…';
        currentBrowserCleanLabel = cleanAction ? '页面解析与规划下一步…' : '正在接入内置浏览器…';
      } else {
        currentBrowserCleanLabel = cleanAction;
      }

      const browserSig = `${browserPhase}|${actionKey}|${rawBrowserUrl.slice(0, 120)}|${browserTabTitle.slice(0, 60)}`;
      if (browserSig !== store.lastBrowserSig) {
        if (store.lastBrowserSig !== '') genuineActivity = true;
        store.lastBrowserSig = browserSig;
      }

      // 闭合所有非浏览器未完成步骤
      for (let s of store.steps) {
        if (!s.done && s.kind !== 'browser') {
          s.done = true;
          s.endedAt = now;
        }
      }

      // 若最后回复含 browser-subagent-row 且步骤列表尚未记录启动，则在列表头部补全已完成记录
      if (
        hasBrowserRowInResp &&
        !store.steps.some((s) => s.key === 'browser_start' || /启动子代理|已启动子代理/i.test(s.title || ''))
      ) {
        const rowTxt = normalizeStepTitle((browserSubagentRowEl.textContent || '').replace(/\s+/g, ' ').trim());
        if (rowTxt) {
          store.steps.unshift({
            key: 'browser_start',
            kind: 'subagent',
            title: rowTxt,
            startedAt: store.turnStartedAt || now,
            endedAt: store.turnStartedAt || now,
            done: true
          });
        }
      }

      const estStart = reportedSec > 0 ? Math.min(now, now - reportedSec * 1000) : now;
      if (browserPhase === 'acting') {
        const lastIdx = store.steps.length - 1;
        if (lastIdx >= 0 && store.steps[lastIdx].kind === 'browser' && store.steps[lastIdx].browserPhase !== 'acting') {
          store.steps.pop();
        }
        const tail = store.steps.length > 0 ? store.steps[store.steps.length - 1] : null;
        if (tail && tail.kind === 'browser' && tail.actionKey === actionKey) {
          tail.title = browserStepTitle;
          tail.done = false;
          tail.endedAt = null;
          if (reportedSec > 0) tail.startedAt = Math.min(tail.startedAt || now, estStart);
        } else {
          for (let s of store.steps) {
            if (!s.done) {
              s.done = true;
              s.endedAt = now;
            }
          }
          store.steps.push({
            key: 'browser_' + now + '_' + store.steps.length,
            kind: 'browser',
            browserPhase: 'acting',
            actionKey,
            title: browserStepTitle,
            startedAt: estStart,
            endedAt: null,
            done: false
          });
        }
      } else {
        const tail = store.steps.length > 0 ? store.steps[store.steps.length - 1] : null;
        if (tail && tail.kind === 'browser' && tail.actionKey === actionKey) {
          tail.title = browserStepTitle;
          tail.done = false;
          tail.endedAt = null;
          if (reportedSec > 0) tail.startedAt = Math.min(tail.startedAt || now, estStart);
        } else {
          if (tail && tail.kind === 'browser' && tail.browserPhase !== 'acting') {
            store.steps.pop();
          }
          for (let s of store.steps) {
            if (!s.done) {
              s.done = true;
              s.endedAt = now;
            }
          }
          store.steps.push({
            key: 'browser_' + browserPhase + '_' + now,
            kind: 'browser',
            browserPhase,
            actionKey,
            title: browserStepTitle,
            startedAt: estStart,
            endedAt: null,
            done: false
          });
        }
      }
      store.lastStepText = browserStepTitle;
    } else {
      const tail = store.steps.length > 0 ? store.steps[store.steps.length - 1] : null;
      if (tail && tail.kind === 'browser' && tail.browserPhase && tail.browserPhase !== 'acting') {
        store.steps.pop();
      }
      if (!coordWorking) {
        for (let s of store.steps) {
          if (!s.done) {
            s.done = true;
            s.endedAt = now;
          }
        }
      }
      if (!isRunning) {
        store.lastBrowserSig = '';
      }
    }

    // 内置浏览器登录/验证页自动防打扰识别（在登录/验证 URL 停留 >= 45s 视为等待人工）
    if (
      isBrowserActive &&
      !waitingApproval &&
      rawBrowserUrl &&
      /accounts\.google\.com|\/login\b|\/signin\b|\/oauth\b|\/auth\b|checkout|payment/i.test(rawBrowserUrl)
    ) {
      const tailStep = store.steps.length > 0 ? store.steps[store.steps.length - 1] : null;
      const stepDwellSec =
        tailStep && tailStep.startedAt ? Math.max(0, Math.floor((now - tailStep.startedAt) / 1000)) : 0;
      const roughIdleSec = Math.max(0, Math.floor((now - store.lastActiveTs) / 1000));
      if (stepDwellSec >= 45 || roughIdleSec >= 45) {
        waitingApproval = true;
        userGate.active = true;
        userGate.kind = 'approval';
        userGate.title = '内置浏览器等待您完成登录/验证';
        userGate.progress = '';
        userGate.targetEl = browserPane || null;
      }
    }

    // 非 Swarm、非浏览器的单子代理/后台任务/定时器等待态心跳签名
    if (isRunning && !coordWorking && !isBrowserActive && !isSwarmMode && idleStatusText) {
      const idleStatusSig = idleStatusText.replace(/(?:\s*·\s*\d+[smhd]+|\s*\(\d+[smhd]+\))[….]*$/i, '').trim();
      if (idleStatusSig && idleStatusSig !== store.lastIdleStatusSig) {
        if (store.lastIdleStatusSig !== '') genuineActivity = true;
        store.lastIdleStatusSig = idleStatusSig;
      }
    } else if (!isRunning) {
      store.lastIdleStatusSig = '';
    }

    // 检查异常断流、配额受限或服务重启导致的子代理强行中断
    const tailText = (view.textContent || '').slice(-900);
    let hasRetryBtn = false;
    if (!isRunning) {
      const retryBtns = view.querySelectorAll('button');
      for (let i = Math.max(0, retryBtns.length - 12); i < retryBtns.length; i++) {
        const bt = (retryBtns[i].textContent || '').trim();
        if (bt === '重试' || bt === 'Retry') {
          hasRetryBtn = true;
          break;
        }
      }
    }

    const RE_QUOTA_ERR =
      /RESOURCE_EXHAUSTED|exhausted your capacity|quota exceeded|您已消耗全部.*额度|429 Too Many Requests/i;
    const notifCard = document.querySelector('[data-testid="input-box-notification-card"]');
    const notifText = notifCard && isElementVisible(notifCard) ? (notifCard.textContent || '') : '';
    const tailErrorEl = !isRunning
      ? Array.from(view.querySelectorAll('[role="alert"], [data-testid*="error"], .text-destructive')).pop()
      : null;
    const tailErrorText = tailErrorEl ? (tailErrorEl.textContent || '') : '';
    const lastRespHasProse = !!(lastResp && lastResp.querySelector('.prose, .markdown'));
    const quotaBlocked = !!(
      swarmHealth.coordQuotaBlocked ||
      RE_QUOTA_ERR.test(notifText) ||
      RE_QUOTA_ERR.test(tailErrorText) ||
      (!isRunning && !boardMarkedDone && RE_QUOTA_ERR.test(tailText) && (hasRetryBtn || !lastRespHasProse))
    );

    if (!isRunning && !quotaBlocked) {
      if (
        !boardMarkedDone &&
        /subagents and background tasks have been stopped due to server restart|子代理和后台任务已因服务器重启而停止/i.test(
          tailText
        )
      ) {
        interruptedError = '服务重启导致子代理中断，可一键唤醒恢复';
      } else if (/stream was interrupted|execution terminated due to error|网络连接中断|请求失败/i.test(tailText)) {
        interruptedError = '检测到对话流意外中断 (Stream Interrupted)';
      } else if (hasRetryBtn) {
        interruptedError = '检测到步骤失败，可一键重试唤醒';
      }
    }

    // 运行态切换处理
    if (isRunning && !store.wasRunning) {
      store.wasRunning = true;
      store.lastActiveTs = now;
      genuineActivity = true;
    } else if (!isRunning && store.wasRunning) {
      store.wasRunning = false;
      store.lastActiveTs = now;
      for (let s of store.steps) {
        if (!s.done) {
          s.done = true;
          s.endedAt = now;
        }
      }
      genuineActivity = true;
    }

    // 实质进展评估：一旦上次催促后产生实质推进，立刻清零连续无进展计数 noEffectStreak
    const curCalls = sqlInfo ? sqlInfo.totalCalls || 0 : 0;
    const curGen = sqlInfo ? sqlInfo.genNum || 0 : 0;
    const doneStepsCount = store.steps.filter((s) => s.done).length;
    const curProseLen = store.lastProseLen || 0;
    const swarmBizSig = swarmEntry ? swarmEntry.bizSig || '' : '';
    const progressSig = JSON.stringify({
      turnIdx: store.turnIdx || 0,
      calls: curCalls,
      gen: curGen,
      swarm: swarmBizSig,
      done: doneStepsCount,
      prose: curProseLen
    });

    if (store.noEffectStreak > 0 && store.lastAutoHealSentTs > 0 && now - store.lastAutoHealSentTs > 4000) {
      let hasSubstantialProgress = false;
      try {
        const base = store.healBaselineSig ? JSON.parse(store.healBaselineSig) : null;
        if (!base) {
          hasSubstantialProgress = !!(swarmBizSig || doneStepsCount > 0 || curProseLen > 30);
        } else {
          const swarmProgressed = !!(swarmBizSig && swarmBizSig !== (base.swarm || ''));
          const sameTurnProgressed =
            (store.turnIdx || 0) === (base.turnIdx || 0) &&
            (curCalls > (base.calls || 0) ||
              curGen > (base.gen || 0) ||
              doneStepsCount > (base.done || 0) ||
              curProseLen > Math.max(30, (base.prose || 0) + 30));
          const newTurnProgressed =
            (store.turnIdx || 0) > (base.turnIdx || 0) &&
            (curCalls > (base.calls || 0) + 1 ||
              doneStepsCount > 0 ||
              curProseLen > 30 ||
              (!!store.lastStepText && store.lastStepText !== '模型深度思考中' && store.lastStepText !== '规划调度中'));
          hasSubstantialProgress = swarmProgressed || sameTurnProgressed || newTurnProgressed;
        }
      } catch {}
      if (hasSubstantialProgress) {
        store.noEffectStreak = 0;
        store.healBaselineSig = '';
        genuineActivity = true;
      }
    }

    if (genuineActivity) {
      store.lastActiveTs = now;
      persistTurnStore(store);
    }

    if (waitingApproval) {
      for (let s of store.steps) {
        if (!s.done) {
          s.done = true;
          s.endedAt = now;
        }
      }
    }

    // 计算真实空闲秒数（融合 Swarm 业务成员底层 transcriptMtime，彻底排除 monitor/narrator 干扰）
    let maxSwarmMtime = 0;
    let latestActiveMember = '';
    const mtimeCandidates =
      swarmWorkingMembers.length > 0
        ? swarmWorkingMembers
        : swarmMembers.filter((m) => !isSwarmSystemMember(m));
    for (let i = 0; i < mtimeCandidates.length; i++) {
      const m = mtimeCandidates[i];
      const mt = Number(m.transcriptMtime || 0);
      if (mt > maxSwarmMtime) {
        maxSwarmMtime = mt;
        latestActiveMember = '@' + m.name;
      }
    }
    const effectiveLastActiveTs =
      maxSwarmMtime > 0 && !coordWorking && swarmWorkingMembers.length > 0
        ? maxSwarmMtime
        : Math.max(store.lastActiveTs, maxSwarmMtime);
    const idleSec = isRunning ? Math.max(0, Math.floor((now - effectiveLastActiveTs) / 1000)) : 0;

    // 判定是否卡死：
    // 定时器等待/人机门禁/硬配额限流不走普通卡死，Swarm 死锁检测直接升格为停滞
    const isSubagentOnlyRunning = !!(isRunning && !coordWorking);
    let effectiveTimeout =
      isBrowserActive || (!coordWorking && (effectiveSubagentsRunning > 0 || domBgTasksRunning > 0) && !swarmSnap)
        ? Math.max(cfg.timeoutSec * 2, 240)
        : cfg.timeoutSec;
    if (coordWorking && (store.steps.length === 0 || store.lastStepText === '模型深度思考中')) {
      effectiveTimeout = Math.max(effectiveTimeout, 180);
    }
    let isStalled = isRunning && !waitingApproval && !isWaitingTimer && !quotaBlocked && idleSec >= effectiveTimeout;
    if (isSwarmMode && swarmHealth.swarmDeadlocked && !waitingApproval && !quotaBlocked) {
      isStalled = true;
    }

    // ==========================================================================
    // 3. 分支渲染 A：Swarm / 多子代理协同模式 (isSwarmMode)
    // ==========================================================================
    if (isSwarmMode) {
      // 查找本轮主代理最近一次派单的看板序号 (排除 [done] 结项帖)
      const lastCoordDispatchSeq = swarmHealth.lastCoordDispatchSeq;

      let swarmRows = [];
      if (swarmMembers.length > 0) {
        // 排序：coordinator -> working -> 已回传 -> 待命 -> monitor/narrator
        const sorted = swarmMembers.slice().sort((a, b) => {
          if (a.role === 'coordinator') return -1;
          if (b.role === 'coordinator') return 1;
          const aSys = isSwarmSystemMember(a);
          const bSys = isSwarmSystemMember(b);
          if (aSys && !bSys) return 1;
          if (!aSys && bSys) return -1;
          const aWork = a.status === 'working' ? 0 : 1;
          const bWork = b.status === 'working' ? 0 : 1;
          if (aWork !== bWork) return aWork - bWork;
          return (b.lastPostSeq || 0) - (a.lastPostSeq || 0);
        });

        swarmRows = sorted.map((m) => {
          const isMemberWorking = m.status === 'working';
          const isCoord = m.role === 'coordinator';
          const isMonitor = m.role === 'monitor' || /^monitor(?:-\d+)?$/i.test(m.name || '');
          const isNarrator = m.role === 'narrator' || !!m.narrator || /^narrator(?:-\d+)?$/i.test(m.name || '');
          const isSysWorker = isSwarmSystemMember(m);
          const hasPostedThisRound =
            (m.posts || 0) > 0 && (lastCoordDispatchSeq === 0 || (m.lastPostSeq || 0) > lastCoordDispatchSeq);
          const hasPostedPrevRound = (m.posts || 0) > 0 && !hasPostedThisRound;
          const mIdle = m.transcriptMtime ? Math.max(0, Math.round((now - m.transcriptMtime) / 1000)) : null;

          let icon = '⏳';
          let spin = false;
          let desc = '';
          let rightLabel = '待命';
          let color = '#94a3b8';

          if (isMemberWorking) {
            const memberThreshold =
              isCoord && swarmHealth.unresolvedStallPost ? Math.min(effectiveTimeout, 90) : effectiveTimeout;
            const memberStalled = !isSysWorker && mIdle !== null && mIdle >= memberThreshold;
            icon = isMonitor ? '🛡️' : isNarrator ? '📝' : memberStalled ? '⚠️' : '🔄';
            spin = !isSysWorker && !memberStalled;
            desc = m.activity
              ? m.activity
              : isCoord
                ? '正在汇总调度与执行工具…'
                : isMonitor
                  ? 'Swarm 防死锁巡检哨兵 (巡检中…)'
                  : isNarrator
                    ? 'Swarm 叙事总览维护 (更新中…)'
                    : m.unread > 0
                      ? `正在处理 ${m.unread} 条看板消息…`
                      : '子代理正在并发执行任务…';
            rightLabel = isMonitor
              ? '巡检中'
              : isNarrator
                ? '总览中'
                : memberStalled
                  ? `停滞 ${fmtDur(mIdle * 1000)}`
                  : '运行中';
            color = isSysWorker ? '#818cf8' : memberStalled ? '#f87171' : '#38bdf8';
          } else if (isCoord) {
            if (boardMarkedDone && !isRunning) {
              icon = '✅';
              desc = `已发布 [done] 结项 (#${m.lastPostSeq || ''})`;
              rightLabel = '已完成';
              color = '#10b981';
            } else if (m.wait_since || waitingAfterSeq) {
              icon = '📡';
              const seq = m.wait_since || waitingAfterSeq;
              desc = `挂起等待看板回传 (#${seq} 后唤醒)`;
              rightLabel = swarmHealth.swarmDeadlocked ? '死锁停滞' : '监听看板';
              color = swarmHealth.swarmDeadlocked ? '#f87171' : '#a78bfa';
            } else {
              icon = '✅';
              desc = `本轮调度完毕 (共发帖 ${m.posts || 0})`;
              rightLabel = '待命';
              color = '#10b981';
            }
          } else if (isMonitor) {
            icon = '🛡️';
            desc = 'Swarm 防死锁巡检哨兵';
            rightLabel = '值守中';
            color = '#818cf8';
          } else if (isNarrator) {
            icon = '📝';
            desc = 'Swarm 叙事总览员';
            rightLabel = '值守中';
            color = '#818cf8';
          } else if (hasPostedThisRound) {
            icon = '✅';
            desc = `本轮已回传看板 #${m.lastPostSeq}`;
            rightLabel = '已回传';
            color = '#10b981';
          } else if (m.failure) {
            icon = '⚠️';
            const fText = typeof m.failure === 'object' ? m.failure.text || m.failure.kind : String(m.failure);
            desc = `异常: ${fText}`;
            rightLabel = m.failure && m.failure.kind === 'quota' ? '配额受限' : '异常';
            color = '#f87171';
          } else if (hasPostedPrevRound) {
            icon = '⏳';
            desc = `待命 (上轮回传 #${m.lastPostSeq})`;
            rightLabel = '待命';
            color = '#94a3b8';
          } else {
            icon = '⏳';
            desc = '等待看板 @mention 唤醒';
            rightLabel = '待命';
            color = '#94a3b8';
          }

          const stepBadge = `${m.steps || 0} 步` + (isMemberWorking && mIdle !== null ? ` · ${fmtDur(mIdle * 1000)}前` : '');

          return {
            icon,
            spin,
            title: `@${m.name} · ${desc}`,
            status: stepBadge,
            right: rightLabel,
            color,
            jumpCid: m.conversation_id && m.conversation_id !== cid ? m.conversation_id : '',
            openSwarm: !m.conversation_id || m.conversation_id === cid
          };
        });
      } else {
        // 尚未获取到 /api/swarm 时的 DOM 级子代理兜底展示
        swarmRows.push({
          icon: coordWorking ? '🔄' : '📡',
          spin: coordWorking,
          title: coordWorking
            ? `@coordinator · ${store.lastStepText || '主代理正在调度任务…'}`
            : `@coordinator · 已派发任务，等待子代理回传${waitingAfterSeq ? ` (#${waitingAfterSeq})` : ''}`,
          status: coordWorking ? '主代理活跃' : '挂起等待中',
          right: coordWorking ? '运行中' : '监听中',
          color: coordWorking ? '#38bdf8' : '#a78bfa',
          openSwarm: true
        });
        if (effectiveSubagentsRunning > 0) {
          swarmRows.push({
            icon: '🔄',
            spin: true,
            title: `🐝 ${effectiveSubagentsRunning} 个并发子代理正在后台执行任务…`,
            status: idleStatusText || 'Subagents running',
            right: '并发执行中',
            color: '#38bdf8',
            openSwarm: true
          });
        }
      }

      if (waitingApproval) {
        swarmRows.push(buildUserGateRow(userGate));
      }

      // 计算 Swarm 本轮真实整体进度
      const totalWorkers = Math.max(1, swarmWorkers.length || effectiveSubagentsRunning || 1);
      const completedWorkers = swarmWorkers.filter(
        (w) =>
          w.status !== 'working' &&
          (w.posts || 0) > 0 &&
          (lastCoordDispatchSeq === 0 || (w.lastPostSeq || 0) > lastCoordDispatchSeq)
      ).length;
      const workingWorkers = swarmWorkers.filter((w) => w.status === 'working').length;

      let progress = 100;
      let stateKind = 'done';
      let stateLabel = 'Swarm 已完成';
      let subtitle = '';

      if (waitingApproval) {
        const gateDisp = formatUserGateDisplay(userGate);
        stateKind = 'approval';
        stateLabel = gateDisp.stateLabel;
        progress = Math.min(92, Math.round(((completedWorkers + 0.5) / (totalWorkers + 1)) * 100));
        subtitle = gateDisp.subtitle;
      } else if (quotaBlocked) {
        stateKind = 'quota';
        stateLabel = '🚫 配额受限';
        progress = Math.min(90, Math.max(20, Math.round((completedWorkers / (totalWorkers + 1)) * 100)));
        subtitle = '⏸ 模型配额/限流受限，已切换 300s 慢速探活';
      } else if (isStalled) {
        stateKind = 'stalled';
        stateLabel = 'Swarm 停滞';
        progress = Math.min(90, Math.max(20, Math.round(((completedWorkers + 0.3) / (totalWorkers + 1)) * 100)));
        const stalledNames = swarmWorkingMembers.map((m) => '@' + m.name).join(', ') || '当前节点';
        subtitle = swarmHealth.deadlockReason
          ? `⚠️ ${swarmHealth.deadlockReason}`
          : `⚠️ 全矩阵已 ${idleSec}s 无进展 · ${stalledNames}`;
      } else if (interruptedError) {
        stateKind = 'stalled';
        stateLabel = 'Swarm 中断';
        progress = Math.min(90, Math.max(20, Math.round((completedWorkers / (totalWorkers + 1)) * 100)));
        subtitle = `⚠️ ${interruptedError}`;
      } else if (isRunning) {
        stateKind = 'swarm';
        const activeBizCount = swarmWorkingMembers.length || effectiveSubagentsRunning || (coordWorking ? 1 : 0);
        stateLabel = `🐝 Swarm (${activeBizCount} 活跃)`;
        const rawPct = Math.round(((completedWorkers + workingWorkers * 0.45 + (coordWorking ? 0.2 : 0.4)) / (totalWorkers + 1)) * 100);
        progress = Math.min(95, Math.max(18, rawPct));

        const leadList = swarmWorkingMembers;
        if (leadList.length > 0) {
          const lead = leadList[0];
          const act =
            lead.activity ||
            (lead.role === 'coordinator'
              ? '主代理汇总调度中…'
              : lead.unread > 0
                ? `正在处理 ${lead.unread} 条看板消息…`
                : '正在执行子任务…');
          subtitle =
            leadList.length > 1
              ? `🐝 @${lead.name} 等 ${leadList.length} 节点并发: ${act}`
              : `🐝 @${lead.name}: ${act}`;
        } else if (effectiveSubagentsRunning > 0) {
          subtitle = `🐝 主代理监听看板中 · ${effectiveSubagentsRunning} 个子代理正在并发运行…`;
        } else {
          subtitle = `🐝 @coordinator: ${store.lastStepText || '正在同步 Swarm 看板状态…'}`;
        }
      } else {
        stateKind = 'done';
        stateLabel = '🐝 Swarm 就绪';
        progress = 100;
        const sTitle = (swarmSnap && swarmSnap.title) || convTitle;
        subtitle = boardMarkedDone
          ? `✅ Swarm 已结项 [done] · ${sTitle}`
          : `✅ 全部 ${swarmMembers.length || totalWorkers} 节点已回传待命 · ${sTitle}`;
      }

      const shortCid = cid.slice(0, 8);
      const lastSeq = lastBoardMsg ? lastBoardMsg.seq : waitingAfterSeq || 0;
      const sourceTag =
        (lastSeq ? `看板 #${lastSeq} · ` : '') +
        (sqlInfo && sqlInfo.genNum ? `会话 ${shortCid} · Gen#${sqlInfo.genNum}` : `会话 ${shortCid}`);
      const stageHeader =
        swarmMembers.length > 0
          ? `🐝 Swarm 协同矩阵 (${swarmMembers.length} 节点 · 已回传 ${completedWorkers}/${swarmWorkers.length})`
          : `🐝 多子代理协同流 (${effectiveSubagentsRunning} 子代理运行中)`;

      return {
        mode: 'chat',
        isSwarm: true,
        cid,
        convTitle,
        isRunning,
        waitingApproval,
        isStalled,
        interruptedError,
        stateKind,
        stateLabel,
        progress,
        subtitle,
        sourceTag,
        stageHeader,
        rows: swarmRows,
        idleSec,
        activeActor: latestActiveMember,
        sqlInfo,
        bgConvs,
        store,
        queuedCount,
        coordWorking,
        isBrowser: false,
        browserHost: '',
        isWaitingTimer,
        isSubagentOnlyRunning,
        hasAgentBrowserTab: !!agentTabBtn,
        userGateKind: userGate.kind,
        quotaBlocked,
        kickPrompt: swarmHealth.kickPrompt || '',
        progressSig,
        canWake: !waitingApproval && (isStalled || !!interruptedError || quotaBlocked || !isRunning)
      };
    }

    // ==========================================================================
    // 4. 分支渲染 B：常规单智能体对话模式
    // ==========================================================================
    const wfBtn = lastResp ? lastResp.querySelector('[data-testid="worked-for-collapsible"]') : null;
    const wfSummary = wfBtn ? (wfBtn.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const changedCard = lastResp ? lastResp.querySelector('[data-testid="changed-files-card-header"], [data-testid="changed-files-card"]') : null;
    const changedText = changedCard ? (changedCard.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 42) : '';
    const embedCount = lastResp ? lastResp.querySelectorAll('[data-testid="agent-embed"]').length : 0;

    let displayRows = [];
    if (store.steps.length > 0) {
      const recent = store.steps.slice(-5);
      displayRows = recent.map((s) => {
        const dur = fmtDur((s.done ? s.endedAt || now : now) - s.startedAt);
        if (s.done) {
          return {
            icon: '✅',
            spin: false,
            title: s.title,
            status: `耗时 ${dur}`,
            right: '100%',
            color: '#10b981'
          };
        }
        return {
          icon: isStalled ? '⚠️' : '🔄',
          spin: !isStalled,
          title: s.title,
          status: isStalled ? `停滞 ${idleSec}s` : '执行中',
          right: dur,
          color: isStalled ? '#f87171' : '#38bdf8'
        };
      });
    } else {
      if (lastUserText) {
        displayRows.push({
          icon: '💬',
          spin: false,
          title: `本轮指令: ${lastUserText}`,
          status: `第 ${displayTurnNum} 轮`,
          right: '已提交',
          color: '#94a3b8'
        });
      }
      if (wfSummary) {
        displayRows.push({
          icon: isRunning ? '🔄' : '✅',
          spin: isRunning,
          title: `模型思考与工具链 (${wfSummary})`,
          status: isRunning ? '运行中' : '已完成',
          right: isRunning ? fmtDur(now - store.turnStartedAt) : '100%',
          color: isRunning ? '#38bdf8' : '#10b981'
        });
      } else if (isRunning && coordWorking) {
        displayRows.push({
          icon: '🔄',
          spin: true,
          title: '正在等待模型首字响应 / 规划工具调用…',
          status: '推理中',
          right: fmtDur(now - store.turnStartedAt),
          color: '#38bdf8'
        });
      }
      if (changedText) {
        displayRows.push({
          icon: '📝',
          spin: false,
          title: `文件变更: ${changedText}`,
          status: '已落盘',
          right: '100%',
          color: '#10b981'
        });
      }
      if (embedCount > 0) {
        displayRows.push({
          icon: '🧩',
          spin: false,
          title: `内嵌交互组件 (${embedCount} 个交付工件)`,
          status: '已渲染',
          right: '100%',
          color: '#10b981'
        });
      }
      if (!isRunning && store.lastProseLen > 0) {
        displayRows.push({
          icon: '✅',
          spin: false,
          title: `回复正文输出 (${store.lastProseLen} 字)`,
          status: '已完成',
          right: '100%',
          color: '#10b981'
        });
      }
    }

    if (isRunning && !coordWorking && !isBrowserActive && !isSwarmMode && !waitingApproval) {
      displayRows.push({
        icon: isWaitingTimer ? '⏱' : '🔄',
        spin: !isWaitingTimer,
        title: isWaitingTimer
          ? `⏱ 正在等待定时任务触发 (${waitingTimerLabel || 'timer'})`
          : `🔄 后台子代理/命令正在执行 (${idleStatusText || '运行中'})`,
        status: isWaitingTimer ? '定时等待中' : '运行中',
        right: fmtDur(now - store.turnStartedAt),
        color: isWaitingTimer ? '#a78bfa' : '#38bdf8'
      });
    }

    if (waitingApproval) {
      displayRows.push(buildUserGateRow(userGate));
    }

    const doneSteps = store.steps.filter((s) => s.done).length;
    const totalRecorded = store.steps.length;
    const sqlSteps = sqlInfo && sqlInfo.sqlTurnSteps ? sqlInfo.sqlTurnSteps : 0;
    const effectiveDone = Math.max(doneSteps, isRunning ? Math.max(0, sqlSteps - 1) : sqlSteps);
    const effectiveTotal = Math.max(totalRecorded, sqlSteps, isRunning ? effectiveDone + 1 : Math.max(1, effectiveDone));

    let stateKind = 'done';
    let stateLabel = '已完成';
    let progress = 100;
    let subtitle = '';
    const shortCid = cid.slice(0, 8);
    const sourceTag = sqlInfo && sqlInfo.genNum ? `会话 ${shortCid} · Gen#${sqlInfo.genNum}` : `会话 ${shortCid}`;
    let stageHeader = isRunning
      ? `📋 本轮实时执行流 (已完成 ${effectiveDone} 步 · 进行中)`
      : `📋 本轮真实执行流 (共 ${effectiveTotal} 步 · 第 ${displayTurnNum} 轮)`;
    const queueSuffix = queuedCount > 0 ? ` · 队列 ${queuedCount} 条` : '';

    if (waitingApproval) {
      const gateDisp = formatUserGateDisplay(userGate);
      stateKind = 'approval';
      stateLabel = gateDisp.stateLabel;
      progress = Math.min(90, Math.round(((effectiveDone + 0.5) / Math.max(1, effectiveTotal)) * 100));
      subtitle = gateDisp.subtitle;
    } else if (quotaBlocked) {
      stateKind = 'quota';
      stateLabel = '🚫 配额受限';
      progress = Math.min(92, Math.max(20, Math.round((effectiveDone / Math.max(1, effectiveTotal)) * 100)));
      subtitle = '⏸ 模型配额/限流受限，已切换 300s 慢速探活';
    } else if (isStalled) {
      stateKind = 'stalled';
      stateLabel = '卡死预警';
      progress = Math.min(92, Math.max(15, Math.round(((effectiveDone + 0.3) / Math.max(1, effectiveTotal)) * 100)));
      const curName = store.lastStepText || '当前步骤';
      subtitle = `⚠️ 已停滞 ${idleSec}s 无进展 · ${curName}`;
    } else if (interruptedError) {
      stateKind = 'stalled';
      stateLabel = '异常断流';
      progress = Math.min(90, Math.max(20, Math.round((effectiveDone / Math.max(1, effectiveTotal)) * 100)));
      subtitle = `⚠️ ${interruptedError}`;
    } else if (isBrowserActive) {
      stateKind = 'browser';
      stateLabel = '🌐 浏览器操控';
      progress = Math.min(95, Math.max(18, Math.round(((effectiveDone + 0.5) / Math.max(1, effectiveTotal)) * 100)));
      subtitle = `🌐 ${browserHost ? `[${browserHost}] ` : ''}${currentBrowserCleanLabel}${queueSuffix}`;
      stageHeader = `🌐 浏览器实时操控流 (已完成 ${effectiveDone} 步 · 运行中)`;
    } else if (isRunning) {
      stateKind = 'running';
      stateLabel = isWaitingTimer ? '⏱ 定时等待' : '进行中';
      progress = Math.min(95, Math.max(12, Math.round(((effectiveDone + 0.4) / Math.max(1, effectiveTotal)) * 100)));
      const activeTitle = isWaitingTimer
        ? `⏱ 等待定时任务触发: ${waitingTimerLabel || 'timer'}`
        : !coordWorking && idleStatusText
          ? idleStatusText
          : store.lastStepText || (wfSummary ? `${wfSummary} · 正在推理规划…` : '模型正在思考与规划中…');
      subtitle = `[第 ${effectiveDone + 1} 步] ${activeTitle}${queueSuffix}`;
    } else {
      stateKind = 'done';
      stateLabel = '已完成';
      progress = 100;
      subtitle = wfSummary
        ? `${wfSummary} · 第 ${displayTurnNum} 轮已就绪 (${convTitle})`
        : `第 ${displayTurnNum} 轮已就绪 · ${convTitle}`;
    }

    return {
      mode: 'chat',
      isSwarm: false,
      isBrowser: isBrowserActive,
      browserHost,
      isWaitingTimer,
      isSubagentOnlyRunning,
      hasAgentBrowserTab: !!agentTabBtn,
      userGateKind: userGate.kind,
      quotaBlocked,
      kickPrompt: '',
      progressSig,
      queuedCount,
      coordWorking,
      cid,
      convTitle,
      isRunning,
      waitingApproval,
      isStalled,
      interruptedError,
      stateKind,
      stateLabel,
      progress,
      subtitle,
      sourceTag,
      stageHeader,
      rows: displayRows,
      idleSec,
      activeActor: '',
      sqlInfo,
      bgConvs,
      store,
      canWake: !waitingApproval && (isStalled || !!interruptedError || quotaBlocked || !isRunning)
    };
  }

  // 安全唤醒 / 重试调起真实会话
  let autoHealCountdown = 0;
  let autoHealTargetTurn = -1;

  function triggerRealWakeup(reason = 'manual', customPrompt = '') {
    autoHealCountdown = 0;
    const view = document.querySelector('[data-testid="conversation-view"]');
    const agentResps = view ? view.querySelectorAll('[data-testid="agent-response"]') : null;
    const lastResp = agentResps && agentResps.length > 0 ? agentResps[agentResps.length - 1] : null;
    const gate = detectUserInteractionGate(view, lastResp, true, 0, false);
    if (gate.active) {
      focusUserGateUI();
      return false;
    }

    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return false;

    const promptText = typeof customPrompt === 'string' && customPrompt.trim() ? customPrompt.trim() : '继续';

    if (view) {
      const btns = view.querySelectorAll('button');
      for (let i = btns.length - 1; i >= Math.max(0, btns.length - 15); i--) {
        const txt = (btns[i].textContent || '').trim();
        if (txt === '重试' || txt === 'Retry') {
          btns[i].click();
          return true;
        }
      }
    }

    const queuedCount = getQueuedMessagesCount();
    if (queuedCount > 0) {
      const sendNowBtn = findQueuedSendNowBtn();
      if (sendNowBtn) {
        sendNowBtn.click();
        return true;
      }
      return false;
    }

    const sendPromptText = () => {
      const box = document.getElementById('antigravity.agentSidePanelInputBox');
      if (!box) return;
      const editor = box.querySelector('[data-lexical-editor="true"], [contenteditable="true"], textarea');
      if (!editor) return;

      const existingText = (editor.value !== undefined ? editor.value : editor.textContent || '').trim();
      if (existingText.length > 0 && reason !== 'manual-force') {
        return;
      }

      editor.focus();
      if (existingText.length === 0) {
        const ok = document.execCommand && document.execCommand('insertText', false, promptText);
        if (!ok) {
          editor.dispatchEvent(
            new InputEvent('beforeinput', {
              inputType: 'insertText',
              data: promptText,
              bubbles: true,
              cancelable: true
            })
          );
        }
      }

      setTimeout(() => {
        const sendBtn =
          box.querySelector('[data-testid="send-button"]') ||
          Array.from(box.querySelectorAll('button')).find((b) => {
            const a = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-ag-orig-aria-label') || '');
            return /send|submit|发送|提交/i.test(a) && !b.disabled;
          });
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else {
          editor.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
          );
        }

        // 若因后台运行未彻底结束导致新消息落入「排队消息」，550ms 后自动补点 Send Now 强推直达主代理
        setTimeout(() => {
          if (getQueuedMessagesCount() > 0) {
            const sendNow = findQueuedSendNowBtn();
            if (sendNow) sendNow.click();
          }
        }, 550);
      }, 140);
    };

    const cancelBtn = inputBox.querySelector('[data-testid="input-cancel-button"]');
    if (cancelBtn) {
      cancelBtn.click();
      setTimeout(sendPromptText, 850);
      return true;
    }

    if (reason === 'manual') {
      const stopBtn = document.querySelector('[data-testid="webview-agent-cursor-stop-button"]');
      const stopRect = stopBtn ? stopBtn.getBoundingClientRect() : null;
      if (stopBtn && stopRect && stopRect.width > 0 && stopRect.height > 0) {
        stopBtn.click();
        setTimeout(sendPromptText, 900);
        return true;
      }
    }

    sendPromptText();
    return true;
  }

  // 构建 DOM 界面与智能贴边锚点状态
  const SAFE_X = 12;
  const SAFE_Y = 12;
  let posState = null;
  try {
    const rawPos = loadJson(localStorage, STORAGE_POS_KEY, null);
    if (
      rawPos &&
      (rawPos.anchor === 'left' || rawPos.anchor === 'right') &&
      typeof rawPos.offsetX === 'number' &&
      typeof rawPos.top === 'number'
    ) {
      posState = {
        anchor: rawPos.anchor,
        offsetX: Math.max(SAFE_X, rawPos.offsetX),
        top: Math.max(SAFE_Y, rawPos.top)
      };
    } else if (rawPos && typeof rawPos.left === 'number' && typeof rawPos.top === 'number') {
      if (rawPos.left + 420 > window.innerWidth - SAFE_X) {
        posState = {
          anchor: 'right',
          offsetX: Math.max(SAFE_X, Math.min(240, window.innerWidth - rawPos.left - 128)),
          top: Math.max(SAFE_Y, rawPos.top)
        };
      } else {
        posState = {
          anchor: 'left',
          offsetX: Math.max(SAFE_X, rawPos.left),
          top: Math.max(SAFE_Y, rawPos.top)
        };
      }
      saveJson(localStorage, STORAGE_POS_KEY, posState);
    }
  } catch {}

  const pill = document.createElement('div');
  pill.id = 'ag-watchdog-dock-pill';
  pill.innerHTML = `
    <span id="ag-wd-pill-dot" class="ag-wd-dot-pulse" style="width:8px;height:8px;border-radius:50%;background:#00d2ff;color:#00d2ff;"></span>
    <span id="ag-wd-pill-txt" class="ag-wd-mono" style="color:#e2e8f0;">100% 完成了么</span>
    <span style="font-size:9px;opacity:0.65;margin-left:1px;">▾</span>
  `;
  pill.title = '点击展开「完成了么」真实会话监控面板';

  const hud = document.createElement('div');
  hud.id = 'ag-watchdog-hud';

  function applyAnchorStyles(el) {
    if (!el) return;
    const anchor = posState ? posState.anchor : 'right';
    const offsetX = Math.max(SAFE_X, posState ? posState.offsetX : 20);
    const top = Math.max(SAFE_Y, posState ? posState.top : 56);
    if (anchor === 'left') {
      el.style.left = offsetX + 'px';
      el.style.right = 'auto';
    } else {
      el.style.right = offsetX + 'px';
      el.style.left = 'auto';
    }
    el.style.top = top + 'px';
  }

  function applyPositionAndClamp() {
    applyAnchorStyles(hud);
    applyAnchorStyles(pill);

    const activeEl = cfg.hidden ? null : cfg.minimized ? pill : hud;
    if (!activeEl) return;
    const rect = activeEl.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;

    const anchor = posState ? posState.anchor : 'right';
    if (anchor === 'left') {
      const maxLeft = Math.max(SAFE_X, window.innerWidth - rect.width - SAFE_X);
      const curLeft = parseFloat(activeEl.style.left);
      const baseLeft = Number.isFinite(curLeft) ? curLeft : rect.left;
      const clampedLeft = Math.max(SAFE_X, Math.min(maxLeft, baseLeft));
      activeEl.style.left = clampedLeft + 'px';
      activeEl.style.right = 'auto';
    } else {
      const maxRight = Math.max(SAFE_X, window.innerWidth - rect.width - SAFE_X);
      const curRight = parseFloat(activeEl.style.right);
      const baseRight = Number.isFinite(curRight) ? curRight : window.innerWidth - rect.right;
      const clampedRight = Math.max(SAFE_X, Math.min(maxRight, baseRight));
      activeEl.style.right = clampedRight + 'px';
      activeEl.style.left = 'auto';
    }

    const maxTop = Math.max(SAFE_Y, window.innerHeight - rect.height - SAFE_Y);
    const curTop = parseFloat(activeEl.style.top);
    const baseTop = Number.isFinite(curTop) ? curTop : rect.top;
    const clampedTop = Math.max(SAFE_Y, Math.min(maxTop, baseTop));
    activeEl.style.top = clampedTop + 'px';
  }

  hud.innerHTML = `
    <div id="ag-wd-header" style="display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:grab;">
      <div style="display:flex;align-items:center;gap:11px;min-width:0;flex:1;">
        <div style="position:relative;width:48px;height:48px;flex-shrink:0;display:flex;align-items:center;justify-content:center;">
          <svg style="width:100%;height:100%;transform:rotate(-90deg);" viewBox="0 0 36 36">
            <path stroke="#1e293b" stroke-width="3.4" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
            <path id="ag-wd-ring" stroke="#00d2ff" stroke-width="3.6" stroke-linecap="round" fill="none" stroke-dasharray="100, 100"
              style="transition:stroke-dasharray 0.35s ease, stroke 0.25s ease;"
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
          </svg>
          <span id="ag-wd-ring-txt" class="ag-wd-mono" style="position:absolute;font-size:11px;font-weight:700;color:#ffffff;">100%</span>
        </div>

        <div style="min-width:0;flex:1;">
          <div style="display:flex;align-items:center;gap:7px;margin-bottom:3px;">
            <span id="ag-wd-badge" style="display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:9999px;font-size:11px;font-weight:600;background:rgba(8,47,73,0.9);color:#38bdf8;border:1px solid rgba(56,189,248,0.4);">
              <span id="ag-wd-badge-dot" class="ag-wd-dot-pulse" style="width:6px;height:6px;border-radius:50%;background:#38bdf8;color:#38bdf8;"></span>
              <span id="ag-wd-badge-txt">同步中</span>
            </span>
            <span style="font-size:14px;font-weight:700;color:#ffffff;letter-spacing:0.3px;">完成了么</span>
          </div>
          <div id="ag-wd-subtitle" class="ag-wd-mono" style="font-size:11px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            正在连接当前真实对话…
          </div>
        </div>
      </div>

      <div class="ag-wd-ctrl-btns">
        <button id="ag-wd-collapse-btn" class="ag-wd-icon-btn" title="折叠/展开明细">${cfg.collapsed ? '▼' : '▲'}</button>
        <button id="ag-wd-min-btn" class="ag-wd-icon-btn" title="收起为悬浮胶囊">—</button>
        <button id="ag-wd-close-btn" class="ag-wd-icon-btn" title="彻底关闭隐藏 (可按 ⌥+W 或点顶栏 ⚡ 重新呼出)">✕</button>
      </div>
    </div>

    <div id="ag-wd-bar-track" style="width:100%;height:4px;background:#1e293b;border-radius:9999px;margin-top:10px;overflow:hidden;">
      <div id="ag-wd-bar" style="width:100%;height:100%;background:linear-gradient(90deg,#00d2ff,#38bdf8);border-radius:9999px;transition:width 0.35s ease, background 0.25s ease;"></div>
    </div>

    <div id="ag-wd-body" style="margin-top:10px;padding-top:9px;border-top:1px solid rgba(51,65,85,0.55);display:${cfg.collapsed ? 'none' : 'block'};">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:7px;font-size:11px;">
        <span id="ag-wd-stage-hdr" style="color:#e2e8f0;font-weight:600;">📋 本轮真实执行流</span>
        <span id="ag-wd-src-tag" class="ag-wd-mono" style="font-size:10.5px;color:#38bdf8;background:rgba(8,47,73,0.65);padding:1px 6px;border-radius:4px;border:1px solid rgba(56,189,248,0.28);">数据源: 实时会话</span>
      </div>

      <div id="ag-wd-rows" class="ag-wd-stage-list"></div>

      <div id="ag-wd-bg-bar" style="display:none;margin-top:6px;flex-direction:column;gap:4px;"></div>

      <div style="margin-top:8px;padding:7px 9px;border-radius:9px;background:rgba(2,6,23,0.72);border:1px solid rgba(30,41,59,0.9);display:flex;flex-direction:column;gap:6px;">
        <div class="ag-wd-mono" style="display:flex;justify-content:space-between;align-items:center;font-size:11px;">
          <span id="ag-wd-hb" style="color:#10b981;">● 心跳: 实时监听中</span>
          <span id="ag-wd-sql" style="color:#94a3b8;font-size:10.5px;max-width:210px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding-top:5px;border-top:1px solid rgba(30,41,59,0.75);">
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            <button id="ag-wd-timeout-btn" class="ag-wd-chip-btn ag-wd-mono" title="点击切换卡死判定阈值">超时阈值: ${cfg.timeoutSec}s</button>
            <button id="ag-wd-autoheal-btn" class="ag-wd-chip-btn ${cfg.autoHeal ? 'is-active' : ''}" title="开启后，遇到异常断流或超时卡死将倒计时 5 秒自动发送「继续」唤醒">断流自愈: ${cfg.autoHeal ? '开' : '关'}</button>
            <button id="ag-wd-swarm-btn" class="ag-wd-chip-btn is-swarm-btn" style="display:none;" title="打开或聚焦右侧 Swarm 实时看板">🐝 看板</button>
            <button id="ag-wd-browser-btn" class="ag-wd-chip-btn is-browser-btn" style="display:none;" title="一键聚焦内置浏览器智能体标签页">🌐 聚焦页面</button>
          </div>
          <button id="ag-wd-wake-btn" class="ag-wd-chip-btn" title="若当前对话断流或卡住，立即自动点重试或发送「继续」">⚡ 唤醒继续</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(pill);
  document.body.appendChild(hud);

  function ensureReopenToolbarBtn() {
    let btn = document.getElementById('ag-watchdog-reopen-btn');
    const toolbar = document.querySelector('[data-testid="pane-titlebar-toolbar"]');
    if (!cfg.hidden) {
      if (btn) btn.remove();
      return;
    }
    if (!toolbar) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'ag-watchdog-reopen-btn';
      btn.type = 'button';
      btn.title = '打开「完成了么」实时会话监控 (⌥+W)';
      btn.textContent = '⚡ 监控';
      btn.style.cssText =
        'height:24px;padding:0 8px;margin-right:4px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid rgba(56,189,248,0.45);background:rgba(11,19,32,0.88);color:#38bdf8;display:inline-flex;align-items:center;gap:4px;';
      btn.addEventListener('click', () => {
        cfg.hidden = false;
        cfg.minimized = false;
        saveJson(localStorage, STORAGE_CFG_KEY, cfg);
        syncVisibility();
        renderSnapshot();
      });
    }
    if (btn.parentElement !== toolbar) {
      toolbar.insertBefore(btn, toolbar.firstChild);
    }
  }

  function syncVisibility() {
    if (cfg.hidden) {
      hud.style.display = 'none';
      pill.style.display = 'none';
      ensureReopenToolbarBtn();
    } else if (cfg.minimized) {
      hud.style.display = 'none';
      pill.style.display = 'inline-flex';
      ensureReopenToolbarBtn();
    } else {
      hud.style.display = 'block';
      pill.style.display = 'none';
      ensureReopenToolbarBtn();
    }
    applyPositionAndClamp();
    requestAnimationFrame(applyPositionAndClamp);
  }
  syncVisibility();

  // DOM 缓存引用
  const elRing = document.getElementById('ag-wd-ring');
  const elRingTxt = document.getElementById('ag-wd-ring-txt');
  const elBadge = document.getElementById('ag-wd-badge');
  const elBadgeDot = document.getElementById('ag-wd-badge-dot');
  const elBadgeTxt = document.getElementById('ag-wd-badge-txt');
  const elSubtitle = document.getElementById('ag-wd-subtitle');
  const elBar = document.getElementById('ag-wd-bar');
  const elBody = document.getElementById('ag-wd-body');
  const elStageHdr = document.getElementById('ag-wd-stage-hdr');
  const elSrcTag = document.getElementById('ag-wd-src-tag');
  const elRows = document.getElementById('ag-wd-rows');
  const elBgBar = document.getElementById('ag-wd-bg-bar');
  const elHb = document.getElementById('ag-wd-hb');
  const elSql = document.getElementById('ag-wd-sql');
  const elCollapseBtn = document.getElementById('ag-wd-collapse-btn');
  const elMinBtn = document.getElementById('ag-wd-min-btn');
  const elCloseBtn = document.getElementById('ag-wd-close-btn');
  const elTimeoutBtn = document.getElementById('ag-wd-timeout-btn');
  const elAutohealBtn = document.getElementById('ag-wd-autoheal-btn');
  const elSwarmBtn = document.getElementById('ag-wd-swarm-btn');
  const elBrowserBtn = document.getElementById('ag-wd-browser-btn');
  const elWakeBtn = document.getElementById('ag-wd-wake-btn');
  const elPillDot = document.getElementById('ag-wd-pill-dot');
  const elPillTxt = document.getElementById('ag-wd-pill-txt');

  let lastBgHtml = '';
  let lastRowsHtml = '';
  let latestKickPrompt = '';

  function renderSnapshot() {
    const snap = sampleRealConversation();
    latestKickPrompt = snap.kickPrompt || '';

    // 控制 Swarm / 浏览器快捷按钮显示
    if (elSwarmBtn) {
      elSwarmBtn.style.display = snap.isSwarm ? 'inline-block' : 'none';
    }
    if (elBrowserBtn) {
      elBrowserBtn.style.display = snap.isBrowser || snap.hasAgentBrowserTab ? 'inline-block' : 'none';
    }

    // 自适应退避自愈调度（有实质进展自动清零无进展计数；Swarm 死锁停滞直接放行踢起；无进展退避持续探活）
    const cooldownSec = snap.quotaBlocked
      ? 300
      : snap.store
        ? snap.store.noEffectStreak <= 0
          ? 0
          : snap.store.noEffectStreak === 1
            ? Math.max(cfg.timeoutSec, 120)
            : snap.store.noEffectStreak === 2
              ? 180
              : 300
        : 0;
    const sinceLastHealSec =
      snap.store && snap.store.lastAutoHealSentTs > 0
        ? Math.max(0, Math.floor((Date.now() - snap.store.lastAutoHealSentTs) / 1000))
        : Infinity;
    const remainCooldown = cooldownSec > sinceLastHealSec ? cooldownSec - sinceLastHealSec : 0;

    const canHealThisState =
      !!snap.interruptedError ||
      (snap.isStalled && (snap.isSwarm || !snap.isSubagentOnlyRunning)) ||
      !!snap.quotaBlocked;

    const allowAutoHeal =
      cfg.autoHeal &&
      snap.mode === 'chat' &&
      !snap.waitingApproval &&
      !snap.isWaitingTimer &&
      remainCooldown === 0 &&
      canHealThisState &&
      !!snap.store;

    if (allowAutoHeal) {
      if (autoHealTargetTurn !== snap.store.turnIdx || autoHealCountdown <= 0) {
        autoHealTargetTurn = snap.store.turnIdx;
        autoHealCountdown = autoHealCountdown > 0 ? autoHealCountdown - 1 : 5;
        if (autoHealCountdown === 0) {
          snap.store.healBaselineSig = snap.progressSig || '';
          snap.store.noEffectStreak = (snap.store.noEffectStreak || 0) + 1;
          snap.store.totalAutoHeals = (snap.store.totalAutoHeals || 0) + 1;
          snap.store.lastAutoHealSentTs = Date.now();
          snap.store.lastActiveTs = Date.now();
          persistTurnStore(snap.store);
          triggerRealWakeup('auto', snap.kickPrompt || '');
        }
      } else {
        autoHealCountdown -= 1;
        if (autoHealCountdown <= 0) {
          snap.store.healBaselineSig = snap.progressSig || '';
          snap.store.noEffectStreak = (snap.store.noEffectStreak || 0) + 1;
          snap.store.totalAutoHeals = (snap.store.totalAutoHeals || 0) + 1;
          snap.store.lastAutoHealSentTs = Date.now();
          snap.store.lastActiveTs = Date.now();
          persistTurnStore(snap.store);
          triggerRealWakeup('auto', snap.kickPrompt || '');
        }
      }
    } else {
      autoHealCountdown = 0;
    }

    // 环形进度与颜色主题
    const pct = Math.max(0, Math.min(100, Math.round(snap.progress)));
    elRing.setAttribute('stroke-dasharray', `${pct}, 100`);
    elRingTxt.textContent = `${pct}%`;
    elBar.style.width = `${pct}%`;

    hud.classList.remove('is-stalled', 'is-done', 'is-approval', 'is-swarm', 'is-browser', 'is-quota');
    pill.classList.remove('is-stalled', 'is-done', 'is-approval', 'is-swarm', 'is-browser', 'is-quota');
    hud.classList.toggle('is-collapsed', !!cfg.collapsed);

    const isAnimatedState = ['running', 'swarm', 'browser', 'approval', 'stalled'].includes(snap.stateKind);
    elBadgeDot.classList.toggle('ag-wd-dot-pulse', isAnimatedState);
    elPillDot.classList.toggle('ag-wd-dot-pulse', isAnimatedState);

    let themeColor = '#00d2ff';
    if (snap.stateKind === 'stalled') {
      themeColor = '#ef4444';
      hud.classList.add('is-stalled');
      pill.classList.add('is-stalled');
      elBadge.style.background = 'rgba(69, 10, 10, 0.92)';
      elBadge.style.borderColor = 'rgba(248, 113, 113, 0.65)';
      elBadge.style.color = '#fca5a5';
      elWakeBtn.classList.add('is-wake');
      elWakeBtn.textContent =
        autoHealCountdown > 0
          ? `⚡ ${autoHealCountdown}s 自愈中 (点此立即唤醒)`
          : snap.isSwarm
            ? '⚡ 立即踢起节点'
            : '⚡ 立即唤醒重调';
    } else if (snap.stateKind === 'quota') {
      themeColor = '#f97316';
      hud.classList.add('is-quota');
      pill.classList.add('is-quota');
      elBadge.style.background = 'rgba(67, 20, 7, 0.9)';
      elBadge.style.borderColor = 'rgba(249, 115, 22, 0.6)';
      elBadge.style.color = '#fdba74';
      elWakeBtn.classList.remove('is-wake');
      elWakeBtn.textContent = remainCooldown > 0 && cfg.autoHeal ? `⚡ ${remainCooldown}s 后探活` : '⚡ 立即探活';
    } else if (snap.stateKind === 'approval') {
      themeColor = '#f59e0b';
      hud.classList.add('is-approval');
      pill.classList.add('is-approval');
      elBadge.style.background = 'rgba(69, 26, 3, 0.9)';
      elBadge.style.borderColor = 'rgba(245, 158, 11, 0.6)';
      elBadge.style.color = '#fcd34d';
      elWakeBtn.classList.remove('is-wake');
      elWakeBtn.textContent = snap.userGateKind === 'question' ? '💬 去答题' : '⏸ 去审批';
    } else if (snap.stateKind === 'swarm') {
      themeColor = '#818cf8';
      hud.classList.add('is-swarm');
      pill.classList.add('is-swarm');
      elBadge.style.background = 'rgba(49, 46, 129, 0.88)';
      elBadge.style.borderColor = 'rgba(129, 140, 248, 0.55)';
      elBadge.style.color = '#c7d2fe';
      elWakeBtn.classList.remove('is-wake');
      elWakeBtn.textContent = '⚡ 唤醒主代理';
    } else if (snap.stateKind === 'browser') {
      themeColor = '#22d3ee';
      hud.classList.add('is-browser');
      pill.classList.add('is-browser');
      elBadge.style.background = 'rgba(8, 51, 68, 0.9)';
      elBadge.style.borderColor = 'rgba(34, 211, 238, 0.55)';
      elBadge.style.color = '#67e8f9';
      elWakeBtn.classList.remove('is-wake');
      elWakeBtn.textContent = '⚡ 停止并重调';
    } else if (snap.stateKind === 'running') {
      themeColor = '#00d2ff';
      elBadge.style.background = 'rgba(8, 47, 73, 0.9)';
      elBadge.style.borderColor = 'rgba(56, 189, 248, 0.45)';
      elBadge.style.color = '#38bdf8';
      elWakeBtn.classList.remove('is-wake');
      elWakeBtn.textContent = '⚡ 强制重调';
    } else {
      themeColor = '#10b981';
      hud.classList.add('is-done');
      pill.classList.add('is-done');
      elBadge.style.background = 'rgba(6, 78, 59, 0.88)';
      elBadge.style.borderColor = 'rgba(16, 185, 129, 0.48)';
      elBadge.style.color = '#6ee7b7';
      elWakeBtn.classList.remove('is-wake');
      elWakeBtn.textContent = '⚡ 发送继续';
    }

    elRing.setAttribute('stroke', themeColor);
    elBar.style.background =
      snap.stateKind === 'swarm'
        ? 'linear-gradient(90deg, #38bdf8, #818cf8)'
        : snap.stateKind === 'browser'
          ? 'linear-gradient(90deg, #06b6d4, #2dd4bf)'
          : snap.stateKind === 'running'
            ? 'linear-gradient(90deg, #00d2ff, #38bdf8)'
            : themeColor;
    elBadgeDot.style.background = themeColor;
    elBadgeDot.style.color = themeColor;
    elBadgeTxt.textContent = snap.stateLabel;

    elPillDot.style.background = themeColor;
    elPillDot.style.color = themeColor;
    elPillTxt.textContent = `${pct}% · ${snap.stateLabel}`;

    elSubtitle.textContent = snap.subtitle;
    elSubtitle.title = snap.subtitle;
    elStageHdr.textContent = snap.stageHeader;
    elSrcTag.textContent = snap.sourceTag;
    elSrcTag.title = '数据源: ' + snap.sourceTag;

    // 渲染真实步骤或 Swarm 节点矩阵列表（仅当 HTML 变化时更新 DOM）
    const nextRowsHtml = snap.rows
      .map(
        (r) => `
      <div data-jump-cid="${escHtml(r.jumpCid || '')}" data-open-swarm="${r.openSwarm ? '1' : ''}" data-focus-gate="${r.focusGate ? '1' : ''}" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;background:rgba(15,23,42,0.72);border:1px solid ${r.spin ? 'rgba(56,189,248,0.42)' : 'rgba(30,41,59,0.75)'};${r.jumpCid || r.openSwarm || r.focusGate ? 'cursor:pointer;' : ''}">
        <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
          <span class="${r.spin ? 'ag-wd-spin' : ''}" style="font-size:12px;flex-shrink:0;">${r.icon}</span>
          <span class="ag-wd-mono" title="${escHtml(r.title)}" style="font-size:11px;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(r.title)}</span>
        </div>
        <div class="ag-wd-mono" style="display:flex;align-items:center;gap:8px;flex-shrink:0;font-size:11px;">
          <span style="color:#94a3b8;">${escHtml(r.status)}</span>
          <span style="color:${r.color};font-weight:700;">${escHtml(r.right)}</span>
        </div>
      </div>`
      )
      .join('');

    if (nextRowsHtml !== lastRowsHtml) {
      lastRowsHtml = nextRowsHtml;
      elRows.innerHTML = nextRowsHtml;
    }

    ensureReopenToolbarBtn();

    // 后台其他并行运行窗口提示条
    if (snap.mode === 'chat' && snap.bgConvs.length > 0) {
      elBgBar.style.display = 'flex';
      const nextBgHtml = snap.bgConvs
        .map(
          (b) => `
        <div data-jump-cid="${escHtml(b.cid)}" style="padding:5px 9px;border-radius:8px;background:rgba(8,47,73,0.48);border:1px solid rgba(56,189,248,0.34);font-size:11px;color:#7dd3fc;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;transition:background 0.15s ease;">
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🔄 后台运行中: ${escHtml(b.title)}</span>
          <span style="flex-shrink:0;color:#38bdf8;font-weight:600;">点击切换 →</span>
        </div>`
        )
        .join('');
      if (nextBgHtml !== lastBgHtml) {
        lastBgHtml = nextBgHtml;
        elBgBar.innerHTML = nextBgHtml;
      }
    } else {
      lastBgHtml = '';
      elBgBar.style.display = 'none';
      elBgBar.innerHTML = '';
    }

    // 心跳与 SQLite 实时速率展示
    if (snap.stateKind === 'stalled') {
      elHb.style.color = '#f87171';
      elHb.textContent =
        autoHealCountdown > 0
          ? `⚠️ 停滞! ${autoHealCountdown}s 后自动${snap.isSwarm ? '踢起唤醒' : '唤醒'}…`
          : cfg.autoHeal && remainCooldown > 0 && snap.store
            ? `⏳ 第 ${snap.store.totalAutoHeals || 1} 次催促已发出，${remainCooldown}s 后若仍无进展将继续自动催促…`
            : snap.interruptedError
              ? `⚠️ ${snap.interruptedError}`
              : snap.isStalled && snap.isSubagentOnlyRunning && !snap.isSwarm
                ? `⚠️ 子代理已 ${snap.idleSec}s 无新进展 (防插队未自动发送，可手动停止重调)`
                : snap.isSwarm
                  ? `⚠️ ${String(snap.subtitle || '').replace(/^⚠️\s*/, '')}`
                  : `⚠️ 已 ${snap.idleSec}s 无进展输出`;
    } else if (snap.stateKind === 'quota') {
      elHb.style.color = '#fb923c';
      elHb.textContent =
        cfg.autoHeal && remainCooldown > 0 && snap.store
          ? `⏳ 第 ${snap.store.totalAutoHeals || 1} 次催促已发出，${remainCooldown}s 后若仍无进展将继续自动催促…`
          : '🚫 模型配额或限流受限 (已切换 300s 慢速探活)';
    } else if (snap.stateKind === 'approval') {
      elHb.style.color = '#fbbf24';
      elHb.textContent =
        snap.userGateKind === 'question'
          ? '⏸ 等待您在输入框上方完成选择题 / 问答'
          : '⏸ 等待人工审批授权操作';
    } else if (snap.stateKind === 'browser') {
      elHb.style.color = snap.idleSec > cfg.timeoutSec * 0.65 ? '#fbbf24' : '#22d3ee';
      const hostSuffix = snap.browserHost ? ` · ${snap.browserHost}` : '';
      elHb.textContent =
        snap.idleSec <= 2
          ? `● 浏览器心跳: 实时操控中${hostSuffix}`
          : `● 浏览器心跳: ${snap.idleSec}s 前动作${hostSuffix}`;
    } else if (snap.stateKind === 'swarm' || snap.stateKind === 'running') {
      elHb.style.color = snap.idleSec > cfg.timeoutSec * 0.65 ? '#fbbf24' : '#10b981';
      const actorSuffix = snap.isSwarm && snap.activeActor ? ` (${snap.activeActor})` : '';
      elHb.textContent =
        snap.idleSec <= 2
          ? `● ${snap.isSwarm ? 'Swarm 心跳' : '心跳'}: 实时活跃中${actorSuffix}`
          : `● ${snap.isSwarm ? 'Swarm 心跳' : '心跳'}: ${snap.idleSec}s 前活跃${actorSuffix}`;
    } else {
      elHb.style.color = '#34d399';
      elHb.textContent = snap.isSwarm ? '● Swarm 心跳: 矩阵就绪 (全员待命)' : '● 心跳: 会话就绪 (等待指令)';
    }

    elSql.textContent = snap.sqlInfo && snap.sqlInfo.inlineText ? snap.sqlInfo.inlineText : '';
    elSql.title = snap.sqlInfo && snap.sqlInfo.inlineText ? snap.sqlInfo.inlineText : '';
  }

  // 事件绑定：拖拽定位（面板与胶囊位置同步记忆）
  const dragHeader = document.getElementById('ag-wd-header');
  let dragState = null;

  function startDrag(e, targetEl) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const rect = targetEl.getBoundingClientRect();
    dragState = {
      el: targetEl,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top,
      moved: false
    };
    dragHeader.style.cursor = 'grabbing';
    e.preventDefault();
  }

  dragHeader.addEventListener('mousedown', (e) => startDrag(e, hud));
  pill.addEventListener('mousedown', (e) => startDrag(e, pill));

  const onMouseMove = (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true;
    if (!dragState.moved) return;

    const el = dragState.el;
    const w = el.offsetWidth || 160;
    const h = el.offsetHeight || 40;
    const maxL = Math.max(SAFE_X, window.innerWidth - w - SAFE_X);
    const maxT = Math.max(SAFE_Y, window.innerHeight - h - SAFE_Y);
    const nextL = Math.max(SAFE_X, Math.min(maxL, dragState.origLeft + dx));
    const nextT = Math.max(SAFE_Y, Math.min(maxT, dragState.origTop + dy));

    el.style.left = nextL + 'px';
    el.style.top = nextT + 'px';
    el.style.right = 'auto';
  };

  const onMouseUp = () => {
    if (!dragState) return;
    const wasMoved = dragState.moved;
    const target = dragState.el;
    dragState = null;
    dragHeader.style.cursor = 'grab';
    if (wasMoved) {
      const rect = target.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      if (centerX >= window.innerWidth / 2) {
        posState = {
          anchor: 'right',
          offsetX: Math.max(SAFE_X, Math.round(window.innerWidth - rect.right)),
          top: Math.max(SAFE_Y, Math.round(rect.top))
        };
      } else {
        posState = {
          anchor: 'left',
          offsetX: Math.max(SAFE_X, Math.round(rect.left)),
          top: Math.max(SAFE_Y, Math.round(rect.top))
        };
      }
      saveJson(localStorage, STORAGE_POS_KEY, posState);
      applyPositionAndClamp();
    } else if (target === pill) {
      cfg.minimized = false;
      cfg.hidden = false;
      saveJson(localStorage, STORAGE_CFG_KEY, cfg);
      syncVisibility();
      renderSnapshot();
      applyPositionAndClamp();
    }
  };

  const onWindowResize = () => {
    applyPositionAndClamp();
  };

  const onKeyDown = (e) => {
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.code === 'KeyW' || e.key === 'w' || e.key === 'W' || e.key === '∑')) {
      e.preventDefault();
      cfg.hidden = !cfg.hidden;
      if (!cfg.hidden) cfg.minimized = false;
      saveJson(localStorage, STORAGE_CFG_KEY, cfg);
      syncVisibility();
      renderSnapshot();
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', onKeyDown);

  // 按钮交互
  elCollapseBtn.addEventListener('click', () => {
    cfg.collapsed = !cfg.collapsed;
    elBody.style.display = cfg.collapsed ? 'none' : 'block';
    elCollapseBtn.textContent = cfg.collapsed ? '▼' : '▲';
    hud.classList.toggle('is-collapsed', !!cfg.collapsed);
    saveJson(localStorage, STORAGE_CFG_KEY, cfg);
    applyPositionAndClamp();
    elCollapseBtn.blur();
  });

  elMinBtn.addEventListener('click', () => {
    cfg.minimized = true;
    cfg.hidden = false;
    saveJson(localStorage, STORAGE_CFG_KEY, cfg);
    syncVisibility();
    elMinBtn.blur();
  });

  elCloseBtn.addEventListener('click', () => {
    cfg.hidden = true;
    saveJson(localStorage, STORAGE_CFG_KEY, cfg);
    syncVisibility();
    elCloseBtn.blur();
  });

  elTimeoutBtn.addEventListener('click', () => {
    const idx = TIMEOUT_OPTIONS.indexOf(cfg.timeoutSec);
    cfg.timeoutSec = TIMEOUT_OPTIONS[(idx + 1) % TIMEOUT_OPTIONS.length];
    elTimeoutBtn.textContent = `超时阈值: ${cfg.timeoutSec}s`;
    saveJson(localStorage, STORAGE_CFG_KEY, cfg);
    renderSnapshot();
  });

  elAutohealBtn.addEventListener('click', () => {
    cfg.autoHeal = !cfg.autoHeal;
    autoHealCountdown = 0;
    elAutohealBtn.textContent = `断流自愈: ${cfg.autoHeal ? '开' : '关'}`;
    elAutohealBtn.classList.toggle('is-active', cfg.autoHeal);
    saveJson(localStorage, STORAGE_CFG_KEY, cfg);
    renderSnapshot();
  });

  if (elSwarmBtn) {
    elSwarmBtn.addEventListener('click', () => {
      openSwarmBoardUI();
    });
  }

  if (elBrowserBtn) {
    elBrowserBtn.addEventListener('click', () => {
      openBrowserPaneUI();
      elBrowserBtn.blur();
    });
  }

  elWakeBtn.addEventListener('click', () => {
    const view = document.querySelector('[data-testid="conversation-view"]');
    const agentResps = view ? view.querySelectorAll('[data-testid="agent-response"]') : null;
    const lastResp = agentResps && agentResps.length > 0 ? agentResps[agentResps.length - 1] : null;
    const gate = detectUserInteractionGate(view, lastResp, true, 0, false);
    if (gate.active) {
      focusUserGateUI();
      return;
    }
    const curCid = getCascadeId();
    if (curCid) {
      const st = getTurnStore(curCid);
      st.noEffectStreak = 0;
      st.healBaselineSig = '';
      st.lastAutoHealSentTs = 0;
      persistTurnStore(st);
    }
    triggerRealWakeup('manual', latestKickPrompt);
  });

  elBgBar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const item = e.target.closest('[data-jump-cid]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    jumpToConversation(item.getAttribute('data-jump-cid'));
  });

  elRows.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const card = e.target.closest('[data-jump-cid], [data-open-swarm], [data-focus-gate="1"]');
    if (!card) return;
    const jCid = card.getAttribute('data-jump-cid');
    const isOpenSwarm = card.getAttribute('data-open-swarm') === '1';
    const isFocusGate = card.getAttribute('data-focus-gate') === '1';
    if (!jCid && !isOpenSwarm && !isFocusGate) return;
    e.preventDefault();
    e.stopPropagation();
    if (isFocusGate) {
      focusUserGateUI();
    } else if (isOpenSwarm) {
      openSwarmBoardUI();
    } else if (jCid) {
      jumpToConversation(jCid);
    }
  });

  // 挂载 SQLite 指标回调钩子
  const prevRenderMetrics = window.__ag_render_metrics;
  if (typeof prevRenderMetrics === 'function' && !prevRenderMetrics.__ag_wd_wrapped) {
    const wrapped = function (payload) {
      const res = prevRenderMetrics.apply(this, arguments);
      try {
        renderSnapshot();
      } catch {}
      return res;
    };
    wrapped.__ag_wd_wrapped = true;
    wrapped.__ag_wd_orig = prevRenderMetrics;
    window.__ag_render_metrics = wrapped;
  }

  // MutationObserver 监听真实聊天区变化
  let rafScheduled = false;
  const scheduleRender = () => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      try {
        renderSnapshot();
      } catch {}
    });
  };

  const domObs = new MutationObserver((mutations) => {
    let relevant = false;
    for (let i = 0; i < mutations.length; i++) {
      const t = mutations[i].target;
      const el = t && t.nodeType === 1 ? t : t ? t.parentElement : null;
      if (!el) continue;
      if (
        el.id === 'ag-watchdog-hud' ||
        el.id === 'ag-watchdog-dock-pill' ||
        el.id === 'ag-watchdog-reopen-btn' ||
        el.closest(
          '#ag-watchdog-hud, #ag-watchdog-dock-pill, #ag-watchdog-reopen-btn, #ag-live-metrics-pill, #ag-live-metrics-tooltip'
        )
      ) {
        continue;
      }
      relevant = true;
      break;
    }
    if (relevant) scheduleRender();
  });

  if (document.body) {
    domObs.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // 每秒刷新一次实时计时、Swarm 轮询与防卡死检测
  const tickTimer = setInterval(() => {
    if (!document.hidden) {
      try {
        renderSnapshot();
      } catch {}
    }
  }, 1000);

  renderSnapshot();

  // 注册热重载清理钩子
  window.__ag_watchdog_cleanup = () => {
    clearInterval(tickTimer);
    try {
      domObs.disconnect();
    } catch {}
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('keydown', onKeyDown);
    if (window.__ag_render_metrics && window.__ag_render_metrics.__ag_wd_orig) {
      window.__ag_render_metrics = window.__ag_render_metrics.__ag_wd_orig;
    }
    if (window.extensions && window.extensions.sendAuthorities && window.extensions.sendAuthorities.__ag_wd_orig) {
      window.extensions.sendAuthorities = window.extensions.sendAuthorities.__ag_wd_orig;
    }
    const reopenBtn = document.getElementById('ag-watchdog-reopen-btn');
    if (reopenBtn) reopenBtn.remove();
    hud.remove();
    pill.remove();
  };
})();
