// "Tailor my application" (free version, 2026-11-25). Runs entirely in the browser - no AI, no server.
// Uses the resume check's term list (job-resume-check.js) to see what this ad asks for, then:
//  - puts the skills the ad asks for first, and in each job the bullets that mention them first;
//  - highlights every one of those so the candidate sees what moved;
//  - lists what the ad asks for that the profile doesn't show ("worth adding, if true");
//  - fills a cover letter template from the profile, with blanks left for them.
// Nothing is reworded or invented. Word download uses docx (loaded only on click). Pages call gtag only.
(function () {
  "use strict";
  var DOCX = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js";
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (m) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]; }); }
  function track(n, p) { try { if (typeof gtag === "function") gtag("event", n, p || {}); } catch (e) {} }

  // Field-job requirements the resume check leaves out (it marks tools and credentials inside the ad),
  // used here only for ordering and the "worth adding, if true" list.
  var KIT_TERMS = [
    { id: "k_heights", label: "Working at heights", v: [/\bat (elevated )?heights?\b/, /from heights/, /elevated heights?/, /\bclimb(ing)?\b.{0,40}\b(tower|turbine|nacelle)s?/, /\bheights?\b/] },
    { id: "k_dl", label: "Valid driver's license", v: [/driver.?s.? licen[cs]e/, /driving record/] },
    { id: "k_travel", label: "Open to travel", v: [/\btravel(ing|ling)?\b(?! (time|expenses?|reimburse))/] },
    { id: "k_cust", label: "Customer service", v: [/customer service/, /customer[- ]facing/] },
    { id: "k_team", label: "Training or leading others", v: [/\btrain(ing|ed)? (new )?(hires|technicians|others|team)/, /\bmentor/, /\blead (a )?(crew|team)/] },
  ];
  // The ad's terms, as regexes, from the resume check plus the kit's own list.
  function adTerms(reqText) {
    return (window.VTResumeCheck ? window.VTResumeCheck.TERMS : []).concat(KIT_TERMS).filter(function (t) {
      if (t.brand) return false;
      if (t.gate && !t.gate.test(reqText)) return false;
      return t.v.some(function (re) { return re.test(reqText); });
    });
  }
  function hits(text, terms) {
    var low = String(text || "").toLowerCase();
    return terms.filter(function (t) { return t.v.some(function (re) { return re.test(low); }); });
  }
  // Stable sort: matching items first, original order kept within each group.
  function lift(list, terms) {
    return list.map(function (x, i) { return { x: x, i: i, n: hits(x, terms).length }; })
      .sort(function (a, b) { return (b.n > 0) - (a.n > 0) || a.i - b.i; });
  }

  function build(job, c, body) {
    var a = window.VTResumeCheck.analyze(body, c);
    var terms = adTerms(a.reqText);
    var skills = lift(c.skills || [], terms);
    var jobs = (c.experience || []).filter(function (e) { return e && (e.title || e.co); }).map(function (e) {
      return { e: e, bullets: lift(e.bullets || [], terms) };
    });
    var movedSkills = skills.some(function (s, k) { return s.i !== k; });
    var movedBullets = jobs.some(function (j) { return j.bullets.some(function (b, k) { return b.i !== k; }); });
    var lit = skills.filter(function (s) { return s.n; }).length + jobs.reduce(function (n, j) { return n + j.bullets.filter(function (b) { return b.n; }).length; }, 0);
    var byId = {}; window.VTResumeCheck.TERMS.forEach(function (t) { byId[t.id] = t; });
    var me = [c.headline, c.bio, (c.skills || []).join(" "), (c.experience || []).map(function (e) { return [e.title, (e.bullets || []).join(" ")].join(" "); }).join(" "), c.relocation].join(" ").toLowerCase();
    var kitHave = [], kitMiss = [];
    KIT_TERMS.forEach(function (t) {
      if (!t.v.some(function (re) { return re.test(a.reqText); })) return;
      (t.v.some(function (re) { return re.test(me); }) ? kitHave : kitMiss).push(t.label);
    });
    var missing = a.missing.map(function (id) { return { label: byId[id].label, need: a.need[id] || "" }; })
      .concat(kitMiss.map(function (l) { return { label: l, need: "" }; }))
      .sort(function (x, y) { return (y.need === "Required") - (x.need === "Required"); });
    var haveTerms = Object.keys(a.status).filter(function (id) { return a.status[id] === "have"; }).map(function (id) { return byId[id]; })
      .concat(KIT_TERMS.filter(function (t) { return kitHave.indexOf(t.label) >= 0; }));
    var haveLabels = Object.keys(a.status).filter(function (id) { return a.status[id] === "have"; }).map(function (id) { return byId[id].label; }).concat(kitHave);
    // The two bullets that match the ad best, for the letter.
    var best = [];
    jobs.forEach(function (j) { j.bullets.forEach(function (b) { if (b.n) best.push(b); }); });
    best.sort(function (x, y) { return y.n - x.n; });
    return { a: a, terms: terms, skills: skills, jobs: jobs, movedSkills: movedSkills, movedBullets: movedBullets, lit: lit,
             missing: missing, haveLabels: haveLabels, haveTerms: haveTerms, best: best.slice(0, 2).map(function (b) { return b.x; }) };
  }

  function mark(text, on) { return on ? "<mark>" + esc(text) + "</mark>" : esc(text); }

  function resumeHtml(c, k) {
    var name = [c.first_name, c.last_name].filter(Boolean).join(" ");
    var contact = [c.location, c.email, (c.linkedin_url || "").replace(/^https?:\/\/(www\.)?/, "")].filter(Boolean).map(esc).join(" &middot; ");
    var edu = (c.education || []).filter(function (e) { return e && (e.degree || e.school); });
    return "<h1>" + esc(name) + "</h1><div class=\"ct\">" + contact + "</div>" +
      (c.bio ? "<h3>Summary</h3><p>" + esc(c.bio) + "</p>" : "") +
      (k.skills.length ? "<h3>Skills &amp; certifications</h3><p>" + k.skills.map(function (s) { return mark(s.x, s.n); }).join(" &middot; ") + "</p>" : "") +
      (k.jobs.length ? "<h3>Experience</h3>" + k.jobs.map(function (j) {
        return "<div class=\"jt\">" + esc(j.e.title || "") + "</div><div class=\"jm\">" + esc([j.e.co, j.e.dates].filter(Boolean).join(" · ")) + "</div>" +
          (j.bullets.length ? "<ul>" + j.bullets.map(function (b) { return "<li>" + mark(b.x, b.n) + "</li>"; }).join("") + "</ul>" : "");
      }).join("") : "") +
      (edu.length ? "<h3>Education</h3>" + edu.map(function (e) {
        return "<div class=\"jt\">" + esc(e.degree || "") + "</div><div class=\"jm\">" + esc([e.school, e.dates].filter(Boolean).join(" · ")) + "</div>";
      }).join("") : "");
  }

  function blank(t) { return "<span class=\"kit-blank\">[" + esc(t) + "]</span>"; }
  // "Wind Technician" stays capitalised, "Confined space" becomes "confined space" mid-sentence.
  function inSentence(t) { return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t; }
  function listJoin(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
  function letterHtml(job, c, k) {
    var name = [c.first_name, c.last_name].filter(Boolean).join(" ");
    var latest = (c.experience || [])[0];
    var city = (job.location || "").split(",")[0].trim();
    var title = job.job_title || "open";
    var where = city && title.toLowerCase().indexOf(city.toLowerCase()) < 0 ? " in " + esc(city) : "";
    var yrs = c.years_experience ? ", with " + esc(c.years_experience) + " of experience" : "";
    var me = latest && latest.title && latest.co && /present|current|now/i.test(latest.dates || "")
      ? " I'm currently a " + esc(latest.title) + " at " + esc(latest.co) + yrs + "."
      : c.headline ? " I'm a " + esc(c.headline) + yrs + "." : "";
    var intro = "I'm applying for the " + esc(title) + " role" + where + "." + me;
    var why = blank("One or two sentences on why " + job.company + " and this role interest you");
    var proof = k.best.length
      ? "<p>" + (k.best.length === 1 ? "One thing" : "Two things") + " from my experience that match" + (k.best.length === 1 ? "es" : "") +
        " what you're looking for:</p><ul>" + k.best.map(function (b) { return "<li>" + esc(b) + "</li>"; }).join("") + "</ul>"
      : "<p>" + blank("Your strongest example of work like this role") + "</p>";
    // Things the ad asks for that the profile shows, not already covered by the bullets above.
    var shown = k.best.join(" ").toLowerCase();
    var extra = k.haveTerms.filter(function (t) { return !t.v.some(function (re) { return re.test(shown); }); })
      .slice(0, 3).map(function (t) { return inSentence(t.label); });
    var also = extra.length ? "<p>Your posting also asks for " + esc(listJoin(extra)) + ", which " + (extra.length === 1 ? "is" : "are") + " part of my experience too.</p>" : "";
    return "<p>Dear " + esc(job.company) + " hiring team,</p><p>" + intro + " " + why + "</p>" + proof + also +
      "<p>Thank you for considering my application. I'd welcome the chance to talk.</p><p>" + esc(name) + (c.email ? "<br>" + esc(c.email) : "") + "</p>";
  }

  function sideHtml(k) {
    var changed = [];
    if (k.movedSkills) changed.push("<li><b>Skills</b> this ad asks for are now first.</li>");
    if (k.movedBullets) changed.push("<li><b>Bullets</b> that match the ad now lead each job.</li>");
    if (k.lit) changed.push("<li>Everything that matches this ad is highlighted in green (" + k.lit + " in all).</li>");
    if (!changed.length) changed.push("<li>Your profile already leads with what this ad asks for, so nothing needed moving.</li>");
    changed.push("<li>Your summary and wording are exactly as you wrote them.</li>");
    var add = k.missing.length ? "<div class=\"kit-add\"><h4 style=\"color:#FFB547\">Worth adding, if true</h4>This ad asks for these and your profile doesn't show them. We never add them for you:<ul style=\"margin:6px 0 6px 16px\">" +
      k.missing.map(function (m) { return "<li>" + esc(m.label) + (m.need ? " <span class=\"kit-need\">" + esc(m.need) + "</span>" : "") + "</li>"; }).join("") +
      "</ul><a href=\"/dashboard.html#profile\">Add them to your profile &rarr;</a></div>" : "";
    return "<h4>What we changed for this ad</h4><ul>" + changed.join("") + "</ul>" + add +
      "<div class=\"kit-foot\">Built only from your Verde Talent profile, in your browser. The cover letter has blanks for you to fill in. Read both over before you send them.</div>";
  }

  // --- Word download -------------------------------------------------------------------------
  var docxLoading = null;
  function loadDocx() {
    if (window.docx) return Promise.resolve();
    if (!docxLoading) docxLoading = new Promise(function (ok, bad) { var s = document.createElement("script"); s.src = DOCX; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
    return docxLoading;
  }
  function paperToDocx(el) {
    var D = window.docx, out = [];
    function runs(node, bold) {
      var r = [];
      node.childNodes.forEach(function (n) {
        if (n.nodeType === 3) { if (n.textContent) r.push(new D.TextRun({ text: n.textContent, bold: bold })); }
        else if (n.tagName === "BR") r.push(new D.TextRun({ text: "", break: 1 }));
        else r = r.concat(runs(n, bold || n.tagName === "B"));
      });
      return r;
    }
    el.childNodes.forEach(function (n) {
      if (n.nodeType !== 1) return;
      var t = n.tagName, cls = n.className || "";
      if (t === "H1") out.push(new D.Paragraph({ children: [new D.TextRun({ text: n.textContent, bold: true, size: 36 })] }));
      else if (t === "H3") out.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_3, spacing: { before: 240 }, children: [new D.TextRun({ text: n.textContent.toUpperCase() })] }));
      else if (t === "UL") n.querySelectorAll("li").forEach(function (li) { out.push(new D.Paragraph({ bullet: { level: 0 }, children: runs(li) })); });
      else out.push(new D.Paragraph({ spacing: { after: cls === "jt" ? 0 : 120 }, children: runs(n, cls === "jt") }));
    });
    return new D.Document({ sections: [{ children: out }] });
  }
  function download(el, filename) {
    return loadDocx().then(function () { return window.docx.Packer.toBlob(paperToDocx(el)); }).then(function (blob) {
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
  }

  // --- Panel -----------------------------------------------------------------------------------
  function open(job, c, body) {
    var k = build(job, c, body);
    var sc = document.getElementById("kitScrim");
    document.getElementById("kitR").innerHTML = resumeHtml(c, k);
    document.getElementById("kitL").innerHTML = letterHtml(job, c, k);
    document.getElementById("kitSide").innerHTML = sideHtml(k);
    // The letter tab says how many blanks are left; it updates as they edit.
    var lt = document.querySelector('[data-kt="l"]');
    var count = function () {
      var n = document.querySelectorAll("#kitL .kit-blank").length;
      lt.innerHTML = "Cover letter" + (n ? ' <span class="kit-tabn">&middot; ' + n + " blank" + (n === 1 ? "" : "s") + " to fill in</span>" : "");
    };
    count();
    document.getElementById("kitL").oninput = function () {
      // a blank they typed over stops being a blank
      document.querySelectorAll("#kitL .kit-blank").forEach(function (b) { if (!/^\[.*\]$/.test(b.textContent.trim())) b.classList.remove("kit-blank"); });
      count();
    };
    sc.classList.add("open"); document.body.style.overflow = "hidden";
    track("job_kit_open", { matched: k.lit, missing: k.missing.length });
    return k;
  }
  function close() { document.getElementById("kitScrim").classList.remove("open"); document.body.style.overflow = ""; }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t.id === "kitScrim" || t.closest("#kitX")) return close();
    var tab = t.closest("[data-kt]");
    if (tab) {
      document.querySelectorAll("[data-kt]").forEach(function (x) { x.classList.toggle("on", x === tab); });
      document.getElementById("kitR").hidden = tab.dataset.kt !== "r";
      document.getElementById("kitL").hidden = tab.dataset.kt !== "l";
      return;
    }
    if (t.closest("#kitEdit")) {
      var b = t.closest("#kitEdit"), on = b.textContent === "Edit";
      document.querySelectorAll(".paper").forEach(function (p) { p.contentEditable = on; });
      b.textContent = on ? "Done editing" : "Edit";
      return;
    }
    var visible = function () { return document.getElementById("kitR").hidden ? document.getElementById("kitL") : document.getElementById("kitR"); };
    if (t.closest("#kitWord")) {
      var w = t.closest("#kitWord"), el = visible(), kind = el.id === "kitR" ? "Resume" : "Cover letter";
      w.textContent = "Preparing…";
      download(el, (kind + " - " + (window.VTKitJob ? window.VTKitJob.company : "job")).replace(/[\/:*?"<>|]+/g, "-").replace(/\s+/g, " ") + ".docx")
        .then(function () { w.textContent = "Download Word (.docx)"; track("job_kit_download", { kind: kind }); },
              function () { w.textContent = "Download failed - try again"; });
      return;
    }
    if (t.closest("#kitCopy")) {
      var cb = t.closest("#kitCopy"), txt = visible().innerText;
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
        function () { cb.textContent = "Copied ✓"; }, function () { cb.textContent = "Select the text to copy"; });
      setTimeout(function () { cb.textContent = "Copy text"; }, 2000);
      track("job_kit_copy");
    }
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

  var KIT_CSS = ".kit-btn{background:none;border:0.5px solid rgba(34,224,154,0.55);color:var(--grn);padding:11px 16px;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:6px;} .kit-btn:hover{background:rgba(34,224,154,0.08);} .kit-scrim{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:300;display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:32px 16px;} .kit-scrim.open{display:flex;} .kit{background:#0F0F0F;border:0.5px solid var(--bdr2);border-radius:16px;width:min(1040px,100%);display:grid;grid-template-columns:minmax(0,1fr) 300px;overflow:hidden;} .kit-main{padding:18px 20px 22px;min-width:0;} .kit-top{display:flex;align-items:center;gap:10px;margin-bottom:12px;} .kit-top h2{font-size:17px;font-weight:600;margin-right:auto;} .kit-x{background:none;border:0.5px solid var(--bdr2);color:var(--t2);border-radius:8px;width:32px;height:32px;cursor:pointer;} .kit-tabs{display:flex;gap:6px;margin-bottom:12px;} .kit-tab{background:none;border:0.5px solid var(--bdr2);color:var(--t2);border-radius:999px;padding:6px 14px;font-size:13px;cursor:pointer;} .kit-tab.on{background:rgba(34,224,154,0.12);border-color:rgba(34,224,154,0.5);color:var(--grn);} .paper{background:#FAFAF7;color:#1B1B1B;border-radius:8px;padding:30px 34px;font-family:Georgia,'Times New Roman',serif;font-size:13.5px;line-height:1.5;min-height:520px;outline:none;} .paper[contenteditable=true]{box-shadow:0 0 0 2px rgba(34,224,154,0.6);} .paper h1{font-size:22px;margin:0;font-weight:700;letter-spacing:.01em;} .paper .ct{font-size:12.5px;color:#555;margin-top:2px;} .paper h3{font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:#2F6B4F;border-bottom:1px solid #D9D9D0;padding-bottom:3px;margin:16px 0 6px;font-family:-apple-system,'Segoe UI',sans-serif;} .paper .jt{font-weight:700;} .paper .jm{color:#555;font-size:12.5px;} .paper ul{margin:4px 0 8px 18px;padding:0;} .paper li{margin:2px 0;} .paper mark{background:#E4F6EC;color:inherit;padding:0 2px;border-radius:2px;} .paper p{margin:0 0 10px;} .kit-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;} .kit-actions button{border-radius:9px;padding:9px 14px;font-size:13px;cursor:pointer;border:0.5px solid var(--bdr2);background:none;color:var(--t1);} .kit-actions .pri{background:var(--grn);color:#052e1e;border:none;font-weight:600;} .kit-side{border-left:0.5px solid var(--bdr);background:var(--card);padding:18px 16px;font-size:13px;color:var(--t2);line-height:1.5;} .kit-side h4{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--t3);margin:0 0 8px;} .kit-side ul{margin:0 0 16px 16px;padding:0;} .kit-side li{margin:4px 0;} .kit-side b{color:var(--t1);font-weight:600;} .kit-add{background:rgba(255,181,71,0.08);border:0.5px solid rgba(255,181,71,0.35);border-radius:10px;padding:10px 12px;margin-bottom:16px;} .kit-add a{color:#FFB547;} .kit-foot{font-size:12px;color:var(--t3);border-top:0.5px solid var(--bdr);padding-top:12px;} @media (max-width:820px){.kit{grid-template-columns:1fr;}.kit-side{border-left:none;border-top:0.5px solid var(--bdr);}.paper{padding:20px;}} .kit-blank{background:#FFF1D6;color:#7A4B00;border-radius:3px;padding:0 3px;font-style:italic;} .kit-need{font-size:10px;font-weight:700;border-radius:999px;padding:1px 6px;text-transform:uppercase;background:rgba(255,107,107,0.15);color:#FF8A8A;margin-left:4px;} .kit-tabn{color:#FFB547;} .kit-p{font-size:14px;color:var(--t2);line-height:1.6;margin:0 0 12px;max-width:560px;} .kit-p b{color:var(--t1);} .kit-cta{background:var(--grn);color:#052e1e;font-weight:600;border-radius:9px;padding:10px 16px;text-decoration:none;font-size:14px;} .kit-cta2{color:var(--t2);border:0.5px solid var(--bdr2);border-radius:9px;padding:10px 16px;text-decoration:none;font-size:14px;} #kitMsg{padding:6px 0 10px;} .kit.kit-msg{grid-template-columns:1fr;width:min(640px,100%);} .kit.kit-msg .kit-side{display:none;}";
  // --- Page wiring: the button the job page carries (#kitOpen), the panel, the profile -------
  var SUPABASE_URL = "https://iqcyofkosjopxsfdufvy.supabase.co";
  var ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";
  var FIELDS = "first_name,last_name,email,location,linkedin_url,headline,bio,skills,experience,education,years_experience,relocation";
  var SHELL =
    '<div class="kit-scrim" id="kitScrim" role="dialog" aria-modal="true" aria-label="Your application kit"><div class="kit">' +
    '<div class="kit-main"><div class="kit-top"><h2>Your application kit</h2><button class="kit-x" id="kitX" aria-label="Close">&#10005;</button></div>' +
    '<div id="kitBody"><div class="kit-tabs"><button class="kit-tab on" data-kt="r">Resume for this job</button><button class="kit-tab" data-kt="l">Cover letter</button></div>' +
    '<div class="paper" id="kitR"></div><div class="paper" id="kitL" hidden></div>' +
    '<div class="kit-actions"><button class="pri" id="kitWord">Download Word (.docx)</button><button id="kitEdit">Edit</button><button id="kitCopy">Copy text</button></div></div>' +
    '<div id="kitMsg" hidden></div></div>' +
    '<aside class="kit-side" id="kitSide"></aside></div></div>';
  function ensureShell() {
    if (document.getElementById("kitScrim")) return;
    var d = document.createElement("div"); d.innerHTML = SHELL; document.body.appendChild(d.firstChild);
  }
  function message(html, side) {
    ensureShell();
    document.getElementById("kitBody").hidden = true;
    var m = document.getElementById("kitMsg"); m.hidden = false; m.innerHTML = html;
    document.getElementById("kitSide").innerHTML = side || "";
    document.querySelector("#kitScrim .kit").classList.add("kit-msg");
    document.getElementById("kitScrim").classList.add("open"); document.body.style.overflow = "hidden";
  }
  async function loadCandidate() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem("vt_session") || "null"); } catch (e) {}
    if (!s || !s.candidate_id) return null;
    if (window.VTAlerts && window.VTAlerts.session) s = await window.VTAlerts.session();
    if (!s || !s.access_token) return null;
    var res = await fetch(SUPABASE_URL + "/rest/v1/candidates?id=eq." + encodeURIComponent(s.candidate_id) + "&select=" + FIELDS,
      { headers: { apikey: ANON_KEY, Authorization: "Bearer " + s.access_token } });
    if (!res.ok) return null;
    var rows = await res.json();
    return rows[0] || null;
  }
  async function start(btn) {
    var job = {};
    try { job = JSON.parse(document.getElementById("vt-job").textContent); } catch (e) {}
    window.VTKitJob = job;
    var body = document.querySelector(".desc-body");
    var label = btn.innerHTML; btn.disabled = true; btn.textContent = "Preparing…";
    var c = null;
    try { c = await loadCandidate(); } catch (e) {}
    btn.disabled = false; btn.innerHTML = label;
    if (!c) {
      track("job_kit_signed_out");
      return message('<p class="kit-p"><b>Get a resume tuned to this job, plus a cover letter to finish.</b></p>' +
        '<p class="kit-p">It\'s built from your Verde Talent profile: we put what this ad asks for first, show you what\'s worth adding, and fill in a cover letter for you. Free, and nothing is sent anywhere.</p>' +
        '<div class="kit-actions"><a class="kit-cta" href="/create-profile.html">Create your free profile &rarr;</a><a class="kit-cta2" href="/login.html">Sign in</a></div>');
    }
    var hasWork = (c.experience || []).some(function (e) { return e && e.title; }) || (c.skills || []).length;
    if (!hasWork) {
      return message('<p class="kit-p"><b>Add your work history first.</b></p><p class="kit-p">Your profile doesn\'t have any jobs or skills yet, so there\'s nothing to tailor. Upload your resume on your dashboard and we\'ll fill them in.</p>' +
        '<div class="kit-actions"><a class="kit-cta" href="/dashboard.html#profile">Go to my profile &rarr;</a></div>');
    }
    ensureShell();
    document.getElementById("kitMsg").hidden = true; document.getElementById("kitBody").hidden = false;
    document.querySelector("#kitScrim .kit").classList.remove("kit-msg");
    document.querySelectorAll("[data-kt]").forEach(function (x) { x.classList.toggle("on", x.dataset.kt === "r"); });
    document.getElementById("kitR").hidden = false; document.getElementById("kitL").hidden = true;
    open(job, c, body);
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("#kitOpen");
    if (b) { e.preventDefault(); start(b); }
  });

  (function () { var st = document.createElement("style"); st.textContent = KIT_CSS; document.head.appendChild(st); })();
  window.VTJobKit = { open: open, build: build };
})();
