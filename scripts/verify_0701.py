"""One-shot verifier: dump rank-100 name for every board in 07-01."""
import json
from pathlib import Path

p = Path(__file__).resolve().parent.parent / "data" / "daily" / "2026-07-01.json"
d = json.load(p.open(encoding="utf-8"))

print("date_beijing:      ", d.get("date_beijing"))
print("scraped_at_beijing:", d.get("scraped_at_beijing"))
print()
for pk, plat in d.get("platforms", {}).items():
    for b in plat.get("boards", []):
        rows = b.get("rows", [])
        rank100 = rows[99] if len(rows) >= 100 else None
        name = rank100.get("name") if rank100 else "(<100 rows>)"
        print(f"  {pk}/{b.get('label')} rank 100: {name}")
