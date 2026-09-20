#!/usr/bin/env python3
"""Upserts legends.json into football_players on STAGING/local: numeric
Transfermarkt id + Wikidata id on the existing `legend:*` rows (keeps their uuid
and portrait), new rows for legends we never had (portrait = Commons file via
Special:FilePath, mirrored to the CDN by football-grid-player-cdn.ts --pool)."""
import json, os, sys, urllib.parse
import psycopg

db = os.environ.get("DATABASE_URL", "")
if "nsdfiprfmhdqhbfxfwpv" not in db and "localhost" not in db and "127.0.0.1" not in db:
    raise SystemExit("Refusing to run outside staging/local")
data = json.load(open(sys.argv[1]))
apply = "--apply" in sys.argv
updated = inserted = skipped = 0
with psycopg.connect(db) as conn, conn.cursor() as cur:
    # One pass over the table (50k wide rows) instead of a scan per legend.
    wanted_tm = [str(l.get("transfermarktId")) for l in data["legends"] if str(l.get("transfermarktId") or "").isdigit()]
    cur.execute("SELECT transfermarkt_id FROM football_players WHERE transfermarkt_id = ANY(%s)", (wanted_tm,))
    existing_tm = {row[0] for row in cur.fetchall()}
    cur.execute("SELECT id, image_url, lower(name) FROM football_players WHERE transfermarkt_id LIKE 'legend:%%'")
    legend_rows = {row[2]: (row[0], row[1]) for row in cur.fetchall()}
    for legend in data["legends"]:
        tm = str(legend.get("transfermarktId") or "")
        if not tm.isdigit():
            skipped += 1; continue
        if tm in existing_tm:
            skipped += 1; continue
        payload = {"source": "wikidata", "qid": legend["qid"], "image": legend.get("image"), "awards": legend.get("awards", [])}
        nationality = (legend.get("citizenship") or [None])[0]
        image = legend.get("image")
        image_url = f"https://commons.wikimedia.org/wiki/Special:FilePath/{urllib.parse.quote(image)}?width=512" if image else None
        row = legend_rows.get(legend["name"].lower())
        if row:
            if apply:
                cur.execute("""UPDATE football_players SET transfermarkt_id = %s, wikidata_id = %s, date_of_birth = COALESCE(date_of_birth, %s::date),
                               nationality = COALESCE(nationality, %s), position_group = COALESCE(position_group, %s), active_status = 'legend',
                               fame_bucket = COALESCE(fame_bucket, 'legend'), data_quality_status = 'usable',
                               source_payload = source_payload || %s::jsonb, updated_at = now() WHERE id = %s""",
                            (tm, legend["qid"], legend.get("dateOfBirth"), nationality, legend.get("positionGroup"), json.dumps(payload), row[0]))
            updated += 1
        else:
            if apply:
                cur.execute("""INSERT INTO football_players (transfermarkt_id, wikidata_id, name, nationality, position_group, date_of_birth,
                               active_status, image_url, fame_bucket, data_quality_status, source_payload)
                               VALUES (%s, %s, %s, %s, %s, %s::date, 'legend', %s, 'legend', 'usable', %s::jsonb)""",
                            (tm, legend["qid"], legend["name"], nationality, legend.get("positionGroup"), legend.get("dateOfBirth"), image_url, json.dumps(payload)))
            inserted += 1
    if apply:
        conn.commit()
print(json.dumps({"apply": apply, "updatedLegendRows": updated, "insertedNew": inserted, "skippedExisting": skipped}))
