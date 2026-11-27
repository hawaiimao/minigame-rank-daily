"""Scrape the Google Play (Android) US top-free GAMES chart via AppBrain.

AppBrain (appbrain.com) aggregates Google Play rankings and server-renders
them as plain HTML — no JS, no login, no API key needed:

    https://www.appbrain.com/stats/google-play-rankings/top_free/game/us

  - top_free     = free chart
  - game         = Games category only (also: all / application / per-genre)
  - us           = United States storefront (also: jp, kr, de, fr, ...)

The page title confirms the chart ("Google Play Ranking: Top Free Games in
the United States"). Each table row carries:
  ranking-rank  -> rank
  /app/{slug}/{package} -> package name
  app title     -> game name
  /dev/...      -> developer (publisher, feeds the publisher base)
  category      -> "Games"
  rating/installs -> bonus fields (kept on the row, not required downstream)

Why AppBrain and not Google Play directly: play.google.com renders the
chart client-side — the SSR HTML contains no app data (verified). AppBrain
is SSR, free, and needs only a plain urllib GET (same philosophy as
scrape_taptap.py). ~100 rows per chart.

STATUS 2026-11: BLOCKED. AppBrain now answers non-browser clients with
HTTP 429 whose body is the /show_humancheck interstitial. Reproduced from
a GitHub Actions runner and a CN residential line, and it persists with a
full Chrome header set — so this is a human check, not a rate limit, and
the backoff below cannot get through. The Android board has been empty
since roughly 2026-10. Either drive a real browser through the check or
switch to another Google Play ranking source; until then this module
fails fast with AppBrainBlocked so the cause is visible in the CI log.

Emits the standard snapshot fragment consumed by ci_scrape.py:

    {"label": "Android", "boards": [{"label": "美区免费榜", "rows": [...]}]}

Downstream base/diff/sync treats `android` as a normal platform key;
publishers automatically enter the publisher base (base.py reads
rank/name/publisher/category).
"""
from __future__ import annotations

import html as html_mod
import json
import re
import time
import urllib.error
import urllib.request
from typing import Callable

# US free GAMES chart. To add more storefronts, extend with
# f".../top_free/game/{cc}" — and mirror in site/app.js BOARD_LABELS.
CHART_URL = (
    "https://www.appbrain.com/stats/google-play-rankings/top_free/game/us"
)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# One <tr> per ranked app.
_ROW_RE = re.compile(
    r'<tr>\s*<td class="ranking-rank">(\d+)</td>(.*?)</tr>', re.S
)
_NAME_RE = re.compile(r'<a[^>]*>([^<]+)</a>')
_DEV_RE = re.compile(r'/dev/[^"]+"[^>]*>([^<]+)</a>')
_PKG_RE = re.compile(r"/app/[^/]+/([A-Za-z0-9_.]+)")
_CAT_RE = re.compile(r'class="ranking-category-cell"[^>]*>\s*<a[^>]*>([^<]+)</a>', re.S)


class AppBrainBlocked(RuntimeError):
    """AppBrain served its /show_humancheck interstitial instead of the chart."""


def _fetch(url: str, timeout: float = 25, retries: int = 3) -> str:
    """GET with a browser UA; retry on transient errors with backoff.

    2026-11: AppBrain put the ranking pages behind a human check. Anything
    that is not an interactive browser session gets HTTP 429 whose body is
    the /show_humancheck interstitial. Verified from both GitHub Actions
    IPs *and* a CN residential line, and it survives a full set of Chrome
    headers (Accept / Sec-Fetch-* / br encoding), so the old "transient
    rate limit, back off and retry" reading no longer holds — retrying
    just burns ~18s and reports a misleading "429 Too Many Requests".
    Detect the interstitial and fail fast with an honest reason.
    """
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8", "replace")
                if "show_humancheck" in body:
                    raise AppBrainBlocked(
                        "AppBrain 返回人机验证页 /show_humancheck（非限流，重试无效）"
                    )
                return body
        except AppBrainBlocked:
            raise
        except urllib.error.HTTPError as e:  # noqa: PERF203
            if e.code in (403, 429):
                try:
                    blocked_body = e.read().decode("utf-8", "replace")
                except Exception:  # noqa: BLE001
                    blocked_body = ""
                if "show_humancheck" in blocked_body:
                    raise AppBrainBlocked(
                        f"AppBrain 人机验证拦截（HTTP {e.code} → /show_humancheck）。"
                        "需真实浏览器会话或更换数据源，退避重试无效"
                    ) from None
            last_err = e
            if attempt < retries:
                time.sleep(3 * (attempt + 1))  # 3s, 6s, 9s
            else:
                raise
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < retries:
                time.sleep(3 * (attempt + 1))  # 3s, 6s, 9s
            else:
                raise
    raise last_err  # type: ignore[misc]


def parse_ranking(html_text: str) -> list[dict]:
    """Extract ranked rows from the AppBrain rankings table HTML."""
    rows: list[dict] = []
    for m in _ROW_RE.finditer(html_text):
        rk = int(m.group(1))
        cell = m.group(2)
        name_m = _NAME_RE.search(cell)
        pkg_m = _PKG_RE.search(cell)
        if not name_m or not pkg_m:
            continue
        name = html_mod.unescape(name_m.group(1)).strip()
        if not name:
            continue
        dev_m = _DEV_RE.search(cell)
        cat_m = _CAT_RE.search(cell)
        publisher = html_mod.unescape(dev_m.group(1)).strip() if dev_m else ""
        category = html_mod.unescape(cat_m.group(1)).strip() if cat_m else "Games"
        rows.append({
            "rank": rk,
            "name": name,
            "publisher": publisher,
            "category": category,
            "package": pkg_m.group(1),
        })
    rows.sort(key=lambda r: r["rank"])
    return rows


def scrape(top_n: int = 100, log: Callable = print) -> dict:
    """Scrape up to `top_n` entries of the US free GAMES chart.

    Returns the standard snapshot fragment (one board). On fetch/parse
    failure the board is emitted empty with an `error` note so ci_scrape's
    merge never blocks the rest of the snapshot.
    """
    try:
        raw = _fetch(CHART_URL)
    except Exception as e:  # noqa: BLE001
        log(f"[android] 抓取失败（美区免费榜将为空）: {e}")
        return {
            "label": "Android",
            "boards": [{"label": "美区免费榜", "rows": [], "error": str(e)}],
        }
    rows = parse_ranking(raw)[:top_n]
    log(f"[android] 美区免费游戏榜: {len(rows)} 条")
    return {"label": "Android", "boards": [{"label": "美区免费榜", "rows": rows}]}


if __name__ == "__main__":
    import sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    frag = scrape(top_n=n)
    print(json.dumps(frag, ensure_ascii=False, indent=2))
    for b in frag["boards"]:
        print(f"\n{b['label']}: {len(b['rows'])} rows", flush=True)
