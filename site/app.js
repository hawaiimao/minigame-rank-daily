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
  let firstAnywhere = 0, firstOnBoard = 0, returning = 0, newPubs = 0;
  if (state.diff) {
    for (const k in state.diff.boards) {
      const t = state.diff.boards[k].totals || {};
      firstAnywhere += t.first_anywhere || 0;
      firstOnBoard += t.first_on_board || 0;
      returning += t.returning || 0;
      newPubs += t.new_publishers || 0;
    }
    $("kpi-first-anywhere").textContent = firstAnywhere;
    $("kpi-first-on-board").textContent = firstOnBoard;
    $("kpi-returning").textContent = returning;
    $("kpi-new-pubs").textContent = newPubs;
  } else {
    $("kpi-first-anywhere").textContent = "—";
    $("kpi-first-on-board").textContent = "—";
    $("kpi-returning").textContent = "—";
    $("kpi-new-pubs").textContent = "—";
  }
  $("kpi-latest-date").textContent = state.latest.date_beijing || "—";
  $("kpi-latest-time").textContent = state.latest.scraped_at_beijing
    ? state.latest.scraped_at_beijing.replace("T", " ").slice(0, 16)
    : "";
  $("kpi-history").textContent = state.index?.daily?.length || 0;

  $("meta-date").textContent = state.latest.date_beijing
    ? `最新数据：${state.latest.date_beijing}（北京时间）`
    : "—";
}

function renderDiffTables() {
  const ab = state.activeBoard;
  if (!ab) return;
  const diffBoard = findDiffBoard(state.diff, ab.plat, ab.label);
  $("panel-new-board").textContent =
    `${platLabelOf(ab.plat)} · ${ab.label}`;

  const tbodyG = document.querySelector("#tbl-new tbody");
  tbodyG.innerHTML = "";
  const tbodyP = document.querySelector("#tbl-newpub tbody");
  tbodyP.innerHTML = "";

  if (!diffBoard) {
    tbodyG.innerHTML = `<tr><td colspan="6" class="muted">尚无对比数据（首日运行后才有）</td></tr>`;
    tbodyP.innerHTML = `<tr><td colspan="3" class="muted">—</td></tr>`;
    return;
  }

  const rowsTagged = [
    ...(diffBoard.first_anywhere || []).map(r => ({ ...r, _tag: "全新", _cls: "first-anywhere" })),
    ...(diffBoard.first_on_board || []).map(r => ({ ...r, _tag: "首次入此榜", _cls: "first-board" })),
    ...(diffBoard.returning || []).map(r => ({ ...r, _tag: "回归", _cls: "returning" })),
  ].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  if (!rowsTagged.length) {
    tbodyG.innerHTML = `<tr><td colspan="6" class="muted">今日此榜无新进 / 回归</td></tr>`;
  } else {
    for (const r of rowsTagged) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="badge ${r._cls}">${r._tag}</span></td>
        <td class="rank-num">${r.rank ?? ""}</td>
        <td><strong>${escapeHTML(r.name || "")}</strong></td>
        <td>${escapeHTML(r.category || "")}</td>
        <td>${escapeHTML(r.subcategory || "") || `<span class="slogan">${escapeHTML(r.slogan || "")}</span>`}</td>
        <td>${escapeHTML(r.publisher || "")}</td>`;
      tbodyG.appendChild(tr);
    }
  }
  if (!diffBoard.new_publishers?.length) {
    tbodyP.innerHTML = `<tr><td colspan="3" class="muted">今日无新进发行商</td></tr>`;
  } else {
    for (const r of diffBoard.new_publishers) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHTML(r.publisher || "")}</td>
        <td>${escapeHTML(r.name || "")}</td>
        <td class="rank-num">${r.rank ?? ""}</td>`;
      tbodyP.appendChild(tr);
    }
  }
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
  const newGameSet = new Set([
    ...((diffBoard?.first_anywhere) || []).map(r => r.name),
    ...((diffBoard?.first_on_board) || []).map(r => r.name),
  ]);

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
      <td>${escapeHTML(r.change || "")}</td>
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

function renderHistoryChart() {
  const canvas = $("chart-history");
  if (!canvas || !state.history.length) return;
  const labels = state.history.map(h => h.date);
  const datasets = [];
  const allKeys = new Set();
  for (const h of state.history) {
    for (const k in (h.boards || {})) allKeys.add(k);
  }
  const palette = ["#6fa8ff", "#ffae3a", "#3ddc84", "#ff6464", "#bd87ff", "#43d3df"];
  let i = 0;
  for (const key of allKeys) {
    datasets.push({
      label: key,
      data: state.history.map(h => h.boards?.[key] ?? null),
      borderColor: palette[i % palette.length],
      backgroundColor: palette[i % palette.length] + "33",
      tension: 0.3,
    });
    i++;
  }
  new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      plugins: { legend: { labels: { color: "#e7e9ee" } } },
      scales: {
        x: { ticks: { color: "#8a8f9c" }, grid: { color: "#2a2e38" } },
        y: { ticks: { color: "#8a8f9c" }, grid: { color: "#2a2e38" } },
      },
    },
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
  // history.jsonl
  try {
    const txt = await fetchText(`${DATA_BASE}/history.jsonl`);
    state.history = txt.split("\n")
      .filter(Boolean)
      .map(s => { try { return JSON.parse(s); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { state.history = []; }

  renderDatePicker();
  // Default to first board.
  setActiveBoard("wx", "人气榜");
  renderKPIs();
  renderHistoryChart();
}

init();
