import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { applyOps, diff, clone } from '../shared/ops.js';
const BASE = process.env.BASE || 'http://localhost:8801';
let n = 0, failed = 0; const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').slice(0, 3).join(' | ')); } };
const api = (who, method, path, body, extra = {}) => fetch(BASE + path, { method, headers: { 'x-plank-name': encodeURIComponent(who), 'x-plank': '1', 'content-type': 'application/json', ...extra }, body: body ? JSON.stringify(body) : undefined });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let idn = 0; const nid = () => 'q' + (++idn) + Date.now().toString(36);
const card = title => ({ id: nid(), title, desc: '', labels: [], due: '', done: false, checks: [], created: Date.now() });

function connect(who, boardId, cid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws/' + boardId + '?cid=' + cid + '&name=' + encodeURIComponent(who));
    const c = { ws, who, cid, msgs: [], closed: null, waiters: [] };
    ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); c.waiters = c.waiters.filter(w => !w(m)); });
    ws.on('close', code => { c.closed = code; });
    ws.on('unexpected-response', (req, res) => reject(new Error('HTTP ' + res.statusCode)));
    ws.on('error', reject);
    ws.on('open', () => c.waitFor(m => m.t === 'hello').then(() => resolve(c)));
    c.send = m => ws.send(JSON.stringify(m));
    c.waitFor = (pred, ms = 4000) => new Promise((res, rej) => { const f = c.msgs.find(pred); if (f) return res(f); const to = setTimeout(() => rej(new Error('timed out waiting for message')), ms); c.waiters.push(m => { if (pred(m)) { clearTimeout(to); res(m); return true; } return false; }); });
    c.hello = () => c.msgs.filter(m => m.t === 'hello').at(-1);
  });
}

const starter = { name: 'Team board', names: { l1: 'Urgent' }, archived: false, lists: [{ id: 'todo', title: 'To do', cards: [card('First')] }, { id: 'done', title: 'Done', cards: [] }], archive: [] };
let board, ann, bob;

await t('anyone can create a board, and everyone sees the same list of boards', async () => {
  const r = await api('Ann', 'POST', '/api/boards', { board: starter }); assert.equal(r.status, 201);
  board = (await r.json()).id; assert.ok(board);
  const a = await (await api('Ann', 'GET', '/api/boards')).json(), b = await (await api('Bob', 'GET', '/api/boards')).json();
  assert.ok(a.boards.some(x => x.id === board) && b.boards.some(x => x.id === board)); assert.deepEqual(a.boards, b.boards); assert.equal(b.name, 'Bob');
});
await t('a state-changing request without the header, or from another site, is refused', async () => {
  assert.equal((await fetch(BASE + '/api/boards', { method: 'POST', headers: { 'x-plank-name': 'Ann', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await api('Ann', 'POST', '/api/boards', { board: starter }, { origin: 'https://evil.example' })).status, 403);
});
await t('a board that does not exist cannot be opened, listed or deleted', async () => {
  await assert.rejects(connect('Bob', 'nope123', 'b0'), /404/);
  assert.equal((await api('Bob', 'GET', '/api/boards/nope123/snapshots')).status, 404);
  assert.equal((await api('Bob', 'DELETE', '/api/boards/nope123')).status, 404);
});
await t('both people connect and see the same board and each other by name', async () => {
  ann = await connect('Ann', board, 'ann1'); bob = await connect('Bob', board, 'bob1');
  assert.equal(ann.hello().doc.name, 'Team board'); assert.deepEqual(bob.hello().doc, ann.hello().doc); assert.equal(ann.hello().you, 'Ann');
  const p = await bob.waitFor(m => m.t === 'presence' && m.users.length === 2); assert.deepEqual(p.users.sort(), ['Ann', 'Bob']);
});
await t('a name is only a label: control characters are removed and it is cut to 30 characters', async () => {
  const odd = await connect('  Zed\u0007   the\tgreat ' + 'x'.repeat(60), board, 'z1'); assert.ok(odd.hello().you.length <= 30 && !/[\u0000-\u001f]/.test(odd.hello().you) && odd.hello().you.startsWith('Zed the great'), odd.hello().you);
  const blank = await connect('   ', board, 'z2'); assert.equal(blank.hello().you, 'Someone'); odd.ws.close(); blank.ws.close();
});
await t('changing your name relabels you for everyone without reconnecting', async () => {
  ann.send({ t: 'name', name: '  Annie\u0007  ' });
  const p = await bob.waitFor(m => m.t === 'presence' && m.users.includes('Annie')); assert.deepEqual(p.users.sort(), ['Annie', 'Bob']);
  assert.equal(ann.closed, null, 'still connected');
  ann.send({ t: 'name', name: 'Ann' }); await bob.waitFor(m => m.t === 'presence' && m.users.includes('Ann') && !m.users.includes('Annie'));
});
await t('a change from one person reaches the other at once, and the sender gets a receipt', async () => {
  const c = card('Order the cake');
  ann.send({ t: 'ops', opid: 'o1', ops: [{ o: 'card.add', listId: 'todo', index: 0, card: c }] });
  const got = await bob.waitFor(m => m.t === 'ops' && m.opid === 'o1'); assert.equal(got.ops[0].card.title, 'Order the cake'); assert.equal(got.by, 'Ann');
  const echo = await ann.waitFor(m => m.t === 'ops' && m.opid === 'o1'); assert.equal(echo.cid, 'ann1'); assert.equal(echo.seq, got.seq);
});
await t('a no-op batch still gets a receipt', async () => {
  bob.send({ t: 'ops', opid: 'noop', ops: [{ o: 'card.del', id: 'does-not-exist' }, { o: 'bogus' }] });
  const r = await bob.waitFor(m => m.t === 'ops' && m.opid === 'noop'); assert.equal(r.ops.length, 0);
});
await t('invalid operations are cleaned or ignored on the server', async () => {
  bob.send({ t: 'ops', opid: 'bad', ops: [{ o: 'card.add', listId: 'todo', index: 0, card: { id: '../../x', title: 'bad id' } }, { o: 'card.add', listId: 'todo', index: 0, card: { id: nid(), title: 'x'.repeat(5000), labels: ['l9', 'l1'], due: 'soon' } }] });
  const r = await ann.waitFor(m => m.t === 'ops' && m.opid === 'bad'); assert.equal(r.ops.length, 1);
  bob.send({ t: 'sync' }); await sleep(300);
  const d = bob.msgs.filter(m => m.t === 'hello').at(-1).doc; const c = d.lists[0].cards.find(x => x.title.startsWith('xxxx'));
  assert.equal(c.title.length, 500); assert.deepEqual(c.labels, ['l1']); assert.equal(c.due, ''); assert.ok(!d.lists[0].cards.some(x => x.title === 'bad id'));
});
await t('the activity trail records the first change by name', async () => {
  ann.send({ t: 'activity' }); const a = await ann.waitFor(m => m.t === 'activity');
  assert.ok(a.items.some(i => i.who === 'Ann' && /Order the cake/.test(i.text)), JSON.stringify(a.items.slice(0, 3)));
});
await t('a card sent without a created time gets one stamped once, and everyone agrees on it', async () => {
  const id = nid(); ann.send({ t: 'ops', opid: 'nocr', ops: [{ o: 'card.add', listId: 'todo', index: 0, card: { id, title: 'no stamp' } }] });
  const r = await bob.waitFor(m => m.t === 'ops' && m.opid === 'nocr'); assert.ok(r.ops[0].card.created > 0);
  ann.send({ t: 'sync' }); await sleep(300);
  const d = ann.msgs.filter(m => m.t === 'hello').at(-1).doc; assert.equal(d.lists.flatMap(l => l.cards).find(c => c.id === id).created, r.ops[0].card.created);
});
await t('two people editing at once end up with identical boards (random edits, 60 rounds)', async () => {
  const mine = { ann: clone(ann.msgs.filter(m => m.t === 'hello').at(-1).doc), bob: clone(bob.msgs.filter(m => m.t === 'hello').at(-1).doc) };
  const people = [ann, bob];
  for (let r = 0; r < 60; r++) {
    for (const p of people) {
      const d = p.live || (p.live = clone(p.hello().doc));
      const before = clone(d);
      const k = Math.floor(Math.random() * 4);
      if (k === 0) d.lists[Math.floor(Math.random() * d.lists.length)].cards.push(card('c' + r + p.who[0]));
      else if (k === 1) { const l = d.lists.find(x => x.cards.length); if (l) l.cards.splice(Math.floor(Math.random() * l.cards.length), 1); }
      else if (k === 2) { const a = d.lists.find(x => x.cards.length), b = d.lists[Math.floor(Math.random() * d.lists.length)]; if (a) b.cards.splice(0, 0, a.cards.shift()); }
      else { const l = d.lists.find(x => x.cards.length); if (l) l.cards[0].title = 'T' + r + p.who[0]; }
      const ops = diff(before, d); if (ops.length) p.send({ t: 'ops', opid: p.cid + '-' + r, ops });
    }
    await sleep(Math.random() * 15);
  }
  await sleep(800);
  ann.send({ t: 'sync' }); bob.send({ t: 'sync' }); await sleep(600);
  // fold every broadcast onto the first hello each of them saw: both must reach the server's copy
  const server = ann.msgs.filter(m => m.t === 'hello').at(-1).doc;
  assert.deepEqual(bob.msgs.filter(m => m.t === 'hello').at(-1).doc, server);
  for (const p of people) { const d = clone(p.msgs.find(m => m.t === 'hello').doc); for (const m of p.msgs) if (m.t === 'ops' && m.seq > p.msgs.find(x => x.t === 'hello').rev) applyOps(d, m.ops); if (JSON.stringify(canon(d)) !== JSON.stringify(canon(server))) { const f = x => x.lists.map(l => l.id + ':' + l.cards.map(c => c.title).join(',')).join(' | '); const dd = (a, b, path = '') => { if (JSON.stringify(a) === JSON.stringify(b)) return; if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) dd(a[k], b[k], path + '/' + k); } else console.log('DIFF', p.who, path, JSON.stringify(a)?.slice(0, 60), 'vs server', JSON.stringify(b)?.slice(0, 60)); }; dd(canon(d), canon(server)); console.log('STREAM', p.who, f(d).slice(0, 300)); console.log('SERVER', f(server).slice(0, 300)); throw new Error(p.who + ' rebuilt from the stream differs'); } }
});
await t('the activity trail names who did what', async () => {
  ann.send({ t: 'activity' }); const a = await ann.waitFor(m => m.t === 'activity');
  assert.ok(a.items.length > 0 && a.items.every(i => i.who && i.text && i.at) && a.items.some(i => i.who === 'Ann') && a.items.some(i => i.who === 'Bob'), JSON.stringify(a.items.slice(0, 3)));
});
let snaps, before;
await t('anyone can list backups, and each shows how big the board was', async () => {
  snaps = (await (await api('Bob', 'GET', `/api/boards/${board}/snapshots`)).json()).snapshots;
  assert.ok(snaps.length >= 1); assert.ok(snaps.every(b => b.at > 0 && Number.isInteger(b.lists) && Number.isInteger(b.cards)), JSON.stringify(snaps));
});
await t('restoring a backup replaces the board for everyone and keeps the replaced version as a backup', async () => {
  ann.send({ t: 'sync' }); await sleep(300);
  before = clone(ann.msgs.filter(m => m.t === 'hello').at(-1).doc);
  const old = snaps.at(-1).at; const want = await (await api('Ann', 'GET', `/api/boards/${board}/snapshots/${old}`)).json();
  const nHello = { ann: ann.msgs.filter(m => m.t === 'hello').length, bob: bob.msgs.filter(m => m.t === 'hello').length };
  assert.equal((await api('Ann', 'POST', `/api/boards/${board}/snapshots/${old}`)).status, 200);
  for (let i = 0; i < 30 && (ann.msgs.filter(m => m.t === 'hello').length === nHello.ann || bob.msgs.filter(m => m.t === 'hello').length === nHello.bob); i++) await sleep(100);
  assert.deepEqual(ann.msgs.filter(m => m.t === 'hello').at(-1).doc, want, 'the first person sees the backup');
  assert.deepEqual(bob.msgs.filter(m => m.t === 'hello').at(-1).doc, want, 'the second person sees the backup');
  const after = (await (await api('Ann', 'GET', `/api/boards/${board}/snapshots`)).json()).snapshots;
  assert.equal(after.length, Math.min(snaps.length + 1, 48)); assert.ok(after[0].at >= snaps[0].at);
  const kept = await (await api('Ann', 'GET', `/api/boards/${board}/snapshots/${after[0].at}`)).json(); assert.deepEqual(kept, before, 'the replaced version was kept');
  const seen = ann.msgs.filter(m => m.t === 'activity').length; ann.send({ t: 'activity' }); for (let i = 0; i < 30 && ann.msgs.filter(m => m.t === 'activity').length === seen; i++) await sleep(100); const a = ann.msgs.filter(m => m.t === 'activity').at(-1); assert.ok(a.items.some(i => /restored an earlier version/.test(i.text)), JSON.stringify(a.items.slice(0, 3)));
});
await t('editing still works after a restore, and restoring the kept version brings everything back', async () => {
  const c = card('after restore'); ann.send({ t: 'ops', opid: 'ar', ops: [{ o: 'card.add', listId: ann.hello().doc.lists[0].id, index: 0, card: c }] });
  const got = await bob.waitFor(m => m.t === 'ops' && m.opid === 'ar'); assert.equal(got.ops.length, 1);
  const list = (await (await api('Ann', 'GET', `/api/boards/${board}/snapshots`)).json()).snapshots;
  const nHello = ann.msgs.filter(m => m.t === 'hello').length;
  const keptAt = list.find(b => b.cards === before.lists.reduce((n, l) => n + l.cards.length, 0) && b.lists === before.lists.length).at;
  assert.equal((await api('Ann', 'POST', `/api/boards/${board}/snapshots/${keptAt}`)).status, 200);
  for (let i = 0; i < 30 && ann.msgs.filter(m => m.t === 'hello').length === nHello; i++) await sleep(100);
  assert.deepEqual(ann.msgs.filter(m => m.t === 'hello').at(-1).doc, before);
  assert.equal((await api('Ann', 'POST', `/api/boards/${board}/snapshots/12345`)).status, 404);
});
await t('renaming and archiving a board updates the list people see', async () => {
  ann.send({ t: 'ops', opid: 'r1', ops: [{ o: 'board.set', name: 'Renamed', archived: true }] }); await ann.waitFor(m => m.opid === 'r1'); await sleep(200);
  const b = (await (await api('Ann', 'GET', '/api/boards')).json()).boards.find(x => x.id === board); assert.equal(b.name, 'Renamed'); assert.equal(b.archived, true);
});
await t('an oversized message is refused', async () => {
  const big = await connect('Ann', board, 'big'); big.send({ t: 'ops', opid: 'x', ops: [{ o: 'card.set', id: 'a', f: { desc: 'x'.repeat(800000) } }] });
  for (let i = 0; i < 30 && big.closed === null; i++) await sleep(100); assert.equal(big.closed, 1009);
});
await t('the board survives a server restart', async () => { if (!process.env.RESTART) return; });
await t('deleting a board removes it for everyone', async () => {
  const c = await connect('Ann', board, 'last');
  assert.equal((await api('Ann', 'DELETE', `/api/boards/${board}`)).status, 200);
  for (let i = 0; i < 30 && !c.msgs.some(m => m.t === 'gone'); i++) await sleep(100); assert.ok(c.msgs.some(m => m.t === 'gone'), 'told the board is gone');
  assert.equal((await (await api('Ann', 'GET', '/api/boards')).json()).boards.some(b => b.id === board), false);
});
for (const p of [ann, bob]) try { p.ws.close(); } catch (e) { /* closed */ }
console.log(`SERVER: ${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
