"""Missing XI squads from Transfermarkt starting line-ups: finals, super cups and
famous fixtures between big clubs, 2013-2025. Every squad is a real 11 with the
positions and shirt numbers Transfermarkt recorded for that match."""
import csv, json, re, sys, unicodedata, collections
import duckdb
import os; HERE = os.path.dirname(os.path.abspath(__file__))
DATA = '/Users/user/dev/quizball-worktrees/grid-launch-data/transfermarkt'
sys.path.insert(0, '/Users/user/dev/quizball-worktrees/grid-bo3-backend/scripts/football-grid-content-generator')
import importlib; gen = importlib.import_module('football-grid-build-launch-manifest')
WEB = '/Users/user/dev/quizball-worktrees/grid-parity-web'
registry = json.load(open(f'{WEB}/src/data/football-grid/launch-assets/clubs.json'))
registry = registry if isinstance(registry, list) else registry['items']
master = {c['id']: c for c in json.load(open(f'{WEB}/src/data/clubs.json'))}
CLUB_KA = json.load(open(f'{HERE}/clubs-ka.json'))
def key(s): return re.sub(r'[^a-z0-9]+', ' ', unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()).strip()

# --- players + aliases -------------------------------------------------------
pool = {}
for r in csv.DictReader(open(f'{HERE}/aliases.csv')):
    tm = r['transfermarkt_id']
    if not tm.isdigit(): continue
    p = pool.setdefault(int(tm), {'name': r['name'], 'peak': int(r['peak_value_eur'] or 0), 'aliases': set(), 'ka': None})
    p['aliases'].add(r['alias'])
    if r['alias_type'] == 'georgian' and not p['ka']: p['ka'] = r['alias']

# --- matches -----------------------------------------------------------------
con = duckdb.connect()
for t in ['games', 'competitions', 'clubs']: con.execute(f"create table {t} as select * from read_csv_auto('{DATA}/{t}.csv.gz', header=true)")
con.execute(f"create table game_lineups as select * from read_csv_auto('{DATA}/game_lineups.csv.gz', header=true, all_varchar=true, strict_mode=false, ignore_errors=true)")
con.execute("create table xi as select game_id, club_id, count(*) n from game_lineups where type='starting_lineup' group by 1,2 having count(*)=11")
con.execute("""create table full_xi as select g.*, c.name as comp_name, c.type as comp_type from games g
    join competitions c on c.competition_id = g.competition_id
    join xi h on h.game_id=g.game_id and h.club_id=g.home_club_id join xi a on a.game_id=g.game_id and a.club_id=g.away_club_id""")
BIG = ['Real Madrid', 'FC Barcelona', 'Atlético de Madrid', 'Manchester City', 'Manchester United', 'Liverpool FC', 'Chelsea FC', 'Arsenal FC', 'Tottenham Hotspur',
       'Bayern Munich', 'Borussia Dortmund', 'Juventus FC', 'Inter Milan', 'AC Milan', 'SSC Napoli', 'Associazione Sportiva Roma', 'Paris Saint-Germain', 'Ajax Amsterdam',
       'SL Benfica', 'FC Porto', 'Sporting CP', 'Celtic FC', 'Rangers FC', 'Galatasaray', 'Fenerbahce', 'Bayer 04 Leverkusen', 'Sevilla FC', 'Olympique Marseille', 'Olympique Lyon']
DERBIES = [('Real Madrid', 'FC Barcelona'), ('Real Madrid', 'Atlético de Madrid'), ('Manchester City', 'Manchester United'), ('Liverpool FC', 'Manchester United'),
           ('Arsenal FC', 'Tottenham Hotspur'), ('Chelsea FC', 'Arsenal FC'), ('Liverpool FC', 'Everton FC'), ('Bayern Munich', 'Borussia Dortmund'), ('Juventus FC', 'Inter Milan'),
           ('Inter Milan', 'AC Milan'), ('Associazione Sportiva Roma', 'SS Lazio'), ('Celtic FC', 'Rangers FC'), ('Galatasaray', 'Fenerbahce'), ('Ajax Amsterdam', 'Feyenoord Rotterdam'),
           ('SL Benfica', 'FC Porto'), ('Paris Saint-Germain', 'Olympique Marseille'), ('Sevilla FC', 'Real Betis Balompié'), ('Liverpool FC', 'Manchester City')]
def q(sql): return con.execute(sql).fetchall()
cols = ['game_id', 'season', 'competition_id', 'comp_name', 'comp_type', 'round', 'date', 'home_club_id', 'home_club_name', 'away_club_id', 'away_club_name', 'home_club_goals', 'away_club_goals', 'home_club_formation', 'away_club_formation']
sel = ', '.join(cols)
matches = {}
def take(rows, kind):
    for r in rows:
        m = dict(zip(cols, r)); m['kind'] = kind; matches.setdefault(m['game_id'], m)
take(q(f"select {sel} from full_xi where competition_id in ('CL','EL') and lower(round)='final'"), 'final')
take(q(f"select {sel} from full_xi where comp_type in ('domestic_cup','other','international_cup') and lower(round)='final'"), 'final')
big_sql = ','.join("'" + b.replace("'", "''") + "'" for b in BIG)
for a, b in DERBIES:
    take(q(f"select {sel} from full_xi where (home_club_name='{a}' and away_club_name='{b}') or (home_club_name='{b}' and away_club_name='{a}')"), 'derby')
take(q(f"select {sel} from full_xi where competition_id in ('CL','EL') and (lower(round) like '%semi%' or lower(round) like '%quarter%') and home_club_name in ({big_sql}) and away_club_name in ({big_sql})"), 'semi')
# Only derbies that were events: 4+ goals, a 3+ goal margin, or a cup/European stage.
matches = {gid: m for gid, m in matches.items() if m['kind'] != 'derby' or (int(m['home_club_goals'] or 0) + int(m['away_club_goals'] or 0) >= 4 or abs(int(m['home_club_goals'] or 0) - int(m['away_club_goals'] or 0)) >= 3 or m['comp_type'] != 'domestic_league')}
print('matches', len(matches), collections.Counter(m['kind'] for m in matches.values()))

from xi_layout import LINE, SHORT, SIDE, layout  # noqa: E402

squads = []; stats = collections.Counter()
for m in matches.values():
    for side in ('home', 'away'):
        club_id = m[f'{side}_club_id']; club = m[f'{side}_club_name']; opp = m['away_club_name' if side == 'home' else 'home_club_name']
        item = gen.map_club_item(club, registry)
        if not item or not master.get(item['id'], {}).get('logo'): stats['no_crest'] += 1; continue
        rows = q(f"select player_id, player_name, position, number from game_lineups where game_id={m['game_id']} and club_id={club_id} and type='starting_lineup'")
        players = [(r, r[2], r[3]) for r in rows]
        laid, formation = layout([(r, r[2], r[3]) for r in rows], m[f'{side}_club_formation'] or '')
        if not laid: stats['layout_fail'] += 1; continue
        known = sum(1 for r in rows if int(r[0]) in pool)
        if known < 6: stats['too_obscure'] += 1; continue
        slots = []
        for (r, pos, num), x, y in laid:
            pid = int(r[0]); p = pool.get(pid); name = p['name'] if p else r[1]
            aliases = set(p['aliases']) if p else set()
            aliases.add(name); parts = name.split(' ')
            if len(parts) > 1 and len(parts[-1]) >= 4: aliases.add(parts[-1])
            slots.append({'id': f"{SHORT.get(pos, 'PL').lower()}{len(slots)}", 'position': SHORT.get(pos, 'PL'), 'number': int(num) if str(num).isdigit() else None, 'x': x, 'y': y,
                          'tm_id': pid, 'name': {'en': name, 'es': name, 'ka': (p['ka'] if p and p['ka'] else None)}, 'accepted_answers': sorted(aliases)})
        score = f"{m['home_club_goals']}-{m['away_club_goals']}"
        fame = sum(pool[int(r[0])]['peak'] for r in rows if int(r[0]) in pool) / 11
        squads.append({'game_id': int(m['game_id']), 'kind': m['kind'], 'team': label(club), 'opponent': label(opp), 'match_label': comp_label(m), 'competition_id': m['competition_id'], 'season': int(m['season']),
                       'date': str(m['date']), 'score': score, 'home': side == 'home', 'formation': formation, 'slots': slots,
                       'difficulty': 'easy' if fame >= 40e6 else 'medium' if fame >= 15e6 else 'hard', 'known_players': known})
        stats['kept'] += 1
print(dict(stats)); print('squads', len(squads), collections.Counter(s['kind'] for s in squads), collections.Counter(s['difficulty'] for s in squads))
print('slots lacking ka name:', sum(1 for s in squads for sl in s['slots'] if not sl['name']['ka']))
json.dump(squads, open(f'{HERE}/squads.json', 'w'), ensure_ascii=False, indent=1)
ex = next(s for s in squads if s['competition_id'] == 'CL' and s['season'] == 2014)
print(ex['team'], ex['match_label'], ex['formation'], [(sl['position'], sl['number'], sl['name']['en'], sl['x'], sl['y']) for sl in ex['slots']])
