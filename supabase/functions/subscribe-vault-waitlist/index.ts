// Saves a Resume Vault waitlist signup (the "Notify me" box on resume-vault.html)
// and tells the site owner about it.
//
// The box used to open a pre-filled email to contact@ - nothing was saved unless
// the visitor also pressed Send in their own mail app. This stores the address
// in vault_waitlist (unique email, so a repeat signup is just "already on the
// list") and sends one owner alert per new address.
//
// Public by necessity (anonymous visitors) - "Verify JWT" stays ON, satisfied
// by the anon key the page sends (same as subscribe-job-alert).
//
// Env vars required: RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

const OWNER_EMAIL = "contact@verdetalent.com";

// How this visitor first found the site, recorded in the browser by fullstory.js
// (vt_first_touch). Only these keys, as short strings, are ever stored.
function cleanFirstTouch(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["source", "medium", "campaign", "referrer", "landing", "ai_engine", "date"]) {
    if (typeof r[k] === "string" && r[k]) out[k] = (r[k] as string).slice(0, 120);
  }
  if (typeof r.ai === "boolean") out.ai = r.ai;
  return Object.keys(out).length ? out : null;
}

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

// The box is public, so a bot could submit thousands of addresses. Every signup
// is still saved - this only caps owner alert emails per server instance.
const ALERT_WINDOW_MS = 10 * 60 * 1000;
const ALERT_MAX_PER_WINDOW = 10;
const recentAlerts: number[] = [];

async function alertOwner(email: string, firstTouch: Record<string, unknown> | null) {
  const now = Date.now();
  while (recentAlerts.length && now - recentAlerts[0] > ALERT_WINDOW_MS) recentAlerts.shift();
  if (recentAlerts.length >= ALERT_MAX_PER_WINDOW) {
    console.warn("Vault waitlist owner notifications throttled (burst of signups):", email);
    return;
  }
  recentAlerts.push(now);

  const domain = email.split("@")[1] || "";
  const source = firstTouch ? [firstTouch.source, firstTouch.medium].filter(Boolean).join(" / ") : "";
  const row = (k: string, v: string) =>
    `<tr><td style="padding:3px 14px 3px 0;color:#6B7280;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:3px 0;">${escapeHtml(v || "-")}</td></tr>`;
  const { error } = await resend.emails.send({
    from: "Verde Talent Alerts <alerts@updates.verdetalent.com>",
    to: OWNER_EMAIL,
    subject: `Resume Vault waitlist: ${email}`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#0A0A0A;">
<p style="margin:0 0 10px;font-size:16px;font-weight:700;">New Resume Vault waitlist signup</p>
<table cellpadding="0" cellspacing="0" style="font-size:13.5px;">
${row("Email", email)}
${row("Company domain", domain)}
${row("First found us via", source)}
${row("Signed up", new Date().toUTCString())}
</table>
<p style="margin:12px 0 0;color:#9CA3AF;font-size:12px;">Automatic alert - sent once per new address. The full list is in the vault_waitlist table.</p>
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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
      return jsonResponse({ error: "Enter a valid email first." }, 400);
    }
    const firstTouch = cleanFirstTouch(body.first_touch);

    const { error } = await supabaseAdmin.from("vault_waitlist").insert({ email, first_touch: firstTouch });
    if (error && error.code === "23505") return jsonResponse({ success: true, already: true }, 200);
    if (error) {
      console.error("vault_waitlist insert failed:", error);
      return jsonResponse({ error: "Something went wrong." }, 500);
    }

    // Best-effort: the signup is saved either way.
    try {
      await alertOwner(email, firstTouch);
    } catch (alertErr) {
      console.error("Owner alert failed:", alertErr);
    }
    return jsonResponse({ success: true, already: false }, 200);
  } catch (err) {
    console.error("subscribe-vault-waitlist crashed:", err);
    return jsonResponse({ error: "Something went wrong." }, 500);
  }
});
