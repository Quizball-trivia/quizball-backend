import { describe, expect, it } from 'vitest';
import { parseCapacityArgs } from '../../scripts/chaos/capacity.js';

describe('capacity ladder arguments', () => {
  it('sorts and deduplicates player levels', () => {
    const args = parseCapacityArgs(['--target=local', '--levels=200,50,100,100']);
    expect(args.target).toBe('local');
    expect(args.levels).toEqual([50, 100, 200]);
    expect(args.flapRate).toBe(0);
  });
});
