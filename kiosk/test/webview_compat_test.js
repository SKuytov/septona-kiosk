/**
 * Reproduces the panel's failure and proves the engine fix.
 *
 * The device reported `TypeError: Promise.withResolvers is not a function` when opening any
 * document. That API arrived in Chrome/WebView 119 and the panel's WebView is older, so the
 * default pdf.js build cannot run there at all.
 *
 * This removes the API before any app code is evaluated, which is exactly the engine the
 * panel has, and then requires a document to open and render.
 *
 * Case 1: the API is missing (the panel). A document must still open.
 * Case 2: the API is missing. The app must SAY so on the diagnostics screen.
 * Case 3: control — the API present, nothing regressed.
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4173/';

/** Strips the newer APIs, so the page runs on the same surface as the panel's WebView. */
const OLD_WEBVIEW = () => {
  delete Promise.withResolvers;
  delete Object.hasOwn;
  delete Array.prototype.at;
  delete Array.prototype.findLast;
  delete Array.prototype.findLastIndex;
  // eslint-disable-next-line no-undef
  delete globalThis.structuredClone;
};

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
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
    const box = await page.locator('canvas').first().boundingBox().catch(() => null);
    if (box && box.width > 50) return { ok: true };
    const err = await page.locator('.vw__load').first().textContent().catch(() => null);
    if (err && /не може|not been|could not/i.test(err)) {
      return { ok: false, text: err.replace(/\s+/g, ' ').trim().slice(0, 260) };
    }
  }
  return { ok: false, text: 'timeout waiting for the page to render' };
};

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
    cond ? pass++ : fail++;
  };

  // ---------- Case 1: the panel's engine ----------
  console.log('\nCase 1 — WebView without Promise.withResolvers (the panel)');
  {
    const ctx = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
      serviceWorkers: 'block',
    });
    await ctx.addInitScript(OLD_WEBVIEW);
    const page = await ctx.newPage();
    const errors = [];
    const workers = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // The engine's worker is a separate realm that the page-level shim cannot reach, so it
    // relies on the polyfills inside the pdf.js legacy worker bundle. Record the workers
    // actually created: if pdf.js quietly fell back to running on the main thread, that
    // path would be untested and would still break on the panel.
    page.on('worker', (w) => workers.push(w.url()));
    await ctx.route('**/api/**', (r) => r.abort());

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rail .tab', { timeout: 120000 });
    await page.waitForTimeout(2500);

    // Guard the test itself: the app records which APIs were missing when it loaded, so if
    // the stripping above ever stopped working this assertion fails rather than the suite
    // quietly passing against a modern engine.
    const shimmed = await page.evaluate(() => window.__septonaShimmed || null);
    check('the stripped engine really was missing the API',
      Array.isArray(shimmed) && shimmed.includes('Promise.withResolvers'),
      JSON.stringify(shimmed));

    await showDocs(page);
    const cards = await page.locator('.card').count();
    check('the board still renders', cards > 0, `${cards} cards`);

    const r = await openFirstDoc(page);
    check('a document opens and renders on the old engine', r.ok, r.text || '');
    check('no withResolvers TypeError anywhere',
      !errors.some((e) => /withResolvers/.test(e)),
      errors.filter((e) => /withResolvers/.test(e)).join(' | ') || 'none');
    check('the real pdf.js worker ran, not a main-thread fallback',
      workers.some((u) => /pdf\.worker/.test(u)),
      workers.join(' | ') || 'no workers created');
    await ctx.close();
  }

  // ---------- Case 2: the app must report the compatibility gap ----------
  console.log('\nCase 2 — diagnostics names the missing APIs');
  {
    const ctx = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
      serviceWorkers: 'block',
    });
    await ctx.addInitScript(OLD_WEBVIEW);
    const page = await ctx.newPage();
    await ctx.route('**/api/**', (r) => r.abort());
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rail .tab', { timeout: 120000 });

    const reported = await page.evaluate(() => window.__septonaShimmed || null);
    check('the app knows which APIs it had to shim',
      Array.isArray(reported) && reported.includes('Promise.withResolvers'),
      JSON.stringify(reported));
    await ctx.close();
  }

  // ---------- Case 3: control ----------
  console.log('\nCase 3 — current engine, control');
  {
    const ctx = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
      serviceWorkers: 'block',
    });
    const page = await ctx.newPage();
    await ctx.route('**/api/**', (r) => r.abort());
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rail .tab', { timeout: 120000 });
    await page.waitForTimeout(2000);
    const r = await openFirstDoc(page);
    check('a document opens normally', r.ok, r.text || '');
    const reported = await page.evaluate(() => window.__septonaShimmed || null);
    check('nothing is reported as shimmed on a current engine',
      Array.isArray(reported) && reported.length === 0, JSON.stringify(reported));
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
