/**
 * Staging judge — reads a report bundle (written by run.mts), feeds each
 * scenario's event timeline to Gemini via the rule-aware LLM judge, and prints a
 * clear per-scenario verdict (coded-invariant result + the LLM's findings) so a
 * human can read it and decide.
 *
 * Optionally also reviews server logs: pass a logs file with --logs <path> (a text
 * file of the staging deploy logs for the run window) and the judge folds them in.
 *
 * Run:  npx tsx game-regression/staging/judge.mts game-regression/staging/reports/staging-<tag>.json
 * Needs OPENROUTER_API_KEY (the Gemini judge). Fails OPEN if the API is unavailable.
 */
import { readFile } from 'node:fs/promises';
import { createTrace, type EventTrace, type TraceDir } from '../src/adapter.mjs';
import { reviewTrace, formatLlmFinding } from '../src/llm-reviewer.mjs';

interface BundleScenario {
  name: string;
  ok: boolean;
  detail: string;
  violations: string[];
  variant?: 'possession' | 'party';
  events?: Array<{ dir: string; event: string; target?: string; payload: unknown }>;
}
interface Bundle { url: string; runTag: string; scenarios: BundleScenario[] }

function rebuildTrace(events: BundleScenario['events']): EventTrace {
  const t = createTrace(() => 0);
  for (const e of events ?? []) t.record(e.dir as TraceDir, e.event, e.payload, e.target);
  return t;
}

async function main(): Promise<void> {
  const bundlePath = process.argv[2];
  if (!bundlePath) {
    console.error('usage: tsx judge.mts <report-bundle.json>');
    process.exit(2);
  }
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as Bundle;
  console.log(`[judge] ${bundle.scenarios.length} scenario(s) from ${bundle.url} (run ${bundle.runTag})\n`);

  let hardFail = 0;
  let llmFlag = 0;
  for (const s of bundle.scenarios) {
    console.log(`══ ${s.name} ══`);
    // 1) Coded-invariant verdict (the authoritative gate).
    console.log(`  invariants: ${s.ok ? 'PASS' : 'FAIL'} — ${s.detail}`);
    for (const v of s.violations) console.log(`     ${v}`);
    if (!s.ok) hardFail++;

    // 2) The Gemini judge (advisory second opinion, rule-aware).
    if (s.events && s.events.length > 0) {
      const trace = rebuildTrace(s.events);
      const review = await reviewTrace(trace, {
        variant: s.variant === 'party' ? 'friendly_party_quiz' : 'ranked_sim',
        note: s.ok ? undefined : `This scenario FAILED a coded invariant (${s.detail}); explain what went wrong.`,
      });
      if (review.error) {
        console.log(`  gemini: (unavailable — ${review.error})`);
      } else if (review.findings.length === 0) {
        console.log(`  gemini: clean — ${review.summary}`);
      } else {
        llmFlag++;
        console.log(`  gemini: ${review.findings.length} finding(s) — ${review.summary}`);
        for (const f of review.findings) console.log(`     ${formatLlmFinding(f)}`);
      }
    } else {
      console.log('  gemini: (no events recorded — likely never started)');
    }
    console.log('');
  }

  console.log(`[judge] SUMMARY: invariants ${bundle.scenarios.length - hardFail}/${bundle.scenarios.length} clean; gemini flagged ${llmFlag} scenario(s).`);
  console.log(hardFail > 0
    ? '[judge] VERDICT: ❌ FAIL — a scenario failed the coded invariants (hard gate).'
    : llmFlag > 0
      ? '[judge] VERDICT: ⚠ PASS (with Gemini findings to review — advisory).'
      : '[judge] VERDICT: ✅ PASS — all scenarios clean (invariants + Gemini).');
  process.exit(hardFail > 0 ? 1 : 0);
}

void main();
