/* Fullstory — org o-254FDS-na1
   Loaded from same origin so the site CSP only needs 'self' for this file;
   the snippet then pulls edge.fullstory.com, which is allowlisted in script-src.
   Edit here once — every page includes this file. */
!function(m,n,e,t,l,o,g,y){var u,a,f=function(h){
return!(h in m)||(m.console&&m.console.log&&m.console.log("FullStory namespace conflict. Please use a different namespace."),!1)}(l)
;f&&(g=m[l]=function(){var b=function(b,d,j,r){r=r||2;var i,c=/Async$/;return c.test(b)&&(b=b.replace(c,""),
"function"==typeof Promise)?new Promise((function(i,c){h(b,d,j,i,c,r)})):h(b,d,j,i,i,r)};function h(h,d,j,r,i,c){
return b._api?b._api(h,d,j,r,i,c):(b.q&&b.q.push([h,d,j,r,i,c]),null)}return b.q=[],b}(),y=function(b){function h(h){
"function"==typeof h[4]&&h[4](new Error(b))}var d=g.q;if(d){for(var j=0;j<d.length;j++)h(d[j]);d.length=0,d.push=h}},function(){
var b="script",d=n.createElement(b);d.async=!0,d.crossOrigin="anonymous",d.src="https://"+t+"?org="+o,d.setAttribute("data-fs-namespace",l),
d.onerror=function(){y("Error loading "+t)};var c=n.getElementsByTagName(b)[0]
;c&&c.parentNode?c.parentNode.insertBefore(d,c):n.head.appendChild(d)}(),function(){function b(){}function h(b,h,d){g(b,h,d,1)}function d(b,d,j){
h("setProperties",{type:b,properties:d},j)}function j(b,h){d("user",b,h)}function r(b,h,d){j({uid:b},d),h&&j(h,d)}g.identify=r,g.setUserVars=j,
g.identifyAccount=b,g.clearUserCookie=b,g.setVars=d,g.event=function(b,d,j){h("trackEvent",{name:b,properties:d},j)},g.anonymize=function(){r(!1)
},g.shutdown=function(){h("shutdown")},g.restart=function(){h("restart")},g.log=function(b,d){h("log",{level:b,msg:d})},g.consent=function(b){
h("setIdentity",{consent:!arguments.length||b})}}(),u="fetch",a="XMLHttpRequest",g._w={},g._w[a]=m[a],g._w[u]=m[u],m[u]&&(m[u]=function(){
return g._w[u].apply(this,arguments)}),g("init",{env:{orgId:o,host:e,script:t}}),g._v="2.1.0")
}(window,document,"fullstory.com","edge.fullstory.com/s/fs.js","FS","o-254FDS-na1");

/* --- Verde Talent tracking layer (added 2026-11-13) -------------------------
   1. First touch: the first time a browser lands here we remember how it came
      (utm_source, else the referring site's host, else "direct") and whether
      that was an AI assistant. Stored only in this browser (vt_first_touch).
   2. Identity: a signed-in employer or candidate is linked to their account ID
      (never their email) and account type, so sessions can be found by account.
   3. Events: every gtag('event', ...) on the site is mirrored to Fullstory with
      the first-touch fields attached. Pages call gtag only, never FS directly,
      so nothing is counted twice.
   Never sends anything a person typed. */
(function () {
  var AI_HOSTS = /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity\.ai|gemini\.google\.com|bard\.google\.com|claude\.ai|copilot\.microsoft\.com|copilot\.com|you\.com|meta\.ai|deepseek\.com|grok\.com|x\.ai)$/i;
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  // 1. First touch
  var ft = store.get('vt_first_touch');
  if (!ft || !ft.source) {
    var q = new URLSearchParams(location.search);
    var refHost = '';
    try { refHost = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; } catch (e) {}
    if (refHost === location.hostname.replace(/^www\./, '')) refHost = '';
    var src = (q.get('utm_source') || refHost || 'direct').toLowerCase().slice(0, 80);
    var engine = '';
    [src, refHost].forEach(function (h) { var m = h && h.match(AI_HOSTS); if (m && !engine) engine = m[2].toLowerCase(); });
    ft = {
      source: src,
      medium: (q.get('utm_medium') || (refHost ? 'referral' : (q.get('utm_source') ? '' : 'none'))).slice(0, 80),
      campaign: (q.get('utm_campaign') || '').slice(0, 80),
      referrer: refHost,
      landing: location.pathname.slice(0, 120),
      ai: !!engine,
      ai_engine: engine,
      date: new Date().toISOString().slice(0, 10)
    };
    store.set('vt_first_touch', ft);
  }
  window.vtFirstTouch = ft;
  var ftProps = {
    first_touch_source: ft.source, first_touch_medium: ft.medium, first_touch_campaign: ft.campaign,
    first_touch_landing: ft.landing, first_touch_ai: !!ft.ai, first_touch_ai_engine: ft.ai_engine || '',
    first_touch_date: ft.date
  };
  FS('setProperties', { type: 'user', properties: ftProps });

  // 2. Identity (employer wins if both sessions exist in one browser)
  var now = Date.now();
  var emp = store.get('vt_employer_session');
  var cand = store.get('vt_session');
  var who = (emp && emp.user_id && (!emp.expires_at || emp.expires_at > now)) ? { id: emp.user_id, type: 'employer' }
          : (cand && cand.user_id && (!cand.expires_at || cand.expires_at > now)) ? { id: cand.user_id, type: 'candidate' }
          : null;
  if (who) FS('setIdentity', { uid: who.id, properties: { account_type: who.type } });

  // 3. Mirror gtag events to Fullstory
  var origGtag = window.gtag;
  if (typeof origGtag === 'function' && !origGtag._vtMirrored) {
    var wrapped = function () {
      if (arguments[0] === 'event' && typeof arguments[1] === 'string') {
        var p = {}, src = arguments[2] || {};
        for (var k in src) {
          if (Object.prototype.hasOwnProperty.call(src, k) && typeof src[k] !== 'function' && k !== 'event_timeout') p[k] = src[k];
        }
        for (var f in ftProps) p[f] = ftProps[f];
        try { FS('trackEvent', { name: arguments[1], properties: p }); } catch (e) {}
      }
      return origGtag.apply(this, arguments);
    };
    wrapped._vtMirrored = true;
    window.gtag = wrapped;
  }
})();

/* --- 4. Signed-in nav (added 2026-11-20) ------------------------------------
   Every page's top bar is static HTML that always says "Sign in". When this
   browser holds a candidate or employer session, relabel it "My account", put
   Dashboard + Sign out in its menu for that account type, and drop the
   "Create profile" button for a signed-in candidate. Uses the same test as the
   job search's match labels (a stored session with an id), so the two agree. */
(function () {
  function get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function run() {
    var btn = document.getElementById('signinToggle');
    var menu = document.getElementById('signinMenu');
    if (!btn || !menu) return;
    var cand = get('vt_session'), emp = get('vt_employer_session');
    var isCand = !!(cand && cand.candidate_id), isEmp = !!(emp && emp.user_id);
    if (!isCand && !isEmp) return;
    var first = btn.firstChild;
    if (first && first.nodeType === 3) first.nodeValue = 'My account ';
    var html = '<div class="si-label grn">Candidates</div>' +
      (isCand ? '<a href="/dashboard.html">Dashboard</a><a href="#" data-vt-signout="vt_session">Sign out</a>'
              : '<a href="/login.html">Sign in</a>') +
      '<div class="si-label amb">Employers</div>' +
      (isEmp ? '<a href="/employer-dashboard.html">Dashboard</a><a href="#" data-vt-signout="vt_employer_session">Sign out</a>'
             : '<a href="/employer-login.html">Sign in</a>');
    menu.innerHTML = html;
    menu.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-vt-signout]');
      if (!a) return;
      e.preventDefault();
      try { localStorage.removeItem(a.getAttribute('data-vt-signout')); } catch (err) {}
      location.reload();
    });
    if (isCand) {
      var nav = btn.closest('.nav-right') || document;
      var cp = nav.querySelector('a[href="create-profile.html"], a[href="/create-profile.html"]');
      if (cp) cp.style.display = 'none';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();

/* --- 5. Nav fit (added 2026-11-20) -----------------------------------------
   Each page switches to the menu button below 940px, but between roughly 940
   and 1100px the links ran into the Saved / Sign in buttons (and at ~960px the
   page scrolled sideways). Measure instead of guessing a width: if the last
   link comes within 16px of the buttons, or the bar overflows, use the same
   menu-button layout the pages use on phones. Re-checked on resize. */
(function () {
  var CSS =
    '.nav-right{margin-left:16px;}' +
    'html.vt-nav-compact .nav-toggle{display:flex;}' +
    'html.vt-nav-compact .nav-groups{display:none;flex-direction:column;align-items:flex-start;gap:0;position:absolute;top:100%;left:0;right:0;background:var(--blk);border-bottom:0.5px solid var(--bdr);padding:1rem 1.5rem 1.25rem;z-index:50;margin:0;}' +
    'html.vt-nav-compact .nav-groups.open{display:flex;}' +
    'html.vt-nav-compact .nav-group{width:100%;padding-top:.85rem;margin-top:.85rem;border-top:0.5px solid var(--bdr2);}' +
    'html.vt-nav-compact .nav-group:first-child{padding-top:0;margin-top:0;border-top:none;}' +
    'html.vt-nav-compact .nav-group + .nav-group{margin-left:0;padding-left:0;border-left:none;}' +
    'html.vt-nav-compact .nav-links{flex-direction:column;align-items:flex-start;gap:.7rem;margin-top:.5rem;}';
  var root = document.documentElement;
  function check() {
    var nav = document.querySelector('.nav'), groups = document.querySelector('.nav-groups'), right = document.querySelector('.nav-right');
    if (!nav || !groups || !right) return;
    var wasOpen = groups.classList.contains('open');
    root.classList.remove('vt-nav-compact');
    var links = groups.querySelectorAll('.nav-links a');
    var last = links.length ? links[links.length - 1].getBoundingClientRect() : null;
    var tight = false;
    if (last && last.width) {
      tight = right.getBoundingClientRect().left - last.right < 16 || nav.scrollWidth > nav.clientWidth + 1;
    }
    if (tight) root.classList.add('vt-nav-compact');
    else if (wasOpen && getComputedStyle(groups).position !== 'absolute') groups.classList.remove('open');
  }
  function run() {
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    check();
    var t = null;
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(check, 80); });
    window.addEventListener('load', check);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(check);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
