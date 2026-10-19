import { describe, expect, it } from 'vitest';
import { hostedGoalClip, hostedGoalVideoUrl } from '../../src/modules/guess-the-goal/guess-the-goal.video.js';

const base = 'https://lfbwhxvwubzeqkztghok.supabase.co/storage/v1/object/public/goal-clips/goal.mp4';
describe('first-party goal clips', () => {
  it.each([base, base.replace('lfbwhxvwubzeqkztghok', 'nsdfiprfmhdqhbfxfwpv')])('accepts the owned bucket %s', (url) => {
    expect(hostedGoalVideoUrl(url)).toBe(url);
  });
  it.each([
    null, '', 'bad url', 'https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc',
    'https://www.youtube-nocookie.com/embed/abc', base.replace('https:', 'http:'),
    base.replace('.supabase.co', '.supabase.co.attacker.example'),
    base.replace('https://', 'https://user:pass@'), base.replace('/goal-clips/', '/other/'),
    base.replace('.mp4', '.html'), base.replace('.mp4', '.mp4/anything'),
    base.replace('goal.mp4', '../other/goal.mp4'), base.replace('goal.mp4', '%2e%2e%2fother.mp4'),
    base.replace('.supabase.co/', '.supabase.co:8443/'), `${base}#fragment`,
  ])('never plays an untrusted/source URL %s', (url) => {
    expect(hostedGoalVideoUrl(url)).toBeNull();
  });
  it('keeps clip windows paired with the selected canonical media', () => {
    expect(hostedGoalClip({ mirrored_url: base, clip_start_s: 2, clip_end_s: 12 })).toEqual({ video_url: base, clip_start_s: 2, clip_end_s: 12 });
    expect(hostedGoalClip({ video_url: 'https://youtu.be/abc', clip_start_s: 150, clip_end_s: 184 })).toEqual({ video_url: null, clip_start_s: null, clip_end_s: null });
  });
  it('supports a hosted primary URL without a mirror and prefers a valid mirror', () => {
    expect(hostedGoalClip({ video_url: base }).video_url).toBe(base);
    expect(hostedGoalClip({ mirrored_url: base, video_url: 'https://youtu.be/abc' }).video_url).toBe(base);
  });
});
