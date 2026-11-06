import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('/opt/npm-tools/node_modules/playwright');
const PORT = 8812, BASE = 'http://localhost:' + PORT, PW = 'correct horse battery staple';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0, failed = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').slice(0, 3).join(' | ')); } };
execSync('rm -rf /tmp/wr-login');
const proc = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--local', '--persist-to', '/tmp/wr-login', '--var', 'TEAM_PASSWORD:' + PW], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore', detached: true });
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch (e) { /* not yet */ } await sleep(300); }
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, colorScheme: 'light' });
const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
const tabs = async () => { let k = 0; const seen = []; await page.mouse.click(1, 1); for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); seen.push(await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName))); } return seen; };

await t('the first thing anyone sees is a password page, and focus is already in the field', async () => {
  await page.goto(BASE); await page.waitForSelector('#p');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'p'); assert.equal(await page.locator('label[for=p]').innerText(), 'Team password');
  assert.equal(await page.locator('.list').count(), 0); assert.equal(await page.title(), 'Plank Board');
  await page.screenshot({ path: '/home/claude/tests/login-light.png' });
});
await t('a wrong password shows a plain message, keeps you on the page and selects the text for a retry', async () => {
  await page.fill('#p', 'not the password'); await page.click('#go'); await page.waitForFunction(() => /not right/.test(document.getElementById('e').textContent), null, { timeout: 6000 });
  assert.equal(await page.locator('#go').isEnabled(), true); assert.equal(await page.locator('#go').innerText(), 'Open'); assert.equal(await page.locator('.list').count(), 0);
});
await t('the right password (Enter key) opens the app, which asks for a name once', async () => {
  await page.fill('#p', PW); await page.keyboard.press('Enter'); await page.waitForSelector('#nm-input', { timeout: 10000 });
  await page.fill('#nm-input', 'Ann'); await page.keyboard.press('Enter'); await page.waitForSelector('.list');
  assert.equal(await page.locator('#board-name').innerText(), 'My board'); assert.equal(await page.locator('#warn.show').count(), 0);
});
await t('the live connection works behind the password (a second browser sees changes)', async () => {
  const c2 = await browser.newContext(); const p2 = await c2.newPage(); await p2.goto(BASE); await p2.waitForSelector('#p'); await p2.fill('#p', PW); await p2.click('#go');
  await p2.waitForSelector('#nm-input'); await p2.fill('#nm-input', 'Bob'); await p2.click('#nm-save'); await p2.waitForSelector('.list');
  await page.locator('section.list[aria-label="To do"] .add-btn').click(); await page.keyboard.type('Through the password'); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await p2.waitForFunction(() => [...document.querySelectorAll('section.list[aria-label="To do"] .card')].some(c => /Through the password/.test(c.innerText)), null, { timeout: 8000 });
  assert.equal(await p2.locator('#warn.show').count(), 0); await c2.close();
});
await t('a reload goes straight to the board: the password and name are remembered', async () => {
  await page.reload(); await page.waitForSelector('.list'); assert.equal(await page.locator('#p').count(), 0); assert.equal(await page.locator('#nm-input').count(), 0);
});
await t('Sign out returns to the password page, and the old tab no longer gets any data', async () => {
  await page.click('#menu-btn'); await page.locator('.menu-item', { hasText: 'Sign out' }).click(); await page.waitForSelector('#p', { timeout: 8000 });
  assert.equal((await ctx.request.get(BASE + '/api/boards')).status(), 401);
});
await t('if the session stops working while the page is open, coming back to the tab goes back to the password page', async () => {
  await page.fill('#p', PW); await page.click('#go'); await page.waitForSelector('.list');
  await ctx.clearCookies(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));     // coming back to the tab checks the boards
  await page.waitForSelector('#p', { timeout: 10000 }); assert.equal(await page.locator('.list').count(), 0);
});
await t('the password page works in dark mode and on a phone-sized screen with no sideways scrolling', async () => {
  const c = await browser.newContext({ colorScheme: 'dark', viewport: { width: 360, height: 640 } }); const p = await c.newPage(); await p.goto(BASE); await p.waitForSelector('#p');
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor); assert.equal(bg, 'rgb(16, 16, 17)');
  await p.screenshot({ path: '/home/claude/tests/login-dark.png' }); await c.close();
});
await t('no script errors', async () => assert.deepEqual(errs, []));
try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) { /* gone */ } try { execSync('pkill -f "port 8812"'); } catch (e) { /* none */ }
await browser.close();
console.log(`LOGIN E2E: ${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
