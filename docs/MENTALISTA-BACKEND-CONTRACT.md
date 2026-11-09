# Mentalista — backend contract

Mentalista is a room game (`game = "mentalista"`, engine `version = 1`). A room of **3–6 admitted seats** plays **one
chooser cycle**: each admitted seat is the chooser of exactly one round, on a schedule frozen when the ready gate
closes. In a round the chooser secretly commits one legal pick from a public category; every other seat then locks one
immutable prediction of that pick; the round reveals all at once. A predictor whose prediction equals the pick scores
**+2**; the chooser always scores **0**.

The secret never reaches a non-author before the reveal: a seat's view is a function of its own choice/prediction and
the public category only, so two states differing solely in another seat's open (uncommitted-to-the-viewer) secret are
indistinguishable to that viewer — including once the match is over or cancelled.

This document describes the implemented wire, content, timing and migration contract.

## Wire protocol

### Commands — `src/modules/room/games/mentalista/mentalista.engine.ts` (`mentalistaCommandSchema`)

A discriminated union on `type`, each object `.strict()` (unknown keys rejected):

| type      | fields                                | meaning                                                      |
|-----------|---------------------------------------|-------------------------------------------------------------|
| `choose`  | `round: int`, `option: int`           | the scheduled chooser commits their legal pick (option **index**) |
| `predict` | `round: int`, `option: int`           | a predictor locks one immutable prediction (option **index**) |

- `round` ∈ `[0, 5]` (`MENTALISTA_MAX_ROUNDS - 1`). `option` ∈ `[0, 7]` (`MENTALISTA_MAX_OPTIONS - 1`).
- `round` is the zero-based round index. `option` is the zero-based index into that round's public category options, not an option id.
- `apply` validation order (first failing wins): `not_active` (over/cancelled) → `withdrawn` (seat left) →
  `stale_round` (`round ≠ state.round`) → `illegal_option` (`option ≥ category.options.length`) → `not_open`
  (`now ≥ deadline`) → role/phase:
  - `choose`: `not_chooser` → `wrong_phase` (not the choose phase) → `already_chosen`.
  - `predict`: `chooser_cannot_predict` → `wrong_phase` (not the predict phase) → `already_predicted`.
- A prediction or choice is **final**. The shared room runtime replays the recorded result when the same actor retries
  the same command ID and identical payload, including an original success. Reusing that ID with a changed payload
  returns `command_id_reused`. A new command ID does not permit revision: a second valid-phase `predict` returns
  `already_predicted`, and a second valid-phase `choose` returns `already_chosen`; earlier validation failures still
  take precedence if the phase, round or seat status changed.

### View — `MentalistaView` (returned by `view(state, content, seat, locale)`)

```
phase:        'choose' | 'predict' | 'reveal' | 'over'   // 'cancelled' is projected as 'over'
round:        number
totalRounds:  number                                     // = admitted seats
chooserSeat:  number
category:     MentalistaPublicCategory | null            // null in terminal (over/cancelled)
iAmChooser:   boolean
seats:        Array<{ seat, status, isChooser, committed, predicted, score }>  // booleans only, never values
mySeat:       number
myChoice:     number | null    // the author's own committed pick, for them alone, while open
myPrediction: number | null    // the author's own locked prediction, for them alone, in the predict phase
reveal:       MentalistaResult | null   // the just-banked round, only during 'reveal'
results:      MentalistaResult[]        // banked rounds only (each carries target + predictions)
standings:    RoomEngineStanding[] | null   // non-null only in terminal
deadline:     string | null                 // ISO-8601; null in terminal
```

`seats[].committed`/`predicted` are **public booleans** (whether, never what). `myChoice`/`myPrediction` are the only
places a secret is exposed, and only to its own author while the round is open. `reveal`/`results` carry other seats'
values **only after** the round has banked.

`MentalistaResult`: `{ round, chooser, target: number|null, voided: boolean, entries: MentalistaEntry[] }`.
`target` is `null` ⇔ `voided` (no commit landed: the chooser withdrew before committing, or the deadline passed with no
pick). `MentalistaEntry`: `{ seat, prediction: number|null, matched: boolean, points }`.

## Content & options

### Content pack — `mentalistaContentSchema`

Checked-in test fixtures use an invented universe. Runtime packs may contain reviewed real football subjects; real
content packs, answers and aliases stay in private storage and the database, never in this public repository. The
schema does not restrict display names to fictional subjects.

```
timing:     { chooseMs, predictMs, revealMs }            // re-validated, bounded (see below)
categories: MentalistaCategory[]                         // min 3, max 6; ids distinct
```

`MentalistaCategory` (`.strict()`): `{ id: string(1..64), difficulty: 'easy'|'medium'|'hard', prompt: Localized,
options: MentalistaOption[] (min 3, max 8, ids distinct) }`. `MentalistaOption`: `{ id: string(1..64), name: Localized }`.

`Localized` (`.strict()`): `es`, `en`, `ka`, `tr` **required** (string 1..200); `ru`, `pt`, `de`, `fr` optional and fall
back to `en`. Locales: `es en ka tr ru pt de fr`.

A dealt pack holds **≥ MIN_SEATS (3) and ≤ MAX_ROUNDS (6)** distinct categories, so any admitted roster of 3–6 has its
own category for every round. Deal (`MENTALISTA_PACK_WANTED = { easy: 2, medium: 2, hard: 2 }`) draws along the curve
`easy, medium, hard, easy, medium, hard`, taking the first `seats` distinct categories, and backfills from any remaining
difficulty before giving up; it returns `null` (match cannot start) if it cannot reach `seats` distinct categories.

### Options & timing — `mentalistaOptionsSchema` / `resolveTiming`

Host options are **FLAT**: `{ chooseMs?, predictMs?, revealMs? }`, `.strict()`. They are flat because the shared lobby
options transport (`lobbyRoomOptionsSchema`) carries only flat string/number/boolean primitives — a nested
`{ timing: {...} }` blob would never survive it, so `resolveTiming` rejects one. (The stored **content** keeps its own
nested `timing` block; only the host options went flat.) `resolveTiming`: `null`/`undefined` → defaults; a valid flat
blob → defaults merged with the provided clocks; **anything illegal, including a nested `{ timing }` → `undefined`**
(not this game's options). Defaults and bounds (ms):

| clock      | default | min   | max    |
|------------|---------|-------|--------|
| `chooseMs` | 20 000  | 5 000 | 60 000 |
| `predictMs`| 20 000  | 5 000 | 60 000 |
| `revealMs` |  5 000  | 2 000 | 15 000 |

All clocks are integers; out-of-bounds, non-integer, or unknown keys are rejected. `MENTALISTA_OUTAGE_MS = 5 000`: a
deadline overdue by more than this is treated as a server outage — the open phase gets a fresh window and nobody is
charged (`afterOutage`, and the outage branch of `tick`).

### Seat gates & registration

- `ROOM_GAME_MIN_SEATS.mentalista = 3` → `roomGameMinSeats('mentalista') = 3` (chooser + ≥2 predictors). No own seat
  cap → `roomGameSeats('mentalista', ceiling) = min(ceiling, 6)`.
- `lobby-modes.isValidHostStartShape` raises a `room_game` host-start minimum to the game's own via
  `Math.max(shape.min, roomGameMinSeats(roomGame))`, and caps at `roomGameSeats(roomGame, shape.max)`.
- `room.registry` registers `mentalistaRoomEngine` in both `CURRENT` and `ENGINES[...][version]`.

## Timing & terminal semantics (reference)

- Phases advance one boundary per `tick`: `choose → predict` (on commit) or **void** (withdrawn chooser / deadline with
  no commit) → `reveal` → next round or `over`. A commit that lands in the same instant as the chooser's withdrawal is
  **preserved** (the pick stands and the round scores on it).
- The predict phase waits for every non-withdrawn, non-chooser seat **including away seats**; it banks early only when
  all of them have locked, otherwise at the deadline. An away seat stays score-eligible.
- A predictor who withdraws **before** the reveal earns 0 that round (even on a match); a **banked** reveal is never
  rewritten by a later seat change.
- Terminal settlement (`settleTerminal`, fewer than two non-withdrawn seats): one survivor **in** → `over`; the lone
  survivor **away** → wait (their return → `over`; the clock running out at the final reveal re-arms, via `loneAway`);
  **none** → `cancelled`. A withdrawn future chooser is **voided on their round, never reassigned**; the schedule is
  frozen at start.
- `standings`: points desc; equal points share a place; seats that left rank below everyone who stayed.

## Migrations (one table per migration; added `NOT VALID`, validated, then swapped)

Mentalista joins the room-game check constraints (new value `'mentalista'`, check suffix `v11`, after Football Draft's
`v10`). Applied in filename order:

1. `20261109130000_mentalista_room_pool_check.sql` — `room_pool.chk_room_pool_game_v11` (ADD … NOT VALID).
2. `20261109130010_mentalista_room_matches_check.sql` — `room_matches.chk_room_matches_game_v11` (ADD … NOT VALID).
3. `20261109130020_mentalista_lobbies_check.sql` — `lobbies.lobbies_room_game_check_v11` (ADD … NOT VALID).
4. `20261109130100_mentalista_validate.sql` — `VALIDATE CONSTRAINT` for all three (SHARE UPDATE EXCLUSIVE; reads/writes continue).
5. `20261109130110_mentalista_swap_room_pool.sql` — drop the old `room_pool` check, rename `v11` into place.
6. `20261109130120_mentalista_swap_room_matches.sql` — same swap for `room_matches`.
7. `20261109130130_mentalista_swap_lobbies.sql` — same swap for `lobbies`.

## Tests in this worktree

- `tests/room/mentalista.engine.test.ts` — pure engine/rules: start/schedule, frozen cycle with voided (never
  reassigned) withdrawn chooser, command role/round/phase/option/malformed rejection, replay/immutability,
  choose/predict/reveal deadline boundaries (−1 / equal / +1), outage grace, withdrawal before/after commit, away
  eligibility and no-early-reveal, predictor leaving before/after reveal, terminal settlement (one in / one away / none)
  and lone-away final reveal, exhaustive secret non-interference for every non-author seat, terminal projections with no
  unfinished secret, scoring (+2 / chooser 0) and standings, full 3/4/5/6 cycles, and strict bounded timing/content schemas.
- `tests/room/mentalista.registration.test.ts` — `room.types` seat gates, the room-engine adapter (id/version/command
  schema, parseContent/parseOptions, deal for all admitted sizes + short-pool `null`), and read-only **source
  assertions** for the registry/lobby wiring (those modules import config that reads `.env`, so they are asserted
  against committed source rather than imported — no DB client, config load, or network).

Run (pure, no DB/Redis/network; loads only the `tests/release/network-guard.ts` setup, which traps any DB/Redis/cloud
socket):

```
npx vitest run --config vitest.mentalista.config.ts
```

- `tests/room/mentalista-db.integration.test.ts` — real-Postgres integration: gate/admission, scoring, command
  immutability/idempotency, role/phase/round/option/authz rejection, secret redaction, terminal projection, chooser-leave
  semantics (void vs preserved commit), away predictor eligibility, and stale-token inertness — all driven through
  `roomService` against the exact owned rehearsal DB. Identity-gated: refuses to run on any URL other than
  `postgresql://mentalista_local@127.0.0.1:55519/rehearsal_mentalista` and re-asserts the live connection identity
  before any destructive work. No shared DB used or needed.

Run (requires the exact owned rehearsal DB on port 55519):

```
RELEASE_TEST_DATABASE_URL=postgresql://mentalista_local@127.0.0.1:55519/rehearsal_mentalista \
  npx vitest run --config vitest.mentalista-db.config.ts
```

## Verification results (2026-11-09)

The following checks were completed for the local pilot.

| Check | Result |
|---|---|
| `tsc --noEmit` | success (0 errors) |
| Pure Mentalista tests (`vitest.mentalista.config.ts`) | 30/30 passed |
| Existing lobby / room-registry / config / client-capability regressions | 20/20 passed |
| Real `roomService` Postgres integration (`vitest.mentalista-db.config.ts`, `rehearsal_mentalista` port 55519) | 13/13 passed |
| Migrations applied and validated on isolated services | 7/7 |
| Local candidate browser checks with a private fixture | Two actual game matches completed with correct results; English, Spanish and Georgian rendering, reconnect, continuing clocks and timeout scoring checked |

No shared DB was used or needed at any stage. No staging or production deployment has been performed for this pilot.

## Outstanding gaps

1. **Full entry and navigation flows**: completed local candidate browser checks used a private fixture, excluding
   normal login, profile, lobby, minimum-seat lobby admission and return navigation, as well as staging. Long Georgian
   options and reveal content wrapped at 320px, but the fixture toolbar obscured the mobile header; the full header and
   accessibility were not verified. Broader socket/security coverage remains separate from the observed game flows.
2. **Full-schema migration failure coverage**: rollback and retry were verified with the real migration runner against
   a minimal synthetic database. That rehearsal does not cover the complete application schema or production load.
3. **Concurrent race/stress coverage**: more concurrent seat-action scenarios under load.
4. **DB-level early-termination / unfinished-secret cancellation**: covered by pure engine tests; no dedicated DB-level
   integration test yet.
5. **DB predictor withdrawal before/after reveal**: covered by pure engine tests; no dedicated DB-level integration test
   yet.
6. **Private real content / fact checking and release review**: all test fixtures use an invented universe; real content
   packs require separate review before any release.
7. **Staging deployment verification and production release review remain pending.**
