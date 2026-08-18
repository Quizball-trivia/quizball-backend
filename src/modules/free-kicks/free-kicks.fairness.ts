import { createHash, createHmac, randomBytes } from 'crypto';
import { OPEN_ORDER, ZONE_ORDER_VERSION, type FreeKicksZone } from './free-kicks.constants.js';

/**
 * Commit-reveal fairness for the keeper.
 *
 * Before the attack the server commits to SHA256(serverSeed). The client may
 * supply a nonce AFTER seeing the commitment, so the house cannot grind seeds
 * toward a player's zone habits. At shoot time with k open zones:
 *
 *   keeperIndex = HMAC_SHA256(serverSeed, `${roundId}:${attack}:${k}:${nonce}:v1`) mod k
 *
 * The player's picked zone is NOT an input — the keeper cannot chase the pick.
 * Modulo bias is removed with rejection sampling over 4-byte windows.
 */

export function newServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function commitmentFor(serverSeed: string): string {
  return createHash('sha256').update(serverSeed).digest('hex');
}

export function keeperHmacInput(
  roundId: string,
  attack: number,
  openCount: number,
  clientNonce: string | null
): string {
  return `${roundId}:${attack}:${openCount}:${clientNonce ?? ''}:v${ZONE_ORDER_VERSION}`;
}

function uniformIndex(seed: string, input: string, modulo: number): number {
  if (!Number.isInteger(modulo) || modulo < 1 || modulo > 64) {
    throw new Error(`Invalid modulo for keeper derivation: ${modulo}`);
  }
  let digest = createHmac('sha256', seed).update(input).digest();
  const limit = Math.floor(0x1_0000_0000 / modulo) * modulo;
  let counter = 0;
  for (;;) {
    for (let offset = 0; offset + 4 <= digest.length; offset += 4) {
      const value = digest.readUInt32BE(offset);
      if (value < limit) return value % modulo;
    }
    counter += 1;
    digest = createHmac('sha256', seed).update(`${input}:${counter}`).digest();
  }
}

export function keeperZoneFromSeed(
  serverSeed: string,
  hmacInput: string,
  openCount: number
): { zone: FreeKicksZone; index: number } {
  const index = uniformIndex(serverSeed, hmacInput, openCount);
  return { zone: OPEN_ORDER[index], index };
}

/** Anyone can re-derive a shot from the revealed inputs. */
export function verifyShot(input: {
  serverSeed: string;
  commitHash: string;
  hmacInput: string;
  openCount: number;
  keeperZone: string;
}): boolean {
  if (commitmentFor(input.serverSeed) !== input.commitHash) return false;
  return keeperZoneFromSeed(input.serverSeed, input.hmacInput, input.openCount).zone === input.keeperZone;
}
