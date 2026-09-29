// The monthly Intelligence email: one market report per subscriber, built from the same data
// as the Intelligence pages (intel_dataset, including the 'monthly' insights part) and
// compared with last month's copy (intel_dataset_history) for "what changed".
//
// Triggered by Supabase Cron every Tuesday; it only sends in the second week of the month
// (days 8-14), so it lands on the second Tuesday, after that month's government releases.
// "Verify JWT" stays ON: the cron job calls it with the service-role key, and a browser can't.
//
// Body (all optional):
//   { "preview": true, "as_email": "subscriber@x.com" }  returns that subscriber's email as HTML
//        and sends nothing - for checking the design.
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
  // "Wind Turbine Technicians", but "Finance & Accounting roles": only job titles take an s.
  const plural = (r: string) => { const t = title(r); return t.endsWith("s") ? t
    : /(ian|er|or|ist|ive|man|ant|ent)$/i.test(t) ? t + "s" : t + " roles"; };
  const single = (r: string) => title(r);
  // Job titles often carry the site: "Wind Technician I (Advanced Level) at Northern Colorado Wind in Peetz, CO".
  const shortTitle = (t: string) => String(t || "").split(/\s+(?:at|in|-|–|\|)\s+|\s*\(/)[0].slice(0, 60);
  const name = (st: string) => D.states[st]?.name || st;
  const cell = (r: string, st: string) => D.states[st]?.roles?.[r];
  const bls = (r: string, st: string) => D.bls?.[r]?.states?.[st];
  const word = Object.fromEntries(SECTORS) as Record<string, string>;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ym = (v: string) => { const [y, m] = String(v || "").split("-"); return m ? `${MONTHS[+m - 1]} ${y}` : esc(v); };
  const md = (v: string) => { const [, m, d] = String(v || "").split("-"); return d ? `${MONTHS[+m - 1]} ${+d}` : esc(v); };
  const pctOf = (now: number, then: number) => then ? Math.round(100 * (now / then - 1)) : 0;
  const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
  const link = (r: string, st: string) => `${SITE}/employer-intelligence.html?role=${encodeURIComponent(r)}&amp;state=${st}`;
  const monthName = new Date(month + "-15").toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // ---- Key takeaways: at most one of each type, each with a number, what it means, what to do.
  type Take = { type: string; score: number; label: string; colour: string; figure: string; note: string; text: string; action: string; href: string; linkText: string };
  const takes: Take[] = [];
  for (const p of who.posts) {
    const c = cell(p.role, p.area_key);
    if (p.gap_pct != null && p.gap_pct <= -3 && p.market_median)
      takes.push({ type: "pay", score: 100 + Math.abs(p.gap_pct), label: "Your pay", colour: "#A35F00", figure: money(p.advertised_annual),
        note: `&minus;${Math.abs(p.gap_pct)}% vs market`, text: `Your <b>${esc(p.title)}</b> posting in <b>${esc(name(p.area_key))}</b> advertises
        ${money(p.advertised_annual)}, below the ${money(p.market_median)} that employers there advertise for the same role.`,
        action: `Raise it to at least ${money(p.market_median)}.`, href: link(p.role, p.area_key), linkText: `See ${esc(single(p.role))} pay in ${esc(name(p.area_key))}` });
    if (c?.days && p.days_live >= c.days * 1.5)
      takes.push({ type: "slow", score: 85, label: "Your search", colour: "#A35F00", figure: `${p.days_live} days`, note: `usually ${c.days}`,
        text: `Your <b>${esc(p.title)}</b> posting in <b>${esc(name(p.area_key))}</b> has been up far longer than searches like it usually take there.`,
        action: `Check its pay and requirements against the market.`, href: link(p.role, p.area_key), linkText: `Compare it with the market` });
  }
  // Takeaways are worked out per role. An account that follows sectors and states but no
  // roles yet gets the busiest roles in its sectors there instead, so it still gets three.
  const takeRows = who.rows.length ? who.rows : who.states.flatMap((st) => Object.entries(D.states[st]?.roles || {})
    .filter(([r]) => { const sec = sectorOf(D, r, st); return sec && who.sectors.includes(sec); })
    .sort((a: Any, b: Any) => b[1].open - a[1].open).slice(0, 4).map(([r]) => ({ role: r, state: st })));
  for (const r of takeRows) {
    const c = cell(r.role, r.state), b = bls(r.role, r.state), nat = D.national?.[r.role] || {}, x = M.roles?.[r.role + "|" + r.state] || {};
    // Only where BLS measures this job itself: a wider stand-in occupation is not a fair floor.
    if (c?.pay && b?.[1] && c.pay[1] < b[1] && !D.bls?.[r.role]?.broad) {
      const floor = Math.ceil(b[1] / 1000) * 1000;
      takes.push({ type: "pay", score: 80 + 100 * (b[1] - c.pay[1]) / b[1], label: "Your pay", colour: "#A35F00", figure: money(c.pay[1]),
        note: `&minus;${money(b[1] - c.pay[1])} below`, text: `${esc(title(r.role))}s in <b>${esc(name(r.state))}</b> are advertised below what the lowest-paid
        quarter of people already doing the job earn (${money(b[1])}, BLS).${nat.pay && Math.abs(nat.pay[1] - c.pay[1]) >= 500
          ? ` Nationally the role advertises ${money(nat.pay[1])}.` : ""}`,
        action: `Set your ${esc(name(r.state))} band to start at ${money(floor)}.`, href: link(r.role, r.state), linkText: `See ${esc(single(r.role))} pay in ${esc(name(r.state))}` });
    }
    for (const [co, now, then] of (x.emp_moves || [])) if (now < then)
      takes.push({ type: "talent", score: 70 + (then - now), label: "Talent available", colour: "#0E8A5F", figure: `${then} &rarr; ${now}`,
        note: `${esc(co)} openings`, text: `<b>${esc(co)}</b> has cut its open ${esc(single(r.role))} roles in <b>${esc(name(r.state))}</b> by
        ${Math.abs(pctOf(now, then))}% in four weeks. People at a company that has stopped hiring for their role are the easiest to move.`,
        action: `Reach out to ${esc(co)} ${esc(plural(r.role))} in ${esc(name(r.state))} this month.`, href: link(r.role, r.state),
        linkText: `See who's hiring ${esc(plural(r.role))} in ${esc(name(r.state))}` });
    if (c?.days && nat.days && c.days >= nat.days * 1.4) {
      const alt = Object.entries(D.states).map(([k, s]: Any) => [k, s.roles?.[r.role]])
        .filter(([k, y]: Any) => k !== r.state && y?.days && y.open >= 5 && y.days <= c.days * 0.7)
        .sort((a: Any, b2: Any) => a[1].days - b2[1].days)[0] as Any;
      if (alt) takes.push({ type: "recruit", score: 60 + c.days / nat.days, label: "Where to recruit", colour: "#1D6FB8", figure: `${c.days} days`,
        note: `vs ${nat.days} nationally`, text: `${esc(title(r.role))} searches in <b>${esc(name(r.state))}</b> take ${(c.days / nat.days).toFixed(1)}&times;
        the national average. <b>${esc(name(alt[0]))}</b> fills the same role in ${alt[1].days} days, with ${alt[1].open} open${alt[1].pay && c.pay
          ? ` and advertised pay of ${money(alt[1].pay[1])} against ${esc(name(r.state))}'s ${money(c.pay[1])}` : ""}.`,
        action: `Open your ${esc(name(r.state))} search to relocating or remote candidates, starting with ${esc(name(alt[0]))}.`,
        href: link(r.role, alt[0]), linkText: `See ${esc(plural(r.role))} in ${esc(name(alt[0]))}` });
    }
  }
  for (const st of who.states) for (const [co, city, n, when, kind, industry] of (M.layoffs?.[st] || []))
    if (n && n >= 100 && (kind === "energy" || kind === true))
      takes.push({ type: "talent", score: 65 + n / 100, label: "Talent available", colour: "#0E8A5F", figure: `${n.toLocaleString("en-US")} jobs`,
        note: `notice ${md(when)}`, text: `<b>${esc(co)}</b>${industry ? ` (${esc(String(industry).replace(/^[-\d:\s]+/, "").toLowerCase())})` : ""} filed a
        layoff notice in ${esc(city)}${city ? ", " : ""}<b>${esc(name(st))}</b>: experienced energy workers about to be looking.`,
        action: `Ask the local workforce board about its rapid-response job fair, or post in ${esc(city || name(st))} now.`,
        href: `${SITE}/employer-intel-home.html?tab=mine`, linkText: `See layoffs near you` });
  // Last resort, so there are always three: the biggest build-out coming in their states.
  for (const st of who.states) {
    const p = D.states[st]?.pipe, dev = p?.top_developers?.[0];
    if (p?.mw?.within_12mo >= 500) takes.push({ type: "demand", score: 30 + p.mw.within_12mo / 1000, label: "Demand ahead", colour: "#1D6FB8",
      figure: gw(p.mw.within_12mo), note: "due online in 12 months", text: `Solar, wind and storage capacity scheduled to come online in <b>${esc(name(st))}</b>
      within a year${dev ? `, led by <b>${esc(dev.entity.trim())}</b>` : ""}. Every project needs crews to build, commission and run it.`,
      action: `Line up field crews and subcontractors in ${esc(name(st))} now, before these sites start hiring.`,
      href: `${SITE}/employer-intel-home.html?tab=explore`, linkText: `See the build pipeline in ${esc(name(st))}` });
  }
  const seenType = new Set<string>();
  const three = takes.sort((a, b) => b.score - a.score).filter((t) => !seenType.has(t.type) && seenType.add(t.type)).slice(0, 3);

  // ---- the sections
  const row = (label: string, colour: string, text: string, sub = "") => `<tr><td style="padding:8px 0;border-bottom:1px solid #E6EAE8;width:108px;
    vertical-align:top;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${colour};">${label}</td>
    <td style="padding:8px 0 8px 10px;border-bottom:1px solid #E6EAE8;font-size:13.5px;line-height:1.5;color:#333;">${text}${sub
      ? `<br><span style="color:#6B716E;">${sub}</span>` : ""}</td></tr>`;
  const section = (h: string, intro: string, rows: string[]) => rows.length ? `<tr><td style="padding:22px 28px 2px;">
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B716E;font-weight:700;">${h}</div>
    ${intro ? `<div style="font-size:12.5px;color:#8A908D;margin:2px 0 6px;">${intro}</div>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join("")}</table></td></tr>` : "";

  // Competitor moves: role-level cuts and growth first, combined across states; then new and quiet.
  const byEmpRole = new Map<string, { co: string; role: string; parts: string[]; size: number; up: boolean }>();
  for (const r of who.rows) for (const [co, now, then] of (M.roles?.[r.role + "|" + r.state]?.emp_moves || [])) {
    const key = co + "|" + r.role + "|" + (now > then);
    const e = byEmpRole.get(key) || { co, role: r.role, parts: [], size: 0, up: now > then };
    e.parts.push(`${esc(name(r.state))} ${then} &rarr; ${now} (${now > then ? "+" : "&minus;"}${Math.abs(pctOf(now, then))}%)`);
    e.size += Math.abs(now - then);
    byEmpRole.set(key, e);
  }
  const moves: [number, string][] = [...byEmpRole.values()].map((e) => [e.size + 100, row(e.up ? "Hiring more" : "Cutting back", e.up ? "#0E8A5F" : "#B2381F",
    `<b>${esc(e.co)}</b> &middot; ${esc(plural(e.role))}`, e.parts.join(" &middot; "))]);
  for (const st of who.states) for (const sec of who.sectors) {
    const mv = M.moves?.[st]?.[sec];
    if (!mv) continue;
    (mv.new || []).forEach(([co, n, role]: Any) => moves.push([n + 50, row("New here", "#1D6FB8", `<b>${esc(co)}</b> &middot; ${word[sec]}`,
      `Started hiring in ${esc(name(st))}: ${n} open${role ? `, mostly ${esc(plural(role))}` : ""}`)]));
    (mv.quiet || []).forEach(([co]: Any) => moves.push([1, row("Gone quiet", "#A35F00", `<b>${esc(co)}</b> &middot; ${word[sec]}`,
      `No new postings in ${esc(name(st))} for six weeks`)]));
  }

  const pay: string[] = [], slow: [number, string][] = [];
  for (const r of who.rows) {
    const x = M.roles?.[r.role + "|" + r.state], c = cell(r.role, r.state);
    if (!x) continue;
    if (x.top) {
      const vs = c?.pay ? Math.round(100 * (x.top[1] / c.pay[1] - 1)) : null;
      pay.push(row("Top offer", "#6B716E", `<b>${money(x.top[1])}</b> &middot; ${esc(x.top[0])}, ${esc(shortTitle(x.top[2]))}`,
        `${esc(String(x.top[3]).split(";")[0].replace(/,\s*(US|United States).*$/, ""))}${vs != null ? ` &middot; ${vs >= 0 ? vs + "% above" : Math.abs(vs) + "% below"}
        the ${esc(name(r.state))} median of ${money(c.pay[1])}` : ""}`));
    }
    (x.pay_moves || []).slice(0, 2).forEach(([co, a, b, p]: Any) => pay.push(row(p > 0 ? "Raised pay" : "Cut pay", p > 0 ? "#0E8A5F" : "#B2381F",
      `<b>${esc(co)}</b> &middot; ${esc(plural(r.role))}, ${esc(name(r.state))}`, `${money(a)} &rarr; ${money(b)} (${p > 0 ? "+" : "&minus;"}${Math.abs(p)}%)`)));
    (x.struggling || []).forEach(([co, t, loc, days, reposts]: Any) => slow.push([days + reposts * 60, row(`${days} days`, "#A35F00",
      `<b>${esc(co)}</b> &middot; ${esc(shortTitle(t))}`, `${esc(String(loc).split(";")[0].replace(/,\s*(US|United States).*$/, ""))}${reposts
        ? ` &middot; reposted ${reposts === 1 ? "once" : reposts === 2 ? "twice" : reposts + " times"}` : ""} &middot; usually fills in ${x.typical || "?"} days`)]));
  }

  const laid: [number, string][] = [];
  const NOT_TRADES = /\b(oracle|google|alphabet|meta platforms|microsoft|salesforce|adobe|netflix|linkedin|uber|lyft|airbnb|workday|intuit|paypal|amazon\.com|apple inc)\b/i;
  for (const st of who.states) (M.layoffs?.[st] || []).filter((l: Any) => !NOT_TRADES.test(l[0])).forEach(([co, city, n, when, kind, industry]: Any) => {
    const ind = String(industry || "").replace(/^[-\d:,\s]+/, "").replace(/\s*\(.*\)$/, "").toLowerCase();
    laid.push([(kind === "energy" || kind === true ? 1e6 : 0) + (n || 0), row(n ? `${n.toLocaleString("en-US")} jobs` : "Layoff",
      kind === "energy" || kind === true ? "#1D6FB8" : "#6B716E", `<b>${esc(co)}</b>${ind ? ` &middot; ${esc(ind)}` : ""}`,
      `${esc(city)}${city ? ", " : ""}${esc(name(st))} &middot; notice filed ${md(when)}`)]);
  });

  const proj: string[] = [];
  for (const st of who.states) {
    const p = M.projects?.[st];
    if (!p) continue;
    p.new.slice(0, 2).forEach(([plant, entity, tech, mw, online, county]: Any) => proj.push(row("New", "#1D6FB8",
      `<b>${esc(plant)}</b> &middot; ${gw(mw)} ${esc(String(tech).toLowerCase())}`, `${county ? esc(county) + " County, " : ""}${esc(name(st))} &middot; due ${ym(online)}`)));
    p.delayed.slice(0, 2).forEach(([plant, entity, tech, mw, online, county, was]: Any) => proj.push(row("Delayed", "#A35F00",
      `<b>${esc(plant)}</b> &middot; ${gw(mw)}`, `${county ? esc(county) + " County, " : ""}${esc(name(st))} &middot; now ${ym(online)}, was ${ym(was)}`)));
  }

  // Their postings: only the ones people applied to.
  const postRows = who.posts.filter((p) => p.applications > 0).map((p) => row(`${p.applications} applied`, "#0E8A5F",
    `<b>${esc(p.title)}</b> &middot; ${esc(name(p.area_key))}`, `${money(p.advertised_annual || 0)} advertised${p.gap_pct != null && p.market_median
      ? `, ${Math.abs(p.gap_pct)}% ${p.gap_pct < 0 ? "below" : "above"} the ${money(p.market_median)} market` : ""} &middot; up ${p.days_live} days${p.typical_days
      ? `, usually ${p.typical_days}` : ""}`));

  const FOREIGN = /\b(dubai|uae|eu|europe\w*|german\w*|china|chinese|india\w*|uk|britain|british|australia\w*|japan\w*|global|world|canada|mexico|brazil|africa\w*|asia\w*)\b/i;
  const news = who.sectors.flatMap((s) => (M.news?.[s] || []).filter((n: Any) => !FOREIGN.test(n[0])).slice(0, 2)).slice(0, 3);
  const safe = (u: string) => /^https?:\/\//i.test(u || "") ? esc(u) : SITE;

  const changed: string[] = [];
  if (H?.states) {
    for (const r of who.rows) {
      const now = cell(r.role, r.state), was = H.states[r.state]?.roles?.[r.role];
      if (!now || !was) continue;
      const where = `${esc(title(r.role))}, ${esc(name(r.state))}`;
      if (was.open !== now.open) changed.push(row("Open roles", "#6B716E", `${was.open} &rarr; <b>${now.open}</b>`, where));
      if (was.pay && now.pay && Math.abs(now.pay[1] - was.pay[1]) >= 500)
        changed.push(row("Advertised pay", "#6B716E", `${money(was.pay[1])} &rarr; <b>${money(now.pay[1])}</b>`, where));
      if (was.days && now.days && was.days !== now.days) changed.push(row("Time to fill", "#6B716E", `${was.days} &rarr; <b>${now.days} days</b>`, where));
    }
    for (const st of who.states) {
      const now = D.states[st], was = H.states[st];
      if (now?.unemp && was?.unemp && now.unemp.latest !== was.unemp.latest)
        changed.push(row("Unemployment", "#6B716E", `${pct(was.unemp.latest)} &rarr; <b>${pct(now.unemp.latest)}</b>`, esc(name(st))));
    }
  }

  const open = who.rows.reduce((a, r) => a + (cell(r.role, r.state)?.open || 0), 0);
  const soon = who.states.reduce((a, st) => a + (D.states[st]?.pipe?.mw?.within_12mo || 0), 0);
  const days = who.rows.map((r) => cell(r.role, r.state)?.days).filter(Boolean).sort((a: number, b: number) => a - b);
  const stat = (v: string, l: string) => `<td width="33%" style="padding:6px;vertical-align:top;"><div style="background:#F4F6F5;border-radius:10px;padding:13px 12px;">
    <div style="font-size:21px;font-weight:700;color:#111;">${v}</div><div style="font-size:12px;color:#6B716E;line-height:1.4;margin-top:3px;">${l}</div></div></td>`;

  // "Wind and solar hiring in Texas, Colorado and California" / "Clean energy hiring in ...".
  const sectorPhrase = who.sectors.length >= 4 ? "Clean energy" : list(who.sectors.map((s) => word[s] === "grid" ? "grid" : word[s]));
  const intro = `${sectorPhrase[0].toUpperCase() + sectorPhrase.slice(1)} hiring in ${esc(who.states.length <= 3 ? list(who.states.map(name)) : who.states.slice(0, 3).map(name).join(", ") + ` and ${who.states.length - 3} more states`)}.`;
  const unsubscribe = `${SUPABASE_URL}/functions/v1/intel-unsubscribe?token=${who.token}`;

  const card = (t: Take) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E6EAE8;border-left:4px solid ${t.colour};
    border-radius:10px;margin-bottom:12px;"><tr><td style="padding:14px 16px;">
    <div style="font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:${t.colour};font-weight:700;">${t.label}</div>
    <div style="font-size:24px;font-weight:700;color:#111;margin:4px 0 2px;">${t.figure} <span style="font-size:14px;font-weight:600;color:#6B716E;">${t.note}</span></div>
    <div style="font-size:14px;line-height:1.55;color:#333;">${t.text}</div>
    <div style="font-size:13.5px;line-height:1.5;color:#0E8A5F;font-weight:700;margin-top:8px;">&rarr; ${t.action}</div>
    <a href="${t.href}" style="font-size:12.5px;color:#1D6FB8;text-decoration:none;">${t.linkText} &rarr;</a></td></tr></table>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#EEF1EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1EF;"><tr><td align="center" style="padding:18px 12px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;border:1px solid #DADFDC;">
<tr><td style="padding:20px 28px 14px;border-bottom:3px solid #0E8A5F;"><table role="presentation" width="100%"><tr>
  <td><img src="${SITE}/logo.png" alt="Verde Talent" width="72" height="72" style="display:block;border:0;"></td>
  <td style="text-align:right;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#0E8A5F;font-weight:700;">Intelligence<br>
  <span style="color:#6B716E;font-weight:600;">Market report &middot; ${esc(monthName)}</span></td></tr></table></td></tr>
<tr><td style="padding:22px 28px 4px;"><h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;color:#111;">Your markets this month</h1>
  <p style="margin:0;font-size:14.5px;line-height:1.6;color:#333;">${intro}</p></td></tr>
${three.length ? `<tr><td style="padding:20px 28px 0;"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B716E;font-weight:700;
  margin-bottom:10px;">Key takeaways</div>${three.map(card).join("")}</td></tr>` : ""}
${who.rows.length ? "" : `<tr><td style="padding:4px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="background:#F1F8F4;border:1px solid #CFE7DA;border-radius:10px;"><tr><td style="padding:14px 16px;">
  <div style="font-size:14px;line-height:1.55;color:#222;"><b>Want takeaways about your own hiring?</b>
  Tell us the roles you hire and where, and next month's will be about yours: your pay against the market, the competitors for your roles,
  and where to find your people.</div>
  <a href="${SITE}/employer-intel-home.html?tab=mine&amp;setup=1" style="display:inline-block;margin-top:10px;background:#0E8A5F;color:#ffffff;
  text-decoration:none;font-size:13.5px;font-weight:700;padding:9px 16px;border-radius:8px;">Set up your roles (1 minute) &rarr;</a>
  </td></tr></table></td></tr>`}
${section("Competitor moves", "Roles open now against four weeks ago, for employers hiring in your markets.", moves.sort((a, b) => b[0] - a[0]).slice(0, 5).map((x) => x[1]))}
${section("Pay watch", "The best offers posted in the last 30 days, and employers who changed their advertised pay.", pay.slice(0, 4))}
${section("Struggling to fill", "Competitors' searches in your roles open over twice the usual time, or taken down and reposted. Their applicants may still be looking.",
  slow.sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1]))}
${section("Layoffs near you", "State WARN notices in energy and the trades: experienced people about to be looking for work.", laid.sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1]))}
${section("Projects in your states", "Changes in the latest federal build list (EIA-860M): crews needed, and when.", proj.slice(0, 4))}
${section("Your postings", "", postRows)}
${section("What changed since last month", "", changed.slice(0, 5))}
${news.length ? `<tr><td style="padding:22px 28px 2px;"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B716E;font-weight:700;
  margin-bottom:6px;">In the news</div>${news.map(([t, url, src]: Any) => `<p style="margin:0 0 7px;font-size:13.5px;line-height:1.5;">
  <a href="${safe(url)}" style="color:#1D6FB8;text-decoration:none;">${esc(t)}</a>${src ? ` <span style="color:#8A908D;font-size:12px;">&middot; ${esc(src)}</span>` : ""}</p>`).join("")}</td></tr>` : ""}
<tr><td style="padding:18px 22px 2px;"><table role="presentation" width="100%"><tr>
  ${stat(open.toLocaleString("en-US"), "open roles you follow")}${stat(soon ? gw(soon) : "&mdash;", "due online in your states within 12 months")}${stat(days.length ? days[Math.floor(days.length / 2)] + " days" : "&mdash;", "typical time to fill")}
</tr></table>${H ? "" : `<p style="margin:8px 6px 0;font-size:12px;color:#8A908D;">From next month: what changed since this report.</p>`}</td></tr>
<tr><td align="center" style="padding:24px 28px 8px;"><a href="${SITE}/employer-intel-report.html" style="display:inline-block;background:#0E8A5F;color:#ffffff;text-decoration:none;
  font-size:15px;font-weight:700;padding:14px 26px;border-radius:10px;">Open your full report &rarr;</a>
  <p style="margin:12px 0 0;font-size:12.5px;color:#6B716E;">Every sector, state and role you follow &mdash; with <b>Download PDF</b>.</p></td></tr>
<tr><td style="padding:22px 28px 24px;border-top:1px solid #E6EAE8;">
  <p style="margin:0 0 6px;font-size:11.5px;line-height:1.6;color:#8A908D;">You get this because your Verde Talent account has Intelligence. It covers the sectors,
  states and roles you follow &mdash; change them on the Intelligence page.</p>
  <p style="margin:0;font-size:11.5px;color:#8A908D;"><a href="${unsubscribe}" style="color:#8A908D;">Stop these monthly emails</a> &middot;
  <a href="${SITE}/employer-account.html" style="color:#8A908D;">Account &amp; billing</a> &middot; Verde Talent &middot; contact@verdetalent.com</p></td></tr>
</table></td></tr></table></body></html>`;

  const plain = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&rarr;/g, "->").replace(/&minus;/g, "-").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
  const text = [`Verde Talent Intelligence - market report, ${monthName}`, plain(intro), "",
    ...(three.length ? ["Key takeaways:", ...three.map((t, i) => `${i + 1}. ${plain(t.text)} -> ${plain(t.action)}`), ""] : []),
    `Open your full report: ${SITE}/employer-intel-report.html`, "", `Stop these emails: ${unsubscribe}`].join("\n");
  const sectorWords = who.sectors.length && who.sectors.length < 4 ? ` · ${list(who.sectors.map((s) => word[s]))}` : "";
  return { html, text, subject: `Your ${monthName} market report${sectorWords}`, unsubscribe };
}

// --------------------------------------------------------------------------------- run -----
Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const testTo: string | undefined = body.test_email;
    const preview = body.preview === true;   // { preview: true, as_email } -> the HTML, nothing sent
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const dom = now.getUTCDate();
    if (!testTo && !preview && !body.force && (dom < 8 || dom > 14)) return json({ skipped: "not the second week of the month" });

    const D = await loadParts("intel_dataset");
    let H: Any = await loadParts("intel_dataset_history", ["month", previousMonth(month)]);
    if (!H.states) H = null;

    const { data: subs, error } = await db.from("intel_subscriptions")
      .select("user_id, status, current_period_end, monthly_email, email_token, last_report_month");
    if (error) throw error;
    let targets = (subs || []).filter((s: Any) => ["active", "past_due"].includes(s.status)
      && new Date(s.current_period_end) > now && s.monthly_email);

    if (testTo || preview) {
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
        // Preview only: body.sample_follows ({ rows: [{role, state}], sectors: [...] }) stands in for
        // the account's own follows, so a design can be checked without touching anyone's data.
        const sample = preview ? body.sample_follows : null;
        const watchRows = sample?.rows || (watch || []).map((w: Any) => ({ role: w.role, state: w.area_key }));
        const rows = [...watchRows, ...posts.map((p) => ({ role: p.role, state: p.area_key }))]
          .filter((r) => { const k = r.role + "|" + r.state; if (seen.has(k) || !D.states[r.state]?.roles?.[r.role]) return false; seen.add(k); return true; });
        const markets = (follows || []).filter((f: Any) => f.kind === "market" && D.states[f.key]).map((f: Any) => f.key);
        let states = [...new Set([...markets, ...rows.map((r) => r.state)])];
        if (!states.length) states = Object.keys(D.states).sort((a, b) =>
          Object.values(D.states[b].roles).reduce((n: number, c: Any) => n + c.open, 0) - Object.values(D.states[a].roles).reduce((n: number, c: Any) => n + c.open, 0)).slice(0, 3);
        const chosen = sample?.sectors || (follows || []).filter((f: Any) => f.kind === "sector").map((f: Any) => f.key);
        const inferred = rows.map((r) => sectorOf(D, r.role, r.state)).filter(Boolean) as string[];
        let sectors = SECTORS.map(([k]) => k).filter((k) => chosen.includes(k) || inferred.includes(k));
        if (!sectors.length) sectors = SECTORS.map(([k]) => k);

        const mail = build(D, H, { rows, states, sectors, posts, token: s.email_token }, month);
        if (preview) return new Response(mail.html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
