"""Missing XI layout engine: maps Transfermarkt line-up positions to x/y slots for a formation."""
import collections, re

LINE = {'Goalkeeper': 'GK', 'Left-Back': 'DEF', 'Centre-Back': 'DEF', 'Right-Back': 'DEF', 'Sweeper': 'DEF', 'Defender': 'DEF',
        'Defensive Midfield': 'DM', 'Central Midfield': 'CM', 'Attacking Midfield': 'AM', 'Left Midfield': 'CM', 'Right Midfield': 'CM', 'Midfielder': 'CM',
        'Left Winger': 'W', 'Right Winger': 'W', 'Centre-Forward': 'FW', 'Second Striker': 'FW', 'Attack': 'FW'}
SHORT = {'Goalkeeper': 'GK', 'Left-Back': 'LB', 'Centre-Back': 'CB', 'Right-Back': 'RB', 'Sweeper': 'SW', 'Defender': 'DF', 'Defensive Midfield': 'DM', 'Central Midfield': 'CM',
         'Attacking Midfield': 'AM', 'Left Midfield': 'LM', 'Right Midfield': 'RM', 'Midfielder': 'MF', 'Left Winger': 'LW', 'Right Winger': 'RW', 'Centre-Forward': 'CF', 'Second Striker': 'SS', 'Attack': 'FW'}
SIDE = {'Left-Back': 0, 'Left Midfield': 0, 'Left Winger': 0, 'Right-Back': 2, 'Right Midfield': 2, 'Right Winger': 2}
def layout(players, formation):
    """players: list of (name, position, number). Returns slots with x/y or None when the XI does not fit a clean shape."""
    nums = [int(n) for n in re.findall(r'\d', formation.split(' ')[0])] if formation else []
    if not nums or sum(nums) != 10: return None, formation
    groups = collections.defaultdict(list)
    for p in players: groups[LINE.get(p[1], 'CM')].append(p)
    if len(groups['GK']) != 1: return None, formation
    # outfield lines back-to-front; wingers fill the front line first, then the widest midfield line
    # strikers are their own line behind the wingers so a lone CF takes the front slot of a 4-1-4-1 / 4-2-3-1
    outfield = [groups['DEF'], groups['DM'], groups['CM'], groups['AM'], groups['W'], groups['FW']]
    # within a group, deeper roles first so they spill into the line behind (a Second Striker sits behind the CF)
    DEPTH = {'Second Striker': 0}
    order = [p for line in outfield for p in sorted(line, key=lambda p: (DEPTH.get(p[1], 1), SIDE.get(p[1], 1)))]
    if len(order) != 10: return None, formation
    lines = []; i = 0
    for n in nums: lines.append(order[i:i + n]); i += n
    rows = [(groups['GK'][0], 50, 90)]
    ys = [72, 55, 40, 27, 15][:len(nums)] if len(nums) <= 5 else [72, 60, 48, 36, 24, 14]
    if len(nums) == 3: ys = [72, 48, 22]
    if len(nums) == 2: ys = [68, 30]
    XS = {1: [50], 2: [33, 67], 3: [22, 50, 78], 4: [14, 38, 62, 86], 5: [10, 30, 50, 70, 90], 6: [8, 25, 42, 58, 75, 92]}
    CENTRAL = {'Defensive Midfield': 3, 'Attacking Midfield': 3, 'Centre-Forward': 2, 'Second Striker': 2, 'Centre-Back': 1, 'Central Midfield': 1}
    def arrange(line):
        lefts = [p for p in line if SIDE.get(p[1]) == 0]; rights = [p for p in line if SIDE.get(p[1]) == 2]
        centers = sorted([p for p in line if SIDE.get(p[1], 1) == 1], key=lambda p: -CENTRAL.get(p[1], 0))
        # most central role in the middle, then alternate outwards
        mid = []
        for i, p in enumerate(centers):
            if i % 2 == 0: mid.insert(len(mid) // 2, p)
            else: mid.insert(len(mid) // 2 + 1, p)
        return lefts + mid + rights
    for line, y in zip(lines, ys):
        line = arrange(line); n = len(line)
        xs = XS.get(n) or [50 if n == 1 else 10 + j * (80 / (n - 1)) for j in range(n)]
        for j, p in enumerate(line):
            rows.append((p, xs[j], y))
    return rows, '-'.join(str(n) for n in nums)
def label(name):
    item = gen.map_club_item(name, registry); en = item['labelEn'] if item else name
    return {'en': en, 'ka': CLUB_KA.get(en) or CLUB_KA.get(name) or en, 'es': en}
COMP_NAME = {'premier-league': 'Premier League', 'laliga': 'LaLiga', 'serie-a': 'Serie A', 'bundesliga': 'Bundesliga', 'ligue-1': 'Ligue 1', 'super-lig': 'Süper Lig', 'liga-portugal-bwin': 'Liga Portugal',
             'liga-portugal': 'Liga Portugal', 'scottish-premiership': 'Scottish Premiership', 'eredivisie': 'Eredivisie', 'italy-cup': 'Coppa Italia', 'copa-del-rey': 'Copa del Rey', 'fa-cup': 'FA Cup', 'dfb-pokal': 'DFB-Pokal',
             'coupe-de-france': 'Coupe de France', 'efl-cup': 'EFL Cup', 'supercopa': 'Supercopa de España', 'supercoppa-italiana': 'Supercoppa Italiana', 'dfl-supercup': 'DFL-Supercup', 'community-shield': 'Community Shield',
             'trophee-des-champions': 'Trophée des Champions', 'taca-de-portugal': 'Taça de Portugal', 'knvb-beker': 'KNVB Beker', 'turkish-cup': 'Türkiye Kupası', 'scottish-cup': 'Scottish Cup', 'johan-cruijff-schaal': 'Johan Cruijff Schaal',
             'uefa-super-cup': 'UEFA Super Cup', 'fifa-club-world-cup': 'FIFA Club World Cup', 'jupiler-pro-league': 'Jupiler Pro League', 'russian-premier-liga': 'Russian Premier Liga', 'ukrainian-premier-liga': 'Ukrainian Premier Liga'}
COMP_KA = {'Champions League': 'ჩემპიონთა ლიგა', 'Europa League': 'ევროპა ლიგა', 'Premier League': 'პრემიერ ლიგა', 'LaLiga': 'ლა ლიგა', 'Serie A': 'სერია A', 'Bundesliga': 'ბუნდესლიგა', 'Ligue 1': 'ლიგა 1',
           'FA Cup': 'FA Cup', 'Copa del Rey': 'მეფის თასი', 'Coppa Italia': 'იტალიის თასი', 'DFB-Pokal': 'გერმანიის თასი', 'Coupe de France': 'საფრანგეთის თასი', 'Supercopa': 'სუპერთასი',
           'Supercoppa Italiana': 'იტალიის სუპერთასი', 'DFL-Supercup': 'გერმანიის სუპერთასი', 'Community Shield': 'საზოგადოებრივი ფარი', 'Eredivisie': 'ერედივიზია', 'Super Lig': 'სუპერ ლიგა', 'Scottish Premiership': 'შოტლანდიის პრემიერშიპი'}
ROUND_ES = {'Semi-Finals': 'Semifinales', 'Semi-Finals 1st Leg': 'Semifinal, ida', 'Semi-Finals 2nd Leg': 'Semifinal, vuelta', 'Quarter-Finals': 'Cuartos de final', 'Quarter-Finals 1st Leg': 'Cuartos de final, ida', 'Quarter-Finals 2nd Leg': 'Cuartos de final, vuelta'}
COMP_ES = {'Champions League': 'Champions League', 'Europa League': 'Europa League', 'FA Cup': 'FA Cup', 'Copa del Rey': 'Copa del Rey', 'Coppa Italia': 'Coppa Italia', 'DFB-Pokal': 'DFB-Pokal'}
def comp_label(m):
    s = int(m['season']); season = f"{s}/{str(s + 1)[-2:]}"; round_ = (m['round'] or '').replace(' leg', ' Leg')  # TM mixes '1st leg' / '1st Leg'
    name = {'CL': 'Champions League', 'EL': 'Europa League'}.get(m['competition_id']) or COMP_NAME.get(m['comp_name']) or m['comp_name'].replace('-', ' ').title()
    ka_name = next((v for k, v in COMP_KA.items() if k.lower() in name.lower()), name)
    if m['kind'] == 'derby': return {'en': f"{name} {season}", 'es': f"{COMP_ES.get(name, name)} {season}", 'ka': f"{ka_name} {season}"}
    is_final = round_.lower() == 'final'  # 'Quarter-Finals' also contains 'final'
    r_en = 'Final' if is_final else round_; r_es = 'Final' if is_final else ROUND_ES.get(round_, round_)
    r_ka = 'ფინალი' if is_final else ('ნახევარფინალი' if 'semi' in round_.lower() else ('მეოთხედფინალი' if 'quarter' in round_.lower() else round_))
    return {'en': f"{name} {season} {r_en}".strip(), 'es': f"{COMP_ES.get(name, name)} {season} {r_es}".strip(), 'ka': f"{ka_name} {season} {r_ka}".strip()}
