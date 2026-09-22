import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'scripts/football-grid-content-generator'
spec = importlib.util.spec_from_file_location('facts', ROOT / 'derive-epl-history-facts.py')
facts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(facts)


class EPLHistoryFactTests(unittest.TestCase):
    def fixture(self):
        manifest = {'release': {'version': 1}, 'criteria': [
            {'key': 'club:arsenal', 'family': 'club'},
            {'key': 'league:premier-league', 'family': 'league'},
            {'key': 'manager:arsene-wenger', 'family': 'manager', 'labelEn': 'Arsène Wenger'},
            {'key': 'teammate:p2', 'family': 'teammate'},
            {'key': 'country:france', 'family': 'country'},
            {'key': 'trophy:league', 'family': 'trophy_award'}],
            'players': [{'id': 'p1', 'nameEn': 'Player One'}, {'id': 'p2', 'nameEn': 'Player Two'}],
            'aliases': [], 'memberships': [
                {'criterionKey': 'club:arsenal', 'playerId': 'p2', 'evidence': [{
                    'sourceKey': 'dcaribou-transfermarkt-datasets',
                    'sourceLocator': 'appearances.csv:player_id=2;club_id=11'}]},
                {'criterionKey': 'country:france', 'playerId': 'p1', 'evidence': [{
                    'sourceKey': 'dcaribou-transfermarkt-datasets',
                    'sourceLocator': 'players.csv:player_id=1'}]}]}
        archive = {'source': {'provider': 'fixture', 'commit': 'fixture-commit'}, 'appearances': [
            {'sourcePlayerId': 'A', 'name': 'Player One', 'birthDate': '1970-01-01',
             'gameId': 100, 'sourcePlayerGameId': 1, 'team': 'Arsenal',
             'seasonStart': 2000, 'date': '2000-08-10'},
            {'sourcePlayerId': 'B', 'name': 'Player Two', 'birthDate': '1971-01-01',
             'gameId': 100, 'sourcePlayerGameId': 2, 'team': 'Arsenal',
             'seasonStart': 2000, 'date': '2000-08-10'}]}
        comparison = {'identityCandidates': [
            {'archivePlayerId': 'A', 'sourcePlayerId': '1', 'name': 'Player One'},
            {'archivePlayerId': 'B', 'sourcePlayerId': '2', 'name': 'Player Two'}],
            'comparisons': [{'sourcePlayerId': str(i), 'sourceClubId': '11',
                             'seasonStart': 2000, 'status': 'counts_agree', 'archiveAppearances': 1,
                             'aggregateAppearances': [1]} for i in [1, 2]]}
        managers = [{'manager_id': 'W', 'manager_name': 'Arsene Wenger'}]
        stints = [{'manager_team_id': 1, 'manager_id': 'W', 'team': 'Arsenal',
                   'manager_joined': '1996-10-01', 'manager_left': '2018-06-30'}]
        return archive, comparison, managers, stints, [manifest]

    def pairs(self, result):
        return {(f['criterionKey'], f['playerId']) for f in result['releases'][0]['proposedFacts']}

    def test_derives_witnessed_facts_without_inventing_trophies_or_overwriting_memberships(self):
        result = facts.derive(*self.fixture())
        self.assertEqual(self.pairs(result), {
            ('club:arsenal', 'p1'), ('league:premier-league', 'p1'),
            ('league:premier-league', 'p2'), ('manager:arsene-wenger', 'p1'),
            ('manager:arsene-wenger', 'p2'), ('teammate:p2', 'p1')})
        self.assertFalse(result['coverageComplete'])
        self.assertFalse(result['publishable'])
        self.assertTrue(result['noMappingsApplied'])
        for f in result['releases'][0]['proposedFacts']:
            self.assertEqual(f['reviewStatus'], 'requires_review')
            self.assertEqual(f['witnessGameCount'], 1)

    def test_missing_identity_and_conflicting_count_cannot_generate_facts(self):
        args = self.fixture()
        args[1]['comparisons'][0]['status'] = 'counts_differ'
        result = facts.derive(*args)
        self.assertTrue(all(p != 'p1' for _, p in self.pairs(result)))
        self.assertFalse(any(k.startswith('teammate:') for k, _ in self.pairs(result)))
        args[1]['identityCandidates'][1]['name'] = 'Different Player'
        self.assertEqual(self.pairs(facts.derive(*args)), set())

    def test_opponents_and_different_matches_are_not_club_teammates(self):
        for field, value in [('gameId', 101), ('team', 'Chelsea')]:
            args = self.fixture()
            args[0]['appearances'][1][field] = value
            if field == 'team':
                args[1]['comparisons'][1]['sourceClubId'] = '631'
            self.assertNotIn(('teammate:p2', 'p1'), self.pairs(facts.derive(*args)))

    def test_manager_transition_unknown_dates_and_overlapping_stints_are_not_guessed(self):
        for start, end in [('2000-08-10', '2018-06-30'), ('1996-10-01', '2000-08-10'),
                           (None, '2018-06-30'), ('1996-10-01', None),
                           ('1996-02-31', '2018-06-30')]:
            args = self.fixture()
            args[3][0].update(manager_joined=start, manager_left=end)
            self.assertFalse(any(k.startswith('manager:') for k, _ in self.pairs(facts.derive(*args))))
        args = self.fixture()
        args[3].append({**args[3][0], 'manager_team_id': 2})
        self.assertFalse(any(k.startswith('manager:') for k, _ in self.pairs(facts.derive(*args))))

    def test_witness_bounds_are_recorded_and_samples_do_not_limit_qualifying_facts(self):
        args = self.fixture()
        original = args[0]['appearances'][0]
        for n in range(1, 6):
            args[0]['appearances'].append({**original, 'gameId': 100 + n,
                                          'sourcePlayerGameId': 10 + n, 'date': f'2000-08-{10+n:02}'})
        result = facts.derive(*args)
        row = next(f for f in result['releases'][0]['proposedFacts'] if f['criterionKey'] == 'club:arsenal')
        self.assertEqual(row['witnessGameCount'], 6)
        self.assertEqual(len(row['witnesses']), 3)
        self.assertEqual((row['firstWitnessDate'], row['lastWitnessDate']), ('2000-08-10', '2000-08-15'))

    def test_official_bounded_service_evidence_can_resolve_an_undated_archive_endpoint(self):
        args = self.fixture()
        args[3][0]['manager_left'] = None
        interval = {'managerId': 'W', 'archiveStintId': 1, 'club': 'Arsenal',
                    'fromExclusive': '1996-10-01', 'throughExclusive': '2013-10-01',
                    'sourceUrl': 'https://www.arsenal.com/example', 'fact': 'Official service interval'}
        result = facts.derive(*args, [interval])
        self.assertIn(('manager:arsene-wenger', 'p1'), self.pairs(result))
        manager = next(f for f in result['releases'][0]['proposedFacts'] if f['family'] == 'manager')
        self.assertEqual(manager['witnesses'][0]['officialManagerEvidence'], interval)
        interval['throughExclusive'] = '2000-08-10'
        self.assertFalse(any(k.startswith('manager:') for k, _ in self.pairs(facts.derive(*args, [interval]))))
        interval['club'] = 'Another club'
        with self.assertRaisesRegex(ValueError, 'conflicts with archive identity'):
            facts.derive(*args, [interval])

    def test_official_manager_evidence_cannot_silently_miss_or_reverse_a_stint(self):
        for change, message in [({'archiveStintId': 999}, 'no matching archive stint'),
                                ({'throughExclusive': '1990-01-01'}, 'Invalid official manager interval'),
                                ({'fromExclusive': 'invalid'}, 'Invalid official manager interval')]:
            interval = {'managerId': 'W', 'archiveStintId': 1, 'club': 'Arsenal',
                        'fromExclusive': '1996-10-01', 'throughExclusive': '2013-10-01', **change}
            with self.assertRaisesRegex(ValueError, message):
                facts.derive(*self.fixture(), [interval])


if __name__ == '__main__':
    unittest.main()
