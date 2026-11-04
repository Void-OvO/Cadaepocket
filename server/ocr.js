'use strict';
/* 이미지 공지 글자 읽기 (OCR)
 * 학교 공지는 본문 대신 포스터 이미지 한 장만 올리는 경우가 많다. Claude API 키가 없거나 Claude 가 실패해도
 * 대상·기간을 읽을 수 있도록 서버에 설치한 Tesseract(무료, 한국어 학습 데이터)로 글자를 뽑는다.
 * 외부 npm 패키지 없이 tesseract 명령을 직접 실행하고, 이미지는 임시 파일 없이 표준 입력으로 넘긴다. */
const { spawn, spawnSync } = require('node:child_process');
const cfg = require('./config');

const MAX_BYTES = 8 * 1024 * 1024;
let avail = null;
/* tesseract 가 설치돼 있고 한국어 데이터가 있는지 (한 번만 확인) */
function available() {
  if (avail !== null) return avail;
  if (!cfg.ocr) return (avail = false);
  try {
    const r = spawnSync(cfg.ocrCmd, ['--list-langs'], { encoding: 'utf8', timeout: 10000 });
    const langs = ((r.stdout || '') + (r.stderr || '')).split(/\s+/);
    avail = r.status === 0 && cfg.ocrLang.split('+').every(l => langs.includes(l));
  } catch (_) { avail = false; }
  return avail;
}

/* tesseract TSV 출력 → 줄 단위 글자 + 평균 신뢰도(0~1) */
function parseTsv(tsv) {
  const lines = new Map(); let sum = 0, cnt = 0;
  for (const row of String(tsv).split(/\r?\n/).slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;               // level 5 = 단어
    const word = c.slice(11).join('\t').trim(), conf = Number(c[10]);
    if (!word) continue;
    const key = c[2] + '.' + c[3] + '.' + c[4];                  // block.par.line
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(word);
    if (conf >= 0) { sum += conf; cnt++; }
  }
  // 한국어는 Tesseract 가 글자마다 띄어 쓰는 일이 많다("재 학 생"). 한 글자짜리 한글 조각은 옆 한글에 붙인다
  const H = /[가-힣]/;
  const join = ws => ws.reduce((s, w, i) => {
    if (!i) return w;
    const prev = ws[i - 1], glue = H.test(prev.slice(-1)) && H.test(w[0]) && ([...prev].length === 1 || [...w].length === 1);
    return s + (glue ? '' : ' ') + w;
  }, '');
  const text = [...lines.values()].map(join).join('\n')
    .replace(/(\d)\s*\.\s*(\d)/g, '$1.$2')                       // "2026 . 11 . 20" → "2026.11.20"
    .replace(/(\d)\s*([:~])\s*(\d)/g, '$1$2$3');
  return { text, conf: cnt ? Math.round(sum / cnt) / 100 : 0 };
}

function runTesseract(buf) {
  return new Promise((ok, no) => {
    const p = spawn(cfg.ocrCmd, ['stdin', 'stdout', '-l', cfg.ocrLang, '--psm', '3', 'tsv'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    const t = setTimeout(() => { p.kill('SIGKILL'); no(new Error('ocr timeout')); }, 90000);
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
    p.on('error', e => { clearTimeout(t); no(e); });
    p.on('close', code => {
      clearTimeout(t);
      if (code !== 0) return no(new Error('tesseract ' + code + ' ' + Buffer.concat(err).toString().slice(0, 160)));
      ok(Buffer.concat(out).toString('utf8'));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

async function fetchBytes(url, f) {
  const r = await f(url, { headers: { 'user-agent': cfg.userAgent }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('image ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('image too large');
  return buf;
}

/* 이미지 주소들 → [{ url, text, conf }] (못 읽은 이미지는 빠진다). 공지 하나의 이미지는 순서대로 하나씩 읽는다 (서버 메모리 절약) */
async function readImages(urls, f) {
  f = f || fetch;
  const out = [];
  for (const url of (urls || []).slice(0, cfg.ocrMaxImages)) {
    try {
      const r = parseTsv(await runTesseract(await fetchBytes(url, f)));
      if (r.text.replace(/\s/g, '').length >= 8) out.push({ url, text: r.text, conf: r.conf });
    } catch (e) { console.warn('[ocr] 실패:', url, e.message); }
  }
  return out;
}

module.exports = { available, readImages, parseTsv };
