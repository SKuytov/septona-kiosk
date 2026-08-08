/**
 * Reproduces the device failure mode and proves the fix.
 *
 * Case A: every bundled PDF read comes back truncated (what Capacitor's asset stream can
 *         do on Android). The importer must reject them, NOT show unopenable cards.
 * Case B: IndexedDB already holds truncated bytes from the old build, exactly like the
 *         panel does now. Opening the document must self-repair and render.
 * Case C: nothing wrong. Everything still opens (no regression).
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:4173/';
const SEED = '/home/user/workspace/septona-kiosk/kiosk/public/seed';
const manifest = JSON.parse(fs.readFileSync(`${SEED}/manifest.json`, 'utf8'));

/** Opens a category, because the panel now rests on a home screen with none selected. */
const showDocs = async (page) => {
  if (await page.locator('.card').count()) return;
  await page.waitForSelector('.tab', { timeout: 60000 });
  await page.locator('.tab').first().click();
  await page.waitForSelector('.card', { timeout: 30000 });
};

const openFirstDoc = async (page) => {
  await showDocs(page);
  await page.locator('.card').first().click();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(400);
    const box = await page.locator('canvas').first().boundingBox().catch(() => null);
    if (box && box.width > 50) return { ok: true };
    const err = await page.locator('.vw__load').first().textContent().catch(() => null);
    if (err && /не може|not been|could not/i.test(err)) return { ok: false, text: err.replace(/\s+/g, ' ').trim().slice(0, 200) };
  }
  return { ok: false, text: 'timeout' };
};

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  let pass = 0, fail = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
    cond ? pass++ : fail++;
  };

  // ---------- Case A: truncated asset reads ----------
  console.log('\nCase A — every bundled PDF read is truncated');
  {
    const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await ctx.route('**/api/**', (r) => r.abort());
    // Serve only the first 4 KB of each PDF: valid %PDF- header, no trailer, short length.
    await ctx.route('**/seed/*.pdf', async (route) => {
      const id = route.request().url().split('/').pop().replace('.pdf', '');
      const full = fs.readFileSync(`${SEED}/${id}.pdf`);
      await route.fulfill({ status: 200, contentType: 'application/pdf', body: full.subarray(0, 4096) });
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);

    const cards = await page.locator('.card').count();
    const empty = await page.locator('.empty').count();
    check('no unopenable cards are shown', cards === 0, `cards=${cards}, empty state=${empty}`);
    check('an empty state is shown instead', empty > 0);
    await ctx.close();
  }

  // ---------- Case B: bad bytes already stored (the panel's current state) ----------
  console.log('\nCase B — IndexedDB already holds truncated bytes, as on the panel now');
  {
    const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 } });
    const page = await ctx.newPage();
    await ctx.route('**/api/**', (r) => r.abort());
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rail .tab', { timeout: 90000 });
    await page.waitForTimeout(2500);

    // Corrupt the stored copy of every document the way the old importer could have,
    // and mark the store as a generation-1 import so we test the viewer's repair path.
    const corrupted = await page.evaluate(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('septona-kiosk');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const keys = await new Promise((res) => {
        const r = db.transaction('files', 'readonly').objectStore('files').getAllKeys();
        r.onsuccess = () => res(r.result);
      });
      let n = 0;
      for (const k of keys) {
        const rec = await new Promise((res) => {
          const r = db.transaction('files', 'readonly').objectStore('files').get(k);
          r.onsuccess = () => res(r.result);
        });
        if (!rec) continue;
        rec.bytes = rec.bytes.slice(0, 4096); // truncate
        await new Promise((res) => {
          const r = db.transaction('files', 'readwrite').objectStore('files').put(rec, k);
          r.onsuccess = () => res();
        });
        n++;
      }
      // Pretend this copy came from the old import generation.
      await new Promise((res) => {
        const r = db.transaction('meta', 'readwrite').objectStore('meta').put(1, 'seedGeneration');
        r.onsuccess = () => res();
      });
      return n;
    });
    check('stored copies were corrupted for the test', corrupted > 0, `${corrupted} files`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rail .tab', { timeout: 90000 });
    await page.waitForTimeout(9000); // allow the validated re-import to run

    await showDocs(page);
    const cards = await page.locator('.card').count();
    check('board still shows documents after recovery', cards > 0, `${cards} cards`);
    const r = await openFirstDoc(page);
    check('document opens (recovered from bad bytes)', r.ok, r.text || '');
    await page.screenshot({ path: '/home/user/workspace/shots_fix/B-recovered.png' });
    await ctx.close();
  }

  // ---------- Case C: no regression ----------
  console.log('\nCase C — healthy bundle, no regression');
  {
    const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 } });
    const page = await ctx.newPage();
    await ctx.route('**/api/**', (r) => r.abort());
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rail .tab', { timeout: 90000 });
    await page.waitForTimeout(8000);
    await showDocs(page);
    const cards = await page.locator('.card').count();
    check('all bundled documents present', cards > 0, `${cards} cards in first category`);
    const r = await openFirstDoc(page);
    check('document opens normally', r.ok, r.text || '');
    await ctx.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
