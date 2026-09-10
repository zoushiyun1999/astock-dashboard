const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'dashboard', 'data.js');
const eveningPath = path.join(__dirname, 'tmp_evening_0910.json');

const raw = fs.readFileSync(dataPath, 'utf8');
const m = raw.match(/^window\.REPORTS\s*=\s*(.*);\s*$/s);
if (!m) throw new Error('data.js format mismatch');
const data = JSON.parse(m[1]);
const evening = JSON.parse(fs.readFileSync(eveningPath, 'utf8'));

const now = new Date();
const nowStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
evening.generatedAt = nowStr;

data.updatedAt = nowStr;

let report = data.reports.find(r => r.date === '2026-09-10');
if (!report) {
  report = { date: '2026-09-10' };
  data.reports.push(report);
}
report.evening = evening;

data.reports.sort((a,b) => new Date(a.date) - new Date(b.date));
if (data.reports.length > 7) data.reports = data.reports.slice(-7);

const out = 'window.REPORTS = ' + JSON.stringify(data, null, 2) + ';\n';
fs.writeFileSync(dataPath, out, 'utf8');
console.log('Merged evening for 2026-09-10, generatedAt=' + nowStr + ', reports=' + data.reports.length);
