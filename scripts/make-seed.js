'use strict';
/* 시연 캔버스의 data.js(실제 공지 14건)를 data/seed.json 으로 변환하는 일회성 스크립트 */
global.window = {};
require(process.argv[2] || '/home/claude/nm/project/data.js');
const NM = window.NM, iso = ms => ms ? new Date(ms).toISOString().slice(0, 10) : null;
const out = [];
for (const n of Object.values(NM.N)) {
  if (n.fake) continue;
  const unc = [];
  if (n.uncertain) unc.push(Object.assign({}, n.uncertain, n.unsureDone ? { ifDoneAtLeast: n.unsureDone } : {}));
  out.push({
    campus: n.campus, cat: n.cat, no: n.no, dept: n.dept, posted: iso(n.posted), start: iso(n.start), end: iso(n.end), url: n.url, ocr: !!n.ocr,
    title: n.tx.ko.title, tx: n.tx, per: n.per || null,
    criteria: { statuses: n.statuses || null, grades: n.grades || null, minGpa: n.minGpa == null ? null : n.minGpa, minDone: n.minDone == null ? null : n.minDone,
      maxDone: n.maxDone == null ? null : n.maxDone, audience: n.audience || null, excludeExchange: !!n.excludeExchange, depts: n.depts || null, uncertain: unc, boost: n.boost || null }
  });
}
require('fs').writeFileSync(require('path').join(__dirname, '../data/seed.json'), JSON.stringify(out, null, 1));
console.log(out.length, 'notices');
