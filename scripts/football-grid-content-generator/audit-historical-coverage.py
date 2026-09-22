#!/usr/bin/env python3
"""Audit historical discovery against existing releases; never publish or connect to a DB.

Season aggregates witness club/league appearances only. They cannot establish
manager overlap, club teammates, trophy winners or exhaustive season coverage.
"""
import argparse
import csv
import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

LEAGUES = dict(zip(
    ['GB1', 'ES1', 'IT1', 'L1', 'FR1', 'NL1', 'PO1', 'SC1', 'TR1', 'BE1'],
    ['premier-league', 'la-liga', 'serie-a', 'bundesliga', 'ligue-1', 'eredivisie',
     'primeira-liga', 'scottish-premiership', 'super-lig', 'belgian-pro-league']))
SOURCE = 'salimt/football-datasets'
COMMIT = '4701b2bb96b4c26817c35d41d4e1ba940fb04832'
PINS = {
    'player_performances.csv': '21eda6556654478fe986de8972d3b94aea6551ebcd74d5eb153b65edb53d132b',
    'player_profiles.csv': '7ef9afbacf97577d099f21a0ef0ea0d46381bd4806a119f095b9562762a20096',
}


def name_key(value):
    return re.sub(r'[^a-z0-9]+', ' ', unicodedata.normalize('NFKD', value)
                  .encode('ascii', 'ignore').decode().lower()).strip()


def season_start(value):
    """Accept well-formed season pairs, preserving season precision (not dates)."""
    if re.fullmatch(r'(19|20)\d{2}', value):
        return int(value)
    match = re.fullmatch(r'(\d{2})/(\d{2})', value)
    if not match or (int(match[1]) + 1) % 100 != int(match[2]):
        return None
    start = int(match[1])
    return (1900 if start >= 50 else 2000) + start


def rows(path, required):
    with path.open(newline='', encoding='utf-8') as handle:
        reader = csv.DictReader(handle, strict=True)
        if not required.issubset(set(reader.fieldnames or [])):
            raise ValueError(f'Missing required columns: {path.name}')
        for number, row in enumerate(reader, 2):
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f'Malformed CSV record: {path.name}:{number}')
            yield number, row


def identities(manifests):
    """Only existing same-provider IDs, not a cross-provider numeric/name join."""
    player_ids = defaultdict(set)
    for manifest in manifests:
        for member in manifest['memberships']:
            for evidence in member['evidence']:
                if evidence['sourceKey'] != 'dcaribou-transfermarkt-datasets':
                    continue
                match = re.search(r'(?:^|[:;])player_id=(\d+)(?:;|$)', evidence['sourceLocator'])
                if match:
                    player_ids[match[1]].add(member['playerId'])
    reverse = defaultdict(set)
    for provider_id, uuids in player_ids.items():
        for uuid in uuids:
            reverse[uuid].add(provider_id)
    if any(len(values) != 1 for values in [*player_ids.values(), *reverse.values()]):
        raise ValueError('Conflicting Transfermarkt identity mapping')
    return {key: next(iter(values)) for key, values in player_ids.items()}


def audit(raw, manifests, verify_pins=True):
    hashes = {}
    for filename, expected in PINS.items():
        with (raw / filename).open('rb') as handle:
            hashes[filename] = hashlib.file_digest(handle, 'sha256').hexdigest()
        if verify_pins and hashes[filename] != expected:
            raise ValueError(f'Source checksum mismatch: {filename}')
    mapped = identities(manifests)
    profiles = {}
    for _, row in rows(raw / 'player_profiles.csv', {'player_id', 'player_name', 'date_of_birth'}):
        pid = row['player_id']
        if pid in profiles:
            raise ValueError(f'Duplicate source player profile: {pid}')
        # Provider appends its own ID to display names; do not remove other suffixes.
        suffix = ' (' + pid + ')'
        name = row['player_name']
        profiles[pid] = {'name': name[:-len(suffix)] if name.endswith(suffix) else name,
                         'dateOfBirth': row['date_of_birth']}
    names = defaultdict(set)
    for manifest in manifests:
        for player in manifest['players']:
            names[player['id']].add(name_key(player['nameEn']))
        for alias in manifest.get('aliases', []):
            if alias['locale'] == 'en' and alias['acceptancePolicy'] == 'exact':
                names[alias['playerId']].add(name_key(alias['alias']))
    identity_conflicts = {pid for pid, uuid in mapped.items()
                          if pid in profiles and name_key(profiles[pid]['name']) not in names[uuid]}
    cells = defaultdict(lambda: {'players': set(), 'teams': set(), 'rows': 0})
    observed, rejected, conflicts = {}, Counter(), set()
    for number, row in rows(raw / 'player_performances.csv',
                            {'player_id', 'season_name', 'competition_id', 'team_id', 'nb_on_pitch'}):
        year = season_start(row['season_name'])
        if year is None:
            rejected['unparsedSeason'] += 1
            continue
        # Boundary seasons are separate: aggregates cannot identify exact 1990/2012 dates.
        if not 1989 <= year <= 2012 or row['competition_id'] not in LEAGUES:
            continue
        if row['competition_id'] == 'GB1' and year < 1992:
            rejected['premierLeagueBeforeInception'] += 1
            continue
        if not row['nb_on_pitch'].isdigit() or int(row['nb_on_pitch']) < 1:
            rejected['noPositiveAppearanceCount'] += 1
            continue
        if not row['player_id'].isdigit() or not row['team_id'].isdigit():
            rejected['invalidProviderIdentity'] += 1
            continue
        key = (row['player_id'], row['competition_id'], row['team_id'], year)
        value = {**row, 'sourceRow': number, 'seasonStart': year}
        if key in observed:
            if observed[key]['nb_on_pitch'] != row['nb_on_pitch']:
                conflicts.add(key)
            else:
                rejected['duplicateRows'] += 1
        else:
            observed[key] = value
    for key in conflicts:
        observed.pop(key, None)
    rejected['conflictingSeasonRows'] = len(conflicts)
    historical_players = set()
    for row in observed.values():
        cell = cells[(row['competition_id'], row['seasonStart'])]
        cell['players'].add(row['player_id']); cell['teams'].add(row['team_id']); cell['rows'] += 1
        historical_players.add(row['player_id'])
    seasons = []
    for competition, label in LEAGUES.items():
        for year in range(1989, 2013):
            cell = cells[(competition, year)]
            seasons.append({'competition': label, 'seasonStart': year,
                            'boundarySeason': year in (1989, 2012),
                            'playerCount': len(cell['players']), 'teamCount': len(cell['teams']),
                            'positiveAppearanceRows': cell['rows'],
                            'status': 'not_applicable' if competition == 'GB1' and year < 1992 else
                                      ('observed_incomplete' if cell['rows'] else 'missing')})
    releases = []
    for manifest in manifests:
        criterion_by_key = {c['key']: c for c in manifest['criteria']}
        club_keys = defaultdict(set)
        for member in manifest['memberships']:
            if criterion_by_key[member['criterionKey']]['family'] != 'club':
                continue
            for evidence in member['evidence']:
                if evidence['sourceKey'] != 'dcaribou-transfermarkt-datasets':
                    continue
                match = re.search(r'(?:^|[:;])club_id=(\d+)(?:;|$)', evidence['sourceLocator'])
                if match:
                    club_keys[match[1]].add(member['criterionKey'])
        existing = {(m['criterionKey'], m['playerId']) for m in manifest['memberships']}
        displayed = {p['id'] for p in manifest['players']}
        proposals = {}
        for row in observed.values():
            pid = row['player_id']; uuid = mapped.get(pid)
            if not uuid or pid in identity_conflicts or pid not in profiles:
                continue
            keys = set(club_keys[row['team_id']]) | {'league:' + LEAGUES[row['competition_id']]}
            for key in keys:
                if key not in criterion_by_key or (key, uuid) in existing:
                    continue
                proposal = proposals.setdefault((key, uuid), {
                    'criterionKey': key, 'playerId': uuid, 'sourcePlayerId': pid,
                    'name': profiles[pid]['name'], 'displayPresent': uuid in displayed,
                    'reviewStatus': 'requires_review', 'witnesses': []})
                proposal['witnesses'].append({'sourceRow': row['sourceRow'], 'season': row['season_name'],
                    'competitionId': row['competition_id'], 'teamId': row['team_id'],
                    'appearances': int(row['nb_on_pitch'])})
        releases.append({'releaseVersion': manifest['release']['version'],
                         'proposedFactCount': len(proposals),
                         'proposedFacts': [proposals[key] for key in sorted(proposals)]})
    return {'status': 'requires_review', 'publishable': False, 'coverageComplete': False,
            'scope': {'priorityFromYear': 1990, 'priorityThroughYear': 2012,
                      'observationPrecision': 'season', 'boundarySeasons': ['1989/90', '2012/13'],
                      'familiesProposed': ['club', 'league']},
            'source': {'provider': SOURCE, 'commit': COMMIT, 'sha256': hashes,
                       'reuseStatus': 'not_established', 'url': 'https://github.com/' + SOURCE},
            'summary': {'historicalPlayers': len(historical_players),
                        'mappedHistoricalPlayers': len(historical_players & mapped.keys()),
                        'unmappedHistoricalPlayers': len(historical_players - mapped.keys()),
                        'positiveAppearanceRows': len(observed), 'rejected': dict(rejected)},
            'identityConflicts': [{'sourcePlayerId': pid, 'sourceName': profiles[pid]['name'],
                                   'existingNames': sorted(names[mapped[pid]])}
                                  for pid in sorted(identity_conflicts & historical_players)],
            'unmappedPlayers': [{'sourcePlayerId': pid, **profiles.get(pid, {})}
                               for pid in sorted(historical_players - mapped.keys())],
            'seasons': seasons, 'releases': releases,
            'limitations': ['Observed rows are not an exhaustive roster.',
                            'Manager, teammate, trophy and country facts are not inferred.',
                            'Season boundaries are not exact career/appearance dates.',
                            'Unmapped identities and conflicting names cannot be imported.',
                            'Independent source verification and reuse review remain required.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, action='append', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    manifests = []
    for file in args.manifest:
        data = json.loads(file.read_text())
        manifests.append(data.get('candidate', data))
    report = audit(args.raw, manifests)
    report['inputSha256'] = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in args.manifest}
    with args.out.open('x') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2); handle.write('\n')
    print(json.dumps(report['summary']))


if __name__ == '__main__':
    main()
