#!/usr/bin/env npx tsx

/**
 * Verify every goal-videos.json link exists AND allows third-party embeds.
 * Existence is not enough: rights holders (FIFA, UEFA, leagues) often allow a
 * video on youtube.com but block it in embeds, which renders as
 * "Video unavailable" in the app.
 *
 *   YOUTUBE_API_KEY=... npx tsx scripts/guess-the-goal/check-videos.ts
 *
 * Uses the YouTube Data API (videos.list part=status → status.embeddable).
 * Unauthenticated fallbacks (innertube, embed-page scraping) proved unreliable
 * from scripts — when no key is available, load the real-browser harness
 * instead: an HTML page that mounts each video in an IFrame-API player and
 * records onError 101/150 (embed blocked) vs ready-without-error.
 *
 * Exit code 1 when any link is missing, malformed, or not embeddable.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const apiKey = process.env.YOUTUBE_API_KEY;
if (!apiKey) {
  console.error(
    'YOUTUBE_API_KEY is required (Data API v3, videos.list is quota-cheap).\n' +
      'No key? Use the browser harness documented in this file header instead.'
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const links: Record<string, string | null> = JSON.parse(
  readFileSync(join(here, 'goal-videos.json'), 'utf8')
);

function videoId(url: string): string | null {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/
  );
  return m ? m[1] : null;
}

const idBySlug = new Map<string, string>();
let failures = 0;
for (const [slug, url] of Object.entries(links)) {
  if (!url) {
    console.log(`— ${slug}: no link`);
    continue;
  }
  const id = videoId(url);
  if (!id) {
    console.error(`✗ ${slug}: cannot parse video id from ${url}`);
    failures += 1;
    continue;
  }
  idBySlug.set(slug, id);
}

const ids = [...new Set(idBySlug.values())];
const found = new Map<string, { embeddable: boolean; title: string }>();
for (let i = 0; i < ids.length; i += 50) {
  const batch = ids.slice(i, i + 50);
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id=${batch.join(',')}&key=${apiKey}`
  );
  if (!res.ok) {
    console.error(`✗ Data API request failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const data = (await res.json()) as {
    items?: Array<{ id: string; status?: { embeddable?: boolean }; snippet?: { title?: string } }>;
  };
  for (const item of data.items ?? []) {
    found.set(item.id, {
      embeddable: item.status?.embeddable === true,
      title: item.snippet?.title ?? '',
    });
  }
}

for (const [slug, id] of idBySlug) {
  const info = found.get(id);
  if (!info) {
    console.error(`✗ ${slug}: video ${id} not found (deleted/private?)`);
    failures += 1;
  } else if (!info.embeddable) {
    console.error(`✗ ${slug}: embedding DISABLED — ${info.title}`);
    failures += 1;
  } else {
    console.log(`✓ ${slug}: ${info.title}`);
  }
}

console.log(failures > 0 ? `\n${failures} link(s) failed.` : '\nAll links embeddable.');
process.exit(failures > 0 ? 1 : 0);
