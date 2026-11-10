import { createHash } from 'node:crypto';

const revisions = new WeakMap<object, string>();

/** A short, stable revision of a content object (cached per object): a corrected unit is a new judging context. */
export function revisionOf(content: object, project: (c: never) => unknown = (c) => c): string {
  let rev = revisions.get(content);
  if (!rev) {
    rev = createHash('sha1').update(JSON.stringify(project(content as never), (_k, v) => (v instanceof Set ? [...v].sort() : v))).digest('hex').slice(0, 12);
    revisions.set(content, rev);
  }
  return rev;
}
