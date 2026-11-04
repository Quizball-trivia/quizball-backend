import { randomUUID } from 'node:crypto';
import { sql } from '../../../../db/index.js';
import { logger } from '../../../../core/logger.js';
import { roomRepo } from '../../room.repo.js';
import { CARDS, legalDeck, type CardId } from './engine/zoneMatch.cards.js';
import type { ZoneMatchCommand, ZoneMatchContent, ZoneMatchView } from './zone-match.engine.js';
import type { QuizballServer } from '../../../../realtime/socket-server.js';

/**
 * The zone-match practice bot: one server-side player (a real users row, is_ai) seated by the lobby start when a host
 * plays alone (ZONE_MATCH_BOT_ENABLED). It plays through the same command path as a socket would — the engine
 * validates its moves like anyone's — but its driver lives in this process: a restart orphans the match and the
 * engine's idle forfeit ends it (the bot loses). Good enough for the beta; the queue bots come later.
 *
 * Skill: the driver reads the match content (it is the server), then deliberately answers at BOT_ACCURACY with
 * human-ish delays, so it neither stonewalls nor plays like an oracle.
 */

const BOT_NICKNAMES = ['Robo Keeper', 'Auto Libero', 'Circuit Striker', 'Servo Sweeper', 'Patch the Pivot'];
const BOT_ACCURACY = 0.62;
const TICK_MS = 1100;
const MAX_DRIVER_MS = 45 * 60 * 1000;

/**
 * One fresh bot user per match: room_seats has UNIQUE(user_id) WHERE active, so a shared identity would allow one
 * practice match in the whole system. 'ephemeral' keeps it out of every persistent-AI roster (Weekend League picks
 * ai_kind='persistent' bots straight off the users table).
 */
export async function createZoneBotUser(): Promise<string> {
  const id = randomUUID();
  const nickname = BOT_NICKNAMES[Math.floor(Math.random() * BOT_NICKNAMES.length)];
  await sql`INSERT INTO users (id, nickname, is_ai, ai_kind, onboarding_complete) VALUES (${id}, ${nickname}, true, 'ephemeral', true)`;
  return id;
}

/** A random legal loadout (driver code: ordinary randomness, not the match's seeded chance). */
function randomLoadout(): CardId[] {
  const pool = [...CARDS.map((card) => card.id)];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picks: CardId[] = [];
  for (const id of pool) {
    const next = [...picks, id];
    if (legalDeck(next).length === next.length) picks.push(id);
    if (picks.length === 3) break;
  }
  return picks;
}

interface Driver {
  timer: ReturnType<typeof setTimeout> | null;
  /** Question key → when the planned answer goes in (a human-ish delay from when the bot first saw it). */
  planned: Map<string, number>;
  startedAt: number;
}
const drivers = new Map<string, Driver>();

const delay = (minMs: number, maxMs: number) => minMs + Math.random() * (maxMs - minMs);

function decide(view: ZoneMatchView, content: ZoneMatchContent, d: Driver, now: number): ZoneMatchCommand | null {
  if (view.phase === 'loadout') {
    if (view.loadoutIn.you) return null;
    const key = 'loadout';
    const at = d.planned.get(key) ?? d.planned.set(key, now + delay(1500, 5000)).get(key)!;
    return now >= at ? { type: 'loadout', cards: randomLoadout() } : null;
  }
  if (view.phase !== 'match') return null;
  const m = view.match;
  if (m.stage === 'play' && m.battleStep === 'category' && m.possession.attacker === 'player') {
    const open = m.categories.player.filter((c) => !m.usedCategories.player.includes(c.id));
    if (open.length === 0) return null;
    const key = `cat-${m.round}`;
    const at = d.planned.get(key) ?? d.planned.set(key, now + delay(1200, 4000)).get(key)!;
    return now >= at ? { type: 'category', round: m.round, categoryId: open[Math.floor(Math.random() * open.length)].id } : null;
  }
  if (m.stage === 'play' && m.battleStep === 'cards' && m.choice.player === undefined) {
    const key = `card-${m.duelNo}`;
    const at = d.planned.get(key) ?? d.planned.set(key, now + delay(1000, 3500)).get(key)!;
    if (now < at) return null;
    // Mostly passes; sometimes tries a card it still holds — an illegal one just comes back 'rejected'.
    const held = m.deck.player.filter((id) => !m.used.player.includes(id));
    const card = Math.random() < 0.35 && held.length > 0 ? held[Math.floor(Math.random() * held.length)] : null;
    return { type: 'card', duel: m.duelNo, card };
  }
  if ((m.stage === 'play' || m.stage === 'shootout') && m.battleStep === 'mcq' && m.mcq && m.mcq.answers.player === null && view.question) {
    const key = `mcq-${m.mcq.key}`;
    const at = d.planned.get(key) ?? d.planned.set(key, now + delay(2000, Math.max(2500, m.mcq.deadline - now - 1500))).get(key)!;
    if (now < at) return null;
    // The view hides the right answer; being the server, the bot looks it up — then plays at its skill, not as an oracle.
    const pack = content.mcqs.find((q) => (q.prompt.en ?? Object.values(q.prompt)[0]) === view.question!.prompt);
    const hidden = m.mcq.hidden.player;
    const open = [0, 1, 2, 3].filter((i) => !hidden.includes(i));
    let index = open[Math.floor(Math.random() * open.length)];
    if (pack && Math.random() < BOT_ACCURACY) index = pack.correctIndex;
    else if (pack && open.length > 1 && index === pack.correctIndex) index = open.find((i) => i !== pack.correctIndex) ?? index;
    return { type: 'answer', key: m.mcq.key, index };
  }
  if (m.stage === 'play' && m.battleStep === 'numeric' && m.numeric && !m.numeric.result && m.numeric.guesses.player.value === null) {
    const key = `num-${m.numeric.key}`;
    const at = d.planned.get(key) ?? d.planned.set(key, now + delay(2500, 9000)).get(key)!;
    if (now < at) return null;
    const prompt = m.numeric.question.prompt.en ?? Object.values(m.numeric.question.prompt)[0];
    const pack = content.numerics.find((q) => (q.prompt.en ?? Object.values(q.prompt)[0]) === prompt);
    const base = pack ? pack.value : 50;
    const step = pack?.step ?? 1;
    const noisy = base * (1 + (Math.random() - 0.5) * 0.35);
    const value = Math.round(noisy / step) * step;
    return { type: 'guess', key: m.numeric.key, value: Number(value.toFixed(3)) };
  }
  return null;
}

/** Drives the bot's seat until the match ends; one driver per match, in this process only. */
export function startZoneMatchBot(io: QuizballServer, matchId: string, botUserId: string): void {
  if (drivers.has(matchId)) return;
  const d: Driver = { timer: null, planned: new Map(), startedAt: Date.now() };
  drivers.set(matchId, d);
  const stop = () => {
    if (d.timer) clearTimeout(d.timer);
    drivers.delete(matchId);
  };
  const step = async () => {
    try {
      if (Date.now() - d.startedAt > MAX_DRIVER_MS) return stop();
      // Loaded lazily (like the registry's deal): this module is imported before any database is configured.
      const [{ roomService }, { roomRealtimeService }] = await Promise.all([
        import('../../room.service.js'),
        import('../../../../realtime/services/room-realtime.service.js'),
      ]);
      const snap = await roomService.snapshot(matchId, botUserId);
      if (!snap || snap.status === 'completed' || snap.status === 'cancelled') return stop();
      const view = snap.view as ZoneMatchView | null;
      if (snap.status === 'active' && view) {
        const content = (await roomRepo.getContent(undefined, matchId)) as ZoneMatchContent | null;
        const cmd = content ? decide(view, content, d, Date.now()) : null;
        if (cmd) {
          const { result, effects } = await roomService.command(matchId, botUserId, randomUUID(), cmd);
          // The human's screens hear of the bot's move the way they hear of anyone's: snapshots and timer effects.
          if (effects) await roomRealtimeService.deliver(io, effects);
          if (!result.ok && result.code !== 'stale' && result.code !== 'rejected') {
            logger.debug({ matchId, code: result.code, cmd: cmd.type }, 'Zone bot command refused');
          }
        }
      }
    } catch (error) {
      logger.warn({ matchId, error }, 'Zone bot step failed');
    }
    d.timer = setTimeout(step, TICK_MS + Math.random() * 400);
  };
  d.timer = setTimeout(step, TICK_MS);
  logger.info({ matchId, botUserId }, 'Zone bot driver started');
}
