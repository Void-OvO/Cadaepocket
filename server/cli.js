'use strict';
const cmd = process.argv[2];
const dbm = require('./db');
(async () => {
  if (cmd === 'vapid') { const k = require('./push').generateVapid(); console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\n\n위 두 줄을 .env 에 붙여 넣으세요.`); }
  else if (cmd === 'seed') { const db = dbm.open(); console.log(require('./store').seed(db) + '건 추가'); }
  else if (cmd === 'crawl') {
    const db = dbm.open(); const { crawlAll } = require('./scraper'); const notify = require('./notify');
    const only = process.argv[3] ? process.argv[3].split(',') : null;
    const r = await crawlAll(db, { only });
    const pushed = (await notify.onEvents(db, r.events)) + (await notify.deadlines(db));
    console.log(JSON.stringify({ new: r.events.filter(e => e.type === 'new').length, changed: r.events.filter(e => e.type === 'change').length, pushed, errors: r.errors }, null, 1));
  } else if (cmd === 'reanalyze') {
    const cfg = require('./config');
    const all = process.argv.includes('--all'), images = process.argv.includes('--reocr') ? 'all' : process.argv.includes('--images');
    console.log(cfg.anthropicKey ? `Claude(${cfg.anthropicModel})로 ${all ? '모든 공지를' : '규칙 기반으로 분석된 공지를'} 다시 분석합니다.`
      : 'ANTHROPIC_API_KEY 가 없어서 규칙 기반으로 다시 분석합니다. (.env 에 키를 넣으면 Claude 로 분석해요)');
    console.log('이미지 글자 읽기(OCR): ' + (require('./ocr').available() ? `켜짐 (${cfg.ocrCmd}, ${cfg.ocrLang})` : '꺼짐 (tesseract-ocr, tesseract-ocr-kor 를 설치하면 켜져요)') +
      (images === 'all' ? ' · 이미지가 있는 공지를 모두 다시 읽어요' : images ? ' · 이미지가 있는데 아직 글자를 읽지 않은 공지만' : ''));
    const db = dbm.open();
    const r = await require('./scraper').reanalyzeAll(db, { all, images, onProgress: (i, n) => { if (i % 10 === 0 || i === n) console.log(`  ${i}/${n}`); } });
    console.log(JSON.stringify(r));
  } else if (cmd === 'translate') {
    const cfg = require('./config');
    if (!cfg.deeplKey) { console.log('.env 에 DEEPL_API_KEY 가 없어요. DeepL API Free 키(끝이 :fx)를 넣어 주세요.'); return; }
    const db = dbm.open();
    const r = await require('./scraper').translateMissing(db, { onProgress: (i, n) => { if (i % 10 === 0 || i === n) console.log(`  ${i}/${n}`); } });
    console.log(JSON.stringify(r) + `  (이번에 쓴 글자 수 약 ${r.chars.toLocaleString()}자 / 무료 월 500,000자)`);
  } else console.log('usage: node server/cli.js vapid|seed|crawl [sourceKey,...]|reanalyze [--all] [--images|--reocr]|translate');
})().catch(e => { console.error(e); process.exit(1); });
