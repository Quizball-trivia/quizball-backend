import { readFileSync } from 'node:fs';
import { fuzzyMatchesAnswer, fuzzyMatchesAnswerV2 } from './src/realtime/possession-answer-matching.js';

const lines = readFileSync('/tmp/qb-apos/replay.tsv', 'utf8').split('\n').filter(Boolean);
let flipsToCorrect = 0, flipsToWrong = 0, same = 0, parseErr = 0;
const toCorrectSamples: string[] = [];
const toWrongSamples: string[] = [];
for (const line of lines) {
  const idx1 = line.indexOf('\t'); const idx2 = line.indexOf('\t', idx1 + 1); const idx3 = line.indexOf('\t', idx2 + 1);
  if (idx3 < 0) { parseErr++; continue; }
  const wasCorrect = line.slice(idx1 + 1, idx2) === 't';
  const guess = line.slice(idx2 + 1, idx3);
  let accepted: string[];
  try { accepted = JSON.parse(line.slice(idx3 + 1)); } catch { parseErr++; continue; }
  const nowCorrect = fuzzyMatchesAnswer(guess, accepted);
  if (nowCorrect === wasCorrect) { same++; continue; }
  if (nowCorrect) { flipsToCorrect++; if (toCorrectSamples.length < 40) toCorrectSamples.push(`${guess} => ${accepted[0]}`); }
  else { flipsToWrong++; if (toWrongSamples.length < 20) toWrongSamples.push(`${guess} => ${accepted[0]}`); }
}
console.log(JSON.stringify({ total: lines.length, same, flipsToCorrect, flipsToWrong, parseErr }));
console.log('--- newly ACCEPTED (should be apostrophe victims) ---');
for (const s of toCorrectSamples) console.log(s);
console.log('--- newly REJECTED (must be empty) ---');
for (const s of toWrongSamples) console.log(s);
