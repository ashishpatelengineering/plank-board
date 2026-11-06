import assert from 'node:assert/strict';
import { applyOp, applyOps, diff, clone, cleanDoc, syncInto, BoardSync } from '../shared/ops.js';
let n = 0, failed = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n')[0]); } };
let seed = 1; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; const ri = k => Math.floor(rnd() * k); let idn = 0; const nid = () => 'x' + (++idn);
const card = (title = 'c') => ({ id: nid(), title, desc: '', labels: [], due: '', done: false, checks: [], created: 1 });
const mkdoc = () => ({ name: 'B', names: {}, archived: false, lists: [0, 1, 2].map(i => ({ id: 'L' + i, title: 'List ' + i, cards: [card('a' + i), card('b' + i)] })), archive: [{ card: card('old1'), listId: 'L0', listTitle: 'List 0', at: 3 }, { card: card('old2'), listId: 'L1', listTitle: 'List 1', at: 4 }] });

function randomEdit(d) {
  const k = ri(11);
  const L = d.lists;
  if (k === 0 && L.length < 6) L.splice(ri(L.length + 1), 0, { id: nid(), title: 'N', cards: [] });
  else if (k === 1 && L.length > 1) L.splice(ri(L.length), 1);
  else if (k === 2 && L.length) L[ri(L.length)].title = 'T' + ri(99);
  else if (k === 3 && L.length > 1) { const [l] = L.splice(ri(L.length), 1); L.splice(ri(L.length + 1), 0, l); }
  else if (k === 4 && L.length) { const l = L[ri(L.length)]; l.cards.splice(ri(l.cards.length + 1), 0, card('n' + ri(99))); }
  else if (k === 5 && L.length) { const l = L[ri(L.length)]; if (l.cards.length) l.cards.splice(ri(l.cards.length), 1); }
  else if (k === 6 && L.length > 1) { const a = L[ri(L.length)], b = L[ri(L.length)]; if (a.cards.length) { const [c] = a.cards.splice(ri(a.cards.length), 1); b.cards.splice(ri(b.cards.length + 1), 0, c); } }
  else if (k === 7 && L.length) { const l = L[ri(L.length)]; if (l.cards.length) { const c = l.cards[ri(l.cards.length)]; c.title = 'E' + ri(99); c.done = rnd() < .5; c.labels = rnd() < .5 ? ['l1', 'l3'] : []; c.checks = rnd() < .5 ? [{ id: 'k1', text: 'x', done: true }] : []; } }
  else if (k === 8 && L.length) { const l = L[ri(L.length)]; if (l.cards.length) { const [c] = l.cards.splice(ri(l.cards.length), 1); d.archive.push({ card: c, listId: l.id, listTitle: l.title, at: 5 }); } }
  else if (k === 9 && d.archive.length && L.length) { const [a] = d.archive.splice(ri(d.archive.length), 1); L[ri(L.length)].cards.push(a.card); }
  else if (k === 10) { d.name = 'Name' + ri(9); d.names = rnd() < .5 ? { l1: 'Urgent' } : {}; d.archived = rnd() < .2; }
}
const ok = (a, b) => assert.deepEqual(a, b);

t('diff then apply reproduces the target (3000 random edit sequences)', () => {
  for (let i = 0; i < 3000; i++) {
    const a = mkdoc(); const b = clone(a);
    for (let k = 0, m = 1 + ri(6); k < m; k++) randomEdit(b);
    const c = clone(a); applyOps(c, diff(a, b));
    assert.deepEqual(c, b, 'case ' + i);
  }
});
t('diff of identical documents is empty', () => { const a = mkdoc(); assert.equal(diff(a, clone(a)).length, 0); });
t('inverse ops undo an edit exactly', () => {
  for (let i = 0; i < 500; i++) { const a = mkdoc(); const b = clone(a); for (let k = 0; k < 3; k++) randomEdit(b); const x = clone(b); applyOps(x, diff(b, a)); assert.deepEqual(x, a); }
});
t('a deleted list never swallows a card that was added to it at the same time', () => {
  const d = mkdoc(); applyOp(d, { o: 'list.del', id: 'L1' });
  assert.equal(applyOp(d, { o: 'card.add', listId: 'L1', index: 0, card: card('late') }), true);
  assert.ok(d.lists[0].cards.some(c => c.title === 'late'));
});
t('duplicate ids and bad input are ignored', () => {
  const d = mkdoc(); const c = d.lists[0].cards[0];
  assert.equal(applyOp(d, { o: 'card.add', listId: 'L0', index: 0, card: { ...c } }), false);
  assert.equal(applyOp(d, { o: 'nope' }), false); assert.equal(applyOp(d, null), false);
  assert.equal(applyOp(d, { o: 'card.set', id: c.id, f: { title: 5, labels: ['zz', 'l2', 'l2'], due: 'tomorrow' } }), true);
  assert.equal(c.labels.length, 1); assert.equal(c.due, ''); assert.equal(c.title, 'Untitled');
  assert.equal(applyOp(d, { o: 'card.add', listId: 'L0', index: 0, card: { id: '../x', title: 'bad' } }), false);
});
t('cleanDoc trims, limits and drops junk', () => {
  const d = cleanDoc({ name: '  ', lists: [{ id: 'a', title: 'x'.repeat(999), cards: [{ id: 'c1', title: 'ok', labels: ['l9'] }, { id: 'c1', title: 'dup' }, 5] }, { id: 'a' }], names: { l1: 'y'.repeat(99), l8: 'no' } });
  assert.equal(d.name, 'Untitled'); assert.equal(d.lists.length, 1); assert.equal(d.lists[0].title.length, 200); assert.equal(d.lists[0].cards.length, 1); assert.equal(d.names.l1.length, 24); assert.equal(d.names.l8, undefined);
});

// ---- the heart of it: several people editing at once always end up with the same board ----
function network(clients, rounds, drop = 0) {
  const server = mkdoc(); let seq = 0; const queue = [];
  const C = clients.map((name, i) => { const live = clone(server); return { name, live, sync: new BoardSync(server), inbox: [], out: [] }; });
  const send = (c, batch) => queue.push({ c, batch });
  const deliver = () => { const q = queue.splice(0); for (const { c, batch } of q) { const before = clone(server); const ch = applyOps(server, batch.ops); seq++; const msg = { seq, opid: batch.opid, cid: c.name, ops: batch.ops }; for (const x of C) x.inbox.push(msg); } };
  const drain = c => { while (c.inbox.length) { const m = c.inbox.shift(); const r = c.sync.receive(m, c.live, m.cid === c.name, () => c.name + '-' + (++idn)); if (r.extra) send(c, r.extra.batch); } };
  for (let r = 0; r < rounds; r++) {
    for (const c of C) { if (rnd() < .6) { for (let k = 0, m = 1 + ri(3); k < m; k++) randomEdit(c.live); } if (rnd() < .5) { const out = c.sync.collect(c.live, () => c.name + '-' + (++idn)); if (out) send(c, out.batch); } }
    if (rnd() < .6) deliver();
    for (const c of C) if (rnd() < .5) drain(c);
  }
  for (let settle = 0; settle < 6; settle++) { for (const c of C) { const out = c.sync.collect(c.live, () => c.name + '-' + (++idn)); if (out) send(c, out.batch); } deliver(); for (const c of C) drain(c); }
  return { server, C };
}
t('three people editing at random converge to the server copy (300 sessions)', () => {
  for (let s = 0; s < 300; s++) {
    seed = 1000 + s;
    const { server, C } = network(['ann', 'bob', 'cy'], 25);
    for (const c of C) { assert.deepEqual(c.live, server, `session ${s}, ${c.name}`); assert.equal(c.sync.pending.length, 0); }
  }
});
t('syncInto keeps the same card objects on screen', () => {
  const live = mkdoc(); const keep = live.lists[0].cards[0]; const m = clone(live);
  m.lists[0].cards[0].title = 'changed remotely'; m.lists.reverse();
  syncInto(live, m); assert.equal(live.lists[2].cards[0], keep); assert.equal(keep.title, 'changed remotely'); assert.deepEqual(live, m);
});
t('your own typing survives a teammate editing another field of the same card', () => {
  const server = mkdoc(); const a = { live: clone(server), sync: new BoardSync(server) };
  const c = a.live.lists[0].cards[0]; c.title = 'my title';
  const r = a.sync.receive({ opid: 'z', ops: [{ o: 'card.set', id: c.id, f: { desc: 'their notes' } }] }, a.live, false);
  assert.equal(a.live.lists[0].cards[0], c); assert.equal(c.title, 'my title'); assert.equal(c.desc, 'their notes'); assert.ok(r.extra);
});
t('archiving and restoring a card both round-trip', () => {
  const a = mkdoc(); const c = a.lists[1].cards[0]; const b = clone(a);
  b.lists[1].cards.splice(0, 1); b.archive.push({ card: c, listId: 'L1', listTitle: 'List 1', at: 9 });
  const x = clone(a); applyOps(x, diff(a, b)); assert.deepEqual(x, b);
  const y = clone(b); applyOps(y, diff(b, a)); assert.deepEqual(y, a);
});
console.log(`OPS: ${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
