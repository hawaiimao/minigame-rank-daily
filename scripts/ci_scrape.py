"""
CI scrape entry: invoked by GitHub Actions.

Reads the auth state from $GRAVITY_AUTH (JSON content of a Playwright
storage_state file). If unset, runs anonymously (Top 20).

Writes:
  data/daily/<YYYY-MM-DD>.json   one snapshot per UTC date
  data/latest.json               always the most recent snapshot
  data/history.jsonl             append-only log of (date, board, totals)

The snapshot JSON is the same structure as scrape_rank.do_scrape but
flattened a little to be web-friendly.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # repo root
sys.path.insert(0, str(HERE))

import scrape_rank as core  # noqa: E402


# Beijing time (UTC+8) — we want the date label to match Chinese users.
BEIJING_TZ = timezone(timedelta(hours=8))


def resolve_auth(log) -> Path | None:
    """Materialize the auth file from $GRAVITY_AUTH (raw JSON) or from
    a path in $GRAVITY_AUTH_FILE. Returns the file path, or None for
    anonymous mode."""
    raw = os.environ.get("GRAVITY_AUTH", "").strip()
    if raw:
        # Could be a JSON blob, or a path. Heuristic: starts with `{`?
        tmp = ROOT / "_auth_runtime.json"
        if raw.lstrip().startswith("{"):
            tmp.write_text(raw, encoding="utf-8")
            log("使用 $GRAVITY_AUTH 中的 JSON 内容作为登录态")
            return tmp
        # Treat as path
        p = Path(raw)
        if p.is_file():
            log(f"使用登录态文件 {p}")
            return p
        log(f"$GRAVITY_AUTH 看起来不是 JSON 也不是有效路径，匿名运行")
        return None
    log("未设置 $GRAVITY_AUTH，匿名模式（Top 20）")
    return None


def main():
    log = print
    auth = resolve_auth(log)
    top_n = int(os.environ.get("GRAVITY_TOP_N", "100" if auth else "20"))

    daily_dir = ROOT / "data" / "daily"
    daily_dir.mkdir(parents=True, exist_ok=True)

    # We use Beijing date for the filename so a daily 03:33 BJT run lands
    # cleanly into "today's" file.
    now_bj = datetime.now(BEIJING_TZ)
    day_label = now_bj.strftime("%Y-%m-%d")
    out_path = daily_dir / f"{day_label}.json"

    data = core.do_scrape(
        top_n=top_n,
        force_anon=auth is None,
        out_dir=daily_dir,           # core writes its own xlsx/json there
        auth_file=auth or core.DEFAULT_AUTH_FILE,
        log=log,
    )

    # Tag with absolute and Beijing timestamps for the UI.
    data["scraped_at_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data["scraped_at_beijing"] = now_bj.isoformat(timespec="seconds")
    data["date_beijing"] = day_label

    out_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log(f"写出 {out_path}")

    # Always-current pointer.
    latest = ROOT / "data" / "latest.json"
    latest.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log(f"更新 {latest}")

    # Append a compact history line for trend charts.
    hist = ROOT / "data" / "history.jsonl"
    summary = {
        "date": day_label,
        "scraped_at_utc": data["scraped_at_utc"],
        "logged_in": data.get("logged_in", False),
        "boards": {},
    }
    for plat_key, plat in data.get("platforms", {}).items():
        for b in plat.get("boards", []):
            key = f"{plat_key}/{b['label']}"
            summary["boards"][key] = len(b.get("rows", []))
    with hist.open("a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    log(f"追加 {hist}")

    # Don't keep the per-snapshot xlsx that core wrote alongside;
    # the web UI reads JSON, and xlsx files would bloat the repo fast.
    for ext in (".xlsx",):
        for f in daily_dir.glob(f"rank_*{ext}"):
            try:
                f.unlink()
            except Exception:
                pass
    # Same for the redundant rank_*.json that core writes.
    for f in daily_dir.glob("rank_*.json"):
        try:
            f.unlink()
        except Exception:
            pass

    # Clean up the runtime auth blob if we created one.
    runtime_auth = ROOT / "_auth_runtime.json"
    if runtime_auth.exists():
        try:
            runtime_auth.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    main()
