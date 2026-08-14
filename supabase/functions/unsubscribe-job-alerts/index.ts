// One-click unsubscribe link target from job-alerts-weekly's emails.
// Public by necessity (an email client following a link carries no
// Authorization header) - "Verify JWT" must be turned OFF for this
// function in the dashboard, same as stripe-webhook already is for the
// same reason (Stripe can't send a Supabase JWT either).
//
// token is a capability token (candidates.unsubscribe_token or
// job_alert_leads.unsubscribe_token, a random uuid), not tied to auth -
// anyone with the exact token from their own email can turn off their own
// alerts, which is the intended behavior of an unsubscribe link. It grants
// nothing else: this function only ever writes to the single matching row.
//
// Tries candidates first, then job_alert_leads - tokens are independently
// random uuids from two different tables, so a match in one means there's
// nothing to look up in the other.
//
// Env vars required (set via `supabase secrets set`):
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function htmlPage(message: string): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Verde Talent</title>
    <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0A0A0A;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:1.5rem;}
    .card{max-width:420px;} a{color:#22E09A;}</style></head>
    <body><div class="card"><p>${message}</p><p><a href="https://verdetalent.com">← Back to Verde Talent</a></p></div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } },
  );
}

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) {
    return htmlPage("Missing unsubscribe link — please use the link from your email.");
  }

  const { data, error } = await supabaseAdmin
    .from("candidates")
    .update({ email_job_alerts: false })
    .eq("unsubscribe_token", token)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error(error);
    return htmlPage("Something went wrong — please try again, or email contact@verdetalent.com.");
  }
  if (data) {
    return htmlPage("You're unsubscribed from weekly job-match emails. You can turn them back on anytime from your profile.");
  }

  const { data: leadData, error: leadError } = await supabaseAdmin
    .from("job_alert_leads")
    .update({ subscribed: false })
    .eq("unsubscribe_token", token)
    .select("id")
    .maybeSingle();

  if (leadError) {
    console.error(leadError);
    return htmlPage("Something went wrong — please try again, or email contact@verdetalent.com.");
  }
  if (!leadData) {
    return htmlPage("That unsubscribe link isn't valid — it may have already been used.");
  }

  return htmlPage("You're unsubscribed from job alerts. Come back anytime at verdetalent.com.");
});
