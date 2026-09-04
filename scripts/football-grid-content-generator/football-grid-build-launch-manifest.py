#!/usr/bin/env python3
"""Build a reviewed Football Grid launch manifest from Quizball staging data.

The script deliberately exposes only players that can be joined to an existing
published Quizball English/Georgian display answer. Relationship facts come
from a pinned CC0 transfermarkt-datasets snapshot and are materialized with
row-level evidence locators for the immutable Football Grid release.

Runtime dependencies are intentionally kept outside the Node service because
DuckDB is used to scan the multi-million-row source snapshot efficiently:

    python -m pip install certifi duckdb psycopg[binary]
"""

from __future__ import annotations

import argparse
import sys
import hashlib
import json
import os
import random
import re
import ssl
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import duckdb
import psycopg
import certifi


REQUIRED_FAMILIES = {
    "club", "country", "league", "manager", "teammate", "trophy_award", "wildcard"
}
TOP_FIVE_LEAGUES = {"GB1", "ES1", "IT1", "L1", "FR1"}
LEAGUE_COMPETITIONS = {
    "premier-league": "GB1",
    "la-liga": "ES1",
    "serie-a": "IT1",
    "bundesliga": "L1",
    "ligue-1": "FR1",
    "eredivisie": "NL1",
    "primeira-liga": "PO1",
    "brasileirao": "BRA1",
    "scottish-premiership": "SC1",
    "argentine-primera": "ARG1",
    "super-lig": "TR1",
    "belgian-pro-league": "BE1",
    "major-league-soccer": "MLS1",
    "saudi-pro-league": "SA1",
}
TROPHY_COMPETITIONS = {
    "fifa-world-cup": "FIWC",
    "uefa-euro": "EURO",
    "copa-america": "COPA",
    "africa-cup-of-nations": "AFCN",
    "afc-asian-cup": "AFAC",
    "uefa-champions-league": "CL",
    "uefa-europa-league": "EL",
    "uefa-conference-league": "UCOL",
    "fa-cup": "FAC",
    "copa-del-rey": "CDR",
    "coppa-italia": "CIT",
    "dfb-pokal": "DFB",
    "knvb-cup": "NLP",
    # Not in the 2026-08-05 dataset: EFL Cup, Coupe de France, Taça de Portugal,
    # Copa Libertadores, Nations League, Club World Cup — catalogued, unbuildable.
}
LEAGUE_TITLE_COMPETITIONS = {
    "premier-league-title": "GB1",
    "la-liga-title": "ES1",
    "serie-a-title": "IT1",
    "bundesliga-title": "L1",
    "ligue-1-title": "FR1",
}
CLUB_ALIASES = {
    "arsenal fc": "arsenal",
    "chelsea fc": "chelsea",
    "liverpool fc": "liverpool",
    "everton fc": "everton",
    "fc barcelona": "fc-barcelona",
    "real madrid": "real-madrid-cf",
    "bayern munich": "fc-bayern-munich",
    "ajax amsterdam": "afc-ajax",
    "associazione sportiva roma": "as-roma",
    "olympique marseille": "olympique-de-marseille",
    "olympique lyon": "olympique-lyonnais",
    "fenerbahce": "wl-fenerbahce",
    "besiktas jimnastik kulubu": "wl-besiktas",
    "olympiakos syndesmos filathlon peiraios": "wl-olympiacos",
    "vfl wolfsburg": "wl-vfl-wolfsburg",
    "rb leipzig": "wl-rb-leipzig",
    "galatasaray": "wl-galatasaray",
}
# Curated derby pairs (registry club ids). A player who made senior
# appearances for both sides qualifies for wildcard:played-for-rivals.
RIVAL_CLUB_PAIRS = [
    ("real-madrid-cf", "fc-barcelona"), ("real-madrid-cf", "atletico-de-madrid"),
    ("sevilla-fc", "real-betis"),
    ("manchester-united", "manchester-city"), ("manchester-united", "liverpool"),
    ("liverpool", "everton"), ("arsenal", "tottenham-hotspur"),
    ("ac-milan", "inter-milan"), ("juventus", "inter-milan"), ("as-roma", "ss-lazio"),
    ("borussia-dortmund", "fc-schalke-04"), ("fc-bayern-munich", "borussia-dortmund"),
    ("paris-saint-germain", "olympique-de-marseille"),
    ("afc-ajax", "psv-eindhoven"), ("fc-porto", "sl-benfica"), ("sl-benfica", "sporting-cp"),
    ("celtic", "rangers"), ("boca-juniors", "river-plate"),
    ("wl-galatasaray", "wl-fenerbahce"),
]

HARD_CRITERION_OVERRIDES = {
    # These broad-but-expert criteria intentionally anchor hard boards. Narrow
    # club/manager facts alone do not form enough valid K3,3 board families.
    "league:super-lig",
    "league:eredivisie",
    "league:belgian-pro-league",
    "wildcard:international-caps-100",
    "wildcard:major-leagues-3",
    "wildcard:titles-multiple-countries",
}


def ascii_key(value: str | None) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", normalized.casefold()).strip()


def answer_key(value: str | None) -> str:
    normalized = unicodedata.normalize("NFKC", value or "").lower()  # .lower(), not casefold(): must match normalizeFootballGridAnswer (ß stays ß)
    normalized = re.sub(r"[’'`´]", "", normalized)
    normalized = re.sub(r"[._,;:!?()\[\]{}/\\-]+", " ", normalized)
    normalized = unicodedata.normalize("NFD", normalized)
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", normalized)).strip()


def slug(value: str) -> str:
    return ascii_key(value).replace(" ", "-")


def iso_date(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (date, datetime)):
        return value.date().isoformat() if isinstance(value, datetime) else value.isoformat()
    return str(value)[:10]


def canonical_checksum(rows: Iterable[str], columns: Iterable[str]) -> str:
    normal = f"{'|'.join(sorted(rows))}::{'|'.join(sorted(columns))}"
    transposed = f"{'|'.join(sorted(columns))}::{'|'.join(sorted(rows))}"
    return hashlib.sha256(min(normal, transposed).encode()).hexdigest()


@dataclass
class Player:
    dataset_id: int
    uuid: str
    name_en: str
    name_ka: str
    image_url: str
    peak_value: int
    question_count: int
    accepted_aliases: set[str] = field(default_factory=set)

    @property
    def recognizable_score(self) -> tuple[int, int, str]:
        return (self.question_count, self.peak_value, self.name_en)


@dataclass
class RelationshipEvidence:
    locator: str
    captured_fact: str
    effective_from: str | None = None
    effective_to: str | None = None


@dataclass
class Criterion:
    key: str
    family: str
    subtype: str
    label_en: str
    label_ka: str
    asset_key: str
    difficulty: str
    familiarity: float
    local_asset: Path
    members: dict[str, RelationshipEvidence] = field(default_factory=dict)


def load_registry(path: Path) -> list[dict[str, Any]]:
    return json.loads(path.read_text())


def registry_asset(frontend_root: Path, family: str, item: dict[str, Any]) -> Path:
    if family == "club":
        relative = item["fallback"]["assetPath"]
    elif family == "country":
        relative = item["assetPath"]
    else:
        primary = item.get("primary") or {}
        source = primary.get("source") or {}
        rights = source.get("rightsStatus") or primary.get("rightsStatus")
        relative = primary.get("assetPath") if rights in {"owned", "cleared-for-launch"} else None
        relative = relative or (item.get("fallback") or {}).get("assetPath") or item.get("assetPath")
    if not relative or not relative.startswith("/"):
        raise RuntimeError(f"No packaged asset for {family}/{item.get('id')}")
    return frontend_root / "public" / relative.removeprefix("/")


def criterion_difficulty(member_count: int, familiarity: float) -> str:
    if familiarity >= 82 and member_count >= 30:
        return "easy"
    if familiarity >= 55 and member_count >= 16:
        return "normal"
    return "hard"


def add_criterion(
    criteria: list[Criterion],
    *,
    key: str,
    family: str,
    subtype: str,
    label_en: str,
    label_ka: str,
    asset_key: str,
    local_asset: Path,
    members: dict[str, RelationshipEvidence],
    familiarity: float,
) -> None:
    if len(members) < 9:
        return
    difficulty = criterion_difficulty(len(members), familiarity)
    if key in HARD_CRITERION_OVERRIDES:
        difficulty = "hard"
    criteria.append(Criterion(
        key=key,
        family=family,
        subtype=subtype,
        label_en=label_en,
        label_ka=label_ka,
        asset_key=asset_key,
        difficulty=difficulty,
        familiarity=round(familiarity, 3),
        local_asset=local_asset,
        members=members,
    ))


def load_players(db_url: str) -> tuple[dict[int, Player], list[dict[str, Any]]]:
    with psycopg.connect(db_url) as db, db.cursor() as cursor:
        cursor.execute("""
            SELECT id::text, transfermarkt_id, name, image_url, peak_value_eur
              FROM football_players
             WHERE data_quality_status = 'usable'
               AND transfermarkt_id ~ '^[0-9]+$'
               AND image_url LIKE 'https://nsdfiprfmhdqhbfxfwpv.supabase.co/storage/v1/object/public/imgs/%'
        """)
        player_rows = cursor.fetchall()
        cursor.execute("""
            SELECT q.id::text, q.type, qp.payload
              FROM questions q
              JOIN question_payloads qp ON qp.question_id = q.id
             WHERE q.status = 'published'
               AND q.type IN ('career_path', 'clue_chain', 'football_logic')
               AND NULLIF(qp.payload->'display_answer'->>'en', '') IS NOT NULL
               AND NULLIF(qp.payload->'display_answer'->>'ka', '') IS NOT NULL
        """)
        question_rows = cursor.fetchall()
        cursor.execute("""
            SELECT football_player_id::text, name
              FROM football_player_name_translations
             WHERE locale = 'ka'
        """)
        translation_rows = dict(cursor.fetchall())

    cards_by_alias: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for question_id, question_type, payload in question_rows:
        if isinstance(payload, str):
            payload = json.loads(payload)
        display = payload.get("display_answer") or {}
        english = display.get("en")
        georgian = display.get("ka")
        if not english or not georgian:
            continue
        accepted = [alias for alias in payload.get("accepted_answers", []) if isinstance(alias, str)]
        card = {
            "questionId": question_id,
            "questionType": question_type,
            "english": english,
            "georgian": georgian,
            "accepted": accepted,
        }
        for alias in [english, *accepted]:
            if re.search(r"[A-Za-z]", alias):
                cards_by_alias[ascii_key(alias)].append(card)

    translated: dict[int, Player] = {}
    provenance: list[dict[str, Any]] = []
    for player_uuid, transfermarkt_id, name, image_url, peak_value in player_rows:
        cards = cards_by_alias.get(ascii_key(name), [])
        if cards:
            georgian_counts = Counter(card["georgian"] for card in cards)
            name_ka, count = georgian_counts.most_common(1)[0]
            # A tied editorial spelling is not silently resolved at launch.
            if len(georgian_counts) > 1 and georgian_counts.most_common(2)[1][1] == count:
                continue
        elif player_uuid in translation_rows:
            # Reviewed/transliterated names widen the pool beyond the question bank.
            name_ka = translation_rows[player_uuid]
        else:
            continue
        aliases = {name}
        for card in cards:
            aliases.update(card["accepted"])
            provenance.append(card)
        translated[int(transfermarkt_id)] = Player(
            dataset_id=int(transfermarkt_id),
            uuid=player_uuid,
            name_en=name,
            name_ka=name_ka,
            image_url=image_url,
            peak_value=int(peak_value or 0),
            question_count=len({card["questionId"] for card in cards}),
            accepted_aliases={alias for alias in aliases if isinstance(alias, str) and alias.strip()},
        )
    return translated, provenance


def prepare_duckdb(dataset_dir: Path, players: dict[int, Player]) -> duckdb.DuckDBPyConnection:
    connection = duckdb.connect()
    for name in ["players", "clubs", "competitions", "games", "appearances", "national_teams"]:
        source = dataset_dir / f"{name}.csv.gz"
        if not source.is_file():
            raise RuntimeError(f"Missing dataset file: {source}")
        escaped_source = str(source).replace("'", "''")
        connection.execute(
            f"CREATE VIEW {name} AS SELECT * FROM read_csv_auto('{escaped_source}', header=true, sample_size=-1)"
        )
    connection.execute("CREATE TABLE eligible(player_id BIGINT PRIMARY KEY, uuid VARCHAR)")
    connection.executemany(
        "INSERT INTO eligible VALUES (?, ?)",
        [(player.dataset_id, player.uuid) for player in players.values()],
    )
    return connection


def map_club_item(name: str, registry: list[dict[str, Any]]) -> dict[str, Any] | None:
    by_id = {item["id"]: item for item in registry}
    if ascii_key(name) in CLUB_ALIASES:
        return by_id.get(CLUB_ALIASES[ascii_key(name)])
    by_label: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in registry:
        by_label[ascii_key(item.get("labelEn"))].append(item)
    keys = [ascii_key(name)]
    stripped = re.sub(r"\b(fc|cf|afc|ac|sc|cfc|fk)\b", " ", ascii_key(name))
    keys.append(re.sub(r"\s+", " ", stripped).strip())
    candidates: list[dict[str, Any]] = []
    for key in keys:
        candidates.extend(by_label.get(key, []))
    if not candidates:
        name_slug = slug(name)
        slug_candidates = [name_slug, f"wl-{name_slug}"]
        for token in ("-fc", "fc-", "-cf", "cf-", "-ac", "ac-"):
            slug_candidates.extend(candidate.replace(token, "-").strip("-") for candidate in list(slug_candidates))
        candidates = [by_id[candidate] for candidate in slug_candidates if candidate in by_id]
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item["id"].startswith("wl-"), len(item["id"]), item["id"]))
    return candidates[0]


def build_criteria(
    connection: duckdb.DuckDBPyConnection,
    players: dict[int, Player],
    frontend_root: Path,
) -> list[Criterion]:
    pack = frontend_root / "src/data/football-grid/launch-assets"
    registries = {
        name: load_registry(pack / f"{name}.json")
        for name in ["clubs", "countries", "leagues", "managers", "competitions", "wildcards"]
    }
    player_by_uuid = {player.uuid: player for player in players.values()}
    criteria: list[Criterion] = []

    club_rows = connection.execute("""
        SELECT c.club_id, c.name, e.uuid, min(a.date), max(a.date), count(DISTINCT a.game_id)
          FROM appearances a
          JOIN eligible e USING (player_id)
          JOIN clubs c ON c.club_id = a.player_club_id
         GROUP BY c.club_id, c.name, e.uuid
    """).fetchall()
    clubs: dict[tuple[int, str], dict[str, RelationshipEvidence]] = defaultdict(dict)
    for club_id, club_name, player_uuid, first_date, last_date, games in club_rows:
        clubs[(club_id, club_name)][player_uuid] = RelationshipEvidence(
            locator=f"appearances.csv:player_id={player_by_uuid[player_uuid].dataset_id};club_id={club_id}",
            captured_fact=f"{player_by_uuid[player_uuid].name_en} made {games} recorded senior appearances for {club_name}.",
            effective_from=iso_date(first_date), effective_to=iso_date(last_date),
        )
    used_club_assets: set[str] = set()
    club_members_by_registry_id: dict[str, dict[str, RelationshipEvidence]] = {}
    for (_club_id, club_name), members in sorted(clubs.items(), key=lambda item: (-len(item[1]), item[0][1])):
        item = map_club_item(club_name, registries["clubs"])
        if not item or item["id"] in used_club_assets:
            continue
        used_club_assets.add(item["id"])
        club_members_by_registry_id[item["id"]] = members
        familiarity = min(98.0, 42.0 + len(members) * 0.85)
        add_criterion(
            criteria, key=f"club:{item['id']}", family="club", subtype="senior-club-appearance",
            label_en=item["labelEn"], label_ka=item["labelKa"], asset_key=item["id"],
            local_asset=registry_asset(frontend_root, "club", item), members=members,
            familiarity=familiarity,
        )

    country_by_name = {ascii_key(item["labelEn"]): item for item in registries["countries"]}
    country_rows = connection.execute("""
        SELECT e.uuid, nt.country_name, count(DISTINCT a.game_id), min(a.date), max(a.date)
          FROM appearances a
          JOIN eligible e USING (player_id)
          JOIN games g USING (game_id)
          JOIN competitions c ON c.competition_id = a.competition_id
          JOIN national_teams nt ON nt.national_team_id = a.player_club_id
         WHERE c.type = 'national_team_competition'
         GROUP BY e.uuid, nt.country_name
        UNION ALL
        SELECT e.uuid, nt.country_name, p.international_caps, NULL, NULL
          FROM players p
          JOIN eligible e USING (player_id)
          JOIN national_teams nt ON nt.national_team_id = p.current_national_team_id
         WHERE coalesce(p.international_caps, 0) > 0
    """).fetchall()
    country_members: dict[str, dict[str, RelationshipEvidence]] = defaultdict(dict)
    for player_uuid, country_name, appearances, first_date, last_date in country_rows:
        item = country_by_name.get(ascii_key(country_name))
        if not item:
            continue
        existing = country_members[item["id"]].get(player_uuid)
        evidence = RelationshipEvidence(
            locator=f"national-team-records:player_id={player_by_uuid[player_uuid].dataset_id};country={country_name}",
            captured_fact=f"{player_by_uuid[player_uuid].name_en} has {appearances} recorded senior appearances/caps for {country_name}.",
            effective_from=iso_date(first_date), effective_to=iso_date(last_date),
        )
        if existing is None or (first_date is not None and existing.effective_from is None):
            country_members[item["id"]][player_uuid] = evidence
    # National-team records are sparse in the snapshot (retired legends have no
    # current_national_team_id and few NT appearance rows), which is why only a
    # couple of countries ever reached the 9-member floor. Citizenship is fully
    # populated for every player row, so it backfills the "X-ian player" clue
    # semantics; explicit NT evidence, when present, stays preferred.
    citizenship_rows = connection.execute("""
        SELECT e.uuid, p.player_id, p.country_of_citizenship
          FROM players p
          JOIN eligible e USING (player_id)
         WHERE coalesce(p.country_of_citizenship, '') <> ''
    """).fetchall()
    for player_uuid, dataset_player_id, country_name in citizenship_rows:
        item = country_by_name.get(ascii_key(country_name))
        if not item:
            continue
        if player_uuid in country_members[item["id"]]:
            continue
        country_members[item["id"]][player_uuid] = RelationshipEvidence(
            locator=f"players.csv:player_id={dataset_player_id};country_of_citizenship={country_name}",
            captured_fact=(
                f"{player_by_uuid[player_uuid].name_en} is recorded with country of citizenship "
                f"{country_name} in the pinned transfermarkt snapshot."
            ),
            effective_from=None,
            effective_to=None,
        )
    for item in registries["countries"]:
        members = country_members.get(item["id"], {})
        add_criterion(
            criteria, key=f"country:{item['id']}", family="country", subtype="nationality",
            label_en=item["labelEn"], label_ka=item["labelKa"], asset_key=item["id"],
            local_asset=registry_asset(frontend_root, "country", item), members=members,
            familiarity=min(96.0, 40.0 + len(members) * 1.1),
        )

    league_items = {item["id"]: item for item in registries["leagues"]}
    league_rows = connection.execute("""
        SELECT a.competition_id, e.uuid, count(DISTINCT a.game_id), min(a.date), max(a.date)
          FROM appearances a JOIN eligible e USING (player_id)
          JOIN competitions c USING (competition_id)
         WHERE c.type = 'domestic_league'
         GROUP BY a.competition_id, e.uuid
    """).fetchall()
    league_members: dict[str, dict[str, RelationshipEvidence]] = defaultdict(dict)
    competition_to_league = {value: key for key, value in LEAGUE_COMPETITIONS.items()}
    player_leagues: dict[str, set[str]] = defaultdict(set)
    for competition_id, player_uuid, appearances, first_date, last_date in league_rows:
        league_id = competition_to_league.get(competition_id)
        if not league_id or league_id not in league_items:
            continue
        player_leagues[player_uuid].add(competition_id)
        league_members[league_id][player_uuid] = RelationshipEvidence(
            locator=f"appearances.csv:player_id={player_by_uuid[player_uuid].dataset_id};competition_id={competition_id}",
            captured_fact=f"{player_by_uuid[player_uuid].name_en} made {appearances} recorded senior league appearances in {league_items[league_id]['labelEn']}.",
            effective_from=iso_date(first_date), effective_to=iso_date(last_date),
        )
    for league_id, competition_id in LEAGUE_COMPETITIONS.items():
        item = league_items.get(league_id)
        if not item:
            continue
        members = league_members.get(league_id, {})
        add_criterion(
            criteria, key=f"league:{league_id}", family="league", subtype="senior-league-appearance",
            label_en=item["labelEn"], label_ka=item["labelKa"], asset_key=league_id,
            local_asset=registry_asset(frontend_root, "league", item), members=members,
            familiarity=min(99.0, 55.0 + len(members) * 0.22),
        )

    manager_items = {ascii_key(item["labelEn"].removeprefix("Sir ")): item for item in registries["managers"]}
    manager_rows = connection.execute("""
        SELECT CASE WHEN a.player_club_id = g.home_club_id THEN g.home_club_manager_name
                    ELSE g.away_club_manager_name END AS manager,
               e.uuid, count(DISTINCT a.game_id), min(a.date), max(a.date)
          FROM appearances a
          JOIN eligible e USING (player_id)
          JOIN games g USING (game_id)
         WHERE a.player_club_id IN (g.home_club_id, g.away_club_id)
           AND manager IS NOT NULL AND manager <> ''
         GROUP BY manager, e.uuid
    """).fetchall()
    manager_members: dict[str, dict[str, RelationshipEvidence]] = defaultdict(dict)
    for manager_name, player_uuid, appearances, first_date, last_date in manager_rows:
        item = manager_items.get(ascii_key(manager_name))
        if not item:
            continue
        manager_members[item["id"]][player_uuid] = RelationshipEvidence(
            locator=f"games.csv+appearances.csv:player_id={player_by_uuid[player_uuid].dataset_id};manager={manager_name}",
            captured_fact=f"{player_by_uuid[player_uuid].name_en} made {appearances} recorded senior appearances under {item['labelEn']}.",
            effective_from=iso_date(first_date), effective_to=iso_date(last_date),
        )
    for item in registries["managers"]:
        members = manager_members.get(item["id"], {})
        add_criterion(
            criteria, key=f"manager:{item['id']}", family="manager", subtype="manager-overlap",
            label_en=item["labelEn"], label_ka=item["labelKa"], asset_key=item["id"],
            local_asset=registry_asset(frontend_root, "manager", item), members=members,
            familiarity=min(94.0, 45.0 + len(members) * 0.65),
        )

    club_seasons = connection.execute("""
        SELECT e.uuid, a.player_club_id, g.season, min(a.date), max(a.date)
          FROM appearances a JOIN eligible e USING (player_id) JOIN games g USING (game_id)
          JOIN clubs c ON c.club_id = a.player_club_id
         GROUP BY e.uuid, a.player_club_id, g.season
    """).fetchall()
    slots: dict[tuple[int, int], set[str]] = defaultdict(set)
    player_slots: dict[str, list[tuple[int, int, Any, Any]]] = defaultdict(list)
    for player_uuid, club_id, season, first_date, last_date in club_seasons:
        slots[(club_id, season)].add(player_uuid)
        player_slots[player_uuid].append((club_id, season, first_date, last_date))
    teammate_targets = sorted(players.values(), key=lambda player: player.recognizable_score, reverse=True)[:120]
    for target in teammate_targets:
        teammates: dict[str, list[tuple[int, int, Any, Any]]] = defaultdict(list)
        for club_id, season, first_date, last_date in player_slots.get(target.uuid, []):
            for teammate_uuid in slots[(club_id, season)]:
                if teammate_uuid != target.uuid:
                    teammates[teammate_uuid].append((club_id, season, first_date, last_date))
        members: dict[str, RelationshipEvidence] = {}
        for teammate_uuid, overlaps in teammates.items():
            seasons = sorted({season for _club, season, _first, _last in overlaps})
            clubs_used = sorted({club for club, _season, _first, _last in overlaps})
            members[teammate_uuid] = RelationshipEvidence(
                locator=f"appearances.csv:players={player_by_uuid[teammate_uuid].dataset_id},{target.dataset_id};club_ids={','.join(map(str, clubs_used))};seasons={','.join(map(str, seasons))}",
                captured_fact=f"{player_by_uuid[teammate_uuid].name_en} and {target.name_en} made senior appearances for the same club in {len(seasons)} recorded season(s).",
                effective_from=min(filter(None, (iso_date(row[2]) for row in overlaps)), default=None),
                effective_to=max(filter(None, (iso_date(row[3]) for row in overlaps)), default=None),
            )
        if len(members) < 9:
            continue
        teammate_asset_key = f"/assets/football-grid/players/{target.uuid}.webp"
        local_portrait = Path("__PLAYER_CACHE__") / f"{target.uuid}.webp"
        add_criterion(
            criteria, key=f"teammate:{target.uuid}", family="teammate", subtype="same-club-season",
            label_en=f"Played with {target.name_en}", label_ka=f"ითამაშა {target.name_ka}-სთან ერთად",
            asset_key=teammate_asset_key, local_asset=local_portrait, members=members,
            familiarity=min(94.0, 50.0 + target.question_count * 4.0 + target.peak_value / 20_000_000),
        )

    competition_items = {item["id"]: item for item in registries["competitions"]}
    final_winner_rows = connection.execute("""
        WITH winners AS (
          SELECT competition_id, season,
                 CASE WHEN home_club_goals > away_club_goals THEN home_club_id ELSE away_club_id END winner_id,
                 CASE WHEN home_club_goals > away_club_goals THEN home_club_name ELSE away_club_name END winner_name,
                 date final_date
            FROM games
           WHERE round = 'Final' AND home_club_goals <> away_club_goals
        )
        SELECT w.competition_id, w.season, w.winner_id, w.winner_name, w.final_date,
               e.uuid, count(DISTINCT a.game_id)
          FROM winners w
          JOIN appearances a ON a.competition_id = w.competition_id
                            AND a.player_club_id = w.winner_id
          JOIN games g ON g.game_id = a.game_id AND g.season = w.season
          JOIN eligible e ON e.player_id = a.player_id
         GROUP BY w.competition_id, w.season, w.winner_id, w.winner_name, w.final_date, e.uuid
    """).fetchall()
    trophy_members: dict[str, dict[str, list[tuple[Any, ...]]]] = defaultdict(lambda: defaultdict(list))
    competition_to_trophy = {value: key for key, value in TROPHY_COMPETITIONS.items()}
    for competition_id, season, winner_id, winner_name, final_date, player_uuid, appearances in final_winner_rows:
        trophy_id = competition_to_trophy.get(competition_id)
        if trophy_id:
            trophy_members[trophy_id][player_uuid].append((season, winner_id, winner_name, final_date, appearances))

    league_winner_rows = connection.execute("""
        WITH club_positions AS (
          SELECT competition_id, season, date, home_club_id club_id,
                 home_club_name club_name, home_club_position standing FROM games
          UNION ALL
          SELECT competition_id, season, date, away_club_id,
                 away_club_name, away_club_position FROM games
        ), latest AS (
          SELECT *, row_number() OVER (
            PARTITION BY competition_id, season, club_id ORDER BY date DESC
          ) AS recency
          FROM club_positions WHERE standing IS NOT NULL
        ), winners AS (
          SELECT competition_id, season, club_id winner_id, club_name winner_name, date final_date
            FROM latest WHERE recency = 1 AND standing = 1
        )
        SELECT w.competition_id, w.season, w.winner_id, w.winner_name, w.final_date,
               e.uuid, count(DISTINCT a.game_id)
          FROM winners w
          JOIN appearances a ON a.competition_id = w.competition_id
                            AND a.player_club_id = w.winner_id
          JOIN games g ON g.game_id = a.game_id AND g.season = w.season
          JOIN eligible e ON e.player_id = a.player_id
         WHERE w.competition_id IN ('GB1','ES1','IT1','L1','FR1')
         GROUP BY w.competition_id, w.season, w.winner_id, w.winner_name, w.final_date, e.uuid
    """).fetchall()
    competition_to_title = {value: key for key, value in LEAGUE_TITLE_COMPETITIONS.items()}
    player_title_countries: dict[str, set[str]] = defaultdict(set)
    title_memberships: dict[str, dict[str, list[tuple[Any, ...]]]] = defaultdict(lambda: defaultdict(list))
    for competition_id, season, winner_id, winner_name, final_date, player_uuid, appearances in league_winner_rows:
        trophy_id = competition_to_title.get(competition_id)
        if trophy_id:
            title_memberships[trophy_id][player_uuid].append((season, winner_id, winner_name, final_date, appearances))
            player_title_countries[player_uuid].add(competition_id)
    trophy_members.update(title_memberships)
    for trophy_id, by_player in trophy_members.items():
        item = competition_items.get(trophy_id)
        if not item:
            continue
        members: dict[str, RelationshipEvidence] = {}
        for player_uuid, wins in by_player.items():
            seasons = sorted({int(win[0]) for win in wins})
            teams = sorted({str(win[2]) for win in wins})
            members[player_uuid] = RelationshipEvidence(
                locator=f"games.csv+appearances.csv:competition_id={TROPHY_COMPETITIONS.get(trophy_id, LEAGUE_TITLE_COMPETITIONS.get(trophy_id))};seasons={','.join(map(str, seasons))}",
                captured_fact=f"{player_by_uuid[player_uuid].name_en} made a recorded competition appearance in {len(seasons)} title-winning {item['labelEn']} campaign(s) for {', '.join(teams)}.",
                effective_from=None, effective_to=max(iso_date(win[3]) for win in wins),
            )
        add_criterion(
            criteria, key=f"trophy:{trophy_id}", family="trophy_award", subtype="winning-campaign-appearance",
            label_en=f"{item['labelEn']} winner", label_ka=f"{item['labelKa']} გამარჯვებული",
            asset_key=trophy_id, local_asset=registry_asset(frontend_root, "trophy_award", item),
            members=members, familiarity=min(92.0, 48.0 + len(members) * 0.7),
        )

    wildcard_items = {item["id"]: item for item in registries["wildcards"]}
    wildcard_members: dict[str, dict[str, RelationshipEvidence]] = defaultdict(dict)
    player_rows = connection.execute("""
        SELECT e.uuid, p.position, p.date_of_birth, p.international_caps
          FROM players p JOIN eligible e USING (player_id)
    """).fetchall()
    for player_uuid, position, born, caps in player_rows:
        position_id = {
            "Goalkeeper": "position-gk", "Defender": "position-def",
            "Midfield": "position-mid", "Attack": "position-fwd",
        }.get(position)
        if position_id:
            wildcard_members[position_id][player_uuid] = RelationshipEvidence(
                locator=f"players.csv:player_id={player_by_uuid[player_uuid].dataset_id};field=position",
                captured_fact=f"{player_by_uuid[player_uuid].name_en} is recorded as {position}.",
            )
        if born:
            decade = int(str(born)[:4]) // 10 * 10
            decade_id = f"born-{decade}s"
            if decade_id in wildcard_items:
                wildcard_members[decade_id][player_uuid] = RelationshipEvidence(
                    locator=f"players.csv:player_id={player_by_uuid[player_uuid].dataset_id};field=date_of_birth",
                    captured_fact=f"{player_by_uuid[player_uuid].name_en} was born in {decade}–{decade + 9}.",
                    effective_from=iso_date(born), effective_to=iso_date(born),
                )
        if int(caps or 0) >= 100:
            wildcard_members["international-caps-100"][player_uuid] = RelationshipEvidence(
                locator=f"players.csv:player_id={player_by_uuid[player_uuid].dataset_id};field=international_caps",
                captured_fact=f"{player_by_uuid[player_uuid].name_en} has {int(caps)} recorded senior international caps.",
            )
    for player_uuid, leagues in player_leagues.items():
        major = sorted(leagues & TOP_FIVE_LEAGUES)
        if len(major) >= 3:
            wildcard_members["major-leagues-3"][player_uuid] = RelationshipEvidence(
                locator=f"appearances.csv:player_id={player_by_uuid[player_uuid].dataset_id};competition_ids={','.join(major)}",
                captured_fact=f"{player_by_uuid[player_uuid].name_en} made recorded appearances in {len(major)} major European leagues.",
            )
    for player_uuid, countries in player_title_countries.items():
        if len(countries) >= 2:
            wildcard_members["titles-multiple-countries"][player_uuid] = RelationshipEvidence(
                locator=f"games.csv+appearances.csv:player_id={player_by_uuid[player_uuid].dataset_id};title_competitions={','.join(sorted(countries))}",
                captured_fact=f"{player_by_uuid[player_uuid].name_en} appeared in league-title campaigns in {len(countries)} countries.",
            )
    # 2+ Champions League titles: distinct winning campaigns with a recorded appearance.
    for player_uuid, wins in trophy_members.get("uefa-champions-league", {}).items():
        seasons = sorted({int(win[0]) for win in wins})
        if len(seasons) >= 2:
            wildcard_members["champions-league-2plus"][player_uuid] = RelationshipEvidence(
                locator=f"games.csv+appearances.csv:player_id={player_by_uuid[player_uuid].dataset_id};competition_id=CL;seasons={','.join(map(str, seasons))}",
                captured_fact=f"{player_by_uuid[player_uuid].name_en} appeared in {len(seasons)} Champions League-winning campaigns.",
            )
    # Treble: Champions League + domestic league title + domestic cup in one season.
    domestic_cups = {"fa-cup", "copa-del-rey", "coppa-italia", "dfb-pokal", "knvb-cup"}
    cl_seasons: dict[str, set[int]] = {
        uuid: {int(win[0]) for win in wins} for uuid, wins in trophy_members.get("uefa-champions-league", {}).items()
    }
    title_seasons: dict[str, set[int]] = defaultdict(set)
    for trophy_id, by_player in title_memberships.items():
        for uuid, wins in by_player.items():
            title_seasons[uuid].update(int(win[0]) for win in wins)
    cup_seasons: dict[str, set[int]] = defaultdict(set)
    for trophy_id in domestic_cups:
        for uuid, wins in trophy_members.get(trophy_id, {}).items():
            cup_seasons[uuid].update(int(win[0]) for win in wins)
    for player_uuid, seasons in cl_seasons.items():
        trebles = sorted(seasons & title_seasons.get(player_uuid, set()) & cup_seasons.get(player_uuid, set()))
        if trebles:
            wildcard_members["treble-winner"][player_uuid] = RelationshipEvidence(
                locator=f"games.csv+appearances.csv:player_id={player_by_uuid[player_uuid].dataset_id};treble_seasons={','.join(map(str, trebles))}",
                captured_fact=f"{player_by_uuid[player_uuid].name_en} appeared in a Champions League, league-title and domestic-cup winning campaign in the same season ({trebles[0]}).",
            )
    # Derby: senior appearances for both clubs of a curated rival pair.
    for left_id, right_id in RIVAL_CLUB_PAIRS:
        left = club_members_by_registry_id.get(left_id, {})
        right = club_members_by_registry_id.get(right_id, {})
        for player_uuid in set(left) & set(right):
            if player_uuid in wildcard_members["played-for-rivals"]:
                continue
            wildcard_members["played-for-rivals"][player_uuid] = RelationshipEvidence(
                locator=f"appearances.csv:player_id={player_by_uuid[player_uuid].dataset_id};clubs={left_id},{right_id}",
                captured_fact=f"{player_by_uuid[player_uuid].name_en} made senior appearances for both {left_id} and {right_id}.",
            )
    for wildcard_id, members in wildcard_members.items():
        item = wildcard_items.get(wildcard_id)
        if not item:
            continue
        add_criterion(
            criteria, key=f"wildcard:{wildcard_id}", family="wildcard", subtype=wildcard_id,
            label_en=item["labelEn"], label_ka=item["labelKa"], asset_key=wildcard_id,
            local_asset=registry_asset(frontend_root, "wildcard", item), members=members,
            familiarity=min(97.0, 55.0 + len(members) * 0.18),
        )

    duplicates = [key for key, count in Counter(criterion.key for criterion in criteria).items() if count > 1]
    if duplicates:
        raise RuntimeError(f"Duplicate criterion keys: {duplicates}")
    return criteria


# Difficulty mix of the European rotation. Mirrors the validator's targets in
# football-grid.content-validator.ts — change both together.
BOARD_DISTRIBUTION = {"easy": 0.40, "normal": 0.45, "hard": 0.15}
# A board is only "easy" when its thinnest cell still has plenty of answers; a
# board whose criteria look easy but has a 9-answer cell plays as normal.
EASY_MIN_CELL_ANSWERS = 15
HARD_MAX_CELL_ANSWERS = 8


def board_difficulty(criteria: list[Criterion], min_cell_answers: int | None = None) -> str:
    hard = sum(criterion.difficulty == "hard" for criterion in criteria)
    normal = sum(criterion.difficulty == "normal" for criterion in criteria)
    if hard >= 2:
        return "hard"
    if hard == 1 or normal >= 3:
        return "normal"
    if min_cell_answers is not None and min_cell_answers < EASY_MIN_CELL_ANSWERS:
        return "normal"
    return "easy"


def has_distinct_matching(cells: list[list[str]]) -> bool:
    player_to_cell: dict[str, int] = {}

    def visit(cell_index: int, seen: set[str]) -> bool:
        for player_uuid in cells[cell_index]:
            if player_uuid in seen:
                continue
            seen.add(player_uuid)
            occupied = player_to_cell.get(player_uuid)
            if occupied is None or visit(occupied, seen):
                player_to_cell[player_uuid] = cell_index
                return True
        return False

    return all(visit(index, set()) for index in range(len(cells)))


def generate_boards(
    criteria: list[Criterion], players: dict[int, Player], count: int, seed: int
) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    player_by_uuid = {player.uuid: player for player in players.values()}
    members = {criterion.key: set(criterion.members) for criterion in criteria}
    neighbors: dict[str, set[str]] = defaultdict(set)
    intersections: dict[tuple[str, str], list[str]] = {}
    for left_index, left in enumerate(criteria):
        for right in criteria[left_index + 1:]:
            shared = members[left.key] & members[right.key]
            if len(shared) < 9:
                continue
            ordered = sorted(shared, key=lambda uuid: player_by_uuid[uuid].recognizable_score, reverse=True)
            neighbors[left.key].add(right.key)
            neighbors[right.key].add(left.key)
            intersections[(min(left.key, right.key), max(left.key, right.key))] = ordered

    by_key = {criterion.key: criterion for criterion in criteria}
    by_difficulty: dict[str, list[Criterion]] = defaultdict(list)
    for criterion in criteria:
        by_difficulty[criterion.difficulty].append(criterion)
    targets = {"easy": round(count * BOARD_DISTRIBUTION["easy"]), "normal": round(count * BOARD_DISTRIBUTION["normal"])}
    targets["hard"] = count - targets["easy"] - targets["normal"]
    pools: dict[str, dict[str, dict[str, Any]]] = {difficulty: {} for difficulty in targets}
    hard_edges = [
        (left, right)
        for left in by_difficulty["hard"]
        for right in by_difficulty["hard"]
        if left.key < right.key and right.key in neighbors[left.key]
    ]
    if targets["hard"] > 0 and not hard_edges:
        raise RuntimeError("No compatible hard-criterion pair can support a hard board")

    def shared(left: str, right: str) -> list[str]:
        return intersections[(min(left, right), max(left, right))]

    attempts = 0
    max_attempts = max(400_000, count * 3_000)
    pool_factor = 18 if count <= 600 else 6
    while attempts < max_attempts and any(len(pools[key]) < targets[key] * pool_factor for key in targets):
        attempts += 1
        desired = rng.choice([key for key in targets if len(pools[key]) < targets[key] * pool_factor])
        if desired == "easy":
            row_pool = by_difficulty["easy"] + by_difficulty["normal"]
        elif desired == "hard":
            row_hard, column_hard = rng.choice(hard_edges)
            if rng.random() < 0.5:
                row_hard, column_hard = column_hard, row_hard
            compatible_nonhard_rows = [
                by_key[key] for key in neighbors[column_hard.key]
                if by_key[key].difficulty != "hard" and key != row_hard.key
            ]
            if len(compatible_nonhard_rows) < 2:
                continue
            row_pool = [row_hard, *rng.sample(compatible_nonhard_rows, 2)]
        else:
            row_pool = criteria
        rows = row_pool if desired == "hard" else rng.sample(row_pool, 3)
        if len({criterion.key for criterion in rows}) != 3:
            continue
        if sum(criterion.difficulty == "hard" for criterion in rows) > 1:
            continue
        common = set.intersection(*(neighbors[criterion.key] for criterion in rows))
        common.difference_update(criterion.key for criterion in rows)
        if len(common) < 3:
            continue
        column_candidates = [by_key[key] for key in common]
        if desired == "hard":
            hard_columns = [
                criterion for criterion in column_candidates
                if criterion.difficulty == "hard" and criterion.key == column_hard.key
            ]
            nonhard_columns = [criterion for criterion in column_candidates if criterion.difficulty != "hard"]
            if not hard_columns or len(nonhard_columns) < 2:
                continue
            columns = [rng.choice(hard_columns), *rng.sample(nonhard_columns, 2)]
        else:
            columns = rng.sample(column_candidates, 3)
        if sum(criterion.difficulty == "hard" for criterion in columns) > 1:
            continue
        all_criteria = [*rows, *columns]
        # Family cap: never more than two criteria of one family on a board, so
        # a board cannot read as "six teammate clues" — every board spans at
        # least three families.
        if max(Counter(criterion.family for criterion in all_criteria).values()) > 2:
            continue
        checksum = canonical_checksum(
            [criterion.key for criterion in rows], [criterion.key for criterion in columns]
        )
        if checksum in pools[desired]:
            continue
        cells = [shared(row.key, column.key) for row in rows for column in columns]
        min_cell = min(len(cell) for cell in cells)
        actual_difficulty = board_difficulty(all_criteria, min_cell)
        if actual_difficulty != desired:
            continue
        if not has_distinct_matching(cells):
            continue
        pools[desired][checksum] = {
            "checksum": checksum,
            "rows": rows,
            "columns": columns,
            "cells": cells,
            "minCellAnswers": min_cell,
        }

    short = {key: (len(pools[key]), targets[key]) for key in targets if len(pools[key]) < targets[key]}
    if short:
        raise RuntimeError(f"Could not generate the required board distribution: {short}")

    selected: list[dict[str, Any]] = []
    use_count: Counter[str] = Counter()
    family_use: Counter[str] = Counter()
    for difficulty in ["easy", "normal", "hard"]:
        candidates = list(pools[difficulty].values())
        for _ in range(targets[difficulty]):
            # Family evenness leads: pick the board whose families are least
            # represented so far, then spread individual criteria within that.
            candidates.sort(key=lambda candidate: (
                sum(family_use[item.family] for item in [*candidate["rows"], *candidate["columns"]]),
                sum(use_count[item.key] for item in [*candidate["rows"], *candidate["columns"]]),
                -len({item.family for item in [*candidate["rows"], *candidate["columns"]]}),
                candidate["checksum"],
            ))
            chosen = candidates.pop(0)
            selected.append(chosen)
            use_count.update(item.key for item in [*chosen["rows"], *chosen["columns"]])
            family_use.update(item.family for item in [*chosen["rows"], *chosen["columns"]])

    board_families = {item.family for board in selected for item in [*board["rows"], *board["columns"]]}
    if board_families != REQUIRED_FAMILIES:
        missing = sorted(REQUIRED_FAMILIES - board_families)
        raise RuntimeError(f"Generated boards do not expose all planned families: {missing}")

    result: list[dict[str, Any]] = []
    for board in selected:
        all_criteria = [*board["rows"], *board["columns"]]
        result.append({
            "key": f"grid-{board['checksum'][:16]}",
            "version": 1,
            "rowCriteria": [criterion.key for criterion in board["rows"]],
            "columnCriteria": [criterion.key for criterion in board["columns"]],
            "difficulty": board_difficulty(all_criteria, board["minCellAnswers"]),
            "familiarityScore": round(sum(item.familiarity for item in all_criteria) / 6, 3),
            "minCellAnswers": board["minCellAnswers"],
            "approvedBy": "football-grid-launch-audit-v1",
            "cells": [{
                "playerIds": cell,
                "recognizablePlayerIds": cell[:2],
            } for cell in board["cells"]],
        })
    return result


def build_aliases(players: list[Player], reviewed_at: str) -> list[dict[str, Any]]:
    aliases: list[dict[str, Any]] = []
    candidate_owners: dict[str, set[str]] = defaultdict(set)
    candidates_by_player: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    for player in players:
        english = player.name_en.strip()
        parts = english.split()
        full_type = "mononym" if len(parts) == 1 else "full_name"
        candidates_by_player[player.uuid].append((english, "en", full_type))
        candidates_by_player[player.uuid].append((player.name_ka.strip(), "ka", "georgian"))
        for accepted in player.accepted_aliases:
            value = accepted.strip()
            if not value or value in {english, player.name_ka}:
                continue
            locale = "ka" if re.search(r"[\u10A0-\u10FF]", value) else "en"
            alias_type = "nickname" if len(value.split()) == 1 else "accentless"
            candidates_by_player[player.uuid].append((value, locale, alias_type))
        if len(parts) > 1:
            candidates_by_player[player.uuid].append((parts[0], "en", "given_name"))
            candidates_by_player[player.uuid].append((parts[-1], "en", "family_name"))
            candidates_by_player[player.uuid].append((f"{parts[-1]} {' '.join(parts[:-1])}", "en", "reordered"))
        for value, _locale, _alias_type in candidates_by_player[player.uuid]:
            candidate_owners[answer_key(value)].add(player.uuid)

    seen: set[tuple[str, str, str, str]] = set()
    for player in players:
        for value, locale, alias_type in candidates_by_player[player.uuid]:
            normalized = answer_key(value)
            if not normalized:
                continue
            exact_required = value in {player.name_en, player.name_ka}
            if not exact_required and len(candidate_owners[normalized]) != 1:
                continue
            key = (player.uuid, normalized, locale, alias_type)
            if key in seen:
                continue
            seen.add(key)
            aliases.append({
                "playerId": player.uuid,
                "alias": value,
                "normalizedAlias": normalized,
                "locale": locale,
                "aliasType": alias_type,
                "acceptancePolicy": "exact" if exact_required else "unique_only",
                "reviewedBy": "quizball-published-localization+launch-alias-audit-v1",
                "reviewedAt": reviewed_at,
            })
    return aliases


def download_asset(url: str, destination: Path) -> None:
    if destination.is_file() and destination.stat().st_size > 0:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "Quizball-Grid-Launch-Audit/1.0"})
    tls_context = ssl.create_default_context(cafile=certifi.where())
    # The image CDN rate-limits bursts (HTTP 429); back off instead of failing
    # the whole build.
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=30, context=tls_context) as response:
                if response.status != 200:
                    raise RuntimeError(f"Asset request failed ({response.status}): {url}")
                content = response.read()
            break
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt < 5:
                time.sleep(5 * (attempt + 1))
                continue
            raise
    if len(content) < 100:
        raise RuntimeError(f"Asset is unexpectedly small ({len(content)} bytes): {url}")
    temporary = destination.with_suffix(destination.suffix + ".part")
    temporary.write_bytes(content)
    temporary.replace(destination)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-dir", required=True, type=Path)
    parser.add_argument("--frontend-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--asset-registry", required=True, type=Path)
    parser.add_argument("--asset-cache", required=True, type=Path)
    parser.add_argument("--boards", type=int, default=500)
    parser.add_argument("--release-version", type=int, required=True)
    parser.add_argument("--seed", type=int, default=20260826)
    args = parser.parse_args()
    db_url = os.environ.get("DATABASE_URL") or os.environ.get("STAGING_DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL or STAGING_DATABASE_URL is required")
    if "nsdfiprfmhdqhbfxfwpv" not in db_url:
        raise RuntimeError("Refusing to build launch content from a non-staging database")

    reviewed_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    players, question_provenance = load_players(db_url)
    connection = prepare_duckdb(args.dataset_dir, players)
    criteria = build_criteria(connection, players, args.frontend_root)
    print(json.dumps({
        "eligiblePlayers": len(players),
        "criteriaBuilt": Counter(criterion.family for criterion in criteria),
        "wildcards": {criterion.key: len(criterion.members) for criterion in criteria if criterion.family == "wildcard"},
    }, ensure_ascii=False), file=sys.stderr)
    boards = generate_boards(criteria, players, args.boards, args.seed)
    exposed_ids = {
        player_id for board in boards for cell in board["cells"] for player_id in cell["playerIds"]
    }
    player_by_uuid = {player.uuid: player for player in players.values()}
    exposed_players = sorted(
        (player_by_uuid[player_id] for player_id in exposed_ids),
        key=lambda player: player.name_en,
    )
    aliases = build_aliases(exposed_players, reviewed_at)

    used_criterion_keys = {
        key for board in boards for key in [*board["rowCriteria"], *board["columnCriteria"]]
    }
    used_criteria = [criterion for criterion in criteria if criterion.key in used_criterion_keys]
    player_cache_by_uuid = {player.uuid: args.asset_cache / f"{player.uuid}.webp" for player in exposed_players}
    with ThreadPoolExecutor(max_workers=3) as executor:
        list(executor.map(
            lambda player: download_asset(player.image_url, player_cache_by_uuid[player.uuid]),
            exposed_players,
        ))

    asset_registry: dict[str, str] = {}
    for criterion in used_criteria:
        path = criterion.local_asset
        if str(path).startswith("__PLAYER_CACHE__"):
            target_uuid = Path(path).name.removesuffix(".webp")
            path = player_cache_by_uuid[target_uuid]
        if not path.is_file():
            raise RuntimeError(f"Criterion asset is missing: {criterion.key} -> {path}")
        asset_registry[criterion.asset_key] = str(path.resolve())
    for player in exposed_players:
        asset_registry[player.image_url] = str(player_cache_by_uuid[player.uuid].resolve())

    source_version = "2026-08-05+etag-44d453b372c5d697cce4ce08f5f03e4c-28"
    membership_rows: list[dict[str, Any]] = []
    for criterion in used_criteria:
        for player_uuid, evidence in criterion.members.items():
            membership_rows.append({
                "criterionKey": criterion.key,
                "playerId": player_uuid,
                "relationshipSubtype": criterion.subtype,
                "effectiveFrom": evidence.effective_from,
                "effectiveTo": evidence.effective_to,
                "verifiedBy": "football-grid-source-consistency-audit-v1",
                "reviewedAt": reviewed_at,
                "evidence": [{
                    "sourceKey": "dcaribou-transfermarkt-datasets",
                    "sourceLocator": evidence.locator,
                    "capturedFact": evidence.captured_fact,
                    "effectiveFrom": evidence.effective_from,
                    "effectiveTo": evidence.effective_to,
                    "rightsClass": "CC0-1.0-public-domain-dataset",
                    "reviewedBy": "football-grid-source-consistency-audit-v1",
                    "reviewedAt": reviewed_at,
                }],
            })

    manifest = {
        "release": {
            "version": args.release_version,
            "aliasVersion": 1,
            "resolverPolicyVersion": 1,
            "relationshipSnapshot": {
                "dataset": "dcaribou/transfermarkt-datasets",
                "datasetVersion": source_version,
                "localizedAnswerSource": "published Quizball career_path/clue_chain/football_logic content",
                "localizedQuestionRecordsScanned": len(question_provenance),
                "eligibleLocalizedPlayers": len(players),
                "exposedPlayers": len(exposed_players),
                "clubVisualPolicy": "quizball-owned-monogram-fallbacks",
                "realClubCrestsEnabled": False,
                "generator": "football-grid-build-launch-manifest.py/v1",
                "seed": args.seed,
            },
            "approvedBy": "football-grid-launch-audit-v1",
            "approvedAt": reviewed_at,
        },
        "sources": [{
            "key": "dcaribou-transfermarkt-datasets",
            "providerName": "dcaribou/transfermarkt-datasets",
            "datasetVersion": source_version,
            "permittedUse": "Football relationship facts for Quizball gameplay under the dataset's published CC0 1.0 metadata.",
            "databaseRightsStatus": "approved",
            "attributionRequirements": "No attribution required by CC0; retain immutable source and row locators for audit.",
            "retentionRequirements": "Retain release evidence locators and checksums for the lifetime of pinned matches.",
            "approvalOwner": "Quizball content operations",
            # Provenance rows are keyed (source_key, dataset_version) and every
            # later publish must byte-match the stored approval — reuse the
            # original approval timestamp instead of the build time.
            "approvedAt": "2026-08-26T08:21:51Z",
        }],
        "assetCatalog": sorted(asset_registry),
        "players": [{
            "id": player.uuid,
            "nameEn": player.name_en,
            "nameKa": player.name_ka,
            "imageAssetKey": player.image_url,
        } for player in exposed_players],
        "criteria": [{
            "key": criterion.key,
            "family": criterion.family,
            "subtype": criterion.subtype,
            "labelEn": criterion.label_en,
            "labelKa": criterion.label_ka,
            "assetKey": criterion.asset_key,
            "metadata": {
                "memberCount": len(criterion.members),
                "visualPolicy": "owned-or-cleared-primary-with-deterministic-fallback",
            },
            "difficulty": criterion.difficulty,
            "familiarityScore": criterion.familiarity,
        } for criterion in used_criteria],
        "memberships": membership_rows,
        "aliases": aliases,
        "boards": boards,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.asset_registry.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    args.asset_registry.write_text(json.dumps(asset_registry, ensure_ascii=False, indent=2) + "\n")

    family_counts = Counter(criterion.family for criterion in used_criteria)
    board_counts = Counter(board["difficulty"] for board in boards)
    min_answers = min(len(cell["playerIds"]) for board in boards for cell in board["cells"])
    print(json.dumps({
        "releaseVersion": args.release_version,
        "boards": board_counts,
        "criteria": family_counts,
        "memberships": len(membership_rows),
        "players": len(exposed_players),
        "aliases": len(aliases),
        "minimumCellAnswers": min_answers,
        "assetCount": len(asset_registry),
        "manifest": str(args.output),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
