import { describe, expect, it } from 'vitest';
import { judgeTenableRelease } from '../../scripts/tenable-release-judge.js';
import type { TenableEntity } from '../../src/modules/tenable/tenable.identify.js';

// Invented clubs only: the repository is public. `alpha` is far better known, so a shared spelling resolves to it.
const entity = (eid: string, name: string, fame: number, aliases: string[] = []): TenableEntity => ({ eid, name, known: name, fame, aliases, qualifier: null });
const alpha = entity('alpha', 'Vardo Rovers', 95);
const beta = entity('beta', 'Ostra United', 5);
const gamma = entity('gamma', 'Kelmar Athletic', 50);
const own = [alpha, beta, gamma];
const judge = (pinned: Array<{ eid: string; aliases: string[] }>, extra: Array<{ eid: string; aliases: string[] }>, entities = own) =>
  judgeTenableRelease('club', 'rel', entities, [], pinned.map((r) => ({ kind: 'club', ...r })), extra.map((r) => ({ kind: 'club', ...r }))).problems;

describe('Tenable release judge', () => {
  it('takes a spelling that only means its own entity', () => {
    expect(judge([], [{ eid: 'alpha', aliases: ['Vardo Rouge'] }])).toEqual([]);
  });

  it('refuses a new spelling equal to another entity\'s original name: that input would change owner', () => {
    const problems = judge([], [{ eid: 'alpha', aliases: ['Ostra United'] }]);
    expect(problems.join()).toMatch(/"Ostra United" meant beta/);
  });

  it('refuses a new spelling that takes over a spelling another language pinned', () => {
    const problems = judge([{ eid: 'beta', aliases: ['Ostra Bleu'] }], [{ eid: 'alpha', aliases: ['Ostra Bleu'] }]);
    expect(problems.join()).toMatch(/"Ostra Bleu" meant beta/);
  });

  it('refuses a new spelling that takes over a key the matcher derives: the surname of a correct answer', () => {
    const entities = [entity('alpha', 'Vardo Rovers', 95), entity('beta', 'Ostra United', 5)];
    expect(judgeTenableRelease('club', 'rel', entities, [], [], []).problems).toEqual([]);
    expect(judge([], [{ eid: 'alpha', aliases: ['United'] }], entities).join()).toMatch(/"united" meant beta, would read as alpha/);
  });

  it('refuses a new spelling that takes over a compact form', () => {
    const entities = [entity('alpha', 'Vardo Rovers', 95), entity('beta', 'Ostra United', 5)];
    expect(judge([], [{ eid: 'alpha', aliases: ['Ostraunited'] }], entities).join()).toMatch(/"ostraunited" meant beta/);
  });

  it('refuses a free ambiguous answer that would come to name one entity', () => {
    const twins = [entity('twin-a', 'Pellin Town', 40), entity('twin-b', 'Pellin Town', 40), entity('gamma', 'Kelmar Athletic', 99)];
    expect(judge([], [{ eid: 'gamma', aliases: ['Pellin Town'] }], twins).join()).toMatch(/"Pellin Town" meant ambiguous, would read as gamma/);
  });

  it('reports wrong ownership even when this set did not cause it', () => {
    expect(judge([{ eid: 'beta', aliases: ['Rovers'] }], [{ eid: 'alpha', aliases: ['Vardo Rouge'] }]).join()).toMatch(/"Rovers" \(beta\) reads as alpha/);
  });

  it('lets a real ambiguity stand: a spelling two entities carry is a free answer', () => {
    const twins = [entity('twin-a', 'Pellin Town', 40), entity('twin-b', 'Pellin Town', 40), gamma];
    expect(judge([{ eid: 'twin-a', aliases: ['Pellin Town'] }], [{ eid: 'gamma', aliases: ['Kelmar Vert'] }], twins)).toEqual([]);
  });
});
