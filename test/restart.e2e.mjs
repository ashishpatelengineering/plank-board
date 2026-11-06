import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('/opt/npm-tools/node_modules/playwright');
const BASE = 'http://localhost:8803';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0, failed = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').slice(0, 3).join(' | ')); } };
execSync('rm -rf /tmp/wr-restart');
let proc;
async function start() {
  proc = spawn('npx', ['wrangler', 'dev', '--port', '8803', '--local', '--persist-to', '/tmp/wr-restart', '--var', 'DEV_MODE:1'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore', detached: true });
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/me'); if (r.ok) return; } catch (e) { /* not yet */ } await sleep(300); }
  throw new Error('server did not start');
}
const stop = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) { /* gone */ } try { execSync('pkill -f "port 8803"'); } catch (e) { /* none */ } };
await start();
const browser = await chromium.launch();
async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } }); await ctx.addInitScript(n => { try { localStorage.setItem('plank.team.name', n); } catch (e) { /* ignore */ } }, name);
  const page = await ctx.newPage(); await page.goto(BASE); await page.waitForSelector('.list'); return { ctx, page, email: name };
}
const cards = async (p, list) => (await p.page.locator(`section.list[aria-label="${list}"] .card`).allInnerTexts()).map(s => s.split('\n')[0].trim());
const waitCards = async (p, list, pred, ms = 30000) => { const end = Date.now() + ms; let got; while (Date.now() < end) { got = await cards(p, list); if (pred(got)) return got; await sleep(250); } throw new Error(`${p.email} ${list}: ${JSON.stringify(got)}`); };
const add = async (p, list, text) => { await p.page.locator(`section.list[aria-label="${list}"] .add-btn`).click(); await p.page.keyboard.type(text); await p.page.keyboard.press('Enter'); await p.page.keyboard.press('Escape'); };
const ann = await person('Ann');
const bob = await person('Bob');
await bob.page.waitForSelector('#presence.show .pp');
await add(ann, 'To do', 'Before the outage'); await waitCards(bob, 'To do', c => c.includes('Before the outage'));
await t('the server dies: both people see Offline and can keep working', async () => {
  stop(); await ann.page.waitForSelector('#warn.show', { timeout: 15000 }); await bob.page.waitForSelector('#warn.show', { timeout: 15000 });
  await add(ann, 'To do', 'Written during outage by ann'); await add(bob, 'Doing', 'Written during outage by bob');
  assert.ok((await cards(ann, 'To do')).includes('Written during outage by ann'));
});
await t('the server comes back with its data: everything reconciles on both screens with nothing lost', async () => {
  await start();
  for (const p of [ann, bob]) await p.page.evaluate(() => window.dispatchEvent(new Event('online')));
  for (const p of [ann, bob]) { await waitCards(p, 'To do', c => c.includes('Before the outage') && c.includes('Written during outage by ann')); await waitCards(p, 'Doing', c => c.includes('Written during outage by bob')); }
  await ann.page.waitForSelector('#warn:not(.show)', { state: 'attached', timeout: 30000 }); await bob.page.waitForSelector('#warn:not(.show)', { state: 'attached', timeout: 30000 });
});
await t('a fresh load afterwards shows the same board (nothing exists only on the screens)', async () => {
  const c = await person('Ann'); const list = await cards({ page: c.page }, 'To do'); assert.ok(list.includes('Written during outage by ann') && list.includes('Before the outage'), JSON.stringify(list));
});
stop(); await browser.close();
console.log(`RESTART: ${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
