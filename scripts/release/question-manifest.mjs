import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function canonicalJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === undefined) throw new Error('Undefined is not a content value');
  return JSON.stringify(value);
}
export const contentHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

function uniqueIndex(rows, key, label) {
  if (!Array.isArray(rows)) throw new Error(`Missing ${label}`);
  const map = new Map();
  for (const row of rows) {
    if (!row[key] || map.has(row[key])) throw new Error(`Missing or duplicate ${label} identity`);
    map.set(row[key], row);
  }
  return map;
}

function prepare(snapshot) {
  if (snapshot.format !== 1 || !snapshot.project) throw new Error('Unsupported snapshot');
  const categories = uniqueIndex(snapshot.categories, 'id', 'category');
  uniqueIndex(snapshot.categories, 'slug', 'category slug');
  const questions = uniqueIndex(snapshot.questions, 'id', 'question');
  const payloads = uniqueIndex(snapshot.payloads, 'question_id', 'question payload');
  uniqueIndex(snapshot.payloads, 'id', 'payload');
  for (const id of payloads.keys()) if (!questions.has(id)) throw new Error('Orphan question payload');
  const records = new Map();
  for (const question of questions.values()) {
    const category = categories.get(question.category_id);
    const payload = payloads.get(question.id);
    if (!category || !payload) throw new Error(`Question ${question.id} is missing content dependencies`);
    // User IDs, timestamps and WL play history are environment-specific. Never
    // overwrite them while comparing/promoting editorial content.
    const editorial = {
      categorySlug: category.slug,
      type: question.type,
      difficulty: question.difficulty,
      status: question.status,
      prompt: question.prompt,
      explanation: question.explanation,
      rankedEligible: question.ranked_eligible,
      visibility: question.visibility,
      payload: payload.payload,
    };
    records.set(question.id, {question, category, editorial, hash: contentHash(editorial)});
  }
  return records;
}

function changedPaths(source, target, path = '') {
  if (canonicalJson(source) === canonicalJson(target)) return [];
  if (source && target && typeof source === 'object' && typeof target === 'object'
      && !Array.isArray(source) && !Array.isArray(target)) {
    return [...new Set([...Object.keys(source), ...Object.keys(target)])].sort().flatMap(key => {
      const next = path ? `${path}.${key}` : key;
      if (!(key in source) || !(key in target)) return [next];
      return changedPaths(source[key], target[key], next);
    });
  }
  return [path];
}

const LOCALES = new Set(['en', 'ka', 'es', 'tr']);
function missingLocalePaths(source, target, path = '') {
  if (!source || !target || typeof source !== 'object' || typeof target !== 'object') return [];
  // Arrays often embed option IDs. Requiring exact positional IDs prevents a
  // translation being attached to a different answer after an editor reorders.
  if (Array.isArray(source) || Array.isArray(target)) {
    if (!Array.isArray(source) || !Array.isArray(target) || source.length !== target.length) return [];
    if (!source.every((item, i) => item && typeof item === 'object' && item.id && item.id === target[i]?.id)) return [];
    return source.flatMap((item, i) => missingLocalePaths(item, target[i], `${path}[${i}]`));
  }
  const found = [];
  for (const key of Object.keys(source)) {
    const next = path ? `${path}.${key}` : key;
    const value = source[key];
    if (LOCALES.has(key) && typeof value === 'string' && value.trim()
        && (target[key] === undefined || target[key] === null || target[key] === '')) found.push(next);
    else if (key in target) found.push(...missingLocalePaths(value, target[key], next));
  }
  return found;
}

export function buildQuestionManifest(source, target) {
  if (source.project === target.project) throw new Error('Source and target projects must differ');
  const sourceRecords = prepare(source);
  const targetRecords = prepare(target);
  const targetsByHash = new Map();
  for (const [id, record] of targetRecords) {
    const ids = targetsByHash.get(record.hash) ?? [];
    ids.push(id); targetsByHash.set(record.hash, ids);
  }
  const entries = [];
  for (const [id, record] of sourceRecords) {
    const existing = targetRecords.get(id);
    const reasons = [];
    if (record.question.status !== 'published') reasons.push(`status:${record.question.status}`);
    if (record.question.visibility !== 'public') reasons.push(`visibility:${record.question.visibility}`);
    const label = `${record.category.slug} ${Object.values(record.question.prompt ?? {}).join(' ')}`;
    if (/(?:^|[\s_-])(test|fixture|e2e|smoke|chaos|staging-only)(?:$|[\s_-])/i.test(label)) reasons.push('possible-test-content');
    const exactOtherIds = (targetsByHash.get(record.hash) ?? []).filter(other => other !== id);
    const disposition = existing
      ? (existing.hash === record.hash ? 'identical' : 'preserve-target-review-conflict')
      : exactOtherIds.length ? 'review-existing-identical-content' : 'review-addition';
    entries.push({
      sourceId: id, targetId: existing ? id : null,
      type: record.question.type, categorySlug: record.category.slug,
      status: record.question.status, visibility: record.question.visibility,
      sourceHash: record.hash, targetHash: existing?.hash ?? null,
      disposition, exactOtherIds, reviewReasons: reasons,
      changedPaths: existing && existing.hash !== record.hash ? changedPaths(record.editorial, existing.editorial) : [],
      missingLocalePaths: existing ? missingLocalePaths(record.editorial, existing.editorial) : [],
    });
  }
  const targetOnly = [...targetRecords].filter(([id]) => !sourceRecords.has(id)).map(([id,r])=>({id,hash:r.hash,type:r.question.type,status:r.question.status,visibility:r.question.visibility}));
  const count = key => entries.reduce((out,row)=>{out[row[key]]=(out[row[key]]??0)+1;return out;},{});
  return {
    format:1, executable:false, sourceProject:source.project,targetProject:target.project,
    sourceSnapshotHash:contentHash(source),targetSnapshotHash:contentHash(target),
    summary:{sourceQuestions:sourceRecords.size,targetQuestions:targetRecords.size,targetOnly:targetOnly.length,dispositions:count('disposition'),sourceTypes:count('type'),missingLocaleCandidates:entries.filter(e=>e.missingLocalePaths.length).length},
    rules:['No source or target row is deleted.','Existing target content and IDs are preserved by default.','Every conflict and source-only row remains in the private snapshots for review.','No draft/private/test-like row is auto-published.','Identity mappings, media and dependent player data must be reviewed before an executable package is built.'],
    entries,targetOnly,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2); const options={};
  for(let i=0;i<args.length;i+=2){if(!['--source','--target','--out'].includes(args[i])||!args[i+1]||options[args[i]])throw new Error('Usage: --source snapshot.json --target snapshot.json --out manifest.json');options[args[i]]=args[i+1];}
  if(Object.keys(options).length!==3)throw new Error('All three paths are required');
  const result=buildQuestionManifest(JSON.parse(readFileSync(options['--source'],'utf8')),JSON.parse(readFileSync(options['--target'],'utf8')));
  writeFileSync(options['--out'],JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(result.summary,null,2));
}
