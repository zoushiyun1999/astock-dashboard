/* ============================================================
   A股速览 · 渲染逻辑
   ------------------------------------------------------------
   编辑指南：
   · 数据来源：同目录下 data.js（由定时任务自动写入，勿手改）
   · 想调整某个板块的展示方式 → 找到 renderMorning / renderEvening
   · 想改 tab / 日期切换行为 → switchTab / step / render
   ============================================================ */
(function () {
  'use strict';

  var list = ((window.REPORTS && window.REPORTS.reports) || []).slice().sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; // 按日期升序，最新在末尾
  });
  var idx = list.length - 1;           // 当前展示哪一天（默认最新）
  var curTab = 'morning';

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /* 数据源「到期时间」（当天分钟数）= 任务开始时间 + 约 10 分钟运行余量。
     早报 08:30→520(8:40) ／ 晚报 21:00→1270(21:10) ／ 量价选股 15:10→920(15:20)
     ／ 次日验证 21:30→1300(21:40)
     ⚠️ 只在这里定义一次。原先 srcMeta() 和 renderHealth() 各写一套数字，
        改任务时间时改了一处漏了另一处 —— 结果健康条每天 15:00 就误报"量价未更新"。
     新任务的改动请先改这里，再改 page 上的文案。 */
  var DUE = { morning: 520, evening: 1270, screener: 920, verify: 1300 };
  function fmtDate(ds) {
    var p = ds.split('-');
    return { ymd: p[0] + '年' + +p[1] + '月' + +p[2] + '日', week: WEEK[new Date(+p[0], +p[1] - 1, +p[2]).getDay()] };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 判断今天是否交易日（周末 + 节假日休市） */
  function isTradingToday() {
    var now = new Date();
    var w = now.getDay();
    if (w === 0 || w === 6) return false;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    var years = window.TRADE_HOLIDAYS || {};
    var list = years[String(now.getFullYear())] || [];
    return list.indexOf(today) < 0;
  }

  /** 量价选股历史（screener 现为数组，最新在前；兼容旧的单对象结构） */
  function screenerList() {
    var raw = window.SCREENER || (window.REPORTS && window.REPORTS.screener);
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  /** 今天（本地）的日期串 YYYY-MM-DD */
  function todayYmd() {
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  /** 量价选股今天跑过没？判据**只看日期**（不看 list.length）：
   *  写 {date:today,count:0,list:[]} = 任务跑了、只是选出 0 只，应判"已更新"。
   *  「有没有票」是 renderScreener() 的事，不该影响"任务跑没跑"的判定（P2-3）。
   *  srcMeta() 与 renderHealth() 共用此函数，杜绝两处判据不一致。
   *  ⚠️ 必须保持顶层 `function name(){}` 形态 —— test_health_logic.js 按大括号配对抽源码。 */
  function scRanToday() {
    var sc = screenerList()[0];
    return !!(sc && sc.date === todayYmd());
  }

  /** 次日验证今天跑过没？扫描所有推荐，是否存在 verify.at === 今天（P1-3）。
   *  verify.js 每天 21:30 给推荐股写 verify.at = 当天。 */
  function verifyRanToday() {
    var t = todayYmd();
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (!rec) continue;
      var groups = [];
      if (rec.morning && rec.morning['今日关注']) groups.push(rec.morning['今日关注']);
      if (rec.evening && rec.evening['明日关注']) {
        rec.evening['明日关注'].forEach(function (g) { if (g && g.picks) groups.push(g.picks); });
      }
      for (var j = 0; j < groups.length; j++) {
        for (var k = 0; k < groups[j].length; k++) {
          var p = groups[j][k];
          if (p && p.verify && p.verify.at === t) return true;
        }
      }
    }
    return false;
  }

  /** 汇总各数据源的时间与状态（供顶部状态区与 footer 使用） */
  function srcMeta(r) {
    var sc = screenerList()[0];
    var cal = (window.REPORTS && window.REPORTS.calendar) || [];
    var mo = r && r.morning, ev = r && r.evening;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var now = new Date();
    var todayStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    var hm = now.getHours() * 60 + now.getMinutes();
    var trading = isTradingToday();
    var scToday = scRanToday();   // 只看日期（P2-3），与 renderHealth 同判据

    // 状态：ok=已生成 / wait=待更新(未到点) / miss=未更新(已过点仍无) / close=休市
    function st(done, dueMin) {
      if (!trading) return 'close';
      if (done) return 'ok';
      return hm < dueMin ? 'wait' : 'miss';
    }

    // planned=true 表示 time 是「计划时间」（任务还没跑，拿计划点兜底），不是真实生成时间。
    // 不加这个标记的话，「量价选股 15:10」和「早报 08:33」外观一样，会被读成"15:10 更新过"。
    function row(name, at, done, due, plannedAt) {
      return {
        name: name,
        time: at ? String(at).slice(11, 16) : (plannedAt || ''),
        planned: !at && !!plannedAt,
        state: st(done, due)
      };
    }

    return [
      row('早报', mo && mo.generatedAt, !!mo, DUE.morning, '8:30'),
      row('晚报', ev && ev.generatedAt, !!ev, DUE.evening, '21:00'),
      row('量价选股', scToday && sc.runAt, scToday, DUE.screener, '15:10'),
      row('次日验证', '', verifyRanToday(), DUE.verify, '21:30'),
      {
        name: '投资日历',
        time: (cal.length && cal[0].publishedAt) ? cal[0].publishedAt.slice(5, 10) : '',
        planned: false,
        state: cal.length ? 'ok' : 'wait'
      }
    ];
  }

  /** header / footer 里展示某一行数据源的时间（计划时间加标注，免被误读成真实更新时间） */
  function metaTime(s) {
    if (!s.time) return '';
    return s.time + (s.planned ? '(计划)' : '');
  }

  /* 卡片标题点：颜色一律走 CSS 语义变量，不在 JS 里写死色值。
     传入的是「语义名」，由 style.css 的 [data-dot=...] 决定实际颜色 ——
     这样换配色只需要改一处，也避免再出现"红绿被用到非价格场景"。 */
  function sectionCard(title, tone, inner) {
    return '<div class="card"><h3 data-dot="' + esc(tone) + '">' +
      '<span class="dot"></span>' + esc(title) + '</h3>' + inner + '</div>';
  }

  /* ── 早报渲染 ── */
  function renderMorning(r) {
    if (!r) return emptyCard('早报待更新', '每天 8:30 自动生成，先看看晚报吧');
    var s = r.sections || {};
    var html = '';

    // 要闻简讯
    if (s['要闻简讯'] && s['要闻简讯'].length) {
      var lis = s['要闻简讯'].map(function (t, i) {
        if (i === 0) return '<li class="headline"><span class="hl-tag">头条</span><span>' + esc(t) + '</span></li>';
        return '<li><span class="idx">' + (i + 1) + '</span><span>' + esc(t) + '</span></li>';
      }).join('');
      html += sectionCard('要闻简讯', 'brand', '<ul class="news">' + lis + '</ul>');
    }

    // 盘前人气股
    if (s['盘前人气股']) {
      var plats = s['盘前人气股'];
      var keys = ['韭研公社', '同花顺', '东方财富', '淘股吧'];
      var rows = keys.filter(function (k) { return plats[k]; }).map(function (k, i) {
        return '<div class="row"><span class="plat' + (i === 0 ? ' b1' : '') + '">' + esc(k) + '</span><span class="stocks">' + esc(plats[k]) + '</span></div>';
      }).join('');
      if (rows) html += sectionCard('盘前人气股', 'violet', '<div class="hot">' + rows + '</div>');
    }

    // 重点公告
    if (s['重点公告'] && s['重点公告'].length) {
      var lis2 = s['重点公告'].map(function (t) {
        var warn = /⚠️|风险|退市/.test(t);
        return '<li class="' + (warn ? 'warn' : '') + '"><span class="bullet"></span><span>' + esc(t) + '</span></li>';
      }).join('');
      html += sectionCard('重点公告', 'amber', '<ul class="ann">' + lis2 + '</ul>');
    }

    // 今日新股
    if (s['今日新股']) {
      // 今日新股：结构色（藏青），不用绿色 —— 绿色已被价格层占用
      html += sectionCard('今日新股', 'info', '<div style="font-size:14px">' + esc(s['今日新股']) + '</div>');
    }

    html += linkRow(r.sourceUrl, '🔗 原文：' + esc(r.title || '开盘必读'));
    return html;
  }

  /* ── 晚报渲染 ── */
  function renderEvening(r) {
    if (!r) return emptyCard('晚报待更新', '每天 21:00 自动生成，先看看早报吧');
    var html = '';

    // 博主观点（每位博主一张折叠卡，默认收起 —— 博主会增加，全展开会占满整屏）
    if (r['博主观点'] && r['博主观点'].length) {
      var bvList = r['博主观点'];
      var views = bvList.map(function (v, i) {
        var text = String(v.view || '');
        // 摘要取首行并截断：首行通常是博主的结论句，信息密度最高
        var firstLine = text.split('\n')[0];
        var peek = firstLine.length > 46 ? firstLine.slice(0, 46) + '…' : firstLine;
        if (peek === text) peek = '';       // 短到首行就是全文，不必重复显示摘要
        return '<div class="blogger-view" id="bv-' + i + '">' +
          '<button class="blogger-head" type="button" onclick="toggleBlogger(' + i + ')" aria-expanded="false" aria-controls="bv-body-' + i + '">' +
          '<span class="blogger-arrow">▶</span>' +
          '<span class="blogger-name">🗣️ ' + esc(v.author) + '</span>' +
          '<span class="blogger-meta">' + text.length + ' 字</span>' +
          '</button>' +
          (peek ? '<div class="blogger-peek" id="bv-peek-' + i + '">' + esc(peek) + '</div>' : '') +
          '<div class="blogger-body" id="bv-body-' + i + '">' +
          '<div class="blogger-text">' + esc(text) + '</div>' +
          '</div>' +
          '</div>';
      }).join('');
      var tools = '<div class="bv-tools">' +
        '<span class="bv-count">共 ' + bvList.length + ' 位博主 · 点击标题展开</span>' +
        '<button class="bv-toggle" id="bvToggle" type="button" onclick="toggleAllBlogger()">展开全部</button>' +
        '</div>';
      html += sectionCard('博主观点', 'violet', tools + views);
    }

    // 大盘概况
    if (r['大盘概况']) {
      var m = r['大盘概况'];
      var metHtml = '';
      if (m.metrics && m.metrics.length) {
        metHtml = '<div class="metrics">' + m.metrics.map(function (x) {
          // 颜色按「数值符号」判定，不只看 x.up 字段 ——
          // 字段缺失时原先静默不上色，同一行里出现"绿/灰/灰"三种呈现，用户无法解读。
          var n = parseFloat(String(x.v).replace(/[^0-9.\-]/g, ''));
          var cls = x.up === true ? ' up'
            : x.up === false ? ' down'
              : (!isNaN(n) ? (n > 0 ? ' up' : (n < 0 ? ' down' : '')) : '');
          // 炸板率是"越高越危险"的逆向指标，≥50% 标警示色
          var warn = '';
          if (/炸板/.test(x.k)) {
            var num = parseFloat(x.v);
            if (!isNaN(num) && num >= 50) warn = ' warn';
          }
          return '<div class="metric' + warn + '"><div class="k">' + esc(x.k) + '</div><div class="v' + cls + '">' + esc(x.v) + '</div>' +
            (x.d ? '<div class="d">' + esc(x.d) + '</div>' : '') + '</div>';
        }).join('') + '</div>';
      }
      var sumHtml = m.summary ? '<div class="summary">' + esc(m.summary) + '</div>' : '';
      html += sectionCard('大盘概况', 'up', metHtml + sumHtml);
    }

    // 连板梯队
    if (r['连板梯队'] && r['连板梯队'].length) {
      var lis = r['连板梯队'].map(function (t) {
        var m2 = t.match(/^(\d+板[：:])/);
        var board = m2 ? m2[1] : '连板';
        return '<li><span class="board">' + esc(board) + '</span><span>' + esc(t.replace(/^\d+板[：:]/, '')) + '</span></li>';
      }).join('');
      html += sectionCard('连板梯队', 'rank1', '<ul class="ladder">' + lis + '</ul>');
    }

    // 板块热点
    if (r['板块热点'] && r['板块热点'].length) {
      var secs = r['板块热点'].map(function (x, i) {
        return '<div class="sector">' +
          '<div class="sc-head"><span class="rank">' + (i + 1) + '</span>' +
          '<span class="nm">' + esc(x.name) + '</span>' +
          (x.strength ? '<span class="st">' + esc(x.strength) + '</span>' : '') + '</div>' +
          '<div class="stocks">' + esc(x.stocks) + '</div>' +
          (x.catalyst ? '<div class="cat"><b>催化</b>' + esc(x.catalyst) + '</div>' : '') +
          '</div>';
      }).join('');
      html += sectionCard('板块热点', 'rank3', secs);
    }

    // 市场情绪
    if (r['市场情绪']) {
      html += sectionCard('市场情绪', 'info', '<div class="mood">' + esc(r['市场情绪']) + '</div>');
    }

    // 原文链接
    var links = [];
    if (r.links) {
      Object.keys(r.links).forEach(function (k) { links.push('<a href="' + esc(r.links[k]) + '" target="_blank">🔗 ' + esc(k) + '原文</a>'); });
    }
    if (links.length) html += '<div class="link-row">' + links.join('') + '</div>';

    return html;
  }

  function emptyCard(t, s) {
    return '<div class="card empty"><div class="ico">📭</div><div class="t">' + esc(t) + '</div><div class="s">' + esc(s) + '</div></div>';
  }

  /* ── 短线关注渲染：博主看好的股（今日 / 明日 两段） ── */
  function stBadge(status) {
    if (!status) return '';
    var cls = 'st-mid';
    if (/高位|风险|断板|崩|退潮|极高|兑现|危险/.test(status)) cls = 'st-risk';
    else if (/低位|补涨|未启动|安全|未充分/.test(status)) cls = 'st-low';
    else if (/待确认|待验证|观察|待发酵|回踩/.test(status)) cls = 'st-wait';
    return '<span class="st-badge ' + cls + '">' + esc(status) + '</span>';
  }

  /** 推荐股实际表现标记
   *  主口径 = 实盘：开盘买入 → 收盘卖出（buyRet / netRet），与博主推荐口径一致
   *  次口径 = 旧 gain（验证日收盘涨跌幅，相对昨收），弱化显示并明确标注 [收盘]，
   *           避免被误读为"跟着开盘买能赚这么多"。
   *  一字板（locked）单独标记，不显示收益（买不进，收益无意义）。 */
  function verifyBadge(v) {
    if (!v) return '';
    if (v.hit === null || v.hit === undefined) {
      return '<span class="st-verify v-none">⏸ 停牌</span>';
    }
    if (v.locked) {
      return '<span class="st-verify v-none">🔒 一字板·未成交</span>';
    }
    // 实盘口径优先；老数据无 buyRet 时回退旧口径
    var hasLive = (typeof v.buyRet === 'number' && isFinite(v.buyRet));
    var r = hasLive ? v.buyRet : v.gain;
    var cls = r > 0 ? 'v-up' : r < 0 ? 'v-down' : 'v-none';
    var txt = (r > 0 ? '+' : '') + r + '%';
    var html = '<span class="st-verify ' + cls + '">' + (r > 0 ? '✅' : r < 0 ? '❌' : '➖') + txt + '</span>';
    if (hasLive && typeof v.gain === 'number' && isFinite(v.gain)) {
      html += '<span class="st-verify v-old-note v-old">' + (v.gain > 0 ? '+' : '') + v.gain + '%</span>';
    }
    return html;
  }

  function todayLi(x) {
    return '<li><div class="body">' +
      '<div class="nm">' + esc(x.name) +
      (x.sector ? '<span class="sec">' + esc(x.sector) + '</span>' : '') +
      stBadge(x.status) + verifyBadge(x.verify) + '</div>' +
      (x.reason ? '<div class="note">' + esc(x.reason) + '</div>' : '') +
      '</div></li>';
  }

  function pickLi(x, i) {
    return '<li><span class="rank">' + (i + 1) + '</span><div class="body">' +
      '<div class="nm">' + esc(x.name) +
      (x.role ? '<span class="tag">' + esc(x.role) + '</span>' : '') +
      stBadge(x.status) + verifyBadge(x.verify) + '</div>' +
      (x.reason ? '<div class="note">' + esc(x.reason) + '</div>' : '') +
      '</div></li>';
  }

  function pickCard(g, gi) {
    var picks = g.picks || [];
    var lis = picks.length
      ? '<ul class="watch">' + picks.map(pickLi).join('') + '</ul>'
      : '<div class="pick-none">该板块明日不建议参与（见上方推导）</div>';
    return '<div class="pick-card">' +
      '<div class="lg-head"><span class="pg-no">' + (gi + 1) + '</span>' +
      '<span class="lg-sector">' + esc(g.sector) + '</span>' +
      (g.stage ? '<span class="lg-stage">' + esc(g.stage) + '</span>' : '') +
      '<span class="pg-count">' + picks.length + ' 只</span></div>' +
      (g.why ? '<div class="lg-why"><b>为什么热：</b>' + esc(g.why) + '</div>' : '') +
      (g.chain ? '<div class="lg-chain"><b>博主思路：</b>' + esc(g.chain) + '</div>' : '') +
      '<div class="pick-list">' + lis + '</div>' +
      '</div>';
  }

  function renderWatchlist(r) {
    var ev = r && r.evening, mo = r && r.morning;
    var today = (mo && mo['今日关注']) || [];
    var tmr = (ev && ev['明日关注']) || [];
    if (!today.length && !tmr.length) {
      return emptyCard('短线关注待更新', '早报 8:30 出「今日可关注」，晚报 21:00 出「明日可关注」');
    }
    var html = '';

    if (today.length) {
      html += sectionCard('今日可关注 · 来自早报', 'info',
        '<div class="wl-desc">早盘 8:30 生成 · 盘前人气股 + 公告利好 · 共 ' + today.length + ' 只，带状态标签</div>' +
        '<ul class="watch watch-today">' + today.map(todayLi).join('') + '</ul>');
    }

    if (tmr.length) {
      var cards = tmr.map(pickCard).join('');
      var cnt = tmr.reduce(function (n, g) { return n + (g.picks || []).length; }, 0);
      html += sectionCard('明日可关注 · 来自晚报', 'violet',
        '<div class="wl-desc">晚盘 21:00 生成 · 博主主线板块 + 个股状态 · 共 ' + cnt + ' 只，按板块分组</div>' + cards);
    }

    html += renderHotRepeat();
    html += '<div class="card tip"><span class="ico">📌</span><span>以上为博主看好个股提炼 + 当前状态标注，仅供盯盘参考，不构成投资建议。红色状态=高位风险，绿色=低位相对安全，灰色=需验证。✅/❌ 为推荐后实际表现（次日验证）。</span></div>';
    return html;
  }

  /** 近 7 日重复被推荐的个股，体现题材持续性 */
  function renderHotRepeat() {
    var cnt = {};
    list.forEach(function (rec) {
      var adds = [];
      if (rec.morning && rec.morning['今日关注']) rec.morning['今日关注'].forEach(function (p) { if (p && p.name) adds.push(p.name); });
      if (rec.evening && rec.evening['明日关注']) rec.evening['明日关注'].forEach(function (g) {
        (g.picks || []).forEach(function (p) { if (p && p.name) adds.push(p.name); });
      });
      adds.forEach(function (n) { cnt[n] = (cnt[n] || 0) + 1; });
    });
    var rep = Object.keys(cnt).filter(function (n) { return cnt[n] >= 2; })
      .map(function (n) { return { n: n, c: cnt[n] }; })
      .sort(function (a, b) { return b.c - a.c; }).slice(0, 10);
    if (!rep.length) return '';
    var lis = rep.map(function (x) {
      return '<li><span class="rn">' + esc(x.n) + '</span><span class="rc">' + x.c + '次</span></li>';
    }).join('');
    return sectionCard('📈 近期重复推荐（近7日）', 'down',
      '<ul class="hot-rep">' + lis + '</ul>' +
      '<div class="wl-desc">被多次推荐的个股，值得重点跟踪其持续性</div>');
  }

  function linkRow(url, text) {
    if (!url) return '';
    return '<div class="link-row"><a href="' + esc(url) + '" target="_blank">' + esc(text) + '</a></div>';
  }

  /* ── 投资日历专版渲染（仅独立 Tab，不进晚报正文） ── */
  var calIdx = 0; // 当前展示第几篇日历（0 = 最新）

  function renderCalendar() {
    var cal = (window.REPORTS && window.REPORTS.calendar) || [];
    if (!cal.length) {
      return emptyCard('投资日历待更新', '「A股投资日历」博主发布月度日历后自动收录');
    }
    if (calIdx >= cal.length) calIdx = 0;
    var c = cal[calIdx];

    var html = '';
    // 日期切换（紧凑芯片，每篇一个，多篇时显示）
    if (cal.length > 1) {
      var chips = cal.map(function (p, i) {
        var ps = p.publishedAt || '';
        var m = parseInt(ps.slice(5, 7), 10);
        var d = parseInt(ps.slice(8, 10), 10);
        var label = (m && d) ? (m + '/' + d) : (ps.slice(0, 10) || ('#' + (i + 1)));
        return '<button class="cal-m' + (i === calIdx ? ' on' : '') + '" onclick="showCal(' + i + ')">' + esc(label) + '</button>';
      }).join('');
      html += '<div class="cal-months">' + chips + '</div>';
    }

    // 文章头
    html += '<div class="card cal-head"><div class="cal-author">📅 韭研公社 · <b>A股投资日历</b>（绝不追高的老韭菜）</div>' +
      '<div class="cal-title">' + esc(c.title) + '</div>' +
      '<div class="cal-meta">发布于 ' + esc(c.publishedAt) + (c.url ? ' · <a href="' + esc(c.url) + '" target="_blank">查看原文 ↗</a>' : '') + '</div></div>';

    // 原图展示 —— 2008×17040 的长图直接铺开会占 2800px 高、且压缩到 1/6 完全不可读。
    // 改为默认折叠：只留一个入口，点击后全屏看，可双指缩放。
    if (c.images && c.images.length) {
      var total = c.images.length;
      html += sectionCard('日历原图', 'up',
        '<div class="wl-desc">博主原始长图，共 ' + total + ' 张 · 点击放大查看</div>' +
        '<button class="cal-open" onclick="openCalViewer()">' +
        '<span>🖼</span><span>查看日历原图</span>' +
        '<span class="cal-open-meta">（长图 · ' + total + ' 张）</span>' +
        '</button>');
    }

    // 事件列表
    var evs = (c.events || []).map(function (x) {
      if (typeof x === 'string') return '<li><span class="dt">近期</span><span>' + esc(x) + '</span></li>';
      return '<li><span class="dt">' + esc(x.date) + '</span><span>' + esc(x.event) + '</span></li>';
    }).join('');
    html += sectionCard('事件日历', 'amber', '<ul class="cal">' + evs + '</ul>');
    return html;
  }

  window.showCal = function (i) {
    calIdx = i;
    document.getElementById('sec-calendar').innerHTML = renderCalendar();
  };

  /* ── 日历原图全屏查看器 ── */
  window.openCalViewer = function () {
    var cal = (window.REPORTS && window.REPORTS.calendar) || [];
    var c = cal[calIdx];
    if (!c || !c.images || !c.images.length) return;
    var old = document.getElementById('calViewer');
    if (old) old.parentNode.removeChild(old);

    var v = document.createElement('div');
    v.id = 'calViewer';
    v.className = 'cal-viewer';
    v.innerHTML =
      '<div class="cal-viewer-bar">' +
      '<span>' + esc(c.title || '投资日历原图') + '</span>' +
      '<span class="cv-spacer"></span>' +
      '<button onclick="closeCalViewer()">关闭</button>' +
      '</div>' +
      '<div class="cal-viewer-body">' +
      c.images.map(function (src) { return '<img src="' + esc(src) + '" alt="投资日历原图">'; }).join('') +
      '</div>' +
      '<div class="cal-viewer-tip">双指缩放可放大查看细节</div>';
    document.body.appendChild(v);
    document.body.style.overflow = 'hidden';
  };

  /* ── 博主观点折叠 ──
     博主会持续增加，正文人均 400~700 字，默认全部展开会把晚报顶到几千像素。
     默认收起（只留标题 + 字数 + 首行摘要），点标题展开单篇，或一键展开全部。 */
  function setBloggerOpen(view, open) {
    var body = view.querySelector('.blogger-body');
    var head = view.querySelector('.blogger-head');
    if (!body) return;
    view.classList.toggle('open', open);
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
    // max-height 过渡需要落到真实像素，写死一个大值会让收起动画变慢，故展开后临时放开
    if (open) {
      body.style.maxHeight = body.scrollHeight + 'px';
      // 图片/字体回流后高度可能变化，动画结束后清掉内联值，交给 CSS 的 4000px 兜底
      setTimeout(function () { body.style.maxHeight = ''; }, 300);
    } else {
      // 先固定当前高度，下一帧归零，否则从 0 到 0 没有过渡
      body.style.maxHeight = body.scrollHeight + 'px';
      requestAnimationFrame(function () { body.style.maxHeight = ''; });
    }
  }

  window.toggleBlogger = function (i) {
    var view = document.getElementById('bv-' + i);
    if (!view) return;
    setBloggerOpen(view, !view.classList.contains('open'));
    syncBloggerToggle();
  };

  window.toggleAllBlogger = function () {
    var box = document.getElementById('sec-evening');
    if (!box) return;
    var views = box.querySelectorAll('.blogger-view');
    if (!views.length) return;
    // 只要还有收起的，就全部展开；全展开时再点则全部收起
    var anyClosed = false;
    for (var i = 0; i < views.length; i++) {
      if (!views[i].classList.contains('open')) { anyClosed = true; break; }
    }
    for (var j = 0; j < views.length; j++) setBloggerOpen(views[j], anyClosed);
    syncBloggerToggle();
  };

  // 总开关文案跟随实际状态（用户单独展开/收起某一位时也要同步）
  function syncBloggerToggle() {
    var btn = document.getElementById('bvToggle');
    var box = document.getElementById('sec-evening');
    if (!btn || !box) return;
    var views = box.querySelectorAll('.blogger-view');
    if (!views.length) return;
    var openCount = 0;
    for (var i = 0; i < views.length; i++) {
      if (views[i].classList.contains('open')) openCount++;
    }
    btn.textContent = openCount === views.length ? '收起全部' : '展开全部';
  }

  window.closeCalViewer = function () {
    var v = document.getElementById('calViewer');
    if (v) v.parentNode.removeChild(v);
    document.body.style.overflow = '';
  };

  // Esc 关闭全屏看图
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') window.closeCalViewer();
  });

  /* ── 量价选股渲染（技术面条件筛选，按涨幅降序） ── */
  function scRowsHtml(arr) {
    if (!arr.length) return '<tr><td colspan="9" class="sc-empty">暂无数据</td></tr>';
    return arr.map(function (s, i) {
      var to = parseFloat(s.turnover) || 0;
      var vr = parseFloat(s.volRatio) || 0;
      var tag = (s.sector ? '<span class="sc-hot">' + esc(s.sector) + '</span>' : '') +
        ((s.sector && s.industry) ? '<br>' : '') +
        (s.industry ? '<span class="sc-ind">' + esc(s.industry) + '</span>' : '');
      return '<tr>' +
        '<td class="sc-no">' + (i + 1) + '</td>' +
        '<td class="sc-nm">' + esc(s.name) + '</td>' +
        '<td class="sc-sector">' + (tag || '<span class="sc-none">-</span>') + '</td>' +
        '<td class="sc-gain">' + (s.gain > 0 ? '+' : '') + esc(s.gain) + '%</td>' +
        '<td class="sc-num' + (to >= 10 ? ' sc-hot-val' : '') + '">' + esc(s.turnover) + '%</td>' +
        '<td class="sc-num">' + esc(s.cap) + '亿</td>' +
        '<td class="sc-num' + (vr >= 2 ? ' sc-hot-val' : '') + '">' + esc(s.volRatio) + '</td>' +
        '<td class="sc-yang">' + esc(s.yang) + '连阳</td>' +
        '<td class="sc-num">' + esc(s.aboveRate) + '%</td>' +
        '</tr>';
    }).join('');
  }

  var scIdx = 0;
  window.showSc = function (i) {
    scIdx = i;
    document.getElementById('sec-screener').innerHTML = renderScreener();
  };

  function renderScreener() {
    var hist = screenerList().filter(function (x) { return x && x.list; });
    if (!hist.length) {
      return emptyCard('量价选股待更新', '每个交易日收盘后自动筛选，先看看其他板块吧');
    }
    if (scIdx >= hist.length) scIdx = 0;
    var sc = hist[scIdx];
    if (!sc.list || !sc.list.length) {
      return emptyCard('量价选股待更新', '每个交易日收盘后自动筛选，先看看其他板块吧');
    }

    // 历史期数切换（保留最近 10 期，便于回看与策略验证）
    var picker = hist.length > 1
      ? '<div class="cal-months">' + hist.map(function (x, i) {
          return '<button class="cal-m' + (i === scIdx ? ' on' : '') + '" onclick="showSc(' + i + ')">' +
            esc(x.date.slice(5)) + ' · ' + (x.count || 0) + '只</button>';
        }).join('') + '</div>'
      : '';

    var c = sc.criteria || {};
    var cond = [
      ['涨幅', c.gain], ['换手', c.turnover], ['市值', c.cap],
      ['量比', c.volRatio], ['K线', c.yang], ['均线', c.aboveAvg], ['排除', c.exclude]
    ].filter(function (x) { return x[1]; })
      .map(function (x) { return '<span class="sc-cond"><b>' + esc(x[0]) + '</b>' + esc(x[1]) + '</span>'; })
      .join('');

    var rows = sc.list.slice().sort(function (a, b) { return (b.gain || 0) - (a.gain || 0); });

    return sectionCard('量价选股 · ' + esc(sc.date), 'info',
      picker +
      '<div class="wl-desc">全市场 ' + esc(sc.count) + ' 只符合条件 · 更新于 ' + esc(sc.runAt) + '</div>' +
      '<div class="sc-conds">' + cond + '</div>' +
      // 9 列在手机上会溢出屏外，加提示 + 右侧渐隐遮罩，告诉用户"右边还有"
      '<div class="sc-hint" id="scHint">← 左右滑动查看全部 9 项指标</div>' +
      '<div class="sc-scroller">' +
      '<div class="sc-wrap" id="scWrap"><table class="sc-table">' +
      '<thead><tr><th>#</th><th>名称</th><th>板块</th><th>涨幅</th><th>换手</th><th>市值</th><th>量比</th><th>连阳</th><th>均线上</th></tr></thead>' +
      '<tbody>' + scRowsHtml(rows) + '</tbody></table></div>' +
      '<span class="sc-fade" id="scFade"></span></div>') +
      '<div class="card tip"><span class="ico">📌</span><span>纯技术面条件筛选，不含题材与基本面判断，仅供盯盘参考，不构成投资建议。带板块标签的为当日主线/博主看好个股。</span></div>';
  }

  /** 量价表横向滚动：滚到底/不需要滚动时收起渐隐遮罩与提示 */
  function bindScHint() {
    var wrap = document.getElementById('scWrap');
    var fade = document.getElementById('scFade');
    var hint = document.getElementById('scHint');
    if (!wrap || !fade) return;
    function upd() {
      // ⚠️ 必须判 clientWidth>0：render() 时 section 还是 display:none（.hide），
      //    此时 clientWidth/scrollWidth 全为 0，"需不需要滚动"会算错成 false，
      //    遮罩和提示会被永久关掉。隐藏状态下直接返回，等切到该 Tab 再算。
      if (!wrap.clientWidth) return;
      var more = wrap.scrollWidth - wrap.clientWidth > 4;
      var atEnd = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 4;
      fade.classList.toggle('off', !more || atEnd);
      if (hint) hint.classList.toggle('off', !more);
    }
    wrap.addEventListener('scroll', upd, { passive: true });
    window.addEventListener('resize', upd);
    upd();
    // switchTab 里 section 变可见后再跑一次（此时才有真实宽度）
    window.__scHintRefresh = upd;
  }

  var TABS = ['morning', 'evening', 'watchlist', 'calendar', 'screener'];

  function updateDateNav() {
    var nav = document.querySelector('.date-nav');
    if (nav) nav.style.display = (curTab === 'screener' || curTab === 'calendar') ? 'none' : '';
  }

  function positionGlider() {
    var tabs = document.getElementById('tabs');
    var glider = document.getElementById('tabGlider');
    var active = tabs ? tabs.querySelector('.tab.on') : null;
    if (tabs && glider && active) {
      glider.style.left = active.offsetLeft + 'px';
      glider.style.width = active.offsetWidth + 'px';
    }
  }

  /** 晚报未读红点：最新一期有晚报、且用户没在"最新一期"上打开过晚报时显示 */
  function updateEveningDot() {
    var dot = document.getElementById('eveningDot');
    if (!dot) return;
    var newest = list[list.length - 1];
    var hasEvening = !!(newest && newest.evening);
    // ⚠️ 只有真正停在最新一期看晚报才算已读。
    //    以前是在 switchTab 里无脑记 list[length-1].date，导致"翻回历史日期看晚报"
    //    也会把最新一期的未读红点清掉。
    var isOnNewest = idx === list.length - 1;
    var seen = null;
    try { seen = localStorage.getItem('lastSeenEvening'); } catch (e) {}
    if (hasEvening && isOnNewest && curTab === 'evening') {
      try { localStorage.setItem('lastSeenEvening', newest.date); } catch (e) {}
      seen = newest.date;
    }
    dot.classList.toggle('show', hasEvening && seen !== newest.date);
  }

  function switchTab(tab) {
    if (TABS.indexOf(tab) < 0) tab = 'morning';
    curTab = tab;
    try { localStorage.setItem('curTab', tab); } catch (e) {}
    // 「晚报已读」的记账放在 updateEveningDot() 里统一处理（它知道当前在看哪一天）
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    document.getElementById('sec-morning').classList.toggle('hide', tab !== 'morning');
    document.getElementById('sec-evening').classList.toggle('hide', tab !== 'evening');
    document.getElementById('sec-watchlist').classList.toggle('hide', tab !== 'watchlist');
    document.getElementById('sec-calendar').classList.toggle('hide', tab !== 'calendar');
    document.getElementById('sec-screener').classList.toggle('hide', tab !== 'screener');
    updateDateNav();
    positionGlider();
    updateEveningDot();
  }

  function render() {
    var r = list[idx];
    var isNewest = idx === list.length - 1;

    // header
    var d = fmtDate(r ? r.date : '----');
    document.getElementById('hdDate').textContent = r ? d.ymd : '—';
    document.getElementById('hdWeek').textContent = r ? d.week : '';
    document.getElementById('navLbl').textContent = isNewest ? '最新一期' : '历史 · ' + (r ? r.date : '');
    document.getElementById('btnPrev').disabled = idx <= 0;
    document.getElementById('btnNext').disabled = isNewest;

    // 状态（按数据源分别展示时间与状态，圆点表示状态）
    var st = document.getElementById('hdStatus');
    if (r) {
      st.innerHTML = srcMeta(r).map(function (s) {
        var label = s.state === 'ok' ? (s.name === '投资日历' ? '已收录' : '已生成')
          : (s.state === 'wait' ? '待更新' : (s.state === 'miss' ? '未更新' : '休市'));
        var timeHtml = (s.state === 'close') ? '' : (metaTime(s) ? ' ' + metaTime(s) : '');
        // 每项一个 div（网格子项），不再用 <br> 分隔 —— 网格才能稳定 2 列
        return '<div><i class="st-dot ' + s.state + '"></i>' + s.name + timeHtml +
          ' <span class="st-state">' + label + '</span></div>';
      }).join('');
    } else {
      st.textContent = '';
    }

    // 内容
    document.getElementById('sec-morning').innerHTML = renderMorning(r ? r.morning : null);
    document.getElementById('sec-evening').innerHTML = renderEvening(r ? r.evening : null);
    document.getElementById('sec-watchlist').innerHTML = renderWatchlist(r);
    document.getElementById('sec-calendar').innerHTML = renderCalendar();
    document.getElementById('sec-screener').innerHTML = renderScreener();

    // footer（按数据源展示最新更新时间）
    var upd = document.getElementById('ftUpd');
    var newest = list[list.length - 1];
    upd.textContent = newest ? srcMeta(newest).map(function (s) {
      return s.name + (metaTime(s) ? ' ' + metaTime(s) : '');
    }).join(' · ') : '—';
    renderHealth();
    updateDateNav();
    positionGlider();
    updateEveningDot();
    bindScHint();
    // section 由 hide 变可见后，量价表的真实宽度才存在，此时刷新遮罩判定
    if (typeof window.__scHintRefresh === 'function') window.__scHintRefresh();
  }

  /** 数据健康条：基于各源最后更新时间，提示是否异常 */
  function renderHealth() {
    var bar = document.getElementById('healthBar');
    if (!bar) return;
    // 休市：节假日/周末不报警
    if (!isTradingToday()) {
      bar.className = 'health close';
      bar.innerHTML = '🔵 今日休市 · 无行情更新';
      return;
    }
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var todayStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    var h = now.getHours() * 60 + now.getMinutes();
    var newest = list[list.length - 1];
    var issues = [];

    // ① 先判"最新一期到底是不是今天"
    //    以前只查「最新一期有没有 morning/evening」—— 周一管线全挂时，最新一期还是上周五的记录，
    //    而周五的字段齐全，于是三项检查全过，健康条显示"🟢 各源运行正常"。
    //    换句话说：**越是彻底断更，越不报警**。这才是最该修的地方。
    var hasToday = !!(newest && newest.date === todayStr);
    if (!hasToday) {
      // 在没有今天任何数据的前提下，过了最早的到期点就该报（不能用晚报的 21:10，那太晚了）
      if (h >= DUE.morning) issues.push('今日无任何数据（管线可能没跑）');
    } else {
      if (!newest.morning && h >= DUE.morning) issues.push('🌅早报缺失');
      if (!newest.evening && h >= DUE.evening) issues.push('🌙晚报缺失');
    }

    // 量价：与 srcMeta() 同判据（只看日期，P2-3）；验证：新增监控项（P1-3）
    if (!scRanToday()) { if (h >= DUE.screener) issues.push('🔍量价未更新'); }
    if (h >= DUE.verify && !verifyRanToday()) issues.push('🔬验证未跑');

    var level = issues.length ? (issues.length >= 2 ? 'bad' : 'warn') : 'ok';
    bar.className = 'health ' + level;
    bar.innerHTML = level === 'ok' ? '🟢 各源运行正常' : (level === 'warn' ? '🟡 注意：' : '🔴 异常：') + issues.join('、');
  }

  window.step = function (d) {
    var n = idx + d;
    if (n < 0 || n >= list.length) return;
    idx = n;
    render();
  };
  window.switchTab = switchTab;

  render();
  // 刷新后保留上次浏览的 Tab（localStorage 持久化）
  try {
    var savedTab = localStorage.getItem('curTab');
    if (savedTab && TABS.indexOf(savedTab) >= 0) switchTab(savedTab);
    var sy = parseInt(localStorage.getItem('scroll_' + savedTab) || '0', 10);
    window.scrollTo(0, sy);
  } catch (e) {}

  // 滚动位置按 Tab 持久化
  window.addEventListener('scroll', function () {
    try { localStorage.setItem('scroll_' + curTab, String(window.scrollY)); } catch (e) {}
    // 滚动后收起 header 的品牌/日期区，把屏幕让给内容（Tab 栏本身是 sticky，会留在顶部）
    document.body.classList.toggle('scrolled', window.scrollY > 60);
  }, { passive: true });

  // 窗口尺寸变化时重新定位滑动下划线
  window.addEventListener('resize', positionGlider);

  // 博主正文里有 emoji / 长段落，字体回流会让 scrollHeight 变化，展开态重新校准高度
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      var open = document.querySelectorAll('.blogger-view.open .blogger-body');
      for (var i = 0; i < open.length; i++) open[i].style.maxHeight = open[i].scrollHeight + 'px';
    });
  }

  // 新数据轮询：先探测 version.json（几百字节），key 变了才拉全量，避免每分钟下载 170KB
  (function () {
    // 本地 file:// 打开时 fetch 会被 CORS 拦，直接跳过（数据源仍是 index.html 引入的 data.js）
    if (location.protocol === 'file:') return;

    var curKey = null;
    var POLL_MS = 60000;

    function poll() {
      fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (v) {
          if (!v || !v.key) return;
          if (curKey === null) { curKey = v.key; return; }  // 首轮只记基线
          if (v.key !== curKey) { curKey = v.key; showUpdateBar(); }
        })
        .catch(function () {});                             // 离线/异常静默，下轮再试
    }

    // 页面在后台时不轮询，回到前台立刻查一次（省电省流量）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll();
    });
    setInterval(function () { if (!document.hidden) poll(); }, POLL_MS);
    setTimeout(poll, 3000);
  })();

  /** 拉取全量数据就地替换：不整页刷新，保留当前 Tab 与浏览的日期 */
  function applyUpdate(done) {
    fetch('data.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.REPORTS) return;
        var wasNewest = idx >= list.length - 1;             // 原本停在最新一期就继续跟到最新
        var prevDate = list[idx] ? list[idx].date : null;
        window.REPORTS = j.REPORTS;
        if (j.SCREENER) window.SCREENER = j.SCREENER;
        list = ((window.REPORTS && window.REPORTS.reports) || []).slice().sort(function (a, b) {
          return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
        });
        if (wasNewest) {
          idx = list.length - 1;
        } else {
          var n = -1;
          for (var i = 0; i < list.length; i++) { if (list[i].date === prevDate) { n = i; break; } }
          idx = n >= 0 ? n : list.length - 1;
        }
        render();
      })
      .catch(function () {})
      .then(function () { if (done) done(); });
  }

  function showUpdateBar() {
    var b = document.getElementById('updateBar');
    if (!b) {
      b = document.createElement('div');
      b.id = 'updateBar';
      document.body.appendChild(b);
    }
    b.innerHTML = '📡 有新数据 · <a id="ubBtn" href="javascript:void(0)">点击更新</a>';
    b.style.display = 'block';
    var btn = document.getElementById('ubBtn');
    if (btn) {
      btn.onclick = function () {
        b.innerHTML = '⏳ 正在更新…';
        applyUpdate(function () { b.style.display = 'none'; });
      };
    }
  }

  // 调试出口：控制台可执行 __aStockDebug.applyUpdate() / .showUpdateBar() 手动触发更新
  window.__aStockDebug = { applyUpdate: applyUpdate, showUpdateBar: showUpdateBar };
})();
