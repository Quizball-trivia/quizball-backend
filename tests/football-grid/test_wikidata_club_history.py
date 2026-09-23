"""Keep historical discovery separate from answer acceptance."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[2] / 'scripts/football-grid-content-generator/fetch-wikidata-club-history.py'
spec = importlib.util.spec_from_file_location('wikidata_club_history', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def binding(value):
    return {'value': value}


class WikidataClubHistoryTest(unittest.TestCase):
    def test_exact_club_ids_are_required(self):
        clubs = {
            'club:arsenal': {'label': 'Arsenal', 'transfermarktIds': {'11'}, 'wikidataQids': {'Q9617'}},
            'club:old': {'label': 'Old club', 'transfermarktIds': set(), 'wikidataQids': set()},
            'club-arsenal': {'label': 'Arsenal', 'transfermarktIds': set(), 'wikidataQids': set()},
            'club:conflict': {'label': 'Conflict', 'transfermarktIds': {'5'}, 'wikidataQids': {'Q1543'}},
        }
        mapped, held = module.mapped_clubs(clubs, {'11': {'Q9617'}, '5': {'Q999'}})
        self.assertEqual({row['key'] for row in mapped}, {'club:arsenal', 'club-arsenal'})
        self.assertEqual(next(row['identityBasis'] for row in mapped if row['key'] == 'club-arsenal'),
                         'exact_internal_label_review_candidate')
        self.assertEqual({row['key'] for row in held}, {'club:old', 'club:conflict'})

    def test_undated_or_unlinked_careers_are_not_ready(self):
        row = {'player': binding('http://www.wikidata.org/entity/Q123'),
               'statement': binding('http://www.wikidata.org/entity/statement/Q123-abc'),
               'rank': binding('http://wikiba.se/ontology#NormalRank'),
               'start': binding('1975-01-01T00:00:00Z'),
               'end': binding('1980-01-01T00:00:00Z'),
               'matches': binding('123'), 'tm': binding('77')}
        candidate = module.classify_career(row, 1950, 2026, {'77': {'uuid-a'}})
        self.assertEqual(candidate['reviewReasons'], [])
        self.assertEqual(candidate['reviewStatus'], 'requires_review')
        self.assertEqual(candidate['existingPlayerIds'], ['uuid-a'])
        missing = module.classify_career({**row, 'end': {}, 'matches': {}, 'tm': {}}, 1950, 2026, {})
        self.assertIn('date_boundary_missing', missing['reviewReasons'])
        self.assertIn('positive_senior_appearances_unproven', missing['reviewReasons'])
        self.assertIn('player_identity_unresolved', missing['reviewReasons'])

    def test_inventory_uses_evidence_ids_and_holds_conflicts(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'manifest.json'
            file.write_text(json.dumps({
                'criteria': [{'key': 'club:arsenal', 'family': 'club', 'labelEn': 'Arsenal'}],
                'memberships': [
                    {'criterionKey': 'club:arsenal', 'playerId': 'uuid-a', 'evidence': [
                        {'sourceLocator': 'appearances.csv:player_id=77;club_id=11'},
                        {'sourceLocator': 'wikidata:Q123#P54=Q9617'},
                    ]},
                ],
            }))
            clubs, players = module.inventory([file])
            self.assertEqual(clubs['club:arsenal']['transfermarktIds'], {'11'})
            self.assertEqual(clubs['club:arsenal']['wikidataQids'], {'Q9617'})
            self.assertEqual(players['77'], {'uuid-a'})


if __name__ == '__main__':
    unittest.main()
