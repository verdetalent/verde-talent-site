// vault-resume - an employer with Resume Vault access downloads a candidate's resume.
//
// POST { candidate_id } with the employer's own sign-in token (Authorization header).
// Returns { url, filename }: a link to the file that works for 60 seconds.
//
// The rules live in the database (supabase/migrations/017_vault_resume_downloads.sql):
// vault_resume() runs as the signed-in employer and only returns the file's location when they
// have live employer_vault_access AND the candidate would appear in their Vault list - profile
// searchable, open to recruiters (for agencies), and not hidden from their company ("hide from
// current employer"). This function never decides who may see what; it only signs the link the
// database allowed. A hidden candidate and a missing one get the same answer, so the response
// never reveals that someone is hiding from you.
//
// Every download is logged in vault_resume_downloads (internal; not readable from the site), and
// an account is capped at DAILY_LIMIT downloads a day.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Public by design (the same key the site uses in the browser).
const ANON_KEY = "sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH";
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SITE_ORIGIN = "https://verdetalent.com";
const LINK_SECONDS = 60;
const DAILY_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Please sign in to your employer account." }, 401);
    const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !userData?.user) return json({ error: "Your session has expired - please sign in again." }, 401);
    const userId = userData.user.id;

    let candidateId = "";
    try { candidateId = String((await req.json())?.candidate_id || ""); } catch (_e) { /* bad body */ }
    if (!UUID_RE.test(candidateId)) return json({ error: "Missing candidate." }, 400);

    // The database decides, as this employer (their token, not the service role).
    const { data: rows, error: ruleError } = await supabaseUser.rpc("vault_resume", { p_candidate: candidateId });
    if (ruleError) {
      console.error("vault_resume failed", ruleError.message);
      return json({ error: "Couldn't load that resume. Please try again." }, 500);
    }
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.resume_path) return json({ error: "This resume isn't available." }, 404);

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await supabaseAdmin.from("vault_resume_downloads")
      .select("id", { count: "exact", head: true }).eq("user_id", userId).gte("downloaded_at", since);
    if ((count || 0) >= DAILY_LIMIT) {
      return json({ error: "You've reached today's resume download limit. Please try again tomorrow." }, 429);
    }

    const filename = String(row.resume_filename || "resume.pdf").replace(/[\r\n"\\/]/g, "").slice(0, 120) || "resume.pdf";
    const { data: signed, error: signError } = await supabaseAdmin.storage.from("resumes")
      .createSignedUrl(row.resume_path, LINK_SECONDS, { download: filename });
    if (signError || !signed?.signedUrl) {
      console.error("sign failed", signError?.message);
      return json({ error: "Couldn't load that resume. Please try again." }, 500);
    }

    const { error: logError } = await supabaseAdmin.from("vault_resume_downloads")
      .insert({ user_id: userId, candidate_id: candidateId, company_name: row.viewer_company || null });
    if (logError) console.error("download log failed", logError.message);

    return json({ url: signed.signedUrl, filename });
  } catch (e) {
    console.error("vault-resume error", e instanceof Error ? e.message : String(e));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
