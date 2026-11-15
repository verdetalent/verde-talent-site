// Target of the optional "Confirm my email" button in the welcome emails.
// Public by necessity (an email client following a link sends no
// Authorization header) - deploy with --no-verify-jwt.
//
// The token is HMAC-SHA256(EMAIL_CONFIRM_SECRET, lower(email)), checked in
// constant time, so the link can only confirm the address it was sent to and
// grants nothing else. Confirming never changes what an account can do: it is
// recorded (email_confirmations, candidates.email_confirmed_at) and shown only
// to the site owner in the admin Resume Vault. Always ends on a page on
// verdetalent.com - Supabase serves function-generated HTML as plain text.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), EMAIL_CONFIRM_SECRET.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL_CONFIRM_SECRET = Deno.env.get("EMAIL_CONFIRM_SECRET") || "";
const SITE = "https://verdetalent.com/email-confirmed.html";
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function redirect(status: "ok" | "invalid"): Response {
  return new Response(null, { status: 302, headers: { Location: `${SITE}?status=${status}` } });
}

async function expectedToken(email: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(EMAIL_CONFIRM_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const email = (url.searchParams.get("e") || "").trim().toLowerCase();
    const token = url.searchParams.get("t") || "";
    if (!EMAIL_CONFIRM_SECRET || !email || !token || email.length > 254) return redirect("invalid");
    if (!sameString(token, await expectedToken(email))) return redirect("invalid");

    const now = new Date().toISOString();
    await db.from("email_confirmations").upsert({ email, confirmed_at: now }, { onConflict: "email", ignoreDuplicates: true });
    await db.from("candidates").update({ email_confirmed_at: now }).eq("email", email).is("email_confirmed_at", null);
    return redirect("ok");
  } catch (err) {
    console.error("confirm-email failed:", err);
    return redirect("invalid");
  }
});
