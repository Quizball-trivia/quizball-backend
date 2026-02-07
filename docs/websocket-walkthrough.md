# WebSocket & Multiplayer System Walkthrough

A comprehensive guide to QuizBall's real-time multiplayer system.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [File Structure](#file-structure)
3. [Redis Role & Usage](#redis-role--usage)
4. [Connection & Authentication](#connection--authentication)
5. [Room System](#room-system)
6. [Game Modes](#game-modes)
7. [Complete Game Flow](#complete-game-flow)
8. [Event Reference](#event-reference)
9. [Database Schema](#database-schema)
10. [Scoring System](#scoring-system)
11. [Error Handling & Edge Cases](#error-handling--edge-cases)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (Next.js)                                │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  socket-client.ts  →  useRealtimeConnection.ts  →  React Components │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ WebSocket (Socket.IO)
                                      │ + JWT Auth Token
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            BACKEND (Node.js)                                 │
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────────┐  │
│  │ socket-server│───►│ socket-auth  │───►│ Handler Registration         │  │
│  │    .ts       │    │    .ts       │    │  - lobby.handler.ts          │  │
│  └──────────────┘    └──────────────┘    │  - draft.handler.ts          │  │
│         │                                 │  - match.handler.ts          │  │
│         │                                 └──────────────────────────────┘  │
│         ▼                                              │                     │
│  ┌──────────────┐                                      ▼                     │
│  │ Redis Adapter│◄────────────────────────┬───────────────────────┐         │
│  │ (Socket.IO)  │                         │                       │         │
│  └──────────────┘                         ▼                       ▼         │
│         │                          ┌────────────┐          ┌────────────┐   │
│         │                          │  Services  │          │   Repos    │   │
│         ▼                          │  lobbies   │          │  lobbies   │   │
│  ┌──────────────┐                  │  matches   │          │  matches   │   │
│  │    Redis     │                  └────────────┘          └────────────┘   │
│  │  - Pub/Sub   │                         │                       │         │
│  │  - Locks     │                         └───────────┬───────────┘         │
│  │  - Queue     │                                     ▼                     │
│  └──────────────┘                              ┌────────────┐               │
│                                                │  Postgres  │               │
│                                                │ (Supabase) │               │
│                                                └────────────┘               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why Socket.IO?

- **Automatic reconnection** - handles network drops gracefully
- **Room abstraction** - built-in room join/leave/broadcast
- **Redis adapter** - enables horizontal scaling across multiple server instances
- **Fallback transports** - WebSocket → HTTP long-polling if needed

---

## File Structure

```
src/realtime/
├── socket-server.ts      # Server initialization, CORS, adapter setup
├── socket-auth.ts        # JWT extraction & verification middleware
├── socket.types.ts       # TypeScript interfaces for all events
├── redis.ts              # Redis client initialization (pub/sub + commands)
├── locks.ts              # Distributed locking for race conditions
├── match-flow.ts         # Question timing, round resolution, match completion
├── schemas/
│   ├── lobby.schemas.ts  # Zod validation for lobby events
│   ├── draft.schemas.ts  # Zod validation for draft events
│   └── match.schemas.ts  # Zod validation for match events
└── handlers/
    ├── lobby.handler.ts  # lobby:create, join, leave, ready + ranked queue
    ├── draft.handler.ts  # draft:ban → category elimination
    └── match.handler.ts  # match:answer → scoring & round resolution

src/modules/
├── lobbies/
│   ├── lobbies.repo.ts     # Database CRUD for lobbies
│   ├── lobbies.service.ts  # Business logic (build state, select categories)
│   └── lobbies.types.ts    # TypeScript types
└── matches/
    ├── matches.repo.ts     # Database CRUD for matches
    ├── matches.service.ts  # Business logic (create match, build payloads)
    └── matches.types.ts    # TypeScript types
```

### File Responsibilities

| File | Purpose |
|------|---------|
| `socket-server.ts` | Creates Socket.IO server, attaches Redis adapter, registers all handlers |
| `socket-auth.ts` | Middleware that validates JWT and loads user from DB |
| `socket.types.ts` | Type-safe event definitions (ClientToServer & ServerToClient) |
| `redis.ts` | Initializes 3 Redis clients: command, pub, sub |
| `locks.ts` | Prevents race conditions (e.g., double round resolution) |
| `match-flow.ts` | Core game loop: send questions, handle timeouts, resolve rounds |
| `lobby.handler.ts` | All lobby lifecycle + ranked matchmaking queue |
| `draft.handler.ts` | Category ban/pick phase before match starts |
| `match.handler.ts` | Answer submission and immediate feedback |

---

## Redis Role & Usage

Redis serves **three critical purposes**:

### 1. Socket.IO Adapter (Pub/Sub)

```typescript
// socket-server.ts
import { createAdapter } from '@socket.io/redis-adapter';

const { pubClient, subClient } = await initRedisClients();
io.adapter(createAdapter(pubClient, subClient));
```

**Why?** Enables horizontal scaling. When you have multiple backend instances:
- Player A connects to Server 1
- Player B connects to Server 2
- Server 1 emits to `match:123` room
- Redis pub/sub broadcasts to Server 2
- Player B receives the message

Without this, room broadcasts only work within a single server instance.

### 2. Distributed Locking

```typescript
// locks.ts
export async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  const result = await client.set(key, '1', { NX: true, PX: ttlMs });
  return result === 'OK';
}
```

**Why?** Prevents race conditions:
- Two players answer at the same millisecond
- Both trigger `resolveRound()`
- Without lock: round resolves twice, corrupted state
- With lock: first caller wins, second returns early

Used for:
- `lock:lobby:{lobbyId}` - draft start
- `lock:match:{matchId}:{qIndex}` - round resolution

### 3. Ranked Matchmaking Queue

```typescript
// lobby.handler.ts
const RANKED_QUEUE_KEY = 'ranked:queue';           // List of waiting user IDs
const RANKED_INQUEUE_PREFIX = 'ranked:inqueue:';   // Prevents double-queuing

// Enqueue
await redis.rPush(RANKED_QUEUE_KEY, userId);

// When 2+ players waiting
const userA = await redis.lPop(RANKED_QUEUE_KEY);
const userB = await redis.lPop(RANKED_QUEUE_KEY);
// Create lobby and start game
```

**Why Redis instead of in-memory?**
- Survives server restarts
- Works across multiple server instances
- TTL on `inqueue` keys auto-cleans stuck entries

---

## Connection & Authentication

### Client Connection

```typescript
// Frontend: socket-client.ts
import { io } from 'socket.io-client';

const socket = io(REALTIME_URL, {
  auth: { token: accessToken },  // JWT from Supabase
  transports: ['websocket'],
});
```

### Server Authentication Middleware

```typescript
// socket-auth.ts
export async function socketAuthMiddleware(socket, next) {
  // 1. Extract token from socket.handshake.auth.token or Authorization header
  const token = extractToken(socket);
  if (!token) return next(new Error('Authentication required'));

  // 2. Verify JWT with Supabase auth provider
  const identity = await authProvider.verifyToken(token);

  // 3. Load or create user in our database
  const user = await usersService.getOrCreateFromIdentity(identity);

  // 4. Attach to socket.data for use in handlers
  socket.data = { user, identity };
  next();
}
```

### Post-Connection Setup

```typescript
// socket-server.ts
io.on('connection', (socket) => {
  // Auto-join personal room for direct messages
  socket.join(`user:${socket.data.user.id}`);

  // Register event handlers
  registerLobbyHandlers(io, socket);
  registerDraftHandlers(io, socket);
  registerMatchHandlers(io, socket);
});
```

---

## Room System

Socket.IO rooms are used to group connections for targeted broadcasts.

| Room Pattern | When Joined | Purpose |
|--------------|-------------|---------|
| `user:{userId}` | On connect | Private messages (answer_ack, opponent info) |
| `lobby:{lobbyId}` | On lobby create/join | Lobby state updates, draft events |
| `match:{matchId}` | On match start | Questions, round results, final results |

### Room Operations

```typescript
// Join a room
socket.join(`lobby:${lobbyId}`);
socket.data.lobbyId = lobbyId;  // Track for cleanup

// Leave a room
socket.leave(`lobby:${lobbyId}`);
socket.data.lobbyId = undefined;

// Broadcast to room
io.to(`lobby:${lobbyId}`).emit('lobby:state', state);

// Broadcast to specific user (all their connections)
io.to(`user:${opponentId}`).emit('match:opponent_answered', { ... });
```

---

## Game Modes

### Friendly Mode

1. **Host creates lobby** → gets invite code (e.g., `ABC123`)
2. **Friend joins** with invite code
3. **Both mark ready** → draft starts
4. **Draft phase** → each bans 1 category
5. **Match plays** → 10 questions

```typescript
// lobby.handler.ts - Friendly lobby creation
socket.on('lobby:create', async ({ mode }) => {
  if (mode === 'friendly') {
    const inviteCode = generateInviteCode(6);  // "ABC123"
    const lobby = await lobbiesRepo.createLobby({
      mode: 'friendly',
      hostUserId: userId,
      inviteCode,
    });
    // ...
  }
});
```

### Ranked Mode

1. **Player joins queue** → added to Redis list
2. **System waits** for 2+ players
3. **Auto-match** → creates lobby, both auto-joined
4. **Draft starts immediately** (no ready phase)
5. **Match plays** → 10 questions

```typescript
// lobby.handler.ts - Ranked queue
async function enqueueRanked(io, userId) {
  // Prevent double-queuing
  const inQueueKey = `ranked:inqueue:${userId}`;
  if (await redis.exists(inQueueKey)) return;

  await redis.setEx(inQueueKey, 60, '1');  // TTL 60s
  await redis.rPush('ranked:queue', userId);

  // Check if we can match
  const queueLength = await redis.lLen('ranked:queue');
  if (queueLength >= 2) {
    const userA = await redis.lPop('ranked:queue');
    const userB = await redis.lPop('ranked:queue');

    // Create lobby and start immediately
    const lobby = await lobbiesRepo.createLobby({ mode: 'ranked', ... });
    await startDraft(io, lobby.id);
  }
}
```

---

## Complete Game Flow

### Phase 1: Lobby Creation & Join

```
┌─────────────┐                    ┌─────────────┐                    ┌─────────────┐
│  Player A   │                    │   Server    │                    │  Player B   │
└──────┬──────┘                    └──────┬──────┘                    └──────┬──────┘
       │                                  │                                  │
       │  lobby:create {mode:"friendly"}  │                                  │
       │─────────────────────────────────►│                                  │
       │                                  │                                  │
       │                           [Create lobby]                            │
       │                           [Generate code]                           │
       │                           [Add A as member]                         │
       │                           [A joins lobby room]                      │
       │                                  │                                  │
       │◄─────────────────────────────────│                                  │
       │  lobby:state {inviteCode:"XYZ"}  │                                  │
       │                                  │                                  │
       │         [A shares code with B out-of-band]                          │
       │                                  │                                  │
       │                                  │  lobby:join_by_code {code:"XYZ"} │
       │                                  │◄─────────────────────────────────│
       │                                  │                                  │
       │                           [Lookup lobby by code]                    │
       │                           [Add B as member]                         │
       │                           [B joins lobby room]                      │
       │                                  │                                  │
       │  lobby:state {members:[A,B]}     │  lobby:state {members:[A,B]}     │
       │◄─────────────────────────────────┼─────────────────────────────────►│
       │                                  │                                  │
```

### Phase 2: Ready Up

```
       │                                  │                                  │
       │  lobby:ready {ready:true}        │                                  │
       │─────────────────────────────────►│                                  │
       │                                  │                                  │
       │  lobby:state {A.ready:true}      │  lobby:state {A.ready:true}      │
       │◄─────────────────────────────────┼─────────────────────────────────►│
       │                                  │                                  │
       │                                  │  lobby:ready {ready:true}        │
       │                                  │◄─────────────────────────────────│
       │                                  │                                  │
       │                           [Both ready? Start draft!]                │
       │                                  │                                  │
```

### Phase 3: Draft (Category Ban)

```typescript
// lobby.handler.ts - startDraft()
export async function startDraft(io, lobbyId) {
  // 1. Select 4 random categories that have enough questions
  const categories = await lobbiesService.selectRandomCategories(4);

  // 2. Store in lobby_categories table
  await lobbiesRepo.insertLobbyCategories(lobbyId, categories);

  // 3. Set lobby status to 'active'
  await lobbiesRepo.setLobbyStatus(lobbyId, 'active');

  // 4. Emit draft:start to all lobby members
  io.to(`lobby:${lobbyId}`).emit('draft:start', {
    lobbyId,
    categories,
    turnUserId: lobby.host_user_id,  // Host bans first
  });
}
```

```
       │                                  │                                  │
       │  draft:start {cats:[1,2,3,4],    │  draft:start {turnUserId:A}      │
       │               turnUserId:A}      │                                  │
       │◄─────────────────────────────────┼─────────────────────────────────►│
       │                                  │                                  │
       │  draft:ban {categoryId:"cat2"}   │                                  │
       │─────────────────────────────────►│                                  │
       │                                  │                                  │
       │  draft:banned {actor:A,cat:2}    │  draft:banned {actor:A,cat:2}    │
       │◄─────────────────────────────────┼─────────────────────────────────►│
       │                                  │                                  │
       │                                  │  draft:ban {categoryId:"cat4"}   │
       │                                  │◄─────────────────────────────────│
       │                                  │                                  │
       │  draft:banned {actor:B,cat:4}    │  draft:banned {actor:B,cat:4}    │
       │◄─────────────────────────────────┼─────────────────────────────────►│
       │                                  │                                  │
       │                           [2 bans complete]                         │
       │                           [Remaining: cat1, cat3]                   │
       │                                  │                                  │
       │  draft:complete {allowed:[1,3]}  │  draft:complete {allowed:[1,3]}  │
       │◄─────────────────────────────────┼─────────────────────────────────►│
       │                                  │                                  │
```

### Phase 4: Match Start

```typescript
// draft.handler.ts - startMatchFromDraft()
async function startMatchFromDraft(io, lobbyId, allowedCategoryIds) {
  // 1. Create match with 10 random questions from allowed categories
  const result = await matchesService.createMatchFromLobby({
    lobbyId,
    categoryIds: allowedCategoryIds,
  });

  // 2. Join all lobby members to match room
  const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.join(`match:${matchId}`);
    socket.data.matchId = matchId;
  });

  // 3. Emit match:start with opponent info (different for each player)
  io.to(`user:${playerA}`).emit('match:start', {
    matchId,
    opponent: { id: playerB, username: "...", avatarUrl: "..." }
  });
  io.to(`user:${playerB}`).emit('match:start', {
    matchId,
    opponent: { id: playerA, username: "...", avatarUrl: "..." }
  });

  // 4. Send first question
  await sendMatchQuestion(io, matchId, 0);
}
```

### Phase 5: Question Loop

```typescript
// match-flow.ts
const QUESTION_TIME_MS = 6000;  // 6 seconds per question

export async function sendMatchQuestion(io, matchId, qIndex) {
  // 1. Build question payload (WITHOUT correctIndex!)
  const payload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);

  // 2. Record timing in database
  const deadlineAt = new Date(Date.now() + QUESTION_TIME_MS);
  await matchesRepo.setQuestionTiming(matchId, qIndex, new Date(), deadlineAt);

  // 3. Emit question to all players
  io.to(`match:${matchId}`).emit('match:question', {
    matchId,
    qIndex,
    total: 10,
    question: {
      id, prompt, options,  // NO correctIndex here!
      categoryName, difficulty
    },
    deadlineAt: deadlineAt.toISOString(),
  });

  // 4. Set timeout for auto-resolution
  setTimeout(() => {
    resolveRound(io, matchId, qIndex, true);  // fromTimeout = true
  }, QUESTION_TIME_MS + 50);  // Small buffer

  return { correctIndex: payload.correctIndex };
}
```

```
       │                                  │                                  │
       │  match:question {qIndex:0,...}   │  match:question {qIndex:0,...}   │
       │◄─────────────────────────────────┼─────────────────────────────────►│
       │                                  │                                  │
       │        [6 SECOND TIMER STARTS]   │                                  │
       │                                  │                                  │
       │  match:answer {qIndex:0,         │                                  │
       │    selectedIndex:2, timeMs:1500} │                                  │
       │─────────────────────────────────►│                                  │
       │                                  │                                  │
       │◄─────────────────────────────────│                                  │
       │  match:answer_ack {isCorrect:T,  │                                  │
       │    correctIndex:2, points:185}   │  [PRIVATE - only to A]           │
       │                                  │                                  │
       │                                  │  match:opponent_answered         │
       │                                  │─────────────────────────────────►│
       │                                  │  {qIndex:0}                      │
       │                                  │                                  │
       │                                  │  match:answer {qIndex:0,         │
       │                                  │◄───selectedIndex:1, timeMs:3200} │
       │                                  │                                  │
       │  match:opponent_answered         │  match:answer_ack {isCorrect:F,  │
       │◄─────────────────────────────────│─────────────────────────────────►│
       │  {qIndex:0}                      │    correctIndex:2, points:0}     │
       │                                  │                                  │
       │                           [Both answered - resolve round]           │
       │                                  │                                  │
       │  match:round_result              │  match:round_result              │
       │  {correctIndex:2,                │  {correctIndex:2,                │
       │   players:{A:{...},B:{...}}}     │   players:{A:{...},B:{...}}}     │
       │◄─────────────────────────────────┼─────────────────────────────────►│
       │                                  │                                  │
       │        [2 SECOND PAUSE]          │                                  │
       │                                  │                                  │
       │  match:question {qIndex:1,...}   │  match:question {qIndex:1,...}   │
       │◄─────────────────────────────────┼─────────────────────────────────►│
       │                                  │                                  │
       │        ... repeat for 10 questions ...                              │
```

### Phase 6: Match Completion

```typescript
// match-flow.ts - resolveRound() when qIndex reaches total
if (nextIndex >= match.total_questions) {
  // 1. Determine winner
  const winner = players.reduce((acc, p) =>
    p.total_points > acc.points ? { userId: p.user_id, points: p.total_points } : acc
  , { userId: null, points: -1 });

  // 2. Mark match complete in DB
  await matchesRepo.completeMatch(matchId, winner.userId);

  // 3. Compute average times
  const avgTimes = await matchesService.computeAvgTimes(matchId);

  // 4. Emit final results
  io.to(`match:${matchId}`).emit('match:final_results', {
    matchId,
    winnerId: winner.userId,
    players: {
      [playerA]: { totalPoints, correctAnswers, avgTimeMs },
      [playerB]: { totalPoints, correctAnswers, avgTimeMs },
    },
    durationMs: Date.now() - match.started_at,
  });
}
```

---

## Event Reference

### Client → Server Events

| Event | Payload | Handler | Description |
|-------|---------|---------|-------------|
| `lobby:create` | `{mode: "friendly" \| "ranked"}` | `lobby.handler.ts` | Create lobby or join ranked queue |
| `lobby:join_by_code` | `{inviteCode: string}` | `lobby.handler.ts` | Join friend's lobby |
| `lobby:leave` | `{}` | `lobby.handler.ts` | Leave lobby or ranked queue |
| `lobby:ready` | `{ready: boolean}` | `lobby.handler.ts` | Toggle ready state |
| `draft:ban` | `{categoryId: string}` | `draft.handler.ts` | Ban a category |
| `match:answer` | `{matchId, qIndex, selectedIndex, timeMs}` | `match.handler.ts` | Submit answer |

### Server → Client Events

| Event | Payload | When |
|-------|---------|------|
| `lobby:state` | `{lobbyId, mode, status, inviteCode, members[]}` | Lobby changes |
| `draft:start` | `{lobbyId, categories[], turnUserId}` | Draft begins |
| `draft:banned` | `{actorId, categoryId}` | Category banned |
| `draft:complete` | `{allowedCategoryIds: [2]}` | Draft done |
| `match:start` | `{matchId, opponent}` | Match begins |
| `match:question` | `{matchId, qIndex, total, question, deadlineAt}` | New question |
| `match:answer_ack` | `{isCorrect, correctIndex, myTotalPoints, ...}` | Answer received (PRIVATE) |
| `match:opponent_answered` | `{matchId, qIndex}` | Opponent answered |
| `match:round_result` | `{correctIndex, players}` | Round complete |
| `match:final_results` | `{winnerId, players, durationMs}` | Match complete |

---

## Database Schema

```sql
-- Lobbies (waiting room before match)
CREATE TABLE lobbies (
  id uuid PRIMARY KEY,
  invite_code text UNIQUE,              -- NULL for ranked
  mode text CHECK (mode IN ('friendly', 'ranked')),
  host_user_id uuid REFERENCES users(id),
  status text CHECK (status IN ('waiting', 'active', 'closed')),
  created_at timestamptz DEFAULT now()
);

-- Lobby members (max 2 per lobby)
CREATE TABLE lobby_members (
  lobby_id uuid REFERENCES lobbies(id),
  user_id uuid REFERENCES users(id),
  is_ready boolean DEFAULT false,
  joined_at timestamptz DEFAULT now(),
  PRIMARY KEY (lobby_id, user_id)
);

-- Categories available in draft (4 per lobby)
CREATE TABLE lobby_categories (
  lobby_id uuid REFERENCES lobbies(id),
  slot integer CHECK (slot BETWEEN 1 AND 4),
  category_id uuid REFERENCES categories(id),
  PRIMARY KEY (lobby_id, slot)
);

-- Category bans (1 per player = 2 total)
CREATE TABLE lobby_category_bans (
  lobby_id uuid REFERENCES lobbies(id),
  user_id uuid REFERENCES users(id),
  category_id uuid REFERENCES categories(id),
  banned_at timestamptz DEFAULT now(),
  PRIMARY KEY (lobby_id, user_id)
);

-- Matches (the actual game)
CREATE TABLE matches (
  id uuid PRIMARY KEY,
  lobby_id uuid REFERENCES lobbies(id),
  mode text CHECK (mode IN ('friendly', 'ranked')),
  status text CHECK (status IN ('active', 'completed', 'abandoned')),
  category_a_id uuid REFERENCES categories(id),
  category_b_id uuid REFERENCES categories(id),
  current_q_index integer DEFAULT 0,
  total_questions integer DEFAULT 10,
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz,
  winner_user_id uuid REFERENCES users(id)
);

-- Match players (exactly 2 per match)
CREATE TABLE match_players (
  match_id uuid REFERENCES matches(id),
  user_id uuid REFERENCES users(id),
  seat smallint CHECK (seat IN (1, 2)),
  total_points integer DEFAULT 0,
  correct_answers integer DEFAULT 0,
  avg_time_ms integer,
  PRIMARY KEY (match_id, user_id)
);

-- Pre-selected questions for match (10 per match)
CREATE TABLE match_questions (
  match_id uuid REFERENCES matches(id),
  q_index integer CHECK (q_index BETWEEN 0 AND 9),
  question_id uuid REFERENCES questions(id),
  category_id uuid REFERENCES categories(id),
  correct_index integer CHECK (correct_index BETWEEN 0 AND 3),
  shown_at timestamptz,
  deadline_at timestamptz,
  PRIMARY KEY (match_id, q_index)
);

-- Player answers (up to 20 per match: 10 questions × 2 players)
CREATE TABLE match_answers (
  match_id uuid REFERENCES matches(id),
  q_index integer CHECK (q_index BETWEEN 0 AND 9),
  user_id uuid REFERENCES users(id),
  selected_index integer CHECK (selected_index BETWEEN 0 AND 3),
  is_correct boolean NOT NULL,
  time_ms integer NOT NULL,
  points_earned integer NOT NULL,
  answered_at timestamptz DEFAULT now(),
  PRIMARY KEY (match_id, q_index, user_id)
);
```

### Data Flow

```
lobby:create
    ↓
┌─────────┐     lobby:ready (×2)     ┌─────────────────┐
│ lobbies │ ──────────────────────► │ lobby_categories │ (4 rows)
└─────────┘                          └─────────────────┘
    │                                        │
    │ lobby_members (2 rows)                 │ draft:ban (×2)
    ↓                                        ↓
                                    ┌────────────────────┐
                                    │ lobby_category_bans│ (2 rows)
                                    └────────────────────┘
                                             │
                                             │ draft:complete
                                             ↓
                                      ┌─────────┐
                                      │ matches │
                                      └─────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ↓                      ↓                      ↓
            ┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
            │match_players │     │ match_questions │     │match_answers │
            │   (2 rows)   │     │   (10 rows)     │     │ (up to 20)   │
            └──────────────┘     └─────────────────┘     └──────────────┘
```

---

## Scoring System

```typescript
// match.handler.ts
const QUESTION_TIME_MS = 6000;  // 6 seconds

function calculatePoints(isCorrect: boolean, timeMs: number): number {
  if (!isCorrect) return 0;

  // Clamp time to valid range
  const clamped = Math.max(0, Math.min(timeMs, QUESTION_TIME_MS));

  // Base: 100 points
  // Bonus: 0-100 based on speed (faster = more bonus)
  const bonus = Math.floor(100 * (1 - clamped / QUESTION_TIME_MS));

  return 100 + bonus;
}
```

### Scoring Examples

| Time (ms) | Correct? | Base | Bonus | Total |
|-----------|----------|------|-------|-------|
| 0 | Yes | 100 | 100 | **200** |
| 1500 | Yes | 100 | 75 | **175** |
| 3000 | Yes | 100 | 50 | **150** |
| 4500 | Yes | 100 | 25 | **125** |
| 6000 | Yes | 100 | 0 | **100** |
| Any | No | 0 | 0 | **0** |

### Maximum Possible Score

- 10 questions × 200 points = **2000 points** (perfect game, instant answers)

---

## Error Handling & Edge Cases

### 1. Player Disconnects Mid-Match

Currently: Match continues, disconnected player gets 0 points for remaining questions (timeout).

```typescript
// socket-server.ts
socket.on('disconnect', (reason) => {
  logger.info({ userId, socketId, reason }, 'Socket disconnected');
  // TODO: Could emit opponent_disconnected, offer forfeit, etc.
});
```

### 2. Answer After Deadline

```typescript
// match.handler.ts
socket.on('match:answer', async (payload) => {
  const match = await matchesRepo.getMatch(matchId);

  // Reject if not current question
  if (match.current_q_index !== qIndex) {
    logger.warn({ matchId, qIndex, current: match.current_q_index },
      'Answer for non-current question');
    return;
  }
  // ...
});
```

### 3. Double Answer Prevention

```typescript
// Primary key constraint: (match_id, q_index, user_id)
try {
  await matchesRepo.insertMatchAnswer({ ... });
} catch (error) {
  logger.warn({ error, matchId, qIndex }, 'Duplicate or invalid match answer');
  return;  // Silently ignore duplicate
}
```

### 4. Race Condition: Both Answer Simultaneously

```typescript
// match-flow.ts
export async function resolveRound(io, matchId, qIndex, fromTimeout) {
  // Distributed lock prevents double resolution
  const lockKey = `lock:match:${matchId}:${qIndex}`;
  const locked = await acquireLock(lockKey, 3000);
  if (!locked) return;  // Another process already resolving

  try {
    // Check if already resolved
    const match = await matchesRepo.getMatch(matchId);
    if (match.current_q_index > qIndex) return;  // Already moved on

    // ... resolve round
  } finally {
    await releaseLock(lockKey);
  }
}
```

### 5. Lobby Abandoned (All Players Leave)

```typescript
// lobby.handler.ts
socket.on('lobby:leave', async () => {
  await lobbiesRepo.removeMember(lobbyId, userId);

  const memberCount = await lobbiesRepo.countMembers(lobbyId);
  if (memberCount === 0) {
    await lobbiesRepo.setLobbyStatus(lobbyId, 'closed');
    logger.info({ lobbyId }, 'Lobby closed (no members)');
  }
});
```

### 6. Not Enough Questions in Category

```typescript
// lobby.handler.ts - startDraft()
const categories = await lobbiesService.selectRandomCategories(4);
if (categories.length < 4) {
  logger.warn({ lobbyId, categoryCount: categories.length },
    'Draft start failed: insufficient categories with questions');
  return;  // Don't start draft
}
```

### 7. Draft Ban Out of Turn

```typescript
// draft.handler.ts
const expectedUserId = getNextActorId(members, bans, lobby.host_user_id);
if (socket.data.user.id !== expectedUserId) {
  logger.warn({ lobbyId, userId }, 'Draft ban out of turn');
  return;  // Ignore
}
```

---

## Testing Checklist

### Manual Testing Flow

1. **Connect**: Open browser console, verify `Socket connected` log
2. **Friendly Lobby**: Create lobby, verify invite code returned
3. **Join**: Second client joins with code, both see `lobby:state` with 2 members
4. **Ready**: Both ready up, verify `draft:start` received
5. **Draft**: Host bans, then guest bans, verify `draft:complete`
6. **Match**: Verify questions flow, timer works, scoring correct
7. **Complete**: After 10 questions, verify `final_results` with correct winner

### Edge Cases to Test

- [ ] Disconnect during match
- [ ] Answer after timeout
- [ ] Same answer twice (should be ignored)
- [ ] Leave ranked queue
- [ ] Leave lobby during draft
- [ ] Reconnect (should rejoin rooms)

---

## Future Improvements

1. **Reconnection Handling**: Auto-rejoin match room on reconnect
2. **Spectator Mode**: Watch friends play
3. **Match History**: Store and display past matches
4. **ELO Rating**: Ranked mode rating system
5. **Rematch**: Quick rematch after game ends
6. **Chat**: In-lobby and post-match chat
7. **Tournaments**: Bracket-style competitions
