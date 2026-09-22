"""Exercise the generator's pure alias functions without its DB/DuckDB dependencies."""
import ast
from collections import defaultdict
from pathlib import Path
import re
from types import SimpleNamespace
import unicodedata
import unittest

path = Path(__file__).resolve().parents[2] / 'scripts/football-grid-content-generator/football-grid-build-launch-manifest.py'
tree = ast.parse(path.read_text())
pure = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in {'answer_key', 'build_aliases'}]
namespace = dict(defaultdict=defaultdict, re=re, unicodedata=unicodedata, Player=SimpleNamespace, Any=object)
exec(compile(ast.Module(body=pure, type_ignores=[]), str(path), 'exec'), namespace)


class GeneratorSurnameTests(unittest.TestCase):
    def test_shared_surnames_are_retained_for_every_owner(self):
        players = [SimpleNamespace(uuid=str(i), name_en=en, name_ka=ka, accepted_aliases=set())
                   for i, (en, ka) in enumerate([
                       ('Kylian Mbappé', 'კილიან მბაპე'), ('Ethan Mbappé', 'ეთან მბაპე'),
                       ('Thomas Müller', 'თომას მიულერი'), ('Gerd Müller', 'გერდ მიულერი'),
                       ('Thomas Smith', 'თომას სმიტი'),
                   ])]
        aliases = namespace['build_aliases'](players, '2026-09-21T19:00:00.000Z')
        family = [a for a in aliases if a['aliasType'] == 'family_name']
        self.assertEqual({a['playerId'] for a in family if a['normalizedAlias'] == 'mbappe'}, {'0', '1'})
        self.assertEqual({a['playerId'] for a in family if a['normalizedAlias'] == 'muller'}, {'2', '3'})
        self.assertTrue(all(a['acceptancePolicy'] == 'unique_only' for a in family))
        self.assertFalse(any(a['aliasType'] == 'given_name' and a['normalizedAlias'] == 'thomas' for a in aliases))
        self.assertEqual(len([a for a in aliases if a['acceptancePolicy'] == 'exact']), 10)


if __name__ == '__main__':
    unittest.main()
