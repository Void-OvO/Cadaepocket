'use strict';
/* 공지 제목·요약을 영어·중국어(간체)로 번역 — DeepL API (외부 패키지 없이 fetch).
 * Claude 키가 있으면 Claude 가 분석하면서 번역까지 하므로, 이 모듈은 Claude 가 없거나 번역을 못 했을 때만 쓴다. */
const cfg = require('./config');

const FIELDS = ['title', 'gist', 'who', 'benefit', 'docs', 'how'];
const TARGET = { en: 'EN-US', zh: 'ZH' };            // DeepL 의 'ZH' 는 중국어 간체
const sleep = ms => new Promise(r => setTimeout(r, ms));

function endpoint(key) {
  // 무료 플랜 키는 ':fx' 로 끝나고 주소가 다르다
  return /:fx$/.test(key) ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
}

class QuotaError extends Error {}

/* 한 언어로 여러 문장을 한 번에 번역. 429(요청 많음)면 잠깐 쉬었다가 다시, 456(월 한도 초과)이면 QuotaError */
async function deepl(texts, lang, f, key) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await f(endpoint(key), {
      method: 'POST',
      headers: { authorization: 'DeepL-Auth-Key ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: texts, source_lang: 'KO', target_lang: TARGET[lang] }),
      signal: AbortSignal.timeout(30000)
    });
    if (r.status === 429 || r.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
    if (r.status === 456) throw new QuotaError('DeepL 월 무료 한도를 다 썼어요');
    if (!r.ok) throw new Error('deepl ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    return (j.translations || []).map(t => t.text);
  }
  throw new Error('deepl: 계속 바빠서 번역하지 못했어요');
}

/* 제목 + 한국어 요약 → { en: {title,gist,...}, zh: {...} }. 빈 필드는 번역하지 않고 빈 문자열로 둔다 */
async function translateSummary(title, ko, f, key) {
  f = f || fetch; key = key || cfg.deeplKey;
  if (!key) return {};
  const src = Object.assign({}, ko || {}, { title });
  const fields = FIELDS.filter(k => src[k] && String(src[k]).trim());
  const out = {};
  for (const lang of Object.keys(TARGET)) {
    const res = await deepl(fields.map(k => String(src[k])), lang, f, key);
    out[lang] = Object.fromEntries(FIELDS.map(k => [k, '']));
    fields.forEach((k, i) => { out[lang][k] = (res[i] || '').trim(); });
  }
  return out;
}

module.exports = { translateSummary, endpoint, QuotaError };
