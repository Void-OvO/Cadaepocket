## 무엇을 바꿨나요

<!-- 한두 줄로. 관련 이슈나 공지 번호가 있으면 함께 -->

## 브랜치

- [ ] `feature/…` · `docs/…` → `develop`
- [ ] `release/…` → `master` (합친 뒤 태그, develop 에도 합치기)
- [ ] `hotfix/…` → `master` (합친 뒤 태그, develop 에도 합치기)

## 확인

- [ ] `npm test` 통과
- [ ] 버그 수정이면 그 버그를 잡는 테스트 추가
- [ ] 크롤러 변경이면 실제 사이트에서 `npm run crawl` 확인
- [ ] 화면 문구 변경이면 `web/i18n.js` 3개 언어 모두 수정
- [ ] 새 설정값은 `.env.example`·README 에 반영
- [ ] `.env`·DB·키 파일이 들어가지 않음

자세한 규칙은 [CONTRIBUTING.md](../CONTRIBUTING.md) 를 보세요.
