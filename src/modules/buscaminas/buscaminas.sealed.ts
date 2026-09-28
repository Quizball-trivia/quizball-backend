import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CARDS_PER_ROUND, ROUNDS_PER_DAY, TARGETS_PER_ROUND } from './buscaminas.constants.js';
import { BUSCAMINAS_DIFFICULTIES, BUSCAMINAS_LOCALES, type BuscaminasDayContent, type BuscaminasDifficulty } from './buscaminas.types.js';

/** The boards and their answers ship only in this form: the backend repo is public. `data` is gzip(JSON), then AES-256-GCM. */
export interface SealedContent {
  v: 2;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

export const CONTENT_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Card art is served by the web from this directory only. */
const CARD_IMG = /^\/buscaminas\/v1\/p\/[A-Za-z0-9_-]+\.[a-z0-9]+$/;

const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyBytes(keyHex: string): Buffer {
  if (!CONTENT_KEY_PATTERN.test(keyHex)) throw new Error('BUSCAMINAS_CONTENT_KEY must be 64 hex characters');
  return Buffer.from(keyHex, 'hex');
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Validates one day and keeps exactly the board fields plus the ok flags (unknown fields are dropped). */
export function parseDay(label: string, raw: unknown): BuscaminasDayContent {
  const fail = (msg: string): never => { throw new Error(`${label}: ${msg}`); };
  const d = (raw ?? {}) as { day?: unknown; number?: unknown; contentVersion?: unknown; rounds?: unknown };
  if (typeof d.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.day)) fail('day must be YYYY-MM-DD');
  if (!Number.isInteger(d.number)) fail('number must be an integer');
  const contentVersion = d.contentVersion;
  if (!Number.isInteger(contentVersion) || (contentVersion as number) < 1 || (contentVersion as number) > 2 ** 32) fail('contentVersion must be present and an integer in 1..2^32');
  if (!Array.isArray(d.rounds) || d.rounds.length !== ROUNDS_PER_DAY) fail(`expected ${ROUNDS_PER_DAY} rounds`);
  const roundIds = new Set<string>();
  const rounds = (d.rounds as Array<{ id?: unknown; difficulty?: unknown; prompt?: unknown; cards?: unknown }>).map((round, i) => {
    if (typeof round?.id !== 'string' || !round.id) fail(`round ${i}: missing id`);
    if (roundIds.has(round.id as string)) fail(`round ${i}: duplicate id ${String(round.id)}`);
    roundIds.add(round.id as string);
    if (!BUSCAMINAS_DIFFICULTIES.includes(round.difficulty as BuscaminasDifficulty)) fail(`round ${i}: difficulty must be one of ${BUSCAMINAS_DIFFICULTIES.join('/')}`);
    const prompt = (round.prompt ?? {}) as Record<string, unknown>;
    for (const locale of BUSCAMINAS_LOCALES) if (!nonEmpty(prompt[locale])) fail(`round ${i}: prompt.${locale} missing`);
    if (!Array.isArray(round.cards) || round.cards.length !== CARDS_PER_ROUND) fail(`round ${i}: expected ${CARDS_PER_ROUND} cards`);
    const ids = new Set<string>();
    const cards = (round.cards as Array<{ id?: unknown; name?: unknown; img?: unknown; ok?: unknown }>).map((card, j) => {
      if (typeof card?.id !== 'string' || !card.id) fail(`round ${i} card ${j}: missing id`);
      if (!nonEmpty(card.name)) fail(`round ${i} card ${j}: missing name`);
      if (typeof card.img !== 'string' || !CARD_IMG.test(card.img)) fail(`round ${i} card ${j}: img must be a file under /buscaminas/v1/p/`);
      if (typeof card.ok !== 'boolean') fail(`round ${i} card ${j}: missing ok (answers stripped?)`);
      if (ids.has(card.id as string)) fail(`round ${i}: duplicate card ${String(card.id)}`);
      ids.add(card.id as string);
      return { id: card.id as string, name: card.name as string, img: card.img as string, ok: card.ok as boolean };
    });
    if (cards.filter((c) => c.ok).length !== TARGETS_PER_ROUND) fail(`round ${i}: expected ${TARGETS_PER_ROUND} correct cards`);
    return {
      id: round.id as string,
      difficulty: round.difficulty as BuscaminasDifficulty,
      prompt: { es: prompt.es as string, en: prompt.en as string, ka: prompt.ka as string, tr: prompt.tr as string },
      cards,
    };
  });
  return { day: d.day as string, number: d.number as number, contentVersion: contentVersion as number, rounds };
}

export function sealContent(days: readonly BuscaminasDayContent[], keyHex: string): SealedContent {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(keyHex), iv, { authTagLength: TAG_BYTES });
  const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(days), { level: 9 })), cipher.final()]);
  return { v: 2, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function openContent(sealed: SealedContent, keyHex: string): BuscaminasDayContent[] {
  if (sealed?.v !== 2 || sealed.alg !== 'aes-256-gcm') throw new Error('unsupported sealed content envelope');
  const iv = Buffer.from(sealed.iv, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed sealed content envelope');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(keyHex), iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  let packed: Buffer;
  try {
    packed = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
  } catch {
    throw new Error('decryption failed: wrong BUSCAMINAS_CONTENT_KEY or tampered content');
  }
  let days: unknown;
  try {
    days = JSON.parse(gunzipSync(packed).toString('utf8'));
  } catch {
    // Newer V8 messages quote the input; decrypted answers must never reach a log.
    throw new Error('decrypted content is not valid gzipped JSON');
  }
  if (!Array.isArray(days) || days.length === 0) throw new Error('decrypted content is not a list of days');
  return days.map((day, i) => parseDay(`day ${i}`, day));
}
