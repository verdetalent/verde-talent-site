// Saves a no-account job alert signup (the quick form on create-profile.html)
// and tells the site owner about it.
//
// The browser used to insert one job_alert_leads row per chosen sector
// directly. That works, but gives the server no moment to react to a new
// person - and one signup for four sectors is four inserts, so a per-row
// notification would send four emails for one human. This takes the whole
// signup in one request, saves a row per sector exactly as before
// (unique(email, sector) still stops duplicates), and sends ONE alert if at
// least one sector was new.
//
// Public by necessity (anonymous visitors) - "Verify JWT" stays ON, satisfied
// by the anon key the page sends (same as subscribe-newsletter).
//
// Env vars required: RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

const OWNER_EMAIL = "contact@verdetalent.com";
const ALLOWED_SECTORS = new Set(["Solar", "Wind", "Storage", "Grid", "EV", "Hydrogen", "Policy", "Sustainability"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://verdetalent.com",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The form is public, so a bot could submit thousands of addresses. Every
// signup is still saved - this only caps how many alert emails one server
// instance sends (10 per 10 minutes) so the owner's inbox isn't flooded.
const ALERT_WINDOW_MS = 10 * 60 * 1000;
const ALERT_MAX_PER_WINDOW = 10;
const recentAlerts: number[] = [];

async function alertOwner(email: string, jobTitle: string, location: string, newSectors: string[]) {
  const now = Date.now();
  while (recentAlerts.length && now - recentAlerts[0] > ALERT_WINDOW_MS) recentAlerts.shift();
  if (recentAlerts.length >= ALERT_MAX_PER_WINDOW) {
    console.warn("Job alert owner notifications throttled (burst of signups):", email);
    return;
  }
  recentAlerts.push(now);

  const row = (k: string, v: string) =>
    `<tr><td style="padding:3px 14px 3px 0;color:#6B7280;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:3px 0;">${escapeHtml(v || "-")}</td></tr>`;
  const { error } = await resend.emails.send({
    from: "Verde Talent Alerts <alerts@updates.verdetalent.com>",
    to: OWNER_EMAIL,
    subject: `New job alert signup: ${email}`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#0A0A0A;">
<p style="margin:0 0 10px;font-size:16px;font-weight:700;">New job alert signup (no account)</p>
<table cellpadding="0" cellspacing="0" style="font-size:13.5px;">
${row("Email", email)}
${row("Job title", jobTitle)}
${row("Location", location)}
${row("Sectors", newSectors.join(", "))}
</table>
<p style="margin:12px 0 0;color:#9CA3AF;font-size:12px;">Automatic alert - sent once per signup, listing the sectors that were new.</p>
</div>`,
  });
  if (error) console.error("Owner alert rejected:", error);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const text = await req.text();
    if (text.length > 5000) return jsonResponse({ error: "That submission is too large." }, 413);
    const body = JSON.parse(text);

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const jobTitle = typeof body.job_title === "string" ? body.job_title.trim().slice(0, 100) : "";
    const location = typeof body.location === "string" ? body.location.trim().slice(0, 100) : "";
    const sectors = Array.isArray(body.sectors)
      ? [...new Set(body.sectors.filter((s: unknown): s is string => typeof s === "string" && ALLOWED_SECTORS.has(s)))]
      : [];

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
      return jsonResponse({ error: "Enter a valid email first." }, 400);
    }
    if (!jobTitle) return jsonResponse({ error: "Enter the job title you're looking for." }, 400);
    if (!location) return jsonResponse({ error: "Enter a city, state, or ZIP." }, 400);
    if (sectors.length === 0) return jsonResponse({ error: "Pick at least one sector." }, 400);

    const results = await Promise.all(sectors.map(async (sector) => {
      const { error } = await supabaseAdmin
        .from("job_alert_leads")
        .insert({ email, sector, location, job_title: jobTitle });
      if (!error) return { sector, status: "added" as const };
      if (error.code === "23505") return { sector, status: "already" as const };
      console.error("job_alert_leads insert failed:", sector, error);
      return { sector, status: "failed" as const };
    }));

    const added = results.filter((r) => r.status === "added").map((r) => r.sector);
    const already = results.filter((r) => r.status === "already").map((r) => r.sector);
    const failed = results.filter((r) => r.status === "failed").map((r) => r.sector);

    if (added.length === 0 && already.length === 0) {
      return jsonResponse({ error: "Something went wrong.", added, already, failed }, 500);
    }

    // Best-effort: the signup is saved either way.
    if (added.length > 0) {
      try {
        await alertOwner(email, jobTitle, location, added);
      } catch (alertErr) {
        console.error("Owner alert failed:", alertErr);
      }
    }

    return jsonResponse({ success: true, added, already, failed }, 200);
  } catch (err) {
    console.error("subscribe-job-alert crashed:", err);
    return jsonResponse({ error: "Something went wrong." }, 500);
  }
});
