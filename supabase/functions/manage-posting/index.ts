// Lets an employer view/remove their job posting(s) two ways:
//  1. Via the secret manage_token emailed to them when payment succeeds -
//     no account needed, the token in the URL IS the authentication
//     (used by manage-posting.html).
//  2. Via a signed-in employer account (Authorization: Bearer <access_token>)
//     - used by employer-dashboard.html to list/remove postings tied to
//     their account, without needing to dig up an emailed link. Ownership
//     is employer_user_id = the signed-in user, OR company_email matching
//     their account email (covers postings made before they had an
//     account, or made anonymously with the same email).
// Either way, RLS still blocks all direct anon access to job_postings -
// only this function, via the service role key, can actually touch it.
//
// Env vars required (set via Supabase dashboard -> Edge Functions -> Secrets):
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Public by design (same key used site-wide in client-side code) - safe to
// hardcode here rather than requiring a redundant secret for it.
const ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SITE_ORIGIN = "https://verdetalent.com";
const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const POSTING_FIELDS = "id, company_name, job_title, status, duration_days, paid_at, expires_at, employer_user_id, company_email, manage_token";

async function getAuthedUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data, error } = await supabaseUser.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

function ownsPosting(posting: { employer_user_id: string | null; company_email: string }, user: { id: string; email?: string }) {
  return posting.employer_user_id === user.id || posting.company_email === user.email;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { id, token, action } = await req.json();

    if (action === "list") {
      const user = await getAuthedUser(req);
      if (!user) return jsonResponse({ error: "Sign in to view your postings." }, 401);

      const { data: postings, error } = await supabase
        .from("job_postings")
        .select(POSTING_FIELDS)
        .or(`employer_user_id.eq.${user.id},company_email.eq.${user.email}`)
        .order("created_at", { ascending: false });
      if (error) return jsonResponse({ error: "Could not load your postings." }, 500);

      return jsonResponse({ postings: postings.map(({ manage_token: _omit, employer_user_id: _omit2, ...p }) => p) });
    }

    if (!id) {
      return jsonResponse({ error: "Missing id." }, 400);
    }

    const { data: posting, error: fetchError } = await supabase
      .from("job_postings")
      .select(POSTING_FIELDS)
      .eq("id", id)
      .single();
    if (fetchError || !posting) {
      return jsonResponse({ error: "Posting not found." }, 404);
    }

    let authorized = false;
    if (token) {
      authorized = posting.manage_token === token;
    } else {
      const user = await getAuthedUser(req);
      authorized = !!user && ownsPosting(posting, user);
    }
    if (!authorized) {
      return jsonResponse({ error: "Invalid link." }, 403);
    }

    if (action === "delete") {
      if (posting.status !== "paid") {
        return jsonResponse({ error: "This posting is already removed or was never published." }, 409);
      }
      const { error: updateError } = await supabase
        .from("job_postings")
        .update({ status: "removed" })
        .eq("id", id);
      if (updateError) {
        return jsonResponse({ error: "Could not remove the posting. Please try again." }, 500);
      }
      return jsonResponse({ success: true });
    }

    // Default action: just return the posting's current status for display.
    const { manage_token: _omit, employer_user_id: _omit2, ...safePosting } = posting;
    return jsonResponse({ posting: safePosting });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Something went wrong." }, 500);
  }
});
