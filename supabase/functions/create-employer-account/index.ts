// Creates an employer login server-side so every new employer can be
// recognised: the account is tagged account_type = "employer" (nothing
// distinguished employers from candidates before), the employer gets a
// welcome email, and the site owner gets a "new employer" alert.
//
// Unlike candidates there is no second step (no profile row), so there is
// nothing to roll back - one call creates the login and returns a signed-in
// session.
//
// Public by necessity (anonymous visitors) - "Verify JWT" stays ON, satisfied
// by the anon key the page sends (same as subscribe-newsletter).
//
// Env vars required: RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Public by design - the same publishable key the site ships to every browser.
const ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";
const SITE_ORIGIN = "https://verdetalent.com";
const OWNER_EMAIL = "contact@verdetalent.com";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function fail(status: number, code: string, message: string): Response {
  return json({ success: false, code, message }, status);
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const GRN = "#22E09A";
const INK = "#0A0A0A";
const MUTED = "#6B7280";
const BORDER = "#E8E8E8";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function shell(bodyHtml: string, footerNote: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F5F6F5;font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F5;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid ${BORDER};">
<tr><td style="background:${INK};padding:20px 28px;">
  <span style="font-size:18px;font-weight:700;color:#FFFFFF;font-family:${FONT};">Verde <span style="color:${GRN};">Talent</span></span>
</td></tr>
<tr><td style="padding:28px;color:${INK};font-size:14.5px;line-height:1.6;">
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid ${BORDER};">
  <p style="margin:0;font-size:11px;color:#9CA3AF;line-height:1.6;">${footerNote}<br/>Verde Talent &middot; <a href="${SITE_ORIGIN}" style="color:#9CA3AF;">verdetalent.com</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;"><tr><td style="background:${GRN};border-radius:9px;">
<a href="${href}" style="display:inline-block;padding:11px 20px;font-size:13px;font-weight:600;color:#052e1e;text-decoration:none;">${label}</a>
</td></tr></table>`;
}

function welcomeHtml(): string {
  return shell(
    `<p style="margin:0 0 14px;font-size:17px;font-weight:700;">Welcome to Verde Talent.</p>
<p style="margin:0 0 14px;">Thanks for creating an employer account. Verde Talent is a job board built only for renewable energy, storage and grid roles, so your postings are seen by people looking for exactly this work.</p>
<p style="margin:0 0 6px;">Ready when you are:</p>
${button(`${SITE_ORIGIN}/post-job.html`, "Post your first job")}
<p style="margin:14px 0 14px;">You can post a single role or buy a pack of postings if you'll be hiring more than once. Everything you post can be managed and reposted from your account:
<a href="${SITE_ORIGIN}/employer-home.html" style="color:#0E9F6E;">verdetalent.com/employer-home</a></p>
<p style="margin:0 0 14px;">For harder-to-fill roles, our sister company, Lotus Scout, runs deeper, more involved searches.</p>
<p style="margin:0;color:${MUTED};">Questions? Just reply to this email - it comes straight to us.</p>`,
    "You're receiving this because you created an employer account on Verde Talent.",
  );
}

function ownerAlertHtml(email: string): string {
  const domain = email.split("@")[1] || "";
  const row = (k: string, v: string) =>
    `<tr><td style="padding:3px 14px 3px 0;color:${MUTED};white-space:nowrap;">${esc(k)}</td><td style="padding:3px 0;">${esc(v)}</td></tr>`;
  return shell(
    `<p style="margin:0 0 12px;font-size:16px;font-weight:700;">New employer account on Verde Talent</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13.5px;">
${row("Email", email)}
${row("Company domain", domain)}
${row("Signed up", new Date().toUTCString())}
</table>
<p style="margin:14px 0 0;color:${MUTED};font-size:13px;">Employer sign-up only collects an email and password, so there is no company name yet.</p>`,
    "Automatic alert - sent for each new employer account.",
  );
}

async function sendEmails(email: string) {
  const results = await Promise.allSettled([
    resend.emails.send({
      from: "Verde Talent <welcome@updates.verdetalent.com>",
      to: email,
      replyTo: OWNER_EMAIL,
      subject: "Welcome to Verde Talent",
      html: welcomeHtml(),
    }),
    resend.emails.send({
      from: "Verde Talent Alerts <alerts@updates.verdetalent.com>",
      to: OWNER_EMAIL,
      subject: `New employer: ${email}`,
      html: ownerAlertHtml(email),
    }),
  ]);
  results.forEach((r, i) => {
    const which = i === 0 ? "welcome" : "owner alert";
    if (r.status === "rejected") console.error(`Employer ${which} email failed:`, r.reason);
    else if (r.value.error) console.error(`Employer ${which} email rejected:`, r.value.error);
  });
}

function looksAlreadyRegistered(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "email_exists" || err.code === "user_already_exists" ||
    /already (been )?registered|already exists/i.test(err.message || "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return fail(405, "method", "Method not allowed.");

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 5000) return fail(413, "too_large", "That submission is too large.");
    body = JSON.parse(text);
  } catch {
    return fail(400, "invalid", "We couldn't read that - please try again.");
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return fail(400, "invalid_email", "Enter a valid email address.");
  }
  if (password.length < 6 || password.length > 72) {
    return fail(400, "short_password", "Password must be between 6 and 72 characters.");
  }

  try {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { account_type: "employer" },
    });

    if (!created?.user) {
      if (looksAlreadyRegistered(createError)) {
        return fail(409, "email_taken", "That email already has an account. Try signing in instead.");
      }
      console.error("createUser failed:", createError);
      return fail(500, "server", "Something went wrong on our side - please try again.");
    }

    let session: Record<string, unknown> | null = null;
    const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const { data: signed } = await anon.auth.signInWithPassword({ email, password });
    if (signed?.session) {
      session = {
        access_token: signed.session.access_token,
        refresh_token: signed.session.refresh_token,
        expires_in: signed.session.expires_in,
        user_id: created.user.id,
        email,
      };
    }

    await sendEmails(email);

    return json({ success: true, session });
  } catch (err) {
    console.error("create-employer-account crashed:", err);
    return fail(500, "server", "Something went wrong on our side - please try again.");
  }
});
