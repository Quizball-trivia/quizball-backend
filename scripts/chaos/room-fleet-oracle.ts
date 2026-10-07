/** Independent load-test oracle. Deliberately does not import either game engine. */
export function assertLocalUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Local-only URL required');
  if (url.protocol !== 'http:') throw new Error('Local HTTP required');
  return url;
}

export function assertTarget(api: string, target: string, manifestApi: string): void {
  const url = new URL(api);
  if (url.origin !== new URL(manifestApi).origin) throw new Error('Manifest belongs to a different API');
  if (target === 'local') {
    assertLocalUrl(api);
    return;
  }
  if (target !== 'staging' || url.origin !== 'https://api-staging.quizball.io')
    throw new Error('Production and unknown targets are blocked');
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : 0;
}

export function podiumOracle(
  guesses: Array<number | null>,
  value: number,
  precision: number,
  exactWithin: number,
) {
  const factor = 10 ** precision;
  const distances = guesses.map((g) =>
    g === null ? null : Math.abs(Math.round(g * factor) - Math.round(value * factor)),
  );
  const ordered = distances.filter((d): d is number => d !== null).sort((a, b) => a - b);
  return distances.map((d) => {
    const rank = d === null ? null : ordered.findIndex((x) => x === d) + 1;
    const exact = d !== null && d <= Math.floor(exactWithin * factor + 1e-9);
    return {
      rank,
      exact,
      points: rank === null ? 0 : Math.max(0, Math.min(3, guesses.length - 1) - rank + 1) + Number(exact),
    };
  });
}

export function partyPoints(correct: boolean, timeMs: number, durationMs = 10_000): number {
  if (!correct) return 0;
  const effective = Math.max(0, Math.min(durationMs, Math.max(0, timeMs)) - 500);
  return Math.ceil((durationMs - effective) / 1_000) * 10;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function roomPlaces(
  rows: Array<{ seat: number; points: number; wins: number; error: number; withdrawn: boolean }>,
): number[] {
  const key = (r: (typeof rows)[number]) => [
    Number(r.withdrawn),
    -r.points,
    -r.wins,
    Math.round(r.error * 1e6),
  ];
  const compare = (a: (typeof rows)[number], b: (typeof rows)[number]) => {
    const ka = key(a),
      kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  };
  const sorted = [...rows].sort((a, b) => compare(a, b) || a.seat - b.seat),
    places: number[] = [];
  sorted.forEach((r, i) => {
    places[r.seat] = i > 0 && compare(r, sorted[i - 1]) === 0 ? places[sorted[i - 1].seat] : i + 1;
  });
  return places;
}
