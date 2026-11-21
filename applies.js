// Remembers which jobs a signed-in candidate clicked Apply on (candidate_applications), so the
// dashboard can ask "Any news?" later and the check-in email can follow up (job-checkins).
//
// Every Apply button on the site already sends a GA4 "apply_click" event (job pages, paid
// postings, and the "Continue to your application" button after sign-up or sign-in). Rather
// than touching each of those, this wraps gtag and records the same click to the candidate's
// account. Signed out = nothing recorded. Never blocks or delays the click itself.
//
// Loaded by alerts.js on job pages, and directly on employer-job.html, login.html and
// create-profile.html.
(function () {
  "use strict";
  if (window.VTApplies) return;
  var SUPABASE_URL = "https://iqcyofkosjopxsfdufvy.supabase.co";
  var ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";

  function readSession() {
    try { return JSON.parse(localStorage.getItem("vt_session") || "null"); } catch (e) { return null; }
  }
  // Same storage and refresh as dashboard.html / alerts.js.
  async function session() {
    var s = readSession();
    if (!s || !s.refresh_token || !s.candidate_id) return null;
    if (s.expires_at && s.expires_at > Date.now() + 60000) return s;
    try {
      var res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
      if (!res.ok) return null;
      var d = await res.json();
      s.access_token = d.access_token;
      s.refresh_token = d.refresh_token;
      s.expires_at = Date.now() + (d.expires_in || 3600) * 1000;
      try { localStorage.setItem("vt_session", JSON.stringify(s)); } catch (e) {}
      return s;
    } catch (e) {
      return null;
    }
  }

  function clip(v, n) { v = v == null ? "" : String(v).trim(); return v ? v.slice(0, n) : null; }

  // What the click was for. Job pages carry the employer URL on #applyBtn; paid postings that
  // take applications on Verde Talent have no URL, so they're keyed by posting id.
  function describe(params) {
    var btn = document.getElementById("applyBtn");
    var url = params.job_url || (btn && btn.dataset && btn.dataset.url) || null;
    var postingId = /employer-job\.html/.test(location.pathname) ? new URLSearchParams(location.search).get("id") : null;
    var key = url || (postingId ? "posting:" + postingId : null);
    if (!key) return null;
    var page = null;
    if (/^\/jobs\/[^/]+\.html$/.test(location.pathname)) page = location.pathname;
    else if (postingId) page = "/employer-job.html?id=" + encodeURIComponent(postingId);
    return {
      job_key: clip(key, 2000),
      job_url: clip(url, 2000),
      job_page: clip(page, 300),
      job_title: clip(params.job_title, 300),
      company: clip(params.company, 200),
      location: clip(params.job_location, 200),
      apply_path: clip(params.apply_method === "verde_profile" ? "verde_profile" : params.apply_path, 40),
    };
  }

  async function record(params) {
    var row = describe(params || {});
    if (!row) return;
    var s = await session();
    if (!s) return;
    row.candidate_id = s.candidate_id;
    try {
      await fetch(SUPABASE_URL + "/rest/v1/candidate_applications?on_conflict=candidate_id,job_key", {
        method: "POST",
        keepalive: true,
        headers: {
          apikey: ANON_KEY,
          Authorization: "Bearer " + s.access_token,
          "Content-Type": "application/json",
          // Clicking Apply on the same job again keeps the first row (and its answer).
          Prefer: "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify(row),
      });
    } catch (e) {}
    // An Apply click that went to the employer's own site is only "Started" (the database sets
    // that - 019_applications_started.sql) until the candidate says they finished.
    if ((params || {}).apply_method !== "verde_profile") rememberPending(row);
  }

  // --- "Did you finish applying?" ---------------------------------------------------------------
  // Asked with a small bar at the bottom of the page, never during the application: Apply opens
  // the employer's site in a new tab, and the bar only appears once they come back to this one
  // (after at least ASK_AFTER_MS - a quick peek isn't an attempt). Nothing blocks or dims the
  // page, it slides away on its own, and ignoring it just leaves the job under "To finish" in
  // their tracker. At most one bar per visit, about the latest click only; anyone who closes it
  // twice is never shown it again (their tracker still asks).
  var ASK_AFTER_MS = 20000;
  var AUTO_HIDE_MS = 15000;
  var K_PENDING = "vt_apply_pending";      // sessionStorage: the latest unanswered click
  var K_ASKED = "vt_apply_asked";          // sessionStorage: a bar was shown this visit
  var K_CLOSED = "vt_apply_bar_closed";    // localStorage: how many times they closed it
  var K_ANSWERED = "vt_apply_answered";    // localStorage: job keys already answered
  function lsGet(k, d) { try { return JSON.parse(localStorage.getItem(k) || "null") || d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function track(name, p) { try { if (typeof gtag === "function") gtag("event", name, p || {}); } catch (e) {} }

  function rememberPending(row) {
    if (lsGet(K_ANSWERED, []).indexOf(row.job_key) >= 0) return;
    try {
      sessionStorage.setItem(K_PENDING, JSON.stringify({
        job_key: row.job_key, job_title: row.job_title, company: row.company, at: Date.now(),
      }));
    } catch (e) {}
  }
  function pending() { try { return JSON.parse(sessionStorage.getItem(K_PENDING) || "null"); } catch (e) { return null; } }

  async function answer(p, status) {
    var s = await session();
    if (!s) return false;
    try {
      var res = await fetch(SUPABASE_URL + "/rest/v1/candidate_applications?candidate_id=eq." + encodeURIComponent(s.candidate_id) +
        "&job_key=eq." + encodeURIComponent(p.job_key), {
        method: "PATCH",
        headers: { apikey: ANON_KEY, Authorization: "Bearer " + s.access_token, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ status: status, status_at: new Date().toISOString() }),
      });
      return res.ok;
    } catch (e) { return false; }
  }

  var CSS =
    ".vt-fin{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translate(-50%,140%);z-index:900;" +
    "display:flex;align-items:center;gap:10px;flex-wrap:wrap;max-width:min(560px,calc(100vw - 32px));box-sizing:border-box;" +
    "background:#141a17;border:0.5px solid rgba(34,224,154,0.45);border-radius:14px;padding:10px 12px 10px 16px;" +
    "box-shadow:0 10px 30px rgba(0,0,0,0.45);font:13.5px/1.4 Inter,system-ui,sans-serif;color:#fff;transition:transform .35s ease;}" +
    ".vt-fin.on{transform:translate(-50%,0);}" +
    ".vt-fin-q{flex:1 1 220px;min-width:0;}.vt-fin-q b{font-weight:600;}" +
    ".vt-fin-b{display:flex;gap:6px;align-items:center;}" +
    ".vt-fin button{font:inherit;font-size:13px;font-weight:600;border-radius:999px;padding:6px 14px;cursor:pointer;border:0.5px solid rgba(255,255,255,0.25);background:transparent;color:#fff;}" +
    ".vt-fin button.yes{background:#22E09A;border-color:#22E09A;color:#052e1e;}" +
    ".vt-fin button.x{border:0;padding:6px 8px;color:rgba(255,255,255,0.5);font-size:15px;line-height:1;}" +
    ".vt-fin button:hover{filter:brightness(1.1);}" +
    ".vt-fin button{white-space:nowrap;}" +
    // Phones: full width along the bottom edge.
    "@media (max-width:560px){.vt-fin{left:12px;right:12px;max-width:none;transform:translateY(160%);bottom:calc(12px + env(safe-area-inset-bottom,0px));}" +
    ".vt-fin.on{transform:translateY(0);}}";

  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showBar(p) {
    try { sessionStorage.setItem(K_ASKED, "1"); sessionStorage.removeItem(K_PENDING); } catch (e) {}
    if (!document.getElementById("vt-fin-css")) {
      var st = document.createElement("style");
      st.id = "vt-fin-css";
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var bar = document.createElement("div");
    bar.className = "vt-fin";
    bar.setAttribute("role", "status");
    var what = p.company ? "to <b>" + esc(p.company) + "</b>" : (p.job_title ? "for <b>" + esc(p.job_title) + "</b>" : "");
    bar.innerHTML = '<div class="vt-fin-q">Did you finish applying ' + what + "?</div>" +
      '<div class="vt-fin-b"><button type="button" class="yes" data-a="applied">Yes</button>' +
      '<button type="button" data-a="later">Not yet</button>' +
      '<button type="button" class="x" data-a="close" aria-label="Close - don\'t ask about this job">&#10005;</button></div>';
    document.body.appendChild(bar);
    requestAnimationFrame(function () { requestAnimationFrame(function () { bar.classList.add("on"); }); });
    var timer = setTimeout(function () { hide(); track("apply_finish_bar", { answer: "ignored" }); }, AUTO_HIDE_MS);
    function hide(msg) {
      clearTimeout(timer);
      if (msg) {
        bar.innerHTML = '<div class="vt-fin-q">' + msg + "</div>";
        setTimeout(function () { bar.classList.remove("on"); }, 2200);
      } else {
        bar.classList.remove("on");
      }
      setTimeout(function () { bar.remove(); }, 3000);
    }
    bar.addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-a]");
      if (!b) return;
      var a = b.getAttribute("data-a");
      track("apply_finish_bar", { answer: a });
      var answered = lsGet(K_ANSWERED, []);
      answered.push(p.job_key);
      lsSet(K_ANSWERED, answered.slice(-200));
      if (a === "close") {
        lsSet(K_CLOSED, lsGet(K_CLOSED, 0) + 1);
        hide();
      } else if (a === "later") {
        hide("No problem &mdash; it&rsquo;s under <b>To finish</b> in your tracker.");
      } else {
        clearTimeout(timer);
        var ok = await answer(p, "applied");
        hide(ok ? "Nice &mdash; added to your applications. Good luck!" : "Couldn&rsquo;t save that &mdash; you can mark it in your tracker.");
      }
    });
  }

  function maybeAsk() {
    if (document.visibilityState !== "visible") return;
    var p = pending();
    if (!p || Date.now() - p.at < ASK_AFTER_MS) return;
    try { if (sessionStorage.getItem(K_ASKED)) return; } catch (e) {}
    if (lsGet(K_CLOSED, 0) >= 2) return;
    if (!readSession()) return;
    showBar(p);
  }
  document.addEventListener("visibilitychange", maybeAsk);
  window.addEventListener("focus", maybeAsk);

  function wrap() {
    var original = window.gtag;
    if (typeof original !== "function" || original.__vtApplies) return;
    var wrapped = function () {
      var r = original.apply(this, arguments);
      try {
        if (arguments[0] === "event" && arguments[1] === "apply_click") record(arguments[2]);
      } catch (e) {}
      return r;
    };
    wrapped.__vtApplies = true;
    window.gtag = wrapped;
  }
  wrap();

  window.VTApplies = { record: record, _showBar: showBar };
})();
