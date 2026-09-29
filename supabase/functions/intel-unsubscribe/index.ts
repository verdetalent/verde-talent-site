// One-click unsubscribe from the monthly Intelligence email.
//
//   GET  ?token=...   the "Stop these monthly emails" link in the email: switches it off and
//                     shows a short confirmation page.
//   POST ?token=...   the one-click request mail clients send from their own Unsubscribe
//                     button (RFC 8058, via the List-Unsubscribe-Post header).
//
// The token is the subscriber's intel_subscriptions.email_token, so no sign-in is needed and
// it can only ever switch that one account's email off. Deployed with "Verify JWT" OFF:
// people click it straight from their inbox.
//
// Env vars required: the auto-provided SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(title: string, body: string, status = 200) {
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head><body style="margin:0;background:#EEF1EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<div style="max-width:520px;margin:60px auto;background:#fff;border:1px solid #DADFDC;border-radius:14px;padding:32px 30px;">
<img src="https://verdetalent.com/logo.png" alt="Verde Talent" width="64" height="64" style="display:block;margin-bottom:12px;">
<h1 style="font-size:20px;margin:0 0 10px;color:#111;">${title}</h1><p style="font-size:14.5px;line-height:1.6;color:#333;margin:0;">${body}</p>
</div></body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!UUID.test(token)) {
    return req.method === "POST" ? new Response("bad token", { status: 400 })
      : page("That link didn't work", "Switch the monthly email off from <a href=\"https://verdetalent.com/employer-account.html\">Account &amp; credits</a> instead.", 400);
  }
  const { error } = await db.from("intel_subscriptions").update({ monthly_email: false, updated_at: new Date().toISOString() })
    .eq("email_token", token);
  if (error) {
    console.error("unsubscribe failed", error);
    return req.method === "POST" ? new Response("error", { status: 500 })
      : page("Something went wrong", "Please try the link again, or email contact@verdetalent.com and we'll switch it off.", 500);
  }
  if (req.method === "POST") return new Response("ok");
  return page("You're unsubscribed", "You won't get the monthly market report by email any more. Your Intelligence access and your report page are unchanged, and you can switch the email back on any time from <a href=\"https://verdetalent.com/employer-account.html\" style=\"color:#1D6FB8;\">Account &amp; credits</a>.");
});
