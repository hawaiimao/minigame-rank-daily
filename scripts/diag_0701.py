"""Check current state of 07-01 wx boards + git history."""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def show_wx(path, label):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    print(f"== {label} ==")
    print(f"   date_beijing: {d.get('date_beijing')}")
    print(f"   scraped_at:   {d.get('scraped_at_beijing')}")
    for pk, plat in d.get("platforms", {}).items():
        if pk != "wx":
            continue
        for b in plat.get("boards", []):
            if b.get("label") not in ("人气榜", "畅销榜"):
                continue
            rows = b.get("rows", [])
            top1 = rows[0].get("name") if rows else "-"
            print(f"   {pk}/{b.get('label')} rank1={top1}")
    print()


# 1. current 07-01 file
show_wx(ROOT / "data/daily/2026-07-01.json", "current 07-01.json (working copy)")

# 2. All commits touching 07-01
print("== git log for 07-01 ==")
print(subprocess.run(
    ["git", "log", "--all", "--oneline", "-20", "--", "data/daily/2026-07-01.json"],
    cwd=ROOT, capture_output=True, text=True, encoding="utf-8"
).stdout)

# 3. Compare rank 1-3 of wx 人气榜 across each historical commit
for sha, hint in [
    ("d9853f1", "should be TRUE 07-01 (10:38 BJT)"),
    ("f4ba80d", "our 'fix' commit — from e64d7b0"),
    ("HEAD", "current HEAD"),
]:
    result = subprocess.run(
        ["git", "show", f"{sha}:data/daily/2026-07-01.json"],
        cwd=ROOT, capture_output=True,
    )
    if result.returncode != 0:
        print(f"[{sha}] not found")
        continue
    d = json.loads(result.stdout.decode("utf-8"))
    for pk, plat in d.get("platforms", {}).items():
        if pk != "wx":
            continue
        for b in plat.get("boards", []):
            if b.get("label") not in ("人气榜", "畅销榜"):
                continue
            rows = b.get("rows", [])
            top3 = [r.get("name") for r in rows[:3]]
            print(f"[{sha}] wx/{b.get('label')} Top3: {top3}   ({hint})")
