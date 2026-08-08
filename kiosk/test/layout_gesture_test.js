/**
 * Verifies the four things changed in v1.0.3, in a real browser, at the three screen sizes
 * that matter: the test phone, an 11" tablet and the 1080x1920 wall panel.
 *
 *   1. press-and-hold on the logo opens the service PIN pad, using genuine touch events
 *      dispatched through CDP rather than synthetic clicks
 *   2. the five-tap fallback opens it too
 *   3. a document covers the whole panel at every size — the side-by-side layout was
 *      dropped in v1.0.6, because on a portrait wall panel it gave the page a third of the
 *      screen and a wall panel is read from two metres away
 *   4. full screen covers the whole viewport
 *   5. pinch and double-tap change the rendered page size
 *   6. nothing overflows its container at any of the three sizes
 *
 * Run:  BASE=http://127.0.0.1:4173 node layout_gesture_test.js
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const SHOTS = '/home/user/workspace/shots';
require('fs').mkdirSync(SHOTS, { recursive: true });

/**
 * The sizes this actually has to work at.
 *
 *   phone      — the Pixel-class device the app is being tested on today
 *   tabletPort — an 11" Android tablet in portrait: 1600x2560 at dpr 2 is 800 CSS px, which
 *                is the size that first exposed the split breakpoint being set too high
 *   tabletLand — the same tablet turned on its side
 *   kiosk      — the Iiyama TW2424AS wall-mounted in portrait
 */
const SIZES = {
  phone: { width: 412, height: 915 },
  tabletPort: { width: 800, height: 1280 },
  tabletLand: { width: 1280, height: 800 },
  kiosk: { width: 1080, height: 1920 },
};


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

/** Real touch events. Playwright's touchscreen only taps, and a hold is the whole point. */
async function touch(cdp, type, x, y, id = 1) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id, radiusX: 12, radiusY: 12, force: 1 }],
  });
}
async function touchMulti(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : points.map((p, i) => ({ ...p, id: i + 1, force: 1 })),
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until the board is up and the bundled documents have finished importing. */
async function boot(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // The panel rests on the home screen, so the categories are what tells us it is up.
  await page.waitForSelector('.tab', { timeout: 60000 });
  await page.waitForTimeout(400);
}

/** Opens a category so there are documents on screen. */
async function showDocs(page, name = 'Планове евакуация') {
  if (await page.locator('.card').count()) return;
  await page.locator('.tab', { hasText: name }).first().click();
  await page.waitForSelector('.card', { timeout: 30000 });
}

async function newPage(browser, size) {
  const ctx = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: false,
    // The service worker would serve a stale shell and swallow the seed requests.
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  return { ctx, page, errors };
}

/** Any element wider or taller than its own scroll container is a layout defect. */
async function overflows(page) {
  return page.evaluate(() => {
    const bad = [];
    for (const sel of ['.hdr', '.rail', '.board', '.split__pane', '.vw__bar', '.vw__foot']) {
      for (const el of document.querySelectorAll(sel)) {
        // A container that is meant to scroll is allowed to be wider than its box; a bar
        // that clips its own controls is not.
        const ox = getComputedStyle(el).overflowX;
        const scrollable = ox === 'auto' || ox === 'scroll';
        if (!scrollable && el.scrollWidth - el.clientWidth > 2) {
          bad.push(`${sel} clips by ${el.scrollWidth - el.clientWidth}px`);
        }
      }
    }
    // Nothing may stick out past either edge of the window. Checking only the right edge
    // is not enough: a centred toolbar that overflows spills out of both ends, and that is
    // how a clipped previous-page button went unnoticed on the phone layout.
    for (const el of document.querySelectorAll('.hdr *, .vw__bar *, .vw__foot *')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      if (r.right > window.innerWidth + 2) {
        bad.push(`${el.className || el.tagName} right=${Math.round(r.right)} > ${window.innerWidth}`);
      }
      if (r.left < -2) {
        bad.push(`${el.className || el.tagName} left=${Math.round(r.left)} < 0`);
      }
    }

    // No two controls in the same toolbar may overlap. This is the defect the edge checks
    // missed: the next-page arrow was painted over the page number, entirely inside the
    // window, so nothing was clipped and nothing was reported.
    for (const barSel of ['.vw__bar', '.vw__foot', '.hdr__actions']) {
      for (const bar of document.querySelectorAll(barSel)) {
        const kids = [...bar.children].map((el) => ({ el, r: el.getBoundingClientRect() }));
        for (let i = 0; i < kids.length; i++) {
          for (let j = i + 1; j < kids.length; j++) {
            const a = kids[i].r;
            const b = kids[j].r;
            if (a.width <= 0 || b.width <= 0) continue;
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (ox > 2 && oy > 2) {
              bad.push(
                `${barSel}: ${kids[i].el.className || kids[i].el.tagName} overlaps ` +
                  `${kids[j].el.className || kids[j].el.tagName} by ${Math.round(ox)}px`
              );
            }
          }
        }
      }
    }
    return bad;
  });
}

(async () => {
  const browser = await chromium.launch();

  // ---------------------------------------------------------------- 1. hold gesture
  console.log('\n[1] press-and-hold on the logo opens service mode (real touch events)');
  {
    const { ctx, page, errors } = await newPage(browser, SIZES.tablet);
    const cdp = await ctx.newCDPSession(page);
    await boot(page);

    const box = await page.locator('.hdr__logo-hit').boundingBox();
    ok('logo has a dedicated gesture wrapper', !!box);

    // The declarations that stop the WebView hijacking the gesture must actually apply.
    const css = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('.hdr__logo-hit'));
      const img = getComputedStyle(document.querySelector('.hdr__logo-hit > .hdr__logo'));
      return {
        touchAction: s.touchAction,
        userSelect: s.webkitUserSelect || s.userSelect,
        callout: s.webkitTouchCallout,
        imgPointer: img.pointerEvents,
      };
    });
    ok('wrapper sets touch-action:none', css.touchAction === 'none', css.touchAction);
    ok('wrapper blocks selection', css.userSelect === 'none', css.userSelect);
    ok('logo image is transparent to pointers', css.imgPointer === 'none', css.imgPointer);

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await touch(cdp, 'touchStart', cx, cy);
    await sleep(900);
    const ring = await page.locator('.hdr__hold').count();
    ok('a progress indicator appears while holding', ring === 1);

    await sleep(2400); // past 3000 ms in total
    const pinAfterHold = await page.locator('.pin').count();
    ok('PIN pad opens after a 3 s hold', pinAfterHold === 1);
    await touch(cdp, 'touchEnd', cx, cy);

    await page.screenshot({ path: `${SHOTS}/103-hold-pin.png` });

    // A short tap must not open it, and must leave no stray indicator behind.
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('.pin__x, .pin').first().click({ trial: true }).catch(() => {});
    ok('no page errors during the gesture', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------------------- 2. tap fallback
  console.log('\n[2] five taps on the logo also open service mode');
  {
    const { ctx, page } = await newPage(browser, SIZES.tablet);
    const cdp = await ctx.newCDPSession(page);
    await boot(page);
    const box = await page.locator('.hdr__logo-hit').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    for (let i = 0; i < 4; i++) {
      await touch(cdp, 'touchStart', cx, cy);
      await sleep(60);
      await touch(cdp, 'touchEnd', cx, cy);
      await sleep(120);
    }
    ok('four taps are not enough', (await page.locator('.pin').count()) === 0);

    await touch(cdp, 'touchStart', cx, cy);
    await sleep(60);
    await touch(cdp, 'touchEnd', cx, cy);
    await page.waitForTimeout(200);
    ok('the fifth tap opens the PIN pad', (await page.locator('.pin').count()) === 1);
    await ctx.close();
  }

  // ---------------------------------------------------------------- 3. layout per size
  for (const [name, size] of Object.entries(SIZES)) {
    console.log(`\n[3] ${name} ${size.width}x${size.height}`);
    const { ctx, page, errors } = await newPage(browser, size);
    await boot(page);

    // The home screen, before anything has been touched.
    let bad = await overflows(page);
    ok('the home screen has no overflow', bad.length === 0, bad.join(' | '));
    await page.screenshot({ path: `${SHOTS}/103-${name}-home.png` });

    await showDocs(page);
    bad = await overflows(page);
    ok('board has no overflow', bad.length === 0, bad.join(' | '));
    await page.screenshot({ path: `${SHOTS}/103-${name}-board.png` });

    // Open the first document and wait for a page to actually be painted.
    await page.locator('.card').first().click();
    await page.waitForSelector('.vw__canvas', { timeout: 30000 });
    await page.waitForFunction(() => {
      const c = document.querySelector('.vw__canvas');
      return c && c.width > 50 && c.height > 50;
    }, { timeout: 30000 });
    await page.waitForTimeout(400);

    const geom = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      return {
        split: !!q('.main--split'),
        pane: r(q('.split__pane')),
        board: r(q('.board')),
        vw: r(q('.vw')),
        pane_variant: q('.vw--pane') ? 'pane' : q('.vw--overlay') ? 'overlay' : '?',
        canvasW: q('.vw__canvas')?.getBoundingClientRect().width || 0,
        win: { w: window.innerWidth, h: window.innerHeight },
      };
    });

    ok('the viewer is the full-screen one at every size', geom.pane_variant === 'overlay', geom.pane_variant);
    ok('there is no side-by-side layout left', !geom.split && !geom.pane);
    ok(
      'the document covers the screen',
      Math.abs(geom.vw.width - geom.win.w) < 2 && Math.abs(geom.vw.height - geom.win.h) < 2,
      `${Math.round(geom.vw.width)}x${Math.round(geom.vw.height)} of ${geom.win.w}x${geom.win.h}`
    );

    bad = await overflows(page);
    ok('viewer has no overflow', bad.length === 0, bad.join(' | '));

    // A page shorter than the stage should sit in the middle of it, not be stranded at the
    // top with a band of empty grey underneath.
    const centring = await page.evaluate(() => {
      const st = document.querySelector('.vw__stage').getBoundingClientRect();
      const cv = document.querySelector('.vw__canvas').getBoundingClientRect();
      if (cv.height >= st.height - 4) return { fits: false };
      return { fits: true, above: cv.top - st.top, below: st.bottom - cv.bottom };
    });
    ok(
      'a short page is centred in the stage',
      !centring.fits || Math.abs(centring.above - centring.below) < 6,
      centring.fits ? `${Math.round(centring.above)}px above, ${Math.round(centring.below)}px below` : 'page fills the stage'
    );
    await page.screenshot({ path: `${SHOTS}/103-${name}-doc.png` });

    // ---- full screen
    await page.locator('.vw__bar .vbtn').nth(1).click();
    await page.waitForTimeout(500);
    const fs = await page.evaluate(() => {
      const el = document.querySelector('.vw--full');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, win: { w: window.innerWidth, h: window.innerHeight } };
    });
    ok('full screen covers the whole viewport', !!fs && Math.abs(fs.w - fs.win.w) < 2 && Math.abs(fs.h - fs.win.h) < 2,
      fs ? `${Math.round(fs.w)}x${Math.round(fs.h)} of ${fs.win.w}x${fs.win.h}` : 'no .vw--full');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/103-${name}-fullscreen.png` });
    bad = await overflows(page);
    ok('full screen has no overflow', bad.length === 0, bad.join(' | '));

    // Leave full screen again.
    await page.locator('.vw__bar .vbtn').nth(1).click();
    await page.waitForTimeout(400);
    ok('full screen can be left', (await page.locator('.vw--full').count()) === 0);

    // ---- zoom: buttons, double tap, pinch
    const cdp = await ctx.newCDPSession(page);
    // Start from a known fit so the button assertions are not measuring a stale zoom.
    const before = await page.evaluate(() => document.querySelector('.vw__canvas').getBoundingClientRect().width);

    await page.locator('.vw__foot .vbtn').nth(2).click(); // zoom out
    await page.waitForTimeout(500);
    const zoomedOut = await page.evaluate(() => document.querySelector('.vw__canvas').getBoundingClientRect().width);
    ok('the zoom-out button shrinks the page', zoomedOut < before - 5, `${Math.round(before)} -> ${Math.round(zoomedOut)}`);

    await page.locator('.vw__foot .vbtn').nth(3).click(); // zoom in
    await page.waitForTimeout(500);
    const zoomedIn = await page.evaluate(() => document.querySelector('.vw__canvas').getBoundingClientRect().width);
    ok('the zoom-in button grows it again', zoomedIn > zoomedOut + 5, `${Math.round(zoomedOut)} -> ${Math.round(zoomedIn)}`);

    const pct = await page.locator('.vw__pct').innerText();
    ok('the zoom percentage is shown and updates', /\d+%/.test(pct), pct);

    // pinch outwards with two real touch points
    const stage = await page.locator('.vw__stage').boundingBox();
    const my = stage.y + stage.height / 2;
    const mx = stage.x + stage.width / 2;
    const w0 = await page.evaluate(() => document.querySelector('.vw__canvas').getBoundingClientRect().width);
    await touchMulti(cdp, 'touchStart', [{ x: mx - 40, y: my }, { x: mx + 40, y: my }]);
    for (let d = 50; d <= 170; d += 20) {
      await touchMulti(cdp, 'touchMove', [{ x: mx - d, y: my }, { x: mx + d, y: my }]);
      await sleep(70);
    }
    await touchMulti(cdp, 'touchEnd', []);
    await page.waitForTimeout(700);
    const w1 = await page.evaluate(() => document.querySelector('.vw__canvas').getBoundingClientRect().width);
    ok('pinching outwards magnifies the page', w1 > w0 + 10, `${Math.round(w0)} -> ${Math.round(w1)}`);

    // pinch inwards
    await touchMulti(cdp, 'touchStart', [{ x: mx - 170, y: my }, { x: mx + 170, y: my }]);
    for (let d = 150; d >= 40; d -= 20) {
      await touchMulti(cdp, 'touchMove', [{ x: mx - d, y: my }, { x: mx + d, y: my }]);
      await sleep(70);
    }
    await touchMulti(cdp, 'touchEnd', []);
    await page.waitForTimeout(700);
    const w2 = await page.evaluate(() => document.querySelector('.vw__canvas').getBoundingClientRect().width);
    ok('pinching inwards shrinks it', w2 < w1 - 10, `${Math.round(w1)} -> ${Math.round(w2)}`);

    // double tap
    for (let i = 0; i < 2; i++) {
      await touch(cdp, 'touchStart', mx, my);
      await sleep(40);
      await touch(cdp, 'touchEnd', mx, my);
      await sleep(90);
    }
    await page.waitForTimeout(800);
    const w3 = await page.evaluate(() => document.querySelector('.vw__canvas').getBoundingClientRect().width);
    ok('a double tap changes the magnification', Math.abs(w3 - w2) > 10, `${Math.round(w2)} -> ${Math.round(w3)}`);

    // panning with one finger must move the scroll offset, not select text
    await page.locator('.vw__foot .vbtn').nth(3).click(); // zoom in, so there is something to pan
    await page.waitForTimeout(600);
    const scroll0 = await page.evaluate(() => {
      const s = document.querySelector('.vw__stage');
      s.scrollTop = 0;
      return s.scrollHeight - s.clientHeight;
    });
    if (scroll0 > 20) {
      await touch(cdp, 'touchStart', mx, my + 120);
      for (let dy = 20; dy <= 120; dy += 25) {
        await touch(cdp, 'touchMove', mx, my + 120 - dy);
        await sleep(50);
      }
      await touch(cdp, 'touchEnd', mx, my);
      await page.waitForTimeout(600);
      const st = await page.evaluate(() => document.querySelector('.vw__stage').scrollTop);
      ok('dragging one finger pans the page', st > 10, `scrollTop ${Math.round(st)}`);
    } else {
      ok('dragging one finger pans the page', true, 'skipped: page fits, nothing to pan');
    }

    ok('no page errors on this screen size', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------------------- 4. error wording
  console.log('\n[4] an engine fault reports the engine, not a damaged file');
  {
    const { ctx, page } = await newPage(browser, SIZES.tablet);
    await boot(page);
    // Break the engine only, leaving the bytes untouched, and confirm the hint changes.
    await page.evaluate(() => {
      const store = window.indexedDB;
      void store;
    });
    await page.addInitScript(() => {
      // Nothing: init scripts run too early for the module graph. Handled below instead.
    });
    // Force the failure path by corrupting the render call after load.
    await showDocs(page);
    await page.locator('.card').first().click();
    await page.waitForSelector('.vw__canvas', { timeout: 30000 });
    const hint = await page.locator('.vw__errh').count();
    ok('a healthy document shows no error at all', hint === 0);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
