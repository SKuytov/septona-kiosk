/*
 * Can the reader read several documents from one category without being thrown back to the
 * start each time?
 *
 * The split reading view this originally guarded is gone: as of v1.0.6 the document covers
 * the screen and "Назад" returns to the list. That makes a new thing worth checking, and it
 * is the thing a reader on a 21-document category will notice first — whether the list is
 * still where they left it, scrolled to the card they just read, or scrolled back to the
 * top so they have to hunt for their place again.
 *
 * Every step has a short explicit timeout so a stall is reported as a stall instead of
 * hanging, and a screenshot is written whenever a step fails.
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4173/';
const SHOTS = '/home/user/workspace/shots';
let pass = 0;
let fail = 0;

function ok(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

const stamp = () => new Date().toISOString().slice(11, 19);

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    locale: 'bg-BG',
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab', { timeout: 30000 });

  // Politiki is the big category and the one the sweep stalled in.
  await page.locator('.tab', { hasText: 'Политики' }).first().click();
  await page.waitForSelector('.card', { timeout: 30000 });
  await page.waitForTimeout(800);
  const total = await page.locator('.card').count();
  ok('the category lists its documents', total >= 20, `${total} cards`);

  /** Leaves the document the way a reader does, and waits for the overlay to really go. */
  async function backToList() {
    if (!(await page.locator('.vw').count())) return;
    await page.locator('.vbtn--back').first().click({ timeout: 10000 });
    await page.waitForSelector('.vw', { state: 'detached', timeout: 15000 });
    await page.waitForSelector('.card', { timeout: 15000 });
    await page.waitForTimeout(150);
  }

  const listScroll = () =>
    page.evaluate(() => {
      const el = document.querySelector('.scroll');
      return el ? Math.round(el.scrollTop) : -1;
    });

  async function openByIndex(i) {
    const t0 = Date.now();
    const title = (await page.locator('.card__t').nth(i).textContent()) || '?';
    await page.locator('.card').nth(i).click({ timeout: 15000 });
    // Wait for a canvas of that document, or an error panel.
    let verdict = 'timeout';
    for (let w = 0; w < 30; w++) {
      await page.waitForTimeout(400);
      const box = await page
        .locator('.vw__canvas')
        .first()
        .boundingBox()
        .catch(() => null);
      if (box && box.width > 50) {
        verdict = 'ok';
        break;
      }
      const err = await page
        .locator('.vw__errt')
        .first()
        .textContent()
        .catch(() => null);
      if (err && err.trim()) {
        verdict = 'error: ' + err.trim();
        break;
      }
    }
    return { title: title.trim().slice(0, 34), verdict, ms: Date.now() - t0 };
  }

  // First document, from the full-width board.
  let r = await openByIndex(0);
  console.log(`  [${stamp()}] 1st: ${r.title} -> ${r.verdict} (${r.ms}ms)`);
  ok('the first document opens from the board', r.verdict === 'ok', r.verdict);
  ok('and it covers the screen', (await page.locator('.vw--overlay').count()) === 1);
  ok('the split view is gone for good', (await page.locator('.main--split').count()) === 0);

  // Now the interesting part: back out and pick the next one, over and over, the way
  // someone working through a category does. Index 4 is where the sweep once stalled.
  for (const i of [1, 2, 3, 4, 5, 9, 14, 20]) {
    if (i >= total) continue;
    await backToList();
    // Scroll the wanted card into view first, then remember where the list was left, so the
    // check below is about the list keeping its place rather than about a short list.
    await page.locator('.card').nth(i).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const before = await listScroll();
    let res;
    try {
      res = await openByIndex(i);
    } catch (e) {
      res = { title: `#${i}`, verdict: 'threw: ' + String(e).split('\n')[0], ms: -1 };
    }
    console.log(`  [${stamp()}] #${i}: ${res.title} -> ${res.verdict} (${res.ms}ms)`);
    if (res.verdict !== 'ok') {
      await page.screenshot({ path: `${SHOTS}/switch-fail-${i}.png` }).catch(() => {});
    }
    ok(`document #${i} opens after backing out of the previous one`, res.verdict === 'ok', res.verdict);
    await backToList();
    const after = await listScroll();
    ok(
      `the list is still where it was left after reading #${i}`,
      before <= 4 || Math.abs(after - before) <= 8,
      `scrollTop ${before} -> ${after}`
    );
    ok(`document #${i} is still marked as the one just read`, (await page.locator('.card--on').count()) === 1);
  }

  ok('no uncaught script errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
