/* Publishers follow-up page.
 * Reads: publisher_status + publisher_board_history via Supabase
 *   PostgREST (the master publisher list + which boards each has been on).
 * Reads/writes: Supabase table `publisher_status` (status / note).
 *
 * Loading is lazy + paginated:
 *   1. loadPublishersList() fetches the full publisher list + board
 *      history (2 parallel queries) and renders immediately — no waiting
 *      on debut-day games.
 *   2. "代表游戏" (debut-day games) are fetched on demand for the
 *      currently visible page via ensureGamesFor(), grouped by
 *      first_seen date and batched 40 publishers per daily_snapshots
 *      query. Rows show "…" until their games arrive, then re-render.
 *   3. The table renders PAGE_SIZE publishers at a time with a
 *      "加载更多" button.
 *
 * Statuses: pending (default) | contacted | rejected | contacting.
 * All status/note updates are optimistic — errors surface via a toast
 * and revert.
 */

const STATUS_ORDER = ["pending", "contacted", "rejected", "contacting"];
const STATUS_LABEL = {
  pending:    "待联",
  contacted:  "已联",
  rejected:   "已拒",
  contacting: "联系中",
};
const NOTE_MAX = 200;
const PAGE_SIZE = 50;

const state = {
  publishers: [],   // [{name, games: string[]|null, first_seen, boards}, ...]
                    // games === null means debut-day games not fetched yet.
  status: {},       // { name: { status, note } }
  filter: "all",
  search: "",
  pending: new Set(),
  page: 0,          // pages of PAGE_SIZE currently rendered
  gamesLoading: new Set(),  // publisher names with an in-flight games fetch
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

// ---------- data loading ----------

async function loadPublishersList() {
  // Two queries in parallel:
  //   1. publisher_status: the master list + follow-up state
  //   2. publisher_board_history: which boards each publisher has been on
  // Debut-day games are NOT fetched here — they load lazily per visible
  // page in ensureGamesFor().
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

  const boardsBy = new Map();
  for (const r of boardHist) {
    const key = `${r.platform}/${r.board}`;
    if (!boardsBy.has(r.publisher)) boardsBy.set(r.publisher, []);
    boardsBy.get(r.publisher).push(key);
  }

  const list = pubs.map(p => ({
    name: p.publisher,
    games: null,            // fetched lazily in ensureGamesFor()
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

// Fetch debut-day games for the given publishers (only those not already
// loaded or loading). Groups by first_seen date and batches 40 publishers
// per daily_snapshots `in.(...)` query. Re-renders when done so the "…"
// placeholders fill in. Fire-and-forget — callers don't await.
async function ensureGamesFor(list) {
  const need = list.filter(p =>
    p.first_seen && p.games === null && !state.gamesLoading.has(p.name));
  if (!need.length) return;
  for (const p of need) state.gamesLoading.add(p.name);

  const byName = new Map(state.publishers.map(p => [p.name, p]));
  try {
    // Group the publishers we need by their debut date so we can issue
    // one daily_snapshots query per (date, 40-publisher chunk).
    const byDate = new Map();
    for (const p of need) {
      if (!byDate.has(p.first_seen)) byDate.set(p.first_seen, []);
      byDate.get(p.first_seen).push(p.name);
    }
    await Promise.all(Array.from(byDate.entries()).map(async ([date, names]) => {
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
          const p = byName.get(r.publisher_name);
          if (!p) continue;
          (p.games ||= new Set()).add(r.game_name);
        }
      }
    }));
    // Freeze accumulated sets into arrays; empty for publishers with no rows.
    for (const p of need) {
      p.games = p.games instanceof Set ? Array.from(p.games) : [];
    }
  } catch (err) {
    // Leave games === null on failure so a future render can retry.
    for (const p of need) {
      if (p.games instanceof Set) p.games = Array.from(p.games);
      else p.games = null;
    }
    toast(`代表游戏拉取失败：${err.message}`, false);
  } finally {
    for (const p of need) state.gamesLoading.delete(p.name);
  }
  renderRows();
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

function filteredPublishers() {
  const q = state.search.trim().toLowerCase();
  return state.publishers.filter(p => {
    const st = statusOf(p.name);
    if (state.filter !== "all" && st !== state.filter) return false;
    if (q) {
      // games may be null (not yet loaded) — search name only in that case.
      const hay = (p.name + " " + (p.games ? p.games.join(" ") : "")).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}

function renderRows() {
  const tbody = document.querySelector("#tbl-pub tbody");
  tbody.innerHTML = "";

  const filtered = filteredPublishers();
  const shown = filtered.slice(0, (state.page + 1) * PAGE_SIZE);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">无匹配</td></tr>`;
    return;
  }

  // Total publishers per debut date (across the whole filtered set) so
  // each date divider shows the real group size, not just the page slice.
  const groupTotals = new Map();
  for (const p of filtered) {
    const d = p.first_seen || "未知日期";
    groupTotals.set(d, (groupTotals.get(d) || 0) + 1);
  }

  // state.publishers is sorted by first_seen desc + name asc, and
  // filteredPublishers preserves that order, so grouping in iteration
  // gives newest → oldest.
  let currentDate = null;
  for (const p of shown) {
    const seenDate = p.first_seen || "未知日期";
    if (seenDate !== currentDate) {
      currentDate = seenDate;
      const tr = document.createElement("tr");
      tr.className = "date-divider";
      tr.innerHTML = `<td colspan="5">
        <span class="dv-date">${escapeHTML(seenDate)}</span>
        <span class="dv-count">首次出现 ${groupTotals.get(seenDate) || 0} 家</span>
      </td>`;
      tbody.appendChild(tr);
    }

    const st = statusOf(p.name);
    const tr = document.createElement("tr");
    tr.dataset.name = p.name;
    if (st !== "pending") tr.classList.add(`row-${st}`);

    const gamesCell = p.games == null
      ? `<span class="muted">…</span>`
      : (p.games.slice(0, 2).map(escapeHTML).join("、")
          + (p.games.length > 2 ? ` <span class="muted">+${p.games.length - 2}</span>` : "")
          || `<span class="muted">—</span>`);
    const boardsShown = p.boards.slice(0, 3);
    const boardsExtra = p.boards.length - boardsShown.length;
    const boards = boardsShown.map(b => {
      const plat = b.startsWith("wx/") ? "wx"
        : b.startsWith("douyin/") ? "douyin"
        : b.startsWith("taptap/") ? "taptap"
        : "unknown";
      return `<span class="board-tag board-tag-${plat}">${escapeHTML(shortBoard(b))}</span>`;
    }).join("")
      + (boardsExtra > 0
          ? `<span class="board-tag board-tag-more" title="${escapeAttr(p.boards.map(shortBoard).join('、'))}">+${boardsExtra}</span>`
          : "");
    const note = noteOf(p.name);
    tr.innerHTML = `
      <td class="pub-name">${escapeHTML(p.name)}</td>
      <td class="pub-games" title="${escapeAttr(p.games ? p.games.join('、') : '')}">${gamesCell}</td>
      <td><div class="pub-boards">${boards}</div></td>
      <td>${statusButtonsHTML(p.name, st)}</td>
      <td>${noteFieldHTML(p.name, note)}</td>`;
    tbody.appendChild(tr);
  }

  // "Load more" row if there are still filtered publishers off-page.
  if (shown.length < filtered.length) {
    const remaining = filtered.length - shown.length;
    const more = document.createElement("tr");
    more.className = "load-more-row";
    more.innerHTML = `<td colspan="5" class="load-more-cell">
      <button type="button" id="pub-more" class="load-more-btn">
        加载更多（还有 ${remaining} 家）
      </button></td>`;
    tbody.appendChild(more);
    $("pub-more").onclick = () => {
      state.page++;
      renderRows();
    };
  }

  // Fetch debut-day games for whatever is now visible (fire-and-forget;
  // it re-renders once they arrive).
  ensureGamesFor(shown);
}

function shortBoard(key) {
  const m = key.match(/^(wx|douyin|taptap)\/(.+)$/);
  if (!m) return key;
  const plat = m[1] === "wx" ? "微"
    : m[1] === "douyin" ? "抖"
    : m[1] === "taptap" ? "Tap"
    : "";
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
    state.page = 0;
    renderRows();
  });

  document.getElementById("pub-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    document.querySelectorAll("#pub-filter button").forEach(x =>
      x.classList.toggle("active", x === b));
    state.filter = b.dataset.filter;
    state.page = 0;
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
    await loadPublishersList();
    loading.style.display = "none";
    updateCounts();
    renderRows();   // renders first page + kicks off games fetch for it
  } catch (err) {
    loading.textContent = `加载失败：${err.message}（点击右侧按钮时会重试同步状态）`;
    updateCounts();
    renderRows();
  }
}

init();