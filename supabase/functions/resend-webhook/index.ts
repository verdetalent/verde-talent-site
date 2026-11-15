// Receives Resend's delivery/engagement webhooks (email.sent, .delivered,
// .delivery_delayed, .bounced, .complained, .opened, .clicked) and logs one
// row per event into newsletter_events. This is what turns "no visibility
// into deliverability" into an actual per-subscriber history - Resend's own
// dashboard only shows aggregate counts.
//
// Resend calls this directly (server-to-server), so it must be deployed
// with --no-verify-jwt (no anon-key auth like subscribe-newsletter gets) -
// trust instead comes from the Svix signature check below, same shape as
// stripe-webhook's Stripe-signature check.
//
// Env vars required (set via `supabase secrets set`):
//   RESEND_WEBHOOK_SECRET      - from the Resend Dashboard's webhook endpoint (whsec_...)
//   SUPABASE_URL               - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY  - auto-provided by Supabase

import { createClient } from "npm:@supabase/supabase-js@2";
import { Webhook } from "npm:svix@1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET")!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const webhook = new Webhook(WEBHOOK_SECRET);

interface ResendWebhookPayload {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    to?: string[];
    created_at?: string;
    [key: string]: unknown;
  };
}

Deno.serve(async (req) => {
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  const body = await req.text();

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing Svix headers", { status: 400 });
  }

  let payload: ResendWebhookPayload;
  try {
    payload = webhook.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ResendWebhookPayload;
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  // Hard bounces (Resend only sends email.bounced for permanent failures) and
  // spam complaints: stop emailing that address everywhere. Accounts and
  // profiles are never touched beyond the flag - see email_suppressions.
  if (payload.type === "email.bounced" || payload.type === "email.complained") {
    const addr = (payload.data.to?.[0] || "").trim().toLowerCase();
    if (addr) {
      const reason = payload.type === "email.bounced" ? "bounced" : "complained";
      const at = payload.data.created_at ?? payload.created_at ?? new Date().toISOString();
      const { error: supErr } = await supabaseAdmin.from("email_suppressions")
        .upsert({ email: addr, reason, event_at: at }, { onConflict: "email" });
      if (supErr) console.error("Could not record suppression:", supErr);
      const { error: candErr } = await supabaseAdmin.from("candidates")
        .update({ email_bounced_at: at }).eq("email", addr);
      if (candErr) console.error("Could not flag candidate:", candErr);
    }
  }

  const { error } = await supabaseAdmin.from("newsletter_events").insert({
    svix_id: svixId,
    event_type: payload.type,
    resend_email_id: payload.data.email_id,
    subscriber_email: payload.data.to?.[0] ?? null,
    occurred_at: payload.data.created_at ?? payload.created_at,
    raw: payload,
  });

  if (error) {
    // A redelivery of an event we've already logged hits the svix_id
    // unique constraint - that's expected and fine, not a real failure.
    if (error.code === "23505") {
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Failed to log newsletter event:", error);
    return new Response("Failed to log event", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
