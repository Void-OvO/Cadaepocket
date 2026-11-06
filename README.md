# 가톨리미 (Catolimi) — 서버 + PWA

가톨릭대학교 성심·성의 공지를 각 학교 게시판에서 가져와, **내 학적·학년·학점에 해당되는 공지만** 골라 보여주고
마감·정정을 푸시로 알려주는 서비스. 외부 npm 패키지 없이 Node 22.13+ 만으로 동작합니다.

## 빠른 시작
```bash
cp .env.example .env        # 필요하면 값 채우기
npm run seed                # (선택) 시연용 실제 공지 14건 넣기. 서버가 빈 DB면 자동으로 넣어요
npm run crawl               # 학교 게시판 수집 (학교 사이트에 접속 가능한 네트워크에서 실행)
npm start                   # http://localhost:3000  — 브라우저에서 열어 '홈 화면에 추가' 하면 앱처럼 설치됩니다
npm run reanalyze           # 저장된 공지를 다시 분석 (규칙 기반으로 분석된 것만, --all 이면 전부, -- --images 면 이미지 글자를 아직 안 읽은 공지만)
npm run translate           # 번역이 없는 공지만 영어·중국어로 번역 (DEEPL_API_KEY 필요)
npm test                    # 28개 테스트
```
푸시를 쓰려면 `npm run vapid` 로 키를 만들어 `.env` 에 넣으세요(HTTPS 필요, localhost 는 예외).

**서버 배포**: 한국 리전 우분투 VPS 에 `.\deploy\deploy.ps1 -Server <IP> -Key <키.pem>` 한 줄로 설치·업데이트합니다 (Node 22 + systemd + Caddy 자동 HTTPS, 무료 `sslip.io` 주소). 자세한 순서는 [deploy/배포안내.md](deploy/배포안내.md).

**AI 분석(Claude)**: `.env` 의 `ANTHROPIC_API_KEY` 에 키를 넣으면 새로 수집되는 공지를 Claude 가 본문과 이미지(포스터)까지 읽고 분석합니다. 이미 저장된 공지는 `npm run reanalyze` 로 한 번 다시 분석하세요. 모델은 `ANTHROPIC_MODEL`(기본 `claude-sonnet-5-5`)로 바꿀 수 있고, Claude 가 실패·거절하면 그 공지는 규칙 기반으로 대신 분석합니다.

**이미지 공지 글자 읽기(OCR)**: Claude 키가 없거나 Claude 가 실패하면, 본문이 이미지뿐이거나 본문에 마감일이 없는 공지의 이미지(최대 4장)를 서버의 Tesseract 로 읽어 대상·기간을 찾습니다. 서버에는 `deploy/setup.sh` 가 `tesseract-ocr`, `tesseract-ocr-kor` 를 설치합니다(로컬 PC 에 없으면 OCR 없이 동작). 읽은 글자와 신뢰도는 `notice_attachment.extracted_text`·`ocr_confidence` 에 남습니다. `OCR=0` 이면 끕니다.

## 구성
| 경로 | 역할 |
|---|---|
| `server/sources.js` | 캠퍼스별 수집원(주소·분류 번호). 성심/성의는 도메인·분류·표 칼럼 순서가 달라 따로 둠 |
| `server/scraper.js` | 목록·상세 파싱, 고정글/중복(통합·단과대 게시판) 병합, 내용 해시로 **정정 감지 → 새 버전 + 변경 이력** |
| `server/analyze.js` | 공지 → 자격요건 JSON. Claude(본문+이미지) 또는 규칙 기반 + 이미지 OCR 대체. 모르는 값은 "확인 필요"로 남김 |
| `server/ocr.js` | 이미지 공지 글자 읽기: 서버의 Tesseract(한국어)를 실행해 포스터 글자를 뽑음 (설치돼 있지 않으면 건너뜀) |
| `server/push.js` | Web Push(VAPID + RFC 8291 암호화), 외부 라이브러리 없음 (RFC 부록 A 벡터로 검증) |
| `server/notify.js` | 새 글·정정·마감 임박 푸시, 중복 발송 방지, 만료 구독 정리 |
| `server/index.js` | REST API + 정적 서빙 + 주기 수집 스케줄러 |
| `web/depts.js` | 학과 → 단과대학 목록과 학과 게시판 주소(서버·앱 공용). 초기 설정 자동완성과 학과 수집원에 씀 |
| `web/` | PWA (홈·학과·상세·캘린더·저장·설정, 3개 언어, 오프라인 캐시, 서비스 워커) |

**마지막 업데이트**: 목록 위에는 그 게시판을 마지막으로 수집한 시각, 공지 상세에는 앱이 그 공지를 원문에서 마지막으로 확인한 시각(`checked_at`)을 보여 줍니다.

API: `GET /api/notices?campus=sim|ui&cat=&board=` (board: 학과 게시판 키, 예 `dept-psychology`) · `GET /api/notices/:id` · `GET /api/changes` · `POST /api/push/subscribe|unsubscribe` · `POST /api/reports` · `POST /api/admin/crawl`(Bearer `ADMIN_TOKEN`) · `GET /api/health`

## 개인정보 설계
학과·평점은 **기기(localStorage/IndexedDB)에만** 저장하고 서버에 저장하지 않습니다. 학과 탭을 열 때만 그 학과 게시판 키(예: `dept-psychology`)가 목록 요청 주소에 담깁니다(서버는 기록하지 않음). 서버는 푸시 구독(endpoint·키), 캠퍼스, 언어, 알림 분류·시점과,
푸시를 켠 경우 **학적 상태·이수 학기·교환/외국인 여부와 저장한 공지 번호**만 압니다. 서버는 앞의 세 가지로 대상 아닌 공지를 미리 걸러 보내고(학과·평점 조건은 거르지 않음), 서비스 워커는 받은 알림을 항상 띄웁니다.

푸시 규칙: **새 공지**는 내 조건에 맞고 알림을 켠 뒤에 새로 올라온 공지만(켜기 전에 있던 공지는 보내지 않음), **마감 7·3·1일 전**과 **정정** 알림은 저장한 공지에만 보냅니다.
(브라우저는 알림을 띄우지 않는 푸시가 반복되면 구독을 끊을 수 있어서, 기기에서 조용히 버리는 방식은 쓰지 않습니다.)

## 꼭 알아둘 점
- 이 개발 환경에서는 학교 사이트에 접속할 수 없어 **크롤러를 실제 사이트로 실행해 보지 못했습니다.** 파서는 사이트 구조를 직접 확인한 결과(`b-cate-notice`, `a.b-title[data-article-no]`, `.b-content-box`, `.b-file-box` 등)를 바탕으로 만든 가짜 페이지로 테스트했습니다. 첫 `npm run crawl` 결과가 비면 `server/scraper.js` 의 `parseList` 선택자를 먼저 확인하세요. 게시판 한 곳이 실패해도 다른 곳은 계속 수집하고, `GET /api/health` 에 마지막 오류가 남습니다.
- 공지의 영어·중국어 번역(제목·요약·대상·혜택·서류·신청 방법): `ANTHROPIC_API_KEY` 가 있으면 Claude 가 분석하면서 함께 번역하고, 없으면 `DEEPL_API_KEY`(DeepL API Free, 월 50만 자 무료)로 번역합니다. 공지 1건에 약 220자(두 언어)라 무료 한도로 충분합니다. 둘 다 없으면 한국어 원문을 "Korean/韩文" 표시와 함께 보여 줍니다. 이미 저장된 공지는 `npm run translate` 로 번역하세요. 기계 번역이라 틀릴 수 있어 상세 화면에 원문 확인 안내가 있습니다.
- 서버 배포 시 HTTPS 필수(서비스 워커·푸시). 수집은 7백 ms 간격 + User-Agent 표기로 학교 서버 부담을 줄였지만, 운영 전 학교 정보 담당에 알리는 것을 권합니다.
- `sim-event`, `sim-outside` 게시판은 기본 비활성(`server/sources.js`).
