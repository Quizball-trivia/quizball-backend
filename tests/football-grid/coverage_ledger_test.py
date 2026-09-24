import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/football-grid-content-generator/football-grid-coverage-ledger.py"
SPEC = importlib.util.spec_from_file_location("football_grid_coverage_ledger", SCRIPT)
ledger = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledger)


def sample_manifest():
    return {
        "release": {"version": 2026092301},
        "criteria": [
            {"key": "club:alpha", "family": "club", "subtype": "senior-club-appearance", "labelEn": "Alpha"},
            {"key": "country:ge", "family": "country", "subtype": "nationality", "labelEn": "Georgia"},
            {"key": "club:beta", "family": "club", "subtype": "senior-club-appearance", "labelEn": "Beta"},
        ],
        "players": [
            {"id": "one", "nameEn": "Player One", "nameKa": "ფეხბურთელი ერთი"},
            {"id": "two", "nameEn": "Player Two"},
        ],
        "memberships": [
            {"criterionKey": "club:alpha", "playerId": "one"},
            {"criterionKey": "country:ge", "playerId": "one"},
            {"criterionKey": "club:beta", "playerId": "two"},
        ],
        "aliases": [
            {"playerId": "one", "normalizedAlias": "player one"},
            {"playerId": "two", "normalizedAlias": "player two"},
        ],
        "boards": [{
            "key": "board:test", "rowCriteria": ["club:alpha"] * 3,
            "columnCriteria": ["country:ge", "club:beta", "club:alpha"],
            "cells": [{"playerIds": ["one"]}, {"playerIds": []}, {"playerIds": ["one"]}] * 3,
        }],
    }


class CoverageLedgerTest(unittest.TestCase):
    def test_inventory_and_held_identity_prioritization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            discovery = root / "discovery.json"
            manifest.write_text(json.dumps(sample_manifest()), encoding="utf-8")
            discovery.write_text(json.dumps({"heldClubKeys": [{"key": "club-alpha"}]}), encoding="utf-8")
            summary = ledger.run([f"european={manifest}"], discovery, None, root / "out")
            self.assertEqual(summary["combined"]["distinctPairs"], 3)
            self.assertEqual(summary["combined"]["cellPlacements"], 9)
            self.assertEqual(summary["combined"]["criteriaUsedInStoredBoards"], 3)
            self.assertEqual(summary["combined"]["clubSeasonRowsForReview"], 154)
            self.assertEqual(summary["discovery"]["matchedHeldClubKeys"], 1)
            self.assertEqual(summary["discovery"]["unmatchedHeldKeys"], [])
            self.assertEqual(summary["discovery"]["heldClubKeysUsedInStoredBoards"], 1)
            self.assertEqual(summary["discovery"]["topHeldClubsByCellPlacements"][0]["cell_placements"], 9)
            self.assertEqual(len((root / "out" / "pairs.csv").read_text().splitlines()), 4)

    def test_reports_sort_into_actionable_review_categories(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(sample_manifest()), encoding="utf-8")
            pack = ledger.load_manifest("european", path)
            base = {"board_theme": "european", "row_criterion_key": "club:alpha",
                    "column_criterion_key": "country:ge", "outcome": "wrong"}
            examples = [
                ("player one", "accepted_in_current_release"),
                ("player two", "football_fact_review"),
                ("mystery person", "player_or_spelling_research"),
            ]
            for name, expected in examples:
                result = ledger.triage_report({**base, "submitted_text": name}, {"european": pack})
                self.assertEqual(result["triage"], expected)
            self.assertEqual(
                ledger.triage_report({**base, "submitted_text": "ფეხბურთელი ერთი"}, {"european": pack})["triage"],
                "name_alias_review",
            )
            self.assertEqual(
                ledger.triage_report({**base, "submitted_text": "ერთი"}, {"european": pack})["triage"],
                "name_alias_review",
            )
            self.assertEqual(
                ledger.triage_report({"submitted_text": "Player One"}, {"european": pack})["triage"],
                "missing_context",
            )
            reports = Path(directory) / "reports.json"
            reports.write_text(json.dumps({"reports": [
                {**base, "id": "report-one", "submitted_text": "ფეხბურთელი ერთი"},
                {**base, "id": "report-two", "submitted_text": "Player Two"},
            ]}), encoding="utf-8")
            out = Path(directory) / "out"
            ledger.run([f"european={path}"], None, reports, out)
            self.assertEqual(json.loads((out / "alias-proposals.json").read_text(encoding="utf-8"))[0]["playerId"], "one")
            self.assertEqual(json.loads((out / "fact-review-candidates.json").read_text(encoding="utf-8"))[0]["playerId"], "two")

    def test_detects_different_answers_even_when_repeated_cells_have_the_same_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = sample_manifest()
            manifest["boards"][0]["cells"][3] = {"playerIds": ["two"]}
            path = root / "manifest.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            summary = ledger.run([f"european={path}"], None, None, root / "out")
            self.assertEqual(summary["combined"]["repeatedCellDisagreements"], 1)
            self.assertEqual(summary["combined"]["incompleteCells"], 1)
            self.assertEqual(summary["combined"]["missingCellAnswers"], 1)
            self.assertEqual(summary["combined"]["unsupportedCellAnswers"], 1)


if __name__ == "__main__":
    unittest.main()
