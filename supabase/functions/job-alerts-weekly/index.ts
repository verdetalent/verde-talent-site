// Weekly job-match digest. Triggered on a schedule (Supabase Cron -> this
// function), never by a browser - "Verify JWT" stays ON for this function
// in the dashboard, and the cron job's own service-role key satisfies that,
// so no extra secret-header check is needed on top of it.
//
// Matches on sector only for now (candidates.sectors[] vs each job's
// sector_bucket) - the most reliable signal available without getting into
// fuzzy location/text matching. A candidate with zero matching jobs this
// week gets no email at all, rather than an empty one.
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
const MAX_JOBS_PER_EMAIL = 8;
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
  sector_bucket: string | null;
  first_seen: string | null;
  posted_date: string | null;
}

interface Candidate {
  id: string;
  email: string;
  first_name: string | null;
  sectors: string[] | null;
  unsubscribe_token: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildEmailHtml(candidate: Candidate, jobs: JobListing[]): string {
  const firstName = candidate.first_name || "there";
  const unsubscribeUrl = `${SUPABASE_URL}/functions/v1/unsubscribe-job-alerts?token=${candidate.unsubscribe_token}`;
  const rows = jobs.map((job) => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #eee;">
        <a href="${SITE_ORIGIN}/jobs/${job.page_slug}.html" style="font-size:15px;font-weight:600;color:#0A0A0A;text-decoration:none;">${escapeHtml(job.job_title || "Open role")}</a>
        <div style="font-size:13px;color:#666;margin-top:2px;">${escapeHtml(job.company || "")}${job.location ? " · " + escapeHtml(job.location) : ""}</div>
      </td>
    </tr>`).join("");

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#0A0A0A;">
    <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
    <p style="font-size:15px;">Here ${jobs.length === 1 ? "'s a new role" : "are " + jobs.length + " new roles"} matching your sectors on Verde Talent this week:</p>
    <table style="width:100%;border-collapse:collapse;">${rows}</table>
    <p style="margin-top:24px;"><a href="${SITE_ORIGIN}/jobs.html" style="font-size:13px;color:#22E09A;">See all open roles →</a></p>
    <p style="margin-top:32px;font-size:11px;color:#999;">
      You're getting this because job alerts are on for your Verde Talent profile.
      <a href="${unsubscribeUrl}" style="color:#999;">Unsubscribe</a>
    </p>
  </div>`;
}

Deno.serve(async (_req) => {
  try {
    const feedRes = await fetch(JOBS_FEED_URL);
    if (!feedRes.ok) {
      throw new Error(`Could not fetch jobs feed: ${feedRes.status}`);
    }
    const allJobs = (await feedRes.json()) as JobListing[];

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
      .select("id, email, first_name, sectors, unsubscribe_token, last_job_alert_sent_at")
      .eq("email_job_alerts", true)
      .neq("availability", "Not currently looking")
      .not("email", "is", null)
      .or(`last_job_alert_sent_at.is.null,last_job_alert_sent_at.lt.${cooldownCutoff}`);

    if (candidatesError) throw candidatesError;

    let sent = 0;
    let skippedNoMatch = 0;
    let failed = 0;

    for (const candidate of (candidates || []) as Candidate[]) {
      const matched = new Map<string, JobListing>();
      for (const sector of candidate.sectors || []) {
        for (const job of jobsBySector.get(sector) || []) {
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
        html: buildEmailHtml(candidate, jobs),
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

    return new Response(
      JSON.stringify({ success: true, new_jobs_found: newJobs.length, sent, skipped_no_match: skippedNoMatch, failed }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
