"""Profile maintenance tool: set/update game profiles + upload screenshots."""
from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SUPA_ENV = Path("C:/tmp/supa.env")
BUCKET = "game-shots"


def load_env() -> tuple[str, str]:
    if not SUPA_ENV.exists():
        raise SystemExit(f"[profile] missing {SUPA_ENV}")
    text = SUPA_ENV.read_text(encoding="utf-8").strip()
    url = "https://pjwwwxanhtvzkscumedm.supabase.co"
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    key = None
    for ln in lines:
        if ln.startswith("SUPABASE_SERVICE_KEY="):
            key = ln.split("=", 1)[1]
        elif ln and not ln.startswith("#") and not ln.startswith("http"):
            key = ln
    if not key:
        raise SystemExit("[profile] no service key found in supa.env")
    return url, key


def req(url: str, key: str, path: str, method="GET", body=None,
        headers=None, raw=False):
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url + path, data=data, method=method)
    r.add_header("apikey", key)
    r.add_header("Authorization", "Bearer " + key)
    if headers:
        for k, v in headers.items():
            r.add_header(k, v)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            payload = resp.read()
            if raw:
                return resp.status, payload
            return json.loads(payload.decode("utf-8")) if payload else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        raise SystemExit(f"[profile] {method} {path} -> HTTP {e.code}\n{detail}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_set = sub.add_parser("set", help="upsert a game profile")
    p_set.add_argument("--game", required=True)
    p_set.add_argument("--developer", default="")
    p_set.add_argument("--desc", default="")
    p_set.add_argument("--tags", default="")
    p_set.add_argument("--notes", default="")

    p_add = sub.add_parser("add-shot", help="upload one screenshot")
    p_add.add_argument("--game", required=True)
    p_add.add_argument("--file", required=True, type=Path)
    p_add.add_argument("--order", type=int, default=0)

    p_rm = sub.add_parser("rm-shot", help="remove a screenshot by URL")
    p_rm.add_argument("--game", required=True)
    p_rm.add_argument("--url", required=True)

    p_get = sub.add_parser("get", help="show profile + screenshots")
    p_get.add_argument("--game", required=True)

    sub.add_parser("list", help="list all profiles")
    args = ap.parse_args()

    url, key = load_env()

    if args.cmd == "set":
        tags = [t.strip() for t in args.tags.split(",") if t.strip()]
        try:
            req(url, key,
                "/rest/v1/game_profiles?on_conflict=game_name",
                method="POST",
                body=[{
                    "game_name": args.game,
                    "developer": args.developer,
                    "gameplay_desc": args.desc,
                    "tags": tags,
                    "notes": args.notes,
                }],
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
        except SystemExit as e:
            if "does not exist" in str(e) or "relation" in str(e):
                raise SystemExit(
                    "[profile] game_profiles 表不存在。请先在 Supabase SQL Editor 执行 "
                    "scripts/sql/game_profiles.sql,或用 PAT 让我代跑。\n" + str(e))
            raise
        print(f"[profile] upserted {args.game}")

    elif args.cmd == "add-shot":
        if not args.file.exists():
            raise SystemExit(f"[profile] file not found: {args.file}")
        obj = f"{args.game}/{args.file.name}"
        obj_enc = urllib.parse.quote(obj, safe="/")
        with open(args.file, "rb") as f:
            status, _ = req(url, key,
                            f"/storage/v1/object/{BUCKET}/{obj_enc}",
                            method="POST", body=f.read(),
                            headers={"Content-Type": "application/octet-stream",
                                     "x-upsert": "true"}, raw=True)
        if status not in (200, 201):
            raise SystemExit(f"[profile] upload failed: {status}")
        pub = (f"{url}/storage/v1/object/public/{BUCKET}/"
               f"{urllib.parse.quote(obj, safe='/')}")
        try:
            req(url, key, "/rest/v1/game_screenshots", method="POST",
                body=[{"game_name": args.game, "url": pub,
                       "sort_order": args.order}],
                headers={"Prefer": "return=minimal"})
        except SystemExit as e:
            if "does not exist" in str(e) or "relation" in str(e):
                raise SystemExit(
                    "[profile] game_screenshots 表不存在。请先执行 SQL。\n" + str(e))
            raise
        print(f"[profile] uploaded: {pub}")

    elif args.cmd == "rm-shot":
        rows = req(url, key,
                   "/rest/v1/game_screenshots"
                   f"?game_name=eq.{urllib.parse.quote(args.game)}"
                   f"&url=eq.{urllib.parse.quote(args.url)}")
        if not rows:
            print("[profile] no matching screenshot row; nothing to delete")
            return
        for r in rows:
            obj = r["url"].split(f"/object/public/{BUCKET}/")[-1]
            req(url, key,
                f"/storage/v1/object/{BUCKET}/{urllib.parse.quote(obj, safe='/')}",
                method="DELETE")
            req(url, key, f"/rest/v1/game_screenshots?id=eq.{r['id']}",
                method="DELETE")
        print(f"[profile] removed {len(rows)} screenshot(s)")

    elif args.cmd == "get":
        rows = req(url, key,
                   "/rest/v1/game_profiles"
                   f"?game_name=eq.{urllib.parse.quote(args.game)}")
        if not rows:
            print("[profile] not found")
            return
        g = rows[0]
        shots = req(url, key,
                    "/rest/v1/game_screenshots"
                    f"?game_name=eq.{urllib.parse.quote(args.game)}"
                    "&order=sort_order.asc")
        g["screenshots"] = shots or []
        print(json.dumps(g, ensure_ascii=False, indent=2))

    elif args.cmd == "list":
        rows = req(url, key,
                   "/rest/v1/game_profiles?select=game_name,developer,updated_at"
                   "&order=game_name.asc")
        for r in rows or []:
            print(f"{r['game_name']}\t{r.get('developer','')}\t{r.get('updated_at','')}")


if __name__ == "__main__":
    main()
