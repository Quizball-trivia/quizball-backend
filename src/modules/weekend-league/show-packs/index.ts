/**
 * Registry of show packs. Add next Monday's pack as its own module
 * (orshabatoba-YYYY-MM-DD.ts) and list it here; the orchestrator loads it into
 * that Monday's event automatically, and a redeploy before the host presses
 * Start replaces the event's questions with the new version.
 */

import { showPackSchema, type ShowPack } from './show-pack.js';

const PACKS: ShowPack[] = [];

const bySlugDate = new Map<string, ShowPack>();
for (const raw of PACKS) {
  // Validated at load: a malformed pack fails the boot loudly in tests/CI
  // rather than silently at show time.
  const pack = showPackSchema.parse(raw);
  bySlugDate.set(`${pack.slug}/${pack.eventDate}`, pack);
}

export function findShowPack(slug: string, eventDate: string): ShowPack | null {
  return bySlugDate.get(`${slug}/${eventDate}`) ?? null;
}
