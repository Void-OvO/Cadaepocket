/* 가톨릭대학교 학부 학과 목록 (서버·브라우저 공용, 외부 의존성 없음)
 *
 * 단과대학·계열: 학교 공식 '교육 > 대학' 페이지(www.catholic.ac.kr/ko/academics/edu_undergraduate{N}.do)의
 *   탭 이름(college)과 그 안의 소분류(group, 예: 인문사회계열 > 국제·법정경계열)를 그대로 옮김 (2026-11-06 확인).
 *   메뉴에 없는 옛 페이지(#2, #4)는 쓰지 않았다.
 * 학과 사이트 주소: 같은 페이지들의 학과 바로가기 링크.
 *  - board: 학과 공지 게시판. 기본은 https://{slug}.catholic.ac.kr/{slug}/community/notice.do 이고,
 *           규칙이 다른 학과는 세 번째 값에 주소를 적었다. 2026-11-06 에 모든 게시판을 열어 목록이 읽히는 것을 확인함
 *  - 성의교정 학과는 이미 수집 중인 의과대학·간호대학 게시판(ui-medicine, ui-nursing)을 쓴다.
 *  - board 가 null 이면 게시판 주소를 모르는 학과 (학과 공지를 보여 줄 수 없음)
 * 성신교정(신학대학)은 앱이 지원하는 캠퍼스가 아니라서 넣지 않았다. 폐과(종교학과)도 뺐다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CatoDepts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /* [단과대학(공식 탭), [[소분류(없으면 null), [[학과, slug, 게시판 주소(규칙과 다를 때)], ...]], ...]] */
  var SIM = [
    ['경영대학', [[null, [['경영학과', 'business'], ['회계학과', 'accounting']]],
      ['글로벌경영학부', [['국제경영학과', 'gbs'], ['세무회계금융학과', 'gbs'], ['IT파이낸스학과', 'gbs']]]]],
    ['바이오헬스융합대학', [[null, [['생명공학과', 'biotech'], ['바이오메디컬화학공학과', 'bmce'], ['바이오로직스공학부', 'ble', 'https://ble.catholic.ac.kr/BLE/community/notice.do'],
      ['AI의공학과', 'aibme'], ['의생명과학과', 'mbs'], ['바이오메디컬소프트웨어학과', 'bmsw']]]]],
    ['AI전자정보융합대학', [[null, [['컴퓨터정보공학부', 'csie'], ['미디어기술콘텐츠학과', 'mtc'], ['정보통신전자공학부', 'ice'], ['인공지능학과', 'ai'], ['데이터사이언스학과', 'datascience']]]]],
    ['약학대학', [[null, [['약학과', 'pharmacy']]]]],
    ['인문사회계열', [
      ['인문계열', [['국어국문학과', 'korean'], ['철학과', 'philosophy'], ['국사학과', 'koreanhistory']]],
      ['어문계열', [['영어영문학부', 'english'], ['중국언어문화학과', 'cn'], ['일어일본문화학과', 'japanese', 'https://japanese.catholic.ac.kr/japanese/major/notice.do'], ['프랑스어문화학과', 'french']]],
      ['사회과학계열', [['사회복지학과', 'socialwelfare'], ['심리학과', 'psychology'], ['사회학과', 'sociology'], ['아동학과', 'children']]],
      ['특수교육', [['특수교육과', 'sped']]],
      ['국제·법정경계열', [['국제학부', 'is'], ['법학과', 'law'], ['경제학과', 'economics'], ['행정학과', 'pa']]],
      ['글로벌경영학', [['글로벌경영학과', 'globalbiz']]],
      ['한국어문화학', [['한국어문화학과', 'klc']]]]],
    ['자연공학계열', [
      ['자연과학계열', [['화학과', 'chemistry'], ['수학과', 'math'], ['물리학과', 'physics']]],
      ['공학계열', [['에너지환경공학과', 'envi']]],
      ['생활과학계열', [['공간디자인·소비자학과', 'design'], ['의류학과', 'clothing'], ['식품영양학과', 'fn']]]]],
    ['예체능계열', [['음악', [['음악과', 'music'], ['성악과', 'voice']]], ['응용예술', [['예술미디어융합학과', 'gamc']]]]],
    ['자유전공학부', [[null, [['자유전공학부', 'liberal']]]]],
    ['융합전공학부', [[null, [['융합전공학부', 'major-convergence', 'https://major-convergence.catholic.ac.kr/major_convergence/notice/notice.do']]]]]
  ];
  var UI = [
    ['의과대학', [[null, [['의예과', 'ui-medicine'], ['의학과', 'ui-medicine']]]]],
    ['간호대학', [[null, [['간호학과', 'ui-nursing']]]]]
  ];

  /* full: 화면에 보여 주고 프로필에 저장하는 소속 = 단과대학 이름 (group 소분류는 참고용으로만 남겨 둠) */
  var LIST = [];
  function add(campus, college, group, d, url, host, slug, board) {
    LIST.push({ name: d, college: college, group: group, full: college,
      campus: campus, slug: slug, board: board, url: url, host: host });
  }
  SIM.forEach(function (c) {
    c[1].forEach(function (g) {
      g[1].forEach(function (d) {
        var slug = d[1], url = slug ? (d[2] || 'https://' + slug + '.catholic.ac.kr/' + slug + '/community/notice.do') : null;
        add('sim', c[0], g[0], d[0], url, url ? new URL(url).hostname : null, slug, slug ? 'dept-' + slug : null);
      });
    });
  });
  UI.forEach(function (c) {
    c[1].forEach(function (g) {
      g[1].forEach(function (d) {
        var path = d[1] === 'ui-medicine' ? 'medicine' : 'nursing';
        add('ui', c[0], g[0], d[0], 'https://songeui.catholic.ac.kr/' + path + '/community/notice.do', 'songeui.catholic.ac.kr', null, d[1]);
      });
    });
  });

  /* 학과 수집원(성심 학과 게시판). 같은 게시판을 쓰는 학과(글로벌경영학부 3개 학과)는 한 번만 */
  var BOARDS = [], seen = {};
  LIST.forEach(function (d) {
    if (d.campus !== 'sim' || !d.slug || seen[d.board]) return;
    seen[d.board] = true;
    BOARDS.push({ key: d.board, campus: 'sim', board: d.name + ' 공지', base: d.url, scope: 'dept' });
  });

  function find(name, campus) {
    name = String(name || '').trim();
    for (var i = 0; i < LIST.length; i++) if (LIST[i].name === name && (!campus || LIST[i].campus === campus)) return LIST[i];
    return null;
  }
  /* 자동완성: 띄어쓰기 무시, 학과 이름 앞부분 일치를 먼저, 그다음 포함·단과대학 이름 일치 */
  function search(q, campus, max) {
    var k = String(q || '').replace(/\s+/g, '');
    var pool = LIST.filter(function (d) { return !campus || d.campus === campus; });
    if (!k) return pool.slice(0, max || 50);
    var a = [], b = [];
    pool.forEach(function (d) {
      var n = d.name.replace(/\s+/g, '');
      if (n.indexOf(k) === 0) a.push(d);
      else if (n.indexOf(k) > -1 || d.full.replace(/\s+/g, '').indexOf(k) > -1) b.push(d);
    });
    return a.concat(b).slice(0, max || 8);
  }
  return { LIST: LIST, BOARDS: BOARDS, find: find, search: search };
});
