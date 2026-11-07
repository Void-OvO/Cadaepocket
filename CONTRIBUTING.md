# 가톨리미 개발 안내

이 저장소는 **git-flow** 브랜치 전략을 씁니다. 원칙은 두 가지입니다.

- **`develop`**: 개발과 테스트를 하는 브랜치입니다. 기능은 `develop` 에서 갈라져 나와 `develop` 으로 돌아오고, 합쳐진 기능들은 develop 에서 함께 테스트합니다.
- **`master`**: **테스트까지 모두 끝난 코드만** 들어갑니다. master 에 있는 코드는 언제든 서버에 배포해도 되는 상태여야 합니다.

처음 참여한다면 이 문서를 끝까지 한 번 읽어 주세요.

## 1. 처음 받기

```bash
git clone https://github.com/Void-OvO/Catholic.git
cd Catholic
git checkout develop          # 개발은 항상 develop 에서 시작
cp .env.example .env          # 키는 각자 발급해서 채운다 (팀원에게 받은 키를 커밋하지 말 것)
npm test                      # Node 22.13 이상. 외부 npm 패키지는 없다
npm start                     # http://localhost:3000
```

## 2. 브랜치

| 브랜치 | 어디서 만드나 | 어디로 합치나 | 용도 |
|---|---|---|---|
| `master` | - | - | **테스트를 마친 코드만.** 릴리스 태그(`v1.1.1` 등)가 붙고 서버에 배포된다. 직접 커밋 금지 |
| `develop` | - | - | **개발과 테스트.** 기능을 모아 함께 테스트한다. 직접 커밋 금지 (PR 로만) |
| `feature/<기능>` | `develop` | `develop` | 새 기능, 기능 개선 |
| `docs/<주제>` | `develop` | `develop` | 문서만 바꿀 때 |
| `release/<버전>` | `develop` | `master` + `develop` | develop 테스트를 통과한 코드를 master 로 올릴 때 (버전 올림, 테스트 중 나온 마지막 수정) |
| `hotfix/<버전>` | `master` | `master` + `develop` | 배포된 버전의 급한 버그 수정 |

브랜치 이름은 영어 소문자와 하이픈으로 짓습니다. 지금까지 쓴 이름을 참고하세요.
`feature/crawler`, `feature/web-push`, `feature/dept-boards`, `docs/readme-crawl-status`, `release/1.1.0`, `hotfix/1.1.1`

```
feature/…  ──PR──▶  develop  ──(테스트 완료 기준 통과)──▶  release/…  ──PR──▶  master  ──▶  태그·배포
                       ▲                                                        │
                       └──────────────── release·hotfix 를 develop 에도 합친다 ──┘
```

## 3. 기능 개발 순서

```bash
git checkout develop
git pull origin develop                     # 최신 develop 에서 시작
git checkout -b feature/saved-export        # 기능 브랜치 만들기

# ... 작업하고 작은 단위로 자주 커밋 ...
git add server/store.js web/app.js
git commit -m "feat(saved): 저장한 공지 목록을 캘린더 파일로 내보내기"

npm test                                    # 모두 통과해야 PR 을 연다
git push -u origin feature/saved-export
```

그다음 GitHub 에서 **`feature/saved-export` → `develop`** 으로 Pull Request 를 엽니다.

- PR 은 최소 1명이 확인한 뒤 합칩니다.
- 합칠 때는 **"Create a merge commit"** 을 고릅니다. Squash·Rebase 로 합치면 기능 브랜치가 그래프에서 사라집니다(로컬에서 합친다면 `git merge --no-ff`).
- 합친 뒤에는 기능 브랜치를 지웁니다.
- 작업하는 동안 develop 이 많이 바뀌었으면 `git merge develop` 으로 내 브랜치에 먼저 받아서 충돌을 풀고 올립니다.

## 4. develop 에서 테스트하기

기능이 develop 에 합쳐지면 develop 을 받아 **합쳐진 상태 그대로** 테스트합니다. 내 기능 브랜치에서는 됐는데 다른 기능과 합치니 깨지는 경우를 여기서 잡습니다.

```bash
git checkout develop && git pull
npm test
npm run crawl        # 실제 학교 사이트 수집 (아래 기준 참고)
npm start            # 화면·푸시 직접 확인
```

테스트 중 문제가 나오면 develop 에 직접 고치지 않고 `feature/…` (또는 `fix` 성격이면 `feature/fix-…`) 브랜치를 만들어 PR 로 고칩니다.

### master 에 올려도 되는 조건 (테스트 완료 기준)

아래를 **모두** 확인한 develop 만 master 로 올립니다. 확인한 사람과 결과를 release PR 본문에 남깁니다.

- [ ] `npm test` 가 모두 통과한다
- [ ] `npm run crawl` 로 실제 학교 사이트를 수집했고, `GET /api/health` 에 오류(`last_error`)가 없다
- [ ] 새로 수집한 공지 몇 건을 원문과 비교해 대상·기간 분석이 맞는지 봤다
- [ ] 휴대폰에서 홈 화면에 추가한 앱으로 초기 설정 → 홈 → 상세 → 저장 → 캘린더 → 학과 탭을 눌러 봤다
- [ ] 푸시를 켜고 `scripts/test-push.js` 로 알림이 실제로 오는지 확인했다
- [ ] 한국어·영어·중국어 화면을 한 번씩 바꿔 봤다
- [ ] 이번에 바뀐 기능을 직접 써 봤다

## 5. master 로 올리기 (릴리스)

develop 이 위 기준을 통과하면 release 브랜치로 master 에 올립니다. 버전은 `주.부.수` 이고, 기능이 추가되면 부 번호(`1.1.0` → `1.2.0`), 버그 수정만이면 수 번호(`1.1.0` → `1.1.1`)를 올립니다.

```bash
git checkout develop && git pull
git checkout -b release/1.2.0
# package.json 의 version 을 1.2.0 으로, README 정리
git commit -am "chore(release): v1.2.0"
git push -u origin release/1.2.0
```

1. **`release/1.2.0` → `master`** PR 을 만듭니다. 본문에 위 "테스트 완료 기준" 체크 결과를 붙입니다. release 브랜치에서는 버전·문서·테스트 중 나온 작은 수정만 하고, 새 기능은 넣지 않습니다.
2. 합친 뒤 master 에 태그를 붙입니다.
   ```bash
   git checkout master && git pull
   git tag -a v1.2.0 -m "v1.2.0: 바뀐 점 한 줄 요약"
   git push origin v1.2.0
   ```
3. **`release/1.2.0` → `develop`** 으로도 합쳐서 release 중에 고친 내용을 develop 에 돌려놓습니다.
4. release 브랜치를 지웁니다. 서버 배포는 master 에서만 합니다 (`deploy/deploy.ps1`).

## 6. 긴급 수정 (hotfix)

배포된 버전에서 급한 버그가 나왔을 때만 씁니다. develop 이 아니라 **master** 에서 갈라집니다. 급하더라도 master 원칙은 같습니다: 테스트를 마친 뒤에만 합칩니다.

```bash
git checkout master && git pull
git checkout -b hotfix/1.1.2
# 수정 + 그 버그를 잡는 테스트 추가 + package.json 버전 올림
git commit -am "fix(scraper): ..."
npm test                     # 그리고 버그가 났던 상황을 직접 다시 확인
git push -u origin hotfix/1.1.2
```

`hotfix/1.1.2` → `master` 로 합치고 태그 `v1.1.2` 를 붙인 뒤, **`develop` 에도 꼭 합칩니다.** develop 에 합치지 않으면 다음 릴리스에서 같은 버그가 되살아납니다.

## 7. 커밋 메시지

```
<종류>(<범위>): <무엇을 했는지 한국어로>

<필요하면 왜 바꿨는지, 어떤 문제가 있었는지>
```

| 종류 | 언제 |
|---|---|
| `feat` | 새 기능 |
| `fix` | 버그 수정 |
| `docs` | 문서만 |
| `test` | 테스트 추가·수정 |
| `refactor` | 동작은 그대로, 코드 구조만 |
| `chore` | 버전, 설정, 스크립트 같은 잡무 |

범위는 바뀐 모듈 이름을 씁니다: `scraper`, `analyze`, `notify`, `push`, `api`, `pwa`, `sources`, `db`, `deploy` 등.

```
feat(notify): 마감 당일 알림 추가
fix(scraper): 분류당 2페이지 제한으로 뒤로 밀려난 공지 누락 수정
docs: 학과 공지 수집 안내
```

## 8. 커밋하면 안 되는 것

`.gitignore` 가 막고 있지만, `git add .` 전에 `git status` 로 한 번 확인하세요.

- `.env` (Claude·DeepL API 키, VAPID 개인키, 관리자 토큰)
- `data/*.db*` (수집한 공지와 **사용자 푸시 구독 정보**)
- `*.pem` (서버 접속 키)

실수로 올렸다면 커밋을 지우는 것만으로는 부족합니다. 이미 원격에 올라간 키는 **바로 폐기하고 새로 발급**한 뒤 팀에 알려 주세요.

## 9. develop 으로 PR 올리기 전 확인

- [ ] `develop` 에서 갈라진 `feature/…` (또는 `docs/…`) 브랜치다
- [ ] `npm test` 가 모두 통과한다
- [ ] 버그를 고쳤다면 그 버그를 다시 잡는 테스트를 추가했다
- [ ] 크롤러를 바꿨다면 실제 학교 사이트에서 `npm run crawl` 로 한 번 돌려 봤다 (요청 간격 `CRAWL_DELAY_MS` 는 줄이지 않는다)
- [ ] 화면 문구를 바꿨다면 `web/i18n.js` 의 한국어·영어·중국어를 모두 고쳤다
- [ ] 설정값을 추가했다면 `.env.example` 과 README 에 적었다
- [ ] 개인정보 원칙을 지켰다: 학과·평점은 서버로 보내거나 저장하지 않는다 (README "개인정보 설계")

## 10. 저장소 관리자 설정 (한 번만)

GitHub 저장소 **Settings** 에서:

- **General → Pull Requests**: "Allow merge commits" 만 켜고 Squash·Rebase merging 은 끕니다.
- **General → Default branch**: `develop` 으로 바꾸면 PR 이 기본으로 develop 을 향합니다.
- **Branches → Add branch ruleset**:
  - `master`: "Require a pull request before merging" (승인 1명 이상), "Block force pushes". master 로 가는 PR 은 `release/…`·`hotfix/…` 에서만 엽니다.
  - `develop`: "Require a pull request before merging", "Block force pushes".
