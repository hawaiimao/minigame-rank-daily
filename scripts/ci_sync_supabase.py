"""
Sync a daily snapshot into Supabase.

Reads the JSON file that ci_scrape.py just wrote (data/latest.json),
then upserts:
  - `games` table: dedup by name, update first_seen / last_seen
  - `daily_snapshots` table: one row per (date, platform, board, rank)
  - `publisher_status` table: touch first_seen / last_seen / totals

Runs after ci_scrape and ci_diff. Uses service_role key so it bypasses
RLS. Both key and URL come from environment variables:
  SUPABASE_URL           https://<ref>.supabase.co
  SUPABASE_SERVICE_KEY   the service_role JWT

Idempotent: re-running with the same snapshot is a no-op.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
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
    """Upsert rows in chunks to keep request bodies small."""
    if not rows:
        return 0
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
    Merge only the stat / date fields — read the row, keep status/note if
    present, then upsert."""
    if not incoming:
        return 0

    # Fetch existing rows for these publishers to preserve status/note.
    names = [p["publisher"] for p in incoming]
    # PostgREST `in.(a,b,c)` filter — quote each value defensively.
    encoded = ",".join('"' + n.replace('"', '""') + '"' for n in names[:200])
    existing = []
    if encoded:
        existing = sb_request(
            base_url, service_key,
            f"/publisher_status?publisher=in.({encoded})&select=publisher,status,note,first_seen_at",
            method="GET",
        ) or []

    ex_map = {row["publisher"]: row for row in existing}
    merged = []
    for row in incoming:
        old = ex_map.get(row["publisher"], {})
        merged.append({
            "publisher": row["publisher"],
            "status": old.get("status") or "pending",
            "note": old.get("note") or "",
            # Never let today move first_seen_at forward.
            "first_seen_at": old.get("first_seen_at") or row["first_seen_at"],
            "last_seen_at": row["last_seen_at"],
            "total_games": row["total_games"],
            "total_boards": row["total_boards"],
        })
    return upsert_batch(
        base_url, service_key, "publisher_status", merged,
        on_conflict="publisher",
    )


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

    n = merge_publisher_stats(base_url, service_key, publisher_rows)
    log(f"[sync] merged publisher_status stats: {n}")

    log("[sync] done.")


if __name__ == "__main__":
    main()
