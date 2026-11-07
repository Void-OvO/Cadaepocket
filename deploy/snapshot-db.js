'use strict';
/* 실행 중인 서버가 쓰고 있어도 안전하게 DB 사본을 만든다: node deploy/snapshot-db.js <원본.db> <사본.db> */
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error('usage: node deploy/snapshot-db.js <src.db> <dst.db>'); process.exit(1); }
fs.rmSync(dst, { force: true });
const db = new DatabaseSync(src);
db.exec("VACUUM INTO '" + dst.replace(/'/g, "''") + "'");
db.close();
const c = new DatabaseSync(dst, { readOnly: true });
console.log('DB 사본: 공지 ' + c.prepare('SELECT COUNT(*) n FROM notice').get().n + '건, ' + (fs.statSync(dst).size / 1024 / 1024).toFixed(1) + 'MB');
c.close();
