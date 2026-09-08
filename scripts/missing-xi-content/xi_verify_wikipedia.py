"""Verify Missing XI domestic-final squads against the English Wikipedia match article.

VERIFIED only when the article's line-up table lists exactly our 11 starters; the layout is then
rebuilt from the article's position codes (GK/RB/CB/.../CF) through the shared layout engine.
Usage: xi_verify_wikipedia.py [--cache DIR]   (rewrites squads.json in place)
"""
import json, os, re, subprocess, sys, time, unicodedata, collections, datetime, difflib, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from xi_layout import SHORT, layout
CACHE = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else f'{HERE}/.wiki-cache'
os.makedirs(CACHE, exist_ok=True)
UA = 'QuizballMissingXI/1.0 (content verification; contact: dev@quizball.io)'
TITLE = {'FAC': '{y} FA Cup final', 'DFB': '{y} DFB-Pokal final', 'CIT': '{y} Coppa Italia final', 'CDR': '{y} Copa del Rey final',
         'GBCS': '{y} FA Community Shield', 'DFL': '{y} DFL-Supercup', 'SCI': '{y} Supercoppa Italiana', 'SUC': '{y} Supercopa de España',
         'FRCH': '{y} Trophée des Champions', 'POSU': '{y} Supertaça Cândido de Oliveira', 'NLSC': '{y} Johan Cruyff Shield',
         'SFA': '{y} Scottish Cup final', 'NLP': '{y} KNVB Cup final', 'GRP': '{y} Greek Football Cup final', 'UKRP': '{y} Ukrainian Cup final'}
CODE2LONG = {'GK': 'Goalkeeper', 'RB': 'Right-Back', 'CB': 'Centre-Back', 'LB': 'Left-Back', 'SW': 'Sweeper', 'RWB': 'Right Midfield', 'LWB': 'Left Midfield', 'WB': 'Right Midfield',
             'DF': 'Centre-Back', 'DM': 'Defensive Midfield', 'CM': 'Central Midfield', 'RM': 'Right Midfield', 'LM': 'Left Midfield', 'MF': 'Central Midfield',
             'AM': 'Attacking Midfield', 'RW': 'Right Winger', 'LW': 'Left Winger', 'RF': 'Right Winger', 'LF': 'Left Winger', 'CF': 'Centre-Forward',
             'SS': 'Second Striker', 'ST': 'Centre-Forward', 'FW': 'Centre-Forward',
             'CDM': 'Defensive Midfield', 'CAM': 'Attacking Midfield', 'RCB': 'Centre-Back', 'LCB': 'Centre-Back', 'RCM': 'Central Midfield', 'LCM': 'Central Midfield',
             'RDM': 'Defensive Midfield', 'LDM': 'Defensive Midfield', 'RAM': 'Attacking Midfield', 'LAM': 'Attacking Midfield', 'RS': 'Centre-Forward', 'LS': 'Centre-Forward',
             'CS': 'Centre-Forward', 'RWF': 'Right Winger', 'LWF': 'Left Winger', 'DMF': 'Defensive Midfield', 'AMF': 'Attacking Midfield', 'CMF': 'Central Midfield', 'CD': 'Centre-Back'}

def fetch(url, key):
    path = f'{CACHE}/{key}.json'
    if os.path.exists(path): return json.load(open(path))['body']
    body = subprocess.run(['curl', '-sS', '--max-time', '30', '-A', UA, url], capture_output=True, text=True, check=True).stdout
    json.dump({'body': body}, open(path, 'w')); time.sleep(0.4); return body

def wikitext(title):
    t = urllib.parse.quote(title.replace(' ', '_'))
    body = fetch(f'https://en.wikipedia.org/w/index.php?title={t}&action=raw', 'raw-' + re.sub(r'[^A-Za-z0-9]+', '_', title))
    m = re.match(r'#REDIRECT\s*\[\[([^\]|]+)', body, re.I)
    return wikitext(m.group(1)) if m else body

def search(query):
    body = fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=' + urllib.parse.quote(query), 'search-' + re.sub(r'[^A-Za-z0-9]+', '_', query))
    return [r['title'] for r in json.loads(body)['query']['search']]

def norm(s): return re.sub(r'[^a-z0-9 ]', ' ', unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()).split()
LINK = re.compile(r'\[\[([^\]|]+)(?:\|([^\]]*))?\]\]')
def lineups(text):
    """Line-up blocks as lists of (code, number, link target, display). Handles both the inline
    `|GK || 1 || [[Name]]` rows and one-cell-per-line tables. A block starts at each GK row; starters are its first 11 rows."""
    blocks = []
    text = re.sub(r'\n\{\|[^\n]*', '\n|-', text)  # a table start also opens a row
    for row in re.split(r'\n\|-', text):
        cells = [c.strip() for c in re.split(r'\|\||\n\|', '\n' + row.strip()) if c.strip()]
        if len(cells) < 3 or cells[0] not in CODE2LONG: continue
        num = re.sub(r'[^0-9]', '', cells[1])
        link = next((LINK.search(c) for c in cells[2:] if LINK.search(c)), None)
        if not num or not link: continue
        if cells[0] == 'GK' or not blocks: blocks.append([])
        name = re.sub(r'\s*\(.*?\)', '', link.group(1)).strip()
        blocks[-1].append((cells[0], int(num), name, (link.group(2) or '').strip()))
    return [b[:11] for b in blocks if len(b) >= 11]

MONTHS = {m: i for i, m in enumerate(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], 1)}
def dates_in(text):
    out = set()
    for y, m, d in re.findall(r'\{\{[Ss]tart date\|(\d{4})\|(\d{1,2})\|(\d{1,2})', text): out.add(datetime.date(int(y), int(m), int(d)))
    for d, m, y in re.findall(r'\b(\d{1,2})\s+(' + '|'.join(MONTHS) + r')\s+(\d{4})\b', text): out.add(datetime.date(int(y), MONTHS[m], int(d)))
    for m, d, y in re.findall(r'\b(' + '|'.join(MONTHS) + r')\s+(\d{1,2}),\s+(\d{4})\b', text): out.add(datetime.date(int(y), MONTHS[m], int(d)))
    return out
def infobox_date(text):
    """The match's own date: the infobox Start date template first, else a line-start `| date =` parameter
    (inline `|date=` inside citations is deliberately ignored). None when absent."""
    head = text[:8000]
    m = re.search(r'\{\{[Ss]tart date\|(?:[^}|]*\|)*?(\d{4})\|(\d{1,2})\|(\d{1,2})', head)
    if m: return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    for value in re.findall(r'^\|\s*date\s*=\s*([^\n]+)', head, re.M):
        found = dates_in(re.split(r'<ref', value)[0])
        if found: return min(found)
    return None
def date_in(text, d):
    # strict: no infobox date, no verification
    return infobox_date(text) == datetime.date.fromisoformat(d)

def name_score(slot, row):
    ours = norm(slot['name']['en']); theirs = norm(row[2]) + norm(row[3])
    if not ours or not theirs: return 0
    score = difflib.SequenceMatcher(None, ' '.join(ours), ' '.join(norm(row[2]))).ratio()
    if any(len(t) >= 4 and t in theirs for t in ours): score = max(score, 0.8)
    if ours[-1] in theirs: score = max(score, 0.85)
    if slot['number'] is not None and row[1] == int(slot['number']): score += 0.5
    return score

def assign(slots, block):
    pairs = sorted(((name_score(sl, r), i, j) for i, sl in enumerate(slots) for j, r in enumerate(block)), reverse=True)
    used_i, used_j, out = set(), set(), {}
    for sc, i, j in pairs:
        if i in used_i or j in used_j: continue
        if sc < 0.75: break
        used_i.add(i); used_j.add(j); out[i] = block[j]
    return out

squads = json.load(open(f'{HERE}/squads.json')); stats = collections.Counter(); problems = []
for s in squads:
    comp = s['competition_id']
    if comp not in TITLE or (s.get('verified') and s['verified']['source'] != 'wikipedia'): continue
    s['verified'] = None
    stats['candidates'] += 1
    year = int(s['date'][:4]); month = int(s['date'][5:7])
    years = [year, year - 1]  # super cups / postponed finals are titled by the season's first year
    titles = [TITLE[comp].format(y=y) for y in years] + [TITLE[comp].format(y=f'{y}\u2013{str(y + 1)[-2:]}') for y in years]
    titles += [t for t in search(TITLE[comp].format(y=year)) if t not in titles]
    found = None
    for title in titles[:6]:
        text = wikitext(title)
        if not text or not date_in(text, s['date']): continue
        blocks = lineups(text)
        if not blocks: continue
        best = max(((len(assign(s['slots'], b)), b) for b in blocks), key=lambda x: x[0])
        found = (title, best); break
    if not found: stats['no_article_or_lineup'] += 1; problems.append(('no_article', s['team']['en'], s['match_label']['en'], s['date'], titles[:2])); s['verified'] = None; continue
    title, (hits, block) = found
    assigned = assign(s['slots'], block)
    if len(assigned) != 11:
        missing = [sl['name']['en'] for i, sl in enumerate(s['slots']) if i not in assigned]
        stats['xi_mismatch'] += 1; problems.append(('xi_mismatch', s['team']['en'], s['date'], title, missing[:3])); s['verified'] = None; continue
    players = []
    for i, sl in enumerate(s['slots']):
        code, num, _, _ = assigned[i]; sl['number'] = num
        players.append(((sl['tm_id'], sl['name']['en']), CODE2LONG[code], num))
    # Lines come from the article's codes only: defenders / holding / central / attacking band (+ wingers when
    # an AM exists) / forwards. The layout engine orders groups DEF, DM, CM, AM, W, FW, so the digits line up.
    LINE_OF = {'Left-Back': 'D', 'Centre-Back': 'D', 'Right-Back': 'D', 'Sweeper': 'D', 'Defensive Midfield': 'DM', 'Central Midfield': 'M',
               'Left Midfield': 'M', 'Right Midfield': 'M', 'Attacking Midfield': 'AM', 'Left Winger': 'W', 'Right Winger': 'W',
               'Centre-Forward': 'F', 'Second Striker': 'F'}
    counts = collections.Counter(LINE_OF[pos] for (_, pos, _) in players if pos != 'Goalkeeper')
    if counts['AM']: counts['AM'] += counts.pop('W', 0)
    else: counts['F'] += counts.pop('W', 0)
    formation = '-'.join(str(counts[k]) for k in ('D', 'DM', 'M', 'AM', 'F') if counts.get(k))
    laid, formation = layout(players, formation)
    if not laid: stats['layout_fail'] += 1; problems.append(('layout_fail', s['team']['en'], s['date'], title)); s['verified'] = None; continue
    by_tm = {sl['tm_id']: sl for sl in s['slots']}; new = []
    for (r, pos, num), x, y in laid:
        new.append({**by_tm[r[0]], 'id': f"{SHORT[pos].lower()}{len(new)}", 'position': SHORT[pos], 'x': x, 'y': y})
    s['tm_formation'] = s.get('tm_formation') or s['formation']; s['slots'] = new; s['formation'] = formation
    s['verified'] = {'source': 'wikipedia', 'matchId': title, 'checkedAt': datetime.date.today().isoformat()}
    stats['verified'] += 1
json.dump(squads, open(f'{HERE}/squads.json', 'w'), ensure_ascii=False)
print(dict(stats))
for p in problems[:40]: print(' ', p)
