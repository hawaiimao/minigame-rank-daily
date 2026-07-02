"""
Recover missing wx/人气榜 + wx/畅销榜 for a specified historical date.

Runs `scrape_rank.do_scrape(historical_date=...)` which drives the site's
date picker to the target day. Only the two boards that were previously
stale get merged back into the existing daily/<date>.json — other boards
are kept intact.

Usage (needs GRAVITY_AUTH set to a logged-in session; historical view
requires login):
  python scripts/rescrape_wx_boards.py 2026-07-01

Only patches wx/人气榜 and wx/畅销榜 by default. Override via env var
GRAVITY_PATCH_BOARDS='wx/人气榜,wx/畅销榜'.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import scrape_rank as core  # noqa: E402
import ci_scrape  # noqa: E402  (for auth resolution helper)

ROOT = HERE.parent


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python scripts/rescrape_wx_boards.py <YYYY-MM-DD>")
    date_str = sys.argv[1]

    daily_path = ROOT / "data" / "daily" / f"{date_str}.json"
    if not daily_path.exists():
        raise SystemExit(f"{daily_path} does not exist yet")

    boards_to_patch = os.environ.get(
        "GRAVITY_PATCH_BOARDS", "wx/人气榜,wx/畅销榜"
    )
    boards = [b.strip() for b in boards_to_patch.split(",") if b.strip()]
    print(f"[rescrape] target: {date_str} | patching boards: {boards}")

    # Prefer $GRAVITY_AUTH (env-driven, matches CI). Fall back to a
    # local rank_auth.json — this script is expected to run on the dev
    # machine, and CI already has the working data anyway.
    auth = ci_scrape.resolve_auth(print)
    if auth is None:
        local_auth = ROOT / "rank_auth.json"
        if local_auth.exists():
            auth = local_auth
            print(f"[rescrape] 使用本地登录态文件 {local_auth}")
    if auth is None:
        raise SystemExit(
            "[rescrape] historical view requires login; set GRAVITY_AUTH "
            "or place rank_auth.json in the repo root"
        )

    fresh = core.do_scrape(
        top_n=100,
        force_anon=False,
        out_dir=ROOT / "data" / "daily",
        auth_file=auth,
        log=print,
        historical_date=date_str,
    )

    # Load existing snapshot and overwrite only the requested boards.
    existing = json.loads(daily_path.read_text(encoding="utf-8"))
    for want in boards:
        plat_key, _, board_label = want.partition("/")
        # Find the fresh version.
        fresh_rows = None
        for pk, plat in fresh.get("platforms", {}).items():
            if pk != plat_key:
                continue
            for b in plat.get("boards", []):
                if b.get("label") == board_label:
                    fresh_rows = b.get("rows")
                    break
        if fresh_rows is None:
            print(f"[warn] board {want} not present in fresh scrape, skipping")
            continue
        # Overwrite in existing.
        for pk, plat in existing.get("platforms", {}).items():
            if pk != plat_key:
                continue
            for b in plat.get("boards", []):
                if b.get("label") == board_label:
                    b["rows"] = fresh_rows
                    print(f"[rescrape] {want}: replaced with {len(fresh_rows)} rows")

    daily_path.write_text(
        json.dumps(existing, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[rescrape] wrote {daily_path}")


if __name__ == "__main__":
    main()
