// Every generated device key must authenticate against the kiosk API.
// The key alphabet is base64url, so ~40% of keys contain an underscore and ~40% a dash.
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ok   ' + m) };
const bad = (m) => { fail++; console.log('  FAIL ' + m) };

const jf = async (url, opts) => {
  const r = await fetch(url, opts);
  let b = null; try { b = await r.json() } catch {}
  return { status: r.status, body: b };
};

(async () => {
  const login = await jf(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@septona.local', password: 'septona-admin' })
  });
  if (!login.body?.token) { console.log('cannot sign in:', login.status, login.body); process.exit(1) }
  const auth = { authorization: `Bearer ${login.body.token}`, 'content-type': 'application/json' };
  ok('signed in as admin');

  const make = async (name) => {
    const r = await jf(`${BASE}/api/devices`, { method: 'POST', headers: auth, body: JSON.stringify({ name }) });
    if (r.status !== 201 || !r.body?.key) throw new Error('create failed: ' + JSON.stringify(r));
    return { key: r.body.key, id: r.body.device.id };
  };
  const manifest = (key) => jf(`${BASE}/api/kiosk/manifest`, { headers: { 'x-device-key': key } });

  // Enough keys that both an underscore and a dash are near-certain to appear.
  console.log('== every generated key authenticates');
  const N = 40;
  const made = [];
  for (let i = 0; i < N; i++) made.push(await make(`Ключ тест ${Date.now()}-${i}`));
  const withU = made.filter(d => d.key.slice(12).includes('_'));
  const withD = made.filter(d => d.key.slice(12).includes('-'));
  const plain = made.filter(d => !/[-_]/.test(d.key.slice(12)));
  console.log(`     ${N} keys: ${withU.length} contain "_", ${withD.length} contain "-", ${plain.length} neither`);
  if (withU.length > 0) ok('the sample includes keys with an underscore'); else bad('sample had no underscore key — rerun');

  let rejected = [];
  for (const d of made) {
    const r = await manifest(d.key);
    if (r.status !== 200) rejected.push({ key: d.key, status: r.status, code: r.body?.error?.code });
  }
  if (rejected.length === 0) ok(`all ${N} keys accepted by /api/kiosk/manifest`);
  else {
    bad(`${rejected.length}/${N} keys rejected`);
    rejected.slice(0, 3).forEach(r => console.log('       ', r.status, r.code, r.key));
  }

  console.log('== group results by key shape');
  const rate = (list) => {
    if (!list.length) return 'no samples';
    const badCount = list.filter(d => rejected.some(r => r.key === d.key)).length;
    return `${list.length - badCount}/${list.length} accepted`;
  };
  console.log(`     underscore keys: ${rate(withU)}`);
  console.log(`     dash keys:       ${rate(withD)}`);
  console.log(`     plain keys:      ${rate(plain)}`);
  if (withU.every(d => !rejected.some(r => r.key === d.key))) ok('underscore keys all work'); else bad('underscore keys rejected');
  if (withD.every(d => !rejected.some(r => r.key === d.key))) ok('dash keys all work'); else bad('dash keys rejected');

  console.log('== the exact key from the panel');
  const real = 'sk_f12f8891_iNyK_yRYuk7gZegouKi_VyskQ13AmHre';
  const r0 = await manifest(real);
  if (r0.status === 401) ok('an unknown key of that shape is refused, not crashed (401)');
  else bad('unexpected status for an unknown key: ' + r0.status);

  console.log('== surrounding whitespace is tolerated');
  const d1 = made[0];
  for (const [label, k] of [['trailing newline', d1.key + '\n'], ['leading space', ' ' + d1.key], ['both', ' ' + d1.key + ' ']]) {
    const r = await manifest(k);
    if (r.status === 200) ok(label + ' accepted'); else bad(label + ' rejected (' + r.status + ')');
  }

  console.log('== bad keys are still refused');
  for (const [label, k] of [
    ['empty', ''],
    ['wrong shape', 'not-a-key'],
    ['right shape, wrong secret', 'sk_' + d1.key.slice(3, 11) + '_' + 'x'.repeat(32)],
    ['wrong prefix', 'sk_00000000_' + d1.key.slice(12)],
    ['prefix only', 'sk_' + d1.key.slice(3, 11)],
    ['jwt instead of a key', login.body.token]
  ]) {
    const r = await manifest(k);
    if (r.status === 401) ok(label + ' → 401'); else bad(label + ' → ' + r.status + ' (expected 401)');
  }

  console.log('== a revoked key stops working');
  await jf(`${BASE}/api/devices/${d1.id}`, { method: 'DELETE', headers: auth });
  const rr = await manifest(d1.key);
  if (rr.status === 401) ok('revoked key → 401'); else bad('revoked key still works: ' + rr.status);

  console.log('== an accepted key records the heartbeat');
  const d2 = made[1];
  const hb = await jf(`${BASE}/api/kiosk/heartbeat`, {
    method: 'POST', headers: { 'x-device-key': d2.key, 'content-type': 'application/json' },
    body: JSON.stringify({ appVersion: '1.0.5', docsCached: 55, storageBytes: 12100000, manifestVersion: 14 })
  });
  if (hb.status < 300) ok('heartbeat accepted'); else bad('heartbeat rejected: ' + hb.status);
  const list = await jf(`${BASE}/api/devices`, { headers: auth });
  const row = (list.body?.devices || []).find(x => x.id === d2.id);
  if (row?.lastSeenAt) ok('lastSeenAt recorded'); else bad('lastSeenAt not recorded');
  if (row?.appVersion === '1.0.5') ok('appVersion recorded'); else bad('appVersion: ' + row?.appVersion);
  if (row?.lastManifestVersion === 14) ok('lastManifestVersion recorded'); else bad('lastManifestVersion: ' + row?.lastManifestVersion);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
