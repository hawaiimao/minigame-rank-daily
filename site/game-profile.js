/* Game profile page: product-dimension list -> click into edit view.
 * Read via anon key; write via save-profile Edge Function (x-client-info admin key).
 */
(function () {
  const FN_URL = "https://pjwwwxanhtvzkscumedm.supabase.co/functions/v1/save-profile";
  const ADMIN_KEY = (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ADMIN_KEY) || "";

  const state = {
    games: [],        // [{name}]
    profiles: {},     // name -> profile row
    shots: {},        // name -> [shot rows]
    list: [],         // computed merged list
    current: null,
    dirty: false,
  };

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[m]));
  }

  async function loadAll() {
    const [games, profiles, shots] = await Promise.all([
      window.sb.select("games", { select: "name", order: "name.asc", limit: 5000 }),
      window.sb.select("game_profiles", { limit: 5000 }),
      window.sb.select("game_screenshots", { select: "game_name,url,sort_order", order: "sort_order.asc,id.asc", limit: 5000 }),
    ]);
    state.games = games || [];
    state.profiles = {};
    for (const p of profiles || []) state.profiles[p.game_name] = p;
    state.shots = {};
    for (const s of shots || []) {
      if (!state.shots[s.game_name]) state.shots[s.game_name] = [];
      state.shots[s.game_name].push(s);
    }
    buildList();
  }

  function buildList() {
    const rows = [];
    for (const g of state.games) {
      const p = state.profiles[g.name];
      const sh = state.shots[g.name] || [];
      rows.push({
        name: g.name,
        has: !!p,
        developer: (p && p.developer) || "",
        desc: (p && p.gameplay_desc) || "",
        tags: (p && p.tags) || [],
        updated: (p && p.updated_at) || "",
        firstShot: sh.length ? sh[0].url : "",
        shotCount: sh.length,
      });
    }
    // 建档的在前(按 updated_at 降序),未建档按名字
    rows.sort((a, b) => {
      if (a.has !== b.has) return a.has ? -1 : 1;
      if (a.has && b.has) {
        return (b.updated || "").localeCompare(a.updated || "");
      }
      return a.name.localeCompare(b.name, "zh");
    });
    state.list = rows;
    renderList();
  }

  function renderList() {
    const q = $("gp-search").value.trim().toLowerCase();
    const filtered = q
      ? state.list.filter((r) =>
          r.name.toLowerCase().includes(q) || r.developer.toLowerCase().includes(q))
      : state.list;
    const box = $("gp-list");
    box.innerHTML = "";
    $("gp-count").textContent = `共 ${filtered.length} 款（已建档 ${filtered.filter((r) => r.has).length}）`;
    if (!filtered.length) {
      box.innerHTML = '<div class="gp-empty">没有匹配的产品。</div>';
      return;
    }
    for (const r of filtered.slice(0, 300)) {
      const card = document.createElement("div");
      card.className = "gp-card";
      const thumb = r.firstShot
        ? `<img class="gp-card-thumb" src="${esc(r.firstShot)}" loading="lazy" alt="" />`
        : `<div class="gp-card-thumb empty">无图</div>`;
      const tags = (r.tags || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
      const dev = r.developer ? `<div class="gp-card-dev">${esc(r.developer)}</div>` : "";
      const meta = r.has
        ? `更新 ${esc((r.updated || "").slice(0, 10))} · ${r.shotCount} 图`
        : "未建档";
      card.innerHTML = `
        ${thumb}
        <div class="gp-card-body">
          <div class="gp-card-name">${esc(r.name)}${r.has ? '<span class="badge-has">已建档</span>' : ""}</div>
          ${dev}
          ${tags ? `<div class="gp-card-tags">${tags}</div>` : ""}
          ${r.desc ? `<div class="gp-card-desc">${esc(r.desc)}</div>` : ""}
          <div class="gp-card-meta">${meta}</div>
        </div>`;
      card.addEventListener("click", () => showEdit(r.name));
      box.appendChild(card);
    }
  }

  function showEdit(name) {
    state.current = name;
    $("gp-toolbar").style.display = "none";
    $("gp-list").style.display = "none";
    $("gp-form").style.display = "block";

    // 进入前先隐藏两个子视图,避免状态残留
    document.getElementById("gp-view").style.display = "none";
    document.getElementById("gp-edit-mode").style.display = "none";

    const p = state.profiles[name] || null;
    if (p) {
      renderView(p);          // 已建档 -> 只读展示 + 编辑按钮
    } else {
      enterEditMode();        // 未建档 -> 直接编辑表单
    }
    $("gp-status").textContent = "";
  }

  function renderView(p) {
    const fields = [
      ["开发商", p.developer || "—"],
      ["玩法", p.gameplay_desc || "—"],
      ["标签", (p.tags || []).join(", ") || "—"],
      ["备注", p.notes || "—"],
      ["更新时间", (p.updated_at || "").slice(0, 16).replace("T", " ")],
    ];
    const view = document.getElementById("gp-view");
    view.style.display = "block";
    view.querySelector(".gp-view-name").textContent = p.game_name;
    const dl = view.querySelector(".gp-view-fields");
    dl.innerHTML = "";
    for (const [k, v] of fields) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    renderViewShots(p.game_name);
    document.getElementById("gp-edit-mode").style.display = "none";
  }

  function renderViewShots(name) {
    const box = document.getElementById("gp-view-shots");
    box.innerHTML = "";
    const sh = state.shots[name] || [];
    if (!sh.length) { box.innerHTML = '<span class="gp-hint">暂无截图</span>'; return; }
    for (const s of sh) {
      const img = document.createElement("img");
      img.src = s.url; img.alt = ""; img.loading = "lazy";
      img.style.cssText = "width:160px;height:110px;object-fit:cover;border-radius:6px;border:1px solid #ddd;";
      box.appendChild(img);
    }
  }

  function enterEditMode() {
    const p = state.profiles[state.current] || { game_name: state.current, developer: "", gameplay_desc: "", tags: [], notes: "" };
    document.getElementById("gp-view").style.display = "none";
    const edit = document.getElementById("gp-edit-mode");
    const editTitle = document.getElementById("gp-edit-title");
    if (editTitle) editTitle.textContent = state.current;
    edit.style.display = "block";
    $("gp-developer").value = p.developer || "";
    $("gp-desc").value = p.gameplay_desc || "";
    $("gp-tags").value = (p.tags || []).join(", ");
    $("gp-notes").value = p.notes || "";
    renderShots();
  }

  function renderShots() {
    const box = $("gp-shots");
    box.innerHTML = "";
    const sh = state.shots[state.current] || [];
    if (!sh.length) {
      box.innerHTML = '<span class="gp-hint">暂无截图</span>';
      return;
    }
    for (const s of sh) {
      const d = document.createElement("div");
      d.className = "gp-shot";
      d.innerHTML = `<img src="${esc(s.url)}" alt="" loading="lazy" /><button class="del" data-id="${s.id}" title="删除">×</button>`;
      box.appendChild(d);
    }
  }

  async function save() {
    const body = {
      game_name: state.current,
      developer: $("gp-developer").value.trim(),
      gameplay_desc: $("gp-desc").value.trim(),
      tags: $("gp-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      notes: $("gp-notes").value.trim(),
    };
    $("gp-status").textContent = "保存中…";
    try {
      const resp = await fetch(FN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + (window.APP_CONFIG.SUPABASE_KEY || ""),
          "x-client-info": ADMIN_KEY,
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || ("HTTP " + resp.status));
      state.profiles[state.current] = body;
      $("gp-status").textContent = "已保存到数据库。";
    } catch (err) {
      $("gp-status").textContent = "保存失败：" + err.message;
    }
  }

  async function upload() {
    const files = Array.from($("gp-file").files || []);
    if (!files.length || !state.current) return;
    const fd = new FormData();
    fd.append("game_name", state.current);
    for (const f of files) fd.append("files", f);
    $("gp-status").textContent = "上传中…";
    try {
      const resp = await fetch(FN_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + (window.APP_CONFIG.SUPABASE_KEY || ""),
          "x-client-info": ADMIN_KEY,
        },
        body: fd,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || ("HTTP " + resp.status));
      $("gp-file").value = "";
      await refreshShots(state.current);
      $("gp-status").textContent = "截图已上传。";
    } catch (err) {
      $("gp-status").textContent = "上传失败：" + err.message;
    }
  }

  async function refreshShots(name) {
    const shots = await window.sb.select("game_screenshots", {
      match: { game_name: name },
      order: "sort_order.asc,id.asc",
      limit: 200,
    });
    state.shots[name] = shots || [];
    renderShots();
  }

  function backToList() {
    state.current = null;
    $("gp-toolbar").style.display = "";
    $("gp-list").style.display = "";
    $("gp-form").style.display = "none";
    document.getElementById("gp-view").style.display = "none";
    buildList();
  }

  function init() {
    $("gp-save").addEventListener("click", save);
    $("gp-upload-btn").addEventListener("click", upload);
    $("gp-view-back").addEventListener("click", backToList);
    $("gp-edit-btn").addEventListener("click", enterEditMode);
    $("gp-clear").addEventListener("click", () => { $("gp-search").value = ""; renderList(); });
    $("gp-search").addEventListener("input", renderList);
  }

  (async function () {
    init();
    try {
      await loadAll();
      $("gp-loading").style.display = "none";
      const q = new URLSearchParams(location.search).get("name");
      if (q && state.profiles[q] !== undefined) {
        showEdit(q);
      } else if (q) {
        showEdit(q); // 未建档也允许直接编辑
      }
    } catch (err) {
      $("gp-loading").textContent = "加载失败：" + err.message;
    }
  })();
})();