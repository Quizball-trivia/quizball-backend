#!/usr/bin/env python3
"""Validate the pinned 1992–2012 match archive and cross-check season aggregates.

Reads data only. It does not merge players by name, generate memberships, or
publish content. A player's birth country is never treated as nationality.
"""
import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

PINS = {
    'managers.rds': 'f3153b6d0f8ef1d09e49150fbb8d8e7c20dea0ade414088324f071cfcd559e99',
    'player_game.rds': 'ff397fa8a10de6fb7d2790a7b9669e9ac93fadcdebbb5121a891098b5c07bc0f',
    'player_team.rds': '4d17a3253b91c50393804bbf0082007caab754dbda5c2a01d4ded73daa9484df',
    'game_team.rds': '06252f18be3f0540eacf81216829ab9746531b006348c41124b1640b78ed64de',
    'manager_team.rds': 'f9fc7b68b605d2d439f3d003381b6daf99801e18d563683f00d72786a3015535',
    'players.rds': '3bb1fa39487a7cb7ca63d6bf1377322ae0bdd0603467040ac45539f0f5b83d8f',
    'games.rds': 'dfb29a3044a2edb62eca66a6187f0330f096f50cc78feaedbfc0d6d00f738661',
}
COMMIT = 'c61f77af99b6cc814e698909557e059768270dee'


def keyed(records, key):
    result = {}
    for row in records:
        if row[key] in result:
            raise ValueError(f'Duplicate {key}: {row[key]}')
        result[row[key]] = row
    return result


def played(row):
    # Unused substitutes and synthetic own-goal rows do not establish appearances.
    if row['start'] not in (True, False, 0, 1, None):
        raise ValueError('Invalid starter flag')
    return bool(row['start']) or int(row['time_on']) > 0


def audit(tables):
    all_games = keyed(tables['games'], 'game_id')
    games = {key: value for key, value in all_games.items()
             if '1992-07-01' <= str(value['game_date'])[:10] < '2012-07-01'}
    teams = keyed(tables['game_team'], 'team_game_id')
    stints = keyed(tables['player_team'], 'player_team_id')
    players = keyed(tables['players'], 'player_id')
    keyed(tables['player_game'], 'player_game_id')
    by_season = defaultdict(lambda: {'games': set(), 'players': set(), 'teams': set(), 'appearances': 0})
    sides = defaultdict(list)
    for row in teams.values():
        if row['game_id'] in games:
            sides[row['game_id']].append(row)
    bad_games = {game: 'invalid_home_away_sides' for game in games
                 if len(sides[game]) != 2 or {r['venue'] for r in sides[game]} != {'H', 'A'}
                 or len({r['team'] for r in sides[game]}) != 2}
    starter_counts = Counter()
    for row in tables['player_game']:
        side = teams.get(row['team_game_id'])
        if side and side['game_id'] in games and bool(row['start']):
            starter_counts[row['team_game_id']] += 1
    for game, game_sides in sides.items():
        if any(starter_counts[s['team_game_id']] != 11 for s in game_sides):
            bad_games[game] = 'starter_count_not_eleven_per_side'
    duplicate_player_games = Counter()
    for row in tables['player_game']:
        side, stint = teams.get(row['team_game_id']), stints.get(row['player_team_id'])
        if side and stint and side['game_id'] in games and played(row):
            duplicate_player_games[(side['game_id'], stint['player_id'])] += 1
    rejected, appearances = [], []
    for row in tables['player_game']:
        side = teams.get(row['team_game_id'])
        if not side:
            rejected.append({'sourcePlayerGameId': row['player_game_id'], 'reason': 'missing_team_game'})
            continue
        if side['game_id'] not in games:
            continue
        if not played(row):
            continue
        stint = stints.get(row['player_team_id'])
        reason = None
        if not stint:
            reason = 'missing_player_stint'
        elif stint['team'] != side['team']:
            reason = 'player_stint_team_mismatch'
        elif stint['player_id'] not in players:
            reason = 'missing_player_profile'
        elif stint['player_id'] == 'OWNGOAL':
            reason = 'synthetic_player'
        elif duplicate_player_games[(side['game_id'], stint['player_id'])] != 1:
            reason = 'duplicate_player_game'
        elif side['game_id'] in bad_games:
            reason = bad_games[side['game_id']]
        if reason:
            rejected.append({'sourcePlayerGameId': row['player_game_id'], 'reason': reason,
                             'gameId': side['game_id'], 'team': side['team'],
                             'stintTeam': stint.get('team') if stint else None})
            continue
        player = players[stint['player_id']]
        date = str(games[side['game_id']]['game_date'])[:10]
        year = int(date[:4]) - (int(date[5:7]) < 7)
        appearances.append({'sourcePlayerGameId': row['player_game_id'], 'gameId': side['game_id'],
                            'sourcePlayerId': stint['player_id'], 'name': ' '.join(
                                str(player.get(k) or '').strip() for k in ['first_name', 'last_name']).strip(),
                            'birthDate': str(player['birth_date'])[:10],
                            'team': side['team'], 'date': date, 'seasonStart': year})
        cell = by_season[year]
        cell['players'].add(stint['player_id']); cell['teams'].add(side['team']); cell['appearances'] += 1
    for game, record in games.items():
        date = str(record['game_date'])[:10]
        year = int(date[:4]) - (int(date[5:7]) < 7)
        by_season[year]['games'].add(game)
    seasons = []
    for year in range(1992, 2012):
        cell = by_season[year]; expected = 462 if year <= 1994 else 380
        seasons.append({'seasonStart': year, 'games': len(cell['games']), 'expectedCompletedGames': expected,
                        'fixtureCountMatches': len(cell['games']) == expected,
                        'players': len(cell['players']), 'teams': len(cell['teams']),
                        'acceptedAppearanceRecords': cell['appearances'],
                        'status': 'observed_not_certified_complete'})
    return {'status': 'requires_review', 'publishable': False, 'coverageComplete': False,
            'source': {'provider': 'pssguy/epldata', 'commit': COMMIT,
                       'url': 'https://github.com/pssguy/epldata', 'declaredLicense': 'MIT'},
            'summary': {'games': len(games), 'players': len({a['sourcePlayerId'] for a in appearances}),
                        'acceptedAppearanceRecords': len(appearances), 'quarantinedRecords': len(rejected),
                        'quarantinedGames': len(bad_games)},
            'seasons': seasons, 'rejected': rejected,
            'quarantinedGames': [{'gameId': game, 'reason': reason} for game, reason in sorted(bad_games.items())],
            'appearances': appearances,
            'limitations': ['Independent player/club identity mapping is still required.',
                            'Matching fixture counts do not certify every player appearance.',
                            'Manager, teammate, trophy and nationality facts are not produced.',
                            '1990/91 and 1991/92 were not Premier League seasons.']}


def main():
    import pyreadr
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--comparison', type=Path)
    args = parser.parse_args()
    tables = {}; hashes = {}
    for name, expected in PINS.items():
        file = args.raw / name
        with file.open('rb') as handle:
            hashes[name] = hashlib.file_digest(handle, 'sha256').hexdigest()
        if hashes[name] != expected:
            raise ValueError(f'Source checksum mismatch: {name}')
        frame = next(iter(pyreadr.read_r(str(file)).values()))
        tables[file.stem] = frame.astype(object).where(frame.notna(), None).to_dict('records')
    report = audit(tables)
    report['source']['sha256'] = hashes
    if args.comparison:
        other = json.loads(args.comparison.read_text())
        comparisons = {s['seasonStart']: s for s in other['seasons'] if s['competition'] == 'premier-league'}
        report['seasonComparison'] = [{'seasonStart': s['seasonStart'], 'matchArchivePlayers': s['players'],
                                      'aggregateSourcePlayers': comparisons[s['seasonStart']]['playerCount']}
                                     for s in report['seasons']]
        report['comparisonSha256'] = hashlib.sha256(args.comparison.read_bytes()).hexdigest()
    with args.out.open('x') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=1); handle.write('\n')
    print(json.dumps(report['summary']))


if __name__ == '__main__':
    main()
