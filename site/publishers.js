/* Publishers follow-up page.
 * Reads: data/base/publishers.json (list of every publisher we've ever seen)
 * Reads/writes: Google Apps Script Web App (window.APP_CONFIG.SHEET_API)
 *   - GET  → { ok, data: { "<publisher>": "<status>", ... } }
 *   - POST → { publisher, status } → persists status
 *
 * Statuses: pending (default) | contacted | rejected | closed.
 * All UI updates are optimistic — errors surface via a toast and revert.
 */

const STATUS_ORDER = ["pending", "contacted", "rejected", "closed"];
const STATUS_LABEL = {
  pending:   "待联",
  contacted: "已联",
  rejected:  "已拒",
  closed:    "联系中",
};

const state = {
  publishers: [],   // [{name, games:[], first_seen, boards:[]}, ...]
  status: {},       // { name: 'pending'|'contacted'|... }
  filter: "all",
  search: "",
  pending: new Set(), // publisher names with in-flight write
};

const $ = id => document.getElementById(id);

async function fetchJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function loadPublishers() {
  // publishers.json shape: { publishers: { <name>: { name, first_seen_anywhere, games, board_history } } }
  const raw = await fetchJSON("./data/base/publishers.json");
  const dict = raw.publishers || {};
  const list = Object.values(dict).map(p => ({
    name: p.name,
    games: p.games || [],
    first_seen: p.first_seen_anywhere || "",
    boards: Object.keys(p.board_history || {}),
  }));
  // Sort: newest-seen first, then by name.
  list.sort((a, b) => {
    if (a.first_seen !== b.first_seen)
      return a.first_seen < b.first_seen ? 1 : -1;
    return a.name.localeCompare(b.name, "zh");
  });
  state.publishers = list;
}

async function loadStatus() {
  const url = window.APP_CONFIG?.SHEET_API;
  if (!url) throw new Error("SHEET_API not configured");
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`status api ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "status api not ok");
  state.status = j.data || {};
}

async function pushStatus(publisher, status) {
  const url = window.APP_CONFIG?.SHEET_API;
  // POSTs to Apps Script must have a "simple" content type (avoid
  // triggering CORS preflight, which Apps Script won't answer).
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ publisher, status }),
  });
  if (!r.ok) throw new Error(`sheet write ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "sheet write not ok");
}

function toast(msg, ok = true) {
  const el = $("pub-toast");
  el.textContent = msg;
  el.className = "pub-toast show" + (ok ? " ok" : " err");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "pub-toast"), 2500);
}

function statusOf(name) {
  return state.status[name] || "pending";
}

function counts() {
  const c = { all: state.publishers.length,
              pending: 0, contacted: 0, rejected: 0, closed: 0 };
  for (const p of state.publishers) c[statusOf(p.name)]++;
  return c;
}

function updateCounts() {
  const c = counts();
  for (const k of Object.keys(c)) $(`cnt-${k}`).textContent = c[k];
}

function renderRows() {
  const tbody = document.querySelector("#tbl-pub tbody");
  tbody.innerHTML = "";
  const q = state.search.trim().toLowerCase();
  let shown = 0;
  for (const p of state.publishers) {
    const st = statusOf(p.name);
    if (state.filter !== "all" && st !== state.filter) continue;
    if (q) {
      const hay = (p.name + " " + p.games.join(" ")).toLowerCase();
      if (hay.indexOf(q) === -1) continue;
    }
    shown++;
    const tr = document.createElement("tr");
    tr.dataset.name = p.name;
    if (st !== "pending") tr.classList.add(`row-${st}`);
    tr.innerHTML = `
      <td class="pub-name">${escapeHTML(p.name)}</td>
      <td class="pub-games">${escapeHTML(p.games.slice(0, 3).join("、"))}${p.games.length > 3 ? ` <span class="muted">+${p.games.length - 3}</span>` : ""}</td>
      <td class="pub-boards">${p.boards.map(b => `<span class="board-tag">${escapeHTML(b)}</span>`).join("")}</td>
      <td class="pub-first">${escapeHTML(p.first_seen)}</td>
      <td>${statusButtonsHTML(p.name, st)}</td>`;
    tbody.appendChild(tr);
  }
  if (!shown) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="muted" style="text-align:center;padding:24px">无匹配</td>`;
    tbody.appendChild(tr);
  }
}

function statusButtonsHTML(name, cur) {
  const pending = state.pending.has(name);
  return `<div class="status-buttons ${pending ? 'is-pending' : ''}">${
    STATUS_ORDER.map(s => {
      const active = s === cur ? "active" : "";
      return `<button class="st-btn st-${s} ${active}" data-name="${escapeAttr(name)}" data-status="${s}">${STATUS_LABEL[s]}</button>`;
    }).join("")
  }</div>`;
}

function attachHandlers() {
  document.querySelector("#tbl-pub").addEventListener("click", async (e) => {
    const btn = e.target.closest(".st-btn");
    if (!btn) return;
    const name = btn.dataset.name;
    const nextStatus = btn.dataset.status;
    const prevStatus = statusOf(name);
    if (nextStatus === prevStatus) return; // no-op

    // Optimistic update.
    state.status[name] = nextStatus;
    state.pending.add(name);
    renderRows();
    updateCounts();

    try {
      await pushStatus(name, nextStatus);
      state.pending.delete(name);
      renderRows();
      toast(`已更新：${name} → ${STATUS_LABEL[nextStatus]}`, true);
    } catch (err) {
      // Rollback.
      state.status[name] = prevStatus;
      state.pending.delete(name);
      renderRows();
      updateCounts();
      toast(`同步失败：${err.message}`, false);
    }
  });

  document.getElementById("pub-search").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderRows();
  });

  document.getElementById("pub-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    document.querySelectorAll("#pub-filter button").forEach(x =>
      x.classList.toggle("active", x === b));
    state.filter = b.dataset.filter;
    renderRows();
  });
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}
function escapeAttr(s) { return escapeHTML(s).replace(/`/g, "&#96;"); }

async function init() {
  attachHandlers();
  const loading = $("pub-loading");
  try {
    await loadPublishers();
    loading.textContent = `已加载 ${state.publishers.length} 家发行商，正在拉取跟进状态…`;
    await loadStatus();
    loading.style.display = "none";
    updateCounts();
    renderRows();
  } catch (err) {
    loading.textContent = `加载失败：${err.message}（点击右侧按钮时会重试同步状态）`;
    // Even if the sheet failed to load, still render the list so the
    // page is usable — writes will attempt and either succeed or toast.
    updateCounts();
    renderRows();
  }
}

init();
