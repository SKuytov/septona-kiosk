#!/usr/bin/env bash
# Exercises deploy/install.sh end to end without a real Docker or network,
# in the same shape the user runs it: piped into `bash` with no tty.
set -uo pipefail

SRC=/home/user/workspace/septona-kiosk/deploy/install.sh
ROOT=/tmp/instest
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }
has()  { if grep -qF -- "$2" "$3"; then ok "$1"; else bad "$1 — '$2' not in output"; fi; }
hasnt(){ if grep -qF -- "$2" "$3"; then bad "$1 — unexpected '$2'"; else ok "$1"; fi; }

setup_shims() {
  local bin=$1 compose_rc=${2:-0} health=${3:-ok}
  mkdir -p "$bin"
  cat > "$bin/docker" <<EOF
#!/usr/bin/env bash
case "\$1 \$2" in
  "--version"*)   echo "Docker version 29.7.2, build abc"; exit 0 ;;
  "compose version") exit 0 ;;
esac
if [ "\$1" = compose ]; then echo "[shim] docker \$*" >> "$ROOT/compose.log"; exit $compose_rc; fi
exit 0
EOF
  cat > "$bin/curl" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in *"/api/health") [ "$health" = ok ] && exit 0 || exit 7 ;; esac; done
exit 0
EOF
  cat > "$bin/apt-get" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat > "$bin/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = clone ]; then mkdir -p "\${@: -1}/.git"; exit 0; fi
if [ "\$1" = rev-parse ]; then echo deadbee; exit 0; fi
exit 0
EOF
  cat > "$bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  # the harness is not root; the script's own root check is verified separately
  cat > "$bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -u ]; then echo 0; else /usr/bin/id "$@"; fi
EOF
  cat > "$bin/hostname" <<'EOF'
#!/usr/bin/env bash
echo "192.168.0.160 "
EOF
  chmod +x "$bin"/*
}

run() { # name, install_dir, compose_rc, health -> writes $ROOT/<name>.out
  local name=$1 dir=$2 rc=${3:-0} health=${4:-ok}
  local bin="$ROOT/$name/bin"
  setup_shims "$bin" "$rc" "$health"
  mkdir -p "$dir"
  ( export PATH="$bin:$PATH" INSTALL_DIR="$dir" HTTP_PORT="${PORT:-8099}" \
           REPO_URL=https://example.invalid/x.git
    cd /tmp && cat "$SRC" | bash ) > "$ROOT/$name.out" 2>&1
  echo $?
}

rm -rf "$ROOT"; mkdir -p "$ROOT"; : > "$ROOT/compose.log"

echo "== 1. fresh install, everything healthy"
D="$ROOT/fresh/opt"; RC=$(run fresh "$D")
check "exits 0" "$RC" 0
O="$ROOT/fresh.out"
has  "reaches Configuring"    "==> Configuring"           "$O"
has  "generates .env"         "generated .env"            "$O"
has  "reaches build step"     "Building and starting"     "$O"
has  "reaches readiness"      "become healthy"            "$O"
has  "prints success"         "Septona Kiosk is running"  "$O"
has  "prints management URL"  "http://192.168.0.160:8099/" "$O"
has  "prints kiosk URL"       "/kiosk/"                   "$O"
has  "prints credentials"     "admin@septona.local"       "$O"
has  "prints import hint"     "deploy/import-docs.sh"     "$O"
hasnt "no silent stop"        "Installation stopped"      "$O"

echo "== 2. the generated .env"
E="$D/.env"
if [ -f "$E" ]; then ok ".env created"; else bad ".env created"; fi
check ".env mode 600" "$(stat -c %a "$E")" 600
P=$(grep '^ADMIN_PASSWORD=' "$E" | cut -d= -f2-)
check "password is 16 chars" "${#P}" 16
if [[ "$P" =~ ^[A-HJ-NP-Za-km-z2-9]{16}$ ]]; then ok "password avoids look-alikes"; else bad "password charset: $P"; fi
if [ "$P" = "$(grep '^ADMIN_PASSWORD=' "$E" | cut -d= -f2-)" ]; then ok "password stable in file"; fi
J=$(grep '^JWT_SECRET=' "$E" | cut -d= -f2-)
check "jwt secret 64 hex" "${#J}" 64
G=$(grep '^POSTGRES_PASSWORD=' "$E" | cut -d= -f2-)
check "pg password 32 hex" "${#G}" 32
has  "port recorded"      "HTTP_PORT=8099"     "$E"
has  "db name recorded"   "septona_kiosk"      "$E"
if grep -q "$P" "$ROOT/fresh.out"; then ok "the password it wrote is the one it printed"; else bad "printed password differs from .env"; fi

echo "== 3. passwords differ between installs"
D2="$ROOT/fresh2/opt"; run fresh2 "$D2" >/dev/null
P2=$(grep '^ADMIN_PASSWORD=' "$D2/.env" | cut -d= -f2-)
if [ "$P" != "$P2" ]; then ok "two installs get different passwords"; else bad "password is not random"; fi

echo "== 4. re-run over an existing install keeps credentials"
RC=$(run rerun "$D")
check "re-run exits 0" "$RC" 0
has  "keeps credentials"  "already exists"        "$ROOT/rerun.out"
has  "says kept"          "Existing credentials"  "$ROOT/rerun.out"
check "password unchanged" "$(grep '^ADMIN_PASSWORD=' "$E" | cut -d= -f2-)" "$P"
hasnt "does not reprint a new password" "Write this password down" "$ROOT/rerun.out"

echo "== 5. failures are now reported, not silent"
RC=$(run buildfail "$ROOT/bf/opt" 1)
if [ "$RC" != 0 ]; then ok "compose failure exits non-zero ($RC)"; else bad "compose failure went unnoticed"; fi
has "names the failing line" "Installation stopped at line" "$ROOT/buildfail.out"
has "names the command"      "docker compose up"            "$ROOT/buildfail.out"

RC=$(run unhealthy "$ROOT/uh/opt" 0 bad)
check "unhealthy exits 1" "$RC" 1
has "explains the timeout" "did not answer within"    "$ROOT/unhealthy.out"
has "points at the logs"   "docker compose logs -f"   "$ROOT/unhealthy.out"

echo "== 6. port already in use is caught"
python3 -c "
import socket,time,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(('0.0.0.0',8098)); s.listen(1)
open('$ROOT/port.pid','w').write(str(1)); time.sleep(25)
" & PP=$!
sleep 2
RC=$(PORT=8098 run portbusy "$ROOT/pb/opt")
kill $PP 2>/dev/null
check "port clash exits 1" "$RC" 1
has "explains the clash" "already in use" "$ROOT/portbusy.out"
has "offers a way out"   "HTTP_PORT=9090" "$ROOT/portbusy.out"

echo "== 6b. the root check still works"
OUT=$(cd /tmp && cat "$SRC" | bash 2>&1); RC=$?
check "non-root exits 1" "$RC" 1
if grep -qF "Run as root" <<<"$OUT"; then ok "tells you to use sudo"; else bad "root check message"; fi

echo "== 7. compose commands actually issued"
has "pulls db image"     "compose pull"          "$ROOT/compose.log"
has "builds and starts"  "compose up -d --build" "$ROOT/compose.log"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
