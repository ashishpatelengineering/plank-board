/* ---------- team mode: boards live on the team server and everyone sees changes as they happen ---------- */
(() => {
T.on = true;
const CID = uid() + uid();
const tb = new Map();            // board id -> { id, role, ws, up, tries, timer, sync, live, presence, removed }
const order = new Map();         // board id -> position in the list the server gave us
const creating = new Set();
let me = '', opn = 0, dirty = false, groups = [], lastCheck = 0;
const newOp = () => CID + '-' + (++opn);
const NAME_KEY = 'plank.team.name';
const tidy = v => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
let myName = ''; try { myName = tidy(localStorage.getItem(NAME_KEY)); } catch (e) { /* ignore */ }
const headers = () => ({ 'content-type': 'application/json', 'x-plank': '1', 'x-plank-name': encodeURIComponent(myName || 'Someone') });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null; try { data = await r.json(); } catch (e) { /* no body */ }
  if (r.status === 401) {                       // the password cookie ran out or the password changed: go back to the password page
    let again = false; try { again = Date.now() - +sessionStorage.getItem('plank.reload') < 15000; sessionStorage.setItem('plank.reload', String(Date.now())); } catch (e) { /* ignore */ }
    if (!again) { location.reload(); return new Promise(() => {}); }
  }
  if (!r.ok) { const err = new Error((data && data.error) || ('Something went wrong (' + r.status + ')')); err.status = r.status; throw err; }
  return data;
}

/* ----- one live connection per board ----- */
function openBoard(meta, live) {
  const rec = { id: meta.id, role: 'owner', ws: null, up: false, tries: 0, timer: null, sync: null, live: live || null, presence: [], removed: false, deleting: false, onActivity: null, resolve: null };
  rec.first = new Promise(r => { rec.resolve = r; });
  tb.set(meta.id, rec); dial(rec); return rec;
}
function dial(rec) {
  if (rec.removed) return;
  clearTimeout(rec.timer); rec.timer = null;
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws/' + rec.id + '?cid=' + CID + '&name=' + encodeURIComponent(myName || 'Someone'));
  rec.ws = ws;
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMsg(rec, m); };
  ws.onclose = ev => {
    if (rec.ws !== ws || rec.removed) return;
    rec.up = false;
    if (ev.code === 4004) return lose(rec, 'deleted');
    redial(rec); setWarn();
  };
  ws.onerror = () => { /* onclose follows */ };
}
function redial(rec) {
  if (rec.removed || rec.timer) return;
  rec.tries++;
  rec.timer = setTimeout(async () => {
    rec.timer = null;
    if (rec.tries >= 2) { try { const l = await api('GET', '/api/boards'); if (!l.boards.some(b => b.id === rec.id) && rec.live && !creating.has(rec.id)) return lose(rec, 'removed'); } catch (e) { /* offline */ } }
    dial(rec);
  }, Math.min(15000, 700 * 2 ** Math.min(rec.tries, 5)));
}
function sendBatch(rec, batch) {
  if (rec.ws && rec.ws.readyState === 1) { try { rec.ws.send(JSON.stringify({ t: 'ops', opid: batch.opid, ops: batch.ops })); } catch (e) { /* resent after reconnect */ } }
}
function onMsg(rec, m) {
  if (m.t === 'hello') {
    rec.tries = 0; rec.up = true; if (m.you) me = m.you;
    if (!rec.sync) {
      rec.sync = new BoardSync(m.doc);
      if (rec.live) syncInto(rec.live, m.doc); else rec.live = Object.assign(clone(m.doc), { id: rec.id, role: rec.role });
      place(rec); rec.resolve();
    } else {
      const extra = rec.sync.reset(m.doc, rec.live);
      if (extra) record(rec, extra);
    }
    rec.live.role = rec.role;
    for (const b of rec.sync.pending) sendBatch(rec, b);       // anything not yet confirmed is sent again; applying twice changes nothing
    rec.presence = m.presence || [];
    setWarn(); if (rec.id === S.active) { renderHeader(); renderBoard(); }
  } else if (m.t === 'ops' && rec.sync) {
    const r = rec.sync.receive(m, rec.live, m.cid === CID, newOp);
    if (r.extra) { record(rec, r.extra); sendBatch(rec, r.extra.batch); }
    if (r.changed) { if (rec.id === S.active) { dirty = true; tick(); } }
  } else if (m.t === 'you') {
    if (m.name) me = m.name;
  } else if (m.t === 'presence') {
    rec.presence = m.users || []; if (rec.id === S.active) drawPresence();
  } else if (m.t === 'activity') {
    if (rec.onActivity) rec.onActivity(m.items || []);
  } else if (m.t === 'gone') {
    if (!rec.removed) lose(rec, 'deleted');
  }
}
function place(rec) {
  if (S.boards.includes(rec.live)) return;
  const idx = order.has(rec.id) ? order.get(rec.id) : 1e9;
  let at = S.boards.findIndex(b => (order.has(b.id) ? order.get(b.id) : 1e9) > idx);
  if (at < 0) at = S.boards.length;
  S.boards.splice(at, 0, rec.live);
}
function lose(rec, why) {
  if (rec.removed) return;
  rec.removed = true; clearTimeout(rec.timer); try { rec.ws && rec.ws.close(); } catch (e) { /* closed */ }
  tb.delete(rec.id);
  const name = rec.live ? rec.live.name : 'A board';
  const i = rec.live ? S.boards.indexOf(rec.live) : -1; if (i > -1) S.boards.splice(i, 1);
  modalStack.slice().forEach(m => m.close());
  if (!S.boards.length) { const b = starter().boards[0]; S.boards.push(b); S.active = b.id; }
  if (S.active === rec.id || !S.boards.some(b => b.id === S.active)) { const nb = S.boards.find(b => !b.archived) || S.boards[0]; S.active = nb.id; ui.composer = null; ui.addList = false; }
  renderHeader(); renderBoard(); setWarn();
  toast(why === 'deleted' ? `“${name}” was deleted` : `“${name}” is no longer available`);
}

/* ----- turning what the person did on screen into operations ----- */
function record(rec, out) {                      // remember how to undo this batch
  const g = groups[groups.length - 1];
  if (g && out.inverse && out.inverse.length) g.inv.unshift({ id: rec.id, ops: out.inverse });
}
function collectAll() {
  for (const rec of tb.values()) {
    if (!rec.sync || !rec.live) continue;
    const out = rec.sync.collect(rec.live, newOp);
    if (out) { record(rec, out); sendBatch(rec, out.batch); }
  }
}
async function createBoard(b) {
  creating.add(b.id);
  try {
    const res = await api('POST', '/api/boards', { id: b.id, board: b });
    if (res.id !== b.id) { if (S.active === b.id) S.active = res.id; b.id = res.id; }
    b.role = 'owner'; order.set(b.id, order.size);
    openBoard({ id: b.id, role: 'owner' }, b);
  } catch (e) { setTimeout(() => creating.delete(b.id), 4000); return; }
  creating.delete(b.id);
}
async function deleteBoard(rec) {
  if (rec.deleting) return; rec.deleting = true;
  try { await api('DELETE', '/api/boards/' + rec.id); rec.removed = true; clearTimeout(rec.timer); try { rec.ws && rec.ws.close(); } catch (e) { /* closed */ } tb.delete(rec.id); }
  catch (e) { rec.deleting = false; toast('Could not delete the board. Try again.'); place(rec); renderHeader(); renderBoard(); }
}
T.flush = () => {
  for (const b of S.boards) if (!tb.has(b.id) && !creating.has(b.id)) createBoard(b);                         // a board made or imported on this screen
  for (const rec of [...tb.values()]) if (rec.live && rec.sync && !rec.removed && !S.boards.includes(rec.live)) deleteBoard(rec);   // deleted forever on this screen
  collectAll();
  try { localStorage.setItem('plank.team.active', S.active); } catch (e) { /* ignore */ }
  setWarn();
};
T.checkpoint = () => { collectAll(); groups.push({ inv: [] }); if (groups.length > 60) groups.shift(); };
T.undo = () => {
  collectAll();
  let g = groups.pop();
  while (g && !g.inv.length) g = groups.pop();
  if (!g) return false;
  document.querySelectorAll('.overlay').forEach(o => o.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  for (const e of g.inv) {
    const rec = tb.get(e.id); if (!rec || !rec.live) continue;
    applyOps(rec.live, e.ops);
    if (S.boards.includes(rec.live) && !rec.live.archived) S.active = rec.id;
  }
  ui.composer = null; ui.addList = false;
  touch(); renderHeader(); renderBoard();
  return true;
};

/* ----- showing other people's changes without disturbing you ----- */
function inBoardField() { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !!a.closest('#board'); }
function inSheetField() { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && !!a.closest('.overlay'); }
function tick() {
  if (!dirty || drag || press || inBoardField()) return;
  dirty = false;
  const a = document.activeElement, c = a && a.closest && a.closest('.card');
  if (c && c.dataset.id) ui.focusCardId = c.dataset.id;
  renderHeader(); renderBoard();
  if (ui.cardPaint && !inSheetField()) ui.cardPaint.paint();
}
setInterval(tick, 250);
const hue = s => { let x = 0; for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x % 360; };
const initials = e => { const p = e.split(' ').filter(Boolean); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : (p[0] || '')[1] || '')).toUpperCase(); };
function drawPresence() {
  const el = $('#presence'); if (!el) return;
  const rec = tb.get(S.active); const others = ((rec && rec.presence) || []).filter(x => x !== me);
  el.classList.toggle('show', others.length > 0);
  const chips = others.slice(0, 4).map(x => h('span', { class: 'pp', style: `background:hsl(${hue(x)} 55% 36%)`, title: x + ' is here too', 'aria-label': x + ' is on this board', text: initials(x) }));
  if (others.length > 4) chips.push(h('span', { class: 'pp more', title: others.slice(4).join(', '), text: '+' + (others.length - 4) }));
  el.replaceChildren(...chips);
}
const baseHeader = renderHeader;
renderHeader = () => { baseHeader(); drawPresence(); };

T.warn = w => {
  const down = [...tb.values()].some(r => r.sync && !r.up && !r.removed);
  const waiting = [...tb.values()].reduce((n, r) => n + (r.sync ? r.sync.pending.length : 0), 0);
  w.classList.toggle('show', down);
  w.textContent = 'Offline';
  w.title = down ? (waiting ? `Reconnecting. Your ${waiting} latest change${waiting === 1 ? '' : 's'} will be sent when you are back online.` : 'Reconnecting. If this lasts, reload the page.') : '';
};

/* ----- who is here, and the activity trail ----- */
const ago = at => { const s = (Date.now() - at) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
function activityDialog() {
  const rec = tb.get(S.active); if (!rec) return;
  const root = h('div', { class: 'dlg' });
  const m = openModal(root, { label: 'Activity', onClose: () => { rec.onActivity = null; } });
  function paint(items) {
    root.replaceChildren(...[
      h('h2', { text: 'Activity' }),
      h('p', { class: 'hint', text: `Recent changes on “${rec.live.name}”, newest first.` }),
      items === null ? h('div', { class: 'empty-hint', text: 'Loading…' })
        : items.length ? h('div', { class: 'arch-list' }, items.map(i => h('div', { class: 'act-row' }, `${i.who === me ? 'You' : i.who} ${i.text}`, h('small', { text: ago(i.at) }))))
          : h('div', { class: 'empty-hint', text: 'Nothing yet. Changes will appear here.' }),
      h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn primary', id: 'act-close', text: 'Close', onclick: () => m.close() }))].filter(Boolean));
  }
  rec.onActivity = paint; paint(null);
  try { rec.ws.send(JSON.stringify({ t: 'activity' })); } catch (e) { paint([]); }
}
const when = at => new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
function backupsDialog() {
  const rec = tb.get(S.active); if (!rec) return;
  const root = h('div', { class: 'dlg' });
  const m = openModal(root, { label: 'Backups' });
  let items = null, err = '', ask = null, busy = false;
  async function load() {
    try { items = (await api('GET', `/api/boards/${rec.id}/snapshots`)).snapshots; err = ''; }
    catch (e) { items = items || []; err = 'Could not load the backups.'; }
    paint();
  }
  async function restore(at) {
    busy = true; paint();
    try { await api('POST', `/api/boards/${rec.id}/snapshots/${at}`); toast('Board restored. The version it replaced is kept as a backup.'); m.close(); return; }
    catch (e) { err = 'Could not restore that backup.'; }
    busy = false; ask = null; await load();
  }
  function paint() {
    const rows = items === null ? [h('div', { class: 'empty-hint', text: 'Loading…' })]
      : items.length ? items.map(b => h('div', { class: 'tm-row' + (ask === b.at ? ' asking' : '') },
        ask === b.at
          ? [h('div', { class: 'tm-who' }, 'Replace the board with this version?', h('small', { text: `${when(b.at)}, ${b.cards} card${b.cards === 1 ? '' : 's'}` })),
            h('button', { type: 'button', class: 'btn', text: 'Cancel', disabled: busy ? true : null, onclick: () => { ask = null; paint(); } }),
            h('button', { type: 'button', class: 'btn primary', id: 'bk-confirm', text: busy ? 'Restoring…' : 'Restore', disabled: busy ? true : null, onclick: () => restore(b.at) })]
          : [h('div', { class: 'tm-who' }, when(b.at), h('small', { text: `${b.lists} list${b.lists === 1 ? '' : 's'}, ${b.cards} card${b.cards === 1 ? '' : 's'} · ${ago(b.at)}` })),
            h('button', { type: 'button', class: 'btn', text: 'Restore', 'aria-label': 'Restore the backup from ' + when(b.at), onclick: () => { ask = b.at; paint(); } })]))
        : [h('div', { class: 'empty-hint', text: 'No backups yet. One is saved every hour while the board is in use.' })];
    root.replaceChildren(...[
      h('h2', { text: 'Backups' }),
      h('p', { class: 'hint', text: `A copy of “${rec.live.name}” is saved every hour, and the last 48 are kept. Restoring replaces the board for everyone. The version you replace is saved first, so you can go back.` }),
      err ? h('p', { class: 'hint', text: err }) : null,
      h('div', { class: 'arch-list' }, rows),
      h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn primary', id: 'bk-close', text: 'Close', onclick: () => m.close() }))].filter(Boolean));
  }
  paint(); load();
}
const nameDialog = first => new Promise(done => {
  const root = h('div', { class: 'dlg' });
  let saved = false;
  const input = h('input', { type: 'text', class: 'field', id: 'nm-input', maxlength: '30', value: myName, autocomplete: 'nickname', 'aria-label': 'Your name' });
  const save = () => {
    const v = tidy(input.value); if (!v) { input.focus(); return; }
    saved = true; const changed = v !== myName; myName = v; me = v;
    try { localStorage.setItem(NAME_KEY, v); } catch (e) { /* ignore */ }
    m.close();
    if (changed && !first) { for (const r of tb.values()) { try { if (r.ws && r.ws.readyState === 1) r.ws.send(JSON.stringify({ t: 'name', name: v })); } catch (e) { /* the next connection uses the new name */ } } toast('Your name is now ' + v); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  const m = openModal(root, { label: first ? 'Your name' : 'Change my name', onClose: () => { if (!saved && !myName) myName = 'Someone'; me = myName; done(); } });
  root.replaceChildren(
    h('h2', { text: first ? 'What should we call you?' : 'Change my name' }),
    h('p', { class: 'hint', text: 'Teammates see this name next to the round badge at the top and in the activity list. It is only a label, so use your first name.' }),
    input,
    h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn primary', id: 'nm-save', text: first ? 'Continue' : 'Save', onclick: save })));
  input.focus(); input.select();
});
async function signOut() { try { await api('POST', '/auth/logout'); } catch (e) { /* the page reload shows the password page either way */ } location.reload(); }
T.menuItems = () => [
  { sep: true },
  { label: 'Activity', run: activityDialog },
  { label: 'Backups…', run: backupsDialog },
  { label: 'Change my name…', run: () => nameDialog(false) },
  { label: 'Sign out', run: signOut },
  { label: 'You are ' + me, disabled: true },
];

/* ----- the help text, adapted for a shared team board ----- */
T.help = base => {
  const teamSec = { id: 'team', title: 'Working with your team', lead: 'Everyone who knows the address and the team password sees the same boards, and every change appears for everyone the moment it happens.', blocks: [
    ['h', 'Getting in'],
    ['steps', [
      ['Open the address', 'Use the web address your team shares. Bookmark it.'],
      ['Type the team password', 'You only need it once on each device. After that this page remembers you for about a month.'],
      ['Tell us your name', 'The first time, type your first name. Teammates see it next to your round badge and in the activity list. Change it any time from the **⋯** menu with **Change my name**.'],
    ]],
    ['h', 'Working at the same time'],
    ['list', [
      '**Live changes.** When a teammate adds, edits or moves a card, you see it appear without reloading.',
      '**Who is here.** Round badges at the top show who else has the board open. Point at a badge to see the name.',
      '**Same card, same moment.** If two people change the same part of a card at the same time, the most recent change is kept. Changes to different parts, such as one person editing notes and another ticking complete, are both kept.',
      '**Activity.** Choose **Activity** from the **⋯** menu to see who did what and when.',
      '**New boards.** A board a teammate makes appears in your board list within about half a minute.',
    ]],
    ['h', 'Backups'],
    ['steps', [
      ['Open Backups', 'Click the **⋯** button, then choose **Backups**.'],
      ['Pick a version', 'A copy of the board is saved every hour, and the last 48 are kept. Each line shows the time and how many lists and cards it had. Click **Restore** next to the one you want.'],
      ['Confirm', 'Click **Restore** again to confirm, or **Cancel** to leave things as they are. The board changes for everyone straight away.'],
      ['Changed your mind?', 'The version you replaced is saved as a new backup first. Open **Backups** again and restore it.'],
    ]],
    ['h', 'If the connection drops'],
    ['list', [
      '**Offline** appears at the top when this page cannot reach the server. Keep working: your changes stay on the screen and are sent as soon as you are back.',
      'If it lasts a long time, reload the page. You may be asked for the team password again.',
    ]],
    ['h', 'Signing out'],
    ['list', ['Open the **⋯** menu and choose **Sign out**. Do this on a shared computer.']],
    ['tip', 'Archive is the safe way to tidy up. Archived cards and boards can be restored by anyone. Deleting a board for good removes it for everyone, so check with the team first.'],
  ] };
  const out = base.map(sec => {
    if (sec.id === 'saving') return { ...sec, title: 'Saving', lead: 'You never need to save by hand. Your boards are kept on the team server.', blocks: [
      ['list', [
        '**Saved for everyone.** Every change is sent to the team server within a moment, and your teammates see it straight away.',
        '**Any device.** Open this page on another computer or phone, type the team password, and you see the same boards.',
        '**History.** The server keeps hourly backups of every board. Open **Backups** in the **⋯** menu to bring back an earlier version.',
      ]],
      ['h', 'What the small message means'],
      ['list', ['**Offline:** this page cannot reach the server right now. Your latest changes wait on the screen and are sent when the connection returns.']],
      ['tip', 'Export to Excel from the **⋯** menu whenever you want your own copy.'],
    ] };
    if (sec.id === 'undo') return { ...sec, blocks: [...sec.blocks, ['tip', 'On a shared board, Undo takes back only your own last change. Your teammates\' work is never undone.']] };
    if (sec.id === 'faq') return { ...sec, blocks: sec.blocks.map(b => b[0] === 'faq' ? ['faq', [...b[1].filter(([q]) => !/other device/i.test(q)), ['How do I add a teammate?', 'Send them the web address and the team password. They then see all the boards.'], ['It asks for the password again.', 'The password is remembered for about a month on each device, and it stops working if the team password is changed. Ask whoever set it up for the current one.'], ['Why does it say Offline?', 'This page lost its connection to the server. Keep working. Your changes are sent when the connection returns.']]] : b) };
    return sec;
  });
  const at = out.findIndex(x => x.id === 'boards');
  out.splice(at + 1, 0, teamSec);
  return out;
};

/* ----- coming back to the tab, new boards made by teammates ----- */
async function refreshBoards(force) {
  if (!force && Date.now() - lastCheck < 5000) return;
  lastCheck = Date.now();
  try {
    const list = await api('GET', '/api/boards');
    const ids = new Set(list.boards.map(b => b.id));
    for (const meta of list.boards) if (!tb.has(meta.id) && !creating.has(meta.id)) {
      order.set(meta.id, order.size);
      const rec = openBoard(meta);
      rec.first.then(() => { renderHeader(); toast(`“${rec.live.name}” was added by a teammate`); });
    }
    for (const rec of [...tb.values()]) if (!ids.has(rec.id) && rec.live && !rec.removed && !rec.deleting && !creating.has(rec.id)) lose(rec, 'removed');
  } catch (e) { /* offline: the connections report it */ }
}
T.wake = () => { for (const rec of tb.values()) if (!rec.up && !rec.removed && rec.sync) { rec.tries = 0; dial(rec); } refreshBoards(false); };
addEventListener('online', () => T.wake());
setInterval(() => { if (document.visibilityState === 'visible') refreshBoards(true); }, 30000);

/* ----- start ----- */
function fatal(text) {
  S = { v: 3, active: 'x', updated: 0, boards: [{ id: 'x', name: 'Plank Board', lists: [], names: {}, archive: [], archived: false }] };
  renderHeader(); renderBoard();
  document.body.append(h('div', { class: 'overlay' }, h('div', { class: 'modal', role: 'alertdialog', 'aria-label': 'Cannot connect' }, h('div', { class: 'dlg' },
    h('h2', { text: 'Cannot connect' }), h('p', { class: 'hint', text }),
    h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn primary', text: 'Try again', onclick: () => location.reload() }))))));
}
T.boot = async () => {
  S = { v: 3, active: 'x', updated: 0, boards: [{ id: 'x', name: 'Plank Board', lists: [], names: {}, archive: [], archived: false }] };
  if (!myName) { renderHeader(); renderBoard(); await nameDialog(true); }
  me = myName;
  let list;
  try { list = await api('GET', '/api/boards'); }
  catch (e) { S = { v: 3, active: 'x', updated: 0, boards: [] }; return fatal(e.status === 503 ? e.message : 'Plank Board could not reach the server. Check your connection and try again. If the password was changed, reloading will ask for it again.'); }
  S = { v: 3, active: '', updated: 0, boards: [] };
  let metas = list.boards;
  list.boards.forEach((b, i) => order.set(b.id, i));
  if (!metas.length) {                                         // first visit by anyone: start with a sample board
    const b = starter().boards[0];
    try { const res = await api('POST', '/api/boards', { id: b.id, board: b }); metas = [{ id: res.id, name: res.name, archived: false }]; order.set(res.id, 0); }
    catch (e) { return fatal('Plank Board could not create your first board. Reload to try again.'); }
  }
  const recs = metas.map(meta => openBoard(meta));
  await Promise.race([Promise.all(recs.map(r => r.first)), sleep(8000)]);
  if (!S.boards.length) return fatal('Plank Board could not open your boards. Reload to try again.');
  let saved = ''; try { saved = localStorage.getItem('plank.team.active') || ''; } catch (e) { /* ignore */ }
  const pick = S.boards.find(b => b.id === saved && !b.archived) || S.boards.find(b => !b.archived) || S.boards[0];
  S.active = pick.id;
  renderHeader(); renderBoard(); setWarn();
  recs.forEach(r => r.first.then(() => { renderHeader(); }));
};
})();
