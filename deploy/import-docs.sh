#!/usr/bin/env bash
#
# Septona Kiosk — load an initial document set into a running installation.
#
#   sudo bash /opt/septona-kiosk/deploy/import-docs.sh ~/KIOSK_DOCS.zip
#   sudo bash /opt/septona-kiosk/deploy/import-docs.sh /path/to/extracted/folder
#
# Top-level folders become categories. Folders named *_BG / *_ENG inside them are not
# subcategories: their documents are tagged with that language instead.
#
# Safe to re-run: documents are content-addressed, so importing the same archive twice
# does not create duplicates.

set -euo pipefail

on_error() {
  local rc=$1 line=$2 cmd=$3
  printf '\n\033[31m !! Import stopped at line %s (exit %s)\033[0m\n' "$line" "$rc" >&2
  printf '\033[31m    while running: %s\033[0m\n\n' "$cmd" >&2
  exit "$rc"
}
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

INSTALL_DIR="${INSTALL_DIR:-/opt/septona-kiosk}"
SERVICE="${SERVICE:-server}"

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=''; G=''; R=''; D=''; N=''
fi
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$1" "$N"; }
info() { printf '    %s\n' "$1"; }
die()  { printf '\n%s !! %s%s\n\n' "$R" "$1" "$N" >&2; exit 1; }

SOURCE="${1:-}"
[ -n "$SOURCE" ] || die "Usage: sudo bash $0 <KIOSK_DOCS.zip | folder>"
[ -e "$SOURCE" ] || die "No such file or folder: $SOURCE"
[ -d "$INSTALL_DIR" ] || die "Installation not found at $INSTALL_DIR. Set INSTALL_DIR=…"

cd "$INSTALL_DIR"
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Run deploy/install.sh first."

step "Checking the stack is running"
if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$SERVICE"; then
  die "The '$SERVICE' container is not running. Start it with:  cd $INSTALL_DIR && docker compose up -d"
fi
info "$SERVICE is up"

# --------------------------------------------------------------------- unpack
WORK=""
# Must always succeed: a trap that ends non-zero would override the script's
# own exit status and report a successful import as a failure.
cleanup() { if [ -n "$WORK" ]; then rm -rf "$WORK"; fi; return 0; }
trap cleanup EXIT

if [ -d "$SOURCE" ]; then
  TREE="${SOURCE%/}"
  step "Using folder"
else
  case "${SOURCE,,}" in
    *.zip) ;;
    *) die "Expected a .zip archive or a folder, got: $SOURCE" ;;
  esac
  step "Unpacking the archive"
  if ! command -v unzip >/dev/null 2>&1; then
    info "installing unzip…"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip
  fi
  WORK="$(mktemp -d)"
  # -O CP852 would mangle these names; the archive stores UTF-8 Cyrillic.
  unzip -q -O UTF-8 "$SOURCE" -d "$WORK/tree" 2>/dev/null \
    || unzip -q "$SOURCE" -d "$WORK/tree"
  TREE="$WORK/tree"
fi

# An archive zipped from a parent folder arrives as one wrapper directory. Descend
# into it, otherwise the whole set would import as a single category.
DEPTH_ENTRIES=$(find "$TREE" -mindepth 1 -maxdepth 1 | wc -l)
if [ "$DEPTH_ENTRIES" -eq 1 ]; then
  ONLY="$(find "$TREE" -mindepth 1 -maxdepth 1)"
  if [ -d "$ONLY" ] && [ -z "$(find "$ONLY" -maxdepth 1 -type f -print -quit)" ]; then
    info "descending into wrapper folder: $(basename "$ONLY")"
    TREE="$ONLY"
  fi
fi

# Mirrors the extensions scripts/import-archive.js accepts: PDFs are stored as they
# are, Office files are converted by LibreOffice inside the container.
PDF_COUNT=$(find "$TREE" -type f -iname '*.pdf' | wc -l)
OFFICE_COUNT=$(find "$TREE" -type f \( -iname '*.doc' -o -iname '*.docx' -o -iname '*.xls' \
  -o -iname '*.xlsx' -o -iname '*.ods' -o -iname '*.odt' -o -iname '*.ppt' -o -iname '*.pptx' \) | wc -l)
CAT_COUNT=$(find "$TREE" -mindepth 1 -maxdepth 1 -type d | wc -l)
[ $((PDF_COUNT + OFFICE_COUNT)) -gt 0 ] || die "No documents found under $TREE"
if [ "$OFFICE_COUNT" -gt 0 ]; then
  info "$CAT_COUNT categories, $PDF_COUNT PDF and $OFFICE_COUNT Office files (converted on import)"
else
  info "$CAT_COUNT categories, $PDF_COUNT PDF files"
fi

# ---------------------------------------------------------------- copy + import
step "Copying into the container"
docker compose exec -T "$SERVICE" rm -rf /tmp/import-docs
docker compose cp "$TREE" "$SERVICE:/tmp/import-docs"
info "copied to /tmp/import-docs"

step "Importing"
docker compose exec -T "$SERVICE" node scripts/import-archive.js /tmp/import-docs
docker compose exec -T "$SERVICE" rm -rf /tmp/import-docs

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<server-ip>"
PORT="$(grep -E '^HTTP_PORT=' .env 2>/dev/null | cut -d= -f2- || true)"
[ -n "$PORT" ] || PORT=8080

cat <<EOF

${G}${B}  Import finished.${N}

  ${B}Check the result${N}   http://${IP}:${PORT}/
  ${D}The panels pick the new documents up at their next sync.${N}

EOF
