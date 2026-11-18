// "Feature this job": a Stripe Checkout for the Featured add-on on a posting that is already live
// (bought with a credit, a pack, or without Featured at first). $300 for 30 days at the top of the
// homepage's Featured jobs section; at most 6 featured at once (featured_slots_left()).
//
// The caller proves ownership the same two ways as manage-posting:
//   1. { id, token } - the manage_token from the "your posting is live" email (manage-posting.html)
//   2. a signed-in employer account (Authorization: Bearer <access_token>) that owns the posting
//      (employer_user_id, or company_email = the account email) - employer-dashboard.html
// The webhook (stripe-webhook, metadata.kind = "featured") switches it on once paid.
//
// Also answers { action: "slots" } with how many spots are free, for any page that asks.
//
// Env vars: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto).

import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";

// Keep in step with create-checkout-session.
const FEATURED_CENTS = 30000;
const FEATURED_DAYS = 30;

const SITE_ORIGIN = "https://verdetalent.com";
const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function authedUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || authHeader.includes(ANON_KEY)) return null;
  const client = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data, error } = await client.auth.getUser();
  return error || !data?.user ? null : data.user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const { data: left, error: slotsError } = await supabase.rpc("featured_slots_left");
    if (slotsError) throw slotsError;
    if (body.action === "slots") return json({ slots_left: left ?? 0, of: 6, price_cents: FEATURED_CENTS, days: FEATURED_DAYS });

    const id = String(body.id || "");
    if (!id) return json({ error: "Missing posting." }, 400);
    const { data: posting } = await supabase.from("job_postings")
      .select("id, status, expires_at, featured_until, job_title, company_name, company_email, employer_user_id, manage_token")
      .eq("id", id).maybeSingle();
    if (!posting) return json({ error: "Posting not found." }, 404);

    let owner = false;
    let returnTo = `${SITE_ORIGIN}/employer-dashboard.html`;
    if (body.token && posting.manage_token && body.token === posting.manage_token) {
      owner = true;
      returnTo = `${SITE_ORIGIN}/manage-posting.html?id=${posting.id}&token=${encodeURIComponent(posting.manage_token)}`;
    } else {
      const user = await authedUser(req);
      if (user && (posting.employer_user_id === user.id || (user.email && posting.company_email === user.email))) owner = true;
    }
    if (!owner) return json({ error: "You can only feature your own postings." }, 403);

    const now = Date.now();
    if (posting.status !== "paid" || !posting.expires_at || Date.parse(posting.expires_at) <= now) {
      return json({ error: "Only a live posting can be featured." }, 409);
    }
    if (posting.featured_until && Date.parse(posting.featured_until) > now) {
      return json({ error: "This posting is already featured." }, 409);
    }
    if ((left ?? 0) < 1) return json({ error: "All 6 Featured spots are taken right now. Try again in a few days." }, 409);

    const sep = returnTo.includes("?") ? "&" : "?";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "us_bank_account"],
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: FEATURED_CENTS,
          product_data: {
            name: `Verde Talent: Featured on the homepage, ${FEATURED_DAYS} days`,
            description: `${posting.job_title} at ${posting.company_name}`,
          },
        },
        quantity: 1,
      }],
      metadata: { job_posting_id: posting.id, kind: "featured" },
      success_url: `${returnTo}${sep}featured=1`,
      cancel_url: returnTo,
    });
    return json({ url: session.url });
  } catch (err) {
    console.error("feature-posting failed:", err);
    return json({ error: "Something went wrong - please try again." }, 500);
  }
});
