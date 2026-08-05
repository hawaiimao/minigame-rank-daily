import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  // Auth: prefer a signed-in editor JWT; fall back to the legacy
  // X-Profile-Key (PROFILE_ADMIN_KEY) for compatibility.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500, headers: cors });
  }
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const authHeader = req.headers.get("authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const adminKey = Deno.env.get("PROFILE_ADMIN_KEY") || "";
  const legacyKey = req.headers.get("x-client-info") || "";

  if (jwt) {
    // Verify the user JWT and require the editor role.
    const { data: user, error: userErr } = await sb.auth.getUser(jwt);
    if (userErr || !user || !user.user) {
      return new Response("Unauthorized", { status: 401, headers: cors });
    }
    const { data: prof, error: profErr } = await sb
      .from("profiles")
      .select("role")
      .eq("user_id", user.user.id)
      .maybeSingle();
    if (profErr) {
      return new Response("Unauthorized", { status: 401, headers: cors });
    }
    if (!prof || prof.role !== "editor") {
      return new Response("Forbidden: viewer account cannot write", { status: 403, headers: cors });
    }
  } else if (!adminKey || legacyKey !== adminKey) {
    return new Response("Unauthorized", { status: 401, headers: cors });
  }

  const ct = req.headers.get("content-type") || "";
  try {
    if (ct.includes("multipart/form-data")) {
      // Upload screenshots: fields game_name + files[]
      const form = await req.formData();
      const gameName = String(form.get("game_name") || "").trim();
      const files = form.getAll("files").filter((f) => f instanceof File);
      if (!gameName || !files.length) {
        return new Response("game_name and files required", { status: 400, headers: cors });
      }
      const urls = [];
      for (const f of files) {
        const safeName = f.name.replace(/[^\w.\-]+/g, "_");
        // Use an ASCII-safe prefix derived from the game name (encodeURIComponent
        // keeps CJK out of the storage key; Supabase Storage rejects non-ASCII keys).
        const safePrefix = encodeURIComponent(gameName).replace(/%/g, "_").slice(0, 60) || "g";
        const path = `${safePrefix}/${Date.now()}_${safeName}`;
        const { error: upErr } = await sb.storage
          .from("game-shots")
          .upload(path, f, { contentType: f.type || "application/octet-stream", upsert: true });
        if (upErr) throw upErr;
        const { data: pub } = sb.storage.from("game-shots").getPublicUrl(path);
        urls.push(pub.publicUrl);
      }
      const { data: existing, error: selErr } = await sb
        .from("game_screenshots")
        .select("id")
        .eq("game_name", gameName)
        .order("sort_order", { ascending: true });
      if (selErr) throw selErr;
      const start = (existing || []).length;
      const rows = urls.map((u, i) => ({
        game_name: gameName,
        url: u,
        sort_order: start + i,
      }));
      const { error: insErr } = await sb.from("game_screenshots").insert(rows);
      if (insErr) throw insErr;
      return new Response(JSON.stringify({ ok: true, urls }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // JSON: support delete_shot action + save profile
    const body = await req.json();
    if (body.action === "delete_shot") {
      const targetUrl = String(body.url || "").trim();
      if (!targetUrl) {
        return new Response("url required", { status: 400, headers: cors });
      }
      // Extract storage object path from public URL.
      const marker = "/object/public/game-shots/";
      const idx = targetUrl.indexOf(marker);
      if (idx === -1) {
        return new Response("invalid url", { status: 400, headers: cors });
      }
      const objPath = decodeURIComponent(targetUrl.slice(idx + marker.length));
      // Delete storage object.
      const { error: delErr } = await sb.storage.from("game-shots").remove([objPath]);
      if (delErr) throw delErr;
      // Delete DB row by url.
      const { error: dbErr } = await sb
        .from("game_screenshots")
        .delete()
        .eq("url", targetUrl);
      if (dbErr) throw dbErr;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (body.action === "create_game") {
      const name = String(body.name || "").trim();
      if (!name) {
        return new Response("name required", { status: 400, headers: cors });
      }
      // Beijing date (UTC+8).
      const now = new Date();
      const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
      const date = beijing.toISOString().slice(0, 10);
      const { error: insErr } = await sb
        .from("games")
        .upsert(
          { name, first_seen_at: date, last_seen_at: date },
          { onConflict: "name", ignoreDuplicates: true },
        );
      if (insErr) throw insErr;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const gameName = String(body.game_name || "").trim();
    if (!gameName) {
      return new Response("game_name required", { status: 400, headers: cors });
    }
    const row = {
      game_name: gameName,
      developer: String(body.developer || ""),
      gameplay_desc: String(body.gameplay_desc || ""),
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      notes: String(body.notes || ""),
      abandoned: body.abandoned === true,
      abandon_reason: String(body.abandon_reason || ""),
      value: ["high", "mid", "low"].includes(body.value) ? body.value : "",
      favorite: body.favorite === true,
    };
    const { error } = await sb.from("game_profiles").upsert(row, { onConflict: "game_name" });
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});