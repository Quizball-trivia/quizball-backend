/** Six-player real-socket gameplay fleet. Only local/staging; never imports app config or reads .env. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, type Socket } from 'socket.io-client';
import postgres from 'postgres';
import {
  assertTarget,
  assertLocalUrl,
  partyPoints,
  percentile,
  podiumOracle,
  roomPlaces,
  sameJson,
} from './room-fleet-oracle.js';

type Payload = Record<string, any>; // Socket payloads span two existing protocols.
interface User {
  userId: string;
  token: string;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (test: () => boolean, timeout: number, label: string) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (test()) return;
    await sleep(50);
  }
  throw new Error(`${label} timed out after ${timeout}ms`);
};
const main = async () => {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string) =>
    argv.includes(`--${name}`) ? (argv[argv.indexOf(`--${name}`) + 1] ?? fallback) : fallback;
  const target = flag('target', 'local'),
    api = flag('api', 'http://127.0.0.1:8050');
  const manifest = JSON.parse(readFileSync(flag('users', 'room-load-artifacts/users.json'), 'utf8'));
  assertTarget(api, target, manifest.apiBase);
  const peer = flag('peer-api', '');
  if (peer && target !== 'local') throw new Error('Explicit replica routing is local-only');
  const peerApi = peer ? assertLocalUrl(peer).origin : null;
  if (target === 'staging' && (!argv.includes('--confirm-staging') || manifest.localAuthFixture))
    throw new Error('Staging requires explicit confirmation and real staging test credentials');
  const count = Number(flag('rooms', '1')),
    cycles = Number(flag('cycles', '1')),
    rampMs = Number(flag('ramp-seconds', '10')) * 1000;
  const cyclePauseMs = Number(flag('cycle-pause-seconds', '0')) * 1000;
  const mode = flag('mode', 'mixed'),
    fault = flag('fault', 'none');
  const partyCategoryId = flag('category', manifest.partyCategoryId ?? '');
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 200 ||
    !Number.isInteger(cycles) ||
    cycles < 1 ||
    cycles > 100 ||
    !Number.isFinite(rampMs) ||
    rampMs < 0 ||
    rampMs > 600000 ||
    !Number.isFinite(cyclePauseMs) ||
    cyclePauseMs < 0 ||
    cyclePauseMs > 3600000
  )
    throw new Error('Invalid rooms/cycles/ramp');
  if (
    !['aproximado', 'party', 'mixed'].includes(mode) ||
    !['none', 'reconnect', 'leave', 'duplicate'].includes(fault)
  )
    throw new Error('Invalid mode/fault');
  if (mode !== 'aproximado' && !/^[0-9a-f-]{36}$/i.test(partyCategoryId))
    throw new Error('Party/mixed runs require a verified MCQ category in the manifest or --category');
  const offset = Number(flag('user-offset', '0'));
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid user offset');
  const users: User[] = manifest.users.slice(offset);
  if (
    users.length < count * 6 ||
    new Set(users.slice(0, count * 6).map((u) => u.userId)).size !== count * 6 ||
    users.slice(0, count * 6).some((u) => !u.userId || !u.token)
  )
    throw new Error('Need six distinct authenticated users per room');
  const database = new URL(flag('database', 'postgresql://postgres@127.0.0.1:5436/quizball_load_local'));
  if (
    target === 'local' &&
    (!['localhost', '127.0.0.1'].includes(database.hostname) ||
      !/^\/quizball_load_[a-z0-9_]+$/.test(database.pathname))
  )
    throw new Error('Dedicated local load DB required');
  if (
    target === 'staging' &&
    !database.hostname.includes('nsdfiprfmhdqhbfxfwpv') &&
    !database.username.includes('nsdfiprfmhdqhbfxfwpv')
  )
    throw new Error('Staging database identity required');
  const db = postgres(database.href, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 5,
    connection: { application_name: 'room-load-observer' },
  });
  const out = resolve(flag('out', 'room-load-artifacts/run'));
  mkdirSync(out, { recursive: true });
  // A stopped/restarting local server is a setup failure, not a gameplay capacity sample.
  const readyResponse = await fetch(`${api}/health/db`, { signal: AbortSignal.timeout(5000) });
  const readyData = await readyResponse.json();
  if (!readyResponse.ok || !readyData.ok)
    throw new Error('Backend is not ready; start it before launching the fleet');
  let peerReady: Payload | undefined;
  if (peerApi) {
    const response = await fetch(`${peerApi}/health/db`, { signal: AbortSignal.timeout(5000) });
    peerReady = await response.json();
    if (!response.ok || !peerReady?.ok) throw new Error('Peer backend is not ready');
  }
  const began = Date.now(),
    errors: Array<{ room: number; stage: string; detail: string }> = [],
    samples: number[] = [],
    health: Payload[] = [],
    results: Payload[] = [],
    clients: Player[] = [];
  let monitorBusy = false,
    maxConnected = 0,
    actualConnected = 0,
    staleStates = 0,
    sent = 0,
    accepted = 0,
    duplicateAcks = 0;
  const matchIds: string[] = [],
    timerLateness: number[] = [];
  const log = (s: string) => console.log(`+${((Date.now() - began) / 1000).toFixed(1)}s ${s}`);
  const fail = (room: number, stage: string, error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    if (errors.length < 2000) errors.push({ room, stage, detail });
    log(`FAIL room ${room} ${stage}: ${detail.slice(0, 250)}`);
  };
  const assert = (ok: boolean, reason: string) => {
    if (!ok) throw new Error(reason);
  };
  const monitor = async () => {
    if (monitorBusy) return;
    monitorBusy = true;
    try {
      const start = Date.now();
      const response = await fetch(`${api}/health/db`, { signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      let peerHealth: Payload | undefined;
      if (peerApi) {
        const peerResponse = await fetch(`${peerApi}/health/db`, { signal: AbortSignal.timeout(5000) });
        peerHealth = { ...(await peerResponse.json()), httpStatus: peerResponse.status };
      }
      const [load] =
        await db`SELECT (SELECT count(*)::int FROM room_matches WHERE id=ANY(${db.array(matchIds)}::uuid[]) AND status='active')+(SELECT count(*)::int FROM matches WHERE id=ANY(${db.array(matchIds)}::uuid[]) AND status='active') AS active_matches, (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS db_connections, (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters`;
      health.push({
        atMs: Date.now() - began,
        httpStatus: response.status,
        httpMs: Date.now() - start,
        ...data,
        ...(peerHealth ? { peer: peerHealth } : {}),
        ...load,
      });
    } catch (error) {
      health.push({ atMs: Date.now() - began, error: String(error) });
    } finally {
      monitorBusy = false;
    }
  };
  const monitorTimer = setInterval(() => void monitor(), 2000);
  await monitor();

  class Player {
    socket: Socket;
    latest = new Map<string, Payload>();
    questions = new Map<number, Payload>();
    roundResults = new Map<number, Payload>();
    final: Payload | undefined;
    matchId = '';
    game = '';
    active = true;
    closed = false;
    answers = new Map<
      number,
      { value: number; points?: number; correct?: boolean; sentAt: number; accepted?: boolean }
    >();
    scheduled = new Set<number>();
    pending = new Map<string, { sentAt: number; duplicate: boolean }>();
    ready = new Set<string>();
    content: Payload[] = [];
    seat = -1;
    highestVersion = -1;
    cycle = 0;
    faulted = false;
    timers = new Set<ReturnType<typeof setTimeout>>();
    previousRoom: Payload | undefined;
    constructor(
      readonly user: User,
      readonly roomIndex: number,
      readonly index: number,
    ) {
      this.socket = io(peerApi && index % 2 ? peerApi : api, {
        autoConnect: false,
        transports: ['websocket'],
        auth: { token: user.token },
        reconnection: true,
        reconnectionDelay: 300,
        reconnectionDelayMax: 1000,
        timeout: 20000,
      });
      clients.push(this);
      this.socket.on('connect', () => {
        actualConnected++;
        maxConnected = Math.max(maxConnected, actualConnected);
        if (this.matchId) {
          if (this.game === 'aproximado')
            this.socket.emit('room:resync', { matchId: this.matchId, locale: 'es' });
          else this.socket.emit('match:rejoin', { matchId: this.matchId });
        }
      });
      this.socket.on('disconnect', () => {
        actualConnected = Math.max(0, actualConnected - 1);
      });
      this.socket.on('connect_error', (e) => fail(this.roomIndex, 'connect', e));
      this.socket.onAny((event: string, data: Payload) => {
        if (this.closed) return;
        this.latest.set(event, data);
        if (event === 'error' || event === 'room:error') {
          fail(this.roomIndex, event, JSON.stringify(data));
          return;
        }
        if (event === 'room:state' && data.matchId === this.matchId) {
          if (data.stateVersion < this.highestVersion) {
            staleStates++;
            return;
          }
          this.highestVersion = data.stateVersion;
          this.seat = data.me.seat;
          if (
            this.index === 0 &&
            this.previousRoom?.view?.phase !== data.view?.phase &&
            ['intro', 'reveal'].includes(this.previousRoom?.view?.phase)
          )
            timerLateness.push(
              Math.max(0, Date.now() - new Date(this.previousRoom!.phaseDeadlineAt).getTime()),
            );
          this.previousRoom = data;
          if (data.status === 'ready' && !this.ready.has(data.matchId)) {
            this.ready.add(data.matchId);
            this.socket.emit('room:ready', { matchId: data.matchId, locale: 'es' });
          }
          if (data.view?.question && ('value' in data.view.question || 'exactWithin' in data.view.question))
            fail(this.roomIndex, 'answer leak', 'private question key in room state');
          for (const [r, result] of (data.view?.results ?? []).entries()) this.roundResults.set(r, result);
          if (data.view?.phase === 'guess' && data.me.active && this.active) this.scheduleRoomAnswer(data);
          if (data.status === 'completed' || data.status === 'cancelled') this.final = data;
        }
        if (event === 'room:command_result' && data.matchId === this.matchId) {
          const p = this.pending.get(data.commandId);
          if (!p) return;
          this.pending.delete(data.commandId);
          if (p.duplicate) {
            duplicateAcks++;
            if (!data.ok && !['already_answered', 'not_open'].includes(data.code))
              fail(this.roomIndex, 'duplicate', JSON.stringify(data));
            return;
          }
          samples.push(Date.now() - p.sentAt);
          if (data.ok) {
            accepted++;
            const a = [...this.answers.values()].find((a) => a.sentAt === p.sentAt);
            if (a) a.accepted = true;
          } else fail(this.roomIndex, 'command', JSON.stringify(data));
        }
        if (event === 'match:waiting_for_ready' && data.matchId === this.matchId)
          this.socket.emit(data.phase === 'resume' ? 'match:resume_ui_ready' : 'match:kickoff_ui_ready', {
            matchId: this.matchId,
          });
        if (event === 'match:rejoin_available' && this.matchId)
          this.socket.emit('match:rejoin', { matchId: this.matchId });
        if (event === 'match:start' && data.matchId === this.matchId)
          this.socket.emit('match:kickoff_ui_ready', { matchId: this.matchId });
        if (event === 'match:question' && data.matchId === this.matchId) {
          this.questions.set(data.qIndex, data);
          this.socket.emit('match:question_revealed', { matchId: this.matchId, qIndex: data.qIndex });
          if (this.active) this.schedulePartyAnswer(data);
        }
        if (event === 'match:answer_ack' && data.matchId === this.matchId) {
          const a = this.answers.get(data.qIndex);
          if (!a) return;
          if (a.accepted) {
            duplicateAcks++;
            return;
          }
          a.accepted = true;
          a.points = data.pointsEarned;
          a.correct = data.isCorrect;
          samples.push(Date.now() - a.sentAt);
          accepted++;
        }
        if (event === 'match:round_result' && data.matchId === this.matchId) {
          this.roundResults.set(data.qIndex, data);
          this.later(
            () =>
              this.socket.emit('match:ready_for_next_question', {
                matchId: data.matchId,
                qIndex: data.qIndex,
              }),
            3000,
          );
        }
        if (event === 'match:final_results' && data.matchId === this.matchId) {
          this.final = data;
          this.socket.emit('match:final_results_ack', {
            matchId: this.matchId,
            resultVersion: data.resultVersion,
          });
        }
      });
    }
    later(fn: () => void, ms: number) {
      const t = setTimeout(
        () => {
          this.timers.delete(t);
          if (!this.closed) fn();
        },
        Math.max(0, ms),
      );
      this.timers.add(t);
    }
    reset(game: string, id: string, content: Payload[]) {
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      this.pending.clear();
      this.matchId = id;
      this.game = game;
      this.content = content;
      this.active = true;
      this.final = undefined;
      this.faulted = false;
      this.seat = -1;
      this.highestVersion = -1;
      this.previousRoom = undefined;
      this.answers.clear();
      this.scheduled.clear();
      this.roundResults.clear();
      this.questions.clear();
      this.latest.delete('room:state');
    }
    scheduleRoomAnswer(state: Payload) {
      const r = state.view.round;
      if (this.scheduled.has(r) || !this.content[r]) return;
      this.scheduled.add(r);
      const q = this.content[r],
        unit = 10 ** -q.precision;
      const offset = r % 3 === 0 ? 0 : ([0, 0, 1, -1, 3, 10][this.seat] ?? this.index);
      const value = Number(Math.max(0, q.value + offset * unit).toFixed(q.precision));
      this.later(
        () =>
          void this.actFaultThenAnswer(r, () => {
            const commandId = randomUUID(),
              at = Date.now();
            this.answers.set(r, { value, sentAt: at });
            this.pending.set(commandId, { sentAt: at, duplicate: false });
            sent++;
            const payload = { matchId: this.matchId, commandId, command: { type: 'guess', round: r, value } };
            this.socket.emit('room:command', payload);
            if (fault === 'duplicate' && this.index === 0) this.socket.emit('room:command', payload);
          }),
        argv.includes('--burst') ? 250 : 250 + this.index * 200,
      );
    }
    schedulePartyAnswer(q: Payload) {
      const r = q.qIndex;
      if (this.scheduled.has(r)) return;
      this.scheduled.add(r);
      const timeMs = argv.includes('--burst') ? 250 : 250 + this.index * 400;
      const options = q.question?.options?.length ?? 4;
      const selectedIndex = (r + this.index) % 3 === 0 ? q.correctIndex : (q.correctIndex + 1) % options;
      this.later(
        () =>
          void this.actFaultThenAnswer(r, () => {
            const at = Date.now();
            this.answers.set(r, { value: selectedIndex, sentAt: at });
            sent++;
            const payload = { matchId: this.matchId, qIndex: r, selectedIndex, timeMs };
            this.socket.emit('match:answer', payload);
            if (fault === 'duplicate' && this.index === 0) this.socket.emit('match:answer', payload);
          }),
        Math.max(0, new Date(q.playableAt).getTime() - Date.now()) + timeMs,
      );
    }
    async actFaultThenAnswer(r: number, answer: () => void) {
      try {
        if (!this.faulted && r === 2 && this.index === 5 && fault === 'reconnect') {
          this.faulted = true;
          this.socket.disconnect();
          await sleep(4000);
          this.socket.connect();
          await until(() => this.socket.connected, 15000, 'reconnect');
          await sleep(this.game === 'party' ? 6500 : 1000);
          // The player may have missed this question while offline; do not send a stale answer.
          if (
            this.game === 'aproximado' &&
            (this.latest.get('room:state')?.view?.round !== r ||
              this.latest.get('room:state')?.view?.phase !== 'guess')
          )
            return;
          if (this.game === 'party' && this.latest.get('match:question')?.qIndex !== r) return;
        }
        if (!this.faulted && r === 3 && this.index === 5 && fault === 'leave') {
          this.faulted = true;
          this.active = false;
          this.socket.emit(this.game === 'party' ? 'match:leave' : 'room:leave', {
            matchId: this.matchId,
            commandId: randomUUID(),
          });
          return;
        }
        answer();
      } catch (error) {
        fail(this.roomIndex, 'fault', error);
      }
    }
    async ack(event: string, payload: Payload) {
      return new Promise<Payload>((resolve, reject) =>
        this.socket
          .timeout(30000)
          .emit(event, payload, (error: Error | null, result: Payload) =>
            error
              ? reject(error)
              : result?.ok
                ? resolve(result)
                : reject(new Error(`${event}: ${result?.code ?? 'no result'}`)),
          ),
      );
    }
    close() {
      this.closed = true;
      for (const t of this.timers) clearTimeout(t);
      this.socket.disconnect();
    }
  }

  const playGroup = async (roomIndex: number) => {
    const game = mode === 'mixed' ? (roomIndex % 2 === 0 ? 'aproximado' : 'party') : mode;
    const players = users.slice(roomIndex * 6, roomIndex * 6 + 6).map((u, i) => new Player(u, roomIndex, i));
    const host = players[0];
    let lobbyId = '';
    try {
      await sleep(count <= 1 ? 0 : (rampMs * roomIndex) / count);
      for (const p of players) p.socket.connect();
      await until(() => players.every((p) => p.socket.connected), 30000, 'six sockets connected');
      const created = await host.ack('lobby:create', {
        mode: 'friendly',
        isPublic: false,
        ...(game === 'aproximado' ? { gameMode: 'room_game', roomGame: 'aproximado' } : {}),
      });
      lobbyId = created.lobbyId;
      if (game === 'party') {
        host.socket.emit('lobby:update_settings', {
          lobbyId,
          gameMode: 'friendly_party_quiz',
          friendlyRandom: false,
          friendlyCategoryAId: partyCategoryId,
        });
        await until(
          () =>
            host.latest.get('lobby:state')?.settings?.gameMode === 'friendly_party_quiz' &&
            host.latest.get('lobby:state')?.settings?.friendlyCategoryAId === partyCategoryId,
          30000,
          'verified party category',
        );
      }
      // Joining is sequential per lobby (same user-visible flow); different rooms run concurrently.
      for (const p of players.slice(1)) await p.ack('lobby:join_by_code', { inviteCode: created.inviteCode });
      await until(
        () =>
          host.latest.get('lobby:state')?.members?.length === 6 &&
          host.latest.get('lobby:state')?.settings?.gameMode ===
            (game === 'party' ? 'friendly_party_quiz' : 'room_game'),
        30000,
        'six-member settings',
      );
      for (let cycle = 0; cycle < cycles; cycle++) {
        if (cycle > 0) {
          await sleep(cyclePauseMs);
          // The two existing protocols differ: room games reuse their room;
          // Party Quiz's Play Again creates/joins a new rematch lobby.
          if (game === 'party') {
            const previousLobbyId = lobbyId;
            for (const p of players) {
              p.socket.emit('match:play_again', { matchId: p.matchId });
              await until(
                () =>
                  p.latest.get('lobby:state')?.lobbyId !== previousLobbyId &&
                  p.latest.get('lobby:state')?.status === 'waiting',
                30000,
                'party play again lobby',
              );
              if (p === host) lobbyId = host.latest.get('lobby:state')!.lobbyId;
              assert(
                p.latest.get('lobby:state')?.lobbyId === lobbyId,
                'players split across rematch lobbies',
              );
            }
            host.socket.emit('lobby:update_settings', {
              lobbyId,
              gameMode: 'friendly_party_quiz',
              friendlyRandom: false,
              friendlyCategoryAId: partyCategoryId,
            });
            await until(
              () =>
                host.latest.get('lobby:state')?.members?.length === 6 &&
                host.latest.get('lobby:state')?.settings?.friendlyCategoryAId === partyCategoryId,
              30000,
              'six-member party rematch settings',
            );
          }
          await until(
            () => host.latest.get('lobby:state')?.status === 'waiting',
            30000,
            'rematch lobby waiting',
          );
        }
        for (const p of players) {
          p.latest.delete(game === 'party' ? 'match:start' : 'room:found');
          p.socket.emit('lobby:ready', { ready: true });
        }
        await until(
          () => host.latest.get('lobby:state')?.members?.every((m: Payload) => m.isReady === true),
          30000,
          'everyone ready',
        );
        const start = Date.now();
        host.socket.emit('lobby:start', { lobbyId });
        await until(
          () => players.every((p) => p.latest.has(game === 'party' ? 'match:start' : 'room:found')),
          45000,
          'all six match announcements',
        );
        const id = host.latest.get(game === 'party' ? 'match:start' : 'room:found')!.matchId;
        matchIds.push(id);
        let content: Payload[] = [];
        if (game === 'aproximado') {
          const [row] = await db`SELECT content FROM room_match_content WHERE match_id=${id}`;
          content = row.content.questions;
        }
        for (const p of players) {
          p.reset(game, id, content);
          if (game === 'aproximado') p.socket.emit('room:resync', { matchId: id, locale: 'es' });
          else p.socket.emit('match:kickoff_ui_ready', { matchId: id });
        }
        await until(
          () => players.filter((p) => p.active).every((p) => Boolean(p.final)),
          300000,
          'match results',
        );
        const end = Date.now();
        if (game === 'aproximado') {
          const [row] = await db`SELECT status,state,result FROM room_matches WHERE id=${id}`;
          assert(row.status === 'completed', 'room did not complete');
          assert(row.state.results.length === 10, 'not ten room rounds');
          const reference = players.find((p) => p.active)!.final!.result;
          for (const p of players.filter((p) => p.active))
            assert(sameJson(p.final!.result, reference), 'clients disagree on room result');
          const rounds = row.state.results;
          const finalKeys = Array.from({ length: 6 }, (_, seat) => ({
            seat,
            points: 0,
            wins: 0,
            error: 0,
            withdrawn: row.state.status[seat] === 'withdrawn',
          }));
          for (let r = 0; r < 10; r++) {
            const guesses = rounds[r].entries.map((e: Payload) => e.guess);
            const expected = podiumOracle(
              guesses,
              content[r].value,
              content[r].precision,
              content[r].exactWithin,
            );
            for (let seat = 0; seat < 6; seat++) {
              assert(
                rounds[r].entries[seat].points === expected[seat].points,
                `room round ${r} seat ${seat} points differ`,
              );
              finalKeys[seat].points += expected[seat].points;
              finalKeys[seat].wins += Number(expected[seat].rank === 1);
              finalKeys[seat].error +=
                guesses[seat] === null
                  ? 1
                  : Math.min(
                      1,
                      Math.abs(guesses[seat] - content[r].value) /
                        Math.max(Math.abs(content[r].value), Number.EPSILON),
                    );
            }
          }
          const places = roomPlaces(finalKeys);
          for (const p of players) {
            const standing = row.result.standings.find((s: Payload) => s.userId === p.user.userId);
            const total = rounds.reduce((n: number, r: Payload) => n + r.entries[standing.seat].points, 0);
            assert(standing.points === total, 'room total differs from rounds');
            assert(
              standing.place === places[standing.seat] &&
                standing.roundWins === finalKeys[standing.seat].wins,
              'room ranking/wins differ from independent oracle',
            );
            for (const [r, a] of p.answers) {
              assert(a.accepted === true, `missing room acknowledgement at ${r}`);
              assert(rounds[r].entries[standing.seat].guess === a.value, `accepted room answer lost at ${r}`);
            }
            if (fault === 'none' || fault === 'duplicate')
              assert(p.answers.size === 10, 'room player missed a round');
            if (fault === 'leave' && p.index === 5)
              assert(standing.withdrawn === true, 'room leaver revived');
          }
        } else {
          const rows =
            await db`SELECT user_id,q_index,is_correct,time_ms,points_earned,selected_index FROM match_answers WHERE match_id=${id}`;
          const [match] = await db`SELECT status,total_questions FROM matches WHERE id=${id}`;
          const ranked =
            await db`SELECT user_id,seat,total_points,correct_answers,avg_time_ms FROM match_players WHERE match_id=${id} ORDER BY total_points DESC,correct_answers DESC,avg_time_ms ASC NULLS LAST,seat ASC`;
          assert(match.status === 'completed', 'party did not complete');
          const final = players.find((p) => p.active)!.final!;
          for (const p of players.filter((p) => p.active))
            assert(sameJson(p.final!.standings, final.standings), 'clients disagree on party standings');
          ranked.forEach((p, i) =>
            assert(
              final.standings.find((s: Payload) => s.userId === p.user_id)?.rank === i + 1,
              'party ranking differs from points/correct/time/seat order',
            ),
          );
          assert(rows.length <= match.total_questions * 6, 'duplicate party answer rows');
          for (const p of players) {
            let expectedTotal = 0,
              correct = 0;
            for (const answer of rows.filter((a) => a.user_id === p.user.userId)) {
              const question = p.questions.get(answer.q_index);
              assert(Boolean(question), 'party persisted an answer for an unseen question');
              assert(
                answer.is_correct === (answer.selected_index === question!.correctIndex),
                'party answer correctness differs from selected option',
              );
              const expected = partyPoints(answer.is_correct, answer.time_ms);
              assert(answer.points_earned === expected, 'party points do not match scoring oracle');
              expectedTotal += expected;
              correct += Number(answer.is_correct);
            }
            const actual = final.players[p.user.userId];
            assert(
              actual.totalPoints === expectedTotal && actual.correctAnswers === correct,
              'party final totals differ from answers',
            );
            for (const [r, a] of p.answers) {
              assert(a.accepted === true, `missing party acknowledgement at ${r}`);
              assert(
                rows.some(
                  (x) => x.user_id === p.user.userId && x.q_index === r && x.selected_index === a.value,
                ),
                'accepted party answer lost',
              );
            }
            if (fault === 'none' || fault === 'duplicate')
              assert(p.answers.size === match.total_questions, 'party player missed a round');
          }
        }
        results.push({
          room: roomIndex,
          cycle,
          game,
          matchId: id,
          lobbyId,
          startedAtMs: start - began,
          elapsedMs: end - start,
          answers: players.reduce((n, p) => n + p.answers.size, 0),
        });
        log(
          `PASS ${game} room ${roomIndex} cycle ${cycle + 1}: six-player match, scores and delivery verified (${((end - start) / 1000).toFixed(1)}s)`,
        );
      }
    } catch (error) {
      fail(roomIndex, game, error);
    } finally {
      // Only these synthetic users' rooms. Retain match evidence in the isolated DB.
      // On failure, explicitly withdraw these test players before room cleanup; do not leave a
      // content-starved test match spinning in the background and contaminating the next tier.
      if (!players.every((p) => p.final) && host.matchId) {
        for (const p of players)
          if (p.socket.connected)
            p.socket.emit(game === 'party' ? 'match:forfeit' : 'room:leave', {
              matchId: p.matchId,
              commandId: randomUUID(),
            });
        await sleep(1500);
      }
      for (const p of players) {
        if (lobbyId && p.socket.connected) await p.ack('lobby:leave', {}).catch(() => {});
        p.close();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: count }, (_, r) => playGroup(r)));
    // Correct scores alone do not certify a run whose post-game rewards are
    // still queued or failing. Observe the bounded background queue draining.
    const drainDeadline = Date.now() + 120_000;
    for (;;) {
      while (monitorBusy) await sleep(50);
      await monitor();
      const latest = health[health.length - 1];
      const pending = (latest?.partyCompletionDbTasks?.active ?? 0) + (latest?.partyCompletionDbTasks?.queued ?? 0)
        + (latest?.peer?.partyCompletionDbTasks?.active ?? 0) + (latest?.peer?.partyCompletionDbTasks?.queued ?? 0);
      if (pending === 0) break;
      if (Date.now() >= drainDeadline) { fail(-1, 'completion', 'post-game reward queue did not drain within 120 seconds'); break; }
      await sleep(1_000);
    }
  } finally {
    clearInterval(monitorTimer);
    while (monitorBusy) await sleep(50);
    await monitor();
    for (const p of clients) p.close();
    await db.end();
  }
  const percentiles = {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: samples.reduce((m, n) => Math.max(m, n), 0),
  };
  const expectedMatches = count * cycles;
  const peak = (get: (h: Payload) => number) => Math.max(0, ...health.map((h) => get(h) || 0));
  const rejectionsAtStart = health.find((h) => h.pool)?.pool.rejections ?? 0;
  const healthy = (h: Payload) => h.ok === true && (!peerApi || h.peer?.ok === true);
  const summary = {
    target,
    api,
    peerApi,
    mode,
    fault,
    burst: argv.includes('--burst'),
    rooms: count,
    players: count * 6,
    cycles,
    cyclePauseMs,
    configuration: {
      dbPool: readyData.pool?.max,
      dbInflight: readyData.pool?.limit,
      dbQueueLimit: readyData.pool?.queueLimit,
      generatorNode: process.version,
      gameplayConcurrency: readyData.gameplayDbTasks?.limit,
      gameplayQueueLimit: readyData.gameplayDbTasks?.queueLimit,
      partyCompletionConcurrency: readyData.partyCompletionDbTasks?.limit,
      peerDbPool: peerReady?.pool?.max,
    },
    expectedMatches,
    completedMatches: results.length,
    verifiedMatches: results.length,
    maxConnected,
    maxConcurrentMatches: peak((h) => h.active_matches),
    sent,
    accepted,
    duplicateAcks,
    staleStates,
    elapsedSec: (Date.now() - began) / 1000,
    ackMs: percentiles,
    timerLatenessMs: { p95: percentile(timerLateness, 0.95), max: Math.max(0, ...timerLateness) },
    peaks: {
      rssMb: peak((h) => h.runtime?.memoryMb?.rss),
      heapMb: peak((h) => h.runtime?.memoryMb?.heapUsed),
      cpuCorePct: peak((h) => h.runtime?.cpuCorePct),
      eventLoopP99Ms: peak((h) => h.runtime?.eventLoopDelayMs?.p99),
      dbConnections: peak((h) => h.db_connections),
      dbQueue: peak((h) => h.pool?.queued),
      dbLockWaiters: peak((h) => h.lock_waiters),
      dbRejections: Math.max(0, peak((h) => h.pool?.rejections) - rejectionsAtStart),
      gameplayQueueLifetimeHighWater: peak((h) => h.gameplayDbTasks?.maxQueued),
      gameplayWaitLifetimeMaxMs: peak((h) => h.gameplayDbTasks?.maxWaitMs),
      gameplayRejections: Math.max(0, peak((h) => h.gameplayDbTasks?.rejections) - (readyData.gameplayDbTasks?.rejections ?? 0)),
      partyCompletionQueueLifetimeHighWater: peak((h) => h.partyCompletionDbTasks?.maxQueued),
      partyCompletionWaitLifetimeMaxMs: peak((h) => h.partyCompletionDbTasks?.maxWaitMs),
      partyCompletionRejections: Math.max(0, peak((h) => h.partyCompletionDbTasks?.rejections) - (readyData.partyCompletionDbTasks?.rejections ?? 0)),
      peerDbRejections: Math.max(0, peak((h) => h.peer?.pool?.rejections) - (peerReady?.pool?.rejections ?? 0)),
      peerGameplayRejections: Math.max(0, peak((h) => h.peer?.gameplayDbTasks?.rejections) - (peerReady?.gameplayDbTasks?.rejections ?? 0)),
      peerPartyCompletionRejections: Math.max(0, peak((h) => h.peer?.partyCompletionDbTasks?.rejections) - (peerReady?.partyCompletionDbTasks?.rejections ?? 0)),
      peerRssMb: peak((h) => h.peer?.runtime?.memoryMb?.rss),
    },
    errors,
    results,
    healthSamples: health.length,
    healthFailures: health.filter((h) => !healthy(h)).length,
    correctnessPass: errors.length === 0 && results.length === expectedMatches,
    latencyPass: percentiles.p95 <= 500 && percentiles.p99 <= 1000,
    healthPass: health.every(healthy),
    capacityPass: false,
    note: 'Local fixture bypasses external identity-provider infrastructure only; all sockets and gameplay use the real backend. Saturation failures are retained.',
  };
  summary.capacityPass = summary.peaks.dbRejections === 0 && summary.peaks.gameplayRejections === 0
    && summary.peaks.partyCompletionRejections === 0 && summary.peaks.peerDbRejections === 0
    && summary.peaks.peerGameplayRejections === 0 && summary.peaks.peerPartyCompletionRejections === 0;
  writeFileSync(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(resolve(out, 'health.json'), JSON.stringify(health, null, 2));
  log(`SUMMARY ${JSON.stringify({ ...summary, errors: errors.slice(0, 5), results: undefined })}`);
  process.exitCode = summary.correctnessPass && summary.latencyPass && summary.healthPass && summary.capacityPass ? 0 : 1;
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
