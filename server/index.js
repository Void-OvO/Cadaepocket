'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const dbm = require('./db');
const store = require('./store');
const push = require('./push');
const notify = require('./notify');
const { crawlAll } = require('./scraper');
const { CAMPUS_CATS, CAMPUSES, SOURCES } = require('./sources');

const WEB = path.join(__dirname, '../web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function createApp(db, opts) {
  opts = opts || {};
  let crawling = false;
  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(b); };
  const readBody = req => new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; if (s.length > 20000) { no(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }); });
  const isAdmin = req => cfg.adminToken && (req.headers.authorization || '') === 'Bearer ' + cfg.adminToken;

  async function runCrawl() {
    if (crawling) return { skipped: true };
    crawling = true;
    try {
      const r = await crawlAll(db, opts.crawl);
      // 새 공지는 수집하면서 번역된다. 그때 번역이 실패한 공지(네트워크 오류 등)는 여기서 다시 채운다
      let translated = 0;
      if (cfg.deeplKey && !opts.noTranslate) {
        try { translated = (await require('./scraper').translateMissing(db)).done; }
        catch (e) { console.warn('[translate] 실패:', e.message); }
      }
      const sent = (await notify.onEvents(db, r.events, opts.notify)) + (await notify.deadlines(db, opts.notify));
      return { events: r.events.length, errors: r.errors, translated, pushed: sent };
    } finally { crawling = false; }
  }

  async function api(req, res, url) {
    const p = url.pathname, q = Object.fromEntries(url.searchParams);
    if (req.method === 'GET' && p === '/api/health') {
      const src = db.prepare('SELECT key,last_crawled_at,last_error FROM notice_source WHERE active=1').all();
      return send(res, 200, { ok: true, notices: db.prepare('SELECT COUNT(*) c FROM notice').get().c, sources: src });
    }
    if (req.method === 'GET' && p === '/api/config')
      return send(res, 200, { vapidPublicKey: push.enabled() ? cfg.vapidPublic : null, campuses: Object.values(CAMPUSES).map(c => ({ id: c.id, name: c.name, host: c.host, cats: CAMPUS_CATS[c.id] })) });
    if (req.method === 'GET' && p === '/api/notices') {
      if (q.campus && !CAMPUSES[q.campus]) return send(res, 400, { error: 'campus' });
      if (q.board && !SOURCES.some(s => s.key === q.board)) return send(res, 400, { error: 'board' });
      // at: 응답 시각, updatedAt: 이 목록의 게시판을 마지막으로 수집한 시각 (앱의 '마지막 업데이트')
      return send(res, 200, { notices: store.list(db, q), at: dbm.now(), updatedAt: store.lastCrawled(db, q) });
    }
    let m = p.match(/^\/api\/notices\/(\d+)$/);
    if (req.method === 'GET' && m) { const n = store.get(db, +m[1]); return n ? send(res, 200, n) : send(res, 404, { error: 'not found' }); }
    if (req.method === 'GET' && p === '/api/changes') return send(res, 200, { changes: store.changes(db, q.campus || 'sim', q.since) });

    if (req.method === 'POST' && p === '/api/push/subscribe') {
      const b = await readBody(req), s = b.subscription || {}, k = s.keys || {};
      if (!/^https:\/\//.test(s.endpoint || '') || !k.p256dh || !k.auth || !CAMPUSES[b.campus]) return send(res, 400, { error: 'invalid subscription' });
      const lead = (Array.isArray(b.leadDays) ? b.leadDays : [3, 1]).filter(x => Number.isInteger(x) && x >= 0 && x <= 14);
      // [] = 모든 영역, ['none'] = 새 공지 알림 영역을 모두 끔 (마감·정정 알림은 그대로)
      let cats = (Array.isArray(b.categories) ? b.categories : []).filter(x => (CAMPUS_CATS[b.campus] || []).includes(x));
      if (!cats.length && Array.isArray(b.categories) && b.categories.includes('none')) cats = ['none'];
      // 미리 거르기용 대략적인 조건만 받는다(학적·이수 학기·교환 여부). 다른 값은 버린다
      const pr = b.profile || {};
      const prof = ['재학', '휴학', '복학 예정'].includes(pr.status) && Number.isInteger(pr.done) && pr.done >= 0 && pr.done <= 12
        ? JSON.stringify({ status: pr.status, done: pr.done, exchange: pr.exchange === true }) : null;
      // 저장한 공지 번호(마감·정정 알림용). 숫자만, 최대 500개
      const saved = (Array.isArray(b.saved) ? b.saved : []).filter(x => Number.isInteger(x) && x > 0).slice(0, 500);
      const t = dbm.now();
      // created_at 은 처음 구독한 시각으로 남는다(새 공지 알림은 이 시각 이후에 올라온 공지만)
      db.prepare(`INSERT INTO push_subscription (endpoint,p256dh,auth,campus_id,lang,categories_json,lead_days_json,change_alert,profile_json,saved_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,campus_id=excluded.campus_id,lang=excluded.lang,categories_json=excluded.categories_json,lead_days_json=excluded.lead_days_json,change_alert=excluded.change_alert,profile_json=excluded.profile_json,saved_json=excluded.saved_json,updated_at=excluded.updated_at`)
        .run(s.endpoint, k.p256dh, k.auth, b.campus, ['ko', 'en', 'zh'].includes(b.lang) ? b.lang : 'ko', JSON.stringify(cats), JSON.stringify(lead), b.changeAlert === false ? 0 : 1, prof, JSON.stringify(saved), t, t);
      return send(res, 200, { ok: true });
    }
    // 알림 모아 보기: 기기가 자기 구독 주소로 받은 알림 목록을 묻는다 (주소가 URL·로그에 남지 않게 POST)
    if (req.method === 'POST' && p === '/api/push/history') {
      const b = await readBody(req), h = require('./notify').history(db, b.endpoint, 50);
      return h ? send(res, 200, { items: h }) : send(res, 404, { error: 'unknown subscription' });
    }
    if (req.method === 'POST' && p === '/api/push/unsubscribe') {
      const b = await readBody(req); db.prepare('DELETE FROM push_subscription WHERE endpoint=?').run(String(b.endpoint || '')); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/reports') {
      const b = await readBody(req);
      if (!store.get(db, Number(b.noticeId))) return send(res, 404, { error: 'not found' });
      db.prepare('INSERT INTO error_report (notice_id,note,created_at) VALUES (?,?,?)').run(Number(b.noticeId), String(b.note || '').slice(0, 500), dbm.now());
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/admin/crawl') {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, await runCrawl());
    }
    return send(res, 404, { error: 'not found' });
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', // 앱 코드(html·js·css·manifest)는 매번 확인해 배포 직후에도 옛 화면이 남지 않게 하고, 아이콘만 오래 캐시한다
    'cache-control': ['.html', '.js', '.css', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
      'service-worker-allowed': '/', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      serveStatic(req, res, url);
    } catch (e) { if (!res.headersSent) send(res, e instanceof SyntaxError ? 400 : 500, { error: 'server error' }); else res.end(); console.warn('[http]', e.message); }
  });
  return { server, runCrawl };
}

function start() {
  const db = dbm.open();
  if (!db.prepare('SELECT 1 FROM notice LIMIT 1').get()) { console.log('[boot] 빈 DB — 시드 공지 ' + store.seed(db) + '건을 넣었어요.'); }
  const app = createApp(db);
  app.server.listen(cfg.port, cfg.host, () => console.log(`가톨리미 서버 http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}  (푸시 ${push.enabled() ? 'ON' : 'OFF — npm run vapid'}, AI ${cfg.anthropicKey ? 'Claude' : '규칙 기반'}, 번역 ${cfg.anthropicKey ? 'Claude' : cfg.deeplKey ? 'DeepL' : 'OFF'})`));
  const tick = () => app.runCrawl().then(r => r && !r.skipped && console.log('[crawl]', JSON.stringify(r))).catch(e => console.warn('[crawl] 실패', e.message));
  if (cfg.crawlIntervalMin > 0) { setTimeout(tick, 5000); setInterval(tick, cfg.crawlIntervalMin * 60000); }
}

module.exports = { createApp, start };
if (require.main === module) start();
