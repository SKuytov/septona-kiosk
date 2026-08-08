"""Seeds a throwaway category with three documents so the interface test has something to
delete without touching the real Septona policies."""
import json
import subprocess
import sys
import time
import urllib.request

BASE = 'http://127.0.0.1:8090'


def call(path, data=None, token=None, method=None):
    req = urllib.request.Request(BASE + path, method=method or ('POST' if data else 'GET'))
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, body) as r:
        return json.load(r)


token = call('/api/auth/login', {'email': 'admin@septona.local', 'password': 'septona-admin'})['token']
# Clear anything a previous run left behind, so the test always starts from three documents.
existing = call('/api/categories', token=token)
for c in existing['categories']:
    if c.get('nameBg') == 'UI тест изтриване':
        docs = call('/api/documents?pageSize=200&deleted=include', token=token)
        for d in docs['documents']:
            if d.get('categoryId') == c['id']:
                call('/api/documents/%s?hard=true' % d['id'], token=token, method='DELETE')
        call('/api/categories/' + c['id'], token=token, method='DELETE')

cat = call('/api/categories', {'nameBg': 'UI тест изтриване', 'nameEn': 'UI delete test',
                               'icon': 'doc', 'colour': '#2E8BC9'}, token)['category']['id']
print('category', cat)

PDF = """%%PDF-1.4
%% ui-delete-test %s
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%%%EOF
"""

for n in (1, 2, 3):
    path = f'/tmp/ui-{n}.pdf'
    # A unique token per file: content-addressed storage would otherwise give all three the
    # same blob, and the purge test would then be checking the wrong thing.
    open(path, 'wb').write((PDF % f'{n}-{time.time()}').encode())
    meta = json.dumps({'categoryId': cat, 'titleBg': f'UI тест документ {n}',
                       'titleEn': f'UI test doc {n}', 'language': 'bg'}, ensure_ascii=False)
    out = subprocess.run(['curl', '-s', '-H', 'Authorization: Bearer ' + token,
                          '-X', 'POST', f'{BASE}/api/documents?allowDuplicate=true',
                          '-F', f'file=@{path};type=application/pdf',
                          '-F', 'meta=' + meta], capture_output=True, text=True).stdout
    print(n, out[:120])

open('/tmp/uicat', 'w').write(cat)
