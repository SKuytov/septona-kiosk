// Open all 55 documents through the real UI and record which ones render a canvas
// versus showing an error. This is the path the panel actually takes.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, locale: "en-US" });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 200)); });

  await ctx.route('**/api/**', (r) => r.abort()); // stay purely on bundled content
  await page.goto((process.env.BASE || 'http://127.0.0.1:4173/'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.rail .tab', { timeout: 90000 });
  await page.waitForTimeout(2000);
  // Switch the global language to EN, which is what the operator did.
  await page.locator('.lang button', { hasText: 'EN' }).click().catch(async () => {
    await page.getByText('EN', { exact: true }).click();
  });
  await page.waitForTimeout(1500);
  console.log('language switched to EN');

  const tabCount = await page.locator('.rail .tab').count();
  let total = 0, ok = 0;
  const failures = [];

  for (let ti = 0; ti < tabCount; ti++) {
    await page.locator('.rail .tab').nth(ti).click();
    await page.waitForTimeout(900);
    const cat = ((await page.locator('.cat-hd__t').textContent().catch(() => '?')) || '?').trim();
    const cards = await page.locator('.card').count();
    console.log(`\n[${cat}] ${cards} documents`);

    for (let ci = 0; ci < cards; ci++) {
      const title = ((await page.locator('.card__t').nth(ci).textContent().catch(() => '?')) || '?').trim();
      await page.locator('.card').nth(ci).click();
      total++;

      // Either a canvas appears, or the viewer shows an error.
      let verdict = 'timeout';
      for (let w = 0; w < 30; w++) {
        await page.waitForTimeout(400);
        const box = await page.locator('canvas').first().boundingBox().catch(() => null);
        if (box && box.width > 50) { verdict = 'ok'; break; }
        const errTxt = await page.locator('.vw__err, .vw__msg').first().textContent().catch(() => null);
        if (errTxt && errTxt.trim()) { verdict = 'ERROR: ' + errTxt.trim().slice(0, 70); break; }
      }
      if (verdict === 'ok') { ok++; process.stdout.write('.'); }
      else { failures.push({ cat, title, verdict }); process.stdout.write('X'); }

      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
      // Make sure the viewer really closed before the next click.
      if (await page.locator('canvas').first().isVisible().catch(() => false)) {
        await page.locator('.vw__close, .vbtn').first().click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  }

  console.log(`\n\nrendered: ${ok}/${total}`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log(`  [${f.cat}] ${f.title} -> ${f.verdict}`);
  }
  if (errs.length) {
    console.log('\nfirst page/console errors:');
    [...new Set(errs)].slice(0, 8).forEach((e) => console.log('  ' + e));
  }
  await browser.close();
})();
