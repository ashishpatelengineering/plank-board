import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('/opt/npm-tools/node_modules/playwright');
const BASE = process.env.BASE || 'http://localhost:8801';
let n = 0, failed = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').slice(0, 4).join(' | ')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch();
async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const net = { offline: false, open: new Set() };
  const page = await ctx.newPage(); const errs = [];
  await page.routeWebSocket(/\/ws\//, ws => { if (net.offline) { ws.close(); return; } const server = ws.connectToServer(); net.open.add(ws); ws.onClose(() => net.open.delete(ws)); }); page.on('pageerror', e => errs.push(String(e))); page.on('console', m => { if (m.type() === 'error' && !/WebSocket|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await page.goto(BASE); await page.waitForSelector('#nm-input');
  return { ctx, page, name, errs, net };
}
const enterName = async p => { await p.page.fill('#nm-input', p.name); await p.page.click('#nm-save'); await p.page.waitForSelector('.list'); };
const titles = p => p.page.locator('.card .title, .card .ctitle, .card [class*=title]').allTextContents();
const cardTexts = async (p, list) => (await p.page.locator(`section.list[aria-label="${list}"] .card`).allInnerTexts()).map(s => s.split('\n')[0].trim());
const waitCards = async (p, list, pred, ms = 6000) => { const end = Date.now() + ms; let got; while (Date.now() < end) { got = await cardTexts(p, list); if (pred(got)) return got; await sleep(150); } throw new Error(`${p.email} ${list}: ${JSON.stringify(got)}`); };
const addCard = async (p, list, text) => { await p.page.locator(`section.list[aria-label="${list}"] .add-btn`).click(); await p.page.keyboard.type(text); await p.page.keyboard.press('Enter'); await p.page.keyboard.press('Escape'); };
const menu = async (p, label) => { await p.page.click('#menu-btn'); await p.page.locator('.menu-item', { hasText: label }).first().click(); };

let ann, bob;
await t('a first-time visitor is asked for a name, then gets a sample board', async () => {
  ann = await person('Ann');
  assert.match(await ann.page.locator('.overlay').innerText(), /What should we call you\?/); assert.ok(!/null|undefined/.test(await ann.page.locator('.overlay').innerText()));
  await ann.page.click('#nm-save'); assert.equal(await ann.page.locator('#nm-input').count(), 1, 'a name is required');
  await enterName(ann);
  assert.equal(await ann.page.locator('#board-name').innerText(), 'My board'); assert.ok((await cardTexts(ann, 'To do')).includes('Drag me to Doing'));
  assert.equal(await ann.page.locator('#warn.show').count(), 0);
});
await t('a second person types their name and sees the same board, with the first shown as online', async () => {
  bob = await person('Bob'); await enterName(bob);
  assert.equal(await bob.page.locator('#board-name').innerText(), 'My board'); assert.ok((await cardTexts(bob, 'To do')).includes('Drag me to Doing'));
  await bob.page.waitForSelector('#presence.show .pp'); assert.equal((await bob.page.locator('#presence .pp').first().getAttribute('title')), 'Ann is here too');
  await ann.page.waitForSelector('#presence.show .pp'); assert.equal((await ann.page.locator('#presence .pp').first().innerText()), 'BO');
  const list = await (await fetch(BASE + '/api/boards', { headers: { 'x-plank-name': 'Zoe' } })).json(); assert.equal(list.boards.length, 1, 'one shared board, not one each');
});
await t('a card added by one person appears for the other within a moment, without reloading', async () => {
  await addCard(ann, 'To do', 'Order the cake'); await waitCards(bob, 'To do', c => c.includes('Order the cake'));
  await addCard(bob, 'Doing', 'Buy balloons'); await waitCards(ann, 'Doing', c => c.includes('Buy balloons'));
});
await t('moving a card by drag shows up for the other person', async () => {
  const src = ann.page.locator('section.list[aria-label="To do"] .card', { hasText: 'Order the cake' }), dst = ann.page.locator('section.list[aria-label="Done"] .cards');
  const a = await src.boundingBox(), d = await dst.boundingBox();
  await ann.page.mouse.move(a.x + 20, a.y + 15); await ann.page.mouse.down(); await ann.page.mouse.move(a.x + 40, a.y + 30, { steps: 4 }); await ann.page.mouse.move(d.x + 40, d.y + 30, { steps: 12 }); await ann.page.mouse.up();
  await waitCards(ann, 'Done', c => c.includes('Order the cake')); await waitCards(bob, 'Done', c => c.includes('Order the cake')); await waitCards(bob, 'To do', c => !c.includes('Order the cake'));
});
await t('edits to a card sheet reach the other person (labels, complete, notes)', async () => {
  await ann.page.locator('.card', { hasText: 'Order the cake' }).click(); await ann.page.locator('[data-label="l1"]').click(); await ann.page.locator('#cm-done').check(); await ann.page.fill('textarea', 'Chocolate, 12 people'); await sleep(500); await ann.page.keyboard.press('Escape');
  const c = bob.page.locator('.card', { hasText: 'Order the cake' }); await c.locator('.tag, .bar-chip').first().waitFor(); assert.match(await c.innerText(), /Urgent/); assert.match(await c.innerText(), /Complete/);
  await c.click(); assert.equal(await bob.page.locator('textarea').first().inputValue(), 'Chocolate, 12 people'); await bob.page.keyboard.press('Escape');
});
await t('both people typing in different cards at the same moment keep both edits', async () => {
  await Promise.all([
    (async () => { await ann.page.locator('.card', { hasText: 'Buy balloons' }).click(); await ann.page.fill('#cm-title', 'Buy red balloons'); await sleep(900); await ann.page.keyboard.press('Escape'); })(),
    (async () => { await addCard(bob, 'To do', 'Send invitations'); })(),
  ]);
  await waitCards(bob, 'Doing', c => c.includes('Buy red balloons')); await waitCards(ann, 'To do', c => c.includes('Send invitations'));
});
await t('a teammate renaming the board updates your title', async () => {
  await menu(bob, 'Rename board'); await bob.page.keyboard.press('Control+a'); await bob.page.keyboard.type('Birthday party'); await bob.page.keyboard.press('Enter');
  await ann.page.waitForFunction(() => document.querySelector('#board-name').textContent === 'Birthday party');
});
await t('the activity trail shows who did what', async () => {
  await menu(ann, 'Activity'); await ann.page.waitForSelector('.act-row');
  const rows = await ann.page.locator('.act-row').allInnerTexts(); const all = rows.join('\n'); assert.ok(!/null|undefined/.test(await ann.page.locator('.overlay').innerText()), 'stray text in the activity window');
  assert.match(all, /Bob added “Send invitations”/); assert.match(all, /You added “Order the cake”/); assert.match(all, /renamed the board to “Birthday party”/);
  await ann.page.click('#act-close');
});
await t('undo reverts only your own last change and keeps your teammate\'s work', async () => {
  await addCard(bob, 'To do', 'Bob extra'); await waitCards(ann, 'To do', c => c.includes('Bob extra'));
  await ann.page.locator('section.list[aria-label="To do"] .card', { hasText: 'Send invitations' }).click(); await ann.page.click('#cm-delete'); await sleep(600);
  await waitCards(bob, 'To do', c => !c.includes('Send invitations'));
  await ann.page.keyboard.press('Control+z');
  await waitCards(ann, 'To do', c => c.includes('Send invitations') && c.includes('Bob extra')); await waitCards(bob, 'To do', c => c.includes('Send invitations') && c.includes('Bob extra'));
});
await t('losing the connection shows "Offline", edits are kept, and they arrive when you are back', async () => {
  bob.net.offline = true; for (const w of [...bob.net.open]) await w.close(); await bob.page.waitForSelector('#warn.show', { timeout: 8000 });
  await addCard(bob, 'Done', 'Made while offline'); await sleep(500);
  assert.ok((await cardTexts(bob, 'Done')).includes('Made while offline'));
  assert.ok(!(await cardTexts(ann, 'Done')).includes('Made while offline'));
  bob.net.offline = false; await bob.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitCards(ann, 'Done', c => c.includes('Made while offline'), 20000); await bob.page.waitForSelector('#warn:not(.show)', { state: 'attached', timeout: 20000 });
});
await t('after a reload everything is still there, on the board you were looking at', async () => {
  await ann.page.reload(); await ann.page.waitForSelector('.list');
  assert.equal(await ann.page.locator('#board-name').innerText(), 'Birthday party');
  assert.ok((await cardTexts(ann, 'Done')).includes('Made while offline'));
});
await t('archiving a card on one screen removes it from the other, and restoring brings it back', async () => {
  await ann.page.locator('.card', { hasText: 'Buy red balloons' }).click(); await ann.page.click('#cm-archive');
  await waitCards(bob, 'Doing', c => !c.includes('Buy red balloons'));
  await menu(bob, 'Archived cards'); await bob.page.locator('.arch-row', { hasText: 'Buy red balloons' }).locator('.btn', { hasText: 'Restore' }).click(); await bob.page.click('#arch-close');
  await waitCards(ann, 'Doing', c => c.includes('Buy red balloons'));
});
await t('Backups: anyone can use them; restoring asks first, changes both screens, and can be undone by restoring the kept version', async () => {
  await addCard(ann, 'To do', 'Keep me safe'); await waitCards(bob, 'To do', c => c.includes('Keep me safe'));
  await menu(bob, 'Backups'); await bob.page.waitForSelector('.tm-row');
  const rows = await bob.page.locator('.overlay .tm-row').count(); assert.ok(rows >= 1);
  const txt = await bob.page.locator('.overlay').innerText(); assert.ok(!/null|undefined|NaN/.test(txt), txt); assert.match(txt, /\d+ lists?, \d+ cards?/);
  await bob.page.locator('.overlay .tm-row .btn').last().click();
  await bob.page.waitForSelector('#bk-confirm'); assert.match(await bob.page.locator('.overlay').innerText(), /Replace the board with this version\?/);
  await bob.page.locator('.overlay .tm-row.asking .btn', { hasText: 'Cancel' }).click(); assert.equal(await bob.page.locator('#bk-confirm').count(), 0, 'cancel changes nothing');
  assert.ok((await cardTexts(ann, 'To do')).includes('Keep me safe'));
  await bob.page.locator('.overlay .tm-row .btn').last().click(); await bob.page.click('#bk-confirm');
  await bob.page.waitForSelector('.overlay', { state: 'detached' });
  await waitCards(ann, 'To do', c => !c.includes('Keep me safe')); await waitCards(bob, 'To do', c => !c.includes('Keep me safe'));
  await menu(ann, 'Backups'); await ann.page.waitForFunction(n => document.querySelectorAll('.overlay .tm-row').length > n, rows);
  await ann.page.locator('.overlay .tm-row .btn').first().click(); await ann.page.click('#bk-confirm'); await ann.page.waitForSelector('.overlay', { state: 'detached' });
  await waitCards(ann, 'To do', c => c.includes('Keep me safe')); await waitCards(bob, 'To do', c => c.includes('Keep me safe'));
  await addCard(bob, 'To do', 'Still live'); await waitCards(ann, 'To do', c => c.includes('Still live'));
});
await t('changing your name updates the badge your teammate sees', async () => {
  await menu(ann, 'Change my name'); await ann.page.fill('#nm-input', 'Annie'); await ann.page.click('#nm-save');
  await bob.page.waitForFunction(() => [...document.querySelectorAll('#presence .pp')].some(p => p.title === 'Annie is here too'), null, { timeout: 12000 });
  await ann.page.reload(); await ann.page.waitForSelector('.list'); assert.equal(await ann.page.locator('#nm-input').count(), 0, 'remembered after a reload');
  await ann.page.click('#menu-btn'); assert.ok((await ann.page.locator('.menu-item').allInnerTexts()).some(x => /You are Annie/.test(x))); await ann.page.keyboard.press('Escape');
});
await t('a board made by one person appears for the other by itself, and anyone can archive and delete it', async () => {
  await ann.page.click('#board-btn'); await ann.page.locator('.menu-item', { hasText: 'New board' }).click(); await ann.page.fill('.overlay input', 'Trip'); await ann.page.keyboard.press('Enter');
  await ann.page.waitForFunction(() => document.querySelector('#board-name').textContent === 'Trip'); await sleep(800);
  await bob.page.evaluate(() => { window.__f = setInterval(() => window.dispatchEvent(new Event('focus')), 1200); });
  await bob.page.waitForFunction(() => /added by a teammate/.test(document.querySelector('#toast').textContent), null, { timeout: 40000 });
  await bob.page.evaluate(() => clearInterval(window.__f));
  await menu(ann, 'Archive board'); await sleep(500);
  await menu(bob, 'Archived boards');
  const row = bob.page.locator('.arch-row', { hasText: 'Trip' }); await row.waitFor({ timeout: 8000 });
  assert.equal(await row.locator('.btn.danger').isDisabled(), false, 'delete is available to everyone');
});
await t('deleting a board for good removes it from the other screen too', async () => {
  const row = bob.page.locator('.arch-row', { hasText: 'Trip' });
  await row.locator('.btn.danger').click(); await bob.page.locator('.overlay').last().locator('.btn', { hasText: 'Delete forever' }).click(); await sleep(800);
  await ann.page.waitForFunction(() => /was deleted/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
  const list = await (await fetch(BASE + '/api/boards', { headers: { 'x-plank-name': 'Zoe' } })).json(); assert.ok(!list.boards.some(b => b.name === 'Trip'), JSON.stringify(list.boards.map(b => b.name)));
  assert.equal(await ann.page.locator('#board-name').innerText(), 'Birthday party');
  await bob.page.keyboard.press('Escape');
});
await t('Help explains working with the team and has no em dashes or leftovers about accounts', async () => {
  await ann.page.click('#help-btn'); await ann.page.waitForSelector('.hp-link');
  const links = await ann.page.locator('.hp-link').allInnerTexts(); assert.ok(links.some(l => /Working with your team/.test(l)), links.join('|'));
  await ann.page.locator('.hp-link', { hasText: 'Working with your team' }).click();
  let txt = await ann.page.locator('.overlay').innerText(); assert.match(txt, /team password/); assert.ok(!txt.includes('—'), 'em dash found');
  const every = [];
  for (const l of links) { await ann.page.locator('.hp-link', { hasText: l.trim() }).first().click(); every.push(await ann.page.locator('.overlay').innerText()); }
  const all = every.join('\n'); assert.ok(!/Share board|Google|Cloudflare Access|an owner|administrator|\bowners?\b/i.test(all), (/Share board|Google|Cloudflare Access|an owner|administrator|\bowners?\b/i.exec(all) || [])[0]);
  assert.ok(!all.includes('—'), 'em dash in help');
  await ann.page.keyboard.press('Escape');
});
await t('importing an Excel file creates a real shared board on the server', async () => {
  const [dl] = await Promise.all([ann.page.waitForEvent('download'), menu(ann, 'Export to Excel')]); const path = '/tmp/team-export.xlsx'; await dl.saveAs(path);
  const [fc] = await Promise.all([ann.page.waitForEvent('filechooser'), menu(ann, 'Import from Excel')]); await fc.setFiles(path);
  await ann.page.waitForFunction(() => /Imported/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 }); await sleep(1500);
  const list = await (await fetch(BASE + '/api/boards', { headers: { 'x-plank-name': 'Zoe' } })).json();
  assert.ok(list.boards.some(b => /\(2\)$/.test(b.name)), JSON.stringify(list.boards.map(b => b.name)));
});
await t('signing out sends the sign-out request', async () => {
  const req = ann.page.waitForRequest(r => /\/auth\/logout/.test(r.url()) && r.method() === 'POST'); await menu(ann, 'Sign out'); await req;
  await ann.page.waitForSelector('.list');
});
await t('closing the page removes the person from the online list', async () => { await bob.ctx.close(); await ann.page.waitForSelector('#presence:not(.show)', { state: 'attached', timeout: 15000 }); assert.equal((await ann.page.locator('#presence').innerText()).trim(), ''); });
await t('no script errors on either screen', async () => { assert.deepEqual([...ann.errs, ...bob.errs], []); });
await ann.page.screenshot({ path: '/home/claude/tests/team-ann.png' });
await browser.close();
console.log(`TEAM E2E: ${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
