// 校验 dashboard/data.js 结构
const fs = require('fs');
const path = 'C:/Users/zoush/WorkBuddy/A股推送系统/dashboard/data.js';
const src = fs.readFileSync(path, 'utf8');
// 用 Function 构造 + 模拟 window 上下文
const window = {};
const vm = require('vm');
try {
  vm.runInNewContext(src, { window });
  const R = window.REPORTS;
  console.log('OK updatedAt:', R.updatedAt);
  console.log('reports count:', R.reports.length);
  console.log('dates:', R.reports.map(r => r.date).join(','));
  console.log('first report morning.title:', R.reports[0].morning.title);
  console.log('first report morning.今日关注 count:', R.reports[0].morning['今日关注'].length);
  console.log('first report sections keys:', Object.keys(R.reports[0].morning.sections).join(','));
  console.log('first report watch names:', R.reports[0].morning['今日关注'].map(s => s.name).join('/'));
  console.log('8/31 morning kept?', !!R.reports[1].morning);
  console.log('8/31 evening kept?', !!R.reports[1].evening);
  console.log('calendar count:', R.calendar.length);
  console.log('screener kept?', !!R.screener);
} catch (e) {
  console.error('FAIL:', e.message);
  process.exit(1);
}
