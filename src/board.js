import { DurableObject } from 'cloudflare:workers';
import { applyOp, cleanDoc, LIMITS } from '../shared/ops.js';
import { ensureSchema } from './db.js';

const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const tidy = v => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30) || 'Someone';
const short = (t, n = 40) => { t = String(t || 'Untitled'); return '“' + (t.length > n ? t.slice(0, n - 1) + '…' : t) + '”'; };
const SNAP_EVERY = 3600e3, SNAP_KEEP = 48, ACTIVITY_KEEP = 200;

/* One Durable Object per board. It is the only writer, so every change is applied one at a time, in one order,
   and then sent to everyone who is looking at the board. */
export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env; this.doc = null; this.id = ''; this.rev = 0; this.lastSnap = 0; this.activity = []; this.written = new Map();
    ctx.blockConcurrencyWhile(() => this.load());
  }

  /* ----- storage: a small key per list, so a change rewrites only what it touched ----- */
  async load() {
    const meta = await this.ctx.storage.get('meta');
    if (!meta) return;
    const lists = [];
    for (const ids of chunks(meta.listIds, 100)) {
      const got = await this.ctx.storage.get(ids.map(i => 'l:' + i));
      for (const i of ids) { const l = got.get('l:' + i); if (l) lists.push(l); }
    }
    const archive = (await this.ctx.storage.get('archive')) || [];
    this.activity = (await this.ctx.storage.get('activity')) || [];
    this.id = meta.id; this.rev = meta.rev || 0; this.lastSnap = meta.lastSnap || 0;
    this.doc = { name: meta.name, names: meta.names, archived: meta.archived, lists, archive };
    this.remember();
  }
  parts() {
    const d = this.doc, p = new Map();
    p.set('meta', { id: this.id, name: d.name, names: d.names, archived: d.archived, listIds: d.lists.map(l => l.id), rev: this.rev, lastSnap: this.lastSnap });
    for (const l of d.lists) p.set('l:' + l.id, l);
    p.set('archive', d.archive);
    p.set('activity', this.activity);
    return p;
  }
  remember() { this.written = new Map([...this.parts()].map(([k, v]) => [k, JSON.stringify(v)])); }
  async persist() {
    const next = this.parts(), put = {}, del = [];
    for (const [k, v] of next) { const s = JSON.stringify(v); if (this.written.get(k) !== s) { put[k] = v; this.written.set(k, s); } }
    for (const k of [...this.written.keys()]) if (!next.has(k)) { del.push(k); this.written.delete(k); }
    for (const part of chunks(Object.entries(put), 100)) await this.ctx.storage.put(Object.fromEntries(part));
    for (const part of chunks(del, 100)) await this.ctx.storage.delete(part);
  }

  /* ----- plain requests from the Worker (never from a browser) ----- */
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get('upgrade') === 'websocket') return this.connect(req);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    switch (url.pathname) {
      case '/init':
        if (!this.doc) { this.id = String(body.id); this.doc = cleanDoc(body.doc); this.rev = 1; await this.persist(); }
        return Response.json({ ok: true });
      case '/destroy':
        this.doc = null; this.written = new Map();
        for (const ws of this.ctx.getWebSockets()) { try { ws.send(JSON.stringify({ t: 'gone' })); ws.close(4004, 'deleted'); } catch (e) { /* already closed */ } }
        await new Promise(r => setTimeout(r, 300));   // let the goodbye reach everyone before the storage goes
        await this.ctx.storage.deleteAll();
        return Response.json({ ok: true });
      case '/restore':
        if (!this.doc) return new Response('gone', { status: 404 });
        this.doc = cleanDoc(body.doc); this.rev++; this.logActivity(body.by, 'restored an earlier version of the board'); await this.persist(); await this.mirror();
        for (const ws of this.ctx.getWebSockets()) this.hello(ws);
        return Response.json({ ok: true });
      case '/snapshot':
        return Response.json({ doc: this.doc, rev: this.rev });
      default: return new Response('not found', { status: 404 });
    }
  }

  /* ----- live connections (hibernating sockets: the object can sleep between messages) ----- */
  connect(req) {
    if (!this.doc) return new Response('gone', { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    const att = { name: (req.headers.get('x-user') || 'Someone').slice(0, 30), cid: (req.headers.get('x-cid') || '').slice(0, 40) };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(att);
    this.hello(server);
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }
  send(ws, m) { try { ws.send(JSON.stringify(m)); } catch (e) { /* the socket just closed */ } }
  broadcast(m, except) { const s = JSON.stringify(m); for (const ws of this.ctx.getWebSockets()) { if (ws === except) continue; try { ws.send(s); } catch (e) { /* closed */ } } }
  presence(except) { return [...new Set(this.ctx.getWebSockets().filter(w => w !== except && w.readyState === 1).map(w => (w.deserializeAttachment() || {}).name).filter(Boolean))]; }
  broadcastPresence(except) { this.broadcast({ t: 'presence', users: this.presence(except) }); }
  hello(ws) {
    const a = ws.deserializeAttachment() || {};
    this.send(ws, { t: 'hello', id: this.id, rev: this.rev, you: a.name, doc: this.doc, presence: this.presence() });
  }

  async webSocketMessage(ws, data) {
    if (!this.doc) return;
    if (typeof data !== 'string' || data.length > 700000) { ws.close(1009, 'too large'); return; }
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    const a = ws.deserializeAttachment() || {};
    if (m.t === 'ops') {
      const opid = String(m.opid || '').slice(0, 60);
      const applied = [];
      for (const op of (Array.isArray(m.ops) ? m.ops : []).slice(0, LIMITS.opsPerBatch)) {
        if (op && op.o === 'card.add' && op.card && typeof op.card === 'object' && !(+op.card.created > 0)) op.card.created = Date.now();   // stamped once here so every copy agrees
        const said = this.describe(op, a.name);
        if (applyOp(this.doc, op)) { applied.push(op); if (said) this.logActivity(a.name, said); }
      }
      if (applied.length) {
        this.rev++;
        const msg = { t: 'ops', seq: this.rev, opid, cid: a.cid, by: a.name, ops: applied };
        this.broadcast(msg);
        await this.persist();
        if (applied.some(o => o.o === 'board.set')) await this.mirror();
        await this.maybeSnapshot();
      } else {
        this.send(ws, { t: 'ops', seq: this.rev, opid, cid: a.cid, by: a.name, ops: [] });   // nothing to do, but the sender still needs its receipt
      }
    } else if (m.t === 'name') {                    // someone changed the name they go by: relabel this connection, no reconnect needed
      ws.serializeAttachment({ ...a, name: tidy(m.name) }); this.broadcastPresence();
      this.send(ws, { t: 'you', name: tidy(m.name) });
    } else if (m.t === 'sync') {
      this.hello(ws);
    } else if (m.t === 'activity') {
      this.send(ws, { t: 'activity', items: this.activity.slice(-100).reverse() });
    }
  }
  webSocketClose(ws) { try { ws.close(); } catch (e) { /* already closed */ } this.broadcastPresence(ws); }
  webSocketError(ws) { this.broadcastPresence(ws); }

  /* ----- a short human-readable trail of who did what ----- */
  describe(op, who) {
    const d = this.doc; if (!d || !op || typeof op !== 'object') return '';
    const card = id => { for (const l of d.lists) { const c = l.cards.find(x => x.id === id); if (c) return { c, l }; } return null; };
    const list = id => d.lists.find(l => l.id === id);
    switch (op.o) {
      case 'card.add': return op.card && !card(op.card.id) ? `added ${short(op.card.title)} to ${short((list(op.listId) || d.lists[0] || {}).title)}` : '';
      case 'card.del': { const f = card(op.id); return f ? `deleted ${short(f.c.title)}` : ''; }
      case 'card.move': { const f = card(op.id), to = list(op.listId); return f && to && to !== f.l ? `moved ${short(f.c.title)} to ${short(to.title)}` : ''; }
      case 'card.set': {
        const f = card(op.id); if (!f || !op.f) return '';
        if (op.f.done === true && !f.c.done) return `completed ${short(f.c.title)}`;
        if (op.f.done === false && f.c.done) return `reopened ${short(f.c.title)}`;
        return `edited ${short(f.c.title)}`;
      }
      case 'arch.add': return op.entry && op.entry.card ? `archived ${short(op.entry.card.title)}` : '';
      case 'arch.del': { const e = d.archive.find(x => x.card.id === op.id); return e ? `restored or removed ${short(e.card.title)} from the archive` : ''; }
      case 'list.add': return op.list ? `added the list ${short(op.list.title)}` : '';
      case 'list.del': { const l = list(op.id); return l ? `deleted the list ${short(l.title)}` : ''; }
      case 'list.set': { const l = list(op.id); return l && l.title !== op.title ? `renamed the list ${short(l.title)} to ${short(op.title)}` : ''; }
      case 'board.set':
        if (typeof op.name === 'string' && op.name.trim() && op.name.trim() !== d.name) return `renamed the board to ${short(op.name.trim())}`;
        if (typeof op.archived === 'boolean' && op.archived !== d.archived) return op.archived ? 'archived the board' : 'restored the board';
        return '';
      default: return '';
    }
  }
  logActivity(who, text) {
    const now = Date.now(), last = this.activity[this.activity.length - 1];
    // typing in one card produces many tiny edits: keep one line per person and card per minute
    if (last && last.who === who && last.text === text && now - last.at < 60000) { last.at = now; return; }
    this.activity.push({ who, text, at: now });
    if (this.activity.length > ACTIVITY_KEEP) this.activity.splice(0, this.activity.length - ACTIVITY_KEEP);
  }

  /* ----- the board list lives in D1, so keep its name and archived flag current; keep hourly backups ----- */
  async mirror() {
    try { await ensureSchema(this.env.DB); await this.env.DB.prepare('UPDATE boards SET name = ?, archived = ? WHERE id = ?').bind(this.doc.name, this.doc.archived ? 1 : 0, this.id).run(); } catch (e) { /* the next change tries again */ }
  }
  async maybeSnapshot() {
    const now = Date.now(); if (now - this.lastSnap < SNAP_EVERY) return;
    try {
      await ensureSchema(this.env.DB);
      await this.env.DB.batch([
        this.env.DB.prepare('INSERT OR REPLACE INTO snapshots (board_id, at, json) VALUES (?, ?, ?)').bind(this.id, now, JSON.stringify(this.doc)),
        this.env.DB.prepare('DELETE FROM snapshots WHERE board_id = ? AND at NOT IN (SELECT at FROM snapshots WHERE board_id = ? ORDER BY at DESC LIMIT ?)').bind(this.id, this.id, SNAP_KEEP),
      ]);
      this.lastSnap = now; await this.persist();
    } catch (e) { /* try again after the next change */ }
  }
}
