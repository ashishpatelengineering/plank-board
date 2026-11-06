import { configured, hasSession, checkPassword, makeSession, sessionCookie, clearCookie, MIN_PASSWORD } from './auth.js';
import { ensureSchema } from './db.js';
import { loginPage } from './page.js';
import { cleanDoc, goodId } from '../shared/ops.js';
export { Board } from './board.js';

const MAX_BOARDS = 200;
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const fail = (status, error) => json({ error }, status);
const stub = (env, id) => env.BOARD.get(env.BOARD.idFromName(id));
const call = (env, id, path, body) => stub(env, id).fetch('https://board' + path, { method: 'POST', body: JSON.stringify(body || {}) });
const newId = () => { const b = crypto.getRandomValues(new Uint8Array(9)); return [...b].map(x => (x % 36).toString(36)).join('') + Date.now().toString(36).slice(-3); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* a display name only: it labels presence and the activity trail, it proves nothing */
const cleanName = raw => { let s = ''; try { s = decodeURIComponent(raw || ''); } catch (e) { s = String(raw || ''); } return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30) || 'Someone'; };
const secure = h => { h.set('x-content-type-options', 'nosniff'); h.set('referrer-policy', 'same-origin'); h.set('x-frame-options', 'DENY'); h.set('cache-control', 'no-store'); return h; };
const html = (text, status = 200) => new Response(text, { status, headers: secure(new Headers({ 'content-type': 'text/html; charset=utf-8' })) });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    const isApi = path.startsWith('/api/') || path.startsWith('/ws/');
    const origin = req.headers.get('origin');
    const sameOrigin = !origin || new URL(origin).host === url.host;   // a page on another website must never act as you

    if (!configured(env)) {
      const msg = `Plank Board is not set up yet. Add a TEAM_PASSWORD of at least ${MIN_PASSWORD} characters (see the setup guide).`;
      return isApi || path.startsWith('/auth/') ? fail(503, msg) : html(loginPage(msg), 503);
    }

    if (path === '/auth/login' && req.method === 'POST') {
      if (!sameOrigin || req.headers.get('x-plank') !== '1') return fail(403, 'Wrong origin.');
      const body = await req.json().catch(() => null);
      if (!(await checkPassword(env, body && body.password))) { await sleep(700); return fail(401, 'That password is not right.'); }
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await makeSession(env)) });
    }
    if (path === '/auth/logout' && req.method === 'POST') {
      if (!sameOrigin || req.headers.get('x-plank') !== '1') return fail(403, 'Wrong origin.');
      return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
    }

    const signedIn = await hasSession(req, env);
    if (!isApi) {
      if (!signedIn) return html(loginPage());
      const res = await env.ASSETS.fetch(req);
      const h = secure(new Headers(res.headers));
      return new Response(res.body, { status: res.status, headers: h });
    }
    if (!signedIn) return fail(401, 'Not signed in.');
    if (!sameOrigin) return fail(403, 'Wrong origin.');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.get('x-plank') !== '1') return fail(403, 'Missing header.');

    const name = cleanName(path.startsWith('/ws/') ? url.searchParams.get('name') : req.headers.get('x-plank-name'));
    await ensureSchema(env.DB);
    const now = Date.now();
    const parts = path.split('/').filter(Boolean);       // ['api','boards',id,'snapshots',at]
    const exists = async id => !!(await env.DB.prepare('SELECT 1 x FROM boards WHERE id = ?').bind(id).first());

    /* ----- live connection ----- */
    if (parts[0] === 'ws' && parts[1]) {
      if (req.headers.get('upgrade') !== 'websocket') return fail(426, 'Expected a WebSocket.');
      const id = parts[1]; if (!(await exists(id))) return fail(404, 'No such board.');
      const fwd = new Request('https://board/ws', { headers: { upgrade: 'websocket', 'x-user': name, 'x-cid': url.searchParams.get('cid') || '' } });
      return stub(env, id).fetch(fwd);
    }
    if (parts[0] !== 'api') return fail(404, 'Not found.');

    if (parts[1] === 'me' && req.method === 'GET') return json({ name });

    if (parts[1] === 'boards' && parts.length === 2) {
      if (req.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT id, name, archived FROM boards ORDER BY created, id').all();
        return json({ name, boards: results.map(r => ({ id: r.id, name: r.name, archived: !!r.archived })) });
      }
      if (req.method === 'POST') {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.board !== 'object') return fail(400, 'Missing board.');
        const count = await env.DB.prepare('SELECT count(*) c FROM boards').first();
        if (count.c >= MAX_BOARDS) return fail(429, 'Too many boards.');
        let id = goodId(body.id) ? body.id : newId();
        if (await exists(id)) id = newId();
        const doc = cleanDoc(body.board);
        await env.DB.prepare('INSERT INTO boards (id, name, archived, created, owner) VALUES (?, ?, ?, ?, ?)').bind(id, doc.name, doc.archived ? 1 : 0, now, name).run();
        await call(env, id, '/init', { id, doc });
        return json({ id, name: doc.name, archived: doc.archived }, 201);
      }
    }

    if (parts[1] === 'boards' && parts[2]) {
      const id = parts[2];
      if (!(await exists(id))) return fail(404, 'No such board.');

      if (parts.length === 3 && req.method === 'DELETE') {
        await call(env, id, '/destroy');
        await env.DB.batch([env.DB.prepare('DELETE FROM boards WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM snapshots WHERE board_id = ?').bind(id)]);
        return json({ ok: true });
      }

      if (parts[3] === 'snapshots') {
        if (parts.length === 4 && req.method === 'GET') {
          const { results } = await env.DB.prepare('SELECT at, json FROM snapshots WHERE board_id = ? ORDER BY at DESC').bind(id).all();
          return json({ snapshots: results.map(r => { let lists = 0, cards = 0; try { const d = JSON.parse(r.json); lists = d.lists.length; cards = d.lists.reduce((n, l) => n + l.cards.length, 0); } catch (e) { /* unreadable: counts stay 0 */ } return { at: r.at, lists, cards }; }) });
        }
        if (parts.length === 5 && req.method === 'GET') {
          const r = await env.DB.prepare('SELECT json FROM snapshots WHERE board_id = ? AND at = ?').bind(id, +parts[4]).first();
          return r ? new Response(r.json, { headers: { 'content-type': 'application/json' } }) : fail(404, 'No such backup.');
        }
        if (parts.length === 5 && req.method === 'POST') {
          const r = await env.DB.prepare('SELECT json FROM snapshots WHERE board_id = ? AND at = ?').bind(id, +parts[4]).first();
          if (!r) return fail(404, 'No such backup.');
          // keep what is there now as a backup first, so a restore can itself be undone
          const cur = await (await call(env, id, '/snapshot')).json();
          if (cur && cur.doc) await env.DB.prepare('INSERT OR REPLACE INTO snapshots (board_id, at, json) VALUES (?, ?, ?)').bind(id, Date.now(), JSON.stringify(cur.doc)).run();
          await call(env, id, '/restore', { doc: JSON.parse(r.json), by: name });
          return json({ ok: true });
        }
      }
    }
    return fail(404, 'Not found.');
  },
};
