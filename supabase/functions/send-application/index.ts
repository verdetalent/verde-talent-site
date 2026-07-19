// Sends a candidate's resume directly to an employer for a paid job
// posting that has no apply_url (postings WITH an apply_url send
// candidates straight to the employer's own site instead - we're never
// involved in delivery there, so this function only ever applies to the
// no-apply_url case).
//
// The caller must be a signed-in candidate (their own access_token in the
// Authorization header, not the anon key) - identity is verified via
// supabaseUser.auth.getUser() before any data is touched. All actual
// reads/writes then go through the service-role client, since identity is
// already independently confirmed at that point.
//
// Env vars required (set via `supabase secrets set`):
//   RESEND_API_KEY            - Resend API key (re_...)
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Public by design (same key used site-wide in client-side code) - safe to
// hardcode here rather than requiring a redundant secret for it.
const ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";

const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SITE_ORIGIN = "https://verdetalent.com";
const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Converts a resume's raw bytes to base64 for the email attachment in
// fixed-size chunks - spreading a multi-megabyte Uint8Array directly into
// String.fromCharCode(...bytes) risks blowing the call stack.
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "You need to be signed in to apply." }, 401);
    }

    const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !userData?.user) {
      return jsonResponse({ error: "Your session has expired — please log in again." }, 401);
    }
    const candidateUserId = userData.user.id;
    const candidateEmail = userData.user.email;

    const { job_posting_id } = await req.json();
    if (!job_posting_id) {
      return jsonResponse({ error: "Missing job_posting_id." }, 400);
    }

    const { data: posting, error: postingError } = await supabaseAdmin
      .from("job_postings")
      .select("id, company_name, company_email, job_title, apply_url, status, expires_at")
      .eq("id", job_posting_id)
      .single();
    if (postingError || !posting) {
      return jsonResponse({ error: "Job posting not found." }, 404);
    }
    if (posting.status !== "paid" || new Date(posting.expires_at) < new Date()) {
      return jsonResponse({ error: "This posting is no longer active." }, 409);
    }
    if (posting.apply_url) {
      return jsonResponse({ error: "This posting has its own application link — use that instead." }, 400);
    }

    const { data: existing } = await supabaseAdmin
      .from("applications")
      .select("id")
      .eq("job_posting_id", job_posting_id)
      .eq("candidate_user_id", candidateUserId)
      .maybeSingle();
    if (existing) {
      return jsonResponse({ error: "You've already applied to this job.", already_applied: true }, 409);
    }

    const { data: candidate, error: candidateError } = await supabaseAdmin
      .from("candidates")
      .select("first_name, last_name, headline, resume_path, resume_filename")
      .eq("user_id", candidateUserId)
      .single();
    if (candidateError || !candidate) {
      return jsonResponse({ error: "We couldn't find your candidate profile. Create one before applying." }, 404);
    }
    if (!candidate.resume_path) {
      return jsonResponse({ error: "Upload a resume to your profile before applying — edit your profile to add one." }, 400);
    }

    const { data: resumeBlob, error: downloadError } = await supabaseAdmin.storage
      .from("resumes")
      .download(candidate.resume_path);
    if (downloadError || !resumeBlob) {
      return jsonResponse({ error: "Could not retrieve your resume file." }, 500);
    }
    const resumeBytes = new Uint8Array(await resumeBlob.arrayBuffer());
    const resumeFilename = candidate.resume_filename || candidate.resume_path.split("/").pop() || "resume.pdf";
    const candidateName = `${candidate.first_name} ${candidate.last_name}`.trim() || "A Verde Talent candidate";

    const { error: emailError } = await resend.emails.send({
      from: "Verde Talent Applications <applications@updates.verdetalent.com>",
      to: posting.company_email,
      replyTo: candidateEmail,
      subject: `New application: ${posting.job_title} — ${candidateName}`,
      text: [
        `${candidateName} applied to "${posting.job_title}" at ${posting.company_name} through Verde Talent.`,
        candidate.headline ? `Headline: ${candidate.headline}` : null,
        `Email: ${candidateEmail}`,
        ``,
        `Their resume is attached. Replying to this email will go directly to the candidate.`,
      ].filter(Boolean).join("\n"),
      attachments: [{ filename: resumeFilename, content: uint8ToBase64(resumeBytes) }],
    });

    if (emailError) {
      console.error("Resend send failed:", emailError);
      await supabaseAdmin.from("applications").insert({ job_posting_id, candidate_user_id: candidateUserId, status: "failed" });
      return jsonResponse({ error: "Could not send your application. Please try again." }, 500);
    }

    await supabaseAdmin.from("applications").insert({ job_posting_id, candidate_user_id: candidateUserId, status: "sent" });

    return jsonResponse({ success: true });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Something went wrong sending your application." }, 500);
  }
});
