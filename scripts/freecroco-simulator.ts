/**
 * Local fake of Freecroco's score-events endpoint (contract v1.1 §6), for exercising partner score delivery.
 * Never point it at, or run it against, anything but your own machine.
 *
 * Usage:
 *   npx tsx scripts/freecroco-simulator.ts [--port=4610] [--api-key=<key>] [--path=/v1/integrations/quizball/score-events]
 *     [--fail-rate=0.2]      answer 500 to this share of new events
 *     [--timeout-rate=0.1]   never answer this share of requests (the sender's 10 s timeout fires)
 *     [--status=500]         answer every request with this status (e.g. 500, 429, 503, 400, 409)
 *     [--retry-after=30]     Retry-After seconds sent with 429 / 503
 *     [--no-day-cutoff]      credit events whose Tbilisi day has already closed
 *     [--cert=localhost.pem --key=localhost-key.pem]   serve HTTPS
 *
 * The key defaults to FREECROCO_SIM_API_KEY, else `local-simulator-key`. Requests without the right `x-api-key`
 * get 401.
 *
 * The backend only accepts an https:// webhook URL (partner-config.ts), so for an end-to-end run serve HTTPS with a
 * locally trusted certificate, e.g. `mkcert localhost 127.0.0.1`, then start the backend with
 *   NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
 *   PARTNER_FREECROCO_CONFIG='{"slug":"freecroco","environment":"test","inboundKeySha256":["<64 hex>"],
 *     "launchBaseUrl":"http://localhost:3000",
 *     "webhook":{"url":"https://localhost:4610/v1/integrations/quizball/score-events","apiKey":"local-simulator-key"}}'
 *
 * Behaviour (what we ask of Freecroco): a new eventId is stored and credited, then 200. A repeated eventId with the
 * same body gets 200 and is not credited again; with a different body, 409. Points count on the Asia/Tbilisi day of
 * occurredAt; an event arriving after its day closed gets 200 and is not credited. The daily and weekly
 * leaderboards are kept in memory and printed after every credit and on Ctrl-C.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';

const GAME_IDS = new Set([
  'ranked', 'countdown', 'true-false', 'pick-em', 'career-path', 'higher-lower',
  'card-detective', 'guess-the-goal', 'road-to-goal', 'trivia-mines', 'quiz-board',
]);
const BODY_KEYS = ['eventId', 'gameId', 'occurredAt', 'playerId', 'score', 'sessionId'];
const EVENT_ID = /^qb_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAYER_ID = /^[A-Za-z0-9._:@-]{1,64}$/;
const ISO_MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(prefix));
  if (!hit) return undefined;
  return hit === `--${name}` ? 'true' : hit.slice(prefix.length);
}

const rate = (name: string) => {
  const value = Number(flag(name) ?? 0);
  if (!(value >= 0 && value <= 1)) throw new Error(`--${name} must be between 0 and 1`);
  return value;
};

const port = Number(flag('port') ?? 4610);
const apiKey = flag('api-key') ?? process.env.FREECROCO_SIM_API_KEY ?? 'local-simulator-key';
const path = flag('path') ?? '/v1/integrations/quizball/score-events';
const failRate = rate('fail-rate');
const timeoutRate = rate('timeout-rate');
const forcedStatus = flag('status') ? Number(flag('status')) : null;
const retryAfter = flag('retry-after');
const dayCutoff = flag('no-day-cutoff') === undefined;
const cert = flag('cert');
const key = flag('key');

interface StoredEvent {
  body: string;
  credited: boolean;
}

const events = new Map<string, StoredEvent>();
const daily = new Map<string, Map<string, number>>();
const weekly = new Map<string, Map<string, number>>();
const hung = new Set<ServerResponse>();

const tbilisiDay = (at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at);

/** Monday of the Tbilisi week, as YYYY-MM-DD. */
function tbilisiWeek(at: Date): string {
  const day = new Date(`${tbilisiDay(at)}T00:00:00Z`);
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString().slice(0, 10);
}

function credit(board: Map<string, Map<string, number>>, period: string, playerId: string, score: number) {
  const scores = board.get(period) ?? new Map<string, number>();
  scores.set(playerId, (scores.get(playerId) ?? 0) + score);
  board.set(period, scores);
}

function printBoards() {
  const show = (title: string, board: Map<string, Map<string, number>>) => {
    for (const [period, scores] of [...board].sort(([a], [b]) => a.localeCompare(b))) {
      const rows = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20);
      console.log(`\n${title} ${period}`);
      rows.forEach(([player, points], i) => console.log(`  ${String(i + 1).padStart(2)}. ${player.padEnd(30)} ${points}`));
    }
  };
  show('Daily', daily);
  show('Weekly from', weekly);
  console.log('');
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function invalid(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(',') !== BODY_KEYS.join(',')) return `fields must be exactly ${BODY_KEYS.join(', ')}`;
  if (typeof b.eventId !== 'string' || !EVENT_ID.test(b.eventId)) return 'eventId';
  if (typeof b.sessionId !== 'string' || !UUID.test(b.sessionId)) return 'sessionId';
  if (typeof b.playerId !== 'string' || !PLAYER_ID.test(b.playerId)) return 'playerId';
  if (typeof b.gameId !== 'string' || !GAME_IDS.has(b.gameId)) return 'gameId';
  if (typeof b.occurredAt !== 'string' || !ISO_MS_UTC.test(b.occurredAt) || Number.isNaN(Date.parse(b.occurredAt))) {
    return 'occurredAt (UTC ISO 8601 with milliseconds)';
  }
  if (typeof b.score !== 'number' || !Number.isInteger(b.score) || b.score < 0) return 'score';
  return null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const raw = await readBody(req).catch(() => null);
  const log = (status: number | 'hang', note = '') =>
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${status}${note ? ` ${note}` : ''} ${raw ?? ''}`);

  if (req.method !== 'POST' || req.url !== path) {
    log(404);
    return reply(res, 404, { error: 'not_found' });
  }
  if (req.headers['x-api-key'] !== apiKey) {
    log(401, '(bad x-api-key)');
    return reply(res, 401, { error: 'unknown_key' });
  }
  if (Math.random() < timeoutRate) {
    log('hang');
    hung.add(res);
    res.on('close', () => hung.delete(res));
    return;
  }
  if (forcedStatus) {
    log(forcedStatus, '(forced)');
    return reply(res, forcedStatus, { error: 'forced' }, retryAfter ? { 'retry-after': retryAfter } : {});
  }
  let body: unknown;
  try {
    body = JSON.parse(raw ?? '');
  } catch {
    log(400, '(not JSON)');
    return reply(res, 400, { error: 'invalid_json' });
  }
  const problem = invalid(body);
  if (problem) {
    log(400, `(invalid: ${problem})`);
    return reply(res, 400, { error: 'invalid_request', field: problem });
  }
  const event = body as { eventId: string; playerId: string; occurredAt: string; score: number };
  const canonical = JSON.stringify(Object.fromEntries(BODY_KEYS.map((k) => [k, (body as Record<string, unknown>)[k]])));
  const seen = events.get(event.eventId);
  if (seen) {
    if (seen.body !== canonical) {
      log(409, '(same eventId, different body)');
      return reply(res, 409, { error: 'event_conflict' });
    }
    log(200, '(duplicate, not credited again)');
    return reply(res, 200, { status: 'duplicate' });
  }
  if (Math.random() < failRate) {
    log(500, '(chaos)');
    return reply(res, 500, { error: 'chaos' });
  }
  const at = new Date(event.occurredAt);
  const late = dayCutoff && tbilisiDay(at) < tbilisiDay(new Date());
  events.set(event.eventId, { body: canonical, credited: !late });
  if (late) {
    log(200, '(day closed, not credited)');
    return reply(res, 200, { status: 'late' });
  }
  credit(daily, tbilisiDay(at), event.playerId, event.score);
  credit(weekly, tbilisiWeek(at), event.playerId, event.score);
  log(200, `(credited ${event.score})`);
  reply(res, 200, { status: 'credited' });
  printBoards();
}

const listener = (req: IncomingMessage, res: ServerResponse) => {
  handle(req, res).catch((error) => {
    console.error('handler failed', error);
    if (!res.headersSent) reply(res, 500, { error: 'simulator_error' });
  });
};

const server = cert && key
  ? createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, listener)
  : createHttpServer(listener);

server.listen(port, '127.0.0.1', () => {
  const scheme = cert && key ? 'https' : 'http';
  console.log(`Freecroco simulator on ${scheme}://127.0.0.1:${port}${path}`);
  console.log(`  fail-rate=${failRate} timeout-rate=${timeoutRate} status=${forcedStatus ?? '-'} day-cutoff=${dayCutoff}`);
});

process.on('SIGINT', () => {
  printBoards();
  console.log(`${events.size} distinct events received`);
  for (const res of hung) res.destroy();
  server.close(() => process.exit(0));
});
