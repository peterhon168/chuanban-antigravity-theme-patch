#!/usr/bin/env node
/**
 * Antigravity 三模型协作模式与 GEMINI.md 策略同步状态桥 (bridge-server.mjs)
 * 跨平台支持 Windows / macOS / Linux，仅监听 127.0.0.1:19876。
 */

import fs from 'node:fs';
import http from 'node:http';
import {
  STATE_PATH,
  readState,
  applyPolicyToGeminiMd,
  normalizePolicyName
} from './policy-manager.mjs';

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.AG_COLLAB_BRIDGE_PORT || '19876', 10) || 19876;
const MAX_BODY_BYTES = 4096;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true'
  });
  res.end(body);
}

function checkAlreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: '/health', timeout: 800 },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          try {
            const obj = JSON.parse(raw);
            if (res.statusCode === 200 && obj?.service === 'ag-collab-bridge' && typeof obj?.policy === 'string') {
              resolve('same-service');
              return;
            }
          } catch {}
          resolve('other-service');
        });
      }
    );
    req.on('error', () => resolve('not-listening'));
    req.on('timeout', () => {
      req.destroy();
      resolve('not-listening');
    });
  });
}

const probe = await checkAlreadyRunning();
if (probe === 'same-service') {
  process.exit(0);
}
if (probe === 'other-service') {
  console.error(`[collab-bridge] Port ${PORT} is already occupied by another service.`);
  process.exit(1);
}

if (!fs.existsSync(STATE_PATH)) {
  try {
    applyPolicyToGeminiMd('gemini', { mode: 'A', source: 'init', lockMs: 0 });
  } catch {}
}

function readJsonBody(req, res, onParsed) {
  let bytes = 0;
  const chunks = [];
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { ok: false, error: 'Payload too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    try {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      const body = text ? JSON.parse(text) : {};
      onParsed(body);
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
    }
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const pathname = reqUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    const cur = readState();
    sendJson(res, 200, {
      ok: true,
      service: 'ag-collab-bridge',
      mode: cur.mode,
      policy: cur.policy,
      policyLockUntil: cur.policyLockUntil,
      updatedAt: cur.updatedAt,
      pid: process.pid
    });
    return;
  }

  if (req.method === 'GET' && (pathname === '/mode' || pathname === '/policy')) {
    const cur = readState();
    sendJson(res, 200, {
      ok: true,
      ...cur
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/mode') {
    readJsonBody(req, res, (body) => {
      const nextMode = typeof body?.mode === 'string' ? body.mode.trim().toUpperCase() : '';
      if (nextMode !== 'A' && nextMode !== 'B') {
        sendJson(res, 400, { ok: false, error: 'mode must be "A" or "B"' });
        return;
      }
      const explicitPol = normalizePolicyName(body?.policy);
      const targetPolicy = explicitPol || (nextMode === 'B' ? 'opus' : 'gemini');
      const lockMs = nextMode === 'B' ? 180000 : 0;
      const result = applyPolicyToGeminiMd(targetPolicy, {
        mode: nextMode,
        lockMs,
        source: body?.source || `hud:mode-${nextMode}`
      });
      sendJson(res, 200, {
        ok: true,
        switchedGeminiMd: result.switched,
        ...result.state
      });
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/policy') {
    readJsonBody(req, res, (body) => {
      const targetPolicy = normalizePolicyName(body?.policy);
      if (!targetPolicy) {
        sendJson(res, 400, { ok: false, error: 'policy must be "gemini", "opus", or "sonnet"' });
        return;
      }
      const lockMs =
        typeof body?.lockMs === 'number'
          ? body.lockMs
          : targetPolicy === 'gemini'
            ? 0
            : 300000;
      const result = applyPolicyToGeminiMd(targetPolicy, {
        lockMs,
        source: body?.source || `hud:policy-${targetPolicy}`
      });
      sendJson(res, 200, {
        ok: true,
        switchedGeminiMd: result.switched,
        ...result.state
      });
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.on('error', (err) => {
  console.error('[collab-bridge] Server error:', err?.message || err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // 保持后台常驻监听
});
