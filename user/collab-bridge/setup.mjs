#!/usr/bin/env node
/**
 * 跨平台一键部署脚本 (user/collab-bridge/setup.mjs)
 * 支持 Windows / macOS / Linux：
 *   1. 将 collab-bridge（含 gemini / opus v2 / sonnet v2 三套策略模板与封装工具）部署至 ~/.gemini/collab-bridge/
 *   2. 自动生成当前系统对应的包装器 (.cmd 或可执行 shell 脚本)
 *   3. 同步 opus-agent.md / sonnet-agent.md 至 ~/.gemini/config/agents/
 *   4. 无损合并 collab-mode-router 至 ~/.gemini/config/hooks.json（保留设备原有其它 Hook）
 *   5. 配置开机自启（Windows Startup VBS / macOS LaunchAgent / Linux systemd user）并拉起后台状态桥
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME_DIR = os.homedir();
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const GEMINI_DIR = path.join(HOME_DIR, '.gemini');
const TARGET_DIR = path.join(GEMINI_DIR, 'collab-bridge');
const CONFIG_DIR = path.join(GEMINI_DIR, 'config');
const AGENTS_DIR = path.join(CONFIG_DIR, 'agents');
const HOOKS_JSON_PATH = path.join(CONFIG_DIR, 'hooks.json');
const GEMINI_MD_PATH = path.join(GEMINI_DIR, 'GEMINI.md');

function copyDirRecursive(src, dest) {
  if (path.resolve(src) === path.resolve(dest)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  if (!IS_WIN) {
    try {
      fs.chmodSync(filePath, 0o755);
    } catch {}
  }
}

function generatePlatformWrappers() {
  const binDir = path.join(TARGET_DIR, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  if (IS_WIN) {
    writeExecutable(
      path.join(TARGET_DIR, 'pre-invocation-hook.cmd'),
      '@echo off\r\nnode "%~dp0pre-invocation-hook.mjs"\r\n'
    );
    writeExecutable(
      path.join(TARGET_DIR, 'pre-tool-use-hook.cmd'),
      '@echo off\r\nnode "%~dp0pre-tool-use-hook.mjs"\r\n'
    );
    writeExecutable(
      path.join(binDir, 'codex-worker.cmd'),
      '@echo off\r\nnode "%~dp0codex-worker.mjs" %*\r\n'
    );
    writeExecutable(
      path.join(binDir, 'agy-ask.cmd'),
      '@echo off\r\nnode "%~dp0agy-ask.mjs" %*\r\n'
    );
  } else {
    writeExecutable(
      path.join(TARGET_DIR, 'pre-invocation-hook.sh'),
      '#!/usr/bin/env sh\nexec node "$(dirname "$0")/pre-invocation-hook.mjs"\n'
    );
    writeExecutable(
      path.join(TARGET_DIR, 'pre-tool-use-hook.sh'),
      '#!/usr/bin/env sh\nexec node "$(dirname "$0")/pre-tool-use-hook.mjs"\n'
    );
    writeExecutable(
      path.join(binDir, 'codex-worker'),
      '#!/usr/bin/env sh\nexec node "$(dirname "$0")/codex-worker.mjs" "$@"\n'
    );
    writeExecutable(
      path.join(binDir, 'agy-ask'),
      '#!/usr/bin/env sh\nexec node "$(dirname "$0")/agy-ask.mjs" "$@"\n'
    );
  }
}

function installAgents() {
  const srcAgents = path.join(TARGET_DIR, 'agents');
  if (!fs.existsSync(srcAgents)) return [];
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const installed = [];
  for (const fn of fs.readdirSync(srcAgents)) {
    if (!fn.endsWith('.md')) continue;
    const dest = path.join(AGENTS_DIR, fn);
    fs.copyFileSync(path.join(srcAgents, fn), dest);
    installed.push(fn);
  }
  return installed;
}

function mergeHooksJson() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  let hooksObj = {};
  if (fs.existsSync(HOOKS_JSON_PATH)) {
    try {
      const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf8').replace(/^\uFEFF/, '').trim();
      if (raw) hooksObj = JSON.parse(raw);
    } catch {
      const bak = `${HOOKS_JSON_PATH}.bak.${Date.now()}`;
      fs.copyFileSync(HOOKS_JSON_PATH, bak);
      hooksObj = {};
    }
  }

  const preInvCmd = path
    .join(TARGET_DIR, IS_WIN ? 'pre-invocation-hook.cmd' : 'pre-invocation-hook.sh')
    .replace(/\\/g, '/');
  const preToolCmd = path
    .join(TARGET_DIR, IS_WIN ? 'pre-tool-use-hook.cmd' : 'pre-tool-use-hook.sh')
    .replace(/\\/g, '/');

  hooksObj['collab-mode-router'] = {
    PreInvocation: [
      {
        type: 'command',
        command: preInvCmd,
        timeout: 5
      }
    ],
    PreToolUse: [
      {
        matcher: 'swarm|post_message|run_command',
        hooks: [
          {
            type: 'command',
            command: preToolCmd,
            timeout: 5
          }
        ]
      }
    ]
  };

  fs.writeFileSync(HOOKS_JSON_PATH, JSON.stringify(hooksObj, null, 2) + '\n', 'utf8');
  return Object.keys(hooksObj);
}

function setupAutostartAndStartBridge() {
  const nodeExe = process.execPath;
  const serverScript = path.join(TARGET_DIR, 'bridge-server.mjs');

  if (IS_WIN) {
    // 先结束旧的 bridge-server.mjs 进程以便加载新版
    try {
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*collab-bridge*bridge-server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        ],
        { windowsHide: true, timeout: 4000 }
      );
    } catch {}

    const vbsContent = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run """${nodeExe}"" ""${serverScript}""", 0, False`,
      ''
    ].join('\r\n');

    const localVbs = path.join(TARGET_DIR, 'StartCollabBridge.vbs');
    fs.writeFileSync(localVbs, vbsContent, 'utf8');

    const startupDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      : '';
    let startupVbs = '';
    if (startupDir && fs.existsSync(startupDir)) {
      startupVbs = path.join(startupDir, 'AntigravityCollabBridge.vbs');
      fs.writeFileSync(startupVbs, vbsContent, 'utf8');
    }

    try {
      spawnSync('explorer.exe', [localVbs], { windowsHide: true, timeout: 3000 });
    } catch {
      try {
        const child = spawn('wscript.exe', [localVbs], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      } catch {}
    }
    return { platform: 'win32', localVbs, startupVbs };
  }

  if (IS_MAC) {
    const launchAgentsDir = path.join(HOME_DIR, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    const plistPath = path.join(launchAgentsDir, 'com.chuanban.antigravity.collab-bridge.plist');
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.chuanban.antigravity.collab-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExe}</string>
    <string>${serverScript}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(TARGET_DIR, 'bridge.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(TARGET_DIR, 'bridge.err.log')}</string>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plistContent, 'utf8');
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
      execSync(`launchctl load -w "${plistPath}" 2>/dev/null || true`);
    } catch {}
    return { platform: 'darwin', plistPath };
  }

  // Linux
  try {
    const systemdDir = path.join(HOME_DIR, '.config', 'systemd', 'user');
    fs.mkdirSync(systemdDir, { recursive: true });
    const svcPath = path.join(systemdDir, 'antigravity-collab-bridge.service');
    const svcContent = `[Unit]
Description=Antigravity Collab Mode & Policy Bridge

[Service]
ExecStart="${nodeExe}" "${serverScript}"
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(svcPath, svcContent, 'utf8');
    execSync('systemctl --user daemon-reload && systemctl --user enable --now antigravity-collab-bridge.service 2>/dev/null || true');
    return { platform: 'linux', svcPath };
  } catch {
    const child = spawn(nodeExe, [serverScript], { detached: true, stdio: 'ignore' });
    child.unref();
    return { platform: 'linux-detached' };
  }
}

function waitForHealth(maxWaitMs = 3000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get(
        { host: '127.0.0.1', port: 19876, path: '/health', timeout: 600 },
        (res) => {
          let raw = '';
          res.on('data', (c) => {
            raw += c;
          });
          res.on('end', () => {
            try {
              const data = JSON.parse(raw);
              if (res.statusCode === 200 && data?.ok) {
                resolve(data);
                return;
              }
            } catch {}
            retryOrFail();
          });
        }
      );
      req.on('error', retryOrFail);
      req.on('timeout', () => {
        req.destroy();
        retryOrFail();
      });
    };

    const retryOrFail = () => {
      if (Date.now() - start >= maxWaitMs) {
        resolve({ ok: false });
      } else {
        setTimeout(tryOnce, 250);
      }
    };

    tryOnce();
  });
}

// 1. 同步文件至 ~/.gemini/collab-bridge
copyDirRecursive(__dirname, TARGET_DIR);

// 2. 备份设备原有 GEMINI.md（若尚未备份过）
const deviceBackupPath = path.join(TARGET_DIR, 'policies', 'GEMINI.md.device-backup');
if (fs.existsSync(GEMINI_MD_PATH) && !fs.existsSync(deviceBackupPath)) {
  try {
    fs.copyFileSync(GEMINI_MD_PATH, deviceBackupPath);
  } catch {}
}

// 3. 生成跨平台包装器、安装 agents、合并 hooks.json
generatePlatformWrappers();
const agentsInstalled = installAgents();
const activeHooks = mergeHooksJson();

// 4. 初始化默认模式与 GEMINI.md 策略
const pmUrl = pathToFileURL(path.join(TARGET_DIR, 'policy-manager.mjs')).href;
const pm = await import(pmUrl);
const curState = pm.readState();
const initRes = pm.applyPolicyToGeminiMd(curState.policy || 'gemini', {
  mode: curState.mode || 'A',
  source: 'setup'
});

// 5. 配置自启并拉起后台状态桥
const autostart = setupAutostartAndStartBridge();
const health = await waitForHealth(3200);

console.log(
  '[CollabBridge Setup]',
  JSON.stringify(
    {
      ok: !!health.ok,
      targetDir: TARGET_DIR,
      policiesIncluded: ['gemini.md', 'opus.md', 'sonnet.md', 'common-footer.md'],
      agentsInstalled,
      activeHooks,
      initialState: initRes.state,
      autostart,
      bridgeHealth: health
    },
    null,
    2
  )
);
