import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CARDS_PER_ROUND, ROUNDS_PER_DAY, TARGETS_PER_ROUND } from './buscaminas.constants.js';
import type { BuscaminasDayContent } from './buscaminas.types.js';

/** The answers ship only in this form: the backend repo is public. */
export interface SealedContent {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

export const CONTENT_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyBytes(keyHex: string): Buffer {
  if (!CONTENT_KEY_PATTERN.test(keyHex)) throw new Error('BUSCAMINAS_CONTENT_KEY must be 64 hex characters');
  return Buffer.from(keyHex, 'hex');
}

/** Validates one day and keeps only what the server needs (ids and the ok flags). */
export function parseDay(label: string, raw: unknown): BuscaminasDayContent {
  const fail = (msg: string): never => { throw new Error(`${label}: ${msg}`); };
  const d = (raw ?? {}) as { day?: unknown; number?: unknown; contentVersion?: unknown; rounds?: unknown };
  if (typeof d.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.day)) fail('day must be YYYY-MM-DD');
  if (!Number.isInteger(d.number)) fail('number must be an integer');
  const contentVersion = d.contentVersion;
  if (!Number.isInteger(contentVersion) || (contentVersion as number) < 1 || (contentVersion as number) > 2 ** 32) fail('contentVersion must be present and an integer in 1..2^32');
  if (!Array.isArray(d.rounds) || d.rounds.length !== ROUNDS_PER_DAY) fail(`expected ${ROUNDS_PER_DAY} rounds`);
  const roundIds = new Set<string>();
  const rounds = (d.rounds as Array<{ id?: unknown; cards?: unknown }>).map((round, i) => {
    if (typeof round?.id !== 'string' || !round.id) fail(`round ${i}: missing id`);
    if (roundIds.has(round.id as string)) fail(`round ${i}: duplicate id ${String(round.id)}`);
    roundIds.add(round.id as string);
    if (!Array.isArray(round.cards) || round.cards.length !== CARDS_PER_ROUND) fail(`round ${i}: expected ${CARDS_PER_ROUND} cards`);
    const ids = new Set<string>();
    const cards = (round.cards as Array<{ id?: unknown; ok?: unknown }>).map((card, j) => {
      if (typeof card?.id !== 'string' || !card.id) fail(`round ${i} card ${j}: missing id`);
      if (typeof card.ok !== 'boolean') fail(`round ${i} card ${j}: missing ok (answers stripped?)`);
      if (ids.has(card.id as string)) fail(`round ${i}: duplicate card ${String(card.id)}`);
      ids.add(card.id as string);
      return { id: card.id as string, ok: card.ok as boolean };
    });
    if (cards.filter((c) => c.ok).length !== TARGETS_PER_ROUND) fail(`round ${i}: expected ${TARGETS_PER_ROUND} correct cards`);
    return { id: round.id as string, cards };
  });
  return { day: d.day as string, number: d.number as number, contentVersion: contentVersion as number, rounds };
}

export function sealContent(days: readonly BuscaminasDayContent[], keyHex: string): SealedContent {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(keyHex), iv, { authTagLength: TAG_BYTES });
  const data = Buffer.concat([cipher.update(JSON.stringify(days), 'utf8'), cipher.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function openContent(sealed: SealedContent, keyHex: string): BuscaminasDayContent[] {
  if (sealed?.v !== 1 || sealed.alg !== 'aes-256-gcm') throw new Error('unsupported sealed content envelope');
  const iv = Buffer.from(sealed.iv, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed sealed content envelope');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(keyHex), iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  let text: string;
  try {
    text = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('decryption failed: wrong BUSCAMINAS_CONTENT_KEY or tampered content');
  }
  let days: unknown;
  try {
    days = JSON.parse(text);
  } catch {
    // Newer V8 messages quote the input; decrypted answers must never reach a log.
    throw new Error('decrypted content is not valid JSON');
  }
  if (!Array.isArray(days) || days.length === 0) throw new Error('decrypted content is not a list of days');
  return days.map((day, i) => parseDay(`day ${i}`, day));
}
