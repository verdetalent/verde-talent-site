// Stripe calls this directly (server-to-server) when a payment event
// happens - this is the ONLY place a job posting actually gets marked
// "paid". The browser redirecting to success_url is not proof of payment
// on its own (a URL can be visited without paying); the signature check
// below is what makes this trustworthy.
//
// Env vars required (set via `supabase secrets set`):
//   STRIPE_SECRET_KEY         - same key create-checkout-session uses
//   STRIPE_WEBHOOK_SECRET     - from the Stripe Dashboard webhook endpoint (whsec_...)
//   RESEND_API_KEY            - same key send-application uses
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function handleCreditPackPurchase(session: Stripe.Checkout.Session, purchaseId: string): Promise<Response> {
  const { data: purchase, error: fetchError } = await supabase
    .from("employer_credit_purchases")
    .select("pack_size, status, employer_user_id")
    .eq("id", purchaseId)
    .single();

  if (fetchError || !purchase) {
    console.error("Could not find credit purchase for webhook", purchaseId, fetchError);
    return new Response("Credit purchase not found", { status: 404 });
  }

  // Idempotency: Stripe can and does redeliver the same event more than once.
  if (purchase.status === "paid") {
    return new Response(JSON.stringify({ received: true, already_processed: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime());
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  const { error: updateError } = await supabase
    .from("employer_credit_purchases")
    .update({
      status: "paid",
      credits_remaining: purchase.pack_size,
      paid_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
    })
    .eq("id", purchaseId);

  if (updateError) {
    console.error("Failed to mark credit purchase paid", purchaseId, updateError);
    return new Response("Database update failed", { status: 500 });
  }

  const { data: userData } = await supabase.auth.admin.getUserById(purchase.employer_user_id);
  const email = userData?.user?.email;
  if (email) {
    await resend.emails.send({
      from: "Verde Talent <postings@updates.verdetalent.com>",
      to: email,
      subject: `Your ${purchase.pack_size}-posting credit pack is ready`,
      text: [
        `You now have ${purchase.pack_size} job-posting credits on your Verde Talent account, valid through ${expiresAt.toLocaleDateString()}.`,
        ``,
        `Use them any time from the posting form - just sign in first and you'll see the option to post with a credit instead of paying again.`,
        ``,
        `https://verdetalent.com/employer-account.html`,
      ].join("\n"),
    }).catch((err: unknown) => console.error("Failed to send credit-pack confirmation email", purchaseId, err));
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

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
    const purchaseId = session.metadata?.purchase_id;

    if (purchaseId) {
      return await handleCreditPackPurchase(session, purchaseId);
    }

    if (!jobPostingId) {
      console.error("checkout.session.completed with no job_posting_id or purchase_id in metadata", session.id);
      return new Response("Missing metadata", { status: 400 });
    }

    const { data: posting, error: fetchError } = await supabase
      .from("job_postings")
      .select("duration_days, status, company_name, company_email, job_title, manage_token")
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

    const manageUrl = `https://verdetalent.com/manage-posting.html?id=${jobPostingId}&token=${posting.manage_token}`;
    const { error: emailError } = await resend.emails.send({
      from: "Verde Talent <postings@updates.verdetalent.com>",
      to: posting.company_email,
      subject: `Your job posting is live: ${posting.job_title}`,
      text: [
        `Your posting "${posting.job_title}" at ${posting.company_name} is now live on Verde Talent for ${posting.duration_days} days.`,
        ``,
        `To remove it early at any time, use this link:`,
        manageUrl,
        ``,
        `Keep this email - this link is the only way to manage this posting.`,
      ].join("\n"),
    });
    if (emailError) {
      // Non-fatal: the posting is already live and paid; just log it so
      // the employer can be helped manually if they never got the link.
      console.error("Failed to send manage-link email", jobPostingId, emailError);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
