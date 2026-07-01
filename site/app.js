/* Dashboard for the gravity-engine ranking tracker.
 * Loads ./data/latest.json + ./data/index.json + ./data/diff/<date>.json
 * Pure vanilla JS, no build step.
 */

const DATA_BASE = "./data";

const PLATFORM_ORDER = [
  ["wx", "微信小游戏"],
  ["douyin", "抖音小游戏"],
];
const BOARD_LABELS = {
  wx: ["人气榜", "畅销榜", "畅玩榜"],
  douyin: ["热门榜", "畅销榜", "新游榜"],
};

const state = {
  latest: null,        // most recent snapshot
  diff: null,          // diff JSON (newer vs previous)
  index: null,         // {daily: [...], diff: [...]}
  history: [],         // parsed history.jsonl lines
  activeBoard: null,   // {plat, label}
  sort: { key: "rank", dir: 1 }, // for full-board table
};

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function fetchText(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) return "";
  return res.text();
}

function $(id) { return document.getElementById(id); }

function buildBoardTabs() {
  const nav = $("board-tabs");
  nav.innerHTML = "";
  for (const [plat, platLabel] of PLATFORM_ORDER) {
    for (const label of BOARD_LABELS[plat]) {
      const btn = document.createElement("button");
      btn.className = "board-tab";
      btn.textContent = `${platLabel} · ${label}`;
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

function findBoard(snapshot, plat, label) {
  const p = snapshot?.platforms?.[plat];
  if (!p) return null;
  return p.boards?.find(b => b.label === label) || null;
}

function findDiffBoard(diff, plat, label) {
  if (!diff) return null;
  return diff.boards?.[`${plat}/${label}`] || null;
}

function renderKPIs() {
  if (!state.latest) return;
  const dateLabel = state.latest.date_beijing || "—";
  $("meta-date").textContent = `最新数据：${dateLabel}（北京时间）`;
  $("meta-days").textContent = state.index?.daily?.length || 0;
}

function renderDiffTables() {
  const ab = state.activeBoard;
  if (!ab) return;
  const diffBoard = findDiffBoard(state.diff, ab.plat, ab.label);
  $("panel-new-board").textContent =
    ` · ${platLabelOf(ab.plat)} · ${ab.label}`;

  // Header reflects the actual snapshot date — never the wall-clock
  // "today" — so a visit at 11am (before the day's run) shows the
  // previous day's label instead of an empty "today".
  const dateLabel = state.latest?.date_beijing || "—";
  $("panel-new-title").textContent = `新进产品 · ${dateLabel}`;

  // "Next update" hint: the day *after* the snapshot date, at 10:30 BJT.
  const hint = $("panel-new-hint");
  if (state.latest?.date_beijing) {
    const nextDay = new Date(state.latest.date_beijing + "T00:00:00");
    nextDay.setDate(nextDay.getDate() + 1);
    const y = nextDay.getFullYear();
    const m = String(nextDay.getMonth() + 1).padStart(2, "0");
    const d = String(nextDay.getDate()).padStart(2, "0");
    hint.textContent = `${y}-${m}-${d} 数据将于当日 10:30 更新`;
  } else {
    hint.textContent = "";
  }

  // The baseline is "everything we've ever seen on this board" — there
  // isn't a single comparison date to point at. Just clarify that.
  $("panel-new-baseline").textContent = "对照此榜全部历史快照。";

  const tbodyG = document.querySelector("#tbl-new tbody");
  tbodyG.innerHTML = "";

  if (!diffBoard) {
    $("panel-new-count").textContent = "";
    tbodyG.innerHTML = `<tr><td colspan="7" class="muted">尚无对比数据（首日运行后才有）</td></tr>`;
    return;
  }

  // Build a set of "new publisher" names for this board so we can flag
  // which rows are new-studio entries.
  const newPubSet = new Set(
    (diffBoard.new_publishers || [])
      .map(r => r.publisher)
      .filter(Boolean),
  );

  const rowsTagged = [
    ...(diffBoard.new_to_board || []).map(r => ({ ...r, _tag: "新进榜", _cls: "first-board" })),
    ...(diffBoard.returning || []).map(r => ({ ...r, _tag: "回归", _cls: "returning" })),
  ].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  $("panel-new-count").textContent = `（共 ${rowsTagged.length} 个）`;

  if (!rowsTagged.length) {
    tbodyG.innerHTML = `<tr><td colspan="7" class="muted">今日此榜无新进 / 回归</td></tr>`;
    return;
  }
  for (const r of rowsTagged) {
    const tr = document.createElement("tr");
    const hasPub = !!(r.publisher && r.publisher.trim());
    const isNewPub = hasPub && newPubSet.has(r.publisher);
    let studioCell;
    if (!hasPub) {
      studioCell = `<span class="badge studio-unknown">未知</span>`;
    } else if (isNewPub) {
      studioCell = `<span class="badge new-pub">新厂</span>`;
    } else {
      studioCell = `<span class="badge studio-old">老厂</span>`;
    }
    tr.innerHTML = `
      <td><span class="badge ${r._cls}">${r._tag}</span></td>
      <td class="rank-num">${r.rank ?? ""}</td>
      <td><strong>${escapeHTML(r.name || "")}</strong></td>
      <td>${escapeHTML(r.category || "")}</td>
      <td>${escapeHTML(r.subcategory || "") || `<span class="slogan">${escapeHTML(r.slogan || "")}</span>`}</td>
      <td>${escapeHTML(r.publisher || "")}</td>
      <td>${studioCell}</td>`;
    tbodyG.appendChild(tr);
  }
}

function changeCell(r) {
  // r.change is the raw text like "1", "- 稳定", "霸榜15天".
  // r.change_direction is one of: up / down / flat / top / new / unknown.
  const dir = r.change_direction;
  const raw = (r.change || "").trim();
  // Strip a leading "- " often present on flat rows.
  const cleaned = raw.replace(/^-\s*/, "").trim();
  if (dir === "top") {
    return `<span class="chg chg-top">${escapeHTML(cleaned || raw)}</span>`;
  }
  if (dir === "flat") {
    return `<span class="chg chg-flat">— 稳定</span>`;
  }
  if (dir === "new") {
    return `<span class="chg chg-new">新</span>`;
  }
  if (dir === "up" || dir === "down") {
    // Colors already match convention (up=red, down=green); the arrow
    // glyph the site uses is the *opposite* of the semantic direction,
    // so we swap it here to match user expectation.
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
  const board = findBoard(state.latest, ab.plat, ab.label);
  $("panel-board-name").textContent =
    `${platLabelOf(ab.plat)} · ${ab.label} · 共 ${board?.rows?.length || 0} 条`;
  const tbody = document.querySelector("#tbl-full tbody");
  tbody.innerHTML = "";
  if (!board) return;
  const diffBoard = findDiffBoard(state.diff, ab.plat, ab.label);
  const newGameSet = new Set(
    ((diffBoard?.new_to_board) || []).map(r => r.name),
  );

  const rows = [...board.rows].sort(sortRowsBy(state.sort));
  for (const r of rows) {
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

function sortRowsBy({ key, dir }) {
  return (a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb), "zh") * dir;
  };
}

function attachSortHandlers() {
  const ths = document.querySelectorAll("#tbl-full thead th");
  const keys = ["rank", "name", "category", "subcategory", "publisher", "change", null];
  ths.forEach((th, i) => {
    if (!keys[i]) return;
    th.onclick = () => {
      if (state.sort.key === keys[i]) state.sort.dir *= -1;
      else { state.sort.key = keys[i]; state.sort.dir = 1; }
      renderFullBoard();
    };
  });
}

function renderDatePicker() {
  const sel = $("date-picker");
  sel.innerHTML = "";
  const days = (state.index?.daily || []).slice().reverse();
  for (const d of days) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    sel.appendChild(opt);
  }
  $("date-load").onclick = async () => {
    const d = sel.value;
    if (!d) return;
    try {
      state.latest = await fetchJSON(`${DATA_BASE}/daily/${d}.json`);
      // Try matching diff for that date.
      try {
        state.diff = await fetchJSON(`${DATA_BASE}/diff/${d}.json`);
      } catch (e) { state.diff = null; }
      renderAll();
    } catch (e) {
      alert(`加载失败：${e.message}`);
    }
  };
}

function renderBoardViews() {
  renderDiffTables();
  renderFullBoard();
}

function renderAll() {
  renderKPIs();
  renderBoardViews();
}

function platLabelOf(key) {
  return ({ wx: "微信小游戏", douyin: "抖音小游戏" })[key] || key;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

async function init() {
  buildBoardTabs();
  attachSortHandlers();

  try {
    state.latest = await fetchJSON(`${DATA_BASE}/latest.json`);
  } catch (e) {
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<div style="background:#3d1d1d;color:#ff9696;padding:10px 32px">
        尚无 latest.json — 等首次抓取后再访问，或把 sample 数据放进 data/。
      </div>`,
    );
    return;
  }
  try {
    state.index = await fetchJSON(`${DATA_BASE}/index.json`);
  } catch (e) { state.index = { daily: [], diff: [] }; }
  // Try to load the diff matching latest.
  if (state.latest.date_beijing) {
    try {
      state.diff = await fetchJSON(
        `${DATA_BASE}/diff/${state.latest.date_beijing}.json`,
      );
    } catch (e) { state.diff = null; }
  }
  // history.jsonl is no longer rendered (chart removed) but kept on disk
  // for future use; skip loading.

  renderDatePicker();
  // Default to first board.
  setActiveBoard("wx", "人气榜");
  renderKPIs();
}

init();
