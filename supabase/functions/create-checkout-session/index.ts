// Creates a Stripe Checkout Session for a pending job posting.
//
// Price is decided HERE, server-side, from a fixed lookup table - never
// trusts a price sent from the browser, so nobody can tamper with the
// amount by editing a request before it reaches Stripe.
//
// Env vars required (set via `supabase secrets set`):
//   STRIPE_SECRET_KEY        - Stripe secret key (sk_live_... or sk_test_...)
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// The only two real offers - anything else in a request is rejected.
const PRICING: Record<number, { cents: number; label: string }> = {
  30: { cents: 10000, label: "30-day job posting" },
  60: { cents: 15000, label: "60-day job posting" },
};

const SITE_ORIGIN = "https://verdetalent.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { job_posting_id, duration_days } = await req.json();

    if (!job_posting_id || !PRICING[duration_days]) {
      return new Response(JSON.stringify({ error: "Invalid job_posting_id or duration_days" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { cents, label } = PRICING[duration_days];

    // Confirm the posting exists and hasn't already been paid for, and lock
    // in the real price/duration on the row itself before creating the
    // session (belt-and-suspenders alongside the webhook re-reading these
    // same columns later rather than trusting session metadata alone).
    const { data: posting, error: fetchError } = await supabase
      .from("job_postings")
      .select("id, status, company_name, job_title")
      .eq("id", job_posting_id)
      .single();

    if (fetchError || !posting) {
      return new Response(JSON.stringify({ error: "Job posting not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (posting.status !== "pending_payment") {
      return new Response(JSON.stringify({ error: "This posting has already been paid for" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: updateError } = await supabase
      .from("job_postings")
      .update({ duration_days, price_cents: cents })
      .eq("id", job_posting_id);
    if (updateError) throw updateError;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "us_bank_account"],
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: cents,
          product_data: {
            name: `Verde Talent: ${label}`,
            description: `${posting.job_title} at ${posting.company_name}`,
          },
        },
        quantity: 1,
      }],
      metadata: { job_posting_id },
      success_url: `${SITE_ORIGIN}/post-job-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_ORIGIN}/post-job.html?canceled=1`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Something went wrong creating checkout." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
