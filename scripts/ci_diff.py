"""
CI diff entry: classify today's snapshot against the cumulative base.

Reads:
  data/daily/<latest>.json    today's snapshot
  data/base/games.json        cumulative game library (BEFORE today)
  data/base/publishers.json   cumulative publisher library

Writes:
  data/diff/<today>.json      classification (first-time / returning / etc.)
  data/base/games.json        updated to include today
  data/base/publishers.json   updated to include today

If base/ is missing or stale, it gets rebuilt from data/daily/* up to but
not including today's snapshot, so a freshly cloned repo still produces
correct "first-ever" labels.
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
    if not files:
        print("[diff] data/daily/ 为空，无可处理的快照。")
        return
    today_p = files[-1]
    today_snap = json.loads(today_p.read_text(encoding="utf-8"))
    today = today_snap.get("date_beijing") or today_p.stem
    print(f"[diff] 处理快照：{today_p.name}（{today}）")

    # The base must reflect everything BEFORE today. We rebuild from the
    # full daily/ except today, then optionally trust an existing
    # base/games.json if it's already in sync. Rebuild is cheap (linear
    # scan) and avoids drift, so we just always rebuild from history.
    base_before = basemod._empty()
    history_files = files[:-1]
    print(f"[diff] 重建 base 用 {len(history_files)} 份历史快照。")
    for p in history_files:
        snap = json.loads(p.read_text(encoding="utf-8"))
        day = snap.get("date_beijing") or p.stem
        basemod.absorb_snapshot(base_before, snap, day)

    classified = basemod.classify_today(base_before, today_snap, today)

    # The frontend cares about a single "new to this board" bucket — the
    # difference between "first ever seen anywhere" and "first time on
    # THIS board (but seen elsewhere)" is academic for board monitoring.
    # Merge them; keep the detailed split available in case future
    # downstream tools want it.
    for bk, b in classified["boards"].items():
        merged = (b.get("first_anywhere") or []) + (b.get("first_on_board") or [])
        # Sort by rank for stable presentation.
        merged.sort(key=lambda r: (r.get("rank") if r.get("rank") is not None else 9999))
        b["new_to_board"] = merged
        b["totals"] = {
            "new_to_board": len(merged),
            "returning": b["totals"].get("returning", 0),
            "new_publishers": b["totals"].get("new_publishers", 0),
        }

    out_path = DIFF / f"{today}.json"
    out_path.write_text(
        json.dumps(classified, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    totals = {"new_to_board": 0, "returning": 0, "new_publishers": 0}
    for bk, b in classified["boards"].items():
        for k in totals:
            totals[k] += b["totals"][k]
    print(f"[diff] 写出 {out_path}")
    print(f"[diff] 汇总：{totals}")

    # Now fold today into the base and persist.
    base_after = base_before
    basemod.absorb_snapshot(base_after, today_snap, today)
    basemod.save(base_after)
    print(f"[diff] 更新 data/base/  "
          f"(games={len(base_after['games'])}, "
          f"publishers={len(base_after['publishers'])})")


if __name__ == "__main__":
    main()
