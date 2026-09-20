"""Insert Missing XI squads as published missing_xi questions and configure the daily.
Usage: xi_insert.py <db_url>"""
import json, os, sys, uuid, psycopg
db_url = sys.argv[1]; HERE = os.path.dirname(os.path.abspath(__file__))
squads = json.load(open(f'{HERE}/squads.json'))
ids_file = f"{HERE}/inserted-ids.{db_url.rsplit('/', 1)[1].split('?')[0]}.json"
if os.path.exists(ids_file): sys.exit('already inserted: ' + ids_file)
with psycopg.connect(db_url, autocommit=True, prepare_threshold=None) as conn, conn.cursor() as cur:
    cur.execute("select id from categories where slug = 'missing-xi'"); row = cur.fetchone()
    if row: cat = str(row[0])
    else:
        cat = str(uuid.uuid4())
        cur.execute("""insert into categories (id, slug, name, description, is_active) values (%s, 'missing-xi', %s, %s, true)""",
                    (cat, json.dumps({'en': 'Missing XI', 'ka': 'დაკარგული XI', 'es': 'XI perdido'}), json.dumps({'en': 'Famous starting line-ups', 'ka': 'ცნობილი შემადგენლობები', 'es': 'Alineaciones famosas'})))
    ids = []
    for s in squads:
        qid = str(uuid.uuid4()); ids.append(qid)
        prompt = {'en': f"{s['team']['en']} – {s['match_label']['en']}", 'ka': f"{s['team']['ka']} – {s['match_label']['ka']}", 'es': f"{s['team']['es']} – {s['match_label']['es']}"}
        payload = {'type': 'missing_xi', 'team': s['team'], 'opponent': s['opponent'], 'match_label': s['match_label'], 'formation': s['formation'], 'score': s['score'], 'season': s['season'],
                   'slots': [{'id': sl['id'], 'position': sl['position'], 'number': sl['number'], 'x': sl['x'], 'y': sl['y'], 'name': sl['name'], 'accepted_answers': sl['accepted_answers'], 'tm_id': sl['tm_id']} for sl in s['slots']]}
        cur.execute("""insert into questions (id, category_id, type, difficulty, status, prompt, explanation, ranked_eligible, visibility)
                       values (%s, %s, 'missing_xi', %s, 'published', %s, null, true, 'public')""", (qid, cat, s['difficulty'], json.dumps(prompt, ensure_ascii=False)))
        cur.execute("insert into question_payloads (question_id, payload) values (%s, %s)", (qid, json.dumps(payload, ensure_ascii=False)))
    cur.execute("select 1 from daily_challenge_configs where challenge_type = 'missingXi'")
    settings = json.dumps({'challengeType': 'missingXi', 'categoryIds': [cat], 'squadCount': 3, 'secondsPerSquad': 120})
    if cur.fetchone():
        cur.execute("update daily_challenge_configs set settings = %s::jsonb, is_active = true, updated_at = now() where challenge_type = 'missingXi'", (settings,))
    else:
        cur.execute("""insert into daily_challenge_configs (challenge_type, is_active, sort_order, show_on_home, coin_reward, xp_reward, settings)
                       values ('missingXi', true, 11, false, 30, 90, %s::jsonb)""", (settings,))
    json.dump(ids, open(ids_file, 'w'))
    cur.execute("select count(*) from questions where type = 'missing_xi' and status = 'published'"); print('published missing_xi:', cur.fetchone()[0], 'category', cat)
