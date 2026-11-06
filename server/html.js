'use strict';
/* 외부 패키지 없이 쓰는 아주 작은 HTML 도우미. 학교 게시판처럼 구조가 일정한 페이지만 다룬다. */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') {
      const n = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[g.toLowerCase()] !== undefined ? ENT[g.toLowerCase()] : m;
  });
}

function stripTags(html) {
  return decode(String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const oneLine = s => stripTags(s).replace(/\s+/g, ' ').trim();

/* 속성 값 읽기 */
function attr(tagHtml, name) {
  const m = tagHtml.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'));
  return m ? decode(m[1] !== undefined ? m[1] : m[2]) : null;
}

/* startIdx 에서 시작하는 <tag ...> 요소의 안쪽 HTML (같은 태그 중첩 처리) */
function innerFrom(html, startIdx, tag) {
  const open = new RegExp('<' + tag + '\\b[^>]*>', 'iy');
  open.lastIndex = startIdx;
  const first = open.exec(html);
  if (!first) return null;
  const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
  re.lastIndex = startIdx + first[0].length;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { open: first[0], inner: html.slice(startIdx + first[0].length, m.index), end: re.lastIndex };
  }
  return null;
}

/* class 에 cls 가 들어간 첫 번째 tag 요소 */
function byClass(html, cls, tag) {
  tag = tag || '[a-z][a-z0-9]*';
  const re = new RegExp('<(' + tag + ')\\b[^>]*\\sclass\\s*=\\s*"[^"]*\\b' + cls + '\\b[^"]*"[^>]*>', 'i');
  const m = re.exec(html);
  if (!m) return null;
  return innerFrom(html, m.index, m[1]);
}

/* 정규식에 맞는 모든 요소(예: tr) */
function all(html, tag) {
  const out = [];
  const re = new RegExp('<' + tag + '\\b[^>]*>', 'gi');
  let m;
  while ((m = re.exec(html))) {
    const el = innerFrom(html, m.index, tag);
    if (!el) break;
    out.push(el);
    re.lastIndex = el.end;
  }
  return out;
}

module.exports = { decode, stripTags, oneLine, attr, innerFrom, byClass, all };
