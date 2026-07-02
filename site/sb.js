/* Thin wrapper around Supabase PostgREST for read-only front-end use.
 * Only depends on window.APP_CONFIG (config.js).
 *
 * Usage:
 *   const rows = await sb.select('daily_snapshots', {
 *     match: { snapshot_date: '2026-07-02' },
 *     order: 'platform.asc,board.asc,rank.asc',
 *     limit: 1000,
 *   });
 */
(function () {
  const cfg = window.APP_CONFIG || {};

  function url(path) {
    const base = (cfg.SUPABASE_URL || "").replace(/\/$/, "");
    return `${base}/rest/v1${path}`;
  }

  function headers(extra = {}) {
    return {
      apikey: cfg.SUPABASE_KEY,
      Authorization: `Bearer ${cfg.SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async function select(table, opts = {}) {
    const params = new URLSearchParams();
    params.set("select", opts.select || "*");
    if (opts.order) params.set("order", opts.order);
    if (opts.match) {
      for (const [k, v] of Object.entries(opts.match)) {
        params.set(k, `eq.${v}`);
      }
    }
    if (opts.raw) {
      // Free-form filters like `snapshot_date=gte.2026-06-01`.
      for (const [k, v] of Object.entries(opts.raw)) {
        params.set(k, v);
      }
    }

    // Supabase's PostgREST hard-caps a single response at 1000 rows.
    // Auto-paginate via Range header until we have `opts.limit` (default:
    // all matching rows).
    const wantAll = opts.limit == null;
    const maxRows = wantAll ? Infinity : opts.limit;
    const pageSize = 1000;
    const collected = [];
    let offset = 0;

    while (collected.length < maxRows) {
      const remaining = maxRows - collected.length;
      const size = Math.min(pageSize, remaining);
      const from = offset;
      const to = offset + size - 1;
      const r = await fetch(`${url("/" + table)}?${params}`, {
        headers: headers({ Range: `${from}-${to}`, "Range-Unit": "items" }),
        cache: "no-cache",
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        throw new Error(`sb.select ${table} ${r.status} ${detail.slice(0, 120)}`);
      }
      const chunk = await r.json();
      collected.push(...chunk);
      // No more rows to fetch.
      if (chunk.length < size) break;
      offset += chunk.length;
      // Guard: never keep looping if server ignores Range and returns
      // the same first page again.
      if (offset === 0) break;
    }
    return collected;
  }

  async function upsert(table, rows, onConflict, prefer = "return=minimal") {
    const path = onConflict
      ? `/${table}?on_conflict=${onConflict}`
      : `/${table}`;
    const r = await fetch(url(path), {
      method: "POST",
      headers: headers({
        Prefer: `resolution=merge-duplicates,${prefer}`,
      }),
      body: JSON.stringify(rows),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`sb.upsert ${table} ${r.status} ${detail.slice(0, 120)}`);
    }
    // Only try to parse a body when the caller explicitly asked for one
    // via Prefer: return=representation. `return=minimal` — the default
    // — yields an empty body that JSON.parse would choke on.
    if (!prefer.includes("return=representation")) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  async function patch(table, patchBody, matchKey, matchValue) {
    const path = `/${table}?${matchKey}=eq.${encodeURIComponent(matchValue)}`;
    const r = await fetch(url(path), {
      method: "PATCH",
      headers: headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(patchBody),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`sb.patch ${table} ${r.status} ${detail.slice(0, 120)}`);
    }
  }

  window.sb = { select, upsert, patch };
})();
