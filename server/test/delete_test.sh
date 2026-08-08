#!/usr/bin/env bash
# Deleting a document from the admin platform, end to end against a real server.
#
# The point of these checks is not that the endpoint returns 200. It is:
#   - an archived document leaves the kiosk manifest but keeps its versions and audit trail;
#   - a restored document comes back;
#   - a permanently deleted document takes its PDF files off the disk, which it did not do
#     before this change: the rows went and the files stayed readable forever;
#   - a blob shared by two documents survives the deletion of one of them, because storage is
#     content-addressed and the bytes are shared;
#   - an editor cannot delete, an admin can;
#   - every one of these leaves a line in the audit trail.
set -uo pipefail

BASE=${BASE:-http://127.0.0.1:8090}
DATA_DIR=${DATA_DIR:-/tmp/septona-data}
pass=0; fail=0
ok() { if [ "$2" = "1" ]; then pass=$((pass+1)); echo "  PASS  $1${3:+ — $3}"; else fail=$((fail+1)); echo "  FAIL  $1${3:+ — $3}"; fi; }
# Reads a dotted path out of a JSON body on stdin.
#
# Written to a temporary file rather than fed to python as a here-doc: a here-doc IS stdin, so
# the script would eat the JSON it was meant to read and every check in this file would come
# back empty. Which is exactly what happened the first time.
JQR=$(mktemp /tmp/septona-jqr-XXXXXX.py)
trap 'rm -f "$JQR"' EXIT
cat > "$JQR" <<'PYEOF'
import json, os, sys
try:
    node = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for part in os.environ['SEPTONA_PATH'].split('.'):
    if not part:
        continue
    try:
        node = node[part] if isinstance(node, dict) else node[int(part)]
    except (KeyError, IndexError, ValueError, TypeError):
        sys.exit(1)
print('' if node is None else node)
PYEOF
jqr() { SEPTONA_PATH="$1" python3 "$JQR" 2>/dev/null; }

echo "== signing in"
ADMIN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@septona.local","password":"septona-admin"}' | jqr token)
[ -n "$ADMIN" ] && ok "administrator signed in" 1 || ok "administrator signed in" 0
A=(-H "Authorization: Bearer $ADMIN")

# A throwaway category and two documents that share identical bytes.
CAT=$(curl -s "${A[@]}" -X POST "$BASE/api/categories" -H 'Content-Type: application/json' \
  -d '{"nameBg":"Тест изтриване","nameEn":"Delete test","icon":"doc","colour":"#2E8BC9"}' | jqr category.id)
ok "a test category was created" "$([ -n "$CAT" ] && echo 1 || echo 0)" "$CAT"

PDF=/tmp/del-a.pdf
python3 - "$PDF" "$$-$(date +%s)" <<'PYEOF'
import sys
# The smallest valid one-page PDF, written by hand so the test needs no fixture file.
#
# The comment carries a per-run token on purpose. Storage is content-addressed, so a fixed
# fixture would hash to the same blob every run and the last-owner purge check would find the
# leftovers of the previous run still pointing at it — the test would fail while the code was
# correct. Which is what happened.
open(sys.argv[1], 'wb').write(("""%%PDF-1.4
%% septona-delete-test %s
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%%%EOF
""" % sys.argv[2]).encode())
PYEOF
cp "$PDF" /tmp/del-b.pdf   # identical bytes: same sha256, one shared blob on disk

mk() { # mk <title> <file> -> document id
  curl -s "${A[@]}" -X POST "$BASE/api/documents" \
    -F "file=@$2;type=application/pdf" \
    -F "meta={\"categoryId\":\"$CAT\",\"titleBg\":\"$1\",\"titleEn\":\"$1\",\"language\":\"bg\"}" \
    "$BASE/api/documents?allowDuplicate=true" 2>/dev/null | jqr document.id
}
DOC_A=$(curl -s "${A[@]}" -X POST "$BASE/api/documents?allowDuplicate=true" \
  -F "file=@/tmp/del-a.pdf;type=application/pdf" \
  -F "meta={\"categoryId\":\"$CAT\",\"titleBg\":\"Документ А\",\"titleEn\":\"Doc A\",\"language\":\"bg\"}" | jqr document.id)
DOC_B=$(curl -s "${A[@]}" -X POST "$BASE/api/documents?allowDuplicate=true" \
  -F "file=@/tmp/del-b.pdf;type=application/pdf" \
  -F "meta={\"categoryId\":\"$CAT\",\"titleBg\":\"Документ Б\",\"titleEn\":\"Doc B\",\"language\":\"bg\"}" | jqr document.id)
# The manifest is what a panel sees, and it is only reachable with a device key, so the test
# registers its own throwaway display rather than asserting against an error body.
DEV=$(curl -s "${A[@]}" -X POST "$BASE/api/devices" -H 'Content-Type: application/json' \
  -d '{"name":"Тест изтриване","location":"тест"}')
DEVKEY=$(echo "$DEV" | jqr key); DEVID=$(echo "$DEV" | jqr device.id)
ok "a test device key was issued" "$([ -n "$DEVKEY" ] && echo 1 || echo 0)"
manifest() { curl -s -H "X-Device-Key: $DEVKEY" "$BASE/api/kiosk/manifest"; }
ok "the manifest is readable with that key" \
  "$([ -n "$(manifest | jqr manifestVersion)" ] && echo 1 || echo 0)"

ok "two documents were uploaded" "$([ -n "$DOC_A" ] && [ -n "$DOC_B" ] && echo 1 || echo 0)" "$DOC_A / $DOC_B"

SHA=$(curl -s "${A[@]}" "$BASE/api/documents/$DOC_A" | jqr document.sha256)
BLOB="$DATA_DIR/files/${SHA:0:2}/${SHA:2:2}/$SHA.pdf"
ok "the uploaded bytes are on disk" "$([ -f "$BLOB" ] && echo 1 || echo 0)" "$BLOB"
ok "both documents point at the same blob" \
  "$([ "$(curl -s "${A[@]}" "$BASE/api/documents/$DOC_B" | jqr document.sha256)" = "$SHA" ] && echo 1 || echo 0)"

echo
echo "== archiving (the default, reversible)"
MV_BEFORE=$(manifest | jqr manifestVersion)
IN_LIST() { curl -s "${A[@]}" "$BASE/api/documents?pageSize=200${2:-}" | grep -c "\"$1\"" ; }
ok "the document is in the live list before archiving" "$([ "$(IN_LIST "$DOC_A")" -ge 1 ] && echo 1 || echo 0)"

R=$(curl -s "${A[@]}" -X DELETE "$BASE/api/documents/$DOC_A")
ok "archiving is accepted" "$([ "$(echo "$R" | jqr ok)" = "True" ] && echo 1 || echo 0)" "$R"
ok "it reports that it was not permanent" "$([ "$(echo "$R" | jqr hard)" = "False" ] && echo 1 || echo 0)"
ok "and it does not claim it removed files" "$([ "$(echo "$R" | jqr filesRemoved)" = "" ] && echo 1 || echo 0)" "$R"
ok "it leaves the live list" "$([ "$(IN_LIST "$DOC_A")" -eq 0 ] && echo 1 || echo 0)"
ok "it appears in the archive view" "$([ "$(IN_LIST "$DOC_A" "&deleted=only")" -ge 1 ] && echo 1 || echo 0)"
ok "the other document is not in the archive view" \
  "$([ "$(IN_LIST "$DOC_B" "&deleted=only")" -eq 0 ] && echo 1 || echo 0)"
ok "the archived document still opens for an administrator" \
  "$([ "$(curl -s "${A[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/documents/$DOC_A")" = "200" ] && echo 1 || echo 0)"
ok "its PDF is still on disk" "$([ -f "$BLOB" ] && echo 1 || echo 0)"
ok "it is gone from the kiosk manifest" \
  "$([ "$(manifest | grep -c "\"$DOC_A\"")" -eq 0 ] && echo 1 || echo 0)"
MV_AFTER=$(manifest | jqr manifestVersion)
ok "the manifest version was bumped so panels notice" \
  "$([ "$MV_AFTER" -gt "$MV_BEFORE" ] 2>/dev/null && echo 1 || echo 0)" "$MV_BEFORE -> $MV_AFTER"
ok "archiving is in the audit trail" \
  "$([ "$(curl -s "${A[@]}" "$BASE/api/audit?pageSize=20" | grep -c 'Архивиран документ')" -ge 1 ] && echo 1 || echo 0)"

echo
echo "== restoring"
curl -s "${A[@]}" -X POST "$BASE/api/documents/$DOC_A/restore" > /dev/null
ok "the restored document is back in the live list" "$([ "$(IN_LIST "$DOC_A")" -ge 1 ] && echo 1 || echo 0)"
ok "and back in the kiosk manifest" \
  "$([ "$(manifest | grep -c "\"$DOC_A\"")" -ge 1 ] && echo 1 || echo 0)"
ok "restoring names the document in the audit trail" \
  "$([ "$(curl -s "${A[@]}" "$BASE/api/audit?pageSize=20" | grep -c 'Възстановен от архива документ')" -ge 1 ] && echo 1 || echo 0)"

echo
echo "== permanent deletion of one of two documents sharing a blob"
R=$(curl -s "${A[@]}" -X DELETE "$BASE/api/documents/$DOC_A?hard=true")
ok "permanent deletion is accepted" "$([ "$(echo "$R" | jqr ok)" = "True" ] && echo 1 || echo 0)" "$R"
ok "it reports that it was permanent" "$([ "$(echo "$R" | jqr hard)" = "True" ] && echo 1 || echo 0)"
ok "no file was removed, because the other document holds the same bytes" \
  "$([ "$(echo "$R" | jqr filesRemoved)" = "0" ] && echo 1 || echo 0)" "filesRemoved=$(echo "$R" | jqr filesRemoved)"
ok "the shared blob survives" "$([ -f "$BLOB" ] && echo 1 || echo 0)"
ok "the document is gone entirely" \
  "$([ "$(curl -s "${A[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/documents/$DOC_A")" = "404" ] && echo 1 || echo 0)"
ok "it is not in the archive view either" "$([ "$(IN_LIST "$DOC_A" "&deleted=only")" -eq 0 ] && echo 1 || echo 0)"
ok "the surviving document still opens" \
  "$([ "$(curl -s "${A[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/documents/$DOC_B")" = "200" ] && echo 1 || echo 0)"
ok "its file is still readable" \
  "$([ "$(curl -s "${A[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/documents/$DOC_B/versions/$(curl -s "${A[@]}" "$BASE/api/documents/$DOC_B" | jqr document.versionId)/file")" = "200" ] && echo 1 || echo 0)"

echo
echo "== permanent deletion of the last document holding the blob"
R=$(curl -s "${A[@]}" -X DELETE "$BASE/api/documents/$DOC_B?hard=true")
ok "one file was removed from the disk" "$([ "$(echo "$R" | jqr filesRemoved)" = "1" ] && echo 1 || echo 0)" "$R"
ok "the PDF is really gone from the disk" "$([ ! -f "$BLOB" ] && echo 1 || echo 0)" "$BLOB"
ok "the empty directory it lived in was pruned" \
  "$([ ! -d "$DATA_DIR/files/${SHA:0:2}/${SHA:2:2}" ] && echo 1 || echo 0)"
ok "permanent deletion is in the audit trail with a file count" \
  "$([ "$(curl -s "${A[@]}" "$BASE/api/audit?pageSize=20" | grep -c 'Окончателно изтрит документ')" -ge 1 ] && echo 1 || echo 0)"
ok "and the audit entry survives the document it describes" \
  "$([ "$(curl -s "${A[@]}" "$BASE/api/audit?pageSize=50" | grep -c "$DOC_B")" -ge 1 ] && echo 1 || echo 0)"

echo
echo "== who is allowed to delete"
# Throwaway accounts, so the test does not depend on which demo users a given database happens
# to have been seeded with.
STAMP=$$
TEST_USERS=""
for role in editor viewer; do
  UID_=$(curl -s "${A[@]}" -X POST "$BASE/api/users" -H 'Content-Type: application/json' \
    -d "{\"email\":\"del-$role-$STAMP@septona.local\",\"password\":\"test-passw0rd\",\"name\":\"Тест $role\",\"role\":\"$role\"}" | jqr user.id)
  TEST_USERS="$TEST_USERS $UID_"
done
DOC_C=$(curl -s "${A[@]}" -X POST "$BASE/api/documents?allowDuplicate=true" \
  -F "file=@/tmp/del-a.pdf;type=application/pdf" \
  -F "meta={\"categoryId\":\"$CAT\",\"titleBg\":\"Документ В\",\"titleEn\":\"Doc C\",\"language\":\"bg\"}" | jqr document.id)
for role in editor viewer; do
  TOK=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"del-$role-$STAMP@septona.local\",\"password\":\"test-passw0rd\"}" | jqr token)
  ok "the $role account signed in" "$([ -n "$TOK" ] && echo 1 || echo 0)"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" -X DELETE "$BASE/api/documents/$DOC_C")
  ok "an $role cannot archive a document" "$([ "$CODE" = "403" ] && echo 1 || echo 0)" "HTTP $CODE"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" -X DELETE "$BASE/api/documents/$DOC_C?hard=true")
  ok "an $role cannot permanently delete a document" "$([ "$CODE" = "403" ] && echo 1 || echo 0)" "HTTP $CODE"
done
ok "and the document survived every refused attempt" "$([ "$(IN_LIST "$DOC_C")" -ge 1 ] && echo 1 || echo 0)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ADMIN" -X DELETE "$BASE/api/documents/$DOC_C?hard=true")
ok "the administrator can" "$([ "$CODE" = "200" ] && echo 1 || echo 0)" "HTTP $CODE"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/documents/$DOC_B")
ok "an unauthenticated request cannot delete anything" "$([ "$CODE" = "401" ] && echo 1 || echo 0)" "HTTP $CODE"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "${A[@]}" -X DELETE "$BASE/api/documents/doc_does_not_exist")
ok "deleting something that is not there is a 404, not a 500" "$([ "$CODE" = "404" ] && echo 1 || echo 0)" "HTTP $CODE"

# Leave the database as the test found it: the throwaway category, display and accounts all go.
curl -s "${A[@]}" -X DELETE "$BASE/api/categories/$CAT" > /dev/null
# The devices API revokes rather than deletes, by design — a display's history has to survive
# it — so this leaves one revoked "Тест изтриване" row behind per run. Harmless, but worth
# knowing before someone wonders why the devices page has a column of them.
if [ -n "${DEVID:-}" ]; then curl -s "${A[@]}" -X DELETE "$BASE/api/devices/$DEVID" > /dev/null; fi
for uid in ${TEST_USERS:-}; do curl -s "${A[@]}" -X DELETE "$BASE/api/users/$uid" > /dev/null; done
rm -f /tmp/del-a.pdf /tmp/del-b.pdf

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
