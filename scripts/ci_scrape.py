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

Historical re-pull: set GRAVITY_DATE=YYYY-MM-DD to re-scrape a specific
past day's ranking via the site's date picker (requires a logged-in
session). The output lands in data/daily/<that date>.json and
overwrites any existing file only when GRAVITY_FORCE is also set, so
re-pulling a committed snapshot is always explicit.
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
    top_env = os.environ.get("GRAVITY_TOP_N", "").strip()
    if top_env:
        top_n = int(top_env)
    else:
        top_n = 100 if auth else 20

    daily_dir = ROOT / "data" / "daily"
    daily_dir.mkdir(parents=True, exist_ok=True)

    # Optional historical re-pull: GRAVITY_DATE=YYYY-MM-DD drives the site's
    # date picker to that day instead of scraping "today". Requires a
    # logged-in session (anonymous mode only exposes today). Used to
    # re-pull a past date whose snapshot was bad.
    hist_date = os.environ.get("GRAVITY_DATE", "").strip() or None

    # We use Beijing date for the filename so a daily 03:33 BJT run lands
    # cleanly into "today's" file.
    now_bj = datetime.now(BEIJING_TZ)
    day_label = hist_date or now_bj.strftime("%Y-%m-%d")
    out_path = daily_dir / f"{day_label}.json"

    # First-run-of-the-day wins: if today's snapshot already exists, skip.
    # The Gravity Engine site occasionally rewrites its own rankings
    # later in the day (e.g. rank 89 changes at 12:00), so subsequent
    # scrapes would overwrite the initial "correct" 10:30 data. Force
    # a re-scrape by deleting today's daily/*.json before running.
    # A historical re-pull (GRAVITY_DATE set) is inherently intentional,
    # so it implies force — overwriting that past snapshot is the point.
    force = bool(hist_date) or os.environ.get("GRAVITY_FORCE", "").lower() in ("1", "true", "yes")
    if out_path.exists() and not force:
        log(f"快照 {out_path.name} 已存在，跳过（如需强制覆盖，"
            f"设置 GRAVITY_FORCE=1）")
        return

    data = core.do_scrape(
        top_n=top_n,
        force_anon=auth is None,
        out_dir=daily_dir,           # core writes its own xlsx/json there
        auth_file=auth or core.DEFAULT_AUTH_FILE,
        log=log,
        historical_date=hist_date,
    )

    # Tag with absolute and Beijing timestamps for the UI.
    data["scraped_at_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data["scraped_at_beijing"] = now_bj.isoformat(timespec="seconds")
    data["date_beijing"] = day_label

    # Merge TapTap pre-registration board (separate site, scraped via SSR
    # JSON-LD — see scrape_taptap.py). Wrapped so a TapTap failure never
    # blocks the gravity-engine snapshot for wx/douyin.
    #
    # TapTap has no historical API — it always returns the current
    # pre-registration board. For a historical re-pull we must NOT fold
    # today's TapTap into a past day's snapshot; reuse the board already
    # stored in the file we're overwriting (if any), else omit it.
    if hist_date and out_path.exists():
        try:
            prev = json.loads(out_path.read_text(encoding="utf-8"))
            prev_tap = prev.get("platforms", {}).get("taptap")
            if prev_tap:
                data.setdefault("platforms", {})["taptap"] = prev_tap
                log(f"复用旧快照 taptap/预约榜: "
                    f"{len(prev_tap['boards'][0]['rows'])} 条（历史重拉）")
        except Exception as e:
            log(f"[taptap] 复用旧快照失败，历史重拉将不含 taptap: {e}")
    elif not hist_date:
        try:
            import scrape_taptap as taptap
            tfrag = taptap.scrape(top_n=top_n, log=log)
            data.setdefault("platforms", {})["taptap"] = tfrag
            log(f"合并 taptap/预约榜: {len(tfrag['boards'][0]['rows'])} 条")
        except Exception as e:
            log(f"[taptap] 抓取失败，跳过（不影响其他平台）: {e}")

    out_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log(f"写出 {out_path}")

    # The latest.json pointer and history.jsonl trend log track the
    # advancing frontier of daily snapshots. A historical re-pull of a
    # past date must not regress latest.json back to that date or append
    # a duplicate trend line — only the normal "today" run updates them.
    if not hist_date:
        latest = ROOT / "data" / "latest.json"
        latest.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        log(f"更新 {latest}")

        histfile = ROOT / "data" / "history.jsonl"
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
        with histfile.open("a", encoding="utf-8") as f:
            f.write(json.dumps(summary, ensure_ascii=False) + "\n")
        log(f"追加 {histfile}")

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
