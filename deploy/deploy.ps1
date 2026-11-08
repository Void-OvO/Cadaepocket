<#
  가대포켓를 VPS 에 배포·업데이트합니다 (Windows PowerShell, 이 PC 에서 실행).

  예)  .\deploy\deploy.ps1 -Server 3.35.12.34 -Key C:\Users\me\Downloads\LightsailDefaultKey-ap-northeast-2.pem
       .\deploy\deploy.ps1 -Server 3.35.12.34 -Key ...pem -User ubuntu -Domain notice.example.com

  하는 일
   1) 앱 코드를 묶는다 (.env, data/, .git 은 빼고)
   2) 이 PC .env 에서 API 키(DEEPL·ANTHROPIC)만 골라 따로 올린다 (-NoKeys 면 안 올림)
   3) 처음 배포일 때 지금까지 수집한 공지 DB 사본을 함께 올린다 (-NoData 면 안 올림. 서버에 DB 가 있으면 서버 것을 유지)
   4) 서버에서 deploy/setup.sh 를 실행한다 (Node·Caddy 설치, 서비스 등록, HTTPS)
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Key,
  [string]$User = 'ubuntu',
  [string]$Domain = '',
  [switch]$NoKeys,
  [switch]$NoData,
  [switch]$PackOnly        # 서버에 올리지 않고 묶은 파일만 확인 (시험용)
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $env:TEMP ('cadaepocket-deploy-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
$target = "$User@$Server"
$sshOpt = @('-i', $Key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30')

try {
  if (-not (Test-Path $Key)) { throw "키 파일이 없어요: $Key" }
  # OpenSSH 는 다른 사용자가 읽을 수 있는 키를 거부하므로 권한을 내 계정만으로 줄인다
  icacls $Key /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null

  Write-Host '==> 1/4 코드 묶기'
  $tarball = Join-Path $tmp 'cadaepocket.tar.gz'
  Push-Location $root
  # 어떤 커밋을 배포했는지 서버 /api/health 의 revision 에 남긴다 (커밋 안 한 수정이 있으면 +dirty)
  $rev = $null
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $sha = git rev-parse --short HEAD 2>$null; $br = git rev-parse --abbrev-ref HEAD 2>$null
    if ($sha) { $rev = "$br@$sha"; if (git status --porcelain 2>$null) { $rev += '+dirty' } }
  }
  if ($rev) { [IO.File]::WriteAllText((Join-Path $root 'REVISION'), "$rev`n"); Write-Host "    배포할 코드: $rev" }
  # data/ 의 DB 파일만 뺀다 (data/seed.json 은 코드가 쓰는 시연 공지라 넣어야 함)
  tar.exe -czf $tarball --exclude=./.env --exclude='./data/*.db*' --exclude=./.git --exclude=./node_modules --exclude=./deploy/*.log .
  Remove-Item (Join-Path $root 'REVISION') -ErrorAction SilentlyContinue
  $inTar = tar.exe -tzf $tarball
  if (-not ($inTar -contains './data/seed.json')) { throw 'data/seed.json 이 묶음에 없어요' }
  if ($inTar | Where-Object { $_ -match '\.db($|-)' -or $_ -eq './.env' }) { throw '묶음에 DB 나 .env 가 들어갔어요' }
  Pop-Location
  $files = @($tarball, (Join-Path $root 'deploy\setup.sh'))

  if (-not $NoKeys -and (Test-Path (Join-Path $root '.env'))) {
    $pick = Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^(DEEPL_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_MODEL|DEPT_AI|CRAWL_DEPTS)=.+' }
    if ($pick) {
      Write-Host ('==> 2/4 API 키 올리기: ' + (($pick | ForEach-Object { ($_ -split '=')[0] }) -join ', '))
      $envFile = Join-Path $tmp 'cadaepocket.env'
      [IO.File]::WriteAllText($envFile, (($pick -join "`n") + "`n"))
      $files += $envFile
    } else { Write-Host '==> 2/4 올릴 API 키 없음' }
  } else { Write-Host '==> 2/4 API 키 건너뜀' }

  if (-not $NoData -and (Test-Path (Join-Path $root 'data\cadaepocket.db'))) {
    Write-Host '==> 3/4 수집한 공지 DB 사본 만들기 (실행 중인 서버가 있어도 안전한 VACUUM INTO)'
    $dbCopy = Join-Path $tmp 'cadaepocket.db'
    node (Join-Path $root 'deploy\snapshot-db.js') (Join-Path $root 'data\cadaepocket.db') $dbCopy
    if ($LASTEXITCODE -ne 0) { throw 'DB 사본을 만들지 못했어요 (-NoData 로 건너뛸 수 있어요)' }
    $files += $dbCopy
  } else { Write-Host '==> 3/4 DB 건너뜀 (서버에서 처음부터 수집)' }

  if ($PackOnly) {
    Write-Host '==> 묶기만 함 (-PackOnly). 만든 파일:'
    $files | ForEach-Object { '{0,10:N0} bytes  {1}' -f (Get-Item $_).Length, $_ }
    $tmp = $null   # 확인할 수 있게 지우지 않음
    return
  }
  Write-Host "==> 4/4 $target 로 올리고 설치"
  & scp.exe @sshOpt @files "${target}:/tmp/"
  if ($LASTEXITCODE -ne 0) { throw 'scp 실패 (주소·키·사용자 이름, 클라우드 방화벽의 22번 포트를 확인하세요)' }
  $envArg = if ($Domain) { "DOMAIN='$Domain' " } else { '' }
  & ssh.exe @sshOpt $target "sed -i 's/\r$//' /tmp/setup.sh && sudo ${envArg}bash /tmp/setup.sh"
  if ($LASTEXITCODE -ne 0) { throw '서버 설치 단계에서 실패했어요 (위 로그 참고)' }
}
finally {
  if ($tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
