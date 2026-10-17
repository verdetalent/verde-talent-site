// "Forgot your password?" for candidates (and any other Verde Talent login).
// Builds a one-time recovery link server-side and emails it through Resend,
// rather than relying on Supabase's built-in mailer, so it uses the same
// verified sending domain as every other email the site sends.
//
// The link lands on reset-password.html, which already handles the
// recovery-token hash and lets the person choose a new password.
//
// Always answers "sent" whether or not the email has an account, so the form
// can't be used to find out who is registered.
//
// Public by necessity - "Verify JWT" stays ON, satisfied by the anon key the
// page sends (same as subscribe-newsletter).
//
// Env vars required: RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_ORIGIN = "https://verdetalent.com";
const RESET_PAGE = `${SITE_ORIGIN}/reset-password.html`;

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

// Best-effort brake on one address being mailed repeatedly (per server
// instance - not a guarantee, but stops casual hammering of the button).
const lastSent = new Map<string, number>();
const MIN_GAP_MS = 60_000;

function resetEmailHtml(link: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#F5F6F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F5;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid #E8E8E8;">
<tr><td style="background:#0A0A0A;padding:20px 28px;"><span style="font-size:18px;font-weight:700;color:#FFFFFF;">Verde <span style="color:#22E09A;">Talent</span></span></td></tr>
<tr><td style="padding:28px;color:#0A0A0A;font-size:14.5px;line-height:1.6;">
<p style="margin:0 0 14px;font-size:17px;font-weight:700;">Reset your password</p>
<p style="margin:0 0 16px;">Someone asked to reset the password on your Verde Talent account. Use the button below to choose a new one. The link works once and expires in an hour.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;"><tr><td style="background:#22E09A;border-radius:9px;">
<a href="${link}" style="display:inline-block;padding:11px 20px;font-size:13px;font-weight:600;color:#052e1e;text-decoration:none;">Choose a new password</a>
</td></tr></table>
<p style="margin:0;color:#6B7280;font-size:13px;">If you didn't ask for this, you can ignore this email - your password won't change.</p>
</td></tr>
<tr><td style="padding:14px 28px 22px;border-top:1px solid #E8E8E8;"><p style="margin:0;font-size:11px;color:#9CA3AF;">Verde Talent &middot; <a href="${SITE_ORIGIN}" style="color:#9CA3AF;">verdetalent.com</a></p></td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ success: false }, 405);

  let email = "";
  try {
    const body = await req.json();
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  } catch {
    return json({ success: false, message: "Enter your email address." }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return json({ success: false, message: "Enter a valid email address." }, 400);
  }

  const now = Date.now();
  if (now - (lastSent.get(email) ?? 0) < MIN_GAP_MS) {
    return json({ success: true });
  }
  lastSent.set(email, now);

  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: RESET_PAGE },
    });
    // The link only OPENS reset-password.html; the single-use code is redeemed
    // there when the person submits a new password. That keeps an email
    // security scanner or link previewer (common on corporate inboxes) from
    // using the code up just by loading the URL. Falls back to Supabase's own
    // hosted link if the hashed token is ever missing.
    const hashedToken = data?.properties?.hashed_token;
    const link = hashedToken
      ? `${RESET_PAGE}?token_hash=${encodeURIComponent(hashedToken)}&type=recovery`
      : data?.properties?.action_link;
    if (error || !link) {
      // Unknown address (or a lookup failure) - say nothing different.
      if (error) console.error("generateLink:", error.message);
      return json({ success: true });
    }
    const { error: sendError } = await resend.emails.send({
      from: "Verde Talent <accounts@updates.verdetalent.com>",
      to: email,
      replyTo: "contact@verdetalent.com",
      subject: "Reset your Verde Talent password",
      html: resetEmailHtml(link),
    });
    if (sendError) console.error("Reset email rejected:", sendError);
  } catch (err) {
    console.error("request-password-reset crashed:", err);
  }
  return json({ success: true });
});
