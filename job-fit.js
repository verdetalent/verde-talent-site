// How well a job fits a candidate's profile - the match label on jobs.html cards - and the role
// matching the "What am I worth?" salary check uses to find comparable postings.
//
// The role rules are the same ones the job-alert emails use (supabase/functions/job-alerts-weekly,
// which ports taxonomy/job_category.py), so "Strong match" on a card means the same thing as "this
// would be in your alert email". Keep the three in step when the categories change.
//
// Everything runs in the browser from the candidate's own profile; nothing is sent anywhere.
// Pages call gtag only (never FullStory directly).
(function () {
  "use strict";
  // In a browser this is window; in the job-alert function (Deno) it's globalThis.
  var ROOT = typeof window !== "undefined" ? window : globalThis;
  if (ROOT.VTJobFit) return;
  var SUPABASE_URL = "https://iqcyofkosjopxsfdufvy.supabase.co";
  var ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";
  var CACHE_KEY = "vt_fit_profile";

  var JOB_CATEGORY_RULES = [
    ["Project/Program Management", [/\bproject manage/, /\bprogram manage/, /\bschedul(er|ing)\b/]],
    ["Engineering", [/\bengineer(ing)?\b/]],
    ["Construction/Field", [
      /\bconstruction\b/, /\bfield (service|technician)\b/, /\blineman\b/,
      /\btechnician\b/, /\binstall(er|ation)\b/, /\bsuperintendent\b/,
      /\bforeperson\b/, /\bforeman\b/,
      /\bwelder\b/, /\belectrician\b/, /\blaborer\b/, /\bmechanic\b/,
      /\bcarpenter\b/, /\bmillwright\b/, /\bcement mason\b/,
      /\bitinerant\b/, /\bmachinist\b/, /\brepair(er)?\b/,
      /\bestimat(or|ing)\b/, /\bdesign phase\b/, /\bpreconstruction\b/,
      /\bepc\b/,
    ]],
    ["Sales", [/\bsales\b/, /\baccount executive\b/, /\bbusiness development\b/, /\bappointment setter\b/]],
    ["Finance/Accounting", [
      /\bfinanc(e|ial)\b/, /\baccount(ant|ing)\b/, /\bfp&a\b/, /\btax\b/,
      /\baudit\b/, /\btreasury\b/, /\bcost control\b/,
    ]],
    ["Legal", [/\blegal\b/, /\bcounsel\b/, /\bcompliance\b/, /\bcontracts?\b/, /\bimmigration\b/]],
    ["Supply Chain/Procurement", [
      /\bsupply chain\b/, /\bprocurement\b/, /\bsourcing\b/, /\blogistics\b/,
      /\bwarehouse\b/, /\bmaterials?\b/, /\bbuyer\b/, /\bsupply planner\b/,
    ]],
    ["HR/Talent", [/\bhuman resources\b/, /\bhr\b/, /\btalent\b/, /\brecruit(er|ing|ment)\b/, /\bpeople\b/]],
    ["IT/Technology", [
      /\binformation technology\b/, /\bit support\b/, /\bsoftware\b/,
      /\bcyber\b/, /\bdata\b/, /\bnetwork\b/, /\bapplication(s)? develop/,
    ]],
    ["Marketing/Communications", [/\bmarketing\b/, /\bcommunications\b/, /\bbrand\b/, /\bpublic relations\b/]],
    ["Safety/EHS", [/\bsafety\b/, /\behs\b/, /\benvironmental\b/, /\bquality\b/]],
    ["Customer Service", [/\bcustomer (service|experience|success)\b/, /\bcall center\b/]],
    ["Real Estate/Land", [/\breal estate\b/, /\bland (manager|agent)\b/]],
    ["Manufacturing/Production", [/\bmanufactur/, /\bproduction\b/, /\bstock keeper\b/]],
    ["Operations", [/\boperations?\b/, /\boperator\b/, /\bo&m\b/, /\bplant manager\b/, /\bcommissioning\b/]],
    ["Development", [/\bdevelopment\b/]],
  ];
  var GENERIC_TITLE_WORDS = new Set([
    "senior", "sr", "junior", "jr", "lead", "principal", "staff", "associate", "assistant",
    "chief", "head", "entry", "level", "i", "ii", "iii", "iv", "v",
    "and", "of", "the", "a", "an", "to", "for", "in", "at", "with", "or", "open",
    "solar", "wind", "energy", "renewable", "renewables", "storage", "battery", "bess",
    "grid", "power", "clean", "ev", "hydrogen", "offshore", "onshore", "utility", "utilities", "pv",
    "remote", "hybrid", "onsite", "site", "based", "full", "part", "time", "contract", "temporary",
    "us", "usa", "north", "america", "new",
  ]);
  var TITLE_WORD_ALIASES = {
    tech: "technician", techs: "technician", mgr: "manager", engr: "engineer", eng: "engineer",
    admin: "administrator", coord: "coordinator",
  };

  function mapJobCategory(title) {
    var text = String(title || "").toLowerCase();
    if (!text) return null;
    for (var i = 0; i < JOB_CATEGORY_RULES.length; i++) {
      var rule = JOB_CATEGORY_RULES[i];
      if (rule[1].some(function (p) { return p.test(text); })) return rule[0];
    }
    return null;
  }
  function titleWords(title) {
    var words = new Set();
    String(title || "").toLowerCase().split(/[^a-z&]+/).forEach(function (w) {
      if (!w) return;
      w = TITLE_WORD_ALIASES[w] || w;
      if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
      if (!GENERIC_TITLE_WORDS.has(w)) words.add(w);
    });
    return words;
  }
  function roleFromTitle(title) { return { category: mapJobCategory(title), words: titleWords(title) }; }
  // Headline first (what they say they are), then their experience titles - as the alerts do.
  function candidateRole(c) {
    var h = roleFromTitle(c.headline);
    if (h.category) return h;
    var exp = Array.isArray(c.experience) ? c.experience : [];
    for (var i = 0; i < exp.length; i++) {
      var r = roleFromTitle(exp[i] && exp[i].title);
      if (r.category) return r;
    }
    if (h.words.size) return h;
    return roleFromTitle(exp[0] && exp[0].title);
  }
  // null = not the same kind of job; otherwise how many title words are shared.
  function roleScore(job, role) {
    if (!role.category && role.words.size === 0) return null;
    var jobWords = titleWords(job.job_title);
    var shared = 0;
    role.words.forEach(function (w) { if (jobWords.has(w)) shared++; });
    var plain = shared >= Math.min(2, role.words.size);
    if (role.category) {
      if (job.job_category === role.category) return shared;
      if (!job.job_category && plain) return shared;
      return null;
    }
    return plain ? shared : null;
  }

  function stateOf(text) {
    var m = String(text || "").match(/,\s*([A-Z]{2})\b/);
    return m ? m[1] : null;
  }
  function isRemote(job) { return job.work_style === "Remote" || job.is_remote === true || /\bremote\b/i.test(job.location || ""); }
  function list(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === "string" && v.trim().charAt(0) === "[") {
      try { return JSON.parse(v.replace(/'/g, '"')); } catch (e) { return []; }
    }
    return [];
  }

  // Skills: a job tag counts as theirs when one of their skills names it ("OSHA 30" covers
  // "OSHA"), or the other way round. A few common spellings are folded together.
  var SKILL_ALIASES = {
    "pe": "professional engineer", "pe license": "professional engineer", "primavera p6": "p6",
    "primavera": "p6", "bess": "energy storage systems", "bms": "battery management system", "esri arcgis": "arcgis",
  };
  function normSkill(s) {
    s = String(s || "").toLowerCase().replace(/[^a-z0-9/+#. ]+/g, " ").replace(/\s+/g, " ").trim();
    return SKILL_ALIASES[s] || s;
  }
  function hasWord(hay, needle) {
    if (needle.length < 2) return false;
    var esc = needle.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
    return new RegExp("(^|[^a-z0-9])" + esc + "($|[^a-z0-9])").test(hay);
  }
  function skillMatch(jobSkill, mine) {
    var j = normSkill(jobSkill);
    for (var i = 0; i < mine.length; i++) {
      var m = mine[i];
      if (m === j || hasWord(m, j) || (m.length >= 3 && hasWord(j, m))) return true;
    }
    return false;
  }

  // Years of experience (profile bucket) against the job's level. Unknown either side = no check.
  var LEVEL_FITS = {
    "Less than 1 year": ["Entry Level", "Individual Contributor"],
    "1–3 years": ["Entry Level", "Individual Contributor"],
    "3–5 years": ["Individual Contributor", "Manager+"],
    "5–10 years": ["Individual Contributor", "Manager+"],
    "10+ years": ["Individual Contributor", "Manager+", "Director+"],
  };

  var PROFILE = null;
  function prepare(c) {
    if (!c) return null;
    var role = candidateRole(c);
    return {
      role: role,
      hasRole: !!(role.category || role.words.size),
      sectors: new Set(list(c.sectors)),
      skills: list(c.skills).map(normSkill).filter(Boolean),
      state: stateOf(c.location),
      years: c.years_experience || null,
      payMin: Number(c.salary_min) || null,
      raw: c,
    };
  }

  // -> { level: 'strong' | 'good', reasons: [short labels], skills: {have, of} | null } or null.
  //   strong = your kind of role, in your sector(s), in your state or remote
  //   good   = your kind of role, and either your sector or your state/remote
  // A job above or below their experience level drops one step. Pay and skills are shown as
  // reasons but never decide the level - most postings list neither.
  function score(job, profile) {
    var p = profile || PROFILE;
    if (!p || !p.hasRole) return null;
    var shared = roleScore(job, p.role);
    if (shared === null) return null;
    // Stricter than the alerts: a label needs the job title to share a word with theirs
    // ("technician", "engineer"), not just the same broad role type - a wind technician isn't a
    // match for "Wind Carpenter" just because both are construction/field jobs.
    if (p.role.words.size && shared < 1) return null;
    var reasons = ["Your role"];
    var jobSectors = list(job.sector_buckets);
    var sectorHit = jobSectors.filter(function (s) { return p.sectors.has(s); });
    var sectorOk = !p.sectors.size || !jobSectors.length || sectorHit.length > 0;
    if (sectorHit.length) reasons.push(sectorHit[0]);
    var placeOk = false;
    if (isRemote(job)) { placeOk = true; reasons.push("Remote"); }
    else if (p.state && stateOf(job.location) === p.state) { placeOk = true; reasons.push("In " + p.state); }
    var levelOk = true;
    if (p.years && job.seniority_level && LEVEL_FITS[p.years]) {
      levelOk = LEVEL_FITS[p.years].indexOf(job.seniority_level) >= 0;
      if (levelOk) reasons.push("Experience level");
    }
    if (p.payMin && job.salary_annual_max && job.salary_annual_max >= p.payMin) reasons.push("Meets your pay");
    var skills = null;
    var jobSkills = list(job.skills);
    if (jobSkills.length && p.skills.length) {
      var have = jobSkills.filter(function (s) { return skillMatch(s, p.skills); }).length;
      skills = { have: have, of: jobSkills.length };
      if (have) reasons.push(have + " of " + jobSkills.length + " skills");
    }
    var level = null;
    if (sectorOk && placeOk) level = "strong";
    else if (sectorHit.length || placeOk) level = "good";
    if (!levelOk) level = level === "strong" ? "good" : null;
    if (!level) return null;
    return { level: level, reasons: reasons, skills: skills };
  }

  function readJson(k) { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch (e) { return null; } }
  // The signed-in candidate's profile - only the fields the match needs. Cached for 10 minutes in
  // this tab. Resolves null when signed out.
  async function loadProfile() {
    var s;
    try { s = JSON.parse(localStorage.getItem("vt_session") || "null"); } catch (e) { s = null; }
    if (!s || !s.candidate_id) return null;
    var cached = readJson(CACHE_KEY);
    if (cached && cached.id === s.candidate_id && Date.now() - cached.at < 600000) {
      PROFILE = prepare(cached.c);
      return PROFILE;
    }
    if (ROOT.VTAlerts && ROOT.VTAlerts.session) s = await window.VTAlerts.session();
    if (!s || !s.access_token) return null;
    try {
      var res = await fetch(SUPABASE_URL + "/rest/v1/candidates?id=eq." + encodeURIComponent(s.candidate_id) +
        "&select=headline,experience,sectors,skills,location,years_experience,salary_min", {
        headers: { apikey: ANON_KEY, Authorization: "Bearer " + s.access_token },
      });
      if (!res.ok) return null;
      var rows = await res.json();
      if (!rows.length) return null;
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ id: s.candidate_id, at: Date.now(), c: rows[0] })); } catch (e) {}
      PROFILE = prepare(rows[0]);
      return PROFILE;
    } catch (e) { return null; }
  }
  // A profile edit should show up straight away on the next search.
  function forget() { try { sessionStorage.removeItem(CACHE_KEY); } catch (e) {} PROFILE = null; }

  ROOT.VTJobFit = {
    loadProfile: loadProfile,
    forget: forget,
    prepare: prepare,
    score: score,
    profile: function () { return PROFILE; },
    roleFromTitle: roleFromTitle,
    roleScore: roleScore,
    mapJobCategory: mapJobCategory,
    stateOf: stateOf,
    list: list,
  };
})();
