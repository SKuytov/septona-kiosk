/*
 * Swiping between pages.
 *
 * The interesting part is not that a swipe turns the page — it is that the same finger also
 * pans a zoomed page, and the two must not fight. The rule under test: a sideways drag pans
 * while the page still has room to move that way, and turns the page only once it has run
 * out of room. So at fit-width a swipe always turns, and zoomed in it walks to the edge
 * first.
 *
 * Touches go in through CDP because Playwright's own touchscreen only taps, and a swipe is a
 * sequence of moves with timing that matters: the gesture commits on distance *or* on speed.
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4173/';
const SHOTS = '/home/user/workspace/shots';
let pass = 0;
let fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function touch(cdp, type, x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 12, radiusY: 12, force: 1 }],
  });
}

/**
 * A swipe as a real sequence of touches. `steps` and `delay` control the speed, which the
 * gesture reads as velocity: a few big jumps is a flick, many small slow ones is a drag.
 */
async function swipe(cdp, from, to, { steps = 12, delay = 12 } = {}) {
  await touch(cdp, 'touchStart', from.x, from.y);
  await sleep(delay);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await touch(cdp, 'touchMove', from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
    await sleep(delay);
  }
  await touch(cdp, 'touchEnd', to.x, to.y);
  await sleep(360);
}

const pageOf = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.vw__pg-long') || document.querySelector('.vw__pg');
    const m = (el?.textContent || '').match(/(\d+)/);
    return m ? Number(m[1]) : -1;
  });

const stageBox = (page) => page.locator('.vw__stage').boundingBox();

const scrollState = (page) =>
  page.evaluate(() => {
    const s = document.querySelector('.vw__stage');
    return { left: s.scrollLeft, max: s.scrollWidth - s.clientWidth, top: s.scrollTop };
  });

const canvasTransform = (page) =>
  page.evaluate(() => document.querySelector('.vw__canvas').style.transform || 'none');

async function openMultiPageDoc(page) {
  await page.waitForSelector('.card', { timeout: 60000 });
  await page.locator('.tab', { hasText: 'Планове евакуация' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('.card').first().click();
  await page.waitForSelector('.vw__canvas', { timeout: 30000 });
  await page.waitForTimeout(1200);
}

async function run(size) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: size,
    locale: 'bg-BG',
    hasTouch: true,
    isMobile: false,
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await openMultiPageDoc(page);

  const box = await stageBox(page);
  const midY = box.y + box.height / 2;
  const right = box.x + box.width - 40;
  const left = box.x + 40;

  console.log(`\n---- ${size.width}x${size.height}`);

  // Read the long label specifically. `.vw__pg` holds both the long and the short form —
  // one of them hidden by CSS — so its textContent is "Стр. 1 от 6" immediately followed by
  // "1/6", and a naive match reads that as 61 pages.
  const total = await page.evaluate(() => {
    const m = (document.querySelector('.vw__pg-long')?.textContent || '').match(/(\d+)\D+(\d+)/);
    return m ? Number(m[2]) : -1;
  });
  ok('the document has several pages to swipe through', total > 2, `${total} pages`);

  // ---- 1. fit-width: nothing to pan, so a swipe turns the page ------------------
  let before = await pageOf(page);
  const fit = await scrollState(page);
  ok('at fit-width the page has no room to pan sideways', fit.max <= 1, `max=${fit.max}`);

  await swipe(cdp, { x: right, y: midY }, { x: left, y: midY });
  let after = await pageOf(page);
  ok('swiping left goes to the next page', after === before + 1, `${before} -> ${after}`);

  await swipe(cdp, { x: left, y: midY }, { x: right, y: midY });
  let back = await pageOf(page);
  ok('swiping right goes back', back === before, `${after} -> ${back}`);

  ok('the page is left square on screen afterwards', (await canvasTransform(page)) === 'none');

  // ---- 2. a small slow drag is not a page turn ----------------------------------
  before = await pageOf(page);
  await swipe(cdp, { x: right, y: midY }, { x: right - 26, y: midY }, { steps: 10, delay: 45 });
  ok('a short slow drag does not turn the page', (await pageOf(page)) === before);
  ok('and it springs back', (await canvasTransform(page)) === 'none');

  // ---- 3. a fast flick turns it even though it is short -------------------------
  before = await pageOf(page);
  await swipe(cdp, { x: right, y: midY }, { x: right - 70, y: midY }, { steps: 3, delay: 8 });
  ok('a fast flick turns the page', (await pageOf(page)) === before + 1, `${before} -> ${await pageOf(page)}`);

  // ---- 4. a vertical drag is a scroll, not a page turn --------------------------
  before = await pageOf(page);
  await swipe(cdp, { x: box.x + box.width / 2, y: box.y + box.height - 60 },
                   { x: box.x + box.width / 2, y: box.y + 60 }, { steps: 10, delay: 16 });
  ok('dragging up does not turn the page', (await pageOf(page)) === before, `page ${await pageOf(page)}`);

  // ---- 5. zoomed in, a swipe pans before it turns -------------------------------
  // Two presses of zoom-in put the page wider than the stage.
  await page.locator('.vw__foot .vbtn').nth(3).click();
  await page.waitForTimeout(500);
  await page.locator('.vw__foot .vbtn').nth(3).click();
  await page.waitForTimeout(900);
  let st = await scrollState(page);
  ok('zoomed in, the page is wider than the stage', st.max > 40, `max=${st.max}`);

  await page.evaluate(() => {
    document.querySelector('.vw__stage').scrollLeft = 0;
  });
  await page.waitForTimeout(150);
  before = await pageOf(page);
  await swipe(cdp, { x: right, y: midY }, { x: left, y: midY }, { steps: 12, delay: 16 });
  st = await scrollState(page);
  ok('with room to pan, a sideways drag pans instead of turning',
     (await pageOf(page)) === before, `page ${await pageOf(page)}`);
  ok('and it actually moved the page across', st.left > 20, `scrollLeft=${Math.round(st.left)}`);

  // ---- 6. at the edge of a zoomed page, the same swipe turns --------------------
  await page.evaluate(() => {
    const s = document.querySelector('.vw__stage');
    s.scrollLeft = s.scrollWidth - s.clientWidth;
  });
  await page.waitForTimeout(150);
  before = await pageOf(page);
  await swipe(cdp, { x: right, y: midY }, { x: left, y: midY }, { steps: 12, delay: 16 });
  ok('at the right-hand edge the swipe turns the page instead',
     (await pageOf(page)) === before + 1, `${before} -> ${await pageOf(page)}`);

  // Back to fit-width for the edge cases.
  await page.locator('.vw__foot .vbtn').nth(4).click();
  await page.waitForTimeout(700);
  const fitNow = await page.locator('.vw__foot .vbtn').nth(4).getAttribute('class');
  if (!/vbtn/.test(fitNow || '')) ok('fit button present', false);

  // ---- 7. the ends of the document ---------------------------------------------
  await page.evaluate(() => {
    // Jump to the last page using the footer's next button rather than guessing.
  });
  for (let i = 0; i < total + 2; i++) {
    const btn = page.locator('.vw__foot .vbtn').nth(1);
    if (await btn.isDisabled()) break;
    await btn.click();
    await page.waitForTimeout(280);
  }
  const last = await pageOf(page);
  ok('reached the last page with the buttons', last === total, `page ${last} of ${total}`);

  await swipe(cdp, { x: right, y: midY }, { x: left, y: midY });
  ok('swiping past the last page stays put', (await pageOf(page)) === total, `page ${await pageOf(page)}`);
  ok('and the page is not left pushed aside', (await canvasTransform(page)) === 'none',
     await canvasTransform(page));

  for (let i = 0; i < total + 2; i++) {
    const btn = page.locator('.vw__foot .vbtn').nth(0);
    if (await btn.isDisabled()) break;
    await btn.click();
    await page.waitForTimeout(280);
  }
  ok('back to the first page with the buttons', (await pageOf(page)) === 1);
  await swipe(cdp, { x: left, y: midY }, { x: right, y: midY });
  ok('swiping before the first page stays put', (await pageOf(page)) === 1);
  ok('and that page is square too', (await canvasTransform(page)) === 'none');

  // ---- 8. the buttons still work, which the user asked to keep ------------------
  await page.locator('.vw__foot .vbtn').nth(1).click();
  await page.waitForTimeout(400);
  ok('the next-page button still works alongside the swipe', (await pageOf(page)) === 2);
  await page.locator('.vw__foot .vbtn').nth(0).click();
  await page.waitForTimeout(400);
  ok('the previous-page button still works', (await pageOf(page)) === 1);

  // ---- 9. double-tap still zooms, and a tap is never read as a swipe ------------
  const beforeTapPage = await pageOf(page);
  await touch(cdp, 'touchStart', box.x + box.width / 2, midY);
  await touch(cdp, 'touchEnd', box.x + box.width / 2, midY);
  await sleep(90);
  await touch(cdp, 'touchStart', box.x + box.width / 2, midY);
  await touch(cdp, 'touchEnd', box.x + box.width / 2, midY);
  await sleep(900);
  const zoomed = await page.evaluate(() => {
    const el = document.querySelector('.vw__pct');
    return Number((el?.textContent || '').replace('%', ''));
  });
  ok('a double-tap still zooms', zoomed > 100, `${zoomed}%`);
  ok('and taps never turned the page', (await pageOf(page)) === beforeTapPage);

  ok('no uncaught script errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  await page.screenshot({ path: `${SHOTS}/swipe-${size.width}x${size.height}.png` });
  await browser.close();
}

async function main() {
  for (const size of [
    { width: 412, height: 915 },
    { width: 800, height: 1280 },
    { width: 1080, height: 1920 },
  ]) {
    await run(size);
  }
  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
