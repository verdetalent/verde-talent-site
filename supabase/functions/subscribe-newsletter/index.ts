// Newsletter signup endpoint. news.html posts { email, location } here
// rather than inserting straight into newsletter_subscribers.
//
// `location` is what the subscriber typed into the optional "City, State,
// or ZIP" box. It's resolved here to a two-letter US state, stored in
// newsletter_subscribers.location, which newsletter-weekly uses to match
// its Featured jobs sidebar (see buildFeaturedJobsFor there); the raw text
// goes in location_input. Blank or unrecognized just leaves the state null
// and the newsletter falls back to its nationwide most-recent list. This
// replaced an IP-geolocation lookup (ip-api.com) on 2026-09-13 - nothing
// about the visitor leaves this function now.
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

// Same location reading as job-alerts-weekly's parsePersonLocation (state
// part only - edge functions here don't share code): a ZIP, "City, ST",
// "City, State", "City State", or a state on its own.
const US_STATE_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
};
const US_STATE_CODES = new Set(Object.values(US_STATE_ABBR));

function stateCode(token: string | null | undefined): string | null {
  const t = (token || "").trim();
  if (!t) return null;
  if (t.length === 2 && US_STATE_CODES.has(t.toUpperCase())) return t.toUpperCase();
  return US_STATE_ABBR[t.toLowerCase()] || null;
}

// Approximate USPS ZIP-prefix -> state blocks (first 3 digits).
const ZIP3_STATE_RANGES: [number, number, string][] = [
  [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"], [50, 59, "VT"],
  [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"],
  [200, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"],
  [290, 299, "SC"], [300, 319, "GA"], [320, 339, "FL"], [341, 342, "FL"], [344, 344, "FL"],
  [346, 347, "FL"], [349, 349, "FL"], [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"],
  [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"], [460, 479, "IN"], [480, 499, "MI"],
  [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [570, 577, "SD"], [580, 588, "ND"],
  [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"],
  [700, 714, "LA"], [716, 729, "AR"], [730, 749, "OK"], [750, 799, "TX"], [800, 816, "CO"],
  [820, 831, "WY"], [832, 839, "ID"], [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"],
  [885, 885, "TX"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"], [970, 979, "OR"],
  [980, 994, "WA"], [995, 999, "AK"],
];

function stateFromLocation(text: string): string | null {
  const t = text.trim();
  if (!t) return null;

  const zip = t.match(/^(\d{5})(-\d{4})?$/);
  if (zip) {
    const prefix = parseInt(zip[1].slice(0, 3), 10);
    return ZIP3_STATE_RANGES.find(([lo, hi]) => prefix >= lo && prefix <= hi)?.[2] || null;
  }

  const parts = t.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const state = stateCode(parts[1]);
    if (state) return state;
  } else {
    const whole = stateCode(t);
    if (whole) return whole;
    const words = t.split(/\s+/);
    for (const n of [2, 1]) {
      if (words.length <= n) continue;
      const state = stateCode(words.slice(-n).join(" "));
      if (state) return state;
    }
  }
  // Last resort: a state code or name anywhere in the text.
  const abbr = t.match(/\b([A-Z]{2})\b/g)?.find((m) => US_STATE_CODES.has(m));
  if (abbr) return abbr;
  const lower = t.toLowerCase();
  for (const [name, code] of Object.entries(US_STATE_ABBR)) {
    if (lower.includes(name)) return code;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const { email, location } = await req.json();
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return jsonResponse({ error: "Valid email required." }, 400);
    }

    const locationInput = typeof location === "string" ? location.trim().slice(0, 100) : "";

    const { error } = await supabaseAdmin
      .from("newsletter_subscribers")
      .insert({
        email,
        location: locationInput ? stateFromLocation(locationInput) : null,
        location_input: locationInput || null,
      });

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
