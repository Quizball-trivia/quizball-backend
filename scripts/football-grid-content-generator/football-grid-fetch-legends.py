#!/usr/bin/env python3
"""Resolve the curated legends list against Wikidata and write legends.json:
career clubs / national teams with years, nationality, birth date, position,
awards, Transfermarkt id and portrait. Every fact keeps its Wikidata locator so
the release evidence stays auditable (Wikidata content is CC0)."""
import json, ssl, sys, time, urllib.parse, urllib.request
from pathlib import Path

try:
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # system python without certifi
    SSL_CONTEXT = ssl.create_default_context()

UA = "QuizballGridLegends/1.0 (nika@quizball.io)"
API = "https://www.wikidata.org/w/api.php"
FOOTBALLER = "Q937857"  # association football player
NATIONAL_TEAM = "Q6979593"  # national association football team
POSITION_GROUP = {"Q201330": "GK", "Q336286": "DEF", "Q193592": "MID", "Q280658": "FWD", "Q2020703": "DEF", "Q1273541": "MID", "Q1145062": "FWD"}

def get(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30, context=SSL_CONTEXT) as r:
                return json.load(r)
        except Exception as error:  # noqa: BLE001
            if attempt == 3: raise
            time.sleep(1.5 * (attempt + 1))

def search(name):
    q = urllib.parse.urlencode({"action": "wbsearchentities", "search": name, "language": "en", "type": "item", "limit": 6, "format": "json"})
    hits = get(f"{API}?{q}").get("search", [])
    for hit in hits:
        desc = (hit.get("description") or "").lower()
        if "footballer" in desc or "football player" in desc or "association football" in desc:
            return hit["id"], desc
    # Managers, politicians and club owners describe themselves otherwise;
    # fall back to the occupation claim.
    for hit in hits:
        claims = entity(hit["id"]).get("claims", {})
        if FOOTBALLER in ids(claims, "P106") and claims.get("P54"):
            return hit["id"], f"occupation:{hit.get('description') or ''}"
    return None, None

def entity(qid):
    return get(f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json")["entities"][qid]

def year(claim, prop):
    for qual in claim.get("qualifiers", {}).get(prop, []):
        value = qual.get("datavalue", {}).get("value", {})
        if isinstance(value, dict) and value.get("time"): return int(value["time"][1:5])
    return None

def ids(claims, prop):
    return [c["mainsnak"]["datavalue"]["value"]["id"] for c in claims.get(prop, []) if "datavalue" in c["mainsnak"]]

def labels(qids):
    out = {}
    qids = sorted(set(qids))
    for i in range(0, len(qids), 50):
        chunk = qids[i:i + 50]
        q = urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(chunk), "props": "labels|claims", "languages": "en", "format": "json"})
        data = get(f"{API}?{q}")["entities"]
        for qid, ent in data.items():
            claims = ent.get("claims", {})
            instance = ids(claims, "P31")
            country = ids(claims, "P17")
            out[qid] = {"label": ent.get("labels", {}).get("en", {}).get("value", qid), "national": NATIONAL_TEAM in instance, "countryQid": country[0] if country else None}
    return out

def main():
    src = Path(sys.argv[1]); dest = Path(sys.argv[2])
    rows = []
    for line in src.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"): continue
        name, _, pinned = line.partition("|")
        rows.append((name.strip(), pinned.strip() or None))
    legends, failed, team_qids, country_qids = [], [], set(), set()
    for name, pinned in rows:
        qid, desc = (pinned, "pinned") if pinned else search(name)
        if not qid:
            failed.append({"name": name, "reason": "no footballer item"}); print(f"✗ {name}: not found"); continue
        claims = entity(qid)["claims"]
        teams = []
        for claim in claims.get("P54", []):
            if "datavalue" not in claim["mainsnak"]: continue
            teams.append({"qid": claim["mainsnak"]["datavalue"]["value"]["id"], "start": year(claim, "P580"), "end": year(claim, "P582")})
        team_qids.update(t["qid"] for t in teams)
        citizenship = ids(claims, "P27"); country_qids.update(citizenship)
        dob = next((c["mainsnak"]["datavalue"]["value"]["time"][1:11] for c in claims.get("P569", []) if "datavalue" in c["mainsnak"]), None)
        positions = ids(claims, "P413")
        tm = next((c["mainsnak"]["datavalue"]["value"] for c in claims.get("P2446", []) if "datavalue" in c["mainsnak"]), None)
        image = next((c["mainsnak"]["datavalue"]["value"] for c in claims.get("P18", []) if "datavalue" in c["mainsnak"]), None)
        awards = ids(claims, "P166")
        legends.append({"name": name, "qid": qid, "transfermarktId": tm, "dateOfBirth": dob, "citizenshipQids": citizenship,
                        "positionQids": positions, "positionGroup": next((POSITION_GROUP[p] for p in positions if p in POSITION_GROUP), None),
                        "teams": teams, "awardQids": awards, "image": image})
        print(f"✔ {name} {qid} tm={tm} teams={len(teams)} awards={len(awards)}")
        time.sleep(0.2)
    team_info = labels(team_qids | country_qids | {a for l in legends for a in l["awardQids"]})
    for legend in legends:
        for team in legend["teams"]:
            info = team_info.get(team["qid"], {}); team["label"] = info.get("label", team["qid"]); team["national"] = info.get("national", False)
        legend["citizenship"] = [team_info.get(q, {}).get("label", q) for q in legend["citizenshipQids"]]
        legend["awards"] = [team_info.get(q, {}).get("label", q) for q in legend["awardQids"]]
    dest.write_text(json.dumps({"fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source": "wikidata", "legends": legends, "failed": failed}, ensure_ascii=False, indent=1) + "\n")
    print(f"\n{len(legends)} legends resolved, {len(failed)} failed → {dest}")

if __name__ == "__main__":
    main()
