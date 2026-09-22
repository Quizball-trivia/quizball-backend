#!/usr/bin/env python3
"""Measure all available source records against the actual clue scope and cutoff.

Observations are not exhaustive rosters or approved facts. Missing seasons and
unresolved club mappings remain visible. Never connects to a database.
"""
import argparse
import csv
import gzip
import hashlib
import importlib.util
import json
import re
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path


spec = importlib.util.spec_from_file_location('history', Path(__file__).with_name('audit-historical-coverage.py'))
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


def scope(manifests):
    criteria = {}
    club_ids = defaultdict(set)
    for manifest in manifests:
        for criterion in manifest['criteria']:
            prior = criteria.setdefault(criterion['key'], criterion)
            if prior['family'] != criterion['family'] or prior.get('subtype') != criterion.get('subtype'):
                raise ValueError(f"Conflicting criterion meaning: {criterion['key']}")
        for membership in manifest['memberships']:
            if criteria[membership['criterionKey']]['family'] != 'club':
                continue
            for evidence in membership['evidence']:
                if evidence['sourceKey'] != 'dcaribou-transfermarkt-datasets':
                    continue
                match = re.search(r'(?:^|[:;])club_id=(\d+)(?:;|$)', evidence['sourceLocator'])
                if match:
                    club_ids[membership['criterionKey']].add(match[1])
    if any(len(ids) != 1 for ids in club_ids.values()):
        raise ValueError('Conflicting source IDs for a club clue')
    leagues = {provider: key for provider, key in history.LEAGUES.items()
               if f'league:{key}' in criteria}
    return criteria, dict(club_ids), leagues


def collect_aggregate(records, from_year, through, leagues, scoped_clubs):
    rows, rejected, conflicts = {}, Counter(), set()
    names = defaultdict(set)
    for number, row in records:
        year = history.season_start(row['season_name'])
        if year is None:
            rejected['unparsed_season'] += 1
            continue
        if year < from_year or year > through.year:
            continue
        club, competition = row['team_id'], row['competition_id']
        if row.get('team_name') and club.isdigit():
            names[history.name_key(row['team_name'])].add(club)
        if competition not in leagues and club not in scoped_clubs:
            continue
        if not club.isdigit() or not row['player_id'].isdigit():
            rejected['invalid_identity'] += 1
            continue
        if competition == 'GB1' and year < 1992:
            rejected['premier_league_before_inception'] += 1
            continue
        count = row['nb_on_pitch']
        if not count.isdigit() or int(count) < 1:
            rejected['no_positive_appearances'] += 1
            continue
        # A season containing the cutoff cannot be date-filtered from a total.
        # Retain it as unresolved below; never turn it into dated evidence.
        cutoff_boundary = year == through.year or (year == through.year - 1 and through.month <= 6)
        key = (row['player_id'], competition, club, year)
        value = {'playerId': row['player_id'], 'competitionId': competition, 'clubId': club,
                 'seasonStart': year, 'appearances': int(count), 'sourceRow': number,
                 'cutoffBoundary': cutoff_boundary}
        if key in rows:
            if rows[key]['appearances'] != value['appearances']:
                conflicts.add(key)
            else:
                rejected['duplicate_rows'] += 1
        else:
            rows[key] = value
    for key in conflicts:
        rows.pop(key, None)
    rejected['conflicting_player_club_seasons'] = len(conflicts)
    return list(rows.values()), dict(rejected), names


def summarize(observations):
    return {'players': len({r['playerId'] for r in observations}),
            'clubs': len({r['clubId'] for r in observations}), 'records': len(observations)}


def modern_records(dataset, from_year, through):
    with gzip.open(dataset / 'games.csv.gz', 'rt') as handle:
        games = {r['game_id']: r for r in csv.DictReader(handle)}
    with gzip.open(dataset / 'appearances.csv.gz', 'rt') as handle:
        for row in csv.DictReader(handle):
            played = date.fromisoformat(row['date'][:10])
            if not date(from_year, 1, 1) <= played <= through:
                continue
            game = games.get(row['game_id'])
            if not game or game['competition_id'] != row['competition_id']:
                raise ValueError(f"Unresolved appearance/game join: {row['appearance_id']}")
            yield {'playerId': row['player_id'], 'clubId': row['player_club_id'],
                   'competitionId': row['competition_id'], 'seasonStart': int(game['season']),
                   'date': played.isoformat()}


def build(raw, dataset, manifests, from_year, through):
    criteria, club_mapping, leagues = scope(manifests)
    scoped_clubs = set().union(*club_mapping.values()) if club_mapping else set()
    aggregate, rejected, source_names = collect_aggregate(history.rows(raw / 'player_performances.csv',
        {'player_id', 'team_id', 'season_name', 'competition_id', 'nb_on_pitch'}),
        from_year, through, leagues, scoped_clubs)
    by_aggregate = defaultdict(list)
    for row in aggregate:
        by_aggregate[('league', row['competitionId'], row['seasonStart'])].append(row)
        by_aggregate[('club', row['clubId'], row['seasonStart'])].append(row)
    modern = defaultdict(lambda: {'players': set(), 'clubs': set(), 'records': 0, 'first': None, 'last': None})
    all_modern_players = set()
    first = last = None
    appearance_count = 0
    for row in modern_records(dataset, from_year, through):
        first = min(first or row['date'], row['date']); last = max(last or row['date'], row['date'])
        all_modern_players.add(row['playerId']); appearance_count += 1
        for family, entity in [('league', row['competitionId']), ('club', row['clubId'])]:
            if (family == 'league' and entity not in leagues) or (family == 'club' and entity not in scoped_clubs):
                continue
            cell = modern[(family, entity, row['seasonStart'])]
            cell['players'].add(row['playerId']); cell['clubs'].add(row['clubId']); cell['records'] += 1
            cell['first'] = min(cell['first'] or row['date'], row['date'])
            cell['last'] = max(cell['last'] or row['date'], row['date'])
    with gzip.open(dataset / 'clubs.csv.gz', 'rt') as handle:
        for club in csv.DictReader(handle):
            source_names[history.name_key(club['name'])].add(club['club_id'])
    entities = [('league', provider, 'league:' + label) for provider, label in leagues.items()]
    entities += [('club', next(iter(ids)), key) for key, ids in sorted(club_mapping.items())]
    seasons = []
    for family, source_id, key in entities:
        for year in range(from_year, through.year + 1):
            agg = by_aggregate[(family, source_id, year)]
            mod = modern[(family, source_id, year)]
            observed = len(agg) > 0 or mod['records'] > 0
            seasons.append({'criterionKey': key, 'sourceId': source_id, 'seasonStart': year,
                'aggregate': summarize(agg),
                'aggregateCutoffBoundaryRows': sum(r['cutoffBoundary'] for r in agg),
                'datedAppearances': {'players': len(mod['players']), 'clubs': len(mod['clubs']),
                                     'records': mod['records'], 'first': mod['first'], 'last': mod['last']},
                'status': 'observed_incomplete' if observed else 'unassessed_no_source_records'})
    unresolved = []
    for key, criterion in sorted(criteria.items()):
        if criterion['family'] == 'club' and key not in club_mapping:
            unresolved.append({'criterionKey': key, 'label': criterion['labelEn'],
                'candidateSourceIds': sorted(source_names[history.name_key(criterion['labelEn'])]),
                'status': 'identity_mapping_requires_review'})
    eras = []
    for start, end in [(1990, 2012), (1950, 1989), (2013, through.year)]:
        if max(from_year, start) > min(end, through.year):
            continue
        selected = [r for r in aggregate if max(from_year, start) <= r['seasonStart'] <= min(end, through.year)]
        eras.append({'fromSeasonStart': max(from_year, start), 'throughSeasonStart': min(end, through.year),
                     **summarize(selected), 'status': 'observed_incomplete' if selected else 'unassessed'})
    return {'status': 'requires_review', 'publishable': False, 'coverageComplete': False,
        'target': {'fromYear': from_year, 'throughDate': through.isoformat()},
        'scope': {'criterionCounts': dict(Counter(c['family'] for c in criteria.values())),
                  'clubsWithExistingSourceMapping': len(club_mapping),
                  'distinctMappedClubIds': len(scoped_clubs), 'unresolvedClubClues': len(unresolved)},
        'source': {'aggregateProvider': history.SOURCE, 'aggregateCommit': history.COMMIT,
                   'aggregateReuseStatus': 'not_established',
                   'aggregateLatestSeasonStart': max((r['seasonStart'] for r in aggregate), default=None),
                   'appearanceFirst': first, 'appearanceLast': last,
                   'appearanceRows': appearance_count, 'playersWithAppearances': len(all_modern_players)},
        'aggregateSummary': {**summarize(aggregate), 'rejected': rejected}, 'eras': eras,
        'unresolvedClubMappings': unresolved, 'seasons': seasons,
        'limitations': ['Counts measure observed source rows, never an exhaustive player roster.',
            'A club clue is not necessarily a distinct club; aliases can share identities.',
            'Name-only club matches are candidates, never applied identity mappings.',
            'Missing seasons are unassessed; clubs or leagues may not yet have existed.',
            'Season totals cannot establish exact dates, teammate overlap or trophy wins.',
            'The opening 1949/50 boundary needs dated evidence for appearances in 1950.',
            'Current-cutoff season aggregates need dated evidence before any import.',
            'Earlier Scottish/predecessor competitions need explicit clue continuity rules.',
            'Other competitions in a mapped club history are observations, not approved senior appearances.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, action='append', required=True)
    parser.add_argument('--from-year', type=int, default=1950)
    parser.add_argument('--through-date', type=date.fromisoformat, default=date(2026, 8, 31))
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if not 1950 <= args.from_year <= args.through_date.year:
        parser.error('Expected 1950 <= from-year <= through-date year')
    checksums = dict(history.PINS)
    for line in Path(__file__).with_name('dataset-2026-08-05.sha256').read_text().splitlines():
        digest, name = line.split()
        checksums[name] = digest
    for name, expected in checksums.items():
        path = (args.dataset if name.endswith('.gz') else args.raw) / name
        with path.open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != expected:
                raise ValueError(f'Source checksum mismatch: {name}')
    manifests = []
    for path in args.manifest:
        data = json.loads(path.read_text())
        manifests.append(data.get('candidate', data))
    result = build(args.raw, args.dataset, manifests, args.from_year, args.through_date)
    result['sourceChecksums'] = checksums
    result['inputSha256'] = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in args.manifest}
    with args.out.open('x') as handle:
        json.dump(result, handle, ensure_ascii=False, indent=1)
        handle.write('\n')
    print(json.dumps({k: result[k] for k in ['scope', 'source', 'aggregateSummary', 'eras']}))


if __name__ == '__main__':
    main()
