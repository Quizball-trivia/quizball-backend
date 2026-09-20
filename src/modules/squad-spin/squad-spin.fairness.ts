import { createHash, createHmac, randomBytes } from 'crypto';
import { FAIRNESS_VERSION } from './squad-spin.constants.js';

/**
 * Commit-reveal for the reels. At start the server commits to SHA256(serverSeed);
 * the combo dealt for spin n is the HMAC_SHA256(serverSeed, `${roundId}:${nonce}:v1:spin:${n}:${attempt}`)
 * index into the active combo list for the run's reel count, so the server cannot
 * steer a run towards harder combos once it has committed, and the whole sequence
 * is verifiable when the seed is revealed at settlement.
 */
export function newServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function commitmentFor(serverSeed: string): string {
  return createHash('sha256').update(serverSeed).digest('hex');
}

export function roundHmacInput(roundId: string, clientNonce: string | null): string {
  return `${roundId}:${clientNonce ?? ''}:v${FAIRNESS_VERSION}`;
}

export function uniformIndex(seed: string, input: string, modulo: number): number {
  if (modulo <= 0) throw new Error('Empty range');
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

export function comboOffsetFromSeed(serverSeed: string, hmacInput: string, spinIndex: number, attempt: number, comboCount: number): number {
  return uniformIndex(serverSeed, `${hmacInput}:spin:${spinIndex}:${attempt}`, comboCount);
}
