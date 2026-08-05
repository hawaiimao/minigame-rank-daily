/* Shared auth for the dashboard: editor/viewer login.
 * Expects on the page:
 *   - <header id="page-header"> with an h1 (auth chip is appended to the
 *     top-right corner)
 *   - #gp-auth-slot (optional legacy toolbar slot; renderAuthUI also fills it)
 *   - auth overlay markup with ids gp-auth-email / gp-auth-pass /
 *     gp-auth-login / gp-auth-cancel / gp-auth-err / gp-auth-overlay
 * Provides window.Auth = { state, isEditor, authHeaders, render, logout,
 * openModal, restore, onAuthChange }
 */
(function () {
  const cfg = window.APP_CONFIG || {};
  const SB_URL = cfg.SUPABASE_URL || "";
  const ADMIN_KEY = cfg.PROFILE_ADMIN_KEY || "";
  const KEY = "gp_auth";

  const state = {
    token: null,
    user: null,   // { id, email }
    role: "viewer",
    ready: false,
  };
  const listeners = [];

  function emit() {
    for (const fn of listeners) { try { fn(); } catch (e) {} }
  }

  async function fetchRole(token, uid) {
    try {
      const resp = await fetch(SB_URL + "/rest/v1/profiles?user_id=eq." + encodeURIComponent(uid) + "&select=role", {
        headers: { "Authorization": "Bearer " + token, "apikey": cfg.SUPABASE_KEY },
      });
      if (!resp.ok) return "viewer";
      const arr = await resp.json();
      return (Array.isArray(arr) && arr.length && arr[0].role) || "viewer";
    } catch (e) { return "viewer"; }
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[m]));
  }

  function render() {
    // Header top-right chip
    const header = document.getElementById("page-header");
    if (header) {
      let chip = document.getElementById("auth-chip");
      if (!chip) {
        chip = document.createElement("div");
        chip.id = "auth-chip";
        chip.className = "auth-chip";
        header.appendChild(chip);
      }
      if (state.user) {
        chip.innerHTML = '<span class="auth-chip-email">' + esc(state.user.email || "") + '</span>' +
          '<button type="button" class="auth-btn" id="auth-logout">\u9000\u51fa</button>';
        const lo = document.getElementById("auth-logout");
        if (lo) lo.addEventListener("click", logout);
      } else {
        chip.innerHTML = '<button type="button" class="auth-btn" id="auth-login">\u767b\u5f55</button>';
        const lb = document.getElementById("auth-login");
        if (lb) lb.addEventListener("click", openModal);
      }
    }
    // Legacy toolbar slot (game.html)
    const slot = document.getElementById("gp-auth-slot");
    if (slot) {
      if (state.user) {
        slot.innerHTML = '<span class="gp-user-chip"><span>' + esc(state.user.email || "") + '</span><button type="button" class="gp-auth-btn" id="gp-logout">\u9000\u51fa</button></span>';
        const lo = document.getElementById("gp-logout");
        if (lo) lo.addEventListener("click", logout);
      } else {
        slot.innerHTML = '<button type="button" class="gp-auth-btn" id="gp-login-btn">\u767b\u5f55</button>';
        const lb = document.getElementById("gp-login-btn");
        if (lb) lb.addEventListener("click", openModal);
      }
    }
    emit();
  }

  function openModal() {
    const overlay = document.getElementById("gp-auth-overlay");
    if (!overlay) return;
    overlay.style.display = "flex";
    const err = document.getElementById("gp-auth-err");
    if (err) err.textContent = "";
    const email = document.getElementById("gp-auth-email");
    if (email) email.focus();
  }
  function closeModal() {
    const overlay = document.getElementById("gp-auth-overlay");
    if (overlay) overlay.style.display = "none";
  }

  async function doLogin() {
    const email = document.getElementById("gp-auth-email");
    const pass = document.getElementById("gp-auth-pass");
    const err = document.getElementById("gp-auth-err");
    if (!email || !pass || !err) return;
    const em = email.value.trim();
    const pw = pass.value;
    if (!em || !pw) { err.textContent = "\u8bf7\u8f93\u5165\u90ae\u7bb1\u548c\u5bc6\u7801"; return; }
    err.textContent = "\u767b\u5f55\u4e2d\u2026";
    try {
      const resp = await fetch(SB_URL + "/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": cfg.SUPABASE_KEY },
        body: JSON.stringify({ email: em, password: pw }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error_description || data.msg || ("HTTP " + resp.status));
      const token = data.access_token;
      const uid = (data.user && data.user.id) || "";
      const uemail = (data.user && data.user.email) || em;
      const role = await fetchRole(token, uid);
      state.token = token;
      state.user = { id: uid, email: uemail };
      state.role = role;
      state.ready = true;
      try { localStorage.setItem(KEY, JSON.stringify({ token: token, user: state.user })); } catch (e) {}
      closeModal();
      render();
      if (role !== "editor") alert("\u8be5\u8d26\u53f7\u4e3a\u6d4f\u89c8\u8005\u8d26\u53f7\uff0c\u4ec5\u53ef\u67e5\u770b\uff0c\u65e0\u6cd5\u7f16\u8f91\u3002");
    } catch (err) {
      err.textContent = "\u767b\u5f55\u5931\u8d25\uff1a" + err.message;
    }
  }

  function logout() {
    state.token = null;
    state.user = null;
    state.role = "viewer";
    try { localStorage.removeItem(KEY); } catch (e) {}
    render();
  }

  async function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) {}
    if (saved && saved.token) {
      try {
        const me = await fetch(SB_URL + "/auth/v1/user", {
          headers: { "Authorization": "Bearer " + saved.token, "apikey": cfg.SUPABASE_KEY },
        });
        if (me.ok) {
          const u = await me.json();
          state.token = saved.token;
          state.user = { id: u.id, email: u.email };
          state.role = await fetchRole(saved.token, u.id);
        }
      } catch (e) {}
    }
    state.ready = true;
    render();
  }

  function authHeaders() {
    if (state.token) return { "Authorization": "Bearer " + state.token };
    return { "x-client-info": ADMIN_KEY };
  }
  function isEditor() { return state.role === "editor"; }
  function isLoggedIn() { return !!state.user; }
  function onAuthChange(fn) { listeners.push(fn); }
  function bind() {
    const loginBtn = document.getElementById("gp-auth-login");
    if (loginBtn) loginBtn.addEventListener("click", doLogin);
    const cancelBtn = document.getElementById("gp-auth-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
    const overlay = document.getElementById("gp-auth-overlay");
    if (overlay) overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  }

  window.Auth = {
    state: state, isEditor: isEditor, isLoggedIn: isLoggedIn,
    authHeaders: authHeaders, render: render, logout: logout,
    openModal: openModal, closeModal: closeModal, restore: restore,
    onAuthChange: onAuthChange, bind: bind,
  };
})();
