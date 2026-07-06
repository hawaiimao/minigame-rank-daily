"""Scrape the TapTap pre-registration ranking (预约榜).

TapTap server-renders https://www.taptap.cn/top/reserve and embeds a
schema.org ItemList JSON-LD block per page. Each entry carries the
*global* `position` (rank), the game `name`, and the app `url`. We just
paginate `?page=N` and read that JSON-LD — no browser, no HTML card
parsing, so there is nothing for TapTap's anti-bot to flag.

Why not Playwright: a prior headless-Chromium attempt got
`ERR_CONNECTION_RESET` — TapTap's WAF targets headless-browser
automation signals (navigator.webdriver, CDP, ...). A plain HTTP GET is
served the real SSR content without challenge (verified). If TapTap
ever starts TLS-fingerprinting Python clients, swap `_fetch` to
`curl_cffi` with `impersonate="chrome124"` — one-line change.

Emits the standard snapshot fragment consumed by ci_scrape.py:
    {"label": "TapTap", "boards": [{"label": "预约榜", "rows": [...]}]}

Rows carry only `rank` + `name` for v1 (no publisher/category yet). The
downstream base/diff/sync pipeline treats every other field as null,
and the frontend already renders taptap/预约榜, so this is enough to
light up the board end-to-end.

Stdlib-only (urllib + gzip + re + json) — no new CI dependencies.
"""
from __future__ import annotations

import gzip
import json
import re
import time
import urllib.error
import urllib.request

BASE = "https://www.taptap.cn/top/reserve"
PAGE_SIZE = 10  # each page's JSON-LD lists 10 items; positions are global

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_ITEMLIST_RE = re.compile(
    r'<script type="application/ld\+json">(.*?)</script>', re.S
)


def _fetch(url: str, timeout: float = 20, retries: int = 2) -> str:
    """GET a URL with a realistic browser UA; transparent gzip. Retries
    on transient network errors."""
    last_err = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw.decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
            else:
                raise
    raise last_err  # type: ignore[misc]


def _parse_items(html: str) -> list[dict]:
    """Return [{position, name, url}] from the ItemList JSON-LD, or []."""
    for block in _ITEMLIST_RE.findall(html):
        try:
            d = json.loads(block)
        except Exception:
            continue
        if d.get("@type") != "ItemList":
            continue
        out = []
        for it in d.get("itemListElement", []):
            pos = it.get("position")
            name = it.get("name")
            if pos is None or not name:
                continue
            out.append({
                "position": int(pos),
                "name": str(name).strip(),
                "url": it.get("url", ""),
            })
        return out
    return []


def scrape(top_n: int = 100, log=print) -> dict:
    """Scrape up to `top_n` entries of the TapTap 预约榜.

    Returns the standard snapshot fragment. Stops at top_n, at the last
    page (fewer than PAGE_SIZE items), at an empty page, or if a page
    adds nothing new (guards against a site silently regressing pages).
    """
    rows = []
    seen_ranks: set[int] = set()
    page = 1
    max_pages = (top_n // PAGE_SIZE) + 2  # safety cap

    while len(rows) < top_n and page <= max_pages:
        url = BASE + (f"?page={page}" if page > 1 else "")
        try:
            html = _fetch(url)
        except Exception as e:
            log(f"[taptap] page {page} fetch failed: {e} — stopping")
            break

        items = _parse_items(html)
        if not items:
            log(f"[taptap] page {page}: no items — stopping")
            break

        added = 0
        for it in items:
            rank = it["position"]
            if rank in seen_ranks:
                continue
            seen_ranks.add(rank)
            rows.append({"rank": rank, "name": it["name"]})
            added += 1
            if len(rows) >= top_n:
                break

        log(f"[taptap] page {page}: +{added} (total {len(rows)})")
        if added == 0 or len(items) < PAGE_SIZE:
            break  # regressing page or last page
        page += 1

    rows.sort(key=lambda r: r["rank"])
    return {
        "label": "TapTap",
        "boards": [{"label": "预约榜", "rows": rows}],
    }


if __name__ == "__main__":
    frag = scrape(top_n=100)
    print(json.dumps(frag, ensure_ascii=False, indent=2))
    print(f"\n{len(frag['boards'][0]['rows'])} rows", flush=True)