#!/usr/bin/env bash
#
# Септона Киоск — публикуване на управляващата платформа в интернет.
#
#   sudo bash /opt/septona-kiosk/deploy/setup-tunnel.sh
#
# Свързва платформата към Cloudflare Tunnel: сървърът сам набира изход към Cloudflare и
# трафикът се връща по същата връзка. Затова НЕ се отваря нито един входящ порт на
# рутера или на защитната стена, а адресът е на ваш домейн с истински сертификат —
# такъв, който FortiGate няма основание да блокира.
#
# Скриптът е безопасен за повторно изпълнение: сменя токена или адреса и рестартира.

set -euo pipefail

on_error() {
  printf '\n\033[31m !! Спряно на ред %s (код %s)\033[0m\n' "$2" "$1" >&2
  printf '\033[31m    команда: %s\033[0m\n\n' "$3" >&2
  exit "$1"
}
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

INSTALL_DIR="${INSTALL_DIR:-/opt/septona-kiosk}"

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=''; G=''; Y=''; R=''; D=''; N=''
fi
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$1" "$N"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '%s !! %s%s\n' "$Y" "$1" "$N"; }
die()  { printf '\n%s !! %s%s\n\n' "$R" "$1" "$N" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Стартирайте с sudo:  sudo bash $0"
[ -f "${INSTALL_DIR}/.env" ] || die "Не намирам ${INSTALL_DIR}/.env — инсталирайте платформата първо."
cd "$INSTALL_DIR"

# Записва или подменя един ключ в .env, без да пипа останалите.
set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    # Стойността може да съдържа / и &, затова разделителят е знак, който не се среща
    # в токен или в домейн.
    python3 - "$key" "$val" <<'PY'
import sys, io
key, val = sys.argv[1], sys.argv[2]
lines = open('.env', encoding='utf-8').read().split('\n')
out = [f'{key}={val}' if l.startswith(key + '=') else l for l in lines]
open('.env', 'w', encoding='utf-8').write('\n'.join(out))
PY
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

read_env() { grep -E "^$1=" .env 2>/dev/null | cut -d= -f2- || true; }

cat <<EOF

${B}  Публикуване на управляващата платформа${N}
${D}  Преди да продължите, направете следното в Cloudflare (безплатно):

    1. Създайте акаунт на https://dash.cloudflare.com и добавете домейна си.
       Cloudflare ще ви даде два nameserver-а — въведете ги при регистратора
       (Hostinger / SuperHosting), на мястото на текущите. Изчакайте да стане Active.

    2. Отворете Zero Trust > Networks > Tunnels > Create a tunnel > Cloudflared.
       Дайте име (например septona-kiosk) и НАТИСНЕТЕ Save.

    3. На екрана с инсталационните команди копирайте само дългия токен —
       това е стойността след «--token» (започва с eyJ...).

    4. В раздела Public Hostname на тунела добавете:
         Subdomain: docs        Domain: вашият домейн
         Service:   HTTP        URL: server:8080
       Запишете.
${N}
EOF

step "Данни за тунела"
CURRENT_HOST="$(read_env PUBLIC_ORIGIN)"
[ -n "$CURRENT_HOST" ] && info "текущ адрес: $CURRENT_HOST"

if [ -n "${TUNNEL_TOKEN:-}" ]; then
  info "токенът е подаден през средата"
else
  printf '    Поставете токена от Cloudflare и натиснете Enter:\n    > '
  # Токенът е дълъг; -r пази обратните наклонени черти.
  read -r TUNNEL_TOKEN </dev/tty
fi
TUNNEL_TOKEN="$(printf '%s' "$TUNNEL_TOKEN" | tr -d '[:space:]')"
[ -n "$TUNNEL_TOKEN" ] || die "Без токен не мога да продължа."
# Токените на Cloudflare са base64 JSON и започват с eyJ. Проверката е мека, за да не
# се спъне, ако форматът се промени.
case "$TUNNEL_TOKEN" in
  eyJ*) ;;
  *) warn "Токенът не изглежда като този на Cloudflare (обикновено започва с eyJ). Продължавам." ;;
esac

if [ -n "${PUBLIC_HOSTNAME:-}" ]; then
  HOSTNAME_IN="$PUBLIC_HOSTNAME"
else
  printf '\n    Адресът, който въведохте като Public Hostname (напр. docs.example.com):\n    > '
  read -r HOSTNAME_IN </dev/tty
fi
HOSTNAME_IN="$(printf '%s' "$HOSTNAME_IN" | tr -d '[:space:]' | sed -E 's#^https?://##; s#/.*$##')"
[ -n "$HOSTNAME_IN" ] || die "Без адрес не мога да продължа."
grep -qE '^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' <<<"$HOSTNAME_IN" \
  || die "«$HOSTNAME_IN» не изглежда като домейн."

PUBLIC_ORIGIN="https://${HOSTNAME_IN}"

# ---------------------------------------------------------------- безопасност
# Публичен адрес с фабрична парола или с познат JWT ключ е отворена врата. Сървърът
# отказва да стартира в такъв случай — по-добре да го кажем сега, отколкото след като
# тунелът е вдигнат.
step "Проверка на тайните"
JWT_NOW="$(read_env JWT_SECRET)"
if [ -z "$JWT_NOW" ] || [ "${#JWT_NOW}" -lt 24 ] \
   || [ "$JWT_NOW" = "change-me-to-a-long-random-string" ]; then
  warn "JWT_SECRET е слаб или липсва — генерирам нов (всички ще бъдат отписани)."
  set_env JWT_SECRET "$(openssl rand -hex 32)"
  info "нов JWT_SECRET е записан"
else
  info "JWT_SECRET е достатъчно дълъг"
fi

# .env казва само какво е било зададено при инсталацията; истината е в базата. Питаме
# самата платформа, преди да сме пипнали каквото и да е — по-добре да откажем сега,
# отколкото да вдигнем тунел към панел с публично известна парола.
HTTP_PORT_PRE="$(read_env HTTP_PORT)"; [ -n "$HTTP_PORT_PRE" ] || HTTP_PORT_PRE=8080
FACTORY_CHECK="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST "http://127.0.0.1:${HTTP_PORT_PRE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@septona.local","password":"septona-admin"}' 2>/dev/null || true)"

if [ "$FACTORY_CHECK" = "200" ]; then
  cat <<EOF

${R}${B}  Спирам: администраторът още използва фабричната парола.${N}

  Тя е публично известна — на публичен адрес това е отворена врата, затова
  платформата няма да стартира с нея и не променям нищо в настройките.

  ${B}Направете това първо${N}
      1. Отворете http://$(hostname -I | awk '{print $1}'):${HTTP_PORT_PRE}/ от локалната мрежа.
      2. Влезте като admin@septona.local
      3. Сменете паролата (горе вдясно > Смяна на парола). Поне 12 знака.
      4. Стартирайте този скрипт отново.

EOF
  exit 1
elif [ "$FACTORY_CHECK" = "429" ]; then
  warn "Платформата ограничава опитите за вход в момента — не мога да проверя паролата."
  info "Ако администраторът още използва «septona-admin», сървърът ще откаже да стартира."
elif [ "$FACTORY_CHECK" = "401" ]; then
  info "фабричната парола вече не работи — добре"
else
  warn "Не мога да достигна платформата локално (код: ${FACTORY_CHECK:-няма отговор})."
  info "Продължавам, но проверете дневника, ако тунелът не се вдигне."
fi

step "Записване на настройките"
set_env PUBLIC_ORIGIN "$PUBLIC_ORIGIN"
set_env TUNNEL_TOKEN "$TUNNEL_TOKEN"
chmod 600 .env
info "PUBLIC_ORIGIN=$PUBLIC_ORIGIN"
info "TUNNEL_TOKEN записан в .env (права 600)"

step "Стартиране на платформата и тунела"
docker compose --profile tunnel up -d
HTTP_PORT="$(read_env HTTP_PORT)"; [ -n "$HTTP_PORT" ] || HTTP_PORT=8080

step "Изчакване"
LOCAL_OK=false
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${HTTP_PORT}/api/health" >/dev/null 2>&1; then
    LOCAL_OK=true; break
  fi
  sleep 2
done

if [ "$LOCAL_OK" != true ]; then
  warn "Платформата не отговаря локално. Последни редове от дневника:"
  docker compose logs --tail 30 server || true
  die "Отстранете горното и стартирайте скрипта отново."
fi
info "платформата отговаря локално"

# Проверката отвън е истинската: DNS записът се създава от Cloudflare и понякога се
# разпространява за минута-две.
PUBLIC_OK=false
for i in $(seq 1 45); do
  CODE="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 8 "${PUBLIC_ORIGIN}/api/health" 2>/dev/null || true)"
  if [ "$CODE" = "200" ]; then PUBLIC_OK=true; break; fi
  sleep 4
  if [ $((i % 8)) -eq 0 ]; then info "още чакам публичния адрес… ($((i * 4))s)"; fi
done

echo
if [ "$PUBLIC_OK" = true ]; then
  CERT="$(echo | openssl s_client -connect "${HOSTNAME_IN}:443" -servername "$HOSTNAME_IN" 2>/dev/null \
          | openssl x509 -noout -issuer -dates 2>/dev/null || true)"
  cat <<EOF
${G}${B}  Готово. Платформата е достъпна от всеки компютър.${N}

  ${B}Управляваща платформа${N}   ${PUBLIC_ORIGIN}/
  ${B}В локалната мрежа${N}       http://$(hostname -I | awk '{print $1}'):${HTTP_PORT}/

  ${B}Сертификат${N}
$(printf '%s\n' "$CERT" | sed 's/^/      /')

  ${D}Панелите в цеха продължават да работят по локалния адрес — нищо не се променя за тях.
  Дневник на тунела:   cd ${INSTALL_DIR} && docker compose logs -f cloudflared
  Спиране на тунела:   cd ${INSTALL_DIR} && docker compose stop cloudflared${N}

EOF
else
  warn "Тунелът е вдигнат, но ${PUBLIC_ORIGIN} още не отговаря."
  cat <<EOF

  ${B}Най-честите причини${N}
    • Public Hostname в Cloudflare сочи към друг адрес — трябва да е
      Service: HTTP, URL: ${B}server:8080${N}
    • Домейнът още не е Active в Cloudflare (nameserver-ите не са сменени).
    • DNS записът още се разпространява — изчакайте няколко минути и опитайте пак.

  ${D}Дневник на тунела:  cd ${INSTALL_DIR} && docker compose logs --tail 50 cloudflared${N}

EOF
fi
