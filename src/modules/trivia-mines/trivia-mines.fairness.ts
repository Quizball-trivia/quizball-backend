import { createHash, createHmac, randomBytes } from 'crypto';
import { BOARD_SIZE, DEFENDERS, FAIRNESS_VERSION } from './trivia-mines.constants.js';

/**
 * Commit-reveal fairness for the board.
 *
 * At start the server commits to SHA256(serverSeed); the client may pass a
 * nonce after seeing the commitment. The 4 defender tiles are drawn without
 * replacement from HMAC_SHA256(serverSeed, `${roundId}:${nonce}:v1:defender:${n}`)
 * with rejection sampling, so the board is fixed before the first pick and
 * verifiable once the seed is revealed at settlement.
 */
export function newServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function commitmentFor(serverSeed: string): string {
  return createHash('sha256').update(serverSeed).digest('hex');
}

export function boardHmacInput(roundId: string, clientNonce: string | null): string {
  return `${roundId}:${clientNonce ?? ''}:v${FAIRNESS_VERSION}`;
}

function uniformIndex(seed: string, input: string, modulo: number): number {
  const limit = Math.floor(0x1_0000_0000 / modulo) * modulo;
  let counter = 0;
  for (;;) {
    const digest = createHmac('sha256', seed).update(`${input}:${counter}`).digest();
    for (let offset = 0; offset + 4 <= digest.length; offset += 4) {
      const value = digest.readUInt32BE(offset);
      if (value < limit) return value % modulo;
    }
    counter += 1;
  }
}

/** The 4 defender tiles (0–24), sorted, derived from the seed and the board input. */
export function defendersFromSeed(serverSeed: string, hmacInput: string): number[] {
  const tiles: number[] = [];
  let n = 0;
  while (tiles.length < DEFENDERS) {
    const tile = uniformIndex(serverSeed, `${hmacInput}:defender:${n}`, BOARD_SIZE);
    if (!tiles.includes(tile)) tiles.push(tile);
    n += 1;
  }
  return tiles.sort((a, b) => a - b);
}

/** Which still-hidden defender a successful scout reveals (deterministic per scout number). */
export function scoutRevealFromSeed(serverSeed: string, hmacInput: string, scoutNumber: number, hidden: number[]): number {
  return hidden[uniformIndex(serverSeed, `${hmacInput}:scout:${scoutNumber}`, hidden.length)];
}
