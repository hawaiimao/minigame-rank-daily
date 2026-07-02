/* Publishers follow-up page.
 * Reads: data/base/publishers.json (list of every publisher we've ever seen)
 * Reads/writes: Supabase table `publisher_status` via PostgREST.
 *   Base URL: <SUPABASE_URL>/rest/v1
 *   Auth:     apikey header + Authorization: Bearer <anon key>
 *
 * Statuses: pending (default) | contacted | rejected | contacting.
 * All UI updates are optimistic — errors surface via a toast and revert.
 */

const STATUS_ORDER = ["pending", "contacted", "rejected", "contacting"];
const STATUS_LABEL = {
  pending:    "待联",
  contacted:  "已联",
  rejected:   "已拒",
  contacting: "联系中",
};
const NOTE_MAX = 200;

const state = {
  publishers: [],   // [{name, games:[], first_seen, boards:[]}, ...]
  status: {},       // { name: { status, note } }
  filter: "all",
  search: "",
  pending: new Set(),
};

const $ = id => document.getElementById(id);

// ---------- Supabase writes ----------

async function pushStatus(publisher, patch) {
  // patch = { status?, note? }
  const body = { publisher };
  if (patch.status !== undefined) body.status = patch.status;
  if (patch.note !== undefined) body.note = patch.note;
  body.updated_at = new Date().toISOString();
  await window.sb.upsert("publisher_status", body, "publisher");
}

async function loadPublishers() {
  // Two queries in parallel:
  //   1. publisher_status: the master list + follow-up state
  //   2. publisher_board_history: which boards each publisher has been on
  const [pubs, boardHist] = await Promise.all([
    window.sb.select("publisher_status", {
      select: "publisher,status,note,first_seen_at,last_seen_at,total_games,total_boards",
      order: "first_seen_at.desc.nullslast",
      limit: 5000,
    }),
    window.sb.select("publisher_board_history", {
      select: "publisher,platform,board",
      limit: 5000,
    }),
  ]);

  // For "which games did this publisher bring on the day it first
  // appeared" — exactly the set we want to show — hit daily_snapshots
  // per publisher/date. That's O(N) round-trips but PostgREST is fast
  // and we can also batch by grouping all publishers that share the
  // same first_seen_at into a single "in.(...)" query.
  //
  // Group publishers by first_seen date so we can query one date at a
  // time.
  const dateGroups = new Map();
  for (const p of pubs) {
    if (!p.first_seen_at) continue;
    if (!dateGroups.has(p.first_seen_at)) dateGroups.set(p.first_seen_at, []);
    dateGroups.get(p.first_seen_at).push(p.publisher);
  }
  // Query snapshots for each date.
  const gamesBy = new Map();  // publisher -> Set(game names on debut day)
  await Promise.all(Array.from(dateGroups.entries()).map(async ([date, names]) => {
    // PostgREST `in.(...)` list limit ~2 KB URL-safe; batch conservatively.
    for (let i = 0; i < names.length; i += 40) {
      const chunk = names.slice(i, i + 40);
      const inList = chunk
        .map(n => `"${n.replace(/"/g, '""')}"`)
        .join(",");
      const rows = await window.sb.select("daily_snapshots", {
        select: "publisher_name,game_name",
        raw: {
          snapshot_date: `eq.${date}`,
          publisher_name: `in.(${inList})`,
        },
        limit: 5000,
      });
      for (const r of rows) {
        if (!r.publisher_name || !r.game_name) continue;
        if (!gamesBy.has(r.publisher_name)) gamesBy.set(r.publisher_name, new Set());
        gamesBy.get(r.publisher_name).add(r.game_name);
      }
    }
  }));

  const boardsBy = new Map();
  for (const r of boardHist) {
    const key = `${r.platform}/${r.board}`;
    if (!boardsBy.has(r.publisher)) boardsBy.set(r.publisher, []);
    boardsBy.get(r.publisher).push(key);
  }

  const list = pubs.map(p => ({
    name: p.publisher,
    // Games this publisher brought on their debut day. If we couldn't
    // find any (no first_seen_at, or snapshot query failed), fall back
    // to an empty list.
    games: Array.from(gamesBy.get(p.publisher) || []),
    first_seen: p.first_seen_at || "",
    boards: boardsBy.get(p.publisher) || [],
  }));
  list.sort((a, b) => {
    if (a.first_seen !== b.first_seen)
      return a.first_seen < b.first_seen ? 1 : -1;
    return a.name.localeCompare(b.name, "zh");
  });
  state.publishers = list;

  const statusMap = {};
  for (const p of pubs) {
    statusMap[p.publisher] = {
      status: p.status || "pending",
      note: p.note || "",
    };
  }
  state.status = statusMap;
}

async function loadStatus() {
  // No-op: loadPublishers already fetched status/note in one call.
}

// ---------- UI ----------

function toast(msg, ok = true) {
  const el = $("pub-toast");
  el.textContent = msg;
  el.className = "pub-toast show" + (ok ? " ok" : " err");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "pub-toast"), 2500);
}

function statusOf(name) {
  return state.status[name]?.status || "pending";
}
function noteOf(name) {
  return state.status[name]?.note || "";
}

function counts() {
  const c = {
    all: state.publishers.length,
    pending: 0, contacted: 0, rejected: 0, contacting: 0,
  };
  for (const p of state.publishers) c[statusOf(p.name)]++;
  return c;
}

function updateCounts() {
  const c = counts();
  for (const k of Object.keys(c)) {
    const el = $(`cnt-${k}`);
    if (el) el.textContent = c[k];
  }
}

function renderRows() {
  const tbody = document.querySelector("#tbl-pub tbody");
  tbody.innerHTML = "";
  const q = state.search.trim().toLowerCase();

  // Filter first (search + status).
  const filtered = state.publishers.filter(p => {
    const st = statusOf(p.name);
    if (state.filter !== "all" && st !== state.filter) return false;
    if (q) {
      const hay = (p.name + " " + p.games.join(" ")).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });

  if (!filtered.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="muted" style="text-align:center;padding:24px">无匹配</td>`;
    tbody.appendChild(tr);
    return;
  }

  // Group by first_seen date. state.publishers is already sorted by
  // first_seen desc + name asc, so grouping in order gives newest → oldest.
  let currentDate = null;
  for (const p of filtered) {
    const seenDate = p.first_seen || "未知日期";
    if (seenDate !== currentDate) {
      currentDate = seenDate;
      // Count publishers in this group after applying the same filters.
      const groupSize = filtered.filter(x => (x.first_seen || "未知日期") === seenDate).length;
      const tr = document.createElement("tr");
      tr.className = "date-divider";
      tr.innerHTML = `<td colspan="5">
        <span class="dv-date">${escapeHTML(seenDate)}</span>
        <span class="dv-count">首次出现 ${groupSize} 家</span>
      </td>`;
      tbody.appendChild(tr);
    }

    const st = statusOf(p.name);
    const tr = document.createElement("tr");
    tr.dataset.name = p.name;
    if (st !== "pending") tr.classList.add(`row-${st}`);
    const games = p.games.slice(0, 2).map(escapeHTML).join("、")
      + (p.games.length > 2 ? ` <span class="muted">+${p.games.length - 2}</span>` : "");
    const boardsShown = p.boards.slice(0, 3);
    const boardsExtra = p.boards.length - boardsShown.length;
    const boards = boardsShown.map(b => {
      const plat = b.startsWith("wx/") ? "wx" : (b.startsWith("douyin/") ? "douyin" : "unknown");
      return `<span class="board-tag board-tag-${plat}">${escapeHTML(shortBoard(b))}</span>`;
    }).join("")
      + (boardsExtra > 0
          ? `<span class="board-tag board-tag-more" title="${escapeAttr(p.boards.map(shortBoard).join('、'))}">+${boardsExtra}</span>`
          : "");
    const note = noteOf(p.name);
    tr.innerHTML = `
      <td class="pub-name">${escapeHTML(p.name)}</td>
      <td class="pub-games" title="${escapeAttr(p.games.join('、'))}">${games}</td>
      <td><div class="pub-boards">${boards}</div></td>
      <td>${statusButtonsHTML(p.name, st)}</td>
      <td>${noteFieldHTML(p.name, note)}</td>`;
    tbody.appendChild(tr);
  }
}

function shortBoard(key) {
  const m = key.match(/^(wx|douyin)\/(.+)$/);
  if (!m) return key;
  const plat = m[1] === "wx" ? "微" : "抖";
  const board = m[2].replace("榜", "");
  return `${plat}·${board}`;
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

function noteFieldHTML(name, note) {
  const shown = escapeAttr(note);
  return `<input class="note-input" type="text" maxlength="${NOTE_MAX}"
    placeholder="备注…"
    data-name="${escapeAttr(name)}" value="${shown}" />`;
}

function attachHandlers() {
  const tbl = document.querySelector("#tbl-pub");

  tbl.addEventListener("click", async (e) => {
    const btn = e.target.closest(".st-btn");
    if (!btn) return;
    const name = btn.dataset.name;
    const nextStatus = btn.dataset.status;
    const prev = state.status[name] || { status: "pending", note: "" };
    if (nextStatus === prev.status) return;

    state.status[name] = { ...prev, status: nextStatus };
    state.pending.add(name);
    renderRows();
    updateCounts();

    try {
      await pushStatus(name, { status: nextStatus });
      state.pending.delete(name);
      renderRows();
      toast(`已更新：${name} → ${STATUS_LABEL[nextStatus]}`, true);
    } catch (err) {
      state.status[name] = prev;
      state.pending.delete(name);
      renderRows();
      updateCounts();
      toast(`同步失败：${err.message}`, false);
    }
  });

  tbl.addEventListener("focusout", async (e) => {
    const input = e.target.closest(".note-input");
    if (!input) return;
    await commitNote(input);
  });
  tbl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const input = e.target.closest(".note-input");
    if (!input) return;
    e.preventDefault();
    input.blur();
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

async function commitNote(input) {
  const name = input.dataset.name;
  const nextNote = input.value.slice(0, NOTE_MAX);
  const prev = state.status[name] || { status: "pending", note: "" };
  if (nextNote === prev.note) return;

  state.status[name] = { ...prev, note: nextNote };
  input.classList.add("saving");
  try {
    await pushStatus(name, { note: nextNote });
    input.classList.remove("saving");
    input.classList.add("saved");
    setTimeout(() => input.classList.remove("saved"), 900);
  } catch (err) {
    state.status[name] = prev;
    input.classList.remove("saving");
    input.value = prev.note;
    toast(`备注保存失败：${err.message}`, false);
  }
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
    updateCounts();
    renderRows();
  }
}

init();
