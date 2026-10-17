// Creates a candidate's login AND their profile in one server-side step, so
// nobody can end up with an account but no profile. The browser used to do
// this as two separate calls (sign up, then save the profile) - if the second
// failed, the person was left half-created: able to log in to nothing, and
// stuck if they retried with a different password. Here, if the profile can't
// be saved the account is removed again, so any failed attempt is safe to
// retry from scratch.
//
// On success it also sends the candidate a welcome email and notifies the
// site owner - those only fire for fully created candidates.
//
// Public by necessity (called by anonymous visitors) - "Verify JWT" stays ON,
// same as subscribe-newsletter: the anon key the page sends satisfies it.
//
// Env vars required (set via `supabase secrets set`):
//   RESEND_API_KEY            - same key the other Edge Functions use
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

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

// ---- input cleaning ---------------------------------------------------------

const NUL = String.fromCharCode(0);

// Postgres rejects text containing a NUL character outright, which would turn
// a pasted resume into a failed signup - strip it rather than fail.
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.split(NUL).join("").trim();
  return t ? t.slice(0, max) : null;
}

function cleanStringArray(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => cleanText(v, maxLen))
    .filter((v): v is string => !!v)
    .slice(0, maxItems);
}

// experience / education are arrays of small objects; anything else is dropped.
function cleanEntryArray(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  const text = JSON.stringify(value.slice(0, maxItems));
  if (text.length > 60000) return [];
  return JSON.parse(text.split("\\u0000").join(""));
}

function cleanInt(value: unknown, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n);
}

function cleanBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function buildProfile(raw: Record<string, unknown>) {
  return {
    first_name: cleanText(raw.first_name, 100),
    last_name: cleanText(raw.last_name, 100),
    headline: cleanText(raw.headline, 200),
    location: cleanText(raw.location, 200),
    years_experience: cleanText(raw.years_experience, 60),
    bio: cleanText(raw.bio, 2000),
    sectors: cleanStringArray(raw.sectors, 20, 60),
    skills: cleanStringArray(raw.skills, 60, 80),
    experience: cleanEntryArray(raw.experience, 30),
    education: cleanEntryArray(raw.education, 15),
    work_style: cleanStringArray(raw.work_style, 10, 40),
    job_type: cleanText(raw.job_type, 60),
    relocation: cleanText(raw.relocation, 60),
    salary_min: cleanInt(raw.salary_min, 10_000_000),
    salary_max: cleanInt(raw.salary_max, 10_000_000),
    availability: cleanText(raw.availability, 60),
    linkedin_url: cleanText(raw.linkedin_url, 300),
    website_url: cleanText(raw.website_url, 300),
    github_url: cleanText(raw.github_url, 300),
    resume_filename: cleanText(raw.resume_filename, 255),
    resume_path: null,
    visibility_recruiters: cleanBool(raw.visibility_recruiters, true),
    visibility_salary: cleanBool(raw.visibility_salary, true),
    visibility_employer: cleanBool(raw.visibility_employer, false),
    visibility_searchable: cleanBool(raw.visibility_searchable, true),
    email_job_alerts: cleanBool(raw.email_job_alerts, false),
  };
}

// ---- email ----------------------------------------------------------------

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

function welcomeHtml(firstName: string, searchable: boolean, jobAlerts: boolean): string {
  const visibility = searchable
    ? "Your profile is now in our resume database, so employers hiring across solar, wind, storage and the grid can find you."
    : "Your profile is saved and set to private for now - you can change who can see it any time from your profile.";
  const alerts = jobAlerts
    ? `<p style="margin:0 0 14px;">You also asked for job alerts, so we'll email you when new roles match.</p>`
    : "";
  return shell(
    `<p style="margin:0 0 14px;font-size:17px;font-weight:700;">Welcome to Verde Talent, ${esc(firstName)}.</p>
<p style="margin:0 0 14px;">Thanks for creating your profile. ${esc(visibility)}</p>
${alerts}
<p style="margin:0 0 6px;">A good place to start:</p>
${button(`${SITE_ORIGIN}/jobs.html`, "Browse open clean energy jobs")}
<p style="margin:14px 0 14px;">You can sign in any time to update your profile, resume or preferences:
<a href="${SITE_ORIGIN}/login.html" style="color:#0E9F6E;">verdetalent.com/login</a></p>
<p style="margin:0;color:${MUTED};">Questions? Just reply to this email - it comes straight to us.</p>`,
    "You're receiving this because you created a profile on Verde Talent.",
  );
}

function ownerAlertHtml(p: ReturnType<typeof buildProfile>, email: string, referral: string | null, hasResume: boolean): string {
  const row = (k: string, v: unknown) =>
    `<tr><td style="padding:3px 14px 3px 0;color:${MUTED};white-space:nowrap;vertical-align:top;">${esc(k)}</td><td style="padding:3px 0;">${esc(v || "-")}</td></tr>`;
  return shell(
    `<p style="margin:0 0 12px;font-size:16px;font-weight:700;">New candidate on Verde Talent</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13.5px;">
${row("Name", `${p.first_name} ${p.last_name}`)}
${row("Email", email)}
${row("Headline", p.headline)}
${row("Location", p.location)}
${row("Experience", p.years_experience)}
${row("Sectors", (p.sectors || []).join(", "))}
${row("Resume attached", hasResume ? "yes (uploading)" : "no")}
${row("Searchable by employers", p.visibility_searchable ? "yes" : "no")}
${row("Referred by code", referral)}
</table>`,
    "Automatic alert - sent for each new candidate profile.",
  );
}

async function sendEmails(p: ReturnType<typeof buildProfile>, email: string, referral: string | null) {
  const results = await Promise.allSettled([
    resend.emails.send({
      from: "Verde Talent <welcome@updates.verdetalent.com>",
      to: email,
      replyTo: OWNER_EMAIL,
      subject: `Welcome to Verde Talent, ${p.first_name}`,
      html: welcomeHtml(p.first_name!, p.visibility_searchable, p.email_job_alerts),
    }),
    resend.emails.send({
      from: "Verde Talent Alerts <alerts@updates.verdetalent.com>",
      to: OWNER_EMAIL,
      subject: `New candidate: ${p.first_name} ${p.last_name}`,
      html: ownerAlertHtml(p, email, referral, !!p.resume_filename),
    }),
  ]);
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`Email ${i === 0 ? "welcome" : "owner alert"} failed:`, r.reason);
    else if (r.value.error) console.error(`Email ${i === 0 ? "welcome" : "owner alert"} rejected:`, r.value.error);
  });
}

// ---- main -------------------------------------------------------------------

function looksAlreadyRegistered(err: { code?: string; message?: string; status?: number } | null): boolean {
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
    if (text.length > 250_000) return fail(413, "too_large", "That submission is too large.");
    body = JSON.parse(text);
  } catch {
    return fail(400, "invalid", "We couldn't read that submission - please try again.");
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const profile = buildProfile((body.profile && typeof body.profile === "object" ? body.profile : {}) as Record<string, unknown>);
  const referralRaw = typeof body.referral_code === "string" ? body.referral_code.trim() : "";
  const referralCode = /^[A-Za-z0-9]{4,16}$/.test(referralRaw) ? referralRaw : null;

  if (!profile.first_name || !profile.last_name) return fail(400, "missing_name", "Add your first and last name first.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return fail(400, "invalid_email", "Enter a valid email to create your account.");
  if (password.length < 6 || password.length > 72) return fail(400, "short_password", "Choose a password between 6 and 72 characters.");

  try {
    // 1. The login. If the email already has one, only carry on when the
    // password proves it's theirs AND they never got a profile (a leftover
    // from the old two-step flow) - otherwise stop with a clear message.
    let userId: string;
    let createdHere = false;

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { account_type: "candidate" },
    });

    if (created?.user) {
      userId = created.user.id;
      createdHere = true;
    } else if (looksAlreadyRegistered(createError)) {
      const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const { data: signedIn, error: signInError } = await anon.auth.signInWithPassword({ email, password });
      if (signInError || !signedIn?.user) {
        return fail(409, "email_taken", "That email already has a Verde Talent account.");
      }
      const { data: existing } = await admin.from("candidates").select("id").eq("user_id", signedIn.user.id).limit(1);
      if (existing && existing.length) {
        return fail(409, "profile_exists", "You already have a profile with that email - sign in to update it.");
      }
      userId = signedIn.user.id;
    } else {
      console.error("createUser failed:", createError);
      return fail(500, "server", "Something went wrong on our side. Nothing was saved - please try again.");
    }

    // 2. The profile. If this fails, take the login back out so the person
    // is never left half-created.
    const { data: candidate, error: insertError } = await admin
      .from("candidates")
      .insert({ ...profile, user_id: userId, email })
      .select("id, referral_code")
      .single();

    if (insertError || !candidate) {
      console.error("Profile insert failed:", insertError);
      if (createdHere) {
        const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
        if (deleteError) {
          console.error("ROLLBACK FAILED - orphan account left behind:", userId, email, deleteError);
          await resend.emails.send({
            from: "Verde Talent Alerts <alerts@updates.verdetalent.com>",
            to: OWNER_EMAIL,
            subject: "ACTION NEEDED: orphan account after failed signup",
            html: `<p>A candidate signup failed to save the profile AND the cleanup failed.</p><p>Email: ${esc(email)}<br/>User id: ${esc(userId)}</p><p>Delete this auth user (or let them retry with the same password).</p>`,
          }).catch(() => {});
        }
      }
      return fail(500, "save_failed", "We couldn't save your profile. Nothing was created - please try again.");
    }

    // 3. Everything below is best-effort: the candidate exists either way.
    if (referralCode) {
      const { error: refError } = await admin.from("referrals").insert({ referrer_code: referralCode, referred_candidate_id: candidate.id });
      if (refError) console.error("Could not record referral:", refError);
    }

    let session: Record<string, unknown> | null = null;
    const anonForSession = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const { data: signed } = await anonForSession.auth.signInWithPassword({ email, password });
    if (signed?.session) {
      session = {
        access_token: signed.session.access_token,
        refresh_token: signed.session.refresh_token,
        expires_in: signed.session.expires_in,
        user_id: userId,
      };
    }

    await sendEmails(profile, email, referralCode);

    return json({ success: true, candidate_id: candidate.id, referral_code: candidate.referral_code, session });
  } catch (err) {
    console.error("create-candidate-account crashed:", err);
    return fail(500, "server", "Something went wrong on our side. Nothing was saved - please try again.");
  }
});
