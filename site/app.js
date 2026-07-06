/* Dashboard for the gravity-engine ranking tracker.
 * Reads from Supabase (see sb.js). Boards are loaded lazily: only the
 * active board's snapshot + diff are fetched (not all boards at once),
 * and results are cached per date so switching back to a seen board or
 * date is instant. The full-board table renders in pages of PAGE_SIZE
 * rows at a time via a "加载更多" button instead of dumping every row
 * into the DOM up front.
 */

const PLATFORM_ORDER = [
  ["wx", "微信小游戏"],
  ["douyin", "抖音小游戏"],
  ["taptap", "TapTap"],
];
const BOARD_LABELS = {
  wx: ["畅销榜", "畅玩榜", "人气榜"],
  douyin: ["畅销榜", "热门榜", "新游榜"],
  taptap: ["预约榜"],
};

// Icon per board name (works across platforms).
const BOARD_ICON = {
  "畅销榜": "💰",
  "畅玩榜": "🎮",
  "人气榜": "🔥",
  "热门榜": "⚡",
  "新游榜": "✨",
  "预约榜": "📅",
};

// Rows rendered per "page" in the full-board table.
const PAGE_SIZE = 50;

const state = {
  currentDate: null,          // YYYY-MM-DD (Beijing)
  availableDates: [],         // sorted asc
  // cache[date]["plat/label"] = { rows, diff }
  cache: {},
  activeBoard: null,          // {plat, label}
  fullBoardPage: 0,          // pages already rendered for the active board
};

function $(id) { return document.getElementById(id); }

function platLabelOf(key) {
  return ({ wx: "微信小游戏", douyin: "抖音小游戏", taptap: "TapTap" })[key] || key;
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function boardKey(plat, label) { return `${plat}/${label}`; }

function cacheEntry(date, plat, label) {
  return state.cache[date] && state.cache[date][boardKey(plat, label)];
}
function setCacheEntry(date, plat, label, data) {
  ((state.cache[date] ||= {}))[boardKey(plat, label)] = data;
}

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

function mapSnapshotRow(r) {
  return {
    rank: r.rank,
    name: r.game_name,
    publisher: r.publisher_name || "",
    change: r.change_raw || "",
    change_direction: r.change_direction,
    category: r.category || "",
    category_rank: r.category_rank,
    subcategory: r.subcategory || "",
    slogan: r.slogan || "",
  };
}

// Fetch one board's snapshot + diff in parallel. `date` is the snapshot
// date; `plat`/`label` select the board. Returns { rows, diff }.
async function loadBoardData(date, plat, label) {
  const [snapRows, diffRows, pbhRows] = await Promise.all([
    window.sb.select("daily_snapshots", {
      match: { snapshot_date: date, platform: plat, board: label },
      order: "rank.asc",
      limit: 500,
    }),
    window.sb.select("daily_diffs", {
      match: { snapshot_date: date, platform: plat, board: label },
      order: "rank.asc",
      limit: 1000,
    }),
    window.sb.select("publisher_board_history", {
      raw: {
        first_seen: `eq.${date}`,
        platform: `eq.${plat}`,
        board: `eq.${label}`,
      },
      limit: 1000,
    }),
  ]);

  const rows = snapRows.map(mapSnapshotRow);

  const diff = { new_to_board: [], returning: [], new_publishers: [] };
  for (const r of diffRows) {
    const rec = {
      rank: r.rank,
      name: r.game_name,
      publisher: r.publisher_name || "",
    };
    if (r.category === "returning") diff.returning.push(rec);
    else diff.new_to_board.push(rec);
  }

  // "New publishers" on this board today = publisher_board_history says
  // the publisher's first_seen on this board equals today.
  const newPubKeys = new Set(pbhRows.map(r => r.publisher));
  const seen = new Set();
  for (const r of rows) {
    if (!r.publisher || seen.has(r.publisher)) continue;
    if (newPubKeys.has(r.publisher)) {
      seen.add(r.publisher);
      diff.new_publishers.push({ rank: r.rank, name: r.name, publisher: r.publisher });
    }
  }

  return { rows, diff };
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
      const platShort = plat === "wx" ? "微"
        : plat === "douyin" ? "抖"
        : plat === "taptap" ? "Tap"
        : "";
      btn.innerHTML = `<span class="tab-icon">${icon}</span>`
        + `<span class="tab-label">${platShort}·${escapeHTML(label.replace("榜",""))}</span>`;
      btn.dataset.plat = plat;
      btn.dataset.label = label;
      btn.onclick = () => setActiveBoard(plat, label);
      nav.appendChild(btn);
    }
  }
}

function updateTabActive() {
  const ab = state.activeBoard;
  for (const btn of document.querySelectorAll(".board-tab")) {
    btn.classList.toggle(
      "active",
      !!ab && btn.dataset.plat === ab.plat && btn.dataset.label === ab.label,
    );
  }
}

async function setActiveBoard(plat, label) {
  state.activeBoard = { plat, label };
  state.fullBoardPage = 0;
  updateTabActive();

  // Cached for this date → render instantly, no network.
  if (cacheEntry(state.currentDate, plat, label)) {
    renderBoardViews();
    return;
  }

  showBoardLoading();
  try {
    const data = await loadBoardData(state.currentDate, plat, label);
    setCacheEntry(state.currentDate, plat, label, data);
  } catch (e) {
    showBoardError(e);
    return;
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
    const ab = state.activeBoard;
    $("date-load").disabled = true;
    try {
      state.currentDate = d;
      state.fullBoardPage = 0;
      renderKPIs();
      if (!cacheEntry(d, ab.plat, ab.label)) {
        showBoardLoading();
        const data = await loadBoardData(d, ab.plat, ab.label);
        setCacheEntry(d, ab.plat, ab.label, data);
      }
      renderBoardViews();
    } catch (e) {
      alert(`加载失败：${e.message}`);
    } finally {
      $("date-load").disabled = false;
    }
  };
}

// ---------- UI: rendering ----------

function getBoardData(plat, label) {
  return cacheEntry(state.currentDate, plat, label) || { rows: [], diff: null };
}
function findRows(plat, label) { return getBoardData(plat, label).rows; }
function findDiff(plat, label) { return getBoardData(plat, label).diff; }

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

  const showCount = Math.min((state.fullBoardPage + 1) * PAGE_SIZE, sorted.length);
  for (let i = 0; i < showCount; i++) {
    const r = sorted[i];
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

  // "Load more" row if there are still rows off-page.
  if (showCount < sorted.length) {
    const remaining = sorted.length - showCount;
    const more = document.createElement("tr");
    more.className = "load-more-row";
    more.innerHTML = `<td colspan="7" class="load-more-cell">
      <button type="button" id="tbl-full-more" class="load-more-btn">
        加载更多（还有 ${remaining} 条）
      </button></td>`;
    tbody.appendChild(more);
    $("tbl-full-more").onclick = () => {
      state.fullBoardPage++;
      renderFullBoard();
    };
  }
}

function showBoardLoading() {
  const ab = state.activeBoard;
  if (ab) {
    $("panel-board-name").textContent =
      `${platLabelOf(ab.plat)} · ${ab.label} · 加载中…`;
  }
  const tFull = document.querySelector("#tbl-full tbody");
  tFull.innerHTML = `<tr><td colspan="7" class="muted loading-cell">加载中…</td></tr>`;
  const tNew = document.querySelector("#tbl-new tbody");
  tNew.innerHTML = `<tr><td colspan="7" class="muted loading-cell">加载中…</td></tr>`;
  const cnt = $("panel-new-count");
  if (cnt) cnt.textContent = "";
}

function showBoardError(e) {
  const tFull = document.querySelector("#tbl-full tbody");
  tFull.innerHTML = `<tr><td colspan="7" class="muted">加载失败：${escapeHTML(e.message)}</td></tr>`;
}

function renderBoardViews() {
  renderDiffTables();
  renderFullBoard();
}

async function init() {
  buildBoardTabs();

  try {
    const dates = await loadAvailableDates();
    if (!dates.length) throw new Error("no snapshots yet");
    state.currentDate = dates[dates.length - 1];
    renderDatePicker();
    renderKPIs();
    // setActiveBoard triggers the first board's lazy load and shows a
    // loading state until the data arrives.
    await setActiveBoard("wx", "畅销榜");
  } catch (e) {
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<div style="background:#3d1d1d;color:#ff9696;padding:10px 32px">
        数据加载失败：${escapeHTML(e.message)}
      </div>`,
    );
  }
}

init();