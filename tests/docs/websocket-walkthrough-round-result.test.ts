import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// match:round_result has two producers with different shapes; the walkthrough
// must document both so client agents wire the right fields.
const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'websocket-walkthrough.md'), 'utf8');
const rows = doc.split('\n').filter((line) => line.startsWith('| `match:round_result`'));

describe('websocket walkthrough: match:round_result variants', () => {
  it('documents the possession resolver shape: questionKind + reveal + deltas, no top-level correctIndex', () => {
    const possession = rows.find((row) => /possession/i.test(row));
    expect(possession).toBeDefined();
    expect(possession).toMatch(/questionKind/);
    expect(possession).toMatch(/reveal/);
    expect(possession).toMatch(/deltas/);
    expect(possession).toMatch(/no top-level `?correctIndex`?/i);
  });

  it('documents the party quiz shape: questionKind + reveal + top-level correctIndex + rankingOrder', () => {
    const party = rows.find((row) => /party/i.test(row));
    expect(party).toBeDefined();
    expect(party).toMatch(/questionKind/);
    expect(party).toMatch(/reveal/);
    expect(party).toMatch(/correctIndex/);
    expect(party).toMatch(/rankingOrder/);
  });
});
