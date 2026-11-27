"""Read the public boards straight from the server-rendered HTML.

Why this exists
---------------
rank.gravity-engine.com server-renders the public top 20 of every board
into the initial HTML: 微信 3 boards = 60 rows, 抖音 4 boards = 80 rows.
Its own meta description says so — 「公开展示各榜前20名，登录后可查询历史
排行」.

The Playwright path (scrape_rank.py) never sees that HTML. It waits for the
Vue app to re-render the list from its own XHRs, and when the stored
GRAVITY_AUTH session has died those XHRs return code 2001 (「登录异常」).
The app then clears the list, so a platform that had 60 perfectly good rows
sitting in the payload collapses to 0. That is exactly what happened from
2026-10-30: 微信 and 抖音 sat at 0 rows for 39 days while the public data
was still being served on every request.

So this module is the safety net: fetch the same URL WITHOUT a browser and
parse the server-rendered list. No login, no Playwright, ~1s.

Trade-off
---------
Public data is top 20 per board, so this cannot replace a logged-in 100-row
scrape. It only prevents a total blackout — a 20-row day is far better than
an empty board.

Field mapping
-------------
This module reads fields by CSS class, so it gets the mapping right:
``publisher`` is the real publisher and ``change`` is the real rank move.
Note that ``parse_row()`` in scrape_rank.py derives the same fields from
innerText *positionally* and is off by one slot (it stores the subcategory
in ``publisher`` and the publisher in ``change``); the DOM has 5-6 text
lines per row in a non-constant order, so positional parsing cannot be
salvaged — it needs the same class-based extraction this module uses.
"""
from __future__ import annotations

import html as html_mod
import re
import urllib.request
from typing import Callable

BASE = "https://rank.gravity-engine.com"

PLATFORM_URL = {
    "wx": f"{BASE}/wechat/day/",
    "douyin": f"{BASE}/douyin/day/",
}

# Board order in the SSR payload. The HTML carries the 20 rows of every board
# back-to-back with no separator, so the order had to be established against
# a known-good logged-in snapshot: 微信 group1=人气/2=畅销/3=畅玩 and
# 抖音 group1=热门/2=畅销/3=新游 all matched that day's rank-1 game exactly
# (抖音 畅销榜 rank1 = 三国：冰河时代), group4 is the 发行人热度 board that
# only exists in the 抖音 payload.
BOARD_LABELS = {
    "wx": ["人气榜", "畅销榜", "畅玩榜"],
    "douyin": ["热门榜", "畅销榜", "新游榜", "发行人热度榜"],
}
PLATFORM_LABEL = {"wx": "微信小游戏", "douyin": "抖音小游戏"}

ROWS_PER_BOARD = 20

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

_ITEM_START = re.compile(r'<div class="rank-child-item')


def _fetch(url: str, timeout: float = 25) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _text(raw: str) -> str:
    return html_mod.unescape(raw).replace("\u200b", "").strip()


def _first(seg: str, pattern: str) -> str:
    m = re.search(pattern, seg, re.S)
    return _text(m.group(1)) if m else ""


def _split_items(doc: str) -> list[str]:
    pos = [m.start() for m in _ITEM_START.finditer(doc)]
    return [doc[pos[i]: pos[i + 1] if i + 1 < len(pos) else len(doc)]
            for i in range(len(pos))]


def _change_and_dir(seg: str) -> tuple[str, str]:
    """Return (change text, direction) from ``.rank-right-item``.

    The two platforms encode the move differently: 微信 as text
    (「霸榜55天」/「- 稳定」/「+2」), 抖音 as a triangle <svg><path> plus a bare
    number (「1」). So read the triangle first with the same path-substring
    test scrape_rank.py applies to the live DOM:
        "M512 320 192 704h639.936z"  ▲ rank number grew    → down
        "m192 384 320 384 320-384z"  ▼ rank number shrank  → up
    Fall back to the text rules when no triangle is present.
    """
    i = seg.find('class="rank-right-item')
    if i < 0:
        return "", "unknown"
    # Back up to the opening '<' — starting mid-attribute leaves a fragment
    # like 'class="rank-right-item" data-v-...>' that survives tag stripping.
    start = seg.rfind("<", 0, i)
    if start < 0:
        start = i
    chunk = seg[start:start + 1500]

    svg_dir = ""
    for m in re.finditer(r'<path[^>]*\bd="([^"]*)"', chunk):
        d = re.sub(r"\s+", " ", m.group(1))
        if "704" in d:
            svg_dir = "down"
            break
        if "-384" in d:
            svg_dir = "up"
            break

    text = ""
    for line in re.sub(r"<[^>]*>", "\n", chunk).split("\n"):
        t = _text(line)
        if t and len(t) <= 40:
            text = t
            break

    return text, (svg_dir or _direction(text))


def _direction(change: str) -> str:
    """Mirror of the SVG-based detection used on the live DOM.

    Text carries the same semantics: 「霸榜」= held #1, 「稳定」= unchanged,
    ``+N`` = the rank number dropped = improved (站点画绿色▼), ``-N`` = worsened.
    """
    t = change.replace(" ", "")
    if not t or t in {"--", "—", "-"}:
        return "new"
    if "霸榜" in t:
        return "top"
    if "稳定" in t:
        return "flat"
    if t.startswith("+"):
        return "up"
    if t.startswith("-"):
        return "down"
    return "flat"


def _category(tags: list[str]) -> tuple[str, int | None, str]:
    """Split 「休闲 · 4名」 into (category, category_rank, slogan)."""
    if not tags:
        return "", None, ""
    m = re.match(r"^(.+?)[·:：](\d+)名$", tags[0].replace(" ", ""))
    if m:
        return m.group(1), int(m.group(2)), ""
    return "", None, tags[0]


def _parse_item(seg: str, fallback_rank: int) -> dict:
    rank_raw = _first(seg, r'class="index"[^>]*>\s*NO\.(\d+)')
    rank = int(rank_raw) if rank_raw.isdigit() else fallback_rank

    name = (_first(seg, r'class="rank-app-name[^"]*"[^>]*?title="([^"]+)"')
            or _first(seg, r"<img alt=\"([^\"]+)\""))
    publisher = _first(seg, r'class="app-publisher[^"]*"[^>]*?title="([^"]+)"')

    tags = [_text(t) for t in
            re.findall(r'class="categorize"[^>]*>(.*?)</span>', seg, re.S)]
    tags = [t for t in tags if t]
    category, cat_rank, slogan = _category(tags)
    subcategory = tags[1] if len(tags) > 1 else ""

    change, direction = _change_and_dir(seg)

    return {
        "rank": rank,
        "name": name,
        "category": category,
        "category_rank": cat_rank,
        "subcategory": subcategory,
        "slogan": slogan,
        "publisher": publisher,
        "change": change,
        "change_direction": direction,
    }


def scrape_platform(platform: str, top_n: int = ROWS_PER_BOARD,
                    log: Callable = print) -> dict:
    """Return the standard snapshot fragment for one gravity-engine platform."""
    if platform not in PLATFORM_URL:
        raise ValueError(f"unknown platform: {platform}")

    doc = _fetch(PLATFORM_URL[platform])
    items = _split_items(doc)
    log(f"[ssr] {platform}: HTML 中渲染 {len(items)} 条"
        f"（{len(BOARD_LABELS[platform])} 榜 × {ROWS_PER_BOARD}）")

    boards = []
    for i, label in enumerate(BOARD_LABELS[platform]):
        chunk = items[i * ROWS_PER_BOARD:(i + 1) * ROWS_PER_BOARD]
        rows = [_parse_item(seg, j + 1) for j, seg in enumerate(chunk)]
        rows = [r for r in rows if r["name"]]
        boards.append({"label": label, "rows": rows[:top_n]})
        log(f"[ssr]   {label}: {len(rows)} 行")

    return {"label": PLATFORM_LABEL[platform], "boards": boards}


def is_empty(fragment: dict | None) -> bool:
    """True when a platform fragment carries no rows at all."""
    if not fragment:
        return True
    return not any(b.get("rows") for b in fragment.get("boards", []))


if __name__ == "__main__":
    import json
    import sys

    plat = sys.argv[1] if len(sys.argv) > 1 else "wx"
    frag = scrape_platform(plat)
    print(json.dumps(frag, ensure_ascii=False, indent=2)[:2000])
