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
import re
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

spec = importlib.util.spec_from_file_location('history', Path(__file__).with_name('audit-historical-coverage.py'))
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)
PROFILE_SHA256 = '1457768f75cb27adb38b2227b9c8facc53174a626cbe1e18f9019b5647fa8d3c'
RETIRED_ENTITIES_SHA256 = '4a35aaee42fd626c2b945b6aaab8d5c468e72f8c7d97313073437d3cf39de546'


def unique_index(rows, key):
    result = {}
    for row in rows:
        identity = row[key]
        if identity in result and result[identity] != row:
            raise ValueError(f'Conflicting duplicate {key}: {identity}')
        result[identity] = row
    return result


def retired_profiles(data):
    """Read corroborating identity fields, never career facts, from pinned Wikidata."""
    profiles = []
    held = []
    for entity in data['entities'].values():
        def values(prop):
            statements = [s for s in entity.get('claims', {}).get(prop, [])
                          if s.get('rank') != 'deprecated']
            preferred = [s for s in statements if s.get('rank') == 'preferred']
            return [s['mainsnak']['datavalue']['value'] for s in preferred or statements
                    if s.get('mainsnak', {}).get('snaktype') == 'value'
                    and 'datavalue' in s['mainsnak']]

        ids = set(v for v in values('P2446') if isinstance(v, str) and v.isdigit())
        days = set()
        for value in values('P569'):
            if (value.get('precision') != 11 or value.get('before', 0) != 0
                    or value.get('after', 0) != 0
                    or value.get('calendarmodel') != 'http://www.wikidata.org/entity/Q1985727'
                    or not re.fullmatch(r'\+\d{4}-\d{2}-\d{2}T00:00:00Z', value.get('time', ''))):
                continue
            day = value['time'][1:11]
            date.fromisoformat(day)
            days.add(day)
        name = entity.get('labels', {}).get('en', {}).get('value')
        human = any(v.get('id') == 'Q5' for v in values('P31') if isinstance(v, dict))
        if (not human or not name or len(ids) != 1 or len(days) != 1
                or not isinstance(entity.get('lastrevid'), int)):
            held.append(entity['id'])
            continue
        profiles.append({'player_id': next(iter(ids)), 'date_of_birth': next(iter(days)),
            'evidence_name': name, 'source': 'wikidata', 'entity': entity['id'],
            'revision': entity['lastrevid'],
            'url': f"https://www.wikidata.org/w/index.php?oldid={entity['lastrevid']}"})
    unique_index(profiles, 'player_id')
    return profiles, held


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
        if profile.get('evidence_name') and history.name_key(profile['evidence_name']) not in accepted:
            return 'corroborating_name_not_in_existing_exact_aliases'
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
            *(['Resolve held identities; held does not mean the football relationship is false.']
              if any(d['status'] == 'held_for_identity_review' for d in decisions) else []),
            'Validate manager intervals, portraits and all four answer locales for the final chosen subset.',
            'Coverage is observed EPL history, not complete 1990–2012 or 1950–1989 coverage.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['fact-report', 'archive', 'crosscheck', 'profiles', 'out']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--retired-entities', type=Path,
                        help='Optional pinned Wikidata snapshot for missing retired-player profiles')
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
        profiles = list(csv.DictReader(handle))
    supplement = []
    held_entities = []
    if args.retired_entities:
        raw = args.retired_entities.read_bytes()
        if hashlib.sha256(raw).hexdigest() != RETIRED_ENTITIES_SHA256:
            raise ValueError('Expected the pinned retired-player entity snapshot')
        supplement, held_entities = retired_profiles(json.loads(raw))
        existing_ids = {p['player_id'] for p in profiles}
        if any(p['player_id'] in existing_ids for p in supplement):
            raise ValueError('A supplement cannot replace an existing modern profile')
        profiles.extend(supplement)
    result = review(report, archive, crosscheck, profiles, manifests)
    result['retiredIdentityEvidence'] = {'profiles': supplement, 'heldEntities': held_entities}
    result['inputSha256'] = {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [args.fact_report, args.archive, args.crosscheck, args.profiles, args.retired_entities] if p}
    with args.out.open('x') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps(result['summary']))


if __name__ == '__main__':
    main()
