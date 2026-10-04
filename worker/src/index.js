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
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeadersFor(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const contentLength = Number(request.headers.get('Content-Length') || '0');
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: 'Request too large' }, 413, cors);
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
