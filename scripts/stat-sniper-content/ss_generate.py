"""Stat Sniper content: numeric football facts, each traceable to a Transfermarkt dataset row.
Kinds: transfer fee, league goals in a season, final attendance, peak market value, height.
Players come from the Pass Chain universe (Georgian names + clubs); prompts are templated en/ka/es.
Usage: ss_generate.py   → questions.json next to this file"""
import csv, gzip, json, os, re, collections, random
HERE = os.path.dirname(os.path.abspath(__file__)); DATA = '/Users/user/dev/quizball-worktrees/grid-launch-data/transfermarkt'
universe = json.load(open(f'{os.path.dirname(HERE)}/pass-chain-content/universe.json'))
CLUB_KA = json.load(open(f'{os.path.dirname(HERE)}/missing-xi-content/clubs-ka.json'))
by_tm = {int(k): v for k, v in universe.items()}
famous = {tm for tm, p in sorted(by_tm.items(), key=lambda kv: -kv[1]['fame'])[:450]}
club_label = {}
for p in by_tm.values():
    for c in p['clubs']: club_label[c['key']] = c
def club_i18n(cid, name):
    c = club_label.get(f'tm{cid}')
    if c: return {'en': c['en'], 'ka': c['ka'], 'es': c['es']}
    return {'en': name, 'ka': CLUB_KA.get(name, name), 'es': name}
def season_label(s): s = int(s); return f'{s}/{str(s + 1)[-2:]}'
COMP = {'CL': ('Champions League', 'ჩემპიონთა ლიგა', 'Champions League'), 'EL': ('Europa League', 'ევროპა ლიგა', 'Europa League'), 'FAC': ('FA Cup', 'FA Cup', 'FA Cup'),
        'CDR': ('Copa del Rey', 'მეფის თასი', 'Copa del Rey'), 'CIT': ('Coppa Italia', 'იტალიის თასი', 'Coppa Italia'), 'DFB': ('DFB-Pokal', 'გერმანიის თასი', 'DFB-Pokal'),
        'USC': ('UEFA Super Cup', 'UEFA სუპერთასი', 'Supercopa de Europa'), 'UCOL': ('Conference League', 'კონფერენციის ლიგა', 'Conference League')}
LEAGUE = {'GB1', 'ES1', 'IT1', 'L1', 'FR1'}  # league appearances only for the goals questions
questions = []
def add(kind, prompt, unit, value, lo, hi, step, source, difficulty):
    questions.append({'kind': kind, 'prompt': prompt, 'unit': unit, 'value': value, 'min': lo, 'max': hi, 'step': step, 'source': source, 'difficulty': difficulty})
def name3(p): return {'en': p['name']['en'], 'ka': p['name']['ka'], 'es': p['name']['es']}
def fmt(tpl, **kw): return {l: tpl[l].format(**{k: (v[l] if isinstance(v, dict) else v) for k, v in kw.items()}) for l in ('en', 'ka', 'es')}

# 1. transfer fees ≥ €20M for famous players
FEE = {'en': 'Transfer fee: {player} → {club}, {season}?', 'ka': 'ტრანსფერის ღირებულება: {player} → {club}, {season}?', 'es': 'Precio del traspaso: {player} → {club}, {season}?'}
EURM = {'en': '€M', 'ka': 'მლნ €', 'es': 'M€'}
seen = set()
for r in csv.DictReader(gzip.open(f'{DATA}/transfers.csv.gz', 'rt')):
    pid = int(r['player_id']); fee = float(r['transfer_fee'] or 0)
    if pid not in famous or fee < 20_000_000 or not r['to_club_id']: continue
    key = (pid, r['transfer_season']);
    if key in seen: continue
    seen.add(key)
    m = round(fee / 1_000_000); hi = 100 if m <= 50 else (200 if m <= 120 else 300)
    add('fee', fmt(FEE, player=name3(by_tm[pid]), club=club_i18n(r['to_club_id'], r['to_club_name']), season=r['transfer_season']), EURM, m, 0, hi, 1,
        {'dataset': 'transfermarkt/transfers', 'player_id': pid, 'to_club_id': int(r['to_club_id']), 'season': r['transfer_season']}, 'easy' if m >= 60 else 'medium')

# 2. league goals in a season (top-5 leagues), ≥ 12 goals
goals = collections.Counter(); club_of = {}
for r in csv.DictReader(gzip.open(f'{DATA}/appearances.csv.gz', 'rt')):
    pid = int(r['player_id'])
    if pid not in famous or r['competition_id'] not in LEAGUE: continue
    y, mth = int(r['date'][:4]), int(r['date'][5:7]); season = y if mth >= 7 else y - 1
    goals[(pid, season, r['competition_id'])] += int(r['goals'] or 0); club_of[(pid, season, r['competition_id'])] = int(r['player_club_id'] or 0)
GOALS = {'en': 'League goals: {player}, {club}, {season}?', 'ka': 'ლიგის გოლები: {player}, {club}, {season}?', 'es': 'Goles en liga: {player}, {club}, {season}?'}
GOALU = {'en': 'goals', 'ka': 'გოლი', 'es': 'goles'}
tm_clubs = {int(r['club_id']): r['name'] for r in csv.DictReader(gzip.open(f'{DATA}/clubs.csv.gz', 'rt'))}
for (pid, season, comp), g in goals.items():
    if g < 12: continue
    cid = club_of[(pid, season, comp)]
    add('goals', fmt(GOALS, player=name3(by_tm[pid]), club=club_i18n(cid, tm_clubs.get(cid, '')), season=season_label(season)), GOALU, g, 0, 50, 1,
        {'dataset': 'transfermarkt/appearances', 'player_id': pid, 'season': season, 'competition_id': comp}, 'easy' if g >= 25 else 'medium')

# 3. attendance at finals
ATT = {'en': 'Attendance: {home} vs {away}, {comp} final {season}?', 'ka': 'დამსწრეთა რაოდენობა: {home} – {away}, {comp} ფინალი {season}?', 'es': 'Asistencia: {home} vs {away}, final de {comp} {season}?'}
ATTU = {'en': 'spectators', 'ka': 'მაყურებელი', 'es': 'espectadores'}
for r in csv.DictReader(gzip.open(f'{DATA}/games.csv.gz', 'rt')):
    if r['round'].lower() != 'final' or r['competition_id'] not in COMP or not (r['attendance'] or '').strip(): continue
    att = int(float(r['attendance']))
    if att < 10000: continue
    comp = {'en': COMP[r['competition_id']][0], 'ka': COMP[r['competition_id']][1], 'es': COMP[r['competition_id']][2]}
    add('attendance', fmt(ATT, home=club_i18n(r['home_club_id'], r['home_club_name']), away=club_i18n(r['away_club_id'], r['away_club_name']), comp=comp, season=season_label(r['season'])), ATTU,
        att, 0, 100000, 500, {'dataset': 'transfermarkt/games', 'game_id': int(r['game_id'])}, 'medium' if r['competition_id'] in ('CL', 'EL') else 'hard')

# 4. peak market value (Transfermarkt valuation) and 5. height
PEAK = {'en': 'Peak Transfermarkt value: {player}?', 'ka': 'პიკური საბაზრო ღირებულება (Transfermarkt): {player}?', 'es': 'Valor máximo en Transfermarkt: {player}?'}
HGT = {'en': 'Height: {player}?', 'ka': 'სიმაღლე: {player}?', 'es': 'Estatura: {player}?'}
CM = {'en': 'cm', 'ka': 'სმ', 'es': 'cm'}
for r in csv.DictReader(gzip.open(f'{DATA}/players.csv.gz', 'rt')):
    pid = int(r['player_id'])
    if pid not in famous: continue
    peak = float(r['highest_market_value_in_eur'] or 0); h = int(float(r['height_in_cm'] or 0))
    if peak >= 30_000_000:
        m = round(peak / 1_000_000); add('peak', fmt(PEAK, player=name3(by_tm[pid])), EURM, m, 0, 100 if m <= 60 else 200, 1, {'dataset': 'transfermarkt/players', 'player_id': pid, 'field': 'highest_market_value_in_eur'}, 'medium')
    if 160 <= h <= 205:
        add('height', fmt(HGT, player=name3(by_tm[pid])), CM, h, 160, 205, 1, {'dataset': 'transfermarkt/players', 'player_id': pid, 'field': 'height_in_cm'}, 'easy')
# balance kinds: heights and valuations only for the most famous names
rank = {tm: i for i, tm in enumerate(sorted(famous, key=lambda tm: -by_tm[tm]['fame']))}
questions = [q for q in questions if not (q['kind'] == 'height' and rank.get(q['source'].get('player_id'), 999) >= 150) and not (q['kind'] == 'peak' and rank.get(q['source'].get('player_id'), 999) >= 220)]
random.seed(11); random.shuffle(questions)
json.dump(questions, open(f'{HERE}/questions.json', 'w'), ensure_ascii=False)
print('questions', len(questions), collections.Counter(q['kind'] for q in questions), collections.Counter(q['difficulty'] for q in questions))
for q in questions[:6]: print(' ', q['prompt']['en'], '=', q['value'], q['unit']['en'], '|', q['prompt']['ka'])
