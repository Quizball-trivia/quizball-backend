import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('review', Path(__file__).parents[2] /
    'scripts/football-grid-content-generator/review-epl-identity-witnesses.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IdentityWitnessTests(unittest.TestCase):
    def setUp(self):
        self.archive = {'source': {'commit': 'pinned'}, 'appearances': [
            {'sourcePlayerGameId': 1, 'sourcePlayerId': 'A', 'gameId': 10, 'date': '2001-09-01',
             'team': 'Arsenal', 'name': 'First Player', 'birthDate': '1970-01-01'},
            {'sourcePlayerGameId': 2, 'sourcePlayerId': 'B', 'gameId': 10, 'date': '2001-09-01',
             'team': 'Arsenal', 'name': 'Second Player', 'birthDate': '1971-01-01'}]}
        self.profiles = [{'player_id': '100', 'date_of_birth': '1970-01-01'},
                         {'player_id': '200', 'date_of_birth': '1971-01-01'}]
        self.crosscheck = {'identityCandidates': [
            {'archivePlayerId': 'A', 'sourcePlayerId': '100'},
            {'archivePlayerId': 'B', 'sourcePlayerId': '200'}]}
        self.manifest = {'players': [{'id': 'uuid-a', 'nameEn': 'First Player'},
                                     {'id': 'uuid-b', 'nameEn': 'Second Player'}],
            'memberships': [{'playerId': uid, 'evidence': [{'sourceKey': 'dcaribou-transfermarkt-datasets',
                'sourceLocator': f'player_id={pid}'}]} for uid, pid in [('uuid-a', '100'), ('uuid-b', '200')]]}
        fact = {'criterionKey': 'teammate:uuid-b', 'playerId': 'uuid-a', 'providerPlayerId': '100',
                'sourcePlayerId': 'A', 'birthDate': '1970-01-01', 'name': 'First Player', 'family': 'teammate',
                'firstWitnessDate': '2001-09-01', 'lastWitnessDate': '2001-09-01',
                'witnesses': [{'sourcePlayerGameId': 1, 'gameId': 10, 'date': '2001-09-01', 'team': 'Arsenal',
                               'teammatePlayerId': 'uuid-b', 'teammateSourcePlayerGameId': 2}]}
        self.report = {'source': {'commit': 'pinned'}, 'releases': [{'releaseVersion': 1, 'proposedFacts': [fact]}]}

    def run_review(self):
        return module.review(self.report, self.archive, self.crosscheck, self.profiles, [self.manifest])

    def test_matching_both_identities_does_not_approve_content_or_modify_input(self):
        before = copy.deepcopy(self.report)
        result = self.run_review()
        self.assertEqual(result['decisions'][0]['status'], 'identity_confirmed')
        self.assertFalse(result['publishable'])
        self.assertEqual(self.report, before)

    def test_birth_date_disagreement_holds_a_plausible_name_match(self):
        self.profiles[0]['date_of_birth'] = '1980-01-01'
        self.assertEqual(self.run_review()['decisions'][0]['reasons'], ['birth_date_disagreement'])

    def test_missing_teammate_profile_holds_the_relationship_too(self):
        self.profiles.pop()
        self.assertEqual(self.run_review()['decisions'][0]['reasons'], ['teammate_independent_profile_missing'])

    def test_same_match_opponent_is_never_a_teammate(self):
        self.archive['appearances'][1]['team'] = 'Chelsea'
        with self.assertRaisesRegex(ValueError, 'same club match'):
            self.run_review()

    def test_changed_witness_fails_instead_of_becoming_a_new_fact(self):
        self.report['releases'][0]['proposedFacts'][0]['witnesses'][0]['date'] = '2001-09-02'
        with self.assertRaisesRegex(ValueError, 'pinned appearance'):
            self.run_review()

    def test_mapping_to_a_different_uuid_is_not_accepted(self):
        self.manifest['memberships'][0]['playerId'] = 'uuid-unrelated'
        self.assertEqual(self.run_review()['decisions'][0]['reasons'], ['existing_uuid_mapping_not_confirmed'])

    def test_conflicting_duplicate_identity_cannot_overwrite_an_earlier_mapping(self):
        self.crosscheck['identityCandidates'].append({'archivePlayerId': 'A', 'sourcePlayerId': '999'})
        with self.assertRaisesRegex(ValueError, 'Conflicting duplicate archivePlayerId'):
            self.run_review()

    def test_conflicting_duplicate_appearance_is_rejected(self):
        row = dict(self.archive['appearances'][0], team='Chelsea')
        self.archive['appearances'].append(row)
        with self.assertRaisesRegex(ValueError, 'Conflicting duplicate sourcePlayerGameId'):
            self.run_review()


if __name__ == '__main__':
    unittest.main()
