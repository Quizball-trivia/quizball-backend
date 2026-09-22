#!/usr/bin/env python3
"""Prepare an additive, deliberately unpublishable historical answer draft."""
import argparse
import copy
import hashlib
import importlib.util
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

spec = importlib.util.spec_from_file_location('history', Path(__file__).with_name('audit-historical-coverage.py'))
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


def prepare(manifest, catalogs, report, timestamp):
    if report.get('status') != 'requires_review' or report.get('publishable') is not False:
        raise ValueError('Expected an unapproved historical fact report')
    results = [r for r in report['releases'] if r['releaseVersion'] == manifest['release']['version']]
    if len(results) != 1:
        raise ValueError('Expected exactly one matching historical release audit')
    candidate = copy.deepcopy(manifest)
    criteria = {c['key']: c for c in candidate['criteria']}
    players = {p['id']: p for p in candidate['players']}
    donor_players = {}
    donor_aliases = defaultdict(list)
    for catalog in catalogs:
        for player in catalog['players']:
            previous = donor_players.setdefault(player['id'], player)
            if history.name_key(previous['nameEn']) != history.name_key(player['nameEn']):
                raise ValueError('Conflicting donor player identity')
        for alias in catalog.get('aliases', []):
            if alias not in donor_aliases[alias['playerId']]:
                donor_aliases[alias['playerId']].append(alias)
    origins = {urlparse(p['imageAssetKey']).netloc for p in players.values()
               if p.get('imageAssetKey', '').startswith('http')}
    members = {(m['criterionKey'], m['playerId']) for m in candidate['memberships']}
    assets = set(candidate.get('assetCatalog', []))
    alias_key = lambda a: (a['playerId'], a['normalizedAlias'], a['locale'], a['aliasType'])
    alias_keys = {alias_key(a) for a in candidate.get('aliases', [])}
    summary = Counter()
    unresolved = []
    source_definitions = [('pssguy-epldata-history', report['source'], 'MIT declared by upstream'),
                          ('salimt-football-datasets-history', report['aggregateSource'], 'Reuse not established')]
    if report.get('officialManagerEvidence'):
        source_definitions.append(('quizball-official-manager-intervals',
            {'provider': 'Official club manager history', 'commit': report['officialManagerEvidence']['sha256']},
            'Factual service intervals with official club attribution'))
    for key, source, rights in source_definitions:
        if any(s['key'] == key for s in candidate['sources']):
            raise ValueError('Historical source already present; regenerate from the original input')
        candidate['sources'].append({'key': key, 'providerName': source['provider'],
            'datasetVersion': source['commit'], 'permittedUse': 'Research draft; review required before gameplay release',
            'databaseRightsStatus': 'pending_review', 'attributionRequirements': rights,
            'retentionRequirements': 'Preserve pinned source checksums and every fact witness',
            'approvalOwner': 'UNREVIEWED', 'approvedAt': timestamp})
    for fact in results[0]['proposedFacts']:
        key, pid = fact['criterionKey'], fact['playerId']
        criterion = criteria.get(key)
        if not criterion or criterion['family'] != fact['family'] or fact['family'] not in ['club', 'league', 'manager', 'teammate']:
            raise ValueError('Unknown or incompatible historical criterion')
        if fact.get('reviewStatus') != 'requires_review' or not fact.get('witnesses'):
            raise ValueError('Missing historical review status or witnesses')
        if (key, pid) in members:
            continue
        if pid not in players:
            donor = donor_players.get(pid)
            aliases = donor_aliases[pid]
            if not donor or not donor.get('nameKa') or any(not any(a['locale'] == loc and a['acceptancePolicy'] == 'exact'
                    for a in aliases) for loc in ['en', 'ka']):
                unresolved.append({'criterionKey': key, 'playerId': pid, 'reason': 'missing_bilingual_display_identity'})
                continue
            image = donor.get('imageAssetKey', '')
            if image.startswith('http') and urlparse(image).netloc not in origins:
                raise ValueError('Cross-environment portrait origin')
            if not image:
                unresolved.append({'criterionKey': key, 'playerId': pid, 'reason': 'missing_portrait_reference'})
                continue
            candidate['players'].append(copy.deepcopy(donor)); players[pid] = donor
            added_aliases = []
            for alias in aliases:
                key_alias = alias_key(alias)
                if key_alias not in alias_keys:
                    added_aliases.append(copy.deepcopy(alias)); alias_keys.add(key_alias)
            candidate['aliases'].extend(added_aliases); assets.add(image)
            summary['addedPlayers'] += 1; summary['addedAliases'] += len(added_aliases)
        accepted_names = {history.name_key(players[pid]['nameEn'])}
        accepted_names.update(history.name_key(a['alias']) for a in candidate['aliases']
                              if a['playerId'] == pid and a['locale'] == 'en' and a['acceptancePolicy'] == 'exact')
        if history.name_key(fact['name']) not in accepted_names:
            raise ValueError('Historical fact player identity differs from the display catalog')
        evidence = []
        for witness in fact['witnesses']:
            evidence.append({'sourceKey': 'pssguy-epldata-history',
                'sourceLocator': witness['sourceLocator'],
                'capturedFact': json.dumps({'criterionKey': key, 'archivePlayerId': fact['sourcePlayerId'],
                    'witness': witness}, ensure_ascii=False, sort_keys=True),
                'effectiveFrom': witness['date'], 'effectiveTo': witness['date'],
                'rightsClass': 'source-review-pending', 'reviewedBy': 'UNREVIEWED', 'reviewedAt': timestamp})
            count = witness['countCorroboration']
            evidence.append({'sourceKey': 'salimt-football-datasets-history',
                'sourceLocator': f"player_performances.csv:player_id={count['sourcePlayerId']};team_id={count['sourceClubId']};season_start={count['seasonStart']}",
                'capturedFact': json.dumps(count, sort_keys=True), 'effectiveFrom': None, 'effectiveTo': None,
                'rightsClass': 'source-review-pending', 'reviewedBy': 'UNREVIEWED', 'reviewedAt': timestamp})
            if witness.get('officialManagerEvidence'):
                official = witness['officialManagerEvidence']
                evidence.append({'sourceKey': 'quizball-official-manager-intervals',
                    'sourceLocator': official['sourceUrl'], 'capturedFact': official['fact'],
                    'effectiveFrom': witness['date'], 'effectiveTo': witness['date'],
                    'rightsClass': 'facts-with-attribution', 'reviewedBy': official['reviewedBy'],
                    'reviewedAt': timestamp})
        # Multiple appearance witnesses can cite the same season-count record.
        # Retain each distinct fact once, matching the database evidence key.
        evidence = list({json.dumps(row, sort_keys=True): row for row in evidence}.values())
        candidate['memberships'].append({'criterionKey': key, 'playerId': pid,
            'relationshipSubtype': criterion['subtype'], 'effectiveFrom': None, 'effectiveTo': None,
            'verifiedBy': 'UNREVIEWED', 'reviewedAt': timestamp, 'evidence': evidence})
        members.add((key, pid)); summary['addedFacts'] += 1; summary[f"added_{fact['family']}"] += 1
    by_criterion = defaultdict(set)
    for key, pid in members:
        by_criterion[key].add(pid)
    for criterion in candidate['criteria']:
        criterion.setdefault('metadata', {})['memberCount'] = len(by_criterion[criterion['key']])
    for board in candidate['boards']:
        changed = False
        for index, cell in enumerate(board['cells']):
            valid = by_criterion[board['rowCriteria'][index // 3]] & by_criterion[board['columnCriteria'][index % 3]]
            previous = set(cell['playerIds'])
            if previous - valid:
                raise ValueError('An existing answer is unsupported by the original membership intersection')
            additions = sorted(valid - previous)
            if any(pid not in players for pid in additions):
                raise ValueError('New answer has no display identity')
            if additions:
                cell['playerIds'].extend(additions); changed = True
                summary['changedCells'] += 1; summary['addedPlayerCellAnswers'] += len(additions)
        if changed:
            board['version'] += 1; board['approvedBy'] = 'UNREVIEWED'; summary['changedBoards'] += 1
    candidate['assetCatalog'] = sorted(assets)
    candidate['release']['approvedBy'] = 'UNREVIEWED'
    candidate['release']['relationshipSnapshot'].update(transform='historical-epl-draft-v1',
        coverageComplete=False, historicalSource=report['source']['commit'])
    return {'status': 'requires_review', 'publishable': False, 'sourceVersion': manifest['release']['version'],
        'summary': dict(summary), 'removedAnswers': 0, 'unresolvedFacts': unresolved, 'candidate': candidate,
        'blockers': ['Review cross-provider identities and source facts before approval.',
            'Source reuse, portraits, alias ambiguity, difficulty and staging rehearsal remain to be reviewed.',
            'Allocate fresh release versions and preserve quarantines before any publishing.',
            'No approval command supports this historical draft.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fact-report', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, action='append', required=True)
    parser.add_argument('--base-index', type=int, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    report = json.loads(args.fact_report.read_text())
    manifests = []
    for path in args.manifest:
        payload = path.read_bytes()
        if hashlib.sha256(payload).hexdigest() != report['inputSha256'].get(str(path)):
            raise ValueError('Manifest differs from the historical fact audit')
        data = json.loads(payload); manifests.append(data.get('candidate', data))
    if not 0 <= args.base_index < len(manifests):
        parser.error('Invalid base-index')
    timestamp = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    result = prepare(manifests[args.base_index], manifests, report, timestamp)
    result['factReportSha256'] = hashlib.sha256(args.fact_report.read_bytes()).hexdigest()
    result['inputSha256'] = report['inputSha256']
    with args.out.open('x') as output:
        json.dump(result, output, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps({'summary': result['summary'], 'unresolvedFacts': len(result['unresolvedFacts']),
                      'removedAnswers': result['removedAnswers']}))


if __name__ == '__main__':
    main()
