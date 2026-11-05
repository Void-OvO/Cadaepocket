'use strict';
/* Web Push: VAPID(ES256 JWT) + RFC 8291 aes128gcm 본문 암호화. 외부 패키지 없이 node:crypto 만 사용. */
const crypto = require('node:crypto');
const cfg = require('./config');

const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
function hkdf(salt, ikm, info, len) {            // 길이 ≤ 32 이므로 한 블록이면 충분
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);
}

function generateVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' }), prv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)]);
  return { publicKey: b64u(raw), privateKey: prv.d };
}

function vapidKey(pubB64, privB64) {
  const pub = unb64u(pubB64);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privB64 }, format: 'jwk' });
}

function vapidHeaders(endpoint, pub, priv, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: vapidKey(pub, priv), dsaEncoding: 'ieee-p1363' });
  return { authorization: `vapid t=${head}.${body}.${b64u(sig)}, k=${pub}` };
}

/* RFC 8291. opts.asKeys / opts.salt 는 테스트 벡터용. */
function encrypt(payload, p256dh, auth, opts) {
  opts = opts || {};
  const ua = unb64u(p256dh), authSecret = unb64u(auth);
  const as = opts.asKeys || crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = as.publicKey.export({ format: 'jwk' });
  const asPub = Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)]);
  const uaKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(ua.subarray(1, 33)), y: b64u(ua.subarray(33, 65)) }, format: 'jwk' });
  const secret = crypto.diffieHellman({ privateKey: as.privateKey, publicKey: uaKey });
  const salt = opts.salt || crypto.randomBytes(16);
  const ikm = hkdf(authSecret, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}

/* 테스트용 복호화(브라우저 쪽 동작을 흉내) */
function decrypt(body, uaPrivateKey, uaPubRaw, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const asKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(asPub.subarray(1, 33)), y: b64u(asPub.subarray(33, 65)) }, format: 'jwk' });
  const secret = crypto.diffieHellman({ privateKey: uaPrivateKey, publicKey: asKey });
  const ikm = hkdf(unb64u(auth), secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPubRaw, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

function enabled() { return !!(cfg.vapidPublic && cfg.vapidPrivate); }

/* 반환: HTTP status. 404/410 이면 호출한 쪽에서 구독을 지운다. */
async function send(sub, payloadObj, opts) {
  opts = opts || {};
  const f = opts.fetch || fetch;
  const body = encrypt(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
  const r = await f(sub.endpoint, {
    method: 'POST',
    headers: Object.assign({ 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(opts.ttl || 86400), urgency: opts.urgency || 'normal' },
      vapidHeaders(sub.endpoint, cfg.vapidPublic, cfg.vapidPrivate, cfg.vapidSubject || 'mailto:admin@example.com')),
    body
  });
  return r.status;
}

module.exports = { generateVapid, vapidHeaders, encrypt, decrypt, send, enabled, b64u, unb64u };
