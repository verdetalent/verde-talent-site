// Lets a signed-in employer see their available job-posting credits and
// redeem one against a job posting instead of paying through Stripe.
// Always requires Authorization: Bearer <employer access_token> - credits
// have no anonymous or token-link access path the way job postings do.
//
// Env vars required (set via Supabase dashboard -> Edge Functions -> Secrets):
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase
//   RESEND_API_KEY            - same key send-application/stripe-webhook use

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

const SITE_ORIGIN = "https://verdetalent.com";
const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function getAuthedUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data, error } = await supabaseUser.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const user = await getAuthedUser(req);
    if (!user) return jsonResponse({ error: "Sign in to manage your credits." }, 401);

    const { action, job_posting_id } = await req.json();

    if (action === "list") {
      const { data: batches, error } = await supabase
        .from("employer_credit_purchases")
        .select("id, pack_size, credits_remaining, paid_at, expires_at, status")
        .eq("employer_user_id", user.id)
        .order("expires_at", { ascending: true });
      if (error) return jsonResponse({ error: "Could not load your credits." }, 500);

      const active = (batches || []).filter(b =>
        b.status === "paid" && b.credits_remaining > 0 && b.expires_at && new Date(b.expires_at) > new Date()
      );
      const totalAvailable = active.reduce((sum, b) => sum + b.credits_remaining, 0);

      return jsonResponse({ batches, totalAvailable });
    }

    if (action === "redeem") {
      if (!job_posting_id) return jsonResponse({ error: "Missing job_posting_id." }, 400);

      const { data: posting, error: postingError } = await supabase
        .from("job_postings")
        .select("id, company_name, company_email, job_title, employer_user_id, status, duration_days, manage_token")
        .eq("id", job_posting_id)
        .single();
      if (postingError || !posting) return jsonResponse({ error: "Job posting not found." }, 404);
      if (posting.employer_user_id !== user.id) return jsonResponse({ error: "Not your job posting." }, 403);
      if (posting.status !== "pending_payment") return jsonResponse({ error: "This posting was already processed." }, 409);
      if (posting.duration_days !== 30) return jsonResponse({ error: "Credits only cover the 30-day plan." }, 400);

      // FIFO: spend from whichever non-expired batch runs out soonest,
      // so credits from an older pack get used before a newer one's.
      const { data: batches, error: batchError } = await supabase
        .from("employer_credit_purchases")
        .select("id, credits_remaining, expires_at")
        .eq("employer_user_id", user.id)
        .eq("status", "paid")
        .gt("credits_remaining", 0)
        .gt("expires_at", new Date().toISOString())
        .order("expires_at", { ascending: true })
        .limit(1);
      if (batchError) return jsonResponse({ error: "Could not check your credits." }, 500);
      const batch = batches?.[0];
      if (!batch) return jsonResponse({ error: "No available credits." }, 409);

      const { error: decrementError } = await supabase
        .from("employer_credit_purchases")
        .update({ credits_remaining: batch.credits_remaining - 1 })
        .eq("id", batch.id);
      if (decrementError) return jsonResponse({ error: "Could not redeem a credit. Please try again." }, 500);

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const { error: updateError } = await supabase
        .from("job_postings")
        .update({
          status: "paid",
          paid_via_credit: true,
          paid_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .eq("id", job_posting_id);
      if (updateError) {
        // Best-effort rollback of the credit spend, since the posting
        // itself failed to activate.
        await supabase.from("employer_credit_purchases").update({ credits_remaining: batch.credits_remaining }).eq("id", batch.id);
        return jsonResponse({ error: "Could not activate the posting. Please try again." }, 500);
      }

      {
        const manageUrl = `${SITE_ORIGIN}/manage-posting.html?id=${job_posting_id}&token=${posting.manage_token}`;
        await resend.emails.send({
          from: "Verde Talent <postings@updates.verdetalent.com>",
          to: posting.company_email,
          subject: `Your job posting is live: ${posting.job_title}`,
          text: [
            `Your posting "${posting.job_title}" at ${posting.company_name} is now live on Verde Talent for 30 days, paid for with one of your posting credits.`,
            ``,
            `To remove it early at any time, use this link:`,
            manageUrl,
            ``,
            `Keep this email - this link is the only way to manage this posting.`,
          ].join("\n"),
        }).catch((err: unknown) => console.error("Failed to send credit-redeem confirmation email", err));
      }

      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: "Unknown action." }, 400);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Something went wrong." }, 500);
  }
});
