'use strict';
(function () {
  var M = window.CatoMatch, I = window.I18N, T = I.T, DEP = window.CatoDepts;
  var $app = document.getElementById('app');
  var DAY = 86400000;

  /* ───────── 상태 ───────── */
  var CAMPUS = {
    sim: { name: { ko: '성심교정', en: 'Songsim Campus', zh: '圣心校区' }, place: { ko: '경기 부천', en: 'Bucheon', zh: '京畿道富川' }, host: 'catholic.ac.kr', cats: ['aca', 'sch', 'job', 'gen'] },
    ui: { name: { ko: '성의교정', en: 'Songeui Campus', zh: '圣义校区' }, place: { ko: '서울 서초', en: 'Seocho, Seoul', zh: '首尔瑞草' }, host: 'songeui.catholic.ac.kr', cats: ['aca', 'sch', 'evt', 'gen'] }
  };
  var DEF = { campus: null, lang: 'ko', status: '재학', returnTerm: '', dept: '', college: '', done: 4, gpa: 3.5, exchange: false, interests: [],
    push: { on: false, cats: [], lead: [3, 1], change: true }, saved: [] };
  var profile = load();
  var ui = { grade: 'my', cat: 'all', month: null, toast: '', ac: -1 };
  var notices = [], cacheAt = null, feedUpdatedAt = null, vapidKey = null;
  var dept = { board: null, notices: [], updatedAt: null, loaded: false, offline: false };   // 학과 탭 공지
  var extra = {};                                                  // 목록에 없는 공지(예: 다른 탭에서 연 공지)를 id 로 보관

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem('cadaepocket.profile'));
      if (s) {
        if (s.status === '졸업 예정') s.status = '재학';               // 졸업 예정은 없앴다: 4학년 재학으로 본다
        var p = Object.assign({}, DEF, s, { push: Object.assign({}, DEF.push, s.push || {}) });
        var d = DEP.find(p.dept, p.campus); if (d) p.college = d.full;   // 저장된 소속을 공식 단과대학·계열로 맞춘다
        return p;
      }
    } catch (e) {}
    return JSON.parse(JSON.stringify(DEF));
  }
  function save() {
    try { localStorage.setItem('cadaepocket.profile', JSON.stringify(profile)); } catch (e) {}
    idbSet('profile', profile);                                   // 서비스 워커가 푸시를 걸러낼 때 읽는다
  }
  function idbSet(k, v) {
    try {
      var r = indexedDB.open('cadaepocket', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { var tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); };
    } catch (e) {}
  }

  /* ───────── 유틸 ───────── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function L() { return profile.lang; }
  function t(k) { return (T[L()] && T[L()][k]) || T.ko[k] || k; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function md(iso) {
    if (!iso) return ''; var m = +iso.slice(5, 7), d = +iso.slice(8, 10);
    return L() === 'en' ? MON[m - 1] + ' ' + d : L() === 'zh' ? m + '月' + d + '日' : m + '/' + d;
  }
  function today() { var d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
  function me() { return Object.assign({}, profile, { grade: M.gradeOf(profile.done) }); }
  function tx(n) {
    var x = n.tx[L()] || {}, k = n.tx.ko || {}, o = {};
    ['title', 'gist', 'who', 'benefit', 'docs', 'how'].forEach(function (f) { o[f] = x[f] || k[f] || ''; });
    o.untranslated = L() !== 'ko' && !(n.tx[L()] && n.tx[L()].title);     // 번역이 아직 없어 한국어 원문을 보여 주는 중
    return o;
  }
  function dday(n) {
    if (!n.end) return { label: n.ocr || (n.criteria.uncertain || []).length ? t('chk') : t('open'), urgent: false, days: null };
    var d = M.daysLeft(n.end, today());
    return { label: d === 0 ? 'D-Day' : d < 0 ? (L() === 'ko' ? '마감' : L() === 'zh' ? '已截止' : 'Closed') : 'D-' + d, urgent: d >= 0 && d <= 7, days: d };
  }
  function period(n) { return n.start && n.end ? md(n.start) + (L() === 'en' ? ' – ' : ' ~ ') + md(n.end) : (n.end ? '~ ' + md(n.end) : ''); }
  function catName(k) { return I.CAT[L()][k] || k; }
  function tl(ko, en, zh) { return L() === 'en' ? en : L() === 'zh' ? zh : ko; }
  function gradeName(g) { return tl(g + '학년', 'Year ' + g, g + '年级'); }
  function onLeave() { return profile.status === '휴학' || profile.status === '복학 예정'; }
  /* 복학 예정 학기 후보: 오늘 기준 다음 두 학기 (예: 2026년 11월 → 2027-1, 2027-2) */
  function nextTerms() { var d = new Date(), y = d.getFullYear(); return d.getMonth() < 6 ? [y + '-2', (y + 1) + '-1'] : [(y + 1) + '-1', (y + 1) + '-2']; }
  function termName(v) { return v === 'tbd' ? tl('미정', 'Not decided', '未定') : tl(v + '학기', 'Sem. ' + v, v + '学期'); }
  /* 오른쪽 위 알약: "경영학과 · 3학년" / "컴퓨터정보공학부 · 휴학 중" */
  function meLabel() {
    var who = profile.dept || CAMPUS[profile.campus].name[L()];
    var st = profile.status === '휴학' ? tl('휴학 중', 'On leave', '休学中') : profile.status === '재학' ? gradeName(me().grade) : I.STAT[L()][profile.status];
    return who + ' · ' + st;
  }
  /* 홈 제목 아래 기준 문구 */
  function feedSub() {
    var p = me(), dept = profile.dept, gpa = profile.gpa.toFixed(1);
    if (onLeave()) {
      var rt = profile.returnTerm && profile.returnTerm !== 'tbd' ? tl(profile.returnTerm + '학기 복학 예정', 'Returning ' + profile.returnTerm, '预定' + profile.returnTerm + '学期复学') : semText(profile.done, profile.status);
      return [dept, rt].filter(Boolean).join(' · ');
    }
    if (L() === 'ko') return (dept ? dept + ' ' : '') + p.grade + '학년 · 평균 학점 ' + gpa + ' 기준이에요';
    return [dept, gradeName(p.grade), tl('', 'GPA ', '平均绩点 ') + gpa].filter(Boolean).join(' · ');
  }
  /* '마지막 업데이트' 시각: 오늘이면 "오늘 오후 2:30", 아니면 "11/5 오후 2:30" */
  function fmtTime(iso) {
    var d = new Date(iso); if (!iso || isNaN(d)) return '';
    var now = new Date(), same = d.toDateString() === now.toDateString();
    var h = d.getHours(), mm = String(d.getMinutes()).padStart(2, '0'), h12 = h % 12 || 12;
    var day = md(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    if (L() === 'en') return (same ? 'Today' : day) + ', ' + h12 + ':' + mm + (h < 12 ? ' AM' : ' PM');
    if (L() === 'zh') return (same ? '今天' : day) + ' ' + h + ':' + mm;
    return (same ? '오늘' : day) + ' ' + (h < 12 ? '오전 ' : '오후 ') + h12 + ':' + mm;
  }
  function updLine(iso) { var s = fmtTime(iso); return s ? tl('마지막 업데이트 ', 'Last updated ', '最后更新 ') + s : tl('아직 수집 전이에요', 'Not synced yet', '尚未同步'); }
  /* 내 학과 (학과 목록에 있는 학과만 학과 공지를 볼 수 있다) */
  function myDept() { return DEP.find(profile.dept, profile.campus); }
  function allNotices() {
    var seen = {}, out = [];
    notices.concat(dept.notices, Object.keys(extra).map(function (k) { return extra[k]; })).forEach(function (n) { if (!seen[n.id]) { seen[n.id] = 1; out.push(n); } });
    return out;
  }
  function toast(s) { ui.toast = s; render(); setTimeout(function () { ui.toast = ''; render(); }, 2600); }
  function api(path, opt) { return fetch(path, opt).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }

  /* ───────── 데이터 ───────── */
  function fetchNotices() {
    if (!profile.campus) return Promise.resolve();
    return api('/api/notices?campus=' + profile.campus).then(function (j) {
      notices = j.notices; cacheAt = j.at; feedUpdatedAt = j.updatedAt || null; ui.offline = false; ui.loadErr = false;
      try { localStorage.setItem('cadaepocket.notices.' + profile.campus, JSON.stringify(j)); } catch (e) {}
    }).catch(function () {
      try { var j = JSON.parse(localStorage.getItem('cadaepocket.notices.' + profile.campus)); if (j) { notices = j.notices; cacheAt = j.at; feedUpdatedAt = j.updatedAt || null; ui.offline = true; } } catch (e) {}
      // 저장해 둔 목록도 없으면 '공지 없음' 대신 '불러오지 못함 · 다시 시도'를 보여 준다
      ui.loadErr = !notices.length;
    }).then(function () { ui.loaded = true; render(); fetchDept(); });
  }
  /* 학과 공지: 학과 게시판 이름만 요청에 담는다 (서버는 저장하지 않음) */
  function fetchDept() {
    var d = myDept();
    if (!d || !d.board) { dept = { board: null, notices: [], updatedAt: null, loaded: true, offline: false }; return Promise.resolve(); }
    var key = 'cadaepocket.dept.' + d.board;
    if (dept.board !== d.board) dept = { board: d.board, notices: [], updatedAt: null, loaded: false, offline: false };
    return api('/api/notices?campus=' + d.campus + '&board=' + encodeURIComponent(d.board)).then(function (j) {
      dept = { board: d.board, notices: j.notices, updatedAt: j.updatedAt || null, loaded: true, offline: false };
      try { localStorage.setItem(key, JSON.stringify(j)); } catch (e) {}
    }).catch(function () {
      var j = null; try { j = JSON.parse(localStorage.getItem(key)); } catch (e) {}
      dept = { board: d.board, notices: j ? j.notices : [], updatedAt: j ? j.updatedAt : null, loaded: true, offline: true };
    }).then(function () { if (route() === '/dept' || route() === '/saved' || route() === '/cal') render(); });
  }

  /* ───────── 화면 조각 ───────── */
  function tabbar(cur) {
    var tabs = [['feed', t('tabHome'), 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'],
      ['dept', tl('학과', 'Dept.', '院系'), 'M2 9l10-5 10 5-10 5zM6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5M22 9v6'],
      ['cal', t('tabCal'), 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4'],
      ['saved', tl('저장', 'Saved', '收藏'), 'M6 3.5h12v17l-6-4.2-6 4.2z'],
      ['set', t('tabSet'), 'M4 9h8M18 9h2M4 15h2M12 15h8M15 6.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM9 12.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z']];
    return '<nav class="tabbar">' + tabs.map(function (x) {
      return '<a class="tb' + (cur === x[0] ? ' on' : '') + '" href="#/' + (x[0] === 'feed' ? '' : x[0]) + '"' + (cur === x[0] ? ' aria-current="page"' : '') + '><svg class="ic" viewBox="0 0 24 24"><path d="' + x[2] + '"/></svg>' + esc(x[1]) + '</a>';
    }).join('') + '</nav>';
  }
  function bar(inner) { return '<div class="bar">' + inner + '</div>'; }
  function logo() { return '<div class="logo"><span class="mark"></span>' + esc(L() === 'ko' ? '가대포켓' : 'CadaePocket') + '</div>'; }
  function toastHtml() { return ui.toast ? '<div class="toast" role="status">' + esc(ui.toast) + '</div>' : ''; }

  /* m: 해당 여부('match'|'maybe'|'no'). null 이면 해당 여부 배지를 달지 않는다 (학과 탭: 내 학과 공지라 모두 해당)
   * pin: 학과 게시판에서 상단 고정('공지')된 글이면 사이트처럼 '공지' 표시를 맨 앞에 단다 */
  function card(n, m, pin) {
    var d = dday(n), x = tx(n);
    var bd = m === 'match' ? 'bd-match' : m === 'maybe' ? 'bd-maybe' : 'bd-no';
    var lab = m === 'match' ? t('bMatch') : m === 'maybe' ? t('bMaybe') : t('bNo');
    var badge = m ? '<span class="bd ' + bd + '">' + esc(lab) + '</span>' : '';
    var chg = n.change && n.version > 1 ? '<span class="bd bd-chg">' + esc(t('bChg')) + '</span>' : '';
    var ko = x.untranslated ? '<span class="bd bd-ko" title="' + esc(tl('', 'Not translated yet', '尚未翻译')) + '">' + esc(tl('', 'Korean', '韩文')) + '</span>' : '';
    return '<a class="nc' + (m ? ' m-' + m : '') + (pin ? ' pin' : '') + '" href="#/n/' + n.id + '"><div class="nc-top">' + (pin ? '<span class="bd bd-pin">' + esc(tl('공지', 'Pinned', '置顶')) + '</span>' : '') + '<span class="tag">' + esc(catName(n.cat)) + '</span>' + badge + chg + ko +
      '<span class="dd' + (d.urgent ? ' urg' : '') + '">' + esc(d.label) + '</span></div><p class="nc-title">' + esc(x.title) + '</p>' +
      '<dl class="meta">' + (x.who ? '<dt>' + esc(t('who')) + '</dt><dd>' + esc(x.who) + '</dd>' : '') +
      (n.end || n.start ? '<dt>' + esc(t('when')) + '</dt><dd>' + esc(period(n)) + '</dd>' : '') + '</dl></a>';
  }

  /* ───────── 뷰: 초기 설정 ───────── */
  var OS = {
    ko: { title: '내게 맞는 공지만 골라 드릴게요', sub: '아래 정보로 해당되는 공지를 골라요. 입력한 정보는 이 기기에만 저장돼요.', lCampus: '캠퍼스', hCampus: '캠퍼스마다 공지가 올라오는 게시판이 달라요. 선택한 캠퍼스의 공지만 가져와요.', lLang: '언어', lStatus: '학적 상태', lDept: '학과(부)', lDone: '이수 완료한 학기', hDone: '휴학한 학기는 빼고, 실제로 다닌 학기만 세어 주세요.', lGpa: '평균 학점', hGpa: '4.5 만점 기준이에요.', lExc: '교환·외국인 학생이에요', lInt: '관심 영역 (선택)', hInt: '관심 영역의 공지는 더 위에 보여드려요.', priv: '학과·학점은 서버에 저장하지 않아요. 학과 공지를 불러올 때만 그 학과 게시판 이름을 요청에 담아요. 푸시를 켜면 알림을 고르려고 학적·이수 학기·교환 여부와 저장한 공지 번호만 보내요. AI에는 공지 본문만 전달해요.', cta: '시작하기', gpaFix: '평균 학점은 0.0~4.5 사이예요. 4.5 만점에 맞춰 고쳤어요.', gpaBad: '숫자로 입력해 주세요 (예: 3.5). 이전 값을 그대로 뒀어요.',
      hDept: '학과 이름을 입력하면 목록이 나와요. 목록에서 고르면 단과대학도 함께 저장되고 학과 공지를 볼 수 있어요.', college: '단과대학', notListed: '목록에 없는 학과예요. 학과 공지는 목록에서 고른 학과만 볼 수 있어요.', noMatch: '일치하는 학과가 없어요' },
    en: { title: 'Only the notices that apply to you', sub: 'We use this to pick matching notices. Your details stay on this device.', lCampus: 'Campus', hCampus: 'Each campus posts on its own board. We only sync your campus.', lLang: 'Language', lStatus: 'Status', lDept: 'Department', lDone: 'Semesters completed', hDone: 'Do not count semesters you were on leave.', lGpa: 'GPA', hGpa: 'On a 4.5 scale.', lExc: 'I am an exchange / international student', lInt: 'Interests (optional)', hInt: 'Notices in these areas appear higher.', priv: 'Your department and GPA are not stored on a server. Only when loading department notices is the department board name sent in the request. With push on, only your status, semesters, exchange flag and saved notice IDs are sent to pick alerts. Only notice text goes to the AI.', cta: 'Get started', gpaFix: 'GPA must be between 0.0 and 4.5, so we adjusted it.', gpaBad: 'Please enter a number (e.g. 3.5). We kept the previous value.',
      hDept: 'Start typing to see matching departments. Pick one to save its college and see department notices.', college: 'College', notListed: 'This department is not in the list, so department notices are not available.', noMatch: 'No matching department' },
    zh: { title: '只为您挑选相关通知', sub: '我们根据以下信息筛选通知。您输入的信息只保存在本设备上。', lCampus: '校区', hCampus: '各校区的公告发布在不同的网站。我们只同步所选校区的公告。', lLang: '语言', lStatus: '学籍状态', lDept: '院系', lDone: '已完成学期数', hDone: '休学的学期不计入。', lGpa: '平均绩点', hGpa: '满分4.5。', lExc: '我是交换生/留学生', lInt: '关注领域（选填）', hInt: '关注领域的通知会显示在更靠前的位置。', priv: '院系和绩点不会保存在服务器上。只有加载院系通知时，请求中才会包含该院系公告栏名称。开启推送时，仅发送学籍、学期数、交换生标记和收藏的通知编号用于筛选提醒。只有通知正文会交给AI。', cta: '开始使用', gpaFix: '绩点应在0.0~4.5之间，已为您调整。', gpaBad: '请输入数字（例：3.5）。已保留之前的数值。',
      hDept: '输入院系名称即可显示列表。从列表中选择后会同时保存所属学院，并可查看院系通知。', college: '学院', notListed: '列表中没有该院系，无法查看院系通知。', noMatch: '没有匹配的院系' }
  };
  function chip(on, label, act, val) { return '<button class="chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-a="' + act + '" data-v="' + esc(val) + '">' + esc(label) + '</button>'; }
  function viewSetup() {
    var o = OS[L()], p = profile, c = p.campus;
    var cps = ['sim', 'ui'].map(function (k) {
      var on = c === k, x = CAMPUS[k];
      return '<button class="' + (on ? 'on' : '') + '" aria-pressed="' + on + '" data-a="campus" data-v="' + k + '"><span class="cn">' + esc(x.name[L()]) + '</span><span class="cp">' + esc(x.place[L()]) + '</span><span class="cb">' + x.host + '</span></button>';
    }).join('');
    var langs = [['ko', '한국어'], ['en', 'English'], ['zh', '中文']].map(function (x) { return chip(p.lang === x[0], x[1], 'lang', x[0]); }).join('');
    var sts = ['재학', '휴학', '복학 예정'].map(function (k) { return chip(p.status === k, I.STAT[L()][k], 'status', k); }).join('');
    var sems = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (n) { return chip(p.done === n, n === 9 ? '9+' : String(n), 'done', n); }).join('');
    var ints = c ? CAMPUS[c].cats.map(function (k) { return chip(p.interests.indexOf(k) > -1, catName(k), 'int', k); }).join('') : '';
    return bar(logo()) + '<div class="scroll"><h1 class="h1">' + esc(o.title) + '</h1><p class="sub">' + esc(o.sub) + '</p>' +
      '<div class="fld"><span class="lab">' + esc(o.lCampus) + '</span><p class="hint">' + esc(o.hCampus) + '</p><div class="cpk">' + cps + '</div></div>' +
      '<div class="fld"><span class="lab">' + esc(o.lLang) + '</span><div class="wrap">' + langs + '</div></div>' +
      '<div class="fld"><span class="lab">' + esc(o.lStatus) + '</span><div class="wrap">' + sts + '</div></div>' +
      (onLeave() ? '<div class="fld"><span class="lab">' + esc(tl('복학 예정 학기', 'Returning semester', '预定复学学期')) + '</span><div class="wrap">' +
        nextTerms().concat(['tbd']).map(function (v) { return chip(p.returnTerm === v, termName(v), 'rterm', v); }).join('') + '</div></div>' : '') +
      deptField(o) +
      '<div class="fld"><span class="lab">' + esc(o.lDone) + '</span><p class="hint">' + esc(o.hDone) + '</p><div class="grid5">' + sems + '</div><p class="cur">' + esc(semText(p.done, p.status)) + '</p></div>' +
      '<div class="fld"><label class="lab" for="gpa">' + esc(o.lGpa) + '</label><p class="hint">' + esc(o.hGpa) + '</p><input id="gpa" class="in" type="text" inputmode="decimal" value="' + esc(p.gpa.toFixed(1)) + '" data-in="gpa" aria-describedby="gpainfo"><p class="hint" id="gpainfo" role="status" style="margin-top:8px" hidden></p></div>' +
      '<div class="fld">' + chip(p.exchange, o.lExc, 'exchange', '') + '</div>' +
      (c ? '<div class="fld"><span class="lab">' + esc(o.lInt) + '</span><p class="hint">' + esc(o.hInt) + '</p><div class="wrap">' + ints + '</div></div>' : '') +
      '<p class="priv">' + esc(o.priv) + '</p></div><div class="cta"><button class="btn" data-a="start"' + (c ? '' : ' disabled style="opacity:.5"') + '>' + esc(o.cta) + '</button></div>';
  }
  /* 학과 입력 + 자동완성 목록. 목록은 입력할 때마다 acList() 가 다시 채운다(전체를 다시 그리면 입력이 끊기므로) */
  function deptInfoHtml(o) {
    var d = myDept();
    return d ? '<p class="cur" id="deptinfo">' + esc(o.college + ' · ' + d.full) + '</p>'
      : (profile.dept ? '<p class="hint" id="deptinfo" style="margin-top:8px">' + esc(o.notListed) + '</p>' : '<p id="deptinfo"></p>');
  }
  function deptField(o) {
    var p = profile, info = deptInfoHtml(o);
    return '<div class="fld acwrap"><label class="lab" for="dept">' + esc(o.lDept) + '</label><p class="hint">' + esc(o.hDept) + '</p>' +
      '<input id="dept" class="in" type="text" value="' + esc(p.dept) + '" data-in="dept" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="acl">' +
      '<ul class="ac" id="acl" role="listbox" hidden></ul>' + info + '</div>';
  }
  function acItems(q) { return DEP.search(q, profile.campus, 8); }
  function acList(input) {
    var ul = document.getElementById('acl'); if (!ul) return;
    var q = input.value.trim(), items = q ? acItems(q) : [];
    if (!q) { ul.hidden = true; ul.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); return; }
    if (ui.ac >= items.length) ui.ac = items.length - 1;
    ul.innerHTML = items.length ? items.map(function (d, i) {
      return '<li id="ac' + i + '" role="option" class="' + (i === ui.ac ? 'on' : '') + '" aria-selected="' + (i === ui.ac) + '" data-pick="' + esc(d.name) + '"><span class="an">' + esc(d.name) + '</span><span class="acol">' + esc(d.full) + '</span></li>';
    }).join('') : '<li class="none" aria-disabled="true">' + esc(OS[L()].noMatch) + '</li>';
    ul.hidden = false; input.setAttribute('aria-expanded', 'true');
    if (ui.ac > -1) input.setAttribute('aria-activedescendant', 'ac' + ui.ac); else input.removeAttribute('aria-activedescendant');
  }
  function pickDept(name) {
    var d = DEP.find(name, profile.campus);
    profile.dept = d ? d.name : name; profile.college = d ? d.full : '';
    // 입력칸 값을 먼저 바꿔 둔다: 포커스가 빠질 때 change 가 입력 중이던 글자로 덮어쓰지 않게
    var inp = document.getElementById('dept'); if (inp) inp.value = profile.dept;
    ui.ac = -1; save(); if (inp && document.activeElement === inp) inp.blur(); render(); fetchDept();
  }
  function semText(done, status) {
    var g = M.gradeOf(done), term = M.termOf(done), ret = status === '휴학' || status === '복학 예정';
    if (L() === 'en') return (ret ? 'After returning: ' : 'Now: ') + 'Year ' + g + ', Semester ' + term;
    if (L() === 'zh') return (ret ? '复学后：' : '当前：') + g + '年级 ' + term + '学期';
    return (ret ? '복학 후 ' : '현재 ') + g + '학년 ' + term + '학기';
  }

  /* ───────── 뷰: 홈 ───────── */
  function viewFeed() {
    var p = me(), c = CAMPUS[profile.campus];
    var items = notices.map(function (n) { return { id: n.id, cat: n.cat, end: n.end, criteria: n.criteria, n: n }; });
    var list = M.feed(items, p, { grade: ui.grade, cat: ui.cat, today: today() });
    // 관심 영역·상태별 가중치는 match.js 의 score 가 처리
    var mode = profile.status === '휴학' ? t('modeLeave') : '';
    var grades = [['my', t('gMy')], ['all', t('gAll')], ['1', t('g1')], ['2', t('g2')], ['3', t('g3')], ['4', t('g4')]];
    // 맨 끝 '마감' 탭: 마감 지난 공지만 모아 본다 (다른 탭에서는 마감 지난 공지를 빼고 보여 준다)
    var cats = ['all'].concat(c.cats, ['closed']);
    var catLabel = function (k) { return k === 'closed' ? tl('마감', 'Closed', '已截止') : I.CAT[L()][k]; };
    // 아직 받은 목록이 없으면(불러오는 중·실패) 머리글이 '0건 · 아직 수집 전'으로 보이지 않게 건수를 숨기고 상태를 알린다
    var waiting = !notices.length && (ui.loadErr || !ui.loaded);
    var upd = !waiting ? updLine(feedUpdatedAt) : ui.loadErr ? tl('서버에 연결하지 못했어요', 'Could not reach the server', '无法连接服务器') : tl('불러오는 중이에요', 'Loading…', '正在加载…');
    var body = list.length ? list.map(function (x) { return card(x.item.n, x.m); }).join('') :
      !notices.length && ui.loadErr ? '<div class="empty" role="alert"><p class="empty-t">' + esc(tl('공지를 불러오지 못했어요', 'Could not load notices', '无法加载通知')) + '</p><p>' +
        esc(tl('인터넷 연결을 확인한 뒤 다시 시도해 주세요.', 'Check your internet connection and try again.', '请检查网络连接后重试。')) + '</p><button class="btn sec" data-a="retry">' + esc(tl('다시 시도', 'Try again', '重试')) + '</button></div>' :
      !notices.length && !ui.loaded ? '<div class="empty" role="status"><p>' + esc(tl('공지를 불러오고 있어요…', 'Loading notices…', '正在加载通知…')) + '</p></div>' : ui.cat === 'closed' ?
      '<div class="empty"><p class="empty-t">' + esc(tl('마감된 공지가 없어요', 'No closed notices', '没有已截止的通知')) + '</p></div>' :
      '<div class="empty"><p class="empty-t">' + esc(t('emptyT')) + '</p><p>' + esc(t('emptyB')) + '</p><button class="btn sec" data-a="grade" data-v="all">' + esc(t('emptyBtn')) + '</button></div>';
    return bar(logo() + '<div class="bar-r">' + bell() + '<a class="me" href="#/set">' + esc(meLabel()) + '</a></div>') +
      // 위쪽(제목·필터)은 고정하고 아래 공지 카드 목록만 스크롤한다
      '<div class="lhead"><h1 class="h1">' + esc(t(ui.grade === 'my' ? 'feedMy' : 'feedAll')) + (waiting ? '' : ' <span class="cnt">' + list.length + (L() === 'ko' ? '건' : '') + '</span>') + '</h1>' +
      '<p class="sub" style="margin-bottom:4px">' + esc(feedSub()) + '</p>' +
      '<p class="srcln"><span class="cmpt">' + esc(c.name[L()]) + '</span> ' + esc(c.host) + esc(t('srcFrom')) + (ui.offline ? ' · offline' : '') + '</p>' +
      '<p class="upd' + (waiting ? (ui.loadErr ? ' err' : ' wait') : '') + '">' + esc(upd) + '</p>' +
      (mode ? '<p class="mode">' + esc(mode) + '</p>' : '') +
      '<div class="chips">' + grades.map(function (g) { return chip(ui.grade === g[0], g[1], 'grade', g[0]); }).join('') + '</div>' +
      '<div class="chips cats">' + cats.map(function (k) { return '<button class="ct' + (ui.cat === k ? ' on' : '') + '" data-a="cat" data-v="' + k + '">' + esc(catLabel(k)) + '</button>'; }).join('') + '</div></div>' +
      '<div class="scroll list" id="sc">' + body + '</div>' +
      '<button class="totop" id="totop" aria-label="' + esc(t('toTop')) + '" style="display:none" data-a="top"><svg class="ic" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>' + tabbar('feed');
  }

  /* ───────── 뷰: 상세 ───────── */
  function labels() {
    var l = L();
    var sem = l === 'ko' ? '학기' : l === 'zh' ? '学期' : ' sem.';
    return { lang: l, rStatus: t('rStatus'), allStatus: l === 'ko' ? '전체 학적' : l === 'zh' ? '全部学籍' : 'All statuses', statusName: function (s) { return I.STAT[l][s]; },
      rDept: t('rDept'), rGrade: t('rGrade'), rDone: t('rDone'), rGpa: t('rGpa'), rAud: t('rAud'), audX: t('audX'), audXme: t('audXme'), audNo: t('audNo'),
      seeSrc: t('seeSrc'), cantTell: t('cantTell'), noDept: l === 'ko' ? '학과를 입력하지 않았어요' : l === 'zh' ? '未填写院系' : 'Department not set', gpaNeed: t('gpaNeed'), cmpNo: t('cmpNo'), cmpUnk: t('cmpUnk'), cmpAll: t('cmpAll'),
      gradeNeed: function (g) { return l === 'ko' ? g.join('·') + '학년' : l === 'zh' ? g.join('·') + '年级' : 'Year ' + (g.length > 1 ? g[0] + '–' + g[g.length - 1] : g[0]); },
      gradeMine: function (p, g) { var ret = p.status === '휴학' || p.status === '복학 예정'; return l === 'ko' ? (ret ? '복학 후 ' : '') + g + '학년' : l === 'zh' ? (ret ? '复学后' : '') + g + '年级' : 'Year ' + g + (ret ? ' after returning' : ''); },
      doneNeed: function (a, b) { return a != null && b != null ? a + '~' + b + sem : a != null ? a + (l === 'ko' ? '학기 이상' : l === 'zh' ? '学期以上' : '+ sem.') : '~' + b + sem; },
      semUnit: function (n) { return n + sem; },
      gpaMine: function (g) { return (l === 'ko' ? '평균 학점 ' : l === 'zh' ? '平均绩点 ' : 'GPA ') + g.toFixed(1); } };
  }
  /* 정정 상자: 바뀐 항목을 "신청 마감 11/20 → 11/27" 처럼 보여준다 */
  var FIELD = { end: ['신청 마감', 'Deadline', '截止日期'], start: ['신청 시작', 'Opens', '开始日期'], statuses: ['대상 학적', 'Status', '学籍'], grades: ['대상 학년', 'Year', '年级'],
    minGpa: ['최소 평점', 'Min. GPA', '最低绩点'], minDone: ['이수 학기', 'Semesters', '学期'], maxDone: ['이수 학기', 'Semesters', '学期'], depts: ['대상 학과', 'Departments', '院系'] };
  function fval(v) {
    if (v == null || (Array.isArray(v) && !v.length)) return '–';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return md(v);
    return Array.isArray(v) ? v.join('·') : String(v);
  }
  function detectedAt(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var h = d.getHours(), mm = String(d.getMinutes()).padStart(2, '0'), day = md(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    return tl(day + ' ' + (h < 12 ? '오전 ' : '오후 ') + (h % 12 || 12) + ':' + mm + '에 변경을 감지했어요',
      'Change detected ' + day + ', ' + (h % 12 || 12) + ':' + mm + (h < 12 ? ' AM' : ' PM'), day + ' ' + h + ':' + mm + ' 检测到更新');
  }
  function viewDetail(id) {
    // 상세: 위쪽은 '목록' 버튼만 (로고·앱 이름 없음), 아래 '원문 보기·공지 저장'과 함께 고정. 가운데 본문만 스크롤
    var top = bar('<a class="back" href="#' + (ui.from || '/') + '"><svg class="ic" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>' + esc(t('back')) + '</a>');
    var n = allNotices().filter(function (x) { return x.id === id; })[0];
    if (!n) { loadById(id); return top + '<div class="scroll"><p class="loading">' + (missing[id] ? '404' : '…') + '</p></div>'; }
    if (!n.full) loadDetail(n);
    var p = me(), m = M.match(n.criteria, p), x = tx(n), l = labels();
    var rs = M.rows(n.criteria, p, l);
    // 충족일 때도 무엇을 충족하는지 보이도록: 공지가 따로 제한하지 않은 학적·학과·학년도 '제한 없음 ✓' 줄로 보여 준다
    if (!rs.some(function (r) { return r.st === 'no'; })) {
      var has = {}; rs.forEach(function (r) { has[r.label] = 1; });
      var free = tl('제한 없음', 'No restriction', '无限制');
      [[l.rStatus, l.statusName(p.status)], [l.rDept, p.dept || '—'], [l.rGrade, l.gradeMine(p, p.grade)]].forEach(function (a) {
        if (!has[a[0]]) rs.push({ st: 'ok', label: a[0], need: free, mine: a[1] });
      });
      rs = rs.filter(function (r) { return r.st !== 'unk'; }).concat(rs.filter(function (r) { return r.st === 'unk'; }));   // 확인 필요는 맨 아래
    }
    var bd = m === 'match' ? 'bd-match' : m === 'maybe' ? 'bd-maybe' : 'bd-no';
    var saved = profile.saved.indexOf(n.id) > -1;
    var rows = rs.map(function (r) {
      return '<li><span class="st st-' + r.st + '">' + { ok: '✓', no: '✕', unk: '?' }[r.st] + '</span><div><p class="cl">' + esc(r.label) + '</p>' +
        '<p class="cv"><span class="k">' + esc(t('need')) + '</span>' + esc(r.need) + '</p><p class="cv"><span class="k">' + esc(t('mine')) + '</span>' + esc(r.mine) + '</p></div></li>';
    }).join('');
    var when = period(n) ? esc(period(n)) + (n.ocr ? '<span class="un">' + esc(t('unsure')) + '</span>' : '') : '';
    var sum = [[t('sWho'), esc(x.who)], [t('sWhen'), when], [tl('혜택·내용', 'Benefits', '支持内容'), esc(x.benefit)], [t('sDocs'), esc(x.docs)], [t('sHow'), esc(x.how)]].filter(function (a) { return a[1]; })
      .map(function (a) { return '<dt>' + esc(a[0]) + '</dt><dd>' + a[1] + '</dd>'; }).join('');
    var chg = '';
    if (n.change && n.version > 1) {
      var diffs = (n.change.fields || []).map(function (f) {
        var lab = FIELD[f.field] ? tl(FIELD[f.field][0], FIELD[f.field][1], FIELD[f.field][2]) : f.field;
        return '<div class="diff"><span class="what">' + esc(lab) + '</span><span class="old">' + esc(fval(f.from)) + '</span><span aria-hidden="true">→</span><span class="new">' + esc(fval(f.to)) + '</span></div>';
      }).join('');
      chg = '<div class="chgbox"><strong>' + esc(t('chgT')) + '</strong>' + diffs + '<p>' + esc(n.change.summary || '') + '</p><p class="when">' + esc(t('chgAi')) + ' · ' + esc(detectedAt(n.change.at)) + '</p></div>';
    }
    var maybe = m === 'maybe' ? '<div class="maybebox"><strong>' + esc(t('maybeT')) + '</strong><p>' + esc(t('maybeB')) + '</p></div>' : '';
    var files = (n.attachments || []).filter(function (a) { return a.kind === 'file'; }).map(function (a) { return '<li><a class="lnk" href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.name) + '</a></li>'; }).join('');
    return top + '<div class="scroll"><div class="nc-top"><span class="tag">' + esc(catName(n.cat)) + '</span><span class="bd ' + bd + '">' +
      esc(m === 'match' ? t('bMatch') : m === 'maybe' ? t('bMaybe') : t('bNo')) + '</span>' + (n.change && n.version > 1 ? '<span class="bd bd-chg">' + esc(t('bChg')) + '</span>' : '') + '</div>' +
      '<h1 class="h2">' + esc(x.title) + '</h1><p class="sub" style="margin-bottom:4px">' + esc(srcLine(n)) + '</p>' +
      '<p class="upd">' + esc(updLine(n.checkedAt)) + esc(tl(' · 앱이 원문을 확인한 시각이에요', ' · when the app last checked the original', ' · 应用最后核对原文的时间')) + '</p>' +
      (x.untranslated ? '<p class="mode">' + esc(tl('', 'This notice has not been translated yet, so it is shown in the original Korean.', '此通知尚未翻译，显示韩文原文。')) + '</p>' : '') + chg + maybe +
      '<div class="blk"><h2>' + esc(t('cmp')) + '</h2><p class="verdict">' + esc(M.verdict(rs, l)) + '</p><ul class="cmp">' + rows + '</ul></div>' +
      '<div class="blk"><h2>' + esc(t('sum')) + '</h2>' + (x.gist ? '<p class="gist">' + esc(x.gist) + '</p>' : '') + '<dl class="sum">' + sum + '</dl>' + (n.ocr ? '<p class="note">' + esc(t('ocr')) + '</p>' : '') + '<p class="note">' + esc(t('disc')) + '</p></div>' +
      (files ? '<div class="blk"><h2>' + esc(tl('첨부파일', 'Attachments', '附件')) + '</h2><ul class="files">' + files + '</ul></div>' : '') +
      '<button class="lnk" data-a="report" data-v="' + n.id + '">' + esc(t('report')) + '</button></div>' +
      '<div class="actions"><a class="btn sec" href="' + esc(n.url) + '" target="_blank" rel="noopener">' + esc(t('src')) + '</a>' +
      '<button class="btn' + (saved ? ' done' : '') + '" data-a="save" data-v="' + n.id + '">' + esc(saved ? t('saved') + (n.end ? ' · ' + md(n.end) : '') : t('save')) + '</button></div>' + toastHtml();
  }
  /* 목록 API 에는 첨부파일이 없어서 상세를 열 때 한 번 더 불러온다 */
  var loadingDetail = {}, missing = {};
  /* 목록에 없는 공지(푸시 알림·다른 캠퍼스 등)는 하나만 불러온다 */
  function loadById(id) {
    if (loadingDetail[id] || missing[id]) return; loadingDetail[id] = true;
    api('/api/notices/' + id).then(function (full) { extra[id] = Object.assign(full, { full: true }); render(); })
      .catch(function () { missing[id] = true; render(); });
  }
  function loadDetail(n) {
    if (loadingDetail[n.id]) return; loadingDetail[n.id] = true;
    api('/api/notices/' + n.id).then(function (full) { Object.assign(n, full, { full: true }); render(); }).catch(function () { n.full = true; });
  }
  function srcLine(n) {
    var c = CAMPUS[n.campus], ds = n.posted ? md(n.posted) : '';
    return c.name[L()] + ' · ' + (n.dept || '') + ' · ' + (L() === 'ko' ? ds + ' ' + t('posted') : t('posted') + ' ' + ds);
  }

  /* ───────── 뷰: 학과 공지 ───────── */
  function viewDept() {
    var d = myDept(), p = me();
    var head = bar(logo() + '<a class="me" href="#/set">' + esc(meLabel()) + '</a>');
    var body, fixed = '';
    if (!d) {
      body = '<h1 class="h1">' + esc(tl('학과 공지', 'Department notices', '院系通知')) + '</h1><div class="empty"><p class="empty-t">' +
        esc(profile.dept ? tl('목록에 없는 학과예요', 'Department not in the list', '列表中没有该院系') : tl('학과를 아직 고르지 않았어요', 'No department selected', '尚未选择院系')) + '</p><p>' +
        esc(tl('정보 수정에서 학과 이름을 입력하고 목록에서 골라 주세요.', 'In “Edit my info”, type your department and pick it from the list.', '请在“修改我的信息”中输入院系并从列表中选择。')) + '</p>' +
        '<a class="btn sec" href="#/setup">' + esc(tl('학과 고르기', 'Choose department', '选择院系')) + '</a></div>';
    } else if (!d.board) {
      body = '<h1 class="h1">' + esc(d.name) + '</h1><p class="sub">' + esc(d.full) + '</p><div class="empty"><p class="empty-t">' +
        esc(tl('이 학과 게시판은 아직 연결하지 않았어요', 'This department board is not connected yet', '尚未接入该院系公告栏')) + '</p><p>' +
        esc(tl('학교 공지는 홈에서 볼 수 있어요.', 'University notices are on Home.', '学校通知可在首页查看。')) + '</p></div>';
    } else {
      // 서버가 준 순서 그대로 = 학과 사이트와 같은 순서 (상단 고정 '공지' 먼저, 나머지는 최신 글 번호 순)
      var list = dept.notices;
      // 불러오는 중이거나, 실패했는데 저장해 둔 목록도 없으면 머리글에 '0건 · 아직 수집 전'을 보이지 않는다 (홈과 같은 규칙)
      var dErr = dept.loaded && dept.offline && !list.length && !dept.updatedAt, dWait = !dept.loaded || dErr;
      var dUpd = !dWait ? updLine(dept.updatedAt) : dErr ? tl('서버에 연결하지 못했어요', 'Could not reach the server', '无法连接服务器') : tl('불러오는 중이에요', 'Loading…', '正在加载…');
      // 위쪽(학과 이름·출처·업데이트 시각)은 고정하고 카드 목록만 스크롤
      var fixed = '<div class="lhead line"><h1 class="h1">' + esc(tl(d.name + ' 공지', d.name + ' notices', d.name + '通知')) + (dWait ? '' : ' <span class="cnt">' + list.length + (L() === 'ko' ? '건' : '') + '</span>') + '</h1>' +
        '<p class="sub" style="margin-bottom:4px">' + esc(d.full) + '</p>' +
        '<p class="srcln"><span class="cmpt">' + esc(tl('학과', 'Dept.', '院系')) + '</span> ' + esc(d.host) + esc(t('srcFrom')) + (dept.offline ? ' · offline' : '') + '</p>' +
        '<p class="upd' + (dWait ? (dErr ? ' err' : ' wait') : '') + '">' + esc(dUpd) + '</p></div>';
      body = (!dept.loaded ? '<p class="loading">…</p>' : list.length ? list.map(function (n) { return card(n, null, n.boardPinned); }).join('') :
          '<div class="empty"><p class="empty-t">' + esc(tl('아직 가져온 학과 공지가 없어요', 'No department notices yet', '还没有院系通知')) + '</p><p>' +
          esc(tl('다음 수집 때 학과 게시판 공지를 가져와요.', 'They will appear after the next sync.', '下次同步后会显示。')) + '</p></div>') +
        '<p class="note">' + esc(tl('학과 게시판 공지예요. 학교 전체 공지는 홈에서 볼 수 있어요.', 'These come from the department board. University-wide notices are on Home.', '以上来自院系公告栏。学校通知请在首页查看。')) + '</p>';
    }
    return head + (fixed || '') + '<div class="scroll' + (fixed ? ' list' : '') + '">' + body + '</div>' + tabbar('dept');
  }

  /* ───────── 뷰: 캘린더 ───────── */
  function viewCal() {
    var base = ui.month || (function () { var d = new Date(today()); return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; })(); ui.month = base;
    var p = me(), first = new Date(Date.UTC(base.y, base.m, 1)), start = first.getUTCDay(), days = new Date(Date.UTC(base.y, base.m + 1, 0)).getUTCDate();
    var ev = {};
    allNotices().forEach(function (n) {
      if (!n.end) return;
      var m = M.match(n.criteria, p);
      if (m === 'no' && profile.saved.indexOf(n.id) < 0) return;   // 내게 해당(가능성)인 학교·학과 공지 + 저장한 공지
      (ev[n.end] = ev[n.end] || []).push(n);
    });
    var wk = L() === 'en' ? ['S', 'M', 'T', 'W', 'T', 'F', 'S'] : L() === 'zh' ? ['日', '一', '二', '三', '四', '五', '六'] : ['일', '월', '화', '수', '목', '금', '토'];
    var wkLong = tl(['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'], ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']);
    var cells = wk.map(function (w) { return '<span class="dow">' + w + '</span>'; }).join('');
    for (var i = 0; i < start; i++) cells += '<span class="cell blank"></span>';
    var td = new Date(today()).toISOString().slice(0, 10);
    // 기본 선택: 이 달에서 오늘 이후 가장 가까운 마감일 (없으면 오늘). 오늘은 테두리, 선택한 날은 채워서 구분한다
    var monthKey = base.y + '-' + String(base.m + 1).padStart(2, '0');
    var firstDue = Object.keys(ev).filter(function (k) { return k >= td && k.slice(0, 7) === monthKey; }).sort()[0];
    var sel = ui.sel || firstDue || td;
    for (var d = 1; d <= days; d++) {
      var iso = base.y + '-' + String(base.m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      var cls = 'cell' + (iso === td ? ' today' : '') + (ev[iso] ? ' has' : '') + (iso === sel ? ' sel' : '');
      cells += '<button class="' + cls + '" data-a="day" data-v="' + iso + '" aria-pressed="' + (iso === sel) + '"' + (ev[iso] ? ' aria-label="' + d + ' · ' + ev[iso].length + '"' : '') + '>' + d + '</button>';
    }
    // 학과 공지는 본인 학과라 '해당' 배지를 달지 않는다 (학과 탭과 같게)
    var p2 = me(), cardOf = function (n) { return n.scope === 'dept' ? card(n, null) : card(n, M.match(n.criteria, p2)); };
    // 고른 날의 마감만 보여 준다. 그날 마감이 없으면 빈 안내만 (다른 날 공지를 끌어오지 않음)
    var sd = new Date(Date.UTC(+sel.slice(0, 4), +sel.slice(5, 7) - 1, +sel.slice(8, 10)));
    var list = '<p class="daytitle">' + esc(tl(md(sel).replace('/', '월 ') + '일 ', wkLong[sd.getUTCDay()] + ', ', md(sel) + ' ') + (L() === 'en' ? md(sel) : wkLong[sd.getUTCDay()])) + '</p>' +
      (ev[sel] ? ev[sel].map(cardOf).join('') : '<div class="empty"><p>' + esc(tl('이 날 마감인 공지가 없어요', 'No deadlines on this day', '这一天没有截止的通知')) + '</p></div>');
    var title = tl(base.y + '년 ' + (base.m + 1) + '월', MON[base.m] + ' ' + base.y, base.y + '年' + (base.m + 1) + '月');
    var chev = function (dir, d, label) { return '<button data-a="mon" data-v="' + dir + '" aria-label="' + esc(label) + '"><svg class="ic" viewBox="0 0 24 24"><path d="' + d + '"/></svg></button>'; };
    // 위쪽(월 제목·이전/다음 달)과 아래 탭바는 고정, 달력과 마감 공지만 스크롤
    return bar(logo() + '<a class="me" href="#/set">' + esc(meLabel()) + '</a>') + '<div class="lhead line"><div class="calhd"><h1 class="h1">' + esc(title) + '</h1>' +
      '<div class="calnav">' + chev(-1, 'M15 5l-7 7 7 7', tl('이전 달', 'Previous month', '上个月')) + chev(1, 'M9 5l7 7-7 7', tl('다음 달', 'Next month', '下个月')) + '</div></div>' +
      '<p class="sub" style="margin-bottom:4px">' + esc(tl('학교·학과 공지 중 내게 해당되는 공지와 저장한 공지의 마감일이에요.', 'Deadlines of university and department notices that apply to you, plus saved ones.', '与您相关的学校和院系通知及已收藏通知的截止日期。')) + '</p></div>' +
      '<div class="scroll"><div class="cal">' + cells + '</div>' + list + '</div>' + tabbar('cal');
  }

  /* ───────── 뷰: 설정 ───────── */
  function viewSettings() {
    var c = profile.campus, ps = profile.push, canPush = 'serviceWorker' in navigator && 'PushManager' in window;
    var S = {
      ko: { camp: '공지 출처(캠퍼스)', prof: '정보 수정', push: '앱 푸시', pushOn: '푸시 알림 받기', pushHelp: '내게 해당되는 새 공지가 올라오면 알려드려요. 알림을 켜기 전에 올라온 공지는 알리지 않아요.', cats: '새 공지 알림 받을 영역', lead: '저장한 공지 마감 알림', chg: '저장한 공지가 바뀌면 알려주기', reset: '이 기기의 정보 모두 지우기', noPush: '이 브라우저는 푸시를 지원하지 않아요. (iPhone은 홈 화면에 추가한 뒤 사용하세요)', noKey: '서버에 푸시 키가 설정돼 있지 않아요.', d0: '마감 당일', dn: function (n) { return '마감 ' + n + '일 전'; }, lang: '언어' },
      en: { camp: 'Notice source (campus)', prof: 'Edit my info', push: 'Push notifications', pushOn: 'Enable notifications', pushHelp: 'We alert you when a new notice that applies to you is posted. Notices posted before you turn this on are not sent.', cats: 'New-notice categories', lead: 'Deadline reminders for saved notices', chg: 'Alert me when a saved notice changes', reset: 'Erase all data on this device', noPush: 'This browser does not support push. (On iPhone, add to Home Screen first)', noKey: 'Push keys are not configured on the server.', d0: 'Due day', dn: function (n) { return n + ' d before'; }, lang: 'Language' },
      zh: { camp: '通知来源（校区）', prof: '修改我的信息', push: '推送通知', pushOn: '开启通知', pushHelp: '有与您相关的新通知发布时提醒您。开启前已发布的通知不会提醒。', cats: '新通知提醒类别', lead: '收藏通知的截止提醒', chg: '收藏的通知更正时提醒我', reset: '清除本设备上的所有数据', noPush: '此浏览器不支持推送。（iPhone请先添加到主屏幕）', noKey: '服务器未配置推送密钥。', d0: '当天', dn: function (n) { return '提前' + n + '天'; }, lang: '语言' }
    }[L()];
    var cps = ['sim', 'ui'].map(function (k) { return chip(c === k, CAMPUS[k].name[L()], 'switchCampus', k); }).join('');
    var langs = [['ko', '한국어'], ['en', 'English'], ['zh', '中文']].map(function (x) { return chip(L() === x[0], x[1], 'lang2', x[0]); }).join('');
    var sw = function (on, act, val, label) { return '<button class="sw' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" aria-label="' + esc(label) + '" data-a="' + act + '" data-v="' + esc(val) + '"></button>'; };
    var row = function (title, desc, right) { return '<div class="row"><div><p class="row-t">' + esc(title) + '</p>' + (desc ? '<p class="row-d">' + esc(desc) + '</p>' : '') + '</div>' + (right || '') + '</div>'; };
    var catRows = c ? CAMPUS[c].cats.map(function (k) { var on = !ps.cats.length || ps.cats.indexOf(k) > -1, nm = catName(k) + tl(' 공지', '', '通知'); return row(nm, '', sw(on, 'pcat', k, nm)); }).join('') : '';
    // 마감 당일 알림은 서버가 항상 보내므로 고를 수 있는 건 7·3·1일 전 (목업과 같음)
    var leads = [7, 3, 1].map(function (d) { return chip(ps.lead.indexOf(d) > -1, S.dn(d), 'plead', d); }).join('');
    // 푸시를 쓸 수 없으면 맨 위 스위치만 흐리게 하고 이유를 적는다. 마감·정정 항목은 미리 골라 두면 켤 때 적용
    var why = !canPush ? S.noPush : !vapidKey ? S.noKey : '';
    var master = '<button class="sw' + (ps.on && !why ? ' on' : '') + (why ? ' dis' : '') + '" role="switch" aria-checked="' + (ps.on && !why) + '"' + (why ? ' aria-disabled="true"' : '') +
      ' aria-label="' + esc(S.pushOn) + '" data-a="ptoggle" data-v=""></button>';
    var pf = me();
    return bar(logo()) + '<div class="scroll"><h1 class="h1">' + esc(tl('알림 설정', 'Notification settings', '通知设置')) + '</h1>' +
      '<div class="prof"><strong>' + esc(profile.dept || CAMPUS[c].name[L()]) + '</strong>' + (profile.college ? '<p>' + esc(profile.college + ' · ' + CAMPUS[c].name[L()]) + '</p>' : '') +
      '<p>' + esc(I.STAT[L()][profile.status] + ' · ' + tl('평균 학점 ', 'GPA ', '平均绩点 ') + profile.gpa.toFixed(1)) + '</p>' +
      '<p>' + esc(semText(pf.done, profile.status)) + '</p><a class="lnk" href="#/setup">' + esc(S.prof) + '</a></div>' +
      '<p class="grp">' + esc(S.push) + '</p>' + row(S.pushOn, why || S.pushHelp, master) +
      // 새 공지 알림 영역은 푸시 알림을 켰을 때만 보인다 (끄면 숨기고, 고른 값은 그대로 기억)
      (ps.on && !why ? '<p class="grp">' + esc(S.cats) + '</p>' + catRows : '') +
      '<p class="grp">' + esc(S.lead) + '</p><div class="wrap">' + leads + '</div>' +
      '<p class="grp">' + esc(tl('정정 알림', 'Correction alerts', '更正提醒')) + '</p>' +
      row(S.chg, tl('마감 연장·장소 변경처럼 바뀐 부분만 요약해서 보내드려요.', 'Only what changed, such as an extended deadline.', '只发送变更内容的摘要，例如截止日期延长。'), sw(ps.change, 'pchg', '', S.chg)) +
      '<p class="grp">' + esc(S.camp) + '</p><div class="wrap">' + cps + '</div>' +
      '<p class="grp">' + esc(S.lang) + '</p><div class="wrap">' + langs + '</div>' +
      '<p style="margin-top:22px;text-align:center"><button class="lnk" data-a="wipe">' + esc(S.reset) + '</button></p></div>' + toastHtml() + tabbar('set');
  }

  /* ───────── 뷰: 저장한 공지 ───────── */
  function viewSaved() {
    var p = me(), td = new Date(today()).toISOString().slice(0, 10);
    var list = allNotices().filter(function (n) { return profile.saved.indexOf(n.id) > -1; });
    // 아직 신청할 수 있는 것을 마감 빠른 순으로, 마감 지난 것은 아래로
    list.sort(function (a, b) {
      var ca = a.end && a.end < td ? 1 : 0, cb = b.end && b.end < td ? 1 : 0;
      return (ca - cb) || ((a.end || '9999') < (b.end || '9999') ? -1 : (a.end || '9999') > (b.end || '9999') ? 1 : 0);
    });
    var open = list.filter(function (n) { return !(n.end && n.end < td); }).length;
    var body = list.length ? list.map(function (n) { return card(n, M.match(n.criteria, p)); }).join('') :
      '<div class="empty"><p class="empty-t">' + esc(tl('아직 저장한 공지가 없어요', 'No saved notices yet', '还没有收藏的通知')) + '</p><p>' +
      esc(tl('공지 상세에서 "공지 저장"을 누르면 여기에 모여요.', 'Tap "Save notice" on a notice to keep it here.', '在通知详情中点击“保存通知”即可收藏到这里。')) + '</p>' +
      '<a class="btn sec" href="#/">' + esc(tl('공지 보러 가기', 'Browse notices', '查看通知')) + '</a></div>';
    return bar(logo() + '<a class="me" href="#/set">' + esc(meLabel()) + '</a>') +
      '<div class="lhead line"><h1 class="h1">' + esc(tl('저장한 공지', 'Saved notices', '收藏的通知')) + ' <span class="cnt">' + list.length + (L() === 'ko' ? '건' : '') + '</span></h1>' +
      '<p class="sub">' + esc(list.length ? tl('신청할 수 있는 공지 ' + open + '건 · 마감이 빠른 순으로 보여드려요', open + ' still open · sorted by deadline', '可申请 ' + open + ' 条 · 按截止日期排序')
        : tl('저장한 공지를 한곳에 모아 보여드려요.', 'Notices you saved appear here.', '这里汇总您保存的通知。')) + '</p></div>' +
      '<div class="scroll list">' + body + '</div>' + tabbar('saved');
  }

  /* ───────── 뷰: 받은 알림 모아 보기 ─────────
   * 서버가 이 기기 구독으로 보낸 알림 기록 + 이 기기에 남겨 둔 기록(구독을 다시 만들어도 예전 알림이 남게) */
  var alerts = { items: [], loaded: false, noSub: false };
  function alertsCache() { try { return JSON.parse(localStorage.getItem('cadaepocket.alerts')) || []; } catch (e) { return []; } }
  function alertsSeen() { try { return localStorage.getItem('cadaepocket.alerts.seen') || ''; } catch (e) { return ''; } }
  function hasUnread() { var a = alerts.items[0]; return !!(a && a.at > alertsSeen()); }
  function bell() {
    var dot = hasUnread() ? '<span class="dot" aria-hidden="true"></span>' : '';
    return '<a class="bell" href="#/alerts" aria-label="' + esc(tl('받은 알림', 'Notifications', '收到的通知') + (dot ? tl(' · 새 알림 있음', ' · new', ' · 有新通知') : '')) + '">' +
      '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/></svg>' + dot + '</a>';
  }
  function fetchAlerts() {
    var cached = alertsCache();
    if (!alerts.loaded) alerts.items = cached;
    var done = function () {
      alerts.loaded = true; var r = route();
      // 알림 화면을 보고 있으면 지금까지 받은 것을 읽음으로 (이번 방문에는 prevSeen 기준으로 '새 알림' 표시를 그대로 둔다)
      if (r === '/alerts' && alerts.items[0]) { try { localStorage.setItem('cadaepocket.alerts.seen', alerts.items[0].at); } catch (e) {} }
      if (r === '/alerts' || r === '/') render();
    };
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { alerts.noSub = true; return done(); }
    return navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.pushManager.getSubscription() : null; }).then(function (sub) {
      if (!sub) { alerts.noSub = true; return; }
      alerts.noSub = false;
      return api('/api/push/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).then(function (j) {
        var seen = {}, all = j.items.concat(cached).filter(function (a) { var k = a.kind + ':' + a.at; if (seen[k]) return false; seen[k] = 1; return true; });
        all.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
        alerts.items = all.slice(0, 100);
        try { localStorage.setItem('cadaepocket.alerts', JSON.stringify(alerts.items)); } catch (e) {}
      });
    }).catch(function () {}).then(done);
  }
  function viewAlerts() {
    var KIND = { new: tl('새 공지', 'New', '新通知'), deadline: tl('마감 알림', 'Deadline', '截止提醒'), change: tl('정정', 'Updated', '更正'), test: tl('테스트', 'Test', '测试') };
    var list = alerts.items.map(function (a) {
      var href = (a.url || '/').replace(/^\//, '') || '#/';
      return '<a class="al" href="' + esc(href.charAt(0) === '#' ? href : '#/') + '"><div class="nc-top"><span class="tag">' + esc(KIND[a.kind] || a.kind) + '</span>' +
        (a.at > alerts.prevSeen ? '<span class="bd bd-new">' + esc(tl('새 알림', 'New', '新')) + '</span>' : '') +
        '<span class="dd">' + esc(fmtTime(a.at)) + '</span></div><p class="nc-title">' + esc(a.title) + '</p>' + (a.body ? '<p class="al-b">' + esc(a.body) + '</p>' : '') + '</a>';
    }).join('');
    var empty = '<div class="empty"><p class="empty-t">' + esc(!alerts.loaded ? '…' : alerts.noSub && !alerts.items.length ? tl('푸시 알림이 꺼져 있어요', 'Push notifications are off', '推送通知已关闭') : tl('아직 받은 알림이 없어요', 'No notifications yet', '还没有收到通知')) + '</p>' +
      (alerts.loaded && alerts.noSub && !alerts.items.length ? '<p>' + esc(tl('설정에서 푸시 알림을 켜면 받은 알림이 여기에 모여요.', 'Turn on push in Settings and your notifications will appear here.', '在设置中开启推送后，收到的通知会显示在这里。')) + '</p><a class="btn sec" href="#/set">' + esc(tl('알림 설정', 'Settings', '通知设置')) + '</a>' : '') + '</div>';
    return bar('<a class="back" href="#/"><svg class="ic" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>' + esc(tl('홈', 'Home', '首页')) + '</a>') +
      '<div class="lhead line"><h1 class="h1">' + esc(tl('받은 알림', 'Notifications', '收到的通知')) + ' <span class="cnt">' + alerts.items.length + (L() === 'ko' ? '건' : '') + '</span></h1>' +
      '<p class="sub">' + esc(tl('이 기기로 보낸 푸시 알림을 최신 순으로 모아 보여드려요.', 'Push notifications sent to this device, newest first.', '按时间倒序显示发送到本设备的推送通知。')) + '</p></div>' +
      '<div class="scroll list">' + (list || empty) + '</div>' + tabbar('feed');
  }

  /* ───────── 라우터·렌더 ───────── */
  var lastRoute = null;
  function route() { var h = location.hash.replace(/^#/, '') || '/'; return h; }
  function render() {
    // 같은 화면을 다시 그릴 때(칩 선택, 저장 등)는 스크롤 위치를 그대로 둔다. 다른 화면으로 가면 맨 위부터
    var r = route(), sc = $app.querySelector('.scroll'), y = sc ? sc.scrollTop : 0, same = r === lastRoute, html;
    var typing = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-in');
    if (typing && r === '/setup') return;                         // 입력 중에는 다시 그리지 않는다
    if (!profile.campus && r !== '/setup') { location.hash = '#/setup'; return; }
    document.documentElement.lang = L();
    var m = r.match(/^\/n\/(\d+)/);
    if (!m && r !== '/setup') ui.from = r;                          // 상세의 '목록' 버튼이 돌아갈 탭
    if (r === '/alerts' && lastRoute !== '/alerts') { alerts.prevSeen = alertsSeen(); fetchAlerts(); }
    html = r === '/setup' ? viewSetup() : m ? viewDetail(+m[1]) : r === '/dept' ? viewDept() : r === '/cal' ? viewCal() : r === '/saved' ? viewSaved() : r === '/set' ? viewSettings() : r === '/alerts' ? viewAlerts() : viewFeed();
    $app.innerHTML = html;
    var ns = $app.querySelector('.scroll'); if (ns && same) ns.scrollTop = y;
    lastRoute = r;
    bindScroll();
  }
  function bindScroll() {
    var sc = document.getElementById('sc'), b = document.getElementById('totop'); if (!sc || !b) return;
    var f = function () { b.style.display = sc.scrollTop > 400 ? 'flex' : 'none'; }; sc.addEventListener('scroll', f, { passive: true }); f();
  }

  /* ───────── 푸시 ───────── */
  function b64uToU8(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); var r = atob(s + '==='.slice((s.length + 3) % 4)), a = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; }
  function syncPush() {
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      if (!sub) return;
      return api('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' },
        // 서버가 대상 아닌 알림을 미리 거르도록 대략적인 조건만 함께 보낸다. 학과·평점은 보내지 않는다
        body: JSON.stringify({ subscription: sub.toJSON(), campus: profile.campus, lang: profile.lang, categories: profile.push.cats, leadDays: profile.push.lead, changeAlert: profile.push.change,
          profile: { status: profile.status, done: profile.done, exchange: !!profile.exchange },
          saved: profile.saved }) });                                     // 마감·정정 알림은 저장한 공지에만 온다
    });
  }
  /* 서비스 워커 준비 기다리기. 처음 연 폰은 아직 설치 중일 수 있어 등록부터 다시 확인하고, 15초가 지나면 실패로 본다
   * (예전에는 서비스 워커가 깨져 있으면 ready 가 끝나지 않아 '허용'을 눌러도 스위치가 그대로였다) */
  function swReady() {
    var reg = navigator.serviceWorker.register('/sw.js').then(function () { return navigator.serviceWorker.ready; });
    return Promise.race([reg, new Promise(function (_, no) { setTimeout(function () { no(new Error('sw timeout')); }, 15000); })]);
  }
  /* 예전 Safari 는 requestPermission 이 Promise 대신 콜백을 쓴다 */
  function askPermission() {
    return new Promise(function (ok) { var r = Notification.requestPermission(ok); if (r && r.then) r.then(ok); });
  }
  function enablePush() {
    return askPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('denied');
      return swReady();
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (s) { return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToU8(vapidKey) }); });
    }).then(function () {
      if (profile.push.cats[0] === 'none') profile.push.cats = [];    // 영역을 모두 꺼서 꺼졌던 경우: 다시 켜면 모든 영역을 켠다
      profile.push.on = true; save(); render();                       // 구독이 되면 바로 켠 상태로 보여 준다
      return syncPush().catch(function () {});                        // 서버 등록이 잠깐 실패해도 앱을 다시 열 때 ensurePush 가 다시 보낸다
    });
  }
  /* 앱을 열 때: 알림을 켜 둔 상태인데 브라우저 구독이 끊겼으면(만료·권한 재설정 등) 다시 구독하고, 서버에 최신 설정을 보낸다 */
  function ensurePush() {
    if (!profile.push.on || !vapidKey || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (s) {
        if (s) return s;
        return Notification.permission === 'granted' ? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToU8(vapidKey) }) : null;
      });
    }).then(function (s) {
      if (!s) { profile.push.on = false; save(); render(); return; }    // 권한이 없으면 스위치를 끈 상태로 보여 준다
      return syncPush();
    }).catch(function () {});
  }
  function disablePush() {
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (s) {
      if (!s) return; var ep = s.endpoint; return s.unsubscribe().then(function () { return api('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: ep }) }); });
    }).then(function () { profile.push.on = false; save(); });
  }

  /* ───────── 이벤트 ───────── */
  function toggle(arr, v) { var i = arr.indexOf(v); return i > -1 ? arr.filter(function (x) { return x !== v; }) : arr.concat([v]); }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-a]'); if (!el) return;
    var a = el.getAttribute('data-a'), v = el.getAttribute('data-v');
    if (a === 'campus') { profile.campus = v; profile.interests = []; var dc = DEP.find(profile.dept, v); profile.college = dc ? dc.full : ''; save(); render(); }
    else if (a === 'lang') { profile.lang = v; save(); render(); }
    else if (a === 'lang2') { profile.lang = v; save(); if (profile.push.on) syncPush().catch(function () {}); render(); }
    else if (a === 'status') { profile.status = v; if (!onLeave()) profile.returnTerm = ''; save(); render(); }
    else if (a === 'rterm') { profile.returnTerm = v; save(); render(); }
    else if (a === 'day') { ui.sel = v; render(); }
    else if (a === 'done') { profile.done = +v; save(); render(); }
    else if (a === 'exchange') { profile.exchange = !profile.exchange; save(); render(); }
    else if (a === 'int') { profile.interests = toggle(profile.interests, v); save(); render(); }
    else if (a === 'start') { commitInputs(); save(); location.hash = '#/'; fetchNotices(); if (profile.push.on) syncPush().catch(function () {}); }
    else if (a === 'retry') { ui.loadErr = false; ui.loaded = false; render(); fetchNotices(); }
    else if (a === 'grade') { ui.grade = v; render(); }
    else if (a === 'cat') { ui.cat = v; render(); }
    else if (a === 'top') { var sc = document.getElementById('sc'); if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (a === 'save') {
      var id = +v, adding = profile.saved.indexOf(id) < 0;
      profile.saved = toggle(profile.saved, id); save(); render();
      if (profile.push.on) syncPush().catch(function () {});
      var leadTxt = profile.push.lead.filter(function (d) { return d > 0; }).sort(function (a, b) { return b - a; }).join('·');
      var sn = allNotices().filter(function (x) { return x.id === id; })[0];
      if (adding && sn && !sn.end) toast(tl('저장했어요. 저장 탭에서 다시 볼 수 있어요.', 'Saved. Find it in the Saved tab.', '已保存，可在收藏中查看。'));
      else if (adding) toast(profile.push.on ? (leadTxt ? tl('저장했어요. 마감 ' + leadTxt + '일 전에 알려드릴게요.', 'Saved. We will remind you before the deadline.', '已保存，截止前会提醒您。')
          : tl('저장했어요. 설정에서 마감 알림 시점을 고르면 알려드려요.', 'Saved. Pick reminder days in Settings.', '已保存。在设置中选择提醒时间。'))
        : tl('저장했어요. 설정에서 푸시를 켜면 마감 전에 알려드려요.', 'Saved. Turn on push in Settings to get deadline reminders.', '已保存。在设置中开启推送即可收到截止提醒。'));
    }
    else if (a === 'report') {
      api('/api/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ noticeId: +v, note: '' }) })
        .then(function () { toast(t('reported')); }).catch(function () { toast('Error'); });
    }
    else if (a === 'mon') { var mm = ui.month.m + (+v), yy = ui.month.y; if (mm < 0) { mm = 11; yy--; } if (mm > 11) { mm = 0; yy++; } ui.month = { y: yy, m: mm }; ui.sel = null; render(); }
    else if (a === 'switchCampus') { profile.campus = v; profile.interests = []; profile.push.cats = []; ui.cat = 'all'; save(); notices = []; fetchNotices(); if (profile.push.on) syncPush().catch(function () {}); }
    else if (a === 'pcat') {
      // [] = 모든 영역(기본값), ['none'] = 모두 끔. 마지막 하나를 끄면 [] 가 되어 전부 다시 켜지던 문제를 막는다
      var all = CAMPUS[profile.campus].cats, cur = (profile.push.cats.length ? profile.push.cats : all).filter(function (k) { return k !== 'none'; });
      cur = toggle(cur, v);
      profile.push.cats = cur.length === all.length ? [] : cur.length ? cur : ['none'];
      save();
      // 영역을 모두 끄면 푸시 알림 받기도 끈다 (다시 켜면 모든 영역이 켜진 상태로 돌아온다)
      if (!cur.length && profile.push.on) {
        disablePush().then(function () { toast(tl('알림 받을 영역을 모두 꺼서 푸시 알림도 껐어요.', 'All categories are off, so push notifications are turned off.', '已关闭所有类别，推送通知也已关闭。')); })
          .catch(function () { profile.push.on = false; save(); render(); });
      } else { syncPush().catch(function () {}); render(); }
    }
    else if (a === 'plead') { profile.push.lead = toggle(profile.push.lead, +v).sort(function (x, y) { return y - x; }); save(); syncPush().catch(function () {}); render(); }
    else if (a === 'pchg') { profile.push.change = !profile.push.change; save(); syncPush().catch(function () {}); render(); }
    else if (a === 'ptoggle' && el.classList.contains('dis')) {
      toast(!('serviceWorker' in navigator && 'PushManager' in window) ? tl('이 브라우저는 푸시를 지원하지 않아요. iPhone은 홈 화면에 추가한 뒤 사용하세요.', 'This browser does not support push.', '此浏览器不支持推送。')
        : tl('아직 서버에 푸시 키가 없어서 알림을 켤 수 없어요. 다른 설정은 미리 골라 둘 수 있어요.', 'Push is not configured on the server yet.', '服务器尚未配置推送。'));
    }
    else if (a === 'ptoggle') {
      (profile.push.on ? disablePush() : enablePush()).then(render).catch(function (e) {
        var denied = e && e.message === 'denied';
        toast(denied ? tl('알림이 허용되지 않았어요. 브라우저(또는 휴대폰) 설정에서 이 사이트의 알림을 허용해 주세요.', 'Notifications are blocked. Allow them for this site in your browser settings.', '通知未被允许。请在浏览器设置中允许本网站的通知。')
          : tl('알림을 켜지 못했어요. 앱을 닫았다 다시 열고 한 번 더 시도해 주세요.', 'Could not turn on notifications. Reopen the app and try again.', '无法开启通知。请重新打开应用后再试。'));
        render();
      });
    }
    else if (a === 'wipe') {
      var wipeAll = function () { try { localStorage.clear(); } catch (x) {} idbSet('profile', null); profile = JSON.parse(JSON.stringify(DEF)); notices = []; location.hash = '#/setup'; render(); };
      // 푸시 구독부터 끈다: 기기 정보만 지우면 서버는 계속 알림을 보내는데, 설정이 사라져 끌 방법이 없다
      // (서비스 워커가 없거나 응답이 없으면 5초 뒤 그냥 지운다)
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) wipeAll();
      else Promise.race([disablePush(), new Promise(function (ok) { setTimeout(ok, 5000); })]).catch(function () {}).then(wipeAll);
    }
  });
  /* 학과 자동완성: 입력할 때 목록만 다시 채우고, 고르면 학과·단과대학을 함께 저장 */
  document.addEventListener('input', function (e) {
    if (!e.target.getAttribute || e.target.getAttribute('data-in') !== 'dept') return;
    ui.ac = -1; acList(e.target);
  });
  document.addEventListener('keydown', function (e) {
    if (!e.target.getAttribute || e.target.getAttribute('data-in') !== 'dept') return;
    var items = acItems(e.target.value.trim()), ul = document.getElementById('acl'), open = ul && !ul.hidden;
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); ui.ac = Math.min(items.length - 1, ui.ac + 1); acList(e.target); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); ui.ac = Math.max(0, ui.ac - 1); acList(e.target); }
    else if (e.key === 'Enter' && open && items.length) { e.preventDefault(); pickDept(items[Math.max(0, ui.ac)].name); }
    else if (e.key === 'Escape' && open) { ul.hidden = true; e.target.setAttribute('aria-expanded', 'false'); }
  });
  // mousedown 에서 고른다: click 까지 기다리면 입력칸이 먼저 포커스를 잃고(change) 화면이 다시 그려져 목록이 사라진다
  document.addEventListener('mousedown', function (e) {
    var li = e.target.closest && e.target.closest('[data-pick]'); if (!li) return;
    e.preventDefault(); pickDept(li.getAttribute('data-pick'));
  });
  /* 입력칸 값을 프로필에 반영하고, 화면은 바뀐 부분(입력칸·안내 문구)만 고친다 */
  function commitInput(el) {
    var k = el.getAttribute('data-in'), o = OS[L()];
    if (k === 'dept') {
      var d = DEP.find(el.value, profile.campus), name = d ? d.name : el.value.trim();
      if (name !== profile.dept || (d ? d.full : '') !== profile.college) {
        profile.dept = name; profile.college = d ? d.full : ''; fetchDept();
      }
      var di = document.getElementById('deptinfo'); if (di) di.outerHTML = deptInfoHtml(o);
      var ul = document.getElementById('acl'); if (ul) { ul.hidden = true; ul.innerHTML = ''; }
      el.setAttribute('aria-expanded', 'false'); el.removeAttribute('aria-activedescendant'); ui.ac = -1;
    }
    if (k === 'gpa') {
      var raw = el.value.trim(), g = parseFloat(raw), msg = '';
      if (!raw || !isFinite(g)) msg = o.gpaBad;
      else { var cg = Math.round(Math.max(0, Math.min(4.5, g)) * 100) / 100; if (cg !== g) msg = o.gpaFix; profile.gpa = cg; }
      el.value = profile.gpa.toFixed(1);
      var gi = document.getElementById('gpainfo'); if (gi) { gi.textContent = msg; gi.hidden = !msg; }
    }
    save();
  }
  /* '시작하기' 를 누를 때 아직 반영되지 않은 입력값도 함께 반영한다 (iOS 는 버튼을 눌러도 입력칸의 change 가 먼저 오지 않을 수 있다) */
  function commitInputs() { Array.prototype.forEach.call(document.querySelectorAll('[data-in]'), commitInput); }
  // 초기 설정 화면은 입력칸에서 포커스가 빠져도 전체를 다시 그리지 않는다:
  // 다시 그리면 입력 후 바로 누른 버튼(시작하기 등)이 새로 만들어져 첫 탭이 무시됐다
  document.addEventListener('change', function (e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-in'); if (!k) return;
    commitInput(e.target);
    if (route() !== '/setup') render();
  });
  window.addEventListener('hashchange', render);

  /* ───────── 시작 ───────── */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
  api('/api/config').then(function (c) { vapidKey = c.vapidPublicKey; if (route() === '/set') render(); ensurePush(); }).catch(function () {});
  // 받은 알림: 앱을 열 때 한 번, 앱이 열려 있는 동안 푸시가 오면 서비스 워커가 알려 줘서 다시 불러온다
  alerts.items = alertsCache(); fetchAlerts();
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'push') setTimeout(fetchAlerts, 1500); });
  save(); render(); fetchNotices();
  setInterval(function () { if (document.visibilityState === 'visible') fetchNotices(); }, 5 * 60000);
})();
