"""
Sync a daily snapshot into Supabase.

Reads the JSON files that ci_scrape.py + ci_diff.py just wrote, then
upserts:
  - `games` table:                dedup by name, update first/last seen
  - `daily_snapshots` table:      one row per (date, platform, board, rank)
  - `daily_diffs` table:          new_to_board / returning entries
  - `game_board_history` table:   from data/base/games.json (rebuilt daily)
  - `publisher_board_history`:    from data/base/publishers.json
  - `publisher_status` table:     touch first/last_seen + totals only

Runs after ci_scrape and ci_diff. Uses service_role key so it bypasses
RLS. Environment variables required:
  SUPABASE_URL           https://<ref>.supabase.co
  SUPABASE_SERVICE_KEY   the service_role JWT

Idempotent: re-running with the same snapshot is a no-op.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def log(msg):
    print(msg, flush=True)


def env(name: str, required: bool = True) -> str:
    v = os.environ.get(name, "").strip()
    if not v and required:
        raise SystemExit(f"[sync] missing env var {name}")
    return v


def sb_request(base_url: str, service_key: str, path: str,
               method: str = "GET", body: dict | list | None = None,
               prefer: str = "return=minimal"):
    """Small wrapper around urllib for PostgREST calls."""
    url = f"{base_url.rstrip('/')}/rest/v1{path}"
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", service_key)
    req.add_header("Authorization", f"Bearer {service_key}")
    req.add_header("Content-Type", "application/json")
    if prefer:
        req.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = resp.read()
            if not payload:
                return None
            return json.loads(payload.decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")[:500]
        raise SystemExit(
            f"[sync] {method} {path} → HTTP {e.code} {e.reason}\n{body_text}"
        )


def upsert_batch(base_url, service_key, table: str, rows: list[dict],
                 on_conflict: str, batch_size: int = 500):
    """Upsert rows in chunks to keep request bodies small.

    Dedupes by the on_conflict columns first: PostgREST raises HTTP 500
    (21000 "cannot affect row a second time") if a single batch contains
    two rows sharing the conflict-target values. Source snapshots can
    legitimately produce duplicates — a game listed twice on a board
    (site glitch), or a name landing in both new_to_board and returning.
    Collapse them keep-first so the upsert is always safe. NULLs in the
    key are kept as-is (Postgres treats them as distinct, no conflict)."""
    if not rows:
        return 0
    cols = [c.strip() for c in on_conflict.split(",") if c.strip()]
    if cols:
        seen = set()
        deduped = []
        for r in rows:
            key = tuple(r.get(c) for c in cols)
            if any(v is None for v in key):
                deduped.append(r)  # NULLs don't conflict in PG
                continue
            if key in seen:
                continue
            seen.add(key)
            deduped.append(r)
        if len(deduped) != len(rows):
            log(f"[sync] {table}: 去重 {len(rows)} → {len(deduped)}（重复冲突键）")
        rows = deduped
    total = 0
    for i in range(0, len(rows), batch_size):
        chunk = rows[i:i + batch_size]
        sb_request(
            base_url, service_key,
            f"/{table}?on_conflict={on_conflict}",
            method="POST",
            body=chunk,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        total += len(chunk)
    return total


def build_rows(snapshot: dict):
    """Extract snapshot rows + game rows from a scraped JSON blob."""
    date = snapshot.get("date_beijing")
    if not date:
        raise SystemExit("[sync] snapshot missing date_beijing")

    snapshot_rows = []
    game_map: dict[str, dict] = {}
    publisher_totals: dict[str, dict] = {}

    for plat_key, plat in snapshot.get("platforms", {}).items():
        for board in plat.get("boards", []):
            board_label = board.get("label")
            for r in board.get("rows", []):
                name = r.get("name")
                if not name:
                    continue
                snapshot_rows.append({
                    "snapshot_date": date,
                    "platform": plat_key,
                    "board": board_label,
                    "rank": r.get("rank"),
                    "game_name": name,
                    "publisher_name": r.get("publisher") or None,
                    "change_direction": r.get("change_direction"),
                    "change_raw": r.get("change"),
                    "category": r.get("category") or None,
                    "category_rank": r.get("category_rank"),
                    "subcategory": r.get("subcategory") or None,
                    "slogan": r.get("slogan") or None,
                })

                # Game dedup: keep the earliest known publisher/category
                # if a duplicate row lacks them, but always advance last_seen.
                g = game_map.get(name)
                if g is None:
                    g = {
                        "name": name,
                        "first_seen_at": date,
                        "last_seen_at": date,
                        "publisher_name": r.get("publisher") or None,
                        "category": r.get("category") or None,
                    }
                    game_map[name] = g
                else:
                    g["last_seen_at"] = date
                    if not g["publisher_name"] and r.get("publisher"):
                        g["publisher_name"] = r["publisher"]
                    if not g["category"] and r.get("category"):
                        g["category"] = r["category"]

                pub = r.get("publisher")
                if pub:
                    p = publisher_totals.setdefault(pub, {
                        "publisher": pub,
                        "first_seen_at": date,
                        "last_seen_at": date,
                        "boards": set(),
                        "games": set(),
                    })
                    p["last_seen_at"] = date
                    p["boards"].add(f"{plat_key}/{board_label}")
                    p["games"].add(name)

    game_rows = list(game_map.values())
    publisher_rows = [
        {
            "publisher": v["publisher"],
            "first_seen_at": v["first_seen_at"],
            "last_seen_at": v["last_seen_at"],
            "total_games": len(v["games"]),
            "total_boards": len(v["boards"]),
        }
        for v in publisher_totals.values()
    ]
    return snapshot_rows, game_rows, publisher_rows


def merge_publisher_stats(base_url, service_key, incoming: list[dict]):
    """publisher_status has status + note that we DO NOT want to overwrite.

    Two-phase to keep it simple and unicode-safe:
      1. Upsert (INSERT ... ON CONFLICT DO NOTHING) — creates rows for
         previously-unseen publishers with default status='pending'.
      2. PATCH each row to update ONLY the stat fields. Because the
         request body doesn't include `status` or `note`, PostgREST
         won't touch them.

    We could batch step 2, but a few hundred requests take <10s total
    and the code stays trivial.
    """
    if not incoming:
        return 0

    # Step 1: seed rows for new publishers (do-nothing on conflict).
    seed = [
        {
            "publisher": r["publisher"],
            "status": "pending",
            "note": "",
            "first_seen_at": r["first_seen_at"],
            "last_seen_at": r["last_seen_at"],
            "total_games": r["total_games"],
            "total_boards": r["total_boards"],
        }
        for r in incoming
    ]
    _post_ignore_duplicates(base_url, service_key, "publisher_status", seed)

    # Step 2: PATCH stats-only for every publisher. Body excludes
    # status/note so those fields are preserved.
    n = 0
    for r in incoming:
        patch_body = {
            "last_seen_at": r["last_seen_at"],
            "total_games": r["total_games"],
            "total_boards": r["total_boards"],
        }
        # We DO NOT update first_seen_at here — the seed sets it once and
        # then it should never move forward.
        pub_encoded = urllib.parse.quote(r["publisher"], safe="")
        sb_request(
            base_url, service_key,
            f"/publisher_status?publisher=eq.{pub_encoded}",
            method="PATCH",
            body=patch_body,
            prefer="return=minimal",
        )
        n += 1
    return n


def _post_ignore_duplicates(base_url, service_key, table, rows,
                            batch_size=500):
    """Insert rows but silently skip primary-key conflicts."""
    for i in range(0, len(rows), batch_size):
        chunk = rows[i:i + batch_size]
        sb_request(
            base_url, service_key,
            f"/{table}",
            method="POST",
            body=chunk,
            prefer="resolution=ignore-duplicates,return=minimal",
        )


def sync_diff_of_the_day(base_url, service_key, snapshot_date):
    """Read data/diff/<date>.json (if present) and upsert into daily_diffs."""
    p = ROOT / "data" / "diff" / f"{snapshot_date}.json"
    if not p.exists():
        return 0
    diff = json.loads(p.read_text(encoding="utf-8"))
    rows = []
    for bkey, bdata in diff.get("boards", {}).items():
        plat = bdata.get("platform")
        board_label = bdata.get("board_label")
        merged = bdata.get("new_to_board")
        if merged is None:
            merged = (bdata.get("first_anywhere") or []) \
                + (bdata.get("first_on_board") or [])
        for r in merged:
            if not r.get("name"):
                continue
            rows.append({
                "snapshot_date": snapshot_date,
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
                "snapshot_date": snapshot_date,
                "platform": plat,
                "board": board_label,
                "game_name": r["name"],
                "category": "returning",
                "rank": r.get("rank"),
                "publisher_name": r.get("publisher") or None,
            })
    return upsert_batch(
        base_url, service_key, "daily_diffs", rows,
        on_conflict="snapshot_date,platform,board,game_name",
    )


def sync_board_history(base_url, service_key):
    """Rebuild game_board_history + publisher_board_history from base/*.
    ci_diff.py already rewrote these files; we mirror them wholesale."""
    games_p = ROOT / "data" / "base" / "games.json"
    pubs_p = ROOT / "data" / "base" / "publishers.json"
    n_gbh = n_pbh = 0

    if games_p.exists():
        data = json.loads(games_p.read_text(encoding="utf-8"))
        board_rows = []
        for name, g in (data.get("games") or {}).items():
            for bkey, bh in (g.get("board_history") or {}).items():
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
        n_gbh = upsert_batch(
            base_url, service_key, "game_board_history", board_rows,
            on_conflict="game_name,platform,board",
        )

    if pubs_p.exists():
        data = json.loads(pubs_p.read_text(encoding="utf-8"))
        board_rows = []
        for name, pub in (data.get("publishers") or {}).items():
            for bkey, bh in (pub.get("board_history") or {}).items():
                plat, _, board = bkey.partition("/")
                board_rows.append({
                    "publisher": name,
                    "platform": plat,
                    "board": board,
                    "first_seen": bh.get("first_seen"),
                    "last_seen": bh.get("last_seen"),
                    "appearances": bh.get("appearances", 1),
                })
        n_pbh = upsert_batch(
            base_url, service_key, "publisher_board_history", board_rows,
            on_conflict="publisher,platform,board",
        )

    return n_gbh, n_pbh


def main():
    base_url = env("SUPABASE_URL")
    service_key = env("SUPABASE_SERVICE_KEY")

    snapshot_path = ROOT / "data" / "latest.json"
    if not snapshot_path.exists():
        log("[sync] no data/latest.json — skipping")
        return
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))

    snapshot_rows, game_rows, publisher_rows = build_rows(snapshot)
    log(f"[sync] snapshot {snapshot.get('date_beijing')} — "
        f"{len(snapshot_rows)} snapshot rows, "
        f"{len(game_rows)} games, "
        f"{len(publisher_rows)} publishers")

    n = upsert_batch(base_url, service_key, "games", game_rows,
                     on_conflict="name")
    log(f"[sync] upserted games: {n}")

    n = upsert_batch(base_url, service_key, "daily_snapshots", snapshot_rows,
                     on_conflict="snapshot_date,platform,board,rank")
    log(f"[sync] upserted daily_snapshots: {n}")

    date = snapshot.get("date_beijing")
    n = sync_diff_of_the_day(base_url, service_key, date)
    log(f"[sync] upserted daily_diffs: {n}")

    n_gbh, n_pbh = sync_board_history(base_url, service_key)
    log(f"[sync] upserted game_board_history: {n_gbh}")
    log(f"[sync] upserted publisher_board_history: {n_pbh}")

    n = merge_publisher_stats(base_url, service_key, publisher_rows)
    log(f"[sync] merged publisher_status stats: {n}")

    log("[sync] done.")


if __name__ == "__main__":
    main()
