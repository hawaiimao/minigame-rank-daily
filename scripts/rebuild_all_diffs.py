"""
Rebuild every diff/*.json from the current daily/*.json chain.

`ci_diff.py` only ever writes the latest day's diff. When you retro-
actively fix an earlier day (e.g. we just repaired 2026-07-01), the
diffs downstream of it are still stale. This script replays everything.

Idempotent. Overwrites diff/ files but leaves daily/ untouched.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import base as basemod  # noqa: E402

ROOT = HERE.parent
DAILY = ROOT / "data" / "daily"
DIFF = ROOT / "data" / "diff"


def main():
    DIFF.mkdir(parents=True, exist_ok=True)
    files = sorted(DAILY.glob("*.json"))
    if len(files) < 2:
        print("[rebuild] need at least 2 daily files; nothing to do.")
        return

    running = basemod._empty()
    # Absorb the very first file into the base without emitting a diff.
    first = files[0]
    first_snap = json.loads(first.read_text(encoding="utf-8"))
    first_day = first_snap.get("date_beijing") or first.stem
    basemod.absorb_snapshot(running, first_snap, first_day)
    print(f"[rebuild] seeded base from {first.name} (no diff).")

    # For every subsequent day, classify against the base as of the day
    # BEFORE it, then absorb it.
    for path in files[1:]:
        snap = json.loads(path.read_text(encoding="utf-8"))
        day = snap.get("date_beijing") or path.stem

        classified = basemod.classify_today(running, snap, day)

        # Same merged shape ci_diff.py produces.
        for bk, b in classified["boards"].items():
            merged = (b.get("first_anywhere") or []) + (b.get("first_on_board") or [])
            merged.sort(key=lambda r: (r.get("rank") if r.get("rank") is not None else 9999))
            b["new_to_board"] = merged
            b["totals"] = {
                "new_to_board": len(merged),
                "returning": b["totals"].get("returning", 0),
                "new_publishers": b["totals"].get("new_publishers", 0),
            }

        out = DIFF / f"{day}.json"
        out.write_text(
            json.dumps(classified, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        totals = {"new_to_board": 0, "returning": 0, "new_publishers": 0}
        for bk, b in classified["boards"].items():
            for k in totals:
                totals[k] += b["totals"][k]
        print(f"[rebuild] {day}: {totals}")

        # Now fold this day into the running base for the next iteration.
        basemod.absorb_snapshot(running, snap, day)

    # Persist the final base so it matches the last day fully.
    basemod.save(running)
    print(f"[rebuild] base updated: "
          f"games={len(running['games'])}, publishers={len(running['publishers'])}")


if __name__ == "__main__":
    main()
