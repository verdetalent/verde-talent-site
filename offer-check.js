// "Check a job offer" (offer-check.html, 2026-11-25): an offer's pay against advertised pay for the
// same kind of role (salary-check.js's VTPay - the same rules as "What am I worth?"), which perks
// similar postings mention (data/job_perks.json, written nightly by renewable-energy-jobs
// taxonomy/perks.py), a counter-offer email with blanks, and questions to ask before signing.
//
// Runs entirely in the browser - no AI, nothing sent anywhere, nothing saved. Signed out, the pay
// figures, the perk figures and the reply email all wait for a free profile (Adam, 2026-11-18 and
// 2026-11-25); signed out, only the questions to ask (without figures) stay free.
// Pages call gtag only (never FullStory directly).
(function () {
  "use strict";
  var DOCX = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js";
  var SUPABASE_URL = "https://iqcyofkosjopxsfdufvy.supabase.co";
  var ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";
  var MIN_TEXT = 8;    // postings with a description needed before we quote how often a perk comes up
  var SHOW_MIN = 10;   // a perk nobody ticked shows only from this share up
  var ASK_MIN = 25;    // ...and is "worth asking about" from this share up
  // [key in job_perks.json, checkbox label, phrase for the email]
  var PERKS = [
    ["health", "Health insurance", "health insurance"],
    ["pto", "Paid time off", "paid time off"],
    ["k401", "401(k) / retirement plan", "a 401(k) or retirement plan"],
    ["ot", "Overtime pay", "overtime pay"],
    ["reloc", "Relocation help", "relocation help"],
    ["sign", "Sign-on bonus", "a sign-on bonus"],
    ["train", "Paid training & certs", "paid training and certifications"],
    ["travel_pay", "Travel pay / per diem", "travel pay or per diem"],
    ["vehicle", "Company vehicle", "a company vehicle"],
  ];
  var CERTS = { Wind: "GWO, NFPA 70E, climb rescue", Solar: "OSHA 30, NABCEP", Grid: "NFPA 70E, OSHA 30", Storage: "NFPA 70E, OSHA 30" };

  var $ = function (id) { return document.getElementById(id); };
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function track(name, params) { try { if (typeof gtag === "function") gtag("event", name, params || {}); } catch (e) {} }
  function session() { try { var s = JSON.parse(localStorage.getItem("vt_session") || "null"); return s && s.candidate_id ? s : null; } catch (e) { return null; } }
  function pct(sorted, p) { return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)]; }
  function blank(t) { return '<span class="bl">[' + esc(t) + "]</span>"; }
  function listJoin(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }

  var LOCK = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  var PERK_MAP = null, NAME = "", READY = false;

  // --- Figures ---------------------------------------------------------------------------------
  function fmtFor(hourly) {
    return hourly
      ? function (v) { return "$" + (v / 2080).toFixed(2); }
      : function (v) { return "$" + (Math.round(v / 100) * 100).toLocaleString("en-US"); };
  }
  // A figure someone would actually ask for: the nearest 50 cents an hour, or $1,000 a year.
  function askFigure(v, hourly) {
    return hourly ? "$" + (Math.round(v / 2080 * 2) / 2).toFixed(2) + " an hour"
      : "$" + (Math.round(v / 1000) * 1000).toLocaleString("en-US") + " a year";
  }
  function perkShares(rows) {
    if (!PERK_MAP) return null;
    var seen = rows.filter(function (r) { return r.job.page_slug && PERK_MAP[r.job.page_slug] !== undefined; });
    if (seen.length < MIN_TEXT) return null;
    // Each employer counts once (the average of its own rate), so one big employer's benefits
    // boilerplate across 40 postings can't decide the figure.
    var by = {};
    seen.forEach(function (r) { var c = (r.job.company || "").toLowerCase(); (by[c] = by[c] || []).push(PERK_MAP[r.job.page_slug].split(",")); });
    var cos = Object.keys(by), out = {};
    PERKS.concat([["travel"]]).forEach(function (p) {
      var sum = 0;
      cos.forEach(function (c) { sum += by[c].filter(function (ks) { return ks.indexOf(p[0]) >= 0; }).length / by[c].length; });
      out[p[0]] = Math.round(sum / cos.length * 100);
    });
    return out;
  }

  // --- Cards -----------------------------------------------------------------------------------
  function payCard(a) {
    if (!a.res || a.res.none) {
      return '<div class="sc-card"><h2>Not enough postings to compare pay yet</h2><p class="sc-p">Not enough employers advertise pay for roles like “' +
        esc(a.title) + "” to give a fair comparison. Try a broader title (for example “Technician” or “Engineer”), or choose Anywhere in the US. The rest of this page still works.</p></div>";
    }
    var v = a.vals, fmt = fmtFor(a.hourly);
    var share = a.share;
    var verdict = share <= 25 ? "<b>On the low side.</b> About " + (100 - share) + "% of similar postings advertise more than this offer."
      : share < 50 ? "<b>A little below the middle.</b> About " + (100 - share) + "% of similar postings advertise more."
      : share < 75 ? "<b>Around the middle.</b> This offer pays more than about " + share + "% of similar postings."
      : "<b>A strong offer.</b> It pays more than about " + share + "% of similar postings.";
    var t = a.res.tier;
    var where = t.st ? "in " + VTPay.STATES[t.st] : "across the US";
    var bits = [];
    if (a.state && !t.st) bits.push("There aren't enough in " + VTPay.STATES[a.state] + " yet, so this compares the whole US.");
    if (a.years && !t.lv) bits.push("There aren't enough at this level yet, so this includes every level.");
    return '<div class="sc-card"><div class="sc-gauge-row">' +
        '<div class="sc-gauge">' + VTPay.gauge({ min: a.p10, max: a.p90, lo: a.lo, hi: a.hi, mid: a.mid, you: a.offer, youLabel: "Offer", fmt: fmt,
          unit: a.hourly ? "an hour" : "a year", label: "Typical advertised pay " + fmt(a.lo) + " to " + fmt(a.hi) }) + "</div>" +
        '<div class="sc-gauge-text"><div class="sc-k">Your offer</div>' +
          '<div class="sc-big oc-offer' + (share < 50 ? " low" : "") + '">' + fmt(a.offer) + '<span class="sc-unit"> ' + (a.hourly ? "an hour" : "a year") + "</span></div>" +
          '<div class="sc-sub">Typical advertised pay for roles like this: <b>' + fmt(a.lo) + " – " + fmt(a.hi) + "</b> " + (a.hourly ? "an hour" : "a year") + ". Median " + fmt(a.mid) + ".</div>" +
          '<p class="sc-verdict">' + verdict + "</p>" +
        "</div></div>" +
        '<p class="sc-scope">Compared with ' + v.length + " postings for roles like “" + esc(a.title) + "” " + where + (t.lv ? " at this level" : "") +
          ". Advertised pay, not offers made. " + bits.join(" ") + "</p>" +
      "</div>";
  }
  // Signed out: pay, perk figures and the reply email all wait for a free profile (Adam, 2026-11-25).
  function lockedCard(a) {
    return '<div class="sc-card sc-locked">' +
      '<div class="sc-k">How your offer compares</div>' +
      '<div class="sc-gauge" aria-hidden="true">' + VTPay.gauge({ min: 0, max: 100, lo: 30, hi: 68, mid: 52, fmt: function () { return ""; }, unit: "Unlock with a free profile", locked: true }) + "</div>" +
      '<div class="sc-lock">' +
        "<h2>Your offer check for “" + esc(a.title) + "” is ready.</h2>" +
        '<ul class="oc-lockl">' +
          '<li>' + LOCK + 'Where this offer falls against similar postings, and the typical pay range</li>' +
          '<li>' + LOCK + 'What offers like this usually include, and what to ask for</li>' +
          '<li>' + LOCK + 'A ready-to-send reply with the figure to ask for</li>' +
        "</ul>" +
        '<p class="sc-p">Create a free profile to see all three. Drop in your resume and we fill in the profile for you in seconds.</p>' +
        '<div class="sc-lock-btns"><a class="btn btn-primary" href="/create-profile.html?src=offer-check" data-lock-cta="signup">Upload your resume - it\'s free</a>' +
        '<a class="btn btn-ghost" href="/login.html" data-lock-cta="signin">I have a profile - sign in</a></div>' +
      "</div></div>";
  }

  // Signed out: the reply email is there to see but not read - placeholder wording only (never the
  // real figure or perks), blurred, with the unlock button on top (Adam, 2026-11-25).
  function lockedLetterCard(a) {
    var co = a.company ? esc(a.company) : "the company";
    var role = a.title ? esc(a.title) : "this";
    var paras = ["Hi Alex,",
      "Thank you for the offer for the " + role + " role at " + co + ". I'm excited about the team and want to make this work.",
      "Before I accept, I'd like to talk about the pay. Similar roles are advertising around $00.00, and with my experience, I'd be glad to accept at $00.00.",
      "Could you also tell me whether the role includes the benefits that similar offers usually include?",
      "Thank you again,<br>Your name"];
    return '<div class="sc-card oc-lockcard"><h2>What to say back <span class="oc-tag">Written for your offer</span></h2>' +
      '<p class="oc-sub">A polite counter with the figure to ask for, based on what similar roles pay. Copy it or download it for Word.</p>' +
      '<div class="oc-lockwrap"><div class="oc-letter oc-blur" aria-hidden="true">' + paras.map(function (p) { return "<p>" + p + "</p>"; }).join("") + "</div>" +
        '<div class="oc-lockover"><span class="oc-lockico">' + LOCK + '</span><b>Your reply is ready</b><span>Free with a Verde Talent profile</span>' +
        '<a class="btn btn-primary" href="/create-profile.html?src=offer-check-reply" data-lock-cta="reply">Unlock my reply - it&#39;s free</a>' +
        '<a class="oc-signin" href="/login.html" data-lock-cta="signin_reply">I have a profile - sign in</a></div></div>' +
    "</div>";
  }

  function perksCard(a) {
    if (!a.shares) return "";
    var rows = PERKS.filter(function (p) { return a.ticked[p[0]] || a.shares[p[0]] >= SHOW_MIN; })
      .sort(function (x, y) { return a.shares[y[0]] - a.shares[x[0]]; });
    if (!rows.length) return "";
    return '<div class="sc-card"><h2>What else offers like this usually include</h2>' +
      '<p class="oc-sub">How often similar postings mention each one, with every employer counted equally. Not in your offer? Worth asking about.</p>' +
      '<table class="oc-tbl">' + rows.map(function (p) {
        var s = a.shares[p[0]], st;
        if (a.ticked[p[0]]) st = '<span class="y">&#10003; In your offer</span>' + (s < SHOW_MIN ? '<span class="oc-plus">Less common - a plus</span>' : "");
        else if (s >= ASK_MIN) st = '<span class="a">&#9679; Ask about it</span>';
        else st = '<span class="m">Sometimes offered</span>';
        var pc = s < SHOW_MIN ? "Rarely mentioned" : '<span class="oc-bar"><i style="width:' + s + '%"></i></span>' + s + "% mention it";
        return "<tr><td>" + esc(p[1]) + '</td><td class="st">' + st + '</td><td class="pc">' + pc + "</td></tr>";
      }).join("") + "</table></div>";
  }

  function letterCard(a) {
    var co = a.company ? '<span class="nm">' + esc(a.company) + "</span>" : blank("company");
    var role = a.title ? esc(a.title) : blank("job title");
    var askFor = a.shares ? PERKS.filter(function (p) { return !a.ticked[p[0]] && a.shares[p[0]] >= ASK_MIN; })
      .sort(function (x, y) { return a.shares[y[0]] - a.shares[x[0]]; }).slice(0, 2).map(function (p) { return p[2]; }) : [];
    var paras = ["Hi " + blank("name") + ",",
      "Thank you for the offer for the " + role + " role at " + co + ". I'm excited about the team and want to make this work."];
    var lead;
    if (a.signedIn && a.target) {
      var fig = '<span class="nm">' + askFigure(a.target, a.hourly) + "</span>";
      paras.push("Before I accept, I'd like to talk about the pay. Similar roles are advertising around " + fig + ", and with my " +
        blank("a certification or experience you bring") + ", I'd be glad to accept at " + fig + ".");
      lead = "A polite counter that asks for " + (a.share < 50 ? "about the median" : "the upper part of the typical range") + ". Edit anything before you send it.";
    } else if (a.signedIn && a.res && !a.res.none && a.share >= 75) {
      paras.push("The pay works well for me.");
      lead = "Your pay is already strong, so this asks about the rest of the package. Edit anything before you send it.";
    } else {
      paras.push("Before I accept, I'd like to talk about the pay. Based on what similar roles advertise, and with my " +
        blank("a certification or experience you bring") + ", I'd be glad to accept at " + blank("the pay you're asking for") + ".");
      lead = "A polite counter. Edit anything before you send it.";
    }
    if (askFor.length) paras.push("Could you also tell me whether the role includes " + listJoin(askFor) + "?");
    paras.push("Thank you again,<br>" + (a.name ? '<span class="nm">' + esc(a.name) + "</span>" : blank("your name")));
    return '<div class="sc-card"><h2>What to say back <span class="oc-tag" id="ocBlanks"></span></h2>' +
      '<p class="oc-sub">' + lead + "</p>" +
      '<div class="oc-letter" id="ocLetter" contenteditable="true" spellcheck="true">' + paras.map(function (p) { return "<p>" + p + "</p>"; }).join("") + "</div>" +
      '<div class="oc-act"><button type="button" class="pri" id="ocCopy">Copy</button><button type="button" id="ocWord">Download Word</button><span class="oc-done" id="ocDone" aria-live="polite"></span></div>' +
    "</div>";
  }

  function questionsCard(a) {
    var q = [];
    var hourly = a.hourly || (a.summary && a.summary.hourlyShare > 0.5);
    if (a.ticked.ot) q.push(["How many hours a week are guaranteed, and when does overtime start?", "Overtime is in your offer. The rate and when it starts make the real difference."]);
    else if (hourly) q.push(["Is the role paid overtime, and how many hours a week are guaranteed?"]);
    if (a.shares && a.shares.travel >= 20 && !a.ticked.travel_pay)
      q.push(["How much of the year is travel, and is travel time paid? Is there a per diem?",
        a.signedIn ? a.shares.travel + "% of similar postings mention travel, but few say whether it's paid." : ""]);
    if (a.ticked.sign) q.push(["Does the sign-on bonus have to be paid back if you leave early?"]);
    if (a.ticked.reloc) q.push(["Is relocation paid up front or reimbursed, and is there a payback clause?"]);
    var certs = CERTS[a.sector];
    q.push([certs ? "Which certifications will you pay for, and when (" + certs + ")?" : "Which training or certifications will you pay for?"]);
    q.push(["When is the first pay review, and what's the usual raise after it?"]);
    q.push(["Is there a probation period, and when do benefits start?"]);
    return '<div class="sc-card"><h2>Questions to ask before you sign</h2><ol class="oc-q">' +
      q.slice(0, 6).map(function (x) { return "<li>" + esc(x[0]) + (x[1] ? "<span>" + esc(x[1]) + "</span>" : "") + "</li>"; }).join("") + "</ol></div>";
  }

  // --- Email tools -----------------------------------------------------------------------------
  function countBlanks() {
    var n = 0;
    document.querySelectorAll("#ocLetter .bl").forEach(function (b) { if (/^\s*\[[^\]]*\]\s*$/.test(b.textContent)) n++; });
    var tag = $("ocBlanks");
    if (tag) { tag.textContent = n ? n + " blank" + (n === 1 ? "" : "s") + " to fill in" : "Ready to send"; tag.classList.toggle("ok", !n); }
  }
  function letterText() {
    return Array.prototype.map.call($("ocLetter").querySelectorAll("p"), function (p) { return p.innerText.trim(); }).join("\n\n");
  }
  var docxLoading = null;
  function loadDocx() {
    if (window.docx) return Promise.resolve();
    if (!docxLoading) docxLoading = new Promise(function (ok, bad) { var s = document.createElement("script"); s.src = DOCX; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
    return docxLoading;
  }
  function done(msg) { var d = $("ocDone"); if (d) { d.textContent = msg; setTimeout(function () { d.textContent = ""; }, 2500); } }
  function wireLetter(a) {
    countBlanks();
    $("ocLetter").addEventListener("input", countBlanks);
    $("ocCopy").addEventListener("click", function () {
      var t = letterText();
      track("offer_check_copy", {});
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { done("Copied"); }, function () { done("Select the text and copy it"); });
      else done("Select the text and copy it");
    });
    $("ocWord").addEventListener("click", function () {
      track("offer_check_download", {});
      loadDocx().then(function () {
        var D = window.docx;
        var paras = letterText().split("\n\n").map(function (block) {
          var lines = block.split("\n"), runs = [];
          lines.forEach(function (l, i) { runs.push(new D.TextRun({ text: l, break: i ? 1 : 0 })); });
          return new D.Paragraph({ spacing: { after: 200 }, children: runs });
        });
        return D.Packer.toBlob(new D.Document({ sections: [{ children: paras }] }));
      }).then(function (blob) {
        var name = ("Offer reply" + (a.company ? " - " + a.company : "")).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() + ".docx";
        var l = document.createElement("a"); l.href = URL.createObjectURL(blob); l.download = name;
        document.body.appendChild(l); l.click(); setTimeout(function () { URL.revokeObjectURL(l.href); l.remove(); }, 1000);
      }).catch(function () { done("Couldn't make the Word file - use Copy instead"); });
    });
  }

  // --- Run -------------------------------------------------------------------------------------
  function ticked() {
    var t = {};
    document.querySelectorAll("#ocPerks input").forEach(function (i) { t[i.value] = i.checked; });
    return t;
  }
  function check() {
    var out = $("ocOut");
    var a = {
      title: $("ocRole").value.trim(), state: $("ocState").value, years: $("ocYears").value,
      company: $("ocCo").value.trim(), hourly: $("ocPer").value === "hour", ticked: ticked(),
      signedIn: !!session(), name: NAME,
    };
    var payIn = Number($("ocPay").value) || 0;
    if (!a.title) { out.innerHTML = '<div class="sc-note">Type the job title from the offer, for example “Wind technician”.</div>'; return; }
    if (!payIn) { out.innerHTML = '<div class="sc-note">Enter the pay you were offered.</div>'; return; }
    if (!READY) { out.innerHTML = '<div class="sc-note">Still loading the latest postings - one moment.</div>'; return; }
    a.offer = a.hourly ? payIn * 2080 : payIn;
    var res = VTPay.compare(a.title, a.state, a.years);
    if (res.error) { out.innerHTML = '<div class="sc-note">' + esc(res.error) + "</div>"; return; }
    a.res = res;
    a.sector = res.tier ? res.tier.sector : null;
    if (!a.sector) {
      var t = a.title.toLowerCase();
      a.sector = /\bwind\b/.test(t) ? "Wind" : /\bsolar\b|\bpv\b/.test(t) ? "Solar" : /substation|transmission|line(man|worker)|grid/.test(t) ? "Grid" : /battery|storage|bess/.test(t) ? "Storage" : null;
    }
    if (!res.none) {
      a.vals = res.rows.map(function (r) { return r.pay; }).sort(function (x, y) { return x - y; });
      a.summary = VTPay.summary(res);
      a.mid = a.summary.mid; a.lo = a.summary.lo; a.hi = a.summary.hi;
      a.p10 = Math.min(pct(a.vals, 0.1), a.offer); a.p90 = Math.max(pct(a.vals, 0.9), a.offer);
      a.share = Math.round(a.vals.filter(function (x) { return x < a.offer; }).length / a.vals.length * 100);
      a.target = a.share < 50 ? a.mid : a.share < 75 ? a.hi : null;
      if (a.target && a.target <= a.offer) a.target = null;
      a.shares = perkShares(res.rows);
    }
    out.innerHTML = a.signedIn ? payCard(a) + perksCard(a) + letterCard(a) + questionsCard(a) : lockedCard(a) + lockedLetterCard(a) + questionsCard(a);
    if (a.signedIn) wireLetter(a);
    out.querySelectorAll("[data-lock-cta]").forEach(function (l) {
      l.addEventListener("click", function () { track("offer_check_unlock_click", { cta: l.dataset.lockCta }); });
    });
    track("offer_check", { found: !res.none, signed_in: a.signedIn,
      band: res.none || !a.signedIn ? "none" : a.share <= 25 ? "low" : a.share < 50 ? "below_mid" : a.share < 75 ? "mid" : "high" });
    out.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function loadName(s) {
    try {
      if (window.VTAlerts && window.VTAlerts.session) s = (await window.VTAlerts.session()) || s;
      if (!s || !s.access_token) return;
      var r = await fetch(SUPABASE_URL + "/rest/v1/candidates?id=eq." + encodeURIComponent(s.candidate_id) + "&select=first_name,last_name",
        { headers: { apikey: ANON_KEY, Authorization: "Bearer " + s.access_token } });
      if (!r.ok) return;
      var rows = await r.json();
      if (rows[0]) NAME = [rows[0].first_name, rows[0].last_name].filter(Boolean).join(" ");
    } catch (e) {}
  }

  document.addEventListener("DOMContentLoaded", async function () {
    if (!$("ocForm")) return;
    $("ocPerks").innerHTML = PERKS.map(function (p) {
      return '<label><input type="checkbox" value="' + p[0] + '"/>' + esc(p[1]) + "</label>";
    }).join("");
    $("ocPerks").addEventListener("change", function (e) { if (e.target.closest("label")) e.target.closest("label").classList.toggle("on", e.target.checked); });
    $("ocGo").addEventListener("click", check);
    ["ocRole", "ocPay", "ocCo"].forEach(function (id) { $(id).addEventListener("keydown", function (e) { if (e.key === "Enter") check(); }); });
    var q = new URLSearchParams(location.search);
    if (q.get("role")) $("ocRole").value = q.get("role").slice(0, 120);
    if (q.get("co")) $("ocCo").value = q.get("co").slice(0, 120);
    var s = session();
    var jobsP = fetch("/data/jobs_list.json").then(function (r) { if (!r.ok) throw 0; return r.json(); });
    var perksP = fetch("/data/job_perks.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    try {
      VTPay.prepare(await jobsP);
    } catch (e) { $("ocOut").innerHTML = '<div class="sc-note">Couldn\'t load the latest postings. Please refresh the page.</div>'; return; }
    PERK_MAP = await perksP;
    var seen = {};
    (await jobsP).forEach(function (j) { var st = j.region === "US" && window.VTJobFit.stateOf(j.location); if (st && VTPay.STATES[st]) seen[st] = 1; });
    Object.keys(seen).sort(function (x, y) { return VTPay.STATES[x].localeCompare(VTPay.STATES[y]); }).forEach(function (st) {
      var o = document.createElement("option"); o.value = st; o.textContent = VTPay.STATES[st]; $("ocState").appendChild(o);
    });
    var qs = (q.get("state") || "").toUpperCase();
    if (qs && seen[qs]) $("ocState").value = qs;
    READY = true;
    if (s) {
      loadName(s);
      try {
        var p = await window.VTJobFit.loadProfile();
        var c = p && p.raw;
        if (c) {
          if (!$("ocRole").value && (c.headline || (c.experience && c.experience[0]))) $("ocRole").value = c.headline || c.experience[0].title || "";
          var st = window.VTJobFit.stateOf(c.location);
          if (!qs && st && seen[st]) $("ocState").value = st;
          if (c.years_experience && $("ocYears").querySelector('option[value="' + c.years_experience + '"]')) $("ocYears").value = c.years_experience;
        }
      } catch (e) {}
    }
  });
})();
