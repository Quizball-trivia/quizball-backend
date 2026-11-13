import { normalizeGapText } from './content-gaps.buffer.js';

/**
 * A short in-process window that counts the same name once: for paths with no game write of their own to dedupe on
 * (stateless answers, repeated guesses). Keys use the recorder's own normalisation, so spelling variants of one name are
 * one key. When full of live keys it refuses new ones (nothing recorded) rather than forgetting the window.
 */
export function createGapDedupe(windowMs = 2 * 60_000, max = 5_000) {
  const seen = new Map<string, number>();
  return {
    fresh(scope: string, text: string, now = Date.now()): boolean {
      const key = `${scope}|${normalizeGapText(text)}`;
      const at = seen.get(key);
      if (at !== undefined && now - at < windowMs) return false;
      if (seen.size >= max) {
        for (const [k, t] of seen) if (now - t >= windowMs) seen.delete(k);
        if (seen.size >= max) return false;
      }
      seen.set(key, now);
      return true;
    },
    reset: () => seen.clear(),
  };
}
