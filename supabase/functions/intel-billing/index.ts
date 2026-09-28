// Intelligence billing for a signed-in employer.
//
//   { action: "checkout", interval: "month" | "year" }  -> { url } of a Stripe Checkout page
//   { action: "portal" }                                -> { url } of the Stripe customer portal
//
// Checkout only starts the purchase. Access is granted by stripe-webhook when Stripe
// confirms the subscription, never by the browser coming back to the success URL.
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

// Server-side prices: the browser only says which interval, never what it costs.
const PLANS: Record<string, { cents: number; label: string }> = {
  month: { cents: 19900, label: "Verde Talent Intelligence Pro - monthly" },
  year: { cents: 199000, label: "Verde Talent Intelligence Pro - yearly" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "You need to be signed in." }, 401);

    const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "Your session has expired - please sign in again." }, 401);
    const user = userData.user;

    const { action, interval } = await req.json();

    const { data: existing } = await supabaseAdmin
      .from("intel_subscriptions")
      .select("plan, status, current_period_end, stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();
    const current = existing && ["active", "past_due"].includes(existing.status)
      && new Date(existing.current_period_end) > new Date();

    if (action === "portal") {
      if (!existing?.stripe_customer_id) {
        return jsonResponse({ error: "There is no card subscription on this account to manage." }, 404);
      }
      const portal = await stripe.billingPortal.sessions.create({
        customer: existing.stripe_customer_id,
        return_url: `${SITE_ORIGIN}/employer-account.html`,
      });
      return jsonResponse({ url: portal.url });
    }

    if (action !== "checkout") return jsonResponse({ error: "Unknown action." }, 400);
    const plan = PLANS[interval];
    if (!plan) return jsonResponse({ error: "Choose monthly or yearly." }, 400);
    if (current) return jsonResponse({ error: "This account already has Intelligence." }, 409);

    // Carried on both the Checkout session and the subscription, so every later
    // subscription event can be traced back to the account without a lookup table.
    const metadata = { intel_user_id: user.id, interval };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: plan.label },
          unit_amount: plan.cents,
          recurring: { interval: interval as "month" | "year" },
        },
        quantity: 1,
      }],
      // Reuse the Stripe customer from an earlier subscription, so their invoices and card
      // stay in one place; otherwise Stripe creates one with the account's email.
      ...(existing?.stripe_customer_id
        ? { customer: existing.stripe_customer_id }
        : { customer_email: user.email }),
      client_reference_id: user.id,
      metadata,
      subscription_data: { metadata },
      // Lets a founding-customer or 100%-off test code be entered on the Stripe page. A card
      // is still always collected, so a first-month-free code cannot become a free account
      // that simply fails to renew.
      allow_promotion_codes: true,
      success_url: `${SITE_ORIGIN}/employer-intel-home.html?welcome=1`,
      cancel_url: `${SITE_ORIGIN}/employer-intel-home.html?canceled=1`,
    });

    return jsonResponse({ url: session.url });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Could not start checkout." }, 500);
  }
});
