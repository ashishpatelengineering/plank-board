/* The only page a signed-out visitor ever gets. Plain HTML, no outside files. */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function loginPage(note) {
  const body = note
    ? `<h1>Plank Board</h1><p class="n">${esc(note)}</p>`
    : `<h1>Plank Board</h1><p>Enter the team password to open the boards.</p>
<form id="f"><label for="p">Team password</label><input id="p" type="password" autocomplete="current-password" autofocus required>
<p id="e" class="e" role="alert"></p><button type="submit" id="go">Open</button></form>
<script>
const f=document.getElementById('f'),e=document.getElementById('e'),b=document.getElementById('go'),p=document.getElementById('p');
f.addEventListener('submit',async ev=>{ev.preventDefault();e.textContent='';b.disabled=true;b.textContent='Checking…';
try{const r=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json','x-plank':'1'},body:JSON.stringify({password:p.value}),credentials:'same-origin'});
if(r.ok){location.reload();return}const d=await r.json().catch(()=>({}));e.textContent=d.error||'Something went wrong. Try again.'}
catch(x){e.textContent='Could not reach the server. Check your connection.'}
b.disabled=false;b.textContent='Open';p.select()});
</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="theme-color" content="#a31f34"><title>Plank Board</title>
<style>
:root{color-scheme:light dark;--bg:#e6e7e9;--card:#fff;--ink:#1b1b1c;--muted:#55575b;--line:#d2d3d5;--accent:#a31f34;--err:#a31f34}
@media(prefers-color-scheme:dark){:root{--bg:#101011;--card:#1b1b1d;--ink:#f0f0f1;--muted:#a6a8ad;--line:#333437;--accent:#ff7083;--err:#ff8a99}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.12)}
h1{margin:0 0 6px;font-size:22px}p{margin:0 0 16px;color:var(--muted)}.n{color:var(--ink)}
label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}
input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
button{width:100%;margin-top:14px;font:inherit;font-weight:600;padding:11px;border:0;border-radius:8px;color:#fff;background:linear-gradient(#b8263c,#8f1a2d);cursor:pointer}
button:disabled{opacity:.7;cursor:default}.e{min-height:1.3em;margin:8px 0 0;color:var(--err);font-size:14px}
</style></head><body><main>${body}</main></body></html>`;
}
