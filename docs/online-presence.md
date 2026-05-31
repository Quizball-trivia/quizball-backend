# Online Presence ("X online" counter)

How QuizBall counts and shows the number of people currently on the site.

---

## What it is

A live **"X online"** badge that counts **everyone on the site** — logged-out
landing-page visitors *and* logged-in players. It is deliberately separate from
the in-game **"players online"** number (open game sockets), which stays small and
honest. This counter is for site-wide social proof.

## Why it works this way

We considered three sources and rejected two:

- **A WebSocket per visitor** — accurate, but holding an open connection for every
  landing-page lurker wastes server memory/connections, especially during ad spikes.
- **Vercel / PostHog** — Vercel has no live-online API (only the dashboard); PostHog
  is an analytics warehouse, too slow/stale for a live ticking number.
- **Chosen: a lightweight heartbeat ping + Redis** — no held connections, counts
  everyone, self-cleaning, and reuses the Redis we already run.

## How it works (high level)

1. **Every open tab pings every 30s** — a tiny `POST /api/v1/presence/ping`. Not a
   held-open connection; a normal request that completes instantly.
2. **The backend records the visitor in Redis** with the current timestamp.
3. **"Online now" = visitors seen in the last 60s.** Anyone who stops pinging
   (closed tab, left, lost wifi) simply ages out — no disconnect bookkeeping.
4. The ping response returns the fresh count, so the badge updates each tick.

```
browser ──POST /presence/ping (every 30s)──▶ backend ──ZADD──▶ Redis: presence:ping_z
                                              backend ──trim stale + ZCARD──▶ count
        ◀────────── { online: N } ───────────
```

## Redis design

One Redis **sorted set**, `presence:ping_z`:

- **member** = `anon:<cookieId>` — a per-browser id from a first-party
  `qb_presence_id` cookie (httpOnly, ~30 days). One browser = one count.
- **score** = last-seen epoch ms.

Operations:

- **Ping** → `ZADD presence:ping_z <now> anon:<id>` (updates the score if the member
  already exists, so repeat pings / multiple tabs count once).
- **Count** → `ZREMRANGEBYSCORE presence:ping_z 0 <now-60000>` (drop stale) then
  `ZCARD`. Self-cleaning; no `KEYS *`, no per-key TTL bookkeeping.

If Redis is unavailable the ping is a no-op and the count returns 0 — never errors.

## Identity choice: count by cookie, not by user

The site-wide counter only needs to count **distinct visitors**, not identify them.
So it keys off the anonymous cookie for everyone — it does **not** verify the auth
token on the ping path. This is intentional:

- JWKS is unset in staging/prod (tokens are HS256), so token verification falls back
  to a Supabase introspection network call. Verifying on every 30s heartbeat would
  hammer Supabase for no benefit.
- Counting by cookie keeps the heartbeat cheap (no auth, no DB, no geo) and avoids
  ever double-counting someone as both a logged-in user and an anonymous visitor.

## Multi-server behaviour

The count lives in **Redis, not in server memory**, so it is correct across any
number of backend instances behind a load balancer: pings from the same visitor can
land on different servers, but they all read/write the **one shared** sorted set.

**Requirement:** all instances must share **one logical Redis**. A primary+replica
setup (or a cluster) is fine — that is still one logical store. Do **not** run two
*independent* Redis instances each holding a separate slice, or the count splits and
each server reports a wrong partial total.

## Where it lives

| Piece | File |
|---|---|
| Redis read/write logic | `src/realtime/presence-ping.service.ts` |
| HTTP controller (cookie + response) | `src/modules/presence/presence.controller.ts` |
| Routes (`POST /ping`, `GET /online`) | `src/http/routes/presence.routes.ts` |
| OpenAPI registration | `src/modules/presence/presence.openapi.ts` |
| Frontend heartbeat + badge | see `frontend-web-next/docs/online-presence.md` |

## Endpoints

- `POST /api/v1/presence/ping` — record the caller as online, return `{ online }`.
  Public (no auth); a bare POST so it skips the CORS preflight.
- `GET /api/v1/presence/online` — current count without recording a ping.

## Tuning

- **Ping cadence (frontend): 30s** and **online window (TTL): 60s.** A visitor who
  misses one ping stays counted; missing ~two (60s) drops them. Change the TTL via
  `PRESENCE_PING_TTL_MS` in the service and the interval in the frontend hook.

## Possible future work

- Per-IP rate limit on `/presence/ping` if scripted random-id pings ever inflate the
  count (it's a soft marketing metric, not security-sensitive — deferred for now).
- A peak/high-water-mark ("max online today") if we want historical highs.
