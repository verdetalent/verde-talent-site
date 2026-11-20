// "What am I worth?" (salary-check.html): a person's pay against advertised pay for the same kind
// of role, in their state and at their level, from the live listings jobs.html already loads.
//
// Same rules as the salary pages (renewable-energy-jobs/export_salary_pages_to_verde_talent.py):
// annual figure = the bottom of the advertised range (hourly x 2,080), sane values only, and no
// figure at all below 8 postings / 3 employers or when one employer is more than 60% of them.
// Role matching is job-fit.js's (the job alerts' rules). Runs entirely in the browser; on screen
// only - no download, nothing sent anywhere. Pages call gtag only (never FullStory directly).
(function () {
  "use strict";
  var MIN_POSTINGS = 8, MIN_EMPLOYERS = 3, DOMINANCE = 0.6;
  var SANE_MIN = 15000, SANE_MAX = 1000000;
  var STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
  // Which job levels count as "your level" for each experience bucket.
  var LEVELS = {
    "Less than 1 year": ["Entry Level"],
    "1–3 years": ["Entry Level", "Individual Contributor"],
    "3–5 years": ["Individual Contributor"],
    "5–10 years": ["Individual Contributor", "Manager+"],
    "10+ years": ["Individual Contributor", "Manager+", "Director+"],
  };
  var SUGGESTIONS = ["Wind turbine technician", "Solar installer", "Solar O&M technician", "Electrician", "Lineman",
    "Substation technician", "Field service technician", "Electrical engineer", "Civil engineer", "Mechanical engineer",
    "Battery storage engineer", "Interconnection engineer", "Project manager", "Construction manager", "Superintendent",
    "Project developer", "Business development manager", "Sales representative", "Financial analyst", "Accountant",
    "Supply chain manager", "Buyer", "Safety manager", "HR generalist", "Software engineer", "Data analyst"];

  // A sector named in the title ("Wind technician") narrows the comparison first - the role rules
  // ignore sector words, which is right for alerts but too loose for pay.
  var SECTOR_WORDS = [[/\bwind\b/, "Wind"], [/\bsolar\b|\bpv\b/, "Solar"], [/\bbattery\b|\bstorage\b|\bbess\b/, "Storage"],
    [/\bgrid\b|\bsubstation\b|\btransmission\b|\bdistribution\b|\butility\b/, "Grid"], [/\bev\b|\bcharging\b/, "EV"],
    [/\bhydrogen\b|\belectroly/, "Hydrogen"], [/\bgeothermal\b/, "Geothermal"]];
  function titleSector(title) {
    var t = String(title || "").toLowerCase();
    for (var i = 0; i < SECTOR_WORDS.length; i++) if (SECTOR_WORDS[i][0].test(t)) return SECTOR_WORDS[i][1];
    return null;
  }

  var JOBS = null;
  var $ = function (id) { return document.getElementById(id); };
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(n) { return "$" + (Math.round(n / 100) * 100).toLocaleString("en-US"); }
  function pct(sorted, p) { return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)]; }
  function median(sorted) {
    var n = sorted.length;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }
  function track(name, params) { try { if (typeof gtag === "function") gtag("event", name, params || {}); } catch (e) {} }

  // Half-circle "gas gauge": the whole arc is the 10th-90th percentile of advertised pay, the green
  // stretch the middle half, a tick at the median and, when given, a needle for their own pay.
  // Colours come from the page's CSS (.vtg-*). Returns an SVG string.
  function gauge(o) {
    var W = 260, cx = 130, cy = 128, r = 104, sw = 20;
    var span = Math.max(o.max - o.min, 1);
    var t = function (v) { return Math.max(0, Math.min(1, (v - o.min) / span)); };
    var pt = function (tt, rr) { var a = Math.PI * tt; return [cx - rr * Math.cos(a), cy - rr * Math.sin(a)]; };
    var f = function (n) { return n.toFixed(1); };
    var arc = function (t1, t2) {
      var a = pt(t1, r), b = pt(t2, r);
      return "M" + f(a[0]) + " " + f(a[1]) + " A" + r + " " + r + " 0 0 1 " + f(b[0]) + " " + f(b[1]);
    };
    var lo = t(o.lo), hi = t(o.hi), md = t(o.mid);
    // Median: a tick across the arc (no word on the arc - it ran into the range text when the
    // median sat near either end). The dial's readout names it at the bottom; elsewhere the text
    // beside the dial does.
    var m1 = pt(md, r - sw / 2 - 2), m2 = pt(md, r + sw / 2 + 7);
    var svg = '<svg class="vtg" viewBox="0 0 ' + W + ' 152" role="img" aria-label="' + esc(o.label || "") + '">' +
      '<path class="vtg-track" d="' + arc(0, 1) + '" stroke-width="' + sw + '" fill="none" stroke-linecap="round"/>' +
      '<path class="vtg-band" d="' + arc(lo, Math.max(hi, lo + 0.01)) + '" stroke-width="' + sw + '" fill="none" stroke-linecap="round"/>' +
      '<line class="vtg-med" x1="' + f(m1[0]) + '" y1="' + f(m1[1]) + '" x2="' + f(m2[0]) + '" y2="' + f(m2[1]) + '" stroke-width="3" stroke-linecap="round"/>';
    if (o.you) {
      var ty = t(o.you), tip = pt(ty, r - sw / 2 - 4), lab = pt(ty, r + sw / 2 + 16);
      svg += '<line class="vtg-needle" x1="' + cx + '" y1="' + cy + '" x2="' + f(tip[0]) + '" y2="' + f(tip[1]) + '" stroke-width="3.5" stroke-linecap="round"/>' +
        '<circle class="vtg-hub" cx="' + cx + '" cy="' + cy + '" r="7"/>' +
        '<text class="vtg-you" x="' + f(lab[0]) + '" y="' + f(lab[1] + 4) + '" text-anchor="middle">You</text>';
    }
    // Locked (signed out): the dial is drawn sharp so it reads as a pay gauge, but with a made-up
    // band, no figures at all and a padlock in the middle - nothing in it is real data.
    if (o.locked) {
      var lx = cx, ly = cy - 30;
      return svg +
        '<path class="vtg-lock" d="M' + (lx - 8) + " " + (ly - 2) + " v-7 a8 8 0 0 1 16 0 v7" + '" fill="none" stroke-width="3.2" stroke-linecap="round"/>' +
        '<rect class="vtg-lockb" x="' + (lx - 13) + '" y="' + (ly - 2) + '" width="26" height="20" rx="4"/>' +
        '<text class="vtg-small" x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle">' + esc(o.unit || "") + "</text>" +
        "</svg>";
    }
    // With a needle the figures sit beside the dial (they'd collide inside it); without one the
    // range is the dial's readout.
    var readout = !o.you && o.readout !== false;
    if (readout) {
      var range = o.fmt(o.lo) + " – " + o.fmt(o.hi);
      // About 0.6em a character in bold digits; keep the line inside the dial's inner edge (~170 wide).
      var size = Math.min(18, Math.floor(170 / (range.length * 0.6)));
      svg += '<text class="vtg-big" x="' + cx + '" y="' + (cy - 26) + '" text-anchor="middle" style="font-size:' + size + 'px">' + esc(range) + "</text>" +
        '<text class="vtg-small" x="' + cx + '" y="' + (cy - 7) + '" text-anchor="middle">' + esc(o.unit || "") + "</text>" +
        '<text class="vtg-medl" x="' + cx + '" y="' + (cy + 22) + '" text-anchor="middle">median ' + esc(o.fmt(o.mid)) + "</text>";
    } else if (o.readout === false) {
      // Compact dial (readout: false - the job search strip, drawn ~150px wide with the figures in
      // text beside it): no unit, and the two end figures drawn large enough to read at that size,
      // pinned to the outer edges so they never meet.
      return svg.replace(' 152" role', ' 160" role') +
        '<text class="vtg-end vtg-end-lg" x="' + (cx - r - sw / 2) + '" y="' + (cy + 29) + '" text-anchor="start">' + esc(o.fmt(o.min)) + "</text>" +
        '<text class="vtg-end vtg-end-lg" x="' + (cx + r + sw / 2) + '" y="' + (cy + 29) + '" text-anchor="end">' + esc(o.fmt(o.max)) + "</text>" +
        "</svg>";
    } else {
      svg += '<text class="vtg-small" x="' + cx + '" y="' + (cy + 22) + '" text-anchor="middle">' + esc(o.unit || "") + "</text>";
    }
    svg +=
      '<text class="vtg-end" x="' + (cx - r) + '" y="' + (cy + 22) + '" text-anchor="middle">' + esc(o.fmt(o.min)) + "</text>" +
      '<text class="vtg-end" x="' + (cx + r) + '" y="' + (cy + 22) + '" text-anchor="middle">' + esc(o.fmt(o.max)) + "</text>" +
      "</svg>";
    return svg;
  }
  // The CSS the gauge needs, for pages that don't carry it.
  var GAUGE_CSS = ".vtg{width:100%;max-width:300px;height:auto;display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-variant-numeric:tabular-nums;}" +
    ".vtg text{font-family:inherit;}" +
    ".vtg-track{stroke:rgba(255,255,255,0.09);}.vtg-band{stroke:var(--grn,#22E09A);}" +
    ".vtg-med{stroke:#fff;}.vtg-lock{stroke:var(--t1,#fff);}.vtg-lockb{fill:var(--t1,#fff);}.vtg-medl{fill:var(--t2,rgba(255,255,255,.6));font-size:11px;font-weight:600;font-family:inherit;}.vtg-needle{stroke:#fff;}.vtg-hub{fill:#fff;}" +
    ".vtg-you{fill:#fff;font-size:12px;font-weight:700;font-family:inherit;}" +
    ".vtg-big{fill:var(--t1,#fff);font-weight:700;font-family:inherit;letter-spacing:0;}" +
    ".vtg-small{fill:var(--t2,rgba(255,255,255,.6));font-size:11.5px;font-family:inherit;}" +
    ".vtg-end{fill:var(--t3,rgba(255,255,255,.35));font-size:10.5px;font-family:inherit;}" +
    ".sc-ask input{border-color:var(--grn,#22E09A)!important;box-shadow:0 0 0 3px rgba(34,224,154,.18);}" +
    ".sc-ask-hint{font-size:12px;color:var(--grn,#22E09A);margin-top:6px;}" +
    ".vtg-end.vtg-end-lg{font-size:20px;font-weight:600;fill:var(--t2,rgba(255,255,255,.6));}";
  (function () {
    if (document.getElementById("vtg-css")) return;
    var st = document.createElement("style");
    st.id = "vtg-css";
    st.textContent = GAUGE_CSS;
    (document.head || document.documentElement).appendChild(st);
  })();

  function isSignedIn() {
    try { var s = JSON.parse(localStorage.getItem("vt_session") || "null"); return !!(s && s.candidate_id); } catch (e) { return false; }
  }

  function annualMin(j) {
    if (typeof j.salary_min !== "number") return null;
    var v = j.salary_period === "hour" ? j.salary_min * 2080 : j.salary_min;
    return v >= SANE_MIN && v <= SANE_MAX ? v : null;
  }

  // The listings jobs.html uses -> salaried US postings. Shared with the dashboard (VTPay).
  function prepare(all) {
    JOBS = all.filter(function (j) { return j.region === "US"; }).map(function (j) {
      return { job: j, pay: annualMin(j), state: window.VTJobFit.stateOf(j.location) };
    }).filter(function (r) { return r.pay !== null; });
    return JOBS;
  }
  // Pay band for a comparison: null when there isn't one.
  function summary(res) {
    if (!res || !res.rows) return null;
    var vals = res.rows.map(function (r) { return r.pay; }).sort(function (a, b) { return a - b; });
    return { n: vals.length, lo: pct(vals, 0.25), mid: median(vals), hi: pct(vals, 0.75), p10: pct(vals, 0.1), p90: pct(vals, 0.9),
             state: res.tier.st, level: !!res.tier.lv, hourlyShare: res.rows.filter(function (r) { return r.job.salary_period === "hour"; }).length / vals.length };
  }

  async function load() {
    var res = await fetch("/data/jobs_list.json");
    if (!res.ok) throw new Error("load");
    prepare(await res.json());
    var seen = {};
    JOBS.forEach(function (r) { if (r.state && STATES[r.state]) seen[r.state] = true; });
    var sel = $("scState");
    Object.keys(seen).sort(function (a, b) { return STATES[a].localeCompare(STATES[b]); }).forEach(function (s) {
      var o = document.createElement("option");
      o.value = s; o.textContent = STATES[s];
      sel.appendChild(o);
    });
  }

  function enough(rows) {
    if (rows.length < MIN_POSTINGS) return false;
    var by = {};
    rows.forEach(function (r) { var c = (r.job.company || "").toLowerCase(); by[c] = (by[c] || 0) + 1; });
    var names = Object.keys(by);
    if (names.length < MIN_EMPLOYERS) return false;
    var top = Math.max.apply(null, names.map(function (n) { return by[n]; }));
    return top / rows.length <= DOMINANCE;
  }

  // Narrowest comparison that has enough postings: state + level, then state, then the whole US.
  // Within each, roles sharing a word with their title first, then the same role type.
  function compare(title, state, years) {
    var F = window.VTJobFit;
    var role = F.roleFromTitle(title);
    if (!role.category && !role.words.size) return { error: "Type a job title, for example \"Wind technician\"." };
    var levels = years && LEVELS[years];
    var sector = titleSector(title);
    // How close the match must be: 3 = shares a title word + same sector, 2 = shares a word,
    // 1 = same role type. Tried in turn within each place/level before widening those.
    // Role type alone (1) is only used when the title has no specific words: "Construction/Field"
    // spans laborers to directors, which says nothing about one person's pay.
    var closeness = (sector ? [3] : []).concat(role.words.size ? [2] : [1]);
    var tiers = [];
    [state || null, null].forEach(function (st, i) {
      if (i === 0 && !state) return;
      [levels || null, null].forEach(function (lv, k) {
        if (k === 0 && !levels) return;
        closeness.forEach(function (c) { tiers.push({ st: st, lv: lv, close: c, sector: sector }); });
      });
    });
    for (var t = 0; t < tiers.length; t++) {
      var tier = tiers[t];
      var rows = JOBS.filter(function (r) {
        if (tier.st && r.state !== tier.st) return false;
        if (tier.lv && tier.lv.indexOf(r.job.seniority_level) < 0) return false;
        var s = F.roleScore(r.job, role);
        if (s === null) return false;
        if (tier.close >= 2 && s < 1) return false;
        if (tier.close === 3 && F.list(r.job.sector_buckets).indexOf(tier.sector) < 0) return false;
        return true;
      });
      if (enough(rows)) return { rows: rows, tier: tier, role: role };
    }
    return { none: true, role: role };
  }

  function scopeText(res, title, state, years) {
    var t = res.tier;
    var where = t.st ? "in " + STATES[t.st] : "across the US";
    var level = t.lv ? " at your level" : "";
    var bits = [];
    if (state && !t.st) bits.push("There aren't enough in " + STATES[state] + " yet, so this compares the whole US.");
    else if (years && !t.lv) bits.push("There aren't enough at your level " + where + " yet, so this includes every level.");
    if (t.sector && t.close < 3) bits.push("There aren't enough " + t.sector.toLowerCase() + " postings, so this includes the same role in every sector.");
    return "Based on " + res.rows.length + " postings for roles like “" + esc(title) + "” " + where + level + ". " + bits.join(" ");
  }

  function render() {
    var title = $("scRole").value.trim();
    var state = $("scState").value;
    var years = $("scYears").value;
    var payIn = Number($("scPay").value) || 0;
    var pay = payIn ? ($("scPer").value === "hour" ? payIn * 2080 : payIn) : 0;
    var out = $("scOut");
    if (!JOBS) { out.innerHTML = '<div class="sc-note">Still loading the latest postings - one moment.</div>'; return; }
    var res = compare(title, state, years);
    if (res.error) { out.innerHTML = '<div class="sc-note">' + esc(res.error) + "</div>"; return; }
    if (res.none) {
      track("salary_check", { found: false });
      out.innerHTML = '<div class="sc-card"><h2>Not enough postings yet</h2><p class="sc-p">Not enough employers advertise pay for roles like “' +
        esc(title) + "” to give a fair figure. Try a broader title (for example “Technician” or “Engineer”), or choose Anywhere in the US.</p></div>";
      return;
    }
    // Signed out: say how much we found, and hold the figures back for a free profile (Adam,
    // 2026-11-18). No real numbers go into the page - the blurred band is a placeholder.
    if (!isSignedIn()) {
      track("salary_check_locked", { scope: res.tier.st ? "state" : "us", level: !!res.tier.lv });
      var whereL = res.tier.st ? "in " + STATES[res.tier.st] : "across the US";
      out.innerHTML =
        '<div class="sc-card sc-locked">' +
          '<div class="sc-k">Typical advertised pay</div>' +
          '<div class="sc-gauge" aria-hidden="true">' + gauge({ min: 0, max: 100, lo: 30, hi: 68, mid: 52, fmt: function () { return ""; }, unit: "Unlock with a free profile", locked: true }) + "</div>" +
          '<div class="sc-lock">' +
            '<h2>Your pay range for “' + esc(title) + "” " + whereL + (res.tier.lv ? " at your level" : "") + " is ready.</h2>" +
            '<p class="sc-p">Create a free profile to see your pay range, where your pay stands, and the best-paying jobs like yours. ' +
            "Drop in your resume and we fill in the profile for you in seconds.</p>" +
            '<div class="sc-lock-btns"><a class="btn btn-primary" href="/create-profile.html" data-lock-cta="signup">Upload your resume - it\'s free</a>' +
            '<a class="btn btn-ghost" href="/login.html" data-lock-cta="signin">I have a profile - sign in</a></div>' +
          "</div>" +
        "</div>";
      out.querySelectorAll("[data-lock-cta]").forEach(function (a) {
        a.addEventListener("click", function () { track("salary_check_unlock_click", { cta: a.dataset.lockCta }); });
      });
      return;
    }
    var vals = res.rows.map(function (r) { return r.pay; }).sort(function (a, b) { return a - b; });
    var mid = median(vals), lo = pct(vals, 0.25), hi = pct(vals, 0.75);
    var p10 = pct(vals, 0.1), p90 = pct(vals, 0.9);
    // Hourly people see hourly figures; everyone else a yearly salary.
    var hourly = $("scPer").value === "hour";
    var hourStr = function (v) { return "$" + (v / 2080).toFixed(2); };
    var fmt = hourly ? hourStr : money;
    var unitLabel = hourly ? '<span class="sc-unit"> an hour</span>' : "";
    var span = Math.max(p90 - p10, 1);
    var pos = function (v) { return Math.max(0, Math.min(100, (v - p10) / span * 100)); };
    var you = "";
    var verdict = "";
    if (pay) {
      var below = vals.filter(function (v) { return v < pay; }).length;
      var share = Math.round(below / vals.length * 100);
      verdict = share >= 75 ? "Your pay is above most of these postings - higher than about " + share + "% of them."
        : share <= 25 ? "Your pay is below most of these postings - " + (100 - share) + "% of them advertise more."
        : "Your pay is in the middle of the range - higher than about " + share + "% of these postings.";
      you = '<div class="sc-you" style="left:' + pos(pay).toFixed(1) + '%"><span>You</span></div>';
    }
    // Best-paying 5, at most 2 from any one employer so the list shows the market, not one company.
    var perCo = {};
    var top = res.rows.slice().sort(function (a, b) { return (b.job.salary_annual_max || b.pay) - (a.job.salary_annual_max || a.pay); })
      .filter(function (r) { var c = (r.job.company || "").toLowerCase(); perCo[c] = (perCo[c] || 0) + 1; return perCo[c] <= 2; }).slice(0, 5);
    var signedIn = false;
    try { var s = JSON.parse(localStorage.getItem("vt_session") || "null"); signedIn = !!(s && s.candidate_id); } catch (e) {}
    track("salary_check", { found: true, scope: res.tier.st ? "state" : "us", level: !!res.tier.lv, compared_pay: !!pay });
    out.innerHTML =
      '<div class="sc-card">' +
        '<div class="sc-gauge-row">' +
          '<div class="sc-gauge">' + gauge({ min: p10, max: p90, lo: lo, hi: hi, mid: mid, you: pay || null, fmt: fmt,
            unit: hourly ? "an hour" : "a year", label: "Typical advertised pay " + fmt(lo) + " to " + fmt(hi) }) + "</div>" +
          '<div class="sc-gauge-text"><div class="sc-k">Typical advertised pay</div>' +
            '<div class="sc-big">' + fmt(lo) + " – " + fmt(hi) + unitLabel + "</div>" +
            '<div class="sc-sub">Green = the middle half of postings. The tick is the median: ' + (hourly
              ? hourStr(mid) + " an hour (" + money(mid) + " a year)"
              : money(mid) + " a year (" + hourStr(mid) + " an hour)") + ".</div>" +
            (verdict ? '<p class="sc-verdict">' + esc(verdict) + "</p>" : "") +
          "</div>" +
        "</div>" +
        '<p class="sc-scope">' + scopeText(res, title, state, years) + "</p>" +
      "</div>" +
      '<div class="sc-card"><h2>Best-paying postings like this</h2><div class="sc-list">' +
        top.map(function (r) {
          var j = r.job;
          var href = j.page_slug ? "/jobs/" + encodeURIComponent(j.page_slug) + ".html" : "/jobs.html";
          return '<a class="sc-job" href="' + href + '"><span class="sc-job-t">' + esc(j.job_title) + '</span><span class="sc-job-m">' +
            esc(j.company) + " · " + esc(j.location) + '</span><span class="sc-job-p">' + esc(j.salary || money(r.pay)) + "</span></a>";
        }).join("") +
      "</div>" +
      (signedIn
        ? '<p class="sc-cta">New roles like these come to you in your <a href="/dashboard.html#alerts">job alerts</a>.</p>'
        : '<p class="sc-cta"><a href="/create-profile.html">Create a free profile</a> and new roles like these come to you by email.</p>') +
      "</div>";
  }

  window.VTPay = { prepare: prepare, compare: compare, summary: summary, money: money, gauge: gauge, STATES: STATES };

  function askForPay() {
    var pay = $("scPay");
    if (!pay) return;
    var field = pay.closest(".sc-field");
    if (field) {
      field.classList.add("sc-ask");
      var lab = field.querySelector("label");
      if (lab && !field.querySelector(".sc-ask-hint")) {
        var h = document.createElement("div");
        h.className = "sc-ask-hint";
        h.textContent = "Enter your pay and press Enter to see where you fall.";
        field.appendChild(h);
      }
    }
    pay.scrollIntoView({ block: "center" });
    try { pay.focus({ preventScroll: true }); } catch (e) { pay.focus(); }
    pay.addEventListener("input", function () { if (field) { field.classList.remove("sc-ask"); var hh = field.querySelector(".sc-ask-hint"); if (hh) hh.remove(); } }, { once: true });
  }

  document.addEventListener("DOMContentLoaded", async function () {
    if (!$("scForm")) return;  // loaded by the dashboard for VTPay only
    var dl = $("scRoleList");
    SUGGESTIONS.forEach(function (s) { var o = document.createElement("option"); o.value = s; dl.appendChild(o); });
    $("scGo").addEventListener("click", render);
    $("scRole").addEventListener("keydown", function (e) { if (e.key === "Enter") render(); });
    $("scPay").addEventListener("keydown", function (e) { if (e.key === "Enter") render(); });
    try { await load(); } catch (e) { $("scOut").innerHTML = '<div class="sc-note">Couldn\'t load the latest postings. Please refresh the page.</div>'; return; }
    // From a job page's "Typical pay for roles like this" link: ?role=...&state=TX.
    var q = new URLSearchParams(location.search);
    if (q.get("role")) {
      $("scRole").value = q.get("role").slice(0, 120);
      var qs = (q.get("state") || "").toUpperCase();
      if (qs && $("scState").querySelector('option[value="' + qs + '"]')) $("scState").value = qs;
      try {
        var pp = window.VTJobFit && await window.VTJobFit.loadProfile();
        var yy = pp && pp.raw && pp.raw.years_experience;
        if (yy && LEVELS[yy]) $("scYears").value = yy;
      } catch (e) {}
      render();
      if (q.get("ask") === "pay") askForPay();
      return;
    }
    // Signed in: start from their own profile (their headline, state and experience).
    try {
      var p = window.VTJobFit && await window.VTJobFit.loadProfile();
      var c = p && p.raw;
      if (c && (c.headline || (c.experience && c.experience[0]))) {
        $("scRole").value = c.headline || c.experience[0].title || "";
        var st = window.VTJobFit.stateOf(c.location);
        if (st && $("scState").querySelector('option[value="' + st + '"]')) $("scState").value = st;
        if (c.years_experience && LEVELS[c.years_experience]) $("scYears").value = c.years_experience;
        $("scPrefill").hidden = false;
        render();
      }
    } catch (e) {}
  });
})();
