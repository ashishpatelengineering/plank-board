/* One shared team password. Typing it once sets a signed cookie (an HMAC of the expiry time, keyed from the password),
   so changing the password signs everybody out. Nothing a browser sends in a plain header counts as proof. */
const enc = new TextEncoder();
const DAYS = 30;
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '='.repeat((4 - t.length % 4) % 4)), c => c.charCodeAt(0)); };

export const MIN_PASSWORD = 12;
export const configured = env => env.DEV_MODE === '1' || (typeof env.TEAM_PASSWORD === 'string' && env.TEAM_PASSWORD.length >= MIN_PASSWORD);

const hmacKey = async env => crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode('plank-session:' + env.TEAM_PASSWORD)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function checkPassword(env, given) {
  if (typeof given !== 'string' || given.length > 200 || typeof env.TEAM_PASSWORD !== 'string' || env.TEAM_PASSWORD.length < MIN_PASSWORD) return false;
  const [a, b] = await Promise.all([given, env.TEAM_PASSWORD].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b); let diff = 0;
  for (let i = 0; i < 32; i++) diff |= x[i] ^ y[i];                      // always compares all 32 bytes
  return diff === 0;
}
export async function makeSession(env) {
  const exp = String(Date.now() + DAYS * 864e5);
  return exp + '.' + b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode('v1.' + exp)));
}
export async function hasSession(req, env) {
  if (env.DEV_MODE === '1') return true;                                 // local development only; never set in production
  if (!configured(env)) return false;
  const m = /(?:^|;\s*)plank_session=([0-9]+)\.([A-Za-z0-9_-]+)/.exec(req.headers.get('cookie') || '');
  if (!m || !(+m[1] > Date.now())) return false;
  try { return await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(m[2]), enc.encode('v1.' + m[1])); } catch (e) { return false; }
}
export const sessionCookie = value => `plank_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`;
export const clearCookie = () => 'plank_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
