#!/usr/bin/env python3
"""Derive reviewable historical club, league, manager and teammate facts.

Uses actual archived appearances, cross-source identity/count corroboration and
existing Quizball UUIDs. No database access, new identities or live publishing.
"""
import argparse
import hashlib
import importlib.util
import json
import re
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


history = module('audit-historical-coverage')
epl = module('audit-epl-history')
crosscheck = module('crosscheck-epl-history')


def day(value):
    if value is None:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def derive(archive, comparisons, managers, manager_stints, manifests, manager_intervals=()):
    source_to_uuid = history.identities(manifests)
    names = defaultdict(set)
    for manifest in manifests:
        for p in manifest['players']:
            names[p['id']].add(history.name_key(p['nameEn']))
        for a in manifest.get('aliases', []):
            if a['locale'] == 'en' and a['acceptancePolicy'] == 'exact':
                names[a['playerId']].add(history.name_key(a['alias']))
    # Exact name/birthday cross-source candidates, still explicitly reviewable.
    mapped = {}
    for candidate in comparisons['identityCandidates']:
        uuid = source_to_uuid.get(candidate['sourcePlayerId'])
        if uuid and history.name_key(candidate['name']) in names[uuid]:
            mapped[candidate['archivePlayerId']] = (uuid, candidate['sourcePlayerId'])
    agreeing = {(x['sourcePlayerId'], x['sourceClubId'], x['seasonStart']): x
                for x in comparisons['comparisons'] if x['status'] == 'counts_agree'}
    manager_names = epl.keyed(managers, 'manager_id')
    archive_stints = epl.keyed(manager_stints, 'manager_team_id')
    stints_by_club = defaultdict(list)
    intervals = {row['archiveStintId']: row for row in manager_intervals}
    if len(intervals) != len(manager_intervals):
        raise ValueError('Duplicate official manager interval')
    if intervals.keys() - archive_stints.keys():
        raise ValueError('Official manager interval has no matching archive stint')
    for stint in manager_stints:
        # Missing endpoints and handover days cannot establish a precise witness.
        start, end = day(stint['manager_joined']), day(stint['manager_left'])
        interval = intervals.get(stint['manager_team_id'])
        if interval:
            if interval['managerId'] != stint['manager_id'] or interval['club'] != stint['team']:
                raise ValueError('Official manager evidence conflicts with archive identity')
            start, end = day(interval['fromExclusive']), day(interval['throughExclusive'])
            if not start or not end or start >= end:
                raise ValueError('Invalid official manager interval dates')
            stint = {**stint, 'officialEvidence': interval}
        if start and end and start < end and stint['manager_id'] in manager_names:
            stints_by_club[stint['team']].append((start, end, stint))

    selected = []
    excluded = Counter()
    for appearance in archive['appearances']:
        identity = mapped.get(appearance['sourcePlayerId'])
        club = crosscheck.CLUBS.get(appearance['team'])
        if not identity:
            excluded['identity_not_reconciled'] += 1
            continue
        if not club or (identity[1], club, appearance['seasonStart']) not in agreeing:
            excluded['player_club_season_not_corroborated'] += 1
            continue
        selected.append({**appearance, 'playerId': identity[0], 'providerPlayerId': identity[1],
                         'providerClubId': club})

    teams = defaultdict(list)
    for row in selected:
        teams[(row['gameId'], row['team'])].append(row)
    reports = []
    for manifest in manifests:
        criteria = {c['key']: c for c in manifest['criteria']}
        existing = {(m['criterionKey'], m['playerId']) for m in manifest['memberships']}
        displayed = {p['id'] for p in manifest['players']}
        club_keys = defaultdict(set)
        for membership in manifest['memberships']:
            if criteria[membership['criterionKey']]['family'] != 'club':
                continue
            for evidence in membership['evidence']:
                if evidence['sourceKey'] == 'dcaribou-transfermarkt-datasets':
                    match = re.search(r'(?:^|[:;])club_id=(\d+)(?:;|$)', evidence['sourceLocator'])
                    if match:
                        club_keys[match[1]].add(membership['criterionKey'])
        manager_keys = defaultdict(set)
        for c in criteria.values():
            if c['family'] == 'manager':
                manager_keys[history.name_key(c['labelEn'].removeprefix('Sir '))].add(c['key'])
        targets = {key.split(':', 1)[1]: key for key, c in criteria.items()
                   if c['family'] == 'teammate' and key.startswith('teammate:')}
        facts = {}
        held_manager = Counter()

        def add(key, row, extra=None):
            if key not in criteria or (key, row['playerId']) in existing:
                return
            entry = facts.setdefault((key, row['playerId']), {
                'criterionKey': key, 'family': criteria[key]['family'], 'playerId': row['playerId'],
                'sourcePlayerId': row['sourcePlayerId'], 'providerPlayerId': row['providerPlayerId'],
                'name': row['name'], 'birthDate': row['birthDate'],
                'displayPresent': row['playerId'] in displayed,
                'reviewStatus': 'requires_review', 'witnesses': [], 'games': set(),
                'firstWitnessDate': row['date'], 'lastWitnessDate': row['date']})
            if row['gameId'] in entry['games']:
                return
            entry['games'].add(row['gameId'])
            entry['firstWitnessDate'] = min(entry['firstWitnessDate'], row['date'])
            entry['lastWitnessDate'] = max(entry['lastWitnessDate'], row['date'])
            if len(entry['witnesses']) < 3:
                entry['witnesses'].append({
                    'gameId': row['gameId'], 'date': row['date'], 'team': row['team'],
                    'sourcePlayerGameId': row['sourcePlayerGameId'],
                    'sourceLocator': f"player_game.rds:player_game_id={row['sourcePlayerGameId']}",
                    'countCorroboration': agreeing[(row['providerPlayerId'], row['providerClubId'], row['seasonStart'])],
                    **(extra or {})})

        for row in selected:
            for key in club_keys[row['providerClubId']]:
                add(key, row)
            add('league:premier-league', row)
            played_on = day(row['date'])
            active = [s for start, end, s in stints_by_club[row['team']] if start < played_on < end]
            if len(active) != 1:
                held_manager['no_unique_strict_date_manager'] += 1
            else:
                manager = active[0]
                label = manager_names[manager['manager_id']]['manager_name'].removeprefix('Sir ')
                keys = manager_keys[history.name_key(label)]
                if len(keys) == 1:
                    add(next(iter(keys)), row, {'sourceManagerId': manager['manager_id'],
                                               'managerStintId': manager['manager_team_id'],
                                               'managerName': label,
                                               **({'officialManagerEvidence': manager['officialEvidence']}
                                                  if 'officialEvidence' in manager else {})})
            for teammate in teams[(row['gameId'], row['team'])]:
                if teammate['playerId'] != row['playerId'] and teammate['playerId'] in targets:
                    add(targets[teammate['playerId']], row, {
                        'teammatePlayerId': teammate['playerId'],
                        'teammateSourcePlayerGameId': teammate['sourcePlayerGameId']})

        proposals = []
        for key in sorted(facts):
            fact = facts[key]
            fact['witnessGameCount'] = len(fact.pop('games'))
            proposals.append(fact)
        reports.append({'releaseVersion': manifest['release']['version'],
                        'proposedFactCount': len(proposals),
                        'proposedByFamily': dict(Counter(f['family'] for f in proposals)),
                        'heldManagerAppearances': dict(held_manager), 'proposedFacts': proposals})
    return {'status': 'requires_review', 'publishable': False, 'coverageComplete': False,
            'noMappingsApplied': True, 'source': archive['source'],
            'summary': {'eligibleMappedIdentities': len(mapped), 'corroboratedAppearances': len(selected),
                        'excludedAppearances': dict(excluded)},
            'releases': reports,
            'limitations': [
                'These are fact proposals, not approved or published answers.',
                'Cross-source exact name/date-of-birth identity candidates still require review.',
                'Only matching appearance counts and existing Quizball identities are used.',
                'Manager handover days, unsupported unknown dates and ambiguous overlaps are excluded.',
                'Teammates must both have played in the same senior club match.',
                'Trophy, country and award facts are not inferred.',
                'Witness date bounds are not continuous playing/manager intervals.',
                'Unmapped players and uncorroborated appearances remain explicit gaps.']}


def main():
    import pyreadr
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, action='append', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    tables = {}
    for filename, expected in epl.PINS.items():
        file = args.raw / 'epldata' / filename
        with file.open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != expected:
                raise ValueError(f'Archive checksum mismatch: {filename}')
        frame = next(iter(pyreadr.read_r(str(file)).values()))
        tables[file.stem] = frame.astype(object).where(frame.notna(), None).to_dict('records')
    for filename, expected in history.PINS.items():
        with (args.raw / filename).open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != expected:
                raise ValueError(f'Aggregate checksum mismatch: {filename}')
    archive = epl.audit(tables)
    archive['source']['sha256'] = epl.PINS
    profiles = (r for _, r in history.rows(args.raw / 'player_profiles.csv', {'player_id', 'player_name', 'date_of_birth'}))
    performances = (r for _, r in history.rows(args.raw / 'player_performances.csv',
                    {'player_id', 'team_id', 'competition_id', 'season_name', 'nb_on_pitch'}))
    comparisons = crosscheck.crosscheck(profiles, archive['appearances'], performances, [])
    manifests = []
    for path in args.manifest:
        data = json.loads(path.read_text())
        manifests.append(data.get('candidate', data))
    interval_file = Path(__file__).with_name('historical-manager-intervals.json')
    intervals = json.loads(interval_file.read_text())['intervals']
    report = derive(archive, comparisons, tables['managers'], tables['manager_team'], manifests, intervals)
    report['officialManagerEvidence'] = {'intervals': intervals,
        'sha256': hashlib.sha256(interval_file.read_bytes()).hexdigest()}
    report['aggregateSource'] = {'provider': history.SOURCE, 'commit': history.COMMIT,
                                 'sha256': history.PINS, 'reuseStatus': 'not_established'}
    report['inputSha256'] = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in args.manifest}
    with args.out.open('x') as output:
        json.dump(report, output, ensure_ascii=False, indent=1)
        output.write('\n')
    print(json.dumps({'summary': report['summary'], 'releases': [
        {k: v for k, v in r.items() if k != 'proposedFacts'} for r in report['releases']]}))


if __name__ == '__main__':
    main()
