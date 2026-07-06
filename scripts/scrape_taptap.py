"""Scrape the TapTap pre-registration ranking (预约榜) with publisher + tags.

TapTap server-renders https://www.taptap.cn/top/reserve and embeds a
schema.org ItemList JSON-LD block per page. Each entry carries the
*global* `position` (rank), the game `name`, and the app `url`. We
paginate `?page=N` and read that JSON-LD for the ranked list.

Then, for each game, we fetch its `/app/{id}` detail page (also SSR) and
extract, from a second JSON-LD block (`@type=VideoGame`):
  - publisher  ← `author.name`  (the developer / 厂商; `publisher.name`
                is just "TapTap" the platform, so we ignore it)
  - tags      ← the `app-intro__tag-item` chip texts on the page
The first tag becomes `category`, the rest join into `subcategory`.

Why not Playwright: a prior headless-Chromium attempt got
`ERR_CONNECTION_RESET` — TapTap's WAF targets headless-browser
automation signals. A plain HTTP GET is served the real SSR content
without challenge (verified). If TapTap ever starts TLS-fingerprinting
Python clients, swap `_fetch` to `curl_cffi` with
`impersonate="chrome124"` — one-line change.

Emits the standard snapshot fragment consumed by ci_scrape.py:
    {"label": "TapTap", "boards": [{"label": "预约榜", "rows": [...]}]}

Rows carry rank + name + publisher + category + subcategory. The
downstream base/diff/sync pipeline + publishers.html all pick up
publisher automatically (base.py tracks publishers, ci_sync_supabase
upserts publisher_status, publishers.html reads it).

Stdlib-only (urllib + gzip + re + json + concurrent.futures) — no new
CI dependencies.
"""
from __future__ import annotations

import gzip
import json
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://www.taptap.cn/top/reserve"
PAGE_SIZE = 10  # each page's JSON-LD lists 10 items; positions are global

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# `<script type="application/ld+json" ...>` — Vue sometimes adds data-v
# attributes, so match loosely.
_LDJSON_RE = re.compile(
    r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', re.S
)
_ITEMLIST_RE = re.compile(
    r'<script type="application/ld\+json">(.*?)</script>', re.S
)
_TAG_ANCHOR_RE = re.compile(
    r'<a[^>]*class="[^"]*app-intro__tag-item[^"]*"[^>]*>(.*?)</a>', re.S
)
_APPID_RE = re.compile(r"/app/(\d+)")


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


def _parse_listing_items(html: str) -> list[dict]:
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


def _app_id(url: str) -> str | None:
    m = _APPID_RE.search(url or "")
    return m.group(1) if m else None


def _parse_app(html: str) -> tuple[str | None, list[str]]:
    """From an /app/{id} page, return (publisher, tags). Best-effort:
    missing fields return (None, [])."""
    publisher = None

    # publisher ← VideoGame JSON-LD author.name
    for block in _LDJSON_RE.findall(html):
        try:
            d = json.loads(block)
        except Exception:
            continue
        if d.get("@type") != "VideoGame":
            continue
        author = d.get("author")
        if isinstance(author, list):
            author = author[0] if author else {}
        if isinstance(author, dict):
            publisher = author.get("name") or publisher
        break  # only one VideoGame block per page

    # tags ← app-intro__tag-item chip texts (strip Vue comment markers)
    tags: list[str] = []
    for anchor_inner in _TAG_ANCHOR_RE.findall(html):
        text = re.sub(r"<!--.*?-->", "", anchor_inner, flags=re.S)
        text = re.sub(r"<[^>]+>", "", text).strip()
        if text:
            tags.append(text)

    return publisher, tags


def _enrich_one(app_id: str | None) -> tuple[str | None, list[str]]:
    """Fetch one app page and return (publisher, tags). On any failure,
    returns (None, []) so the row still keeps rank + name."""
    if not app_id:
        return None, []
    try:
        html = _fetch(f"https://www.taptap.cn/app/{app_id}", timeout=15, retries=1)
    except Exception:
        return None, []
    return _parse_app(html)


def scrape(top_n: int = 100, log=print, max_workers: int = 5) -> dict:
    """Scrape up to `top_n` entries of the TapTap 预约榜, enriched with
    publisher + tags from each app's detail page.

    Returns the standard snapshot fragment. Stops the listing at top_n,
    at the last page (fewer than PAGE_SIZE items), at an empty page, or
    if a page adds nothing new. App-page enrichment is best-effort: a
    failed app page leaves that row with rank + name only.
    """
    # 1) Paginated listing → items with global rank, name, app url.
    items: list[dict] = []
    seen_ranks: set[int] = set()
    page = 1
    max_pages = (top_n // PAGE_SIZE) + 2  # safety cap
    while len(items) < top_n and page <= max_pages:
        url = BASE + (f"?page={page}" if page > 1 else "")
        try:
            html = _fetch(url)
        except Exception as e:
            log(f"[taptap] listing page {page} fetch failed: {e} — stopping")
            break
        page_items = _parse_listing_items(html)
        if not page_items:
            log(f"[taptap] listing page {page}: no items — stopping")
            break
        added = 0
        for it in page_items:
            if it["position"] in seen_ranks:
                continue
            seen_ranks.add(it["position"])
            items.append(it)
            added += 1
            if len(items) >= top_n:
                break
        log(f"[taptap] listing page {page}: +{added} (total {len(items)})")
        if added == 0 or len(page_items) < PAGE_SIZE:
            break  # regressing page or last page
        page += 1

    # 2) Enrich each item with publisher + tags from its app page,
    #    concurrently with a small worker pool (gentle on TapTap).
    app_ids = [_app_id(it["url"]) for it in items]
    enriched_results: list[tuple[str | None, list[str]]]
    if items:
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            enriched_results = list(pool.map(_enrich_one, app_ids))
    else:
        enriched_results = []

    # 3) Build rows.
    rows = []
    enriched_count = 0
    for it, (pub, tags) in zip(items, enriched_results):
        row: dict = {"rank": it["position"], "name": it["name"]}
        if pub:
            row["publisher"] = pub
        if tags:
            row["category"] = tags[0]
            if len(tags) > 1:
                row["subcategory"] = "、".join(tags[1:])
        if pub or tags:
            enriched_count += 1
        rows.append(row)
    log(f"[taptap] enriched {enriched_count}/{len(rows)} rows with publisher/tags")

    rows.sort(key=lambda r: r["rank"])
    return {
        "label": "TapTap",
        "boards": [{"label": "预约榜", "rows": rows}],
    }


if __name__ == "__main__":
    frag = scrape(top_n=100)
    print(json.dumps(frag, ensure_ascii=False, indent=2))
    print(f"\n{len(frag['boards'][0]['rows'])} rows", flush=True)