// Walks an administrator through deleting a document in the real admin SPA, and photographs
// each screen. Asserting on state is what let the last four defects through — the question
// here is whether a person can see the control, understand what it will do, and land back
// somewhere sensible afterwards.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:8090/';
const OUT = '/home/user/workspace/shots';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${note ? ' — ' + note : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${note ? ' — ' + note : ''}`); }
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // ---------------------------------------------------------------- sign in
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', 'admin@septona.local');
  await page.fill('input[type=password]', 'septona-admin');
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar, nav', { timeout: 15000 });

  await page.goto(BASE + '#/documents', { waitUntil: 'networkidle' });
  await page.waitForSelector('table tbody tr', { timeout: 15000 });

  // Narrow to the throwaway category before touching anything. The list is the real one, and
  // the first row of it is a real Septona policy — a test that archives whatever happens to
  // sort first is a test that deletes company documents.
  await page.selectOption('.toolbar select[aria-label*="атегори"], .toolbar select >> nth=0',
    { label: 'UI тест изтриване' }).catch(async () => {
    const sel = page.locator('.toolbar select').first();
    await sel.selectOption({ label: 'UI тест изтриване' });
  });
  await page.waitForTimeout(1200);
  const scoped = await page.locator('table tbody').innerText();
  ok('the list is scoped to the test category', !/Политик|евакуац/i.test(scoped),
    scoped.split('\n')[0]);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/adm-1-list.png`, fullPage: false });

  const rows = await page.locator('table tbody tr').count();
  ok('the document list renders', rows > 0, `${rows} rows`);

  // ---------------------------------------------------- the control is there
  const trash = page.locator('table tbody tr .icon-button--danger').first();
  ok('every row has a delete control', await page.locator('table tbody tr .icon-button--danger').count() === rows);
  const label = await trash.getAttribute('aria-label');
  ok('the control names the document it deletes', /^Изтрий /.test(label || ''), label);

  // the switch
  ok('there is a live/archive switch', await page.locator('.seg__btn').count() === 2);
  ok('the live view is the one selected on arrival',
    await page.locator('.seg__btn[aria-pressed=true]').first().innerText() === 'Активни');

  // -------------------------------------------------- the confirmation reads
  const title = (await page.locator('table tbody tr').first().locator('td').nth(1).innerText()).trim();
  await trash.click();
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/adm-2-archive-confirm.png` });
  const dlg = await page.locator('.modal').innerText();
  ok('the dialog is about archiving, not deleting', /Архивиране/.test(dlg));
  ok('it names the document', dlg.includes(title.split('\n')[0].slice(0, 20)), title.split('\n')[0]);
  ok('it says the panels will lose it', /панел/i.test(dlg));
  ok('it says the history is kept', /остават запазени|историята/i.test(dlg));
  ok('it says it can be undone', /върнат|Архив/i.test(dlg));

  // cancel: nothing may happen
  await page.locator('.modal .button--secondary, .modal .button--quiet').first().click();
  await page.waitForTimeout(500);
  ok('cancelling leaves the list untouched', await page.locator('table tbody tr').count() === rows);

  // -------------------------------------------------------- actually archive
  await page.locator('table tbody tr .icon-button--danger').first().click();
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.locator('.modal .button--danger, .modal .button--primary').first().click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/adm-3-after-archive.png` });
  const after = await page.locator('table tbody tr').count();
  ok('the archived document leaves the list', after === rows - 1, `${rows} -> ${after}`);
  const toast = await page.locator('.toast, [role=status]').first().innerText().catch(() => '');
  ok('a message confirms what happened', /архивиран/i.test(toast), toast.replace(/\n/g, ' '));

  // ------------------------------------------------------- the archive view
  await page.locator('.seg__btn', { hasText: 'Архив' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/adm-4-archive-view.png` });
  const arch = await page.locator('table tbody tr').count();
  ok('the archive view shows the archived document', arch >= 1, `${arch} rows`);
  const archText = await page.locator('table tbody').innerText();
  ok('and it is the right one', archText.includes(title.split('\n')[0].slice(0, 20)));
  ok('the archive explains itself', /не се показват на панелите/.test(await page.locator('.warning-callout').first().innerText()));
  ok('the archive offers to restore', await page.locator('table tbody tr', { hasText: 'Върни' }).count() >= 1);
  // Case-insensitively: the header is uppercased in CSS, so innerText reads "АРХИВИРАН" and a
  // literal comparison against the source string fails while the screen is perfectly correct.
  ok('the date column switches to the archive date',
    /архивиран/i.test(await page.locator('table thead').innerText()));

  // ------------------------------------------- permanent deletion is guarded
  await page.locator('table tbody tr .icon-button--danger').first().click();
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/adm-5-purge-confirm.png` });
  const purge = await page.locator('.modal').innerText();
  ok('the permanent dialog says it cannot be undone', /не може да бъде отменено/.test(purge));
  ok('it says the files leave the server', /файлове.*премахват|премахват.*сървъра/.test(purge));
  ok('it says the audit trail survives', /одитн/i.test(purge));
  const confirmBtn = page.locator('.modal .button--danger');
  ok('the confirm button starts disabled', await confirmBtn.isDisabled());
  await page.fill('#purge-confirm', 'не е точното заглавие');
  await page.waitForTimeout(200);
  ok('a wrong title keeps it disabled', await confirmBtn.isDisabled());
  await page.fill('#purge-confirm', title.split('\n')[0].trim());
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/adm-6-purge-armed.png` });
  ok('the exact title enables it', !(await confirmBtn.isDisabled()));

  await confirmBtn.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/adm-7-after-purge.png` });
  const left = await page.locator('table tbody tr').count();
  ok('the document is gone from the archive too', left === arch - 1, `${arch} -> ${left}`);
  const t2 = await page.locator('.toast, [role=status]').first().innerText().catch(() => '');
  ok('and it reports the files that were removed', /изтрит окончателно/i.test(t2), t2.replace(/\n/g, ' '));

  if (left === 0) {
    ok('an empty archive says so rather than showing an upload prompt',
      /Архивът е празен/.test(await page.locator('.empty-state').first().innerText()));
  }

  // ------------------------------------------------------- selecting several
  await page.locator('.seg__btn', { hasText: 'Активни' }).click();
  await page.waitForTimeout(1200);
  const live = await page.locator('table tbody tr').count();
  await page.locator('table thead input[type=checkbox]').check();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/adm-9-bulk.png` });
  const bar = await page.locator('.warning-callout').last().innerText();
  ok('selecting rows offers to archive them', /Архивирай избраните/.test(bar), bar.replace(/\n/g, ' '));
  await page.locator('.warning-callout .button--danger').click();
  await page.waitForSelector('.modal', { timeout: 5000 });
  const bulkDlg = await page.locator('.modal').innerText();
  ok('the bulk dialog counts what it will archive', new RegExp(`${live} документа`).test(bulkDlg),
    bulkDlg.replace(/\n/g, ' ').slice(0, 90));
  // Cancel: this test is not here to empty the category before the detail check runs.
  await page.locator('.modal .button--secondary').first().click();
  await page.waitForTimeout(500);
  ok('cancelling the bulk dialog archives nothing',
    await page.locator('table tbody tr').count() === live);
  await page.locator('.button--quiet', { hasText: 'Откажи избора' }).click();
  await page.waitForTimeout(400);

  // ----------------------------------------------- the detail page's control
  await page.locator('.seg__btn', { hasText: 'Активни' }).click();
  await page.waitForTimeout(1200);
  await page.locator('table tbody tr .icon-button[aria-label^=Отвори]').first().click();
  await page.waitForSelector('.preview, .card', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/adm-8-detail.png` });
  ok('the detail page offers to archive', await page.locator('.button', { hasText: 'Архивирай' }).count() >= 1);

  // ------------------------------------------------ an editor sees no delete
  await ctx.clearCookies();
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => { try { localStorage.clear(); } catch { /* first party only */ } });
  await p2.goto(BASE, { waitUntil: 'networkidle' });
  console.log('  (editor check runs in the API test — the SPA keeps its token in localStorage)');
  await p2.close();

  ok('no console errors during any of it', errors.length === 0, errors.slice(0, 3).join(' | '));

  // Teardown lives in seed_ui_docs.py, which clears the test category before it seeds. Doing
  // it from inside the page meant guessing which localStorage key holds the token, and a
  // wrong guess sent unauthenticated deletes that failed silently — the cleanup reported
  // success while leaving two documents behind.

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
