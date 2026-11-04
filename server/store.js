'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { tx, now } = require('./db');
const { saveAnalysis } = require('./scraper');

const J = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };

/* data/seed.json(시연용 실제 공지 14건)을 DB 에 넣는다. 첫 수집 때 본문이 들어오면 조용히 덮어쓴다(content_hash='seed'). */
function seed(db, file) {
  file = file || path.join(__dirname, '../data/seed.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  tx(db, () => {
    for (const r of rows) {
      if (db.prepare('SELECT 1 FROM notice WHERE campus_id=? AND external_no=?').get(r.campus, r.no)) continue;
      const src = db.prepare("SELECT id FROM notice_source WHERE campus_id=? AND key LIKE '%-notice'").get(r.campus);
      const k = r.tx.ko;
      const body = [k.who && '대상: ' + k.who, k.docs && '제출 서류: ' + k.docs, k.how && '신청 방법: ' + k.how].filter(Boolean).join('\n');
      const id = Number(db.prepare(`INSERT INTO notice (source_id,campus_id,external_no,category,title,dept,posted_at,original_url,body_text,content_hash,latest_version,first_seen_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'seed',1,?,?)`).run(src.id, r.campus, r.no, r.cat, r.title, r.dept, r.posted, r.url, body, now(), now()).lastInsertRowid);
      db.prepare('INSERT INTO notice_version (notice_id,version_no,title,body_text,content_hash,detected_at) VALUES (?,?,?,?,?,?)').run(id, 1, r.title, body, 'seed', now());
      db.prepare('INSERT OR IGNORE INTO notice_board (notice_id,source_key) SELECT ?, key FROM notice_source WHERE id=?').run(id, src.id);
      const translations = {};
      for (const lang of ['en', 'zh']) if (r.tx[lang]) translations[lang] = { title: r.tx[lang].title, who: r.tx[lang].who, docs: r.tx[lang].docs, how: r.tx[lang].how };
      saveAnalysis(db, id, 1, { criteria: r.criteria, summary: { ko: { who: k.who, docs: k.docs, how: k.how } }, translations, start: r.start, end: r.end, sourceKind: r.ocr ? 'image' : 'text', ocr: r.ocr, model: 'seed' });
      n++;
    }
  });
  return n;
}

const BASE = `SELECT n.*, a.id AS aid, a.criteria_json, a.summary_json, a.apply_start, a.apply_end, a.source_kind, a.ocr, a.model
  FROM notice n JOIN notice_analysis a ON a.notice_id=n.id AND a.version_no=n.latest_version WHERE n.deleted=0`;

function shape(db, r, full) {
  const tx = { ko: Object.assign({ title: r.title }, (J(r.summary_json, {}).ko) || {}) };
  for (const t of db.prepare('SELECT lang,title,summary_json FROM notice_translation WHERE analysis_id=?').all(r.aid))
    tx[t.lang] = Object.assign({ title: t.title }, J(t.summary_json, {}));
  const ch = db.prepare('SELECT * FROM notice_change WHERE notice_id=? ORDER BY id DESC LIMIT 1').get(r.id);
  const o = {
    id: r.id, campus: r.campus_id, cat: r.category, no: r.external_no, pinned: !!r.is_pinned, dept: r.dept || '', posted: r.posted_at,
    start: r.apply_start, end: r.apply_end, url: r.original_url, ocr: !!r.ocr, sourceKind: r.source_kind, version: r.latest_version,
    scope: r.scope || 'campus',
    // checkedAt: 앱이 원문을 마지막으로 확인한 시각(목록·상세에서 '마지막 업데이트'), updatedAt: 내용이 마지막으로 바뀐 시각
    checkedAt: r.checked_at || r.updated_at, updatedAt: r.updated_at,
    criteria: J(r.criteria_json, {}), tx,
    change: ch ? { summary: ch.ai_summary, fields: J(ch.changed_fields_json, []), at: ch.detected_at, toVersion: ch.to_version } : null
  };
  if (full) {
    o.body = r.body_text;
    o.attachments = db.prepare('SELECT kind,file_name AS name,file_url AS url FROM notice_attachment WHERE notice_id=?').all(r.id);
  }
  return o;
}

/* q.board 가 있으면 그 게시판에서 본 공지(학과 탭), 없으면 홈 피드 공지(scope='campus')만.
 * 게시판 목록은 사이트와 같은 순서: 상단 고정('공지')글을 게시판 위 순서대로 먼저, 나머지는 글 번호 큰(최신) 순 */
function list(db, q) {
  const w = [], a = [];
  if (q.campus) { w.push('n.campus_id=?'); a.push(q.campus); }
  if (q.cat) { w.push('n.category=?'); a.push(q.cat); }
  const limit = Math.min(Number(q.limit) || 200, 500);
  if (q.board) {
    const sql = BASE.replace(' WHERE n.deleted=0', ' JOIN notice_board nb ON nb.notice_id=n.id AND nb.source_key=? WHERE n.deleted=0')
      .replace('SELECT n.*,', 'SELECT n.*, nb.pinned AS bpin, nb.pin_rank AS brank,');
    const rows = db.prepare(sql + (w.length ? ' AND ' + w.join(' AND ') : '') + ' ORDER BY nb.pinned DESC, nb.pin_rank, n.external_no DESC LIMIT ' + limit).all(q.board, ...a);
    return rows.map(r => Object.assign(shape(db, r, false), { boardPinned: !!r.bpin }));
  }
  w.push("n.scope='campus'");
  const rows = db.prepare(BASE + ' AND ' + w.join(' AND ') + ' ORDER BY n.posted_at DESC, n.external_no DESC LIMIT ' + limit).all(...a);
  return rows.map(r => shape(db, r, false));
}
/* 목록의 '마지막 업데이트': 해당 게시판(들)을 마지막으로 수집한 시각. 한 번도 수집하지 않았으면 null */
function lastCrawled(db, q) {
  const r = q.board
    ? db.prepare('SELECT last_crawled_at t FROM notice_source WHERE key=?').get(q.board)
    : db.prepare("SELECT MAX(last_crawled_at) t FROM notice_source WHERE campus_id=? AND active=1 AND scope='campus'").get(q.campus || 'sim');
  return (r && r.t) || null;
}
function get(db, id) {
  const r = db.prepare(BASE + ' AND n.id=?').get(id);
  return r ? shape(db, r, true) : null;
}
function changes(db, campus, since) {
  const rows = db.prepare(`SELECT c.*, n.campus_id FROM notice_change c JOIN notice n ON n.id=c.notice_id WHERE n.campus_id=? AND c.detected_at>? ORDER BY c.id DESC LIMIT 50`).all(campus, since || '');
  return rows.map(c => ({ id: c.id, noticeId: c.notice_id, summary: c.ai_summary, fields: J(c.changed_fields_json, []), at: c.detected_at }));
}

module.exports = { seed, list, get, changes, shape, lastCrawled, BASE };
