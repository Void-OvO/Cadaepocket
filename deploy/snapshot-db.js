'use strict';
/* 실행 중인 서버가 쓰고 있어도 안전하게 DB 사본을 만든다: node deploy/snapshot-db.js <원본.db> <사본.db> [--strip-personal]
   --strip-personal: 테스트 서버용. 사용자 푸시 구독·발송 기록·오류 신고를 지우고 공지만 남긴다 */
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const strip = args.includes('--strip-personal');
const [src, dst] = args.filter(a => !a.startsWith('--'));
if (!src || !dst) { console.error('usage: node deploy/snapshot-db.js <src.db> <dst.db> [--strip-personal]'); process.exit(1); }
fs.rmSync(dst, { force: true });
const db = new DatabaseSync(src);
db.exec("VACUUM INTO '" + dst.replace(/'/g, "''") + "'");
db.close();
if (strip) {
  const w = new DatabaseSync(dst);
  const has = t => w.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  for (const t of ['push_log', 'push_subscription', 'error_report']) if (has(t)) w.exec('DELETE FROM ' + t);
  w.exec('VACUUM');
  w.close();
}
const c = new DatabaseSync(dst, { readOnly: true });
console.log('DB 사본: 공지 ' + c.prepare('SELECT COUNT(*) n FROM notice').get().n + '건, ' + (fs.statSync(dst).size / 1024 / 1024).toFixed(1) + 'MB' + (strip ? ' (푸시 구독·발송 기록·오류 신고 삭제)' : ''));
c.close();
