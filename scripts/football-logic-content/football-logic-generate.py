"""Football Logic daily riddles, computed only from the Transfermarkt dataset.
Every riddle is a fact the dataset proves with a uniqueness check; nothing is
written from memory. Output: questions.json + review.csv in this directory."""
import csv, json, re, sys, unicodedata, random
from collections import defaultdict
from pathlib import Path
import duckdb

HERE = Path(__file__).parent
DATA = Path('/Users/user/dev/quizball-worktrees/grid-launch-data/transfermarkt')
WEB = Path('/Users/user/dev/quizball-worktrees/grid-parity-web')
sys.path.insert(0, '/Users/user/dev/quizball-worktrees/grid-bo3-backend/scripts/football-grid-content-generator')
import importlib
gen = importlib.import_module('football-grid-build-launch-manifest')

FLAG = '{{ASSET_BASE}}/imgs/football-grid/v1/flags/%s.svg'
CREST = '{{ASSET_BASE}}/imgs/club-logos/%s'
MIN_SEASON = 2012  # dataset appearance coverage starts 2012/13; older facts are not provable here

def comparable(v):
    v = unicodedata.normalize('NFKD', v or '').encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '', v)

registry = json.loads((WEB / 'src/data/football-grid/launch-assets/clubs.json').read_text())
registry = registry if isinstance(registry, list) else registry['items']
master = json.loads((WEB / 'src/data/clubs.json').read_text())
master_logo = {}
for c in master:
    if c.get('logo'):
        master_logo[c['id']] = c['logo']; master_logo[comparable(c.get('label'))] = c['logo']
master_logo.update({'stade-rennais': 'stade-rennais.png', 'locomotive-tbilisi': 'locomotive-tbilisi.png',
                    'saburtalo-tbilisi': 'saburtalo-tbilisi.png', 'san-lorenzo': 'san-lorenzo.png', 'santos': 'santos-fc-brazil.png'})
countries = json.loads((WEB / 'src/data/football-grid/launch-assets/countries.json').read_text())
countries = countries if isinstance(countries, list) else countries['items']
country_by_en = {c['labelEn'].lower(): c for c in countries}
COUNTRY_FIX = {'korea, south': 'south korea', 'cote d\'ivoire': 'ivory coast', 'the gambia': 'gambia', 'dr congo': 'dr congo',
               'bosnia-herzegovina': 'bosnia and herzegovina', 'türkiye': 'turkey', 'cape verde': 'cabo verde', 'czech republic': 'czechia',
               'north macedonia': 'north macedonia', 'st. kitts & nevis': 'saint kitts and nevis', 'curacao': 'curaçao', 'neukaledonien': 'new caledonia'}
def flag_for(country):
    if not country: return None
    key = country.lower(); key = COUNTRY_FIX.get(key, key)
    item = country_by_en.get(key)
    return item['id'] if item else None

crit_ka = {}
CLUB_KA = json.load(open(HERE / 'clubs-ka.json')) if (HERE / 'clubs-ka.json').exists() else {}
for row in csv.DictReader(open(HERE / 'criteria.csv')):
    if row['family'] == 'club' and re.search(r'[\u10a0-\u10ff]', row['label_ka'] or ''): crit_ka[row['criterion_key'].split(':', 1)[1]] = row['label_ka']

# Files in imgs/club-logos that are the generic placeholder badge (md5 0f27a0f4…),
# audited 2026-09-05 — a riddle must never show one of these.
PLACEHOLDER_LOGOS = {'wl-bournemouth.png', 'wl-crystal-palace.png', 'wl-cska-moscow.png', 'wl-espanyol.png', 'wl-heerenveen.png',
                     'wl-lille.png', 'wl-malaga.png', 'wl-nice.png', 'wl-paok.png', 'wl-stoke-city.png'}
# Registry ids whose master logo is a WL-era copy; prefer the full-size crest.
PREFERRED_MASTER = {'wl-lille': 'losc-lille', 'wl-nice': 'ogc-nice', 'wl-espanyol': 'rcd-espanyol', 'wl-lyon': 'olympique-lyonnais',
                    'wl-fiorentina': 'acf-fiorentina', 'wl-benfica': 'sl-benfica', 'wl-hamburger-sv': 'hamburger-sv', 'wl-wolfsburg': 'wl-vfl-wolfsburg'}
# Real crests uploaded 2026-09-05 (luukhopman/football-logos) for registry ids whose master logo is the placeholder.
EXTRA_LOGOS = {'wl-bournemouth': 'afc-bournemouth.png', 'wl-crystal-palace': 'crystal-palace.png', 'wl-cska-moscow': 'cska-moscow.png',
               'wl-malaga': 'malaga-cf.png', 'wl-paok': 'paok.png', 'wl-heerenveen': 'sc-heerenveen.png'}
club_cache = {}
def club_asset(tm_name):
    """TM club name -> (labelEn, labelKa, crest url) or None when no real crest exists."""
    if tm_name in club_cache: return club_cache[tm_name]
    item = gen.map_club_item(tm_name, registry)
    out = None
    if item:
        logo = master_logo.get(PREFERRED_MASTER.get(item['id'], '')) or master_logo.get(item['id']) or master_logo.get(comparable(item.get('labelEn')))
        if logo in PLACEHOLDER_LOGOS: logo = EXTRA_LOGOS.get(item['id'])
        if logo: out = (item['labelEn'], crit_ka.get(item['id']) or CLUB_KA.get(item['labelEn']) or item['labelEn'], CREST % logo)
    club_cache[tm_name] = out
    return out

# --- answer pool: players + aliases from the published grid release -----------
pool = {}
for row in csv.DictReader(open(HERE / 'aliases.csv')):
    tm = row['transfermarkt_id']
    if not tm.isdigit(): continue
    p = pool.setdefault(int(tm), {'name': row['name'], 'peak': int(row['peak_value_eur'] or 0), 'aliases': set(), 'ka': None})
    p['aliases'].add(row['alias'])
    if row['alias_type'] == 'georgian' and not p['ka']: p['ka'] = row['alias']

con = duckdb.connect()
for t in ['transfers', 'players', 'appearances', 'games', 'clubs', 'competitions']:
    con.execute(f"create table {t} as select * from read_csv_auto('{DATA}/{t}.csv.gz', header=true)")

players = {r[0]: r for r in con.execute("select player_id, name, first_name, last_name, position, country_of_citizenship, highest_market_value_in_eur from players").fetchall()}
POS = {'Attack': {'en': 'forward', 'es': 'delantero', 'ka': 'თავდამსხმელი', 'tr': 'forvet'},
       'Midfield': {'en': 'midfielder', 'es': 'centrocampista', 'ka': 'ნახევარმცველი', 'tr': 'orta saha oyuncusu'},
       'Defender': {'en': 'defender', 'es': 'defensa', 'ka': 'მცველი', 'tr': 'defans oyuncusu'},
       'Goalkeeper': {'en': 'goalkeeper', 'es': 'portero', 'ka': 'მეკარე', 'tr': 'kaleci'}}

KA_VOWELS = 'აეოუ'
def ka_case(name, case):
    """Attach a Georgian case ending to a club name: ში (in), დან (from), ის (genitive)."""
    if not re.search(r'[\u10a0-\u10ff]$', name):
        return f"{name}-{ {'in': 'ში', 'from': 'დან', 'gen': 'ის'}[case] }"
    if name.endswith('ი'):
        stem = name[:-1]
        return {'in': stem + 'ში', 'from': stem + 'იდან', 'gen': stem + 'ის'}[case]
    if name[-1] in KA_VOWELS:
        return {'in': name + 'ში', 'from': name + 'დან', 'gen': name + 'ს'}[case]
    return {'in': name + 'ში', 'from': name + 'იდან', 'gen': name + 'ის'}[case]

def season_label(s):  # '17/18' or 2017 -> '2017/18'
    if isinstance(s, str) and '/' in s:
        a, b = s.split('/'); a = int(a); return f"{2000 + a if a < 50 else 1900 + a}/{b}"
    return f"{s}/{str(s + 1)[-2:]}"
def season_year(s):
    a = int(s.split('/')[0]); return 2000 + a if a < 50 else 1900 + a

def accepted(tm_id):
    p = pool[tm_id]; pr = players.get(tm_id)
    out = set(p['aliases']); out.add(p['name'])
    if pr:
        if pr[1]: out.add(pr[1])
        if pr[3] and len(pr[3]) >= 4: out.add(pr[3])
        if pr[2] and pr[3]: out.add(f"{pr[2]} {pr[3]}")
    return sorted(a for a in out if a and a.strip())

def difficulty(tm_id, bonus=0):
    peak = pool[tm_id]['peak']
    # With the pool floor at €25M, fame alone decides the tier: superstars easy, regulars medium, the rest hard.
    score = (2 if peak >= 40_000_000 else 1 if peak >= 30_000_000 else 0) + bonus
    return 'easy' if score >= 2 else 'medium' if score == 1 else 'hard'

questions = []
MIN_PEAK = 25_000_000  # owner wants recognisable names, not obscure squad players
def add(family, tm_id, img_a, img_b, prompt, explanation, diff, facts):
    p = pool[tm_id]
    if p['peak'] < MIN_PEAK: return
    questions.append({'family': family, 'tm_id': tm_id, 'difficulty': diff, 'prompt': prompt, 'explanation': explanation,
                      'image_a_url': img_a, 'image_b_url': img_b,
                      'display_answer': {'en': p['name'], 'es': p['name'], 'ka': p['ka'] or p['name'], 'tr': p['name']},
                      'accepted_answers': accepted(tm_id), 'facts': facts})

# --- Family A: direct transfers between two crest-backed clubs (hint-only prompt) ---
rows = con.execute("""select player_id, from_club_name, to_club_name, transfer_season, coalesce(transfer_fee, 0), from_club_id, to_club_id
    from transfers""").fetchall()
by_route_season = defaultdict(list)
for r in rows:
    if season_year(r[3]) < MIN_SEASON: continue
    by_route_season[(r[5], r[6], r[3])].append(r)
used_players = defaultdict(int)
for key, group in sorted(by_route_season.items(), key=lambda kv: -max(g[4] for g in kv[1])):
    if len(group) != 1: continue  # two players on the same route in one season → ambiguous, skip
    r = group[0]; pid = r[0]
    if pid not in pool or r[4] < 5_000_000 or used_players[pid] >= 2: continue
    a = club_asset(r[1]); b = club_asset(r[2])
    if not a or not b or a[2] == b[2]: continue
    s = season_label(r[3]); name = pool[pid]['name']; fee_m = r[4] / 1_000_000; fee_txt = f"{fee_m:.0f}" if fee_m.is_integer() else f"{fee_m:.1f}"
    prompt = {'en': f"One player made this move in {s}. Who?",
              'es': f"Un jugador hizo este traspaso en la {s}. ¿Quién?",
              'ka': f"ერთმა ფეხბურთელმა {s} სეზონში ეს გადასვლა გააკეთა. ვინ?",
              'tr': f"{s} sezonunda bu transferi bir oyuncu yaptı. Kim?"}
    expl = {'en': f"{name} joined {b[0]} from {a[0]} in {s} for €{fee_txt}M.",
            'es': f"{name} fichó por el {b[0]} procedente del {a[0]} en la {s} por {fee_txt} M€.",
            'ka': f"{pool[pid]['ka'] or name} {s} სეზონში {ka_case(a[1], 'from')} {ka_case(b[1], 'in')} €{fee_txt} მლნ-ად გადავიდა.",
            'tr': f"{name}, {s} sezonunda {a[0]} kulübünden {b[0]} kulübüne €{fee_txt} milyon karşılığında transfer oldu."}
    add('transfer', pid, a[2], b[2], prompt, expl, difficulty(pid, 1 if r[4] >= 50_000_000 else 0), {'from': r[1], 'to': r[2], 'season': r[3], 'fee': r[4]})
    used_players[pid] += 1

club_names = {r[0]: r[1] for r in con.execute("select club_id, name from clubs").fetchall()}
# --- Family B: "the only <country> <position> to play for this club since 2012" (flag + crest) ---
con.execute("""create table memberships as select distinct a.player_id, a.player_club_id as club_id from appearances a
    join games g on g.game_id = a.game_id where g.season >= 2012""")
mem = con.execute("select player_id, club_id from memberships").fetchall()
by_ccp = defaultdict(list)
for pid, club_id in mem:
    pr = players.get(pid)
    if not pr or not pr[5] or pr[4] not in POS: continue
    by_ccp[(club_id, pr[5], pr[4])].append(pid)
for (club_id, country, position), pids in by_ccp.items():
    if len(pids) != 1: continue
    pid = pids[0]
    if pid not in pool or used_players[pid] >= 2: continue
    cname = club_names.get(club_id); c = club_asset(cname) if cname else None; flag = flag_for(country)
    if not c or not flag: continue
    pos = POS[position]; name = pool[pid]['name']
    prompt = {'en': f"The only {pos['en']} from this country to play for this club since 2012. Who?",
              'es': f"El único {pos['es']} de este país que ha jugado en este club desde 2012. ¿Quién?",
              'ka': f"ერთადერთი {pos['ka']} ამ ქვეყნიდან, ვინც 2012 წლიდან ამ კლუბში ითამაშა. ვინ?",
              'tr': f"2012'den beri bu kulüpte oynayan bu ülkeden tek {pos['tr']}. Kim?"}
    expl = {'en': f"{name} is the only {pos['en']} from that country to have played for {c[0]} since 2012.",
            'es': f"{name} es el único {pos['es']} de ese país que ha jugado en el {c[0]} desde 2012.",
            'ka': f"{pool[pid]['ka'] or name} ერთადერთი {pos['ka']}ა იმ ქვეყნიდან, ვინც 2012 წლიდან {ka_case(c[1], 'in')} ითამაშა.",
            'tr': f"{name}, 2012'den beri {c[0]} formasını giyen o ülkeden tek {pos['tr']}."}
    add('only_one', pid, FLAG % flag, c[2], prompt, expl, difficulty(pid), {'club': cname, 'country': country, 'position': position})
    used_players[pid] += 1

# Keep the "only one" family from crowding the round: the 350 most famous players only.
only = sorted([q for q in questions if q['family'] == 'only_one'], key=lambda q: -pool[q['tm_id']]['peak'])[:350]
questions = [q for q in questions if q['family'] != 'only_one'] + only
hard = sorted([q for q in questions if q['difficulty'] == 'hard'], key=lambda q: -pool[q['tm_id']]['peak'])
rest = [q for q in questions if q['difficulty'] != 'hard']
questions = rest + hard  # keep every hard riddle; the picker serves 1 hard per round
random.seed(20260905)
random.shuffle(questions)
json.dump(questions, open(HERE / 'questions.json', 'w'), ensure_ascii=False, indent=1)
with open(HERE / 'review.csv', 'w') as f:
    w = csv.writer(f); w.writerow(['family', 'difficulty', 'answer', 'prompt_en', 'explanation_en', 'facts', 'image_a', 'image_b', 'accepted_count'])
    for q in questions:
        w.writerow([q['family'], q['difficulty'], q['display_answer']['en'], q['prompt']['en'], q['explanation']['en'], json.dumps(q['facts'], ensure_ascii=False),
                    q['image_a_url'].split('/')[-1], q['image_b_url'].split('/')[-1], len(q['accepted_answers'])])
from collections import Counter
print('total', len(questions)); print(Counter(q['family'] for q in questions)); print(Counter(q['difficulty'] for q in questions))
print('distinct players', len({q['tm_id'] for q in questions}))
