// "No Apply clicks? Free 30 more days" - the Post a Job promise. Run daily by Supabase Cron.
//
// Every paid posting that is about to end (within the next 24 hours, or ended in the last 7 days
// and was missed) with ZERO clicks on its Apply button on Verde Talent (posting_apply_clicks) is
// extended 30 days, once per posting (job_postings.guarantee_extended_at), and the employer gets
// an email saying so. Click counts are never shown to employers (internal only).
//
// Trusted callers only (the cron's secret key). ?dry_run=1 lists what would happen, changes nothing.
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), RESEND_API_KEY.

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);
const DAY_MS = 24 * 60 * 60 * 1000;
const EXTRA_DAYS = 30;

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (!(await isTrustedCaller(req))) return json({ error: "Not allowed." }, 401);
  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  const now = Date.now();
  try {
    const { data: postings, error } = await db.from("job_postings")
      .select("id, job_title, company_name, company_email, expires_at, manage_token")
      .eq("status", "paid")
      .is("guarantee_extended_at", null)
      .lte("expires_at", new Date(now + DAY_MS).toISOString())
      .gt("expires_at", new Date(now - 7 * DAY_MS).toISOString());
    if (error) throw error;

    const result = { checked: (postings || []).length, extended: [] as string[], had_clicks: 0 };
    for (const p of postings || []) {
      const { count, error: countError } = await db.from("posting_apply_clicks")
        .select("id", { count: "exact", head: true }).eq("job_posting_id", p.id);
      if (countError) { console.error("click count failed", p.id, countError); continue; }
      if ((count || 0) > 0) { result.had_clicks++; continue; }

      const base = Math.max(Date.parse(p.expires_at), now);
      const newEnd = new Date(base + EXTRA_DAYS * DAY_MS);
      result.extended.push(`${p.job_title} at ${p.company_name}`);
      if (dryRun) continue;

      const { error: updateError } = await db.from("job_postings")
        .update({ expires_at: newEnd.toISOString(), guarantee_extended_at: new Date(now).toISOString() })
        .eq("id", p.id).is("guarantee_extended_at", null);
      if (updateError) { console.error("extension failed", p.id, updateError); continue; }

      const until = newEnd.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
      const manageUrl = `https://verdetalent.com/manage-posting.html?id=${p.id}&token=${p.manage_token}`;
      const { error: emailError } = await resend.emails.send({
        from: "Verde Talent <postings@updates.verdetalent.com>",
        to: p.company_email,
        replyTo: "contact@verdetalent.com",
        subject: `We've extended your posting free for 30 days: ${p.job_title}`,
        text: [
          `Your posting "${p.job_title}" at ${p.company_name} hasn't had any Apply clicks on Verde Talent yet, so as promised we've kept it live for another 30 days at no charge.`,
          ``,
          `It now runs until ${until}. You don't need to do anything.`,
          ``,
          `Manage or remove it any time: ${manageUrl}`,
          ``,
          `Questions? Just reply to this email.`,
        ].join("\n"),
      });
      if (emailError) console.error("extension email failed", p.id, emailError);
    }
    console.log("posting-guarantee", JSON.stringify({ ...result, dryRun }));
    return json({ ...result, dry_run: dryRun });
  } catch (err) {
    console.error("posting-guarantee failed:", err);
    return json({ error: "failed" }, 500);
  }
});
