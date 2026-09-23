#!/usr/bin/env python3
"""Discover 1950+ club careers and managers for Grid clues; never publish them.

Wikidata P54/P286 claims are leads. A positive appearance count and a precise
identity link make a better review candidate, but neither proves every Grid rule.
The output remains requires_review and contains no release manifest or DB writer.
"""
import argparse
import hashlib
import json
import re
import ssl
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

try:
    import certifi
except ImportError:
    certifi = None

ENDPOINT = 'https://query.wikidata.org/sparql'
USER_AGENT = 'QuizballGridHistory/1.0 (nika@quizball.io)'
CLUB_ID = re.compile(r'club_id=(\d+)')
PLAYER_ID = re.compile(r'player_id=(\d+)')
TEAM_QID = re.compile(r'P54=(Q\d+)')
QID = re.compile(r'Q\d+$')
CONTEXT = ssl.create_default_context(cafile=certifi.where() if certifi else None)


def request(query):
    url = ENDPOINT + '?' + urllib.parse.urlencode({'query': query, 'format': 'json'})
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': USER_AGENT, 'Accept': 'application/sparql-results+json',
            })
            with urllib.request.urlopen(req, timeout=75, context=CONTEXT) as response:
                payload = json.load(response)
                if (not isinstance(payload, dict)
                        or not isinstance(payload.get('results'), dict)
                        or not isinstance(payload['results'].get('bindings'), list)):
                    raise ValueError('Unexpected SPARQL response shape')
                return payload['results']['bindings']
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == 3:
                raise
            time.sleep(4 * (attempt + 1))


def val(row, key):
    return row.get(key, {}).get('value')


def qid(uri):
    value = uri.rsplit('/', 1)[-1] if uri else None
    return value if value and QID.fullmatch(value) else None


def year(value):
    if not value:
        return None
    match = re.match(r'^([+-]?\d{4})-', value)
    return int(match.group(1)) if match else None


def inventory(manifests):
    clubs = {}
    player_ids = defaultdict(set)
    for path in manifests:
        source = json.loads(path.read_text())
        for criterion in source['criteria']:
            if criterion['family'] == 'club':
                clubs.setdefault(criterion['key'], {
                    'label': criterion['labelEn'], 'transfermarktIds': set(), 'wikidataQids': set(),
                })
        for member in source['memberships']:
            for evidence in member['evidence']:
                locator = evidence['sourceLocator']
                player = PLAYER_ID.search(locator)
                if player:
                    player_ids[player.group(1)].add(member['playerId'])
                club = clubs.get(member['criterionKey'])
                if club:
                    team = CLUB_ID.search(locator)
                    wikidata = TEAM_QID.search(locator)
                    if team:
                        club['transfermarktIds'].add(team.group(1))
                    if wikidata:
                        club['wikidataQids'].add(wikidata.group(1))
    return clubs, player_ids


def mapped_clubs(clubs, transfermarkt_map):
    mapped, held = [], []
    for key, club in sorted(clubs.items()):
        tm = club['transfermarktIds']
        evidence_qids = club['wikidataQids']
        lookup_qids = set().union(*(transfermarkt_map.get(item, set()) for item in tm)) if tm else set()
        resolved = lookup_qids | evidence_qids
        row = {'key': key, 'label': club['label'], 'transfermarktIds': sorted(tm),
               'evidenceQids': sorted(evidence_qids), 'lookupQids': sorted(lookup_qids)}
        if len(tm) > 1 or len(evidence_qids) > 1 or len(lookup_qids) > 1 or len(resolved) != 1:
            held.append({**row, 'reason': 'missing_or_conflicting_club_identity'})
        else:
            mapped.append({**row, 'qid': next(iter(resolved)), 'identityBasis': 'pinned_provider_or_claim_id'})
    # The two source releases sometimes spell the same club key as club:foo
    # and club-foo. An exact label match to one pinned identity is a discovery
    # lead only; the result still requires review before any gameplay import.
    labels = defaultdict(set)
    for club in mapped:
        label = ' '.join(unicodedata.normalize('NFKC', club['label']).casefold().split())
        labels[label].add(club['qid'])
    remaining = []
    for club in held:
        if club['transfermarktIds'] or club['evidenceQids']:
            remaining.append(club)
            continue
        label = ' '.join(unicodedata.normalize('NFKC', club['label']).casefold().split())
        matches = labels.get(label, set())
        if len(matches) == 1:
            mapped.append({**club, 'qid': next(iter(matches)), 'identityBasis': 'exact_internal_label_review_candidate'})
        else:
            remaining.append(club)
    return mapped, remaining


def transfermarkt_lookup(ids):
    if not ids:
        return {}
    mapping = defaultdict(set)
    for start in range(0, len(ids), 30):
        batch = ids[start:start + 30]
        values = ' '.join(json.dumps(item) for item in batch)
        rows = request(f'SELECT ?club ?tm WHERE {{ VALUES ?tm {{ {values} }} ?club wdt:P7223 ?tm . }}')
        for row in rows:
            club = qid(val(row, 'club'))
            if club:
                mapping[val(row, 'tm')].add(club)
        time.sleep(1)
    return mapping


def career_query(club, first, last):
    return f'''SELECT ?player ?statement ?rank ?start ?end ?matches ?tm ?position ?role ?subjectRole WHERE {{
      ?player p:P54 ?statement . ?statement ps:P54 wd:{club} .
      ?statement wikibase:rank ?rank .
      OPTIONAL {{ ?statement pq:P580 ?start }}
      OPTIONAL {{ ?statement pq:P582 ?end }}
      OPTIONAL {{ ?statement pq:P1350 ?matches }}
      OPTIONAL {{ ?statement pq:P413 ?position }}
      OPTIONAL {{ ?statement pq:P3831 ?role }}
      OPTIONAL {{ ?statement pq:P2868 ?subjectRole }}
      OPTIONAL {{ ?player wdt:P2446 ?tm }}
      FILTER(!BOUND(?start) || ?start <= "{last}-12-31T23:59:59Z"^^xsd:dateTime)
      FILTER(!BOUND(?end) || ?end >= "{first}-01-01T00:00:00Z"^^xsd:dateTime)
    }}'''


def manager_query(club, first, last):
    return f'''SELECT ?manager ?statement ?rank ?start ?end WHERE {{
      wd:{club} p:P286 ?statement . ?statement ps:P286 ?manager .
      ?statement wikibase:rank ?rank .
      OPTIONAL {{ ?statement pq:P580 ?start }}
      OPTIONAL {{ ?statement pq:P582 ?end }}
      FILTER(!BOUND(?start) || ?start <= "{last}-12-31T23:59:59Z"^^xsd:dateTime)
      FILTER(!BOUND(?end) || ?end >= "{first}-01-01T00:00:00Z"^^xsd:dateTime)
    }}'''


def classify_career(row, first, last, player_ids):
    start, end = year(val(row, 'start')), year(val(row, 'end'))
    matches = val(row, 'matches')
    roles = [qid(val(row, key)) for key in ('position', 'role', 'subjectRole') if val(row, key)]
    tm = val(row, 'tm')
    uuids = sorted(player_ids.get(tm, set())) if tm else []
    reasons = []
    if val(row, 'rank') == 'http://wikiba.se/ontology#DeprecatedRank':
        reasons.append('deprecated_claim')
    if start is None or end is None:
        reasons.append('date_boundary_missing')
    elif start > last or end < first or end < start:
        reasons.append('outside_period_or_invalid_dates')
    if matches is None or not matches.isdigit() or int(matches) == 0:
        reasons.append('positive_senior_appearances_unproven')
    if roles:
        reasons.append('qualified_role_needs_review')
    if len(uuids) != 1:
        reasons.append('player_identity_unresolved')
    return {
        'playerQid': qid(val(row, 'player')), 'statement': val(row, 'statement'),
        'start': val(row, 'start'), 'end': val(row, 'end'), 'matches': matches,
        'transfermarktId': tm, 'existingPlayerIds': uuids, 'qualifiedRoles': roles,
        'reviewStatus': 'requires_review', 'reviewReasons': reasons,
    }


def scan(manifests, output, first, last, limit):
    if first < 1950 or last < first:
        raise ValueError('Expected 1950-or-later start and a valid final year')
    output.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(''.join(hashlib.sha256(p.read_bytes()).hexdigest() for p in manifests).encode()).hexdigest()
    config = {'inputSha256': digest, 'fromYear': first, 'throughYear': last,
              'source': 'Wikidata P54/P286/P7223/P2446, CC0', 'reviewStatus': 'requires_review'}
    config_file = output / 'configuration.json'
    if config_file.exists() and json.loads(config_file.read_text()) != config:
        raise ValueError('Output directory belongs to another input or date range')
    config_file.write_text(json.dumps(config, indent=2) + '\n')
    clubs, player_ids = inventory(manifests)
    lookup_file = output / 'club-id-lookup.json'
    if lookup_file.exists():
        lookup = {k: set(v) for k, v in json.loads(lookup_file.read_text()).items()}
    else:
        lookup = transfermarkt_lookup(sorted({v for club in clubs.values() for v in club['transfermarktIds']}))
        lookup_file.write_text(json.dumps({k: sorted(v) for k, v in lookup.items()}, indent=2) + '\n')
    mapped, held = mapped_clubs(clubs, lookup)
    by_qid = defaultdict(list)
    for club in mapped:
        by_qid[club['qid']].append(club)
    counts = Counter()
    linked_players_by_era = defaultdict(set)
    observed_players_by_era = defaultdict(set)
    manager_claims_by_era = Counter()
    eras = [('1950-1989', 1950, 1989), ('1990-2012', 1990, 2012), ('2013-2026', 2013, 2026)]
    discovered = []
    for club_qid in sorted(by_qid)[:limit or None]:
        file = output / f'club-{club_qid}.json'
        if file.exists():
            payload = json.loads(file.read_text())
        else:
            players = request(career_query(club_qid, first, last))
            time.sleep(1)
            managers = request(manager_query(club_qid, first, last))
            payload = {'clubQid': club_qid, 'fetchedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                       'careerRows': players, 'managerRows': managers, 'reviewStatus': 'requires_review'}
            file.write_text(json.dumps(payload, ensure_ascii=False) + '\n')
            time.sleep(1)
        if payload['clubQid'] != club_qid:
            raise ValueError(f'Cache identity mismatch for {club_qid}')
        careers = [classify_career(row, first, last, player_ids) for row in payload['careerRows']]
        counts['rawCareerRows'] += len(careers)
        counts['datedPositiveLinkedCareerRows'] += sum(not row['reviewReasons'] for row in careers)
        counts['rawManagerRows'] += len(payload['managerRows'])
        for career in careers:
            start, end = year(career['start']), year(career['end'])
            if start is None or end is None or end < start or not career['matches'] or not career['matches'].isdigit() or int(career['matches']) <= 0:
                continue
            if 'deprecated_claim' in career['reviewReasons'] or 'qualified_role_needs_review' in career['reviewReasons']:
                continue
            for name, era_start, era_end in eras:
                if start <= era_end and end >= era_start:
                    if career['playerQid']:
                        observed_players_by_era[name].add(career['playerQid'])
                    if not career['reviewReasons']:
                        linked_players_by_era[name].add(career['existingPlayerIds'][0])
        for manager in payload['managerRows']:
            start, end = year(val(manager, 'start')), year(val(manager, 'end'))
            if not start or not end or val(manager, 'rank') == 'http://wikiba.se/ontology#DeprecatedRank':
                continue
            for name, era_start, era_end in eras:
                if start <= era_end and end >= era_start:
                    manager_claims_by_era[name] += 1
        discovered.append({'clubQid': club_qid, 'gridClubKeys': [c['key'] for c in by_qid[club_qid]],
                           'careerStatements': len(careers), 'managerStatements': len(payload['managerRows']),
                           'candidateStatements': sum(not row['reviewReasons'] for row in careers),
                           'earliestDatedStart': min((year(r['start']) for r in careers if r['start']), default=None),
                           'reviewReasons': dict(Counter(reason for row in careers for reason in row['reviewReasons']))})
        print(f'{club_qid}: {len(careers)} careers, {len(payload["managerRows"])} managers, '
              f'{discovered[-1]["candidateStatements"]} linked review candidates', flush=True)
    summary = {'configuration': config, 'gridClubKeys': len(clubs), 'mappedClubKeys': len(mapped),
               'heldClubKeys': held, 'scannedUniqueClubs': len(discovered), 'counts': dict(counts),
               'datedPositivePlayerClaimsByEra': {name: len(observed_players_by_era[name]) for name, _, _ in eras},
               'linkedExistingPlayersByEra': {name: len(linked_players_by_era[name]) for name, _, _ in eras},
               'datedManagerClaimsByEra': {name: manager_claims_by_era[name] for name, _, _ in eras},
               'clubs': discovered, 'coverageComplete': False, 'publishable': False}
    (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(f'Wrote discovery summary: {output / "summary.json"}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, action='append', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--from-year', type=int, default=1950)
    parser.add_argument('--through-year', type=int, default=2026)
    parser.add_argument('--max-clubs', type=int, default=0)
    args = parser.parse_args()
    if args.max_clubs < 0:
        parser.error('--max-clubs must be nonnegative')
    scan(args.manifest, args.out, args.from_year, args.through_year, args.max_clubs)


if __name__ == '__main__':
    main()
