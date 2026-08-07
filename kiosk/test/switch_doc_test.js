/*
 * Can the reader pick a different document from the list while one is already open?
 *
 * The split reading view narrows the list into a column beside the page. The full-document
 * sweep stalled part-way through a category once that view existed, which is either a
 * problem with the sweep's assumptions or a real one: if a card in the narrow column can
 * no longer be tapped, the left-hand list is decoration rather than navigation.
 *
 * Every step here has a short explicit timeout so a stall is reported as a stall instead of
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
  await page.waitForSelector('.card', { timeout: 30000 });

  // Politiki is the big category and the one the sweep stalled in.
  await page.locator('.tab', { hasText: 'Политики' }).first().click();
  await page.waitForTimeout(800);
  const total = await page.locator('.card').count();
  ok('the category lists its documents', total >= 20, `${total} cards`);

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
  ok('the split view engaged', (await page.locator('.main--split').count()) === 1);

  // Now the interesting part: every later document is picked from the narrow column while
  // the previous one is still on screen. Index 4 is where the sweep stalled.
  for (const i of [1, 2, 3, 4, 5, 9, 14, 20]) {
    if (i >= total) continue;
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
    ok(`document #${i} opens from the list while reading`, res.verdict === 'ok', res.verdict);
    ok(`document #${i} became the selected card`, (await page.locator('.card--on').count()) === 1);
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
