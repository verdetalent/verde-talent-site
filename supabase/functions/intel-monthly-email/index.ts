// The monthly Intelligence email: one market report per subscriber, built from the same data
// as the Intelligence pages (intel_dataset, including the 'monthly' insights part) and
// compared with last month's copy (intel_dataset_history) for "what changed".
//
// Triggered by Supabase Cron every Tuesday; it only sends in the second week of the month
// (days 8-14), so it lands on the second Tuesday, after that month's government releases.
// "Verify JWT" stays ON: the cron job calls it with the service-role key, and a browser can't.
//
// Body (all optional):
//   { "test_email": "you@x.com", "as_email": "subscriber@x.com" }
//        builds the email for as_email's account (default: the first subscriber) and sends ONE
//        copy to test_email only. Nothing is recorded as sent.
//   { "force": true }  sends outside the second week (a missed month).
//
// Each subscriber is sent at most once per month (intel_subscriptions.last_report_month).
//
// Env vars required: RESEND_API_KEY, plus the auto-provided SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);
const SITE = "https://verdetalent.com";
const FROM = "Verde Talent Intelligence <reports@updates.verdetalent.com>";

// deno-lint-ignore no-explicit-any
type Any = any;

const SECTORS: [string, string][] = [["Solar", "solar"], ["Wind", "wind"], ["Storage", "storage"], ["Grid", "grid"]];
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
const gw = (v: number) => v >= 1000 ? (v / 1000).toFixed(1) + " GW" : Math.round(v) + " MW";
const pct = (v: number) => Number(v).toFixed(1) + "%";
const signed = (v: number) => (v > 0 ? "+" : "") + Math.round(v).toLocaleString("en-US");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function previousMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

async function loadParts(table: string, filter?: [string, string]) {
  let q = db.from(table).select("part,data");
  if (filter) q = q.eq(filter[0], filter[1]);
  const { data, error } = await q;
  if (error) throw error;
  return Object.assign({}, ...(data || []).map((r: Any) => r.data));
}

// ------------------------------------------------------------------------------ the email --
function sectorOf(D: Any, role: string, st: string): string | null {
  let best: string | null = null, bestN = -1;
  for (const [k] of SECTORS) {
    const x = D.sectors?.[k];
    const nat = x?.national.roles.find((r: Any) => r[0] === role);
    if (!nat) continue;
    const loc = (x.states?.[st]?.roles || []).find((r: Any) => r[0] === role)?.[1] || 0;
    const n = loc * 100000 + nat[1];
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

function build(D: Any, H: Any | null, who: { rows: Any[]; states: string[]; sectors: string[]; posts: Any[]; token: string }, month: string) {
  const M = D.monthly || {};
  const title = (r: string) => D.titles?.[r] || r;
  const name = (st: string) => D.states[st]?.name || st;
  const cell = (r: string, st: string) => D.states[st]?.roles?.[r];
  const bls = (r: string, st: string) => D.bls?.[r]?.states?.[st];
  const word = Object.fromEntries(SECTORS);
  const monthName = new Date(month + "-15").toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // ---- 3 things to do this month
  const recs: [number, string][] = [];
  for (const p of who.posts) {
    const c = cell(p.role, p.area_key);
    if (p.gap_pct != null && p.gap_pct <= -3 && p.market_median)
      recs.push([100 + Math.abs(p.gap_pct), `Your <b>${esc(p.title)}</b> posting in ${esc(name(p.area_key))} advertises ${money(p.advertised_annual)},
        ${Math.abs(p.gap_pct)}% below the ${money(p.market_median)} market median. Raising it to at least that is the quickest way to more applicants.`]);
    if (c?.days && p.days_live >= c.days * 1.5)
      recs.push([85, `Your <b>${esc(p.title)}</b> posting has been up ${p.days_live} days; searches like it in ${esc(name(p.area_key))} usually close in ${c.days}.
        Check the pay and requirements against the market on its role page.`]);
  }
  for (const r of who.rows) {
    const c = cell(r.role, r.state), b = bls(r.role, r.state), nat = D.national?.[r.role] || {};
    if (c?.pay && b?.[1] && c.pay[1] < b[1])
      recs.push([80, `Employers advertise <b>${esc(title(r.role))}s</b> in ${esc(name(r.state))} at ${money(c.pay[1])}, below what the lowest-paid quarter
        of people already in the job earn (${money(b[1])}, BLS). Budget at least ${money(b[1])} to be competitive.`]);
    if (c?.days && nat.days && c.days >= nat.days * 1.4) {
      const alt = Object.entries(D.states).map(([k, s]: Any) => [k, s.roles?.[r.role]])
        .filter(([k, x]: Any) => k !== r.state && x?.days && x.open >= 5 && x.days <= c.days * 0.7)
        .sort((a: Any, b2: Any) => b2[1].open - a[1].open)[0] as Any;
      if (alt) recs.push([60, `<b>${esc(title(r.role))}</b> searches in ${esc(name(r.state))} take ${c.days} days against ${nat.days} nationally.
        ${esc(name(alt[0]))} fills them in ${alt[1].days} days with ${alt[1].open} open &mdash; worth recruiting there too.`]);
    }
  }
  for (const st of who.states) for (const sec of who.sectors) {
    for (const [c, now, then] of (M.moves?.[st]?.[sec]?.down || []))
      recs.push([70, `<b>${esc(c)}</b> has cut its open ${word[sec]} roles in ${esc(name(st))} from ${then} to ${now}. Its people may be open to offers now.`]);
  }
  for (const st of who.states) for (const [co, city, n, when, kind] of (M.layoffs?.[st] || []))
    if (n && n >= 100) recs.push([kind === "energy" ? 75 : 55, `<b>${esc(co)}</b> filed a layoff notice for ${n.toLocaleString("en-US")} workers
      in ${esc(city)}${city ? ", " : ""}${esc(name(st))} (${esc(when)}): experienced ${kind === "energy" ? "energy" : "plant and trades"} workers about to be looking.`]);
  const away = Object.entries(D.states).filter(([k, s]: Any) => !who.states.includes(k) && s.unemp && s.move && s.move.net_households < 0)
    .sort((a: Any, b: Any) => b[1].unemp.latest - a[1].unemp.latest)[0] as Any;
  if (away) recs.push([40, `Recruit from <b>${esc(away[1].name)}</b>: unemployment is ${pct(away[1].unemp.latest)} and more households are leaving than arriving.`]);
  const three = recs.sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1]);

  // ---- this month's lists
  const line = (label: string, colour: string, text: string, sub = "") => `<tr><td style="padding:7px 0;border-bottom:1px solid #E6EAE8;vertical-align:top;width:104px;
    font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${colour};">${label}</td>
    <td style="padding:7px 0 7px 10px;border-bottom:1px solid #E6EAE8;font-size:13.5px;line-height:1.5;color:#333;">${text}${sub ? `<br><span style="font-size:12px;color:#8A908D;">${sub}</span>` : ""}</td></tr>`;
  const moves: [number, string][] = [];
  for (const st of who.states) for (const sec of who.sectors) {
    const mv = M.moves?.[st]?.[sec];
    if (!mv) continue;
    const where = `${word[sec]} in ${esc(name(st))}`;
    (mv.up || []).forEach(([c, n, t]: Any) => moves.push([n - t, line("Hiring more", "#0E8A5F", `<b>${esc(c)}</b> &middot; ${t} &rarr; ${n} open`, where)]));
    (mv.down || []).forEach(([c, n, t]: Any) => moves.push([t - n, line("Cutting back", "#B2381F", `<b>${esc(c)}</b> &middot; ${t} &rarr; ${n} open`, where)]));
    (mv.new || []).forEach(([c, n]: Any) => moves.push([n + 5, line("New here", "#1D6FB8", `<b>${esc(c)}</b> &middot; ${n} open`, where)]));
    (mv.quiet || []).forEach(([c]: Any) => moves.push([1, line("Gone quiet", "#A35F00", `<b>${esc(c)}</b> &middot; nothing new in six weeks`, where)]));
  }
  const pay: string[] = [], slow: [number, string][] = [];
  for (const r of who.rows) {
    const x = M.roles?.[r.role + "|" + r.state];
    if (!x) continue;
    const where = `${esc(title(r.role))} &middot; ${esc(name(r.state))}`;
    if (x.top) pay.push(line("Top offer", "#6B716E", `<b>${money(x.top[1])}</b> from ${esc(x.top[0])}`, where));
    (x.pay_moves || []).slice(0, 2).forEach(([c, a, b, p]: Any) => pay.push(line(p > 0 ? "Raised pay" : "Cut pay", p > 0 ? "#0E8A5F" : "#B2381F",
      `<b>${esc(c)}</b> ${money(a)} &rarr; ${money(b)}`, where)));
    (x.struggling || []).forEach(([c, t, loc, days, reposts]: Any) => slow.push([days + reposts * 60, line(`${days} days`, "#A35F00",
      `<b>${esc(c)}</b> &middot; ${esc(t)}`, `${esc(loc)}${reposts ? ` &middot; reposted ${reposts}&times;` : ""} &middot; usually ${x.typical || "?"} days`)]));
  }
  const proj: string[] = [];
  for (const st of who.states) (M.projects?.[st]?.new || []).slice(0, 2).forEach(([plant, entity, tech, mw, online]: Any) =>
    proj.push(line("New project", "#1D6FB8", `<b>${esc(plant)}</b> &middot; ${esc(tech)}, ${gw(mw)}`, `${esc(name(st))} &middot; ${esc(entity)} &middot; due ${esc(online)}`)));
  const laid: [number, string][] = [];
  for (const st of who.states) (M.layoffs?.[st] || []).forEach(([co, city, n, when, kind]: Any) => laid.push([(kind === "energy" ? 1e6 : 0) + (n || 0),
    line(n ? `${n.toLocaleString("en-US")} jobs` : "Layoff", kind === "energy" ? "#1D6FB8" : "#6B716E", `<b>${esc(co)}</b>`, `${esc(city)}${city ? ", " : ""}${esc(name(st))} &middot; notice ${esc(when)}`)]));
  const news = who.sectors.flatMap((s) => (M.news?.[s] || []).slice(0, 2)).slice(0, 3);
  const safe = (u: string) => /^https?:\/\//i.test(u || "") ? esc(u) : SITE;

  // ---- your postings
  const postRows = who.posts.map((p) => {
    const gap = p.gap_pct == null ? "&mdash;" : `${p.gap_pct > 0 ? "+" : ""}${p.gap_pct}%`;
    return line(`${p.applications} applied`, "#0E8A5F", `<b>${esc(p.title)}</b> &middot; ${esc(name(p.area_key))}`,
      `${money(p.advertised_annual || 0)} advertised, ${gap} vs market &middot; up ${p.days_live} days${p.typical_days ? `, usually ${p.typical_days}` : ""}`);
  });

  // ---- what changed since last month
  const changed: string[] = [];
  if (H?.states) {
    for (const r of who.rows) {
      const now = cell(r.role, r.state), was = H.states[r.state]?.roles?.[r.role];
      if (!now || !was) continue;
      const where = `${esc(title(r.role))}, ${esc(name(r.state))}`;
      if (was.open !== now.open) changed.push(line("Open roles", "#6B716E", `${was.open} &rarr; <b>${now.open}</b>`, where));
      if (was.pay && now.pay && Math.abs(now.pay[1] - was.pay[1]) >= 500)
        changed.push(line("Advertised pay", "#6B716E", `${money(was.pay[1])} &rarr; <b>${money(now.pay[1])}</b>`, where));
      if (was.days && now.days && was.days !== now.days) changed.push(line("Time to fill", "#6B716E", `${was.days} &rarr; <b>${now.days} days</b>`, where));
    }
    for (const st of who.states) {
      const now = D.states[st], was = H.states[st];
      if (now?.unemp && was?.unemp && now.unemp.latest !== was.unemp.latest)
        changed.push(line("Unemployment", "#6B716E", `${pct(was.unemp.latest)} &rarr; <b>${pct(now.unemp.latest)}</b>`, esc(name(st))));
    }
  }

  // ---- the numbers
  const open = who.rows.reduce((a, r) => a + (cell(r.role, r.state)?.open || 0), 0);
  const soon = who.states.reduce((a, st) => a + (D.states[st]?.pipe?.mw?.within_12mo || 0), 0);
  const days = who.rows.map((r) => cell(r.role, r.state)?.days).filter(Boolean).sort((a: number, b: number) => a - b);
  const stat = (v: string, l: string) => `<td width="33%" style="padding:6px;vertical-align:top;"><div style="background:#F4F6F5;border-radius:10px;padding:13px 12px;">
    <div style="font-size:21px;font-weight:700;color:#111;">${v}</div><div style="font-size:12px;color:#6B716E;line-height:1.4;margin-top:3px;">${l}</div></div></td>`;

  const section = (h: string, body: string) => body ? `<tr><td style="padding:20px 28px 2px;"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;
    color:#6B716E;font-weight:700;margin-bottom:6px;">${h}</div>${body}</td></tr>` : "";
  const table = (rows: string[]) => rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join("")}</table>` : "";
  const sectorWords = who.sectors.map((s) => word[s]).join(" and ");
  const stateNames = who.states.slice(0, 3).map(name).join(", ") + (who.states.length > 3 ? ` and ${who.states.length - 3} more` : "");
  const unsubscribe = `${SUPABASE_URL}/functions/v1/intel-unsubscribe?token=${who.token}`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#EEF1EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1EF;"><tr><td align="center" style="padding:18px 12px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;border:1px solid #DADFDC;">
<tr><td style="padding:20px 28px 14px;border-bottom:3px solid #0E8A5F;"><table role="presentation" width="100%"><tr>
  <td><img src="${SITE}/logo.png" alt="Verde Talent" width="72" height="72" style="display:block;border:0;"></td>
  <td style="text-align:right;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#0E8A5F;font-weight:700;">Intelligence<br>
  <span style="color:#6B716E;font-weight:600;">Market report &middot; ${esc(monthName)}</span></td></tr></table></td></tr>
<tr><td style="padding:22px 28px 4px;"><h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;color:#111;">Your markets this month</h1>
  <p style="margin:0;font-size:14.5px;line-height:1.6;color:#333;">${sectorWords ? esc(sectorWords[0].toUpperCase() + sectorWords.slice(1)) + " hiring" : "Clean energy hiring"} in
  ${esc(stateNames)}, from this month's postings and government data.</p></td></tr>
${three.length ? `<tr><td style="padding:18px 28px 4px;"><div style="background:#F1F8F4;border:1px solid #CFE7DA;border-radius:12px;padding:14px 16px;">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#0E8A5F;font-weight:700;margin-bottom:8px;">3 things to do this month</div>
  ${three.map((t, i) => `<table role="presentation" width="100%"><tr><td style="vertical-align:top;width:24px;font-size:14px;font-weight:700;color:#0E8A5F;padding:5px 0;">${i + 1}.</td>
  <td style="font-size:14px;line-height:1.55;color:#222;padding:5px 0;">${t}</td></tr></table>`).join("")}</div></td></tr>` : ""}
${section("Competitor moves", table(moves.sort((a, b) => b[0] - a[0]).slice(0, 4).map((x) => x[1])))}
${section("Pay watch", table(pay.slice(0, 4)))}
${section("Struggling to fill", table(slow.sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1])))}
${section("Layoffs near you", table(laid.sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1])))}
${section("New projects in your states", table(proj.slice(0, 3)))}
${section("Your postings", table(postRows))}
${section("What changed since last month", table(changed.slice(0, 5)))}
${news.length ? section("In the news", news.map(([t, url, src]: Any) => `<p style="margin:0 0 8px;font-size:13.5px;line-height:1.5;">
  <a href="${safe(url)}" style="color:#1D6FB8;text-decoration:none;">${esc(t)}</a>${src ? ` <span style="color:#8A908D;font-size:12px;">&middot; ${esc(src)}</span>` : ""}</p>`).join("")) : ""}
<tr><td style="padding:18px 22px 2px;"><table role="presentation" width="100%"><tr>
  ${stat(open.toLocaleString("en-US"), "open roles you follow")}${stat(soon ? gw(soon) : "&mdash;", "due online in your states within 12 months")}${stat(days.length ? days[Math.floor(days.length / 2)] + " days" : "&mdash;", "typical time to fill")}
</tr></table></td></tr>
<tr><td align="center" style="padding:24px 28px 8px;"><a href="${SITE}/employer-intel-report.html" style="display:inline-block;background:#0E8A5F;color:#ffffff;text-decoration:none;
  font-size:15px;font-weight:700;padding:14px 26px;border-radius:10px;">Open your full report &rarr;</a>
  <p style="margin:12px 0 0;font-size:12.5px;color:#6B716E;">Every sector, state and role you follow &mdash; with <b>Download PDF</b>.</p></td></tr>
<tr><td style="padding:22px 28px 24px;border-top:1px solid #E6EAE8;">
  <p style="margin:0 0 6px;font-size:11.5px;line-height:1.6;color:#8A908D;">You get this because your Verde Talent account has Intelligence. It covers the sectors,
  states and roles you follow &mdash; change them on the Intelligence page.</p>
  <p style="margin:0;font-size:11.5px;color:#8A908D;"><a href="${unsubscribe}" style="color:#8A908D;">Stop these monthly emails</a> &middot;
  <a href="${SITE}/employer-account.html" style="color:#8A908D;">Account &amp; billing</a> &middot; Verde Talent &middot; contact@verdetalent.com</p></td></tr>
</table></td></tr></table></body></html>`;

  const text = [`Verde Talent Intelligence - market report, ${monthName}`, "",
    ...(three.length ? ["3 things to do this month:", ...three.map((t, i) => `${i + 1}. ${t.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim()}`), ""] : []),
    `Open your full report: ${SITE}/employer-intel-report.html`, "", `Stop these emails: ${unsubscribe}`].join("\n");
  return { html, text, subject: `Your ${monthName} market report${who.sectors.length && who.sectors.length < 4 ? ` · ${sectorWords}` : ""}`, unsubscribe };
}

// --------------------------------------------------------------------------------- run -----
Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const testTo: string | undefined = body.test_email;
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const dom = now.getUTCDate();
    if (!testTo && !body.force && (dom < 8 || dom > 14)) return json({ skipped: "not the second week of the month" });

    const D = await loadParts("intel_dataset");
    let H: Any = await loadParts("intel_dataset_history", ["month", previousMonth(month)]);
    if (!H.states) H = null;

    const { data: subs, error } = await db.from("intel_subscriptions")
      .select("user_id, status, current_period_end, monthly_email, email_token, last_report_month");
    if (error) throw error;
    let targets = (subs || []).filter((s: Any) => ["active", "past_due"].includes(s.status)
      && new Date(s.current_period_end) > now && s.monthly_email);

    if (testTo) {
      let pick = targets[0];
      if (body.as_email) {
        const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 });
        const u = list?.users.find((x: Any) => (x.email || "").toLowerCase() === String(body.as_email).toLowerCase());
        pick = (subs || []).find((s: Any) => s.user_id === u?.id) || pick;
      }
      targets = pick ? [pick] : [];
    }

    const results: Any[] = [];
    for (const s of targets) {
      if (!testTo && s.last_report_month === month) { results.push({ user: s.user_id, skipped: "already sent" }); continue; }
      try {
        const { data: u } = await db.auth.admin.getUserById(s.user_id);
        const email = u?.user?.email;
        if (!email) continue;
        const [{ data: watch }, { data: follows }, { data: bench }] = await Promise.all([
          db.from("intel_watchlist").select("role, area_key").eq("user_id", s.user_id).eq("scope", "state"),
          db.from("intel_follows").select("kind, key").eq("user_id", s.user_id),
          db.from("intel_posting_benchmark").select("posting_id, role, area_key, advertised_annual, market_median, gap_pct, days_live, typical_days, benchmarked")
            .eq("user_id", s.user_id).eq("benchmarked", true),
        ]);
        const posts: Any[] = [];
        for (const b of bench || []) {
          const [{ data: jp }, { count }] = await Promise.all([
            db.from("job_postings").select("job_title").eq("id", b.posting_id).maybeSingle(),
            db.from("applications").select("id", { count: "exact", head: true }).eq("job_posting_id", b.posting_id)
              .eq("status", "sent").gte("created_at", new Date(now.getTime() - 30 * 86400000).toISOString()),
          ]);
          posts.push({ ...b, title: jp?.job_title || b.role, applications: count || 0 });
        }
        const seen = new Set<string>();
        const rows = [...(watch || []).map((w: Any) => ({ role: w.role, state: w.area_key })), ...posts.map((p) => ({ role: p.role, state: p.area_key }))]
          .filter((r) => { const k = r.role + "|" + r.state; if (seen.has(k) || !D.states[r.state]?.roles?.[r.role]) return false; seen.add(k); return true; });
        const markets = (follows || []).filter((f: Any) => f.kind === "market" && D.states[f.key]).map((f: Any) => f.key);
        let states = [...new Set([...markets, ...rows.map((r) => r.state)])];
        if (!states.length) states = Object.keys(D.states).sort((a, b) =>
          Object.values(D.states[b].roles).reduce((n: number, c: Any) => n + c.open, 0) - Object.values(D.states[a].roles).reduce((n: number, c: Any) => n + c.open, 0)).slice(0, 3);
        const chosen = (follows || []).filter((f: Any) => f.kind === "sector").map((f: Any) => f.key);
        const inferred = rows.map((r) => sectorOf(D, r.role, r.state)).filter(Boolean) as string[];
        let sectors = SECTORS.map(([k]) => k).filter((k) => chosen.includes(k) || inferred.includes(k));
        if (!sectors.length) sectors = SECTORS.map(([k]) => k);

        const mail = build(D, H, { rows, states, sectors, posts, token: s.email_token }, month);
        const { data: sent, error: sendError } = await resend.emails.send({
          from: FROM, to: testTo || email, subject: (testTo ? "[Test] " : "") + mail.subject, html: mail.html, text: mail.text,
          headers: { "List-Unsubscribe": `<${mail.unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        });
        if (sendError) throw sendError;
        if (!testTo) await db.from("intel_subscriptions").update({ last_report_month: month }).eq("user_id", s.user_id);
        results.push({ user: s.user_id, sent: testTo || email, resend_id: sent?.id || null });
      } catch (err) {
        console.error("monthly email failed", s.user_id, err);
        results.push({ user: s.user_id, error: String((err as Any)?.message || err) });
      }
    }
    return json({ month, compared_with: H ? previousMonth(month) : null, results });
  } catch (err) {
    console.error(err);
    return json({ error: String((err as Any)?.message || err) }, 500);
  }
});
