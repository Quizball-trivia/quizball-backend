import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST, manifestFromCopies } from '../../scripts/zone-engine-parity.js';

/**
 * The engine copies must stay byte-identical with the web's (import paths apart): the server settles matches the
 * client predicts. A failure here means an engine file changed without `npx tsx scripts/zone-engine-parity.ts --web
 * <web-repo> --write` — sync the other repo's copy and regenerate both PARITY.json files together.
 */
describe('zone-match engine parity', () => {
  it('normalized copies match the committed manifest', () => {
    const root = resolve(import.meta.dirname, '../..');
    const committed = JSON.parse(readFileSync(resolve(root, MANIFEST), 'utf8')) as Record<string, string>;
    expect(manifestFromCopies(root)).toEqual(committed);
  });
});
