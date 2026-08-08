/*
 * The page turn.
 *
 * This is the part of the app the COO asked to be "like real life", so the test is not just
 * "does the number change" — it checks the things that make it feel like paper:
 *
 *   - the sheet follows the finger, at every point of the drag, not just at the end
 *   - going forward, the current page is the one that moves and the next is underneath it
 *   - going back, the previous page comes in on top of the current one
 *   - it works on both axes, because the panel is portrait and people swipe up as readily
 *     as they swipe sideways
 *   - a drag that is abandoned puts everything back and leaves nothing stranded on screen
 *
 * Touches go through CDP: Playwright's touchscreen only taps, and everything here depends on
 * a sequence of moves.
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4173/';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const touch = (cdp, type, x, y) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 12, radiusY: 12, force: 1 }],
  });

/** State of the two turn sheets, read straight off the DOM mid-gesture. */
const turnState = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('.turn');
    if (!root) return null;
    const over = root.querySelector('.turn__sheet--over');
    const under = root.querySelector('.turn__sheet--under');
    const num = (el) => {
      const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform);
      if (!m) return { x: 0, y: 0 };
      const p = m[1].split(',').map(Number);
      return { x: p[4], y: p[5] };
    };
    return {
      on: root.classList.contains('turn--on'),
      over: num(over),
      under: num(under),
      overZ: Number(getComputedStyle(over).zIndex),
      underZ: Number(getComputedStyle(under).zIndex),
      shade: Number(getComputedStyle(root.querySelector('.turn__shade')).opacity),
    };
  });

/*
  Is the document actually on screen?

  This exists because of a bug that every other assertion here walked straight past: the
  turn animated correctly, the page number changed, the sheets were cleared — and the panel
  was left showing an empty grey rectangle, because the layer that hides the live page
  during a turn had been torn down without unhiding it. Checking that the page turned is not
  the same as checking that you can see it.
*/
const documentShowing = (page) =>
  page.evaluate(() => {
    const stage = document.querySelector('.vw__stage');
    const wrap = document.querySelector('.vw__stagewrap');
    const cv = document.querySelector('.vw__canvas');
    if (!stage || !cv) return { ok: false, why: 'no stage' };
    const vis = getComputedStyle(stage).visibility;
    const op = Number(getComputedStyle(cv).opacity);
    const r = cv.getBoundingClientRect();
    return {
      ok: vis === 'visible' && op > 0.9 && r.width > 50 && r.height > 50 && !wrap.classList.contains('vw__stagewrap--turning'),
      why: `visibility=${vis} opacity=${op} size=${Math.round(r.width)}x${Math.round(r.height)} cls="${wrap.className}"`,
    };
  });

const pageOf = (page) =>
  page.evaluate(() => {
    const m = (document.querySelector('.vw__pg-long')?.textContent || '').match(/(\d+)/);
    return m ? Number(m[1]) : -1;
  });

async function open(page) {
  await page.waitForSelector('.tab', { timeout: 60000 });
  await page.locator('.tab', { hasText: 'Планове евакуация' }).first().click();
  await page.waitForSelector('.card', { timeout: 30000 });
  await page.locator('.card').first().click();
  await page.waitForSelector('.vw__canvas', { timeout: 30000 });
  await page.waitForTimeout(1500);
}

async function run(size) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: size, locale: 'bg-BG', hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await open(page);

  const box = await page.locator('.vw__stage').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  console.log(`\n---- ${size.width}x${size.height}`);

  // ---- 1. horizontal: the sheet tracks the finger -----------------------------
  let before = await pageOf(page);
  await touch(cdp, 'touchStart', cx + 300, cy);
  const samples = [];
  for (const dx of [-40, -120, -220, -320]) {
    await touch(cdp, 'touchMove', cx + 300 + dx, cy);
    await sleep(30);
    samples.push({ dx, st: await turnState(page) });
  }
  const live = samples.filter((s) => s.st && s.st.on);
  ok('a sideways drag starts a page turn', live.length >= 3, `${live.length}/4 samples live`);
  ok(
    'the sheet follows the finger rather than snapping',
    live.length >= 3 && live.every((s, i) => i === 0 || s.st.over.x < live[i - 1].st.over.x),
    live.map((s) => `${s.dx}:${Math.round(s.st.over.x)}`).join(' ')
  );
  ok(
    'and it follows it by roughly the distance dragged',
    live.every((s) => Math.abs(s.st.over.x - s.dx) < 26),
    live.map((s) => `${s.dx}->${Math.round(s.st.over.x)}`).join(' ')
  );
  const mid = live[live.length - 1].st;
  ok('going forward, the moving sheet is the one on top', mid.overZ > mid.underZ, `${mid.overZ} > ${mid.underZ}`);
  ok('the page underneath is shaded while it is covered', mid.shade > 0.02, `opacity ${mid.shade.toFixed(3)}`);
  await touch(cdp, 'touchEnd', cx - 20, cy);
  await sleep(650);
  ok('releasing past the threshold turns the page', (await pageOf(page)) === before + 1, `${before} -> ${await pageOf(page)}`);
  {
    const v = await documentShowing(page);
    ok('and the document is on screen afterwards, not a blank panel', v.ok, v.why);
  }
  let after = await turnState(page);
  ok('and the sheets are put away afterwards', after && !after.on);

  // ---- 2. horizontal, backwards: the previous page arrives on top --------------
  before = await pageOf(page);
  await touch(cdp, 'touchStart', cx - 300, cy);
  await touch(cdp, 'touchMove', cx - 260, cy); await sleep(30);
  await touch(cdp, 'touchMove', cx - 100, cy); await sleep(30);
  const back = await turnState(page);
  ok('dragging the other way also turns', back && back.on);
  ok(
    'going back, the arriving page is the one on top',
    back && back.on && back.overZ > back.underZ && back.over.x < 0,
    back ? `over.x=${Math.round(back.over.x)}` : 'no turn'
  );
  await touch(cdp, 'touchEnd', cx + 300, cy);
  await sleep(650);
  ok('and releasing it goes back a page', (await pageOf(page)) === before - 1, `${before} -> ${await pageOf(page)}`);
  {
    const v = await documentShowing(page);
    ok('the document is still on screen after going back', v.ok, v.why);
  }

  // ---- 3. an abandoned drag springs back --------------------------------------
  before = await pageOf(page);
  await touch(cdp, 'touchStart', cx + 200, cy);
  for (const dx of [-30, -60, -80, -50, -10]) { await touch(cdp, 'touchMove', cx + 200 + dx, cy); await sleep(40); }
  await touch(cdp, 'touchEnd', cx + 200, cy);
  await sleep(700);
  ok('a drag that comes back does not turn the page', (await pageOf(page)) === before);
  {
    const v = await documentShowing(page);
    ok('and the document is on screen after an abandoned drag', v.ok, v.why);
  }
  after = await turnState(page);
  ok('and leaves nothing stranded on screen', after && !after.on);

  // ---- 4. vertical -------------------------------------------------------------
  /*
    Up and down turn pages too, but only once the page has been read to its end: in
    landscape a portrait A4 at fit-width is taller than the stage, and a drag up there has to
    scroll. So the rule under test is "scroll while there is room, turn when there is not",
    the same rule the sideways drag follows.
  */
  const room = await page.evaluate(() => {
    const st = document.querySelector('.vw__stage');
    return st.scrollHeight - st.clientHeight;
  });
  if (room > 4) {
    before = await pageOf(page);
    await touch(cdp, 'touchStart', cx, cy + 200);
    for (const dy of [-30, -70, -110]) { await touch(cdp, 'touchMove', cx, cy + 200 + dy); await sleep(30); }
    const scrolling = await turnState(page);
    ok('with page left to read, dragging up scrolls instead of turning', !scrolling || !scrolling.on, `room ${room}px`);
    await touch(cdp, 'touchEnd', cx, cy + 90);
    await sleep(400);
    ok('and the page has not changed', (await pageOf(page)) === before);
    // Read to the bottom, which is where the turn becomes available.
    await page.evaluate(() => { const st = document.querySelector('.vw__stage'); st.scrollTop = st.scrollHeight; });
    await sleep(300);
  } else {
    ok('the whole page fits, so an upward drag has nothing to scroll', true, `room ${room}px`);
    ok('and the page has not changed', true);
  }

  before = await pageOf(page);
  await touch(cdp, 'touchStart', cx, cy + 300);
  for (const dy of [-40, -140, -260, -380]) { await touch(cdp, 'touchMove', cx, cy + 300 + dy); await sleep(30); }
  const vert = await turnState(page);
  ok('an upward drag turns the page too', vert && vert.on);
  ok(
    'and it is the vertical axis that moves, not the horizontal',
    vert && vert.on && Math.abs(vert.over.y) > 100 && Math.abs(vert.over.x) < 4,
    vert ? `x=${Math.round(vert.over.x)} y=${Math.round(vert.over.y)}` : 'no turn'
  );
  await touch(cdp, 'touchEnd', cx, cy - 200);
  await sleep(700);
  ok('releasing an upward drag goes to the next page', (await pageOf(page)) === before + 1, `${before} -> ${await pageOf(page)}`);
  {
    const v = await documentShowing(page);
    ok('the document is on screen after a vertical turn', v.ok, v.why);
  }

  // Going back the same way needs the page scrolled to its top for the same reason.
  await page.evaluate(() => { document.querySelector('.vw__stage').scrollTop = 0; });
  await sleep(300);
  before = await pageOf(page);
  await touch(cdp, 'touchStart', cx, cy - 300);
  for (const dy of [40, 140, 260, 380]) { await touch(cdp, 'touchMove', cx, cy - 300 + dy); await sleep(30); }
  await touch(cdp, 'touchEnd', cx, cy + 200);
  await sleep(700);
  ok('and dragging down goes back', (await pageOf(page)) === before - 1, `${before} -> ${await pageOf(page)}`);

  // ---- 5. the ends of the document ---------------------------------------------
  // The drags above finish on page 1, so this is already the first page: there is nothing
  // before it, and dragging that way must do nothing at all rather than tear off a blank
  // sheet.
  ok('back at the first page', (await pageOf(page)) === 1, `page ${await pageOf(page)}`);
  await touch(cdp, 'touchStart', cx - 300, cy);
  for (const dx of [60, 160, 280]) { await touch(cdp, 'touchMove', cx - 300 + dx, cy); await sleep(30); }
  const edge = await turnState(page);
  ok('there is no turn before the first page', !edge || !edge.on, edge && edge.on ? `over.x=${Math.round(edge.over.x)}` : 'no sheets');
  await touch(cdp, 'touchEnd', cx + 100, cy);
  await sleep(600);
  ok('and the page does not change', (await pageOf(page)) === 1, `page ${await pageOf(page)}`);
  const t2 = await turnState(page);
  ok('nothing is left on screen at the edge either', !t2 || !t2.on);

  ok('no page errors throughout', errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  for (const s of [{ width: 1080, height: 1920 }, { width: 1280, height: 800 }]) await run(s);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
