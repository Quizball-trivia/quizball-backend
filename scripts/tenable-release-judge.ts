/**
 * Whether a Tenable release may take more spellings, the rule both the staging pin (tenable-locale-aliases.ts) and the production
 * copy (tenable-locale-from-staging.ts) apply. No database: the callers read the rows.
 */
import { listProblems, type TenableList } from '../src/modules/tenable/tenable.content.js';
import { buildDirectory, type Directory, type EntityKind, type TenableEntity } from '../src/modules/tenable/tenable.identify.js';
import { mergeAliases } from '../src/modules/tenable/tenable.aliases.js';
import { normalizeName } from '../src/modules/footballers/footballers.text.js';

export interface AliasRow { kind: string; eid: string; aliases: readonly string[] }

const readingOf = (directory: Directory, spelling: string): string => {
  const id = directory.identify(spelling);
  return id.kind === 'entity' ? id.eid : id.kind;
};

/**
 * One release judged with `extra` added to what is pinned: every list playable; every spelling of the pinned sets and `extra`
 * naming one of its entities still means it (a spelling two entities carry may mean the far better known one, or be ambiguous: a
 * free answer; reading as an entity that does not carry it is wrong ownership); and no spelling the release already accepted
 * reads differently now. `fine` holds what a recheck (no `extra`) lets pass: a spelling moved off an entity no list holds.
 */
export function judgeTenableRelease(kind: EntityKind, release: string, own: readonly TenableEntity[], lists: readonly TenableList[], pinned: readonly AliasRow[], extra: readonly AliasRow[]): { problems: string[]; fine: string[] } {
  // Before: the pinned sets as merged so far, or (a recheck) as the server merged them up to 2026-10-24, by kind only.
  const before = buildDirectory(kind, release, mergeAliases([...own], extra.length ? pinned : pinned.filter((r) => r.kind === kind)));
  const directory = buildDirectory(kind, release, mergeAliases([...own], [...pinned, ...extra]));
  const ids = new Set(own.map((e) => e.eid));
  const carries = (eid: string, a: string) => { const e = directory.entity(eid); return !!e && [e.name, e.known, ...e.aliases].some((x) => normalizeName(x) === normalizeName(a)); };
  const problems = lists.flatMap((l) => listProblems(l, directory).map((p) => `${l.id}: ${p}`));
  const misleading = [...pinned, ...extra].filter((r) => ids.has(r.eid)).flatMap((r) => r.aliases.flatMap((a) => {
    const id = directory.identify(a);
    if (id.kind === 'entity' && id.eid === r.eid) return [];
    if (id.kind === 'ambiguous' || (id.kind === 'entity' && carries(id.eid, a))) return [];
    return [`"${a}" (${r.eid}) reads as ${id.kind === 'entity' ? id.eid : id.kind}`];
  }));
  // Everything the release already answers to: its own names, every pinned set's, and what the matcher derives from them
  // ("United" reads as Ostra United through its surname, a key no row stores).
  const accepted = [...new Set([...own.flatMap((e) => [e.name, e.known, ...e.aliases]), ...pinned.filter((r) => ids.has(r.eid)).flatMap((r) => r.aliases), ...before.identifyingKeys()].filter(Boolean))];
  // A recheck of the by-id merge may move a spelling off an entity no list holds (it could only have been a wrong answer).
  const onList = new Set(lists.flatMap((l) => l.slots.map((x) => x.eid)));
  const fine: string[] = [];
  const takenOver = accepted.flatMap((spelling) => {
    const was = before.identify(spelling);
    const wasReading = readingOf(before, spelling), nowReading = readingOf(directory, spelling);
    if (wasReading === nowReading) return [];
    // New spellings may not move anything: a free ambiguous answer that now names an entity can cost a life too.
    if (was.kind !== 'entity' && extra.length === 0) return [];
    const line = `"${spelling}" meant ${wasReading}, would read as ${nowReading}`;
    if (extra.length === 0 && was.kind === 'entity' && !onList.has(was.eid)) { fine.push(line); return []; }
    return [line];
  });
  return { problems: [...problems, ...misleading, ...takenOver], fine };
}
