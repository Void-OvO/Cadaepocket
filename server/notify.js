'use strict';
/* 푸시 규칙
 *  - 새 공지: 내 조건(대략적인 조건으로 서버가 거름)에 맞고, 알림을 켠 뒤에 새로 올라온 공지만. 켜기 전에 이미 있던 공지는 보내지 않는다
 *  - 마감 7·3·1일 전: 저장한 공지만, 고른 시점에만
 *  - 정정: 저장한 공지만 (설정에서 정정 알림을 켠 경우) */
const { now } = require('./db');
const push = require('./push');
const store = require('./store');

const J = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };
const dayMs = 86400000;
const ymd = d => d.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / dayMs);

function line(n, lang) { return (n.tx[lang] && n.tx[lang].title) || n.tx.ko.title; }
const COPY = {
  ko: { new: '새 공지', change: '공지가 정정됐어요', d0: '오늘 마감', dn: d => `마감 D-${d}` },
  en: { new: 'New notice', change: 'Notice updated', d0: 'Due today', dn: d => `Due in ${d}d` },
  zh: { new: '新通知', change: '通知已更正', d0: '今天截止', dn: d => `距截止${d}天` }
};

async function deliver(db, sub, kind, notice, body, dedupe, sender) {
  if (db.prepare('SELECT 1 FROM push_log WHERE dedupe_key=?').get(dedupe)) return false;
  const payload = { kind, id: notice.id, cat: notice.cat, title: notice.title, body, url: '/#/n/' + notice.id, end: notice.end, criteria: notice.criteria, depts: notice.criteria.depts };
  let status;
  try { status = await sender({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload); }
  catch (e) { status = 0; }
  if (status === 404 || status === 410) db.prepare('DELETE FROM push_subscription WHERE id=?').run(sub.id);
  db.prepare('INSERT INTO push_log (subscription_id,notice_id,kind,dedupe_key,status,sent_at,title,body,url) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sub.id, notice.id, kind, dedupe, status, now(), payload.title, body, payload.url);
  return status >= 200 && status < 300;
}

/* 알림 모아 보기: 이 구독(기기)에 실제로 보낸 알림, 최신 순. 구독 주소(endpoint)를 아는 기기만 자기 기록을 볼 수 있다 */
function history(db, endpoint, limit) {
  const sub = db.prepare('SELECT id, lang FROM push_subscription WHERE endpoint=?').get(String(endpoint || ''));
  if (!sub) return null;
  const C = COPY[sub.lang] || COPY.ko;
  const fallback = { new: C.new, change: C.change, deadline: { ko: '마감이 다가와요', en: 'Deadline coming up', zh: '即将截止' }[sub.lang] || '마감이 다가와요', test: '' };
  return db.prepare(`SELECT l.id, l.kind, l.notice_id, l.sent_at, l.title, l.body, l.url, n.title AS ntitle FROM push_log l LEFT JOIN notice n ON n.id=l.notice_id
    WHERE l.subscription_id=? AND l.status BETWEEN 200 AND 299 ORDER BY l.id DESC LIMIT ?`).all(sub.id, Math.min(100, limit || 50))
    .map(r => ({ id: r.id, kind: r.kind, noticeId: r.notice_id, at: r.sent_at, title: r.title || r.ntitle || '', body: r.body || fallback[r.kind] || '', url: r.url || (r.notice_id ? '/#/n/' + r.notice_id : '/') }));
}

const wants = (sub, cat) => { const c = J(sub.categories_json, []); return !c.length || c.includes(cat); };
const savedOf = sub => J(sub.saved_json, []);

/* 서버에서 미리 거르기: 구독할 때 받은 대략적인 조건(학적·이수 학기·교환 여부)으로 '대상 아님'인 공지는 보내지 않는다.
 * 학과·평점은 서버가 모르므로 그 조건은 통과시킨다. 조건을 모르는 예전 구독은 거르지 않는다.
 * (기기에서 조용히 버리면 브라우저가 구독을 끊을 수 있어서, 보낸 알림은 기기가 항상 보여 준다) */
const M = require('../web/match.js');
function fits(sub, criteria) {
  const p = J(sub.profile_json, null);
  if (!p) return true;
  const c = Object.assign({}, criteria, { depts: null, minGpa: null });
  return M.match(c, { status: p.status, done: p.done, gpa: 4.5, exchange: !!p.exchange, dept: '' }) !== 'no';
}

async function onEvents(db, events, opts) {
  opts = opts || {};
  const sender = opts.sender || (push.enabled() ? push.send : null);
  if (!sender) return 0;
  const today = ymd(new Date()), recent = ymd(new Date(Date.now() - 3 * dayMs));
  let sent = 0;
  for (const ev of events) {
    const n = store.get(db, ev.noticeId); if (!n) continue;
    if (ev.type === 'new' && (!n.posted || n.posted < recent)) continue;     // 첫 수집 때 옛 글로 알림 폭탄 방지
    // 학과 게시판에서만 본 공지는 서버가 구독자의 학과를 모르므로 새 공지 알림을 보내지 않는다 (저장했다면 마감·정정 알림은 감)
    if (ev.type === 'new' && n.scope === 'dept') continue;
    const firstSeen = (db.prepare('SELECT first_seen_at FROM notice WHERE id=?').get(n.id) || {}).first_seen_at || '';
    for (const sub of db.prepare('SELECT * FROM push_subscription WHERE campus_id=?').all(n.campus)) {
      const lang = sub.lang, c = COPY[lang] || COPY.ko;
      const t = Object.assign({}, n, { title: line(n, lang) });
      if (ev.type === 'new') {
        // 알림을 켜기 전에 이미 수집돼 있던 공지는 보내지 않는다 (설치 직후 알림 폭탄 방지)
        if (firstSeen < sub.created_at || !wants(sub, n.cat) || !fits(sub, n.criteria)) continue;
        if (await deliver(db, sub, 'new', t, c.new + ' · ' + t.title, `new:${n.id}:${sub.id}`, sender)) sent++;
      } else if (ev.type === 'change' && sub.change_alert && savedOf(sub).includes(n.id)) {
        const ch = db.prepare('SELECT ai_summary FROM notice_change WHERE id=?').get(ev.changeId);
        if (await deliver(db, sub, 'change', t, c.change + ' · ' + (ch ? ch.ai_summary : ''), `chg:${ev.changeId}:${sub.id}`, sender)) {
          sent++; db.prepare('UPDATE notice_change SET pushed=1 WHERE id=?').run(ev.changeId);
        }
      }
    }
  }
  return sent;
}

async function deadlines(db, opts) {
  opts = opts || {};
  const sender = opts.sender || (push.enabled() ? push.send : null);
  if (!sender) return 0;
  const today = opts.today || ymd(new Date());
  let sent = 0;
  const rows = db.prepare(store.BASE + ' AND a.apply_end IS NOT NULL AND a.apply_end>=?').all(today);
  for (const r of rows) {
    const left = daysBetween(today, r.apply_end);
    const n = store.shape(db, r, false);
    for (const sub of db.prepare('SELECT * FROM push_subscription WHERE campus_id=?').all(r.campus_id)) {
      // 마감 알림은 저장한 공지에만, 고른 시점(7·3·1일 전)에만. 직접 저장한 공지라 분류·조건으로는 거르지 않는다
      if (!savedOf(sub).includes(n.id) || !J(sub.lead_days_json, [3, 1]).includes(left)) continue;
      const c = COPY[sub.lang] || COPY.ko;
      const t = Object.assign({}, n, { title: line(n, sub.lang) });
      if (await deliver(db, sub, 'deadline', t, (left === 0 ? c.d0 : c.dn(left)) + ' · ' + t.title, `dl:${n.id}:${r.apply_end}:${left}:${sub.id}`, sender)) sent++;
    }
  }
  return sent;
}

module.exports = { onEvents, deadlines, fits, history };
