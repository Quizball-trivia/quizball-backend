import { describe, expect, it } from 'vitest';
import { parseCgroupCpuMax } from '../../src/core/cpu.js';

describe('cgroup CPU capacity', () => {
  it('parses whole and fractional CPU quotas', () => {
    expect(parseCgroupCpuMax('400000 100000\n')).toBe(4);
    expect(parseCgroupCpuMax('150000 100000')).toBe(1.5);
  });

  it('falls back when the cgroup has no finite quota', () => {
    expect(parseCgroupCpuMax('max 100000\n')).toBeNull();
    expect(parseCgroupCpuMax('invalid')).toBeNull();
    expect(parseCgroupCpuMax('0 100000')).toBeNull();
  });
});
