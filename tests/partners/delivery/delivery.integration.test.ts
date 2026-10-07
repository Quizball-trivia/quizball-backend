import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions } from './test-db.js';

/**
 * Opt-in, real PostgreSQL: applies the delivery migration to a fresh schema and drives the dispatcher against a
 * local stub HTTP server (never a real endpoint). Runs in CI against its PostgreSQL service
 * (MIGRATION_TEST_DATABASE_URL: creates and drops a database of its own), or locally against either that or an
 * isolated database:
 *   PARTNER_DELIVERY_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_partner_delivery_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const isolatedUrl = process.env.PARTNER_DELIVERY_TEST_DATABASE_URL;
const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL;
// Validated before anything connects; postgres.js only ever gets these options, never the raw URLs.
const isolated = isolatedUrl ? testDbOptions(isolatedUrl, ISOLATED_DATABASE) : null;
const adminTarget = !isolated && adminUrl ? testDbOptions(adminUrl, ADMIN_DATABASE) : null;

const MIGRATION = readFileSync(
  join(__dirname, '../../../supabase/migrations/20261005130000_partner_delivery.sql'), 'utf8');
// Supabase's Data API roles, and the default privileges Supabase gives them on every new table.
const ROLES = `
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
`;
const FIXTURE = `
  DROP TABLE IF EXISTS partner_score_event_attempts, partner_score_events, audit_logs, users CASCADE;
  CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL, entity_type text NOT NULL, entity_id uuid, metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now());
`;

const { enqueuePartnerScoreEvent } = await import('../../../src/modules/partners/delivery/score-events.js');
const { ScoreEventDispatcher } = await import('../../../src/modules/partners/delivery/dispatcher.js');
const deliveries = await import('../../../src/modules/partners/delivery/deliveries.js');
const { createPartnerDeliveryAdminRouter } = await import('../../../src/http/routes/partner-delivery.routes.js');
type Dispatcher = InstanceType<typeof ScoreEventDispatcher>;
type DispatcherDeps = ConstructorParameters<typeof ScoreEventDispatcher>[0];

const API_KEY = 'stub-key-not-a-secret-0001';

interface Received { body: string; headers: IncomingMessage['headers']; at: number }
type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void | Promise<void>;

// Generous timeouts: these run in the parallel suite on loaded machines; nothing below depends on wall-clock races.
describe.skipIf(!isolated && !adminTarget)('partner score delivery on real Postgres', { timeout: 30_000 }, () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let createdDatabase: string | undefined;
  let sqlB: ReturnType<typeof postgres> | undefined;
  let server: Server | undefined;
  let stubUrl: string;
  let handler: Handler = (_req, res) => { res.writeHead(200).end('{"status":"ok"}'); };
  let received: Received[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  beforeAll(async () => {
    let target = isolated;
    if (!target) {
      admin = postgres({ ...adminTarget!, max: 1, onnotice: () => undefined });
      const name = `partner_delivery_${randomUUID().replaceAll('-', '')}`;
      await admin`CREATE DATABASE ${admin(name)}`;
      createdDatabase = name;
      target = { ...adminTarget!, database: name };
    }
    db.sql = postgres({ ...target, max: 6, onnotice: () => undefined });
    sqlB = postgres({ ...target, max: 6, onnotice: () => undefined });
    // Nothing destructive runs until both pools are proven to be on the expected database.
    for (const client of [db.sql, sqlB]) {
      const [{ name }] = await client<{ name: string }[]>`SELECT current_database() AS name`;
      expect(name).toBe(target.database);
    }
    await db.sql.unsafe(ROLES);
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers, at: Date.now() });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        res.on('close', () => { inFlight -= 1; });
        void handler(req, res, received.length);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    stubUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/integrations/quizball/score-events`;
  }, 60_000);

  beforeEach(async () => {
    await db.sql.unsafe(FIXTURE);
    await db.sql.begin((tx) => tx.unsafe(MIGRATION));
    received = [];
    inFlight = 0;
    maxInFlight = 0;
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'); };
  }, 60_000);

  afterAll(async () => {
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server!.close(resolve));
      }
    } finally {
      await Promise.allSettled([sqlB?.end({ timeout: 2 }), db.sql?.end({ timeout: 2 })]);
      try {
        if (admin && createdDatabase) await admin.unsafe(`DROP DATABASE "${createdDatabase}" WITH (FORCE)`);
      } finally {
        await admin?.end({ timeout: 2 });
      }
    }
  }, 60_000);

  const destination = () => ({ slug: 'freecroco', environment: 'test' as const, url: stubUrl, apiKey: API_KEY });
  const silentLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  function dispatcher(overrides: Partial<DispatcherDeps> = {}): Dispatcher {
    return new ScoreEventDispatcher({
      sql: db.sql,
      destination,
      log: silentLog() as never,
      pollMs: 60_000,
      timeoutMs: 1_000,
      backoffBaseMs: 1_000,
      random: () => 0,
      ...overrides,
    });
  }

  async function run(d: Dispatcher) {
    d.wake();
    await d.idle();
  }

  async function enqueue(overrides: Record<string, unknown> = {}) {
    const playId = randomUUID();
    const input = {
      playId,
      partnerSlug: 'freecroco',
      environment: 'test' as const,
      playerId: 'player-123',
      sessionId: randomUUID(),
      gameId: 'ranked' as const,
      score: 150,
      occurredAt: new Date('2026-10-07T12:08:00Z'),
      ...overrides,
    };
    const result = await db.sql.begin((tx) => enqueuePartnerScoreEvent(tx, input));
    return { ...input, ...result };
  }

  const row = async (eventId: string) =>
    (await db.sql`SELECT *, id::text AS id FROM partner_score_events WHERE event_id = ${eventId}`)[0]!;
  const attempts = async (eventId: string) => db.sql`
    SELECT a.attempt, a.http_status, a.error FROM partner_score_event_attempts a
    JOIN partner_score_events e ON e.id = a.event_row_id WHERE e.event_id = ${eventId} ORDER BY a.id`;
  const makeDue = (eventId: string) =>
    db.sql`UPDATE partner_score_events SET next_attempt_at = now() WHERE event_id = ${eventId}`;
  const DAY_S = 24 * 60 * 60;
  /** Moves the event's 24-hour window (revived_at is a delivery column) so `leftS` seconds of it remain, by the
   *  database clock; negative = already past the deadline. */
  const windowLeft = (eventId: string, leftS: number) => db.sql`
    UPDATE partner_score_events SET revived_at = now() - make_interval(secs => ${DAY_S - leftS})
    WHERE event_id = ${eventId}`;
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 1_000 && !(await check()); i += 1) await new Promise((r) => setTimeout(r, 10));
  };

  describe('enqueue', () => {
    it('writes nothing when the caller rolls back, and one event per play however often it is called', async () => {
      const playId = randomUUID();
      const input = {
        playId, partnerSlug: 'freecroco', environment: 'test' as const, playerId: 'p-1', sessionId: randomUUID(),
        gameId: 'countdown' as const, score: 0, occurredAt: '2026-10-07T12:08:00.123Z',
      };
      await expect(db.sql.begin(async (tx) => {
        const first = await enqueuePartnerScoreEvent(tx, input);
        const again = await enqueuePartnerScoreEvent(tx, input);
        expect(first).toEqual({ eventId: `qb_${playId}`, created: true });
        expect(again).toEqual({ eventId: `qb_${playId}`, created: false });
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(await db.sql`SELECT 1 FROM partner_score_events`).toHaveLength(0);

      await db.sql.begin((tx) => enqueuePartnerScoreEvent(tx, input));
      const repeat = await db.sql.begin((tx) => enqueuePartnerScoreEvent(tx, { ...input, score: 999 }));
      expect(repeat.created).toBe(false);
      const rows = await db.sql`SELECT event_id, score, payload FROM partner_score_events`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.score).toBe(0);
      expect(rows[0]!.payload.score).toBe(0);
    });

    it('refuses to run outside a transaction and refuses bad input', async () => {
      await expect(enqueuePartnerScoreEvent(db.sql as never, {
        playId: randomUUID(), partnerSlug: 'freecroco', environment: 'test', playerId: 'p', sessionId: randomUUID(),
        gameId: 'ranked', score: 1, occurredAt: new Date(),
      })).rejects.toThrow(/inside the transaction/);
      await expect(enqueue({ score: -1 })).rejects.toThrow();
      await expect(enqueue({ score: 1.5 })).rejects.toThrow();
      await expect(enqueue({ gameId: 'solitaire' })).rejects.toThrow();
      await expect(enqueue({ playerId: 'has space' })).rejects.toThrow();
    });

    it('keeps the event frozen: only delivery columns move, and rows are never deleted', async () => {
      const e = await enqueue();
      await expect(db.sql`UPDATE partner_score_events SET score = 1 WHERE event_id = ${e.eventId}`).rejects.toThrow(/never changes/);
      await expect(db.sql`UPDATE partner_score_events SET payload = '{}' WHERE event_id = ${e.eventId}`).rejects.toThrow(/never changes/);
      await expect(db.sql`DELETE FROM partner_score_events`).rejects.toThrow(/kept/);
      await db.sql`UPDATE partner_score_events SET attempts = 3 WHERE event_id = ${e.eventId}`;
    });
  });

  describe('dispatcher', () => {
    it('POSTs exactly the contract body with the partner key and marks the event sent', async () => {
      const e = await enqueue({ occurredAt: new Date('2026-10-07T12:08:00.000Z') });
      await run(dispatcher());
      expect(received).toHaveLength(1);
      const [req] = received;
      expect(req!.body).toBe(JSON.stringify({
        eventId: e.eventId, sessionId: e.sessionId, playerId: 'player-123', gameId: 'ranked',
        occurredAt: '2026-10-07T12:08:00.000Z', score: 150,
      }));
      expect(Object.keys(JSON.parse(req!.body))).toEqual(['eventId', 'sessionId', 'playerId', 'gameId', 'occurredAt', 'score']);
      expect(req!.headers['x-api-key']).toBe(API_KEY);
      expect(req!.headers['content-type']).toBe('application/json');
      const r = await row(e.eventId);
      expect(r).toMatchObject({ status: 'sent', attempts: 1, lease_token: null, last_error: null });
      expect(r.sent_at).toBeInstanceOf(Date);
      expect(await attempts(e.eventId)).toEqual([
        { attempt: 1, http_status: 200, error: null },
      ]);
    });

    it('stays idle, events pending, while no destination is configured', async () => {
      const e = await enqueue();
      await run(dispatcher({ destination: () => null }));
      expect(received).toHaveLength(0);
      expect(await row(e.eventId)).toMatchObject({ status: 'pending', attempts: 0 });
    });

    it('never sends another environment\'s events', async () => {
      const e = await enqueue({ environment: 'production' });
      await run(dispatcher());
      expect(received).toHaveLength(0);
      expect((await row(e.eventId)).status).toBe('pending');
    });

    it('retries a 500 with backoff, then delivers', async () => {
      handler = (_req, res, n) => { res.writeHead(n === 1 ? 500 : 200).end(n === 1 ? 'oops' : 'ok'); };
      const e = await enqueue();
      const d = dispatcher();
      await run(d);
      const after = await row(e.eventId);
      expect(after).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http_500', lease_token: null });
      // Attempt 1, base 1 s, random 0: half of 1 s after the outcome was recorded.
      const [{ ms }] = await db.sql`
        SELECT extract(epoch FROM e.next_attempt_at - a.created_at) * 1000 AS ms
        FROM partner_score_events e JOIN partner_score_event_attempts a ON a.event_row_id = e.id
        WHERE e.event_id = ${e.eventId}`;
      expect(Number(ms)).toBeGreaterThan(400);
      expect(Number(ms)).toBeLessThanOrEqual(500);
      await makeDue(e.eventId);
      await run(d);
      expect(received).toHaveLength(2);
      expect(received[0]!.body).toBe(received[1]!.body);
      expect((await row(e.eventId)).status).toBe('sent');
      expect((await attempts(e.eventId)).map((a) => a.http_status)).toEqual([500, 200]);
    });

    it('records a timeout and retries it', async () => {
      handler = () => { /* never answers */ };
      const e = await enqueue();
      const d = dispatcher({ timeoutMs: 200 });
      await run(d);
      expect(await row(e.eventId)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'timeout' });
      expect(await attempts(e.eventId)).toMatchObject([{ attempt: 1, http_status: null, error: 'timeout' }]);
    });

    it('honours Retry-After on 429 and 503', async () => {
      handler = (_req, res, n) => { res.writeHead(n === 1 ? 429 : 503, { 'retry-after': n === 1 ? '120' : '30' }).end(); };
      const e = await enqueue();
      const d = dispatcher();
      await run(d);
      let r = await row(e.eventId);
      expect(r).toMatchObject({ status: 'pending', last_error: 'http_429' });
      expect(r.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(100_000);
      expect(r.next_attempt_at.getTime() - Date.now()).toBeLessThanOrEqual(120_000);
      await makeDue(e.eventId);
      await run(d);
      r = await row(e.eventId);
      expect(r).toMatchObject({ status: 'pending', last_error: 'http_503', attempts: 2 });
      expect(r.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(15_000);
    });

    it('a Retry-After past the deadline makes the event dead instead of sending early', async () => {
      handler = (_req, res) => { res.writeHead(429, { 'retry-after': '86400' }).end(); };
      const e = await enqueue();
      const log = silentLog();
      const d = dispatcher({ windowMs: 60_000, log: log as never });
      await run(d);
      expect(await row(e.eventId)).toMatchObject({ status: 'dead', attempts: 1, last_error: 'http_429' });
      await makeDue(e.eventId);
      await run(d);
      expect(received).toHaveLength(1);
      expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/dead-lettered/));
    });

    it('a Retry-After inside the window is honoured even in the last minutes', async () => {
      handler = (_req, res) => { res.writeHead(503, { 'retry-after': '30' }).end(); };
      const e = await enqueue();
      // With a 60 s window and a 60 s last-try margin, only the Retry-After can still fit.
      await run(dispatcher({ windowMs: 60_000 }));
      const r = await row(e.eventId);
      expect(r.status).toBe('pending');
      expect(r.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(15_000);
      expect(r.next_attempt_at.getTime()).toBeLessThan(r.created_at.getTime() + 60_000);
    });

    it('no new POST after the deadline: a late poll gives a failed event up unsent', async () => {
      handler = (_req, res) => { res.writeHead(502).end(); };
      const e = await enqueue();
      const log = silentLog();
      const d = dispatcher({ log: log as never });
      await run(d);
      expect((await row(e.eventId)).status).toBe('pending');
      // The poll that was due inside the window comes after the deadline.
      await windowLeft(e.eventId, -1);
      await makeDue(e.eventId);
      await run(d);
      expect(received).toHaveLength(1);
      expect(await row(e.eventId)).toMatchObject({ status: 'dead', attempts: 1, last_error: 'http_502' });
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ eventId: e.eventId }), expect.stringMatching(/dead-lettered/));
    });

    it('no first POST after the deadline either', async () => {
      const e = await enqueue();
      await windowLeft(e.eventId, -1);
      const log = silentLog();
      await run(dispatcher({ log: log as never }));
      expect(received).toHaveLength(0);
      expect(await row(e.eventId)).toMatchObject({ status: 'dead', last_error: 'window_passed', attempts: 0 });
      expect(log.error).toHaveBeenCalled();
    });

    it('a failure with no retry slot left before the deadline is dead at once', async () => {
      handler = (_req, res) => { res.writeHead(500).end(); };
      const e = await enqueue();
      await run(dispatcher({ windowMs: 30_000 }));
      expect(await row(e.eventId)).toMatchObject({ status: 'dead', attempts: 1, last_error: 'http_500' });
    });

    it('the deadline is checked again right before the request', async () => {
      const e = await enqueue();
      const log = silentLog();
      // The send guard's clock jumps past the 24-hour window between the claim and the request, however long the
      // claim itself took.
      let skew = 0;
      const beforeSend = vi.fn(async () => { skew = 25 * 60 * 60 * 1000; });
      await run(dispatcher({ log: log as never, beforeSend, now: () => performance.now() + skew }));
      expect(beforeSend).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(0);
      expect(await row(e.eventId)).toMatchObject({ status: 'dead', attempts: 0, last_error: 'window_passed', lease_token: null });
      expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/dead-lettered/));
    });

    it('an attempt already under way at the deadline still records its outcome', async () => {
      let answer!: () => void;
      const held = new Promise<void>((resolve) => { answer = resolve; });
      handler = (_req, res) => { void held.then(() => res.writeHead(200).end()); };
      const e = await enqueue();
      // A timeout well inside the default 60 s lease, so the send is not given back.
      const d = dispatcher({ timeoutMs: 30_000 });
      d.wake();
      await until(async () => received.length === 1);
      // The request is out; only now does the deadline pass.
      await windowLeft(e.eventId, -1);
      answer();
      await d.idle();
      expect(received).toHaveLength(1);
      expect(await row(e.eventId)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it.each([400, 401, 404, 422])('a %i is final: dead at once, with an error log', async (status) => {
      handler = (_req, res) => { res.writeHead(status).end('{"error":"nope"}'); };
      const e = await enqueue();
      const log = silentLog();
      await run(dispatcher({ log: log as never }));
      expect(await row(e.eventId)).toMatchObject({ status: 'dead', attempts: 1, last_error: `http_${status}` });
      expect(log.error).toHaveBeenCalledTimes(1);
    });

    it('a 409 (same eventId, different body) is dead at once with its own alert', async () => {
      handler = (_req, res) => { res.writeHead(409).end(); };
      const e = await enqueue();
      const log = silentLog();
      await run(dispatcher({ log: log as never }));
      expect(await row(e.eventId)).toMatchObject({ status: 'dead', attempts: 1, last_error: 'dead_conflict' });
      expect(await attempts(e.eventId)).toEqual([{ attempt: 1, http_status: 409, error: 'dead_conflict' }]);
      expect(log.error).toHaveBeenCalledWith(
        { eventId: e.eventId, status: 409, error: 'dead_conflict' },
        expect.stringMatching(/different body \(409\)/),
      );
      expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/dead-lettered/));
    });

    it('408 is retried', async () => {
      handler = (_req, res) => { res.writeHead(408).end(); };
      const e = await enqueue();
      await run(dispatcher());
      expect(await row(e.eventId)).toMatchObject({ status: 'pending', last_error: 'http_408' });
    });

    it('crash after the claim (no acknowledgement): the next claim after the lease recovers it', async () => {
      const e = await enqueue();
      // A: a sender that hangs forever, ignoring its timeout, as if the replica died mid-send.
      const a = dispatcher({ fetch: () => new Promise<Response>(() => {}) });
      a.wake();
      await until(async () => (await row(e.eventId)).attempts === 1);
      const b = dispatcher({ sql: sqlB! });
      await run(b);
      expect(received).toHaveLength(0);
      expect((await row(e.eventId)).status).toBe('pending');
      // The lease runs out (lease_expires_at is a delivery column).
      await db.sql`UPDATE partner_score_events SET lease_expires_at = now() - interval '1 second', next_attempt_at = now()
        WHERE event_id = ${e.eventId}`;
      await run(b);
      expect(received).toHaveLength(1);
      expect(await row(e.eventId)).toMatchObject({ status: 'sent', attempts: 2 });
      expect(await attempts(e.eventId)).toMatchObject([
        { attempt: 1, error: 'lease_expired', http_status: null },
        { attempt: 2, http_status: 200 },
      ]);
    });

    it('shutdown while a claim is under way gives the rows back unsent and uncounted', async () => {
      const e = await enqueue();
      let reached!: () => void;
      const atGate = new Promise<void>((resolve) => { reached = resolve; });
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      let gated = false;
      const real = db.sql;
      const held = new Proxy(real, {
        get(target, property) {
          if (property !== 'begin') return Reflect.get(target, property, target);
          return (work: (tx: unknown) => Promise<unknown>) => target.begin(async (tx) => {
            const result = await work(tx);
            if (!gated) {
              gated = true;
              reached();
              await gate;
            }
            return result;
          });
        },
      });
      const d = dispatcher({ sql: held });
      d.wake();
      await atGate;
      const closing = d.close(5_000);
      open();
      await closing;
      expect(received).toHaveLength(0);
      const r = await row(e.eventId);
      expect(r).toMatchObject({ status: 'pending', attempts: 0, lease_token: null, destination: null });
      expect(r.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('never stores or logs anything from the answer body or the URL', async () => {
      const secretUrl = `${stubUrl}?token=urlSecretAlphaBeta`;
      const bodies = [
        `bad key ${API_KEY} ${'x'.repeat(4000)}`,
        `{"message":"x-api-key (base64): ${Buffer.from(API_KEY).toString('base64')}"}`,
        '{"error":{"code":"conflict","message":"seen urlSecretAlphaBeta"}}',
      ];
      handler = (_req, res, n) => { res.writeHead(n === 3 ? 409 : 500, { 'content-type': 'application/json' }).end(bodies[n - 1]); };
      const e = await enqueue();
      const log = silentLog();
      const d = dispatcher({
        log: log as never,
        destination: () => ({ slug: 'freecroco', environment: 'test', url: secretUrl, apiKey: API_KEY }),
      });
      for (let i = 0; i < bodies.length; i += 1) {
        if (i) await makeDue(e.eventId);
        await run(d);
      }
      expect(received).toHaveLength(3);
      expect(await attempts(e.eventId)).toEqual([
        { attempt: 1, http_status: 500, error: 'http_500' },
        { attempt: 2, http_status: 500, error: 'http_500' },
        { attempt: 3, http_status: 409, error: 'dead_conflict' },
      ]);
      const stored = JSON.stringify([
        await db.sql`SELECT * FROM partner_score_event_attempts`,
        await db.sql`SELECT * FROM partner_score_events`,
      ]);
      const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
      const base64Key = Buffer.from(API_KEY).toString('base64');
      for (const text of [stored, logged]) {
        expect(text).not.toContain(API_KEY);
        expect(text).not.toContain(base64Key);
        expect(text).not.toContain('urlSecretAlphaBeta');
        expect(text).not.toContain('conflict","message');
      }
    });

    it('an HTTP-date Retry-After is kept absolute', async () => {
      const at = new Date(Math.ceil((Date.now() + 120_000) / 1000) * 1000);
      handler = (_req, res) => { res.writeHead(429, { 'retry-after': at.toUTCString() }).end(); };
      const e = await enqueue();
      await run(dispatcher());
      const r = await row(e.eventId);
      expect(r.status).toBe('pending');
      expect(r.next_attempt_at.getTime()).toBe(at.getTime());
    });

    it('two dispatchers never send the same event, and at most 10 sends are in flight in total', { timeout: 120_000 }, async () => {
      handler = (_req, res) => { setTimeout(() => res.writeHead(200).end(), 150); };
      const events = [];
      for (let i = 0; i < 25; i += 1) events.push(await enqueue({ playerId: `p-${i}` }));
      const a = dispatcher();
      const b = dispatcher({ sql: sqlB! });
      for (let round = 0; round < 200; round += 1) {
        a.wake();
        b.wake();
        await Promise.all([a.idle(), b.idle()]);
        const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM partner_score_events WHERE status = 'sent'`;
        if (n === events.length) break;
      }
      const ids = received.map((r) => JSON.parse(r.body).eventId as string);
      expect(ids.sort()).toEqual(events.map((e) => e.eventId).sort());
      expect(new Set(ids).size).toBe(events.length);
      expect(maxInFlight).toBeLessThanOrEqual(10);
    });

    it('only the lease holder records an outcome', async () => {
      let answerA!: () => void;
      const heldA = new Promise<void>((resolve) => { answerA = resolve; });
      handler = (_req, res, n) => {
        if (n === 1) void heldA.then(() => res.writeHead(500).end());
        else res.writeHead(200).end();
      };
      const e = await enqueue();
      const logA = silentLog();
      const a = dispatcher({ timeoutMs: 60_000, leaseMs: 120_000, log: logA as never });
      const b = dispatcher({ sql: sqlB! });
      a.wake();
      await until(async () => received.length === 1);
      // A's lease runs out while it still waits; B takes the row over and delivers it.
      await db.sql`UPDATE partner_score_events SET lease_expires_at = now() - interval '1 second', next_attempt_at = now()
        WHERE event_id = ${e.eventId}`;
      await run(b);
      expect(await row(e.eventId)).toMatchObject({ status: 'sent', attempts: 2 });
      answerA();
      await a.idle();
      expect(await row(e.eventId)).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
      expect(logA.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/lease was taken over/));
      expect(await attempts(e.eventId)).toMatchObject([
        { attempt: 1, error: 'lease_expired', http_status: null },
        { attempt: 2, http_status: 200 },
      ]);
    });

    it('close() aborts a send in flight and leaves the event due at once', async () => {
      handler = () => { /* never answers */ };
      const e = await enqueue();
      const d = dispatcher({ timeoutMs: 5_000 });
      d.wake();
      await until(async () => received.length === 1);
      await d.close(10_000);
      const r = await row(e.eventId);
      expect(r).toMatchObject({ status: 'pending', last_error: 'aborted', lease_token: null });
      expect(r.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('resend, listings and health', () => {
    it('resend requeues the same event with the identical body, audited', async () => {
      handler = (_req, res, n) => { res.writeHead(n === 1 ? 400 : 200).end(); };
      const e = await enqueue();
      const d = dispatcher();
      await run(d);
      expect((await row(e.eventId)).status).toBe('dead');
      const [admin] = await db.sql`INSERT INTO users DEFAULT VALUES RETURNING id`;

      const result = await deliveries.resendPartnerScoreEvent({
        partnerSlug: 'freecroco', eventId: e.eventId, actorId: admin!.id, reason: 'partner asked',
      });
      expect(result).toEqual({ ok: true, eventId: e.eventId, status: 'pending' });
      const revived = await row(e.eventId);
      expect(revived).toMatchObject({ status: 'pending', destination: null });
      expect(revived.revived_at).toBeInstanceOf(Date);
      const [audit] = await db.sql`SELECT * FROM audit_logs`;
      expect(audit).toMatchObject({
        user_id: admin!.id, action: 'partner_score_event.resend', entity_type: 'partner_score_event', entity_id: e.playId,
      });
      expect(audit!.metadata).toMatchObject({ eventId: e.eventId, attempts: 1, reason: 'partner asked' });

      await run(d);
      expect(received).toHaveLength(2);
      expect(Buffer.from(received[1]!.body)).toEqual(Buffer.from(received[0]!.body));
      expect(JSON.parse(received[1]!.body).eventId).toBe(e.eventId);
      expect(await row(e.eventId)).toMatchObject({ status: 'sent', attempts: 2 });
      expect(await db.sql`SELECT 1 FROM partner_score_events`).toHaveLength(1);
    });

    it('resend rolls back when its audit row cannot be written', async () => {
      handler = (_req, res) => { res.writeHead(400).end(); };
      const e = await enqueue();
      await run(dispatcher());
      const before = await row(e.eventId);
      expect(before.status).toBe('dead');
      // An actor that is not a user: the audit insert fails its foreign key.
      await expect(deliveries.resendPartnerScoreEvent({
        partnerSlug: 'freecroco', eventId: e.eventId, actorId: randomUUID(),
      })).rejects.toThrow();
      expect(await row(e.eventId)).toMatchObject({ status: 'dead', revived_at: null, next_attempt_at: before.next_attempt_at });
      expect(await db.sql`SELECT 1 FROM audit_logs`).toHaveLength(0);
    });

    it('resend refuses an unknown event and any event that is not dead', async () => {
      const [admin] = await db.sql`INSERT INTO users DEFAULT VALUES RETURNING id`;
      expect(await deliveries.resendPartnerScoreEvent({
        partnerSlug: 'freecroco', eventId: `qb_${randomUUID()}`, actorId: admin!.id,
      })).toMatchObject({ ok: false, code: 'not_found' });
      const pending = await enqueue();
      expect(await deliveries.resendPartnerScoreEvent({
        partnerSlug: 'freecroco', eventId: pending.eventId, actorId: admin!.id,
      })).toMatchObject({ ok: false, code: 'not_resendable' });
      const sent = await enqueue();
      await run(dispatcher());
      expect((await row(sent.eventId)).status).toBe('sent');
      expect(await deliveries.resendPartnerScoreEvent({
        partnerSlug: 'freecroco', eventId: sent.eventId, actorId: admin!.id,
      })).toMatchObject({ ok: false, code: 'not_resendable' });
      expect(await db.sql`SELECT 1 FROM audit_logs`).toHaveLength(0);
    });

    it('lists deliveries newest first with filters and a cursor', async () => {
      const made = [];
      for (let i = 0; i < 5; i += 1) made.push(await enqueue({ playerId: i % 2 ? 'odd' : 'even', gameId: i < 3 ? 'ranked' : 'quiz-board' }));
      handler = (_req, res) => { res.writeHead(503).end(); };
      await run(dispatcher());
      const first = await deliveries.listPartnerDeliveries({ partnerSlug: 'freecroco', limit: 2 });
      expect(first.items.map((i) => i.eventId)).toEqual([made[4]!.eventId, made[3]!.eventId]);
      expect(first.items[0]).toMatchObject({ status: 'pending', attempts: 1, lastHttpStatus: 503, lastError: 'http_503' });
      expect(first.items[0]!.lastAttemptAt).toEqual(expect.any(String));
      const second = await deliveries.listPartnerDeliveries({ partnerSlug: 'freecroco', limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((i) => i.eventId)).toEqual([made[2]!.eventId, made[1]!.eventId]);
      const third = await deliveries.listPartnerDeliveries({ partnerSlug: 'freecroco', limit: 2, cursor: second.nextCursor! });
      expect(third.items.map((i) => i.eventId)).toEqual([made[0]!.eventId]);
      expect(third.nextCursor).toBeNull();
      const filtered = await deliveries.listPartnerDeliveries({ partnerSlug: 'freecroco', playerId: 'even', gameId: 'ranked' });
      expect(filtered.items.map((i) => i.eventId)).toEqual([made[2]!.eventId, made[0]!.eventId]);
      expect((await deliveries.listPartnerDeliveries({ partnerSlug: 'freecroco', status: 'sent' })).items).toHaveLength(0);
      const attemptList = await deliveries.listDeliveryAttempts('freecroco', made[0]!.eventId);
      expect(attemptList).toEqual([
        { attempt: 1, attemptedAt: expect.any(String), latencyMs: expect.any(Number), httpStatus: 503, error: 'http_503' },
      ]);
      expect(await deliveries.listDeliveryAttempts('freecroco', `qb_${randomUUID()}`)).toBeNull();
    });

    it('from/to are inclusive Asia/Tbilisi days on occurredAt', async () => {
      // 2026-10-07 in Tbilisi (UTC+4) runs from 2026-10-06T20:00Z to 2026-10-07T20:00Z.
      const before = await enqueue({ occurredAt: new Date('2026-10-06T19:59:59.999Z') });
      const first = await enqueue({ occurredAt: new Date('2026-10-06T20:00:00.000Z') });
      const last = await enqueue({ occurredAt: new Date('2026-10-07T19:59:59.999Z') });
      const after = await enqueue({ occurredAt: new Date('2026-10-07T20:00:00.000Z') });
      const day = await deliveries.listPartnerDeliveries({ partnerSlug: 'freecroco', from: '2026-10-07', to: '2026-10-07' });
      expect(day.items.map((i) => i.eventId)).toEqual([last.eventId, first.eventId]);
      const span = await deliveries.listPartnerDeliveries({ partnerSlug: 'freecroco', from: '2026-10-06', to: '2026-10-08' });
      expect(span.items.map((i) => i.eventId)).toEqual([after.eventId, last.eventId, first.eventId, before.eventId]);
    });

    it('me/results maps delivery state (dead shows as failed)', async () => {
      handler = (_req, res, n) => { res.writeHead(n === 1 ? 200 : 400).end(); };
      const sent = await enqueue({ playerId: 'me', occurredAt: new Date('2026-10-07T10:00:00.000Z') });
      await run(dispatcher());
      const dead = await enqueue({ playerId: 'me', occurredAt: new Date('2026-10-07T11:00:00.000Z'), gameId: 'pick-em', score: 250 });
      await run(dispatcher());
      const pending = await enqueue({ playerId: 'me', occurredAt: new Date('2026-10-07T12:00:00.000Z') });
      await enqueue({ playerId: 'someone-else' });
      const { results } = await deliveries.listRecentResultsForPlayer({ slug: 'freecroco', environment: 'test', externalPlayerId: 'me' }, 20);
      expect(results).toEqual([
        { playId: pending.playId, gameId: 'ranked', score: 150, finishedAt: '2026-10-07T12:00:00.000Z', delivery: 'pending' },
        { playId: dead.playId, gameId: 'pick-em', score: 250, finishedAt: '2026-10-07T11:00:00.000Z', delivery: 'failed' },
        { playId: sent.playId, gameId: 'ranked', score: 150, finishedAt: '2026-10-07T10:00:00.000Z', delivery: 'sent' },
      ]);
      expect((await deliveries.listRecentResultsForPlayer({ slug: 'freecroco', environment: 'test', externalPlayerId: 'me' }, 1)).results).toHaveLength(1);
    });

    it('delivery health: ok, then degraded past 5 minutes, down past an hour', async () => {
      expect(await deliveries.getScoreDeliveryHealth()).toEqual({ status: 'ok', pending: 0, oldestPendingSeconds: 0 });
      const e = await enqueue();
      expect(await deliveries.getScoreDeliveryHealth()).toMatchObject({ status: 'ok', pending: 1 });
      // revived_at is a delivery column, so it can stand in for an old event.
      await db.sql`UPDATE partner_score_events SET revived_at = now() - interval '6 minutes' WHERE event_id = ${e.eventId}`;
      expect(await deliveries.getScoreDeliveryHealth()).toMatchObject({ status: 'degraded', pending: 1 });
      await db.sql`UPDATE partner_score_events SET revived_at = now() - interval '61 minutes' WHERE event_id = ${e.eventId}`;
      const down = await deliveries.getScoreDeliveryHealth();
      expect(down.status).toBe('down');
      expect(down.oldestPendingSeconds).toBeGreaterThanOrEqual(3660);
    });
  });

  describe('Data API exposure', () => {
    it('anon, authenticated and service_role have no effective privilege on the delivery tables', async () => {
      const tables = ['partner_score_events', 'partner_score_event_attempts'];
      const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
      for (const role of ['anon', 'authenticated', 'service_role']) {
        // The simulated Supabase defaults do reach an ordinary new table.
        const [fixture] = await db.sql`SELECT has_table_privilege(${role}, 'public.audit_logs', 'SELECT') AS ok`;
        expect(fixture!.ok).toBe(true);
        for (const table of tables) {
          for (const privilege of privileges) {
            const [r] = await db.sql`SELECT has_table_privilege(${role}, ${`public.${table}`}, ${privilege}) AS ok`;
            expect(r!.ok, `${role} ${privilege} ${table}`).toBe(false);
          }
          for (const privilege of ['USAGE', 'SELECT', 'UPDATE']) {
            const [r] = await db.sql`SELECT has_sequence_privilege(${role}, ${`public.${table}_id_seq`}, ${privilege}) AS ok`;
            expect(r!.ok, `${role} ${privilege} ${table}_id_seq`).toBe(false);
          }
        }
        await expect(db.sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          await tx.unsafe('SELECT * FROM public.partner_score_events');
        })).rejects.toThrow(/permission denied/);
      }
      const rls = await db.sql`SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('partner_score_events', 'partner_score_event_attempts') ORDER BY relname`;
      expect(rls.map((r) => r.relrowsecurity)).toEqual([true, true]);
    });
  });

  describe('admin router', () => {
    const BASE = '/partner-admin/v1/partners/freecroco/deliveries';

    function app(authMw: RequestHandler, role = 'admin', userId?: string) {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        req.user = { id: userId, role } as never;
        next();
      });
      a.use(createPartnerDeliveryAdminRouter(authMw, { resendLimit: { windowMs: 60_000, max: 3 } }));
      return a;
    }
    const allow: RequestHandler = (_req, _res, next) => next();
    const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: { code: 'unauthorized', message: 'no' } }); };

    it('nothing is reachable without the auth middleware letting the request through', async () => {
      const a = app(deny);
      const e = await enqueue();
      expect((await request(a).get(BASE)).status).toBe(401);
      expect((await request(a).get(`${BASE}/${e.eventId}/attempts`)).status).toBe(401);
      expect((await request(a).post(`${BASE}/${e.eventId}/resend`)).status).toBe(401);
      expect((await row(e.eventId)).revived_at).toBeNull();
    });

    it('lists, shows attempts, validates queries, and resends for admins only (rate-limited)', async () => {
      const [admin] = await db.sql`INSERT INTO users DEFAULT VALUES RETURNING id`;
      const e = await enqueue();
      const a = app(allow, 'admin', admin!.id);
      const list = await request(a).get(BASE).query({ status: 'pending', limit: 10 });
      expect(list.status).toBe(200);
      expect(list.headers['cache-control']).toBe('no-store');
      expect(list.body.items[0]).toMatchObject({ eventId: e.eventId, status: 'pending', attempts: 0 });
      expect((await request(a).get(BASE).query({ status: 'weird' })).body).toEqual({
        error: { code: 'invalid_request', message: 'The request is not valid' },
      });
      expect((await request(a).get(BASE).query({ cursor: 'bogus!' })).status).toBe(400);
      expect((await request(a).get(`${BASE}/${e.eventId}/attempts`)).body).toEqual({ items: [] });
      expect((await request(a).get(BASE).query({ from: '2026-02-30' })).status).toBe(400);
      expect((await request(a).get(BASE).query({ from: '2026-10-08', to: '2026-10-07' })).status).toBe(400);
      expect((await request(a).get(BASE).query({ from: '2026-10-07', to: '2026-10-07' })).status).toBe(200);
      expect((await request(a).get(`${BASE}/qb_nope/attempts`)).status).toBe(404);

      const staff = app(allow, 'partner_staff', admin!.id);
      expect((await request(staff).post(`${BASE}/${e.eventId}/resend`)).status).toBe(403);

      const notDead = await request(a).post(`${BASE}/${e.eventId}/resend`);
      expect(notDead.status).toBe(409);
      expect(notDead.body.error.code).toBe('not_resendable');
      await db.sql`UPDATE partner_score_events SET status = 'dead', dead_at = now() WHERE event_id = ${e.eventId}`;
      const resent = await request(a).post(`${BASE}/${e.eventId}/resend`).send({ reason: 'check' });
      expect(resent.status).toBe(202);
      expect(resent.body).toEqual({ eventId: e.eventId, status: 'pending' });
      expect((await request(a).post(`${BASE}/qb_${randomUUID()}/resend`)).status).toBe(404);
      const limited = await request(a).post(`${BASE}/${e.eventId}/resend`);
      expect(limited.status).toBe(429);
      expect(await db.sql`SELECT 1 FROM audit_logs`).toHaveLength(1);
      expect(limited.body.error.code).toBe('rate_limited');
    });
  });
});
