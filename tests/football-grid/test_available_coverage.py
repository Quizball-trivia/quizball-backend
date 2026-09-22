import csv
import gzip
import importlib.util
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'scripts/football-grid-content-generator'
spec = importlib.util.spec_from_file_location('available', ROOT / 'audit-available-coverage.py')
available = importlib.util.module_from_spec(spec)
spec.loader.exec_module(available)


class AvailableCoverageTests(unittest.TestCase):
    def test_scope_preserves_club_aliases_and_exposes_unmapped_clubs(self):
        manifest = {'criteria': [
            {'key': 'club:a', 'family': 'club'}, {'key': 'club-a', 'family': 'club'},
            {'key': 'club:missing', 'family': 'club'}, {'key': 'league:la-liga', 'family': 'league'}],
            'memberships': [{'criterionKey': key, 'evidence': [{
                'sourceKey': 'dcaribou-transfermarkt-datasets', 'sourceLocator': 'appearances.csv:club_id=1'}]}
                for key in ['club:a', 'club-a']]}
        criteria, mapping, leagues = available.scope([manifest])
        self.assertEqual(len(criteria), 4)
        self.assertEqual(mapping, {'club:a': {'1'}, 'club-a': {'1'}})
        self.assertEqual(leagues, {'ES1': 'la-liga'})
        manifest['memberships'].append({'criterionKey': 'club:a', 'evidence': [{
            'sourceKey': 'dcaribou-transfermarkt-datasets', 'sourceLocator': 'appearances.csv:club_id=2'}]})
        with self.assertRaisesRegex(ValueError, 'Conflicting source IDs'):
            available.scope([manifest])

    def test_old_and_modern_seasons_are_included_but_bad_counts_are_not(self):
        def row(pid, season, count='1', club='10', competition='ES1'):
            return {'player_id': pid, 'season_name': season, 'nb_on_pitch': count,
                    'team_id': club, 'team_name': 'Example', 'competition_id': competition}
        records = [row('1', '50/51'), row('2', '90/91'), row('3', '25/26'), row('4', '26/27'),
                   row('5', '90/91', '0'), row('6', '90/91', '2'), row('6', '90/91', '3'),
                   row('7', '90/91', club='99', competition='OTHER'),
                   row('8', '90/91', competition='GB1'), row('9', 'bad')]
        selected, rejected, names = available.collect_aggregate(enumerate(records, 2), 1950,
            date(2026, 8, 31), {'ES1': 'la-liga', 'GB1': 'premier-league'}, {'10'})
        self.assertEqual({r['playerId'] for r in selected}, {'1', '2', '3', '4'})
        self.assertEqual([r['playerId'] for r in selected if r['cutoffBoundary']], ['4'])
        self.assertEqual(rejected['conflicting_player_club_seasons'], 1)
        self.assertEqual(rejected['premier_league_before_inception'], 1)
        self.assertEqual(names['example'], {'10', '99'})

    def test_club_history_in_other_competitions_remains_visible(self):
        row = {'player_id': '1', 'season_name': '95/96', 'nb_on_pitch': '1',
               'team_id': '10', 'competition_id': 'OTHER'}
        selected, _, _ = available.collect_aggregate([(2, row)], 1950, date(2026, 8, 31), {}, {'10'})
        self.assertEqual(len(selected), 1)

    def test_dated_cutoff_includes_august_31_and_excludes_september(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            games = [{'game_id': '1', 'competition_id': 'ES1', 'season': '2026'},
                     {'game_id': '2', 'competition_id': 'ES1', 'season': '2026'}]
            appearances = [{'player_id': '10', 'player_club_id': '20', 'game_id': '1',
                            'competition_id': 'ES1', 'date': '2026-08-31', 'appearance_id': 'a'},
                           {'player_id': '11', 'player_club_id': '20', 'game_id': '2',
                            'competition_id': 'ES1', 'date': '2026-09-01', 'appearance_id': 'b'}]
            for name, rows in [('games', games), ('appearances', appearances)]:
                with gzip.open(root / (name + '.csv.gz'), 'wt') as handle:
                    writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
                    writer.writeheader(); writer.writerows(rows)
            result = list(available.modern_records(root, 1950, date(2026, 8, 31)))
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]['date'], '2026-08-31')
            games[0]['competition_id'] = 'WRONG'
            with gzip.open(root / 'games.csv.gz', 'wt') as handle:
                writer = csv.DictWriter(handle, fieldnames=list(games[0]))
                writer.writeheader(); writer.writerows(games)
            with self.assertRaisesRegex(ValueError, 'Unresolved appearance/game join'):
                list(available.modern_records(root, 1950, date(2026, 8, 31)))


if __name__ == '__main__':
    unittest.main()
