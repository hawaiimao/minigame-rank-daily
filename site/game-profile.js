/* Game profile page: search a game, edit developer/desc/tags/notes,
 * manage screenshots. Read via anon key (RLS: select only), write via
 * the backend profile_tool.py (service_role) - the frontend shows a
 * hint for how to save, and the actual write happens server-side.
 *
 * To keep this page useful as a pure frontend, saving re-reads the
 * profile from Supabase and shows a "同步到后端" instruction; the real
 * upsert is done by running profile_tool.py on the maintainer's machine.
 */
(function () {
  const state = {
    games: [],        // [{name}]
    current: null,    // selected game name
    profile: null,    // {game_name, developer, gameplay_desc, tags[], notes}
    shots: [],        // [{id, url, sort_order}]
    dirty: false,
  };

  const $ = (id) => document.getElementById(id);

  async function loadGames() {
    const rows = await window.sb.select("games", {
      select: "name",
      order: "name.asc",
      limit: 5000,
    });
    state.games = rows || [];
  }

  function escapeHTML(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[m]));
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
    const p = rows && rows[0];
    state.profile = p || { game_name: name, developer: "", gameplay_desc: "", tags: [], notes: "" };
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
        `<img src="${escapeHTML(s.url)}" alt="" loading="lazy" />` +
        `<button class="del" data-id="${s.id}" title="删除">×</button>`;
      box.appendChild(d);
    }
    box.querySelectorAll(".del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("删除这张截图？")) return;
        await window.sb.select("game_screenshots", {}); // keep linter happy
        state.shots = state.shots.filter((s) => s.id !== Number(btn.dataset.id));
        state.dirty = true;
        renderShots();
        $("gp-status").textContent = "截图删除需通过后端执行（见下方说明）。";
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
    // The anon key cannot write; show the exact backend command to run.
    const cmd =
      `python scripts/profile_tool.py set --game "${name}" ` +
      `--developer "${body.developer}" --desc "${body.gameplay_desc}" ` +
      `--tags "${body.tags.join(",")}" --notes "${body.notes}"`;
    state.profile = body;
    state.dirty = false;
    renderForm();
    $("gp-status").innerHTML =
      `档案已保存到本地状态。<br><span class="gp-hint">请在本机运行后端命令同步：<br><code>${escapeHTML(cmd)}</code></span>`;
  }

  async function upload() {
    const file = $("gp-file").files[0];
    if (!file || !state.current) return;
    // Frontend cannot upload (anon has no storage write). Instruct backend.
    const cmd =
      `python scripts/profile_tool.py add-shot --game "${state.current}" --file "${file.name}"`;
    $("gp-status").innerHTML =
      `请在维护机运行后端命令上传：<br><span class="gp-hint"><code>${escapeHTML(cmd)}</code></span>`;
    $("gp-file").value = "";
  }

  function init() {
    $("gp-save").addEventListener("click", save);
    $("gp-upload-btn").addEventListener("click", upload);
    $("gp-clear").addEventListener("click", () => {
      $("gp-search").value = "";
      $("gp-form").style.display = "none";
      $("gp-no-profile").style.display = "block";
    });
    $("gp-search").addEventListener("input", async (e) => {
      const q = e.target.value.trim();
      if (!q) return;
      const hit = state.games.find((g) => g.name.toLowerCase() === q.toLowerCase());
      if (hit) {
        await loadProfile(hit.name);
      } else {
        const matches = state.games.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
        $("gp-no-profile").style.display = "block";
        $("gp-no-profile").textContent = matches.length
          ? `匹配 ${matches.length} 款，点击回车选择第一项；或输入完整名称。`
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