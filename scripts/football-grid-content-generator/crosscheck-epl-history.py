#!/usr/bin/env python3
"""Cross-check historical observations without applying identity links or answers."""
import argparse
import hashlib
import importlib.util
import json
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

# Explicit source labels -> source IDs, not guessed runtime names or new UUIDs.
# Wimbledon is the original club, not AFC Wimbledon or Milton Keynes Dons.
CLUBS = {
    'Arsenal': '11', 'Aston Villa': '405', 'Barnsley': '349', 'Birmingham C': '337',
    'Blackburn': '164', 'Blackpool': '1181', 'Bolton': '355', 'Bradford C': '1027',
    'Burnley': '1132', 'Charlton': '358', 'Chelsea': '631', 'Coventry C': '990',
    'Crystal P': '873', 'Derby Co.': '22', 'Everton': '29', 'Fulham': '931',
    'Hull C': '3008', 'Ipswich T': '677', 'Leeds U': '399', 'Leicester C': '1003',
    'Liverpool': '31', 'Man. City': '281', 'Man. Utd.': '985', 'Middlesbro': '641',
    'Newcastle U': '762', 'Norwich C': '1123', 'Nottm Forest': '703', 'Oldham': '1078',
    'Portsmouth': '1020', 'QPR': '1039', 'Reading': '1032', 'Sheff. Utd.': '350',
    'Sheff. Wed.': '1035', 'Southampton': '180', 'Stoke C': '512', 'Sunderland': '289',
    'Swansea': '2288', 'Swindon T': '352', 'Tottenham H': '148', 'Watford': '1010',
    'West Brom': '984', 'West Ham U': '379', 'Wigan Ath.': '1071',
    'Wimbledon': '114309', 'Wolves': '543',
}


def identity_key(name, birthday):
    # Missing/estimated birthday strings cannot turn a common name into an identity.
    if not birthday or len(birthday) != 10:
        return None
    try:
        date.fromisoformat(birthday)
    except ValueError:
        return None
    name = history.name_key(name)
    return (name, birthday) if name else None


def crosscheck(profiles, appearances, performances, releases):
    candidates = defaultdict(set)
    for row in profiles:
        pid = row['player_id']
        suffix = ' (' + pid + ')'
        name = row['player_name']
        name = name[:-len(suffix)] if name.endswith(suffix) else name
        key = identity_key(name, row['date_of_birth'])
        if key:
            candidates[key].add(pid)
    identities = {}
    for row in appearances:
        key = identity_key(row['name'], row['birthDate'])
        value = (row['name'], row['birthDate'])
        previous = identities.setdefault(row['sourcePlayerId'], value)
        if previous != value:
            raise ValueError('Conflicting archive player identity')
    proposals = {}
    reverse = defaultdict(set)
    for pid, (name, birthday) in identities.items():
        matches = candidates[identity_key(name, birthday)]
        if len(matches) == 1:
            tm_id = next(iter(matches))
            proposals[pid] = tm_id
            reverse[tm_id].add(pid)
    # Both directions must be unique. Even these links remain review candidates.
    proposals = {pid: tm for pid, tm in proposals.items() if len(reverse[tm]) == 1}
    observed = defaultdict(set)
    for row in appearances:
        if row['sourcePlayerId'] not in proposals:
            continue
        if row['team'] not in CLUBS:
            raise ValueError(f"Unmapped archive club: {row['team']}")
        key = (proposals[row['sourcePlayerId']], CLUBS[row['team']], row['seasonStart'])
        observed[key].add(row['gameId'])
    aggregate = defaultdict(set)
    for row in performances:
        year = history.season_start(row['season_name'])
        if row['competition_id'] != 'GB1' or year is None or not 1992 <= year <= 2011:
            continue
        if row['nb_on_pitch'].isdigit() and int(row['nb_on_pitch']) > 0:
            aggregate[(row['player_id'], row['team_id'], year)].add(int(row['nb_on_pitch']))
    compared = []
    for (pid, club, year), games in sorted(observed.items()):
        counts = aggregate[(pid, club, year)]
        status = ('aggregate_missing' if not counts else 'aggregate_conflict' if len(counts) != 1
                  else 'counts_agree' if next(iter(counts)) == len(games) else 'counts_differ')
        compared.append({'sourcePlayerId': pid, 'sourceClubId': club, 'seasonStart': year,
                         'archiveAppearances': len(games), 'aggregateAppearances': sorted(counts),
                         'status': status, 'sampleArchiveGameId': min(games)})
    agreeing = {(c['sourcePlayerId'], c['sourceClubId'], c['seasonStart']) for c in compared
                if c['status'] == 'counts_agree'}
    reviewed_releases = []
    for release in releases:
        corroborated = []
        for fact in release['proposedFacts']:
            witnesses = [w for w in fact['witnesses'] if w['competitionId'] == 'GB1' and
                         (fact['sourcePlayerId'], w['teamId'], history.season_start(w['season'])) in agreeing]
            if witnesses:
                corroborated.append({'criterionKey': fact['criterionKey'], 'playerId': fact['playerId'],
                                     'sourcePlayerId': fact['sourcePlayerId'], 'name': fact['name'],
                                     'corroboratedWitnesses': witnesses, 'reviewStatus': 'requires_review'})
        reviewed_releases.append({'releaseVersion': release['releaseVersion'],
                                  'corroboratedFactCount': len(corroborated), 'facts': corroborated})
    return {'status': 'requires_review', 'publishable': False, 'coverageComplete': False,
            'noMappingsApplied': True,
            'summary': {'archivePlayers': len(identities), 'uniqueIdentityCandidates': len(proposals),
                        'unresolvedIdentities': len(identities) - len(proposals),
                        'comparedPlayerClubSeasons': len(compared),
                        'byComparison': dict(Counter(c['status'] for c in compared))},
            'identityCandidates': [{'archivePlayerId': pid, 'sourcePlayerId': tm,
                                    'name': identities[pid][0], 'birthDate': identities[pid][1],
                                    'reviewStatus': 'requires_review'} for pid, tm in sorted(proposals.items())],
            'clubCrosswalk': CLUBS, 'comparisons': compared, 'releases': reviewed_releases,
            'limitations': ['Exact name/date-of-birth candidates are not approved UUID mappings.',
                            'Agreement between two archives is corroboration, not proof of completeness.',
                            'Disagreements are retained, never patched by choosing the larger count.',
                            'No manager, teammate, trophy or nationality facts are inferred.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path, required=True)
    parser.add_argument('--epl', type=Path, required=True)
    parser.add_argument('--historical', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    for name, expected in history.PINS.items():
        with (args.raw / name).open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != expected:
                raise ValueError(f'Source checksum mismatch: {name}')
    archive = json.loads(args.epl.read_text())
    historical = json.loads(args.historical.read_text())
    if (archive['source']['commit'] != epl.COMMIT or archive['source']['sha256'] != epl.PINS
            or historical['source']['commit'] != history.COMMIT or historical['source']['sha256'] != history.PINS):
        raise ValueError('Expected the pinned archive audits')
    profiles = (r for _, r in history.rows(args.raw / 'player_profiles.csv', {'player_id', 'player_name', 'date_of_birth'}))
    performances = (r for _, r in history.rows(args.raw / 'player_performances.csv',
                    {'player_id', 'team_id', 'competition_id', 'season_name', 'nb_on_pitch'}))
    result = crosscheck(profiles, archive['appearances'], performances, historical['releases'])
    result['inputSha256'] = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [args.epl, args.historical]}
    with args.out.open('x') as handle:
        json.dump(result, handle, ensure_ascii=False, indent=1); handle.write('\n')
    print(json.dumps(result['summary']))


if __name__ == '__main__':
    main()
