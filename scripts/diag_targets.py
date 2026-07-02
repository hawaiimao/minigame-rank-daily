"""Find where these two games actually appear across all snapshots."""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

targets = ["绝世仙王", "真实都市冒险"]

def scan(source, sha=None):
    if sha:
        result = subprocess.run(
            ["git", "show", sha], cwd=ROOT, capture_output=True,
        )
        if result.returncode != 0:
            return None
        try:
            d = json.loads(result.stdout.decode("utf-8"))
        except Exception:
            return None
    else:
        try:
            d = json.loads(Path(source).read_text(encoding="utf-8"))
        except Exception:
            return None
    hits = []
    for pk, plat in d.get("platforms", {}).items():
        for b in plat.get("boards", []):
            for r in b.get("rows", []):
                if r.get("name") in targets:
                    hits.append((pk, b.get("label"), r.get("rank"), r.get("name"), r.get("publisher")))
    return d.get("date_beijing"), d.get("scraped_at_beijing"), hits


# scan current daily files
print("=== current data/daily/*.json ===")
for p in sorted(Path(ROOT / "data/daily").glob("*.json")):
    result = scan(str(p))
    if result:
        date, ts, hits = result
        print(f"{p.name} (date={date}, scraped={ts})")
        for h in hits:
            print(f"  {h}")

# scan every historical commit for 07-01
print("\n=== every commit of data/daily/2026-07-01.json ===")
result = subprocess.run(
    ["git", "log", "--all", "--format=%H %ai", "--", "data/daily/2026-07-01.json"],
    cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
)
for line in result.stdout.strip().split("\n"):
    if not line: continue
    sha = line.split()[0]
    r = scan(None, sha=f"{sha}:data/daily/2026-07-01.json")
    if not r: continue
    date, ts, hits = r
    print(f"{sha[:7]} (scraped={ts})")
    for h in hits:
        print(f"  {h}")
