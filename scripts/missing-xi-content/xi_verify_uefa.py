"""Verify Missing XI squads for UEFA competitions against UEFA's official match API.

A squad is VERIFIED only when UEFA lists exactly the same 11 starters (shirt number + name);
its layout is then rebuilt from UEFA's own line-up graphic coordinates.
Usage: xi_verify_uefa.py [--cache DIR]   (rewrites squads.json in place)
"""
import json, os, re, subprocess, sys, time, unicodedata, collections, datetime, difflib
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else f'{HERE}/.uefa-cache'
os.makedirs(CACHE, exist_ok=True)
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36'
COMP = {'CL': 1, 'EL': 14, 'UCOL': 2019, 'USC': 2}
POS_Y = [72, 55, 40, 27, 15]

def get(url, key):
    path = f'{CACHE}/{key}.json'
    if os.path.exists(path): return json.load(open(path))
    # curl: the python.org build has no root CA bundle for urllib
    raw = subprocess.run(['curl', '-sS', '--max-time', '30', '-A', UA, '-H', 'Accept: application/json', url], capture_output=True, text=True, check=True).stdout
    data = json.loads(raw); json.dump(data, open(path, 'w')); time.sleep(0.25)
    return data

def season_matches(comp_id, season_year):
    out = []
    for phase in ('TOURNAMENT', 'QUALIFYING'):
        offset = 0
        while True:
            page = get(f'https://match.uefa.com/v5/matches?competitionId={comp_id}&seasonYear={season_year}&phase={phase}&limit=200&offset={offset}', f'list-{comp_id}-{season_year}-{phase}-{offset}')
            out += page
            if len(page) < 200: break
            offset += 200
    return out

def norm(s): return re.sub(r'[^a-z0-9 ]', ' ', unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()).split()
STOP = {'fc', 'cf', 'sc', 'ac', 'as', 'club', 'de', 'football', 'the', 'ssc', 'afc', 'bv', 'sv', '1909', 'spa', 'cfc', 'fk', 'sk', 'ss', 'us', 'rc', 'rcd', 'ud', 'sd', 'v'}
def team_score(a, b):
    ta = [t for t in norm(a) if t not in STOP]; tb = [t for t in norm(b) if t not in STOP]
    if not ta or not tb: return 0
    hits = sum(1 for x in ta if any(y.startswith(x[:5]) or x.startswith(y[:5]) for y in tb))
    return hits / max(len(ta), len(tb)) + 0.3 * difflib.SequenceMatcher(None, ' '.join(ta), ' '.join(tb)).ratio()

def find_match(matches, squad):
    d = datetime.date.fromisoformat(squad['date']); best = (0, None, None)
    for m in matches:
        md = datetime.date.fromisoformat(m['kickOffTime']['date'])
        if abs((md - d).days) > 1: continue
        h, a = m['homeTeam']['internationalName'], m['awayTeam']['internationalName']
        s1 = team_score(squad['team']['en'], h) + team_score(squad['opponent']['en'], a)
        s2 = team_score(squad['team']['en'], a) + team_score(squad['opponent']['en'], h)
        s, side = max((s1, 'homeTeam'), (s2, 'awayTeam'))
        if s > best[0]: best = (s, m, side)
    return best if best[0] >= 1.0 else (best[0], None, None)

def name_score(slot, uefa):
    ours = norm(slot['name']['en']); theirs = norm(uefa['player']['internationalName']) + norm(uefa['player'].get('clubShirtName', ''))
    if not ours or not theirs: return 0
    score = difflib.SequenceMatcher(None, ' '.join(ours), ' '.join(norm(uefa['player']['internationalName']))).ratio()
    if any(len(t) >= 4 and t in theirs for t in ours): score = max(score, 0.8)
    if ours[-1] in theirs: score = max(score, 0.85)
    if slot['number'] is not None and int(uefa['jerseyNumber']) == int(slot['number']): score += 0.5
    return score

def assign_players(slots, field):
    """Greedy one-to-one pairing by name evidence; shirt numbers only break ties (UEFA's number is the one worn)."""
    pairs = sorted(((name_score(sl, p), i, j) for i, sl in enumerate(slots) for j, p in enumerate(field)), reverse=True)
    used_i, used_j, out = set(), set(), {}
    for score, i, j in pairs:
        if i in used_i or j in used_j: continue
        if score < 0.75: break
        used_i.add(i); used_j.add(j); out[i] = field[j]
    return out

def layout_from_uefa(field, slots_by_num):
    """Lines and position codes come purely from UEFA's drawn coordinates; the player's
    registered role (fieldPosition) is deliberately ignored — a midfielder at full-back is a full-back tonight."""
    gk = [p for p in field if str(p.get('type', '')).startswith('GOALKEEPER')]
    outfield = sorted([p for p in field if p not in gk], key=lambda p: p['fieldCoordinate']['y'])
    if len(gk) != 1 or len(outfield) != 10: return None
    y0 = outfield[0]['fieldCoordinate']['y']
    # back line: UEFA draws full-backs up to ~150px above the centre-backs; a holding midfielder sits 200px+ up
    back = [p for p in outfield if p['fieldCoordinate']['y'] - y0 <= 160]
    lines = [back]
    for p in outfield[len(back):]:
        if lines[-1] is not back and p['fieldCoordinate']['y'] - lines[-1][-1]['fieldCoordinate']['y'] <= 100: lines[-1].append(p)
        else: lines.append([p])
    while len(lines) > 5:  # merge the two closest non-back lines
        gaps = [(lines[i + 1][0]['fieldCoordinate']['y'] - lines[i][-1]['fieldCoordinate']['y'], i) for i in range(1, len(lines) - 1)]
        _, i = min(gaps); lines[i:i + 2] = [lines[i] + lines[i + 1]]
    XS = {1: [50], 2: [33, 67], 3: [22, 50, 78], 4: [14, 38, 62, 86], 5: [10, 30, 50, 70, 90]}
    ys = {1: [72], 2: [68, 30], 3: [72, 48, 22], 4: [72, 55, 40, 27], 5: [72, 58, 45, 32, 18]}[len(lines)]
    mids = len(lines) - 2
    def code(line_idx, j, n):
        side = 'L' if j == 0 and n > 1 else ('R' if j == n - 1 and n > 1 else 'C')
        if line_idx == 0: return 'CB' if side == 'C' else side + 'B'
        if line_idx == len(lines) - 1: return 'CF' if side == 'C' or n <= 2 else side + 'W'
        if mids >= 2 and line_idx == 1: return 'DM' if side == 'C' else side + 'M'
        if mids >= 2 and line_idx == len(lines) - 2: return 'AM' if side == 'C' else side + 'W'
        return 'CM' if side == 'C' else side + 'M'
    out = [(gk[0], 'GK', 50, 90)]
    for i, line in enumerate(lines):
        line = sorted(line, key=lambda p: p['fieldCoordinate']['x']); n = len(line)
        xs = XS.get(n) or [10 + j * (80 / (n - 1)) for j in range(n)]
        for j, p in enumerate(line): out.append((p, code(i, j, n), xs[j], ys[i]))
    slots = []
    for p, pos, x, y in out:
        old = slots_by_num[int(p['jerseyNumber'])]
        slots.append({**old, 'id': f'{pos.lower()}{len(slots)}', 'position': pos, 'x': x, 'y': y})
    return slots, '-'.join(str(len(l)) for l in lines)

squads = json.load(open(f'{HERE}/squads.json')); stats = collections.Counter(); problems = []
for s in squads:
    comp = s['competition_id']
    if comp not in COMP: continue
    stats['uefa_candidates'] += 1
    # The Super Cup has no season listing; look it up by date instead.
    matches = get(f"https://match.uefa.com/v5/matches?fromDate={s['date']}&toDate={s['date']}&limit=20&offset=0", f"date-{s['date']}") if comp == 'USC' else season_matches(COMP[comp], int(s['season']) + 1)
    score, m, side = find_match(matches, s)
    if not m: stats['no_match']; stats['no_match'] += 1; problems.append(('no_match', s['team']['en'], s['opponent']['en'], s['date'], round(score, 2))); s['verified'] = None; continue
    lineups = get(f"https://match.uefa.com/v5/matches/{m['id']}/lineups", f"lineup-{m['id']}")
    field = lineups.get(side, {}).get('field', [])
    if len(field) != 11: stats['no_lineup'] += 1; problems.append(('no_lineup', s['team']['en'], s['date'], m['id'])); s['verified'] = None; continue
    assigned = assign_players(s['slots'], field)
    missing = [sl['name']['en'] for i, sl in enumerate(s['slots']) if i not in assigned]
    if missing:
        stats['xi_mismatch'] += 1; problems.append(('xi_mismatch', s['team']['en'], s['date'], m['id'], missing[:3])); s['verified'] = None; continue
    by_num = {}
    for i, sl in enumerate(s['slots']):
        sl['number'] = int(assigned[i]['jerseyNumber']); by_num[sl['number']] = sl
    laid = layout_from_uefa(field, by_num)
    if not laid: stats['layout_fail'] += 1; problems.append(('layout_fail', s['team']['en'], s['date'], m['id'])); s['verified'] = None; continue
    s['tm_formation'] = s.get('tm_formation') or s['formation']
    s['slots'], s['formation'] = laid
    s['verified'] = {'source': 'uefa', 'matchId': m['id'], 'checkedAt': datetime.date.today().isoformat()}
    stats['verified'] += 1
json.dump(squads, open(f'{HERE}/squads.json', 'w'), ensure_ascii=False)
print(dict(stats))
for p in problems[:40]: print(' ', p)
