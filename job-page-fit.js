// Job pages (/jobs/<slug>.html): how well this job fits the signed-in candidate (job-fit.js, the
// same rules as the job search's match labels) and a link to typical pay for roles like it. Signed
// out, the same spot asks for a resume instead - matches and pay are what a profile unlocks.
// The job's own fields come from the page (<script id="vt-job">); only the visitor's profile is
// fetched, never the full job list. Pages call gtag only (never FullStory directly).
(function () {
  "use strict";
  var CSS =
    ".jp-fit{margin:1.1rem 0 -.4rem;}" +
    ".jp-fit[hidden]{display:none;}" +
    ".jp-why{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 10px;border-radius:10px;}" +
    ".jp-why.strong{background:rgba(34,224,154,0.07);border:0.5px solid rgba(34,224,154,0.35);}" +
    ".jp-why.good{background:rgba(79,179,255,0.07);border:0.5px solid rgba(79,179,255,0.35);}" +
    ".jp-fit-label{font-size:12px;font-weight:700;border-radius:999px;padding:3px 10px;color:#052e1e;}" +
    ".jp-why.strong .jp-fit-label{background:var(--grn,#22E09A);}" +
    ".jp-why.good .jp-fit-label{background:var(--blu,#4FB3FF);color:#04223a;}" +
    ".jp-chip{font-size:12.5px;color:var(--t1,#fff);background:rgba(255,255,255,0.06);border-radius:6px;padding:2px 8px;}" +
    ".jp-chip b{color:var(--grn,#22E09A);margin-right:4px;}" +
    ".jp-why.good .jp-chip b{color:var(--blu,#4FB3FF);}" +
    ".jp-pay{display:inline-block;margin-top:8px;font-size:13px;color:var(--grn,#22E09A);text-decoration:none;}" +
    ".jp-pay:hover{text-decoration:underline;}" +
    ".jp-ask{display:flex;align-items:center;gap:16px;background:linear-gradient(135deg,rgba(34,224,154,0.07),rgba(79,179,255,0.04));border:0.5px solid rgba(34,224,154,0.35);border-radius:14px;padding:14px 16px;}" +
    ".jp-ask-gauge{flex:0 0 130px;}.jp-ask-gauge .vtg{max-width:130px;}" +
    ".jp-ask-body{flex:1;min-width:0;}" +
    ".jp-ask-t{font-size:15px;font-weight:700;color:var(--t1,#fff);margin-bottom:8px;}" +
    ".jp-ask-eg{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px;}" +
    ".jp-eg-fit{font-size:11px;font-weight:700;border-radius:999px;padding:2px 9px;background:var(--grn,#22E09A);color:#052e1e;}" +
    ".jp-eg-chip{font-size:11.5px;color:var(--t1,#fff);background:rgba(255,255,255,0.06);border-radius:6px;padding:1px 7px;}" +
    ".jp-eg-chip b{color:var(--grn,#22E09A);margin-right:4px;}" +
    ".jp-eg-pay{font-size:11.5px;color:var(--t1,#fff);background:rgba(34,224,154,0.1);border:0.5px solid rgba(34,224,154,0.35);border-radius:6px;padding:1px 8px;}" +
    ".jp-eg-blur{filter:blur(4px);user-select:none;}" +
    ".jp-ask-meter{display:flex;align-items:center;gap:10px;margin-bottom:4px;}" +
    ".jp-ask-bars{display:inline-flex;align-items:flex-end;gap:3px;height:20px;filter:blur(2.5px);}" +
    ".jp-ask-bars i{display:block;width:7px;border-radius:2px;background:var(--grn,#22E09A);}" +
    ".jp-ask-bars i:nth-child(1){height:8px;}.jp-ask-bars i:nth-child(2){height:11px;}.jp-ask-bars i:nth-child(3){height:14px;}" +
    ".jp-ask-bars i:nth-child(4){height:17px;opacity:.35;}.jp-ask-bars i:nth-child(5){height:20px;opacity:.35;}" +
    ".jp-ask-pill{font-size:12px;font-weight:700;border-radius:999px;padding:3px 10px;background:var(--grn,#22E09A);color:#052e1e;filter:blur(4px);user-select:none;}" +
    ".jp-ask-lock{font-size:12px;color:var(--t2,rgba(255,255,255,.6));display:inline-flex;align-items:center;gap:4px;}" +
    ".jp-ask-lock i{font-size:13px;}" +
    ".jp-ask-sub{font-size:12px;color:var(--t3,rgba(255,255,255,.35));margin-bottom:10px;}" +
    ".jp-ask-pay{font-size:13px;color:var(--t2,rgba(255,255,255,.6));margin-bottom:12px;}" +
    ".jp-ask-pay b{color:var(--t1,#fff);font-weight:600;}" +
    ".jp-ask-blur{filter:blur(5px);user-select:none;color:var(--grn,#22E09A);font-weight:700;}" +
    ".jp-ask-cta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}" +
    ".jp-ask-cta a{border:1.5px solid var(--grn,#22E09A);color:var(--grn,#22E09A);background:transparent;font-weight:700;font-size:13.5px;border-radius:999px;padding:8px 16px;text-decoration:none;white-space:nowrap;}" +
    ".jp-ask-cta a:hover{background:rgba(34,224,154,0.1);}" +
    ".jp-ask-cta span{font-size:12px;color:var(--t3,rgba(255,255,255,.35));}" +
    "@media (max-width:560px){.jp-ask{flex-direction:column;align-items:stretch;}.jp-ask-gauge{margin:0 auto;}}" +
    // What's missing + how to get there (job-fit.js gaps()).
    ".jp-gaps{margin-top:8px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.025);border:0.5px dashed rgba(255,255,255,0.18);}" +
    ".jp-gaps-h{font-size:12.5px;font-weight:700;color:var(--t1,#fff);margin-bottom:6px;}" +
    ".jp-gap{display:flex;gap:8px;align-items:flex-start;padding:5px 0;font-size:13px;line-height:1.45;color:var(--t2,rgba(255,255,255,.7));}" +
    ".jp-gap+.jp-gap{border-top:0.5px solid rgba(255,255,255,0.06);}" +
    ".jp-gap-dot{flex:0 0 auto;width:7px;height:7px;margin-top:6px;border-radius:50%;border:1.5px solid var(--amb,#FFB547);}" +
    ".jp-gap-fixes{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px;}" +
    ".jp-gap-fixes a{font-size:12px;font-weight:600;color:var(--grn,#22E09A);text-decoration:none;border:0.5px solid rgba(34,224,154,0.35);border-radius:999px;padding:2px 10px;}" +
    ".jp-gap-fixes a:hover{background:rgba(34,224,154,0.1);}" +
    ".jp-gap-fixes a.train{color:var(--amb,#FFB547);border-color:rgba(255,181,71,0.4);}" +
    ".jp-gap-fixes a.train:hover{background:rgba(255,181,71,0.1);}";

  // The gaps box under the match strip: each thing that's missing, with what to do about it.
  function gapsHtml(title, rows) {
    if (!rows.length) return "";
    return '<div class="jp-gaps"><div class="jp-gaps-h">' + esc(title) + "</div>" +
      rows.map(function (g) {
        return '<div class="jp-gap" data-kind="' + esc(g.kind) + '"><span class="jp-gap-dot"></span><div>' + esc(g.text) +
          (g.fixes.length ? '<div class="jp-gap-fixes">' + g.fixes.map(function (f) {
            var train = f.href.indexOf("/professional-development") === 0;
            return '<a href="' + esc(f.href) + '"' + (train ? ' class="train"' : "") + " data-jp-fix=\"" + esc(g.kind) + "\">" + esc(f.label) + " &rarr;</a>";
          }).join("") + "</div>" : "") +
          "</div></div>";
      }).join("") + "</div>";
  }

  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function track(name, params) { try { if (typeof gtag === "function") gtag("event", name, params || {}); } catch (e) {} }
  function signedIn() {
    try { var s = JSON.parse(localStorage.getItem("vt_session") || "null"); return !!(s && s.candidate_id); } catch (e) { return false; }
  }

  // A note under the job's details, for everyone, only when the job is behind: "Last confirmed
  // open on <company>'s careers site 3 days ago", amber after a week.
  // The date is the company's last clean crawl (/data/job_checked.json, rebuilt nightly) -
  // the pages themselves are static, and a per-job date would rewrite all of them every night.
  var FRESH_CSS =
    ".jp-fresh{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--t3,rgba(255,255,255,.45));margin:-.6rem 0 1rem;}" +
    ".jp-fresh.ok{color:var(--grn,#22E09A);}.jp-fresh.old{color:var(--amb,#FFB547);}";
  function freshLine(job) {
    var meta = document.querySelector(".meta-row");
    if (!meta || !job.company) return;
    fetch("/data/job_checked.json").then(function (r) { return r.ok ? r.json() : null; }).then(function (map) {
      var day = map && map[job.company];
      if (!day) return;
      var t = new Date();
      var d = Math.max(0, Math.round((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - Date.parse(day + "T00:00:00Z")) / 86400000));
      // A healthy crawl re-confirms every job daily, so there's nothing to say until one is behind.
      if (d <= 1) return;
      var site = esc(job.company) + "&rsquo;s careers site";
      var cls = d >= 7 ? "old" : "";
      var text = d < 7 ? "Last confirmed open on " + site + " " + d + " days ago"
        : "We haven&rsquo;t been able to recheck this on " + site + " for " + d + " days &mdash; it may have been filled";
      var st = document.createElement("style");
      st.textContent = FRESH_CSS;
      document.head.appendChild(st);
      var el = document.createElement("div");
      el.className = "jp-fresh " + cls;
      el.innerHTML = text;
      meta.insertAdjacentElement("afterend", el);
      track("job_page_fresh_shown", { days: d });
    }).catch(function () {});
  }

  async function run() {
    var box = document.getElementById("jpFit");
    var dataEl = document.getElementById("vt-job");
    if (!box || !dataEl) return;
    var job;
    try { job = JSON.parse(dataEl.textContent); } catch (e) { return; }
    freshLine(job);
    if (!window.VTJobFit) return;
    var st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);

    if (!signedIn()) {
      // The same pieces as the job search and salary check: the padlock pay gauge (no real figures),
      // the five things a match checks, a blurred pay range, and an outlined button so it never
      // reads as the solid Apply button below.
      var st0 = window.VTJobFit.stateOf(job.location);
      var gauge = window.VTPay && window.VTPay.gauge
        ? window.VTPay.gauge({ min: 0, max: 100, lo: 30, hi: 68, mid: 52, fmt: function () { return ""; }, unit: "", locked: true })
        : "";
      var lock = '<i class="ti ti-lock"></i>';
      box.innerHTML =
        '<div class="jp-ask">' +
          (gauge ? '<div class="jp-ask-gauge" aria-hidden="true">' + gauge + "</div>" : "") +
          '<div class="jp-ask-body">' +
            '<div class="jp-ask-t">See your match and pay range for this job</div>' +
            // The same example strip as the job search banner ("See which jobs match you...").
            '<div class="jp-ask-eg" aria-hidden="true"><span class="jp-eg-fit">Strong match</span>' +
              '<span class="jp-eg-chip"><b>&#10003;</b>Your role</span>' +
              '<span class="jp-eg-chip"><b>&#10003;</b>' + esc((window.VTJobFit.list(job.sector_buckets)[0]) || "Your sector") + "</span>" +
              '<span class="jp-eg-chip"><b>&#10003;</b>Near you</span><span class="jp-eg-chip"><b>&#10003;</b>Experience level</span>' +
              '<span class="jp-eg-pay">Your pay range: <span class="jp-eg-blur">$00 &ndash; $00</span></span></div>' +
            '<div class="jp-ask-cta"><a href="/create-profile.html?src=job-page-fit" data-jp-ask>Unlock free with your resume &rarr;</a>' +
              "<span>Profile built in less than a minute</span></div>" +
          "</div>" +
        "</div>";
      box.hidden = false;
      box.querySelector("[data-jp-ask]").addEventListener("click", function () { track("job_page_fit_ask_click", {}); });
      return;
    }

    var profile = await window.VTJobFit.loadProfile();
    if (!profile || !profile.hasRole) return;
    var fit = window.VTJobFit.score(job, profile);
    var state = window.VTJobFit.stateOf(job.location);
    // The role alone for the salary check: "Wind Technician I (All Levels) at Roadrunner Wind in
    // Cisco, TX" -> "Wind Technician I".
    var role = String(job.job_title || "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
      .split(/\s+(?:at|in|@)\s+|\s+[-–—|]\s+|,\s*/)[0].replace(/\s+/g, " ").trim() || job.job_title || "";
    var payUrl = "/salary-check.html?role=" + encodeURIComponent(role) + (state ? "&state=" + state : "");
    var payLink = '<a class="jp-pay" href="' + esc(payUrl) + '" data-jp-pay>Typical pay for roles like this' + (state ? " in " + esc(state) : "") + " &rarr;</a>";
    var gaps = window.VTJobFit.gaps ? window.VTJobFit.gaps(job, profile) : [];
    if (!fit) {
      // Not a match: say why, and what would change that - the kind of work first (nothing else
      // matters if the role is different), else the gaps that kept it from a label.
      var miss = window.VTJobFit.roleMiss ? window.VTJobFit.roleMiss(job, profile) : null;
      var rows = miss
        ? [{ kind: "role", text: miss.jobCategory && miss.yourCategory && miss.jobCategory !== miss.yourCategory
              ? "This is " + (/^[AEIOU]/.test(miss.jobCategory) ? "an " : "a ") + miss.jobCategory + " role; the experience on your profile is in " + miss.yourCategory + "."
              : "None of the job titles on your profile line up with this one.",
            fixes: [{ label: "Done this kind of work? Add it to your experience", href: "/dashboard.html#experience" }] }]
        : gaps;
      box.innerHTML = gapsHtml("Not a match for your profile yet", rows) + payLink;
    } else {
      box.innerHTML =
        '<div class="jp-why ' + fit.level + '"><span class="jp-fit-label">' + (fit.level === "strong" ? "Strong match" : "Good match") + "</span>" +
        fit.reasons.map(function (r) { return '<span class="jp-chip"><b>&#10003;</b>' + esc(r) + "</span>"; }).join("") + "</div>" +
        gapsHtml(
          // Only sector, location and level decide Strong vs Good - skills and pay never do - so
          // "To get a Strong match" only when one of those is on the list.
          fit.level === "good" && gaps.some(function (g) { return g.kind === "sector" || g.kind === "place" || g.kind === "level"; })
            ? "To get a Strong match" : "To stand out for this one", gaps) + payLink;
    }
    box.hidden = false;
    track("job_page_fit_shown", { level: fit ? fit.level : "none", gaps: gaps.length });
    var pl = box.querySelector("[data-jp-pay]");
    if (pl) pl.addEventListener("click", function () { track("job_page_pay_click", {}); });
    Array.prototype.forEach.call(box.querySelectorAll("[data-jp-fix]"), function (a) {
      a.addEventListener("click", function () {
        track("job_fit_gap_click", { kind: a.getAttribute("data-jp-fix"), training: a.classList.contains("train") });
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
