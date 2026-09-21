"""Offline source audit: exclude national teammates and reject uncertain joins."""
import csv
import gzip
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

path = Path(__file__).resolve().parents[2] / 'scripts/football-grid-content-generator/audit-source-coverage.py'
spec = importlib.util.spec_from_file_location('coverage_audit', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SourceCoverageTests(unittest.TestCase):
    def test_national_only_overlap_never_becomes_club_teammate_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = {
                'players': [['player_id'], [1], [2]],
                'clubs': [['club_id'], [10]],
                'competitions': [['competition_id', 'type'], ['GB1', 'domestic_league'], ['EURO', 'national_team_competition']],
                'appearances': [['player_id', 'game_id', 'player_club_id', 'competition_id', 'date'],
                    [1, 100, 99, 'EURO', '2020-06-01'], [2, 100, 99, 'EURO', '2020-06-01'],
                    [1, 101, 10, 'GB1', '2020-05-01'], [2, 102, 10, 'GB1', '2020-05-02']],
                'games': [['game_id', 'home_club_id', 'away_club_id', 'home_club_manager_name', 'away_club_manager_name', 'season', 'date', 'competition_id', 'round', 'home_club_goals', 'away_club_goals'],
                    [100, 99, 98, 'Manager A', 'Manager B', 2020, '2020-06-01', 'EURO', 'Group', 1, 0],
                    [101, 10, 20, 'Manager A', 'Manager B', 2020, '2020-05-01', 'GB1', 'League', 1, 0],
                    [102, 10, 20, 'Manager A', 'Manager B', 2020, '2020-05-02', 'GB1', 'League', 1, 0]],
            }
            checksums = root / 'checksums'
            hashes = []
            for name, rows in data.items():
                file = root / f'{name}.csv.gz'
                with gzip.open(file, 'wt') as output:
                    csv.writer(output).writerows(rows)
                hashes.append(f'{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}')
            checksums.write_text('\n'.join(hashes))
            manifest = dict(release={'version': 1}, players=[{'id': 'a'}, {'id': 'b'}], boards=[],
                criteria=[{'key': 'club:x', 'family': 'club'}, {'key': 'teammate:a', 'family': 'teammate'}, {'key': 'league:premier-league', 'family': 'league'}],
                memberships=[dict(playerId=uuid, criterionKey='club:x', evidence=[dict(sourceKey='dcaribou-transfermarkt-datasets', sourceLocator=f'appearances.csv:player_id={pid};club_id=10')]) for uuid, pid in [('a', 1), ('b', 2)]])
            report = module.audit(root, [manifest], checksums)
            proposed = report['releases'][0]['proposedFacts']
            self.assertFalse(any(f['family'] == 'teammate' for f in proposed))
            self.assertEqual(sum(f['family'] == 'league' for f in proposed), 2)
            self.assertFalse(report['coverageComplete'])
            self.assertEqual(report['eras'][0]['status'], 'no_appearance_source')
            checksums.write_text('0' * 64 + '  appearances.csv.gz')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                module.audit(root, [manifest], checksums)

    def test_conflicting_identity_ids_are_never_guessed(self):
        manifest = {'memberships': [dict(playerId='a', criterionKey='club:x', evidence=[dict(
            sourceKey='dcaribou-transfermarkt-datasets', sourceLocator=f'players.csv:player_id={pid}')]) for pid in [1, 2]]}
        with self.assertRaisesRegex(ValueError, 'Ambiguous source identities'):
            module.identity_maps([manifest])


if __name__ == '__main__':
    unittest.main()
