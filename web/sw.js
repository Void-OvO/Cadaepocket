'use strict';
var V = 'catolimi-v26';
var SHELL = ['/', '/index.html', '/style.css', '/app.js', '/match.js', '/depts.js', '/i18n.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon.svg'];

self.addEventListener('install', function (e) { e.waitUntil(caches.open(V).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== V; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});

/* 앱 셸: 캐시 우선(백그라운드 갱신) / API: 네트워크 우선, 실패 시 캐시 */
self.addEventListener('fetch', function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.indexOf('/api/') === 0) {
    if (u.pathname === '/api/notices' || u.pathname.indexOf('/api/notices/') === 0)
      e.respondWith(fetch(r).then(function (res) { var c = res.clone(); caches.open(V).then(function (ca) { ca.put(r, c); }); return res; }).catch(function () { return caches.match(r); }));
    return;
  }
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(function (hit) {
    var net = fetch(r).then(function (res) { if (res.ok) { var c = res.clone(); caches.open(V).then(function (ca) { ca.put(r, c); }); } return res; }).catch(function () { return hit; });
    return hit || net;
  }));
});

/* 푸시: 대상 아닌 공지는 서버가 구독 때 받은 대략적인 조건(학적·이수 학기·교환 여부)으로 미리 거른다.
 * 여기서 조용히 버리면 브라우저(Chrome·Edge)가 "알림 없는 푸시"로 보고 구독을 끊을 수 있으므로, 받은 알림은 항상 보여 준다. */
self.addEventListener('push', function (e) {
  var d; try { d = e.data.json(); } catch (x) { d = { title: '가톨리미', body: '새 알림이 있어요', kind: 'misc', id: 0 }; }
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, tag: d.kind + ':' + d.id, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/' } })
    // 앱이 열려 있으면 '받은 알림' 목록을 새로 불러오도록 알린다
    .then(function () { return self.clients.matchAll({ type: 'window' }); }).then(function (cs) { cs.forEach(function (c) { c.postMessage({ type: 'push' }); }); }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) if ('focus' in cs[i]) { cs[i].navigate(url); return cs[i].focus(); }
    return self.clients.openWindow(url);
  }));
});
