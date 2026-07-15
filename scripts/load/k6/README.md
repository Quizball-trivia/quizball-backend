# k6 HTTP and Auth load suite

This suite complements `scripts/chaos/`: k6 drives open-loop HTTP/Auth pressure,
while the TypeScript socket fleet remains the source of truth for Socket.IO
matchmaking, draft, gameplay, reconnects, and match completion.

## Safety

- Production is hard-blocked in the script.
- `TARGET=staging` only accepts `https://api-staging.quizball.io`.
- `TARGET=local` only accepts a loopback URL.
- Signup load is additionally blocked unless a dedicated performance Auth
  project uses an email sink. Never point it at real SMTP delivery.
- No service-role or Supabase secret is used by k6. Test credentials and the
  optional staging rate-limit bypass come from environment variables.
- A refresh VU owns one user and always replaces its rotated refresh token.

## Modes

| `MODE` | workload |
|---|---|
| `smoke` | login → `/users/me` → wallet → refresh → `/users/me` |
| `signup` | unique email registrations; dedicated Auth/email-sink project only |
| `login` | open-loop email/password login arrivals |
| `refresh` | fixed concurrent users rotating unique refresh tokens |
| `wallet` | open-loop concurrent wallet reads |
| `api` | weighted mix of 20 safe public/authenticated API reads |
| `auth-mix` | login arrivals, refresh VUs, wallet pressure, and weighted APIs together |

The arrival-rate modes keep starting iterations independently of response time,
so a slowing server cannot make the generator silently reduce offered load.

## Test users

The suite expects the same pre-confirmed, reusable users as the chaos harness:

```text
chaos+u0@quizball.io
chaos+u1@quizball.io
...
```

Defaults are `TEST_PASSWORD=ChaosTest12345!`, `EMAIL_PREFIX=chaos`, and
`EMAIL_DOMAIN=quizball.io` on staging. Pre-provision enough unique users before
large `refresh`, `wallet`, `smoke`, or combined runs.

```bash
# Idempotent: existing accounts are reused. This creates users but does not
# include provisioning in the measured load test.
npm run load:users -- --target=staging --count=5000 --concurrency=10
```

## Examples

```bash
# Validate the script without generating traffic
npm run load:k6:inspect

# Two-user staging journey. Does not bypass the normal rate limiter.
npm run load:k6:smoke

# 25 → 100 login arrivals/sec, then hold 100/sec for five minutes
TARGET=staging MODE=login USERS=500 RATE=100 START_RATE=25 \
  RAMP_DURATION=2m DURATION=5m MAX_VUS=600 \
  k6 run --summary-export scripts/load/k6/reports/login-100.json \
  scripts/load/k6/auth-api.k6.js

# 500 concurrent refresh sessions. Run from distributed IPs when testing the
# real-world service capacity; Supabase limits refresh requests per source IP.
TARGET=staging MODE=refresh USERS=500 VUS=500 DURATION=10m \
  REFRESH_PAUSE_SECONDS=60 \
  k6 run --summary-export scripts/load/k6/reports/refresh-500.json \
  scripts/load/k6/auth-api.k6.js

# Weighted API + login + refresh + wallet pressure. Use CHAOS_BYPASS_TOKEN only
# when measuring backend capacity behind the deliberate application limiter.
TARGET=staging MODE=auth-mix USERS=500 VUS=100 RATE=250 MAX_VUS=800 \
  PREALLOCATED_VUS=500 \
  LOGIN_RATE=50 WALLET_RATE=75 RAMP_DURATION=2m DURATION=10m \
  CHAOS_BYPASS_TOKEN="$CHAOS_BYPASS_TOKEN" \
  k6 run --summary-export scripts/load/k6/reports/auth-mix-500.json \
  scripts/load/k6/auth-api.k6.js
```

For manual distributed workers, give each runner a disjoint user range with
`SHARD_START`. For example, five workers can use starts `0`, `1000`, `2000`,
`3000`, and `4000` with `USERS=1000` each. Do not reuse a refresh token across
workers.

## Capacity procedure

1. Validate `smoke` with two users.
2. Run clean HTTP modes at 50, 100, 250, 500, and increasing requests/sec.
3. Run concurrent refresh/wallet modes at 100, 250, 500, 1000, 2000, and 5000
   users using distributed workers.
4. Run `auth-mix` alongside the Socket.IO gameplay fleet.
5. Stop at the first SLO failure, fix it, rerun that rung, then continue.
6. Run a 60-minute soak at the highest passing rung.

The script fails when unexpected responses reach 1%, checks fall below 99%,
application p95 exceeds 1.5 seconds, application p99 exceeds 3 seconds, or k6
drops iterations. Correlate each result with Railway replica telemetry,
Supabase connections/queries, and Redis metrics from the chaos report.

Reports include explicit counters for all `429` responses and separate login,
refresh, and signup rate-limit counts. This prevents a managed Auth quota from
being mistaken for an application or database crash.

The backend now tags proxied Supabase Auth limits as
`details.source=supabase_auth`; k6 splits those from application-limiter and
unknown 429s. A large Auth run is invalid if those sources are conflated.
