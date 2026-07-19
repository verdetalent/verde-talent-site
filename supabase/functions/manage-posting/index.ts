// Lets an employer view/remove their own job posting using the secret
// manage_token emailed to them when payment succeeds - no employer login
// system exists, so the token in the URL IS the authentication. Anyone
// with both the posting id and its token can act on it; anyone without
// the token cannot (RLS still blocks all direct anon access to this
// table - only this function, via the service role key, can touch it).
//
// Env vars required (set via Supabase dashboard -> Edge Functions -> Secrets):
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SITE_ORIGIN = "https://verdetalent.com";
const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { id, token, action } = await req.json();
    if (!id || !token) {
      return jsonResponse({ error: "Missing id or token." }, 400);
    }

    const { data: posting, error: fetchError } = await supabase
      .from("job_postings")
      .select("id, company_name, job_title, status, duration_days, paid_at, expires_at, manage_token")
      .eq("id", id)
      .single();

    if (fetchError || !posting) {
      return jsonResponse({ error: "Posting not found." }, 404);
    }
    if (posting.manage_token !== token) {
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
    const { manage_token: _omit, ...safePosting } = posting;
    return jsonResponse({ posting: safePosting });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Something went wrong." }, 500);
  }
});
