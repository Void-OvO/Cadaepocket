'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('../web/match.js');
const S = require('../server/scraper.js');
const A = require('../server/analyze.js');
const P = require('../server/push.js');
const dbm = require('../server/db.js');
const store = require('../server/store.js');
const notify = require('../server/notify.js');
const { createApp } = require('../server/index.js');
const T = require('../server/translate.js');
// .env 에 실제 키가 있어도 테스트는 외부 API 를 부르지 않는다
const cfg = require('../server/config.js'); cfg.anthropicKey = ''; cfg.deeplKey = '';
const fx = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const TODAY = Date.UTC(2026, 10, 6);

test('match: 학적·학년·학점·학과·불확실', () => {
  const p = { status: '재학', done: 4, gpa: 3.4, dept: '간호학과', exchange: false };
  assert.equal(M.match({ statuses: ['재학'], grades: [3] }, p), 'match');
  assert.equal(M.match({ statuses: ['휴학'] }, p), 'no');
  assert.equal(M.match({ minGpa: 3.5 }, p), 'no');
  assert.equal(M.match({ depts: ['의학과'] }, p), 'no');
  assert.equal(M.match({ uncertain: [{ ko: '추천 필요' }] }, p), 'maybe');
  assert.equal(M.match({ minDone: 4, maxDone: 6 }, p), 'match');
  assert.equal(M.match({ audience: 'exchange' }, p), 'no');
});

test('parseList: 고정글·날짜 칼럼 순서 무관·총 건수', () => {
  const r = S.parseList(fx('list.html'));
  assert.equal(r.total, 1234);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].pinned, true);
  assert.equal(r.rows[0].title, '상단 고정 & 안내');
  assert.equal(r.rows[1].no, 277473); assert.equal(r.rows[1].date, '2026-11-05'); assert.equal(r.rows[1].category, '학사');
  assert.equal(r.rows[2].date, '2026-11-04');                       // 날짜가 다른 칼럼 위치여도 정규식으로 찾는다
  assert.equal(r.rows[2].dept, '대학일자리플러스센터');
});

test('parseDetail: 본문·이미지·첨부·등록일', () => {
  const d = S.parseDetail(fx('detail.html'), 'https://www.catholic.ac.kr/ko/campuslife/notice.do?mode=view&articleNo=1');
  assert.equal(d.author, '학사행정팀'); assert.equal(d.posted, '2026-11-05');
  assert.ok(d.bodyText.includes('평점 3.5 이상'));
  assert.deepEqual(d.images, ['https://www.catholic.ac.kr/_attach/img/a.png']);
  assert.equal(d.attachments[0].name, '신청서.hwp');
  // 실제 사이트는 제목 상자에 분류 표시가 같이 있다 (성심 "학사", 성의 "[장학]")
  for (const cate of ['학사', '[장학]']) {
    const t = S.parseDetail(`<div class="b-title-box"><div><span class="b-cate">${cate}</span><div><p class="b-title">성적향상장학금 신청 안내</p></div></div></div>`, 'https://x.kr/').title;
    assert.equal(t, '성적향상장학금 신청 안내');
  }
});

test('rulesAnalyze: 기간·학적·학년·학점', () => {
  const d = S.parseDetail(fx('detail.html'), 'https://x.kr/a');
  const a = A.rulesAnalyze({ title: d.title, bodyText: d.bodyText, images: d.images, postedAt: '2026-11-05' });
  assert.equal(a.start, '2026-11-09'); assert.equal(a.end, '2026-11-20');
  assert.deepEqual(a.criteria.statuses, ['재학']); assert.deepEqual(a.criteria.grades, [3, 4]); assert.equal(a.criteria.minGpa, 3.5);
});
test('rulesAnalyze: 대상 학년이 아닌 학년 언급은 무시한다 (실제 공지에서 나온 오탐)', () => {
  const g = body => A.rulesAnalyze({ title: '안내', bodyText: body, images: [], postedAt: '2026-11-05' }).criteria.grades;
  assert.equal(g('- 4학년 2학기(8차 학기) 학생은 본교 개설 교과목만 수강 가능합니다.'), null);
  assert.equal(g('지원 자격\n1) 1학년 이상 수료한 학생'), null);
  assert.equal(g('신청 자격 : 재학생\n- 단, 2학년 성적에서 3학년 성적으로 10점 향상된 학생은 해당사항 없음'), null);
  assert.equal(g('지원 자격: 4년제 대학 2학년 1학기 진학 예정자'), null);
  assert.equal(g('- 1학년 : 박한종 교수\n- 2학년 : 이향열 교수'), null);
  assert.equal(g('신청 대상: 2024학년도 입학생'), null);
  assert.deepEqual(g('2. 지원 자격 : 의과대학 본과 3~4학년 재학생'), [3, 4]);
  assert.deepEqual(g('신청 대상: 2학년 이상 재학생'), [2, 3, 4]);
});
test('rulesAnalyze: 요약의 대상은 항목 이름 뒤 구분자가 있을 때만 읽는다', () => {
  const who = body => A.rulesAnalyze({ title: '안내', bodyText: body, images: [], postedAt: '2026-11-05' }).summary.ko.who;
  assert.equal(who('1. 대상 과목 : 2027-1학기 편제 교과목 전체'), '');
  assert.equal(who('2. 지원 자격 및 우대 사항\n- 우대'), '');
  assert.equal(who('2. 신청자격 :\n<간호학과, 신입생 제외>'), '<간호학과, 신입생 제외>');
  assert.equal(who('○ 대 상: 학부 재학생'), '학부 재학생');
});
test('rulesAnalyze: 요약은 이어지는 줄과 핵심 문장·혜택까지 담는다', () => {
  const body = '안녕하십니까. 학생지원팀입니다.\n2026학년도 2학기 성적향상 장학생을 다음과 같이 모집하오니 해당하는 학생은 신청하기 바랍니다.\n- 다 음 -\n' +
    '1. 신청기간 : 2026. 11. 03(화) ~ 11. 13(금)\n2. 신청자격 :\n<간호학과, 신입생 제외>\n- 전 학기 평균 70점 이상\n- 직전학기 성적 10점 이상 향상\n3. 지원 금액: 1인당 50만 원\n4. 제출 서류: 신청서 1부';
  const s = A.rulesAnalyze({ title: '성적향상장학금 신청 안내', bodyText: body, images: [], postedAt: '2026-11-03' }).summary.ko;
  assert.equal(s.gist, '2026학년도 2학기 성적향상 장학생을 다음과 같이 모집하오니 해당하는 학생은 신청하기 바랍니다.');
  assert.equal(s.who, '<간호학과, 신입생 제외> · 전 학기 평균 70점 이상 · 직전학기 성적 10점 이상 향상');
  assert.equal(s.benefit, '1인당 50만 원');
  assert.equal(s.docs, '신청서 1부');
});
test('졸업 예정은 학적이 아니라 4학년으로 본다', () => {
  const g = body => A.rulesAnalyze({ title: '안내', bodyText: body, images: [], postedAt: '2026-11-05' }).criteria;
  assert.deepEqual(g('신청 대상: 2026-2학기 졸업 예정자').grades, [4]);
  assert.equal(g('신청 대상: 재학생 및 졸업예정자').grades, null);                       // 함께 쓰이면 좁히지 않는다
  assert.equal(g('지원 자격: 4학기 이상 이수한 자 (졸업예정자는 지원 불가)').grades, null);
  assert.ok(!(g('신청 대상: 졸업 예정자').statuses || []).includes('졸업 예정'));
  // 항목 이름 다음 줄에 대상이 적힌 채용 공지 (실제 공지에서 1학년에게 '해당'으로 나온 사례)
  assert.deepEqual(g('2. 지원 자격\n- 초대졸 이상(전공 무관), 기졸업자 및 2027년 2월 졸업 예정자\n- 군필 또는 면제로서 해외여행에 결격사유가 없는 자').grades, [4]);
  assert.deepEqual(g('지원 대상: 2026학년도 졸업예정자').grades, [4]);
  // 예전 분석·시드에 남은 '졸업 예정'
  const p4 = { status: '재학', done: 7, gpa: 3.5 }, p3 = { status: '재학', done: 5, gpa: 3.5 };
  assert.equal(M.match({ statuses: ['졸업 예정'] }, p4), 'match');
  assert.equal(M.match({ statuses: ['졸업 예정'] }, p3), 'no');
  assert.equal(M.match({ statuses: ['재학', '졸업 예정'] }, p3), 'match');
  assert.equal(A.sanitize({ statuses: ['졸업 예정'] }, {}).criteria.grades[0], 4);
});
test('교환·외국인 학생 전용·제외 공지를 구분한다', () => {
  const c = body => A.rulesAnalyze({ title: '안내', bodyText: body, images: [], postedAt: '2026-11-05' }).criteria;
  const a = c('3. 모집 대상: 중국인 유학생 8-15명 내외 (선착순 마감)');                // 실제 공지에서 내국인에게 '해당'으로 나온 사례
  assert.equal(a.audience, 'exchange');
  assert.equal(M.match(a, { status: '재학', done: 2, gpa: 3.5, exchange: false }), 'no');
  assert.notEqual(M.match(a, { status: '재학', done: 2, gpa: 3.5, exchange: true }), 'no');
  assert.equal(c('신청 대상: 인간학1 수강생 전원(외국인 유학생 포함)').audience, null);
  assert.equal(c('지원 자격: 본교 재학생 (외국인 유학생 제외)').excludeExchange, true);
  assert.equal(c('지원 자격: 본교 재학생 (외국인 유학생 제외)').audience, null);
  // 실제 공지에서 잘못 잡혔던 문장들
  assert.equal(c('해외 파견에 관심 있는 재학생에게 정보를 제공하고, 본교에 재학 중인 수용 교환학생과의 교류의 장을 마련').audience, null);
  assert.equal(c('1. 신청기간 및 대상\n외국인학생, 산업체위탁생, 시간제등록생, 평생교육시설 등록생 등은 선발 대상에서 제외됩니다.').excludeExchange, true);
  const who = A.rulesAnalyze({ title: '안내', bodyText: '- 대상: 중국인 유학생 8-15명 내외 (선착순 마감)\n- 신청기간: 2026.10.21(수)-11.13(금)', images: [], postedAt: '2026-11-05' }).summary.ko.who;
  assert.equal(who, '중국인 유학생 8-15명 내외 (선착순 마감)');
});
test('Claude 분석: 구조화 출력 요청 형식과 응답 처리 (가짜 API)', async () => {
  const answer = { statuses: ['재학'], grades: null, minGpa: 3.0, minDone: null, maxDone: null, audience: null, excludeExchange: false, intl: false, depts: null,
    start: '2026-11-09', end: '2026-11-20', gist: '성적우수 장학금 추가 신청을 받아요.', who: '재학생, 직전 학기 평점 3.0 이상', benefit: '1인 100만 원',
    docs: '신청서', how: '종합정보시스템', uncertain: [], readFromImage: false,
    en: { title: 'Academic Excellence Scholarship', gist: 'Apply for the additional scholarship.', who: 'Enrolled, GPA 3.0+', benefit: 'KRW 1,000,000', docs: 'Application form', how: 'Student portal' },
    zh: { title: '成绩优秀奖学金', gist: '追加申请奖学金。', who: '在读，绩点3.0以上', benefit: '100万韩元', docs: '申请表', how: '综合信息系统' } };
  let sent;
  const fakeFetch = async (url, opt) => {
    sent = { url, headers: opt.headers, body: JSON.parse(opt.body) };
    const resp = (stop, content) => ({ ok: true, json: async () => ({ model: 'claude-sonnet-5-5', stop_reason: stop, content }) });
    return fakeFetch.next ? fakeFetch.next(resp) : resp('end_turn', [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer) }]);
  };
  const n = { title: '장학금 안내', bodyText: '본문', images: [], category: 'sch', postedAt: '2026-11-05' };
  const a = await A.claudeAnalyze(n, fakeFetch);
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  assert.deepEqual(sent.body.output_config.format.schema.required.sort(), Object.keys(A.SCHEMA.properties).sort());
  assert.ok(sent.body.max_tokens >= 16000);
  assert.equal(sent.body.fallbacks, 'default'); assert.equal(sent.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(a.end, '2026-11-20'); assert.equal(a.summary.ko.gist, '성적우수 장학금 추가 신청을 받아요.'); assert.equal(a.criteria.minGpa, 3);
  assert.equal(sent.body.output_config.format.schema.properties.en.type, 'object');
  // 번역은 저장 후 API 에서 언어별로 나온다
  const db = dbm.open(':memory:');
  const nid = Number(db.prepare(`INSERT INTO notice (source_id,campus_id,external_no,category,title,posted_at,original_url,body_text,content_hash,latest_version,first_seen_at,updated_at)
    VALUES ((SELECT id FROM notice_source WHERE key='sim-notice'),'sim',1,'sch','장학금 안내','2026-11-05','https://x','본문','h',1,'t','t')`).run().lastInsertRowid);
  S.saveAnalysis(db, nid, 1, a);
  const got = store.get(db, nid);
  assert.equal(got.tx.en.title, 'Academic Excellence Scholarship'); assert.equal(got.tx.zh.who, '在读，绩点3.0以上'); assert.equal(got.tx.ko.title, '장학금 안내');
  S.saveAnalysis(db, nid, 1, A.rulesAnalyze({ title: '장학금 안내', bodyText: '본문', images: [], postedAt: '2026-11-05' }));   // 다시 분석하면 예전 번역은 지운다
  assert.equal(store.get(db, nid).tx.en, undefined);
  // 거절·잘림은 오류로 돌려서 규칙 기반으로 대체되게 한다
  fakeFetch.next = r => r('refusal', []);
  await assert.rejects(A.claudeAnalyze(n, fakeFetch), /refusal/);
  fakeFetch.next = r => r('max_tokens', [{ type: 'text', text: '{"statuses":' }]);
  await assert.rejects(A.claudeAnalyze(n, fakeFetch), /max_tokens/);
});
test('DeepL 번역: 요청 형식, 빈 필드 건너뛰기, 번역이 없는 공지만 채우기 (가짜 API)', async () => {
  const calls = [];
  const fake = async (url, opt) => {
    const b = JSON.parse(opt.body); calls.push({ url, auth: opt.headers.authorization, b });
    return { ok: true, status: 200, json: async () => ({ translations: b.text.map(s => ({ text: `[${b.target_lang}] ${s}` })) }) };
  };
  const tr = await T.translateSummary('장학금 안내', { gist: '신청하세요', who: '재학생', benefit: '', docs: '', how: '' }, fake, 'k:fx');
  assert.equal(calls[0].url, 'https://api-free.deepl.com/v2/translate');               // 무료 키 주소
  assert.equal(calls[0].auth, 'DeepL-Auth-Key k:fx');
  assert.deepEqual(calls[0].b.text, ['장학금 안내', '신청하세요', '재학생']);            // 빈 필드는 보내지 않는다
  assert.deepEqual(calls.map(c => c.b.target_lang), ['EN-US', 'ZH']);
  assert.equal(tr.en.title, '[EN-US] 장학금 안내'); assert.equal(tr.zh.who, '[ZH] 재학생'); assert.equal(tr.en.benefit, '');
  assert.equal(T.endpoint('paid-key'), 'https://api.deepl.com/v2/translate');
  // 월 한도 초과(456)는 QuotaError
  await assert.rejects(T.translateSummary('x', {}, async () => ({ ok: false, status: 456 }), 'k:fx'), T.QuotaError);
  // 번역이 없는 공지만 채우고, 다시 돌리면 건너뛴다
  const db = dbm.open(':memory:'); store.seed(db);
  db.prepare('DELETE FROM notice_translation').run();
  const r1 = await S.translateMissing(db, { fetch: fake, key: 'k:fx', delayMs: 0 });
  assert.ok(r1.done > 0 && r1.failed === 0);
  const anyId = db.prepare('SELECT id FROM notice LIMIT 1').get().id;
  assert.match(store.get(db, anyId).tx.en.title, /^\[EN-US\] /);
  const r2 = await S.translateMissing(db, { fetch: fake, key: 'k:fx', delayMs: 0 });
  assert.equal(r2.total, 0);
});
test('feed: 마감 임박이 위로, 마감 지난 공지는 다른 탭에서 빼고 \'마감\' 탭에만 모은다', () => {
  const p = { status: '재학', done: 4, gpa: 3.5, interests: [] };
  const today = Date.UTC(2026, 10, 6);
  const items = [{ id: 1, cat: 'aca', end: '2026-11-01', criteria: {} }, { id: 2, cat: 'aca', end: null, criteria: {} }, { id: 3, cat: 'aca', end: '2026-11-08', criteria: {} }, { id: 5, cat: 'sch', end: '2026-11-04', criteria: {} }];
  assert.deepEqual(M.feed(items, p, { today }).map(x => x.item.id), [3, 2]);
  assert.deepEqual(M.feed(items, p, { today, cat: 'aca' }).map(x => x.item.id), [3, 2]);
  assert.deepEqual(M.feed(items, p, { today, cat: 'closed' }).map(x => x.item.id), [5, 1]);   // 최근에 마감된 것부터
  // 확인 필요(maybe)도 신청 가능하면 목록에 나오고, 마감 지난 해당(match) 공지는 나오지 않는다
  items.push({ id: 4, cat: 'aca', end: '2026-11-13', criteria: { uncertain: [{ ko: '추천 필요' }] } });
  assert.deepEqual(M.feed(items, p, { today }).map(x => x.item.id), [3, 2, 4]);
  // 주로 외국인·교환학생용 공지: 내국인에게는 아래로, 교환학생에게는 그대로 (마감 지난 7 은 목록에서 빠짐)
  const intl = [{ id: 5, cat: 'gen', end: '2026-11-08', criteria: { intl: true } }, { id: 6, cat: 'gen', end: null, criteria: {} }, { id: 7, cat: 'gen', end: '2026-11-01', criteria: {} }];
  assert.deepEqual(M.feed(intl, p, { today }).map(x => x.item.id), [6, 5]);
  assert.deepEqual(M.feed(intl, Object.assign({}, p, { exchange: true }), { today }).map(x => x.item.id), [5, 6]);
  assert.equal(A.rulesAnalyze({ title: '[국제교류팀] 외국인 유학생 한국어 말하기 대회', bodyText: '신청 대상: 본교 학생 누구나', images: [], postedAt: '2026-11-05' }).criteria.intl, true);
  assert.equal(A.rulesAnalyze({ title: '인간학 가을 특강 안내', bodyText: '신청 대상: 인간학1 수강생 전원(외국인 유학생 포함)', images: [], postedAt: '2026-11-05' }).criteria.intl, false);
});
test('rulesAnalyze: 이미지뿐인 공지는 확인 필요로 남긴다', () => {
  const a = A.rulesAnalyze({ title: '포스터', bodyText: '', images: ['https://x/a.png'], postedAt: '2026-11-05' });
  assert.equal(a.end, null); assert.ok(a.criteria.uncertain.length >= 1); assert.equal(a.sourceKind, 'image');
});
test('findPeriod: ~까지, 연도 생략, 시각 오인 방지', () => {
  assert.equal(A.findPeriod('접수 기간: 11.9(월) ~ 11.20(금) 17:00', '2026-11-05').end, '2026-11-20');
  assert.equal(A.findPeriod('11월 18일까지 제출', '2026-11-05').end, '2026-11-18');
  assert.equal(A.findPeriod('특강 14:00 시작', '2026-11-05').end, null);
});

test('push: RFC 8291 암호화 → 복호화 왕복', () => {
  const ua = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = ua.publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]);
  const auth = crypto.randomBytes(16).toString('base64url');
  const body = P.encrypt('{"hi":"가톨리미"}', raw.toString('base64url'), auth);
  assert.equal(P.decrypt(body, ua.privateKey, raw, auth), '{"hi":"가톨리미"}');
});
test('push: RFC 8291 부록 A 시험 벡터', () => {
  const b = s => Buffer.from(s, 'base64url');
  const asPriv = b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), asPubRaw = b('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const uaPub = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth = 'BTBZMqHH6r4Tts7J_aSIgg';
  const jwk = { kty: 'EC', crv: 'P-256', x: asPubRaw.subarray(1, 33).toString('base64url'), y: asPubRaw.subarray(33).toString('base64url'), d: asPriv.toString('base64url') };
  const asKeys = { privateKey: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: crypto.createPublicKey({ key: { ...jwk, d: undefined }, format: 'jwk' }) };
  const out = P.encrypt('When I grow up, I want to be a watermelon', uaPub, auth, { asKeys, salt: b('DGv6ra1nlYgDCS1FRnbzlw') });
  assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});
test('push: VAPID JWT 서명이 검증된다', () => {
  const k = P.generateVapid();
  const h = P.vapidHeaders('https://push.example/abc', k.publicKey, k.privateKey, 'mailto:a@b.c').authorization;
  const jwt = h.match(/t=([^,]+)/)[1].split('.');
  const pub = P.unb64u(k.publicKey);
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(jwt[0] + '.' + jwt[1]), { key, dsaEncoding: 'ieee-p1363' }, P.unb64u(jwt[2])));
});

/* 가짜 학교 사이트로 크롤 → 새 글 · 정정 감지 · 중복 병합 */
function fakeSite(state) {
  return async (url) => {
    const u = new URL(url), mk = (b, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => b, json: async () => ({}), headers: new Headers() });
    if (u.hostname !== 'www.catholic.ac.kr') return mk('', false);
    if (u.searchParams.get('mode') === 'list') {
      if (+u.searchParams.get('article.offset') > 0) return mk('<table><tbody></tbody></table>');
      const cat = u.searchParams.get('srCategoryId');
      return mk(cat === '21' ? fx('list.html') : '<table><tbody></tbody></table>');
    }
    const no = u.searchParams.get('articleNo');
    const body = state.v === 1 ? '신청 기간: 2026.11.09 ~ 2026.11.20 대상: 재학생' : '신청 기간: 2026.11.09 ~ 2026.11.27 대상: 재학생';
    return mk(`<div class="b-title-box"><p class="b-title">제목${no}</p></div><div class="b-etc-box">작성자 : 팀 등록일 : 2026.11.05</div><div class="b-content-box"><div class="fr-view"><p>${body}</p></div></div>`);
  };
}
test('crawlAll: 신규 저장 → 동일 내용 무시 → 변경 시 버전·정정 이력', async () => {
  const db = dbm.open(':memory:'), st = { v: 1 };
  const f = fakeSite(st), opt = { fetch: f, delayMs: 0, only: ['sim-notice'], analyzer: n => A.analyze(n, f) };
  let r = await S.crawlAll(db, opt);
  assert.equal(r.events.filter(e => e.type === 'new').length, 3);           // 고정글 + 2건 (고정글은 중복 제거되어 1번만)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notice').get().c, 3);
  r = await S.crawlAll(db, opt); assert.equal(r.events.length, 0);
  st.v = 2; r = await S.crawlAll(db, opt);
  const ch = r.events.filter(e => e.type === 'change'); assert.ok(ch.length >= 1);
  const row = db.prepare('SELECT * FROM notice_change WHERE id=?').get(ch[0].changeId);
  assert.match(row.ai_summary, /신청 마감/); assert.equal(row.to_version, 2);
  const n = store.get(db, ch[0].noticeId); assert.equal(n.end, '2026-11-27'); assert.equal(n.version, 2);
});
test('crawlAll: 한 게시판이 실패해도 다른 게시판은 계속', async () => {
  const db = dbm.open(':memory:');
  const f = async (url) => { if (url.includes('songeui')) throw new Error('boom'); return { ok: true, status: 200, text: async () => '<table><tbody></tbody></table>', headers: new Headers() }; };
  const r = await S.crawlAll(db, { fetch: f, delayMs: 0, analyzer: async () => ({}) });
  assert.ok(r.errors.length >= 1);
  assert.ok(db.prepare("SELECT last_crawled_at FROM notice_source WHERE key='sim-notice'").get().last_crawled_at);
  assert.ok(db.prepare("SELECT last_error FROM notice_source WHERE key='ui-notice'").get().last_error);
});
test('depts: 학과 → 단과대학, 자동완성 검색, 학과 게시판 수집원', () => {
  const D = require('../web/depts.js');
  assert.equal(D.find('심리학과', 'sim').college, '인문사회계열');
  // 화면에는 단과대학 이름만 (소분류는 보여 주지 않음)
  assert.equal(D.find('경제학과', 'sim').full, '인문사회계열');
  assert.equal(D.find('국제경영학과', 'sim').full, '경영대학');
  assert.equal(D.find('자유전공학부', 'sim').college, '자유전공학부');
  assert.equal(D.find('간호학과', 'ui').board, 'ui-nursing');
  assert.equal(D.find('심리학과', 'ui'), null);                              // 캠퍼스가 다르면 없음
  assert.equal(D.search('컴퓨', 'sim')[0].name, '컴퓨터정보공학부');            // 앞부분 일치
  assert.ok(D.search('경영', 'sim').some(d => d.name === '글로벌경영학과'));      // 포함 일치
  assert.ok(D.search('AI전자', 'sim').every(d => d.college === 'AI전자정보융합대학')); // 단과대학 이름으로도 찾음
  assert.equal(D.BOARDS.filter(b => b.key === 'dept-gbs').length, 1);          // 같은 게시판은 한 번만
  const src = require('../server/sources').SOURCES.find(s => s.key === 'dept-psychology');
  assert.equal(src.base, 'https://psychology.catholic.ac.kr/psychology/community/notice.do'); assert.equal(src.scope, 'dept');
});
test('학과 게시판: 홈 피드와 분리, 게시판별 목록, 확인 시각, 새 공지 푸시 제외', async () => {
  const db = dbm.open(':memory:');
  const page = no => `<table><tbody><tr><td>${no}</td><td class="b-td-left b-td-title"><a class="b-title" data-article-no="${no}" href="#">학과 공지 ${no}</a></td><td>학과사무실</td><td>2099.01.01</td><td>3</td></tr></tbody></table>`;
  const f = async url => {
    const u = new URL(url), mk = b => ({ ok: true, status: 200, text: async () => b, headers: new Headers() });
    if (u.searchParams.get('mode') === 'list') return mk(+u.searchParams.get('article.offset') > 0 ? '<table></table>' : page(u.hostname.startsWith('psychology') ? 900001 : 900002));
    return mk('<div class="b-title-box">t</div><div class="b-etc-box">등록일 : 2099.01.01</div><div class="b-content-box"><p>대상: 재학생</p></div>');
  };
  const r = await S.crawlAll(db, { fetch: f, delayMs: 0, only: ['dept-psychology', 'dept-chemistry'], analyzer: async n => A.rulesAnalyze(n) });
  assert.equal(r.events.length, 2);
  assert.equal(store.list(db, { campus: 'sim' }).length, 0);                        // 홈 피드에는 안 나옴
  const ps = store.list(db, { campus: 'sim', board: 'dept-psychology' });
  assert.equal(ps.length, 1); assert.equal(ps[0].no, 900001); assert.equal(ps[0].scope, 'dept'); assert.ok(ps[0].checkedAt);
  assert.ok(store.lastCrawled(db, { board: 'dept-psychology' }));
  let sent = 0; await notify.onEvents(db, r.events, { sender: async () => { sent++; return 201; } });
  db.prepare("INSERT INTO push_subscription (endpoint,p256dh,auth,campus_id,created_at,updated_at) VALUES ('https://p/x','a','b','sim','2000-01-01','2000-01-01')").run();
  await notify.onEvents(db, r.events, { sender: async () => { sent++; return 201; } }); assert.equal(sent, 0);
  // 같은 글을 통합 게시판에서도 보면 홈 피드 공지가 된다
  const src = require('../server/sources').SOURCES.find(s => s.key === 'sim-notice');
  await S.upsertNotice(db, src, { no: 900001, pinned: false, title: '학과 공지 900001', category: '학사', date: '2099-01-01', dept: '팀' }, S.parseDetail('<div class="b-content-box"><p>대상: 재학생</p></div>', 'https://x.kr/'), { analyzer: async n => A.rulesAnalyze(n) });
  assert.equal(store.list(db, { campus: 'sim' }).length, 1);
  assert.equal(store.list(db, { campus: 'sim', board: 'dept-psychology' }).length, 1);
});
test('학과 게시판: 상단 고정(공지)글은 사이트 순서대로 맨 위, 고정이 풀리면 내려간다', async () => {
  const db = dbm.open(':memory:'), st = { pin: true };
  const tr = (no, date, pin) => `<tr class="${pin ? ' b-cate-notice' : ''}"><td class="b-num-box"><span>${pin ? '공지' : no}</span></td><td class="b-td-title b-td-left"><a class="b-title" data-article-no="${no}" href="#">글 ${no}</a></td><td>${date}</td><td>학과</td><td>1</td></tr>`;
  const f = async url => {
    const u = new URL(url), mk = b => ({ ok: true, status: 200, text: async () => b, headers: new Headers() });
    if (u.searchParams.get('mode') === 'list') return mk(+u.searchParams.get('article.offset') > 0 ? '<table></table>' :
      '<table><tbody>' + tr(700002, '2024.10.28', st.pin) + tr(700001, '2025.02.19', st.pin) + tr(900002, '2099.01.02') + tr(900001, '2099.01.01') + '</tbody></table>');
    return mk('<div class="b-content-box"><p>대상: 재학생</p></div>');
  };
  const opt = { fetch: f, delayMs: 0, only: ['dept-business'], analyzer: async n => A.rulesAnalyze(n) };
  await S.crawlAll(db, opt);
  let l = store.list(db, { campus: 'sim', board: 'dept-business' });
  assert.deepEqual(l.map(n => n.no), [700002, 700001, 900002, 900001]);           // 사이트와 같은 순서
  assert.deepEqual(l.map(n => n.boardPinned), [true, true, false, false]);
  st.pin = false; await S.crawlAll(db, opt);
  l = store.list(db, { campus: 'sim', board: 'dept-business' });
  assert.deepEqual(l.map(n => n.no), [900002, 900001, 700002, 700001]); assert.ok(l.every(n => !n.boardPinned));
});
test('seed: 14건, 시드→실제 본문 첫 교체는 정정으로 치지 않는다', async () => {
  const db = dbm.open(':memory:'); assert.equal(store.seed(db), 14); assert.equal(store.seed(db), 0);
  assert.equal(store.list(db, { campus: 'ui' }).length, 7);
  const f = fakeSite({ v: 1 });
  const row = db.prepare("SELECT external_no FROM notice WHERE campus_id='sim' LIMIT 1").get();
  const src = require('../server/sources').SOURCES[0];
  const ev = await S.upsertNotice(db, src, { no: row.external_no, pinned: false, title: 'x', category: '학사', date: '2026-11-05', dept: '팀' }, S.parseDetail(fx('detail.html'), 'https://x.kr/'), { analyzer: n => A.rulesAnalyze(n) });
  assert.equal(ev, null); assert.equal(db.prepare('SELECT COUNT(*) c FROM notice_change').get().c, 0);
});

test('notify: 구독자에게 새 글·정정·마감 푸시, 중복 발송 방지, 410 이면 구독 삭제', async () => {
  const db = dbm.open(':memory:'); store.seed(db);
  const t = new Date().toISOString();
  const nid = db.prepare("SELECT id FROM notice WHERE campus_id='sim' AND external_no=277473").get().id;
  const other = db.prepare("SELECT id FROM notice WHERE campus_id='sim' AND id<>? LIMIT 1").get(nid).id;
  const uiN = db.prepare("SELECT id FROM notice WHERE campus_id='ui' LIMIT 1").get().id;
  const ins = (ep, campus, saved) => db.prepare('INSERT INTO push_subscription (endpoint,p256dh,auth,campus_id,saved_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(ep, 'p', 'a', campus, JSON.stringify(saved), t, t);
  ins('https://e/1', 'sim', [nid]); ins('https://e/2', 'ui', [uiN]);
  const sent = []; const sender = async (sub, payload) => { sent.push([sub.endpoint, payload]); return sub.endpoint === 'https://e/2' ? 410 : 201; };
  for (const id of [nid, other, uiN]) db.prepare('UPDATE notice_analysis SET apply_end=? WHERE notice_id=?').run('2026-11-09', id);
  // 마감 알림: 저장한 공지에만, 고른 시점(기본 3·1일 전)에만
  const n = await notify.deadlines(db, { sender, today: '2026-11-06' });                 // D-3
  assert.equal(n, 1);
  assert.deepEqual(sent.map(([e, pl]) => [e, pl.id]), [['https://e/1', nid], ['https://e/2', uiN]]);   // 저장 안 한 other 는 없음
  assert.match(sent[0][1].body, /D-3/); assert.ok(sent[0][1].criteria);
  sent.length = 0; await notify.deadlines(db, { sender, today: '2026-11-06' });
  assert.equal(sent.length, 0);                                                            // 중복 방지
  assert.equal(db.prepare('SELECT COUNT(*) c FROM push_subscription').get().c, 1);         // 410 → 삭제
  await notify.deadlines(db, { sender, today: '2026-11-05' });                             // D-4: 고른 시점이 아님
  assert.equal(sent.length, 0);
});
test('notify: 새 공지는 알림을 켠 뒤에 올라온 것만, 정정은 저장한 공지만', async () => {
  const db = dbm.open(':memory:'); store.seed(db);
  const ids = db.prepare("SELECT id FROM notice WHERE campus_id='sim' ORDER BY id LIMIT 2").all().map(r => r.id);
  const recent = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  db.prepare('UPDATE notice SET posted_at=?').run(recent);
  db.prepare("UPDATE notice_analysis SET criteria_json='{}'").run();
  const subAt = '2026-11-05T12:00:00.000Z';
  db.prepare('INSERT INTO push_subscription (endpoint,p256dh,auth,campus_id,saved_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('https://e/1', 'p', 'a', 'sim', JSON.stringify([ids[1]]), subAt, subAt);
  db.prepare('UPDATE notice SET first_seen_at=? WHERE id=?').run('2026-11-05T11:00:00.000Z', ids[0]);   // 켜기 전에 있던 공지
  db.prepare('UPDATE notice SET first_seen_at=? WHERE id=?').run('2026-11-05T13:00:00.000Z', ids[1]);   // 켠 뒤에 올라온 공지
  const sent = []; const sender = async (sub, payload) => { sent.push(payload); return 201; };
  await notify.onEvents(db, [{ type: 'new', noticeId: ids[0] }, { type: 'new', noticeId: ids[1] }], { sender });
  assert.deepEqual(sent.map(p => [p.kind, p.id]), [['new', ids[1]]]);
  // 정정: 저장한 공지(ids[1])만
  const ch = id => Number(db.prepare("INSERT INTO notice_change (notice_id,from_version,to_version,changed_fields_json,ai_summary,detected_at) VALUES (?,1,2,'[]','바뀜','t')").run(id).lastInsertRowid);
  sent.length = 0;
  await notify.onEvents(db, [{ type: 'change', noticeId: ids[0], changeId: ch(ids[0]) }, { type: 'change', noticeId: ids[1], changeId: ch(ids[1]) }], { sender });
  assert.deepEqual(sent.map(p => [p.kind, p.id]), [['change', ids[1]]]);
  // 새 공지 알림 영역을 모두 끄면(['none']) 새 공지는 안 오고, 저장한 공지 정정은 그대로 온다
  db.prepare('UPDATE push_subscription SET categories_json=?').run('["none"]'); sent.length = 0;
  await notify.onEvents(db, [{ type: 'new', noticeId: ids[1] }, { type: 'change', noticeId: ids[1], changeId: ch(ids[1]) }], { sender });
  assert.deepEqual(sent.map(p => p.kind), ['change']);
});
test('notify: 구독의 대략적인 조건으로 대상 아닌 공지는 미리 거른다', () => {
  const sub = p => ({ profile_json: p ? JSON.stringify(p) : null });
  const y1 = { status: '재학', done: 1, exchange: false }, y4 = { status: '재학', done: 7, exchange: false };
  assert.equal(notify.fits(sub(y1), { grades: [4] }), false);                              // 1학년에게 4학년 공지 안 보냄
  assert.equal(notify.fits(sub(y4), { grades: [4] }), true);
  assert.equal(notify.fits(sub(y1), { audience: 'exchange' }), false);                     // 유학생 전용
  assert.equal(notify.fits(sub(Object.assign({}, y1, { exchange: true })), { audience: 'exchange' }), true);
  assert.equal(notify.fits(sub({ status: '휴학', done: 3 }), { statuses: ['재학'] }), false);
  assert.equal(notify.fits(sub(y1), { depts: ['간호학과'], minGpa: 4.0 }), true);          // 학과·평점은 서버가 모르므로 통과
  assert.equal(notify.fits(sub(y1), { uncertain: [{ ko: '추천 필요' }] }), true);          // 확인 필요는 보낸다
  assert.equal(notify.fits(sub(null), { grades: [4] }), true);                             // 조건을 모르는 예전 구독은 거르지 않음
});

test('API: 목록·상세·구독·신고·관리자 인증·정적 파일', async () => {
  const db = dbm.open(':memory:'); store.seed(db);
  const { server } = createApp(db); await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const j = async (p, o) => { const r = await fetch(base + p, o); return [r.status, await r.json().catch(() => null)]; };
  let [s, b] = await j('/api/notices?campus=ui'); assert.equal(s, 200); assert.equal(b.notices.length, 7);
  assert.ok('updatedAt' in b); assert.ok(b.notices[0].checkedAt);
  [s] = await j('/api/notices?campus=zzz'); assert.equal(s, 400);
  [s] = await j('/api/notices?campus=sim&board=nope'); assert.equal(s, 400);
  [s, b] = await j('/api/notices?campus=ui&board=ui-nursing'); assert.equal(s, 200); assert.ok(Array.isArray(b.notices));
  [s, b] = await j('/api/notices?campus=ui');
  const id = b.notices[0].id; [s, b] = await j('/api/notices/' + id); assert.equal(s, 200); assert.ok(b.tx.ko.title);
  [s] = await j('/api/notices/99999'); assert.equal(s, 404);
  const post = (p, body, h) => j(p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, h), body: JSON.stringify(body) });
  [s] = await post('/api/push/subscribe', { subscription: { endpoint: 'http://bad', keys: {} }, campus: 'sim' }); assert.equal(s, 400);
  [s] = await post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } }, campus: 'sim', categories: ['aca', 'bogus'], leadDays: [3, 99] }); assert.equal(s, 200);
  const sub = db.prepare('SELECT * FROM push_subscription').get(); assert.equal(sub.categories_json, '["aca"]'); assert.equal(sub.lead_days_json, '[3]');
  // 거르기용 조건은 학적·이수 학기·교환 여부만 저장하고, 학과·평점 같은 다른 값은 버린다
  [s] = await post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } }, campus: 'sim',
    profile: { status: '재학', done: 3, exchange: false, dept: '간호학과', gpa: 4.1 } }); assert.equal(s, 200);
  assert.deepEqual(JSON.parse(db.prepare('SELECT profile_json FROM push_subscription').get().profile_json), { status: '재학', done: 3, exchange: false });
  [s] = await post('/api/reports', { noticeId: id, note: '날짜 틀림' }); assert.equal(s, 200);
  [s] = await post('/api/admin/crawl', {}); assert.equal(s, 401);
  [s] = await post('/api/push/unsubscribe', { endpoint: 'https://push.example/x' }); assert.equal(s, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM push_subscription').get().c, 0);
  let r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /manifest/);
  r = await fetch(base + '/sw.js'); assert.equal(r.status, 200);
  r = await fetch(base + '/..%2f..%2fpackage.json'); assert.equal(r.status, 404);
  server.close();
});

test('이미지 공지: OCR 로 읽은 글자에서 대상·마감일을 뽑고, 읽은 글자는 첨부 행에 남긴다', async () => {
  // tesseract TSV → 줄 단위 글자 (숫자 사이 공백 정리)
  const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
    '5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t91\t신청\n5\t1\t1\t1\t1\t2\t0\t0\t1\t1\t89\t기간:\n5\t1\t1\t1\t1\t3\t0\t0\t1\t1\t80\t2026\n5\t1\t1\t1\t1\t4\t0\t0\t1\t1\t80\t.\n5\t1\t1\t1\t1\t5\t0\t0\t1\t1\t80\t11.20\n' +
    '5\t1\t1\t1\t2\t1\t0\t0\t1\t1\t-1\t\n5\t1\t1\t1\t2\t2\t0\t0\t1\t1\t60\t재학생\n';
  const p = require('../server/ocr').parseTsv(tsv);
  assert.equal(p.text, '신청 기간: 2026.11.20\n재학생'); assert.equal(p.conf, 0.8);
  // 글자마다 띄어 읽은 한글은 붙이고, 휴학생을 '포함'한 대상은 휴학생 전용으로 좁히지 않는다
  const sp = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' + ['재', '학', '생', '및', '휴학생'].map((w, i) => '5\t1\t1\t1\t1\t' + (i + 1) + '\t0\t0\t1\t1\t70\t' + w).join('\n');
  assert.equal(require('../server/ocr').parseTsv(sp).text, '재학생및휴학생');
  // 기간이 여러 개면 '신청·접수' 가 붙은 범위를 마감으로 (납부 기간이 먼저 나와도)
  assert.equal(A.findPeriod('기숙사비 납부 2026.12.07.(월) ~ 12.09.(수)\n입사 신청 기간 | 2026.11.16.(월) 10:00 ~ 11.20.(금) 23:59', '2026-11-04').end, '2026-11-20');
  assert.equal(A.findPeriod('호실 신청 | 2026.11.26.( 목 ) 10:00~16:00\n기숙사비 | 2026.12.07.( 월 ) ~ 12.09.( 수 )\n3. 입사 신청\n신청 기간 2026.11.16.( 월 ) 10:00~11.20.( 금 ) 23:59', '2026-11-04').end, '2026-11-20');
  assert.deepEqual(A.rulesAnalyze({ title: '기숙사 모집', bodyText: '- 내국인및외국인학부 / 대학원생 , 휴학생 -', images: [] }).criteria.statuses, ['재학', '휴학']);
  assert.deepEqual(A.rulesAnalyze({ title: '기숙사 모집', bodyText: '모집 대상: 학부생, 대학원생, 휴학생', images: [] }).criteria.statuses, ['재학', '휴학']);
  const img = 'https://www.catholic.ac.kr/_attach/poster.png';
  const reads = [{ url: img, text: '2026학년도 동계 기숙사 모집\n모집 대상: 재학생 (휴학생 제외)\n신청 기간: 2026. 11. 10.(화) ~ 2026. 11. 20.(금)', conf: 0.84 }];
  const reader = async urls => { assert.deepEqual(urls, [img]); return reads; };
  const n = { title: '[기숙사] 동계 모집공고', bodyText: '', images: [img], attachments: [], category: '일반', postedAt: '2026-11-02' };
  assert.equal(A.rulesAnalyze(n).end, null);                         // 글자를 읽기 전에는 마감일을 모른다
  const a = await A.localAnalyze(n, null, reader);
  assert.equal(a.end, '2026-11-20'); assert.equal(a.ocr, true); assert.equal(a.sourceKind, 'image');
  assert.deepEqual(a.criteria.statuses, ['재학']);
  assert.ok(!a.criteria.uncertain.some(u => /본문이 이미지라/.test(u.ko)));
  // 본문에 마감일이 이미 있으면 이미지를 읽지 않는다
  let called = 0; await A.localAnalyze(Object.assign({}, n, { bodyText: '신청 기간: 2026. 11. 1. ~ 2026. 11. 9. 대상: 재학생 '.repeat(5) }), null, async () => { called++; return reads; });
  assert.equal(called, 0);
  // 저장: 분석의 ocr 표시 + 이미지 첨부 행의 읽은 글자·신뢰도
  const db = dbm.open(':memory:');
  const src = require('../server/sources').SOURCES.find(s => s.key === 'sim-notice');
  await S.upsertNotice(db, src, { no: 910001, pinned: false, title: n.title, category: '일반', date: '2026-11-02', dept: '기숙사' },
    S.parseDetail('<div class="b-content-box"><p><img src="' + img + '"></p></div>', 'https://www.catholic.ac.kr/'), { analyzer: x => A.localAnalyze(x, null, reader) });
  const row = store.list(db, { campus: 'sim' })[0];
  assert.equal(row.end, '2026-11-20'); assert.equal(row.ocr, true);
  const att = db.prepare("SELECT extracted_text, ocr_confidence FROM notice_attachment WHERE kind='image'").get();
  assert.match(att.extracted_text, /신청 기간/); assert.equal(att.ocr_confidence, 0.84);
});
test('웹 파일: 모든 web/*.js 가 문법 오류 없이 읽힌다 (서비스 워커가 깨지면 처음 연 폰에서 푸시를 켤 수 없다)', () => {
  const vm = require('node:vm'), dir = path.join(__dirname, '..', 'web');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }), f);
    assert.ok(!/[�]|媛|怨듭/.test(src), f + ': 글자가 깨져 있다');
  }
  assert.match(fs.readFileSync(path.join(dir, 'sw.js'), 'utf8'), /'가톨리미'/);
});
test('알림 모아 보기: 이 기기 구독으로 보낸 알림만 최신 순으로, 실패한 전송은 빼고', async () => {
  const db = dbm.open(':memory:'); store.seed(db);
  const ids = db.prepare("SELECT id FROM notice WHERE campus_id='sim' ORDER BY id LIMIT 2").all().map(r => r.id);
  db.prepare('UPDATE notice SET posted_at=?, first_seen_at=?').run(new Date(Date.now() - 86400000).toISOString().slice(0, 10), '2026-11-05T13:00:00.000Z');
  db.prepare("UPDATE notice_analysis SET criteria_json='{}'").run();
  const ins = db.prepare('INSERT INTO push_subscription (endpoint,p256dh,auth,campus_id,saved_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
  ins.run('https://e/me', 'p', 'a', 'sim', '[]', '2026-11-05T12:00:00.000Z', 't'); ins.run('https://e/other', 'p', 'a', 'sim', '[]', '2026-11-05T12:00:00.000Z', 't');
  let n = 0; const sender = async sub => (sub.endpoint === 'https://e/me' && n++ === 1) ? 500 : 201;   // 내 두 번째 전송은 실패
  await notify.onEvents(db, ids.map(id => ({ type: 'new', noticeId: id })), { sender });
  const h = notify.history(db, 'https://e/me');
  assert.equal(h.length, 1); assert.equal(h[0].kind, 'new'); assert.ok(h[0].title); assert.match(h[0].url, /^\/#\/n\/\d+$/);
  assert.equal(notify.history(db, 'https://e/none'), null);
  const app = createApp(db).server; await new Promise(ok => app.listen(0, ok));
  const base = 'http://127.0.0.1:' + app.address().port;
  const r = await fetch(base + '/api/push/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://e/other' }) });
  assert.equal(r.status, 200); assert.equal((await r.json()).items.length, 2);
  assert.equal((await fetch(base + '/api/push/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"endpoint":"x"}' })).status, 404);
  app.close();
});