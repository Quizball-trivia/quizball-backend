"""Daily content playbook audit. For every daily challenge type: supply vs demand,
difficulty split, locale coverage of every text field, image presence + reachability.
Usage: daily_content_audit.py <db_url> <out.json> [months=4]"""
import json, sys, ssl, certifi, urllib.request, random, collections, concurrent.futures, psycopg
db_url, out_path = sys.argv[1], sys.argv[2]; MONTHS = float(sys.argv[3]) if len(sys.argv) > 3 else 4
ctx = ssl.create_default_context(cafile=certifi.where()); random.seed(1)
QTYPE = {'moneyDrop': 'mcq_single', 'trueFalse': 'true_false', 'countdown': 'countdown_list', 'clues': 'clue_chain', 'putInOrder': 'put_in_order',
         'imposter': 'imposter_multi_select', 'careerPath': 'career_path', 'highLow': 'high_low', 'footballLogic': 'football_logic'}
LOCALES = ('en', 'ka', 'es')
def walk_text(node, out):
    if isinstance(node, dict):
        if isinstance(node.get('en'), str) and node['en'].strip():
            out.append(node); return
        for k, v in node.items():
            if k in ('accepted_answers',): continue
            walk_text(v, out)
    elif isinstance(node, list):
        for v in node: walk_text(v, out)
def walk_images(node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str) and v.startswith('http') and ('image' in k or k == 'url' or k.endswith('_url')): out.append(v)
            else: walk_images(v, out)
    elif isinstance(node, list):
        for v in node: walk_images(v, out)
def head(url):
    """GET with a browser UA (Wikimedia rejects bare HEAD/urllib); body is discarded after reading the size."""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 QuizballAudit/1.0'})
        with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
            size = int(r.headers.get('Content-Length') or 0) or len(r.read())
            return r.status, size, r.headers.get('Content-Type', '')
    except urllib.error.HTTPError as e: return e.code, 0, ''
    except Exception: return 0, 0, ''
def _unused():
    try: pass
    except urllib.error.HTTPError as e: return e.code, 0, ''
    except Exception: return 0, 0, ''
report = {}
with psycopg.connect(db_url, autocommit=True, prepare_threshold=None) as conn, conn.cursor() as cur:
    cur.execute("select challenge_type, is_active, settings from daily_challenge_configs"); configs = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    for ctype, qtype in QTYPE.items():
        active, settings = configs.get(ctype, (False, {}))
        per_day = settings.get('questionCount') or settings.get('roundCount') or 0
        cats = settings.get('categoryIds') or []
        cur.execute(f"""select q.id, q.difficulty, q.prompt, q.explanation, qp.payload, q.created_by is not null as manual, q.created_at
                        from questions q join question_payloads qp on qp.question_id = q.id join categories c on c.id = q.category_id
                        where q.status = 'published' and q.visibility = 'public' and q.ranked_eligible and q.type = %s and c.is_active
                          and not exists (select 1 from featured_categories fc where fc.category_id = c.id)
                          {'and q.category_id = any(%s::uuid[])' if cats else ''}""", (qtype, cats) if cats else (qtype,))
        rows = cur.fetchall()
        diff = collections.Counter(r[1] for r in rows); gaps = collections.Counter(); texts = 0; images = set(); newest = None
        for r in rows:
            found = []; walk_text(r[2], found); walk_text(r[3], found); walk_text(r[4], found); texts += len(found)
            for t in found:
                for loc in LOCALES:
                    if not (t.get(loc) or '').strip(): gaps[loc] += 1
            imgs = []; walk_images(r[4], imgs); images.update(imgs)
            newest = max(newest, r[6]) if newest else r[6]
        img_report = None
        if images:
            sample = random.sample(sorted(images), min(400, len(images)))
            with concurrent.futures.ThreadPoolExecutor(16) as ex: results = list(ex.map(head, sample))
            bad = [u for u, (code, _, _) in zip(sample, results) if code not in (200, 429)]
            limited = sum(1 for _, (code, _, _) in zip(sample, results) if code == 429)
            sizes = [s for _, s, _ in results if s]
            hot = [u for u in images if 'supabase.co' not in u]
            img_report = {'distinct': len(images), 'hotlinked_external': len(hot), 'checked': len(sample), 'broken': len(bad), 'rate_limited_hotlinks': limited, 'broken_examples': bad[:5],
                          'avg_kb': round(sum(sizes) / len(sizes) / 1024, 1) if sizes else None, 'over_500kb': sum(1 for s in sizes if s > 512000)}
        n = len(rows); days = round(n / per_day, 1) if per_day else None
        report[ctype] = {'question_type': qtype, 'active': active, 'per_day': per_day, 'category_scoped': bool(cats), 'pool': n,
                         'days_no_repeat': days, 'months_target': MONTHS, 'enough': (days or 0) >= MONTHS * 30,
                         'difficulty': dict(diff), 'text_fields': texts, 'missing_by_locale': dict(gaps), 'images': img_report,
                         'newest_question': newest.isoformat() if newest else None}
        print(ctype, 'pool', n, 'per_day', per_day, 'days', days, 'diff', dict(diff), 'gaps', dict(gaps), 'images', img_report and (img_report['distinct'], img_report['broken']))
    # FIFA Cards daily: cards live in fifa_cards, 10 per day drawn by tier.
    active, settings = configs.get('fifaCards', (False, {})); per_day = settings.get('cardCount', 10)
    cur.execute("select difficulty, count(*), count(*) filter (where coalesce(name_ka,'')=''), count(*) filter (where photo_id is null or face_source='none'), count(*) filter (where cardinality(accepted) < 2) from fifa_cards where is_active and not generator_retired group by 1")
    rows = cur.fetchall(); pool = sum(r[1] for r in rows)
    cur.execute("select photo_id, photo_ver from fifa_cards where is_active and photo_id is not null order by random() limit 60"); faces = cur.fetchall()
    import re as _re
    src = open('/Users/user/dev/quizball-worktrees/grid-bo3-backend/src/modules/daily-challenges/fifa-face-url.ts').read()
    tmpl = _re.search(r"`([^`]*\$\{[^`]*)`", src); face_urls = []
    if tmpl:
        t = tmpl.group(1)
        base = db_url.split('@')[1].split('.')[0].replace('aws-1-eu-central-1', '')
        project = 'lfbwhxvwubzeqkztghok' if 'lfbwhx' in db_url else 'nsdfiprfmhdqhbfxfwpv'
        for pid, ver in faces: face_urls.append(f"https://{project}.supabase.co/storage/v1/object/public/imgs/fifa-faces/{pid}_{urllib.request.quote(str(ver or ''))}.webp")
    results = [head(u) for u in face_urls]; broken = [u for u, (c, _, _) in zip(face_urls, results) if c != 200]
    report['fifaCards'] = {'question_type': 'fifa_cards', 'active': active, 'per_day': per_day, 'pool': pool, 'days_no_repeat': round(pool / per_day, 1),
        'months_target': MONTHS, 'enough': pool / per_day >= MONTHS * 30, 'difficulty': {r[0]: r[1] for r in rows},
        'missing_by_locale': {'ka_name': sum(r[2] for r in rows)}, 'no_face_photo': sum(r[3] for r in rows), 'few_accepted': sum(r[4] for r in rows),
        'images': {'checked': len(face_urls), 'broken': len(broken), 'broken_examples': broken[:3], 'face_url_template': tmpl.group(1) if tmpl else None}}
    print('fifaCards', report['fifaCards'])
json.dump(report, open(out_path, 'w'), ensure_ascii=False, indent=1)
