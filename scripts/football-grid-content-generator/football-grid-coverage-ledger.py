#!/usr/bin/env python3
"""Audit published Grid manifests and triage player-reported missing answers.

This tool is read-only. It never publishes content or turns an unverified report
into an accepted answer. The optional reports input is the JSON returned by the
admin missing-answer endpoint, which includes the original cell's clue keys.
"""

import argparse
import csv
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).lower()
    value = re.sub(r"[’'`´]", "", value)
    value = re.sub(r"[._,;:!?()\[\]{}\-/\\]+", " ", value)
    value = "".join(
        char for char in unicodedata.normalize("NFD", value)
        if unicodedata.category(char) != "Mn"
    )
    return " ".join(unicodedata.normalize("NFC", value).split())


def pair_key(row: str, column: str) -> tuple[str, str]:
    return tuple(sorted((row, column)))


def write_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def load_manifest(pack: str, path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not all(key in data for key in ("release", "criteria", "players", "memberships", "aliases", "boards")):
        raise ValueError(f"{path} is not a published Football Grid manifest")
    criteria = {item["key"]: item for item in data["criteria"]}
    players = {item["id"]: item for item in data["players"]}
    memberships: dict[str, set[str]] = defaultdict(set)
    for membership in data["memberships"]:
        memberships[membership["criterionKey"]].add(membership["playerId"])
    aliases: dict[str, set[str]] = defaultdict(set)
    for alias in data["aliases"]:
        aliases[alias["normalizedAlias"]].add(alias["playerId"])
    canonical_names: dict[str, set[str]] = defaultdict(set)
    name_fragments: dict[str, set[str]] = defaultdict(set)
    for player_id, player in players.items():
        for field in ("nameEn", "nameKa", "nameEs", "nameTr"):
            if name := player.get(field):
                normalized_name = normalize_name(name)
                canonical_names[normalized_name].add(player_id)
                for token in normalized_name.split():
                    if len(token) >= 4:
                        name_fragments[token].add(player_id)
    pairs: dict[tuple[str, str], dict] = {}
    criterion_placements = Counter()
    incomplete_cells = 0
    missing_cell_answers = 0
    unsupported_cell_answers = 0
    for board in data["boards"]:
        rows, columns, cells = board["rowCriteria"], board["columnCriteria"], board["cells"]
        if len(rows) != 3 or len(columns) != 3 or len(cells) != 9:
            raise ValueError(f"Board {board.get('key')} is not a 3x3 grid")
        for index, cell in enumerate(cells):
            row, column = rows[index // 3], columns[index % 3]
            if row not in criteria or column not in criteria:
                raise ValueError(f"Board {board.get('key')} references a missing criterion")
            criterion_placements.update({row, column})
            key = pair_key(row, column)
            entry = pairs.setdefault(key, {"placements": 0, "answer_counts": set(),
                                           "answer_variants": set(), "accepted": set(),
                                           "incomplete_cells": 0, "missing_cell_answers": 0,
                                           "unsupported_cell_answers": 0})
            entry["placements"] += 1
            answers = set(cell["playerIds"])
            entry["answer_counts"].add(len(answers))
            entry["answer_variants"].add(frozenset(answers))
            entry["accepted"].update(answers)
            expected = memberships[row] & memberships[column]
            missing = len(expected - answers)
            unsupported = len(answers - expected)
            if missing or unsupported:
                incomplete_cells += 1
                entry["incomplete_cells"] += 1
            missing_cell_answers += missing
            unsupported_cell_answers += unsupported
            entry["missing_cell_answers"] += missing
            entry["unsupported_cell_answers"] += unsupported
    return {
        "pack": pack,
        "path": str(path),
        "release_version": data["release"]["version"],
        "boards": len(data["boards"]),
        "criteria": criteria,
        "players": players,
        "memberships": memberships,
        "aliases": aliases,
        "canonical_names": canonical_names,
        "name_fragments": name_fragments,
        "pairs": pairs,
        "criterion_placements": criterion_placements,
        "incomplete_cells": incomplete_cells,
        "missing_cell_answers": missing_cell_answers,
        "unsupported_cell_answers": unsupported_cell_answers,
    }


def triage_report(report: dict, packs: dict[str, dict]) -> dict:
    theme = report.get("board_theme") or report.get("boardTheme") or ""
    pack = report.get("pack") or ("european" if theme == "european" else "themed" if theme else None)
    row = report.get("row_criterion_key") or report.get("rowCriterionKey")
    column = report.get("column_criterion_key") or report.get("columnCriterionKey")
    submitted = report.get("submitted_text") or report.get("submittedText") or ""
    normalized = report.get("normalized_text") or report.get("normalizedText") or normalize_name(submitted)
    result = {
        "reportId": report.get("id"),
        "attemptId": report.get("attempt_id") or report.get("attemptId"),
        "pack": pack,
        "rowCriterionKey": row,
        "columnCriterionKey": column,
        "submittedText": submitted,
        "normalizedText": normalized,
        "sourceOutcome": report.get("outcome"),
        "candidatePlayerIds": [],
    }
    if not pack or pack not in packs or not row or not column:
        result["triage"] = "missing_context"
        return result
    content = packs[pack]
    if row not in content["criteria"] or column not in content["criteria"]:
        result["triage"] = "retired_criterion"
        return result
    current_pair = content["pairs"].get(pair_key(row, column))
    if current_pair is None:
        result["triage"] = "pair_not_served_in_current_release"
        return result
    accepted = current_pair["accepted"]
    aliases = content["aliases"].get(normalized, set())
    qualifying = aliases & accepted
    if len(qualifying) == 1:
        result["triage"] = "accepted_in_current_release"
        result["candidatePlayerIds"] = sorted(qualifying)
    elif len(qualifying) > 1:
        result["triage"] = "ambiguous_name"
        result["candidatePlayerIds"] = sorted(qualifying)
    elif len(aliases) == 1:
        result["triage"] = "football_fact_review"
        result["candidatePlayerIds"] = sorted(aliases)
    elif len(aliases) > 1:
        result["triage"] = "ambiguous_identity_or_fact"
        result["candidatePlayerIds"] = sorted(aliases)
    else:
        canonical = content["canonical_names"].get(normalized, set())
        fragments = content["name_fragments"].get(normalized, set()) if " " not in normalized else set()
        name_matches = canonical | fragments
        qualifying_names = name_matches & accepted
        if len(qualifying_names) == 1:
            result["triage"] = "name_alias_review"
            result["candidatePlayerIds"] = sorted(qualifying_names)
        elif len(qualifying_names) > 1:
            result["triage"] = "ambiguous_name"
            result["candidatePlayerIds"] = sorted(qualifying_names)
        elif len(name_matches) == 1:
            result["triage"] = "football_fact_review"
            result["candidatePlayerIds"] = sorted(name_matches)
        elif len(name_matches) > 1:
            result["triage"] = "ambiguous_identity_or_fact"
            result["candidatePlayerIds"] = sorted(name_matches)
        else:
            result["triage"] = "player_or_spelling_research"
    return result


def run(manifest_args: list[str], discovery_path: Path | None, reports_path: Path | None, output_dir: Path) -> dict:
    packs = {}
    for argument in manifest_args:
        if "=" not in argument:
            raise ValueError("--manifest must be PACK=PATH")
        pack, filename = argument.split("=", 1)
        if pack in packs or pack not in ("european", "themed"):
            raise ValueError("Provide each of european and themed at most once")
        packs[pack] = load_manifest(pack, Path(filename))
    if not packs:
        raise ValueError("At least one --manifest is required")
    discovery = json.loads(discovery_path.read_text(encoding="utf-8")) if discovery_path else {}
    held_keys = {item["key"] for item in discovery.get("heldClubKeys", [])}
    held_aliases = held_keys | {key.replace(":", "-", 1) for key in held_keys}
    output_dir.mkdir(parents=True, exist_ok=True)

    criterion_rows = []
    pair_rows = []
    all_criteria = set()
    all_players = set()
    all_pairs = set()
    for pack, content in packs.items():
        all_players.update(content["players"])
        all_criteria.update(content["criteria"])
        for criterion in content["criteria"].values():
            key = criterion["key"]
            placements = content["criterion_placements"][key]
            criterion_rows.append({
                "pack": pack, "criterion_key": key, "label_en": criterion["labelEn"],
                "family": criterion["family"], "subtype": criterion["subtype"],
                "member_count": len(content["memberships"].get(key, set())),
                "cell_placements": placements,
                "held_in_1950_discovery": key in held_aliases or key.replace(":", "-", 1) in held_aliases,
            })
        for (first, second), pair in content["pairs"].items():
            all_pairs.add((first, second))
            pair_rows.append({
                "pack": pack, "first_criterion": first, "second_criterion": second,
                "cell_placements": pair["placements"],
                "accepted_players": len(pair["accepted"]),
                "min_cell_answers": min(pair["answer_counts"]),
                "max_cell_answers": max(pair["answer_counts"]),
                "repeated_cell_variants": len(pair["answer_variants"]),
                "repeated_cell_disagreement": len(pair["answer_variants"]) > 1,
                "incomplete_cells": pair["incomplete_cells"],
                "missing_cell_answers": pair["missing_cell_answers"],
                "unsupported_cell_answers": pair["unsupported_cell_answers"],
            })
    held_priority = sorted(
        (item for item in criterion_rows if item["family"] == "club" and item["held_in_1950_discovery"]),
        key=lambda item: (-item["cell_placements"], item["criterion_key"]),
    )
    used_keys = {item["criterion_key"] for item in criterion_rows if item["cell_placements"] > 0}
    used_clubs = {item["criterion_key"] for item in criterion_rows if item["family"] == "club" and item["cell_placements"] > 0}
    used_held_clubs = {item["criterion_key"] for item in held_priority if item["cell_placements"] > 0}
    normalized_criteria_keys = {key.replace(":", "-", 1) for key in all_criteria}
    club_year_rows = [
        {"criterion_key": key, "season_start_year": year, "applicability": "unchecked",
         "source_status": "not_assessed", "verified_players": "", "evidence_reference": ""}
        for key in sorted({item["criterion_key"] for item in criterion_rows if item["family"] == "club"})
        for year in range(1950, 2027)
    ]
    write_csv(output_dir / "criteria.csv", list(criterion_rows[0]), criterion_rows)
    write_csv(output_dir / "pairs.csv", list(pair_rows[0]), pair_rows)
    write_csv(output_dir / "club-seasons.csv", list(club_year_rows[0]), club_year_rows)
    summary = {
        "manifests": {pack: {"path": content["path"], "releaseVersion": content["release_version"],
                             "boards": content["boards"], "criteria": len(content["criteria"]),
                             "distinctPairs": len(content["pairs"])} for pack, content in packs.items()},
        "combined": {"distinctCriteria": len(all_criteria), "distinctPlayers": len(all_players),
                     "distinctPairs": len(all_pairs), "cellPlacements": sum(9 * content["boards"] for content in packs.values()),
                     "clubCriteria": len({item["criterion_key"] for item in criterion_rows if item["family"] == "club"}),
                     "criteriaUsedInStoredBoards": len(used_keys), "clubCriteriaUsedInStoredBoards": len(used_clubs),
                     "clubSeasonRowsForReview": len(club_year_rows),
                     "repeatedCellDisagreements": sum(row["repeated_cell_disagreement"] for row in pair_rows),
                     "incompleteCells": sum(content["incomplete_cells"] for content in packs.values()),
                     "missingCellAnswers": sum(content["missing_cell_answers"] for content in packs.values()),
                     "unsupportedCellAnswers": sum(content["unsupported_cell_answers"] for content in packs.values())},
        "discovery": {"heldClubKeys": len(held_keys), "matchedHeldClubKeys": len({item["criterion_key"] for item in held_priority}),
                      "heldClubKeysUsedInStoredBoards": len(used_held_clubs),
                      "unmatchedHeldKeys": sorted(
                          key for key in held_keys
                          if key.replace(":", "-", 1) not in normalized_criteria_keys
                      ),
                      "topHeldClubsByCellPlacements": [item for item in held_priority if item["cell_placements"] > 0][:20]},
    }
    if reports_path:
        payload = json.loads(reports_path.read_text(encoding="utf-8"))
        reports = payload["reports"] if isinstance(payload, dict) else payload
        if not isinstance(reports, list):
            raise ValueError("Reports must be an array or an object with a reports array")
        triaged = [triage_report(report, packs) for report in reports]
        (output_dir / "report-triage.json").write_text(json.dumps(triaged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        alias_proposals = [
            {"pack": item["pack"], "playerId": item["candidatePlayerIds"][0],
             "alias": item["submittedText"], "normalizedAlias": item["normalizedText"],
             "acceptancePolicy": "unique_only", "reportId": item["reportId"], "reviewStatus": "pending"}
            for item in triaged if item["triage"] == "name_alias_review"
        ]
        fact_candidates = [
            {"pack": item["pack"], "playerId": item["candidatePlayerIds"][0],
             "rowCriterionKey": item["rowCriterionKey"], "columnCriterionKey": item["columnCriterionKey"],
             "reportId": item["reportId"], "reviewStatus": "pending", "evidence": None}
            for item in triaged if item["triage"] == "football_fact_review"
        ]
        (output_dir / "alias-proposals.json").write_text(json.dumps(alias_proposals, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (output_dir / "fact-review-candidates.json").write_text(json.dumps(fact_candidates, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        summary["reports"] = dict(Counter(item["triage"] for item in triaged))
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", action="append", required=True, metavar="PACK=PATH")
    parser.add_argument("--discovery-summary", type=Path)
    parser.add_argument("--reports", type=Path, help="Admin missing-answer reports JSON export")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.manifest, args.discovery_summary, args.reports, args.output_dir), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
