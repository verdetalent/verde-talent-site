// Which of a person's saved / tracked jobs have closed (2026-11-23). Reads each job's own page:
// a closed page carries its closing date and similar open roles (export_job_pages_to_verde_talent.py),
// an older closed page only says "This listing has closed", and a page past its 60 days is gone (404).
// Used by saved-jobs.html and the dashboard's Applications tracker.
(function () {
  const CACHE_KEY = 'vt_closed_cache';
  const TTL = 30 * 60 * 1000;
  let cache = {};
  try { cache = JSON.parse(sessionStorage.getItem(CACHE_KEY) || '{}'); } catch (e) {}
  const save = () => { try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) {} };

  function parse(html) {
    const m = html.match(/<script type="application\/json" id="vt-closed">([\s\S]*?)<\/script>/);
    if (m) {
      let closed = null, similar = [];
      try { closed = JSON.parse(m[1]).closed || null; } catch (e) {}
      const s = html.match(/<script type="application\/json" id="vt-closed-similar">([\s\S]*?)<\/script>/);
      try { if (s) similar = JSON.parse(s[1]).similar || []; } catch (e) {}
      return { closed: true, date: closed, similar };
    }
    if (html.indexOf('This listing has closed') !== -1) return { closed: true, date: null, similar: [] };
    return { closed: false };
  }

  async function one(key) {
    const hit = cache[key];
    if (hit && Date.now() - hit.at < TTL) return hit.r;
    let r = { closed: false };
    try {
      const res = await fetch('/jobs/' + encodeURIComponent(key) + '.html', { credentials: 'omit' });
      if (res.status === 404) r = { closed: true, date: null, similar: [] };
      else if (res.ok) r = parse(await res.text());
    } catch (e) { return { closed: false }; }  // offline etc: say nothing rather than guess
    cache[key] = { at: Date.now(), r };
    save();
    return r;
  }

  // keys: job page slugs. Resolves to { slug: {closed, date, similar} } for the closed ones only.
  async function check(keys) {
    const todo = Array.from(new Set(keys.filter(k => k && /^[\w-]+$/.test(k))));
    const out = {};
    let i = 0;
    async function worker() {
      while (i < todo.length) {
        const k = todo[i++];
        const r = await one(k);
        if (r.closed) out[k] = r;
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }

  function label(r) {
    if (!r.date) return 'Closed';
    const d = new Date(r.date + 'T12:00:00Z');
    return 'Closed ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  window.VTClosed = { check, label };
})();
