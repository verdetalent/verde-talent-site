// Weekly newsletter. Triggered on a schedule (Supabase Cron -> this
// function), never by a browser - same pattern as job-alerts-weekly.
//
// Three content sources:
//   - News: feed.xml (same feed built for the abandoned Beehiiv path -
//     export_rss_feed_to_verde_talent.py in the renewable-energy-jobs repo)
//   - Featured jobs: live paid employer postings (job_postings) and
//     data/jobs_feed.json (the general scraped/aggregated listings
//     job-alerts-weekly also reads) in one pool, preferring jobs in each
//     subscriber's own area - paid postings lead only where their location
//     fits, and are marked "Promoted". Area is typed at signup into an
//     optional "City, State, or ZIP" box and resolved to a state by
//     subscribe-newsletter, stored on newsletter_subscribers.location.
//     Same location rule as job-alerts-weekly: US subscribers never get
//     foreign roles; subscribers who typed a foreign place ("Berlin,
//     Germany", kept in location_input) get only their country's roles.
//   - One intel stat: data/intelligence.json, same file intelligence.html
//     reads. Several candidate stat sentences are generated and one is
//     picked by ISO week number, so it's a different (but stable for the
//     week, not random per-send) stat each time without needing to
//     persist any state.
//
// Sends to everyone in newsletter_subscribers with subscribed=true - this
// list is open-signup (any visitor, not just candidates), kept entirely
// separate from job-alerts-weekly's candidate-only list.
//
// Env vars required (set via `supabase secrets set`):
//   RESEND_API_KEY            - same key the other Edge Functions use
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SITE_ORIGIN = "https://verdetalent.com";
const FEED_URL = `${SITE_ORIGIN}/feed.xml`;
const INTELLIGENCE_URL = `${SITE_ORIGIN}/data/intelligence.json`;
const JOBS_FEED_URL = `${SITE_ORIGIN}/data/jobs_feed.json`;
const MIN_ITEMS = 5;
const MAX_ITEMS = 10;
const MAX_FEATURED_JOBS = 5;

interface FeedItem {
  title: string;
  link: string;
  description: string;
  category: string | null;
  isDomestic: boolean;
}

// Small hand-rolled RSS parser rather than pulling in an XML/DOM library
// for a Deno edge function - feed.xml's shape is fixed and simple (we
// generate it ourselves), so a few regexes are enough and avoid a new
// dependency for five fields. Returns every item in the feed, unsliced -
// the caller decides how many to use after reordering by isDomestic, since
// slicing here first would mean only ever reordering within whatever
// happened to be chronologically first, missing domestic stories sitting
// just past that cutoff.
function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    const description = block.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() || "";
    const category = block.match(/<category>([\s\S]*?)<\/category>/)?.[1]?.trim() || null;
    const isDomestic = block.match(/<domestic>([\s\S]*?)<\/domestic>/)?.[1]?.trim() !== "false";
    if (title && link) {
      items.push({ title: decodeXml(title), link: decodeXml(link), description: decodeXml(description), category, isDomestic });
    }
  }
  return items;
}

// feed.xml is XML, so "PG&E" arrives as "PG&amp;E" and apostrophes as
// "&#39;". Decoded here to plain text, then escapeHtml()'d once on the way
// into the email - escaping the still-encoded text is what printed
// "PG&amp;E" in subscribers' inboxes. Same fix as job-alerts-weekly.
function decodeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Stable partition: domestic stories first (in their original, most-recent-
// first order), then international ones filling any remaining slots - so
// the top of the newsletter isn't dominated by international news just
// because a handful of international stories happened to be posted most
// recently, while still surfacing international stories once domestic
// supply runs out.
function orderDomesticFirst(items: FeedItem[]): FeedItem[] {
  const domestic = items.filter((i) => i.isDomestic);
  const international = items.filter((i) => !i.isDomestic);
  return [...domestic, ...international];
}

interface FeaturedJob {
  id: string;
  job_title: string;
  company_name: string;
  location: string | null;
  link: string;
  paid: boolean;
}

interface GeneralJobListing {
  page_slug: string;
  job_title: string | null;
  company: string | null;
  location: string | null;
  region: string | null;
  is_remote: boolean;
  first_seen: string | null;
  // Set only on paid employer postings (fetchPaidListings).
  link?: string;
  paid?: boolean;
}

// jobs_feed.json's location field is a free-text scrape result - usually
// "City, ST" or a bare "ST", sometimes "Remote"/"Location not listed"/a
// full international place name. Pulling out a trailing two-letter state
// code is the only piece of it that's reliably comparable to a
// subscriber's state.
function extractStateCode(location: string | null): string | null {
  if (!location) return null;
  const match = location.match(/\b([A-Z]{2})$/);
  return match ? match[1] : null;
}

// ---- Countries ------------------------------------------------------------
// Copied from job-alerts-weekly (same rules there): subscribers who typed
// a foreign location ("Berlin, Germany") get Featured jobs from their own
// country; everyone else never sees foreign roles. Originally ported from
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

function jobCountry(job: GeneralJobListing): string | null {
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

// Live paid employer postings, shaped like feed listings so they compete in
// the same pool (buildFeaturedJobsFor) instead of always filling the top
// slots - a paid posting only leads when its location fits the
// subscriber. Read from job_postings rather than the public view, which
// doesn't carry is_international.
async function fetchPaidListings(): Promise<GeneralJobListing[]> {
  const { data, error } = await supabaseAdmin
    .from("job_postings")
    .select("id, job_title, company_name, location, is_international, paid_at")
    .eq("status", "paid")
    .gt("expires_at", new Date().toISOString());
  if (error) {
    console.error("Could not fetch paid job postings (non-fatal):", error);
    return [];
  }
  return (data || []).map((p) => ({
    page_slug: `paid-${p.id}`,
    link: `${SITE_ORIGIN}/employer-job.html?id=${p.id}`,
    job_title: p.job_title,
    company: p.company_name,
    location: p.location,
    region: p.is_international ? "International" : "US",
    is_remote: /\bremote\b/i.test(p.location || ""),
    first_seen: p.paid_at,
    paid: true,
  }));
}

async function fetchGeneralJobListings(): Promise<GeneralJobListing[]> {
  try {
    const res = await fetch(JOBS_FEED_URL);
    if (!res.ok) return [];
    const listings = (await res.json()) as GeneralJobListing[];
    // International roles stay in the list - buildFeaturedJobsFor keeps
    // them away from US subscribers and gives them to subscribers abroad.
    return listings
      .filter((job) => job.job_title && job.company && job.page_slug)
      .sort((a, b) => (b.first_seen || "").localeCompare(a.first_seen || ""));
  } catch (err) {
    console.error("Could not fetch general job listings (non-fatal):", err);
    return [];
  }
}

// The subscriber's MAX_FEATURED_JOBS, from free and paid listings alike,
// depending on where they are:
//   - In the US: listings in their own state plus US remote roles first,
//     then whatever's most recent in the US. Never foreign roles - a German
//     posting listed as "SH, DE" would otherwise pass as Delaware.
//   - Abroad (typed e.g. "Berlin, Germany"): only roles in that country,
//     their own city first, then most recent - no US backfill.
//   - No location on file (box left blank, or not a place we recognize):
//     the US most-recent list.
// Paid postings go first only within a group that matches the subscriber's
// location (their state + remote, or their city / country). In the
// backfill, or for a subscriber with no location, they're ordered like any
// other listing - newest first. Newsletter subscribers give no job title,
// so title can't be weighed here (job-alerts-weekly does).
// The feed can carry the same posting twice under different ids (a company
// re-listing it) - each shows once.
function buildFeaturedJobsFor(
  listings: GeneralJobListing[],
  subscriberState: string | null,
  subscriberCountry: string | null,
  subscriberCity: string | null,
): FeaturedJob[] {
  const toFeaturedJob = (job: GeneralJobListing): FeaturedJob => ({
    id: job.page_slug,
    job_title: job.job_title!,
    company_name: job.company!,
    location: job.location,
    link: job.link || `${SITE_ORIGIN}/jobs/${job.page_slug}.html`,
    paid: !!job.paid,
  });
  const newestFirst = (a: GeneralJobListing, b: GeneralJobListing) => (b.first_seen || "").localeCompare(a.first_seen || "");
  const paidFirst = (group: GeneralJobListing[]) => [...group.filter((j) => j.paid), ...group.filter((j) => !j.paid)];

  let pool: GeneralJobListing[];
  if (subscriberCountry && subscriberCountry !== "US") {
    const inCountry = listings.filter((job) => jobCountry(job) === subscriberCountry).sort(newestFirst);
    const city = (subscriberCity || "").toLowerCase();
    const inCity = (job: GeneralJobListing) => !!city && (job.location || "").toLowerCase().includes(city);
    pool = [...paidFirst(inCountry.filter(inCity)), ...paidFirst(inCountry.filter((job) => !inCity(job)))];
  } else {
    const us = listings.filter((job) => job.region !== "International").sort(newestFirst);
    pool = us;
    if (subscriberState) {
      const matchesSubscriber = (job: GeneralJobListing) =>
        job.is_remote || extractStateCode(job.location) === subscriberState;
      pool = [...paidFirst(us.filter(matchesSubscriber)), ...us.filter((job) => !matchesSubscriber(job))];
    }
  }

  const seen = new Set<string>();
  pool = pool.filter((job) => {
    const key = `${job.job_title}|${job.company}|${job.location}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return pool.slice(0, MAX_FEATURED_JOBS).map(toFeaturedJob);
}

// Several candidate stat sentences from data/intelligence.json (the same
// file intelligence.html reads) - one is picked per send, rotated by ISO
// week number so it's stable for the week and changes next week, without
// needing to persist any "last used" state anywhere.
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

function buildEmailHtml(items: FeedItem[], featuredJobs: FeaturedJob[], intelStat: string | null, unsubscribeToken: string): string {
  const unsubscribeUrl = `${SUPABASE_URL}/functions/v1/unsubscribe-newsletter?token=${unsubscribeToken}`;
  const newsRows = items.map((item) => `
    <tr><td style="padding:14px 0;border-bottom:1px solid ${BORDER};">
      <a href="${escapeHtml(item.link)}" style="font-size:15px;font-weight:600;color:${INK};text-decoration:none;">${escapeHtml(item.title)}</a>
      <div style="font-size:13px;color:${MUTED};margin-top:4px;line-height:1.5;">${escapeHtml(item.description)}</div>
    </td></tr>`).join("");

  const newsColumn = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${newsRows}</table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px;">
      <tr><td style="background:${GRN};border-radius:9px;">
        <a href="${SITE_ORIGIN}/news.html" style="display:inline-block;padding:11px 20px;font-size:13px;font-weight:600;color:#052e1e;text-decoration:none;">Read more on Verde Talent →</a>
      </td></tr>
    </table>`;

  const featuredJobsHtml = featuredJobs.length === 0 ? "" : `
    <div style="font-size:11px;font-weight:700;color:#9CA3AF;letter-spacing:.04em;text-transform:uppercase;margin-bottom:10px;">Featured jobs</div>
    ${featuredJobs.map((job) => `
      <div style="margin-bottom:12px;">
        <a href="${escapeHtml(job.link)}" style="font-size:12.5px;font-weight:600;color:${INK};text-decoration:none;line-height:1.4;display:block;">${escapeHtml(job.job_title)}</a>
        <div style="font-size:11.5px;color:${MUTED};margin-top:2px;">${job.paid ? `<span style="font-size:10px;font-weight:700;color:#0B7A55;">Promoted</span> · ` : ""}${escapeHtml(job.company_name)}${job.location ? " · " + escapeHtml(job.location) : ""}</div>
      </div>`).join("")}
    <a href="${SITE_ORIGIN}/jobs.html" style="font-size:11.5px;color:${GRN};text-decoration:none;font-weight:600;">See all jobs →</a>`;

  const intelStatHtml = !intelStat ? "" : `
    <div style="font-size:11px;font-weight:700;color:#9CA3AF;letter-spacing:.04em;text-transform:uppercase;margin-bottom:10px;${featuredJobs.length ? "margin-top:24px;" : ""}">Industry intel</div>
    <div style="font-size:12.5px;color:${INK};line-height:1.5;margin-bottom:8px;">${escapeHtml(intelStat)}</div>
    <a href="${SITE_ORIGIN}/intelligence.html" style="font-size:11.5px;color:${GRN};text-decoration:none;font-weight:600;">See full dashboard →</a>`;

  const hasSidebar = featuredJobsHtml || intelStatHtml;
  const preheader = "This week's clean energy news from Verde Talent";

  const mainContent = !hasSidebar ? `
    <p style="margin:0 0 20px;font-size:14px;color:${MUTED};line-height:1.5;">This week's clean energy news from Verde Talent:</p>
    ${newsColumn}` : `
    <p style="margin:0 0 20px;font-size:14px;color:${MUTED};line-height:1.5;">This week's clean energy news from Verde Talent:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td class="vt-main-col" valign="top" width="66%" style="padding-right:20px;">${newsColumn}</td>
        <td class="vt-side-col" valign="top" width="34%" style="border-left:1px solid ${BORDER};padding-left:20px;">
          ${featuredJobsHtml}
          ${intelStatHtml}
        </td>
      </tr>
    </table>`;

  return emailShell(preheader, mainContent, unsubscribeUrl);
}

Deno.serve(async (_req) => {
  try {
    const feedRes = await fetch(FEED_URL);
    if (!feedRes.ok) throw new Error(`Could not fetch feed.xml: ${feedRes.status}`);
    const rawItems = parseFeed(await feedRes.text());

    // feed.xml isn't filtered to "this week only" - it's the most recent
    // Approved rows regardless of age, so this floor is really just a "is
    // there even enough real content" guard rather than something
    // expected to trigger often.
    if (rawItems.length < MIN_ITEMS) {
      return new Response(
        JSON.stringify({ success: true, sent: 0, note: `Only ${rawItems.length} feed item(s) available (need at least ${MIN_ITEMS}) - nothing sent.` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const items = orderDomesticFirst(rawItems).slice(0, MAX_ITEMS);
    const [paidJobs, generalJobs, intelStat] = await Promise.all([
      fetchPaidListings(),
      fetchGeneralJobListings(),
      fetchIntelStat(),
    ]);

    const { data: subscribers, error } = await supabaseAdmin
      .from("newsletter_subscribers")
      .select("id, email, unsubscribe_token, location, location_input")
      .eq("subscribed", true);
    if (error) throw error;

    let sent = 0;
    let failed = 0;

    for (const sub of subscribers || []) {
      const unsubscribeUrl = `${SUPABASE_URL}/functions/v1/unsubscribe-newsletter?token=${sub.unsubscribe_token}`;
      // A US state on file wins; only without one is the typed text checked
      // for a foreign country ("Berlin, Germany").
      const abroad = !sub.location && sub.location_input ? personCountry(sub.location_input) : null;
      const featuredJobs = buildFeaturedJobsFor([...paidJobs, ...generalJobs], sub.location, abroad ? abroad.country : null, abroad ? abroad.city : null);
      const { error: sendError } = await resend.emails.send({
        from: "Verde Talent Newsletter <newsletter@updates.verdetalent.com>",
        to: sub.email,
        subject: "This week in clean energy — Verde Talent",
        html: buildEmailHtml(items, featuredJobs, intelStat, sub.unsubscribe_token),
        headers: {
          // RFC 8058 one-click unsubscribe - unsubscribe-newsletter already
          // handles the request the same way regardless of method (GET from
          // the body link, POST from mail clients honoring this header), so
          // no change needed there.
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      if (sendError) {
        console.error(`Send failed for subscriber ${sub.id}:`, sendError);
        failed++;
        continue;
      }
      sent++;
    }

    return new Response(
      JSON.stringify({ success: true, items_included: items.length, paid_jobs: paidJobs.length, general_jobs_available: generalJobs.length, has_intel_stat: !!intelStat, sent, failed }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
