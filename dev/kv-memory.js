// In-memory stand-in for @vercel/kv used by `npm run dev` when no KV credentials are set.
// Data is lost when the dev server restarts.
const store = new Map();
const expiries = new Map();
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
function alive(key) {
  const exp = expiries.get(key);
  if (exp && Date.now() > exp) { store.delete(key); expiries.delete(key); }
  return store.has(key);
}
export const kv = {
  async get(key) { return alive(key) ? clone(store.get(key)) : null; },
  async set(key, value, opts = {}) {
    store.set(key, clone(value));
    if (opts.ex) expiries.set(key, Date.now() + opts.ex * 1000); else expiries.delete(key);
    return 'OK';
  },
  async del(key) { const had = store.delete(key); expiries.delete(key); return had ? 1 : 0; },
  async incr(key) { const next = Number(alive(key) ? store.get(key) : 0) + 1; store.set(key, next); return next; },
  async expire(key, seconds) { if (!store.has(key)) return 0; expiries.set(key, Date.now() + seconds * 1000); return 1; },
};
