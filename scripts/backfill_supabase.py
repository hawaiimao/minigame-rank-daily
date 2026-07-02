"""
One-shot backfill: replay every JSON snapshot in data/ into Supabase.

Idempotent — running twice is safe (all writes are upserts on primary keys).

Usage (run locally, needs env vars):
  export SUPABASE_URL=https://xxx.supabase.co
  export SUPABASE_SERVICE_KEY=<your service role key>
  python scripts/backfill_supabase.py

What it writes:
  - games                    (from data/base/games.json)
  - game_board_history       (from data/base/games.json → board_history)
  - publisher_status         (stat fields only; status/note preserved)
  - publisher_board_history  (from data/base/publishers.json → board_history)
  - daily_snapshots          (from every data/daily/*.json)
  - daily_diffs              (from every data/diff/*.json)
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Reuse helpers from the CI sync script.
from ci_sync_supabase import (          # noqa: E402
    sb_request, upsert_batch, _post_ignore_duplicates, env,
)

ROOT = HERE.parent
DAILY = ROOT / "data" / "daily"
DIFF = ROOT / "data" / "diff"
BASE = ROOT / "data" / "base"


def log(msg):
    print(msg, flush=True)


# ---------------- BASE tables ----------------

def backfill_games(base_url, service_key):
    """From data/base/games.json → games + game_board_history."""
    p = BASE / "games.json"
    if not p.exists():
        log("[backfill] no games.json — skipping")
        return
    data = json.loads(p.read_text(encoding="utf-8"))
    games_dict = data.get("games", {})
    if not games_dict:
        log("[backfill] games.json empty")
        return

    games_rows = []
    board_rows = []
    for name, g in games_dict.items():
        first_seen = g.get("first_seen_anywhere")
        # Compute overall last_seen as max of all board_history last_seen.
        board_hist = g.get("board_history", {}) or {}
        last_seen = first_seen
        for bkey, bh in board_hist.items():
            ls = bh.get("last_seen")
            if ls and (last_seen is None or ls > last_seen):
                last_seen = ls
        # Publisher / category — take the first non-empty entry.
        pub = None
        for p_ in g.get("publishers", []) or []:
            if p_:
                pub = p_
                break
        cat = None
        for c_ in g.get("categories", []) or []:
            if c_:
                cat = c_
                break
        games_rows.append({
            "name": name,
            "first_seen_at": first_seen,
            "last_seen_at": last_seen,
            "publisher_name": pub,
            "category": cat,
        })
        for bkey, bh in board_hist.items():
            plat, _, board = bkey.partition("/")
            board_rows.append({
                "game_name": name,
                "platform": plat,
                "board": board,
                "first_seen": bh.get("first_seen"),
                "last_seen": bh.get("last_seen"),
                "best_rank": bh.get("best_rank"),
                "appearances": bh.get("appearances", 1),
            })

    n = upsert_batch(base_url, service_key, "games", games_rows,
                     on_conflict="name")
    log(f"[backfill] games: {n}")
    n = upsert_batch(base_url, service_key,
                     "game_board_history", board_rows,
                     on_conflict="game_name,platform,board")
    log(f"[backfill] game_board_history: {n}")


def backfill_publishers(base_url, service_key):
    """From data/base/publishers.json → publisher_status stats +
    publisher_board_history. Preserves status/note on existing rows."""
    p = BASE / "publishers.json"
    if not p.exists():
        log("[backfill] no publishers.json — skipping")
        return
    data = json.loads(p.read_text(encoding="utf-8"))
    pubs_dict = data.get("publishers", {})
    if not pubs_dict:
        log("[backfill] publishers.json empty")
        return

    seed_rows = []
    board_rows = []
    for name, pub in pubs_dict.items():
        first_seen = pub.get("first_seen_anywhere")
        board_hist = pub.get("board_history", {}) or {}
        last_seen = first_seen
        for bkey, bh in board_hist.items():
            ls = bh.get("last_seen")
            if ls and (last_seen is None or ls > last_seen):
                last_seen = ls
        seed_rows.append({
            "publisher": name,
            "status": "pending",
            "note": "",
            "first_seen_at": first_seen,
            "last_seen_at": last_seen,
            "total_games": len(pub.get("games", []) or []),
            "total_boards": len(board_hist),
        })
        for bkey, bh in board_hist.items():
            plat, _, board = bkey.partition("/")
            board_rows.append({
                "publisher": name,
                "platform": plat,
                "board": board,
                "first_seen": bh.get("first_seen"),
                "last_seen": bh.get("last_seen"),
                "appearances": bh.get("appearances", 1),
            })

    # Insert-ignore-duplicates first (so existing rows keep status/note).
    _post_ignore_duplicates(base_url, service_key,
                            "publisher_status", seed_rows)
    log(f"[backfill] publisher_status seeds: {len(seed_rows)}")

    # Then PATCH stats-only for every publisher.
    import urllib.parse
    n = 0
    for row in seed_rows:
        patch_body = {
            "last_seen_at": row["last_seen_at"],
            "total_games": row["total_games"],
            "total_boards": row["total_boards"],
        }
        pub_encoded = urllib.parse.quote(row["publisher"], safe="")
        sb_request(
            base_url, service_key,
            f"/publisher_status?publisher=eq.{pub_encoded}",
            method="PATCH",
            body=patch_body,
            prefer="return=minimal",
        )
        n += 1
    log(f"[backfill] publisher_status stats patched: {n}")

    n = upsert_batch(base_url, service_key,
                     "publisher_board_history", board_rows,
                     on_conflict="publisher,platform,board")
    log(f"[backfill] publisher_board_history: {n}")


# ---------------- daily_snapshots ----------------

def backfill_daily_snapshots(base_url, service_key):
    files = sorted(DAILY.glob("*.json"))
    if not files:
        log("[backfill] daily/ empty")
        return
    total = 0
    for p in files:
        snap = json.loads(p.read_text(encoding="utf-8"))
        date = snap.get("date_beijing") or p.stem
        rows = []
        for plat_key, plat in snap.get("platforms", {}).items():
            for board in plat.get("boards", []):
                for r in board.get("rows", []):
                    if not r.get("name"):
                        continue
                    rows.append({
                        "snapshot_date": date,
                        "platform": plat_key,
                        "board": board.get("label"),
                        "rank": r.get("rank"),
                        "game_name": r["name"],
                        "publisher_name": r.get("publisher") or None,
                        "change_direction": r.get("change_direction"),
                        "change_raw": r.get("change"),
                        "category": r.get("category") or None,
                        "category_rank": r.get("category_rank"),
                        "subcategory": r.get("subcategory") or None,
                        "slogan": r.get("slogan") or None,
                    })
        n = upsert_batch(base_url, service_key,
                         "daily_snapshots", rows,
                         on_conflict="snapshot_date,platform,board,rank")
        log(f"[backfill] daily_snapshots {date}: {n}")
        total += n
    log(f"[backfill] daily_snapshots total: {total}")


# ---------------- daily_diffs ----------------

def backfill_daily_diffs(base_url, service_key):
    files = sorted(DIFF.glob("*.json"))
    if not files:
        log("[backfill] diff/ empty")
        return
    total = 0
    for p in files:
        diff = json.loads(p.read_text(encoding="utf-8"))
        date = diff.get("date") or p.stem
        rows = []
        for bkey, bdata in diff.get("boards", {}).items():
            plat = bdata.get("platform")
            board_label = bdata.get("board_label")
            # new_to_board is the merged bucket the frontend cares about.
            merged = bdata.get("new_to_board")
            if merged is None:
                merged = (bdata.get("first_anywhere") or []) \
                    + (bdata.get("first_on_board") or [])
            for r in merged:
                if not r.get("name"):
                    continue
                rows.append({
                    "snapshot_date": date,
                    "platform": plat,
                    "board": board_label,
                    "game_name": r["name"],
                    "category": "new_to_board",
                    "rank": r.get("rank"),
                    "publisher_name": r.get("publisher") or None,
                })
            for r in (bdata.get("returning") or []):
                if not r.get("name"):
                    continue
                rows.append({
                    "snapshot_date": date,
                    "platform": plat,
                    "board": board_label,
                    "game_name": r["name"],
                    "category": "returning",
                    "rank": r.get("rank"),
                    "publisher_name": r.get("publisher") or None,
                })
        n = upsert_batch(base_url, service_key,
                         "daily_diffs", rows,
                         on_conflict="snapshot_date,platform,board,game_name")
        log(f"[backfill] daily_diffs {date}: {n}")
        total += n
    log(f"[backfill] daily_diffs total: {total}")


def backfill_publishers_from_daily(base_url, service_key):
    """Replay all daily/*.json in date order to reconstruct each
    publisher's true first_seen_at (day it first appeared) and
    last_seen_at (most recent day). Also aggregates games and boards.

    Preserves any existing status/note in publisher_status."""
    files = sorted(DAILY.glob("*.json"))
    if not files:
        log("[backfill] daily/ empty, skip publisher rebuild")
        return

    # Aggregate across all daily snapshots.
    pubs = {}       # name -> dict(first_seen_at, last_seen_at, games:set, boards:set)
    board_hist = {} # (name, plat, board) -> dict(first_seen, last_seen, appearances)

    for p in files:
        snap = json.loads(p.read_text(encoding="utf-8"))
        day = snap.get("date_beijing") or p.stem
        for plat_key, plat in snap.get("platforms", {}).items():
            for board in plat.get("boards", []):
                board_label = board.get("label")
                for r in board.get("rows", []):
                    pub = r.get("publisher")
                    game = r.get("name")
                    if not pub:
                        continue
                    entry = pubs.get(pub)
                    if entry is None:
                        entry = {
                            "first_seen_at": day,
                            "last_seen_at": day,
                            "games": set(),
                            "boards": set(),
                        }
                        pubs[pub] = entry
                    else:
                        if day > entry["last_seen_at"]:
                            entry["last_seen_at"] = day
                        # Never move first_seen_at forward.
                    if game:
                        entry["games"].add(game)
                    entry["boards"].add(f"{plat_key}/{board_label}")

                    key = (pub, plat_key, board_label)
                    bh = board_hist.get(key)
                    if bh is None:
                        board_hist[key] = {
                            "first_seen": day,
                            "last_seen": day,
                            "days": {day},
                        }
                    else:
                        if day > bh["last_seen"]:
                            bh["last_seen"] = day
                        bh["days"].add(day)

    log(f"[backfill] replayed {len(files)} daily files → "
        f"{len(pubs)} publishers, {len(board_hist)} (pub,board) pairs")

    seed_rows = [
        {
            "publisher": name,
            "status": "pending",
            "note": "",
            "first_seen_at": e["first_seen_at"],
            "last_seen_at": e["last_seen_at"],
            "total_games": len(e["games"]),
            "total_boards": len(e["boards"]),
        }
        for name, e in pubs.items()
    ]
    _post_ignore_duplicates(base_url, service_key,
                            "publisher_status", seed_rows)
    log(f"[backfill] publisher_status seeds: {len(seed_rows)}")

    import urllib.parse
    n = 0
    for row in seed_rows:
        # Overwrite date + stat fields (do NOT touch status/note).
        # Because history was replayed, first_seen_at is now the
        # correct real date and safe to overwrite.
        patch_body = {
            "first_seen_at": row["first_seen_at"],
            "last_seen_at": row["last_seen_at"],
            "total_games": row["total_games"],
            "total_boards": row["total_boards"],
        }
        pub_encoded = urllib.parse.quote(row["publisher"], safe="")
        sb_request(
            base_url, service_key,
            f"/publisher_status?publisher=eq.{pub_encoded}",
            method="PATCH",
            body=patch_body,
            prefer="return=minimal",
        )
        n += 1
    log(f"[backfill] publisher_status stats overwritten: {n}")

    board_rows = [
        {
            "publisher": name,
            "platform": plat,
            "board": board,
            "first_seen": bh["first_seen"],
            "last_seen": bh["last_seen"],
            "appearances": len(bh["days"]),
        }
        for (name, plat, board), bh in board_hist.items()
    ]
    n = upsert_batch(base_url, service_key,
                     "publisher_board_history", board_rows,
                     on_conflict="publisher,platform,board")
    log(f"[backfill] publisher_board_history: {n}")


def backfill_games_from_daily(base_url, service_key):
    """Same idea for games: replay daily/* and record real first/last dates."""
    files = sorted(DAILY.glob("*.json"))
    if not files:
        return

    games = {}       # name -> {first_seen_at, last_seen_at, publisher, category}
    board_hist = {}  # (name, plat, board) -> {first_seen, last_seen, best_rank, days}

    for p in files:
        snap = json.loads(p.read_text(encoding="utf-8"))
        day = snap.get("date_beijing") or p.stem
        for plat_key, plat in snap.get("platforms", {}).items():
            for board in plat.get("boards", []):
                board_label = board.get("label")
                for r in board.get("rows", []):
                    name = r.get("name")
                    if not name:
                        continue
                    e = games.get(name)
                    if e is None:
                        e = {
                            "first_seen_at": day,
                            "last_seen_at": day,
                            "publisher": r.get("publisher") or None,
                            "category": r.get("category") or None,
                        }
                        games[name] = e
                    else:
                        if day > e["last_seen_at"]:
                            e["last_seen_at"] = day
                        if not e["publisher"] and r.get("publisher"):
                            e["publisher"] = r["publisher"]
                        if not e["category"] and r.get("category"):
                            e["category"] = r["category"]

                    key = (name, plat_key, board_label)
                    bh = board_hist.get(key)
                    if bh is None:
                        board_hist[key] = {
                            "first_seen": day,
                            "last_seen": day,
                            "best_rank": r.get("rank"),
                            "days": {day},
                        }
                    else:
                        if day > bh["last_seen"]:
                            bh["last_seen"] = day
                        rank = r.get("rank")
                        if rank is not None and (
                            bh["best_rank"] is None or rank < bh["best_rank"]
                        ):
                            bh["best_rank"] = rank
                        bh["days"].add(day)

    game_rows = [
        {
            "name": name,
            "first_seen_at": e["first_seen_at"],
            "last_seen_at": e["last_seen_at"],
            "publisher_name": e["publisher"],
            "category": e["category"],
        }
        for name, e in games.items()
    ]
    n = upsert_batch(base_url, service_key, "games", game_rows,
                     on_conflict="name")
    log(f"[backfill] games (rebuilt): {n}")

    board_rows = [
        {
            "game_name": name,
            "platform": plat,
            "board": board,
            "first_seen": bh["first_seen"],
            "last_seen": bh["last_seen"],
            "best_rank": bh["best_rank"],
            "appearances": len(bh["days"]),
        }
        for (name, plat, board), bh in board_hist.items()
    ]
    n = upsert_batch(base_url, service_key,
                     "game_board_history", board_rows,
                     on_conflict="game_name,platform,board")
    log(f"[backfill] game_board_history (rebuilt): {n}")


def main():
    base_url = env("SUPABASE_URL")
    service_key = env("SUPABASE_SERVICE_KEY")

    # Rebuild games + publishers from the actual daily history so that
    # first_seen dates reflect reality, not "the day base/*.json was written".
    backfill_games_from_daily(base_url, service_key)
    backfill_publishers_from_daily(base_url, service_key)

    # daily_snapshots + daily_diffs never had this issue — replay them straight.
    backfill_daily_snapshots(base_url, service_key)
    backfill_daily_diffs(base_url, service_key)

    log("[backfill] all done.")


if __name__ == "__main__":
    main()
