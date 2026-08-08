/*
 * Panning and zooming.
 *
 * Covers the three things that were wrong: part of a zoomed page could not be reached at all,
 * zooming jumped to the middle of the page instead of staying where the fingers were, and a
 * page turn re-rasterised a page that had already been drawn.
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:4173/';

let pass = 0;
let fail = 0;
const ok = (name, cond, note = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${note ? ' — ' + note : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${note ? ' — ' + note : ''}`);
  }
};

const SIZES = [
  { name: 'phone', width: 412, height: 915 },
  { name: 'tabletPort', width: 800, height: 1280 },
  { name: 'kiosk', width: 1080, height: 1920 },
];

/** How far past each edge of the stage the page extends but cannot be scrolled to. */
async function reach(page) {
  return page.evaluate(() => {
    const s = document.querySelector('.vw__stage');
    const c = document.querySelector('.vw__canvas');
    const keep = { l: s.scrollLeft, t: s.scrollTop };
    const sr = s.getBoundingClientRect();
    s.scrollLeft = -1e6;
    s.scrollTop = -1e6;
    let cr = c.getBoundingClientRect();
    const left = Math.round(cr.left - sr.left);
    const top = Math.round(cr.top - sr.top);
    s.scrollLeft = 1e6;
    s.scrollTop = 1e6;
    cr = c.getBoundingClientRect();
    const right = Math.round(sr.right - cr.right);
    const bottom = Math.round(sr.bottom - cr.bottom);
    s.scrollLeft = keep.l;
    s.scrollTop = keep.t;
    return { left, right, top, bottom, canvasW: Math.round(cr.width), stageW: s.clientWidth };
  });
}

/** Two fingers, moving apart or together about a chosen centre. */
async function pinchAbout(page, cx, cy, from, to) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (pts) =>
    cdp.send('Input.dispatchTouchEvent', {
      type: pts.length ? 'touchStart' : 'touchEnd',
      touchPoints: pts,
    });
  const move = (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts });
  const pair = (g) => [
    { x: cx - g / 2, y: cy, id: 1 },
    { x: cx + g / 2, y: cy, id: 2 },
  ];
  await touch(pair(from));
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await move(pair(from + ((to - from) * i) / steps));
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function openFirstDoc(page) {
  // The panel opens on the home screen now: there are no documents on screen until a
  // category is touched, so this waits for the categories rather than for a card.
  await page.waitForSelector('.tab', { timeout: 60000 });
  await page.locator('.tab', { hasText: 'Планове евакуация' }).first().click();
  await page.waitForSelector('.card', { timeout: 30000 });
  await page.locator('.card').first().click();
  await page.waitForSelector('.vw__canvas', { timeout: 30000 });
  await page.waitForTimeout(1100);
}

(async () => {
  const browser = await chromium.launch();

  // ---- 1. every part of a zoomed page can be reached, at every screen size ----
  for (const size of SIZES) {
    console.log(`\n[1] ${size.name} ${size.width}x${size.height}: the whole zoomed page is reachable`);
    const ctx = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      locale: 'bg-BG',
      hasTouch: true,
      serviceWorkers: 'block',
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await openFirstDoc(page);

    const zoomIn = page.locator('.vw__foot .vbtn').nth(3);
    for (let step = 1; step <= 4; step++) {
      await zoomIn.click();
      await page.waitForTimeout(650);
      const r = await reach(page);
      // A positive gap is padding still on screen; a negative one is page that cannot be
      // scrolled to. Only the latter is a fault.
      ok(`zoom step ${step}: nothing is cut off the left`, r.left >= -1, `gap ${r.left}px`);
      ok(`zoom step ${step}: nothing is cut off the right`, r.right >= -1, `gap ${r.right}px`);
      ok(`zoom step ${step}: nothing is cut off the top`, r.top >= -1, `gap ${r.top}px`);
      ok(`zoom step ${step}: nothing is cut off the bottom`, r.bottom >= -1, `gap ${r.bottom}px`);
      if (step === 4) {
        ok(
          'and by now the page really is much wider than the stage',
          r.canvasW > r.stageW * 1.5,
          `${r.canvasW}px page vs ${r.stageW}px stage`
        );
      }
    }

    // A finger drag must be able to walk all the way to the left-hand edge.
    const box = await page.locator('.vw__stage').boundingBox();
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(box.x + 40, box.y + box.height / 2);
      await page.mouse.down();
      for (let k = 1; k <= 8; k++) {
        await page.mouse.move(box.x + 40 + (k * (box.width - 80)) / 8, box.y + box.height / 2);
      }
      await page.mouse.up();
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(700);
    const atLeft = await page.evaluate(() => document.querySelector('.vw__stage').scrollLeft);
    ok('dragging repeatedly reaches the left-hand edge', atLeft <= 1, `scrollLeft=${atLeft}`);

    ok('no uncaught script errors', errors.length === 0, errors[0] || '');
    await ctx.close();
  }

  // ---- 2. zooming stays where the fingers are ----
  console.log('\n[2] zooming keeps hold of the point it was made about');
  {
    const ctx = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
      locale: 'bg-BG',
      hasTouch: true,
      serviceWorkers: 'block',
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await openFirstDoc(page);

    // Aim at a point well away from the centre, so a zoom that ignores it is obvious.
    const target = await page.evaluate(() => {
      const r = document.querySelector('.vw__canvas').getBoundingClientRect();
      return { x: Math.round(r.left + r.width * 0.2), y: Math.round(r.top + r.height * 0.25) };
    });
    const before = await page.evaluate(
      (t) => {
        const r = document.querySelector('.vw__canvas').getBoundingClientRect();
        return { u: (t.x - r.left) / r.width, v: (t.y - r.top) / r.height, w: r.width };
      },
      target
    );

    await pinchAbout(page, target.x, target.y, 160, 460);
    await page.waitForTimeout(900);

    const after = await page.evaluate(
      (b) => {
        const r = document.querySelector('.vw__canvas').getBoundingClientRect();
        return {
          x: r.left + b.u * r.width,
          y: r.top + b.v * r.height,
          w: r.width,
        };
      },
      before
    );
    ok('the pinch magnified the page', after.w > before.w * 1.4, `${Math.round(before.w)} -> ${Math.round(after.w)}px`);
    ok(
      'the pinched point stayed under the fingers',
      Math.abs(after.x - target.x) <= 24 && Math.abs(after.y - target.y) <= 24,
      `drifted ${Math.round(after.x - target.x)},${Math.round(after.y - target.y)}px`
    );

    // Double-tap towards the top-left corner of the page.
    await page.locator('.vw__foot .vbtn').nth(4).click(); // fit, back to a known state
    await page.waitForTimeout(700);
    const tap = await page.evaluate(() => {
      const r = document.querySelector('.vw__canvas').getBoundingClientRect();
      return { x: Math.round(r.left + r.width * 0.25), y: Math.round(r.top + r.height * 0.2) };
    });
    const dtBefore = await page.evaluate(
      (t) => {
        const r = document.querySelector('.vw__canvas').getBoundingClientRect();
        return { u: (t.x - r.left) / r.width, v: (t.y - r.top) / r.height, w: r.width };
      },
      tap
    );
    await page.touchscreen.tap(tap.x, tap.y);
    await page.waitForTimeout(90);
    await page.touchscreen.tap(tap.x, tap.y);
    await page.waitForTimeout(1000);
    const dtAfter = await page.evaluate(
      (b) => {
        const s = document.querySelector('.vw__stage');
        const r = document.querySelector('.vw__canvas').getBoundingClientRect();
        return {
          x: r.left + b.u * r.width,
          y: r.top + b.v * r.height,
          w: r.width,
          // How much room is left to scroll, so a point that cannot be honoured because the
          // page is already against its edge is not counted as a fault.
          roomUp: s.scrollTop,
          roomDown: s.scrollHeight - s.clientHeight - s.scrollTop,
          roomLeft: s.scrollLeft,
          roomRight: s.scrollWidth - s.clientWidth - s.scrollLeft,
        };
      },
      dtBefore
    );
    ok('the double tap magnified the page', dtAfter.w > dtBefore.w * 1.2, `${Math.round(dtBefore.w)} -> ${Math.round(dtAfter.w)}px`);
    /*
      Held as closely as the page allows. Zooming towards a point near the top of a page can
      require scrolling above the start of the document, which is not possible and would leave
      a gap above the page; in that case the page is simply held against its edge, which is
      what any reader does. So a drift is only a fault if there was still room to correct it.
    */
    const dy = dtAfter.y - tap.y;
    const dx = dtAfter.x - tap.x;
    const heldY = Math.abs(dy) <= 30 || (dy < 0 ? dtAfter.roomUp <= 1 : dtAfter.roomDown <= 1);
    const heldX = Math.abs(dx) <= 30 || (dx < 0 ? dtAfter.roomLeft <= 1 : dtAfter.roomRight <= 1);
    ok(
      'the tapped point is held as closely as the page allows',
      heldX && heldY,
      `drifted ${Math.round(dx)},${Math.round(dy)}px; room up ${Math.round(dtAfter.roomUp)}, down ${Math.round(dtAfter.roomDown)}`
    );
    await ctx.close();
  }

  // ---- 3. a page that has already been drawn comes back quickly, and is not blank ----
  console.log('\n[3] turning back to a page already read is quick');
  {
    const ctx = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
      locale: 'bg-BG',
      hasTouch: true,
      serviceWorkers: 'block',
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await openFirstDoc(page);

    const next = page.locator('.vw__foot .vbtn').nth(1);
    const prev = page.locator('.vw__foot .vbtn').nth(0);
    const label = () => page.locator('.vw__pg-long').innerText();

    // Let the neighbours be drawn in the background first.
    await page.waitForTimeout(900);

    const t0 = Date.now();
    await next.click();
    await page.waitForFunction(() => /\s2\s/.test(document.querySelector('.vw__pg-long').innerText), null, { timeout: 15000 });
    const forward = Date.now() - t0;

    await page.waitForTimeout(900);
    const t1 = Date.now();
    await prev.click();
    await page.waitForFunction(() => /\s1\s/.test(document.querySelector('.vw__pg-long').innerText), null, { timeout: 15000 });
    const back = Date.now() - t1;

    ok('going forward is prompt', forward < 1200, `${forward}ms`);
    ok('going back to a page already drawn is prompt', back < 1200, `${back}ms`);
    console.log(`        (${await label()})`);

    // The cached copy must actually contain the page, not an empty white rectangle.
    const ink = await page.evaluate(() => {
      const c = document.querySelector('.vw__canvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, Math.min(c.height, 1200)).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4 * 37) if (d[i] < 200) dark++;
      return dark;
    });
    ok('the page brought back from the cache has content on it', ink > 50, `${ink} dark samples`);

    // And walking through every page of a longer document must not leave a blank.
    for (let i = 0; i < 5; i++) {
      await next.click();
      await page.waitForTimeout(450);
      const blank = await page.evaluate(() => {
        const c = document.querySelector('.vw__canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 900)).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4 * 61) if (d[i] < 200) dark++;
        return dark < 10;
      });
      ok(`page ${i + 2} is drawn, not blank`, !blank);
    }
    await ctx.close();
  }

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
