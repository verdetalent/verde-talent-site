// Job-alert digest - daily or weekly, per candidate. Triggered once a day by
// Supabase Cron (14:00 UTC). Each run emails:
//   - candidates on 'daily' (candidates.alert_frequency), and
//   - candidates on 'weekly' (the default) and job_alert_leads, on Mondays only.
// A candidate's email can have three sections, each holding only jobs that
// are new to them (see "What counts as new" in the handler):
//   1. Matching your profile - sector + role + location, as described below.
//   2. New at companies they follow (candidate_company_follows).
//   3. New for their saved searches (candidate_saved_searches), matched by
//      search-match.js - an exact copy of the site's /search-match.js, so a
//      saved search sends what the search itself shows on jobs.html.
// A job appears once, in the first section it qualifies for. Nothing new in
// any section = no email. The name "job-alerts-weekly" is kept so the cron
// job and logs don't need renaming.
//
// Manual runs (trusted callers only, see isTrustedCaller):
//   ?dry_run=1        build everything, send nothing, change nothing; returns
//                     counts plus sample subjects.
//   ?only=<email>     just that candidate, whatever their schedule (with
//                     dry_run=1 it also returns the email's HTML). Skips leads.
//   ?force_weekly=1   treat today as Monday.
//
// Originally the weekly job-match digest. Never triggered by a browser - "Verify JWT" stays ON for this function
// in the dashboard, and the cron job's own service-role key satisfies that,
// so no extra secret-header check is needed on top of it.
//
// Every job sent must match on sector, role type AND location - see the
// "Matching" section below (pickJobs) for the tiers: within 100 miles or
// remote, then elsewhere in their state, then - only for candidates open to
// relocating - further afield, last. Within each, jobs fitting their most
// recent resume role come first. A person with zero matching jobs this
// week gets no email at all, rather than an empty one.
//
// Two audiences, same matching:
//   - candidates: full profiles. Roles from the job titles on their resume
//     (the headline only if there are none), location from the profile, plus
//     their relocation answer.
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
// Sets globalThis.VTSearchMatch. Must stay identical to the site's /search-match.js.
import "./search-match.js";
// Sets globalThis.VTJobFit - an exact copy of the site's /job-fit.js, so "Strong match" in the
// email means exactly what it means on jobs.html and the job pages.
import "./job-fit.js";

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
// Daily subscribers: skip anyone emailed in the last 20 hours (a cron run that
// drifts a little, or a manual re-run the same day).
const DAILY_COOLDOWN_HOURS = 20;
const MAX_FOLLOW_JOBS_PER_COMPANY = 5;
const MAX_FOLLOW_COMPANIES_PER_EMAIL = 5;
const MAX_JOBS_PER_SEARCH = 5;

// deno-lint-ignore no-explicit-any
const SM = (globalThis as any).VTSearchMatch as {
  normalizeCriteria: (raw: unknown) => Record<string, unknown>;
  matchJob: (job: JobListing, criteria: Record<string, unknown>, geo: unknown) => boolean;
  describe: (criteria: Record<string, unknown>) => string;
  searchUrl: (criteria: Record<string, unknown>, origin: string) => string;
  companyKey: (name: string | null | undefined) => string;
};

// deno-lint-ignore no-explicit-any
const FIT = (globalThis as any).VTJobFit as {
  // deno-lint-ignore no-explicit-any
  prepare: (c: any) => any;
  // deno-lint-ignore no-explicit-any
  score: (job: JobListing, profile: any) => { level: "strong" | "good"; reasons: string[] } | null;
  stateOf: (text: string | null | undefined) => string | null;
  roleFromTitle: (title: string) => { category: string | null };
};

interface JobListing {
  job_id: string;
  page_slug: string;
  job_title: string | null;
  company: string | null;
  location: string | null;
  region: string | null;
  is_remote: boolean;
  sector_bucket: string | null;
  // From the jobs feed (taxonomy/work_terms.py + taxonomy/h1b.py): what the
  // posting itself says about sponsorship, and the employer's USCIS H-1B
  // approvals (set only on US professional roles).
  visa_sponsorship?: "offered" | "not_offered" | "case_by_case" | null;
  employer_h1b?: number | null;
  job_category: string | null;
  first_seen: string | null;
  posted_date: string | null;
  // Read only by saved-search matching (search-match.js) - the same fields jobs.html filters on.
  sector_buckets?: string[] | null;
  work_style?: string | null;
  seniority_level?: string | null;
  employment_type?: string | null;
  skills?: string[] | null;
  salary_annual_max?: number | null;
  // The pay the posting lists, as text ("$28–$36/hr"), when it lists any.
  salary?: string | null;
  // Set only on paid employer postings (see fetchPaidJobs) - they link to
  // their own page rather than jobs/<slug>.html.
  link?: string;
  paid?: boolean;
}

interface Candidate {
  id: string;
  email: string;
  first_name: string | null;
  sectors: string[] | null;
  headline: string | null;
  experience: { title?: string; dates?: string }[] | null;
  location: string | null;
  relocation: string | null;
  work_authorization?: string | null;
  // For the match labels (job-fit.js): the same profile fields the site scores on.
  skills?: string[] | null;
  years_experience?: string | null;
  salary_min?: number | null;
  unsubscribe_token: string;
  alert_frequency?: string | null;
  availability?: string | null;
  last_job_alert_sent_at?: string | null;
  last_job_alert_watermark?: string | null;
  alerts_paused_until?: string | null;
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
//   2. Role     - the same job function (role type) as a title they gave
//                 us: a lead's job_title, or any job title on a candidate's
//                 resume, most recent ranked first (the headline only if they have
//                 none - headlines are often a tagline, not a job title).
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
// then the nearest and newest. Paid employer postings go through the same
// matching; when one matches, it leads its tier (never a closer one).
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
  // Resume shorthand, so "Acct Exec" lines up with "Senior Account Executive".
  acct: "account", exec: "executive", rep: "representative", reps: "representative",
  ops: "operations", mgmt: "management", dir: "director", supv: "supervisor", supvr: "supervisor",
  spec: "specialist", svc: "service", svcs: "service", asst: "assistant", tchn: "technician",
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

// Every job title on the resume counts. Recency is handled by ranking, not a
// cut-off: within a location tier, jobs fitting their most recent title come
// first (see bestRoleScore), so an older role only fills spare slots. The cap
// is just a guard against a runaway profile.
const MAX_EXPERIENCE_ROLES = 15;

// Year a role ended, from the free-text dates on the profile ("2019 - Present",
// "Jan 2020 – Mar 2023"). Present/current = still in it. null = no year given.
function experienceEndYear(dates: unknown): number | null {
  const d = String(dates || "").toLowerCase();
  if (/\b(present|current|now|today)\b/.test(d)) return 9999;
  const years = d.match(/\b(19|20)\d{2}\b/g);
  return years ? Math.max(...years.map(Number)) : null;
}

// Job titles from their work history (the resume), most recent first. Kept in
// the order they were entered unless every entry has a year to sort by - a
// resume already lists newest first, and guessing from half the dates could
// scramble it.
function experienceTitles(candidate: Candidate): string[] {
  const exp = (Array.isArray(candidate.experience) ? candidate.experience : [])
    .filter((e) => e && String(e.title || "").trim());
  const ends = exp.map((e) => experienceEndYear((e as { dates?: string }).dates));
  const ordered = ends.every((y) => y !== null)
    ? exp.map((e, i) => ({ e, i, y: ends[i] as number })).sort((a, b) => b.y - a.y || a.i - b.i).map((x) => x.e)
    : exp;
  return ordered.map((e) => String(e.title).trim());
}

// The roles a candidate is matched on: every job title on their resume, most
// recent first. Headlines are often a tagline
// ("Passionate about the energy transition") rather than a job title, and
// used to decide every match. Now the headline only adds a role when it
// clearly names a job type (a career changer's "Aspiring Solar Installer"),
// ranked after their resume titles - or stands in when there's no job history.
function candidateRoles(candidate: Candidate): Role[] {
  const roles: Role[] = [];
  const seen = new Set<string>();
  const add = (role: Role) => {
    const key = `${role.category}|${[...role.words].sort().join(" ")}`;
    if (seen.has(key)) return;
    seen.add(key);
    roles.push(role);
  };
  for (const title of experienceTitles(candidate)) {
    const role = roleFromTitle(title);
    if (!role.category && role.words.size === 0) continue;
    add(role);
    if (roles.length >= MAX_EXPERIENCE_ROLES) break;
  }
  const headlineRole = roleFromTitle(candidate.headline);
  if (!roles.length) return [headlineRole];
  if (headlineRole.category) add(headlineRole);
  return roles;
}

// Best fit across someone's roles: null if the job fits none of them. Otherwise
// recency first - a job fitting their most recent title outranks one that only
// fits an older title - then shared title words within that role.
const ROLE_RECENCY_WEIGHT = 100;
function bestRoleScore(job: JobListing, roles: Role[]): number | null {
  let best: number | null = null;
  roles.forEach((role, i) => {
    const s = roleScore(job, role);
    if (s === null) return;
    const scored = (roles.length - i) * ROLE_RECENCY_WEIGHT + s;
    if (best === null || scored > best) best = scored;
  });
  return best;
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
    // Two shared title words outrank the job's filed category: "Strategic Account Executive,
    // Engineering and Construction" is filed under Engineering but is a sales job.
    if (shared >= 2) return shared;
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
  // One role for a lead (their typed job title); a candidate's are the job
  // titles on their resume, most recent first - a job may fit any of them.
  roles: Role[];
  // Candidate said they will need visa sponsorship: postings that explicitly
  // rule it out are dropped, and roles open to it rank first in each tier.
  needsSponsorship?: boolean;
}

// Same rule as the "Open to sponsorship" filter on jobs.html.
function openToSponsorship(job: JobListing): boolean {
  return job.visa_sponsorship === "offered" || job.visa_sponsorship === "case_by_case" ||
    (!!job.employer_h1b && job.visa_sponsorship !== "not_offered");
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

// Up to MAX_JOBS_PER_EMAIL jobs, best first: location group (nearby and remote
// together, then state, then relocate), then how recent the resume role it
// fits is, then paid postings, then how closely the title matches, then
// nearest, then newest.
// A paid posting only gets here by matching sector, role type and location
// like any other job; its edge is going first *within its own tier* - it
// never jumps ahead of a closer free listing. A job several requests match
// keeps its best tier/score. Within a tier, sectors take turns (after any
// paid postings) so one busy sector can't fill every slot for someone
// following several.
function pickJobs(requests: MatchRequest[], jobsBySector: Map<string, JobListing[]>, eligible: (job: JobListing) => boolean = () => true): JobListing[] {
  const best = new Map<string, { job: JobListing; tier: number; score: number; miles: number | null }>();
  const needsSponsorship = requests.some((r) => r.needsSponsorship);
  for (const req of requests) {
    for (const sector of req.sectors) {
      for (const job of jobsBySector.get(sector) || []) {
        if (!eligible(job)) continue;
        if (req.needsSponsorship && job.visa_sponsorship === "not_offered") continue;
        const score = bestRoleScore(job, req.roles);
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

  // Ranking order: location group, then how recent the role it fits is, then
  // the existing paid / sponsorship / title / distance / date order. Remote
  // jobs sit in the nearby group - distance means nothing for them, so a
  // remote job fitting someone's current role isn't pushed below a nearby job
  // that only fits an older one.
  const rankOf = (tier: number) => (tier === TIER_REMOTE ? TIER_NEARBY : tier);
  const levelOf = (score: number) => Math.floor(score / ROLE_RECENCY_WEIGHT);
  const sorted = [...best.values()].sort((a, b) =>
    rankOf(a.tier) - rankOf(b.tier) ||
    levelOf(b.score) - levelOf(a.score) ||
    Number(!!b.job.paid) - Number(!!a.job.paid) ||
    (needsSponsorship ? Number(openToSponsorship(b.job)) - Number(openToSponsorship(a.job)) : 0) ||
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

  // Filled group by group in ranked order - (location group, role recency) -
  // so sector rotation below can never put an older-role job ahead of one
  // fitting a more recent role.
  const groups = new Map<string, typeof ranked>();
  for (const r of ranked) {
    const key = `${rankOf(r.tier)}|${levelOf(r.score)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const picked: JobListing[] = [];
  for (const group of groups.values()) {
    if (picked.length >= MAX_JOBS_PER_EMAIL) break;
    for (const r of group) {
      if (r.job.paid && picked.length < MAX_JOBS_PER_EMAIL) picked.push(r.job);
    }
    const bySector = new Map<string, JobListing[]>();
    for (const r of group) {
      if (r.job.paid) continue;
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

// One job in either digest's list. Paid employer postings link to their own
// page and carry a small "Promoted" label - they're only in the list because
// they matched like any other job, but readers should still be able to tell
// what's sponsored.
type Fit = { level: "strong" | "good"; reasons: string[] } | null;

function fitHtml(fit: Fit): string {
  if (!fit) return "";
  const strong = fit.level === "strong";
  const pill = strong
    ? `<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:${GRN};font-size:11px;font-weight:700;color:#052e1e;">Strong match</span>`
    : `<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:#EEF6FF;border:1px solid #C7E0FB;font-size:11px;font-weight:700;color:#1F5FA8;">Good match</span>`;
  const tick = strong ? "#0B7A55" : "#1F5FA8";
  const reasons = fit.reasons.map((r) => `<span style="white-space:nowrap;margin-left:8px;"><b style="color:${tick};">&#10003;</b> ${escapeHtml(r)}</span>`).join("");
  return `<div style="margin-top:7px;font-size:12px;color:${INK};line-height:1.9;">${pill}${reasons}</div>`;
}

function jobRowHtml(job: JobListing, showVisa = false, fit: Fit = null): string {
  const href = job.link || `${SITE_ORIGIN}/jobs/${job.page_slug}.html`;
  let badge = job.paid
    ? ` <span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#F0FBF6;border:1px solid #BFEFD9;font-size:10.5px;font-weight:700;color:#0B7A55;vertical-align:2px;">Promoted</span>`
    : "";
  if (showVisa && openToSponsorship(job)) {
    const label = job.visa_sponsorship === "offered" || job.visa_sponsorship === "case_by_case"
      ? "Visa sponsorship" : "Sponsors H-1B";
    badge += ` <span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#EEF6FF;border:1px solid #C7E0FB;font-size:10.5px;font-weight:700;color:#1F5FA8;vertical-align:2px;">${label}</span>`;
  }
  return `
    <tr><td style="padding:14px 0;border-bottom:1px solid ${BORDER};">
      <a href="${escapeHtml(href)}" style="font-size:15px;font-weight:600;color:${INK};text-decoration:none;">${escapeHtml(job.job_title || "Open role")}</a>${badge}
      <div style="font-size:13px;color:${MUTED};margin-top:3px;">${escapeHtml(job.company || "")}${job.location ? " · " + escapeHtml(job.location) : ""}${job.salary ? ` · <span style="color:#0B7A55;font-weight:600;">${escapeHtml(job.salary)}</span>` : ""}</div>
      ${fitHtml(fit)}
    </td></tr>`;
}

// One block of a candidate's email: profile matches, one followed company, or
// one saved search.
interface EmailSection {
  kind: "profile" | "follow" | "search";
  title: string;
  jobs: JobListing[];
  company?: string;
  moreUrl?: string;
  moreLabel?: string;
}

function countJobs(sections: EmailSection[]): number {
  return sections.reduce((n, s) => n + s.jobs.length, 0);
}

function subjectFor(sections: EmailSection[]): string {
  const total = countJobs(sections);
  const s = total === 1 ? "" : "s";
  if (sections.length === 1 && sections[0].kind === "profile") return `${total} new job${s} matching your profile on Verde Talent`;
  if (sections.length === 1 && sections[0].kind === "follow") return `${sections[0].company} posted ${total} new job${s}`;
  return `${total} new job${s} for you on Verde Talent`;
}

// "What should you be paid?" - the salary check opened with their role and state filled in
// (salary-check.html reads ?role=&state=). Only when we know their role.
function payLinkHtml(candidate: Candidate): string {
  // A job title the salary check can match: their most recent resume job title that maps to a role
  // type, else the first piece of the headline ("Wind Technician | GWO certified" -> "Wind
  // Technician"). A headline like "Energy Professional" with no job history gets no box.
  const tidy = (t: unknown) => String(t || "").split(/\s+[|•·–—-]\s+|\s*\|\s*/)[0].replace(/\s+/g, " ").trim();
  const options = [...experienceTitles(candidate).map(tidy), tidy(candidate.headline)]
    .filter((t) => t && t.length <= 60);
  const role = options.find((t) => FIT.roleFromTitle(t).category) || "";
  if (!role) return "";
  const state = FIT.stateOf(candidate.location);
  const url = `${SITE_ORIGIN}/salary-check.html?role=${encodeURIComponent(role)}${state ? "&state=" + state : ""}&src=alert-email`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
      <tr><td style="background:#F0FBF6;border:1px solid #BFEFD9;border-radius:10px;padding:12px 14px;">
        <div style="font-size:13.5px;font-weight:700;color:${INK};">What should you be paid?</div>
        <div style="font-size:12.5px;color:${MUTED};margin-top:2px;line-height:1.5;">See the pay employers advertise for ${escapeHtml(role)} roles${state ? " in " + state : ""}.</div>
        <a href="${escapeHtml(url)}" style="display:inline-block;margin-top:6px;font-size:12.5px;font-weight:700;color:#0B7A55;text-decoration:none;">Check your pay &rarr;</a>
      </td></tr>
    </table>`;
}

function buildEmailHtml(candidate: Candidate, sections: EmailSection[], news: NewsItem[], intelStat: string | null, cadence: "daily" | "weekly"): string {
  const firstName = candidate.first_name || "there";
  const unsubscribeUrl = `${SUPABASE_URL}/functions/v1/unsubscribe-job-alerts?token=${candidate.unsubscribe_token}`;
  const showVisa = candidate.work_authorization === "needs_sponsorship";
  const total = countJobs(sections);
  const profile = FIT.prepare(candidate);
  const fitOf = (job: JobListing): Fit => (profile && profile.hasRole ? FIT.score(job, profile) : null);
  const rank = (f: Fit) => (f ? (f.level === "strong" ? 2 : 1) : 0);
  for (const sec of sections) {
    if (sec.kind !== "profile") continue;
    // Stable sort: newest-first order is kept within each label.
    sec.jobs = sec.jobs.map((j, i) => ({ j, i, r: rank(fitOf(j)) }))
      .sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.j);
  }
  const payBlock = payLinkHtml(candidate);
  // A profile-only email looks exactly like the old weekly one (no section heading).
  const showTitles = !(sections.length === 1 && sections[0].kind === "profile");

  const blocks = sections.map((sec, i) => `
    ${showTitles ? `<div style="font-size:11.5px;font-weight:700;color:${MUTED};letter-spacing:.04em;text-transform:uppercase;margin:${i ? "26px" : "0"} 0 2px;">${escapeHtml(sec.title)}</div>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${sec.jobs.map((job) => jobRowHtml(job, showVisa, fitOf(job))).join("")}</table>
    ${sec.moreUrl ? `<p style="margin:10px 0 0;font-size:12.5px;"><a href="${escapeHtml(sec.moreUrl)}" style="color:#0B7A55;font-weight:600;text-decoration:none;">${escapeHtml(sec.moreLabel || "See all")} →</a></p>` : ""}`).join("");

  const jobsColumn = `
    ${blocks}
    ${payBlock}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;">
      <tr><td style="background:${GRN};border-radius:9px;">
        <a href="${SITE_ORIGIN}/jobs.html" style="display:inline-block;padding:11px 20px;font-size:13px;font-weight:600;color:#052e1e;text-decoration:none;">See all open roles →</a>
      </td></tr>
    </table>
    <p style="margin:18px 0 0;font-size:12px;color:${MUTED};line-height:1.55;">You get these ${cadence === "daily" ? "daily" : "every Monday"}. <a href="${SITE_ORIGIN}/dashboard.html#alerts" style="color:${MUTED};">Change how often, or follow companies and save searches</a>.</p>`;

  const when = cadence === "daily" ? "since your last alert" : "this week";
  const greeting = `
    <p style="margin:0 0 4px;font-size:16px;font-weight:700;color:${INK};">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 20px;font-size:14px;color:${MUTED};line-height:1.5;">Here ${total === 1 ? "'s a new role" : "are " + total + " new roles"} for you on Verde Talent ${when}.</p>`;

  const mainContent = withSidebar(jobsColumn, news, intelStat);

  return emailShell(`${total} new job${total === 1 ? "" : "s"} for you on Verde Talent`, greeting + mainContent, unsubscribeUrl);
}

// The feed can list the same posting twice (a company re-listing it).
function dedupeJobs(jobs: JobListing[]): JobListing[] {
  const seen = new Set<string>();
  return jobs.filter((j) => {
    const key = `${j.job_title}|${j.company}|${j.location}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function newestFirst(a: JobListing, b: JobListing): number {
  return (b.first_seen || "").localeCompare(a.first_seen || "");
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
  const jobRows = jobs.map((job) => jobRowHtml(job)).join("");

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
// Live paid employer postings (job_postings, status 'paid', not expired),
// shaped like feed listings so they go through exactly the same matching:
// sector, role type (from their title) and location. Read from the table
// rather than the public view, which doesn't carry is_international. They
// stay eligible for as long as they're live, not just their first week -
// that's what the employer paid for - but they only appear to people they
// match, and only rank ahead of free listings within the same location
// tier (see pickJobs). A failed fetch just means no paid postings this run.
async function fetchPaidJobs(): Promise<JobListing[]> {
  const base = "id, company_name, job_title, location, sector, is_international, paid_at, visa_sponsorship";
  const query = (cols: string) => supabaseAdmin
    .from("job_postings")
    .select(cols)
    .eq("status", "paid")
    .gt("expires_at", new Date().toISOString());
  // The extra columns are only for saved-search filters; if any is missing,
  // fall back to the original set rather than losing paid postings.
  let { data, error } = await query(`${base}, work_arrangement, employment_type, salary_max, salary_period`);
  if (error) ({ data, error } = await query(base));
  if (error) {
    console.error("Could not fetch paid job postings (non-fatal):", error);
    return [];
  }
  // deno-lint-ignore no-explicit-any
  return ((data || []) as any[]).map((p) => ({
    job_id: `paid:${p.id}`,
    page_slug: "",
    link: `${SITE_ORIGIN}/employer-job.html?id=${p.id}`,
    job_title: p.job_title,
    company: p.company_name,
    location: p.location,
    region: p.is_international ? "International" : "US",
    is_remote: p.work_arrangement === "Remote" || /\bremote\b/i.test(p.location || ""),
    sector_bucket: p.sector,
    sector_buckets: p.sector ? [p.sector] : null,
    job_category: mapJobCategory(p.job_title),
    work_style: p.work_arrangement || null,
    employment_type: p.employment_type || null,
    salary_annual_max: p.salary_max ? (p.salary_period === "hour" ? p.salary_max * 2080 : p.salary_max) : null,
    first_seen: p.paid_at,
    posted_date: p.paid_at,
    visa_sponsorship: ({ yes: "offered", no: "not_offered", case_by_case: "case_by_case" } as Record<string, JobListing["visa_sponsorship"]>)[p.visa_sponsorship || ""] || null,
    paid: true,
  }));
}

function unsubscribeHeaders(token: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${SUPABASE_URL}/functions/v1/unsubscribe-job-alerts?token=${token}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// Only the cron job (or us) may trigger this. The schedule calls it with a
// project secret key (sb_secret_..., inline in cron.job), which is not a JWT,
// so a JWT "role" check can't be used - and the public publishable/anon key
// must never be enough. Instead, ask Supabase Auth to do one admin-only read
// with whatever key the caller sent: only a secret or service-role key can.
// Addresses that hard-bounced or reported spam (resend-webhook). Never emailed
// again by the weekly sends; the accounts themselves are left alone.
async function loadSuppressed(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin.from("email_suppressions").select("email");
  if (error) {
    console.error("Could not load email_suppressions (sending to everyone):", error);
    return new Set();
  }
  return new Set((data || []).map((r: { email: string }) => r.email.toLowerCase()));
}

async function isTrustedCaller(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const key = bearer || (req.headers.get("apikey") || "").trim();
  if (!key) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface FollowRow { candidate_id: string; company_name: string; company_slug: string | null }
interface SearchRow { candidate_id: string; label: string; criteria: unknown }

// Rows for these candidates from a table keyed by candidate_id, grouped. A
// failed read just leaves those sections out of this run.
async function loadByCandidate<T extends { candidate_id: string }>(table: string, cols: string, ids: string[]): Promise<Map<string, T[]>> {
  const out = new Map<string, T[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabaseAdmin.from(table).select(cols).in("candidate_id", ids.slice(i, i + 200)).order("created_at");
    if (error) {
      console.error(`Could not read ${table} (non-fatal):`, error);
      return out;
    }
    for (const row of (data || []) as unknown as T[]) {
      if (!out.has(row.candidate_id)) out.set(row.candidate_id, []);
      out.get(row.candidate_id)!.push(row);
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (!(await isTrustedCaller(req))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const only = (url.searchParams.get("only") || "").trim().toLowerCase() || null;
  const now = new Date();
  const isMonday = now.getUTCDay() === 1 || url.searchParams.get("force_weekly") === "1";
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
    const [intelStat, paidJobs] = await Promise.all([fetchIntelStat(), fetchPaidJobs(), loadGeoData()]);
    const geo = { cities: CITY_GEO, zip3: ZIP3_GEO };

    // What counts as new. The site's job feed is republished once a day (the
    // evening refresh), and a job's first_seen is when the crawler found it,
    // which can be hours before it reaches the feed. So "first_seen after my
    // last email" would miss jobs crawled before an email but published after
    // it. Instead each candidate stores a watermark: the newest first_seen in
    // the feed when their last email was built. Next time, crawled jobs newer
    // than that are new to them. Paid postings go live the moment they're paid,
    // so they're new when paid_at is after the last email. Never more than
    // NEW_JOB_WINDOW_DAYS back.
    const windowStartMs = now.getTime() - NEW_JOB_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const feedWatermark = allJobs.reduce((m, j) => (j.first_seen && j.first_seen > m ? j.first_seen : m), "");
    const recentJobs = allJobs.filter((job) => job.first_seen && Date.parse(job.first_seen) >= windowStartMs);
    const pool = [...recentJobs, ...paidJobs];

    const jobsBySector = new Map<string, JobListing[]>();
    for (const job of pool) {
      if (!job.sector_bucket) continue;
      if (!jobsBySector.has(job.sector_bucket)) jobsBySector.set(job.sector_bucket, []);
      jobsBySector.get(job.sector_bucket)!.push(job);
    }

    let candQuery = supabaseAdmin
      .from("candidates")
      .select("id, email, first_name, sectors, headline, experience, location, relocation, work_authorization, skills, years_experience, salary_min, unsubscribe_token, last_job_alert_sent_at, last_job_alert_watermark, alert_frequency, availability, alerts_paused_until")
      .eq("email_job_alerts", true)
      .not("email", "is", null);
    if (only) candQuery = candQuery.ilike("email", only.replace(/[%_\\]/g, (c) => "\\" + c));
    const { data: candidateRows, error: candidatesError } = await candQuery;
    if (candidatesError) throw candidatesError;

    const dailyCutoffMs = now.getTime() - DAILY_COOLDOWN_HOURS * 60 * 60 * 1000;
    const weeklyCutoffMs = now.getTime() - RESEND_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    const weeklyCutoff = new Date(weeklyCutoffMs).toISOString();
    const due = ((candidateRows || []) as Candidate[]).filter((c) => {
      if (only) return true;
      // Paused from the dashboard ("Pause for 30 days"): skip until the date passes.
      if (c.alerts_paused_until && Date.parse(c.alerts_paused_until) > now.getTime()) return false;
      const last = c.last_job_alert_sent_at ? Date.parse(c.last_job_alert_sent_at) : 0;
      if (c.alert_frequency === "daily") return last < dailyCutoffMs;
      return isMonday && last < weeklyCutoffMs;
    });

    const ids = due.map((c) => c.id);
    const [followsBy, searchesBy] = await Promise.all([
      loadByCandidate<FollowRow>("candidate_company_follows", "candidate_id, company_name, company_slug", ids),
      loadByCandidate<SearchRow>("candidate_saved_searches", "candidate_id, label, criteria", ids),
    ]);

    let sent = 0;
    let skippedNoMatch = 0;
    let failed = 0;
    let dailySent = 0;
    let followJobs = 0;
    let searchJobs = 0;
    // deno-lint-ignore no-explicit-any
    const previews: any[] = [];

    const suppressed = await loadSuppressed();
    let skippedSuppressed = 0;
    for (const candidate of due) {
      if (suppressed.has((candidate.email || "").toLowerCase())) {
        skippedSuppressed++;
        continue;
      }
      const cadence: "daily" | "weekly" = candidate.alert_frequency === "daily" ? "daily" : "weekly";
      const lastSentMs = candidate.last_job_alert_sent_at ? Date.parse(candidate.last_job_alert_sent_at) : 0;
      const markMs = Math.max(windowStartMs, candidate.last_job_alert_watermark ? Date.parse(candidate.last_job_alert_watermark) : lastSentMs);
      const paidCutoffMs = Math.max(windowStartMs, lastSentMs);
      // Paid postings: a weekly email offers them for as long as they're live
      // (what the employer paid for). A daily email only when newly paid, or on
      // Mondays - otherwise one posting would repeat every day for a month.
      const eligible = (job: JobListing) => job.paid
        ? (cadence === "weekly" || isMonday || (!!job.first_seen && Date.parse(job.first_seen) > paidCutoffMs))
        : (!!job.first_seen && Date.parse(job.first_seen) > markMs);

      const shown = new Set<string>();
      const sections: EmailSection[] = [];

      // 1. Profile matches - not for people who said they're not looking.
      if (candidate.availability !== "Not currently looking") {
        const jobs = pickJobs([{
          sectors: candidate.sectors || [],
          place: parsePersonLocation(candidate.location),
          relocation: candidate.relocation,
          roles: candidateRoles(candidate),
          needsSponsorship: candidate.work_authorization === "needs_sponsorship",
        }], jobsBySector, eligible);
        if (jobs.length) {
          jobs.forEach((j) => shown.add(j.job_id));
          sections.push({ kind: "profile", title: "Matching your profile", jobs });
        }
      }

      // 2. Followed companies, any role they post.
      let companies = 0;
      for (const f of followsBy.get(candidate.id) || []) {
        if (companies >= MAX_FOLLOW_COMPANIES_PER_EMAIL) break;
        const key = SM.companyKey(f.company_name);
        if (!key) continue;
        const fresh = dedupeJobs(pool.filter((j) => eligible(j) && !shown.has(j.job_id) && SM.companyKey(j.company) === key)).sort(newestFirst);
        if (!fresh.length) continue;
        const list = fresh.slice(0, MAX_FOLLOW_JOBS_PER_COMPANY);
        list.forEach((j) => shown.add(j.job_id));
        followJobs += list.length;
        companies++;
        sections.push({
          kind: "follow", company: f.company_name, title: `New at ${f.company_name}`, jobs: list,
          moreUrl: fresh.length > list.length
            ? (f.company_slug ? `${SITE_ORIGIN}/companies/${f.company_slug}.html` : `${SITE_ORIGIN}/jobs.html?company=${encodeURIComponent(f.company_name)}`)
            : undefined,
          moreLabel: `See all ${fresh.length} new roles at ${f.company_name}`,
        });
      }

      // 3. Saved searches.
      for (const s of searchesBy.get(candidate.id) || []) {
        const criteria = SM.normalizeCriteria(s.criteria);
        const matches = dedupeJobs(pool.filter((j) => eligible(j) && !shown.has(j.job_id) && SM.matchJob(j, criteria, geo))).sort(newestFirst);
        if (!matches.length) continue;
        const list = matches.slice(0, MAX_JOBS_PER_SEARCH);
        list.forEach((j) => shown.add(j.job_id));
        searchJobs += list.length;
        sections.push({
          kind: "search", title: `Your search: ${s.label}`, jobs: list,
          moreUrl: SM.searchUrl(criteria, SITE_ORIGIN),
          moreLabel: matches.length > list.length ? `See all ${matches.length} new matches` : "Open this search",
        });
      }

      if (sections.length === 0) {
        skippedNoMatch++;
        continue;
      }

      const subject = subjectFor(sections);
      const html = buildEmailHtml(candidate, sections, newsItems, intelStat, cadence);
      if (dryRun) {
        if (only || previews.length < 10) {
          previews.push({
            candidate: candidate.id, cadence, subject,
            sections: sections.map((s) => ({ kind: s.kind, title: s.title, jobs: s.jobs.length })),
            ...(only ? { html } : {}),
          });
        }
        sent++;
        if (cadence === "daily") dailySent++;
        continue;
      }

      const { error: sendError } = await resend.emails.send({
        from: "Verde Talent Jobs <jobs@updates.verdetalent.com>",
        to: candidate.email,
        subject,
        html,
        headers: unsubscribeHeaders(candidate.unsubscribe_token),
      });

      if (sendError) {
        console.error(`Send failed for candidate ${candidate.id}:`, sendError);
        failed++;
        continue;
      }

      await supabaseAdmin
        .from("candidates")
        .update({ last_job_alert_sent_at: now.toISOString(), last_job_alert_watermark: feedWatermark || null })
        .eq("id", candidate.id);
      sent++;
      if (cadence === "daily") dailySent++;
    }

    // Email-only leads: weekly, Mondays, unchanged (jobs first seen in the
    // last 7 days plus live paid postings).
    let leadsSent = 0;
    let leadsSkippedNoMatch = 0;
    let leadsFailed = 0;

    if (isMonday && !only) {
      const { data: leads, error: leadsError } = await supabaseAdmin
        .from("job_alert_leads")
        .select("id, email, sector, location, job_title, unsubscribe_token, last_alert_sent_at")
        .eq("subscribed", true)
        .or(`last_alert_sent_at.is.null,last_alert_sent_at.lt.${weeklyCutoff}`);

      if (leadsError) throw leadsError;

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
        if (suppressed.has((email || "").toLowerCase())) {
          skippedSuppressed++;
          continue;
        }
        const jobs = pickJobs(rows.map((lead) => ({
          sectors: [lead.sector],
          place: parsePersonLocation(lead.location),
          relocation: null,
          roles: [roleFromTitle(lead.job_title)],
        })), jobsBySector);

        if (jobs.length === 0) {
          leadsSkippedNoMatch++;
          continue;
        }
        if (dryRun) {
          leadsSent++;
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
          .update({ last_alert_sent_at: now.toISOString() })
          .in("id", rows.map((r) => r.id));
        leadsSent++;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        dry_run: dryRun,
        weekly_run: isMonday,
        new_jobs_found: recentJobs.length,
        candidates_due: due.length,
        sent,
        daily_sent: dailySent,
        follow_jobs: followJobs,
        search_jobs: searchJobs,
        skipped_no_match: skippedNoMatch,
        skipped_suppressed: skippedSuppressed,
        failed,
        leads_sent: leadsSent,
        leads_skipped_no_match: leadsSkippedNoMatch,
        leads_failed: leadsFailed,
        ...(dryRun ? { previews } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
