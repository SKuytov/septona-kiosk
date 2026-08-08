#!/usr/bin/env bash
#
# Septona Kiosk — one-command installer for a fresh Ubuntu server.
#
#   curl -fsSL https://raw.githubusercontent.com/SKuytov/septona-kiosk/main/deploy/install.sh | sudo bash
#
# Installs Docker if it is missing, fetches the project, generates strong secrets,
# and starts the management platform. Safe to re-run: an existing .env is never
# overwritten, so re-running upgrades the stack without changing credentials.
#
# Tested on Ubuntu 22.04 LTS and 24.04 LTS.

set -euo pipefail

# Never fail silently. Without this, any non-zero command under `set -e` ends the
# run with no output at all, which is impossible to diagnose over SSH.
on_error() {
  local rc=$1 line=$2 cmd=$3
  printf '\n\033[31m !! Installation stopped at line %s (exit %s)\033[0m\n' "$line" "$rc" >&2
  printf '\033[31m    while running: %s\033[0m\n\n' "$cmd" >&2
  exit "$rc"
}
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

REPO_URL="${REPO_URL:-https://github.com/SKuytov/septona-kiosk.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/septona-kiosk}"
# Remember whether the port was chosen deliberately: on an update the port recorded in
# .env wins over the default, but an explicit HTTP_PORT= must still win over both.
HTTP_PORT_EXPLICIT="${HTTP_PORT:+yes}"
HTTP_PORT="${HTTP_PORT:-8080}"
BRANCH="${BRANCH:-main}"

# ----------------------------------------------------------------- presentation
if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=''; G=''; Y=''; R=''; D=''; N=''
fi
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$1" "$N"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '%s !! %s%s\n' "$Y" "$1" "$N"; }
die()  { printf '\n%s !! %s%s\n\n' "$R" "$1" "$N" >&2; exit 1; }

# ------------------------------------------------------------------- pre-flight
[ "$(id -u)" -eq 0 ] || die "Run as root:  curl -fsSL <url> | sudo bash"

. /etc/os-release 2>/dev/null || die "Cannot identify the operating system."
[ "${ID:-}" = "ubuntu" ] || [ "${ID_LIKE:-}" = "debian" ] \
  || warn "Designed for Ubuntu; '${ID:-unknown}' may work but is untested."

case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) die "Unsupported architecture: $(uname -m). Need x86_64 or aarch64." ;;
esac

# Re-running over an existing installation is the documented way to update, so decide
# that first: several checks below must not treat our own running stack as a conflict.
# Written as if/fi on purpose: a bare `[ ... ] && VAR=true` returns 1 when the file is
# absent, which under `set -e` would abort the installer on every first install.
UPDATING=false
if [ -f "${INSTALL_DIR}/.env" ]; then
  UPDATING=true
  # Honour the port the installation actually runs on, not the default, so the check
  # below and the closing summary both refer to the right one.
  EXISTING_PORT="$(grep -E '^HTTP_PORT=' "${INSTALL_DIR}/.env" 2>/dev/null | cut -d= -f2- || true)"
  if [ -n "${EXISTING_PORT:-}" ] && [ -z "${HTTP_PORT_EXPLICIT:-}" ]; then
    HTTP_PORT="$EXISTING_PORT"
  fi
fi

# A port already in use is the single most common cause of a failed first start, and the
# error Docker gives for it is not obvious. Check before changing anything — but only on
# a first install: on an update the listener on that port is this application itself, and
# compose replaces its own container.
# Capture first, match second: `ss | grep -q` closes the pipe early, which makes ss die
# of SIGPIPE and — under pipefail — silently inverts the test.
if [ "$UPDATING" = false ] && command -v ss >/dev/null 2>&1; then
  LISTENING="$(ss -ltn 2>/dev/null || true)"
  if grep -qE "[:.]${HTTP_PORT}[[:space:]]" <<<"$LISTENING"; then
    die "Port ${HTTP_PORT} is already in use. Re-run with:  HTTP_PORT=9090 sudo -E bash install.sh"
  fi
fi

printf '\n%s  Septona Kiosk — installation%s\n' "$B" "$N"
printf '%s  target: %s   port: %s%s\n' "$D" "$INSTALL_DIR" "$HTTP_PORT" "$N"

# ----------------------------------------------------------------- dependencies
step "Checking system packages"
export DEBIAN_FRONTEND=noninteractive
MISSING=()
for pkg in git curl ca-certificates openssl; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  info "installing: ${MISSING[*]}"
  apt-get update -qq
  apt-get install -y -qq "${MISSING[@]}"
else
  info "git, curl, openssl already present"
fi

step "Checking Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  info "Docker $(docker --version | awk '{print $3}' | tr -d ,) with compose plugin already present"
else
  info "installing Docker Engine from the official repository…"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
                         docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  info "installed $(docker --version | awk '{print $3}' | tr -d ,)"
fi

# --------------------------------------------------------------------- sources
step "Fetching the application"
if [ -d "$INSTALL_DIR/.git" ]; then
  info "existing installation found — updating"
  git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
info "at $INSTALL_DIR ($(git rev-parse --short HEAD))"

# --------------------------------------------------------------------- secrets
step "Configuring"
FRESH_INSTALL=false
if [ -f .env ]; then
  info ".env already exists — keeping current credentials"
else
  FRESH_INSTALL=true
  JWT_SECRET="$(openssl rand -hex 32)"
  PG_PASSWORD="$(openssl rand -hex 16)"
  # Avoid look-alike characters: this gets typed by a human on first login.
  # Read a bounded chunk and then filter. Draining /dev/urandom into `head -c`
  # kills tr with SIGPIPE, which under pipefail aborts the whole installer.
  RANDOM_POOL="$(head -c 1024 /dev/urandom | LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9')"
  [ "${#RANDOM_POOL}" -ge 16 ] || die "Could not read randomness from /dev/urandom."
  ADMIN_PASSWORD="${RANDOM_POOL:0:16}"

  umask 077
  cat > .env <<EOF
# Generated by deploy/install.sh on $(date -Is)
HTTP_PORT=${HTTP_PORT}

POSTGRES_USER=septona
POSTGRES_PASSWORD=${PG_PASSWORD}
POSTGRES_DB=septona_kiosk

JWT_SECRET=${JWT_SECRET}

ADMIN_EMAIL=admin@septona.local
ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF
  chmod 600 .env
  info "generated .env with random secrets (mode 600)"
fi

# ----------------------------------------------------------------------- build
step "Building and starting (first run takes a few minutes)"
docker compose pull --quiet db 2>/dev/null || true
docker compose up -d --build

# ------------------------------------------------------------------- readiness
step "Waiting for the service to become healthy"
READY=false
for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${HTTP_PORT}/api/health" >/dev/null 2>&1; then
    READY=true; break
  fi
  sleep 2
  if [ $((i % 15)) -eq 0 ]; then info "still waiting… ($((i * 2))s)"; fi
done

if [ "$READY" != true ]; then
  warn "The service did not answer within 3 minutes. Recent logs:"
  docker compose logs --tail 40 server || true
  die "Start-up failed. Full logs:  cd ${INSTALL_DIR} && docker compose logs -f"
fi

# ------------------------------------------------------------------- summary
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<server-ip>"
# `|| true` matters: grep exits 1 when the line is absent, which would abort the
# installer here — after everything has already succeeded — on a hand-edited .env.
ADMIN_EMAIL_OUT="$(grep -E '^ADMIN_EMAIL=' .env 2>/dev/null | cut -d= -f2- || true)"
ADMIN_PASS_OUT="$(grep -E '^ADMIN_PASSWORD=' .env 2>/dev/null | cut -d= -f2- || true)"
[ -n "$ADMIN_EMAIL_OUT" ] || ADMIN_EMAIL_OUT="admin@septona.local"
[ -n "$ADMIN_PASS_OUT" ] || ADMIN_PASS_OUT="(вижте ADMIN_PASSWORD в ${INSTALL_DIR}/.env)"

cat <<EOF

${G}${B}  Septona Kiosk is running.${N}

  ${B}Management platform${N}   http://${IP}:${HTTP_PORT}/
  ${B}Kiosk in a browser${N}    http://${IP}:${HTTP_PORT}/kiosk/
  ${B}Health check${N}          http://${IP}:${HTTP_PORT}/api/health

EOF

if [ "$FRESH_INSTALL" = true ]; then
  cat <<EOF
  ${B}Sign in with${N}
      email     ${ADMIN_EMAIL_OUT}
      password  ${Y}${ADMIN_PASS_OUT}${N}

  ${Y}Write this password down now — it is stored only in ${INSTALL_DIR}/.env${N}

  ${B}Next steps${N}
      1. Sign in and change the administrator password.
      2. Създайте устройство (Устройства > Ново устройство) to get a device key.
      3. On the panel, open the app, hold the logo for 3 seconds, enter PIN 2470,
         then type the server address and the device key.
      4. To load the initial document set, copy the archive to this server
         (from your PC:  scp KIOSK_DOCS.zip ${SUDO_USER:-user}@${IP}:~/ ) and run:
           sudo bash ${INSTALL_DIR}/deploy/import-docs.sh ~/KIOSK_DOCS.zip
         Or skip it and upload documents from the management platform.

EOF
else
  cat <<EOF
  ${B}Existing credentials kept.${N} They are in ${INSTALL_DIR}/.env

EOF
fi

cat <<EOF
  ${D}logs     cd ${INSTALL_DIR} && docker compose logs -f
  stop     cd ${INSTALL_DIR} && docker compose down
  update   sudo bash ${INSTALL_DIR}/deploy/install.sh
  backup   cd ${INSTALL_DIR} && docker compose exec -T db pg_dump -U septona septona_kiosk > backup.sql${N}

EOF
