"""
One-shot fix: recover 07-01 daily snapshot from an earlier 07-02 fetch.

Background: on 2026-07-02 the CI first-scrape (commit e64d7b0) captured
data that actually belongs to 07-01's rankings — Gravity Engine's
site had already published today's numbers when the 07-01 CI slot was
missed. Later runs on 07-02 overwrote it. We treat that first fetch
as the correct 07-01 snapshot.

Steps:
  1. `git show e64d7b0:data/daily/2026-07-02.json` → save as 07-01.json
  2. Rewrite `date_beijing` to "2026-07-01" so downstream code sees
     it correctly.

Idempotent: safe to re-run.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "data" / "daily" / "2026-07-01.json"
SOURCE_COMMIT = "e64d7b0"
SOURCE_PATH_IN_COMMIT = "data/daily/2026-07-02.json"


def main():
    print(f"Extracting {SOURCE_PATH_IN_COMMIT} @ {SOURCE_COMMIT} → {TARGET}")
    result = subprocess.run(
        ["git", "show", f"{SOURCE_COMMIT}:{SOURCE_PATH_IN_COMMIT}"],
        cwd=ROOT,
        capture_output=True,
    )
    if result.returncode != 0:
        raise SystemExit(
            f"git show failed: {result.stderr.decode('utf-8', errors='replace')}"
        )
    payload = result.stdout.decode("utf-8")
    data = json.loads(payload)

    old_date = data.get("date_beijing")
    data["date_beijing"] = "2026-07-01"

    TARGET.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Wrote {TARGET}")
    print(f"date_beijing: {old_date} → 2026-07-01")

    # Verify the write.
    check = json.loads(TARGET.read_text(encoding="utf-8"))
    total = 0
    for pk, p in check.get("platforms", {}).items():
        for b in p.get("boards", []):
            total += len(b.get("rows", []))
    print(f"Total rows in file: {total}")


if __name__ == "__main__":
    main()
