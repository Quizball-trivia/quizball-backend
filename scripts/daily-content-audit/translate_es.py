"""Fill missing Spanish text on published questions. Walks prompt, explanation and every
{en,ka,...} text object inside the payload; translates only fields whose `es` is empty;
writes back guarded so existing Spanish is never overwritten.
Usage: translate_es.py <db_url> <apply|dry> <type> [<type>...]"""
import json, os, sys, ssl, certifi, urllib.request, psycopg
db_url, mode, *types = sys.argv[1:]
ctx = ssl.create_default_context(cafile=certifi.where())
FIXED = {'True': 'Verdadero', 'False': 'Falso', 'Who am I?': '¿Quién soy?'}

def walk(node, path, out):
    """Collect (path, en) for every i18n object lacking es."""
    if isinstance(node, dict):
        if isinstance(node.get('en'), str) and node['en'].strip() and not (node.get('es') or '').strip():
            out.append((path, node['en'])); return
        for k, v in node.items():
            if k == 'accepted_answers': continue
            walk(v, path + [k], out)
    elif isinstance(node, list):
        for i, v in enumerate(node): walk(v, path + [i], out)

def set_es(root, path, text):
    node = root
    for p in path: node = node[p]
    if not (node.get('es') or '').strip(): node['es'] = text; return True
    return False

def translate(items):
    prompt = ("Translate these football quiz texts from English to Spanish (neutral Spanish as used by football media). "
              "Keep player, club, stadium and competition names exactly as written (do not translate proper nouns). "
              "Short labels stay short. Return ONLY a JSON object {\"items\": [{\"id\": <same id>, \"es\": <spanish>}]} with every id.\n\n"
              + json.dumps([{'id': i, 'en': t} for i, t in items], ensure_ascii=False))
    req = urllib.request.Request('https://openrouter.ai/api/v1/chat/completions', data=json.dumps({'model': os.environ['OPENROUTER_MODEL'], 'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0, 'response_format': {'type': 'json_object'}}).encode(), headers={'Authorization': 'Bearer ' + os.environ['OPENROUTER_API_KEY'], 'Content-Type': 'application/json'})
    for attempt in range(3):
        try:
            body = json.load(urllib.request.urlopen(req, timeout=300, context=ctx))
            got = {x['id']: x['es'] for x in json.loads(body['choices'][0]['message']['content'].strip().strip('`').removeprefix('json').strip())['items'] if x.get('es')}
            missing = [i for i, _ in items if i not in got]
            if not missing: return got
            print('  retry, missing', len(missing))
        except Exception as e: print('  retry after error', e)
    raise SystemExit('translation failed')

with psycopg.connect(db_url, autocommit=True, prepare_threshold=None) as conn, conn.cursor() as cur:
    for qtype in types:
        cur.execute("""select q.id, q.prompt, q.explanation, qp.payload from questions q join question_payloads qp on qp.question_id = q.id
                       where q.type = %s and q.status = 'published'""", (qtype,))
        rows = cur.fetchall(); work = {}; fields = []
        for qid, prompt, explanation, payload in rows:
            found = []
            walk(prompt, ['prompt'], found); walk(explanation, ['explanation'], found); walk(payload, ['payload'], found)
            if found:
                work[str(qid)] = {'prompt': prompt, 'explanation': explanation, 'payload': payload}
                fields += [(f"{qid}|{json.dumps(p)}", en) for p, en in found]
        print(f"{qtype}: {len(rows)} published, {len(work)} questions with gaps, {len(fields)} fields")
        if mode != 'apply' or not fields: continue
        json.dump(work, open(f'es_snapshot_{qtype}.json', 'w'), ensure_ascii=False)
        got = {}
        todo = [(i, en) for i, en in fields if en not in FIXED]
        for i, en in fields:
            if en in FIXED: got[i] = FIXED[en]
        for s in range(0, len(todo), 60):
            got.update(translate(todo[s:s + 60])); print(f"  translated {min(s + 60, len(todo))}/{len(todo)}")
        json.dump(got, open(f'es_fill_{qtype}.json', 'w'), ensure_ascii=False)
        nq = nf = 0
        for qid, data in work.items():
            changed = {'prompt': False, 'explanation': False, 'payload': False}
            for key, es in got.items():
                q, p = key.split('|', 1)
                if q != qid: continue
                path = json.loads(p); root = data[path[0]]
                if set_es(root, path[1:], es): changed[path[0]] = True; nf += 1
            if changed['prompt']:
                cur.execute("update questions set prompt = %s::jsonb, updated_at = now() where id = %s", (json.dumps(data['prompt'], ensure_ascii=False), qid))
            if changed['explanation']:
                cur.execute("update questions set explanation = %s::jsonb, updated_at = now() where id = %s", (json.dumps(data['explanation'], ensure_ascii=False), qid))
            if changed['payload']:
                cur.execute("update question_payloads set payload = %s::jsonb, updated_at = now() where question_id = %s", (json.dumps(data['payload'], ensure_ascii=False), qid))
            if any(changed.values()): nq += 1
        conn.commit(); print(f"  applied: {nq} questions, {nf} fields")
