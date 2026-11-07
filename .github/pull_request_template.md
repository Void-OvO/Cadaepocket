## 무엇을 바꿨나요

<!-- 한두 줄로. 관련 이슈나 공지 번호가 있으면 함께 -->

## 어느 단계의 PR 인가요

- [ ] ① `feature/…` · `docs/…` → `develop` (아래 "기능 테스트" 채우기)
- [ ] ② `develop` → `master` (아래 "통합 테스트" 채우기. 머지 후 태그·배포)
- [ ] 예외: `hotfix/…` → `master` (머지 후 태그·배포, develop 에도 머지)

## 기능 테스트 (① develop 으로 가는 PR)

- [ ] `npm test` 통과
- [ ] 이 기능(또는 고친 버그)을 확인하는 테스트 추가
- [ ] `npm start` 로 이 기능 직접 사용
- [ ] 크롤러 변경이면 실제 사이트에서 `npm run crawl` 확인
- [ ] 화면 문구 변경이면 `web/i18n.js` 3개 언어 모두 수정
- [ ] 새 설정값은 `.env.example`·README 에 반영
- [ ] 이 브랜치에는 이 기능 코드만 있음, `.env`·DB·키 파일 없음

## 통합 테스트 (② master 로 가는 PR)

develop 에서 확인한 사람: <!-- 이름 -->

- [ ] `npm test` 전부 통과
- [ ] `npm run crawl` 실제 수집, `/api/health` 오류 없음
- [ ] 새 공지 몇 건을 원문과 비교해 분석 결과 확인
- [ ] 휴대폰 홈 화면 앱으로 설정·홈·상세·저장·캘린더·학과 탭 확인
- [ ] `scripts/test-push.js` 로 푸시 수신 확인
- [ ] 한국어·영어·중국어 화면 확인
- [ ] 이번에 develop 에 들어온 기능 모두 직접 사용

자세한 규칙은 [CONTRIBUTING.md](../CONTRIBUTING.md) 를 보세요.
