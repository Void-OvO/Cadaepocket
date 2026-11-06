'use strict';
/* 캠퍼스별 수집원. 주소·분류 번호는 2026-11 기준 학교 사이트에서 확인한 값.
 * 성심·성의는 같은 게시판 엔진이지만 도메인, 분류 번호, 표 칼럼 순서가 달라서 따로 둔다. */

const CAMPUSES = {
  sim: { id: 'sim', name: '성심교정', host: 'catholic.ac.kr' },
  ui: { id: 'ui', name: '성의교정', host: 'songeui.catholic.ac.kr' }
};

/* 게시판이 보여주는 분류 이름 → 앱 분류 */
const CATEGORY_MAP = { '일반': 'gen', '학사': 'aca', '장학': 'sch', '취창업': 'job', '행사': 'evt' };

const SOURCES = [
  {
    key: 'sim-notice', campus: 'sim', board: '공지사항', active: true,
    base: 'https://www.catholic.ac.kr/ko/campuslife/notice.do',
    categories: { 20: '일반', 21: '학사', 22: '장학', 23: '취창업' }
  },
  {
    key: 'sim-event', campus: 'sim', board: '행사안내', active: false,
    base: 'https://www.catholic.ac.kr/ko/campuslife/notice_event.do', categories: null, defaultCat: 'gen'
  },
  {
    key: 'sim-outside', campus: 'sim', board: '외부기관공지', active: false,
    base: 'https://www.catholic.ac.kr/ko/campuslife/notice_outside.do', categories: null, defaultCat: 'gen'
  },
  {
    key: 'ui-notice', campus: 'ui', board: '공지사항', active: true,
    base: 'https://songeui.catholic.ac.kr/ko/news/notice.do',
    categories: { 11: '일반', 12: '학사', 13: '장학', 14: '행사' }
  },
  {
    key: 'ui-medicine', campus: 'ui', board: '의과대학 공지', active: true,
    base: 'https://songeui.catholic.ac.kr/medicine/community/notice.do', categories: null, defaultCat: 'gen'
  },
  {
    key: 'ui-nursing', campus: 'ui', board: '간호대학 공지', active: true,
    base: 'https://songeui.catholic.ac.kr/nursing/community/notice.do', categories: null, defaultCat: 'gen'
  }
];

/* 캠퍼스별로 앱에 보여줄 분류 탭 */
const CAMPUS_CATS = { sim: ['aca', 'sch', 'job', 'gen'], ui: ['aca', 'sch', 'evt', 'gen'] };

module.exports = { CAMPUSES, CATEGORY_MAP, SOURCES, CAMPUS_CATS };
