#!/usr/bin/env bash
# 가톨리미 서버 설치·업데이트 (Ubuntu 22.04/24.04, root 로 실행: sudo bash setup.sh)
#
#   /tmp/catolimi.tar.gz   앱 코드 (deploy.ps1 이 올림)          — 필수
#   /tmp/catolimi.env      .env 에 넣을 추가 값 (API 키 등)        — 있으면 반영
#   /tmp/catolimi.db       처음 설치 때 넣을 DB (수집해 둔 공지)    — 있고 서버에 DB 가 없을 때만 사용
#
# 다시 실행하면 코드만 바꾸고 .env 와 data/ 는 그대로 둔다 (업데이트).
# 환경 변수: DOMAIN (기본: 공인 IP 로 만든 sslip.io 주소)
set -euo pipefail

APP=/opt/catolimi
SVC=catolimi
NODE_MAJOR=22

[ "$(id -u)" -eq 0 ] || { echo "root 로 실행하세요: sudo bash $0"; exit 1; }
[ -f /tmp/catolimi.tar.gz ] || { echo "/tmp/catolimi.tar.gz 가 없어요 (deploy.ps1 로 올리세요)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

log() { echo; echo "==> $*"; }
FIRST_OCR=0

# ── 0. 메모리가 1GB 미만이면 스왑 1GB (512MB 플랜에서 설치·테스트 중 메모리 부족 방지) ──
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$mem_mb" -lt 1000 ] && ! swapon --show | grep -q .; then
  log "스왑 1GB 만들기 (메모리 ${mem_mb}MB)"
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── 1. Node.js 22 (node:sqlite 를 쓰려면 22.13 이상) ──
need_node=1
if command -v node >/dev/null 2>&1; then
  v=$(node -p 'process.versions.node.split(".").map(Number)' | tr -d '[] ' )
  maj=${v%%,*}; rest=${v#*,}; min=${rest%%,*}
  if [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 13 ]; }; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  log "Node.js ${NODE_MAJOR} 설치"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
echo "node $(node -v)"

# ── 1-2. Tesseract OCR (이미지 공지의 글자 읽기, 한국어 데이터 포함) ──
if ! tesseract --list-langs 2>/dev/null | grep -qx kor; then
  log "Tesseract OCR (한국어) 설치"
  apt-get update -y
  apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng
  FIRST_OCR=1
fi

# ── 2. Caddy (HTTPS 인증서 자동 발급·갱신) ──
if ! command -v caddy >/dev/null 2>&1; then
  log "Caddy 설치"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# ── 3. 앱 사용자·코드 ──
id -u catolimi >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin catolimi
mkdir -p "$APP/data"
log "앱 코드 풀기 → $APP"
# 예전 코드 중 .env 와 data/ 를 뺀 나머지를 지우고 새로 푼다
find "$APP" -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec rm -rf {} +
tar -xzf /tmp/catolimi.tar.gz -C "$APP"

# ── 4. 주소 ──
if [ -z "${DOMAIN:-}" ]; then
  IP=$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me)
  DOMAIN="$(echo "$IP" | tr '.' '-').sslip.io"
fi
echo "주소: https://$DOMAIN"

# ── 5. .env (처음 한 번 만들고, 이후에는 추가 값만 반영) ──
ENVF="$APP/.env"
setenv() {  # setenv KEY VALUE : 있으면 바꾸고 없으면 추가
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENVF" 2>/dev/null; then
    local esc; esc=$(printf '%s' "$v" | sed -e 's/[\\/&|]/\\&/g')
    sed -i "s|^${k}=.*|${k}=${esc}|" "$ENVF"
  else
    echo "${k}=${v}" >> "$ENVF"
  fi
}
if [ ! -f "$ENVF" ]; then
  log ".env 만들기 (관리자 토큰·푸시 키 새로 생성)"
  cp "$APP/.env.example" "$ENVF"
  sed -i '/^DB_FILE=/d' "$ENVF"
  setenv ADMIN_TOKEN "$(head -c 24 /dev/urandom | base64 | tr -d '/+=' )"
  keys=$(cd "$APP" && node server/cli.js vapid)
  setenv VAPID_PUBLIC_KEY "$(echo "$keys" | sed -n 's/^VAPID_PUBLIC_KEY=//p')"
  setenv VAPID_PRIVATE_KEY "$(echo "$keys" | sed -n 's/^VAPID_PRIVATE_KEY=//p')"
fi
setenv HOST 127.0.0.1
setenv PORT 3000
setenv APP_ENV prod   # /api/health 의 env
setenv VAPID_SUBJECT "https://$DOMAIN"
# 직접 바꾼 값은 두고, 이 스크립트가 만든 값(주소 포함)만 새 주소로 갱신
if ! grep -q '^CRAWL_USER_AGENT=' "$ENVF" || grep -q '^CRAWL_USER_AGENT=CatolimiBot/0.1 (student project; https://' "$ENVF"; then
  setenv CRAWL_USER_AGENT "CatolimiBot/0.1 (student project; https://$DOMAIN)"
fi
if [ -f /tmp/catolimi.env ]; then
  log "추가 설정 반영 (API 키 등)"
  while IFS='=' read -r k v; do
    [ -n "$k" ] && [ "${k:0:1}" != "#" ] && [ -n "$v" ] && setenv "$k" "$v"
  done < /tmp/catolimi.env
  rm -f /tmp/catolimi.env
fi
chmod 600 "$ENVF"

# ── 6. 처음이면 수집해 둔 DB 넣기 ──
if [ -f /tmp/catolimi.db ]; then
  if [ ! -f "$APP/data/catolimi.db" ]; then log "수집해 둔 DB 넣기"; mv /tmp/catolimi.db "$APP/data/catolimi.db"; else echo "서버에 DB 가 이미 있어서 올린 DB 는 쓰지 않아요"; rm -f /tmp/catolimi.db; fi
fi
chown -R catolimi:catolimi "$APP"

# ── 7. 테스트 (실패하면 서비스를 바꾸지 않고 멈춤) ──
log "테스트"
(cd "$APP" && sudo -u catolimi node --test tests/all.test.js >/tmp/catolimi-test.log 2>&1) || { tail -40 /tmp/catolimi-test.log; echo "테스트 실패: 배포를 멈춰요"; exit 1; }
grep -E '^ℹ (tests|pass|fail)' /tmp/catolimi-test.log || true

# ── 8. systemd 서비스 ──
log "서비스 등록·재시작"
cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=Catolimi notice server
After=network-online.target
Wants=network-online.target

[Service]
User=catolimi
WorkingDirectory=$APP
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production TZ=Asia/Seoul
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable $SVC >/dev/null
systemctl restart $SVC

# ── 9. Caddy: HTTPS → 127.0.0.1:3000 ──
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
	}
}
EOF
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# ── 10. 방화벽 (서버 안쪽. 클라우드 콘솔의 방화벽도 80·443 을 열어야 함) ──
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi
# Oracle Cloud 우분투 이미지는 iptables 로 80·443 을 막아 둔다
if iptables -S INPUT 2>/dev/null | grep -q 'REJECT'; then
  for p in 80 443; do iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT; done
  command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null || true
fi

# ── 11. 확인 ──
sleep 3
systemctl is-active --quiet $SVC && echo "서비스: 실행 중" || { journalctl -u $SVC -n 30 --no-pager; exit 1; }
curl -fsS http://127.0.0.1:3000/api/health >/dev/null && echo "앱 응답: OK"
rm -f /tmp/catolimi.tar.gz
# OCR 를 처음 설치했으면, 이미 모아 둔 이미지 공지를 뒤에서 한 번 다시 읽는다 (진행: journalctl -u catolimi-ocr)
if [ "$FIRST_OCR" -eq 1 ] || [ "${REOCR:-0}" = 1 ]; then
  systemctl stop catolimi-ocr 2>/dev/null || true; systemctl reset-failed catolimi-ocr 2>/dev/null || true
  systemd-run --unit=catolimi-ocr --uid=catolimi --gid=catolimi --working-directory=$APP --property=Nice=10 \
    /usr/bin/node server/cli.js reanalyze $([ "${REOCR:-0}" = 1 ] && echo --reocr || echo --images) >/dev/null && echo "이미지 공지 다시 읽기: 뒤에서 진행 중 (sudo journalctl -u catolimi-ocr -f)"
fi
echo
echo "완료 → https://$DOMAIN"
echo "관리자 토큰: sudo grep ADMIN_TOKEN $ENVF"
echo "로그 보기:   sudo journalctl -u $SVC -f"
