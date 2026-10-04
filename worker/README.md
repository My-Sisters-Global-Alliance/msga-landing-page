# #CheckInSis check-in counter — Cloudflare Worker

Not deployed yet. This folder is excluded from the Jekyll build (see
`_config.yml`) — it's a separate thing that gets deployed to Cloudflare on
its own, not published as part of the website.

## What it stores

One integer. That's it — no IPs, no cookies, no names, no request bodies.
A short-lived in-memory map is used for rate limiting (see comments in
`src/index.js`) but it's never written to durable storage and evaporates
on every cold start.

## Endpoints

- `GET /api/checkin-count` → `{ "total": 247 }`
- `POST /api/checkin` → increments by 1, returns the new `{ "total": 248 }`

## Local dev

```
cd worker
npx wrangler dev
```

## Deploy

```
cd worker
npx wrangler deploy
```

Before deploying, open `wrangler.toml` and make sure exactly one of the two
route options (own-zone route vs. workers.dev) is uncommented — see the
comments there. If using workers.dev, update `CI_API_BASE` in
`checkinsis.html` to match the printed URL.
