/* Dashboard for the gravity-engine ranking tracker.
 * Reads from Supabase (see sb.js). Falls back to nothing if Supabase is
 * unreachable — the JSON files under data/ are still committed by CI as
 * a durable backup, but the frontend no longer parses them.
 */

const PLATFORM_ORDER = [
  ["wx", "微信小游戏"],
  ["douyin", "抖音小游戏"],
];
const BOARD_LABELS = {
  wx: ["畅销榜", "畅玩榜", "人气榜"],
  douyin: ["畅销榜", "热门榜", "新游榜"],
};

// Icon per board name (works across platforms).
const BOARD_ICON = {
  "畅销榜": "💰",
  "畅玩榜": "🎮",
  "人气榜": "🔥",
  "热门榜": "⚡",
  "新游榜": "✨",
};

const state = {
  currentDate: null,          // YYYY-MM-DD (Beijing)
  availableDates: [],         // sorted asc
  boardsByKey: {},            // "wx/人气榜" → [row, ...] (rows for currentDate)
  diffByKey: {},              // "wx/人气榜" → { new_to_board: [...], returning: [...], new_publishers: [...] }
  activeBoard: null,          // {plat, label}
};

function $(id) { return document.getElementById(id); }

function platLabelOf(key) {
  return ({ wx: "微信小游戏", douyin: "抖音小游戏" })[key] || key;
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function boardKey(plat, label) { return `${plat}/${label}`; }

// ---------- data loading ----------

async function loadAvailableDates() {
  // Distinct dates in daily_snapshots. PostgREST doesn't have DISTINCT,
  // but with a small dataset we can just fetch dates ordered desc and
  // dedup. If snapshot count grows unbounded, swap to an RPC / view.
  const rows = await window.sb.select("daily_snapshots", {
    select: "snapshot_date",
    order: "snapshot_date.desc",
    limit: 5000,
  });
  const seen = new Set();
  const dates = [];
  for (const r of rows) {
    if (!seen.has(r.snapshot_date)) {
      seen.add(r.snapshot_date);
      dates.push(r.snapshot_date);
    }
  }
  dates.sort();  // ascending
  state.availableDates = dates;
  return dates;
}

async function loadSnapshotForDate(date) {
  const rows = await window.sb.select("daily_snapshots", {
    match: { snapshot_date: date },
    order: "platform.asc,board.asc,rank.asc",
    limit: 5000,
  });
  const byBoard = {};
  for (const r of rows) {
    const key = boardKey(r.platform, r.board);
    (byBoard[key] ||= []).push({
      rank: r.rank,
      name: r.game_name,
      publisher: r.publisher_name || "",
      change: r.change_raw || "",
      change_direction: r.change_direction,
      category: r.category || "",
      category_rank: r.category_rank,
      subcategory: r.subcategory || "",
      slogan: r.slogan || "",
    });
  }
  state.boardsByKey = byBoard;
  state.currentDate = date;
}

async function loadDiffForDate(date) {
  // 1) Read daily_diffs (categorised game entries).
  const diffRows = await window.sb.select("daily_diffs", {
    match: { snapshot_date: date },
    order: "platform.asc,board.asc,rank.asc",
    limit: 2000,
  });
  const byBoard = {};
  for (const r of diffRows) {
    const key = boardKey(r.platform, r.board);
    const b = (byBoard[key] ||= {
      new_to_board: [], returning: [], new_publishers: [],
    });
    const rec = {
      rank: r.rank,
      name: r.game_name,
      publisher: r.publisher_name || "",
    };
    if (r.category === "returning") b.returning.push(rec);
    else b.new_to_board.push(rec);
  }

  // 2) Compute "new publishers per board today" without a dedicated
  // table: a publisher is new-on-board today if publisher_board_history
  // says its first_seen equals today's date.
  const pbhRows = await window.sb.select("publisher_board_history", {
    raw: { first_seen: `eq.${date}` },
    limit: 2000,
  });
  const newPubKeys = new Set();
  for (const r of pbhRows) newPubKeys.add(`${r.platform}/${r.board}/${r.publisher}`);

  // Attach new_publishers by cross-referencing today's snapshot.
  for (const [key, rows] of Object.entries(state.boardsByKey)) {
    const [plat, board] = key.split("/");
    const seen = new Set();
    const list = [];
    for (const r of rows) {
      if (!r.publisher || seen.has(r.publisher)) continue;
      if (newPubKeys.has(`${plat}/${board}/${r.publisher}`)) {
        seen.add(r.publisher);
        list.push({ rank: r.rank, name: r.name, publisher: r.publisher });
      }
    }
    (byBoard[key] ||= { new_to_board: [], returning: [], new_publishers: [] })
      .new_publishers = list;
  }

  state.diffByKey = byBoard;
}

// ---------- UI: tabs / date picker ----------

function buildBoardTabs() {
  const nav = $("board-tabs");
  nav.innerHTML = "";
  for (const [plat, platLabel] of PLATFORM_ORDER) {
    for (const label of BOARD_LABELS[plat]) {
      const btn = document.createElement("button");
      btn.className = `board-tab board-tab-${plat}`;
      const icon = BOARD_ICON[label] || "•";
      const platShort = plat === "wx" ? "微" : "抖";
      btn.innerHTML = `<span class="tab-icon">${icon}</span>`
        + `<span class="tab-label">${platShort}·${escapeHTML(label.replace("榜",""))}</span>`;
      btn.dataset.plat = plat;
      btn.dataset.label = label;
      btn.onclick = () => setActiveBoard(plat, label);
      nav.appendChild(btn);
    }
  }
}

function setActiveBoard(plat, label) {
  state.activeBoard = { plat, label };
  for (const btn of document.querySelectorAll(".board-tab")) {
    btn.classList.toggle(
      "active",
      btn.dataset.plat === plat && btn.dataset.label === label,
    );
  }
  renderBoardViews();
}

function renderDatePicker() {
  const sel = $("date-picker");
  sel.innerHTML = "";
  const days = state.availableDates.slice().reverse();
  for (const d of days) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    sel.appendChild(opt);
  }
  sel.value = state.currentDate;
  $("date-load").onclick = async () => {
    const d = sel.value;
    if (!d || d === state.currentDate) return;
    try {
      $("date-load").disabled = true;
      await loadSnapshotForDate(d);
      await loadDiffForDate(d);
      renderAll();
    } catch (e) {
      alert(`加载失败：${e.message}`);
    } finally {
      $("date-load").disabled = false;
    }
  };
}

// ---------- UI: rendering ----------

function findRows(plat, label) {
  return state.boardsByKey[boardKey(plat, label)] || [];
}
function findDiff(plat, label) {
  return state.diffByKey[boardKey(plat, label)] || null;
}

function renderKPIs() {
  const dateLabel = state.currentDate || "—";
  $("meta-date").textContent = `最新数据：${dateLabel}（北京时间）`;
  $("meta-days").textContent = state.availableDates.length;
}

function renderDiffTables() {
  const ab = state.activeBoard;
  if (!ab) return;
  const diff = findDiff(ab.plat, ab.label);
  $("panel-new-board").textContent =
    ` · ${platLabelOf(ab.plat)} · ${ab.label}`;

  const dateLabel = state.currentDate || "—";
  $("panel-new-title").textContent = `新进产品 · ${dateLabel}`;

  const hint = $("panel-new-hint");
  if (state.currentDate) {
    const nextDay = new Date(state.currentDate + "T00:00:00");
    nextDay.setDate(nextDay.getDate() + 1);
    const y = nextDay.getFullYear();
    const m = String(nextDay.getMonth() + 1).padStart(2, "0");
    const d = String(nextDay.getDate()).padStart(2, "0");
    hint.textContent = `${y}-${m}-${d} 数据将于当日 10:30 更新`;
  } else {
    hint.textContent = "";
  }

  const baselineEl = $("panel-new-baseline");
  if (baselineEl) baselineEl.textContent = "对照此榜全部历史快照。";

  const tbodyG = document.querySelector("#tbl-new tbody");
  tbodyG.innerHTML = "";

  if (!diff) {
    const cnt = $("panel-new-count");
    if (cnt) cnt.textContent = "";
    tbodyG.innerHTML = `<tr><td colspan="7" class="muted">尚无对比数据（首日运行后才有）</td></tr>`;
    return;
  }

  const newPubSet = new Set((diff.new_publishers || []).map(r => r.publisher).filter(Boolean));

  const rowsTagged = [
    ...(diff.new_to_board || []).map(r => ({ ...r, _tag: "新进榜", _cls: "first-board" })),
    ...(diff.returning   || []).map(r => ({ ...r, _tag: "回归",   _cls: "returning" })),
  ].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  const cnt = $("panel-new-count");
  if (cnt) cnt.textContent = `（共 ${rowsTagged.length} 个）`;

  if (!rowsTagged.length) {
    tbodyG.innerHTML = `<tr><td colspan="7" class="muted">今日此榜无新进 / 回归</td></tr>`;
    return;
  }
  // Enrich diff rows with category / subcategory / slogan from today's snapshot.
  const snapMap = new Map(
    findRows(ab.plat, ab.label).map(r => [r.name, r]),
  );
  for (const r of rowsTagged) {
    const s = snapMap.get(r.name) || {};
    const category = s.category || "";
    const subcategory = s.subcategory || "";
    const slogan = s.slogan || "";
    const hasPub = !!(r.publisher && String(r.publisher).trim());
    const isNewPub = hasPub && newPubSet.has(r.publisher);
    let studioCell;
    if (!hasPub) {
      studioCell = `<span class="badge studio-unknown">未知</span>`;
    } else if (isNewPub) {
      studioCell = `<span class="badge new-pub">新厂</span>`;
    } else {
      studioCell = `<span class="badge studio-old">老厂</span>`;
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="badge ${r._cls}">${r._tag}</span></td>
      <td class="rank-num">${r.rank ?? ""}</td>
      <td><strong>${escapeHTML(r.name || "")}</strong></td>
      <td>${escapeHTML(category)}</td>
      <td>${escapeHTML(subcategory) || `<span class="slogan">${escapeHTML(slogan)}</span>`}</td>
      <td>${escapeHTML(r.publisher || "")}</td>
      <td>${studioCell}</td>`;
    tbodyG.appendChild(tr);
  }
}

function changeCell(r) {
  const dir = r.change_direction;
  const raw = (r.change || "").trim();
  const cleaned = raw.replace(/^-\s*/, "").trim();
  if (dir === "top")  return `<span class="chg chg-top">${escapeHTML(cleaned || raw)}</span>`;
  if (dir === "flat") return `<span class="chg chg-flat">— 稳定</span>`;
  if (dir === "new")  return `<span class="chg chg-new">新</span>`;
  if (dir === "up" || dir === "down") {
    const arrow = dir === "up" ? "▼" : "▲";
    const cls = dir === "up" ? "chg-up" : "chg-down";
    const mag = cleaned.match(/\d+/)?.[0] || cleaned;
    return `<span class="chg ${cls}">${arrow} ${escapeHTML(mag)}</span>`;
  }
  return escapeHTML(raw);
}

function renderFullBoard() {
  const ab = state.activeBoard;
  if (!ab) return;
  const rows = findRows(ab.plat, ab.label);
  $("panel-board-name").textContent =
    `${platLabelOf(ab.plat)} · ${ab.label} · 共 ${rows.length} 条`;
  const tbody = document.querySelector("#tbl-full tbody");
  tbody.innerHTML = "";
  const diff = findDiff(ab.plat, ab.label);
  const newGameSet = new Set(((diff?.new_to_board) || []).map(r => r.name));

  // Always render in rank order (ascending). No user-sorting anymore.
  const sorted = [...rows].sort(
    (a, b) => (a.rank ?? 9999) - (b.rank ?? 9999),
  );
  for (const r of sorted) {
    const tr = document.createElement("tr");
    const isNew = newGameSet.has(r.name);
    tr.innerHTML = `
      <td class="rank-num">${r.rank ?? ""}</td>
      <td><strong>${escapeHTML(r.name || "")}</strong>
        ${r.slogan ? `<div class="slogan">${escapeHTML(r.slogan)}</div>` : ""}</td>
      <td>${escapeHTML(r.category || "")}${r.category_rank ? ` <span class="muted">#${r.category_rank}</span>` : ""}</td>
      <td>${escapeHTML(r.subcategory || "")}</td>
      <td>${escapeHTML(r.publisher || "")}</td>
      <td>${changeCell(r)}</td>
      <td>${isNew ? `<span class="badge-new">NEW</span>` : ""}</td>`;
    tbody.appendChild(tr);
  }
}


function renderBoardViews() {
  renderDiffTables();
  renderFullBoard();
}

function renderAll() {
  renderKPIs();
  renderBoardViews();
}

async function init() {
  buildBoardTabs();

  try {
    const dates = await loadAvailableDates();
    if (!dates.length) throw new Error("no snapshots yet");
    const latest = dates[dates.length - 1];
    await loadSnapshotForDate(latest);
    await loadDiffForDate(latest);
  } catch (e) {
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<div style="background:#3d1d1d;color:#ff9696;padding:10px 32px">
        数据加载失败：${escapeHTML(e.message)}
      </div>`,
    );
    return;
  }

  renderDatePicker();
  setActiveBoard("wx", "畅销榜");
  renderKPIs();
}

init();
