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
    var scToday = !!(sc && sc.date === todayStr && sc.list && sc.list.length);

    // 状态：ok=已生成 / wait=待更新(未到点) / miss=未更新(已过点仍无) / close=休市
    function st(done, dueMin) {
      if (!trading) return 'close';
      if (done) return 'ok';
      return hm < dueMin ? 'wait' : 'miss';
    }

    return [
      { name: '早报', time: (mo && mo.generatedAt) ? mo.generatedAt.slice(11, 16) : '8:30', state: st(!!mo, 510) },
      { name: '晚报', time: (ev && ev.generatedAt) ? ev.generatedAt.slice(11, 16) : '21:00', state: st(!!ev, 1260) },
      { name: '量价选股', time: (scToday && sc.runAt) ? sc.runAt.slice(11, 16) : '14:30', state: st(scToday, 870) },
      { name: '投资日历', time: (cal.length && cal[0].publishedAt) ? cal[0].publishedAt.slice(5, 10) : '', state: cal.length ? 'ok' : 'wait' }
    ];
  }

  function sectionCard(title, color, inner) {
    return '<div class="card"><h3><span class="dot" style="background:' + color + '"></span>' + esc(title) + '</h3>' + inner + '</div>';
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
      html += sectionCard('要闻简讯', '#0F172A', '<ul class="news">' + lis + '</ul>');
    }

    // 盘前人气股
    if (s['盘前人气股']) {
      var plats = s['盘前人气股'];
      var keys = ['韭研公社', '同花顺', '东方财富', '淘股吧'];
      var rows = keys.filter(function (k) { return plats[k]; }).map(function (k, i) {
        return '<div class="row"><span class="plat' + (i === 0 ? ' b1' : '') + '">' + esc(k) + '</span><span class="stocks">' + esc(plats[k]) + '</span></div>';
      }).join('');
      if (rows) html += sectionCard('盘前人气股', '#6741d9', '<div class="hot">' + rows + '</div>');
    }

    // 重点公告
    if (s['重点公告'] && s['重点公告'].length) {
      var lis2 = s['重点公告'].map(function (t) {
        var warn = /⚠️|风险|退市/.test(t);
        return '<li class="' + (warn ? 'warn' : '') + '"><span class="bullet"></span><span>' + esc(t) + '</span></li>';
      }).join('');
      html += sectionCard('重点公告', '#f59f00', '<ul class="ann">' + lis2 + '</ul>');
    }

    // 今日新股
    if (s['今日新股']) {
      html += sectionCard('今日新股', '#0ca678', '<div style="font-size:13.5px">' + esc(s['今日新股']) + '</div>');
    }

    html += linkRow(r.sourceUrl, '🔗 原文：' + esc(r.title || '开盘必读'));
    return html;
  }

  /* ── 晚报渲染 ── */
  function renderEvening(r) {
    if (!r) return emptyCard('晚报待更新', '每天 21:00 自动生成，先看看早报吧');
    var html = '';

    // 博主观点（每位博主的核心思路总结，放在最前）
    if (r['博主观点'] && r['博主观点'].length) {
      var views = r['博主观点'].map(function (v) {
        return '<div class="blogger-view">' +
          '<div class="blogger-name">🗣️ ' + esc(v.author) + '</div>' +
          '<div class="blogger-text">' + esc(v.view) + '</div>' +
          '</div>';
      }).join('');
      html += sectionCard('博主观点', '#6741d9', views);
    }

    // 大盘概况
    if (r['大盘概况']) {
      var m = r['大盘概况'];
      var metHtml = '';
      if (m.metrics && m.metrics.length) {
        metHtml = '<div class="metrics">' + m.metrics.map(function (x) {
          var cls = x.up === true ? ' up' : (x.up === false ? ' down' : '');
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
      html += sectionCard('大盘概况', '#e03131', metHtml + sumHtml);
    }

    // 连板梯队
    if (r['连板梯队'] && r['连板梯队'].length) {
      var lis = r['连板梯队'].map(function (t) {
        var m2 = t.match(/^(\d+板[：:])/);
        var board = m2 ? m2[1] : '连板';
        return '<li><span class="board">' + esc(board) + '</span><span>' + esc(t.replace(/^\d+板[：:]/, '')) + '</span></li>';
      }).join('');
      html += sectionCard('连板梯队', '#d9480f', '<ul class="ladder">' + lis + '</ul>');
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
      html += sectionCard('板块热点', '#f08c00', secs);
    }

    // 市场情绪
    if (r['市场情绪']) {
      html += sectionCard('市场情绪', '#1971c2', '<div class="mood">' + esc(r['市场情绪']) + '</div>');
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

  /** 推荐股次日/当日实际表现标记 */
  function verifyBadge(v) {
    if (!v) return '';
    if (v.hit === null || v.hit === undefined) {
      return '<span class="st-verify v-none">⏸ 停牌</span>';
    }
    var cls = v.hit ? 'v-up' : 'v-down';
    return '<span class="st-verify ' + cls + '">' + (v.hit ? '✅' : '❌') +
      (v.gain > 0 ? '+' : '') + esc(v.gain) + '%</span>';
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
      html += sectionCard('今日可关注 · 来自早报', '#1971c2',
        '<div class="wl-desc">早盘 8:30 生成 · 盘前人气股 + 公告利好 · 共 ' + today.length + ' 只，带状态标签</div>' +
        '<ul class="watch watch-today">' + today.map(todayLi).join('') + '</ul>');
    }

    if (tmr.length) {
      var cards = tmr.map(pickCard).join('');
      var cnt = tmr.reduce(function (n, g) { return n + (g.picks || []).length; }, 0);
      html += sectionCard('明日可关注 · 来自晚报', '#7048e8',
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
    return sectionCard('📈 近期重复推荐（近7日）', '#0ca678',
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

    // 原图展示
    if (c.images && c.images.length) {
      var imgs = c.images.map(function (src) {
        return '<img src="' + esc(src) + '" class="cal-img" alt="投资日历原图">';
      }).join('');
      html += sectionCard('日历原图', '#e03131', '<div class="cal-gallery">' + imgs + '</div>');
    }

    // 事件列表
    var evs = (c.events || []).map(function (x) {
      if (typeof x === 'string') return '<li><span class="dt">近期</span><span>' + esc(x) + '</span></li>';
      return '<li><span class="dt">' + esc(x.date) + '</span><span>' + esc(x.event) + '</span></li>';
    }).join('');
    html += sectionCard('事件日历', '#f59f00', '<ul class="cal">' + evs + '</ul>');
    return html;
  }

  window.showCal = function (i) {
    calIdx = i;
    document.getElementById('sec-calendar').innerHTML = renderCalendar();
  };

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

    return sectionCard('量价选股 · ' + esc(sc.date), '#1971c2',
      picker +
      '<div class="wl-desc">全市场 ' + esc(sc.count) + ' 只符合条件 · 更新于 ' + esc(sc.runAt) + '</div>' +
      '<div class="sc-conds">' + cond + '</div>' +
      '<div class="sc-wrap"><table class="sc-table">' +
      '<thead><tr><th>#</th><th>名称</th><th>板块</th><th>涨幅</th><th>换手</th><th>市值</th><th>量比</th><th>连阳</th><th>均线上</th></tr></thead>' +
      '<tbody>' + scRowsHtml(rows) + '</tbody></table></div>') +
      '<div class="card tip"><span class="ico">📌</span><span>纯技术面条件筛选，不含题材与基本面判断，仅供盯盘参考，不构成投资建议。带板块标签的为当日主线/博主看好个股。</span></div>';
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

  /** 晚报未读红点：最新一期有晚报且用户尚未查看时显示 */
  function updateEveningDot() {
    var dot = document.getElementById('eveningDot');
    if (!dot) return;
    var newest = list[list.length - 1];
    var hasEvening = !!(newest && newest.evening);
    var seen;
    try { seen = localStorage.getItem('lastSeenEvening'); } catch (e) {}
    dot.classList.toggle('show', hasEvening && seen !== newest.date);
  }

  function switchTab(tab) {
    if (TABS.indexOf(tab) < 0) tab = 'morning';
    curTab = tab;
    try { localStorage.setItem('curTab', tab); } catch (e) {}
    if (tab === 'evening') {
      var newest = list[list.length - 1];
      if (newest) { try { localStorage.setItem('lastSeenEvening', newest.date); } catch (e) {} }
    }
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
        var timeHtml = (s.state === 'close') ? '' : (s.time ? ' ' + s.time : '');
        return '<i class="st-dot ' + s.state + '"></i>' + s.name + timeHtml + ' <span class="st-state">' + label + '</span>';
      }).join('<br>');
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
    upd.textContent = newest ? srcMeta(newest).map(function (s) { return s.name + (s.time ? ' ' + s.time : ''); }).join(' · ') : '—';
    renderHealth();
    updateDateNav();
    positionGlider();
    updateEveningDot();
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
    if (!newest || !newest.morning) { if (h >= 570) issues.push('🌅早报缺失'); }
    if (!newest || !newest.evening) { if (h >= 1290) issues.push('🌙晚报缺失'); }
    var sc = screenerList()[0];
    if (!sc || sc.date !== todayStr) { if (h >= 900) issues.push('🔍量价未更新'); }
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
  }, { passive: true });

  // 窗口尺寸变化时重新定位滑动下划线
  window.addEventListener('resize', positionGlider);

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
