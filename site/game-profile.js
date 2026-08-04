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
    abandoned: false,
    boardMap: {},        // name -> board_history
    page: 0,             // 列表当前页
  };

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[m]));
  }

  const BOARD_PLATFORM = { wx: "微信", douyin: "抖音", taptap: "TapTap" };

  function fmtBoard(key) {
    // "wx/???" -> "??????"
    const [plat, board] = String(key).split("/");
    return (BOARD_PLATFORM[plat] || plat) + "·" + (board || "");
  }

  async function loadAll() {
    const [games, profiles, shots, base] = await Promise.all([
      window.sb.select("games", { select: "name,first_seen_at,category,publisher_name", order: "first_seen_at.desc", limit: 5000 }),
      window.sb.select("game_profiles", { limit: 5000 }),
      window.sb.select("game_screenshots", { select: "id,game_name,url,sort_order", order: "sort_order.asc,id.asc", limit: 5000 }),
      fetch("data/base/games.json").then((r) => r.ok ? r.json() : null).catch(() => null),
    ]);
    if (base && base.games) {
      for (const [name, entry] of Object.entries(base.games)) {
        if (entry && entry.board_history) state.boardMap[name] = entry.board_history;
      }
    }
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
      const bh = state.boardMap[g.name] || {};
      const boardKeys = Object.keys(bh);
      boardKeys.sort((a, b) => (bh[a].first_seen || "").localeCompare(bh[b].first_seen || ""));
      const sourceBoards = boardKeys.map(fmtBoard);
      rows.push({
        name: g.name,
        has: !!p,
        developer: (p && p.developer) || (g.publisher_name || ""),
        desc: (p && p.gameplay_desc) || "",
        tags: (p && p.tags) || [],
        updated: (p && p.updated_at) || "",
        abandoned: !!(p && p.abandoned),
        category: g.category || "",
        publisher: (g.publisher_name || (p && p.developer) || ""),
        joined: g.first_seen_at || "",
        sourceBoards: sourceBoards,
        firstShot: sh.length ? sh[0].url : "",
        shotCount: sh.length,
      });
    }
    // 按新加入顺序(first_seen_at 降序),无时间戳的排最后
    rows.sort((a, b) => {
      const ta = a.joined || "", tb = b.joined || "";
      if (ta && tb) return tb.localeCompare(ta);
      if (ta) return -1;
      if (tb) return 1;
      return a.name.localeCompare(b.name, "zh");
    });
    state.list = rows;
    renderList();
  }

  function renderPager(total, totalPages) {
    const pager = document.getElementById("gp-pager");
    const info = document.getElementById("gp-page-info");
    const prev = document.getElementById("gp-prev");
    const next = document.getElementById("gp-next");
    if (!pager) return;
    if (totalPages <= 1) { pager.style.display = "none"; return; }
    pager.style.display = "flex";
    const from = state.page * 20 + 1;
    const to = Math.min(total, (state.page + 1) * 20);
    info.textContent = `${from}-${to} / 共 ${total} 款 · 第 ${state.page + 1}/${totalPages} 页`;
    prev.disabled = state.page === 0;
    next.disabled = state.page >= totalPages - 1;
    const input = document.getElementById("gp-page-input");
    const go = document.getElementById("gp-page-go");
    if (input) { input.max = totalPages; input.value = state.page + 1; }
    if (go) go.disabled = totalPages <= 1;
  }

  function jumpToPage() {
    const input = document.getElementById("gp-page-input");
    if (!input) return;
    const totalPages = Math.max(1, Math.ceil(state.list.length / 20));
    let n = parseInt(input.value, 10);
    if (isNaN(n)) n = 1;
    n = Math.max(1, Math.min(totalPages, n));
    state.page = n - 1;
    renderList();
  }

  function setBoardTag(id, gameName) {
    const el = document.getElementById(id);
    if (!el) return;
    const bh = state.boardMap[gameName] || {};
    const keys = Object.keys(bh);
    keys.sort((a, b) => (bh[a].first_seen || "").localeCompare(bh[b].first_seen || ""));
    const text = keys.map(fmtBoard).join(" / ");
    el.textContent = text;
    el.style.display = text ? "" : "none";
  }

  function openLightbox(srcUrl) {
    const lb = document.getElementById("gp-lightbox");
    if (!lb || !srcUrl) return;
    const img = lb.querySelector("img");
    if (img) img.src = srcUrl;
    lb.style.display = "flex";
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
    const PER_PAGE = 20;
    const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
    if (state.page >= totalPages) state.page = totalPages - 1;
    const pageRows = filtered.slice(state.page * PER_PAGE, (state.page + 1) * PER_PAGE);
    for (const r of pageRows) {
      const card = document.createElement("div");
      card.className = "gp-card" + (r.abandoned ? " abandoned" : "");
      const thumb = r.firstShot
        ? `<img class="gp-card-thumb" src="${esc(r.firstShot)}" loading="lazy" alt="" />`
        : `<div class="gp-card-thumb empty">无图</div>`;
      const tags = (r.tags || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
      const dev = r.developer ? `<div class="gp-card-pub">${esc(r.developer)}</div>` : "";
      const abandonBadge = r.abandoned ? '<span class="badge-abandoned">玩法放弃</span>' : "";
      const srcBoards = (r.sourceBoards || []).slice(0, 3).map((b) => `<span class="badge-src">${esc(b)}</span>`).join("");
      const srcLine = srcBoards ? `<div class="gp-card-src">${srcBoards}</div>` : "";
      const joined = (r.joined || "").slice(0, 10);
      const joinedLine = joined ? `上榜 ${joined}` : "";
      const meta = r.has
        ? `${r.shotCount} 图${joinedLine ? " · " + joinedLine : ""}`
        : joinedLine || "未建档";
      card.innerHTML = `
        ${thumb}
        <div class="gp-card-body">
          <div class="gp-card-head">
            <div class="gp-card-name">${esc(r.name)}${r.has ? '<span class="badge-has">已建档</span>' : ""}</div>
          </div>
          ${srcLine}
          ${dev}
          ${tags ? `<div class="gp-card-tags">${tags}</div>` : ""}
          <div class="gp-card-meta">${abandonBadge} ${meta}</div>
        </div>`;
      card.addEventListener("click", () => showEdit(r.name));
      box.appendChild(card);
    }
    renderPager(filtered.length, totalPages);
  }
  document.getElementById("gp-page-go").addEventListener("click", jumpToPage);
  document.getElementById("gp-page-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") jumpToPage();
  });

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
      ["开发商", p.developer || "—", false],
      ["玩法", p.gameplay_desc || "—", true],
      ["标签", (p.tags || []).join(", ") || "—", false],
      ["备注", p.notes || "—", false],
      ["更新时间", (p.updated_at || "").slice(0, 16).replace("T", " "), false],
    ];
    const view = document.getElementById("gp-view");
    view.style.display = "block";
    view.querySelector(".gp-view-name").textContent = p.game_name;
    setBoardTag("gp-view-board", p.game_name);
    const dl = view.querySelector(".gp-view-fields");
    dl.innerHTML = "";
    for (const [k, v, isMd] of fields) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      if (isMd) dd.innerHTML = renderMarkdown(v); else dd.textContent = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    renderViewShots(p.game_name);
    document.getElementById("gp-edit-mode").style.display = "none";
  }

  function renderMarkdown(src) {
    if (!src) return "";
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0, inCode = false, codeBuf = [], inUl = false, inOl = false, inQuote = false;
    const closeUl = () => { if (inUl) { out.push("</ul>"); inUl = false; } };
    const closeOl = () => { if (inOl) { out.push("</ol>"); inOl = false; } };
    const closeQuote = () => { if (inQuote) { out.push("</blockquote>"); inQuote = false; } };
    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();
      if (line.startsWith("```")) {
        if (!inCode) { closeUl(); closeOl(); closeQuote(); inCode = true; codeBuf = []; }
        else { out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>"); inCode = false; }
        i++; continue;
      }
      if (inCode) { codeBuf.push(raw); i++; continue; }
      if (!line) { closeUl(); closeOl(); closeQuote(); out.push(""); i++; continue; }
      const hm = line.match(/^(#{1,6})\s+(.*)$/);
      if (hm) { closeUl(); closeOl(); closeQuote(); out.push(`<h${hm[1].length}>${inlineMd(hm[2])}</h${hm[1].length}>`); i++; continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { closeUl(); closeOl(); closeQuote(); out.push("<hr>"); i++; continue; }
      if (line.startsWith(">")) {
        closeUl(); closeOl();
        if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
        out.push("<p>" + inlineMd(line.replace(/^>\s?/, "")) + "</p>");
        i++; continue;
      }
      const ulm = line.match(/^[-*+]\s+(.*)$/);
      if (ulm) { closeOl(); closeQuote(); if (!inUl) { out.push("<ul>"); inUl = true; } out.push("<li>" + inlineMd(ulm[1]) + "</li>"); i++; continue; }
      const olm = line.match(/^\d+[.)]\s+(.*)$/);
      if (olm) { closeUl(); closeQuote(); if (!inOl) { out.push("<ol>"); inOl = true; } out.push("<li>" + inlineMd(olm[1]) + "</li>"); i++; continue; }
      closeUl(); closeOl(); closeQuote();
      out.push("<p>" + inlineMd(line) + "</p>");
      i++;
    }
    if (inCode) out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
    closeUl(); closeOl(); closeQuote();
    return out.join("\n");
  }

  function inlineMd(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
        const u = esc(url).trim();
        return /^(https?:|\/)/i.test(u) ? `<img src="${u}" alt="${alt}" loading="lazy" />` : "";
      })
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
        const u = esc(url).trim();
        const safe = /^(https?:|mailto:|#|\/)/i.test(u) ? u : "#";
        return `<a href="${safe}" target="_blank" rel="noopener">${text}</a>`;
      });
  }

  function initMdEditor() {
    const toolbar = document.getElementById("gp-md-toolbar");
    const ta = document.getElementById("gp-desc");
    const pv = document.getElementById("gp-desc-preview");
    if (!toolbar || !ta) return;

    function updatePreview() { pv.innerHTML = renderMarkdown(ta.value); }

    toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      e.preventDefault();
      const start = ta.selectionStart, end = ta.selectionEnd;
      const sel = ta.value.slice(start, end);
      let insert, selStart, selEnd;
      if (btn.dataset.wrap) {
        insert = btn.dataset.wrap + sel + btn.dataset.wrap;
        selStart = start + btn.dataset.wrap.length;
        selEnd = end + btn.dataset.wrap.length;
      } else if (btn.dataset.mdBlock) {
        insert = btn.dataset.mdBlock + "\n" + sel + "\n" + btn.dataset.mdBlock;
        selStart = start + btn.dataset.mdBlock.length + 1;
        selEnd = selStart + sel.length;
      } else {
        insert = btn.dataset.md || "";
        selStart = start + insert.length;
        selEnd = selStart;
      }
      ta.setRangeText(insert, start, end, "end");
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const tabs = document.querySelectorAll("#gp-md-toolbar .md-tab");
    tabs.forEach((t) => t.addEventListener("click", () => switchMdMode(t.dataset.mode)));
    ta.addEventListener("input", updatePreview);
  }

  function switchMdMode(mode) {
    const ta = document.getElementById("gp-desc");
    const pv = document.getElementById("gp-desc-preview");
    document.querySelectorAll("#gp-md-toolbar .md-tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
    if (mode === "preview") {
      pv.innerHTML = renderMarkdown(ta.value);
      ta.style.display = "none";
      pv.style.display = "block";
    } else {
      ta.style.display = "";
      pv.style.display = "none";
    }
  }

  function renderViewShots(name) {
    const box = document.getElementById("gp-view-shots");
    box.innerHTML = "";
    const sh = state.shots[name] || [];
    if (!sh.length) { box.innerHTML = '<span class="gp-hint">暂无截图</span>'; return; }
    for (const s of sh) {
      const img = document.createElement("img");
      img.className = "gp-view-shot";
      img.src = s.url; img.alt = ""; img.loading = "lazy";
      img.addEventListener("click", () => openLightbox(s.url));
      box.appendChild(img);
    }
  }

  function enterEditMode() {
    const p = state.profiles[state.current] || { game_name: state.current, developer: "", gameplay_desc: "", tags: [], notes: "" };
    document.getElementById("gp-view").style.display = "none";
    const edit = document.getElementById("gp-edit-mode");
    const editTitle = document.getElementById("gp-edit-title");
    if (editTitle) editTitle.textContent = state.current;
    setBoardTag("gp-edit-board", state.current);
    edit.style.display = "block";
    const g = state.games.find((x) => x.name === state.current);
    $("gp-developer").value = p.developer || (g && g.publisher_name) || "";
    $("gp-desc").value = p.gameplay_desc || "";
    $("gp-tags").value = (p.tags || []).join(", ");
    $("gp-notes").value = p.notes || "";
    state.abandoned = !!p.abandoned;
    updateAbandonUI();
    renderShots();
  }

  async function deleteShot(s) {
    if (!confirm("确定删除这张截图吗？此操作不可撤销。")) return;
    $("gp-status").textContent = "正在删除截图…";
    try {
      const resp = await fetch(FN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + (window.APP_CONFIG.SUPABASE_KEY || ""),
          "x-client-info": ADMIN_KEY,
        },
        body: JSON.stringify({ action: "delete_shot", url: s.url }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || ("HTTP " + resp.status));
      const sh = state.shots[state.current] || [];
      state.shots[state.current] = sh.filter((x) => x.id !== s.id);
      renderShots();
      $("gp-status").textContent = "截图已删除。";
    } catch (err) {
      $("gp-status").textContent = "删除失败：" + err.message;
    }
  }

  function updateAbandonUI() {
    const ab = document.getElementById("gp-abandon");
    const un = document.getElementById("gp-unabandon");
    if (!ab || !un) return;
    const a = !!state.abandoned;
    ab.style.display = a ? "none" : "";
    un.style.display = a ? "" : "none";
    const edit = document.getElementById("gp-edit-mode");
    if (edit) edit.classList.toggle("is-abandoned", a);
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
      const im = d.querySelector("img");
      if (im) im.addEventListener("click", () => openLightbox(s.url));
      box.appendChild(d);
    }
    box.querySelectorAll(".del").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.id);
        const shot = sh.find((s) => s.id === id);
        if (!shot) return;
        deleteShot(shot);
      });
    });
  }

  async function save() {
    const body = {
      game_name: state.current,
      developer: $("gp-developer").value.trim(),
      gameplay_desc: $("gp-desc").value.trim(),
      tags: $("gp-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      notes: $("gp-notes").value.trim(),
      abandoned: state.abandoned || false,
    };
    const files = Array.from($("gp-file").files || []);
    $("gp-status").textContent = files.length ? "保存并上传中…" : "保存中…";
    try {
      // 1) 保存档案文字
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

      // 2) 如有选中的图片,一并上传
      if (files.length) {
        const fd = new FormData();
        fd.append("game_name", state.current);
        for (const f of files) fd.append("files", f);
        const upResp = await fetch(FN_URL, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + (window.APP_CONFIG.SUPABASE_KEY || ""),
            "x-client-info": ADMIN_KEY,
          },
          body: fd,
        });
        const upData = await upResp.json().catch(() => ({}));
        if (!upResp.ok || !upData.ok) throw new Error(upData.error || ("HTTP " + upResp.status));
        $("gp-file").value = "";
        await refreshShots(state.current);
      }

      $("gp-status").textContent = files.length ? "已保存档案并上传截图。" : "已保存到数据库。";
    } catch (err) {
      $("gp-status").textContent = "保存失败：" + err.message;
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
    initMdEditor();
    $("gp-save").addEventListener("click", save);
    $("gp-view-back").addEventListener("click", backToList);
    $("gp-back").addEventListener("click", backToList);
    $("gp-edit-btn").addEventListener("click", enterEditMode);
    $("gp-abandon").addEventListener("click", () => { state.abandoned = true; updateAbandonUI(); });
    $("gp-unabandon").addEventListener("click", () => { state.abandoned = false; updateAbandonUI(); });
    $("gp-clear").addEventListener("click", () => { $("gp-search").value = ""; state.page = 0; renderList(); });
    $("gp-prev").addEventListener("click", () => { if (state.page > 0) { state.page--; renderList(); } });
    $("gp-next").addEventListener("click", () => { state.page++; renderList(); });
    $("gp-search").addEventListener("input", () => { state.page = 0; renderList(); });
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