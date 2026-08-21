"""Scrape iOS App Store free game charts via Apple's official iTunes RSS.

Apple exposes a free, no-auth JSON feed for each storefront:

    https://itunes.apple.com/{cc}/rss/topfreeapplications/genre=6014/limit=100/json

  - cc        = ISO-3166 storefront code (us / cn / jp / ...)
  - genre=6014 = Games category only (纯游戏榜)
  - limit     = up to 100 entries (RSS caps at 100; publisher present on 100/100)

Each entry carries everything we need without any page parsing:
  im:name      -> 游戏名
  im:artist    -> 开发商（进厂商库的 publisher）
  category     -> 分类（"Games" / "游戏" / "ゲーム" — localized per storefront）
  id           -> App Store ID (im:id) + store link
  im:image     -> 图标 URL
  summary      -> 一句话简介（用作 slogan）

Why not Playwright / third-party (AppAnnie, qimai...): the RSS feed is
official, dependency-free, and needs no login/cookie — a plain urllib
GET suffices, so no new CI dependencies (same philosophy as
scrape_taptap.py).

Emits the standard snapshot fragment consumed by ci_scrape.py:

    {"label": "iOS", "boards": [
        {"label": "美区免费榜", "rows": [...]},
        {"label": "国区免费榜", "rows": [...]},
        {"label": "日区免费榜", "rows": [...]},
    ]}

The downstream base/diff/sync pipeline treats `ios` as a normal platform
key: absorb_snapshot pushes every game into the game base and every
publisher into the publisher base automatically (base.py reads
rank/name/publisher/category only).

Known limitations:
  - RSS exposes only the CURRENT chart — no historical dates (fine for a
    daily-snapshot pipeline; unlike gravity-engine, no date picker to
    re-pull a past day).
  - No rank-change arrows (引力引擎 has them); the frontend "变化" column
    shows empty for iOS boards. New-to-board / returning detection is
    unaffected.
"""
from __future__ import annotations

import json
import time
import urllib.request
from typing import Callable

# us / cn / jp — 用户确认的三个主要市场。扩展国家只需在此追加并同步
# site/app.js 的 BOARD_LABELS["ios"]。
COUNTRIES: dict[str, str] = {
    "us": "美区",
    "cn": "国区",
    "jp": "日区",
}

RSS_TMPL = (
    "https://itunes.apple.com/{cc}/rss/"
    "topfreeapplications/genre=6014/limit={n}/json"
)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def _fetch_json(url: str, timeout: float = 25, retries: int = 2) -> dict:
    """GET + parse a JSON feed, retrying transient network errors."""
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001 — retry on any transient error
            last_err = e
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
            else:
                raise
    raise last_err  # type: ignore[misc]


def _entry_artist(e: dict) -> str:
    artist = e.get("im:artist")
    if isinstance(artist, dict):
        return (artist.get("label") or "").strip()
    return ""


def _entry_link(e: dict) -> str:
    links = e.get("link")
    if isinstance(links, list) and links:
        attrs = links[0].get("attributes") or {}
        return attrs.get("href", "")
    return ""


def _entry_icon(e: dict) -> str:
    imgs = e.get("im:image")
    if isinstance(imgs, list) and imgs:
        # The list is [60x60, 100x100, 512x512]; take the largest.
        return (imgs[-1].get("label") or "").strip()
    return ""


def parse_feed(feed: dict, top_n: int) -> list[dict]:
    """Map a raw RSS feed into rank rows (1-based)."""
    rows: list[dict] = []
    for i, e in enumerate(feed.get("feed", {}).get("entry", []) or []):
        if i >= top_n:
            break
        name = (e.get("im:name") or {}).get("label", "").strip()
        if not name:
            continue
        category = (e.get("category") or {}).get("attributes") or {}
        summary = (e.get("summary") or {}).get("label", "").strip()
        app_id = (e.get("id") or {}).get("attributes") or {}
        rows.append({
            "rank": i + 1,
            "name": name,
            "publisher": _entry_artist(e),
            "category": category.get("label", ""),
            "app_id": app_id.get("im:id", ""),
            "url": _entry_link(e),
            "icon": _entry_icon(e),
            "slogan": summary[:80],
        })
    return rows


def scrape(top_n: int = 100, countries: list[str] | None = None,
           log: Callable = print) -> dict:
    """Scrape up to `top_n` free-game entries per configured storefront.

    Returns the standard snapshot fragment with one board per country.
    A failing storefront yields an empty board with an `error` note but
    never aborts the others.
    """
    if countries is None:
        countries = list(COUNTRIES)
    boards = []
    for cc in countries:
        region = COUNTRIES.get(cc, cc.upper())
        url = RSS_TMPL.format(cc=cc, n=top_n)
        try:
            feed = _fetch_json(url)
        except Exception as e:  # noqa: BLE001
            log(f"[ios/{cc}] 抓取失败（{region}免费榜将为空）: {e}")
            boards.append({"label": f"{region}免费榜", "rows": [], "error": str(e)})
            continue
        rows = parse_feed(feed, top_n)
        boards.append({"label": f"{region}免费榜", "rows": rows})
        log(f"[ios/{cc}] {region}免费榜: {len(rows)} 条")
        # Be gentle on Apple's feed (3 storefronts ≈ 3 requests).
        time.sleep(0.3)
    return {"label": "iOS", "boards": boards}


if __name__ == "__main__":
    import sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    frag = scrape(top_n=n)
    print(json.dumps(frag, ensure_ascii=False, indent=2))
    for b in frag["boards"]:
        print(f"\n{b['label']}: {len(b['rows'])} rows", flush=True)
