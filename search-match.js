// Saved-search matching, shared by the site (/search-match.js) and the job-alerts email function.
//
// A saved search is the filter state of jobs.html at the moment the candidate pressed
// "Get alerts for this search". This file turns that state into a stored "criteria" object,
// describes it in words, and decides whether a job matches it - using the same rules as the
// filter in jobs.html's render(), except the "Date posted" filter (alerts only ever send jobs
// that are new since the last email, so it doesn't apply).
//
// The SAME file is copied to supabase/functions/job-alerts-weekly/search-match.js. Keep the two
// identical (tests/test_search_match_copies.py in renewable-energy-jobs checks they are).
// Plain script, no imports/exports: in a browser it sets window.VTSearchMatch, in the Deno
// function `import "./search-match.js"` sets globalThis.VTSearchMatch.
(function (root) {
  "use strict";

  var CRITERIA_VERSION = 1;
  var SALARY_MINS = { "40k": 40000, "60k": 60000, "80k": 80000, "100k": 100000, "150k": 150000 };

  var ZIP3_STATE_RANGES = [
    [6, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"],
    [50, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"],
    [150, 196, "PA"], [197, 199, "DE"], [200, 205, "DC"], [206, 219, "MD"],
    [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"],
    [300, 319, "GA"], [320, 349, "FL"], [350, 369, "AL"], [370, 385, "TN"],
    [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"],
    [460, 479, "IN"], [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"],
    [550, 567, "MN"], [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"],
    [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"],
    [700, 714, "LA"], [716, 729, "AR"], [730, 749, "OK"], [750, 799, "TX"],
    [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"],
    [850, 865, "AZ"], [870, 884, "NM"], [889, 898, "NV"], [900, 966, "CA"],
    [967, 968, "HI"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
  ];
  function resolveZipState(zip) {
    var n = parseInt(zip.slice(0, 3), 10);
    for (var i = 0; i < ZIP3_STATE_RANGES.length; i++) {
      var r = ZIP3_STATE_RANGES[i];
      if (n >= r[0] && n <= r[1]) return r[2];
    }
    return null;
  }

  var US_STATE_ABBR_TO_NAME = {
    AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california",
    CO: "colorado", CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia",
    HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa",
    KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland",
    MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi",
    MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire",
    NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina",
    ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania",
    RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee",
    TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington",
    WV: "west virginia", WI: "wisconsin", WY: "wyoming", DC: "district of columbia",
  };
  var US_STATE_NAME_TO_ABBR = {};
  Object.keys(US_STATE_ABBR_TO_NAME).forEach(function (a) { US_STATE_NAME_TO_ABBR[US_STATE_ABBR_TO_NAME[a]] = a; });

  var NON_US_COUNTRY_NAMES = new Set([
    "argentina", "australia", "austria", "belgium", "brazil", "bulgaria",
    "canada", "chile", "china", "colombia", "costa rica", "croatia", "cyprus",
    "czech republic", "denmark", "egypt", "estonia", "finland", "france",
    "germany", "greece", "hungary", "iceland", "india", "indonesia", "ireland",
    "israel", "italy", "japan", "kenya", "latvia", "lithuania", "luxembourg",
    "malaysia", "malta", "mexico", "morocco", "netherlands", "new zealand",
    "nigeria", "norway", "pakistan", "panama", "peru", "philippines", "poland",
    "portugal", "qatar", "romania", "saudi arabia", "singapore", "slovakia",
    "slovenia", "south africa", "south korea", "spain", "sweden", "switzerland",
    "taiwan", "thailand", "turkey", "ukraine", "united arab emirates",
    "united kingdom", "uruguay", "vietnam",
  ]);

  function locationTokens(raw) {
    return (raw || "").split(/[;,]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function parseLocationQuery(raw) {
    var text = (raw || "").trim();
    if (!text) return null;
    if (/^\d{5}$/.test(text)) return { zipState: resolveZipState(text), zip: text };
    if (text.toLowerCase() === "remote") return { isRemote: true };
    var city = null, stateText = null;
    var parts = text.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var isForeignCountry = NON_US_COUNTRY_NAMES.has(text.toLowerCase()) ||
      parts.some(function (p) { return NON_US_COUNTRY_NAMES.has(p.toLowerCase()); });
    if (parts.length >= 2) {
      city = parts[0]; stateText = parts[1];
    } else {
      var words = text.split(/\s+/);
      var last = words[words.length - 1];
      if (words.length > 1 && (US_STATE_ABBR_TO_NAME[last.toUpperCase()] || US_STATE_NAME_TO_ABBR[last.toLowerCase()])) {
        stateText = last; city = words.slice(0, -1).join(" ");
      } else if (US_STATE_ABBR_TO_NAME[text.toUpperCase()] || US_STATE_NAME_TO_ABBR[text.toLowerCase()]) {
        stateText = text;
      } else {
        city = text;
      }
    }
    var stateAbbr = stateText
      ? (US_STATE_ABBR_TO_NAME[stateText.toUpperCase()] ? stateText.toUpperCase() : (US_STATE_NAME_TO_ABBR[stateText.toLowerCase()] || null))
      : null;
    return { city: city ? city.toLowerCase() : null, state: stateAbbr, isForeignCountry: isForeignCountry };
  }

  function matchesLocationQuery(job, parsed) {
    if (!parsed) return true;
    if (parsed.isRemote) return !!job.is_remote;
    var tokens = locationTokens(job.location);
    if (parsed.zipState) {
      if (job.is_remote) return true;
      var zipName = US_STATE_ABBR_TO_NAME[parsed.zipState];
      return tokens.some(function (t) { return t.toUpperCase() === parsed.zipState || t.toLowerCase() === zipName; });
    }
    if (parsed.city && !tokens.some(function (t) { return t.toLowerCase().indexOf(parsed.city) !== -1; })) return false;
    if (parsed.state) {
      var stateName = US_STATE_ABBR_TO_NAME[parsed.state];
      if (!tokens.some(function (t) { return t.toUpperCase() === parsed.state || t.toLowerCase() === stateName; })) return false;
    }
    return true;
  }

  // geo = { cities: {"city|ST": [lat, lon]}, zip3: {"787": [lat, lon]} } - the same two files
  // jobs.html loads. Without them, radius searches fall back to exact text matching, as on the site.
  function haversineMiles(lat1, lon1, lat2, lon2) {
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    var a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.pow(Math.sin(dLon / 2), 2);
    return 3958.8 * 2 * Math.asin(Math.sqrt(a));
  }
  function cityLookup(geo, city, state) {
    if (!geo || !geo.cities || !city || !state) return null;
    return geo.cities[city.toLowerCase() + "|" + state.toUpperCase()] || null;
  }
  function resolveQueryLatLon(parsed, geo) {
    if (!parsed) return null;
    if (parsed.zip && geo && geo.zip3) return geo.zip3[parsed.zip.slice(0, 3)] || null;
    if (parsed.city && parsed.state) return cityLookup(geo, parsed.city, parsed.state);
    return null;
  }
  var JOB_GEO_CACHE = new Map();
  function resolveJobLatLon(job, geo) {
    var key = job.location || "";
    if (JOB_GEO_CACHE.has(key)) return JOB_GEO_CACHE.get(key);
    var best = null;
    if (geo && geo.cities) {
      var segs = key.split(";").map(function (s) { return s.trim(); }).filter(Boolean);
      for (var i = 0; i < segs.length && !best; i++) {
        var parts = segs[i].split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        if (parts.length < 2) continue;
        var city = parts[parts.length - 2], st = parts[parts.length - 1];
        var abbr = US_STATE_ABBR_TO_NAME[st.toUpperCase()] ? st.toUpperCase() : (US_STATE_NAME_TO_ABBR[st.toLowerCase()] || null);
        if (!abbr) continue;
        best = cityLookup(geo, city, abbr);
      }
    }
    if (geo && geo.cities) JOB_GEO_CACHE.set(key, best);
    return best;
  }
  function matchesRadiusQuery(job, parsed, radius, geo) {
    var origin = resolveQueryLatLon(parsed, geo);
    if (!origin) return matchesLocationQuery(job, parsed);
    if (job.is_remote) return true;
    var p = resolveJobLatLon(job, geo);
    if (!p) return false;
    return haversineMiles(origin[0], origin[1], p[0], p[1]) <= radius;
  }

  function matchesScope(job, scope) {
    if (scope === "remote") return !!job.is_remote || job.work_style === "Remote";
    if (scope === "international") return job.region === "International";
    return job.region !== "International";
  }

  var VISA_TESTS = {
    open: function (j) { return j.visa_sponsorship === "offered" || j.visa_sponsorship === "case_by_case" || (!!j.employer_h1b && j.visa_sponsorship !== "not_offered"); },
    hide_no: function (j) { return j.visa_sponsorship !== "not_offered"; },
  };

  function list(v) {
    return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string" && x; }).slice(0, 40) : [];
  }
  function str(v, max) {
    return typeof v === "string" ? v.trim().slice(0, max) : "";
  }

  // Clean, versioned criteria from either jobs.html's live state or a stored row. Unknown keys
  // are dropped, so whatever the browser sends, only these fields are ever stored or used.
  function normalizeCriteria(raw) {
    raw = raw || {};
    var radius = parseInt(raw.radius, 10);
    var salary = parseInt(raw.salary_min, 10);
    var scope = ["us_remote", "remote", "international"].indexOf(raw.scope) !== -1 ? raw.scope : "us_remote";
    var location = str(raw.location, 100);
    // A radius only does anything around a ZIP or a "City, ST" (anything else is matched as text,
    // exactly as with no radius), so it's kept only then - and the description stays honest.
    var parsedLoc = parseLocationQuery(location);
    var radiusApplies = !!(parsedLoc && (parsedLoc.zip || (parsedLoc.city && parsedLoc.state)));
    var c = {
      v: CRITERIA_VERSION,
      q: str(raw.q, 100),
      location: location,
      radius: radiusApplies && radius > 0 && radius <= 500 ? radius : null,
      scope: scope,
      sectors: list(raw.sectors).sort(),
      categories: list(raw.categories).sort(),
      seniority: list(raw.seniority).sort(),
      work_styles: list(raw.work_styles).sort(),
      employment_types: list(raw.employment_types).sort(),
      visa: list(raw.visa).filter(function (k) { return VISA_TESTS[k]; }).sort(),
      skills: list(raw.skills).sort(),
      salary_min: salary > 0 ? salary : null,
    };
    return c;
  }

  // Exactly the filter in jobs.html render(), minus "Date posted".
  function matchJob(job, criteria, geo) {
    var c = criteria;
    if (c.sectors.length) {
      var js = (job.sector_buckets && job.sector_buckets.length) ? job.sector_buckets
        : (job.sector_bucket ? [job.sector_bucket] : ["Unclassified"]);
      if (!js.some(function (s) { return c.sectors.indexOf(s) !== -1; })) return false;
    }
    if (c.categories.length && c.categories.indexOf(job.job_category || "Unclassified") === -1) return false;
    if (!matchesScope(job, c.scope)) return false;
    if (c.salary_min && !(job.salary_annual_max >= c.salary_min)) return false;
    if (c.skills.length && !(job.skills || []).some(function (s) { return c.skills.indexOf(s) !== -1; })) return false;
    if (c.seniority.length && c.seniority.indexOf(job.seniority_level) === -1) return false;
    if (c.work_styles.length && c.work_styles.indexOf(job.work_style) === -1) return false;
    if (c.visa.length && !c.visa.every(function (k) { return VISA_TESTS[k](job); })) return false;
    if (c.employment_types.length && c.employment_types.indexOf(job.employment_type) === -1) return false;
    var q = c.q.toLowerCase();
    if (q && (job.job_title || "").toLowerCase().indexOf(q) === -1 && (job.company || "").toLowerCase().indexOf(q) === -1) return false;
    var parsed = parseLocationQuery(c.location);
    if (c.radius) {
      if (!matchesRadiusQuery(job, parsed, c.radius, geo)) return false;
    } else if (!matchesLocationQuery(job, parsed)) return false;
    return true;
  }

  function joinWords(items) {
    if (items.length <= 1) return items[0] || "";
    return items.slice(0, -1).join(", ") + " or " + items[items.length - 1];
  }

  // "Solar or Storage engineer jobs within 50 mi of Austin, TX · Remote · $80k+"
  function describe(criteria) {
    var c = criteria;
    var head = [];
    if (c.sectors.length) head.push(joinWords(c.sectors));
    if (c.q) head.push('"' + c.q + '"');
    if (c.categories.length) head.push(joinWords(c.categories));
    var text = (head.length ? head.join(" ") + " jobs" : "All jobs");
    if (c.location) text += (c.radius ? " within " + c.radius + " mi of " : " in ") + c.location;
    var extras = [];
    if (c.scope === "remote") extras.push("Remote");
    if (c.scope === "international") extras.push("International");
    if (c.work_styles.length) extras.push(joinWords(c.work_styles));
    if (c.employment_types.length) extras.push(joinWords(c.employment_types));
    if (c.seniority.length) extras.push(joinWords(c.seniority));
    if (c.salary_min) extras.push("$" + Math.round(c.salary_min / 1000) + "k+");
    if (c.visa.indexOf("open") !== -1) extras.push("Open to visa sponsorship");
    else if (c.visa.indexOf("hide_no") !== -1) extras.push("No \"no sponsorship\" jobs");
    if (c.skills.length) extras.push("Skills: " + c.skills.slice(0, 3).join(", ") + (c.skills.length > 3 ? "…" : ""));
    if (extras.length) text += " · " + extras.join(" · ");
    return text.slice(0, 200);
  }

  // jobs.html?... link that reopens this search (q, location, sector are read on load).
  function searchUrl(criteria, origin) {
    var p = [];
    if (criteria.q) p.push("q=" + encodeURIComponent(criteria.q));
    if (criteria.location) p.push("location=" + encodeURIComponent(criteria.location));
    if (criteria.sectors.length) p.push("sector=" + encodeURIComponent(criteria.sectors.join(",")));
    return (origin || "") + "/jobs.html" + (p.length ? "?" + p.join("&") : "");
  }

  // Company names compared loosely, so "Sunrun Inc." on one posting and "Sunrun" on another
  // count as the same followed company. Mirrors employer_name_key() in the database, minus the
  // removal of words like "energy" (follows compare whole names, not word sets).
  function companyKey(name) {
    return (name || "").toLowerCase()
      .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|plc|lp|llp)\b\.?/g, " ")
      .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  root.VTSearchMatch = {
    normalizeCriteria: normalizeCriteria,
    matchJob: matchJob,
    describe: describe,
    searchUrl: searchUrl,
    companyKey: companyKey,
    SALARY_MINS: SALARY_MINS,
  };
})(typeof window !== "undefined" ? window : globalThis);
