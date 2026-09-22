import importlib.util
import ast
import json
import os
import re
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from pathlib import Path
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[2] / 'scripts/football-grid-content-generator/football-grid-fetch-legends.py'
spec = importlib.util.spec_from_file_location('historical_discovery', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def item(qid):
    return {'mainsnak': {'datavalue': {'value': {'id': qid}}}}


class HistoricalDiscoveryTests(unittest.TestCase):
    def test_discovery_is_rejected_before_generation_or_database_import(self):
        scripts = path.parent
        tree = ast.parse((scripts / 'football-grid-build-launch-manifest.py').read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'load_legends')
        namespace = dict(Path=Path, Player=SimpleNamespace, Legend=SimpleNamespace, json=json)
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<load_legends>', 'exec'), namespace)
        with tempfile.TemporaryDirectory() as directory:
            discovery = Path(directory) / 'discovery.json'
            for payload in [
                {'reviewStatus': 'requires_review', 'legends': []},
                {'legends': []},
                {'reviewStatus': 'approved', 'reviewedBy': ' ', 'legends': []},
                {'reviewStatus': 'approved', 'reviewedBy': 'reviewer', 'legends': [{}]},
            ]:
                with self.subTest(payload=payload):
                    discovery.write_text(json.dumps(payload))
                    with self.assertRaisesRegex(RuntimeError, 'requires explicit'):
                        namespace['load_legends'](discovery, {})
                    result = subprocess.run([sys.executable, str(scripts / 'football-grid-upsert-legends.py'), str(discovery), '--apply'],
                        env={**os.environ, 'DATABASE_URL': 'postgresql://invalid@127.0.0.1:1/invalid'}, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('requires explicit', result.stderr)

    def test_generator_keeps_classified_national_teams_out_of_clubs(self):
        tree = ast.parse((path.parent / 'football-grid-build-launch-manifest.py').read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'load_legends')
        namespace = dict(Path=Path, Player=SimpleNamespace, Legend=SimpleNamespace, json=json, sys=sys,
                         SENIOR_NATIONAL=re.compile('national', re.I),
                         NOT_SENIOR=re.compile(r'under-|u-?\d\d|\bB\b|women|olympic|amateur|youth|junior', re.I))
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<load_legends>', 'exec'), namespace)
        payload = {'reviewStatus': 'approved', 'reviewedBy': 'test-reviewer', 'legends': [
            {'reviewStatus': 'approved', 'transfermarktId': '1', 'name': 'Player', 'qid': 'Q1', 'teams': [
                {'qid': 'Q2', 'label': 'Example representative side', 'national': True},
                {'qid': 'Q3', 'label': 'Example under-21 side', 'national': True},
                {'qid': 'Q4', 'label': 'Actual Club', 'national': False, 'start': 1994, 'end': 1998},
            ]}]}
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'reviewed.json'
            source.write_text(json.dumps(payload))
            result = namespace['load_legends'](source, {1: SimpleNamespace(dataset_id=1)})[0]
        self.assertEqual(result.national_teams, ['Example representative side'])
        self.assertEqual(result.clubs, [('Q4', 'Actual Club', 1994, 1998)])

    def test_coaching_and_unknown_roles_are_held_out_of_playing_careers(self):
        for role in ['Q41583', 'unknown-role']:
            claim = {'qualifiers': {'P413': [{'datavalue': {'value': {'id': role}}}]}}
            self.assertEqual(module.playing_claim(claim), (False, 'non_player_or_unresolved_role'))
        self.assertEqual(module.playing_claim({'rank': 'deprecated'}), (False, 'deprecated_claim'))
        self.assertEqual(module.playing_claim({'qualifiers': {'P413': [{'datavalue': {'value': {'id': 'Q280658'}}}]}}), (True, None))
        self.assertEqual(module.playing_claim({}), (True, None)) # still a discovery requiring review

    def test_national_team_subclasses_are_recognised_and_cycles_are_bounded(self):
        module.national_class.cache_clear()
        entities = {'men': {'claims': {'P279': [item(module.NATIONAL_TEAM)]}},
                    'cycle': {'claims': {'P279': [item('cycle')]}}, 'club': {'claims': {}}}
        with patch.object(module, 'entity', side_effect=lambda qid: entities[qid]):
            self.assertTrue(module.national_class('men'))
            self.assertFalse(module.national_class('club'))
            self.assertFalse(module.national_class('cycle'))


if __name__ == '__main__':
    unittest.main()
