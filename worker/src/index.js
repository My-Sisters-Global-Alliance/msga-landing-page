// #CheckInSis check-in counter — Cloudflare Worker + SQLite-backed Durable Object.
//
// Stores exactly one thing: a single integer total. No IPs, no cookies, no
// request bodies, no per-visitor identifiers are ever written to storage.
//
// Routes (same-origin, mounted at mysistersglobal.org/api/* — see wrangler.toml):
//   GET  /api/checkin-count  -> { total }
//   POST /api/checkin        -> { total }  (adds 1)

const ALLOWED_EXACT_ORIGIN = 'https://mysistersglobal.org';
const ALLOWED_LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1(:\d+)?$/;

// Only relevant if this Worker ends up deployed to a workers.dev address
// instead of a route on our own zone (see wrangler.toml). For a same-origin
// route these headers are harmless no-ops — browsers ignore CORS headers on
// same-origin requests — so one code path covers both deployment options.
function corsHeadersFor(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = origin === ALLOWED_EXACT_ORIGIN || ALLOWED_LOCAL_ORIGIN.test(origin);
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

const MAX_BODY_BYTES = 1024; // generous ceiling — these endpoints expect no body at all

// Honor Wall: reads public supporter-feed posts from the Givebutter
// "MySGA #CheckInSis Honor Wall" campaign. The API key lives only in the
// Worker secret GIVEBUTTER_API_KEY, never in page code. Results are
// cached for 5 minutes so the page doesn't hit Givebutter on every visit.
const HONOR_WALL_CAMPAIGN_ID = 760449;
const HONOR_WALL_CACHE_SECONDS = 300;
const HONOR_WALL_MAX_PAGES = 5;

// Finds a photo uploaded through the ticket's "Photo of the sister you're
// honoring" question. Looks only in custom-field answers and line items,
// and accepts an image URL or any URL inside a file-type field.
function findHonorPhoto(t, photoMap) {
  if (photoMap) return photoMap[String(t.id)] || photoMap[String(t.number)] || null;
  const IMG = /^https?:\/\/[^\s"']+\.(jpe?g|png|webp|gif|svg)(\?[^\s"']*)?$/i;
  const seen = new Set();
  let found = null;
  const walk = (o, fileCtx) => {
    if (found || o == null) return;
    if (typeof o === 'string') {
      if (IMG.test(o) || (fileCtx && /^https?:\/\//.test(o))) found = o;
      return;
    }
    if (typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    const isFile = fileCtx || o.type === 'file' || o.field_type === 'file';
    for (const k in o) walk(o[k], isFile);
  };
  walk(t.custom_fields, false);
  walk(t.line_items, false);
  return found;
}

// Ticket-level answers (like the "Photo of the sister you're honoring"
// upload) live on Givebutter's tickets, not on transactions. Build a map of
// transaction id -> uploaded photo URL.
async function fetchTicketPhotos(env) {
  const map = {};
  let next = 'https://api.givebutter.com/v1/tickets';
  for (let page = 0; next && page < HONOR_WALL_MAX_PAGES; page++) {
    const res = await fetch(next, {
      headers: { Authorization: 'Bearer ' + env.GIVEBUTTER_API_KEY, Accept: 'application/json' },
    });
    if (!res.ok) break;
    const body = await res.json();
    for (const tk of body.data || []) {
      const f = (tk.custom_fields || []).find(
        (c) => c && c.type === 'file' && typeof c.value === 'string' && /^https?:\/\//.test(c.value)
      );
      if (f && tk.transaction_id != null && !map[String(tk.transaction_id)]) {
        map[String(tk.transaction_id)] = f.value;
      }
    }
    next = body.links && body.links.next;
  }
  return map;
}

async function fetchHonorWall(env) {
  if (!env.GIVEBUTTER_API_KEY) throw new Error('GIVEBUTTER_API_KEY not set');
  const entries = [];
  const photoMap = await fetchTicketPhotos(env);
  let next = 'https://api.givebutter.com/v1/transactions';
  for (let page = 0; next && page < HONOR_WALL_MAX_PAGES; page++) {
    const res = await fetch(next, {
      headers: { Authorization: 'Bearer ' + env.GIVEBUTTER_API_KEY, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('Givebutter returned ' + res.status);
    const body = await res.json();
    for (const t of body.data || []) {
      if (Number(t.campaign_id) !== HONOR_WALL_CAMPAIGN_ID) continue;
      if (t.status && t.status !== 'succeeded') continue;
      const post = t.giving_space;
      if (!post) continue; // hidden posts aren't in the public feed, so keep them off the wall too
      // Moderation: type "hide" in the transaction's Internal note in Givebutter
      // to keep an entry off the website (Givebutter's own Hide button isn't
      // visible through its API).
      if (/\bhide\b/i.test(t.internal_note || '')) continue;
      entries.push({
        from: (post.name || '').trim() || 'A Sister',
        honoree: ((t.dedication && t.dedication.name) || '').trim() || null,
        message: (post.message || '').trim() || null,
        date: t.created_at || null,
        _src: findHonorPhoto(t, photoMap), // internal only, stripped before responding
        key: String(t.id),
      });
    }
    next = body.links && body.links.next;
  }
  return entries;
}

// Short in-memory rate limit. This Map lives only in this Worker isolate's
// live memory for as long as it stays warm (typically minutes) — it is
// never written to Durable Object storage, never logged, and is wiped on
// every cold start/redeploy. It exists purely to blunt a script mashing the
// endpoint faster than a human would click a button; it is not retained
// data about anyone and this file is the only place the IP is ever touched.
const lastSeenByIP = new Map();
const RATE_LIMIT_WINDOW_MS = 2000;
const RATE_LIMIT_MAX_ENTRIES = 5000; // bound memory even under a flood

function isRateLimited(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const last = lastSeenByIP.get(ip);
  if (last && now - last < RATE_LIMIT_WINDOW_MS) return true;
  if (lastSeenByIP.size >= RATE_LIMIT_MAX_ENTRIES) lastSeenByIP.clear();
  lastSeenByIP.set(ip, now);
  return false;
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeadersFor(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/api/honor-wall' && request.method === 'GET') {
      const cache = caches.default;
      const cacheKey = new Request('https://mysistersglobal.org/api/honor-wall');
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      try {
        const entries = (await fetchHonorWall(env)).map(({ _src, ...e }) => ({
          ...e,
          photo: _src ? '/api/honor-photo/' + encodeURIComponent(e.key) : null,
        }));
        const res = json({ entries }, 200, {
          ...cors,
          'Cache-Control': 'public, max-age=' + HONOR_WALL_CACHE_SECONDS,
        });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch (e) {
        return json({ entries: [], error: 'Honor wall unavailable' }, 502, cors);
      }
    }

    const contentLength = Number(request.headers.get('Content-Length') || '0');
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: 'Request too large' }, 413, cors);
    }

    // Serves an honor wall photo through our own domain. Only photos attached
    // to a current honor wall entry can be fetched; SVG is refused.
    if (url.pathname.startsWith('/api/honor-photo/') && request.method === 'GET') {
      const pcache = caches.default;
      const pkey = new Request('https://mysistersglobal.org' + url.pathname);
      const phit = await pcache.match(pkey);
      if (phit) return phit;
      try {
        const key = decodeURIComponent(url.pathname.slice('/api/honor-photo/'.length));
        const list = await fetchHonorWall(env);
        const hit = list.find((x) => x.key === key && x._src);
        if (!hit) return json({ error: 'Not found' }, 404, cors);
        const img = await fetch(hit._src);
        if (!img.ok) return json({ error: 'Photo unavailable' }, 502, cors);
        const ct = (img.headers.get('Content-Type') || '').toLowerCase();
        const ext = ((hit._src.split('?')[0].match(/\.(jpe?g|png|gif|webp)$/i) || [])[1] || '').toLowerCase();
        const type = /^image\/(jpeg|png|gif|webp)$/.test(ct) ? ct : ext ? 'image/' + (ext === 'jpg' ? 'jpeg' : ext) : null;
        if (!type) return json({ error: 'Not a supported image' }, 415, cors);
        const pres = new Response(img.body, {
          headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
        });
        await pcache.put(pkey, pres.clone());
        return pres;
      } catch (err) {
        return json({ error: 'Photo unavailable' }, 502, cors);
      }
    }

    const id = env.CHECKIN_COUNTER.idFromName('global');
    const stub = env.CHECKIN_COUNTER.get(id);

    if (url.pathname === '/api/checkin-count' && request.method === 'GET') {
      const res = await stub.fetch('https://do/count');
      const data = await res.json();
      return json(data, 200, cors);
    }

    if (url.pathname === '/api/checkin' && request.method === 'POST') {
      if (isRateLimited(request)) {
        return json({ error: 'Too many requests, please slow down' }, 429, cors);
      }
      const res = await stub.fetch('https://do/increment', { method: 'POST' });
      const data = await res.json();
      return json(data, 200, cors);
    }

    if (url.pathname === '/api/checkin-count' || url.pathname === '/api/checkin') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    return json({ error: 'Not found' }, 404, cors);
  },
};

export class CheckinCounter {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        'CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 0), total INTEGER NOT NULL)'
      );
      this.sql.exec('INSERT OR IGNORE INTO counter (id, total) VALUES (0, 0)');
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/count') {
      const row = this.sql.exec('SELECT total FROM counter WHERE id = 0').one();
      return new Response(JSON.stringify({ total: row.total }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/increment' && request.method === 'POST') {
      this.sql.exec('UPDATE counter SET total = total + 1 WHERE id = 0');
      const row = this.sql.exec('SELECT total FROM counter WHERE id = 0').one();
      return new Response(JSON.stringify({ total: row.total }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }
}
