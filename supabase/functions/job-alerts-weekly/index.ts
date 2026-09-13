// Weekly job-match digest. Triggered on a schedule (Supabase Cron -> this
// function), never by a browser - "Verify JWT" stays ON for this function
// in the dashboard, and the cron job's own service-role key satisfies that,
// so no extra secret-header check is needed on top of it.
//
// Every job sent must match on sector, role type AND location - see the
// "Matching" section below (pickJobs) for the tiers: within 100 miles, then
// elsewhere in their state, then remote, then - only for candidates open to
// relocating - further afield, last. A person with zero matching jobs this
// week gets no email at all, rather than an empty one.
//
// Two audiences, same matching:
//   - candidates: full profiles. Role from headline (or latest experience
//     title), location from the profile, plus their relocation answer.
//   - job_alert_leads: zero-commitment signups from create-profile.html's
//     alerts box (email + job title + location + sector(s), no account).
//     One combined email per address, and every one carries a "Complete
//     your profile" nudge - profiles are what employers search.
//
// Job data comes from a plain fetch() of the same slim listings already
// embedded into jobs.html (see export_jobs_to_verde_talent.py in the
// renewable-energy-jobs repo, which now also writes this file) - this
// function has no access to that repo's filesystem, so the published JSON
// is the only way to reach it.
//
// Env vars required (set via `supabase secrets set`):
//   RESEND_API_KEY            - same key send-application/stripe-webhook use
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SITE_ORIGIN = "https://verdetalent.com";
const JOBS_FEED_URL = `${SITE_ORIGIN}/data/jobs_feed.json`;
const NEWS_FEED_URL = `${SITE_ORIGIN}/feed.xml`;
const INTELLIGENCE_URL = `${SITE_ORIGIN}/data/intelligence.json`;
const MAX_JOBS_PER_EMAIL = 10;
const MAX_NEWS_ITEMS = 3;
const NEW_JOB_WINDOW_DAYS = 7;
// Guard against double-sends if this ever gets triggered twice in the same
// week (manual re-run, cron misfire) - not a hard weekly lock, just a
// "already sent recently" skip.
const RESEND_COOLDOWN_DAYS = 6;

interface JobListing {
  job_id: string;
  page_slug: string;
  job_title: string | null;
  company: string | null;
  location: string | null;
  region: string | null;
  is_remote: boolean;
  sector_bucket: string | null;
  job_category: string | null;
  first_seen: string | null;
  posted_date: string | null;
}

interface Candidate {
  id: string;
  email: string;
  first_name: string | null;
  sectors: string[] | null;
  headline: string | null;
  experience: { title?: string }[] | null;
  location: string | null;
  relocation: string | null;
  unsubscribe_token: string;
}

// Zero-commitment signup from create-profile.html's "get emailed when new
// jobs open near me" box - email + sector(s) + location + job title, no
// account. job_title runs through the same role rules as a candidate's
// headline, so a lead who typed "Solar Design Engineer" only sees
// engineering roles, not every Solar job in their state. job_title is
// required on the form since 2026-09-13; older rows can still be null, and
// those match on sector + location alone.
interface Lead {
  id: string;
  email: string;
  sector: string;
  location: string;
  job_title: string | null;
  unsubscribe_token: string;
}

// ---------------------------------------------------------------------------
// Matching. Every job sent has to fit on all three:
//   1. Sector   - one of the person's sectors (candidates.sectors[], or the
//                 lead row's sector).
//   2. Role     - the same job function (role type) as the title they gave
//                 us: a lead's job_title, or a candidate's headline (falling
//                 back to their latest experience title).
//   3. Location - in one of these tiers, which is also the send order:
//        NEARBY    within NEARBY_MILES of their city or ZIP
//        STATE     elsewhere in their state
//        REMOTE    remote roles
//        RELOCATE  anywhere else in the US - only for candidates who said
//                  they'd relocate, and always last
// Foreign roles only go to people who told us they're in that country
// ("Berlin, Germany") - and those people get only their own country's
// jobs (see locationTier).
// Within a tier, jobs whose titles share more words with theirs come first
// ("Solar Design Engineer" -> "PV Design Engineer" before "Civil Engineer"),
// then the newest.
// ---------------------------------------------------------------------------

const CITY_GEO_URL = `${SITE_ORIGIN}/data/us_cities_geo.json`;
const ZIP3_GEO_URL = `${SITE_ORIGIN}/data/zip3_centroids.json`;
const NEARBY_MILES = 100;

// Ported from taxonomy/job_category.py on the crawler side - same rules,
// same order (first match wins, most specific categories listed first), so
// a person's inferred role type lines up with what each job was actually
// tagged with. Kept in sync by hand; not imported directly since this Edge
// Function has no access to that repo. Last synced 2026-09-13.
const JOB_CATEGORY_RULES: [string, RegExp[]][] = [
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

function mapJobCategory(title: string | null | undefined): string | null {
  const text = (title || "").toLowerCase();
  if (!text) return null;
  for (const [category, patterns] of JOB_CATEGORY_RULES) {
    if (patterns.some((p) => p.test(text))) return category;
  }
  return null;
}

// Words that say nothing about the job itself - seniority, sector, work
// arrangement, filler. Stripped from both sides before comparing titles, so
// "Senior Solar Design Engineer" and "PV Design Engineer II" share
// {design, engineer} rather than looking unrelated.
const GENERIC_TITLE_WORDS = new Set([
  "senior", "sr", "junior", "jr", "lead", "principal", "staff", "associate", "assistant",
  "chief", "head", "entry", "level", "i", "ii", "iii", "iv", "v",
  "and", "of", "the", "a", "an", "to", "for", "in", "at", "with", "or", "open",
  "solar", "wind", "energy", "renewable", "renewables", "storage", "battery", "bess",
  "grid", "power", "clean", "ev", "hydrogen", "offshore", "onshore", "utility", "utilities", "pv",
  "remote", "hybrid", "onsite", "site", "based", "full", "part", "time", "contract", "temporary",
  "us", "usa", "north", "america", "new",
]);
const TITLE_WORD_ALIASES: Record<string, string> = {
  tech: "technician", techs: "technician", mgr: "manager", engr: "engineer", eng: "engineer",
  admin: "administrator", coord: "coordinator",
};

function titleWords(title: string | null | undefined): Set<string> {
  const words = new Set<string>();
  for (let w of (title || "").toLowerCase().split(/[^a-z&]+/)) {
    if (!w) continue;
    w = TITLE_WORD_ALIASES[w] || w;
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1); // engineers -> engineer
    if (!GENERIC_TITLE_WORDS.has(w)) words.add(w);
  }
  return words;
}

interface Role {
  category: string | null;
  words: Set<string>;
}

function roleFromTitle(title: string | null | undefined): Role {
  return { category: mapJobCategory(title), words: titleWords(title) };
}

// Prefers the headline (what the candidate explicitly said they are) over
// past experience titles, falling back to the most recent listed job only
// if the headline itself doesn't resolve to a role type.
function candidateRole(candidate: Candidate): Role {
  const headlineRole = roleFromTitle(candidate.headline);
  if (headlineRole.category) return headlineRole;
  for (const exp of candidate.experience || []) {
    const expRole = roleFromTitle(exp.title);
    if (expRole.category) return expRole;
  }
  if (headlineRole.words.size) return headlineRole;
  return roleFromTitle(candidate.experience?.[0]?.title);
}

// null = not the same kind of job, drop it. Otherwise the number of title
// words shared, used to rank within a location tier.
//   - Known role type: the job must carry the same one. A job the crawler
//     couldn't tag at all only gets in if its title plainly matches theirs
//     (shares at least two of their words, or their only word).
//   - Title didn't map to a role type (e.g. "Analyst"): shared title words
//     are the only signal, same threshold.
//   - No title information at all (profiles with no headline/experience,
//     leads from before job title was required): nothing to filter on, so
//     location + sector only.
function roleScore(job: JobListing, role: Role): number | null {
  if (!role.category && role.words.size === 0) return 0;
  const jobWords = titleWords(job.job_title);
  let shared = 0;
  for (const w of role.words) if (jobWords.has(w)) shared++;
  const plainMatch = shared >= Math.min(2, role.words.size);
  if (role.category) {
    if (job.job_category === role.category) return shared;
    if (!job.job_category && plainMatch) return shared;
    return null;
  }
  return plainMatch ? shared : null;
}

// Full name -> abbreviation, so "Austin, Texas" matches a listing normalized
// to "Austin, TX" (see taxonomy/location_display.py on the crawler side).
const US_STATE_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
};
const US_STATE_CODES = new Set(Object.values(US_STATE_ABBR));

// "TX" / "tx" / "Texas" -> "TX"; anything else -> null.
function stateCode(token: string | null | undefined): string | null {
  const t = (token || "").trim();
  if (!t) return null;
  if (US_STATE_CODES.has(t.toUpperCase()) && t.length === 2) return t.toUpperCase();
  return US_STATE_ABBR[t.toLowerCase()] || null;
}

// Last resort for free-text locations that don't parse cleanly ("Greater
// Austin area, TX metro") - any state code or name found anywhere in it.
function findStateAnywhere(text: string): string | null {
  const abbr = text.match(/\b([A-Z]{2})\b/g)?.find((m) => US_STATE_CODES.has(m));
  if (abbr) return abbr;
  const lower = text.toLowerCase();
  for (const [name, code] of Object.entries(US_STATE_ABBR)) {
    if (lower.includes(name)) return code;
  }
  return null;
}

// Approximate USPS ZIP-prefix -> state blocks (first 3 digits of a 5-digit
// ZIP), so a bare ZIP still yields a state even when its prefix has no
// centroid. Boundaries are close but not exact at the edges - good enough
// for "is this job in their state", not an authoritative ZIP database.
const ZIP3_STATE_RANGES: [number, number, string][] = [
  [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"], [50, 59, "VT"],
  [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"],
  [200, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"],
  [290, 299, "SC"], [300, 319, "GA"], [320, 339, "FL"], [341, 342, "FL"], [344, 344, "FL"],
  [346, 347, "FL"], [349, 349, "FL"], [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"],
  [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"], [460, 479, "IN"], [480, 499, "MI"],
  [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [570, 577, "SD"], [580, 588, "ND"],
  [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"],
  [700, 714, "LA"], [716, 729, "AR"], [730, 749, "OK"], [750, 799, "TX"], [800, 816, "CO"],
  [820, 831, "WY"], [832, 839, "ID"], [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"],
  [885, 885, "TX"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"], [970, 979, "OR"],
  [980, 994, "WA"], [995, 999, "AK"],
];

function zip3ToState(zip3: number): string | null {
  for (const [lo, hi, state] of ZIP3_STATE_RANGES) {
    if (zip3 >= lo && zip3 <= hi) return state;
  }
  return null;
}

// Same public-domain GeoNames-derived reference files jobs.html's radius
// search uses: "city|ST" -> [lat, lon] (~29.5k cities) and ZIP3 prefix ->
// [lat, lon]. Loaded once per run; if either fails, matching quietly drops
// to state level (no NEARBY tier) rather than failing the send.
type LatLon = [number, number];
let CITY_GEO: Record<string, LatLon> = {};
let ZIP3_GEO: Record<string, LatLon> = {};

async function loadGeoData(): Promise<void> {
  try {
    const [cities, zip3] = await Promise.all([
      fetch(CITY_GEO_URL).then((r) => (r.ok ? r.json() : {})),
      fetch(ZIP3_GEO_URL).then((r) => (r.ok ? r.json() : {})),
    ]);
    CITY_GEO = cities;
    ZIP3_GEO = zip3;
  } catch (err) {
    console.error("Could not load geo data - matching falls back to state level (non-fatal):", err);
  }
}

function haversineMiles(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

// ---- Countries ------------------------------------------------------------
// People who say they're outside the US ("Berlin, Germany") get jobs in
// their own country instead of US ones; everyone else never sees foreign
// roles. ISO2 list and the backward scan are ported from
// taxonomy/countries.py on the crawler side (last synced 2026-09-13).
const COUNTRY_NAME_BY_ISO2: Record<string, string> = {
  AF: "Afghanistan", AL: "Albania", DZ: "Algeria", AD: "Andorra", AO: "Angola", AR: "Argentina",
  AM: "Armenia", AU: "Australia", AT: "Austria", AZ: "Azerbaijan", BS: "Bahamas", BH: "Bahrain",
  BD: "Bangladesh", BY: "Belarus", BE: "Belgium", BZ: "Belize", BJ: "Benin", BT: "Bhutan",
  BO: "Bolivia", BA: "Bosnia and Herzegovina", BW: "Botswana", BR: "Brazil", BN: "Brunei",
  BG: "Bulgaria", BF: "Burkina Faso", BI: "Burundi", KH: "Cambodia", CM: "Cameroon", CA: "Canada",
  CV: "Cabo Verde", CF: "Central African Republic", TD: "Chad", CL: "Chile", CN: "China",
  CO: "Colombia", KM: "Comoros", CG: "Congo", CD: "DR Congo", CR: "Costa Rica", HR: "Croatia",
  CU: "Cuba", CY: "Cyprus", CZ: "Czechia", DK: "Denmark", DJ: "Djibouti", DM: "Dominica",
  DO: "Dominican Republic", EC: "Ecuador", EG: "Egypt", SV: "El Salvador", GQ: "Equatorial Guinea",
  ER: "Eritrea", EE: "Estonia", SZ: "Eswatini", ET: "Ethiopia", FJ: "Fiji", FI: "Finland",
  FR: "France", GA: "Gabon", GM: "Gambia", GE: "Georgia", DE: "Germany", GH: "Ghana", GR: "Greece",
  GD: "Grenada", GT: "Guatemala", GN: "Guinea", GW: "Guinea-Bissau", GY: "Guyana", HT: "Haiti",
  HN: "Honduras", HK: "Hong Kong", HU: "Hungary", IS: "Iceland", IN: "India", ID: "Indonesia",
  IR: "Iran", IQ: "Iraq", IE: "Ireland", IL: "Israel", IT: "Italy", CI: "Ivory Coast", JM: "Jamaica",
  JP: "Japan", JO: "Jordan", KZ: "Kazakhstan", KE: "Kenya", KI: "Kiribati", KW: "Kuwait",
  KG: "Kyrgyzstan", LA: "Laos", LV: "Latvia", LB: "Lebanon", LS: "Lesotho", LR: "Liberia",
  LY: "Libya", LI: "Liechtenstein", LT: "Lithuania", LU: "Luxembourg", MO: "Macao",
  MG: "Madagascar", MW: "Malawi", MY: "Malaysia", MV: "Maldives", ML: "Mali", MT: "Malta",
  MH: "Marshall Islands", MR: "Mauritania", MU: "Mauritius", MX: "Mexico", FM: "Micronesia",
  MD: "Moldova", MC: "Monaco", MN: "Mongolia", ME: "Montenegro", MA: "Morocco", MZ: "Mozambique",
  MM: "Myanmar", NA: "Namibia", NR: "Nauru", NP: "Nepal", NL: "Netherlands", NZ: "New Zealand",
  NI: "Nicaragua", NE: "Niger", NG: "Nigeria", MK: "North Macedonia", NO: "Norway", OM: "Oman",
  PK: "Pakistan", PW: "Palau", PA: "Panama", PG: "Papua New Guinea", PY: "Paraguay", PE: "Peru",
  PH: "Philippines", PL: "Poland", PT: "Portugal", PR: "Puerto Rico", QA: "Qatar", RO: "Romania",
  RU: "Russia", RW: "Rwanda", KN: "Saint Kitts and Nevis", LC: "Saint Lucia", WS: "Samoa",
  SM: "San Marino", SA: "Saudi Arabia", SN: "Senegal", RS: "Serbia", SC: "Seychelles",
  SL: "Sierra Leone", SG: "Singapore", SK: "Slovakia", SI: "Slovenia", SB: "Solomon Islands",
  SO: "Somalia", ZA: "South Africa", KR: "South Korea", SS: "South Sudan", ES: "Spain",
  LK: "Sri Lanka", SD: "Sudan", SR: "Suriname", SE: "Sweden", CH: "Switzerland", SY: "Syria",
  TW: "Taiwan", TJ: "Tajikistan", TZ: "Tanzania", TH: "Thailand", TL: "Timor-Leste", TG: "Togo",
  TO: "Tonga", TT: "Trinidad and Tobago", TN: "Tunisia", TR: "Turkey", TM: "Turkmenistan",
  TV: "Tuvalu", UG: "Uganda", UA: "Ukraine", AE: "United Arab Emirates", GB: "United Kingdom",
  UY: "Uruguay", UZ: "Uzbekistan", VU: "Vanuatu", VA: "Vatican City", VE: "Venezuela",
  VN: "Vietnam", YE: "Yemen", ZM: "Zambia", ZW: "Zimbabwe",
};
const COUNTRY_BY_NAME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(COUNTRY_NAME_BY_ISO2).map(([code, name]) => [name.toLowerCase(), code])),
  "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB",
  "northern ireland": "GB", "czech republic": "CZ", korea: "KR", "south korea": "KR",
  "russian federation": "RU", "viet nam": "VN", uae: "AE", holland: "NL", deutschland: "DE",
  "türkiye": "TR", turkiye: "TR",
  usa: "US", "u.s.": "US", "u.s.a.": "US", "united states": "US", "united states of america": "US", america: "US",
};
const ISO2_CODES = new Set(Object.keys(COUNTRY_NAME_BY_ISO2));
// Vestas lists Indian roles as "IN, TN" (India, Tamil Nadu) - scanned from
// the end like everything else, "TN" would read as Tunisia.
const INDIA_SUBDIVISION_CODES = new Set(["TN", "KA", "MH", "TG", "TS", "AP", "GJ", "DL", "HR", "UP", "RJ", "WB", "KL", "MP", "OR", "OD", "PB"]);
const INDIA_STATE_NAMES = new Set([
  "tamil nadu", "karnataka", "maharashtra", "telangana", "andhra pradesh", "gujarat", "delhi",
  "haryana", "uttar pradesh", "rajasthan", "west bengal", "kerala", "madhya pradesh", "odisha", "punjab",
]);
// A person typing "Toronto, ON" means Canada, not an unknown US place.
const CANADA_PROVINCE_CODES = new Set(["ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "YT", "NT", "NU"]);
// Places listed without any country ("Sydney, NSW", "Jung-gu, Seoul") that
// still name one unambiguously. Three-letter codes and full names only.
const PLACE_TO_COUNTRY: Record<string, string> = {
  nsw: "AU", vic: "AU", qld: "AU", tas: "AU", "new south wales": "AU", queensland: "AU",
  tasmania: "AU", "western australia": "AU", "south australia": "AU", seoul: "KR",
};

// One comma/dash-split piece of a location, as a country - a name, or (only
// when allowCodes) an upper-case ISO2 code. Whole-piece matches only, so a
// city with a country-like word in it never false-positives.
function countryOfSegment(segment: string, allowCodes: boolean): string | null {
  const s = segment.replace(/\s*\+\s*\d+\s*more.*$/i, "").replace(/^careers:\s*/i, "").trim();
  if (!s) return null;
  if (allowCodes && s.length === 2 && s === s.toUpperCase() && ISO2_CODES.has(s)) return s;
  const lower = s.toLowerCase();
  return COUNTRY_BY_NAME[lower] || PLACE_TO_COUNTRY[lower] || (INDIA_STATE_NAMES.has(lower) ? "IN" : null);
}

// Country of an international job ("Aarhus N, Region Central Jutland, DK,
// 8200", "Germany - Erlangen", "Taipei, Taiwan, TW, 110"), scanned from the
// end the way the crawler does. null for US jobs and for international ones
// with no identifiable country ("Remote", "Location not listed").
const JOB_COUNTRY_CACHE = new Map<string, string | null>();

function jobCountry(job: JobListing): string | null {
  if (job.region !== "International") return null;
  const key = job.location || "";
  if (JOB_COUNTRY_CACHE.has(key)) return JOB_COUNTRY_CACHE.get(key) ?? null;
  const segs = key.split(";")[0].split(/,| - /).map((s) => s.trim()).filter(Boolean);
  let found: string | null = null;
  if (segs.includes("IN") && segs.some((s) => INDIA_SUBDIVISION_CODES.has(s))) found = "IN";
  for (let i = segs.length - 1; i >= 0 && !found; i--) found = countryOfSegment(segs[i], true);
  JOB_COUNTRY_CACHE.set(key, found);
  return found;
}

// A person outside the US names their country in words - "Berlin,
// Germany", "Germany", "London, UK", "Berlin Germany". Never by 2-letter
// code: CA, DE, IN, GA... are US states first. Returns the country and the
// city they gave, if any.
function personCountry(t: string): { country: string; city: string | null } | null {
  const segs = t.split(/,| - /).map((s) => s.trim()).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const country = countryOfSegment(segs[i], false);
    if (country) return { country, city: i > 0 ? segs[0] : null };
  }
  if (segs.length >= 2 && CANADA_PROVINCE_CODES.has(segs[segs.length - 1].toUpperCase())) {
    return { country: "CA", city: segs[0] };
  }
  const words = t.split(/\s+/);
  for (const n of [3, 2, 1]) {
    if (words.length <= n) continue;
    const country = countryOfSegment(words.slice(-n).join(" "), false);
    if (country) return { country, city: words.slice(0, -n).join(" ") };
  }
  return null;
}

// Where a person is. US people have a state (and a map point when they gave
// a city or ZIP); people abroad have a country other than "US", and a city
// if they gave one. Neither = location unknown, treated as US.
interface Place {
  state: string | null;
  point: LatLon | null;
  country?: string | null;
  city?: string | null;
}

function cityPoint(city: string, state: string): LatLon | null {
  return CITY_GEO[`${city.trim().toLowerCase()}|${state}`] || null;
}

// What a person typed as their location - a ZIP, "City, ST", "City, State",
// "City State", or just a state - resolved to a state and, where possible,
// a map point for the 100-mile radius. A state alone has no point, so it
// matches on the state tier and remote only.
function parsePersonLocation(text: string | null | undefined): Place {
  const t = (text || "").trim();
  if (!t) return { state: null, point: null };

  const zip = t.match(/^(\d{5})(-\d{4})?$/);
  if (zip) {
    const prefix = zip[1].slice(0, 3);
    return { state: zip3ToState(parseInt(prefix, 10)), point: ZIP3_GEO[prefix] || null };
  }

  const parts = t.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const state = stateCode(parts[1]);
    if (state) return { state, point: cityPoint(parts[0], state) };
  } else {
    const whole = stateCode(t);
    if (whole) return { state: whole, point: null };
    // "Austin TX", "Raleigh North Carolina" - try a 2-word then 1-word state at the end.
    const words = t.split(/\s+/);
    for (const n of [2, 1]) {
      if (words.length <= n) continue;
      const state = stateCode(words.slice(-n).join(" "));
      if (state) return { state, point: cityPoint(words.slice(0, -n).join(" "), state) };
    }
  }
  const abroad = personCountry(t);
  if (abroad) return { state: null, point: null, country: abroad.country, city: abroad.city };
  return { state: findStateAnywhere(t), point: null };
}

// A job's listed location(s) - "City, ST", a bare "ST", or several joined
// with ";" for multi-site postings - as places. Cached per distinct string
// since the same locations repeat across thousands of jobs and people.
const JOB_PLACES_CACHE = new Map<string, Place[]>();

function jobPlaces(job: JobListing): Place[] {
  // Foreign roles never place in a US state - without this a German posting
  // listed as "SH, DE" would read as Delaware.
  if (job.region === "International") return [];
  const key = job.location || "";
  const cached = JOB_PLACES_CACHE.get(key);
  if (cached) return cached;
  const places: Place[] = [];
  for (const seg of key.split(";")) {
    const parts = seg.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const state = stateCode(parts[parts.length - 1]);
    if (!state) continue;
    const point = parts.length >= 2 ? cityPoint(parts[parts.length - 2], state) : null;
    places.push({ state, point });
  }
  JOB_PLACES_CACHE.set(key, places);
  return places;
}

const TIER_NEARBY = 0;
const TIER_STATE = 1;
const TIER_REMOTE = 2;
const TIER_RELOCATE = 3;

// Which location tier a job falls in for this person, or null if it's out
// of range entirely. `relocation` is a candidate's "Open to relocation?"
// answer; leads never give one (their signup is a "near me" ask), so they
// never reach the RELOCATE tier.
//
// People in the US (or with no location) never get foreign roles, whatever
// their relocation answer - "Yes — anywhere" is treated the same as "Yes —
// US only". That includes remote roles based abroad ("Remote - Amsterdam"),
// which usually need you to live in that country.
//
// People who said they're abroad get the mirror image: only jobs in their
// own country - their city first, then elsewhere in the country, then
// remote roles based there. No US roles, no relocation tier.
function locationTier(job: JobListing, place: Place, relocation: string | null): number | null {
  if (place.country && place.country !== "US") {
    if (jobCountry(job) !== place.country) return null;
    if (place.city && (job.location || "").toLowerCase().includes(place.city.toLowerCase())) return TIER_NEARBY;
    return job.is_remote ? TIER_REMOTE : TIER_STATE;
  }
  if (job.region === "International") return null;
  const places = jobPlaces(job);
  if (place.point && places.some((p) => p.point && haversineMiles(place.point!, p.point) <= NEARBY_MILES)) return TIER_NEARBY;
  if (place.state && places.some((p) => p.state === place.state)) return TIER_STATE;
  if (job.is_remote) return TIER_REMOTE;
  if ((relocation === "Yes — anywhere" || relocation === "Yes — US only") && job.region === "US") return TIER_RELOCATE;
  return null;
}

// One set of preferences to match against: a candidate is one of these; a
// lead is one per job_alert_leads row (each row its own sector, and possibly
// its own title/location if they signed up more than once).
interface MatchRequest {
  sectors: string[];
  place: Place;
  relocation: string | null;
  role: Role;
}

// Miles from the person to the nearest of the job's placeable locations,
// or null when either side has no map point.
function jobMiles(job: JobListing, place: Place): number | null {
  if (!place.point) return null;
  let min: number | null = null;
  for (const p of jobPlaces(job)) {
    if (!p.point) continue;
    const d = haversineMiles(place.point, p.point);
    if (min === null || d < min) min = d;
  }
  return min;
}

// Up to MAX_JOBS_PER_EMAIL jobs, best first: location tier, then how
// closely the title matches, then nearest, then newest. A job several
// requests match keeps its best tier/score. Within a tier, sectors take
// turns so one busy sector can't fill every slot for someone following
// several.
function pickJobs(requests: MatchRequest[], jobsBySector: Map<string, JobListing[]>): JobListing[] {
  const best = new Map<string, { job: JobListing; tier: number; score: number; miles: number | null }>();
  for (const req of requests) {
    for (const sector of req.sectors) {
      for (const job of jobsBySector.get(sector) || []) {
        const score = roleScore(job, req.role);
        if (score === null) continue;
        const tier = locationTier(job, req.place, req.relocation);
        if (tier === null) continue;
        const prev = best.get(job.job_id);
        if (!prev || tier < prev.tier || (tier === prev.tier && score > prev.score)) {
          best.set(job.job_id, { job, tier, score, miles: jobMiles(job, req.place) });
        }
      }
    }
  }

  const sorted = [...best.values()].sort((a, b) =>
    a.tier - b.tier ||
    b.score - a.score ||
    (a.miles ?? Infinity) - (b.miles ?? Infinity) ||
    (b.job.first_seen || "").localeCompare(a.job.first_seen || ""));

  // The feed can carry the same posting twice under different ids (a
  // company re-listing it) - show it once.
  const seen = new Set<string>();
  const ranked = sorted.filter((r) => {
    const key = `${r.job.job_title}|${r.job.company}|${r.job.location}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const picked: JobListing[] = [];
  for (let tier = TIER_NEARBY; tier <= TIER_RELOCATE && picked.length < MAX_JOBS_PER_EMAIL; tier++) {
    const bySector = new Map<string, JobListing[]>();
    for (const r of ranked) {
      if (r.tier !== tier) continue;
      const s = r.job.sector_bucket || "";
      if (!bySector.has(s)) bySector.set(s, []);
      bySector.get(s)!.push(r.job);
    }
    const queues = [...bySector.values()];
    for (let i = 0; picked.length < MAX_JOBS_PER_EMAIL && queues.some((q) => i < q.length); i++) {
      for (const q of queues) {
        if (i < q.length && picked.length < MAX_JOBS_PER_EMAIL) picked.push(q[i]);
      }
    }
  }
  return picked;
}

interface NewsItem {
  title: string;
  link: string;
}

// feed.xml is XML, so "PG&E" arrives as "PG&amp;E" and apostrophes as
// "&#39;". Decode before escapeHtml() re-escapes for the email, or the
// reader sees the entity itself ("PG&amp;E") and link query strings break.
function decodeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Same small hand-rolled RSS parser as newsletter-weekly - feed.xml's shape
// is fixed and simple (we generate it ourselves), so a couple of regexes
// beat pulling in an XML/DOM library for two fields.
function parseFeed(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    if (title && link) items.push({ title: decodeXml(title), link: decodeXml(link) });
  }
  return items.slice(0, MAX_NEWS_ITEMS);
}

// The "Industry intel" sidebar stat - copied from newsletter-weekly (edge
// functions don't share code here, same as parseFeed above). Several
// candidate sentences from data/intelligence.json, one picked per send,
// rotated by ISO week so it's stable for the week and changes next week.
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function buildIntelStat(intel: Record<string, unknown>): string | null {
  const candidates: string[] = [];

  const topSkill = (intel.top_skills as { top_skills?: { skill: string; pct_of_described_postings: number }[] })
    ?.top_skills?.[0];
  if (topSkill) {
    candidates.push(`"${topSkill.skill}" is the most in-demand skill this month, appearing in ${topSkill.pct_of_described_postings}% of job descriptions we've tracked.`);
  }

  const demandBySector = intel.demand_trend_by_sector as Record<string, Record<string, number>> | undefined;
  if (demandBySector) {
    let topSector: string | null = null;
    let topCount = 0;
    for (const [sector, months] of Object.entries(demandBySector)) {
      const total = Object.values(months).reduce((a, b) => a + b, 0);
      if (total > topCount) {
        topCount = total;
        topSector = sector;
      }
    }
    if (topSector) candidates.push(`${topSector} is leading hiring this month with ${topCount} open roles tracked.`);
  }

  const regions = intel.region_breakdown as Record<string, number> | undefined;
  if (regions) {
    const [topRegion, topRegionCount] = Object.entries(regions)
      .filter(([name]) => name !== "Unknown")
      .sort((a, b) => b[1] - a[1])[0] || [];
    if (topRegion) candidates.push(`${topRegion} has the most open renewable energy roles right now, with ${topRegionCount} tracked.`);
  }

  const salaryRole = (intel.salary_benchmarks as { roles?: { role: string; national_median_wage: number }[] })
    ?.roles?.[0];
  if (salaryRole) {
    candidates.push(`${salaryRole.role}s earn a national median of $${salaryRole.national_median_wage.toLocaleString()}/year, per BLS data.`);
  }

  const totalTracked = (intel.totals as { open_postings?: number })?.open_postings;
  if (totalTracked) {
    candidates.push(`We're tracking ${totalTracked.toLocaleString()} open renewable energy roles right now.`);
  }

  if (candidates.length === 0) return null;
  return candidates[isoWeekNumber(new Date()) % candidates.length];
}

async function fetchIntelStat(): Promise<string | null> {
  try {
    const res = await fetch(INTELLIGENCE_URL);
    if (!res.ok) return null;
    return buildIntelStat(await res.json());
  } catch (err) {
    console.error("Could not fetch intelligence data (non-fatal):", err);
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Table-based layout, inline styles only, light background - the safe
// subset that renders consistently across Gmail/Outlook/Apple Mail rather
// than trying to reuse the site's own dark theme (which most email clients
// handle inconsistently, Outlook especially).
const GRN = "#22E09A";
const INK = "#0A0A0A";
const MUTED = "#6B7280";
const BORDER = "#E8E8E8";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function emailShell(preheader: string, bodyHtml: string, unsubscribeUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
@media (max-width:480px) {
  .vt-main-col, .vt-side-col { display:block !important; width:100% !important; }
  .vt-side-col { border-left:none !important; border-top:1px solid ${BORDER} !important; padding-left:0 !important; padding-top:16px !important; margin-top:16px !important; }
  .vt-main-col { padding-right:0 !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#F5F6F5;font-family:${FONT};">
<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F5;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid ${BORDER};">
<tr><td style="background:${INK};padding:20px 28px;">
  <span style="font-size:18px;font-weight:700;color:#FFFFFF;font-family:${FONT};">Verde <span style="color:${GRN};">Talent</span></span>
</td></tr>
<tr><td style="padding:28px 28px 8px;">
${bodyHtml}
</td></tr>
<tr><td style="padding:20px 28px 28px;border-top:1px solid ${BORDER};margin-top:12px;">
  <p style="margin:16px 0 0;font-size:11px;color:#9CA3AF;line-height:1.6;">
    Verde Talent · <a href="${SITE_ORIGIN}" style="color:#9CA3AF;">verdetalent.com</a><br/>
    <a href="${unsubscribeUrl}" style="color:#9CA3AF;">Unsubscribe</a>
  </p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// Right-hand column shared by both digests, same look as newsletter-weekly's
// Featured jobs / Industry intel column: "In the news", then "Industry
// intel". Each section drops out on its own when its fetch came back empty,
// and with neither there's no column at all - a missing section is less
// jarring than a header with nothing under it.
const SIDE_LABEL = "font-size:11px;font-weight:700;color:#9CA3AF;letter-spacing:.04em;text-transform:uppercase;margin-bottom:10px;";

function withSidebar(mainHtml: string, news: NewsItem[], intelStat: string | null): string {
  const newsHtml = news.length === 0 ? "" : `
          <div style="${SIDE_LABEL}">In the news</div>
          ${news.map((item) => `<div style="margin-bottom:14px;"><a href="${escapeHtml(item.link)}" style="font-size:12.5px;font-weight:600;color:${INK};text-decoration:none;line-height:1.4;display:block;">${escapeHtml(item.title)}</a></div>`).join("")}
          <a href="${SITE_ORIGIN}/news.html" style="font-size:11.5px;color:${GRN};text-decoration:none;font-weight:600;">More news →</a>`;
  const intelHtml = !intelStat ? "" : `
          <div style="${SIDE_LABEL}${newsHtml ? "margin-top:24px;" : ""}">Industry intel</div>
          <div style="font-size:12.5px;color:${INK};line-height:1.5;margin-bottom:8px;">${escapeHtml(intelStat)}</div>
          <a href="${SITE_ORIGIN}/intelligence.html" style="font-size:11.5px;color:${GRN};text-decoration:none;font-weight:600;">See full dashboard →</a>`;
  if (!newsHtml && !intelHtml) return mainHtml;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td class="vt-main-col" valign="top" width="66%" style="padding-right:20px;">${mainHtml}</td>
        <td class="vt-side-col" valign="top" width="34%" style="border-left:1px solid ${BORDER};padding-left:20px;">${newsHtml}${intelHtml}
        </td>
      </tr>
    </table>`;
}

function buildEmailHtml(candidate: Candidate, jobs: JobListing[], news: NewsItem[], intelStat: string | null): string {
  const firstName = candidate.first_name || "there";
  const unsubscribeUrl = `${SUPABASE_URL}/functions/v1/unsubscribe-job-alerts?token=${candidate.unsubscribe_token}`;
  const jobRows = jobs.map((job) => `
    <tr><td style="padding:14px 0;border-bottom:1px solid ${BORDER};">
      <a href="${SITE_ORIGIN}/jobs/${job.page_slug}.html" style="font-size:15px;font-weight:600;color:${INK};text-decoration:none;">${escapeHtml(job.job_title || "Open role")}</a>
      <div style="font-size:13px;color:${MUTED};margin-top:3px;">${escapeHtml(job.company || "")}${job.location ? " · " + escapeHtml(job.location) : ""}</div>
    </td></tr>`).join("");

  const jobsColumn = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${jobRows}</table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px;">
      <tr><td style="background:${GRN};border-radius:9px;">
        <a href="${SITE_ORIGIN}/jobs.html" style="display:inline-block;padding:11px 20px;font-size:13px;font-weight:600;color:#052e1e;text-decoration:none;">See all open roles →</a>
      </td></tr>
    </table>`;

  const greeting = `
    <p style="margin:0 0 4px;font-size:16px;font-weight:700;color:${INK};">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 20px;font-size:14px;color:${MUTED};line-height:1.5;">Here ${jobs.length === 1 ? "'s a new role" : "are " + jobs.length + " new roles"} matching your experience on Verde Talent this week.</p>`;

  const mainContent = withSidebar(jobsColumn, news, intelStat);

  return emailShell(`${jobs.length} new job${jobs.length === 1 ? "" : "s"} matching your profile`, greeting + mainContent, unsubscribeUrl);
}

// "Solar", "Solar & Storage", "Solar, Storage & Grid" - for a lead's
// combined email across every sector they signed up for.
function sectorLabel(sectors: string[]): string {
  if (sectors.length <= 1) return sectors[0] || "clean energy";
  return `${sectors.slice(0, -1).join(", ")} & ${sectors[sectors.length - 1]}`;
}

// `label` covers every sector on this address (see sectorLabel); `lead` is
// any one of its rows - they share the email, and location is taken from it.
function buildLeadEmailHtml(lead: Lead, label: string, jobs: JobListing[], news: NewsItem[], intelStat: string | null): string {
  const unsubscribeUrl = `${SUPABASE_URL}/functions/v1/unsubscribe-job-alerts?token=${lead.unsubscribe_token}`;
  const jobRows = jobs.map((job) => `
    <tr><td style="padding:14px 0;border-bottom:1px solid ${BORDER};">
      <a href="${SITE_ORIGIN}/jobs/${job.page_slug}.html" style="font-size:15px;font-weight:600;color:${INK};text-decoration:none;">${escapeHtml(job.job_title || "Open role")}</a>
      <div style="font-size:13px;color:${MUTED};margin-top:3px;">${escapeHtml(job.company || "")}${job.location ? " · " + escapeHtml(job.location) : ""}</div>
    </td></tr>`).join("");

  // The upsell - these are zero-commitment leads, and full profiles are what
  // employers search in the talent database, so every send pushes toward one.
  // It sits straight under the job list (the filled button in this email),
  // with "see all roles" demoted to a text link so the two don't compete.
  // UTM tags let GA credit the profiles this email produces.
  const profileUrl = `${SITE_ORIGIN}/create-profile.html?utm_source=job_alert_email&utm_medium=email&utm_campaign=complete_profile`;
  const upsell = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;">
      <tr><td style="background:#F0FBF6;border:1px solid #BFEFD9;border-radius:10px;padding:18px 20px;">
        <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:${INK};">Let ${escapeHtml(label)} employers find you</p>
        <p style="margin:0 0 14px;font-size:13px;color:${MUTED};line-height:1.55;">Complete your free profile and hiring teams can reach out to you directly. Your alerts get sharper too, matched by your experience and not just sector and location. Takes about 2 minutes.</p>
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr><td style="background:${GRN};border-radius:9px;">
            <a href="${profileUrl}" style="display:inline-block;padding:11px 20px;font-size:13px;font-weight:600;color:#052e1e;text-decoration:none;">Complete your profile →</a>
          </td></tr>
        </table>
      </td></tr>
    </table>`;

  const jobsColumn = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${jobRows}</table>
    ${upsell}
    <p style="margin:16px 0 0;font-size:13px;"><a href="${SITE_ORIGIN}/jobs.html" style="color:${INK};font-weight:600;text-decoration:underline;">See all open roles →</a></p>`;

  const greeting = `
    <p style="margin:0 0 4px;font-size:16px;font-weight:700;color:${INK};">Hi there,</p>
    <p style="margin:0 0 20px;font-size:14px;color:${MUTED};line-height:1.5;">Here ${jobs.length === 1 ? "'s a new " + escapeHtml(label) + " role" : "are " + jobs.length + " new " + escapeHtml(label) + " roles"} open near ${escapeHtml(lead.location)} this week.</p>`;

  const mainContent = withSidebar(jobsColumn, news, intelStat);

  return emailShell(`${jobs.length} new ${label} job${jobs.length === 1 ? "" : "s"} near ${lead.location}`, greeting + mainContent, unsubscribeUrl);
}

// RFC 8058 one-click unsubscribe, same as newsletter-weekly sends - gives
// Gmail/Apple Mail their native "Unsubscribe" button, and Gmail/Yahoo
// expect it from bulk senders. unsubscribe-job-alerts reads the token off
// the URL whatever the method, so the mail client's POST works unchanged.
function unsubscribeHeaders(token: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${SUPABASE_URL}/functions/v1/unsubscribe-job-alerts?token=${token}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

Deno.serve(async (_req) => {
  try {
    const feedRes = await fetch(JOBS_FEED_URL);
    if (!feedRes.ok) {
      throw new Error(`Could not fetch jobs feed: ${feedRes.status}`);
    }
    const allJobs = (await feedRes.json()) as JobListing[];

    // News is a nice-to-have alongside the job matches, not the point of
    // this email - a failed/empty fetch degrades to no sidebar rather than
    // blocking the whole send.
    let newsItems: NewsItem[] = [];
    try {
      const newsRes = await fetch(NEWS_FEED_URL);
      if (newsRes.ok) newsItems = parseFeed(await newsRes.text());
    } catch (err) {
      console.error("Could not fetch news feed (non-fatal):", err);
    }
    // Same deal for the intel stat - null just drops that sidebar section.
    // Geo data likewise: without it, matching runs at state level only.
    const [intelStat] = await Promise.all([fetchIntelStat(), loadGeoData()]);

    const cutoff = new Date(Date.now() - NEW_JOB_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const newJobs = allJobs.filter((job) => {
      const seen = job.first_seen ? new Date(job.first_seen) : null;
      return seen && seen >= cutoff;
    });

    const jobsBySector = new Map<string, JobListing[]>();
    for (const job of newJobs) {
      if (!job.sector_bucket) continue;
      if (!jobsBySector.has(job.sector_bucket)) jobsBySector.set(job.sector_bucket, []);
      jobsBySector.get(job.sector_bucket)!.push(job);
    }

    const cooldownCutoff = new Date(Date.now() - RESEND_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: candidates, error: candidatesError } = await supabaseAdmin
      .from("candidates")
      .select("id, email, first_name, sectors, headline, experience, location, relocation, unsubscribe_token, last_job_alert_sent_at")
      .eq("email_job_alerts", true)
      .neq("availability", "Not currently looking")
      .not("email", "is", null)
      .or(`last_job_alert_sent_at.is.null,last_job_alert_sent_at.lt.${cooldownCutoff}`);

    if (candidatesError) throw candidatesError;

    let sent = 0;
    let skippedNoMatch = 0;
    let failed = 0;

    for (const candidate of (candidates || []) as Candidate[]) {
      const jobs = pickJobs([{
        sectors: candidate.sectors || [],
        place: parsePersonLocation(candidate.location),
        relocation: candidate.relocation,
        role: candidateRole(candidate),
      }], jobsBySector);
      if (jobs.length === 0) {
        skippedNoMatch++;
        continue;
      }

      const { error: sendError } = await resend.emails.send({
        from: "Verde Talent Jobs <jobs@updates.verdetalent.com>",
        to: candidate.email,
        subject: jobs.length === 1
          ? `1 new job matching your profile on Verde Talent`
          : `${jobs.length} new jobs matching your profile on Verde Talent`,
        html: buildEmailHtml(candidate, jobs, newsItems, intelStat),
        headers: unsubscribeHeaders(candidate.unsubscribe_token),
      });

      if (sendError) {
        console.error(`Send failed for candidate ${candidate.id}:`, sendError);
        failed++;
        continue;
      }

      await supabaseAdmin
        .from("candidates")
        .update({ last_job_alert_sent_at: new Date().toISOString() })
        .eq("id", candidate.id);
      sent++;
    }

    const { data: leads, error: leadsError } = await supabaseAdmin
      .from("job_alert_leads")
      .select("id, email, sector, location, job_title, unsubscribe_token, last_alert_sent_at")
      .eq("subscribed", true)
      .or(`last_alert_sent_at.is.null,last_alert_sent_at.lt.${cooldownCutoff}`);

    if (leadsError) throw leadsError;

    let leadsSent = 0;
    let leadsSkippedNoMatch = 0;
    let leadsFailed = 0;

    // One email per address, not per row. job_alert_leads holds one row per
    // (email, sector), so someone who ticked Solar + Storage + Grid used to
    // get three separate digests every week. Each row is its own match
    // request (its sector, location and title); pickJobs merges them.
    const leadsByEmail = new Map<string, Lead[]>();
    for (const lead of (leads || []) as Lead[]) {
      if (!leadsByEmail.has(lead.email)) leadsByEmail.set(lead.email, []);
      leadsByEmail.get(lead.email)!.push(lead);
    }

    for (const [email, rows] of leadsByEmail) {
      const jobs = pickJobs(rows.map((lead) => ({
        sectors: [lead.sector],
        place: parsePersonLocation(lead.location),
        relocation: null,
        role: roleFromTitle(lead.job_title),
      })), jobsBySector);

      if (jobs.length === 0) {
        leadsSkippedNoMatch++;
        continue;
      }

      const sectors = [...new Set(rows.map((r) => r.sector))];
      const label = sectorLabel(sectors);
      const location = rows[0].location;
      const { error: sendError } = await resend.emails.send({
        from: "Verde Talent Jobs <jobs@updates.verdetalent.com>",
        to: email,
        subject: jobs.length === 1
          ? `1 new ${label} job near ${location}`
          : `${jobs.length} new ${label} jobs near ${location}`,
        html: buildLeadEmailHtml(rows[0], label, jobs, newsItems, intelStat),
        // Any one row's token works - unsubscribe-job-alerts turns off every
        // row for that address, matching the one combined email.
        headers: unsubscribeHeaders(rows[0].unsubscribe_token),
      });

      if (sendError) {
        console.error(`Send failed for lead ${rows[0].id}:`, sendError);
        leadsFailed++;
        continue;
      }

      await supabaseAdmin
        .from("job_alert_leads")
        .update({ last_alert_sent_at: new Date().toISOString() })
        .in("id", rows.map((r) => r.id));
      leadsSent++;
    }

    return new Response(
      JSON.stringify({
        success: true,
        new_jobs_found: newJobs.length,
        sent,
        skipped_no_match: skippedNoMatch,
        failed,
        leads_sent: leadsSent,
        leads_skipped_no_match: leadsSkippedNoMatch,
        leads_failed: leadsFailed,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
