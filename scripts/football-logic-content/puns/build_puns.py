"""Turn puns_raw.json (model drafts) into Football Logic questions: validate icons, download
OpenMoji PNGs, translate explanations, attach accepted answers. Output: puns_questions.json + icons/."""
import json, os, ssl, certifi, urllib.request, collections, subprocess
HERE = os.path.dirname(os.path.abspath(__file__)); ctx = ssl.create_default_context(cafile=certifi.where())
raw = json.load(open(f'{HERE}/puns_raw.json')); vocab = dict(json.load(open(f'{HERE}/vocab.json')))
players = {p['tm']: p for p in json.load(open(f'{HERE}/famous_players.json'))}
ICON = '{{ASSET_BASE}}/imgs/football-logic/openmoji/%s.png'
os.makedirs(f'{HERE}/icons', exist_ok=True)
def fetch(hexcode):
    path = f'{HERE}/icons/{hexcode}.png'
    if os.path.exists(path): return True
    for base in ('https://cdn.jsdelivr.net/gh/hfg-gmuend/openmoji@15.1.0/color/618x618/', 'https://raw.githubusercontent.com/hfg-gmuend/openmoji/15.1.0/color/618x618/'):
        try:
            data = urllib.request.urlopen(base + hexcode + '.png', timeout=60, context=ctx).read()
            if len(data) > 200: open(path, 'wb').write(data); return True
        except Exception: pass
    return False
keep = []; seen = set(); stats = collections.Counter()
for r in raw:
    tm = str(r.get('tm')); a = str(r.get('a', '')).upper(); b = str(r.get('b', '')).upper()
    if tm not in players or tm in seen: stats['dup_or_unknown'] += 1; continue
    if a not in vocab or b not in vocab or a == b: stats['bad_icon'] += 1; continue
    if r.get('confidence') == 'low': stats['low_conf'] += 1; continue
    if not fetch(a) or not fetch(b): stats['no_png'] += 1; continue
    seen.add(tm); keep.append({**r, 'tm': tm, 'a': a, 'b': b, 'a_name': vocab[a], 'b_name': vocab[b]}); stats['kept'] += 1
print(dict(stats))
# translate the explanations (es, ka, tr) in batches
KEY = os.environ['OPENROUTER_API_KEY']; MODEL = os.environ['OPENROUTER_MODEL']
def translate(items):
    prompt = ("Translate these one-sentence football riddle explanations into Spanish, Georgian and Turkish. Keep player names as written (Georgian: transliterate the player name). "
              "Return ONLY {\"items\": [{\"id\": id, \"es\": ..., \"ka\": ..., \"tr\": ...}]}.\n\n" + json.dumps(items, ensure_ascii=False))
    req = urllib.request.Request('https://openrouter.ai/api/v1/chat/completions', data=json.dumps({'model': MODEL, 'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0, 'response_format': {'type': 'json_object'}}).encode(), headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    return {x['id']: x for x in json.loads(json.load(urllib.request.urlopen(req, timeout=300, context=ctx))['choices'][0]['message']['content'].strip().strip('`').removeprefix('json').strip())['items']}
tr = {}
for s in range(0, len(keep), 40): tr.update(translate([{'id': r['tm'], 'en': r['why']} for r in keep[s:s + 40]]))
PROMPT = {'en': 'Two pictures, one player. Who?', 'es': 'Dos imágenes, un jugador. ¿Quién?', 'ka': 'ორი სურათი, ერთი ფეხბურთელი. ვინ?', 'tr': 'İki resim, bir oyuncu. Kim?'}
qs = []
for r in keep:
    p = players[r['tm']]; t = tr.get(r['tm'], {})
    qs.append({'family': 'picture_pun', 'tm_id': r['tm'], 'difficulty': r.get('difficulty', 'medium'), 'prompt': PROMPT,
               'explanation': {'en': r['why'], 'es': t.get('es', r['why']), 'ka': t.get('ka', r['why']), 'tr': t.get('tr', r['why'])},
               'image_a_url': ICON % r['a'], 'image_b_url': ICON % r['b'],
               'display_answer': {'en': p['name'], 'es': p['name'], 'ka': p['ka'] or p['name'], 'tr': p['name']},
               'accepted_answers': sorted(set(p['aliases']) | {p['name']}), 'facts': {'a': r['a_name'], 'b': r['b_name'], 'confidence': r.get('confidence')}})
json.dump(qs, open(f'{HERE}/puns_questions.json', 'w'), ensure_ascii=False, indent=1)
print('questions', len(qs), 'icons', len({q['image_a_url'] for q in qs} | {q['image_b_url'] for q in qs}))
