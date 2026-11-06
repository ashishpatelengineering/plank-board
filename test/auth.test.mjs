import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
let n = 0, failed = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PW = 'correct horse battery staple';

async function start(port, vars) {
  const args = ['wrangler', 'dev', '--port', String(port), '--local', '--persist-to', '/tmp/wr-auth-' + port, ...vars.flatMap(v => ['--var', v])];
  const p = spawn('npx', args, { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  for (let i = 0; i < 80 && !/Ready on/.test(log); i++) await sleep(250);
  assert.ok(/Ready on/.test(log), 'server did not start');
  return { stop: () => p.kill('SIGTERM'), base: 'http://localhost:' + port };
}
const sessionFor = (password, exp) => { const key = createHash('sha256').update('plank-session:' + password).digest(); return exp + '.' + createHmac('sha256', key).update('v1.' + exp).digest('base64url'); };
const login = (base, password, extra = {}) => fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-plank': '1', ...extra }, body: JSON.stringify({ password }) });
const cookieOf = r => /plank_session=[^;]+/.exec(r.headers.get('set-cookie') || '')?.[0];
const api = (base, path, cookie, extra = {}) => fetch(base + path, { headers: { ...(cookie ? { cookie } : {}), ...extra } });

const s = await start(8802, ['TEAM_PASSWORD:' + PW]);
let good;
await t('a signed-out visitor gets only the password page, not the app', async () => {
  const r = await api(s.base, '/'); assert.equal(r.status, 200); const body = await r.text();
  assert.match(body, /Team password/); assert.ok(!/id="board"|plank\.v1|class="list"/.test(body), 'the app must not be sent');
  assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(await (await api(s.base, '/anything/else')).text(), /Team password/);
});
await t('the data and live connection are closed to a signed-out visitor', async () => {
  for (const p of ['/api/me', '/api/boards', '/api/boards/x/snapshots', '/ws/x']) assert.equal((await api(s.base, p)).status, 401, p);
  assert.equal((await fetch(s.base + '/api/boards', { method: 'POST', headers: { 'x-plank': '1', 'content-type': 'application/json' }, body: '{"board":{}}' })).status, 401);
});
await t('the old shortcuts do nothing in production', async () => {
  for (const h of [{ 'x-dev-user': 'boss' }, { 'x-plank-name': 'Boss' }, { cookie: 'dev_user=boss; plank_session=1.abc' }]) assert.equal((await api(s.base, '/api/me', null, h)).status, 401);
});
await t('a wrong password is refused, slowly, and sets no cookie', async () => {
  const t0 = Date.now(); const r = await login(s.base, 'wrong password here'); assert.equal(r.status, 401); assert.ok(Date.now() - t0 >= 600, 'delay');
  assert.equal(r.headers.get('set-cookie'), null); assert.match((await r.json()).error, /not right/);
  assert.equal((await login(s.base, '')).status, 401); assert.equal((await login(s.base, PW.slice(0, -1))).status, 401); assert.equal((await login(s.base, PW + 'x')).status, 401);
  assert.equal((await login(s.base, 12345)).status, 401); assert.equal((await login(s.base, 'x'.repeat(5000))).status, 401);
});
await t('the right password sets a protected cookie that opens the app and the data', async () => {
  const r = await login(s.base, PW); assert.equal(r.status, 200);
  const raw = r.headers.get('set-cookie'); assert.match(raw, /HttpOnly/); assert.match(raw, /Secure/); assert.match(raw, /SameSite=Lax/); assert.match(raw, /Max-Age=2592000/);
  good = cookieOf(r); assert.ok(good);
  const page = await (await api(s.base, '/', good)).text(); assert.ok(/id="board"|plank\.v1/.test(page) && !/Team password/.test(page), 'the app is sent');
  const me = await (await api(s.base, '/api/me', good, { 'x-plank-name': encodeURIComponent('Ann') })).json(); assert.equal(me.name, 'Ann');
});
await t('login needs the header and the same site', async () => {
  assert.equal((await fetch(s.base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) })).status, 403);
  assert.equal((await login(s.base, PW, { origin: 'https://evil.example' })).status, 403);
});
await t('forged, expired, tampered and wrong-password cookies are all refused', async () => {
  const future = Date.now() + 86400e3;
  const cases = { 'signed with another password': sessionFor('some other password!!', future), 'expired': sessionFor(PW, Date.now() - 1000), 'bad signature': future + '.AAAA', 'no signature': String(future), 'garbage': 'nonsense' };
  for (const [k, v] of Object.entries(cases)) assert.equal((await api(s.base, '/api/me', 'plank_session=' + v)).status, 401, k);
  const [exp, sig] = good.replace('plank_session=', '').split('.'); assert.equal((await api(s.base, '/api/me', `plank_session=${+exp + 864e5 * 365}.${sig}`)).status, 401, 'extended expiry');
  assert.equal((await api(s.base, '/api/me', 'plank_session=' + sessionFor(PW, future))).status, 200, 'a correctly signed one is fine (control case)');
});
await t('a page on another site cannot use your cookie to read or change anything', async () => {
  assert.equal((await api(s.base, '/api/boards', good, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(s.base + '/api/boards', { method: 'POST', headers: { cookie: good, 'content-type': 'application/json' }, body: '{"board":{}}' })).status, 403);
});
await t('signing out clears the cookie', async () => {
  const r = await fetch(s.base + '/auth/logout', { method: 'POST', headers: { 'x-plank': '1', cookie: good } }); assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});
s.stop();

let port = 8803;
for (const [label, vars] of [['a short password', ['TEAM_PASSWORD:short']], ['no password', []]]) {
  const x = await start(port++, vars);
  await t(`with ${label} the server refuses to run instead of running open`, async () => {
    const page = await api(x.base, '/'); assert.equal(page.status, 503); assert.match(await page.text(), /not set up yet/);
    assert.equal((await api(x.base, '/api/boards')).status, 503); assert.equal((await login(x.base, 'short')).status, 503); assert.equal((await login(x.base, '')).status, 503);
  });
  x.stop(); await sleep(500);
}
await sleep(300);
console.log(`AUTH: ${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
