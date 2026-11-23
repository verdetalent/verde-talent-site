// Job pages: resume check, marked inside the ad itself. Things the posting asks for
// (certifications, tools, safety programs, equipment, years) get a green check when the signed-in
// candidate's profile shows them, and an amber underline when it doesn't - tap one to add it to the
// profile or find the training. One key line above the description; nothing else on the page.
// Runs in the browser from the page's own description and the profile job-fit.js already loads.
// window.VTResumeCheck.analyze() is the same analysis without touching the page: job-page-fit.js
// uses it for the match box's skills line. Pages call gtag only.
(function () {
  "use strict";
  var TRAIN = "/professional-development.html";
  var MIN_TERMS = 3;   // fewer things than this in the ad and the check stays off - a "1 of 2" says nothing
  // `v` = ways to write it; a posting and a profile match when any variant appears in both.
  // add: where the fix link sends them. cert: a credential ("Have it?"). train: [label, Training anchor].
  var TERMS = [
    // Field / O&M
    { id: "om", label: "Solar O&M", v: [/\bo&m\b/, /operations? (and|&) maintenance/], gate: /solar|\bpv\b/, add: "experience" },
    { id: "pm", label: "Preventive maintenance", v: [/prevent(at)?ive maintenance/], add: "experience" },
    { id: "cm", label: "Corrective maintenance", v: [/corrective maintenance/], add: "experience" },
    { id: "ts", label: "Troubleshooting", v: [/troublesho(ot|oting|ots|t)\b/, /fault[- ]find/], add: "experience" },
    { id: "inv", label: "Inverters", v: [/\binverters?\b/], add: "experience" },
    { id: "trk", label: "Trackers", v: [/\btracker systems?\b|\btrackers\b|\b(solar|single[- ]axis) trackers?\b/], add: "experience" },
    { id: "sub", label: "Substations", v: [/\bsub-?stations?\b/], add: "experience" },
    { id: "brand", label: "Equipment brands", v: [/\b(tmeic|sungrow|nextracker|array technologies|power electronics|solaredge|enphase|huawei|fimer|gamesa|vestas|nordex|ge vernova|fluence|tesla megapack)\b/], brand: true },
    { id: "dmm", label: "Multimeter", v: [/multi-?meters?/, /\bdmm\b/, /\bfluke\b/], add: "skills" },
    { id: "meg", label: "Megger / insulation testing", v: [/\bmeggers?\b/, /insulation resistance/], add: "skills" },
    { id: "clamp", label: "Clamp meter", v: [/amp clamps?/, /clamp meters?/], add: "skills" },
    { id: "loto", label: "Lockout/tagout (LOTO)", v: [/\bloto\b/, /lock ?out[ \/-]*tag ?out/], add: "skills" },
    { id: "jha", label: "Job hazard analysis (JHA)", v: [/\bjha\b/, /job hazard analys[ie]s/, /\bjsa\b/, /job safety analys[ie]s/], add: "skills" },
    { id: "fall", label: "Fall protection", v: [/fall protection/, /fall arrest/], add: "skills" },
    { id: "lift", label: "Aerial lifts", v: [/aerial lifts?/, /\bmewps?\b/, /boom lifts?/, /scissor lifts?/], add: "skills", cert: true },
    { id: "fork", label: "Forklift", v: [/fork ?lifts?/, /\btelehandlers?\b/], add: "skills", cert: true },
    { id: "rig", label: "Rigging", v: [/\brigging\b/, /\briggers?\b/], add: "skills" },
    { id: "cs", label: "Confined space", v: [/confined[- ]space/], add: "skills" },
    { id: "weld", label: "Welding", v: [/\bweld(ing|er|ers)?\b/], add: "skills" },
    { id: "osha", label: "OSHA training", v: [/\bosha\b/], add: "skills", cert: true, train: ["OSHA 10 / 30", "#jobsite-safety"] },
    { id: "70e", label: "NFPA 70E", v: [/\bnfpa ?70e\b/, /arc[- ]flash/], add: "skills", cert: true, train: ["NFPA 70E courses", "#jobsite-safety"] },
    { id: "nec", label: "National Electrical Code (NEC)", v: [/\bnec\b/, /national electrical code/], add: "skills" },
    { id: "nabcep", label: "NABCEP", v: [/\bnabcep\b/], add: "skills", cert: true, train: ["NABCEP prep", "#sector-solar"] },
    { id: "gwo", label: "GWO", v: [/\bgwo\b/, /global wind organi[sz]ation/], add: "skills", cert: true, train: ["GWO courses", "#sector-wind"] },
    { id: "neta", label: "NETA certification", v: [/\bneta\b/], add: "skills", cert: true },
    { id: "cpr", label: "CPR / First Aid", v: [/\bcpr\b/, /first[- ]aid/], add: "skills", cert: true },
    { id: "mv", label: "Medium / high voltage", v: [/medium[- ]voltage/, /high[- ]voltage/], add: "experience" },
    { id: "scada", label: "SCADA", v: [/\bscada\b/], add: "skills" },
    { id: "plc", label: "PLCs", v: [/\bplcs?\b/, /programmable logic/], add: "skills" },
    { id: "bess", label: "Battery storage (BESS)", v: [/\bbess\b/, /battery (energy )?storage/], add: "experience" },
    { id: "ev", label: "EV chargers", v: [/\bevse\b/, /\bev charg(er|ers|ing)\b/, /electric vehicle charg/], add: "experience" },
    { id: "wo", label: "Work orders / CMMS", v: [/work orders?/, /\bcmms\b/, /\bmaximo\b/], add: "experience" },
    { id: "jour", label: "Journeyman license", v: [/journeyman/], add: "skills", cert: true },
    { id: "master", label: "Master electrician license", v: [/master electrician/], add: "skills", cert: true },
    { id: "cdl", label: "CDL", v: [/(?<!non[- ]?)\bcdl\b/, /commercial driver/], add: "skills", cert: true },
    { id: "epa", label: "EPA 608", v: [/\bepa 608\b/, /section 608/], add: "skills", cert: true },
    { id: "schem", label: "Reading schematics / blueprints", v: [/\bschematics?\b/, /\bblue ?prints?\b/, /one-line diagrams?|single[- ]line diagrams?/], add: "skills" },
    { id: "hyd", label: "Hydraulic systems", v: [/\bhydraulics?\b/], add: "experience" },
    { id: "climb", label: "Tower climbing / work at heights", v: [/\bclimb(ing)?( wind)? (towers?|turbines?|poles?)/, /tower climb/, /work(ing)? at heights?/], add: "experience" },
    { id: "heavy", label: "Heavy equipment", v: [/heavy equipment/, /\b(dozers?|excavators?|backhoes?|skid[- ]steers?|bobcats?)\b/], add: "skills" },
    { id: "line", label: "Line work", v: [/\blinem[ae]n\b/, /\blineworkers?\b/, /overhead (distribution |transmission )?lines?/, /distribution lines/], add: "experience" },
    { id: "comm", label: "Commissioning", v: [/\bcommission(ing|ed)\b/], add: "experience" },
    { id: "mentor", label: "Training / mentoring others", v: [/\bmentor(s|ed|ing)?\b/, /\btrain(ed|ing)? (new|junior|laborers|apprentices|techs|technicians|crew)/], add: "experience" },
    // Engineering / office tools and credentials
    { id: "pe", label: "PE license", v: [/professional engineer(ing)? (licen[cs]e|registration)/, /\bp\.?e\.? (licen[cs]e|licensure|stamp|registration)/, /licensed professional engineer/], add: "skills", cert: true },
    { id: "eit", label: "EIT / FE", v: [/\beit\b/, /engineer[- ]in[- ]training/, /\bfe exam\b/], add: "skills", cert: true },
    { id: "pmp", label: "PMP", v: [/\bpmp\b/], add: "skills", cert: true },
    { id: "cad", label: "AutoCAD", v: [/\bautocad\b/, /\bcad\b/], add: "skills" },
    { id: "pvsyst", label: "PVsyst", v: [/\bpvsyst\b/], add: "skills" },
    { id: "helio", label: "HelioScope", v: [/\bhelioscope\b/], add: "skills" },
    { id: "etap", label: "ETAP", v: [/\betap\b/], add: "skills" },
    { id: "psse", label: "PSS/E", v: [/\bpss\/?e\b/], add: "skills" },
    { id: "pscad", label: "PSCAD", v: [/\bpscad\b/], add: "skills" },
    { id: "gis", label: "GIS", v: [/\barcgis\b/, /\bgis\b/], add: "skills" },
    { id: "revit", label: "Revit", v: [/\brevit\b/], add: "skills" },
    { id: "sw", label: "SolidWorks", v: [/\bsolidworks\b/], add: "skills" },
    { id: "matlab", label: "MATLAB", v: [/\bmatlab\b/], add: "skills" },
    { id: "python", label: "Python", v: [/\bpython\b/], add: "skills" },
    { id: "sql", label: "SQL", v: [/\bsql\b/], add: "skills" },
    { id: "excel", label: "Excel", v: [/\b(ms|microsoft) excel\b/, /\bexcel (spreadsheets?|skills|models?|modell?ing|proficiency)\b/, /\b(advanced|proficien\w*( in| with)?|strong|knowledge of|experience (in|with)) (ms |microsoft )?excel\b/], add: "skills" },
    { id: "pbi", label: "Power BI", v: [/\bpower ?bi\b/], add: "skills" },
    { id: "sf", label: "Salesforce", v: [/\bsalesforce\b/], add: "skills" },
    { id: "sap", label: "SAP", v: [/(?<![“"'])\bsap\b(?![”"'])/], add: "skills" },
    { id: "p6", label: "Primavera P6", v: [/\bprimavera\b/, /\bp6\b/], add: "skills" },
    { id: "msp", label: "Microsoft Project", v: [/\b(ms|microsoft) project\b/], add: "skills" },
    { id: "nerc", label: "NERC standards", v: [/\bnerc\b/], add: "skills" },
    { id: "ix", label: "Interconnection", v: [/\binterconnections?\b/], add: "experience" },
    { id: "spanish", label: "Spanish", v: [/\bbilingual\b/, /(fluent|fluency|native|speak|speaking|proficien\w*|advanced|conversational|written|spoken)( level)?( in)? spanish/, /spanish[- ](speaking|language|is a plus|preferred|required|fluency|skills)/, /spanish (and|&|or) english|english (and|&|or) spanish/], add: "skills" },
  ];
  var BRAND_NAMES = { tmeic: "TMEIC", sungrow: "Sungrow", nextracker: "Nextracker", solaredge: "SolarEdge", enphase: "Enphase",
    huawei: "Huawei", fimer: "FIMER", gamesa: "Gamesa", vestas: "Vestas", nordex: "Nordex", fluence: "Fluence" };
  var PREFERRED = /\b(preferred|a plus|nice to have|bonus|desired|desirable|ideally|advantageous|an asset|an advantage)\b|\(plus\)/;
  var REQUIRED = /\b(must|required|requires|minimum|mandatory)\b/;
  // EEO / benefits / pay boilerplate and the company's own blurb never name a requirement.
  var SKIP = /equal opportunity|equal employment|discriminat|benefits package|401\(?k|pay range|salary range|compensation range|we offer|learn more about|is a leading|is one of the|founded in|wholly owned|subsidiary|end markets|our mission|headquartered|privacy (notice|policy)|reasonable accommodation|e-verify|background check|may also be assigned|other duties as assigned|signing bonus|sign-on bonus/;
  // A short line on its own ("Qualifications:", "**What you'll bring**") starts a section.
  var REQ_HEAD = /qualif|requirement|skills|experience|you have|you bring|you'?ll need|we'?re looking for|looking for|ideal candidate|preferred|certif|licen[cs]|physical|work environment|working conditions|education|must[- ]have|nice to have|bonus|competenc|knowledge/;
  var OTHER_HEAD = /about (us|the company|[a-z]+ [a-z]+:?$)|^about\b|benefit|compensation|perks|why (join|work)|who we are|equal|salary|\bpay\b|our (company|team|mission|values|culture)|what we offer|life at|diversity/;
  var YEARS_RE = /(\d{1,2})\s*\+?\s*(?:years?|yrs)['’]?\s+(?:of\s+)?(?:relevant\s+|related\s+|hands-on\s+|professional\s+|progressive\s+|industry\s+)?experience/i;
  var YEARS_MIN = { "Less than 1 year": 0, "1–3 years": 1, "3–5 years": 3, "5–10 years": 5, "10+ years": 10 };

  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function track(n, p) { try { if (typeof gtag === "function") gtag("event", n, p || {}); } catch (e) {} }
  // Everything the candidate wrote, as one lowercase string: headline, bio, skills, every field of
  // every job and school entry (titles, companies, bullets, degree, certificates...).
  function profileText(c) {
    var parts = [];
    (function walk(v) {
      if (v == null) return;
      if (typeof v === "string") parts.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === "object") Object.keys(v).forEach(function (k) { walk(v[k]); });
    })([c.headline, c.bio, c.skills, c.experience, c.education]);
    return parts.join(" \n ").toLowerCase();
  }
  function textOf(el) { return String(el.textContent || "").replace(/\s+/g, " ").trim(); }
  function isHeading(el) {
    if (el.tagName !== "P") return false;
    var t = textOf(el);
    if (!t || t.length > 70) return false;
    var strong = el.querySelector("strong,b");
    return /:$/.test(t) || (strong && textOf(strong) === t);
  }
  // The blocks of the ad that can hold a requirement, each with the section it sits in.
  // Bullets anywhere except benefits/company sections; paragraphs only under a requirements-type
  // heading or when they say "required"/"preferred" themselves. An ad with no bullets at all: every
  // paragraph that isn't boilerplate.
  function blocks(body) {
    var out = [], section = "", kind = "neutral";
    var hasList = body.querySelectorAll("li").length >= 3;
    Array.prototype.forEach.call(body.querySelectorAll("p, li"), function (el) {
      if (el.tagName === "P" && el.querySelector("li")) return;
      var low = textOf(el).toLowerCase();
      if (isHeading(el)) {
        section = low;
        kind = OTHER_HEAD.test(low) ? "other" : REQ_HEAD.test(low) ? "req" : "neutral";
        return;
      }
      if (!low || SKIP.test(low) || kind === "other") return;
      var take = el.tagName === "LI" || !hasList || kind === "req" || REQUIRED.test(low) || PREFERRED.test(low);
      if (take) out.push({ el: el, low: low, section: section });
    });
    return out;
  }

  // The resume check without touching the page: which things the ad asks for, whether the
  // profile shows each, and whether the ad calls each required or preferred.
  function analyze(body, c) {
    var me = c ? profileText(c) : "";
    var bl = blocks(body);
    var allText = bl.map(function (b) { return b.low; }).join(" \n ");
    var status = {}, need = {}, brand = null;
    TERMS.forEach(function (t) {
      if (t.gate && !t.gate.test(allText)) return;
      if (!t.v.some(function (re) { return re.test(allText); })) return;
      if (t.brand) {
        // A brand only counts when it's one they've worked on - never marked as missing.
        var asked = {};
        (allText.match(new RegExp(t.v[0].source, "g")) || []).forEach(function (b) { asked[b] = 1; });
        Object.keys(asked).some(function (b) { if (me.indexOf(b) >= 0) { brand = b; return true; } return false; });
        return;
      }
      status[t.id] = t.v.some(function (re) { return re.test(me); }) ? "have" : "miss";
      bl.some(function (b) {
        if (!t.v.some(function (re) { return re.test(b.low); })) return false;
        var ctx = b.low + " " + b.section;
        need[t.id] = PREFERRED.test(ctx) ? "Preferred" : REQUIRED.test(ctx) ? "Required" : "";
        return true;
      });
    });
    var ids = Object.keys(status);
    var have = ids.filter(function (k) { return status[k] === "have"; });
    var miss = ids.filter(function (k) { return status[k] === "miss"; });
    return {
      blocks: bl, status: status, need: need, brand: brand,
      have: have.length + (brand ? 1 : 0), total: ids.length + (brand ? 1 : 0),
      missing: miss, ok: ids.length + (brand ? 1 : 0) >= MIN_TERMS,
      reqText: allText,
    };
  }

  var CSS =
    ".rk-key{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:12.5px;color:var(--t2,rgba(255,255,255,.65));margin:0 0 14px;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,0.03);border:0.5px solid rgba(255,255,255,0.08);scroll-margin-top:90px;}" +
    ".rk-key b{color:var(--t1,#fff);font-weight:600;}" +
    ".rk-key .rk-h{color:var(--grn,#22E09A);}" +
    ".rk-key .rk-m{border-bottom:1.5px dashed var(--amb,#FFB547);color:var(--t1,#fff);}" +
    ".rk-key .rk-x{margin-left:auto;background:none;border:0;color:var(--t3,rgba(255,255,255,.4));font:inherit;font-size:12px;cursor:pointer;padding:0;}" +
    ".rk-key .rk-x:hover{color:var(--t1,#fff);}" +
    "mark.rk{background:none;color:inherit;padding:0;}" +
    "mark.rk-h::after{content:'\\2713';color:var(--grn,#22E09A);font-weight:700;font-size:.85em;margin-left:2px;}" +
    "mark.rk-m{border-bottom:1.5px dashed var(--amb,#FFB547);cursor:pointer;}" +
    "mark.rk-m:hover,mark.rk-m.on{background:rgba(255,181,71,0.12);border-radius:3px;}" +
    ".desc-body.rk-off mark.rk-m{border-bottom:0;cursor:auto;background:none;}" +
    ".desc-body.rk-off mark.rk-h::after{content:none;}" +
    ".rk-pop{position:absolute;z-index:50;max-width:290px;background:#16191d;border:0.5px solid rgba(255,181,71,0.45);border-radius:12px;padding:11px 13px;box-shadow:0 10px 30px rgba(0,0,0,.45);font-size:13px;color:var(--t2,rgba(255,255,255,.7));line-height:1.45;}" +
    ".rk-pop[hidden]{display:none;}" +
    ".rk-pt{font-weight:700;color:var(--t1,#fff);margin-bottom:3px;display:flex;align-items:center;gap:8px;}" +
    ".rk-need{font-size:10px;font-weight:700;border-radius:999px;padding:1px 7px;text-transform:uppercase;letter-spacing:.03em;background:rgba(255,107,107,0.15);color:#FF8A8A;}" +
    ".rk-need.p{background:rgba(255,255,255,0.07);color:var(--t2,rgba(255,255,255,.6));}" +
    ".rk-fix{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:9px;}" +
    ".rk-fix a{font-size:12.5px;font-weight:600;color:var(--grn,#22E09A);text-decoration:none;border:0.5px solid rgba(34,224,154,0.35);border-radius:999px;padding:3px 11px;}" +
    ".rk-fix a:hover{background:rgba(34,224,154,0.1);}" +
    ".rk-fix a.train{color:var(--amb,#FFB547);border-color:rgba(255,181,71,0.4);}" +
    ".rk-fix a.train:hover{background:rgba(255,181,71,0.1);}";

  function strip(re) { return re.source.replace(/\((?!\?)/g, "(?:"); }

  function render(body, c, a) {
    var byId = {};
    TERMS.forEach(function (t) { byId[t.id] = t; });
    // One regex over every variant of every term the ad asks for (plus "N+ years ... experience").
    var parts = [];
    Object.keys(a.status).forEach(function (id) {
      byId[id].v.forEach(function (re) { parts.push({ id: id, src: strip(re) }); });
    });
    if (a.brand) parts.push({ id: "brand", src: a.brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") });
    var mineY = YEARS_MIN[c.years_experience];
    var big = new RegExp(parts.map(function (p) { return "(" + p.src + ")"; }).join("|") + "|(" + strip(YEARS_RE) + ")", "gi");
    a.blocks.forEach(function (b) {
      var inBlock = {};   // each thing marked once per bullet ("LOTO" after "Lock Out Tag Out" stays plain)
      var walker = document.createTreeWalker(b.el, NodeFilter.SHOW_TEXT, null);
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(function (node) {
        var text = node.nodeValue, m, last = 0, frag = null;
        big.lastIndex = 0;
        while ((m = big.exec(text))) {
          if (!m[0]) { big.lastIndex++; continue; }
          var gi = -1;
          for (var g = 1; g < m.length; g++) if (m[g] !== undefined) { gi = g - 1; break; }
          var cls, id;
          if (gi === parts.length) {
            if (mineY == null) continue;
            cls = mineY >= +(m[0].match(/\d+/) || [0])[0] ? "rk-h" : "rk-m"; id = "years";
          } else {
            id = parts[gi].id;
            cls = id === "brand" || a.status[id] === "have" ? "rk-h" : "rk-m";
          }
          if (inBlock[id]) continue;
          inBlock[id] = 1;
          if (!frag) frag = document.createDocumentFragment();
          frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          var mk = document.createElement("mark");
          mk.className = "rk " + cls;
          mk.dataset.rk = id;
          if (id === "years" && cls === "rk-m") mk.dataset.n = (m[0].match(/\d+/) || [0])[0];
          if (cls === "rk-m") { mk.tabIndex = 0; mk.setAttribute("role", "button"); }
          else mk.title = "On your profile";
          mk.textContent = m[0];
          frag.appendChild(mk);
          last = m.index + m[0].length;
        }
        if (frag) {
          frag.appendChild(document.createTextNode(text.slice(last)));
          node.parentNode.replaceChild(frag, node);
        }
      });
    });

    var st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
    var key = document.createElement("div");
    key.className = "rk-key";
    key.id = "resume-check";
    key.innerHTML = '<span><b>Resume check:</b> your profile shows <b>' + a.have + " of " + a.total + "</b> things this ad asks for</span>" +
      '<span class="rk-h">&#10003; on your profile</span><span><span class="rk-m">underlined</span> = not yet, tap to add</span>' +
      '<button type="button" class="rk-x">Hide marks</button>';
    var title = document.querySelector(".desc-title");
    (title || body).insertAdjacentElement(title ? "afterend" : "beforebegin", key);

    var pop = document.createElement("div");
    pop.className = "rk-pop";
    pop.hidden = true;
    document.body.appendChild(pop);
    var current = null;
    function hide() { pop.hidden = true; if (current) current.classList.remove("on"); current = null; }
    key.querySelector(".rk-x").addEventListener("click", function () {
      var off = body.classList.toggle("rk-off");
      this.textContent = off ? "Show marks" : "Hide marks";
      hide();
      track("resume_check_toggle", { on: !off });
    });
    function show(mk) {
      var id = mk.dataset.rk;
      if (body.classList.contains("rk-off")) return;
      if (current) current.classList.remove("on");
      current = mk; mk.classList.add("on");
      var html;
      if (id === "years") {
        html = '<div class="rk-pt">' + esc(mk.dataset.n) + "+ years of experience</div>" +
          "Your profile says " + esc(c.years_experience || "nothing yet") + ". Related work counts too: military, trades, internships." +
          '<div class="rk-fix"><a href="/dashboard.html#experience" data-rk-fix="years">Add related experience &rarr;</a></div>';
      } else {
        var t = byId[id];
        var n = a.need[id];
        html = '<div class="rk-pt">' + esc(t.label) + (n ? '<span class="rk-need' + (n === "Preferred" ? " p" : "") + '">' + n + "</span>" : "") + "</div>" +
          "Not on your profile yet." +
          '<div class="rk-fix"><a href="/dashboard.html#' + (t.add === "skills" ? "profile" : "experience") + '" data-rk-fix="' + id + '">' +
          (t.cert ? "Have it? Add it to your skills" : t.add === "skills" ? "Used it? Add it to your skills" : "Done this? Add it to your experience") + " &rarr;</a>" +
          (t.train ? '<a class="train" href="' + TRAIN + t.train[1] + '" data-rk-train="' + id + '">Get it: ' + esc(t.train[0]) + " &rarr;</a>" : "") +
          "</div>";
      }
      pop.innerHTML = html + '<div style="font-size:11.5px;color:var(--t3,rgba(255,255,255,.4));margin-top:9px">Only add what&rsquo;s true &ndash; employers see your profile.</div>';
      pop.hidden = false;
      var r = mk.getBoundingClientRect();
      var w = Math.min(290, window.innerWidth - 32);
      pop.style.maxWidth = w + "px";
      pop.style.left = Math.max(16, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - w - 16)) + "px";
      pop.style.top = (r.bottom + window.scrollY + 8) + "px";
      track("resume_check_open", { item: id });
    }
    body.addEventListener("click", function (e) {
      var mk = e.target.closest("mark.rk-m");
      if (mk) { e.stopPropagation(); show(mk); }
    });
    body.addEventListener("keydown", function (e) {
      var mk = e.target.closest && e.target.closest("mark.rk-m");
      if (mk && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); show(mk); }
      if (e.key === "Escape") hide();
    });
    document.addEventListener("click", function (e) { if (!pop.hidden && !pop.contains(e.target)) hide(); });
    pop.addEventListener("click", function (e) {
      var l = e.target.closest("a");
      if (!l) return;
      if (l.dataset.rkFix) track("resume_check_fix_click", { item: l.dataset.rkFix });
      else if (l.dataset.rkTrain) track("resume_check_training_click", { item: l.dataset.rkTrain });
    });
    track("resume_check_shown", { have: a.have, of: a.total });
  }

  function cachedCandidate() {
    try { return (JSON.parse(sessionStorage.getItem("vt_fit_profile") || "null") || {}).c || null; } catch (e) { return null; }
  }
  // The page's own analysis, computed once (job-page-fit.js asks for it too).
  var RESULT;
  function pageResult() {
    if (RESULT !== undefined) return RESULT;
    var body = document.querySelector(".desc-body");
    var c = cachedCandidate();
    RESULT = body && c ? analyze(body, c) : null;
    return RESULT;
  }

  async function run() {
    if (!window.VTJobFit || !window.VTJobFit.loadProfile) return;
    var p = await window.VTJobFit.loadProfile();
    if (!p) return;
    var a = pageResult();
    if (a && a.ok) render(document.querySelector(".desc-body"), cachedCandidate(), a);
  }

  window.VTResumeCheck = { analyze: analyze, result: pageResult, TERMS: TERMS };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
