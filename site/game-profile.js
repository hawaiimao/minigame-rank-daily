/* Game profile page: product-dimension list -> click into edit view.
 * Read via anon key; write via save-profile Edge Function (x-client-info admin key).
 */
(function () {
  const FN_URL = "https://pjwwwxanhtvzkscumedm.supabase.co/functions/v1/save-profile";
  const ADMIN_KEY = (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ADMIN_KEY) || "";
  const SB_URL = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || "";

  const state = {
    games: [],        // [{name}]
    profiles: {},     // name -> profile row
    shots: {},        // name -> [shot rows]
    list: [],         // computed merged list
    current: null,
    isNew: false,   // new-game mode
    dirty: false,
    abandoned: false,
    boardMap: {},        // name -> board_history
    latestRankMap: {},   // name -> {"wx/人气榜": 11} 当前榜单排名
    page: 0,             // 列表当前页
    filter: "",           // 价值/放弃筛选
    platformFilter: "wx", // wx | douyin | ios | android | taptap
    boardFilter: "畅销榜", // specific board under platformFilter
    favOnly: false,       // 我的收藏模式
  };

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[m]));
  }

  const BOARD_PLATFORM = { wx: "微信", douyin: "抖音", taptap: "TapTap", ios: "iOS", android: "安卓" };
  // Fixed platform ordering for board tags: 微信 → 抖音 → iOS → 安卓 → TapTap.
  const PLATFORM_SEQ = { wx: 0, douyin: 1, ios: 2, android: 3, taptap: 4 };
  // Boards available under each platform (mirrors site/app.js BOARD_LABELS).
  const PLATFORM_BOARDS = {
    wx: ["畅销榜", "畅玩榜", "人气榜"],
    douyin: ["畅销榜", "热门榜", "新游榜"],
    ios: ["美区免费榜", "国区免费榜", "日区免费榜"],
    android: ["美区免费榜"],
    taptap: ["预约榜"],
  };
  function boardSeq(key) {
    const plat = String(key).split("/")[0];
    return PLATFORM_SEQ[plat] ?? 99;
  }
  function sortBoardKeys(keys) {
    return [...keys].sort((a, b) => boardSeq(a) - boardSeq(b)
      || String(a).localeCompare(String(b), "zh"));
  }

  function fmtBoard(key, name) {
    // "wx/人气榜" -> "微信·人气榜"; name 存在时附加排名:
    //   当前在榜 -> 当前排名（来自最新快照）
    //   已掉榜   -> 历史最佳排名（来自 base/games.json board_history）
    const [plat, board] = String(key).split("/");
    const base = (BOARD_PLATFORM[plat] || plat) + "\u00b7" + (board || "");
    if (!name) return base;
    const rank = (state.latestRankMap[name] || {})[key];
    if (rank) return base + "\u00b7" + rank;
    const bh = (state.boardMap[name] || {})[key];
    if (bh && bh.best_rank) return base + "\u00b7 最佳 " + bh.best_rank;
    return base;
  }

  async function loadAll() {
    const [games, profiles, shots, base, latest] = await Promise.all([
      window.sb.select("games", { select: "name,first_seen_at,category,publisher_name", order: "first_seen_at.desc", limit: 5000 }),
      window.sb.select("game_profiles", { limit: 5000 }),
      window.sb.select("game_screenshots", { select: "id,game_name,url,sort_order", order: "sort_order.asc,id.asc", limit: 5000 }),
      fetch("data/base/games.json").then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch("data/latest.json").then((r) => r.ok ? r.json() : null).catch(() => null),
    ]);
    if (base && base.games) {
      for (const [name, entry] of Object.entries(base.games)) {
        if (entry && entry.board_history) state.boardMap[name] = entry.board_history;
      }
    }
    // 从最新榜单快照构建: 名称 -> {榜单key: 当前排名}
    if (latest && latest.platforms) {
      const rm = {};
      for (const [platKey, plat] of Object.entries(latest.platforms)) {
        for (const b of (plat && plat.boards) || []) {
          const bKey = platKey + "/" + (b.label || "");
          for (const row of (b.rows) || []) {
            if (!row || !row.name) continue;
            if (typeof row.rank === "number" || typeof row.rank === "string") {
              rm[row.name] = rm[row.name] || {};
              rm[row.name][bKey] = row.rank;
            }
          }
        }
      }
      state.latestRankMap = rm;
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
      const boardKeys = sortBoardKeys(Object.keys(bh));
      const sourceBoards = boardKeys.map((k) => fmtBoard(k, g.name));
      rows.push({
        name: g.name,
        has: !!p,
        developer: (p && p.developer) || (g.publisher_name || ""),
        desc: (p && p.gameplay_desc) || "",
        tags: (p && p.tags) || [],
        updated: (p && p.updated_at) || "",
        value: (p && p.value) || "",
        favorite: !!(p && p.favorite),
        abandonReason: (p && p.abandon_reason) || "",
        abandoned: !p || !["high", "mid", "low"].includes(p.value),
        category: g.category || "",
        publisher: (g.publisher_name || (p && p.developer) || ""),
        joined: g.first_seen_at || "",
        sourceBoards: sourceBoards,
        platformKeys: boardKeys,
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
    const keys = sortBoardKeys(Object.keys(bh));
    const text = keys.map((k) => fmtBoard(k, gameName)).join(" / ");
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

  function renderBoardFilter() {
    const box = document.getElementById("gp-board-filter");
    if (!box) return;
    box.innerHTML = "";
    const boards = PLATFORM_BOARDS[state.platformFilter] || [];
    for (const b of boards) {
      const btn = document.createElement("button");
      btn.dataset.board = b;
      btn.textContent = b;
      if (state.boardFilter === b) btn.classList.add("active");
      btn.onclick = () => {
        state.boardFilter = b;
        state.page = 0;
        renderBoardFilter();
        renderList();
      };
      box.appendChild(btn);
    }
  }

  function renderList() {
    const q = $("gp-search").value.trim().toLowerCase();
    let filtered = q
      ? state.list.filter((r) =>
          r.name.toLowerCase().includes(q) || r.developer.toLowerCase().includes(q))
      : state.list;
    // Platform + board filter: product must have appeared on this exact board.
    const boardKey = state.platformFilter + "/" + state.boardFilter;
    filtered = filtered.filter((r) =>
      (r.platformKeys || []).includes(boardKey));
    if (state.favOnly) {
      filtered = filtered.filter((r) => r.favorite);
    }
    const f = state.filter;
    if (f === "high" || f === "mid" || f === "low") {
      filtered = filtered.filter((r) => r.value === f);
    } else if (f === "abandoned") {
      filtered = filtered.filter((r) => r.abandoned);
    }
    const tbody = document.querySelector("#tbl-game tbody");
    tbody.innerHTML = "";
    $("gp-count").textContent = `共 ${filtered.length} 款（已建档 ${filtered.filter((r) => r.has).length}）`;
    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">没有匹配的产品。</td></tr>';
      renderMore(0);
      return;
    }
    // Date-group totals across the whole filtered set (publishers-style
    // grouping: newest → oldest with a date divider row per day).
    const groupTotals = new Map();
    for (const r of filtered) {
      const d = (r.joined || "").slice(0, 10) || "未知日期";
      groupTotals.set(d, (groupTotals.get(d) || 0) + 1);
    }
    const PAGE_SIZE = 50;
    const shown = filtered.slice(0, (state.page + 1) * PAGE_SIZE);
    let currentDate = null;
    for (const r of shown) {
      const seenDate = (r.joined || "").slice(0, 10) || "未知日期";
      if (seenDate !== currentDate) {
        currentDate = seenDate;
        const tr = document.createElement("tr");
        tr.className = "date-divider";
        tr.innerHTML = `<td colspan="5">
          <span class="dv-date">${esc(seenDate)}</span>
          <span class="dv-count">首次上榜 ${groupTotals.get(seenDate) || 0} 款</span>
        </td>`;
        tbody.appendChild(tr);
      }
      const effVal = r.value || "abandoned";
      const tr = document.createElement("tr");
      tr.className = "gp-tr v-" + esc(effVal);
      const thumb = r.firstShot
        ? `<img class="gp-thumb" src="${esc(r.firstShot)}" loading="lazy" alt="" />`
        : `<span class="gp-thumb empty">无图</span>`;
      const srcBoards = (r.sourceBoards || []).slice(0, 3).map((b) => `<span class="badge-src">${esc(b)}</span>`).join("");
      const actBtns = `
            <button class="gp-card-fav${r.favorite ? " on" : ""}" data-name="${esc(r.name)}" title="收藏">❤</button>
            <button class="gp-card-val ${esc(effVal)}" data-name="${esc(r.name)}" title="设置玩法状态">${effVal === "high" ? "高价值" : effVal === "mid" ? "中价值" : effVal === "low" ? "低价值" : "放弃"}</button>`;
      tr.innerHTML = `
        <td class="gp-td-name">${thumb}<span class="gp-name">${esc(r.name)}</span>${r.has ? '<span class="badge-has">已建档</span>' : '<span class="badge-no">未建档</span>'}
          ${r.abandonReason ? `<div class="gp-card-abandon-reason">放弃理由：${esc(r.abandonReason)}</div>` : ""}</td>
        <td class="gp-td-dev">${esc(r.developer)}</td>
        <td class="gp-td-src">${srcBoards}</td>
        <td class="gp-td-val">${actBtns}</td>
        <td class="gp-td-view"><button type="button" class="gp-view-btn" data-name="${esc(r.name)}" title="查看/编辑档案">档案</button></td>`;
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".gp-card-fav") || e.target.closest(".gp-card-val")) return;
        if (isEditor()) showEdit(r.name); else showView(r.name);
      });
      const viewBtn = tr.querySelector(".gp-view-btn");
      if (viewBtn) viewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isEditor()) showEdit(r.name); else showView(r.name);
      });
      tbody.appendChild(tr);
    }
    renderMore(filtered.length);
    // 表格行上的收藏按钮: 局部切换心形状态
    tbody.querySelectorAll(".gp-card-fav").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!isEditor()) { if (window.Auth) window.Auth.openModal(); return; }
        const name = btn.dataset.name;
        const cur = state.profiles[name] || { game_name: name, developer: "", gameplay_desc: "", tags: [], notes: "", value: "", favorite: false };
        const next = !cur.favorite;
        btn.disabled = true;
        try {
          const resp = await fetch(FN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",

              ...authHeaders(),
            },
            body: JSON.stringify({ ...cur, favorite: next }),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || !data.ok) throw new Error(data.error || ("HTTP " + resp.status));
          cur.favorite = next;
          state.profiles[name] = cur;
          const row = state.list.find((x) => x.name === name);
          if (row) row.favorite = next;
          btn.disabled = false;
          btn.classList.toggle("on", next);
          if (state.favOnly) renderList();
        } catch (err) {
          alert("操作失败：" + err.message);
          btn.disabled = false;
        }
      });
    });
    // 表格行上的价值按钮: 点击弹出高/中/低选项,局部更新
    tbody.querySelectorAll(".gp-card-val").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!isEditor()) { if (window.Auth) window.Auth.openModal(); return; }
        openValueMenu(btn);
      });
    });
    function openValueMenu(btn) {
      const old = document.querySelector(".gp-val-menu");
      if (old) old.remove();
      const name = btn.dataset.name;
      const cur = state.profiles[name] || { game_name: name, developer: "", gameplay_desc: "", tags: [], notes: "", value: "" };
      const r = btn.getBoundingClientRect();
      const menu = document.createElement("div");
      menu.className = "gp-val-menu";
      menu.style.top = (r.bottom + 4) + "px";
      menu.style.left = Math.max(4, r.left) + "px";
      const opts = [
        ["high", "高价值"],
        ["mid", "中价值"],
        ["low", "低价值"],
        ["abandoned", "放弃"],
      ];
      for (const [v, label] of opts) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "gp-val-menu-item" + ((cur.value || "abandoned") === v ? " active" : "");
        item.textContent = label;
        item.addEventListener("click", (ev) => {
          ev.stopPropagation();
          menu.remove();
          setCardValue(btn, name, v);
        });
        menu.appendChild(item);
      }
      document.body.appendChild(menu);
      const close = (ev) => {
        if (!menu.contains(ev.target)) menu.remove();
        document.removeEventListener("click", close);
      };
      setTimeout(() => document.addEventListener("click", close), 0);
    }

    async function setCardValue(btn, name, value) {
      let reason = (state.profiles[name] || {}).abandon_reason || "";
      if (value === "abandoned") {
        const inp = window.prompt("放弃理由（可选）：", reason || "");
        if (inp !== null) reason = inp.trim();
      }
      const cur = state.profiles[name] || { game_name: name, developer: "", gameplay_desc: "", tags: [], notes: "", value: "" };
      btn.disabled = true;
      try {
        const resp = await fetch(FN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders(),
          },
          body: JSON.stringify({ ...cur, value, abandon_reason: reason }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok) throw new Error(data.error || ("HTTP " + resp.status));
        cur.value = value;
        state.profiles[name] = cur;
        const row = state.list.find((x) => x.name === name);
        if (row) { row.value = value; row.abandonReason = reason; }
        btn.disabled = false;
        btn.className = "gp-card-val " + value;
        btn.textContent = value === "high" ? "高价值" : value === "mid" ? "中价值" : value === "low" ? "低价值" : "放弃";
        // 放弃理由同步到所在行的文案区
        const rowEl = btn.closest("tr");
        if (rowEl) {
          rowEl.className = "gp-tr v-" + (value || "abandoned");
          const reasonEl = rowEl.querySelector(".gp-card-abandon-reason");
          if (reasonEl) reasonEl.remove();
          if (reason) {
            const el = document.createElement("div");
            el.className = "gp-card-abandon-reason";
            el.textContent = reason;
            const nameCell = rowEl.querySelector(".gp-td-name");
            if (nameCell) nameCell.appendChild(el);
          }
        }
        if (state.filter) renderList();
      } catch (err) {
        alert("操作失败：" + err.message);
        btn.disabled = false;
      }
    }
  }
  // Segmented loading: show a "加载更多" button until everything is on screen.
  function renderMore(total) {
    const row = document.getElementById("gp-more-row");
    const btn = document.getElementById("gp-more");
    if (!row || !btn) return;
    const shownCount = (state.page + 1) * 50;
    if (shownCount < total) {
      row.style.display = "";
      btn.textContent = `加载更多（还有 ${total - shownCount} 条）`;
      btn.onclick = () => { state.page++; renderList(); };
    } else {
      row.style.display = "none";
    }
  }
  document.getElementById("gp-page-go").addEventListener("click", jumpToPage);
  document.getElementById("gp-new").addEventListener("click", startNewGame);
  const filterSel = document.getElementById("gp-filter");
  if (filterSel) filterSel.addEventListener("change", () => {
    state.filter = filterSel.value;
    state.favOnly = false;
    const favBtn = document.getElementById("gp-fav");
    if (favBtn) favBtn.classList.remove("active");
    state.page = 0;
    renderList();
  });
  const favBtn = document.getElementById("gp-fav");
  if (favBtn) favBtn.addEventListener("click", () => {
    state.favOnly = !state.favOnly;
    favBtn.classList.toggle("active", state.favOnly);
    state.page = 0;
    renderList();
  });
  const platFilter = document.getElementById("gp-platform-filter");
  if (platFilter) platFilter.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-plat]");
    if (!b) return;
    platFilter.querySelectorAll("button").forEach(x =>
      x.classList.toggle("active", x === b));
    state.platformFilter = b.dataset.plat;
    state.boardFilter = (PLATFORM_BOARDS[state.platformFilter] || [])[0] || "";
    state.page = 0;
    renderBoardFilter();
    renderList();
  });
  document.getElementById("gp-page-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") jumpToPage();
  });

  function showEdit(name) {
    if (!isEditor()) { showView(name); return; }
    state.current = name;
    state.isNew = false;
    $("gp-toolbar").style.display = "none";
    $("gp-table-wrap").style.display = "none";
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


  function showView(name) {
    state.current = name;
    state.isNew = false;
    $("gp-toolbar").style.display = "none";
    $("gp-table-wrap").style.display = "none";
    $("gp-form").style.display = "block";
    document.getElementById("gp-view").style.display = "none";
    document.getElementById("gp-edit-mode").style.display = "none";
    const p = state.profiles[name] || null;
    if (p) {
      renderView(p);
    } else {
      const view = document.getElementById("gp-view");
      view.style.display = "block";
      view.querySelector(".gp-view-name").textContent = name;
      setBoardTag("gp-view-board", name);
      const dl = view.querySelector(".gp-view-fields");
      dl.innerHTML = "";
      const dt = document.createElement("dt"); dt.textContent = "状态";
      const dd = document.createElement("dd"); dd.textContent = "未建档 · 需要编辑者账号登录后才能编辑";
      dl.appendChild(dt); dl.appendChild(dd);
      renderViewShots(name);
      document.getElementById("gp-edit-mode").style.display = "none";
    }
    $("gp-status").textContent = "";
  }

  function startNewGame() {
    if (!isEditor()) { if (window.Auth) window.Auth.openModal(); return; }
    const name = prompt("输入新游戏名称:");
    if (!name || !name.trim()) return;
    state.current = name.trim();
    state.isNew = true;
    if (!state.profiles[state.current]) {
      state.profiles[state.current] = { game_name: state.current, developer: "", gameplay_desc: "", tags: [], notes: "", abandoned: false };
    }
    $("gp-toolbar").style.display = "none";
    $("gp-table-wrap").style.display = "none";
    $("gp-form").style.display = "block";
    document.getElementById("gp-view").style.display = "none";
    document.getElementById("gp-edit-mode").style.display = "none";
    enterEditMode();
    $("gp-status").textContent = "新建游戏，填写完成后保存，上榜日期为今天。";
  }

  function renderView(p) {
    const fields = [
      ["开发商", p.developer || "—", false],
      ["玩法", p.gameplay_desc || "—", true],
      ["标签", (p.tags || []).join(", ") || "—", false],
      ["备注", p.notes || "—", false],
      ...(p.abandon_reason ? [["放弃理由", p.abandon_reason, false]] : []),
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
    const editBtn = document.getElementById("gp-edit-btn");
    if (editBtn) editBtn.style.display = "";
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
    if (!isEditor()) { backToList(); return; }
    const p = state.profiles[state.current] || { game_name: state.current, developer: "", gameplay_desc: "", tags: [], notes: "" };
    document.getElementById("gp-view").style.display = "none";
    const edit = document.getElementById("gp-edit-mode");
    const editTitle = document.getElementById("gp-edit-title");
    if (editTitle) editTitle.textContent = state.current;
    setBoardTag("gp-edit-board", state.current);
    edit.style.display = "block";
    const nameBox = document.getElementById("gp-edit-name");
    if (nameBox) {
      nameBox.value = state.current;
      nameBox.style.display = state.isNew ? "" : "none";
    }
    const g = state.games.find((x) => x.name === state.current);
    $("gp-developer").value = p.developer || (g && g.publisher_name) || "";
    $("gp-desc").value = p.gameplay_desc || "";
    $("gp-tags").value = (p.tags || []).join(", ");
    $("gp-notes").value = p.notes || "";
    const reasonBox = $("gp-abandon-reason");
    const reasonLabel = document.getElementById("gp-abandon-reason-label");
    if (reasonBox) reasonBox.value = p.abandon_reason || "";
    const valueRadios = document.querySelectorAll('input[name="gp-value"]');
    const gv = p.value || "abandoned";
    valueRadios.forEach((r) => { r.checked = r.value === gv; });
    if (reasonLabel && reasonBox) {
      const show = gv === "abandoned";
      reasonLabel.style.display = show ? "" : "none";
      reasonBox.style.display = show ? "" : "none";
    }
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

          ...authHeaders(),
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
    if (!isEditor()) { $("gp-status").textContent = "需要编辑者账号登录后才能保存。"; return; }
    const nameBox = document.getElementById("gp-edit-name");
    let targetName = state.current;
    if (state.isNew && nameBox && nameBox.value.trim()) targetName = nameBox.value.trim();
    const body = {
      game_name: targetName,
      developer: $("gp-developer").value.trim(),
      gameplay_desc: $("gp-desc").value.trim(),
      tags: $("gp-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      notes: $("gp-notes").value.trim(),
      value: (document.querySelector('input[name="gp-value"]:checked') || {}).value || "",
      abandon_reason: $("gp-abandon-reason").value.trim(),
    };
    const files = Array.from($("gp-file").files || []);
    $("gp-status").textContent = files.length ? "保存并上传中…" : "保存中…";
    try {
      // 0) 新建游戏: 先写入 games 表(上榜日期=今天)
      if (state.isNew) {
        const gResp = await fetch(FN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders(),
          },
          body: JSON.stringify({ action: "create_game", name: targetName }),
        });
        const gData = await gResp.json().catch(() => ({}));
        if (!gResp.ok || !gData.ok) throw new Error(gData.error || ("HTTP " + gResp.status));
      }
      // 1) 保存档案文字
      const resp = await fetch(FN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",

          ...authHeaders(),
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || ("HTTP " + resp.status));
      delete state.profiles[state.current];
      state.profiles[targetName] = body;

      // 2) 如有选中的图片,一并上传
      if (files.length) {
        const fd = new FormData();
        fd.append("game_name", targetName);
        for (const f of files) fd.append("files", f);
        const upResp = await fetch(FN_URL, {
          method: "POST",
          headers: {
            ...authHeaders(),
          },
          body: fd,
        });
        const upData = await upResp.json().catch(() => ({}));
        if (!upResp.ok || !upData.ok) throw new Error(upData.error || ("HTTP " + upResp.status));
        $("gp-file").value = "";
        await refreshShots(targetName);
      }

      $("gp-status").textContent = files.length ? "已保存档案并上传截图。" : "已保存到数据库。";
      if (state.isNew) {
        state.isNew = false;
        state.current = targetName;
        await reloadList();
      }
      backToList();
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

  async function reloadList() {
    const [games, profiles, shots] = await Promise.all([
      window.sb.select("games", { select: "name,first_seen_at,category,publisher_name", order: "first_seen_at.desc", limit: 5000 }),
      window.sb.select("game_profiles", { limit: 5000 }),
      window.sb.select("game_screenshots", { select: "id,game_name,url,sort_order", order: "sort_order.asc,id.asc", limit: 5000 }),
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

  function backToList() {
    state.current = null;
    $("gp-toolbar").style.display = "";
    $("gp-table-wrap").style.display = "";
    $("gp-form").style.display = "none";
    document.getElementById("gp-view").style.display = "none";
    buildList();
  }


  // ---------- auth ??? (????? auth.js) ----------
  function isEditor() { return window.Auth ? window.Auth.isEditor() : false; }
  function authHeaders() {
    if (window.Auth) return window.Auth.authHeaders();
    return { "x-client-info": ADMIN_KEY };
  }
  function renderAuthUI() {
    if (window.Auth) window.Auth.render();
    const nb = document.getElementById("gp-new");
    if (nb) nb.style.display = "";
  }
  function openAuthModal() { if (window.Auth) window.Auth.openModal(); }
  function closeAuthModal() { if (window.Auth) window.Auth.closeModal(); }
  async function restoreAuth() {
    if (window.Auth) await window.Auth.restore();
    renderAuthUI();
  }

  function init() {
    initMdEditor();
    if (window.Auth && window.Auth.bind) window.Auth.bind();
    if (window.Auth && window.Auth.onAuthChange) {
      window.Auth.onAuthChange(() => {
        renderAuthUI();
        if (state.games && state.games.length) renderList();
      });
    }
    $("gp-save").addEventListener("click", save);
    $("gp-view-back").addEventListener("click", backToList);
    $("gp-back").addEventListener("click", backToList);
    $("gp-edit-btn").addEventListener("click", () => { if (!isEditor()) { if (window.Auth) window.Auth.openModal(); return; } enterEditMode(); });
    document.querySelectorAll('input[name="gp-value"]').forEach((r) => {
      r.addEventListener("change", () => {
        const show = r.value === "abandoned" && r.checked;
        const lbl = document.getElementById("gp-abandon-reason-label");
        const box = $("gp-abandon-reason");
        if (lbl) lbl.style.display = show ? "" : "none";
        if (box) box.style.display = show ? "" : "none";
      });
    });
    $("gp-clear").addEventListener("click", () => { $("gp-search").value = ""; state.page = 0; renderList(); });
    $("gp-prev").addEventListener("click", () => { if (state.page > 0) { state.page--; renderList(); } });
    $("gp-next").addEventListener("click", () => { state.page++; renderList(); });
    $("gp-search").addEventListener("input", () => { state.page = 0; renderList(); });
  }

  (async function () {
    init();
    await restoreAuth();
    try {
      await loadAll();
      $("gp-loading").style.display = "none";
      renderBoardFilter();  // initial board sub-filter for the default platform
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