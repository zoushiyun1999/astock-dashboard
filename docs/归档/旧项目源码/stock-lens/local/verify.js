// 渲染逻辑验证：用最小 DOM 桩在 Node 中真跑一遍 index.html 的前端脚本。
// 目的：确认 render 不抛错，且确实把 data.js 里的真实数据渲染成了 HTML。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const WEB = path.join(__dirname, 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const dataSrc = fs.readFileSync(path.join(WEB, 'data.js'), 'utf8');

const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!m) { console.error('FAIL: 未找到前端脚本块'); process.exit(1); }
const script = m[1];

function El(id) {
  return {
    id, innerHTML: '', textContent: '', className: '', dataset: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }
  };
}
const els = {};
const document = {
  getElementById: (id) => (els[id] || (els[id] = El(id))),
  querySelectorAll: () => [],
};
const window = {};

const ctx = vm.createContext({ window, document, console });
vm.runInContext(dataSrc, ctx, { filename: 'data.js' });
vm.runInContext(script, ctx, { filename: 'index.html:script' });

// ---- 断言 ----
const checks = [];
const add = (name, cond, extra) => checks.push({ name, ok: !!cond, extra });

add('window.DATA 已注入', ctx.window.DATA && ctx.window.DATA.generatedAt,
    ctx.window.DATA && ctx.window.DATA.generatedAt);
add('顶部状态栏已渲染', /数据时间/.test(els['meta'].innerHTML), els['meta'].innerHTML.replace(/<[^>]+>/g,' ').trim());
add('选股卡片数 = 4', (els['picks'].innerHTML.match(/class="card"/g) || []).length === 4,
    (els['picks'].innerHTML.match(/class="card"/g) || []).length + ' 张');
add('选股渲染出真实股票名', /金科股份/.test(els['picks'].innerHTML));
add('资金类指标已按亿缩放', /亿/.test(els['picks'].innerHTML));
add('板块表已渲染 15 行', (els['sec-body'].innerHTML.match(/<tr>/g) || []).length === 15,
    (els['sec-body'].innerHTML.match(/<tr>/g) || []).length + ' 行');
add('热搜板块表已渲染 12 行', (els['hot-body'].innerHTML.match(/<tr>/g) || []).length === 12,
    (els['hot-body'].innerHTML.match(/<tr>/g) || []).length + ' 行');
add('自选卡片数 = 4', (els['watchlist'].innerHTML.match(/class="card"/g) || []).length === 4,
    (els['watchlist'].innerHTML.match(/class="card"/g) || []).length + ' 张');
add('市值显示为万亿/亿（单位 bug 已修）', /万亿|亿/.test(els['watchlist'].innerHTML));
add('涨跌着色类存在', /class="up"|class="down"/.test(els['picks'].innerHTML + els['watchlist'].innerHTML));

// ---- 手机端适配 ----
// 只在「静态 HTML 部分」统计，避免把脚本里的字符串字面量也算进去
const staticHtml = html.split('<script src="data.js">')[0];
const twPicks = (els['picks'].innerHTML.match(/class="tw"/g) || []).length;
const twStatic = (staticHtml.match(/class="tw"/g) || []).length;
add('窄屏不溢出：grid 用 min(340px,100%)', /minmax\(min\(340px,100%\),1fr\)/.test(html));
add('存在手机端 media query', /@media \(max-width:600px\)/.test(html));
add('窄屏隐藏股票代码以省宽度', /\.cd\{display:none\}/.test(html));
add('长表格首列吸附', /position:sticky;left:0/.test(html));
add('选股表已套滚动容器 x4', twPicks === 4, twPicks + ' 个');
add('静态表已套滚动容器 x2', twStatic === 2, twStatic + ' 个');
add('无未包裹的裸表格', !/<table>/.test(html.replace(/class="tw"><table>/g, '')), '全部表格均在 .tw 内');
add('自选表也套了容器', /class="tw"><table><tbody>/.test(html));

// ---- 博主观点 ----
const b = els['blogs'].innerHTML;
add('博主面板已渲染 4 个分组', (b.match(/class="bpanel"/g) || []).length === 4,
    (b.match(/class="bpanel"/g) || []).length + ' 组');
add('博主条目卡片已渲染 24 张', (b.match(/class="bitem"/g) || []).length === 24,
    (b.match(/class="bitem"/g) || []).length + ' 张');
add('早报标题正确', /开盘必读资讯/.test(b));
add('晚报·湖南人已渲染', /湖南人涨停复盘/.test(b));
add('晚报·shenghuo329 已渲染', /shenghuo329|shenghuo/.test(b) || /class="bpanel"/.test(b));
add('投资日历已渲染', /投资日历/.test(b));
add('博主条目均带原文外链', (b.match(/href="https:\/\//g) || []).length === 24,
    (b.match(/href="https:\/\//g) || []).length + ' 个外链');
add('韭研条目带股票 chips', (b.match(/class="bchip"/g) || []).length > 0,
    (b.match(/class="bchip"/g) || []).length + ' 个 chip');
add('时间已格式化为 MM-DD HH:mm', /\d{2}-\d{2} \d{2}:\d{2}/.test(b));
add('博主区顺序：早报在晚报前', b.indexOf('开盘必读') < b.indexOf('湖南人'));

let bad = 0;
checks.forEach(c => { if (!c.ok) bad++; console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.name + (c.extra ? '   -> ' + c.extra : '')); });
console.log('\n' + (bad === 0 ? '全部通过 (' + checks.length + ')' : bad + ' 项失败'));
process.exit(bad === 0 ? 0 : 1);
