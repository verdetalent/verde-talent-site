// Weekly newsletter. Triggered on a schedule (Supabase Cron -> this
// function), never by a browser - same pattern as job-alerts-weekly.
//
// Three content sources:
//   - News: feed.xml (same feed built for the abandoned Beehiiv path -
//     export_rss_feed_to_verde_talent.py in the renewable-energy-jobs repo)
//   - Featured jobs: public_job_postings (paid employer listings) - queried
//     directly since this function already has a service-role client, no
//     extra fetch needed. Gives paying employers real newsletter exposure.
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
    if (title && link) items.push({ title, link, description, category, isDomestic });
  }
  return items;
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
}

async function fetchFeaturedJobs(): Promise<FeaturedJob[]> {
  const { data, error } = await supabaseAdmin
    .from("public_job_postings")
    .select("id, job_title, company_name, location")
    .order("paid_at", { ascending: false })
    .limit(MAX_FEATURED_JOBS);
  if (error) {
    console.error("Could not fetch featured jobs (non-fatal):", error);
    return [];
  }
  return data || [];
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
      <a href="${item.link}" style="font-size:15px;font-weight:600;color:${INK};text-decoration:none;">${escapeHtml(item.title)}</a>
      <div style="font-size:13px;color:${MUTED};margin-top:4px;line-height:1.5;">${item.description}</div>
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
        <a href="${SITE_ORIGIN}/employer-job.html?id=${job.id}" style="font-size:12.5px;font-weight:600;color:${INK};text-decoration:none;line-height:1.4;display:block;">${escapeHtml(job.job_title)}</a>
        <div style="font-size:11.5px;color:${MUTED};margin-top:2px;">${escapeHtml(job.company_name)}${job.location ? " · " + escapeHtml(job.location) : ""}</div>
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
    const [featuredJobs, intelStat] = await Promise.all([fetchFeaturedJobs(), fetchIntelStat()]);

    const { data: subscribers, error } = await supabaseAdmin
      .from("newsletter_subscribers")
      .select("id, email, unsubscribe_token")
      .eq("subscribed", true);
    if (error) throw error;

    let sent = 0;
    let failed = 0;

    for (const sub of subscribers || []) {
      const { error: sendError } = await resend.emails.send({
        from: "Verde Talent Newsletter <newsletter@updates.verdetalent.com>",
        to: sub.email,
        subject: "This week in clean energy — Verde Talent",
        html: buildEmailHtml(items, featuredJobs, intelStat, sub.unsubscribe_token),
      });
      if (sendError) {
        console.error(`Send failed for subscriber ${sub.id}:`, sendError);
        failed++;
        continue;
      }
      sent++;
    }

    return new Response(
      JSON.stringify({ success: true, items_included: items.length, featured_jobs: featuredJobs.length, has_intel_stat: !!intelStat, sent, failed }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
