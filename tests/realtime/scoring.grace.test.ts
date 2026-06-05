import { describe, expect, it } from 'vitest';
import { calculatePoints } from '../../src/realtime/scoring.js';

// Boundary tests around the GRACE_MS full-points window. GRACE_MS was widened
// 300 -> 500ms so higher-latency players still reach the top bucket on a fast tap.
// These lock the grace-window contract + bucket boundaries so a future change to
// GRACE_MS or the bucketing is caught.
const Q = 10_000; // 10s question

describe('calculatePoints — grace window + buckets (GRACE_MS=500)', () => {
  it('wrong answers always score 0 regardless of time', () => {
    expect(calculatePoints(false, 0, Q)).toBe(0);
    expect(calculatePoints(false, 250, Q)).toBe(0);
  });

  it('any correct answer within the 500ms grace window earns full points', () => {
    // The contract the 300->500 widening protects: <= 500ms = full points.
    expect(calculatePoints(true, 0, Q)).toBe(100);
    expect(calculatePoints(true, 499, Q)).toBe(100);
    expect(calculatePoints(true, 500, Q)).toBe(100);
  });

  it('just past the grace window still rounds up to full for the first bucket', () => {
    // ceil() means 501ms still lands in the top bucket until the first full
    // second of effective time elapses.
    expect(calculatePoints(true, 501, Q)).toBe(100);
    expect(calculatePoints(true, 1000, Q)).toBe(100);
    expect(calculatePoints(true, 1499, Q)).toBe(100);
  });

  it('drops to the next 10-point bucket once grace + 1000ms elapse', () => {
    // grace(500) + 1000ms => effectiveTime crosses 1000 => one bucket lost.
    expect(calculatePoints(true, 1500, Q)).toBe(90);
    expect(calculatePoints(true, 1501, Q)).toBe(90);
  });

  it('floors at the minimum bucket near the deadline and clamps beyond it', () => {
    expect(calculatePoints(true, 9999, Q)).toBe(10);
    expect(calculatePoints(true, Q, Q)).toBe(10);
    expect(calculatePoints(true, Q + 5000, Q)).toBe(10); // clamped to questionTime
  });

  it('negative time is clamped to 0 (full points)', () => {
    expect(calculatePoints(true, -100, Q)).toBe(100);
  });
});
