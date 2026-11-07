/* 프로필 ↔ 공지 자격요건 매칭 (서버·브라우저·서비스워커 공용, 외부 의존성 없음)
 *
 * profile : { campus, status, dept, done, gpa, exchange, interests[] }
 * criteria: 서버가 AI/규칙으로 추출한 공지 자격요건
 *   { statuses[]|null, grades[]|null, minGpa|null, minDone|null, maxDone|null,
 *     audience: 'exchange'|null, excludeExchange: bool, depts[]|null,
 *     uncertain: [{ ko, en?, zh?, ifDoneAtLeast? }], boost[]|null }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CatoMatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var DAY = 86400000;

  function gradeOf(done) { return Math.min(4, Math.floor(done / 2) + 1); }
  function termOf(done) { return done % 2 === 0 ? 1 : 2; }

  function activeUncertain(c, p) {
    return (c.uncertain || []).filter(function (u) {
      return u.ifDoneAtLeast == null || p.done >= u.ifDoneAtLeast;
    });
  }

  /* '졸업 예정'은 학적 상태로 쓰지 않는다(4학년이 곧 졸업 예정). 예전 분석·시드에 남은 값은 이렇게 바꿔 읽는다:
   *  ['졸업 예정'] 만 → 재학 4학년 / ['재학','졸업 예정'] → 재학 */
  function norm(c) {
    c = c || {};
    var st = c.statuses;
    if (!st || st.indexOf('졸업 예정') < 0) return c;
    var rest = st.filter(function (s) { return s !== '졸업 예정'; });
    var out = Object.assign({}, c, { statuses: rest.length ? rest : ['재학'] });
    if (!rest.length && !(c.grades && c.grades.length)) out.grades = [4];
    return out;
  }

  /* 'match' | 'maybe' | 'no' */
  function match(c, p) {
    c = norm(c);
    var grade = gradeOf(p.done);
    if (c.audience === 'exchange' && !p.exchange) return 'no';
    if (c.excludeExchange && p.exchange) return 'no';
    if (c.statuses && c.statuses.length && c.statuses.indexOf(p.status) < 0) return 'no';
    // 학과를 입력하지 않았으면 학과 조건은 '대상 아님'이 아니라 '확인 필요'로 본다 (예전에는 홈에서 조용히 빠졌다)
    var deptUnknown = !!(c.depts && c.depts.length && !p.dept);
    if (c.depts && c.depts.length && p.dept && c.depts.indexOf(p.dept) < 0) return 'no';
    if (c.grades && c.grades.length && c.grades.indexOf(grade) < 0) return 'no';
    if (c.minDone != null && p.done < c.minDone) return 'no';
    if (c.maxDone != null && p.done > c.maxDone) return 'no';
    if (c.minGpa != null && p.gpa < c.minGpa) return 'no';
    if (deptUnknown || activeUncertain(c, p).length) return 'maybe';
    return 'match';
  }

  /* 오늘 기준 남은 일수. end 는 'YYYY-MM-DD' (한국 날짜). 없으면 null */
  function daysLeft(end, today) {
    if (!end) return null;
    var e = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10));
    return Math.round((e - today) / DAY);
  }

  /* end 는 공지의 신청 마감일(criteria 가 아니라 공지 자체에 있다) */
  function score(c, p, cat, today, end) {
    var d = daysLeft(end, today);
    var s = d === null ? 0 : Math.max(0, 21 - d);
    if (d !== null && d < 0) s = -50;                       // 마감 지난 공지는 맨 아래
    if ((p.interests || []).indexOf(cat) > -1) s += 8;
    if (c.boost && c.boost.indexOf(p.status) > -1) s += 12;
    if (c.intl && !p.exchange) s -= 30;                     // 주로 외국인·교환학생용 공지는 내국인에게 아래로 (마감 임박 21 + 관심 8 보다 크게)
    return s;
  }

  var TIER = { match: 0, maybe: 1, no: 2 };

  /* items: [{ id, cat, end, criteria }] → 정렬된 [{ item, m, s }] */
  function feed(items, p, opt) {
    opt = opt || {};
    var grade = opt.grade || 'my', cat = opt.cat || 'all', today = opt.today;
    var out = [];
    items.forEach(function (it) {
      var c = it.criteria || {};
      var m = match(c, p);
      // '마감' 탭(cat='closed')은 마감 지난 공지만 모아 보여 주고, 다른 탭(전체 포함)에서는 마감 지난 공지를 뺀다
      var left = daysLeft(it.end, today), isClosed = left !== null && left < 0;
      if (cat === 'closed' ? !isClosed : isClosed) return;
      if (cat !== 'all' && cat !== 'closed' && it.cat !== cat) return;
      if (grade === 'my') { if (m === 'no') return; }
      else if (grade !== 'all') {
        var g = Number(grade);
        c = norm(c);
        if (c.grades && c.grades.length && c.grades.indexOf(g) < 0) return;
      }
      var d = daysLeft(it.end, today);
      out.push({ item: it, m: m, s: score(c, p, it.cat, today, it.end), closed: d !== null && d < 0 });
    });
    // 마감 탭: 최근에 마감된 것부터. 다른 탭: 해당 > 확인 필요 > 비해당, 같은 등급은 점수순
    if (cat === 'closed') out.sort(function (a, b) { return a.item.end < b.item.end ? 1 : a.item.end > b.item.end ? -1 : 0; });
    else out.sort(function (a, b) { return ((a.closed ? 1 : 0) - (b.closed ? 1 : 0)) || (TIER[a.m] - TIER[b.m]) || (b.s - a.s); });
    return out;
  }

  /* 비교 행: labels = { rStatus, rGrade, rDone, rDept, rGpa, rAud, ... , statusName(fn) } */
  function rows(c, p, L) {
    c = norm(c);
    var out = [];
    var grade = gradeOf(p.done);
    function mk(st, label, need, mine) { return { st: st, label: label, need: need, mine: mine }; }
    if (c.statuses && c.statuses.length) {
      out.push(mk(c.statuses.indexOf(p.status) > -1 ? 'ok' : 'no', L.rStatus,
        c.statuses.length >= 3 ? L.allStatus : c.statuses.map(L.statusName).join(' · '), L.statusName(p.status)));
    }
    if (c.depts && c.depts.length) out.push(mk(!p.dept ? 'unk' : c.depts.indexOf(p.dept) > -1 ? 'ok' : 'no', L.rDept, c.depts.join(' · '), p.dept || L.noDept || L.cantTell));
    if (c.grades && c.grades.length) {
      out.push(mk(c.grades.indexOf(grade) > -1 ? 'ok' : 'no', L.rGrade, L.gradeNeed(c.grades), L.gradeMine(p, grade)));
    }
    if (c.minDone != null || c.maxDone != null) {
      var ok = (c.minDone == null || p.done >= c.minDone) && (c.maxDone == null || p.done <= c.maxDone);
      out.push(mk(ok ? 'ok' : 'no', L.rDone, L.doneNeed(c.minDone, c.maxDone), L.semUnit(p.done)));
    }
    if (c.minGpa != null) out.push(mk(p.gpa >= c.minGpa ? 'ok' : 'no', L.rGpa, c.minGpa.toFixed(1) + ' ' + L.gpaNeed, L.gpaMine(p.gpa)));
    if (c.audience === 'exchange') out.push(mk(p.exchange ? 'ok' : 'no', L.rAud, L.audX, p.exchange ? L.audXme : L.audNo));
    activeUncertain(c, p).forEach(function (u) { out.push(mk('unk', u[L.lang] || u.ko, L.seeSrc, L.cantTell)); });
    return out;
  }

  function verdict(rs, L) {
    if (rs.some(function (r) { return r.st === 'no'; })) return L.cmpNo;
    if (rs.some(function (r) { return r.st === 'unk'; })) return L.cmpUnk;
    return L.cmpAll;
  }

  return { gradeOf: gradeOf, termOf: termOf, match: match, daysLeft: daysLeft, score: score, feed: feed,
           rows: rows, verdict: verdict, norm: norm, activeUncertain: activeUncertain, DAY: DAY };
});
