#!/usr/bin/env node
/**
 * 用本机 Edge 无头模式 + DevTools 协议，真实渲染本地看板并逐 Tab 截图。
 * 零第三方依赖：Node 22 自带 fetch 与全局 WebSocket。
 *
 * 用法：node verify_page.js <url> <outDir>
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/';
const OUT = process.argv[3] || '.';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9223;
const PROFILE = path.join(OUT, 'edge_profile');

fs.mkdirSync(OUT, { recursive: true });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  let list = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      list = await r.json();
      if (list && list.some((t) => t.type === 'page')) break;
    } catch (e) {}
    await sleep(500);
  }
  if (!list) throw new Error('Edge 调试端口未就绪');
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到 page target');

  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 手机视口（用户主用手机看）
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 900, deviceScaleFactor: 2, mobile: true
  });

  await cdp.send('Page.navigate', { url: URL_ });
  // 等 load 事件
  for (let i = 0; i < 30; i++) {
    const st = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (st.result.value === 'complete') break;
    await sleep(300);
  }
  await sleep(1200);

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr);
    return r.result.value;
  };

  const shots = [];
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const f = path.join(OUT, name + '.png');
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    const kb = Math.round(fs.statSync(f).size / 1024);
    shots.push({ name, file: f, kb });
    return f;
  };

  const report = {};
  report.title = await ev('document.title');
  report.tabs = await ev("Array.from(document.querySelectorAll('.tab')).map(function(b){return b.textContent.trim()})");
  report.reportsCount = await ev('window.REPORTS.reports.length');
  report.reportDates = await ev('window.REPORTS.reports.map(function(r){return r.date})');
  report.calendarCount = await ev('(window.REPORTS.calendar||[]).length');
  report.screenerCount = await ev('(window.SCREENER||[]).length');
  report.screenerDates = await ev('(window.SCREENER||[]).map(function(s){return s.date})');
  report.defaultDateLabel = await ev("document.getElementById('navLbl').textContent");
  report.headerDate = await ev("document.getElementById('hdDate').textContent");
  report.healthBar = await ev("(document.getElementById('healthBar')||{}).textContent");
  report.footer = await ev("(document.getElementById('ftUpd')||{}).textContent");

  // 逐 Tab 截图（截图前记录该 Tab 可见区块的非空判定）
  const tabs = ['morning', 'evening', 'watchlist', 'screener', 'calendar'];
  const secIds = { morning: 'sec-morning', evening: 'sec-evening', watchlist: 'sec-watchlist', screener: 'sec-screener', calendar: 'sec-calendar' };
  report.tabRender = {};
  for (const t of tabs) {
    await ev("switchTab('" + t + "')");
    await sleep(500);
    const id = secIds[t];
    report.tabRender[t] = await ev(
      "(function(){var e=document.getElementById('" + id + "');return {visible: !e.classList.contains('hide'), htmlLen: e.innerHTML.length, textLen: (e.innerText||'').length};})()"
    );
    await shot('tab_' + t);
  }

  // 日期回看：从"最新一期"往回翻 2 天
  await ev("switchTab('morning')");
  await sleep(300);
  const nav = [];
  nav.push({ step: 0, label: await ev("document.getElementById('navLbl').textContent"), date: await ev("document.getElementById('hdDate').textContent") });
  await ev('step(-1)'); await sleep(400);
  nav.push({ step: -1, label: await ev("document.getElementById('navLbl').textContent"), date: await ev("document.getElementById('hdDate').textContent"),
             morningText: await ev("document.getElementById('sec-morning').innerText.slice(0,60)") });
  await shot('history_prev1');
  await ev('step(-1)'); await sleep(400);
  nav.push({ step: -2, label: await ev("document.getElementById('navLbl').textContent"), date: await ev("document.getElementById('hdDate').textContent") });
  await shot('history_prev2');
  await ev('step(1)'); await sleep(300);
  await ev('step(1)'); await sleep(400);
  nav.push({ step: 'back-to-newest', label: await ev("document.getElementById('navLbl').textContent"), date: await ev("document.getElementById('hdDate').textContent") });
  report.nav = nav;

  report.shots = shots;
  fs.writeFileSync(path.join(OUT, 'verify_report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));

  cdp.close();
  try { child.kill(); } catch (e) {}
  await sleep(500);
  try { process.kill(child.pid, 'SIGKILL'); } catch (e) {}
}

main().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
