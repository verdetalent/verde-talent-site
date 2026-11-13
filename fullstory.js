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
