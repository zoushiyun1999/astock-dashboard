#!/usr/bin/env node
/**
 * tools/rerun_server.js —— 网页「一键补跑」的 ECS 触发端点（Plan B / Cloudflare 隧道方案）
 *
 * 为什么需要它：看板是纯静态站点（GitHub Pages），浏览器里没有任何通道能直连 ECS 执行命令。
 * 所以这个常驻服务跑在 ECS 上、监听 127.0.0.1，由 cloudflared 隧道暴露成 https://rerun.79zl.cn，
 * 网页按钮 POST 过来即可触发 `bash tools/cron.sh screener` 并回传实时状态。
 *
 * 🔴 安全模型（务必读完）：
 *   · app.js 是公开仓库的静态文件，里面任何 token 都等于公开 —— 所以**不能**靠 token 保密。
 *   · 真正的安全层是：① 命令白名单（只允许 `screener`，拒绝一切其他 task）；
 *                     ② 防重入（running 中返回 409，避免并发覆盖 data.js）；
 *                     ③ 限频（冷却期内返回 429，默认 5 分钟）；
 *                     ④ 硬超时（默认 10 分钟 kill 子进程，防止卡死）。
 *   · RERUN_KEY 只是一个「挡君子」标识：挡掉无意识的误触发和爬虫，不提供保密性。
 *     前端写死同一个值；服务端若设了环境变量 RERUN_KEY，则请求必须带且匹配，否则 403。
 *
 * 路由：
 *   POST /rerun    body {task:"screener", key:"..."}  → 触发（202 已接受 / 400/403/409/429）
 *   GET  /status   → {running, lastRun:{ts,rc,logTail,durationMs}, currentLog}
 *   GET  /health   → {ok:true}（cloudflared / 监控探活）
 *
 * 启动（ECS，由 cloudflared 隧道前置）：
 *   node /opt/astock/tools/rerun_server.js
 *   环境变量（均可选，见下方 DEFAULTS）：RERUN_PORT / RERUN_HOST / RERUN_KEY /
 *   RERUN_ALLOW_ORIGIN / RERUN_COOLDOWN_MS / RERUN_TIMEOUT_MS
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const RERUN_LOG = path.join(LOG_DIR, 'rerun.log');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  key: process.env.RERUN_KEY || '',            // 空 = 不校验 key（仅靠白名单+限频+防重入）
  allowedTasks: ['screener'],                  // 命令白名单：只允许补跑量价
  allowOrigin: process.env.RERUN_ALLOW_ORIGIN || 'https://asx.79zl.cn',
  cooldownMs: 5 * 60 * 1000,                   // 两次成功触发的最小间隔（限频）
  timeoutMs: 10 * 60 * 1000,                   // 单次执行硬超时（防卡死）
  maxLogBytes: 8 * 1024,                       // 回传日志尾大小上限
};

function logLine(msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(RERUN_LOG, '[' + new Date().toISOString() + '] ' + msg + '\n');
  } catch (e) { /* 日志失败不阻塞主流程 */ }
}

/** 构造初始状态（便于单测注入） */
function makeState() {
  return {
    running: false,
    lastRun: null,        // {ts, startedAt, rc, logTail, durationMs, task}
    currentLog: '',       // 本次运行实时日志（ring buffer）
    _timer: null,
  };
}

/**
 * 触发前的纯判定（不修改 state，便于单测）。
 * @returns {{ok:true, runId:string, task:string} | {ok:false, status:number, message:string}}
 */
function planRun(state, task, key, cfg) {
  if (!task || cfg.allowedTasks.indexOf(task) === -1) {
    return { ok: false, status: 400, message: 'task 不在白名单（只允许：' + cfg.allowedTasks.join(', ') + '）' };
  }
  if (cfg.key && key !== cfg.key) {
    return { ok: false, status: 403, message: 'key 不匹配' };
  }
  if (state.running) {
    return { ok: false, status: 409, message: '上一次补跑仍在运行，请稍后再试' };
  }
  if (state.lastRun && (Date.now() - state.lastRun.ts) < cfg.cooldownMs) {
    const wait = Math.ceil((cfg.cooldownMs - (Date.now() - state.lastRun.ts)) / 1000);
    return { ok: false, status: 429, message: '冷却中，请 ' + wait + ' 秒后再试（限频保护）' };
  }
  return { ok: true, runId: crypto.randomBytes(6).toString('hex'), task: task };
}

/** 实际执行（异步，不阻塞 HTTP 响应）。spawnImpl 可注入用于测试。 */
function runTask(state, task, cfg, spawnImpl) {
  state.running = true;
  state.currentLog = '';
  const startedAt = Date.now();
  const runId = crypto.randomBytes(6).toString('hex');

  logLine('▶ 开始补跑 ' + task + '（runId=' + runId + '）');

  const spawnFn = spawnImpl || spawn;
  const child = spawnFn('bash', ['tools/cron.sh', task], {
    cwd: ROOT,
    env: Object.assign({}, process.env),
  });

  const append = (buf) => {
    const s = buf.toString('utf8');
    state.currentLog += s;
    if (state.currentLog.length > cfg.maxLogBytes * 2) {
      state.currentLog = state.currentLog.slice(-cfg.maxLogBytes * 2);
    }
    logLine('  ' + s.replace(/\n+$/, '').replace(/\n/g, '\n  '));
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try { child.kill('SIGKILL'); } catch (e) {}
    finish(-1, '超时（>' + Math.round(cfg.timeoutMs / 1000) + 's）被强制终止');
  }, cfg.timeoutMs);
  state._timer = timer;

  function finish(rc, note) {
    if (state._timer) { clearTimeout(state._timer); state._timer = null; }
    const durationMs = Date.now() - startedAt;
    const logTail = state.currentLog.length > cfg.maxLogBytes
      ? state.currentLog.slice(-cfg.maxLogBytes)
      : state.currentLog;
    state.lastRun = {
      ts: Date.now(),
      startedAt: startedAt,
      rc: rc,
      killed: killed,
      note: note || '',
      logTail: logTail,
      durationMs: durationMs,
      task: task,
    };
    state.running = false;
    state.currentLog = '';
    logLine('■ 补跑结束 rc=' + rc + (note ? ' (' + note + ')' : '') + ' 用时 ' + Math.round(durationMs / 1000) + 's');
  }

  child.on('error', (err) => {
    if (!state.running && state.lastRun) return; // 已结束
    finish(-1, '启动失败：' + err.message);
  });
  child.on('close', (code) => {
    if (killed) return; // finish 已由 timer 调用
    finish(code === null ? -1 : code, code === 0 ? '' : '退出码非 0');
  });

  return runId;
}

/** 构造 HTTP 服务（handler 抽离便于单测） */
function createServer(state, cfg) {
  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', cfg.allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    cors(res);
    res.end(body);
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
      });
      req.on('error', () => resolve({}));
    });
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204); cors(res); return res.end(); }

    const url = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && url === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url === '/status') {
      return sendJson(res, 200, {
        running: state.running,
        lastRun: state.lastRun,
        currentLog: state.running ? state.currentLog : '',
      });
    }

    if (req.method === 'POST' && url === '/rerun') {
      const body = await readBody(req);
      const task = body && body.task;
      const key = body && body.key;
      const decision = planRun(state, task, key, cfg);
      if (!decision.ok) {
        return sendJson(res, decision.status, { error: decision.message });
      }
      const runId = runTask(state, decision.task, cfg);
      logLine('· 已接受触发 runId=' + runId);
      return sendJson(res, 202, { accepted: true, runId: runId, task: decision.task });
    }

    return sendJson(res, 404, { error: 'not found' });
  });

  return server;
}

// ── 入口 ──
if (require.main === module) {
  const cfg = Object.assign({}, DEFAULTS, {
    host: process.env.RERUN_HOST || DEFAULTS.host,
    port: parseInt(process.env.RERUN_PORT || DEFAULTS.port, 10),
    key: process.env.RERUN_KEY || DEFAULTS.key,
    allowOrigin: process.env.RERUN_ALLOW_ORIGIN || DEFAULTS.allowOrigin,
    cooldownMs: parseInt(process.env.RERUN_COOLDOWN_MS || DEFAULTS.cooldownMs, 10),
    timeoutMs: parseInt(process.env.RERUN_TIMEOUT_MS || DEFAULTS.timeoutMs, 10),
  });
  const state = makeState();
  const server = createServer(state, cfg);
  server.listen(cfg.port, cfg.host, () => {
    logLine('rerun_server 监听 ' + cfg.host + ':' + cfg.port + ' origin=' + cfg.allowOrigin +
      ' 白名单=' + cfg.allowedTasks.join(',') + (cfg.key ? ' (key 已启用)' : ' (key 未启用)'));
    console.log('[rerun_server] listening on ' + cfg.host + ':' + cfg.port);
  });
  process.on('SIGTERM', () => { try { server.close(); } catch (e) {} process.exit(0); });
  process.on('SIGINT', () => { try { server.close(); } catch (e) {} process.exit(0); });
}

module.exports = { makeState, planRun, runTask, createServer, DEFAULTS, logLine };
