'use strict';
/* 공지 → 자격요건·요약 JSON.
 *  1) ANTHROPIC_API_KEY 가 있으면 Claude 가 본문과 이미지(포스터)를 함께 읽고 구조화한다.
 *  2) 없거나 실패하면 규칙 기반으로 최소한을 뽑고, 모르는 값은 '확인 필요(uncertain)'로 남긴다.
 *     이때 본문이 이미지뿐이면 서버의 OCR(Tesseract)로 이미지 글자를 읽어 규칙 분석에 넣는다 (ocr.js). */
const cfg = require('./config');
const ocr = require('./ocr');
/* '졸업 예정'은 따로 두지 않는다. 졸업 예정자 대상 공지는 4학년 대상으로 본다 */
const STATUSES = ['재학', '휴학', '복학 예정'];

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => (y + '-' + pad(m) + '-' + pad(d));
function validDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/* ───────── 규칙 기반 ───────── */
const DATE_RE = /(?:(\d{4})\s*(?:[.년]|-)\s*)?(\d{1,2})\s*(?:[.월]|-)\s*(\d{1,2})\s*[.일]?/g;

function findDates(text, postedAt) {
  const py = postedAt ? +postedAt.slice(0, 4) : new Date().getUTCFullYear();
  const pm = postedAt ? +postedAt.slice(5, 7) : 1;
  const out = [];
  let lastYear = null, m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(text))) {
    let y = m[1] ? +m[1] : null, mo = +m[2], d = +m[3];
    if (y == null) {
      y = lastYear != null ? lastYear : py;
      if (lastYear == null && mo < pm - 6) y += 1;           // 12월 게시글의 '1.15' 같은 경우
    } else lastYear = y;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || !validDate(y, mo, d)) continue;
    // 시각(10:00)이나 소수(3.5)로 잘못 잡힌 것을 거른다
    const before = text.slice(Math.max(0, m.index - 1), m.index), after = text.slice(DATE_RE.lastIndex, DATE_RE.lastIndex + 1);
    if (/\d/.test(before) || (!m[1] && /\d/.test(after))) continue;
    out.push({ y, m: mo, d, idx: m.index, end: DATE_RE.lastIndex, iso: iso(y, mo, d) });
  }
  return out;
}

function findPeriod(text, postedAt) {
  const ds = findDates(text, postedAt);
  const between = /^\s*(?:\([^)]{1,4}\))?\s*(?:\d{1,2}[:시]\d{0,2})?\s*(?:\([^)]{1,4}\))?\s*[~∼～\-–]\s*$/;
  // 1) A ~ B 범위. 여러 개면 바로 앞(같은 줄·윗줄)에 '신청·접수·모집·제출' 이 붙은 범위를 고른다 (납부·입사 기간 등보다 우선)
  const ranges = [];
  for (let i = 0; i + 1 < ds.length; i++) {
    const mid = text.slice(ds[i].end, ds[i + 1].idx);
    if (mid.length < 24 && between.test(mid.replace(/\s+/g, ' '))) ranges.push({ start: ds[i].iso, end: ds[i + 1].iso, range: true, firstIdx: ds[i].idx });
  }
  if (ranges.length) {
    const APPLY = /신\s*청|접\s*수|모\s*집|제\s*출|지\s*원\s*기\s*간/;
    // 같은 줄에 붙은 것을 먼저, 없으면 윗줄까지 본다 (표에서 항목 이름이 윗줄에 있는 경우)
    const line = r => { const s = text.slice(Math.max(0, r.firstIdx - 80), r.firstIdx); return s.slice(s.lastIndexOf('\n') + 1); };
    const two = r => { const s = text.slice(Math.max(0, r.firstIdx - 120), r.firstIdx), nl = s.lastIndexOf('\n'); return s.slice(Math.max(0, s.lastIndexOf('\n', nl - 1))); };
    return ranges.find(r => APPLY.test(line(r))) || ranges.find(r => APPLY.test(two(r))) || ranges[0];
  }
  // 2) '...까지'
  for (const d of ds) {
    if (/^\s*(?:\([^)]{1,4}\))?\s*(?:\d{1,2}[:시]\d{0,2}분?)?\s*까지/.test(text.slice(d.end, d.end + 20))) return { start: null, end: d.iso, range: false };
  }
  return { start: null, end: null, range: false };
}

const bullet = s => s.replace(/^[:：\s]+/, '').replace(/^(?:[-·•※▷▶○■◆ㆍ]\s*)+/, '').trim();
/* 다음 항목의 시작으로 보이는 줄: "3. …", "가. …", "○ …", "신청기간 : …" */
const NEXT_ITEM = /^(?:\d+\s*[.)]|[가-하]\s*[.)]|[○■▶◆□◎●【]|[^\s:：]{1,10}\s*[:：])/;

/* 항목 이름 뒤의 내용. 아래로 이어지는 "- …" 줄도 최대 4줄까지 함께 읽는다 */
function section(text, labels, maxLen) {
  maxLen = maxLen || 220;
  for (const lab of labels) {
    // 항목 이름 바로 뒤에 ':' 나 줄바꿈이 와야 한다. ("대상 과목 : …", "지원 자격 및 우대 사항" 같은 줄을 대상으로 잘못 읽지 않게)
    const re = new RegExp('(?:^|\\n)[ \\t]*(?:\\d+[.)]|[○ㆍ·■▶◆□※-])?[ \\t]*' + lab + '[ \\t]*(?:[:：][ \\t]*\\n?|\\n)[ \\t]*([^\\n]{2,160})', 'm');
    const m = re.exec(text);
    if (!m) continue;
    const parts = [bullet(m[1])];
    for (const line of text.slice(m.index + m[0].length).split('\n').slice(1, 5)) {
      const l = line.trim();
      if (!l || NEXT_ITEM.test(l) || NEXT_ITEM.test(bullet(l))) break;   // "- 신청기간: …" 처럼 글머리 기호가 붙은 다음 항목도 멈춘다
      parts.push(bullet(l));
      if (parts.join(' · ').length >= maxLen) break;
    }
    const s = parts.filter(Boolean).join(' · ');
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
  }
  return null;
}

/* 핵심 요약: 본문 앞부분에서 "무엇을 하는 공지인지" 설명하는 첫 문장(들).
 * 인사말·"- 다 음 -"·번호 항목·"항목 : 값" 줄은 건너뛴다. */
function gistOf(title, body) {
  const SKIP = /^(?:[^\s)]{1,4}\)|-?\s*다\s*음\s*-?$|안녕하|<|>|※|\(|-|•|"|“|\d+\s*[.)]|[가-하]\s*[.)]|[○■▶◆□◎●【\[])|(?:안내|공고|모집|개최|알림)\s*(?:\([^)]*\))?$/;
  const isItem = l => !l || SKIP.test(l) || /^[^\s:：]{1,10}\s*[:：]/.test(l);
  const norm = s => s.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/[^0-9A-Za-z가-힣]/g, '');
  const t = norm(title);
  const lines = body.split('\n').map(s => s.trim()).slice(0, 20);
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (l.length < 15 || isItem(l)) continue;
    const g = norm(l);
    if (t.includes(g) || (g.includes(t) && g.length < t.length + 12)) continue;   // 제목을 되풀이하는 줄은 요약이 아니다
    // 본문이 문장 중간에서 줄바꿈된 경우 다음 줄(최대 2줄)을 이어 붙인다
    for (let j = i + 1; j < i + 3 && j < lines.length && !/[.!?。]$|[다요]$/.test(l) && !isItem(lines[j]); j++) l += ' ' + lines[j];
    const sents = l.split(/(?<=(?:다|요|함|음|임)\.)\s+/);   // "2026. 11. 3." 같은 날짜에서 끊기지 않게 문장 끝만 본다
    const s = sents.slice(0, 2).join(' ').trim();
    return s.length > 140 ? s.slice(0, 139) + '…' : s;
  }
  return '';
}

function rulesAnalyze(n) {
  const body = n.bodyText || '';
  const text = n.title + '\n' + body;
  const head = text.slice(0, 1500);
  const per = findPeriod(text, n.postedAt);
  const uncertain = [];
  let statuses = null;
  const st = new Set();
  if (/재학생|재학 중/.test(head)) st.add('재학');
  if (/휴학생|휴학 중/.test(head) && !/휴학생\s*(?:및\s*대학원생\s*)?제외/.test(head)) st.add('휴학');
  if (/복학\s*(?:예정|대상)/.test(head)) { st.add('복학 예정'); st.add('휴학'); }
  // "학부생·대학원생·휴학생"처럼 휴학생을 '포함'해 적은 공지를 휴학생 전용으로 좁히지 않는다 (재학생에게 숨겨지면 안 됨)
  if (st.has('휴학') && !st.has('재학') && /학부생|학부\s*[\/·,]|대학원생|재적생|누구나|전체\s*학생|모든\s*학생|휴학생\s*(?:도|포함)/.test(head)) st.add('재학');
  if (st.size) statuses = STATUSES.filter(s => st.has(s));

  // 대상 문구: "지원 자격" 다음 줄처럼 항목 이름과 다른 줄에 적힌 경우도 잡는다. 학년 판단에도 쓴다
  const who = section(text, ['신청\\s*대상', '지원\\s*대상', '모집\\s*대상', '참가\\s*대상', '신청\\s*자격', '지원\\s*자격', '대상자', '대\\s*상', '자\\s*격']) || '';
  // 학년 판단에 쓸 글: 대상 문구의 조각들(" · "로 이어 붙인 줄) + 본문에서 "대상·자격·재학"이 들어간 줄
  const targets = who.split(' · ').concat(head.split('\n').filter(l => /대\s*상|자\s*격|재학/.test(l)));
  const NEG = /제외|해당\s*(?:사항\s*)?없|불가|수료|진학\s*예정/;

  // 학년은 대상 문구에 있을 때만 대상 학년으로 본다. 학년을 잘못 좁히면 해당 학생에게 공지가 숨겨지므로
  // 제외·해당 없음·수료·진학 예정처럼 뜻이 뒤집히거나 애매한 줄은 건너뛰고, 확실하지 않으면 null(전체)로 둔다.
  let grades = null;
  for (const line of targets) {
    if (NEG.test(line)) continue;
    const g = line.match(/(?<!\d)([1-4](?:\s*[·,~∼～-]\s*[1-4])*)\s*학년(?!도)(\s*이상)?/);
    if (!g) continue;
    const nums = g[1].match(/\d/g).map(Number);
    const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    grades = g[2] ? range(nums[0], 4) : /[~∼～-]/.test(g[1]) ? range(nums[0], nums[nums.length - 1]) : nums;
    break;
  }
  // 졸업 예정자·졸업생만 대상이면 4학년 (예: "초대졸 이상, 기졸업자 및 2027년 2월 졸업 예정자").
  // "재학생 및 졸업예정자"처럼 다른 대상과 함께면 넓히지도 좁히지도 않는다
  if (!grades) for (const line of targets) {
    if (!/졸업\s*예정|기\s*졸업|졸업\s*(?:생|자)/.test(line) || NEG.test(line) || /재학생|재학\s*중|휴학생|누구나|전체|전\s*학년|(?<!\d)[1-4]\s*학년(?!도)/.test(line)) continue;
    grades = [4]; break;
  }
  const gp = head.match(/(?:평점|평균\s*학점|학점)[^\n.]{0,14}?([0-4]\.\d{1,2})\s*(?:\/\s*4\.5\s*)?이상/);
  const minGpa = gp ? Number(gp[1]) : null;
  const dn = head.match(/(\d)\s*학기\s*이상\s*이수/);
  const minDone = dn ? Number(dn[1]) : null;

  // 교환·외국인 학생: 대상 문구가 유학생·외국인·교환학생만 가리키면 전용, "제외/불가"면 제외.
  // "(외국인 유학생 포함)", "내국인 및 외국인", "누구나"처럼 다른 학생도 대상이면 아무것도 정하지 않는다
  let audience = null, excludeExchange = false;
  const INTL = /유학생|외국인|교환\s*학생|international\s+students?|exchange\s+students?/i;
  const MIXED = /포함|내국인|한국인|국내\s*학생|재학생|누구나|전원|전체|전\s*학년|모든\s*학생/;
  for (const line of targets) {
    if (!INTL.test(line)) continue;
    if (/(?:유학생|외국인|교환\s*학생)[^\n]{0,60}(?:제외|불가)/.test(line)) { excludeExchange = true; continue; }
    if (MIXED.test(line)) continue;
    audience = 'exchange'; break;
  }
  // 전용은 아니어도 주로 외국인·교환학생을 위한 공지(제목이나 대상에 유학생 등이 들어감): 내국인에게는 순위를 낮춘다.
  // "(외국인 유학생 포함)", "전원"처럼 모두가 대상이면 낮추지 않는다
  const intl = !audience && !excludeExchange && ((INTL.test(n.title) && !MIXED.test(n.title)) || (INTL.test(who) && !MIXED.test(who)));
  if (/(학과장|지도교수|학부\(과\)장)[^\n]{0,12}추천/.test(text)) uncertain.push({ ko: '학과장·지도교수 추천이 필요한지' });
  if (/성적[^\n]{0,10}(향상|상승)|\d+점\s*이상\s*(향상|상승)/.test(head)) uncertain.push({ ko: '직전 학기 대비 성적 상승 여부' });
  if (/수급자|차상위/.test(head)) uncertain.push({ ko: '기초생활수급·차상위 여부' });
  const imageOnly = body.replace(/\s/g, '').length < 120 && (n.images || []).length > 0;
  if (imageOnly) uncertain.push({ ko: '본문이 이미지라 대상·기간을 읽지 못했어요' });
  if (!per.end && !imageOnly) uncertain.push({ ko: '신청 마감일이 적혀 있지 않아요' });

  const docs =section(text, ['제출\\s*서류', '구비\\s*서류', '제출물']) || '';
  const how = section(text, ['신청\\s*방법', '접수\\s*방법', '제출\\s*방법', '신청처']) || '';
  const benefit = section(text, ['지원\\s*내용', '지원\\s*금액', '장학\\s*금액', '지급\\s*금액', '장학금\\s*액', '혜\\s*택', '선발\\s*인원', '모집\\s*인원',
    '시상\\s*내역', '시상\\s*규모', '활동\\s*내용', '교육\\s*내용', '행사\\s*내용', '주요\\s*내용', '내\\s*용'], 160) || '';
  const gist = imageOnly ? '' : gistOf(n.title, body);
  return {
    criteria: { statuses, grades, minGpa, minDone, maxDone: null, audience, excludeExchange, intl, depts: null, uncertain, boost: null },
    summary: { ko: { gist, who, benefit, docs, how } },
    start: per.start, end: per.end,
    sourceKind: imageOnly ? 'image' : 'text', ocr: false, model: 'rules-v2'
  };
}

/* ───────── Claude (본문 + 이미지) ───────── */
const SYSTEM = [
  '너는 가톨릭대학교 공지를 학생용 앱에 맞게 구조화하는 추출기다.',
  '본문과 첨부된 이미지(포스터·표)에 실제로 적힌 내용만 사용하고 추측하지 않는다. 적혀 있지 않은 값은 null(문장 필드는 빈 문자열)이다.',
  '대상 조건을 실제보다 좁히면 해당 학생에게 공지가 숨겨지므로, 확실한 제한만 넣는다.',
  '"졸업 예정자"는 학적이 아니라 4학년으로 본다: 졸업 예정자나 졸업생만 대상이면 grades 를 [4] 로 둔다.'
].join(' ');

/* 응답 형식은 구조화 출력(output_config.format)으로 강제한다. 지원 범위: additionalProperties:false 필수, 숫자·길이 제약 없음 */
const nullable = s => ({ anyOf: [s, { type: 'null' }] });
const strField = d => ({ type: 'string', description: d });
const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    statuses: nullable({ type: 'array', items: { type: 'string', enum: STATUSES }, description: '대상 학적. 제한이 없으면 null' }),
    grades: nullable({ type: 'array', items: { type: 'integer', enum: [1, 2, 3, 4] }, description: '대상 학년. 제한이 없으면 null. 졸업 예정자·졸업생만 대상이면 [4]' }),
    minGpa: nullable({ type: 'number', description: '최소 평점(4.5 만점 기준)' }),
    minDone: nullable({ type: 'integer', description: '이수 학기 하한' }),
    maxDone: nullable({ type: 'integer', description: '이수 학기 상한' }),
    audience: nullable({ type: 'string', enum: ['exchange'], description: '교환·외국인 학생 전용이면 "exchange"' }),
    excludeExchange: { type: 'boolean', description: '교환·외국인 학생 제외면 true' },
    intl: { type: 'boolean', description: '전용은 아니지만 주로 외국인 유학생·교환학생을 위한 공지면 true (audience 가 "exchange" 면 false)' },
    depts: nullable({ type: 'array', items: { type: 'string' }, description: '특정 학과(예: 의학과, 간호학과)만 대상이면 학과 이름' }),
    start: nullable({ type: 'string', format: 'date', description: '신청·접수 시작일' }),
    end: nullable({ type: 'string', format: 'date', description: '신청·접수 최종 마감일' }),
    gist: strField('무엇에 관한 공지이고 학생이 무엇을 하면 되는지 1~2문장(100자 이내). 제목을 그대로 반복하지 않는다'),
    who: strField('대상과 자격 조건을 구체적으로(학년·학적·학점·학과·제외 대상 포함) 1~2문장'),
    benefit: strField('지원 금액·혜택·선발 인원·행사 일시와 장소 등 핵심 내용 1~2문장. 없으면 빈 문자열'),
    docs: strField('제출 서류 목록. 없으면 빈 문자열'),
    how: strField('신청 방법·제출처(사이트 메뉴 경로나 이메일 포함). 없으면 빈 문자열'),
    uncertain: { type: 'array', items: { type: 'string' }, description: '학적·학년·학점·이수학기·학과만으로는 판단할 수 없는 조건(예: 학과장 추천, 직전 학기 성적 상승, 수급자 여부, 신청 마감일 미기재)을 한국어 짧은 문장으로' },
    readFromImage: { type: 'boolean', description: '이미지에서 읽은 값이 하나라도 있으면 true' }
  }
};
/* 외국인 학생용 번역: 제목과 요약 문장들을 영어·중국어(간체)로. 분석과 같은 요청에서 받는다 */
const TR_FIELDS = ['title', 'gist', 'who', 'benefit', 'docs', 'how'];
const trSchema = lang => ({
  type: 'object', additionalProperties: false, required: TR_FIELDS,
  description: `공지 제목과 gist·who·benefit·docs·how 를 ${lang} 로 자연스럽게 번역. 한국어 필드가 빈 문자열이면 번역도 빈 문자열. 기관·프로그램 이름은 원어를 괄호로 남겨도 된다. 날짜·금액·숫자는 그대로`,
  properties: Object.fromEntries(TR_FIELDS.map(f => [f, { type: 'string' }]))
});
SCHEMA.properties.en = trSchema('영어');
SCHEMA.properties.zh = trSchema('중국어(간체)');
SCHEMA.required = Object.keys(SCHEMA.properties);

function userPrompt(n) {
  return `날짜에 연도가 없으면 게시일(${n.postedAt || '알 수 없음'})을 기준으로 연도를 정한다.
공지 제목: ${n.title}
분류: ${n.category}
본문 텍스트:
"""
${n.bodyText || ''}
"""
이미지가 있으면 이미지 안의 글자도 읽어서 반영한다.`;
}

async function fetchImage(url, f) {
  const r = await f(url, { headers: { 'user-agent': cfg.userAgent } });
  if (!r.ok) throw new Error('image ' + r.status);
  const type = (r.headers.get('content-type') || '').split(';')[0] || 'image/png';
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 4.5 * 1024 * 1024) throw new Error('image too large');
  return { type: /^image\/(png|jpe?g|gif|webp)$/.test(type) ? type.replace('jpg', 'jpeg') : 'image/png', data: buf.toString('base64') };
}

function sanitize(raw, n) {
  const arr = (v, ok) => Array.isArray(v) ? v.filter(ok) : null;
  const date = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && validDate(+v.slice(0, 4), +v.slice(5, 7), +v.slice(8, 10))) ? v : null;
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const statuses = arr(raw.statuses, s => STATUSES.includes(s));
  let grades = arr(raw.grades, g => [1, 2, 3, 4].includes(g));
  // 모델이 그래도 "졸업 예정"만 대상으로 돌려주면 4학년 대상으로 바꾼다
  if (Array.isArray(raw.statuses) && raw.statuses.includes('졸업 예정') && !(statuses && statuses.length) && !(grades && grades.length)) grades = [4];
  const str = v => (typeof v === 'string' ? v.trim().slice(0, 600) : '');
  const uncertain = (Array.isArray(raw.uncertain) ? raw.uncertain : []).filter(x => typeof x === 'string' && x.trim()).map(x => ({ ko: x.trim().slice(0, 120) }));
  return {
    criteria: {
      statuses: statuses && statuses.length ? statuses : null, grades: grades && grades.length ? grades : null,
      minGpa: num(raw.minGpa), minDone: Number.isInteger(raw.minDone) ? raw.minDone : null, maxDone: Number.isInteger(raw.maxDone) ? raw.maxDone : null,
      audience: raw.audience === 'exchange' ? 'exchange' : null, excludeExchange: raw.excludeExchange === true,
      intl: raw.intl === true && raw.audience !== 'exchange',
      depts: arr(raw.depts, s => typeof s === 'string' && s) && raw.depts.length ? raw.depts : null,
      uncertain, boost: null
    },
    summary: { ko: { gist: str(raw.gist), who: str(raw.who), benefit: str(raw.benefit), docs: str(raw.docs), how: str(raw.how) } },
    // 번역: 제목이 있는 언어만 남긴다 → saveAnalysis 가 notice_translation 에 저장
    translations: Object.fromEntries(['en', 'zh'].filter(l => raw[l] && str(raw[l].title))
      .map(l => [l, Object.fromEntries(TR_FIELDS.map(f => [f, str(raw[l][f])]))])),
    start: date(raw.start), end: date(raw.end),
    sourceKind: raw.readFromImage ? 'image' : 'text', ocr: raw.readFromImage === true, model: cfg.anthropicModel
  };
}

async function claudeAnalyze(n, f) {
  const content = [];
  const imgs = (n.images || []).slice(0, 6);
  for (const u of imgs) {
    try { const im = await fetchImage(u, f); content.push({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } }); }
    catch (_) { /* 못 받은 이미지는 건너뜀 */ }
  }
  content.push({ type: 'text', text: userPrompt(n) });
  // 외부 npm 패키지 없이 동작하는 프로젝트라 SDK 대신 Messages API 를 직접 호출한다
  const r = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
      'anthropic-beta': 'server-side-fallback-2026-07-01'          // 안전 분류기가 거절하면 서버가 다른 모델로 다시 시도
    },
    body: JSON.stringify({
      model: cfg.anthropicModel,
      max_tokens: 16000,                                             // 최신 모델은 사고(thinking)가 켜져 있고 그 토큰도 여기서 쓴다. 작으면 JSON 이 잘린다
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content }]
    }),
    signal: AbortSignal.timeout(180000)
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  if (j.stop_reason === 'refusal') throw new Error('refusal' + (j.stop_details && j.stop_details.category ? ' (' + j.stop_details.category + ')' : ''));
  if (j.stop_reason === 'max_tokens') throw new Error('응답이 max_tokens 에서 잘림');
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const out = sanitize(JSON.parse(txt), n);
  out.model = j.model || cfg.anthropicModel;                      // 대체 모델이 답했으면 그 모델 이름을 남긴다
  return out;
}

/* 규칙 기반 + 이미지 글자 읽기(OCR).
 * 본문이 이미지뿐이거나 본문에서 마감일을 못 찾았고 이미지가 있으면, 이미지 글자를 본문 뒤에 붙여 다시 규칙 분석한다.
 * reader(urls) → [{url,text,conf}] 는 테스트에서 바꿔 끼울 수 있다 (기본: 서버의 Tesseract) */
async function localAnalyze(n, f, reader) {
  const a = rulesAnalyze(n);
  const imgs = n.images || [];
  if (!imgs.length || (a.sourceKind !== 'image' && a.end)) return a;
  if (!reader) { if (!ocr.available()) return a; reader = urls => ocr.readImages(urls, f); }
  let reads = [];
  try { reads = await reader(imgs); } catch (e) { console.warn('[analyze] 이미지 읽기 실패:', e.message); }
  if (!reads.length) return a;
  const imgText = reads.map(r => r.text).join('\n');
  const b = rulesAnalyze(Object.assign({}, n, { bodyText: (n.bodyText || '') + '\n' + imgText }));
  const imageOnly = a.sourceKind === 'image';
  // 이미지 글자는 띄어쓰기·숫자가 틀릴 수 있어서 요약 한 줄(gist)은 본문이 있을 때만 쓴다.
  // 대상·혜택·서류·방법도 표 테두리 같은 잡음이 많으면("| 로기재 · 위") 비운다
  if (imageOnly) {
    b.summary.ko.gist = '';
    const clean = s => {
      if (!s || /[|]/.test(s)) return '';
      const ch = [...s.replace(/\s/g, '')], good = ch.filter(c => /[가-힣0-9A-Za-z.,:~()/·%-]/.test(c)).length;
      const words = s.split(/[\s·]+/).filter(Boolean), tiny = words.filter(w => [...w].length <= 1).length;
      return ch.length >= 6 && good / ch.length >= 0.85 && tiny / words.length < 0.4 ? s : '';
    };
    ['who', 'benefit', 'docs', 'how'].forEach(k => { b.summary.ko[k] = clean(b.summary.ko[k]); });
  }
  b.criteria.uncertain = b.criteria.uncertain.filter(u => !/본문이 이미지라/.test(u.ko));
  b.sourceKind = imageOnly ? 'image' : 'text';
  b.ocr = true;
  b.model = 'rules-v2+ocr';
  b.ocrReads = reads;                                             // saveAnalysis 가 notice_attachment.extracted_text 에 남긴다
  return b;
}

async function analyze(n, f) {
  f = f || fetch;
  let a = null;
  if (cfg.anthropicKey) {
    try { a = await claudeAnalyze(n, f); }
    catch (e) { console.warn('[analyze] Claude 실패, 규칙 기반으로 대체:', e.message); }
  }
  if (!a) a = await localAnalyze(n, f);
  // Claude 가 번역하지 못했으면 DeepL 로 제목·요약만 번역한다. 실패해도 분석 결과는 저장하고 번역만 나중에(npm run translate)
  if (cfg.deeplKey && !(a.translations && Object.keys(a.translations).length)) {
    try { a.translations = await require('./translate').translateSummary(n.title, a.summary.ko, f); }
    catch (e) { console.warn('[analyze] 번역 실패(나중에 npm run translate 로 채울 수 있어요):', e.message); }
  }
  return a;
}

module.exports = { analyze, rulesAnalyze, localAnalyze, claudeAnalyze, findPeriod, findDates, sanitize, STATUSES, SCHEMA };
