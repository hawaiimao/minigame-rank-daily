"""Compare rank 98/99/100 across 06-30, 07-01, 07-02 for all 6 boards."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
files = ["2026-06-30", "2026-07-01", "2026-07-02"]

data = {}
for f in files:
    data[f] = json.load((ROOT / f"data/daily/{f}.json").open(encoding="utf-8"))

def get_row(d, plat, board, rank):
    for pk, p in d.get("platforms", {}).items():
        if pk != plat:
            continue
        for b in p.get("boards", []):
            if b.get("label") != board:
                continue
            for r in b.get("rows", []):
                if r.get("rank") == rank:
                    return r
    return None

for plat, boards in [("wx", ["人气榜", "畅销榜", "畅玩榜"]),
                      ("douyin", ["热门榜", "畅销榜", "新游榜"])]:
    for board in boards:
        print(f"\n== {plat}/{board} ==")
        for rank in [98, 99, 100]:
            row = {f: get_row(data[f], plat, board, rank) for f in files}
            names = {f: (row[f].get("name") if row[f] else "-") for f in files}
            same_01_02 = names[files[1]] == names[files[2]]
            same_01_30 = names[files[0]] == names[files[1]]
            marker = ""
            if same_01_02 and not same_01_30:
                marker = "  ← 07-01 == 07-02"
            elif same_01_30:
                marker = "  ← 07-01 == 06-30 (STALE!)"
            print(f"  #{rank}: 06-30={names[files[0]]!r}  07-01={names[files[1]]!r}  07-02={names[files[2]]!r}{marker}")
