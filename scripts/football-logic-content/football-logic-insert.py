"""Insert generated Football Logic questions into a Quizball DB (published) and bump questionCount to 10."""
import json, sys, uuid, psycopg
db_url, asset_base = sys.argv[1], sys.argv[2]
CATEGORY = '5e620b65-5de2-43ec-891f-57b14efb4722'
qs = json.load(open(__file__.rsplit('/', 1)[0] + '/questions.json'))
with psycopg.connect(db_url) as conn, conn.cursor() as cur:
    ids_file = __file__.rsplit('/', 1)[0] + '/inserted-ids.' + db_url.rsplit('/', 1)[1].split('?')[0] + '.json'
    import os
    if os.path.exists(ids_file): sys.exit('already inserted: ' + ids_file)
    ids = []
    for q in qs:
        qid = str(uuid.uuid4()); ids.append(qid)
        prompt = q['prompt']
        payload = {'type': 'football_logic', 'prompt': q['prompt'], 'explanation': q['explanation'],
                   'image_a_url': q['image_a_url'].replace('{{ASSET_BASE}}', asset_base),
                   'image_b_url': q['image_b_url'].replace('{{ASSET_BASE}}', asset_base),
                   'display_answer': q['display_answer'], 'accepted_answers': q['accepted_answers']}
        cur.execute("""insert into questions (id, category_id, type, difficulty, status, prompt, explanation, ranked_eligible, visibility)
                       values (%s, %s, 'football_logic', %s, 'published', %s, %s, true, 'public')""",
                    (qid, CATEGORY, q['difficulty'], json.dumps(prompt, ensure_ascii=False), json.dumps(q['explanation'], ensure_ascii=False)))
        cur.execute("insert into question_payloads (question_id, payload) values (%s, %s)", (qid, json.dumps(payload, ensure_ascii=False)))
    cur.execute("""update daily_challenge_configs set settings = settings || '{"questionCount": 5}'::jsonb, updated_at = now()
                   where challenge_type = 'footballLogic'""")
    conn.commit()
    json.dump(ids, open(ids_file, 'w'))
    cur.execute("select count(*) from questions where type='football_logic' and status='published'"); print('published football_logic:', cur.fetchone()[0])
