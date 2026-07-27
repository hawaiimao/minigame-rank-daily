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
import os
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

    # Historical re-pull: GRAVITY_DATE points ci_scrape at a past day.
    # Process THAT date (not files[-1], which may be a later day), so its
    # data/diff/<date>.json gets written for ci_sync to sync. The base
    # "before" = all daily files strictly earlier than the target date.
    hist_date = os.environ.get("GRAVITY_DATE", "").strip() or None
    if hist_date:
        today_p = DAILY / f"{hist_date}.json"
        if not today_p.exists():
            print(f"[diff] GRAVITY_DATE={hist_date} 的快照不存在，跳过。")
            return
        history_files = [p for p in files if p.stem < hist_date]
        print(f"[diff] 历史重拉模式：目标 {hist_date}，"
              f"base 用 {len(history_files)} 份更早的快照。")
    else:
        today_p = files[-1]
        history_files = files[:-1]

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

    # Now fold today into the base and persist. For a historical re-pull
    # we persist from ALL daily files — including dates AFTER the target —
    # so game_board_history / publisher_board_history never regress for
    # later days. (absorb_snapshot is associative, so for the normal path
    # rebuilding from all files is equivalent to folding today onto
    # base_before; we keep the incremental form there to stay minimal.)
    if hist_date:
        base_full = basemod._empty()
        for p in files:
            snap = json.loads(p.read_text(encoding="utf-8"))
            day = snap.get("date_beijing") or p.stem
            basemod.absorb_snapshot(base_full, snap, day)
        basemod.save(base_full)
        print(f"[diff] 更新 data/base/（全量 {len(files)} 份，含目标日之后）  "
              f"(games={len(base_full['games'])}, "
              f"publishers={len(base_full['publishers'])})")
    else:
        base_after = base_before
        basemod.absorb_snapshot(base_after, today_snap, today)
        basemod.save(base_after)
        print(f"[diff] 更新 data/base/  "
              f"(games={len(base_after['games'])}, "
              f"publishers={len(base_after['publishers'])})")


if __name__ == "__main__":
    main()
