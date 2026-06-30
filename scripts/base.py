"""
Cumulative base library: tracks every game / publisher we've ever seen
across all daily snapshots.

Layout under data/base/:
  games.json:
    {
      "games": {
        "<name>": {
          "name": "...",
          "first_seen_anywhere": "YYYY-MM-DD",
          "categories": ["休闲", ...],
          "publishers": ["..."],          # may shift over time
          "board_history": {
            "wx/人气榜": {
              "first_seen": "YYYY-MM-DD",
              "last_seen": "YYYY-MM-DD",
              "best_rank": 3,
              "appearances": 16
            }, ...
          }
        }
      },
      "updated_at": "..."
    }

  publishers.json: analogous structure, keyed by publisher name.

The base can always be rebuilt from scratch by replaying every file
under data/daily/ in chronological order — see `rebuild_from_daily()`.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

# Where the base lives, relative to repo root (the parent of this file's parent).
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BASE_DIR = ROOT / "data" / "base"
DAILY_DIR = ROOT / "data" / "daily"


def _board_key(plat_key: str, label: str) -> str:
    return f"{plat_key}/{label}"


def _empty():
    return {"games": {}, "publishers": {}, "updated_at": None}


def load() -> dict:
    """Load games + publishers base, returning a single dict.
    Missing files are treated as empty (first-run scenario)."""
    out = _empty()
    games_p = BASE_DIR / "games.json"
    pubs_p = BASE_DIR / "publishers.json"
    if games_p.exists():
        out["games"] = json.loads(games_p.read_text(encoding="utf-8")).get("games", {})
    if pubs_p.exists():
        out["publishers"] = json.loads(pubs_p.read_text(encoding="utf-8")).get("publishers", {})
    return out


def save(base: dict):
    BASE_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    (BASE_DIR / "games.json").write_text(
        json.dumps({"games": base["games"], "updated_at": now},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (BASE_DIR / "publishers.json").write_text(
        json.dumps({"publishers": base["publishers"], "updated_at": now},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def absorb_snapshot(base: dict, snapshot: dict, day: str):
    """Fold a single daily snapshot into the base, mutating in place.

    `day` is a YYYY-MM-DD string identifying when this snapshot was taken.
    """
    games = base["games"]
    pubs = base["publishers"]

    for plat_key, plat in snapshot.get("platforms", {}).items():
        for board in plat.get("boards", []):
            bkey = _board_key(plat_key, board["label"])
            for r in board.get("rows", []):
                name = r.get("name")
                publisher = r.get("publisher") or ""
                category = r.get("category") or ""
                rank = r.get("rank")

                if name:
                    g = games.get(name)
                    if g is None:
                        g = {
                            "name": name,
                            "first_seen_anywhere": day,
                            "categories": [],
                            "publishers": [],
                            "board_history": {},
                        }
                        games[name] = g
                    if category and category not in g["categories"]:
                        g["categories"].append(category)
                    if publisher and publisher not in g["publishers"]:
                        g["publishers"].append(publisher)
                    bh = g["board_history"].get(bkey)
                    if bh is None:
                        bh = {
                            "first_seen": day,
                            "last_seen": day,
                            "best_rank": rank,
                            "appearances": 1,
                        }
                        g["board_history"][bkey] = bh
                    else:
                        bh["last_seen"] = max(bh["last_seen"], day)
                        if rank is not None and (
                            bh["best_rank"] is None
                            or rank < bh["best_rank"]
                        ):
                            bh["best_rank"] = rank
                        # Only count one appearance per (game, board, day).
                        # This relies on absorb_snapshot being called once
                        # per day per snapshot.
                        if bh.get("_last_day_counted") != day:
                            bh["appearances"] = bh.get("appearances", 0) + 1
                            bh["_last_day_counted"] = day

                if publisher:
                    p = pubs.get(publisher)
                    if p is None:
                        p = {
                            "name": publisher,
                            "first_seen_anywhere": day,
                            "games": [],
                            "board_history": {},
                        }
                        pubs[publisher] = p
                    if name and name not in p["games"]:
                        p["games"].append(name)
                    pbh = p["board_history"].get(bkey)
                    if pbh is None:
                        p["board_history"][bkey] = {
                            "first_seen": day,
                            "last_seen": day,
                            "appearances": 1,
                            "_last_day_counted": day,
                        }
                    else:
                        pbh["last_seen"] = max(pbh["last_seen"], day)
                        if pbh.get("_last_day_counted") != day:
                            pbh["appearances"] = pbh.get("appearances", 0) + 1
                            pbh["_last_day_counted"] = day


def classify_today(base_before: dict, snapshot: dict, day: str) -> dict:
    """Given a snapshot for `day` and the base BEFORE absorbing it, label
    every (board, row) as one of:

      - first_anywhere : the game/publisher is absent from base entirely
      - first_on_board : seen in base on other boards but not this one
      - returning      : last_seen on this board < day - 1, then back today
      - persistent     : was on this board yesterday too (not interesting)

    Returns a per-board dict with arrays of rows for each category, plus
    `new_publishers` lifted to the board level.
    """
    games = base_before["games"]
    pubs = base_before["publishers"]
    out = {"date": day, "boards": {}}

    for plat_key, plat in snapshot.get("platforms", {}).items():
        for board in plat.get("boards", []):
            bkey = _board_key(plat_key, board["label"])
            first_anywhere = []
            first_on_board = []
            returning = []
            new_publishers = []
            seen_pub_keys = set()

            for r in board.get("rows", []):
                name = r.get("name", "")
                publisher = r.get("publisher", "")

                # ---- game classification ----
                if name:
                    g = games.get(name)
                    if g is None:
                        first_anywhere.append(r)
                    elif bkey not in g["board_history"]:
                        first_on_board.append(r)
                    else:
                        last = g["board_history"][bkey]["last_seen"]
                        # If gap ≥ 2 days, treat as returning. (Adjacent
                        # day = persistent.)
                        if _day_gap(last, day) >= 2:
                            returning.append(r)
                        # else: persistent — not surfaced here.

                # ---- publisher classification (per-board) ----
                if publisher and publisher not in seen_pub_keys:
                    p = pubs.get(publisher)
                    if p is None or bkey not in p["board_history"]:
                        new_publishers.append(r)
                        seen_pub_keys.add(publisher)

            out["boards"][bkey] = {
                "platform": plat_key,
                "platform_label": plat.get("label"),
                "board_label": board["label"],
                "first_anywhere": first_anywhere,
                "first_on_board": first_on_board,
                "returning": returning,
                "new_publishers": new_publishers,
                "totals": {
                    "first_anywhere": len(first_anywhere),
                    "first_on_board": len(first_on_board),
                    "returning": len(returning),
                    "new_publishers": len(new_publishers),
                },
            }
    return out


def _day_gap(d_old: str, d_new: str) -> int:
    """Return the number of calendar days between two YYYY-MM-DD strings.
    Same day → 0, adjacent days → 1, etc."""
    try:
        a = datetime.strptime(d_old, "%Y-%m-%d")
        b = datetime.strptime(d_new, "%Y-%m-%d")
        return (b - a).days
    except Exception:
        return 0


def rebuild_from_daily() -> dict:
    """Replay every daily/*.json (in date order) into a fresh base.
    Useful when the base files get out of sync with daily/ for any reason."""
    fresh = _empty()
    files = sorted(DAILY_DIR.glob("*.json"))
    for p in files:
        snap = json.loads(p.read_text(encoding="utf-8"))
        day = snap.get("date_beijing") or p.stem
        absorb_snapshot(fresh, snap, day)
    return fresh
