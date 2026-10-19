/** Only Quizball's public goal-clips bucket is playable. Source links remain
 * attribution metadata, never a fallback player (including in old sessions). */
const HOSTED_CLIP_ORIGINS = new Set([
  'https://lfbwhxvwubzeqkztghok.supabase.co',
  'https://nsdfiprfmhdqhbfxfwpv.supabase.co',
]);

export function hostedGoalVideoUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return HOSTED_CLIP_ORIGINS.has(url.origin)
      && !url.username && !url.password && !url.hash
      && /^\/storage\/v1\/object\/public\/goal-clips\/[a-z0-9_-]+\.mp4$/i.test(url.pathname)
      ? url.href : null;
  } catch {
    return null;
  }
}

export function hostedGoalClip(source: {
  mirrored_url?: string | null;
  video_url?: string | null;
  clip_start_s?: number | null;
  clip_end_s?: number | null;
} | null | undefined): {
  video_url: string | null;
  clip_start_s: number | null;
  clip_end_s: number | null;
} {
  const video_url = hostedGoalVideoUrl(source?.mirrored_url) ?? hostedGoalVideoUrl(source?.video_url);
  return {
    video_url,
    clip_start_s: video_url ? source?.clip_start_s ?? null : null,
    clip_end_s: video_url ? source?.clip_end_s ?? null : null,
  };
}
