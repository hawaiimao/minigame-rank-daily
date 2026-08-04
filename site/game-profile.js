/* Game profile page: search a game, edit developer/desc/tags/notes,
 * manage screenshots. Read via anon key (RLS select), write via the
 * save-profile Edge Function (admin key gate).
 */
(function () {
  const FN_URL = "https://pjwwwxanhtvzkscumedm.supabase.co/functions/v1/save-profile";
  const ADMIN_KEY = (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ADMIN_KEY) || "";

  const state = {
    games: [],
    current: null,
    profile: null,
    shots: [],
    dirty: false,
  };

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[m]));
  }

  async function loadGames() {
    const rows = await window.sb.select("games", {
      select: "name",
      order: "name.asc",
      limit: 5000,
    });
    state.games = rows || [];
  }

  async function loadProfile(name) {
    const rows = await window.sb.select("game_profiles", {
      match: { game_name: name },
      limit: 1,
    });
    const shots = await window.sb.select("game_screenshots", {
      match: { game_name: name },
      order: "sort_order.asc,id.asc",
      limit: 200,
    });
    state.profile = (rows && rows[0]) || {
      game_name: name, developer: "", gameplay_desc: "", tags: [], notes: "",
    };
    state.shots = shots || [];
    state.current = name;
    state.dirty = false;
    renderForm();
  }

  function renderForm() {
    const p = state.profile;
    $("gp-title").textContent = p.game_name;
    $("gp-developer").value = p.developer || "";
    $("gp-desc").value = p.gameplay_desc || "";
    $("gp-tags").value = (p.tags || []).join(", ");
    $("gp-notes").value = p.notes || "";
    renderShots();
    $("gp-form").style.display = "block";
    $("gp-no-profile").style.display = "none";
    $("gp-status").textContent = state.dirty ? "有未保存修改。" : "";
  }

  function renderShots() {
    const box = $("gp-shots");
    box.innerHTML = "";
    if (!state.shots.length) {
      box.innerHTML = '<span class="gp-hint">暂无截图</span>';
      return;
    }
    for (const s of state.shots) {
      const d = document.createElement("div");
      d.className = "gp-shot";
      d.innerHTML =
        `<img src="${esc(s.url)}" alt="" loading="lazy" />` +
        `<button class="del" data-id="${s.id}" title="删除">×</button>`;
      box.appendChild(d);
    }
    box.querySelectorAll(".del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("删除这张截图？")) return;
        state.shots = state.shots.filter((s) => s.id !== Number(btn.dataset.id));
        state.dirty = true;
        renderShots();
        $("gp-status").textContent = "截图删除需在维护机运行 profile_tool.py rm-shot（当前版本）。";
      });
    });
  }

  async function save() {
    const name = state.current;
    const body = {
      game_name: name,
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
      state.profile = body;
      state.dirty = false;
      renderForm();
      $("gp-status").textContent = "已保存到数据库。";
    } catch (err) {
      $("gp-status").textContent = "保存失败：" + err.message;
    }
  }

  async function upload() {
    const fileInput = $("gp-file");
    const files = Array.from(fileInput.files || []);
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
      fileInput.value = "";
      await loadProfile(state.current);
      $("gp-status").textContent = "截图已上传。";
    } catch (err) {
      $("gp-status").textContent = "上传失败：" + err.message;
    }
  }

  function init() {
    $("gp-save").addEventListener("click", save);
    $("gp-upload-btn").addEventListener("click", upload);
    $("gp-clear").addEventListener("click", () => {
      $("gp-search").value = "";
      $("gp-form").style.display = "none";
      $("gp-no-profile").style.display = "block";
    });
    $("gp-search").addEventListener("input", (e) => {
      const q = e.target.value.trim();
      if (!q) return;
      const hit = state.games.find((g) => g.name.toLowerCase() === q.toLowerCase());
      if (hit) {
        loadProfile(hit.name);
      } else {
        const matches = state.games.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
        $("gp-no-profile").style.display = "block";
        $("gp-no-profile").textContent = matches.length
          ? `匹配 ${matches.length} 款，输入完整名称确认。`
          : "未找到匹配游戏。";
        $("gp-form").style.display = "none";
      }
    });
    $("gp-search").addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      const q = $("gp-search").value.trim().toLowerCase();
      const hit = state.games.find((g) => g.name.toLowerCase() === q);
      if (hit) await loadProfile(hit.name);
      else {
        const matches = state.games.filter((g) => g.name.toLowerCase().includes(q));
        if (matches.length === 1) await loadProfile(matches[0].name);
        else if (matches.length > 1) $("gp-status").textContent = "多个匹配，请输入完整游戏名。";
      }
    });
  }

  (async function () {
    init();
    try {
      await loadGames();
      const q = new URLSearchParams(location.search).get("name");
      if (q) {
        const hit = state.games.find((g) => g.name === q);
        if (hit) {
          $("gp-search").value = q;
          await loadProfile(hit.name);
          return;
        }
        $("gp-status").textContent = "未找到游戏：" + q;
      }
      $("gp-loading").style.display = "none";
      $("gp-no-profile").style.display = "block";
      $("gp-no-profile").textContent = "输入游戏名开始编辑（按回车确认）。";
    } catch (err) {
      $("gp-loading").textContent = "加载失败：" + err.message;
    }
  })();
})();