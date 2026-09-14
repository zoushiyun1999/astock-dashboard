/* ============================================================
   A股速览 · 渲染逻辑
   ------------------------------------------------------------
   编辑指南：
   · 数据来源：同目录下 data.js（由定时任务自动写入，勿手改）
   · 想调整某个板块的展示方式 → 找到 renderMorning / renderEvening
   · 想改 tab 切换 → switchTab / render
   · 想改日期切换 → curDate / stepDay / pickDay / gotoLatest / setDate
     （每个 Tab 顶部的时间选择条由 dateBar() 生成，投资日历按期用 calBar()）
   · 想改"没有数据时怎么说" → emptyFor()，它区分 休市 / 历史缺口 / 今日未到点
   · 改 srcMeta() / renderHealth() / updateEveningDot() 后**必须**跑
     `node tools/test_health_logic.js`（时间相关判定，读代码极容易看走眼）
   ============================================================ */
(function () {
  'use strict';

  var list = ((window.REPORTS && window.REPORTS.reports) || []).slice().sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; // 按日期升序，最新在末尾
  });
  /* 当前选中的日期（YYYY-MM-DD），默认 = 最新一期。
     ⚠️ 用「日期字符串」而不是数组下标：可选范围不止「有数据的那几期」——
        休市日、历史缺口日也要能被选中，并明确告诉用户「当天没有数据」。
        （旧版是 idx 下标 + 前后一天，用户无法直接跳到指定日期。） */
  var curDate = list.length ? list[list.length - 1].date : todayYmd();
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

  /* ── 日期工具：一律按「本地日」处理，不做 UTC 换算 ── */
  function parseYmd(ds) {
    var p = String(ds).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function ymdOf(d) {
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function shiftYmd(ds, n) {
    var d = parseYmd(ds);
    d.setDate(d.getDate() + n);
    return ymdOf(d);
  }

  /** 任意日期是否交易日（周末 + 节假日休市）。
   *  ⚠️ window.TRADE_HOLIDAYS 是**扁平**结构 {"2026":[…]}；
   *     config/trade_holidays.json 才是 {years:{…}} —— 两者别混（test_health_logic 场景 8 守着这点）。
   *     内部变量别叫 list：会遮蔽外层的 list（历史隐患）。 */
  function isTradingDay(ds) {
    var d = parseYmd(ds);
    var w = d.getDay();
    if (w === 0 || w === 6) return false;
    var hd = window.TRADE_HOLIDAYS || {};
    var offs = hd[String(d.getFullYear())] || [];
    return offs.indexOf(ds) < 0;
  }

  /** 判断今天是否交易日 */
  function isTradingToday() {
    return isTradingDay(todayYmd());
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

  /* ── 数据覆盖范围（决定日期选择器的可选区间） ──
     取 reports（早报/晚报/短线）与 screener（量价）两个数据集的日期并集。
     区间内**任意日期都可选**（含休市日与历史缺口日），没有数据时由空态卡说明原因。 */
  function dataDates() {
    var set = {};
    list.forEach(function (r) { if (r && r.date) set[r.date] = 1; });
    screenerList().forEach(function (x) { if (x && x.date) set[x.date] = 1; });
    return Object.keys(set).sort();
  }
  function earliestDate() {
    var ds = dataDates();
    return ds.length ? ds[0] : todayYmd();
  }
  function latestDate() {
    return list.length ? list[list.length - 1].date : earliestDate();
  }

  /** 按日期取 reports 记录（可能为空：休市日 / 历史缺口日） */
  function findReport(ds) {
    for (var i = 0; i < list.length; i++) { if (list[i] && list[i].date === ds) return list[i]; }
    return null;
  }

  /** 指定日期的量价选股记录（screener 是独立数据集，日期不一定与 reports 重合） */
  function screenerOn(ds) {
    var arr = screenerList();
    for (var i = 0; i < arr.length; i++) { if (arr[i] && arr[i].date === ds) return arr[i]; }
    return null;
  }

  /** 指定日期是否跑过次日验证：扫所有推荐，看有没有 verify.at === ds（P1-3）。
   *  verify.js 每个交易日 21:30 给推荐股写 verify.at = 当天。 */
  function verifyOn(ds) {
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
          if (p && p.verify && p.verify.at === ds) return true;
        }
      }
    }
    return false;
  }

  /** 量价选股今天跑过没？判据**只看日期**（不看 list.length）：
   *  写 {date:today,count:0,list:[]} = 任务跑了、只是选出 0 只，应判"已更新"。
   *  「有没有票」是 renderScreener() 的事，不该影响"任务跑没跑"的判定（P2-3）。
   *  srcMeta() 与 renderHealth() 共用此函数，杜绝两处判据不一致。
   *  ⚠️ 必须保持顶层 `function name(){}` 形态 —— test_health_logic.js 按大括号配对抽源码。 */
  function scRanToday() {
    return !!screenerOn(todayYmd());
  }

  /** 次日验证今天跑过没？（P1-3） */
  function verifyRanToday() {
    return verifyOn(todayYmd());
  }

  /** 汇总各数据源的时间与状态（供顶部状态区与 footer 使用）
   *  ⚠️ 基准是 **curDate（当前选中的日期）**，不是"今天"：
   *     翻到 09-08 时顶部必须显示 09-08 的状态，否则与页面上的日期自相矛盾。
   *  状态：ok=已生成 / wait=待更新(今天还没到点) / miss=未更新 / close=休市
   *  ⚠️ **这里故意不列「次日验证」**（2026-09-15 用户要求去掉）：
   *     它是后台脚本、没有"生成时间"可展示，混在一排时间戳里只剩一个光秃秃的词，没信息量。
   *     它是否真的跑过仍由 renderHealth() 监控（`🔬验证未跑` 只在异常时出现）。 */
  function srcMeta(r, forDate) {
    var ds = forDate || curDate;
    var isToday = ds === todayYmd();
    var trading = isTradingDay(ds);
    var sc = screenerOn(ds);
    var cal = (window.REPORTS && window.REPORTS.calendar) || [];
    var mo = r && r.morning, ev = r && r.evening;
    var now = new Date();
    var hm = now.getHours() * 60 + now.getMinutes();

    function st(done, dueMin) {
      if (done) return 'ok';
      if (!trading) return 'close';
      // 历史交易日没有数据 = 就是没生成，不存在"还没到点"
      if (!isToday) return 'miss';
      return hm < dueMin ? 'wait' : 'miss';
    }

    // planned=true 表示 time 是「计划时间」（任务还没跑，拿计划点兜底），不是真实生成时间。
    // 不加这个标记的话，「量价选股 15:10」和「早报 08:33」外观一样，会被读成"15:10 更新过"。
    // 历史日期不显示计划时间 —— 那天没跑就是没跑，给个计划点只会让人以为"马上会来"。
    function row(name, at, done, due, plannedAt) {
      return {
        name: name,
        time: at ? String(at).slice(11, 16) : (isToday ? (plannedAt || '') : ''),
        planned: !at && isToday && !!plannedAt,
        state: st(done, due)
      };
    }

    return [
      row('早报', mo && mo.generatedAt, !!(mo && mo.generatedAt), DUE.morning, '8:30'),
      row('晚报', ev && ev.generatedAt, !!(ev && ev.generatedAt), DUE.evening, '21:00'),
      row('量价选股', sc && sc.runAt, !!sc, DUE.screener, '15:10'),
      {
        name: '投资日历',
        time: (cal.length && cal[0].publishedAt) ? cal[0].publishedAt.slice(5, 10) : '',
        planned: false,
        state: cal.length ? 'ok' : (trading ? 'wait' : 'close')
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

  /* ── 日期选择条（每个 Tab 内各一条，是"选时间"的入口） ──
     为什么不再只用「前一天 / 后一天」：数据按天发布，但用户想找的是"某一天"，
     连点按钮既到不了指定日期，周末/节假日那两天也永远点不到 —— 也就看不到
     "当天没有数据"的说明，只能看到一句含糊的"待更新"。
     现在：‹ 前后一天（按自然日，含休市日） + 日期选择器（跳任意日期） + 最新一期。
     latest 由调用方给出（各 Tab 的"最新有数据的那天"可能不同）。 */
  function dateBar(ds, latest) {
    var min = earliestDate();
    var max = todayYmd();
    var d = fmtDate(ds);
    var isLatest = ds === latest;
    var trading = isTradingDay(ds);
    var tags = [];
    if (isLatest) tags.push('最新一期');
    if (!trading) tags.push('休市');
    return '<div class="date-bar">' +
      '<button class="db-arrow" type="button" onclick="stepDay(-1)" aria-label="前一天"' +
      (ds <= min ? ' disabled' : '') + '>&#8249;</button>' +
      '<input class="db-input" type="date" id="datePick" value="' + esc(ds) + '"' +
      ' min="' + esc(min) + '" max="' + esc(max) + '" onchange="pickDay(this.value)" aria-label="选择日期">' +
      '<button class="db-arrow" type="button" onclick="stepDay(1)" aria-label="后一天"' +
      (ds >= max ? ' disabled' : '') + '>&#8250;</button>' +
      '<button class="db-latest" type="button" onclick="gotoLatest()"' +
      (isLatest ? ' disabled' : '') + '>最新</button>' +
      '</div>' +
      // 小字只留「星期 + 状态标签」：日期本身已由上面的选择器显示，
      // 而 header 第一行也写着完整日期 —— 再写一遍就是同一屏内第三次重复。
      '<div class="db-sub"><span>' + esc(d.week) + '</span>' +
      (tags.length ? '<span class="db-tag' + (trading ? '' : ' off') + '">' + esc(tags.join(' · ')) + '</span>' : '') +
      '</div>';
  }

  /** 某个数据源的到期点（供空态卡说明"几点该有"） */
  function todayDue(what) {
    var map = {
      '早报': { m: DUE.morning, label: '8:40' },
      '晚报': { m: DUE.evening, label: '21:10' },
      '短线关注': { m: DUE.evening, label: '21:10' },
      '量价选股': { m: DUE.screener, label: '15:20' },
      '投资日历': null
    };
    return Object.prototype.hasOwnProperty.call(map, what) ? map[what] : null;
  }

  /** 该日期在本数据源下没有内容时的空态卡 —— 必须区分四种情况。
   *  ⚠️ 绝不能一律写「待更新」：休市日说"待更新"是错的（那天根本不会有数据），
   *     历史交易日说"待更新"也是错的（早就该有，是没生成）。 */
  function emptyFor(ds, what) {
    var d = fmtDate(ds);
    var head = d.ymd + ' ' + d.week;
    var today = todayYmd();
    if (ds > today) {
      return emptyCard(head + ' · 还没到', '未来日期不会有数据，最多只能选到今天（' + today + '）', '⏭');
    }
    if (!isTradingDay(ds)) {
      return emptyCard(head + ' · 休市 · 无数据',
        '非交易日没有任何行情与简报，也就不会有' + what + '。点「最新」回到最近一期，或用日期选择器换一天。', '🔵');
    }
    if (ds === today) {
      var due = todayDue(what);
      var now = new Date();
      var hm = now.getHours() * 60 + now.getMinutes();
      // 只有「还没到计划时间」才叫待更新；过了点仍没有就是真没生成
      if (due && hm < due.m) {
        return emptyCard(head + ' · ' + what + '待更新',
          '今天的数据还没生成，计划 ' + due.label + ' 左右。也可以先回看「最新一期」。', '⏳');
      }
      return emptyCard(head + ' · 今日' + what + '未生成',
        '已过计划时间（' + (due ? due.label : '—') + '）仍没有数据，可能任务没跑 —— 见页首健康提示。', '⚠️');
    }
    return emptyCard(head + ' · 当日无数据',
      '该交易日没有收录' + what + '（历史缺口或当时未运行）。可翻到相邻日期，或点「最新」。', '📭');
  }

  /* ── 早报渲染 ── */
  function renderMorning(r, ds) {
    if (!r) return dateBar(ds, latestDate()) + emptyFor(ds, '早报');
    var s = r.sections || {};
    var html = dateBar(ds, latestDate());

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
  function renderEvening(r, ds) {
    if (!r) return dateBar(ds, latestDate()) + emptyFor(ds, '晚报');
    var html = dateBar(ds, latestDate());

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

  function emptyCard(t, s, ico) {
    return '<div class="card empty"><div class="ico">' + (ico || '📭') + '</div><div class="t">' + esc(t) + '</div><div class="s">' + esc(s) + '</div></div>';
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

  function renderWatchlist(r, ds) {
    var bar = dateBar(ds, latestDate());
    var ev = r && r.evening, mo = r && r.morning;
    var today = (mo && mo['今日关注']) || [];
    var tmr = (ev && ev['明日关注']) || [];
    if (!today.length && !tmr.length) {
      return bar + emptyFor(ds, '短线关注');
    }
    var html = bar;

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

  /** 日历的"时间"维度是**发布期**（博主发布的是月度长图），不是交易日 ——
   *  所以这个 Tab 里按期导航，而不是按自然日。共 N 期时全部列出，点一下即可切换。 */
  function calBar() {
    var cal = (window.REPORTS && window.REPORTS.calendar) || [];
    if (!cal.length) return '';
    var c = cal[calIdx] || {};
    var chips = cal.map(function (p, i) {
      var ps = p.publishedAt || '';
      return '<button class="cal-m' + (i === calIdx ? ' on' : '') + '" onclick="showCal(' + i + ')">' +
        esc(ps ? ps.slice(5, 10) : ('#' + (i + 1))) + '</button>';
    }).join('');
    return '<div class="cal-bar">' +
      '<div class="cal-bar-head"><span class="cb-t">发布时间</span>' +
      '<span class="cb-meta">共 ' + cal.length + ' 期 · 当前第 ' + (calIdx + 1) + ' 期' +
      (c.publishedAt ? '（' + esc(String(c.publishedAt).slice(0, 10)) + '）' : '') + '</span></div>' +
      '<div class="cal-months">' + chips + '</div></div>';
  }

  function renderCalendar() {
    var cal = (window.REPORTS && window.REPORTS.calendar) || [];
    if (!cal.length) {
      return emptyCard('投资日历待更新', '「A股投资日历」博主发布月度日历后自动收录');
    }
    if (calIdx >= cal.length) calIdx = 0;
    var c = cal[calIdx];

    var html = calBar();

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

  /** 量价选股的最晚一期日期（"最新"按钮用；screener 日期不一定与 reports 重合） */
  function latestScDate() {
    var arr = screenerList().filter(function (x) { return x && x.date; })
      .map(function (x) { return x.date; }).sort();
    return arr.length ? arr[arr.length - 1] : latestDate();
  }

  function renderScreener(ds) {
    var bar = dateBar(ds, latestScDate());
    var sc = screenerOn(ds);
    // 没有这一期的记录 → 按日期性质分别给出"休市 / 无数据 / 待更新"，不再一律写"待更新"
    if (!sc) return bar + emptyFor(ds, '量价选股');

    var c = sc.criteria || {};
    var cond = [
      ['涨幅', c.gain], ['换手', c.turnover], ['市值', c.cap],
      ['量比', c.volRatio], ['K线', c.yang], ['均线', c.aboveAvg], ['排除', c.exclude]
    ].filter(function (x) { return x[1]; })
      .map(function (x) { return '<span class="sc-cond"><b>' + esc(x[0]) + '</b>' + esc(x[1]) + '</span>'; })
      .join('');
    // 有记录但 0 只 = 任务跑了、只是没选出票（≠ 没数据）
    var head = '<div class="wl-desc">' + ((sc.list && sc.list.length)
      ? '全市场 ' + esc(sc.count) + ' 只符合条件 · 更新于 ' + esc(sc.runAt)
      : '任务已运行（' + esc(sc.runAt || '—') + '），当日 0 只符合条件') + '</div>' +
      '<div class="sc-conds">' + cond + '</div>';
    var tip = '<div class="card tip"><span class="ico">📌</span><span>纯技术面条件筛选，不含题材与基本面判断，仅供盯盘参考，不构成投资建议。带板块标签的为当日主线/博主看好个股。</span></div>';

    if (!sc.list || !sc.list.length) {
      return bar + sectionCard('量价选股 · ' + esc(sc.date), 'info', head) + tip;
    }

    var rows = sc.list.slice().sort(function (a, b) { return (b.gain || 0) - (a.gain || 0); });

    return bar + sectionCard('量价选股 · ' + esc(sc.date), 'info',
      head +
      // 9 列在手机上会溢出屏外，加提示 + 右侧渐隐遮罩，告诉用户"右边还有"
      '<div class="sc-hint" id="scHint">← 左右滑动查看全部 9 项指标</div>' +
      '<div class="sc-scroller">' +
      '<div class="sc-wrap" id="scWrap"><table class="sc-table">' +
      '<thead><tr><th>#</th><th>名称</th><th>板块</th><th>涨幅</th><th>换手</th><th>市值</th><th>量比</th><th>连阳</th><th>均线上</th></tr></thead>' +
      '<tbody>' + scRowsHtml(rows) + '</tbody></table></div>' +
      '<span class="sc-fade" id="scFade"></span></div>') + tip;
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

  /* header 状态行里用的**短名**（与 Tab 名一致）：
     「量价选股 / 投资日历」这两个全称会让状态行在 430px 手机上折成两行，白白多占 18px。
     footer 仍用全称（那是完整句子，短名会读不通）。
     注：次日验证已不再进状态行（见 srcMeta 的注释），所以这里不需要它的映射。 */
  var SHORT_NAME = { '量价选股': '量价', '投资日历': '日历' };

  /* ── 日期导航：每个 Tab 内的日期条按钮都走这三个入口 ── */
  function clampDate(ds) {
    var min = earliestDate(), max = todayYmd();
    if (ds < min) return min;
    if (ds > max) return max;
    return ds;
  }
  function setDate(ds) {
    curDate = clampDate(String(ds));
    render();
  }
  window.stepDay = function (n) { setDate(shiftYmd(curDate, n)); };
  window.pickDay = function (v) { if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) setDate(v); };
  window.gotoLatest = function () { setDate(latestDate()); };

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
    var isOnNewest = !!newest && curDate === newest.date;
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
    positionGlider();
    updateEveningDot();
  }

  function render() {
    var r = findReport(curDate);
    var isLatest = curDate === latestDate();

    // header：显示「当前选中的日期」（可能是休市日 / 无数据的交易日，不再只显示有数据的那天）
    var d = fmtDate(curDate);
    document.getElementById('hdDate').textContent = d.ymd;
    document.getElementById('hdWeek').textContent = d.week + (isLatest ? ' · 最新一期' : '');

    // 状态（基准是选中日期，与页头日期自洽）
    // ⚠️ 正常项**不写**"已生成/已收录"：5 项各写一次会把这一行挤成两行，
    //    而绿点已经说明了结果。只有异常态（待更新/未更新/休市）才补状态词，
    //    这样"异常才显眼"，正常时一行装得下 5 个数据源。
    document.getElementById('hdStatus').innerHTML = srcMeta(r).map(function (s) {
      var label = s.state === 'ok' ? ''
        : (s.state === 'wait' ? '待更新' : (s.state === 'miss' ? '未更新' : '休市'));
      var timeHtml = (s.state === 'close') ? '' : (metaTime(s) ? ' ' + metaTime(s) : '');
      var full = s.name + ' ' + (label ? label : ((timeHtml ? timeHtml.trim() : '') + ' 已生成'));
      return '<div title="' + esc(full) + '"><i class="st-dot ' + s.state + '"></i>' +
        esc(SHORT_NAME[s.name] || s.name) + timeHtml +
        (label ? ' <span class="st-state">' + esc(label) + '</span>' : '') + '</div>';
    }).join('');

    // 内容（每个 Tab 自己渲染顶部的日期条：日期语义各 Tab 不同，见 dateBar / calBar）
    document.getElementById('sec-morning').innerHTML = renderMorning(r ? r.morning : null, curDate);
    document.getElementById('sec-evening').innerHTML = renderEvening(r ? r.evening : null, curDate);
    document.getElementById('sec-watchlist').innerHTML = renderWatchlist(r, curDate);
    document.getElementById('sec-calendar').innerHTML = renderCalendar();
    document.getElementById('sec-screener').innerHTML = renderScreener(curDate);

    // footer（各数据源**最新一期**的更新时间，与当前选中的日期无关）
    var upd = document.getElementById('ftUpd');
    var newest = list[list.length - 1];
    upd.textContent = newest ? srcMeta(newest, newest.date).map(function (s) {
      return s.name + (metaTime(s) ? ' ' + metaTime(s) : '');
    }).join(' · ') : '—';
    renderHealth();
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
        var wasLatest = list.length ? curDate === list[list.length - 1].date : true;
        var prevDate = curDate;
        window.REPORTS = j.REPORTS;
        if (j.SCREENER) window.SCREENER = j.SCREENER;
        list = ((window.REPORTS && window.REPORTS.reports) || []).slice().sort(function (a, b) {
          return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
        });
        // 原本停在最新一期就继续跟到最新；否则留在原来那一天（哪怕那天仍然没有数据）
        curDate = clampDate(wasLatest && list.length ? list[list.length - 1].date : prevDate);
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
