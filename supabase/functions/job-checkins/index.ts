// Check-ins on jobs a candidate applied to from Verde Talent (candidate_applications, recorded
// by the site's /applies.js), and the answers that come back.
//
//   POST ?run=1         daily, from Supabase Cron (trusted callers only, see isTrustedCaller).
//                       Emails "Did you hear back from <company>?" about one application per
//                       candidate: applied 21-35 days ago, never answered, never asked about.
//                       At most one check-in email a month per candidate; never to
//                       suppressed addresses (email_suppressions) or anyone who stopped them
//                       (candidates.checkin_emails), nor to anyone who told us in the last 90
//                       days that they found a job.
//                       ?dry_run=1 sends nothing and changes nothing; ?only=<email> limits
//                       it to one candidate (and ignores the 21-day wait and monthly limit).
//   POST {action:"info"|"status"|"report", a, t, ...}
//                       from https://verdetalent.com/job-update.html, the page the email's
//                       buttons open. "a" is the application id and "t" its signature, so a
//                       link only ever works for the application it was sent about.
//   GET|POST ?stop=<candidate id>&t=<signature>
//                       "Stop these check-in emails" (and RFC 8058 one-click unsubscribe).
//
// The email's buttons open a page that records the answer, not this function directly: some
// mail scanners open every link in an email. If two different answers to the same email arrive
// within two minutes, it was a scanner, and the application goes back to unanswered.
//
// Public by necessity (email links carry no Authorization header) - deploy with
// --no-verify-jwt. Signatures are HMAC-SHA256(EMAIL_CONFIRM_SECRET, "checkin:" + id), so they
// can't be forged and can't be swapped between purposes.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), RESEND_API_KEY, EMAIL_CONFIRM_SECRET.

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("EMAIL_CONFIRM_SECRET") || "";
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

const SITE_ORIGIN = "https://verdetalent.com";
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/job-checkins`;
const DAY_MS = 24 * 60 * 60 * 1000;
const ASK_AFTER_DAYS = 21;
const ASK_UNTIL_DAYS = 35;
const MONTHLY_DAYS = 30;
const SCANNER_WINDOW_MS = 2 * 60 * 1000;
const STATUSES = ["interviewing", "hired", "no_luck", "not_applied"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function sign(purpose: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${purpose}:${id}`)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verified(purpose: string, id: string, token: string): Promise<boolean> {
  if (!SECRET || !id || !token || id.length > 64) return false;
  return sameString(token, await sign(purpose, id));
}

function clip(v: unknown, n: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, n) : null;
}

// ---- Answers from job-update.html ------------------------------------------------------------

interface AppRow {
  id: string; candidate_id: string; job_title: string | null; company: string | null;
  job_page: string | null; status: string; status_at: string | null; answered_by_email_at: string | null;
}

async function loadApp(id: string): Promise<AppRow | null> {
  const { data } = await db.from("candidate_applications")
    .select("id, candidate_id, job_title, company, job_page, status, status_at, answered_by_email_at")
    .eq("id", id).maybeSingle();
  return (data as AppRow) || null;
}

async function handleAnswer(body: Record<string, unknown>): Promise<Response> {
  const a = String(body.a || "");
  if (!(await verified("checkin", a, String(body.t || "")))) return json({ error: "This link has expired or is incomplete." }, 400);
  const app = await loadApp(a);
  if (!app) return json({ error: "We couldn't find that application." }, 404);
  const { data: cand } = await db.from("candidates").select("first_name").eq("id", app.candidate_id).maybeSingle();
  const info = { job_title: app.job_title, company: app.company, job_page: app.job_page, status: app.status,
                 first_name: (cand && cand.first_name) || "" };

  if (body.action === "info") return json(info);

  if (body.action === "status") {
    const status = String(body.s || "");
    if (!STATUSES.includes(status)) return json({ error: "Unknown answer." }, 400);
    const now = Date.now();
    const recent = app.answered_by_email_at && now - Date.parse(app.answered_by_email_at) < SCANNER_WINDOW_MS;
    if (recent && app.status !== status) {
      // Two different answers within seconds: a link scanner, not a person.
      await db.from("candidate_applications").update({ status: "applied", status_at: null, answered_by_email_at: new Date(now).toISOString() }).eq("id", a);
      console.log(`job-checkins: conflicting answers for ${a} within ${SCANNER_WINDOW_MS / 1000}s - reset to unanswered`);
      return json({ ...info, status: "applied" });
    }
    await db.from("candidate_applications").update({
      status, status_at: new Date(now).toISOString(), answered_by_email_at: new Date(now).toISOString(),
    }).eq("id", a);
    return json({ ...info, status });
  }

  if (body.action === "report") {
    const found = body.found_job === true;
    const via = ["yes", "partly", "no"].includes(String(body.via_verde)) ? String(body.via_verde) : null;
    if (found && !via) return json({ error: "Did you find it through Verde Talent? Pick one." }, 400);
    const consent = ["first_name", "anonymous", "none"].includes(String(body.share_consent)) ? String(body.share_consent) : "first_name";
    const linked = body.for_application !== false;  // false = "found a job somewhere else"
    const row = {
      candidate_id: app.candidate_id,
      application_id: linked ? app.id : null,
      found_job: found,
      via_verde: found ? via : null,
      job_title: found ? clip(body.job_title, 300) : null,
      company: found ? clip(body.company, 200) : null,
      quote: found ? clip(body.quote, 600) : null,
      share_consent: consent,
      asked_from: "checkin_email",
    };
    // Same daily cap as the table's trigger enforces for signed-in answers.
    const { count } = await db.from("candidate_job_reports").select("id", { count: "exact", head: true })
      .eq("candidate_id", app.candidate_id).gte("created_at", new Date(Date.now() - DAY_MS).toISOString());
    if ((count || 0) >= 20) return json({ error: "Too many answers today - please try again tomorrow." }, 429);
    const { error } = await db.from("candidate_job_reports").insert(row);
    if (error) {
      console.error("job-checkins: report insert failed", error);
      return json({ error: "Something went wrong - please try again." }, 500);
    }
    if (found && linked) {
      await db.from("candidate_applications").update({ status: "hired", status_at: new Date().toISOString() }).eq("id", a);
    }
    return json({ ok: true });
  }
  return json({ error: "Unknown action." }, 400);
}

async function handleStop(url: URL, method: string): Promise<Response> {
  const id = url.searchParams.get("stop") || "";
  const ok = await verified("checkin-stop", id, url.searchParams.get("t") || "");
  if (ok) await db.from("candidates").update({ checkin_emails: false }).eq("id", id);
  if (method === "POST") return new Response(null, { status: ok ? 200 : 400 });
  return new Response(null, { status: 302, headers: { Location: `${SITE_ORIGIN}/job-update.html?stopped=${ok ? 1 : 0}` } });
}

// ---- The daily send ---------------------------------------------------------------------------

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

function esc(s: string | null | undefined): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const GRN = "#22E09A";
const INK = "#0A0A0A";
const BORDER = "#E8E8E8";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function button(href: string, label: string, primary: boolean): string {
  const style = primary
    ? `background:${GRN};color:#052e1e;border:1px solid ${GRN};`
    : `background:#FFFFFF;color:${INK};border:1px solid #D4D4D4;`;
  return `<a href="${href}" style="display:inline-block;${style}border-radius:999px;padding:10px 16px;margin:0 6px 8px 0;font-size:14px;font-weight:600;text-decoration:none;font-family:${FONT};">${label}</a>`;
}

function emailHtml(firstName: string, app: AppRow & { applied_at: string }, links: Record<string, string>, stopUrl: string): string {
  const when = new Date(app.applied_at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const role = esc(app.job_title || "a role");
  const roleHtml = app.job_page ? `<a href="${SITE_ORIGIN}${esc(app.job_page)}" style="color:${INK};font-weight:600;">${role}</a>` : `<b>${role}</b>`;
  const co = app.company ? ` at ${esc(app.company)}` : "";
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F5F6F5;font-family:${FONT};">
<div style="display:none;max-height:0;overflow:hidden;">Any news${app.company ? " from " + esc(app.company) : ""}? One click to tell us.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F5;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid ${BORDER};">
<tr><td style="background:${INK};padding:20px 28px;">
  <span style="font-size:18px;font-weight:700;color:#FFFFFF;font-family:${FONT};">Verde <span style="color:${GRN};">Talent</span></span>
</td></tr>
<tr><td style="padding:28px 28px 12px;color:${INK};font-size:15px;line-height:1.6;">
  <p style="margin:0 0 14px;">Hi ${esc(firstName || "there")},</p>
  <p style="margin:0 0 14px;">On ${when} you applied for ${roleHtml}${co} from Verde Talent. Did you hear back?</p>
  <p style="margin:0 0 18px;">One click tells us how it went:</p>
  <div>${button(links.hired, "Got the job! 🎉", true)}${button(links.interviewing, "Interviewing", false)}${button(links.no_luck, "No luck", false)}${button(links.not_applied, "Didn't apply after all", false)}</div>
  <p style="margin:14px 0 0;font-size:13px;color:#6B7280;">Your answer only goes into your Verde Talent account. Employers never see it.</p>
</td></tr>
<tr><td style="padding:16px 28px 28px;border-top:1px solid ${BORDER};">
  <p style="margin:12px 0 0;font-size:11px;color:#9CA3AF;line-height:1.6;">
    Verde Talent · <a href="${SITE_ORIGIN}" style="color:#9CA3AF;">verdetalent.com</a><br/>
    We send at most one of these a month. <a href="${stopUrl}" style="color:#9CA3AF;">Stop these check-in emails</a>
  </p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

async function runSend(url: URL): Promise<Response> {
  const dryRun = url.searchParams.get("dry_run") === "1";
  const only = (url.searchParams.get("only") || "").trim().toLowerCase();
  const now = Date.now();

  let q = db.from("candidate_applications")
    .select("id, candidate_id, job_title, company, job_page, status, status_at, answered_by_email_at, applied_at")
    .eq("status", "applied").is("checkin_sent_at", null)
    // Jobs they added to their tracker themselves weren't applied to from Verde Talent.
    .or("apply_path.is.null,apply_path.neq.manual")
    .gte("applied_at", new Date(now - ASK_UNTIL_DAYS * DAY_MS).toISOString())
    .order("applied_at", { ascending: false }).limit(5000);
  if (!only) q = q.lte("applied_at", new Date(now - ASK_AFTER_DAYS * DAY_MS).toISOString());
  const { data: apps, error } = await q;
  if (error) return json({ error: error.message }, 500);

  // The newest due application per candidate.
  const byCandidate = new Map<string, AppRow & { applied_at: string }>();
  for (const a of (apps || []) as (AppRow & { applied_at: string })[]) if (!byCandidate.has(a.candidate_id)) byCandidate.set(a.candidate_id, a);
  const ids = [...byCandidate.keys()];

  const { data: sup } = await db.from("email_suppressions").select("email");
  const suppressed = new Set((sup || []).map((r: { email: string }) => r.email.toLowerCase()));
  const result = { due: ids.length, sent: 0, skipped: {} as Record<string, number>, samples: [] as unknown[] };
  const skip = (why: string) => { result.skipped[why] = (result.skipped[why] || 0) + 1; };

  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [{ data: cands }, { data: recentHires }] = await Promise.all([
      db.from("candidates").select("id, email, first_name, checkin_emails, last_checkin_email_at").in("id", chunk),
      db.from("candidate_job_reports").select("candidate_id").in("candidate_id", chunk).eq("found_job", true)
        .gte("created_at", new Date(now - 90 * DAY_MS).toISOString()),
    ]);
    const hired = new Set((recentHires || []).map((r: { candidate_id: string }) => r.candidate_id));
    for (const c of (cands || []) as { id: string; email: string | null; first_name: string | null; checkin_emails: boolean; last_checkin_email_at: string | null }[]) {
      const email = (c.email || "").trim().toLowerCase();
      if (only && email !== only) continue;
      if (!email) { skip("no_email"); continue; }
      if (suppressed.has(email)) { skip("suppressed"); continue; }
      if (c.checkin_emails === false) { skip("stopped"); continue; }
      if (hired.has(c.id)) { skip("already_found_job"); continue; }
      if (!only && c.last_checkin_email_at && now - Date.parse(c.last_checkin_email_at) < MONTHLY_DAYS * DAY_MS) { skip("asked_this_month"); continue; }
      const app = byCandidate.get(c.id)!;
      const t = await sign("checkin", app.id);
      const links: Record<string, string> = {};
      for (const s of STATUSES) links[s] = `${SITE_ORIGIN}/job-update.html?a=${app.id}&t=${t}&s=${s}`;
      const stopUrl = `${FUNCTION_URL}?stop=${c.id}&t=${await sign("checkin-stop", c.id)}`;
      const subject = app.company ? `Did you hear back from ${app.company}?` : "Did you hear back about your application?";
      const html = emailHtml(c.first_name || "", app, links, stopUrl);
      if (dryRun) {
        result.samples.push(only ? { to: email, subject, html } : { subject });
        result.sent++;
        continue;
      }
      const { error: sendErr } = await resend.emails.send({
        from: "Verde Talent <jobs@updates.verdetalent.com>",
        to: email,
        replyTo: "contact@verdetalent.com",
        subject,
        html,
        headers: { "List-Unsubscribe": `<${stopUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
      if (sendErr) { console.error("job-checkins: send failed", email, sendErr); skip("send_failed"); continue; }
      const stamp = new Date().toISOString();
      await db.from("candidate_applications").update({ checkin_sent_at: stamp }).eq("id", app.id);
      await db.from("candidates").update({ last_checkin_email_at: stamp }).eq("id", c.id);
      result.sent++;
    }
  }
  console.log("job-checkins run", JSON.stringify({ ...result, samples: undefined, dryRun }));
  return json(result);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    if (url.searchParams.has("stop")) return await handleStop(url, req.method);
    if (url.searchParams.get("run") === "1") {
      if (!(await isTrustedCaller(req))) return json({ error: "Not allowed." }, 401);
      return await runSend(url);
    }
    if (req.method !== "POST") return new Response(null, { status: 302, headers: { Location: SITE_ORIGIN } });
    const body = await req.json().catch(() => ({}));
    return await handleAnswer(body as Record<string, unknown>);
  } catch (err) {
    console.error("job-checkins failed:", err);
    return json({ error: "Something went wrong - please try again." }, 500);
  }
});
