# 가대포켓 개발 안내

이 저장소는 기능 브랜치 → `develop` → `master` 세 단계로 개발합니다. 단계마다 테스트를 하고, 통과한 코드만 다음 단계로 올립니다.

```
feature/<기능>  ──①기능 테스트──▶  develop  ──②통합 테스트──▶  master (배포 중)
  새 기능 코드만                     기능들을 합쳐서              테스트를 모두 마친 코드만
```

| 단계 | 브랜치 | 하는 일 | 통과하면 |
|---|---|---|---|
| ① | `feature/<기능>` | 새 기능 코드만 작성하고, **그 기능을 테스트** | `develop` 에 머지 |
| ② | `develop` | 다른 기능과 합쳐진 상태로 **전체를 다시 테스트** | `master` 에 머지 |
| ③ | `master` | 서버에 배포된 코드. 태그(`v1.2.0`)를 붙이고 배포 | - |

`master` 와 `develop` 에는 직접 커밋하지 않고 항상 Pull Request 로만 합칩니다. 처음 참여한다면 이 문서를 끝까지 한 번 읽어 주세요.

## 1. 처음 받기

```bash
git clone https://github.com/Void-OvO/cadaepocket.git
cd cadaepocket
git checkout develop          # 개발은 develop 에서 (GitHub 기본 브랜치도 develop)
git config core.hooksPath .githooks   # master 에 직접 커밋·push 하는 실수를 막는 훅 켜기
cp .env.example .env          # 키는 각자 발급해서 채운다 (팀원에게 받은 키를 커밋하지 말 것)
npm test                      # Node 22.13 이상. 외부 npm 패키지는 없다
npm start                     # http://localhost:3000
```

## 2. 브랜치 이름

| 브랜치 | 어디서 만드나 | 어디로 합치나 | 용도 |
|---|---|---|---|
| `master` | - | - | 배포 중인 코드. 직접 커밋 금지 |
| `develop` | - | `master` | 통합 테스트. 직접 커밋 금지 |
| `feature/<기능>` | `develop` | `develop` | 새 기능 하나 (버그 수정도 `feature/fix-…` 로) |
| `docs/<주제>` | `develop` | `develop` | 문서만 바꿀 때 |
| `hotfix/<버전>` | `master` | `master` + `develop` | 배포 중인 서비스의 급한 장애 수정 (예외, 6절) |

이름은 영어 소문자와 하이픈으로 짓습니다. 예: `feature/crawler`, `feature/dept-boards`, `feature/fix-deadline-alert`, `docs/readme-crawl-status`, `hotfix/1.1.1`

**기능 브랜치 하나에는 기능 하나만 넣습니다.** 크롤러를 고치다가 화면 문구가 눈에 띄어도 같은 브랜치에서 고치지 말고 브랜치를 따로 만드세요. 그래야 develop 테스트에서 문제가 생겼을 때 어느 기능 때문인지 바로 알 수 있습니다.

## 3. ① 기능 브랜치: 개발과 기능 테스트

```bash
git checkout develop
git pull origin develop                     # 최신 develop 에서 시작
git checkout -b feature/saved-export

# ... 이 기능에 대한 코드만 작성하고, 작은 단위로 자주 커밋 ...
git add server/store.js web/app.js
git commit -m "feat(saved): 저장한 공지 목록을 캘린더 파일로 내보내기"
```

### 기능 테스트 (develop 에 머지하기 전)

- [ ] `npm test` 가 모두 통과한다
- [ ] 이 기능을 확인하는 테스트를 `tests/all.test.js` 에 추가했다 (버그 수정이면 그 버그를 다시 잡는 테스트)
- [ ] `npm start` 로 띄워서 이 기능을 직접 써 봤다
- [ ] 크롤러를 바꿨다면 `npm run crawl` 로 실제 학교 사이트에서 한 번 돌려 봤다 (요청 간격 `CRAWL_DELAY_MS` 는 줄이지 않는다)
- [ ] 화면 문구를 바꿨다면 `web/i18n.js` 의 한국어·영어·중국어를 모두 고쳤다
- [ ] 설정값을 추가했다면 `.env.example` 과 README 에 적었다
- [ ] 학과·평점을 서버로 보내거나 저장하지 않는다 (README "개인정보 설계")

다 됐으면 올리고 **`feature/saved-export` → `develop`** Pull Request 를 엽니다.

```bash
git push -u origin feature/saved-export
```

- 작업하는 동안 develop 이 바뀌었으면 `git merge develop` 으로 먼저 받아서 충돌을 풀고 다시 테스트한 뒤 올립니다.
- 합칠 때는 **"Create a merge commit"** 을 고릅니다. Squash·Rebase 로 합치면 기능 브랜치가 그래프에서 사라집니다(로컬에서 합친다면 `git merge --no-ff`).
- 합친 뒤에는 기능 브랜치를 지웁니다.

## 4. ② develop: 통합 테스트

기능이 develop 에 합쳐지면, develop 을 받아 **다른 기능과 합쳐진 상태 그대로** 다시 테스트합니다. 내 브랜치에서는 됐는데 다른 기능과 합치니 깨지는 경우를 여기서 잡습니다.

```bash
git checkout develop && git pull
npm test
npm run crawl
npm start
```

### 통합 테스트 (master 에 머지하기 전)

- [ ] `npm test` 가 모두 통과한다
- [ ] `npm run crawl` 로 실제 학교 사이트를 수집했고, `GET /api/health` 에 오류(`last_error`)가 없다
- [ ] 새로 수집한 공지 몇 건을 원문과 비교해 대상·기간 분석이 맞는지 봤다
- [ ] 휴대폰에서 홈 화면에 추가한 앱으로 초기 설정 → 홈 → 상세 → 저장 → 캘린더 → 학과 탭을 눌러 봤다
- [ ] 푸시를 켜고 `scripts/test-push.js` 로 알림이 실제로 오는지 확인했다
- [ ] 한국어·영어·중국어 화면을 한 번씩 바꿔 봤다
- [ ] 이번에 develop 에 들어온 기능들을 모두 직접 써 봤다

**문제가 나오면** develop 에서 바로 고치지 않습니다. 원인이 된 기능 브랜치(이미 지웠다면 `feature/fix-…` 새 브랜치)에서 고치고, ①의 기능 테스트를 다시 거쳐 develop 에 PR 로 합친 뒤 통합 테스트를 처음부터 다시 합니다.

## 5. ③ master: 배포

통합 테스트를 모두 통과하면 master 에 올립니다. 버전은 `주.부.수` 이고, 기능이 추가되면 부 번호(`1.1.1` → `1.2.0`), 버그 수정만이면 수 번호(`1.1.1` → `1.1.2`)를 올립니다.

1. **버전 올리기**: `package.json` 의 `version` 을 바꾸는 작은 브랜치를 develop 에 합칩니다.
   ```bash
   git checkout develop && git pull
   git checkout -b feature/version-1.2.0
   # package.json 의 version 을 1.2.0 으로
   git commit -am "chore: v1.2.0"
   git push -u origin feature/version-1.2.0     # → develop PR
   ```
2. **`develop` → `master`** Pull Request 를 엽니다. 본문에 4절 통합 테스트 체크 결과와 확인한 사람을 남깁니다.
3. 합친 뒤 master 에 태그를 붙입니다.
   ```bash
   git checkout master && git pull
   git tag -a v1.2.0 -m "v1.2.0: 바뀐 점 한 줄 요약"
   git push origin v1.2.0
   ```
4. master 를 서버에 배포합니다 (`deploy/deploy.ps1`). **배포는 master 에서만 합니다.**

GitHub PR 대신 로컬에서 `git merge --no-ff develop` 으로 master 에 합쳤다면, `.githooks/pre-push` 가 master push 를 한 번 막습니다. 통합 테스트를 마친 게 맞으면 `ALLOW_MASTER_PUSH=1` 을 붙여 push 하세요 (PowerShell: `$env:ALLOW_MASTER_PUSH=1; git push origin master; Remove-Item Env:ALLOW_MASTER_PUSH`).

## 6. 예외: 배포 중 급한 장애 (hotfix)

서비스가 망가져서 develop 에 쌓인 다른 기능을 기다릴 수 없을 때만 씁니다. develop 이 아니라 **master** 에서 갈라집니다. 급해도 테스트를 건너뛰지 않습니다.

```bash
git checkout master && git pull
git checkout -b hotfix/1.1.2
# 수정 + 그 버그를 잡는 테스트 추가 + package.json 버전 올림
git commit -am "fix(scraper): ..."
npm test                     # 그리고 장애가 났던 상황을 직접 다시 확인
git push -u origin hotfix/1.1.2
```

`hotfix/1.1.2` → `master` 로 합치고 태그 `v1.1.2` 를 붙여 배포한 뒤, **`develop` 에도 꼭 합칩니다.** develop 에 합치지 않으면 다음 배포 때 같은 장애가 되살아납니다.

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

## 9. 저장소 관리자 설정 (한 번만)

GitHub 저장소 **Settings** 에서:

- **General → Pull Requests**: "Allow merge commits" 만 켜고 Squash·Rebase merging 은 끕니다. "Automatically delete head branches" 를 켜면 머지한 기능 브랜치가 자동으로 지워집니다.
- **General → Default branch**: `develop` 으로 바꾸면 PR 이 기본으로 develop 을 향합니다.
- **Rules → Rulesets → New branch ruleset** 을 `master`, `develop` 에 하나씩 만듭니다: "Require a pull request before merging", "Block force pushes", "Restrict deletions". master 로 가는 PR 은 `develop` 과 `hotfix/…` 에서만 엽니다.
  - 혼자 개발하는 동안에는 자기 PR 을 스스로 승인할 수 없으니 Required approvals 를 0 으로 두거나 Bypass list 에 Repository admin 을 넣습니다.

## 참고: 예전 이력의 `release/…` 브랜치

v1.0.0·v1.1.0 은 `release/…` 브랜치를 거쳐 master 에 올렸습니다. 지금은 위 3단계 방식으로 바꿔서 release 브랜치를 쓰지 않고 develop 에서 master 로 바로 올립니다.
