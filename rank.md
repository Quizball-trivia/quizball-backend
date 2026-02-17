# Ranked System

## Tiers & RP Thresholds

| Tier           | RP Range      | Emoji |
|----------------|---------------|-------|
| Academy        | 0 – 299       | 🏫    |
| Youth Prospect | 300 – 599     | 🌱    |
| Reserve        | 600 – 899     | 📋    |
| Bench          | 900 – 1,199   | 🪑    |
| Rotation       | 1,200 – 1,499 | 🔄    |
| Starting11     | 1,500 – 1,849 | ⚽    |
| Key Player     | 1,850 – 2,199 | ⭐    |
| Captain        | 2,200 – 2,599 | ©️    |
| World-Class    | 2,600 – 2,899 | 💎    |
| Legend         | 2,900 – 3,199 | 👑    |
| GOAT           | 3,200+        | 🐐    |

New profiles are seeded at **1200 RP (Rotation)** but this is a placeholder — the real RP is determined after placement.

---

## Placement (3 matches vs AI)

Every new player must complete 3 placement matches before entering regular ranked.
Placement matches are always against an AI opponent whose difficulty adapts based on results.

### Adaptive AI Anchor

The AI's "RP level" (anchor) determines its difficulty and feeds into the perf score formula.

| Match | Anchor Formula                                          |
|-------|---------------------------------------------------------|
| 1     | 1900 (default)                                          |
| 2+    | `1900 + (wins × 400) - (losses × 500)`, clamped 150–2700 |

Examples:
- Win game 1 → anchor 2 = 1900 + 400 = 2300
- Lose game 1 → anchor 2 = 1900 - 500 = 1400
- Lose both → anchor 3 = 1900 - 1000 = 900

### AI Difficulty Scaling

The anchor also controls the AI's correctness rate and answer speed:

- **Correctness**: `0.52 + (anchorRp / 9000)` → 52% at anchor 150, ~73% at 1900, 82% at 2700
- **Answer delay**: faster at higher anchors (min 350–1000ms, max 2500–5200ms range)

### Per-Match Performance Score

Each placement match produces a **perf score** that measures where the player belongs:

```
correctnessRate = player.correct_answers / total_questions   (0.0 – 1.0)
correctnessModifier = round((correctnessRate - 0.5) × 1400) (-700 to +700)
perfScore = max(0, anchorRp + (win ? +300 : -300) + correctnessModifier)
```

The correctness modifier means:
- **0% correct → -700** (didn't answer anything right)
- **50% correct → 0** (neutral, same as old flat ±300 system)
- **100% correct → +700** (answered everything right)

RP does NOT change during placement games 1 and 2. Only game 3 triggers the seed calculation.

### Final Seed Calculation (after game 3)

```
base = sum(perfScores) / 3
dominanceAdj = clamp(round((playerPointsTotal - opponentPointsTotal) / 50), -150, +150)
seedRp = clamp(roundToNearest25(base + dominanceAdj), 0, 2600)
```

- `playerPointsTotal` / `opponentPointsTotal` = accumulated `total_points` across all 3 matches (includes speed bonuses from `calculatePoints`)
- Dominance adjustment rewards players who had close games or dominated on points

### Placement Outcome Examples

**Lose all 3, 0% correct, 0 points (worst case):**

| Match | Anchor | Win/Loss | Correctness Mod | Perf Score |
|-------|--------|----------|-----------------|------------|
| 1     | 1900   | -300     | -700            | 900        |
| 2     | 1400   | -300     | -700            | 400        |
| 3     | 900    | -300     | -700            | 0          |

Base = 433, dominance = -150 → **~275 RP → Academy**

**Lose all 3, 50% correct (average play):**

| Match | Anchor | Win/Loss | Correctness Mod | Perf Score |
|-------|--------|----------|-----------------|------------|
| 1     | 1900   | -300     | 0               | 1600       |
| 2     | 1400   | -300     | 0               | 1100       |
| 3     | 900    | -300     | 0               | 600        |

Base = 1100, dominance ~0 → **~1100 RP → Bench**

**Win 2, Lose 1, 60% correct:**

| Match | Anchor | Win/Loss | Correctness Mod | Perf Score |
|-------|--------|----------|-----------------|------------|
| 1     | 1900   | +300     | +140            | 2340       |
| 2     | 2300   | +300     | +140            | 2740       |
| 3     | 2700   | -300     | +140            | 2540       |

Base = 2540, dominance +50 → **~2600 RP → Captain/World-Class**

**Win all 3, 100% correct (best case):**

Perf scores ~2900, 3000+, 3000+ → clamped seed → **2600 RP → World-Class**

The full placement range is **Academy (0) → World-Class (2600)**.

---

## Regular Ranked (post-placement)

After placement, RP changes per match based on the Elo-like formula:

```
rankDiff = opponentRp - playerRp

Win:  delta = round(25 + clamp(rankDiff / 50, -15, +20))
Loss: delta = round(-20 + clamp(rankDiff / 50, -25, +10))
```

| Scenario                        | RP Change |
|---------------------------------|-----------|
| Beat much higher-rated opponent | up to +45 |
| Beat equal opponent             | +25       |
| Beat much lower-rated opponent  | +10       |
| Lose to much higher-rated       | -10       |
| Lose to equal opponent          | -20       |
| Lose to much lower-rated        | up to -45 |

- RP floor is **0** (can't go negative)
- Win streaks are tracked (`current_win_streak`) but don't currently affect RP

---

## Matchmaking Flow

1. Player clicks Ranked → `ranked:queue_join` socket event
2. If `RANKED_HUMAN_QUEUE_ENABLED` is true:
   - Player enters a Redis sorted-set queue
   - A tick loop (100ms interval) tries to pair two queued players
   - If no pair found within 7 seconds, falls back to AI opponent
3. If `RANKED_HUMAN_QUEUE_ENABLED` is false (current default):
   - Immediately creates an AI opponent and starts the lobby
4. Once matched → lobby created → category draft (ban 1 each from 4) → match starts

---

## Key Files

| File | Purpose |
|------|---------|
| `src/modules/ranked/ranked.service.ts` | Tier mapping, placement AI context, settlement |
| `src/modules/ranked/ranked.repo.ts` | DB queries for ranked profiles and RP changes |
| `src/modules/ranked/ranked.types.ts` | TypeScript types for ranked system |
| `src/modules/matches/matches.service.ts` | Match creation (passes rankedContext for placement) |
| `src/realtime/possession-match-flow.ts` | AI answer scheduling (reads adaptive correctness) |
| `src/realtime/ai-ranked.constants.ts` | AI profile generation, geo pool, fallback correctness |
| `src/realtime/services/ranked-matchmaking.service.ts` | Redis queue, pairing, fallback logic |
| `src/realtime/services/lobby-realtime.service.ts` | Lobby creation, AI opponent setup |

---

## TODO: Human vs Human Ranked

The human-vs-human ranked path (`RANKED_HUMAN_QUEUE_ENABLED=true`) has several gaps that need fixing before it can be enabled in production:

### 1. No skill-based matchmaking
The queue pairs players randomly (`RANKED_MM_PAIR_TWO_RANDOM_SCRIPT` picks any two from the sorted set). It does not consider RP proximity, tier, or placement status. A 300 RP Academy player could be matched against a 2800 RP World-Class player.

**Needs:** RP-range bucketing or sliding window matching (e.g. ±200 RP, widening over time).

### 2. Placement vs human opponent not handled
The adaptive AI anchor system (`buildPlacementAiContext`) only runs when creating a match with an AI opponent. If two unplaced humans match, or a placed human matches an unplaced one:
- No `rankedContext` is set on the match
- The unplaced player's perf score uses the opponent's real RP as the anchor (not the adaptive anchor)
- The correctness modifier still works but the anchor progression is lost

**Needs:** Decide whether placement is AI-only (block unplaced players from human queue) or support mixed placement (use opponent's RP as a fixed anchor, skip adaptive anchor).

### 3. Both players in placement
If both players are in placement, both would have seed RP 1200 regardless of actual skill. Their perf scores would all use anchor 1200, giving a very narrow placement range.

**Needs:** Either force placement to be AI-only, or assign one player as the "anchor" and compute separately.

### 4. Win streaks not used
`current_win_streak` is tracked but doesn't influence RP gains. Could add a streak multiplier (e.g. +5 RP per consecutive win, capped at +25 bonus).

### 5. Draw handling
The current settlement assumes a `winner_user_id` exists. If a match ends in a draw (total_points_fallback tie), `winner_user_id` is null and settlement is skipped entirely. Draws should award/deduct a small amount (e.g. ±0 or +5 each).
