import { kv } from '@vercel/kv';

export const config = { runtime: 'edge' };

// One household per deployment: the whole workspace lives under a single KV key.
const DATA_KEY = process.env.HOMEFIN_KV_KEY || 'homefin:data';
const BACKUPS_KEY = process.env.HOMEFIN_KV_KEY ? `${process.env.HOMEFIN_KV_KEY}:time-machine` : 'homefin:time-machine';
const MAX_BACKUPS = 5;
const SESSION_PREFIX = 'homefin:session:';
const RATE_PREFIX = 'homefin:ratelimit:';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const PBKDF2_ITERATIONS = 100000;
const MIN_PASSWORD_LENGTH = 8;
const STORE_VERSION = 6;

// ---------- crypto helpers (Web Crypto, available in the edge runtime) ----------
const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}
function timingSafeEqual(a, b) {
  const x = typeof a === 'string' ? enc.encode(a) : a;
  const y = typeof b === 'string' ? enc.encode(b) : b;
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const expected = b64ToBytes(parts[3]);
  const actual = await pbkdf2(password, b64ToBytes(parts[2]), iterations);
  return timingSafeEqual(actual, expected);
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- HTTP helpers ----------
function allowedOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  const list = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}
function corsHeaders(req) {
  // Same-origin requests need no CORS headers. Cross-origin access is opt-in via ALLOWED_ORIGINS.
  const origin = allowedOrigin(req);
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Homefin-Setup-Token',
    'Vary': 'Origin',
  };
}
function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(req) },
  });
}
function decodeBasic(header) {
  const m = String(header || '').match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  try {
    const raw = dec.decode(b64ToBytes(m[1].trim()));
    const idx = raw.indexOf(':');
    if (idx < 0) return null;
    return { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}
function bearerToken(req) {
  const m = String(req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
function clientIp(req) {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

// ---------- data helpers ----------
function normalizeUserId(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'user';
}
function usersOf(data) {
  return data?.users && typeof data.users === 'object' ? data.users : {};
}
function hasRealUsers(data) {
  return Object.values(usersOf(data)).some((u) => u && u.passwordHash);
}
function ensureAdmin(users) {
  const next = { ...users };
  const ids = Object.keys(next);
  if (ids.length && !ids.some((id) => next[id]?.role === 'admin')) next[ids[0]] = { ...next[ids[0]], role: 'admin' };
  ids.forEach((id) => { if (next[id]?.role !== 'admin' && next[id]?.role !== 'user') next[id] = { ...next[id], role: 'user' }; });
  return next;
}
function publicUser(user) {
  if (!user) return user;
  const { passwordHash, password, newPassword, ...rest } = user;
  return rest;
}
function sanitizeForClient(data) {
  if (!data) return data;
  const users = {};
  Object.entries(usersOf(data)).forEach(([id, u]) => { users[id] = publicUser(u); });
  return { ...data, users };
}
function sanitizeHousehold(input) {
  const members = (Array.isArray(input?.members) ? input.members : [])
    .map((m) => ({
      id: normalizeUserId(m?.id || m?.name),
      name: String(m?.name || '').trim().slice(0, 60),
      keywords: (Array.isArray(m?.keywords) ? m.keywords : String(m?.keywords || '').split(','))
        .map((k) => String(k || '').trim().slice(0, 60)).filter(Boolean).slice(0, 20),
    }))
    .filter((m) => m.name)
    .filter((m, idx, arr) => arr.findIndex((x) => x.id === m.id) === idx)
    .slice(0, 12);
  const splitMode = input?.splitMode === 'custom' ? 'custom' : 'equal';
  const sharedSplit = {};
  members.forEach((m) => {
    const pct = Number(input?.sharedSplit?.[m.id]);
    sharedSplit[m.id] = Number.isFinite(pct) && pct >= 0 ? pct : 0;
  });
  return { members, splitMode, sharedSplit };
}

async function findSession(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const key = SESSION_PREFIX + await sha256Hex(token);
  const session = await kv.get(key);
  return session?.userId ? { ...session, key } : null;
}
async function createSession(userId) {
  const token = randomToken();
  await kv.set(SESSION_PREFIX + await sha256Hex(token), { userId, createdAt: new Date().toISOString() }, { ex: SESSION_TTL_SECONDS });
  return token;
}
async function authenticate(req) {
  const session = await findSession(req);
  if (!session) return { error: json(req, { error: 'Unauthorized' }, 401) };
  const data = await kv.get(DATA_KEY);
  const user = usersOf(data)[session.userId];
  if (!user || !user.passwordHash) {
    await kv.del(session.key);
    return { error: json(req, { error: 'Unauthorized' }, 401) };
  }
  return { data, user: { ...user, id: session.userId }, session };
}

// Users are security-sensitive: password hashes never leave the server and
// only admins may create/delete users, change roles or set other users' passwords.
async function mergeUsers(currentUsers, incomingUsers, actor) {
  const isAdmin = actor.role === 'admin';
  const next = {};
  const incoming = incomingUsers && typeof incomingUsers === 'object' ? incomingUsers : null;
  if (!incoming) return { users: currentUsers };
  const ids = isAdmin ? Object.keys(incoming) : Object.keys(currentUsers);
  for (const rawId of ids) {
    const id = normalizeUserId(rawId);
    const cur = currentUsers[id];
    const inc = incoming[rawId] || incoming[id];
    if (!isAdmin && id !== actor.id) { next[id] = cur; continue; }
    if (!inc) { if (!isAdmin && cur) next[id] = cur; continue; }
    const { passwordHash, password, newPassword, role, id: _ignoredId, ...profile } = inc;
    const merged = { ...(cur || {}), ...profile, id };
    merged.role = isAdmin ? (role === 'admin' ? 'admin' : 'user') : (cur?.role || 'user');
    const requested = newPassword || password;
    if (requested) {
      if (String(requested).length < MIN_PASSWORD_LENGTH) return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
      merged.passwordHash = await hashPassword(requested);
      merged.passwordUpdatedAt = new Date().toISOString();
    } else if (cur?.passwordHash) {
      merged.passwordHash = cur.passwordHash;
    }
    if (!merged.passwordHash) return { error: `User "${merged.name || id}" needs a password` };
    if (!merged.createdAt) merged.createdAt = new Date().toISOString();
    next[id] = merged;
  }
  // An admin may not remove their own account (prevents locking the workspace).
  if (!next[actor.id]) next[actor.id] = currentUsers[actor.id];
  return { users: ensureAdmin(next) };
}

// ---------- handlers ----------
async function handleStatus(req) {
  const data = await kv.get(DATA_KEY);
  return json(req, { needsSetup: !hasRealUsers(data), setupTokenConfigured: !!process.env.APP_PASSWORD });
}

async function handleBootstrap(req) {
  const setupToken = process.env.APP_PASSWORD;
  if (!setupToken) return json(req, { error: 'APP_PASSWORD is not configured on the server' }, 503);
  if (!timingSafeEqual(String(req.headers.get('x-homefin-setup-token') || ''), setupToken)) {
    return json(req, { error: 'Invalid setup token' }, 401);
  }
  const current = await kv.get(DATA_KEY);
  if (hasRealUsers(current)) return json(req, { error: 'Setup already completed' }, 409);
  const body = await req.json().catch(() => null);
  const admin = body?.admin || {};
  const name = String(admin.name || '').trim();
  if (!name || !admin.password) return json(req, { error: 'Missing admin name or password' }, 400);
  if (String(admin.password).length < MIN_PASSWORD_LENGTH) return json(req, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
  const household = sanitizeHousehold(body?.household);
  if (!household.members.length) return json(req, { error: 'Add at least one household member' }, 400);
  const shaped = body?.data && typeof body.data === 'object' ? body.data : {};
  const id = normalizeUserId(name);
  const now = new Date().toISOString();
  const data = {
    ...shaped,
    transactions: Array.isArray(shaped.transactions) ? shaped.transactions : [],
    version: Math.max(Number(shaped.version || 0), STORE_VERSION),
    household,
    users: {
      [id]: {
        id,
        name,
        email: String(admin.email || '').trim(),
        passwordHash: await hashPassword(admin.password),
        role: 'admin',
        language: admin.language === 'it' ? 'it' : 'en',
        createdAt: now,
      },
    },
    meta: { ...(shaped.meta || {}), setupCompletedAt: now },
  };
  await kv.set(DATA_KEY, data);
  const token = await createSession(id);
  return json(req, { ok: true, token, userId: id, data: sanitizeForClient(data) });
}

async function handleLogin(req) {
  const ipKey = RATE_PREFIX + await sha256Hex(clientIp(req));
  const failures = Number(await kv.get(ipKey) || 0);
  if (failures >= LOGIN_MAX_FAILURES) return json(req, { error: 'Too many failed attempts, try again later' }, 429);
  const creds = decodeBasic(req.headers.get('authorization'));
  const data = await kv.get(DATA_KEY);
  const users = usersOf(data);
  const wanted = normalizeUserId(creds?.username || '');
  const userId = Object.keys(users).find((id) => id === wanted || normalizeUserId(users[id]?.name) === wanted);
  const ok = !!(creds && userId && await verifyPassword(creds.password, users[userId]?.passwordHash));
  if (!ok) {
    await kv.incr(ipKey);
    await kv.expire(ipKey, LOGIN_WINDOW_SECONDS);
    return json(req, { error: 'Invalid user or password' }, 401);
  }
  await kv.del(ipKey);
  const token = await createSession(userId);
  return json(req, { ok: true, token, userId, data: sanitizeForClient(data) });
}

async function handleRecover(req) {
  // Emergency password reset for the deployment owner, gated by APP_PASSWORD.
  const setupToken = process.env.APP_PASSWORD;
  if (!setupToken || !timingSafeEqual(String(req.headers.get('x-homefin-setup-token') || ''), setupToken)) {
    return json(req, { error: 'Invalid setup token' }, 401);
  }
  const body = await req.json().catch(() => null);
  const data = await kv.get(DATA_KEY);
  const users = usersOf(data);
  const id = normalizeUserId(body?.username || '');
  if (!users[id]) return json(req, { error: 'Unknown user' }, 404);
  if (String(body?.newPassword || '').length < MIN_PASSWORD_LENGTH) return json(req, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
  users[id] = { ...users[id], passwordHash: await hashPassword(body.newPassword), passwordUpdatedAt: new Date().toISOString() };
  await kv.set(DATA_KEY, { ...data, users });
  return json(req, { ok: true });
}

async function handleGet(req) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  return json(req, { data: sanitizeForClient(auth.data), userId: auth.user.id });
}

async function handleReplace(req) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  if (auth.user.role !== 'admin') return json(req, { error: 'Only admins can restore a full backup' }, 403);
  const body = await req.json().catch(() => null);
  if (!body?.data || !Array.isArray(body.data.transactions)) return json(req, { error: 'Invalid full backup payload' }, 400);
  // Restoring data never restores credentials: current users are kept as-is.
  const replacement = {
    ...body.data,
    users: usersOf(auth.data),
    household: body.data.household ? sanitizeHousehold(body.data.household) : auth.data?.household,
    meta: { ...(body.data.meta || {}), lastFullRestoreAt: new Date().toISOString() },
  };
  await kv.set(DATA_KEY, replacement);
  return json(req, { ok: true, data: sanitizeForClient(replacement) });
}

async function handleSet(req) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  const current = auth.data || {};
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') {
    return json(req, { error: 'Missing data payload' }, 400);
  }
  const incoming = body.data;
  const merged = { ...current, ...incoming };
  const userResult = Object.prototype.hasOwnProperty.call(incoming, 'users')
    ? await mergeUsers(usersOf(current), incoming.users, auth.user)
    : { users: usersOf(current) };
  if (userResult.error) return json(req, { error: userResult.error }, 400);
  merged.users = userResult.users;
  if (Object.prototype.hasOwnProperty.call(incoming, 'household')) {
    merged.household = auth.user.role === 'admin' ? sanitizeHousehold(incoming.household) : current.household;
  }
  for (const key of ['categoryCustomizations', 'customCategories', 'categoryOverrides']) {
    if (current[key] || incoming[key]) merged[key] = { ...(current[key] || {}), ...(incoming[key] || {}) };
  }
  for (const key of ['rules', 'overrideHistory']) {
    if (current[key] && !incoming[key]) merged[key] = current[key];
  }
  if (merged?.meta?.deletedUserIds) {
    const activeIds = new Set(Object.keys(merged.users || {}));
    merged.meta = { ...merged.meta, deletedUserIds: merged.meta.deletedUserIds.filter((id) => !activeIds.has(id)) };
  }
  await kv.set(DATA_KEY, merged);
  return json(req, { ok: true, users: sanitizeForClient(merged).users });
}

// Profile edits by the user themself (or an admin). Role changes go through `set`, admin-only.
async function handleProfile(req) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  const body = await req.json().catch(() => null);
  const profile = body?.profile && typeof body.profile === 'object' ? body.profile : null;
  const users = usersOf(auth.data);
  const id = normalizeUserId(profile?.id || '');
  if (!id || !users[id]) return json(req, { error: 'Invalid profile' }, 400);
  if (auth.user.id !== id && auth.user.role !== 'admin') return json(req, { error: 'Forbidden' }, 403);
  const { passwordHash, password, newPassword, role, id: _ignoredId, ...fields } = profile;
  const next = { ...users[id], ...fields, id };
  if (typeof body?.password === 'string' && body.password.length) {
    if (body.password.length < MIN_PASSWORD_LENGTH) return json(req, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
    next.passwordHash = await hashPassword(body.password);
    next.passwordUpdatedAt = new Date().toISOString();
  }
  const saved = { ...auth.data, users: { ...users, [id]: next } };
  await kv.set(DATA_KEY, saved);
  return json(req, { ok: true, data: sanitizeForClient(saved), userId: auth.user.id });
}

// ---------- Time Machine: up to MAX_BACKUPS full snapshots kept in KV ----------
function summarizeSnapshot(snapshot = {}) {
  return {
    transactions: Array.isArray(snapshot.transactions) ? snapshot.transactions.length : 0,
    rules: Array.isArray(snapshot.rules) ? snapshot.rules.length : 0,
    customCategories: snapshot.customCategories && typeof snapshot.customCategories === 'object' ? Object.keys(snapshot.customCategories).length : 0,
    formats: snapshot.customImportFormats && typeof snapshot.customImportFormats === 'object' ? Object.keys(snapshot.customImportFormats).length : 0,
  };
}
function backupMeta(backup = {}) {
  const { snapshot, ...meta } = backup;
  return { ...meta, summary: meta.summary || summarizeSnapshot(snapshot || {}) };
}
async function getBackups() {
  const backups = await kv.get(BACKUPS_KEY);
  return Array.isArray(backups) ? backups : [];
}
// Snapshots never contain credentials; restoring keeps the current users.
function snapshotWithoutUsers(data) {
  const { users, ...rest } = data || {};
  return rest;
}
async function handleTimeMachine(req, action, url) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  if (action === 'time-machine-list') {
    return json(req, { ok: true, backups: (await getBackups()).map(backupMeta) });
  }
  if (action === 'time-machine-download') {
    const backup = (await getBackups()).find((item) => item?.id === url.searchParams.get('id'));
    if (!backup?.snapshot) return json(req, { error: 'Backup not found' }, 404);
    return json(req, { ok: true, backup: backupMeta(backup), data: backup.snapshot });
  }
  if (action === 'time-machine-create') {
    const body = await req.json().catch(() => ({}));
    const createdAt = new Date().toISOString();
    const snapshot = { ...snapshotWithoutUsers(auth.data), meta: { ...(auth.data?.meta || {}), timeMachineSnapshotCreatedAt: createdAt } };
    const backup = {
      id: `tm-${Date.now()}-${randomToken().slice(0, 6)}`,
      name: String(body?.name || '').trim().slice(0, 80) || `Backup ${createdAt.slice(0, 16).replace('T', ' ')}`,
      createdAt,
      createdBy: auth.user.id,
      summary: summarizeSnapshot(snapshot),
      snapshot,
    };
    const backups = [backup, ...(await getBackups())].slice(0, MAX_BACKUPS);
    await kv.set(BACKUPS_KEY, backups);
    return json(req, { ok: true, backups: backups.map(backupMeta) });
  }
  if (auth.user.role !== 'admin') return json(req, { error: 'Only admins can delete or restore backups' }, 403);
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || '');
  if (action === 'time-machine-delete') {
    const backups = (await getBackups()).filter((item) => item?.id !== id);
    await kv.set(BACKUPS_KEY, backups);
    return json(req, { ok: true, backups: backups.map(backupMeta) });
  }
  if (action === 'time-machine-restore') {
    const backup = (await getBackups()).find((item) => item?.id === id);
    if (!backup?.snapshot || !Array.isArray(backup.snapshot.transactions)) return json(req, { error: 'Backup not found' }, 404);
    const restored = {
      ...backup.snapshot,
      users: usersOf(auth.data),
      meta: { ...(backup.snapshot.meta || {}), restoredFromTimeMachineId: id, restoredFromTimeMachineAt: new Date().toISOString() },
    };
    await kv.set(DATA_KEY, restored);
    return json(req, { ok: true, data: sanitizeForClient(restored) });
  }
  return json(req, { error: 'Unknown action' }, 400);
}

async function handleLogout(req) {
  const session = await findSession(req);
  if (session) await kv.del(session.key);
  return json(req, { ok: true });
}

export default async function handler(req) {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || (req.method === 'GET' ? 'get' : 'set');

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });

  try {
    if (req.method === 'GET' && action === 'status') return await handleStatus(req);
    if (req.method === 'GET' && action === 'get') return await handleGet(req);
    if (action.startsWith('time-machine-') && (req.method === 'GET' ? ['time-machine-list', 'time-machine-download'].includes(action) : true)) return await handleTimeMachine(req, action, url);
    if (req.method === 'POST') {
      if (action === 'bootstrap') return await handleBootstrap(req);
      if (action === 'login') return await handleLogin(req);
      if (action === 'logout') return await handleLogout(req);
      if (action === 'recover') return await handleRecover(req);
      if (action === 'replace') return await handleReplace(req);
      if (action === 'profile') return await handleProfile(req);
      if (action === 'set') return await handleSet(req);
    }
    return json(req, { error: 'Method not allowed' }, 405);
  } catch (e) {
    console.error(e);
    return json(req, { error: 'Server error' }, 500);
  }
}
