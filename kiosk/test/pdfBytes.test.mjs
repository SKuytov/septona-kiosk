// Unit-test the byte validator against every real document, plus the corruption modes
// that produced the "document could not be opened" fault on the panel.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const SEED = '/home/user/workspace/septona-kiosk/kiosk/public/seed';
const out = '/tmp/pdfBytes.mjs';
await build({
  entryPoints: ['/home/user/workspace/septona-kiosk/kiosk/src/lib/pdfBytes.ts'],
  outfile: out, format: 'esm', bundle: false, logLevel: 'silent',
});
const { checkPdf } = await import(out + '?v=' + Date.now());

const manifest = JSON.parse(fs.readFileSync(path.join(SEED, 'manifest.json'), 'utf8'));
const buf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  cond ? pass++ : fail++;
};

// 1. Every genuine document must be accepted, checked against its manifest length.
let accepted = 0, rejected = [];
for (const d of manifest.documents) {
  const b = fs.readFileSync(path.join(SEED, `${d.versionId}.pdf`));
  const r = checkPdf(buf(b), d.sizeBytes);
  r.ok ? accepted++ : rejected.push(`${d.titleBg || d.titleEn}: ${r.reason}`);
}
t(`all ${manifest.documents.length} real documents accepted`, accepted === manifest.documents.length,
  rejected.length ? rejected.slice(0, 3).join(' | ') : `${accepted} accepted`);

// 2. Truncation — the failure mode that matters. Must be rejected for every document.
let caught = 0, missed = [];
for (const d of manifest.documents) {
  const b = fs.readFileSync(path.join(SEED, `${d.versionId}.pdf`));
  const r = checkPdf(buf(b.subarray(0, Math.floor(b.length / 2))), d.sizeBytes);
  r.ok ? missed.push(d.versionId) : caught++;
}
t(`truncation caught for all ${manifest.documents.length} documents`, missed.length === 0,
  missed.length ? `missed ${missed.length}` : 'all rejected');

// 3. Truncation with NO expected size (the trailer check must still catch it).
const sample = fs.readFileSync(path.join(SEED, `${manifest.documents[0].versionId}.pdf`));
t('truncation caught without an expected size',
  !checkPdf(buf(sample.subarray(0, Math.floor(sample.length / 2)))).ok);

// 4. An HTML error page served with status 200.
const html = Buffer.from('<!DOCTYPE html><html><body>' + 'x'.repeat(4000) + '</body></html>');
const htmlRes = checkPdf(buf(html));
t('HTML served instead of a PDF is rejected', !htmlRes.ok, htmlRes.reason);

// 5. Empty and tiny bodies.
t('empty body rejected', !checkPdf(new ArrayBuffer(0)).ok);
t('tiny body rejected', !checkPdf(buf(Buffer.alloc(200, 1))).ok);
t('null rejected', !checkPdf(null).ok);

// 6. A one-byte overlong stream must fail the exact-length check.
const padded = Buffer.concat([sample, Buffer.from([0])]);
t('extra trailing byte rejected against expected size',
  !checkPdf(buf(padded), manifest.documents[0].sizeBytes).ok);

// 7. Valid PDF whose header is corrupted.
const badHeader = Buffer.from(sample);
badHeader.write('%XDF-', 0);
t('corrupted header rejected', !checkPdf(buf(badHeader), sample.length).ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
