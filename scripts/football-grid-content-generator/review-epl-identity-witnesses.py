#!/usr/bin/env python3
"""Independently check historical identities and both sides of teammate witnesses.

Offline audit only. A passed identity check is not a content/source-use approval.
Never changes UUID mappings, memberships, release approval or a database.
"""
import argparse
import csv
import gzip
import hashlib
import importlib.util
import json
from collections import Counter, defaultdict
from pathlib import Path

spec = importlib.util.spec_from_file_location('history', Path(__file__).with_name('audit-historical-coverage.py'))
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)
PROFILE_SHA256 = '1457768f75cb27adb38b2227b9c8facc53174a626cbe1e18f9019b5647fa8d3c'


def unique_index(rows, key):
    result = {}
    for row in rows:
        identity = row[key]
        if identity in result and result[identity] != row:
            raise ValueError(f'Conflicting duplicate {key}: {identity}')
        result[identity] = row
    return result


def review(report, archive, crosscheck, profiles, manifests):
    if report['source']['commit'] != archive['source']['commit']:
        raise ValueError('Historical report and appearances use different sources')
    provider_to_uuid = history.identities(manifests)
    names = defaultdict(set)
    for manifest in manifests:
        for player in manifest['players']:
            names[player['id']].add(history.name_key(player['nameEn']))
        for alias in manifest.get('aliases', []):
            if alias['locale'] == 'en' and alias['acceptancePolicy'] == 'exact':
                names[alias['playerId']].add(history.name_key(alias['alias']))
    mappings = {key: row['sourcePlayerId'] for key, row in
                unique_index(crosscheck['identityCandidates'], 'archivePlayerId').items()}
    # Reuse neither a suggested UUID nor a guessed/surname-only name match.
    appearances = unique_index(archive['appearances'], 'sourcePlayerGameId')
    modern = unique_index(profiles, 'player_id')

    def identity_reason(appearance, expected_uuid):
        provider = mappings.get(appearance['sourcePlayerId'])
        if not provider or provider_to_uuid.get(provider) != expected_uuid:
            return 'existing_uuid_mapping_not_confirmed'
        profile = modern.get(provider)
        if profile is None:
            return 'independent_profile_missing'
        if profile.get('date_of_birth', '')[:10] != appearance['birthDate']:
            return 'birth_date_disagreement'
        accepted = names.get(expected_uuid, set())
        if history.name_key(appearance['name']) not in accepted:
            return 'archive_name_not_in_existing_exact_aliases'
        # The stable provider ID, full DOB and existing exact name jointly anchor
        # identity. Provider display names can use a different legal given name.
        return None

    decisions = []
    for release in report['releases']:
        for fact in release['proposedFacts']:
            failures = []
            for witness in fact['witnesses']:
                appearance = appearances.get(witness['sourcePlayerGameId'])
                if appearance is None or any(appearance[k] != witness[k] for k in ['gameId', 'date', 'team']):
                    raise ValueError('Fact witness differs from pinned appearance')
                if (appearance['sourcePlayerId'] != fact['sourcePlayerId']
                        or mappings.get(appearance['sourcePlayerId']) != fact['providerPlayerId']
                        or appearance['birthDate'] != fact['birthDate']):
                    raise ValueError('Fact witness identity differs from report')
                reason = identity_reason(appearance, fact['playerId'])
                if reason:
                    failures.append(reason)
                if fact['family'] == 'teammate':
                    target = fact['criterionKey'].removeprefix('teammate:')
                    teammate = appearances.get(witness['teammateSourcePlayerGameId'])
                    if (target == fact['playerId'] or witness['teammatePlayerId'] != target
                            or teammate is None or any(teammate[k] != appearance[k] for k in ['gameId', 'date', 'team'])):
                        raise ValueError('Teammate is not a different player in the same club match')
                    reason = identity_reason(teammate, target)
                    if reason:
                        failures.append('teammate_' + reason)
            if not fact['witnesses']:
                raise ValueError('Fact has no witnesses')
            decisions.append({'releaseVersion': release['releaseVersion'],
                'criterionKey': fact['criterionKey'], 'playerId': fact['playerId'],
                'name': fact['name'], 'family': fact['family'],
                'firstWitnessDate': fact['firstWitnessDate'], 'lastWitnessDate': fact['lastWitnessDate'],
                'status': 'identity_confirmed' if not failures else 'held_for_identity_review',
                'reasons': sorted(set(failures)), 'witnessesChecked': len(fact['witnesses'])})
    distinct = {}
    for decision in decisions:
        key = (decision['criterionKey'], decision['playerId'])
        previous = distinct.get(key)
        if previous and (previous['status'], previous['reasons']) != (decision['status'], decision['reasons']):
            raise ValueError('The same fact has inconsistent identity decisions across releases')
        distinct[key] = decision
    return {'publishable': False, 'coverageComplete': False,
        'scope': 'Independent DOB/UUID/name checks and same-match teammate witness checks only',
        'summary': {'distinctFacts': len(distinct), 'byStatus': dict(Counter(d['status'] for d in distinct.values())),
            'heldReasons': dict(Counter(r for d in distinct.values() for r in d['reasons'])),
            'earliestMatch': min(d['firstWitnessDate'] for d in decisions),
            'latestMatch': max(d['lastWitnessDate'] for d in decisions)},
        'decisions': decisions,
        'remaining': ['Review source-use terms before approving a production source.',
            'Resolve missing retired-player profiles; held does not mean the football relationship is false.',
            'Validate manager intervals, portraits and all four answer locales for the final chosen subset.',
            'Coverage is observed EPL history, not complete 1990–2012 or 1950–1989 coverage.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['fact-report', 'archive', 'crosscheck', 'profiles', 'out']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    profile_bytes = args.profiles.read_bytes()
    if hashlib.sha256(profile_bytes).hexdigest() != PROFILE_SHA256:
        raise ValueError('Expected the pinned modern player snapshot')
    report = json.loads(args.fact_report.read_text())
    manifests = []
    for filename, checksum in report['inputSha256'].items():
        content = Path(filename).read_bytes()
        if hashlib.sha256(content).hexdigest() != checksum:
            raise ValueError('Manifest changed since fact derivation')
        data = json.loads(content)
        manifests.append(data.get('candidate', data))
    archive = json.loads(args.archive.read_text())
    crosscheck = json.loads(args.crosscheck.read_text())
    expected = crosscheck.get('inputSha256', {}).get(str(args.archive))
    if expected != hashlib.sha256(args.archive.read_bytes()).hexdigest():
        raise ValueError('Archive is not the one used by the identity cross-check')
    with gzip.open(args.profiles, 'rt') as handle:
        result = review(report, archive, crosscheck, list(csv.DictReader(handle)), manifests)
    result['inputSha256'] = {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [args.fact_report, args.archive, args.crosscheck, args.profiles]}
    with args.out.open('x') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps(result['summary']))


if __name__ == '__main__':
    main()
