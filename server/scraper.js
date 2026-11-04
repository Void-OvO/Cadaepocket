'use strict';
const crypto = require('node:crypto');
const cfg = require('./config');
const H = require('./html');
const { tx, now } = require('./db');
const { SOURCES, CATEGORY_MAP } = require('./sources');
const { analyze, localAnalyze } = require('./analyze');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isoDate = s => { const m = (s || '').match(/(\d{4})\.(\d{2})\.(\d{2})/); return m ? m[1] + '-' + m[2] + '-' + m[3] : null; };

/* ───────── 파서 ───────── */
function parseList(html) {
  const rows = [];
  for (const tr of H.all(html, 'tr')) {
    const noM = tr.inner.match(/data-article-no\s*=\s*"(\d+)"/);
    if (!noM) continue;
    const pinned = /\bb-cate-notice\b/.test(tr.open);
    const a = tr.inner.match(/<a\b[^>]*\bb-title\b[^>]*>([\s\S]*?)<\/a>/i);
    const title = a ? H.oneLine(a[1]).replace(/\s*첨부파일\s*N?\s*$/, '').trim() : '';
    const cells = H.all(tr.inner, 'td').map(td => ({ cls: H.attr(td.open, 'class') || '', text: H.oneLine(td.inner) }));
    const titleIdx = cells.findIndex(c => /\bb-td-title\b/.test(c.cls));
    const after = cells.slice(titleIdx + 1).map(c => c.text);
    const date = after.map(isoDate).find(Boolean) || null;
    const dept = after.find(t => t && !/^\d[\d,]*$/.test(t) && !isoDate(t)) || '';
    rows.push({ no: Number(noM[1]), pinned, title, category: (cells[1] && cells[1].text) || '', date, dept });
  }
  const t = H.stripTags(html).match(/총\s*([\d,]+)\s*건/);
  return { rows, total: t ? Number(t[1].replace(/,/g, '')) : null };
}

function absUrl(href, base) { try { return new URL(href, base).toString(); } catch (_) { return null; } }

function parseDetail(html, pageUrl) {
  const titleBox = H.byClass(html, 'b-title-box');
  const etc = H.byClass(html, 'b-etc-box');
  const etcText = etc ? H.oneLine(etc.inner) : '';
  const body = H.byClass(html, 'b-content-box');
  const bodyHtml = body ? body.inner : '';
  const images = [];
  for (const m of bodyHtml.matchAll(/<img\b[^>]*>/gi)) {
    const src = H.attr(m[0], 'src'); const u = src && absUrl(src, pageUrl);
    if (u && !images.includes(u)) images.push(u);
  }
  const attachments = [];
  const fileBox = H.byClass(html, 'b-file-box');
  if (fileBox) for (const m of fileBox.inner.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const href = H.attr(m[0], 'href'); const name = H.oneLine(m[0]);
    if (href && name) attachments.push({ name, url: absUrl(href, pageUrl) });
  }
  const author = (etcText.match(/작성자\s*:?\s*(\S+)/) || [])[1] || '';
  const posted = isoDate((etcText.match(/(?:등록일|작성일)\s*:?\s*(\d{4}\.\d{2}\.\d{2})/) || [])[1]);
  return {
    // 제목 상자 안의 분류 표시(<span class="b-cate">학사</span> / [장학])는 제목이 아니므로 뺀다
    title: titleBox ? H.oneLine(titleBox.inner.replace(/<span\b[^>]*\bb-cate\b[^>]*>[\s\S]*?<\/span>/i, '')) : '',
    author, posted, bodyText: H.stripTags(bodyHtml), images, attachments
  };
}

/* ───────── 주소 ───────── */
function listUrl(src, catId, offset, limit) {
  const u = new URL(src.base);
  u.searchParams.set('mode', 'list');
  if (catId) u.searchParams.set('srCategoryId', String(catId));
  u.searchParams.set('articleLimit', String(limit));
  u.searchParams.set('article.offset', String(offset));
  return u.toString();
}
const viewUrl = (src, no) => { const u = new URL(src.base); u.searchParams.set('mode', 'view'); u.searchParams.set('articleNo', String(no)); return u.toString(); };

/* ───────── 저장 ───────── */
const crit = row => { try { return JSON.parse(row.criteria_json); } catch (_) { return {}; } };

function diffAnalysis(prev, next) {
  const fields = [];
  const cmp = (f, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fields.push({ field: f, from: a, to: b }); };
  cmp('end', prev.apply_end, next.end);
  cmp('start', prev.apply_start, next.start);
  const pc = crit(prev), nc = next.criteria;
  for (const k of ['statuses', 'grades', 'minGpa', 'minDone', 'maxDone', 'depts']) cmp(k, pc[k] == null ? null : pc[k], nc[k] == null ? null : nc[k]);
  return fields;
}
const LABEL = { end: '신청 마감', start: '신청 시작', statuses: '대상 학적', grades: '대상 학년', minGpa: '최소 평점', minDone: '이수 학기(하한)', maxDone: '이수 학기(상한)', depts: '대상 학과' };
function changeSummary(fields) {
  if (!fields.length) return '본문이 수정됐어요. 대상·기간 같은 핵심 조건은 그대로예요.';
  const md = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? (+v.slice(5, 7)) + '/' + (+v.slice(8, 10)) : (v == null ? '없음' : Array.isArray(v) ? v.join('·') : String(v));
  return fields.map(f => `${LABEL[f.field] || f.field}이(가) ${md(f.from)}에서 ${md(f.to)}(으)로 바뀌었어요`).join(' · ');
}

function saveAnalysis(db, noticeId, version, a) {
  // 같은 버전을 다시 분석하면 예전 번역은 내용이 맞지 않으므로 먼저 지운다
  db.prepare('DELETE FROM notice_translation WHERE analysis_id IN (SELECT id FROM notice_analysis WHERE notice_id=? AND version_no=?)').run(noticeId, version);
  db.prepare(`INSERT OR REPLACE INTO notice_analysis (notice_id,version_no,criteria_json,summary_json,apply_start,apply_end,source_kind,ocr,model,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(noticeId, version, JSON.stringify(a.criteria), JSON.stringify(a.summary), a.start, a.end, a.sourceKind, a.ocr ? 1 : 0, a.model, now());
  // OCR 로 읽은 이미지 글자와 신뢰도를 이미지 첨부 행에 남긴다 (관리자 확인·재분석용)
  if (a.ocrReads && a.ocrReads.length) {
    const up = db.prepare("UPDATE notice_attachment SET extracted_text=?, ocr_confidence=? WHERE notice_id=? AND kind='image' AND file_url=?");
    for (const r of a.ocrReads) up.run(String(r.text).slice(0, 20000), r.conf, noticeId, r.url);
  }
  // 번역(영어·중국어)이 있으면 새 분석에 붙여 저장한다
  const tr = a.translations || {};
  if (Object.keys(tr).length) {
    const aid = db.prepare('SELECT id FROM notice_analysis WHERE notice_id=? AND version_no=?').get(noticeId, version).id;
    const ins = db.prepare('INSERT OR REPLACE INTO notice_translation (analysis_id,lang,title,summary_json,created_at) VALUES (?,?,?,?,?)');
    for (const [lang, t] of Object.entries(tr)) {
      const { title, ...sum } = t;
      ins.run(aid, lang, title, JSON.stringify(sum), now());
    }
  }
}

function storeAttachments(db, noticeId, d) {
  db.prepare('DELETE FROM notice_attachment WHERE notice_id=?').run(noticeId);
  const ins = db.prepare('INSERT INTO notice_attachment (notice_id,kind,file_name,file_url) VALUES (?,?,?,?)');
  d.attachments.forEach(a => ins.run(noticeId, 'file', a.name, a.url));
  d.images.forEach(u => ins.run(noticeId, 'image', null, u));
}

/* 한 공지를 처리: 새 글이면 저장, 내용이 바뀌었으면 새 버전·정정 이력. 이벤트 반환 */
async function upsertNotice(db, src, row, detail, ctx) {
  const category = CATEGORY_MAP[row.category] || src.defaultCat || 'gen';
  const title = row.title || detail.title;
  const hash = sha(JSON.stringify([title, detail.bodyText, detail.attachments.map(a => a.name), detail.images]));
  const postedAt = row.date || detail.posted;
  const url = viewUrl(src, row.no);
  const existing = db.prepare('SELECT * FROM notice WHERE campus_id=? AND external_no=?').get(src.campus, row.no);
  const n = { title, bodyText: detail.bodyText, images: detail.images, attachments: detail.attachments, category, postedAt };
  const scope = src.scope === 'dept' ? 'dept' : 'campus';
  // 어느 게시판에서 봤는지와 앱이 원문을 확인한 시각을 남긴다. 통합 게시판에서도 본 공지는 홈 피드 공지(campus)가 된다
  const seen = id => {
    db.prepare('INSERT OR IGNORE INTO notice_board (notice_id,source_key) VALUES (?,?)').run(id, src.key);
    db.prepare(`UPDATE notice SET checked_at=?${scope === 'campus' ? ", scope='campus'" : ''} WHERE id=?`).run(now(), id);
  };
  if (existing) seen(existing.id);

  if (!existing) {
    const a = await ctx.analyzer(n);
    return tx(db, () => {
      const r = db.prepare(`INSERT INTO notice (source_id,campus_id,external_no,category,is_pinned,title,dept,posted_at,original_url,body_text,content_hash,latest_version,first_seen_at,updated_at,scope,checked_at)
        VALUES ((SELECT id FROM notice_source WHERE key=?),?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`)
        .run(src.key, src.campus, row.no, category, row.pinned ? 1 : 0, title, row.dept || detail.author, postedAt, url, detail.bodyText, hash, now(), now(), scope, now());
      const id = Number(r.lastInsertRowid);
      seen(id);
      db.prepare('INSERT INTO notice_version (notice_id,version_no,title,body_text,content_hash,detected_at) VALUES (?,?,?,?,?,?)').run(id, 1, title, detail.bodyText, hash, now());
      storeAttachments(db, id, detail);
      saveAnalysis(db, id, 1, a);
      return { type: 'new', noticeId: id };
    });
  }
  if (existing.content_hash === 'seed') {   // 시연 시드를 실제 본문으로 처음 교체: 정정 이력은 만들지 않는다
    const a = await ctx.analyzer(n);
    return tx(db, () => {
      db.prepare('UPDATE notice SET title=?,body_text=?,content_hash=?,updated_at=? WHERE id=?').run(title, detail.bodyText, hash, now(), existing.id);
      db.prepare('UPDATE notice_version SET title=?,body_text=?,content_hash=? WHERE notice_id=? AND version_no=1').run(title, detail.bodyText, hash, existing.id);
      storeAttachments(db, existing.id, detail);
      db.prepare('DELETE FROM notice_analysis WHERE notice_id=? AND version_no=1').run(existing.id);
      saveAnalysis(db, existing.id, 1, a);
      return null;
    });
  }
  if (existing.content_hash === hash) {
    db.prepare('UPDATE notice SET is_pinned=?, category=?, deleted=0 WHERE id=?').run(row.pinned ? 1 : existing.is_pinned, category, existing.id);
    return null;
  }
  const a = await ctx.analyzer(n);
  return tx(db, () => {
    const v = existing.latest_version + 1;
    const prev = db.prepare('SELECT * FROM notice_analysis WHERE notice_id=? ORDER BY version_no DESC LIMIT 1').get(existing.id);
    db.prepare('UPDATE notice SET title=?,body_text=?,content_hash=?,latest_version=?,category=?,updated_at=?,deleted=0 WHERE id=?')
      .run(title, detail.bodyText, hash, v, category, now(), existing.id);
    db.prepare('INSERT INTO notice_version (notice_id,version_no,title,body_text,content_hash,detected_at) VALUES (?,?,?,?,?,?)').run(existing.id, v, title, detail.bodyText, hash, now());
    storeAttachments(db, existing.id, detail);
    saveAnalysis(db, existing.id, v, a);
    const fields = prev ? diffAnalysis(prev, a) : [];
    const ch = db.prepare('INSERT INTO notice_change (notice_id,from_version,to_version,changed_fields_json,ai_summary,detected_at) VALUES (?,?,?,?,?,?)')
      .run(existing.id, existing.latest_version, v, JSON.stringify(fields), changeSummary(fields), now());
    return { type: 'change', noticeId: existing.id, changeId: Number(ch.lastInsertRowid) };
  });
}

async function fetchText(url, ctx) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await ctx.fetch(url, { headers: { 'user-agent': cfg.userAgent, 'accept-language': 'ko' }, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function crawlSource(db, src, ctx) {
  const events = [], seen = new Set();
  const cats = src.categories ? Object.keys(src.categories) : [null];
  const limit = 10;
  const recheckFrom = new Date(Date.now() - cfg.recheckDays * 86400000).toISOString().slice(0, 10);
  const pages = src.scope === 'dept' ? Math.min(ctx.maxPages, ctx.deptPages) : ctx.maxPages;
  const sub = Object.assign({}, ctx, { analyzer: src.scope === 'dept' ? ctx.deptAnalyzer : ctx.analyzer });
  // 상단 고정('공지')은 이번 목록 기준으로 다시 매긴다: 고정이 풀린 글은 0 으로, 고정글은 게시판 위 순서대로
  db.prepare('UPDATE notice_board SET pinned=0, pin_rank=NULL WHERE source_key=?').run(src.key);
  let pinRank = 0;
  const markPin = row => db.prepare('UPDATE notice_board SET pinned=?, pin_rank=? WHERE source_key=? AND notice_id=(SELECT id FROM notice WHERE campus_id=? AND external_no=?)')
    .run(row.pinned ? 1 : 0, row.pinned ? pinRank++ : null, src.key, src.campus, row.no);
  for (const catId of cats) {
    for (let page = 0; page < pages; page++) {
      const html = await fetchText(listUrl(src, catId, page * limit, limit), ctx);
      const { rows } = parseList(html);
      if (!rows.length) break;
      for (const row of rows) {
        const key = row.no; if (seen.has(key)) continue; seen.add(key);
        const ex = db.prepare('SELECT id,posted_at,deleted FROM notice WHERE campus_id=? AND external_no=?').get(src.campus, row.no);
        const recent = ex && ex.posted_at && ex.posted_at >= recheckFrom;
        if (ex && !recent && !ex.deleted) {
          // 오래된 공지는 다시 열지 않지만, 목록에서 그대로 있는 것을 확인한 시각과 게시판은 남긴다
          db.prepare(`UPDATE notice SET is_pinned=?, checked_at=?${src.scope === 'dept' ? '' : ", scope='campus'"} WHERE id=?`).run(row.pinned ? 1 : 0, now(), ex.id);
          db.prepare('INSERT OR IGNORE INTO notice_board (notice_id,source_key) VALUES (?,?)').run(ex.id, src.key);
          markPin(row);
          continue;
        }
        try {
          await sleep(ctx.delayMs);
          const detail = parseDetail(await fetchText(viewUrl(src, row.no), ctx), viewUrl(src, row.no));
          const ev = await upsertNotice(db, src, row, detail, sub);
          markPin(row);
          if (ev) events.push(ev);
        } catch (e) { console.warn(`[crawl] ${src.key} #${row.no} 실패: ${e.message}`); ctx.errors.push(`${src.key}#${row.no}: ${e.message}`); }
      }
      await sleep(ctx.delayMs);
    }
  }
  return events;
}

/* 모든 활성 수집원을 순회. 한 게시판이 실패해도 다른 캠퍼스·게시판은 계속한다. */
async function crawlAll(db, opts) {
  opts = opts || {};
  const analyzer = opts.analyzer || (n => analyze(n, opts.fetch));
  // 학과 게시판은 공지가 많아서 기본은 규칙 기반 분석 + 이미지 OCR (DEPT_AI=1 이면 Claude). 번역은 나중에 translateMissing 이 채운다
  const deptAnalyzer = opts.analyzer || (cfg.deptAi ? analyzer : n => localAnalyze(n, opts.fetch));
  const ctx = { fetch: opts.fetch || fetch, analyzer, deptAnalyzer,
    maxPages: opts.maxPages || cfg.crawlMaxPages, deptPages: opts.deptPages || cfg.crawlDeptPages,
    delayMs: opts.delayMs != null ? opts.delayMs : cfg.crawlDelayMs, errors: [] };
  const events = [];
  for (const src of SOURCES) {
    if (opts.only && !opts.only.includes(src.key)) continue;
    if (src.scope === 'dept' && !cfg.crawlDepts && !(opts.only && opts.only.includes(src.key))) continue;
    const row = db.prepare('SELECT active FROM notice_source WHERE key=?').get(src.key);
    if (!row || !row.active) continue;
    try {
      events.push(...await crawlSource(db, src, ctx));
      db.prepare('UPDATE notice_source SET last_crawled_at=?, last_error=NULL WHERE key=?').run(now(), src.key);
    } catch (e) {
      console.warn(`[crawl] ${src.key} 실패: ${e.message}`);
      db.prepare('UPDATE notice_source SET last_error=? WHERE key=?').run(String(e.message).slice(0, 300), src.key);
      ctx.errors.push(`${src.key}: ${e.message}`);
    }
  }
  return { events, errors: ctx.errors };
}

/* 저장된 공지를 다시 분석한다 (분석 규칙이 바뀌었거나 API 키를 새로 넣었을 때).
 * 기본: 규칙 기반으로 분석된 것만 / all: 시드를 뺀 전부. 본문이 그대로라 정정 이력은 만들지 않는다 */
async function reanalyzeAll(db, opts) {
  opts = opts || {};
  const analyzer = opts.analyzer || (n => analyze(n, opts.fetch));
  const rows = db.prepare(`SELECT n.*, a.model, a.ocr FROM notice n JOIN notice_analysis a ON a.notice_id=n.id AND a.version_no=n.latest_version
    WHERE n.deleted=0 AND n.content_hash<>'seed' ORDER BY n.posted_at DESC`).all()
    .filter(r => opts.all || !r.model || /^rules/.test(r.model))
    // images: 이미지가 있는데 아직 이미지 글자를 읽지 않은 공지만 (OCR 를 새로 설치했을 때). images:'all' 이면 이미 읽은 것도 다시
    .filter(r => !opts.images || ((opts.images === 'all' || !r.ocr) && db.prepare("SELECT 1 FROM notice_attachment WHERE notice_id=? AND kind='image' LIMIT 1").get(r.id)));
  let done = 0, failed = 0;
  for (const r of rows) {
    const att = db.prepare('SELECT kind,file_name,file_url FROM notice_attachment WHERE notice_id=?').all(r.id);
    const n = { title: r.title, bodyText: r.body_text, category: r.category, postedAt: r.posted_at,
      images: att.filter(x => x.kind === 'image').map(x => x.file_url), attachments: att.filter(x => x.kind === 'file').map(x => ({ name: x.file_name, url: x.file_url })) };
    try { saveAnalysis(db, r.id, r.latest_version, await analyzer(n)); done++; }
    catch (e) { failed++; console.warn(`[reanalyze] #${r.id} 실패: ${e.message}`); }
    if (opts.onProgress) opts.onProgress(done + failed, rows.length);
  }
  return { total: rows.length, done, failed };
}

/* 번역이 없는 공지만 번역해서 붙인다(분석은 그대로). 이미 번역된 공지는 건너뛰므로 여러 번 돌려도 무료 한도를 아낀다 */
async function translateMissing(db, opts) {
  opts = opts || {};
  const { translateSummary, QuotaError } = require('./translate');
  const rows = db.prepare(`SELECT n.id, n.title, a.id AS aid, a.summary_json FROM notice n
    JOIN notice_analysis a ON a.notice_id=n.id AND a.version_no=n.latest_version
    WHERE n.deleted=0 AND NOT EXISTS (SELECT 1 FROM notice_translation t WHERE t.analysis_id=a.id) ORDER BY n.posted_at DESC`).all();
  const ins = db.prepare('INSERT OR REPLACE INTO notice_translation (analysis_id,lang,title,summary_json,created_at) VALUES (?,?,?,?,?)');
  let done = 0, failed = 0, chars = 0;
  for (const r of rows) {
    const ko = JSON.parse(r.summary_json).ko || {};
    try {
      const tr = await translateSummary(r.title, ko, opts.fetch, opts.key);
      for (const [lang, t] of Object.entries(tr)) { const { title, ...sum } = t; ins.run(r.aid, lang, title, JSON.stringify(sum), now()); }
      chars += [r.title, ko.gist, ko.who, ko.benefit, ko.docs, ko.how].reduce((s, x) => s + (x || '').length, 0) * 2;
      done++;
    } catch (e) {
      if (e instanceof QuotaError) { console.warn('[translate] ' + e.message + ' — 다음 달에 다시 돌리면 나머지를 번역해요'); break; }
      failed++; console.warn(`[translate] #${r.id} 실패: ${e.message}`);
    }
    if (opts.onProgress) opts.onProgress(done + failed, rows.length);
    if (opts.delayMs !== 0) await sleep(opts.delayMs || 200);
  }
  return { total: rows.length, done, failed, chars };
}

module.exports = { parseList, parseDetail, listUrl, viewUrl, crawlAll, upsertNotice, saveAnalysis, diffAnalysis, changeSummary, reanalyzeAll, translateMissing };
