import copy
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'scripts/football-grid-content-generator'
spec = importlib.util.spec_from_file_location('draft', ROOT / 'prepare-epl-history-draft.py')
draft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(draft)


class EPLHistoryDraftTests(unittest.TestCase):
    def fixture(self):
        player = {'id': 'p', 'nameEn': 'Player', 'nameKa': 'მოთამაშე', 'imageAssetKey': '/portrait.webp'}
        manifest = {'release': {'version': 1, 'relationshipSnapshot': {}},
            'sources': [], 'players': [player], 'aliases': [], 'assetCatalog': ['/portrait.webp'],
            'criteria': [{'key': 'club:a', 'family': 'club', 'subtype': 'senior-club-appearance'},
                         {'key': 'league:a', 'family': 'league', 'subtype': 'league-appearance'}],
            'memberships': [{'criterionKey': 'club:a', 'playerId': 'p'}],
            'boards': [{'version': 1, 'rowCriteria': ['club:a'] * 3, 'columnCriteria': ['league:a'] * 3,
                        'cells': [{'playerIds': []} for _ in range(9)]}]}
        report = {'status': 'requires_review', 'publishable': False,
            'source': {'provider': 'epl', 'commit': 'epl-pin'},
            'aggregateSource': {'provider': 'aggregate', 'commit': 'aggregate-pin'},
            'releases': [{'releaseVersion': 1, 'proposedFacts': [{
                'criterionKey': 'league:a', 'family': 'league', 'playerId': 'p', 'name': 'Player',
                'sourcePlayerId': 'P', 'reviewStatus': 'requires_review', 'witnesses': [{
                    'sourceLocator': 'player_game.rds:player_game_id=1', 'date': '2000-01-01',
                    'countCorroboration': {'sourcePlayerId': '1', 'sourceClubId': '2',
                        'seasonStart': 1999, 'status': 'counts_agree'}}]}]}]}
        return manifest, report

    def test_adds_complete_intersections_without_inventing_release_approval(self):
        manifest, report = self.fixture()
        before = copy.deepcopy(manifest)
        result = draft.prepare(manifest, [], report, '2026-09-22T08:00:00Z')
        self.assertEqual(result['summary']['addedPlayerCellAnswers'], 9)
        self.assertEqual(result['removedAnswers'], 0)
        self.assertFalse(result['publishable'])
        self.assertEqual(result['candidate']['release']['approvedBy'], 'UNREVIEWED')
        self.assertTrue(all(s['databaseRightsStatus'] == 'pending_review' for s in result['candidate']['sources']))
        self.assertEqual(manifest, before)
        self.assertEqual(result['candidate']['memberships'][-1]['effectiveFrom'], None)

    def test_never_silently_drops_existing_accepted_players(self):
        manifest, report = self.fixture()
        manifest['boards'][0]['cells'][0]['playerIds'] = ['not-a-member']
        with self.assertRaisesRegex(ValueError, 'existing answer is unsupported'):
            draft.prepare(manifest, [], report, '2026-09-22T08:00:00Z')

    def test_official_manager_witness_keeps_attribution_without_approving_the_fact(self):
        manifest, report = self.fixture()
        official = {'sourceUrl': 'https://www.arsenal.com/example', 'fact': 'Verified service interval',
                    'reviewedBy': 'Source audit'}
        report['officialManagerEvidence'] = {'sha256': 'evidence-pin'}
        report['releases'][0]['proposedFacts'][0]['witnesses'][0]['officialManagerEvidence'] = official
        result = draft.prepare(manifest, [], report, '2026-09-22T08:00:00Z')
        member = result['candidate']['memberships'][-1]
        self.assertEqual(member['verifiedBy'], 'UNREVIEWED')
        self.assertEqual(member['evidence'][-1]['sourceLocator'], official['sourceUrl'])
        self.assertEqual(result['candidate']['sources'][-1]['datasetVersion'], 'evidence-pin')

    def test_repeated_season_corroboration_keeps_distinct_appearances_without_duplicate_evidence(self):
        manifest, report = self.fixture()
        witnesses = report['releases'][0]['proposedFacts'][0]['witnesses']
        second = copy.deepcopy(witnesses[0])
        second.update(sourceLocator='player_game.rds:player_game_id=2', date='2000-01-08')
        witnesses.append(second)
        result = draft.prepare(manifest, [], report, '2026-09-22T08:00:00Z')
        evidence = result['candidate']['memberships'][-1]['evidence']
        self.assertEqual(len(evidence), 3)
        self.assertEqual(sum(e['sourceKey'] == 'pssguy-epldata-history' for e in evidence), 2)
        self.assertEqual(sum(e['sourceKey'] == 'salimt-football-datasets-history' for e in evidence), 1)

    def test_missing_bilingual_identity_is_reported_and_not_added(self):
        manifest, report = self.fixture()
        manifest['players'] = []
        result = draft.prepare(manifest, [], report, '2026-09-22T08:00:00Z')
        self.assertEqual(result['unresolvedFacts'][0]['reason'], 'missing_bilingual_display_identity')
        self.assertEqual(result['summary'].get('addedFacts', 0), 0)

    def test_wrong_player_and_different_criterion_family_are_rejected(self):
        for field, value, message in [('name', 'Another person', 'identity differs'),
                                     ('family', 'country', 'incompatible historical criterion')]:
            manifest, report = self.fixture()
            report['releases'][0]['proposedFacts'][0][field] = value
            with self.assertRaisesRegex(ValueError, message):
                draft.prepare(manifest, [], report, '2026-09-22T08:00:00Z')


if __name__ == '__main__':
    unittest.main()
