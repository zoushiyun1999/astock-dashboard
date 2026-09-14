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
const os = require('os');

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/';
const OUT = process.argv[3] || '.';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9223;
// ⚠️ profile 绝不能落在仓库根：里面的 Cookies 被浏览器占用会让 `git add -A` 直接
//    fatal 掉整条发布链路（2026-09-12 晚报任务真实踩到）。放到系统临时目录。
const PROFILE = path.join(os.tmpdir(), 'edge_dbg_verify_' + Date.now());

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 90000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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

  // 手机视口（用户主用手机看）。⚠️ deviceScaleFactor 用 1 而不是 2：
  // dsf=2 + 全页高截图会让 Page.captureScreenshot 超时（无头 Edge 实测，2026-09-15）
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 900, deviceScaleFactor: 1, mobile: true
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
    // captureBeyondViewport 要配合视口高度才生效，而且要**先还原成手机高度**再量 scrollHeight：
    // 上一次截图把 height 设成了全页高，页面最小高度就被那个值撑住，直接再量只会越截越长。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 1, mobile: true });
    await sleep(200);
    const h = await ev('document.documentElement.scrollHeight');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: Math.max(900, Math.min(h, 6000)), deviceScaleFactor: 1, mobile: true });
    await sleep(400);
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
  report.defaultDateInput = await ev("(document.getElementById('datePick')||{}).value");
  report.headerDate = await ev("document.getElementById('hdDate').textContent");
  report.headerWeek = await ev("document.getElementById('hdWeek').textContent");
  report.headerStatusText = await ev("((document.getElementById('hdStatus')||{}).innerText||'').replace(/\\n/g,' ')");
  report.footerText = await ev("(document.getElementById('ftUpd')||{}).textContent");
  report.healthBar = await ev("(document.getElementById('healthBar')||{}).textContent");
  report.footer = await ev("(document.getElementById('ftUpd')||{}).textContent");

  // 顶部开销（未滚动 / 滚动后）—— 2026-09-15 把 header 从 ~190px 压到两行，
  // 这个数字以后改动时容易被悄悄改胖，所以固定测一下。
  report.headerHeight = await ev("(function(){var h=document.querySelector('header');" +
    "return {header: h.offsetHeight, topLine: (document.querySelector('.h-top')||{}).offsetHeight," +
    " statusLine: (document.querySelector('.h-status')||{}).offsetHeight};})()");
  await ev('window.scrollTo(0, 400)');
  await sleep(500);
  report.headerHeightScrolled = await ev("(function(){return {header: document.querySelector('header').offsetHeight," +
    " scrolledClass: document.body.classList.contains('scrolled')};})()");
  // ⚠️ 这里要**直接截当前视口**，不能用 shot()：shot() 会把视口设成全页高，
  //    那一步会重置滚动位置 → body.scrolled 被撤掉，截出来的还是展开态。
  {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'header_scrolled.png'), Buffer.from(r.data, 'base64'));
  }
  await ev('window.scrollTo(0, 0)');
  await sleep(400);

  // 告警条外观：正常时 display:none 不占位，所以异常态的可读性必须单独验一次
  // （深色 header 上的浅红/浅黄文字，配色错了在浅底测试里看不出来）。
  await ev("(function(){var b=document.getElementById('healthBar');" +
    "b.className='health bad';b.innerHTML='🔴 异常：🌅早报缺失、🔬验证未跑';})()");
  await sleep(250);
  report.healthAlert = await ev("(function(){var b=document.getElementById('healthBar');" +
    "return {height:b.offsetHeight, text:b.textContent, display:getComputedStyle(b).display};})()");
  {
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png', clip: { x: 0, y: 0, width: 430, height: 190, scale: 2 }
    });
    fs.writeFileSync(path.join(OUT, 'health_alert.png'), Buffer.from(r.data, 'base64'));
  }
  // 复原：重跑一次 render()（把真实健康状态渲染回来）
  await ev("stepDay(0)");
  await sleep(300);

  // 逐 Tab 截图（截图前记录该 Tab 可见区块的非空判定）+ 每个 Tab 都必须有时间选择模块
  const tabs = ['morning', 'evening', 'watchlist', 'screener', 'calendar'];
  const secIds = { morning: 'sec-morning', evening: 'sec-evening', watchlist: 'sec-watchlist', screener: 'sec-screener', calendar: 'sec-calendar' };
  report.tabRender = {};
  report.tabTimeBar = {};
  for (const t of tabs) {
    await ev("switchTab('" + t + "')");
    await sleep(500);
    const id = secIds[t];
    report.tabRender[t] = await ev(
      "(function(){var e=document.getElementById('" + id + "');return {visible: !e.classList.contains('hide'), htmlLen: e.innerHTML.length, textLen: (e.innerText||'').length};})()"
    );
    report.tabTimeBar[t] = await ev(
      "(function(){var s=document.getElementById('" + id + "');" +
      "var b=s.querySelector('.date-bar'), c=s.querySelector('.cal-bar');" +
      "return {dateBar:!!b, calBar:!!c, hasDateInput:!!s.querySelector('input[type=date]')};})()"
    );
    await shot('tab_' + t);
  }

  // 日期回看：前后一天（自然日）+ 直接跳到指定日期（含休市日 / 历史缺口日）
  await ev("switchTab('morning')");
  await sleep(300);
  const snapNav = async (tag) => ({
    step: tag,
    date: await ev("document.getElementById('hdDate').textContent"),
    week: await ev("document.getElementById('hdWeek').textContent"),
    input: await ev("(document.getElementById('datePick')||{}).value"),
    sub: await ev("(document.querySelector('.db-sub')||{}).innerText"),
    // 选中日期没有内容时，正文必须是"休市 / 无数据 / 未生成"之一（绝不能再是含糊的"待更新"）
    emptyNotice: await ev("/休市|无数据|未生成/.test(document.getElementById('sec-morning').innerText)"),
    pendingWord: await ev("/待更新/.test(document.getElementById('sec-morning').innerText)")
  });

  const nav = [];
  nav.push(await snapNav('最新一期'));
  await ev('stepDay(-1)'); await sleep(400);
  nav.push(await snapNav('-1 天'));
  await shot('history_prev1');
  await ev('stepDay(-1)'); await sleep(400);
  nav.push(await snapNav('-2 天'));
  await shot('history_prev2');

  // 跳到数据覆盖区间的第一天（大概率是"有数据的历史日"，用来验证日期选择器确实生效）
  const minD = await ev("(document.getElementById('datePick')||{}).min");
  if (minD) {
    await ev("pickDay('" + minD + "')"); await sleep(400);
    nav.push(await snapNav('pick ' + minD));
    await shot('history_pick_first');
  }
  await ev('gotoLatest()'); await sleep(400);
  nav.push(await snapNav('回到最新'));
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
