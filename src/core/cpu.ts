import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

const CGROUP_V2_CPU_MAX = '/sys/fs/cgroup/cpu.max';
const CGROUP_V1_CPU_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
const CGROUP_V1_CPU_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

export function parseCgroupCpuMax(value: string): number | null {
  const [quotaText, periodText] = value.trim().split(/\s+/);
  if (!quotaText || quotaText === 'max' || !periodText) return null;

  const quota = Number(quotaText);
  const period = Number(periodText);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) {
    return null;
  }
  return quota / period;
}

function readCgroupV2Capacity(): number | null {
  try {
    return parseCgroupCpuMax(readFileSync(CGROUP_V2_CPU_MAX, 'utf8'));
  } catch {
    return null;
  }
}

function readCgroupV1Capacity(): number | null {
  try {
    const quota = Number(readFileSync(CGROUP_V1_CPU_QUOTA, 'utf8').trim());
    const period = Number(readFileSync(CGROUP_V1_CPU_PERIOD, 'utf8').trim());
    if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) {
      return null;
    }
    return quota / period;
  } catch {
    return null;
  }
}

/**
 * CPU capacity available to this process, in cores. Container quotas can be
 * fractional, so the cgroup value is more accurate than the host CPU count.
 */
export function cpuCapacityCores(): number {
  const parallelism = Math.max(1, availableParallelism());
  const quota = readCgroupV2Capacity() ?? readCgroupV1Capacity();
  return quota === null ? parallelism : Math.min(quota, parallelism);
}
