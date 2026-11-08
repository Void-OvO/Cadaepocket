# 가대포켓 (CadaePocket) — 서버 + PWA

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
npm test                    # 34개 테스트
```
함께 개발한다면 브랜치 전략과 커밋 규칙을 [CONTRIBUTING.md](CONTRIBUTING.md) 에서 먼저 확인하세요 (기능 브랜치에서 개발·기능 테스트 → `develop` 에서 통합 테스트 → 배포 중인 `master`).

푸시를 쓰려면 `npm run vapid` 로 키를 만들어 `.env` 에 넣으세요(HTTPS 필요, localhost 는 예외).

**서버 배포**: 한국 리전 우분투 VPS 에 `.\deploy\deploy.ps1 -Server <IP> -Key <키.pem>` 한 줄로 설치·업데이트합니다 (Node 22 + systemd + Caddy 자동 HTTPS, 무료 `sslip.io` 주소). 자세한 순서는 [deploy/배포안내.md](deploy/배포안내.md). 서버에 떠 있는 코드는 `GET /api/health` 의 `env`·`version`·`revision` 으로 확인합니다.

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

**학과 공지**: 각 학과 사이트의 공지 게시판을 따로 수집합니다. 성심 학과는 대부분 `https://{slug}.catholic.ac.kr/{slug}/community/notice.do`이고, 일어일본문화학과(`/japanese/major/notice.do`)·바이오로직스공학부(`ble.catholic.ac.kr/BLE/...`)·융합전공학부(`/major_convergence/notice/notice.do`)는 주소가 달라 `web/depts.js`에 따로 적었습니다. 2026-11-06에 성심 학과 게시판 45곳을 모두 열어 목록이 읽히는 것을, 그중 5곳은 실제 수집(상세·첨부까지)을 확인했습니다. 성의 의예·의학·간호는 의과대학·간호대학 게시판을 씁니다. 학과 게시판에서만 본 공지는 홈 피드에 섞지 않고 '학과' 탭에서만 보이며, 새 공지 푸시도 보내지 않습니다. 예술미디어융합학과 게시판(gamc)에는 대학원 공지도 함께 올라옵니다. 학과 목록은 나무위키 '가톨릭대학교/학부'(2026-09 판)를 참고했으니 학교 공식 목록과 한 번 대조하세요.

**수집 범위**: 게시판(분류)마다 앞쪽 `CRAWL_MAX_PAGES`(기본 2) 페이지는 매번 보고, 그 뒤로는 처음 보는 최근 `CRAWL_BACKFILL_DAYS`(기본 30)일 글이 나오는 동안 `CRAWL_PAGE_CAP`(기본 15, 학과 `CRAWL_DEPT_PAGE_CAP` 5) 페이지까지 더 넘깁니다. 첫 수집이나 서버가 멈췄던 동안 뒤로 밀려난 글도 채워집니다. 예전에는 2페이지에서 끝나서 하루 3건쯤 올라오는 '일반' 분류의 10/21 공지(276913)가 빠졌습니다.

**마지막 업데이트**: 목록 위에는 그 게시판을 마지막으로 수집한 시각, 공지 상세에는 앱이 그 공지를 원문에서 마지막으로 확인한 시각(`checked_at`)을 보여 줍니다.

API: `GET /api/notices?campus=sim|ui&cat=&board=` (board: 학과 게시판 키, 예 `dept-psychology`) · `GET /api/notices/:id` · `GET /api/changes` · `POST /api/push/subscribe|unsubscribe` · `POST /api/reports` · `POST /api/admin/crawl`(Bearer `ADMIN_TOKEN`) · `GET /api/health`

## 개인정보 설계
학과·평점은 **기기(localStorage/IndexedDB)에만** 저장하고 서버에 저장하지 않습니다. 학과 탭을 열 때만 그 학과 게시판 키(예: `dept-psychology`)가 목록 요청 주소에 담깁니다(서버는 기록하지 않음). 서버는 푸시 구독(endpoint·키), 캠퍼스, 언어, 알림 분류·시점과,
푸시를 켠 경우 **학적 상태·이수 학기·교환/외국인 여부와 저장한 공지 번호**만 압니다. 서버는 앞의 세 가지로 대상 아닌 공지를 미리 걸러 보내고(학과·평점 조건은 거르지 않음), 서비스 워커는 받은 알림을 항상 띄웁니다.

푸시 규칙: **새 공지**는 내 조건에 맞고 알림을 켠 뒤에 새로 올라온 공지만(켜기 전에 있던 공지는 보내지 않음), **마감 7·3·1일 전**과 **정정** 알림은 저장한 공지에만 보냅니다.
(브라우저는 알림을 띄우지 않는 푸시가 반복되면 구독을 끊을 수 있어서, 기기에서 조용히 버리는 방식은 쓰지 않습니다.)

## 꼭 알아둘 점
- **실제 사이트 수집 확인**: 2026-11-05~06에 실제 학교 사이트에서 수집했습니다. 성심 공지사항 85건, 성의 공지사항·의과대학·간호대학 86건, 성심 학과 게시판 528건(공지 699건, 첨부파일 582개, 본문 이미지 510장)이고, 활성 수집원 49곳 모두 오류 없이 수집됐습니다. 이때 분석은 Claude 키 없이 규칙 기반(`rules-v2`)으로 했고, 로컬 PC 에 Tesseract 가 없어 이미지 OCR 은 돌지 않았습니다. 자동 테스트는 사이트 구조(`b-cate-notice`, `a.b-title[data-article-no]`, `.b-content-box`, `.b-file-box` 등)를 본뜬 가짜 페이지로 돌립니다. 학교 사이트 구조가 바뀌어 수집 결과가 비면 `server/scraper.js` 의 `parseList` 선택자를 먼저 확인하세요. 게시판 한 곳이 실패해도 다른 곳은 계속 수집하고, `GET /api/health` 에 마지막 오류가 남습니다.
- 공지의 영어·중국어 번역(제목·요약·대상·혜택·서류·신청 방법): `ANTHROPIC_API_KEY` 가 있으면 Claude 가 분석하면서 함께 번역하고, 없으면 `DEEPL_API_KEY`(DeepL API Free, 월 50만 자 무료)로 번역합니다. 공지 1건에 약 220자(두 언어)라 무료 한도로 충분합니다. 둘 다 없으면 한국어 원문을 "Korean/韩文" 표시와 함께 보여 줍니다. 이미 저장된 공지는 `npm run translate` 로 번역하세요. 기계 번역이라 틀릴 수 있어 상세 화면에 원문 확인 안내가 있습니다.
- 서버 배포 시 HTTPS 필수(서비스 워커·푸시). 수집은 7백 ms 간격 + User-Agent 표기로 학교 서버 부담을 줄였지만, 운영 전 학교 정보 담당에 알리는 것을 권합니다.
- `sim-event`, `sim-outside` 게시판은 기본 비활성(`server/sources.js`).
