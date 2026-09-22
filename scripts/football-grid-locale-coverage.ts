/** Offline name coverage check. Does not establish football-fact or translation accuracy. */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Manifest } from './football-grid-content.js';
import { footballGridOrthographicKey, normalizeFootballGridAnswer, resolveFootballGridAnswer } from '../src/modules/football-grid/football-grid.answer-resolver.js';
import type { FootballGridAliasRecord } from '../src/modules/football-grid/football-grid.types.js';

export function auditGridLocaleCoverage(manifest: Pick<Manifest, 'players' | 'aliases'>) {
  const byKey = new Map<string, FootballGridAliasRecord[]>();
  const byKeyboardKey = new Map<string, FootballGridAliasRecord[]>();
  const aliasCounts: Record<string, number> = {};
  for (const [index, alias] of manifest.aliases.entries()) {
    const record = { ...alias, id: String(index) };
    aliasCounts[alias.locale] = (aliasCounts[alias.locale] ?? 0) + 1;
    for (const [map, key] of [[byKey, alias.normalizedAlias],
      [byKeyboardKey, footballGridOrthographicKey(alias.normalizedAlias)]] as const) {
      const bucket = map.get(key) ?? [];
      bucket.push(record);
      map.set(key, bucket);
    }
  }
  const failures: Array<{ playerId: string; form: string; outcome: string }> = [];
  let checkedForms = 0;
  for (const player of manifest.players) {
    // ES/TR use the canonical Latin name; KA also has a reviewed Georgian name.
    // Language selection never narrows the resolver's shared alias pool.
    const forms = [
      ['latin', player.nameEn], ['georgian', player.nameKa],
      ['spanish-uppercase', player.nameEn.toLocaleUpperCase('es')],
      ['turkish-uppercase', player.nameEn.toLocaleUpperCase('tr')],
      ['georgian-uppercase', player.nameKa.toUpperCase()],
    ];
    for (const [form, text] of forms) {
      checkedForms += 1;
      const key = normalizeFootballGridAnswer(text);
      // Full names must match without typo heuristics. Preserve every collision
      // owner; this audit supplies a cell containing only the identity being checked.
      const aliases = byKey.get(key) ?? byKeyboardKey.get(footballGridOrthographicKey(key)) ?? [];
      const result = resolveFootballGridAnswer({ submittedText: text, aliases,
        validPlayerIds: [player.id], boardPlayerIds: [player.id], usedPlayerIds: [] });
      if (result.outcome !== 'correct' || result.playerId !== player.id) {
        failures.push({ playerId: player.id, form, outcome: result.outcome });
      }
    }
  }
  return { players: manifest.players.length, aliasCounts, checkedForms, failures,
    scope: 'Stored display names and case/keyboard forms only. Does not certify every nickname, Georgian spelling, identity translation or football fact.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: football-grid-locale-coverage.ts MANIFEST.json NEW_REPORT.json');
  const report = auditGridLocaleCoverage(JSON.parse(await readFile(input, 'utf8')));
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...report, failures: report.failures.length }));
  if (report.failures.length) process.exitCode = 2;
}
