import { config, isServerless } from './config.js';
// Accounts: email + password (scrypt) and Google Sign-In (ID token verified server-side).
// Sessions are HMAC-signed cookies, so they work across serverless instances.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { OAuth2Client } from 'google-auth-library';
import * as users from './userdb.js';
import { listUserTrash } from './trashdb.js';
import { computeImpact } from './impact.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'ss_session';
const MAX_AGE_S = 60 * 60 * 24 * 30;
const GOOGLE_CLIENT_ID = config.GOOGLE_CLIENT_ID || '';
const google = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

let SECRET = config.AUTH_SECRET;
if (!SECRET) {
  if (isServerless) console.warn('AUTH_SECRET is not set: sessions will reset whenever a new server instance starts.');
  SECRET = crypto.randomBytes(32).toString('hex');
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S }));
  return `${body}.${b64(crypto.createHmac('sha256', SECRET).update(body).digest())}`;
}

function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = b64(crypto.createHmac('sha256', SECRET).update(body).digest());
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() / 1000 ? p : null;
}

function readCookie(req) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
}

function setSession(req, res, session) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(sign(session))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`);
}

/** Attaches req.session = { uid, name, guest } when a valid cookie is present. */
export function sessionMiddleware(req, _res, next) {
  try { req.session = verify(readCookie(req)); } catch { req.session = null; }
  next();
}

export function requireUser(req, _res, next) {
  if (!req.session?.uid) return next(bad('Sign in to save this to your account', 401));
  next();
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function checkPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored || '').split('$');
  if (!saltHex) return false;
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

async function startSession(req, res, u) {
  await users.updateUser(u.id, { last_login: new Date().toISOString() });
  setSession(req, res, { uid: u.id, name: u.name });
  return users.publicUser(u);
}

export function mountAuth(app) {
  app.get('/api/auth/config', async (_req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null, database: (await users.health()) });
  });

  app.post('/api/auth/signup', async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name) throw bad('Enter your name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
    if (password.length < 8) throw bad('Use at least 8 characters for your password');
    if (await users.findUser({ email })) throw bad('An account with that email already exists. Sign in instead.', 409);
    const u = await users.createUser({ email, name, passwordHash: await hashPassword(password) });
    res.json({ user: await startSession(req, res, u) });
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const u = await users.findUser({ email });
    const ok = u && (u.password_hash ?? u.passwordHash) && await checkPassword(String(req.body.password || ''), u.password_hash ?? u.passwordHash);
    if (!ok) throw bad(u && !(u.password_hash ?? u.passwordHash) ? 'This account uses Google. Use “Sign in with Google”.' : 'Wrong email or password', 401);
    res.json({ user: await startSession(req, res, u) });
  });

  app.post('/api/auth/google', async (req, res) => {
    if (!google) throw bad('Google sign-in is not configured on this server', 501);
    let p;
    try {
      const ticket = await google.verifyIdToken({ idToken: String(req.body.credential || ''), audience: GOOGLE_CLIENT_ID });
      p = ticket.getPayload();
    } catch {
      throw bad('Google sign-in could not be verified', 401);
    }
    let u = await users.findUser({ googleSub: p.sub });
    if (!u && p.email && p.email_verified) {
      u = await users.findUser({ email: p.email });
      if (u) await users.updateUser(u.id, { google_sub: p.sub, picture: u.picture || p.picture });
    }
    if (!u) u = await users.createUser({ email: p.email_verified ? p.email : null, name: p.given_name || p.name || 'Rider', picture: p.picture, googleSub: p.sub });
    res.json({ user: await startSession(req, res, { ...u, picture: u.picture || p.picture }) });
  });

  // The demo login: a separate session with the simulated scooter, for showing the app without hardware.
  // Its rides are never saved to the shared map.
  app.post('/api/auth/demo', (req, res) => {
    setSession(req, res, { guest: true, demo: true, name: 'Demo', gid: `d_${crypto.randomBytes(8).toString('hex')}` });
    res.json({ user: { guest: true, demo: true, name: 'Demo' } });
  });

  app.post('/api/auth/guest', (req, res) => {
    setSession(req, res, { guest: true, name: 'Guest', gid: `g_${crypto.randomBytes(8).toString('hex')}` });
    res.json({ user: { guest: true, name: 'Guest' } });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', async (req, res) => {
    const s = req.session;
    if (!s) return res.status(401).json({ error: 'Not signed in' });
    if (s.guest) return res.json({ user: s.demo ? { guest: true, demo: true, name: 'Demo' } : { guest: true, name: 'Guest' } });
    const u = await users.findUser({ id: s.uid });
    if (!u) return res.status(401).json({ error: 'Account not found' });
    const [activity, picked] = await Promise.all([users.activitySummary(u.id), listUserTrash(u.id)]);
    res.json({ user: users.publicUser(u), activity, impact: computeImpact(activity.totals, picked) });
  });

  // ---- per-user data (Tiger) ----
  app.get('/api/me/stash', requireUser, async (req, res) => res.json(await users.getStash(req.session.uid)));
  app.put('/api/me/stash', requireUser, async (req, res) => res.json(await users.setStash(req.session.uid, Array.isArray(req.body.items) ? req.body.items : [])));
  app.get('/api/me/projects', requireUser, async (req, res) => res.json(await users.listProjects(req.session.uid)));
  app.post('/api/me/projects', requireUser, async (req, res) => res.json(await users.addProject(req.session.uid, req.body.idea || {}, req.body.origin)));
  app.put('/api/me/projects/:id/image', requireUser, async (req, res) => {
    const img = String(req.body.image || '');
    if (!/^data:image\/(jpeg|webp|png);base64,/.test(img) || img.length > 400_000) throw bad('Send a compressed image (under ~300 KB)');
    await users.setProjectImage(req.session.uid, req.params.id, img);
    res.json({ ok: true });
  });
  app.delete('/api/me/projects/:id', requireUser, async (req, res) => { await users.deleteProject(req.session.uid, req.params.id); res.json({ ok: true }); });
}
