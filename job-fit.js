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
    // Resume shorthand, so "Acct Exec" lines up with "Senior Account Executive".
    acct: "account", exec: "executive", rep: "representative", reps: "representative",
    ops: "operations", mgmt: "management", dir: "director", supv: "supervisor", supvr: "supervisor",
    spec: "specialist", svc: "service", svcs: "service", asst: "assistant", tchn: "technician",
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
  // The roles a candidate is matched on - the same rules as the alert emails: every job title on
  // their resume, most recent first. Headlines are often a tagline ("Passionate about the energy
  // transition"), so the headline only adds a role when it clearly names a job type (a career
  // changer's "Aspiring Solar Installer"), after their resume titles - or stands in when there is
  // no job history at all.
  var MAX_EXPERIENCE_ROLES = 15;
  function experienceEndYear(dates) {
    var d = String(dates || "").toLowerCase();
    if (/\b(present|current|now|today)\b/.test(d)) return 9999;
    var years = d.match(/\b(19|20)\d{2}\b/g);
    return years ? Math.max.apply(null, years.map(Number)) : null;
  }
  // Resume order (newest first) unless every entry has a year to sort by.
  function experienceTitles(c) {
    var exp = (Array.isArray(c.experience) ? c.experience : list(c.experience))
      .filter(function (e) { return e && String(e.title || "").trim(); });
    var ends = exp.map(function (e) { return experienceEndYear(e.dates); });
    if (ends.every(function (y) { return y !== null; })) {
      exp = exp.map(function (e, i) { return { e: e, i: i, y: ends[i] }; })
        .sort(function (a, b) { return b.y - a.y || a.i - b.i; })
        .map(function (x) { return x.e; });
    }
    return exp.map(function (e) { return String(e.title).trim(); });
  }
  function candidateRoles(c) {
    var roles = [];
    var seen = new Set();
    function add(role) {
      var key = role.category + "|" + Array.from(role.words).sort().join(" ");
      if (seen.has(key)) return;
      seen.add(key);
      roles.push(role);
    }
    var titles = experienceTitles(c);
    for (var i = 0; i < titles.length && roles.length < MAX_EXPERIENCE_ROLES; i++) {
      var r = roleFromTitle(titles[i]);
      if (r.category || r.words.size) add(r);
    }
    var h = roleFromTitle(c.headline);
    if (!roles.length) return [h];
    if (h.category) add(h);
    return roles;
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
      // Two shared title words outrank the job's filed category: "Strategic Account Executive,
      // Engineering and Construction" is filed under Engineering but is a sales job.
      if (shared >= 2) return shared;
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
    var roles = candidateRoles(c);
    return {
      roles: roles,
      role: roles[0],
      hasRole: roles.some(function (r) { return !!(r.category || r.words.size); }),
      sectors: new Set(list(c.sectors)),
      skills: list(c.skills).map(normSkill).filter(Boolean),
      state: stateOf(c.location),
      years: c.years_experience || null,
      payMin: Number(c.salary_min) || null,
      relocate: /^yes/i.test(String(c.relocation || "")),
      raw: c,
    };
  }

  // --- What's missing ("how to get there") ------------------------------------------------------
  // The other side of the reasons: what keeps a job from being a (stronger) match, each with the
  // one thing the candidate can do about it - add it to their profile if they already have it, or
  // the Training page section that teaches it. Only things we can actually check; never a guess.
  var TRAINING = "/professional-development.html";
  var SECTOR_TRAINING = {
    Solar: "#sector-solar", Wind: "#sector-wind", Storage: "#sector-storage", Grid: "#sector-grid",
    EV: "#sector-ev", Policy: "#sector-policy", Sustainability: "#sector-sustainability",
  };
  // Job skill tags the Training page has a course for.
  var SKILL_TRAINING = [
    [/^osha\b/, "OSHA 10 / 30", "#jobsite-safety"],
    [/^nabcep\b/, "NABCEP prep", "#sector-solar"],
    [/energy storage systems|battery management system/, "Battery storage courses", "#sector-storage"],
  ];
  var LEVEL_ORDER = ["Entry Level", "Individual Contributor", "Manager+", "Director+"];
  function money(n) { return "$" + Math.round(n / 1000) + "k"; }
  var PROFILE_LINK = "/dashboard.html#profile";

  // -> [{ kind, short (card chip), text (job page), fixes: [{label, href}] }]
  function gaps(job, profile) {
    var p = profile || PROFILE;
    if (!p || !p.hasRole) return [];
    var out = [];
    var jobSectors = list(job.sector_buckets);
    if (jobSectors.length) {
      var s = jobSectors[0];
      var fixes = [{ label: "Worked in " + s + "? Add it to your profile", href: PROFILE_LINK }];
      if (SECTOR_TRAINING[s]) fixes.push({ label: s + " training", href: TRAINING + SECTOR_TRAINING[s] });
      if (!p.sectors.size) {
        out.push({ kind: "sector", short: "Add your sectors", text: "Your profile doesn't list any sectors yet, so we can't check this " + s + " job against them.", fixes: fixes });
      } else if (!jobSectors.some(function (x) { return p.sectors.has(x); })) {
        out.push({ kind: "sector", short: s + " not on profile", text: s + " isn't one of the sectors on your profile.", fixes: fixes });
      }
    }
    if (!isRemote(job)) {
      var js = stateOf(job.location);
      if (js && !p.state) {
        out.push({ kind: "place", short: "Add your location", text: "This job is on-site in " + js + ", and your profile has no location to compare.", fixes: [{ label: "Add your location", href: PROFILE_LINK }] });
      } else if (js && p.state && js !== p.state) {
        out.push(p.relocate
          ? { kind: "place", short: "On-site in " + js, text: "On-site in " + js + ". You're in " + p.state + ", but your profile says you're open to relocating.", fixes: [] }
          : { kind: "place", short: "On-site in " + js, text: "On-site in " + js + ", and you're in " + p.state + ".", fixes: [{ label: "Open to moving? Tell employers in your preferences", href: "/dashboard.html#preferences" }] });
      }
    }
    if (p.years && job.seniority_level && LEVEL_FITS[p.years] && LEVEL_FITS[p.years].indexOf(job.seniority_level) < 0) {
      var fitsTop = Math.max.apply(null, LEVEL_FITS[p.years].map(function (l) { return LEVEL_ORDER.indexOf(l); }));
      var above = LEVEL_ORDER.indexOf(job.seniority_level) > fitsTop;
      out.push({ kind: "level", short: above ? "More senior role" : "More junior role",
        text: (above ? "A " + job.seniority_level + " role - more senior than your " : "An " + job.seniority_level + " role - junior for your ") + p.years + " of experience.",
        fixes: [{ label: "Experience years wrong? Update them", href: PROFILE_LINK }] });
    }
    if (p.payMin && job.salary_annual_max && job.salary_annual_max < p.payMin) {
      out.push({ kind: "pay", short: "Under your pay", text: "Pays up to " + money(job.salary_annual_max) + ", under your " + money(p.payMin) + " minimum.", fixes: [] });
    }
    var jobSkills = list(job.skills);
    if (jobSkills.length) {
      if (!p.skills.length) {
        out.push({ kind: "skills", short: "Add your skills", text: "This job asks for " + jobSkills.join(", ") + ". Add your skills to see which you have.", fixes: [{ label: "Add your skills", href: PROFILE_LINK }] });
      } else {
        var missing = jobSkills.filter(function (s) { return !skillMatch(s, p.skills); });
        if (missing.length) {
          var sf = [{ label: "Have " + (missing.length > 1 ? "them" : "it") + "? Add to your profile", href: PROFILE_LINK }];
          var seen = {};
          missing.forEach(function (m) {
            var n = normSkill(m);
            SKILL_TRAINING.forEach(function (t) {
              if (t[0].test(n) && !seen[t[1]]) { seen[t[1]] = 1; sf.push({ label: t[1], href: TRAINING + t[2] }); }
            });
          });
          out.push({ kind: "skills", short: "Missing " + missing[0] + (missing.length > 1 ? " +" + (missing.length - 1) : ""),
            text: "Not on your profile: " + missing.join(", ") + ".", fixes: sf });
        }
      }
    }
    return out;
  }
  // Why a job isn't a match at all when the role is the reason: "This is a Sales role; your
  // experience is in Engineering." null when the role fits (gaps() then explains the rest).
  function roleMiss(job, profile) {
    var p = profile || PROFILE;
    if (!p || !p.hasRole) return null;
    var fits = (p.roles || [p.role]).some(function (role) {
      var shared = roleScore(job, role);
      return shared !== null && !(role.words.size && shared < 1);
    });
    if (fits) return null;
    var cat = job.job_category || mapJobCategory(job.job_title);
    var mine = p.role && p.role.category;
    return { jobCategory: cat || null, yourCategory: mine || null };
  }

  // -> { level: 'strong' | 'good', reasons: [short labels], skills: {have, of} | null } or null.
  //   strong = your kind of role, in your sector(s), in your state or remote
  //   good   = your kind of role, and either your sector or your state/remote
  // A job above or below their experience level drops one step. Pay and skills are shown as
  // reasons but never decide the level - most postings list neither.
  function score(job, profile) {
    var p = profile || PROFILE;
    if (!p || !p.hasRole) return null;
    // Stricter than the alerts: a label needs the job title to share a word with one of theirs
    // ("technician", "engineer"), not just the same broad role type - a wind technician isn't a
    // match for "Wind Carpenter" just because both are construction/field jobs. Any of their
    // roles counts (every resume title, plus a headline that names a job).
    var fits = (p.roles || [p.role]).some(function (role) {
      var shared = roleScore(job, role);
      return shared !== null && !(role.words.size && shared < 1);
    });
    if (!fits) return null;
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
        "&select=headline,experience,sectors,skills,location,years_experience,salary_min,relocation", {
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
    gaps: gaps,
    roleMiss: roleMiss,
    profile: function () { return PROFILE; },
    roleFromTitle: roleFromTitle,
    roleScore: roleScore,
    mapJobCategory: mapJobCategory,
    stateOf: stateOf,
    list: list,
  };
})();
