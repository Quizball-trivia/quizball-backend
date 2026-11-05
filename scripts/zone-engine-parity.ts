/**
 * The zone-match engine lives twice: the web's authoritative copy (src/features/zone-match + numericDuel) and this
 * repo's byte-identical copy under src/modules/room/games/zone-match/engine (import paths apart). This module is the
 * one normalizer both repos' parity tests use: a backend copy normalized here must hash exactly as the web file, and
 * both repos commit the same PARITY.json. Regenerate it (from the web worktree) with:
 *
 *   npx tsx scripts/zone-engine-parity.ts --web <path-to-web-repo> --write
 *
 * gameQuestion.ts is not covered: it is a declared subset of the web's domain type, not a copy.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ENGINE_DIR = 'src/modules/room/games/zone-match/engine';
export const MANIFEST = join(ENGINE_DIR, 'PARITY.json');
const EXCLUDED = new Set(['gameQuestion.ts', 'PARITY.json']);

/** The backend copy turned back into the web file: header off, cross-package imports back, .js suffixes off. */
export function normalizeBackendCopy(source: string): { webPath: string; text: string } {
  const lines = source.split('\n');
  const header = lines[0] ?? '';
  const match = header.match(/^\/\/ COPY of the web's (\S+) \(one rules implementation/);
  if (!match) throw new Error('Not a COPY-headed engine file');
  const text = lines
    .slice(1)
    .join('\n')
    .replaceAll("from './gameQuestion.js'", "from '@/lib/domain'")
    .replaceAll("from './numericDuel.js'", "from '@/features/numeric-question/numericDuel'")
    .replace(/from '(\.\/[A-Za-z0-9.]+?)\.js'/g, "from '$1'");
  return { webPath: match[1], text };
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Web path → sha256 of the web file, from this repo's copies. */
export function manifestFromCopies(repoRoot: string): Record<string, string> {
  const dir = resolve(repoRoot, ENGINE_DIR);
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    if (EXCLUDED.has(name) || !name.endsWith('.ts')) continue;
    const { webPath, text } = normalizeBackendCopy(readFileSync(join(dir, name), 'utf8'));
    out[webPath] = sha256(text);
  }
  return out;
}

const isMain = process.argv[1]?.endsWith('zone-engine-parity.ts');
if (isMain) {
  const argv = process.argv.slice(2);
  const webAt = argv.indexOf('--web');
  const webRoot = webAt >= 0 ? argv[webAt + 1] : null;
  const manifest = manifestFromCopies(resolve(import.meta.dirname, '..'));
  if (webRoot) {
    // The web files are the source of truth: their hashes must equal the copies' normalized ones.
    for (const [webPath, hash] of Object.entries(manifest)) {
      const webHash = sha256(readFileSync(resolve(webRoot, webPath), 'utf8'));
      if (webHash !== hash) throw new Error(`${webPath}: the web file and this repo's copy differ — sync them first`);
    }
  }
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (argv.includes('--write')) {
    // Never one-sided: a manifest written without the web check would let the repos pass their tests while differing.
    if (!webRoot) throw new Error('--write needs --web <path-to-web-repo>: the manifest is only ever regenerated against the web files');
    writeFileSync(resolve(import.meta.dirname, '..', MANIFEST), json);
    writeFileSync(resolve(webRoot, 'src/features/zone-match/PARITY.json'), json);
    console.log(`Wrote ${Object.keys(manifest).length} hashes to both repos' PARITY.json`);
  } else {
    console.log(json);
  }
}
