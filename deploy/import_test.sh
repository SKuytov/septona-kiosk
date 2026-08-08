#!/usr/bin/env bash
# Exercises deploy/import-docs.sh against the real KIOSK_DOCS.zip, with Docker shimmed.
set -uo pipefail

SRC=/home/user/workspace/septona-kiosk/deploy/import-docs.sh
ZIP=/home/user/workspace/uploaded_attachments/9d9c171887a544cc86a471f5bcc00825/KIOSK_DOCS.zip
ROOT=/tmp/imptest
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }
has()  { if grep -qF -- "$2" "$3"; then ok "$1"; else bad "$1 — missing '$2'"; fi; }
hasnt(){ if grep -qF -- "$2" "$3"; then bad "$1 — unexpected '$2'"; else ok "$1"; fi; }

rm -rf "$ROOT"; mkdir -p "$ROOT/bin"
BIN="$ROOT/bin"

cat > "$BIN/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "$ROOT/docker.log"
if [ "\${2:-}" = ps ]; then
  [ "\${RUNNING:-1}" = 1 ] && echo server
  exit 0
fi
if [ "\${2:-}" = cp ]; then
  # record what would be copied
  echo "\$3" > "$ROOT/copied_from"
  find "\$3" -type f | wc -l > "$ROOT/copied_count"
  ( cd "\$3" && find . -mindepth 1 -maxdepth 2 -type d ) > "$ROOT/copied_dirs"
  exit 0
fi
exit 0
EOF
cat > "$BIN/hostname" <<'EOF'
#!/usr/bin/env bash
echo "192.168.0.160 "
EOF
chmod +x "$BIN"/*

INST="$ROOT/opt"; mkdir -p "$INST"; echo "HTTP_PORT=8080" > "$INST/.env"

run() { ( export PATH="$BIN:$PATH" INSTALL_DIR="$INST" ${2:+RUNNING=$2}
          cd /tmp && bash "$SRC" $1 ) > "$ROOT/out" 2>&1; echo $?; }

echo "== 1. bad input is rejected clearly"
RC=$(run ""); check "no argument exits 1" "$RC" 1; has "shows usage" "Usage:" "$ROOT/out"
RC=$(run "/tmp/nope.zip"); check "missing file exits 1" "$RC" 1; has "says not found" "No such file" "$ROOT/out"
echo hi > "$ROOT/x.txt"
RC=$(run "$ROOT/x.txt"); check "non-zip exits 1" "$RC" 1; has "explains input" "Expected a .zip" "$ROOT/out"

echo "== 2. a stopped stack is caught before any work"
RC=$(run "$ZIP" 0); check "stopped stack exits 1" "$RC" 1
has "names the fix" "docker compose up -d" "$ROOT/out"

echo "== 3. the real archive"
: > "$ROOT/docker.log"
RC=$(run "$ZIP" 1)
check "exits 0" "$RC" 0
has "confirms stack up"   "server is up"          "$ROOT/out"
has "unpacks"             "Unpacking the archive" "$ROOT/out"
has "counts 4 categories" "4 categories"          "$ROOT/out"
has "counts 49 PDFs"      "49 PDF"                "$ROOT/out"
has "counts 6 Office"     "6 Office"              "$ROOT/out"
has "copies in"           "Copying into"          "$ROOT/out"
has "imports"             "==> Importing"         "$ROOT/out"
has "reports finished"    "Import finished"       "$ROOT/out"
has "prints the URL"      "http://192.168.0.160:8080/" "$ROOT/out"
check "copied all 55 documents" "$(cat "$ROOT/copied_count")" 55

echo "== 4. the right docker commands, in order"
has "checks running services" "compose ps --status running" "$ROOT/docker.log"
has "clears stale copy"       "rm -rf /tmp/import-docs"    "$ROOT/docker.log"
has "copies to the service"   "server:/tmp/import-docs"    "$ROOT/docker.log"
has "runs the importer"       "node scripts/import-archive.js /tmp/import-docs" "$ROOT/docker.log"
if [ "$(grep -c 'rm -rf /tmp/import-docs' "$ROOT/docker.log")" -eq 2 ]; then ok "cleans up afterwards"; else bad "no cleanup after import"; fi

echo "== 5. Cyrillic category names survive extraction"
for c in "Планове евакуация" "Политики" "Постоянно видими" "ОСНОВНО УПЪТВАНЕ"; do
  if grep -qxF "./$c" "$ROOT/copied_dirs"; then ok "category '$c'"; else bad "category '$c' missing after unzip"; fi
done
if grep -qxF "./Политики/POLICIES_PDF_SIGNED_BG" "$ROOT/copied_dirs"; then ok "language subfolder preserved"; else bad "language subfolder lost"; fi

echo "== 6. a folder works as well as a zip"
rm -rf "$ROOT/tree"; mkdir -p "$ROOT/tree"
unzip -q -O UTF-8 "$ZIP" -d "$ROOT/tree"
RC=$(run "$ROOT/tree" 1)
check "folder input exits 0" "$RC" 0
has "uses the folder"    "Using folder" "$ROOT/out"
has "same category count" "4 categories" "$ROOT/out"

echo "== 7. a zip with a wrapper folder is unwrapped"
rm -rf "$ROOT/wrap"; mkdir -p "$ROOT/wrap/KIOSK_DOCS"
cp -r "$ROOT/tree/." "$ROOT/wrap/KIOSK_DOCS/"
RC=$(run "$ROOT/wrap" 1)
check "wrapper input exits 0" "$RC" 0
has "descends"            "descending into wrapper" "$ROOT/out"
has "finds 4 categories"  "4 categories"            "$ROOT/out"

echo "== 7b. a mistyped filename names the real one"
# Reported: `import-docs.sh ~/KIOSK_DOCS.zip` when the file is KIOSK_DOCS_.zip.
TD="$ROOT/typo"; mkdir -p "$TD"
cp "$ZIP" "$TD/KIOSK_DOCS_.zip"; : > "$TD/unrelated.zip"
OUT="$ROOT/typo.out"
bash "$SRC" "$TD/KIOSK_DOCS.zip" > "$OUT" 2>&1; RC=$?
check "mistyped name exits 1" "$RC" 1
has "repeats what was asked for" "KIOSK_DOCS.zip" "$OUT"
has "names the real file"       "KIOSK_DOCS_.zip" "$OUT"
has "lists the other archive"   "unrelated.zip" "$OUT"

echo "== 7c. no hint when there is nothing to suggest"
ED="$ROOT/nozips"; mkdir -p "$ED"
bash "$SRC" "$ED/missing.zip" > "$ROOT/nozips.out" 2>&1 || true
hasnt "no empty archive list" "Archives found" "$ROOT/nozips.out"
bash "$SRC" "/definitely/not/here.zip" > "$ROOT/nodir.out" 2>&1 || true
has "still reports the path" "not/here.zip" "$ROOT/nodir.out"

echo "== 8. an empty folder is refused"
mkdir -p "$ROOT/empty/sub"
RC=$(run "$ROOT/empty" 1); check "empty exits 1" "$RC" 1; has "says no documents" "No documents found" "$ROOT/out"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
