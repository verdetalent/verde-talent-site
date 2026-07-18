// Stripe calls this directly (server-to-server) when a payment event
// happens - this is the ONLY place a job posting actually gets marked
// "paid". The browser redirecting to success_url is not proof of payment
// on its own (a URL can be visited without paying); the signature check
// below is what makes this trustworthy.
//
// Env vars required (set via `supabase secrets set`):
//   STRIPE_SECRET_KEY         - same key create-checkout-session uses
//   STRIPE_WEBHOOK_SECRET     - from the Stripe Dashboard webhook endpoint (whsec_...)
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const jobPostingId = session.metadata?.job_posting_id;

    if (!jobPostingId) {
      console.error("checkout.session.completed with no job_posting_id in metadata", session.id);
      return new Response("Missing metadata", { status: 400 });
    }

    const { data: posting, error: fetchError } = await supabase
      .from("job_postings")
      .select("duration_days, status")
      .eq("id", jobPostingId)
      .single();

    if (fetchError || !posting) {
      console.error("Could not find job posting for webhook", jobPostingId, fetchError);
      return new Response("Job posting not found", { status: 404 });
    }

    // Idempotency: Stripe can and does redeliver the same event more than
    // once - only act on it the first time this posting is confirmed paid.
    if (posting.status === "paid") {
      return new Response(JSON.stringify({ received: true, already_processed: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + posting.duration_days * 24 * 60 * 60 * 1000);

    const { error: updateError } = await supabase
      .from("job_postings")
      .update({
        status: "paid",
        paid_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
      })
      .eq("id", jobPostingId);

    if (updateError) {
      console.error("Failed to mark job posting paid", jobPostingId, updateError);
      return new Response("Database update failed", { status: 500 });
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
