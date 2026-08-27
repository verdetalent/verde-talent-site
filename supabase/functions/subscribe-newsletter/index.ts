// Newsletter signup endpoint. Replaces news.html's previous direct-to-
// PostgREST insert - routing through here lets the subscriber's IP be read
// server-side and geolocated to a US state, which newsletter-weekly then
// uses to match the Featured jobs sidebar to where the subscriber actually
// is (see buildFeaturedJobsFor there). The browser never sees or sends the
// IP itself - no client-side geolocation call, no third party learning who
// visited from where.
//
// Public by necessity (called by anonymous site visitors) - "Verify JWT"
// stays ON, same as the direct-to-PostgREST call it replaces: the
// anon key sent as apikey/Authorization from news.html satisfies that.
//
// Env vars required (set via `supabase secrets set`):
//   SUPABASE_URL              - auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - auto-provided by Supabase

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://verdetalent.com",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip");
}

// Best-effort only - a failed or slow lookup just leaves location null and
// newsletter-weekly falls back to its unfiltered most-recent list for that
// subscriber. Never blocks or fails the signup itself.
async function geolocateState(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,region`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "success" || data.countryCode !== "US") return null;
    return data.region || null; // two-letter state code - matches jobs_feed.json's extracted state code
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const { email } = await req.json();
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return jsonResponse({ error: "Valid email required." }, 400);
    }

    const location = await geolocateState(clientIp(req));

    const { error } = await supabaseAdmin
      .from("newsletter_subscribers")
      .insert({ email, location });

    if (error) {
      if (error.code === "23505") return jsonResponse({ error: "Already subscribed." }, 409);
      console.error(error);
      return jsonResponse({ error: "Something went wrong." }, 500);
    }

    return jsonResponse({ success: true }, 200);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: "Something went wrong." }, 500);
  }
});
