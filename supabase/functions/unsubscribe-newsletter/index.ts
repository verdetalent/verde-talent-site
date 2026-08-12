// One-click unsubscribe link target from newsletter-weekly's emails.
// Public by necessity (an email client following a link carries no
// Authorization header) - "Verify JWT" must be turned OFF for this
// function in the dashboard, same as unsubscribe-job-alerts and
// stripe-webhook.
//
// token is a capability token (newsletter_subscribers.unsubscribe_token),
// not tied to auth - same design as unsubscribe-job-alerts, kept as a
// separate function/table since newsletter subscribers are a completely
// different, open-signup list from candidates.
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
    .from("newsletter_subscribers")
    .update({ subscribed: false })
    .eq("unsubscribe_token", token)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error(error);
    return htmlPage("Something went wrong — please try again, or email contact@verdetalent.com.");
  }
  if (!data) {
    return htmlPage("That unsubscribe link isn't valid — it may have already been used.");
  }

  return htmlPage("You're unsubscribed from the Verde Talent newsletter.");
});
