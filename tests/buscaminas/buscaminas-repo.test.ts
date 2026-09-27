import { describe, expect, it } from 'vitest';
import { buscaminasRepo } from '../../src/modules/buscaminas/buscaminas.repo.js';
import { newPayload } from '../../src/modules/buscaminas/buscaminas.rules.js';

/** Captures the SQL the repo sends instead of running it. */
function capture() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tx = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('$?'), values });
      return Promise.resolve([]);
    },
    { json: (value: unknown) => value },
  );
  return { tx: tx as never, calls };
}

describe('buscaminas repo', () => {
  it('the ranked UPDATE itself carries the Buenos Aires cutoff, checked at statement time', async () => {
    const { tx, calls } = capture();
    const closesAt = new Date('2026-09-29T03:00:00Z');
    const saved = await buscaminasRepo.saveState(tx, 'run-1', {
      state: newPayload('run-1', '2026-09-28', 1, 'user-a', 4), contentVersion: 1, completion: { score: 42, perfects: 1 }, closesAt,
    });
    expect(saved).toBeNull();
    const [{ text, values }] = calls;
    expect(text).toMatch(/UPDATE buscaminas_runs/);
    expect(text).toMatch(/WHERE id = \$\? AND clock_timestamp\(\) < \$\?\s+RETURNING/);
    expect(text).toMatch(/completed_at = CASE WHEN \$\? THEN clock_timestamp\(\) END/);
    // now() is the transaction start: a request that waited on the row lock across midnight would slip through.
    expect(text).not.toMatch(/\bnow\(\)/);
    expect(values.at(-1)).toBe(closesAt);
  });
});
