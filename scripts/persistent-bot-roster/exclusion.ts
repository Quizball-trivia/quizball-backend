/**
 * Salted-hash exclusion set (CodeRabbit privacy fix). The committed artifact
 * never contains plaintext nicknames — only sha256(salt + nfcLower(name)). The
 * generator and the creation script test membership by hashing a candidate the
 * same way and looking it up. A random salt is committed alongside; it only
 * prevents casual bulk reading (targeted membership testing IS the feature).
 */

import { createHash } from 'node:crypto';

import type { RosterPatterns } from './patterns.js';

/** Canonical form used for all case-insensitive nickname comparisons. */
export function nfcLower(name: string): string {
  // NFC first, then locale-independent lowercase (never toLocaleLowerCase —
  // Turkish-i / Mtavruli hazards).
  return name.normalize('NFC').toLowerCase();
}

/** Salted hash of one already-canonicalized-or-raw name. */
export function hashName(salt: string, name: string): string {
  return createHash('sha256').update(salt).update('\0').update(nfcLower(name)).digest('hex');
}

/** Digest over the sorted hash list — the stable content id of the set. */
export function exclusionDigest(sortedHashes: string[]): string {
  return createHash('sha256').update(sortedHashes.join('\n')).digest('hex');
}

/**
 * Build the committed exclusion object from plaintext names (measure-time only;
 * plaintext stays in memory here and is never returned). Names are NFC-lowered,
 * hashed, deduped, and sorted.
 */
export function buildExclusion(names: string[], salt: string): RosterPatterns['exclusion'] {
  const set = new Set<string>();
  for (const n of names) {
    if (n == null) continue;
    set.add(hashName(salt, n));
  }
  const hashes = [...set].sort();
  return {
    count: hashes.length,
    algorithm: 'sha256(salt+nfcLower)',
    salt,
    sha256: exclusionDigest(hashes),
    hashes,
  };
}

/** A membership tester over the committed hashed exclusion set. */
export function exclusionMembership(exclusion: RosterPatterns['exclusion']): {
  has: (name: string) => boolean;
  set: Set<string>;
} {
  const set = new Set(exclusion.hashes);
  const salt = exclusion.salt;
  return {
    set,
    has: (name: string) => set.has(hashName(salt, name)),
  };
}
