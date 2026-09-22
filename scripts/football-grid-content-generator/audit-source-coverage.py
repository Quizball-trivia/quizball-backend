#!/usr/bin/env python3
"""Offline, fail-closed coverage audit. No database or network access.

Checks exported releases against the pinned appearance snapshot using existing
evidence IDs, never fuzzy name joins. Outputs proposed facts for review, not a
publishable manifest. Coverage is relative to this snapshot, not all football.
"""
import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import duckdb

LEAGUES = dict(zip(
    ['GB1', 'ES1', 'IT1', 'L1', 'FR1', 'NL1', 'PO1', 'BRA1', 'SC1', 'ARG1', 'TR1', 'BE1', 'MLS1', 'SA1'],
    ['premier-league', 'la-liga', 'serie-a', 'bundesliga', 'ligue-1', 'eredivisie', 'primeira-liga', 'brasileirao',
     'scottish-premiership', 'argentine-primera', 'super-lig', 'belgian-pro-league', 'major-league-soccer', 'saudi-pro-league']))


def normalized(value):
    return re.sub(r'[^a-z0-9]+', ' ', unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode().lower()).strip()


def identity_maps(manifests):
    ids, clubs = defaultdict(set), defaultdict(set)
    for manifest in manifests:
        for member in manifest['memberships']:
            for evidence in member['evidence']:
                locator = evidence['sourceLocator']
                # Pinned dataset only: other providers' numeric IDs are unrelated.
                if evidence['sourceKey'] != 'dcaribou-transfermarkt-datasets':
                    continue
                match = re.search(r'(?:^|[:;])player_id=(\d+)(?:;|$)', locator)
                if match:
                    ids[member['playerId']].add(int(match[1]))
                club = re.search(r'(?:^|[:;])club_id=(\d+)(?:;|$)', locator)
                if club and member['criterionKey'].startswith('club:'):
                    clubs[int(club[1])].add(member['criterionKey'])
    conflicts = {uuid: sorted(values) for uuid, values in ids.items() if len(values) != 1}
    reverse = defaultdict(set)
    for uuid, values in ids.items():
        for value in values:
            reverse[value].add(uuid)
    duplicates = {str(key): sorted(values) for key, values in reverse.items() if len(values) > 1}
    club_conflicts = {str(key): sorted(values) for key, values in clubs.items() if len(values) > 1}
    if conflicts or duplicates or club_conflicts:
        raise ValueError(f'Ambiguous source identities; repair before auditing: {json.dumps([conflicts, duplicates, club_conflicts])}')
    return {key: next(iter(values)) for key, values in ids.items()}, {key: next(iter(values)) for key, values in clubs.items()}


def audit(dataset, manifests, checksums):
    verified = {}
    for line in checksums.read_text().splitlines():
        digest, name = line.split()
        path = dataset / name
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != digest:
            raise ValueError(f'Snapshot checksum mismatch: {name}')
        verified[name] = actual
    identities, clubs = identity_maps(manifests)
    conn = duckdb.connect(config={'threads': 2, 'memory_limit': '1GB'})
    for name in ['players', 'appearances', 'games', 'competitions', 'clubs']:
        path = str(dataset / f'{name}.csv.gz').replace("'", "''")
        conn.execute(f"CREATE VIEW {name} AS SELECT * FROM read_csv_auto('{path}', sample_size=-1)")
    conn.execute('CREATE TABLE eligible (uuid VARCHAR PRIMARY KEY, player_id BIGINT UNIQUE)')
    conn.executemany('INSERT INTO eligible VALUES (?,?)', sorted(identities.items()))
    conn.execute('''CREATE TEMP TABLE observed AS
        SELECT e.uuid, a.player_id, a.game_id, a.player_club_id, a.competition_id, a.date,
               g.season, CASE WHEN a.player_club_id = g.home_club_id THEN g.home_club_manager_name
                             WHEN a.player_club_id = g.away_club_id THEN g.away_club_manager_name END manager
          FROM appearances a JOIN eligible e USING (player_id) JOIN games g USING (game_id)''')
    facts = []
    # Each proposal is witnessed by recorded appearances. No citizenship/club-country
    # inference, title inference from standings, or approximate career-date overlap.
    for family, field in [('club', 'player_club_id'), ('league', 'competition_id'), ('manager', 'manager')]:
        rows = conn.execute(f'''SELECT uuid, player_id, {field}, min(date), max(date), min(game_id), count(DISTINCT game_id)
            FROM observed WHERE {field} IS NOT NULL GROUP BY uuid, player_id, {field}''').fetchall()
        for uuid, pid, value, first, last, game, count in rows:
            key = clubs.get(value) if family == 'club' else ('league:' + LEAGUES[value] if family == 'league' and value in LEAGUES else None)
            facts.append(dict(family=family, key=key, manager=value if family == 'manager' else None, playerId=uuid,
                sourcePlayerId=pid, sourceLocator=f'appearances.csv:player_id={pid};game_id={game}',
                capturedFact=f'{count} recorded appearances; {field}={value}', effectiveFrom=str(first), effectiveTo=str(last)))
    target_ids = {c['key'].split(':', 1)[1] for m in manifests for c in m['criteria'] if c['family'] == 'teammate'}
    conn.execute('CREATE TEMP TABLE targets(uuid VARCHAR PRIMARY KEY)')
    conn.executemany('INSERT INTO targets VALUES (?)', [(uuid,) for uuid in sorted(target_ids)])
    teammate_rows = conn.execute('''SELECT a.uuid, a.player_id, b.uuid, min(a.date), max(a.date), min(a.game_id), count(DISTINCT a.game_id)
        FROM observed a JOIN observed b ON a.game_id=b.game_id AND a.player_club_id=b.player_club_id AND a.uuid<>b.uuid
        JOIN targets t ON t.uuid=b.uuid JOIN clubs c ON c.club_id=a.player_club_id
        GROUP BY a.uuid, a.player_id, b.uuid''').fetchall()
    for uuid, pid, target, first, last, game, count in teammate_rows:
        facts.append(dict(family='teammate', key=f'teammate:{target}', playerId=uuid, sourcePlayerId=pid,
            sourceLocator=f'appearances.csv:player_id={pid};game_id={game};teammate_player_id={identities[target]}',
            capturedFact=f'{count} shared recorded club match appearances with {target}', effectiveFrom=str(first), effectiveTo=str(last)))
    source_range = conn.execute('SELECT min(date), max(date), count(*), count(DISTINCT player_id) FROM appearances').fetchone()
    source_players = conn.execute('SELECT count(*) FROM players').fetchone()[0]
    drawn_finals = conn.execute("SELECT competition_id, season, game_id FROM games WHERE round='Final' AND home_club_goals=away_club_goals ORDER BY competition_id, season").fetchall()
    reports = []
    for manifest in manifests:
        keys = {c['key'] for c in manifest['criteria']}
        manager_keys = defaultdict(set)
        for c in manifest['criteria']:
            if c['family'] == 'manager':
                manager_keys[normalized(c['labelEn'].removeprefix('Sir '))].add(c['key'])
        present = {(m['criterionKey'], m['playerId']) for m in manifest['memberships']}
        players = {p['id']: p for p in manifest['players']}
        missing = {}
        for fact in facts:
            if fact['family'] == 'manager':
                options = manager_keys.get(normalized(fact['manager']), set())
                if len(options) != 1:
                    continue
                key = next(iter(options))
            else:
                key = fact['key']
            if key not in keys or (key, fact['playerId']) in present:
                continue
            missing[(key, fact['playerId'])] = {**fact, 'criterionKey': key,
                'displayRecordMissing': fact['playerId'] not in players}
        membership_sets = defaultdict(set)
        for m in manifest['memberships']:
            membership_sets[m['criterionKey']].add(m['playerId'])
        incomplete_cells = []
        for board in manifest['boards']:
            for index, cell in enumerate(board['cells']):
                expected = membership_sets[board['rowCriteria'][index // 3]] & membership_sets[board['columnCriteria'][index % 3]]
                absent = sorted(expected - set(cell['playerIds']))
                extra = sorted(set(cell['playerIds']) - expected)
                if absent or extra:
                    incomplete_cells.append(dict(boardKey=board['key'], cellIndex=index, missing=absent, unsupported=extra))
        reports.append(dict(releaseVersion=manifest['release']['version'], players=len(players),
            playersWithoutSourceIdentity=sorted(set(players) - identities.keys()),
            missingMemberships=len(missing), missingByFamily=dict(Counter(v['family'] for v in missing.values())),
            proposedFacts=list(missing.values()), inconsistentCells=incomplete_cells))
    conn.close()
    return dict(status='requires_review', coverageTargetFromYear=1950, coverageTargetThroughDate=date.today().isoformat(), coverageComplete=False,
        scope='Pinned appearances + existing exact identity mappings; not exhaustive football history',
        eras=[dict(fromYear=year, throughYear=min(year+9, date.today().year),
            status='no_appearance_source' if year+9 < source_range[0].year else 'partial_snapshot_only')
            for year in range(1950, date.today().year + 1, 10)],
        snapshotChecksums=verified, source=dict(firstAppearance=str(source_range[0]), lastAppearance=str(source_range[1]),
            appearanceRows=source_range[2], playersWithAppearances=source_range[3], playerCatalogSize=source_players,
            mappedPlayers=len(identities)), releases=reports,
        limitations=['Players absent from the mapped bilingual catalog remain uncovered.',
            'Historical careers outside the appearance window require separately verified facts.',
            'Manager labels not mapping uniquely are not guessed.',
            'Trophy/award, country and wildcard completeness is not independently verified by this audit.',
            'Same-game teammate evidence is a sufficient witness, not a complete career-overlap dataset.',
            'The existing trophy generator skips drawn finals; review shootout results separately.'],
        drawnFinalsExcludedByGenerator=[dict(competitionId=c, season=s, gameId=g) for c, s, g in drawn_finals])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, action='append', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--require-no-source-gaps', action='store_true', help='Exit 2 for known-source omissions; does NOT certify historical completeness')
    args = parser.parse_args()
    result = audit(args.dataset, [json.loads(path.read_text()) for path in args.manifest], Path(__file__).with_name('dataset-2026-08-05.sha256'))
    with args.out.open('x') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
    print(json.dumps({**result['source'], 'releases': [{k: r[k] for k in ['releaseVersion', 'players', 'missingMemberships', 'missingByFamily']} for r in result['releases']]}))
    if args.require_no_source_gaps and any(r['missingMemberships'] or r['inconsistentCells'] for r in result['releases']):
        sys.exit(2)
