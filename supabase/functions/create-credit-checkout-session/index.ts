// Creates a Stripe Checkout session for a bulk job-posting credit pack.
// Unlike create-checkout-session (single job postings, no login needed),
// this always requires a signed-in employer - credits are meaningless
// without an account to attach them to.
//
// Env vars required (set via Supabase dashboard -> Edge Functions -> Secrets):
//   STRIPE_SECRET_KEY         - same key create-checkout-session uses
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";
const supabaseAdmin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const SITE_ORIGIN = "https://verdetalent.com";
const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Server-side price lookup, same reasoning as create-checkout-session:
// never trust a client-supplied price for what Stripe actually charges.
const PRICING: Record<number, { cents: number; label: string }> = {
  5: { cents: 45000, label: "5 job-posting credit pack" },
  10: { cents: 85000, label: "10 job-posting credit pack" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "You need to be signed in to buy a credit pack." }, 401);

    const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "Your session has expired — please sign in again." }, 401);
    const employerUserId = userData.user.id;

    const { purchase_id } = await req.json();
    if (!purchase_id) return jsonResponse({ error: "Missing purchase_id." }, 400);

    const { data: purchase, error: fetchError } = await supabaseAdmin
      .from("employer_credit_purchases")
      .select("id, employer_user_id, pack_size, status")
      .eq("id", purchase_id)
      .single();
    if (fetchError || !purchase) return jsonResponse({ error: "Purchase not found." }, 404);
    if (purchase.employer_user_id !== employerUserId) return jsonResponse({ error: "Not your purchase." }, 403);
    if (purchase.status !== "pending_payment") return jsonResponse({ error: "This purchase was already processed." }, 409);

    const price = PRICING[purchase.pack_size];
    if (!price) return jsonResponse({ error: "Invalid pack size." }, 400);

    await supabaseAdmin
      .from("employer_credit_purchases")
      .update({ price_cents: price.cents })
      .eq("id", purchase_id);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "us_bank_account"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: price.label },
          unit_amount: price.cents,
        },
        quantity: 1,
      }],
      success_url: `${SITE_ORIGIN}/employer-account.html?credits_success=1`,
      cancel_url: `${SITE_ORIGIN}/employer-account.html?canceled=1`,
      metadata: { purchase_id },
    });

    return jsonResponse({ url: session.url });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Could not start checkout." }, 500);
  }
});
