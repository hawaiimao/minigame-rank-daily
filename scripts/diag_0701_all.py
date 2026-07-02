"""Compare all historical 07-01 commits — full Top 5 + rank 100 for
wx/人气榜 and wx/畅销榜, so we can spot the 'true' snapshot."""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

commits = [
    ("3598422", "?"),
    ("a485fd3", "?"),
    ("e1b8cd4", "?"),
    ("d9853f1", "our current source"),
]


def show(sha):
    result = subprocess.run(
        ["git", "log", "-1", "--format=%ai%n%s", sha],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    meta = result.stdout.strip()
    print(f"\n=== {sha}  {meta.replace(chr(10), ' | ')} ===")

    result = subprocess.run(
        ["git", "show", f"{sha}:data/daily/2026-07-01.json"],
        cwd=ROOT, capture_output=True,
    )
    if result.returncode != 0:
        print("  (file not in this commit)")
        return
    d = json.loads(result.stdout.decode("utf-8"))
    print(f"  scraped_at_beijing: {d.get('scraped_at_beijing')}")
    for pk, plat in d.get("platforms", {}).items():
        if pk != "wx":
            continue
        for b in plat.get("boards", []):
            if b.get("label") not in ("人气榜", "畅销榜"):
                continue
            rows = b.get("rows", [])
            print(f"  wx/{b.get('label')} ({len(rows)} rows):")
            for r in rows[:3]:
                print(f"    #{r['rank']:>2} {r.get('name')}")
            for rank in [98, 99, 100]:
                for r in rows:
                    if r.get("rank") == rank:
                        print(f"    #{r['rank']:>2} {r.get('name')}")
                        break


for sha, hint in commits:
    show(sha)
