import importlib.util
import hashlib
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'scripts/football-grid-content-generator'


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


history = load('audit-historical-coverage')
epl = load('audit-epl-history')
fetcher = load('fetch-historical-sources')
crosscheck = load('crosscheck-epl-history')


class HistoricalCoverageTests(unittest.TestCase):
    def test_download_cache_refuses_a_changed_snapshot_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            cached = Path(directory) / 'source.csv'
            cached.write_bytes(b'original')
            digest = hashlib.sha256(b'original').hexdigest()
            self.assertEqual(fetcher.fetch('https://invalid.test', cached, digest), 'verified_cache')
            with self.assertRaisesRegex(ValueError, 'refusing to overwrite'):
                fetcher.fetch('https://invalid.test', cached, '0' * 64)
            self.assertEqual(cached.read_bytes(), b'original')

    def test_season_precision_and_century_boundary(self):
        self.assertEqual(history.season_start('99/00'), 1999)
        self.assertEqual(history.season_start('11/12'), 2011)
        self.assertEqual(history.season_start('1990'), 1990)
        self.assertIsNone(history.season_start('90/92'))
        self.assertIsNone(history.season_start('1990-ish'))

    def test_appearance_proposals_exclude_bench_earlier_leagues_and_identity_conflicts(self):
        manifest = {'release': {'version': 1}, 'criteria': [
            {'key': 'league:premier-league', 'family': 'league'}, {'key': 'club-example', 'family': 'club'},
            {'key': 'country:gb-eng', 'family': 'country'}],
            'players': [{'id': 'p1', 'nameEn': 'Correct Player'}, {'id': 'p2', 'nameEn': 'Another Player'}],
            'aliases': [], 'memberships': [
                {'playerId': 'p1', 'criterionKey': 'country:gb-eng', 'evidence': [
                    {'sourceKey': 'dcaribou-transfermarkt-datasets', 'sourceLocator': 'players.csv:player_id=1'}]},
                {'playerId': 'p2', 'criterionKey': 'club-example', 'evidence': [
                    {'sourceKey': 'dcaribou-transfermarkt-datasets', 'sourceLocator': 'appearances.csv:player_id=2;club_id=10'}]}]}
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory)
            (raw / 'player_profiles.csv').write_text('player_id,player_name,date_of_birth\n1,Correct Player (1),1970-01-01\n2,Wrong Identity (2),1971-01-01\n')
            (raw / 'player_performances.csv').write_text(
                'player_id,season_name,competition_id,team_id,nb_on_pitch\n'
                '1,90/91,GB1,10,30\n1,92/93,GB1,10,0\n1,93/94,GB1,10,1\n2,93/94,GB1,10,30\n')
            result = history.audit(raw, [manifest], verify_pins=False)
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                history.audit(raw, [manifest])
        proposals = result['releases'][0]['proposedFacts']
        self.assertEqual({(p['criterionKey'], p['playerId']) for p in proposals},
                         {('club-example', 'p1'), ('league:premier-league', 'p1')})
        self.assertTrue(all(w['season'] == '93/94' for p in proposals for w in p['witnesses']))
        self.assertFalse(result['publishable'])
        self.assertFalse(result['coverageComplete'])
        self.assertEqual(result['summary']['rejected']['premierLeagueBeforeInception'], 1)
        self.assertEqual(len(result['identityConflicts']), 1)

    def test_conflicting_season_records_are_not_used(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory)
            (raw / 'player_profiles.csv').write_text('player_id,player_name,date_of_birth\n1,Player (1),1970-01-01\n')
            (raw / 'player_performances.csv').write_text('player_id,season_name,competition_id,team_id,nb_on_pitch\n1,99/00,ES1,10,2\n1,99/00,ES1,10,3\n')
            result = history.audit(raw, [], verify_pins=False)
        self.assertEqual(result['summary']['positiveAppearanceRows'], 0)
        self.assertEqual(result['summary']['rejected']['conflictingSeasonRows'], 1)

    def test_provider_ids_cannot_cross_namespaces_or_conflict(self):
        def member(uuid, source):
            return {'playerId': uuid, 'evidence': [{'sourceKey': source, 'sourceLocator': 'players.csv:player_id=1'}]}
        self.assertEqual(history.identities([{'memberships': [member('a', 'other-provider')]}]), {})
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            history.identities([{'memberships': [member('a', 'dcaribou-transfermarkt-datasets'),
                                                member('b', 'dcaribou-transfermarkt-datasets')]}])

    def test_epl_quarantines_wrong_stint_without_making_up_a_player(self):
        tables = {'games': [{'game_id': 1, 'game_date': '1993-08-10'}],
                  'game_team': [{'team_game_id': 1, 'game_id': 1, 'team': 'Home', 'venue': 'H'},
                                {'team_game_id': 2, 'game_id': 1, 'team': 'Away', 'venue': 'A'}],
                  'players': [], 'player_team': [], 'player_game': []}
        for i in range(22):
            team = 'Home' if i < 11 else 'Away'
            tables['players'].append({'player_id': str(i), 'first_name': 'Player', 'last_name': str(i), 'birth_date': '1970-01-01'})
            tables['player_team'].append({'player_team_id': i, 'player_id': str(i), 'team': 'Wrong' if i == 0 else team})
            tables['player_game'].append({'player_game_id': i, 'player_team_id': i, 'team_game_id': 1 if i < 11 else 2, 'start': True, 'time_on': 0})
        result = epl.audit(tables)
        self.assertEqual(result['summary']['acceptedAppearanceRecords'], 21)
        self.assertEqual(result['rejected'][0]['reason'], 'player_stint_team_mismatch')
        self.assertFalse(epl.played({'start': False, 'time_on': 0}))
        self.assertTrue(epl.played({'start': False, 'time_on': 89}))
        with self.assertRaisesRegex(ValueError, 'starter flag'):
            epl.played({'start': 'False', 'time_on': 0})
        self.assertFalse(result['coverageComplete'])
        self.assertFalse(result['publishable'])
        tables['player_game'][0]['start'] = False
        result = epl.audit(tables)
        self.assertEqual(result['summary']['acceptedAppearanceRecords'], 0)
        self.assertEqual(result['summary']['quarantinedGames'], 1)

    def test_crosscheck_does_not_merge_names_without_a_unique_birth_date_identity(self):
        profiles = [
            {'player_id': '1', 'player_name': 'Common Name (1)', 'date_of_birth': '1970-01-01'},
            {'player_id': '2', 'player_name': 'Common Name (2)', 'date_of_birth': '1971-01-01'},
        ]
        appearance = {'sourcePlayerId': 'COMMON', 'name': 'Common Name', 'birthDate': '1970-01-01',
                      'team': 'Arsenal', 'seasonStart': 1993, 'gameId': 100}
        result = crosscheck.crosscheck(profiles, [appearance], [], [])
        self.assertEqual(result['identityCandidates'][0]['sourcePlayerId'], '1')
        self.assertTrue(result['noMappingsApplied'])
        self.assertFalse(result['publishable'])
        for birthday in ['', 'None', '1970-01-32', '1970']:
            with self.subTest(birthday=birthday):
                result = crosscheck.crosscheck(profiles, [{**appearance, 'birthDate': birthday}], [], [])
                self.assertEqual(result['summary']['uniqueIdentityCandidates'], 0)
        duplicate = {**profiles[0], 'player_id': '3'}
        duplicate['player_name'] = 'Common Name (3)'
        result = crosscheck.crosscheck(profiles + [duplicate], [appearance], [], [])
        self.assertEqual(result['summary']['uniqueIdentityCandidates'], 0)
        result = crosscheck.crosscheck(profiles, [appearance, {**appearance, 'sourcePlayerId': 'OTHER_ID'}], [], [])
        self.assertEqual(result['summary']['uniqueIdentityCandidates'], 0)

    def test_crosscheck_keeps_disagreeing_counts_out_of_corroborated_facts(self):
        profile = {'player_id': '1', 'player_name': 'Player (1)', 'date_of_birth': '1970-01-01'}
        appearance = {'sourcePlayerId': 'PLAYER', 'name': 'Player', 'birthDate': '1970-01-01',
                      'team': 'Arsenal', 'seasonStart': 1993, 'gameId': 100}
        aggregate = {'player_id': '1', 'team_id': '11', 'competition_id': 'GB1', 'season_name': '93/94', 'nb_on_pitch': '2'}
        releases = [{'releaseVersion': 1, 'proposedFacts': [
            {'criterionKey': 'league:premier-league', 'playerId': 'uuid', 'sourcePlayerId': '1', 'name': 'Player',
             'witnesses': [{'competitionId': 'GB1', 'teamId': '11', 'season': '93/94'}]}]}]
        result = crosscheck.crosscheck([profile], [appearance], [aggregate], releases)
        self.assertEqual(result['summary']['byComparison'], {'counts_differ': 1})
        self.assertEqual(result['releases'][0]['corroboratedFactCount'], 0)
        result = crosscheck.crosscheck([profile], [appearance, {**appearance, 'gameId': 101}], [aggregate], releases)
        self.assertEqual(result['summary']['byComparison'], {'counts_agree': 1})
        self.assertEqual(result['releases'][0]['corroboratedFactCount'], 1)
        conflict = {**aggregate, 'nb_on_pitch': '3'}
        result = crosscheck.crosscheck([profile], [appearance], [aggregate, conflict], releases)
        self.assertEqual(result['summary']['byComparison'], {'aggregate_conflict': 1})
        self.assertEqual(result['releases'][0]['corroboratedFactCount'], 0)


if __name__ == '__main__':
    unittest.main()
