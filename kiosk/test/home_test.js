/*
 * The home screen, the single-column list, and the way out of a document.
 *
 * These are the changes the COO asked for, so they are checked as behaviour rather than as
 * styling: what the panel shows when nobody has touched it, what a touch on a category does,
 * what one document per row actually means for the titles, and — the one that matters on a
 * wall — that the panel puts itself back to the home screen when it is left alone.
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4173/';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`); };

async function run(size) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: size, locale: 'bg-BG', hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab', { timeout: 60000 });
  await page.waitForTimeout(1200);
  console.log(`\n---- ${size.width}x${size.height}`);

  // ---- 1. what the panel shows when nobody has touched it -----------------------
  ok('the panel starts on the home screen', await page.locator('.home').isVisible());
  ok('and no category has been chosen for the visitor', (await page.locator('.tab--on').count()) === 0);
  ok('so no documents are listed yet', (await page.locator('.card').count()) === 0);
  ok('the categories are still there to be touched', (await page.locator('.tab').count()) >= 2);
  ok('there is no automatic cycling control any more', (await page.getByText('На пауза').count()) === 0);
  ok('and no cycle progress bar', (await page.locator('.tab__prog').count()) === 0);

  const bgs = await page.locator('.home__bg').count();
  ok('both background photographs are laid down, so the crossfade has nothing to load', bgs === 2, `${bgs} layers`);
  const on = await page.locator('.home__bg--on').count();
  ok('exactly one of them is showing', on === 1, `${on} showing`);
  const logo = await page.locator('.home__logo').boundingBox();
  ok('the mark is on screen at a readable size', logo && logo.width > 140, logo ? `${Math.round(logo.width)}px` : 'missing');
  ok('the home screen tells the visitor what to do', await page.locator('.home__hint').isVisible());

  // The home screen must sit in the document pane, not over the header or the categories:
  // that was the specific instruction, and it is what keeps a touch on a category feel like
  // the pane changing rather than the screen changing.
  const homeBox = await page.locator('.home').boundingBox();
  const railBox = await page.locator('.rail').boundingBox();
  ok(
    'it sits under the categories rather than covering them',
    homeBox.y >= railBox.y + railBox.height - 2,
    `home top ${Math.round(homeBox.y)} vs rail bottom ${Math.round(railBox.y + railBox.height)}`
  );

  // ---- 2. touching a category reveals its documents -----------------------------
  await page.locator('.tab', { hasText: 'Политики' }).first().click();
  await page.waitForSelector('.card', { timeout: 20000 });
  ok('touching a category shows its documents', (await page.locator('.card').count()) > 5);
  ok('and the home screen steps out of the way', (await page.locator('.home').count()) === 0);
  ok('the touched category is marked', (await page.locator('.tab--on').count()) === 1);

  // ---- 3. one document per row ---------------------------------------------------
  const rows = await page.locator('.card--row').count();
  ok('every document is a full-width row', rows === (await page.locator('.card').count()), `${rows} rows`);
  const boxes = await page.locator('.card--row').evaluateAll((els) =>
    els.slice(0, 6).map((e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) }; })
  );
  ok('the rows are all the same width', new Set(boxes.map((b) => b.w)).size === 1, boxes.map((b) => b.w).join(','));
  ok('and stacked, never side by side', new Set(boxes.map((b) => b.x)).size === 1, boxes.map((b) => b.x).join(','));
  ok('each row is comfortably bigger than a fingertip', boxes.every((b) => b.h >= 56), boxes.map((b) => b.h).join(','));

  // Titles are the only thing that identifies a policy, so a clipped title is a real defect.
  const clipped = await page.locator('.card--row .card__t').evaluateAll((els) =>
    els.filter((e) => e.scrollHeight > e.clientHeight + 2).map((e) => e.textContent.trim())
  );
  ok('no document title is cut off', clipped.length === 0, clipped.slice(0, 3).join(' | '));
  const overflow = await page.locator('.card--row').evaluateAll((els) =>
    els.filter((e) => e.scrollWidth > e.clientWidth + 2).length
  );
  ok('and nothing overflows its row sideways', overflow === 0, `${overflow} rows`);

  // ---- 4. a document fills the panel, and the way out goes home -------------------
  await page.locator('.card').first().click();
  await page.waitForSelector('.vw__canvas', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const vw = await page.locator('.vw').boundingBox();
  ok(
    'an open document covers the whole panel',
    vw.width >= size.width - 2 && vw.height >= size.height - 2,
    `${Math.round(vw.width)}x${Math.round(vw.height)}`
  );
  ok('the list is not sharing the screen with it', (await page.locator('.split__pane').count()) === 0);

  // Two ways out, deliberately: back to the list for someone still reading, home for
  // someone who has finished.
  ok('there is a labelled way back to the list', await page.locator('.vw__bar .vbtn', { hasText: 'Назад' }).first().isVisible());
  const exit = page.locator('.vbtn--exit');
  ok('and a labelled way home', await exit.isVisible());
  ok('the way home says where it goes', /Начало/.test(await exit.textContent()));

  await page.locator('.vw__bar .vbtn', { hasText: 'Назад' }).first().click();
  await page.waitForTimeout(600);
  ok('back returns to the list it came from', (await page.locator('.card').count()) > 5 && (await page.locator('.vw__canvas').count()) === 0);

  await page.locator('.card').first().click();
  await page.waitForSelector('.vw__canvas', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.locator('.vbtn--exit').click();
  await page.waitForTimeout(800);
  ok('and the way home goes all the way to the home screen', await page.locator('.home').isVisible());
  ok('with no category left selected behind it', (await page.locator('.tab--on').count()) === 0);

  ok('no page errors throughout', errors.length === 0, errors.join(' | '));
  await browser.close();
}

/** The idle reset. Run once, because it costs a real minute of waiting. */
async function idle() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, locale: 'bg-BG', hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab', { timeout: 60000 });
  console.log('\n---- left alone for a minute');
  await page.locator('.tab', { hasText: 'Политики' }).first().click();
  await page.waitForSelector('.card', { timeout: 20000 });
  await page.locator('.card').first().click();
  await page.waitForSelector('.vw__canvas', { timeout: 30000 });

  await page.waitForTimeout(30000);
  ok('half a minute in, the document is still open', (await page.locator('.vw__canvas').count()) === 1);

  await page.waitForTimeout(42000);
  ok('a minute after the last touch the panel is back on the home screen', await page.locator('.home').isVisible());
  ok('and the document has been closed', (await page.locator('.vw__canvas').count()) === 0);
  ok('and no category is left selected', (await page.locator('.tab--on').count()) === 0);
  await browser.close();
}

(async () => {
  for (const s of [{ width: 1080, height: 1920 }, { width: 1280, height: 800 }, { width: 800, height: 1280 }]) await run(s);
  await idle();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
