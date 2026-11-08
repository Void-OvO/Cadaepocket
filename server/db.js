'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');
const { CAMPUSES, SOURCES } = require('./sources');

/* ERD 의 서버 쪽 테이블. 학과·학점 같은 개인 프로필은 서버에 저장하지 않는다(기기에만 저장).
 * 푸시 구독에는 캠퍼스·분류·알림 시점 같은 '알림 설정'만 둔다. */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS campus (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, site_host TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notice_source (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  campus_id TEXT NOT NULL REFERENCES campus(id),
  board TEXT NOT NULL,
  url TEXT NOT NULL,
  crawl_interval_min INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  last_crawled_at TEXT, last_error TEXT
);

CREATE TABLE IF NOT EXISTS notice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES notice_source(id),
  campus_id TEXT NOT NULL REFERENCES campus(id),
  external_no INTEGER NOT NULL,
  category TEXT NOT NULL,                 -- aca | sch | gen | job | evt
  is_pinned INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  dept TEXT,
  posted_at TEXT,                         -- YYYY-MM-DD
  original_url TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  latest_version INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (campus_id, external_no)         -- 통합 게시판과 단과대학 게시판의 같은 글을 하나로 합침
);
CREATE INDEX IF NOT EXISTS idx_notice_campus ON notice(campus_id, posted_at DESC);

CREATE TABLE IF NOT EXISTS notice_attachment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notice(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                     -- file | image
  file_name TEXT, file_url TEXT NOT NULL,
  extracted_text TEXT, ocr_confidence REAL
);

CREATE TABLE IF NOT EXISTS notice_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notice(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  title TEXT NOT NULL, body_text TEXT NOT NULL,
  content_hash TEXT NOT NULL, detected_at TEXT NOT NULL,
  UNIQUE (notice_id, version_no)
);

CREATE TABLE IF NOT EXISTS notice_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notice(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  criteria_json TEXT NOT NULL,            -- 자격요건 (statuses, grades, minGpa, ..., uncertain)
  summary_json TEXT NOT NULL,             -- who / docs / how / period
  apply_start TEXT, apply_end TEXT,
  source_kind TEXT NOT NULL,              -- text | image | attachment
  ocr INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (notice_id, version_no)
);

CREATE TABLE IF NOT EXISTS notice_translation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES notice_analysis(id) ON DELETE CASCADE,
  lang TEXT NOT NULL, title TEXT, summary_json TEXT, created_at TEXT NOT NULL,
  UNIQUE (analysis_id, lang)
);

CREATE TABLE IF NOT EXISTS notice_change (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notice(id) ON DELETE CASCADE,
  from_version INTEGER NOT NULL, to_version INTEGER NOT NULL,
  changed_fields_json TEXT NOT NULL,      -- [{field,from,to}]
  ai_summary TEXT, detected_at TEXT NOT NULL,
  pushed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS push_subscription (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  campus_id TEXT NOT NULL REFERENCES campus(id),
  lang TEXT NOT NULL DEFAULT 'ko',
  categories_json TEXT NOT NULL DEFAULT '[]',   -- 알림 받을 분류
  lead_days_json TEXT NOT NULL DEFAULT '[3,1]', -- 마감 며칠 전
  change_alert INTEGER NOT NULL DEFAULT 1,
  profile_json TEXT,                            -- 미리 거르기용 대략적인 조건 {status,done,exchange}. 학과·평점은 받지 않는다
  saved_json TEXT NOT NULL DEFAULT '[]',        -- 저장한 공지 번호: 마감·정정 알림은 이 공지에만 보낸다
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER, notice_id INTEGER,
  kind TEXT NOT NULL,                     -- new | deadline | change
  dedupe_key TEXT NOT NULL,
  status INTEGER, sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pushlog ON push_log(dedupe_key);

-- 공지를 본 게시판(통합·단과대·학과 게시판). 학과 탭은 이 표로 그 학과 게시판의 공지를 고른다
CREATE TABLE IF NOT EXISTS notice_board (
  notice_id INTEGER NOT NULL REFERENCES notice(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,      -- 그 게시판에서 상단 고정('공지')인지. 게시판마다 다를 수 있다
  pin_rank INTEGER,                       -- 고정글의 게시판 위 순서 (사이트와 같은 순서로 보여 주기)
  PRIMARY KEY (notice_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_notice_board_src ON notice_board(source_key);

CREATE TABLE IF NOT EXISTS error_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notice(id) ON DELETE CASCADE,
  note TEXT, status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL, resolved_at TEXT
);
`;

function open(file) {
  file = file || cfg.dbFile;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // 예전 DB 에는 profile_json 칸이 없다
  const cols = db.prepare('PRAGMA table_info(push_subscription)').all().map(c => c.name);
  if (!cols.includes('profile_json')) db.exec('ALTER TABLE push_subscription ADD COLUMN profile_json TEXT');
  if (!cols.includes('saved_json')) db.exec("ALTER TABLE push_subscription ADD COLUMN saved_json TEXT NOT NULL DEFAULT '[]'");
  // 공지 범위(campus: 홈 피드 / dept: 학과 게시판에서만 본 공지)와 앱이 원문을 마지막으로 확인한 시각
  const ncols = db.prepare('PRAGMA table_info(notice)').all().map(c => c.name);
  if (!ncols.includes('scope')) db.exec("ALTER TABLE notice ADD COLUMN scope TEXT NOT NULL DEFAULT 'campus'");
  if (!ncols.includes('checked_at')) db.exec('ALTER TABLE notice ADD COLUMN checked_at TEXT');
  const bcols = db.prepare('PRAGMA table_info(notice_board)').all().map(c => c.name);
  if (!bcols.includes('pinned')) db.exec('ALTER TABLE notice_board ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  if (!bcols.includes('pin_rank')) db.exec('ALTER TABLE notice_board ADD COLUMN pin_rank INTEGER');
  // 알림 모아 보기: 보낸 알림의 제목·내용·이동 주소를 남긴다 (예전 기록은 비어 있고, 공지 제목으로 채워 보여 준다)
  const lcols = db.prepare('PRAGMA table_info(push_log)').all().map(c => c.name);
  if (!lcols.includes('title')) db.exec('ALTER TABLE push_log ADD COLUMN title TEXT');
  if (!lcols.includes('body')) db.exec('ALTER TABLE push_log ADD COLUMN body TEXT');
  if (!lcols.includes('url')) db.exec('ALTER TABLE push_log ADD COLUMN url TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pushlog_sub ON push_log(subscription_id, id)');
  const scols = db.prepare('PRAGMA table_info(notice_source)').all().map(c => c.name);
  if (!scols.includes('scope')) db.exec("ALTER TABLE notice_source ADD COLUMN scope TEXT NOT NULL DEFAULT 'campus'");
  const insC = db.prepare('INSERT OR IGNORE INTO campus (id,name,site_host) VALUES (?,?,?)');
  Object.values(CAMPUSES).forEach(c => insC.run(c.id, c.name, c.host));
  const insS = db.prepare('INSERT OR IGNORE INTO notice_source (key,campus_id,board,url,active,scope) VALUES (?,?,?,?,?,?)');
  SOURCES.forEach(s => insS.run(s.key, s.campus, s.board, s.base, s.active ? 1 : 0, s.scope || 'campus'));
  // 예전 공지는 처음 수집한 게시판에서 본 것으로 기록
  db.exec('INSERT OR IGNORE INTO notice_board (notice_id,source_key) SELECT n.id, s.key FROM notice n JOIN notice_source s ON s.id=n.source_id');
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const now = () => new Date().toISOString();
module.exports = { open, tx, now, SCHEMA };
