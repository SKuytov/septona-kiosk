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
  // The panel rests on a home screen with no category selected. The categories are the
  // only thing on screen at boot; the loop below opens each one in turn.
  await page.waitForSelector('.tab', { timeout: 30000 });

  /** Returns to the list from the viewer, which now covers the whole screen. */
  async function backToList() {
    if (!(await page.locator('.vw').count())) return;
    await page.locator('.vbtn--back').first().click({ timeout: 10000 }).catch(() => {});
    // Wait for the overlay to actually leave the DOM: while it is fading it still covers
    // the list, and clicking the next card silently lands on the overlay instead.
    await page.waitForSelector('.vw', { state: 'detached', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.card', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(150);
  }

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

  // Every category, every document. The viewer used to be left open between documents,
  // because the list sat beside it and the next card was one click away. As of v1.0.6 the
  // viewer covers the screen, so each document is closed with the back button before the
  // next is opened — which is also exactly what a reader does now.
  const tabs = await page.locator('.tab').count();
  const catNames = [];
  for (let i = 0; i < tabs; i++) {
    const txt = (await page.locator('.tab').nth(i).textContent()) || '';
    if (!/пауза|Пауза|Възобнови/.test(txt)) catNames.push(txt.trim().split('\n')[0]);
  }

  let seen = 0;
  let good = 0;
  const bad = [];

  for (const cat of catNames) {
    await backToList();
    // Tapping the open category closes it and goes home, so only tap it if it is not open.
    const tab = page.locator('.tab', { hasText: cat }).first();
    if (!(await tab.evaluate((el) => el.classList.contains('tab--on')).catch(() => false))) {
      await tab.click();
    }
    await page.waitForTimeout(700);
    const n = await page.locator('.card').count();
    console.log(`  [${stamp()}] ${cat} — ${n} documents`);
    for (let i = 0; i < n; i++) {
      seen++;
      let res;
      try {
        res = await openByIndex(i);
      } catch (e) {
        res = { title: `#${i}`, verdict: 'threw: ' + String(e).split('\n')[0], ms: -1 };
      }
      await backToList();
      if (res.verdict === 'ok') good++;
      else {
        bad.push(`[${cat}] ${res.title} -> ${res.verdict}`);
        await page.screenshot({ path: `${SHOTS}/sweep-fail-${seen}.png` }).catch(() => {});
      }
    }
    console.log(`      ${good}/${seen} rendered so far`);
  }

  ok(`every document renders (${good}/${seen})`, good === seen && seen > 0, bad.slice(0, 5).join(' | '));

  ok('no uncaught script errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
