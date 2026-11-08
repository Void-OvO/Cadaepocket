'use strict';
/* 모든 푸시 구독자에게 테스트 알림을 보낸다 (서버에서 실행).
 *   node scripts/test-push.js           구독자 수만 확인
 *   node scripts/test-push.js --send    실제로 보냄. 만료된 구독(404·410)은 지운다 */
const dbm = require('../server/db');
const push = require('../server/push');
const db = dbm.open();
const subs = db.prepare('SELECT id, endpoint, p256dh, auth, campus_id, lang, created_at FROM push_subscription').all();
console.log(`구독자 ${subs.length}명 · 푸시 키 ${push.enabled() ? '있음' : '없음'}`);
for (const s of subs) console.log(`  #${s.id} ${s.campus_id} ${s.lang} ${new URL(s.endpoint).host} (구독 ${s.created_at.slice(0, 16)})`);
if (!process.argv.includes('--send')) process.exit(0);
if (!push.enabled()) { console.log('VAPID 키가 없어 보낼 수 없어요'); process.exit(1); }

const COPY = {
  ko: { title: '가대포켓 테스트 알림', body: '알림이 잘 도착했어요. 내게 맞는 새 공지와 저장한 공지의 마감·정정 소식을 이렇게 알려드릴게요.' },
  en: { title: 'CadaePocket test notification', body: 'Notifications are working. We will alert you about new notices and deadlines like this.' },
  zh: { title: 'CadaePocket 测试通知', body: '通知已成功送达。我们会这样提醒您新通知和截止日期。' }
};
(async () => {
  const tally = {};
  for (const s of subs) {
    const c = COPY[s.lang] || COPY.ko;
    let status;
    try { status = await push.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, { kind: 'test', id: Date.now(), title: c.title, body: c.body, url: '/' }); }
    catch (e) { status = 'error: ' + e.message; }
    if (status === 404 || status === 410) db.prepare('DELETE FROM push_subscription WHERE id=?').run(s.id);
    // 알림 모아 보기에도 보이도록 기록한다
    else db.prepare('INSERT INTO push_log (subscription_id,notice_id,kind,dedupe_key,status,sent_at,title,body,url) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(s.id, null, 'test', 'test:' + s.id + ':' + Date.now(), typeof status === 'number' ? status : 0, new Date().toISOString(), c.title, c.body, '/');
    tally[status] = (tally[status] || 0) + 1;
    console.log(`  #${s.id} → ${status}${status === 404 || status === 410 ? ' (만료된 구독이라 지움)' : ''}`);
  }
  console.log('결과', JSON.stringify(tally), '(201 = 전송 접수)');
})();
