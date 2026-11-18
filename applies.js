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
  }

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

  window.VTApplies = { record: record };
})();
