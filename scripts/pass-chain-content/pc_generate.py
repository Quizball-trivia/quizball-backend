"""Pass Chain content: a player↔club graph over the Georgian-named Grid pool, and daily puzzles
whose par (shortest chain) is computed by BFS. Output: universe.json + puzzles.json next to this file.
Usage: pc_generate.py <universe.tsv from football_players ⨝ ka aliases>"""
import csv, gzip, json, re, sys, os, collections, random, unicodedata
HERE = os.path.dirname(os.path.abspath(__file__)); DATA = '/Users/user/dev/quizball-worktrees/grid-launch-data/transfermarkt'
WEB = '/Users/user/dev/quizball-worktrees/grid-parity-web'
sys.path.insert(0, f'{os.path.dirname(HERE)}/football-grid-content-generator')
import importlib, types
for _m in ('duckdb', 'psycopg', 'requests'): sys.modules.setdefault(_m, types.ModuleType(_m))  # only the club-name mapper is needed
gen = importlib.import_module('football-grid-build-launch-manifest')
registry = json.load(open(f'{WEB}/src/data/football-grid/launch-assets/clubs.json')); registry = registry if isinstance(registry, list) else registry['items']
CLUB_KA = json.load(open(f'{os.path.dirname(HERE)}/missing-xi-content/clubs-ka.json'))
NOISE = re.compile(r'\b(II|B|C|J|U1\d|U2\d|Yth\.?|Youth|Reserves?|Academy|Jgd\.|Jugend|Juvenil|Juniors?|Primavera|Under|Castilla|Jong)\b|Without Club|Unknown|Retired|Career break|National|Olympic|Select|-SP$|-RJ$|-MG$|-PR$|-RS$', re.I)

players = {}
for row in csv.reader(open(sys.argv[1]), delimiter='\t'):
    pid, tm, name, img, peak, fame, ka, en = row
    players[int(tm)] = {'id': pid, 'tm_id': int(tm), 'name': {'en': name, 'ka': ka.split('|')[0] if ka else name, 'es': name}, 'image_url': img,
                        'peak': float(peak or 0), 'fame': float(fame or 0), 'aliases': sorted({a for a in (ka + '|' + en).split('|') if a} | {name}), 'clubs': {}}
tm_clubs = {int(r['club_id']): r['name'] for r in csv.DictReader(gzip.open(f'{DATA}/clubs.csv.gz', 'rt'))}
# fame proxy (football_players.fame_score is empty locally): peak market value, international caps, legend bucket
legends = {int(x) for x in open(f'{HERE}/legends.txt').read().split() if x.isdigit()}  # 'legend:*' rows have no TM data
for r in csv.DictReader(gzip.open(f'{DATA}/players.csv.gz', 'rt')):
    p = players.get(int(r['player_id']))
    if not p: continue
    peak = float(r['highest_market_value_in_eur'] or 0); caps = int(float(r['international_caps'] or 0))
    # market value is the fame signal; caps only add a little so a 100-cap journeyman never outranks a star
    p['fame'] = peak + min(caps, 120) * 150_000 + (300_000_000 if p['tm_id'] in legends else 0)
# short club names as written on transfer rows (clubs.csv holds the long legal name)
short_names = collections.defaultdict(collections.Counter)
for r in csv.DictReader(gzip.open(f'{DATA}/transfers.csv.gz', 'rt')):
    for cid, name in ((r['from_club_id'], r['from_club_name']), (r['to_club_id'], r['to_club_name'])):
        if cid and name: short_names[int(cid)][name] += 1
def short_name(cid, fallback=''):
    return short_names[cid].most_common(1)[0][0] if short_names.get(cid) else (fallback or tm_clubs.get(cid, ''))
def club_label(cid, fallback):
    raw = short_name(cid, fallback)
    item = gen.map_club_item(raw, registry) or gen.map_club_item(tm_clubs.get(cid, ''), registry)
    en = (item or {}).get('labelEn') or raw
    label_ka = (item or {}).get('labelKa') or ''
    ka = CLUB_KA.get(en) or CLUB_KA.get(raw) or (label_ka if re.search(r'[\u10a0-\u10ff]', label_ka) else en)
    return {'key': f'tm{cid}', 'kind': 'club', 'en': en, 'ka': ka, 'es': en}
def add(tm, cid, name):
    p = players.get(tm)
    if not p or not cid or not name or NOISE.search(name): return
    p['clubs'].setdefault(int(cid), name)
for r in csv.DictReader(gzip.open(f'{DATA}/transfers.csv.gz', 'rt')):
    pid = int(r['player_id'])
    if pid in players:
        add(pid, r['from_club_id'], r['from_club_name']); add(pid, r['to_club_id'], r['to_club_name'])
for r in csv.DictReader(gzip.open(f'{DATA}/appearances.csv.gz', 'rt')):
    pid = int(r['player_id'])
    if pid in players: add(pid, r['player_club_id'], short_name(int(r['player_club_id'])))
# managers: from games (per-club manager per match) × appearances; ≥5 games under a coach to count
game_mgr = {}
for r in csv.DictReader(gzip.open(f'{DATA}/games.csv.gz', 'rt')):
    game_mgr[int(r['game_id'])] = {int(r['home_club_id'] or 0): r['home_club_manager_name'], int(r['away_club_id'] or 0): r['away_club_manager_name']}
mgr_games = collections.defaultdict(collections.Counter)
for r in csv.DictReader(gzip.open(f'{DATA}/appearances.csv.gz', 'rt')):
    pid = int(r['player_id'])
    if pid not in players: continue
    mgr = (game_mgr.get(int(r['game_id']), {}).get(int(r['player_club_id'] or 0)) or '').strip()
    if mgr: mgr_games[pid][mgr] += 1
def mgr_key(name): return 'mgr:' + re.sub(r'[^a-z0-9]+', '-', unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()).strip('-')
for tm, p in players.items():
    p['managers'] = sorted(({'key': mgr_key(m), 'kind': 'manager', 'en': m, 'ka': m, 'es': m} for m, n in mgr_games[tm].items() if n >= 5), key=lambda c: c['en'])
# resolve labels once per club id; merge clubs that map to the same registry label (e.g. renamed clubs)
labels = {cid: club_label(cid, name) for p in players.values() for cid, name in p['clubs'].items()}
for p in players.values():
    merged = {}
    for cid in p['clubs']: merged[labels[cid]['en']] = labels[cid]
    p['clubs'] = sorted(merged.values(), key=lambda c: c['en'])
players = {tm: p for tm, p in players.items() if len(p['clubs']) >= 1}
club_size = collections.Counter(c['key'] for p in players.values() for c in p['clubs'])
for p in players.values(): p['clubs'].sort(key=lambda c: (-club_size[c['key']], c['en']))
by_link = collections.defaultdict(set)
def links_of(p): return p['clubs'] + p['managers']
for tm, p in players.items():
    for c in links_of(p): by_link[c['key']].add(tm)
def neighbours(tm, within=None):
    """tm -> {other: link}; a club link wins over a manager link when both exist. `within` restricts to a player set."""
    out = {}
    for c in links_of(players[tm]):
        for o in by_link[c['key']]:
            if o == tm or (within is not None and o not in within): continue
            if o not in out or (out[o]['kind'] == 'manager' and c['kind'] == 'club'): out[o] = c
    return out
def bfs(src, max_depth=4, within=None):
    dist = {src: 0}; prev = {}; frontier = [src]
    for d in range(1, max_depth + 1):
        nxt = []
        for u in frontier:
            for v, via in neighbours(u, within).items():
                if v not in dist: dist[v] = d; prev[v] = (u, via); nxt.append(v)
        frontier = nxt
    return dist, prev
def path(prev, src, dst):
    out = []; cur = dst
    while cur != src: u, via = prev[cur]; out.append((cur, via)); cur = u
    return list(reversed(out))
famous = sorted(players, key=lambda tm: -players[tm]['fame'])[:320]
famous_set = set(famous)  # puzzles, pars and revealed chains stay inside the famous pool; answers may use the whole universe
print('universe', len(players), 'links', len(by_link), 'famous pool', len(famous), 'median clubs/player', sorted(len(p['clubs']) for p in players.values())[len(players)//2], 'players with a manager', sum(1 for p in players.values() if p['managers']))
random.seed(7); puzzles = []; used = collections.Counter()
for a in famous:
    dist, prev = bfs(a, 3, famous_set)
    for b in famous:
        if b <= a or b not in dist or dist[b] < 2: continue
        if used[a] >= 4 or used[b] >= 4: continue
        par = dist[b]; steps = path(prev, a, b)
        # par 2: difficulty = how many famous bridging players exist (many = easy); par 3 = hard
        bridges = len(set(neighbours(a, famous_set)) & set(neighbours(b, famous_set))) if par == 2 else 0
        # the famous pool is dense (median ~40 bridges): easy = plenty of routes, hard = a handful
        difficulty = 'hard' if par >= 3 or bridges <= 12 else ('easy' if bridges >= 32 else 'medium')
        puzzles.append({'start': a, 'target': b, 'par': par, 'bridges': bridges, 'difficulty': difficulty, 'solution': [{'tm_id': tm, 'via': via} for tm, via in steps]})  # via = {key, kind, en, ka, es}
        used[a] += 1; used[b] += 1
random.shuffle(puzzles)
print('puzzles', len(puzzles), collections.Counter(p['par'] for p in puzzles), collections.Counter(p['difficulty'] for p in puzzles))
json.dump({str(tm): p for tm, p in players.items()}, open(f'{HERE}/universe.json', 'w'), ensure_ascii=False)
json.dump(puzzles, open(f'{HERE}/puzzles.json', 'w'), ensure_ascii=False)
for p in puzzles[:6]:
    print(' ', players[p['start']]['name']['en'], '→', players[p['target']]['name']['en'], 'par', p['par'], '|', ' → '.join(f"[{v['via']['kind']}] {v['via']['en']} → {players[v['tm_id']]['name']['en']}" for v in p['solution']))
print('solution links by kind:', collections.Counter(v['via']['kind'] for p in puzzles for v in p['solution']))
