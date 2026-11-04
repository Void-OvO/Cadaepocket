'use strict';
const path = require('node:path');
const fs = require('node:fs');

/* .env 를 아주 단순하게 읽는다 (외부 패키지 없음) */
(function loadEnv() {
  const f = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
})();

const root = path.join(__dirname, '..');
module.exports = {
  root,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',                          // 배포 서버에서는 127.0.0.1 (밖에서는 Caddy 가 HTTPS 로 받아 넘김)
  dbFile: process.env.DB_FILE || path.join(root, 'data', 'catolimi.db'),
  webDir: path.join(root, 'web'),
  adminToken: process.env.ADMIN_TOKEN || '',
  crawlIntervalMin: Number(process.env.CRAWL_INTERVAL_MIN || 30),
  crawlMaxPages: Number(process.env.CRAWL_MAX_PAGES || 2),     // 게시판(분류)마다 가져올 목록 페이지 수
  crawlDelayMs: Number(process.env.CRAWL_DELAY_MS || 700),     // 학교 서버 부담을 줄이는 요청 간격
  recheckDays: Number(process.env.RECHECK_DAYS || 14),         // 최근 N일 공지는 매번 다시 열어 정정 여부 확인
  crawlDepts: process.env.CRAWL_DEPTS !== '0',                  // 학과 게시판(약 40곳) 수집
  crawlDeptPages: Number(process.env.CRAWL_DEPT_PAGES || 1),    // 학과 게시판마다 가져올 목록 페이지 수
  deptAi: process.env.DEPT_AI === '1',                          // 학과 공지도 Claude 로 분석 (기본: 규칙 기반, API 비용 절약)
  // 이미지 공지 글자 읽기(OCR). Claude 키가 없거나 실패하면 서버의 Tesseract 로 읽고 규칙 기반 분석에 넣는다
  ocr: process.env.OCR !== '0',
  ocrCmd: process.env.OCR_CMD || 'tesseract',
  ocrLang: process.env.OCR_LANG || 'kor+eng',
  ocrMaxImages: Number(process.env.OCR_MAX_IMAGES || 4),
  userAgent: process.env.CRAWL_USER_AGENT || 'CatolimiBot/0.1 (student project; contact: set CRAWL_USER_AGENT)',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  deeplKey: process.env.DEEPL_API_KEY || '',                     // 공지 제목·요약 영어·중국어 번역 (DeepL API Free 키는 ':fx' 로 끝남)
  vapidPublic: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivate: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  tz: 'Asia/Seoul'
};
