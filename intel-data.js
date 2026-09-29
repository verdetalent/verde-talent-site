// Data access for the Intelligence account pages (employer-intel-home.html and
// employer-intelligence.html). Holds no data itself.
//
// Everything paid comes from Supabase with the signed-in employer's token, and row-level
// security decides what comes back (supabase/migrations/001 and 004): a subscriber gets the
// dataset, anyone else gets zero rows and the page shows its locked view. Nothing paid is
// ever a file on this site, because anything on GitHub Pages can be downloaded by anyone.
//
// On a local copy only, ?sample=data|postings|new|locked reads a local pro-data.json and
// sample postings so the layout can be judged without an account. The hostname check means
// it can never switch on at verdetalent.com, and neither sample file is ever published.
(function () {
  const SUPABASE_URL = 'https://iqcyofkosjopxsfdufvy.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_8fNT-RdlQa_K6O9dxPYxkA__mHmbJNH';
  const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
  const SAMPLE = LOCAL ? new URLSearchParams(location.search).get('sample') : null;
  const SAMPLE_WATCH_KEY = 'vt_intel_watchlist';

  function session() {
    if (SAMPLE) return { access_token: 'sample', user_id: 'sample' };
    try {
      const raw = localStorage.getItem('vt_employer_session');
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s.access_token || s.expires_at < Date.now()) return null;
      return s;
    } catch {
      return null;
    }
  }

  class SignInNeeded extends Error {}

  async function rest(path, options = {}) {
    const s = session();
    if (!s) throw new SignInNeeded();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${s.access_token}`,
                 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (res.status === 401) throw new SignInNeeded();
    return res;
  }

  function signIn(page) {
    location.href = `employer-login.html?next=${encodeURIComponent(page)}`;
  }

  function loadScript(src) {
    return new Promise(resolve => {
      const tag = document.createElement('script');
      tag.src = src; tag.onload = resolve; tag.onerror = resolve;
      document.head.appendChild(tag);
    });
  }

  // { status: 'ok', data } | { status: 'locked' } | { status: 'signin' }
  async function load() {
    if (SAMPLE) {
      if (SAMPLE === 'locked') return { status: 'locked' };
      const data = await (await fetch('pro-data.json', { cache: 'no-store' })).json();
      return { status: 'ok', data };
    }
    try {
      const res = await rest('intel_dataset?select=part,data');
      // Before the migration has run the table does not exist; treat it like no access.
      if (!res.ok) return { status: 'locked' };
      const rows = await res.json();
      if (!rows.length) return { status: 'locked' };
      return { status: 'ok', data: Object.assign({}, ...rows.map(r => r.data)) };
    } catch (e) {
      if (e instanceof SignInNeeded) return { status: 'signin' };
      throw e;
    }
  }

  // The employer's own live postings, as the pages expect them. Live, only the pay
  // comparison is known (intel_posting_benchmark); what a posting asks for is not read
  // from its description yet, so `requirements` is null and the requirement panels hide.
  async function myPostings() {
    if (SAMPLE) {
      if (SAMPLE !== 'postings') return [];
      await loadScript('my-postings.js');
      return window.MY_POSTINGS || [];
    }
    try {
      const res = await rest('intel_posting_benchmark?select=posting_id,role,scope,area_key,'
        + 'advertised_annual,days_live&benchmarked=eq.true&scope=eq.state');
      if (!res.ok) return [];
      const rows = await res.json();
      if (!rows.length) return [];
      const titles = {};
      try {
        const s = session();
        const list = await fetch(`${SUPABASE_URL}/functions/v1/manage-posting`, {
          method: 'POST',
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${s.access_token}`,
                     'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list' }),
        }).then(r => r.json());
        (list.postings || []).forEach(p => { titles[p.id] = p.job_title; });
      } catch { /* titles are a nicety; the role name stands in */ }
      return rows.filter(r => r.role && r.area_key).map(r => ({
        title: titles[r.posting_id] || r.role, where: r.area_key, state: r.area_key, role: r.role,
        advertised: r.advertised_annual, days: r.days_live, requirements: null,
      }));
    } catch {
      return [];
    }
  }

  // The roles and markets an account follows: intel_watchlist live (migration 002),
  // browser storage in a local sample. Rows are { role, state }.
  const watch = {
    async load() {
      if (SAMPLE) {
        if (SAMPLE === 'new') { try { localStorage.removeItem(SAMPLE_WATCH_KEY); } catch {} return null; }
        try { return JSON.parse(localStorage.getItem(SAMPLE_WATCH_KEY) || 'null'); } catch { return null; }
      }
      try {
        const res = await rest('intel_watchlist?select=role,area_key&scope=eq.state&order=created_at');
        return res.ok ? (await res.json()).map(r => ({ role: r.role, state: r.area_key })) : [];
      } catch {
        return [];
      }
    },
    // Writes only the difference, so following one more role is one insert.
    async save(before, after) {
      if (SAMPLE) { try { localStorage.setItem(SAMPLE_WATCH_KEY, JSON.stringify(after)); } catch {} return; }
      const key = r => r.role + '|' + r.state;
      const had = new Set((before || []).map(key)), has = new Set(after.map(key));
      const added = after.filter(r => !had.has(key(r)));
      const removed = (before || []).filter(r => !has.has(key(r)));
      const s = session();
      try {
        if (added.length) await rest('intel_watchlist?on_conflict=user_id,role,scope,area_key', {
          method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
          body: JSON.stringify(added.map(r => ({ user_id: s.user_id, role: r.role, scope: 'state',
                                                area_key: r.state, source: 'manual' }))),
        });
        for (const r of removed) await rest(`intel_watchlist?scope=eq.state&role=eq.${encodeURIComponent(r.role)}`
          + `&area_key=eq.${encodeURIComponent(r.state)}`, { method: 'DELETE' });
      } catch (e) {
        console.error('Could not save what you follow', e);
      }
    },
  };

  // Billing (supabase/functions/intel-billing). Checkout only starts the purchase; access
  // turns on when Stripe tells stripe-webhook the subscription exists.
  async function billing(body) {
    if (SAMPLE) { alert('Sample page: checkout is not available here.'); return null; }
    const s = session();
    if (!s) throw new SignInNeeded();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/intel-billing`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${s.access_token}`,
                 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new SignInNeeded();
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }
  async function checkout(interval) {
    const data = await billing({ action: 'checkout', interval });
    if (data && data.url) location.href = data.url;
  }
  async function portal() {
    const data = await billing({ action: 'portal' });
    if (data && data.url) location.href = data.url;
  }

  // Sectors and markets followed on their own (intel_follows, migration 007): lets an
  // account with no postings and no roles picked yet say "Storage, in Texas" and get a report
  // built around that. Returned as { sectors: [...], markets: [...] }.
  const SAMPLE_FOLLOWS_KEY = 'vt_intel_follows';
  const follows = {
    async load() {
      const empty = { sectors: [], markets: [] };
      if (SAMPLE) {
        if (SAMPLE === 'new') { try { localStorage.removeItem(SAMPLE_FOLLOWS_KEY); } catch {} return empty; }
        try { return JSON.parse(localStorage.getItem(SAMPLE_FOLLOWS_KEY) || 'null') || empty; } catch { return empty; }
      }
      try {
        const res = await rest('intel_follows?select=kind,key&order=created_at');
        if (!res.ok) return empty;
        const rows = await res.json();
        return { sectors: rows.filter(r => r.kind === 'sector').map(r => r.key),
                 markets: rows.filter(r => r.kind === 'market').map(r => r.key) };
      } catch {
        return empty;
      }
    },
    async save(before, after) {
      if (SAMPLE) { try { localStorage.setItem(SAMPLE_FOLLOWS_KEY, JSON.stringify(after)); } catch {} return; }
      const s = session();
      const flat = f => [...(f.sectors || []).map(k => 'sector|' + k), ...(f.markets || []).map(k => 'market|' + k)];
      const had = new Set(flat(before || {})), has = new Set(flat(after));
      const added = [...has].filter(x => !had.has(x)), removed = [...had].filter(x => !has.has(x));
      try {
        if (added.length) await rest('intel_follows?on_conflict=user_id,kind,key', {
          method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
          body: JSON.stringify(added.map(x => { const [kind, key] = x.split('|'); return { user_id: s.user_id, kind, key }; })),
        });
        for (const x of removed) {
          const [kind, key] = x.split('|');
          await rest(`intel_follows?kind=eq.${kind}&key=eq.${encodeURIComponent(key)}`, { method: 'DELETE' });
        }
      } catch (e) {
        console.error('Could not save followed sectors and markets', e);
      }
    },
  };

  function signOut() {
    localStorage.removeItem('vt_employer_session');
    location.href = 'employer-login.html';
  }

  // Local sample only: links between the Intelligence pages keep ?sample=, so clicking
  // through the preview never lands on the real sign-in.
  if (SAMPLE) document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="employer-intel"]');
    if (!a || /[?&]sample=/.test(a.getAttribute('href'))) return;
    const href = a.getAttribute('href');
    a.setAttribute('href', href + (href.includes('?') ? '&' : '?') + 'sample=' + encodeURIComponent(SAMPLE));
  }, true);

  // Scraped text (job titles, locations, news headlines) goes through esc() before it is put
  // into a page, and links through safeUrl(), which only lets http(s) through.
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = v => /^https?:\/\//i.test(String(v || '')) ? esc(v) : '#';

  window.VTIntel = { SAMPLE, LOCAL, load, myPostings, watch, follows, signIn, signOut, checkout, portal, SignInNeeded, esc, safeUrl };
})();
