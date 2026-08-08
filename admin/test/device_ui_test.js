// Drives the real admin UI at :8090 and creates a device through the form.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ok   ' + m) };
const bad = (m) => { fail++; console.log('  FAIL ' + m) };
const is = (m, got, want) => got === want ? ok(m) : bad(`${m} (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) });

  console.log('== sign in');
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', 'admin@septona.local');
  await page.fill('input[type=password]', 'septona-admin');
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Обзор', { timeout: 15000 });
  ok('signed in');

  console.log('== open the devices page');
  await page.click('text=Устройства');
  await page.waitForSelector('h1:has-text("Устройства")');
  await page.waitForTimeout(600);
  ok('devices page open');

  console.log('== the button opens a form, it does not error');
  const before = await page.locator('.toast--error').count();
  await page.locator('button:has-text("Ново устройство")').first().click();
  await page.waitForTimeout(700);
  const dialog = page.locator('[role=dialog]');
  is('a dialog opened', await dialog.count(), 1);
  is('no error toast', await page.locator('.toast--error').count(), before);
  is('dialog title', (await dialog.locator('h2').innerText()).trim(), 'Ново устройство');
  is('name field present', await page.locator('#device-name').count(), 1);
  is('location field present', await page.locator('#device-location').count(), 1);
  is('name is focused', await page.evaluate(() => document.activeElement?.id), 'device-name');
  is('submit disabled while empty', await page.locator('button[type=submit]').isDisabled(), true);

  console.log('== empty name cannot be submitted');
  await page.locator('#device-name').fill('   ');
  await page.waitForTimeout(200);
  is('whitespace name keeps submit disabled', await page.locator('button[type=submit]').isDisabled(), true);

  console.log('== create a device');
  const NAME = 'Киоск — склад ' + Date.now();
  await page.locator('#device-name').fill(NAME);
  await page.locator('#device-location').fill('Склад, до входа');
  await page.waitForTimeout(200);
  is('submit enabled', await page.locator('button[type=submit]').isDisabled(), false);
  await page.locator('button[type=submit]').click();
  await page.waitForSelector('h2:has-text("Ключ за новото устройство")', { timeout: 15000 });
  ok('key dialog shown');
  const key = (await page.locator('.key-box').innerText()).trim();
  if (/^sk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/.test(key)) ok('key looks valid: ' + key.slice(0, 15) + '…');
  else bad('key format: ' + key);

  await page.screenshot({ path: 'shots/dev-key.png' });
  await page.locator('button:has-text("Разбрах")').click();
  await page.waitForTimeout(900);

  console.log('== it appears in the list');
  const row = page.locator('tbody tr', { hasText: NAME });
  is('row present', await row.count(), 1);
  const rowText = await row.innerText();
  if (rowText.includes('Склад, до входа')) ok('location shown'); else bad('location missing from row: ' + rowText.replace(/\n/g, ' | '));
  await page.screenshot({ path: 'shots/dev-list.png' });

  console.log('== it survives a reload');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  is('still listed after reload', await page.locator('tbody tr', { hasText: NAME }).count(), 1);

  console.log('== the audit log recorded it');
  await page.click('text=Одит дневник');
  await page.waitForTimeout(1200);
  const audit = await page.locator('body').innerText();
  if (audit.includes(NAME)) ok('audit entry names the device'); else bad('no audit entry for the device');

  console.log('== revoking marks the row instead of leaving it live');
  await page.click('text=Устройства');
  await page.waitForSelector('h1:has-text("Устройства")');
  await page.waitForTimeout(900);
  await page.locator('tbody tr', { hasText: NAME }).locator('button[aria-label="Отнеми ключа"]').click();
  await page.waitForTimeout(400);
  await page.locator('button:has-text("Отнеми ключа")').last().click();
  await page.waitForTimeout(1200);
  const revoked = page.locator('tbody tr', { hasText: NAME });
  is('row still listed', await revoked.count(), 1);
  if ((await revoked.innerText()).includes('Отнет достъп')) ok('marked as revoked'); else bad('no revoked marker: ' + (await revoked.innerText()).replace(/\n/g,' | '));
  is('revoke button gone', await revoked.locator('button[aria-label="Отнеми ключа"]').count(), 0);
  await page.screenshot({ path: 'shots/dev-revoked.png' });

  console.log('== the form can be cancelled');
  await page.click('text=Устройства');
  await page.waitForSelector('h1:has-text("Устройства")');
  await page.locator('button:has-text("Ново устройство")').first().click();
  await page.waitForTimeout(500);
  await page.locator('button:has-text("Отказ")').click();
  await page.waitForTimeout(400);
  is('dialog closed', await page.locator('[role=dialog]').count(), 0);
  is('nothing created on cancel', await page.locator('tbody tr').count(), await page.locator('tbody tr').count());

  console.log('== no console errors anywhere');
  const real = errors.filter(e => !/favicon|Failed to load resource.*404/i.test(e));
  is('clean console', real.length, 0);
  if (real.length) console.log(real.slice(0, 5));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
