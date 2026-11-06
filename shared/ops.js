/* Plank Board team sync: pure functions shared by the server and the app.
   A board document is { name, names, archived, lists: [{id, title, cards: [card]}], archive: [{card, listId, listTitle, at}] }.
   Everything people do is expressed as small operations; the server applies them in one order and everyone converges. */

const LABEL_IDS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
export const LIMITS = { title: 500, desc: 20000, listTitle: 200, boardName: 200, labelName: 24, check: 500, checks: 300, lists: 200, cards: 5000, archive: 5000, opsPerBatch: 400 };

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, f = '') => (typeof v === 'string' ? v : f);
export const goodId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
export const clone = v => JSON.parse(JSON.stringify(v));
const canon = v => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/* ---------- cleaning (the server never trusts a client) ---------- */
function cleanChecks(v) {
  return (Array.isArray(v) ? v : []).filter(isObj).slice(0, LIMITS.checks).map((k, i) => ({
    id: goodId(k.id) ? k.id : 'k' + i, text: str(k.text).slice(0, LIMITS.check), done: k.done === true,
  }));
}
const cleanFields = {
  title: v => (str(v).slice(0, LIMITS.title) || 'Untitled'),
  desc: v => str(v).slice(0, LIMITS.desc),
  labels: v => (Array.isArray(v) ? v : []).filter((x, i, a) => LABEL_IDS.includes(x) && a.indexOf(x) === i),
  due: v => (/^\d{4}-\d\d-\d\d$/.test(v) ? v : ''),
  done: v => v === true,
  checks: cleanChecks,
};
export function cleanCard(c) {
  if (!isObj(c) || !goodId(c.id)) return null;
  const out = { id: c.id };
  for (const k of Object.keys(cleanFields)) out[k] = cleanFields[k](c[k]);
  out.created = Number.isFinite(+c.created) && +c.created > 0 ? +c.created : 0;
  return out;
}
export function cleanNames(n) {
  const out = {};
  if (isObj(n)) for (const id of LABEL_IDS) { const t = str(n[id]).trim().slice(0, LIMITS.labelName); if (t) out[id] = t; }
  return out;
}
export function cleanDoc(b) {
  const seen = new Set();
  const lists = [];
  for (const l of (isObj(b) && Array.isArray(b.lists) ? b.lists : []).slice(0, LIMITS.lists)) {
    if (!isObj(l) || !goodId(l.id) || seen.has(l.id)) continue;
    seen.add(l.id);
    const cards = [];
    for (const c of (Array.isArray(l.cards) ? l.cards : [])) { const cc = cleanCard(c); if (cc && !seen.has(cc.id)) { seen.add(cc.id); cards.push(cc); } }
    lists.push({ id: l.id, title: str(l.title).slice(0, LIMITS.listTitle) || 'Untitled', cards });
  }
  const archive = [];
  for (const a of (isObj(b) && Array.isArray(b.archive) ? b.archive : []).slice(0, LIMITS.archive)) {
    const cc = isObj(a) ? cleanCard(a.card) : null;
    if (cc && !seen.has(cc.id)) { seen.add(cc.id); archive.push({ card: cc, listId: str(a.listId).slice(0, 40), listTitle: str(a.listTitle, 'List').slice(0, LIMITS.listTitle) || 'List', at: +a.at || 0 }); }
  }
  return { name: (isObj(b) && str(b.name).trim().slice(0, LIMITS.boardName)) || 'Untitled', names: cleanNames(isObj(b) ? b.names : {}), archived: isObj(b) && b.archived === true, lists, archive };
}

/* ---------- finding things ---------- */
function findCard(doc, id) {
  for (const l of doc.lists) { const i = l.cards.findIndex(c => c.id === id); if (i > -1) return { list: l, i, card: l.cards[i] }; }
  return null;
}
const clamp = (i, n) => Math.max(0, Math.min(Number.isFinite(+i) ? Math.floor(+i) : n, n));
const cardCount = doc => doc.lists.reduce((n, l) => n + l.cards.length, 0);
const idTaken = (doc, id) => doc.lists.some(l => l.id === id) || !!findCard(doc, id) || doc.archive.some(a => a.card.id === id);

/* ---------- applying one operation (returns true when something changed) ---------- */
export function applyOp(doc, op) {
  if (!isObj(op) || typeof op.o !== 'string') return false;
  switch (op.o) {
    case 'board.set': {
      let ch = false;
      if (typeof op.name === 'string' && op.name.trim()) { const n = op.name.trim().slice(0, LIMITS.boardName); if (n !== doc.name) { doc.name = n; ch = true; } }
      if (isObj(op.names)) { const n = cleanNames(op.names); if (!same(n, doc.names)) { doc.names = n; ch = true; } }
      if (typeof op.archived === 'boolean' && op.archived !== doc.archived) { doc.archived = op.archived; ch = true; }
      return ch;
    }
    case 'list.add': {
      const l = op.list; if (!isObj(l) || !goodId(l.id) || idTaken(doc, l.id) || doc.lists.length >= LIMITS.lists) return false;
      doc.lists.splice(clamp(op.index, doc.lists.length), 0, { id: l.id, title: str(l.title).slice(0, LIMITS.listTitle) || 'Untitled', cards: [] });
      return true;
    }
    case 'list.set': {
      const l = doc.lists.find(x => x.id === op.id); if (!l) return false;
      const t = str(op.title).slice(0, LIMITS.listTitle) || 'Untitled'; if (t === l.title) return false; l.title = t; return true;
    }
    case 'list.move': {
      const i = doc.lists.findIndex(x => x.id === op.id); if (i < 0) return false;
      const [l] = doc.lists.splice(i, 1); const j = clamp(op.index, doc.lists.length); doc.lists.splice(j, 0, l); return i !== j;
    }
    case 'list.del': {
      const i = doc.lists.findIndex(x => x.id === op.id); if (i < 0) return false; doc.lists.splice(i, 1); return true;
    }
    case 'card.add': {
      const c = cleanCard(op.card); if (!c || idTaken(doc, c.id) || cardCount(doc) >= LIMITS.cards) return false;
      const l = doc.lists.find(x => x.id === op.listId) || doc.lists[0]; if (!l) return false;   // a deleted list never swallows a card
      l.cards.splice(clamp(op.index, l.cards.length), 0, c); return true;
    }
    case 'card.set': {
      const f = findCard(doc, op.id); if (!f || !isObj(op.f)) return false;
      let ch = false;
      for (const k of Object.keys(cleanFields)) if (k in op.f) { const v = cleanFields[k](op.f[k]); if (!same(v, f.card[k])) { f.card[k] = v; ch = true; } }
      return ch;
    }
    case 'card.move': {
      const f = findCard(doc, op.id); if (!f) return false;
      const to = doc.lists.find(x => x.id === op.listId) || doc.lists[0]; if (!to) return false;
      f.list.cards.splice(f.i, 1);
      const j = clamp(op.index, to.cards.length); to.cards.splice(j, 0, f.card);
      return !(to === f.list && j === f.i);
    }
    case 'card.del': {
      const f = findCard(doc, op.id); if (!f) return false; f.list.cards.splice(f.i, 1); return true;
    }
    case 'arch.add': {
      const e = op.entry; const c = isObj(e) ? cleanCard(e.card) : null;
      if (!c || doc.archive.some(a => a.card.id === c.id) || findCard(doc, c.id) || doc.archive.length >= LIMITS.archive) return false;
      doc.archive.push({ card: c, listId: str(e.listId).slice(0, 40), listTitle: str(e.listTitle, 'List').slice(0, LIMITS.listTitle) || 'List', at: +e.at || 0 }); return true;
    }
    case 'arch.del': {
      const i = doc.archive.findIndex(a => a.card.id === op.id); if (i < 0) return false; doc.archive.splice(i, 1); return true;
    }
    default: return false;
  }
}
export function applyOps(doc, ops) { let ch = false; for (const op of ops) if (applyOp(doc, op)) ch = true; return ch; }

/* ---------- working out what changed: ops that turn doc a into doc b ---------- */
export function diff(a, b) {
  const ops = [];
  const bs = {};
  if (a.name !== b.name) bs.name = b.name;
  if (!same(a.names, b.names)) bs.names = clone(b.names);
  if (a.archived !== b.archived) bs.archived = b.archived;
  if (Object.keys(bs).length) ops.push({ o: 'board.set', ...bs });

  // simulate the lists and card order so every move lands exactly where it should
  const sim = a.lists.map(l => ({ id: l.id, cards: l.cards.map(c => c.id) }));
  const targetListIds = new Set(b.lists.map(l => l.id));
  for (let i = sim.length - 1; i >= 0; i--) if (!targetListIds.has(sim[i].id)) { ops.push({ o: 'list.del', id: sim[i].id }); sim.splice(i, 1); }
  b.lists.forEach((l, i) => {
    if (!sim.some(s => s.id === l.id)) { ops.push({ o: 'list.add', index: i, list: { id: l.id, title: l.title } }); sim.splice(Math.min(i, sim.length), 0, { id: l.id, cards: [] }); }
  });
  b.lists.forEach((l, i) => {
    if (sim[i].id !== l.id) { const j = sim.findIndex(s => s.id === l.id); const [s] = sim.splice(j, 1); sim.splice(i, 0, s); ops.push({ o: 'list.move', id: l.id, index: i }); }
  });
  const aList = new Map(a.lists.map(l => [l.id, l]));
  b.lists.forEach(l => { const al = aList.get(l.id); if (al && al.title !== l.title) ops.push({ o: 'list.set', id: l.id, title: l.title }); });

  // restoring from the archive: the archive entry must go before the card comes back
  // the archive is an ordered list: keep the common start, then remove and re-add whatever differs
  let keep = 0;
  while (keep < a.archive.length && keep < b.archive.length && same(a.archive[keep], b.archive[keep])) keep++;
  for (let i = keep; i < a.archive.length; i++) ops.push({ o: 'arch.del', id: a.archive[i].card.id });

  const bCards = new Map(); b.lists.forEach(l => l.cards.forEach(c => bCards.set(c.id, c)));
  const aCards = new Map(); a.lists.forEach(l => l.cards.forEach(c => aCards.set(c.id, c)));
  for (const id of aCards.keys()) if (!bCards.has(id)) {
    const holder = sim.find(s => s.cards.includes(id));
    if (holder) { ops.push({ o: 'card.del', id }); holder.cards.splice(holder.cards.indexOf(id), 1); }
  }
  b.lists.forEach((l, li) => {
    const target = sim[li];
    l.cards.forEach((c, i) => {
      if (target.cards[i] === c.id) return;
      const from = sim.find(s => s.cards.includes(c.id));
      if (from) { from.cards.splice(from.cards.indexOf(c.id), 1); target.cards.splice(Math.min(i, target.cards.length), 0, c.id); ops.push({ o: 'card.move', id: c.id, listId: l.id, index: i }); }
      else { target.cards.splice(Math.min(i, target.cards.length), 0, c.id); ops.push({ o: 'card.add', listId: l.id, index: i, card: clone(c) }); }
    });
  });
  for (const [id, c] of bCards) {
    const old = aCards.get(id); if (!old) continue;
    const f = {};
    for (const k of Object.keys(cleanFields)) if (!same(old[k], c[k])) f[k] = clone(c[k]);
    if (Object.keys(f).length) ops.push({ o: 'card.set', id, f });
  }
  for (let i = keep; i < b.archive.length; i++) ops.push({ o: 'arch.add', entry: clone(b.archive[i]) });
  return ops;
}

/* ---------- copy a document into the live one without replacing the objects the screen holds ---------- */
export function syncInto(live, model) {
  live.name = model.name; live.archived = model.archived;
  for (const k of Object.keys(live.names)) delete live.names[k];
  Object.assign(live.names, model.names);
  const cardById = new Map();
  live.lists.forEach(l => l.cards.forEach(c => cardById.set(c.id, c)));
  live.archive.forEach(a => cardById.set(a.card.id, a.card));
  const fill = mc => {
    let c = cardById.get(mc.id);
    if (!c) { c = {}; cardById.set(mc.id, c); }
    c.id = mc.id; c.title = mc.title; c.desc = mc.desc; c.labels = mc.labels.slice(); c.due = mc.due; c.done = mc.done; c.created = mc.created;
    c.checks = mc.checks.map(k => ({ id: k.id, text: k.text, done: k.done }));
    return c;
  };
  const listById = new Map(live.lists.map(l => [l.id, l]));
  const lists = model.lists.map(ml => {
    const l = listById.get(ml.id) || { id: ml.id, title: '', cards: [] };
    l.title = ml.title;
    l.cards.splice(0, l.cards.length, ...ml.cards.map(fill));
    return l;
  });
  live.lists.splice(0, live.lists.length, ...lists);
  const arch = model.archive.map(ma => ({ card: fill(ma.card), listId: ma.listId, listTitle: ma.listTitle, at: ma.at }));
  live.archive.splice(0, live.archive.length, ...arch);
}

/* ---------- one board's sync state on a client ----------
   confirmed: what the server has told us.  pending: our batches the server has not echoed yet.
   model: confirmed plus pending, i.e. what the screen should show.  The live document is the screen's working copy. */
export class BoardSync {
  constructor(doc) { this.confirmed = clone(doc); this.pending = []; this.model = clone(doc); this.n = 0; }
  // Turn the person's unsent edits (live differs from model) into a batch to send.
  collect(live, newId) {
    const ops = diff(this.model, live);
    if (!ops.length) return null;
    const inverse = diff(live, this.model);
    const batch = { opid: newId ? newId() : 'b' + (++this.n), ops };
    this.pending.push(batch);
    applyOps(this.model, ops);
    return { batch, inverse };
  }
  // A batch arrived from the server (ours coming back, or someone else's).
  receive(msg, live, mine, newId) {
    const extra = this.collect(live, newId);
    applyOps(this.confirmed, msg.ops);
    if (mine) { const i = this.pending.findIndex(b => b.opid === msg.opid); if (i > -1) this.pending.splice(i, 1); }
    const next = clone(this.confirmed);
    for (const b of this.pending) applyOps(next, b.ops);
    const changed = !same(next, this.model);
    this.model = next;
    if (changed) syncInto(live, next);
    return { extra, changed };
  }
  // The server sent a whole new copy (first load, or after a problem). Any unsent edits are replayed on top.
  reset(doc, live) {
    const extra = live ? this.collect(live) : null;
    this.confirmed = clone(doc);
    const next = clone(doc);
    for (const b of this.pending) applyOps(next, b.ops);
    this.model = next;
    if (live) syncInto(live, next);
    return extra;
  }
}
