// Weekly job-match digest. Triggered on a schedule (Supabase Cron -> this
// function), never by a browser - "Verify JWT" stays ON for this function
// in the dashboard, and the cron job's own service-role key satisfies that,
// so no extra secret-header check is needed on top of it.
//
// Matches on three things: sector (candidates.sectors[] vs each job's
// sector_bucket), job function/category inferred from the candidate's
// headline (so a Solar Design Engineer doesn't get sent Wind Technician or
// Battery Storage PM roles just because they're all in-sector), and
// location/relocation preference. A candidate with zero matching jobs this
// week gets no email at all, rather than an empty one.
//
// Also sends a lighter-weight digest to job_alert_leads - zero-commitment
// signups from create-profile.html's "get emailed when new jobs open near
// me" box (email + sector + location only, no account). These match on
// sector + location only (no job-title/category refinement, since there's
// no headline/experience to infer one from), and every email carries an
// upsell nudge toward creating a full profile.
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
// jobs open near me" box - email + sector(s) + location + optional job
// title, no account. job_title runs through the same mapJobCategory() rules
// as a candidate's headline, so a lead who typed "Solar Design Engineer"
// still only sees engineering roles, not every Solar job in their state.
// The email carries an upsell nudge toward a full profile for even tighter
// matching (job-level detail a plain title can't capture).
interface Lead {
  id: string;
  email: string;
  sector: string;
  location: string;
  job_title: string | null;
  unsubscribe_token: string;
}

// Ported from taxonomy/job_category.py on the crawler side - same rules,
// same order (first match wins, most specific categories listed first),
// so a candidate's inferred category lines up with what a job listing was
// actually tagged with. Kept in sync by hand; not imported directly since
// this Edge Function has no access to that repo.
const JOB_CATEGORY_RULES: [string, RegExp[]][] = [
  ["Project/Program Management", [/\bproject manage/, /\bprogram manage/]],
  ["Engineering", [/\bengineer(ing)?\b/]],
  ["Construction/Field", [/\bconstruction\b/, /\bfield (service|technician)\b/, /\blineman\b/, /\btechnician\b/, /\binstaller\b/]],
  ["Sales", [/\bsales\b/, /\baccount executive\b/, /\bbusiness development\b/]],
  ["Finance/Accounting", [/\bfinance\b/, /\baccount(ant|ing)\b/, /\bfp&a\b/, /\btax\b/, /\baudit\b/, /\btreasury\b/]],
  ["Legal", [/\blegal\b/, /\bcounsel\b/, /\bcompliance\b/, /\bcontracts?\b/, /\bimmigration\b/]],
  ["Supply Chain/Procurement", [/\bsupply chain\b/, /\bprocurement\b/, /\bsourcing\b/, /\blogistics\b/, /\bwarehouse\b/, /\bmaterials\b/]],
  ["HR/Talent", [/\bhuman resources\b/, /\bhr\b/, /\btalent\b/, /\brecruit(er|ing|ment)\b/, /\bpeople\b/]],
  ["IT/Technology", [/\binformation technology\b/, /\bit support\b/, /\bsoftware\b/, /\bcyber\b/, /\bdata\b/, /\bnetwork\b/, /\bapplication(s)? develop/]],
  ["Marketing/Communications", [/\bmarketing\b/, /\bcommunications\b/, /\bbrand\b/, /\bpublic relations\b/]],
  ["Safety/EHS", [/\bsafety\b/, /\behs\b/, /\benvironmental health\b/]],
  ["Customer Service", [/\bcustomer (service|experience|success)\b/, /\bcall center\b/]],
  ["Real Estate/Land", [/\breal estate\b/, /\bland (manager|agent)\b/]],
  ["Operations", [/\boperations?\b/, /\boperator\b/, /\bo&m\b/]],
];

function mapJobCategory(title: string | null | undefined): string | null {
  const text = (title || "").toLowerCase();
  if (!text) return null;
  for (const [category, patterns] of JOB_CATEGORY_RULES) {
    if (patterns.some((p) => p.test(text))) return category;
  }
  return null;
}

// Prefers the headline (what the candidate explicitly said they are) over
// past experience titles, falling back to the most recent listed job only
// if the headline itself doesn't resolve to a category.
function candidateJobCategory(candidate: Candidate): string | null {
  const fromHeadline = mapJobCategory(candidate.headline);
  if (fromHeadline) return fromHeadline;
  for (const exp of candidate.experience || []) {
    const fromExp = mapJobCategory(exp.title);
    if (fromExp) return fromExp;
  }
  return null;
}

// Full name -> abbreviation, so a candidate typing "Austin, Texas" still
// matches a job listing normalized to "Austin, TX" (see
// taxonomy/location_display.py on the crawler side for the same idea).
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

function extractStateAbbr(text: string | null): string | null {
  if (!text) return null;
  const abbrMatch = text.match(/\b([A-Z]{2})\b/);
  if (abbrMatch && Object.values(US_STATE_ABBR).includes(abbrMatch[1])) return abbrMatch[1];
  const lower = text.toLowerCase();
  for (const [name, abbr] of Object.entries(US_STATE_ABBR)) {
    if (lower.includes(name)) return abbr;
  }
  return null;
}

// A candidate should only see a job they could actually take without
// relocating, unless they've said they're open to that. Remote jobs are
// always fair game regardless of relocation preference - no move required.
function jobMatchesLocation(job: JobListing, candidate: Candidate): boolean {
  if (job.is_remote) return true;
  if (candidate.relocation === "Yes — anywhere") return true;
  if (candidate.relocation === "Yes — US only") return job.region === "US";
  // "No" (or unset) - only jobs in the candidate's own state.
  const candidateState = extractStateAbbr(candidate.location);
  const jobState = extractStateAbbr(job.location);
  return !!candidateState && candidateState === jobState;
}

// Approximate USPS ZIP-prefix -> state blocks (first 3 digits of a 5-digit
// ZIP), so a lead who types a bare ZIP still gets state-level matching like
// everyone else. Boundaries are close but not exact at the edges - good
// enough for "does this job's state match the lead's state", not meant as
// an authoritative ZIP database.
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

// Leads can enter a bare ZIP instead of "City, State" - try that first,
// fall back to the same name/abbreviation matching used everywhere else.
function extractStateAbbrOrZip(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const zipMatch = trimmed.match(/^(\d{5})(-\d{4})?$/);
  if (zipMatch) return zip3ToState(parseInt(zipMatch[1].slice(0, 3), 10));
  return extractStateAbbr(trimmed);
}

// Leads never state a relocation preference (it's a "near me" ask by
// design), so this is the "No"-relocation branch of jobMatchesLocation
// above: remote jobs always qualify, everything else has to be in-state.
function jobMatchesLeadLocation(job: JobListing, lead: Lead): boolean {
  if (job.is_remote) return true;
  const leadState = extractStateAbbrOrZip(lead.location);
  const jobState = extractStateAbbr(job.location);
  return !!leadState && leadState === jobState;
}

interface NewsItem {
  title: string;
  link: string;
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
    if (title && link) items.push({ title, link });
  }
  return items.slice(0, MAX_NEWS_ITEMS);
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

function buildEmailHtml(candidate: Candidate, jobs: JobListing[], news: NewsItem[]): string {
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

  // No news sidebar at all (rather than an empty one) if the feed came back
  // empty - a missing section is less jarring than a header with nothing
  // under it.
  const mainContent = news.length === 0 ? jobsColumn : `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td class="vt-main-col" valign="top" width="66%" style="padding-right:20px;">${jobsColumn}</td>
        <td class="vt-side-col" valign="top" width="34%" style="border-left:1px solid ${BORDER};padding-left:20px;">
          <div style="font-size:11px;font-weight:700;color:#9CA3AF;letter-spacing:.04em;text-transform:uppercase;margin-bottom:10px;">In the news</div>
          ${news.map((item) => `<div style="margin-bottom:14px;"><a href="${escapeHtml(item.link)}" style="font-size:12.5px;font-weight:600;color:${INK};text-decoration:none;line-height:1.4;display:block;">${escapeHtml(item.title)}</a></div>`).join("")}
          <a href="${SITE_ORIGIN}/news.html" style="font-size:11.5px;color:${GRN};text-decoration:none;font-weight:600;">More news →</a>
        </td>
      </tr>
    </table>`;

  return emailShell(`${jobs.length} new job${jobs.length === 1 ? "" : "s"} matching your profile`, greeting + mainContent, unsubscribeUrl);
}

function buildLeadEmailHtml(lead: Lead, jobs: JobListing[], news: NewsItem[]): string {
  const unsubscribeUrl = `${SUPABASE_URL}/functions/v1/unsubscribe-job-alerts?token=${lead.unsubscribe_token}`;
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
    <p style="margin:0 0 4px;font-size:16px;font-weight:700;color:${INK};">Hi there,</p>
    <p style="margin:0 0 20px;font-size:14px;color:${MUTED};line-height:1.5;">Here ${jobs.length === 1 ? "'s a new " + escapeHtml(lead.sector) + " role" : "are " + jobs.length + " new " + escapeHtml(lead.sector) + " roles"} open near ${escapeHtml(lead.location)} this week.</p>`;

  // The upsell - these are zero-commitment leads, so every send is a chance
  // to nudge them toward a full profile (better matching: job title, not
  // just sector + state).
  const upsell = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;">
      <tr><td style="background:#F5F6F5;border-radius:10px;padding:16px 18px;">
        <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:${INK};">Want more precise matches?</p>
        <p style="margin:0 0 10px;font-size:12.5px;color:${MUTED};line-height:1.5;">Create a free profile and we'll match you by job title too, not just sector and location.</p>
        <a href="${SITE_ORIGIN}/create-profile.html" style="font-size:12.5px;font-weight:600;color:${GRN};text-decoration:none;">Create your free profile →</a>
      </td></tr>
    </table>`;

  const mainContent = news.length === 0 ? jobsColumn : `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td class="vt-main-col" valign="top" width="66%" style="padding-right:20px;">${jobsColumn}</td>
        <td class="vt-side-col" valign="top" width="34%" style="border-left:1px solid ${BORDER};padding-left:20px;">
          <div style="font-size:11px;font-weight:700;color:#9CA3AF;letter-spacing:.04em;text-transform:uppercase;margin-bottom:10px;">In the news</div>
          ${news.map((item) => `<div style="margin-bottom:14px;"><a href="${escapeHtml(item.link)}" style="font-size:12.5px;font-weight:600;color:${INK};text-decoration:none;line-height:1.4;display:block;">${escapeHtml(item.title)}</a></div>`).join("")}
          <a href="${SITE_ORIGIN}/news.html" style="font-size:11.5px;color:${GRN};text-decoration:none;font-weight:600;">More news →</a>
        </td>
      </tr>
    </table>`;

  return emailShell(`${jobs.length} new ${lead.sector} job${jobs.length === 1 ? "" : "s"} near ${lead.location}`, greeting + mainContent + upsell, unsubscribeUrl);
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
      // If we can't tell what role the candidate is after (no headline or
      // experience title that maps to a category), fall back to
      // sector+location only rather than sending nothing - being unable to
      // narrow further is a smaller problem than an inference gap silently
      // zeroing out their email.
      const category = candidateJobCategory(candidate);
      const matched = new Map<string, JobListing>();
      for (const sector of candidate.sectors || []) {
        for (const job of jobsBySector.get(sector) || []) {
          if (!jobMatchesLocation(job, candidate)) continue;
          if (category && job.job_category && job.job_category !== category) continue;
          matched.set(job.job_id, job);
        }
      }
      const jobs = [...matched.values()].slice(0, MAX_JOBS_PER_EMAIL);
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
        html: buildEmailHtml(candidate, jobs, newsItems),
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

    for (const lead of (leads || []) as Lead[]) {
      const category = mapJobCategory(lead.job_title);
      const jobs = (jobsBySector.get(lead.sector) || [])
        .filter((job) => jobMatchesLeadLocation(job, lead))
        .filter((job) => !category || !job.job_category || job.job_category === category)
        .slice(0, MAX_JOBS_PER_EMAIL);

      if (jobs.length === 0) {
        leadsSkippedNoMatch++;
        continue;
      }

      const { error: sendError } = await resend.emails.send({
        from: "Verde Talent Jobs <jobs@updates.verdetalent.com>",
        to: lead.email,
        subject: jobs.length === 1
          ? `1 new ${lead.sector} job near ${lead.location}`
          : `${jobs.length} new ${lead.sector} jobs near ${lead.location}`,
        html: buildLeadEmailHtml(lead, jobs, newsItems),
      });

      if (sendError) {
        console.error(`Send failed for lead ${lead.id}:`, sendError);
        leadsFailed++;
        continue;
      }

      await supabaseAdmin
        .from("job_alert_leads")
        .update({ last_alert_sent_at: new Date().toISOString() })
        .eq("id", lead.id);
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
