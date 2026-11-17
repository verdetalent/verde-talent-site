// Follow a company / get alerts for a search. Loaded on jobs.html, company pages, job pages and
// the candidate dashboard.
//
// Both belong to a candidate profile: alerts are one more reason to create one, never a way
// around it. Signed in as a candidate -> saved straight to the account. Signed out -> a small
// prompt to create a free profile (or sign in); what they asked for is kept in localStorage
// ("vt_pending_alerts") and saved to the account the next time a page with this script loads
// signed in, which is normally the dashboard right after sign-up or sign-in.
//
// Markup it wires up:
//   <button data-vt-follow data-company="Sunrun" data-slug="sunrun">Follow</button>
//   <button data-vt-save-search>Get alerts for this search</button>   (jobs.html; the page sets
//     window.vtCurrentSearchCriteria = () => raw filter state)
// Pages call gtag only (never FullStory directly).
(function () {
  "use strict";
  var SUPABASE_URL = "https://iqcyofkosjopxsfdufvy.supabase.co";
  var ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";
  var PENDING_KEY = "vt_pending_alerts";

  function track(name, params) {
    try { if (typeof gtag === "function") gtag("event", name, params || {}); } catch (e) {}
  }
  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  // Candidate session (same storage and refresh as dashboard.html). null when signed out or
  // when the signed-in account has no candidate profile.
  async function session() {
    var s = readJson("vt_session", null);
    if (!s || !s.refresh_token || !s.candidate_id) return null;
    if (s.expires_at && s.expires_at > Date.now() + 60000) return s;
    try {
      var res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
      if (!res.ok) throw new Error("refresh failed");
      var d = await res.json();
      s.access_token = d.access_token;
      s.refresh_token = d.refresh_token;
      s.expires_at = Date.now() + (d.expires_in || 3600) * 1000;
      writeJson("vt_session", s);
      return s;
    } catch (e) {
      return null;
    }
  }

  async function api(s, method, path, body) {
    var headers = { apikey: ANON_KEY, Authorization: "Bearer " + s.access_token };
    if (body) {
      headers["Content-Type"] = "application/json";
      // An exact duplicate (same company / same search) is ignored instead of erroring.
      headers.Prefer = "resolution=ignore-duplicates,return=representation";
    }
    var res = await fetch(SUPABASE_URL + "/rest/v1/" + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      var msg = (data && data.message) || "Something went wrong - please try again.";
      if (!/up to \d+/.test(msg)) msg = "Something went wrong - please try again.";
      throw new Error(msg);
    }
    return data;
  }

  // ---- Follows -------------------------------------------------------------
  var follows = null; // Map companyKey -> row, once loaded
  function key(name) { return window.VTSearchMatch ? window.VTSearchMatch.companyKey(name) : (name || "").toLowerCase().trim(); }

  async function loadFollows(s) {
    if (follows) return follows;
    follows = new Map();
    try {
      var rows = await api(s, "GET", "candidate_company_follows?select=id,company_name,company_slug,created_at&order=created_at.desc");
      (rows || []).forEach(function (r) { follows.set(key(r.company_name), r); });
    } catch (e) {}
    return follows;
  }

  async function follow(company, slug) {
    var s = await session();
    if (!s) { queue({ type: "follow", company: company, slug: slug || null }); prompt("follow", company); return false; }
    var rows = await api(s, "POST", "candidate_company_follows?on_conflict=candidate_id,company_name",
      { candidate_id: s.candidate_id, company_name: company, company_slug: slug || null });
    await loadFollows(s);
    follows.set(key(company), (rows && rows[0]) || { company_name: company, company_slug: slug || null });
    track("follow_company", { company: company });
    return true;
  }

  async function unfollow(company) {
    var s = await session();
    if (!s) return;
    var row = follows && follows.get(key(company));
    var filter = row && row.id ? "id=eq." + row.id : "company_name=eq." + encodeURIComponent(company);
    await api(s, "DELETE", "candidate_company_follows?" + filter);
    if (follows) follows.delete(key(company));
    track("unfollow_company", { company: company });
  }

  // ---- Saved searches ------------------------------------------------------
  async function saveSearch(rawCriteria) {
    var M = window.VTSearchMatch;
    var criteria = M.normalizeCriteria(rawCriteria);
    // "All jobs" would email every new posting - ask for at least one filter or search term.
    var narrowed = criteria.q || criteria.location || criteria.scope !== "us_remote" || criteria.salary_min ||
      ["sectors", "categories", "seniority", "work_styles", "employment_types", "visa", "skills"]
        .some(function (k) { return criteria[k].length; });
    if (!narrowed) throw new Error("Pick a sector, location or other filter first, then save the search.");
    var label = M.describe(criteria);
    var s = await session();
    if (!s) { queue({ type: "search", criteria: criteria }); prompt("search", label); return false; }
    await api(s, "POST", "candidate_saved_searches?on_conflict=candidate_id,criteria",
      { candidate_id: s.candidate_id, label: label, criteria: criteria });
    track("save_search", { search_label: label });
    return true;
  }

  async function listSavedSearches() {
    var s = await session();
    if (!s) return [];
    return (await api(s, "GET", "candidate_saved_searches?select=id,label,criteria,created_at&order=created_at.desc")) || [];
  }
  async function deleteSavedSearch(id) {
    var s = await session();
    if (!s) return;
    await api(s, "DELETE", "candidate_saved_searches?id=eq." + encodeURIComponent(id));
    track("delete_saved_search", {});
  }
  async function listFollows() {
    var s = await session();
    if (!s) return [];
    follows = null;
    var m = await loadFollows(s);
    return Array.from(m.values());
  }

  // ---- Pending (signed out) ------------------------------------------------
  function queue(item) {
    var p = readJson(PENDING_KEY, []);
    var sig = JSON.stringify(item);
    if (!p.some(function (x) { return JSON.stringify(x) === sig; })) p.push(item);
    writeJson(PENDING_KEY, p.slice(-20));
  }

  // Saves anything queued while signed out. Returns how many were saved.
  async function flushPending() {
    var p = readJson(PENDING_KEY, []);
    if (!p.length) return 0;
    var s = await session();
    if (!s) return 0;
    var saved = 0, left = [];
    for (var i = 0; i < p.length; i++) {
      var it = p[i];
      try {
        if (it.type === "follow" && it.company) {
          await api(s, "POST", "candidate_company_follows?on_conflict=candidate_id,company_name",
            { candidate_id: s.candidate_id, company_name: it.company, company_slug: it.slug || null });
          track("follow_company", { company: it.company, after_signup: true });
          saved++;
        } else if (it.type === "search" && it.criteria) {
          var c = window.VTSearchMatch.normalizeCriteria(it.criteria);
          await api(s, "POST", "candidate_saved_searches?on_conflict=candidate_id,criteria",
            { candidate_id: s.candidate_id, label: window.VTSearchMatch.describe(c), criteria: c });
          track("save_search", { after_signup: true });
          saved++;
        }
      } catch (e) {
        if (!/up to \d+/.test(e.message)) left.push(it); // over the limit: drop it, otherwise retry next time
      }
    }
    writeJson(PENDING_KEY, left);
    follows = null;
    return saved;
  }

  // ---- UI ------------------------------------------------------------------
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(t) {
    return String(t || "").replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }

  function injectCss() {
    if (document.getElementById("vt-alerts-css")) return;
    var css = [
      ".vta-scrim{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;}",
      ".vta-modal{background:var(--card,#131313);border:0.5px solid var(--bdr2,rgba(255,255,255,.14));border-radius:16px;max-width:420px;width:100%;padding:28px 24px 22px;position:relative;color:var(--t1,#fff);font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);}",
      ".vta-modal h2{font-size:19px;font-weight:600;margin:0 0 8px;line-height:1.3;}",
      ".vta-modal p{font-size:14px;color:var(--t2,rgba(255,255,255,.6));line-height:1.55;margin:0 0 18px;}",
      ".vta-modal .vta-what{display:block;font-size:13px;color:var(--t1,#fff);background:rgba(34,224,154,.08);border:0.5px solid rgba(34,224,154,.3);border-radius:9px;padding:9px 12px;margin:0 0 18px;}",
      ".vta-btn{display:block;width:100%;text-align:center;background:var(--grn,#22E09A);color:#052e1e;font-weight:600;font-size:14px;border:0;border-radius:10px;padding:12px 16px;text-decoration:none;cursor:pointer;}",
      ".vta-alt{display:block;text-align:center;font-size:13px;color:var(--t2,rgba(255,255,255,.6));margin-top:12px;}",
      ".vta-alt a{color:var(--grn,#22E09A);}",
      ".vta-x{position:absolute;top:12px;right:12px;background:none;border:0;color:var(--t3,rgba(255,255,255,.35));font-size:18px;cursor:pointer;width:32px;height:32px;}",
      ".vta-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#0F2A1F;color:#fff;border:0.5px solid rgba(34,224,154,.45);border-radius:10px;padding:11px 16px;font-size:13.5px;z-index:1001;max-width:calc(100% - 32px);box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);}",
      ".vta-toast a{color:var(--grn,#22E09A);margin-left:6px;}",
      ".vta-toast.err{background:#2A1410;border-color:rgba(255,112,85,.5);}",
      "[data-vt-follow]{display:inline-flex;align-items:center;gap:6px;background:transparent;border:0.5px solid var(--bdr2,rgba(255,255,255,.14));color:var(--t1,#fff);border-radius:999px;padding:7px 14px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;white-space:nowrap;}",
      "[data-vt-follow]:hover{border-color:var(--grn,#22E09A);}",
      "[data-vt-follow].on{background:rgba(34,224,154,.1);border-color:rgba(34,224,154,.5);color:var(--grn,#22E09A);}",
      "[data-vt-follow] svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;}",
    ].join("");
    document.head.appendChild(el("style", { id: "vt-alerts-css" }, css));
  }

  function toast(html, isError) {
    injectCss();
    var old = document.querySelector(".vta-toast");
    if (old) old.remove();
    var t = el("div", { class: "vta-toast" + (isError ? " err" : ""), role: "status" }, html);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 5000);
  }

  function prompt(kind, what) {
    injectCss();
    track("alert_signup_prompt", { kind: kind });
    var title = kind === "follow" ? "Follow " + esc(what) : "Get alerts for this search";
    var body = kind === "follow"
      ? "Create a free profile and we'll email you when " + esc(what) + " posts a new role. Employers can find you too."
      : "Create a free profile and we'll email you new jobs that match this search. Employers can find you too.";
    var scrim = el("div", { class: "vta-scrim", role: "dialog", "aria-modal": "true" });
    scrim.innerHTML =
      '<div class="vta-modal">' +
      '<button type="button" class="vta-x" aria-label="Close">&#10005;</button>' +
      "<h2>" + title + "</h2><p>" + body + "</p>" +
      (kind === "search" ? '<span class="vta-what">' + esc(what) + "</span>" : "") +
      '<a class="vta-btn" href="/create-profile.html?utm_source=site&utm_medium=alerts&utm_campaign=' + kind + '">Create free profile &rarr;</a>' +
      '<span class="vta-alt">Already have one? <a href="/login.html">Sign in</a>. We\'ll save this when you\'re back.</span>' +
      "</div>";
    function close() { scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    scrim.addEventListener("click", function (e) { if (e.target === scrim || e.target.classList.contains("vta-x")) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(scrim);
  }

  var BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  var CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  function paintFollow(btn, on) {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    var name = btn.hasAttribute("data-show-name") ? " " + esc(btn.dataset.company) : "";
    btn.innerHTML = on ? CHECK + "Following" + name : BELL + "Follow" + name;
    btn.title = on ? "You'll get an email when " + btn.dataset.company + " posts a new role. Click to unfollow."
                   : "Get an email when " + btn.dataset.company + " posts a new role";
  }

  async function wireFollowButtons() {
    var btns = Array.prototype.slice.call(document.querySelectorAll("[data-vt-follow]"));
    if (!btns.length) return;
    injectCss();
    btns.forEach(function (b) { paintFollow(b, false); });
    var s = await session();
    if (s) {
      var m = await loadFollows(s);
      btns.forEach(function (b) { paintFollow(b, m.has(key(b.dataset.company))); });
    }
    btns.forEach(function (b) {
      b.addEventListener("click", async function () {
        var company = b.dataset.company;
        b.disabled = true;
        try {
          if (b.classList.contains("on")) {
            await unfollow(company);
            paintFollow(b, false);
            toast("Unfollowed " + esc(company) + ".");
          } else if (await follow(company, b.dataset.slug)) {
            paintFollow(b, true);
            toast("Following " + esc(company) + ". New roles will be in your job alert email.<a href=\"/dashboard.html#alerts\">Manage</a>");
          }
        } catch (e) {
          toast(esc(e.message), true);
        } finally {
          b.disabled = false;
        }
      });
    });
  }

  function wireSaveSearchButtons() {
    document.querySelectorAll("[data-vt-save-search]").forEach(function (b) {
      b.addEventListener("click", async function () {
        if (typeof window.vtCurrentSearchCriteria !== "function") return;
        b.disabled = true;
        try {
          if (await saveSearch(window.vtCurrentSearchCriteria())) {
            toast("Search saved. New matches will be in your job alert email.<a href=\"/dashboard.html#alerts\">Manage</a>");
          }
        } catch (e) {
          toast(esc(e.message), true);
        } finally {
          b.disabled = false;
        }
      });
    });
  }

  var ready = (async function () {
    if (document.readyState === "loading") await new Promise(function (r) { document.addEventListener("DOMContentLoaded", r); });
    var saved = 0;
    try { saved = await flushPending(); } catch (e) {}
    if (saved && !/dashboard\.html/.test(location.pathname)) toast("Saved to your job alerts ✓<a href=\"/dashboard.html#alerts\">Manage</a>");
    wireSaveSearchButtons();
    await wireFollowButtons();
    return saved;
  })();

  window.VTAlerts = {
    ready: ready,
    session: session,
    follow: follow,
    unfollow: unfollow,
    saveSearch: saveSearch,
    listSavedSearches: listSavedSearches,
    deleteSavedSearch: deleteSavedSearch,
    listFollows: listFollows,
    toast: toast,
  };
})();
