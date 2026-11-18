// "Did you find a new job?" - the dialog behind every candidate-side proof prompt: the
// dashboard's "Any news?" card and "Found a job?" link, the prompt after a candidate marks
// themselves "Not currently looking" or changes employer, the "I found a job" choice when
// turning alerts off, and the check-in email's landing page (job-update.html).
//
// It asks two separate things, because both are useful on their own:
//   1. Did you find a new job? (yes / not yet) - every answer counts towards "x% of candidates
//      who told us found a job", wherever they found it.
//   2. Did you find it through Verde Talent? (yes / partly / no)
// then the role, an optional quote and how it may be shared. Sharing defaults to "first name
// only"; "without my name" and "don't share" are one click away. Nothing is published until the
// site owner approves it (candidate_job_reports.review_status).
//
// The page supplies submit(report) - the dashboard writes with the candidate's session, the
// landing page through the job-checkins function with the email's signed link.
// Pages call gtag only (never FullStory directly).
(function () {
  "use strict";
  if (window.VTOutcomes) return;
  var TRUSTPILOT_URL = "https://www.trustpilot.com/evaluate/verdetalent.com";

  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function track(name, params) {
    try { if (typeof gtag === "function") gtag("event", name, params || {}); } catch (e) {}
  }

  var CSS =
    ".vto-scrim{position:fixed;inset:0;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:16px;z-index:1000;}" +
    ".vto-box{background:var(--card,#131313);color:var(--t1,#fff);border:0.5px solid var(--bdr2,rgba(255,255,255,.14));border-radius:16px;max-width:460px;width:100%;max-height:calc(100vh - 32px);overflow-y:auto;padding:1.5rem;position:relative;box-shadow:0 24px 60px rgba(0,0,0,.5);font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);}" +
    ".vto-x{position:absolute;top:10px;right:12px;background:none;border:none;color:var(--t3,rgba(255,255,255,.35));font-size:18px;cursor:pointer;padding:4px 6px;}" +
    ".vto-box h2{font-size:18px;font-weight:700;margin:0 0 .4rem;padding-right:24px;letter-spacing:-.01em;}" +
    ".vto-box p{font-size:13.5px;color:var(--t2,rgba(255,255,255,.6));line-height:1.6;margin:0 0 1rem;}" +
    ".vto-q{font-size:13px;color:var(--t1,#fff);font-weight:600;margin:1rem 0 .5rem;}" +
    ".vto-pills{display:flex;flex-wrap:wrap;gap:8px;}" +
    ".vto-pill{background:var(--card2,#1A1A1A);color:var(--t1,#fff);border:0.5px solid var(--bdr2,rgba(255,255,255,.14));border-radius:999px;padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit;}" +
    ".vto-pill:hover{border-color:var(--grn,#22E09A);}" +
    ".vto-pill.on{background:rgba(34,224,154,.12);border-color:var(--grn,#22E09A);color:var(--grn,#22E09A);}" +
    ".vto-row{display:flex;gap:8px;}.vto-row>div{flex:1;min-width:0;}" +
    ".vto-box label.vto-l{display:block;font-size:11px;color:var(--t3,rgba(255,255,255,.35));margin:.75rem 0 4px;}" +
    ".vto-box input[type=text],.vto-box textarea{width:100%;box-sizing:border-box;background:var(--card2,#1A1A1A);color:var(--t1,#fff);border:0.5px solid var(--bdr2,rgba(255,255,255,.14));border-radius:9px;padding:9px 11px;font-size:13.5px;font-family:inherit;}" +
    ".vto-box textarea{min-height:76px;resize:vertical;}" +
    ".vto-share{display:flex;flex-direction:column;gap:6px;margin-top:.25rem;}" +
    ".vto-share label{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:var(--t2,rgba(255,255,255,.6));cursor:pointer;line-height:1.45;}" +
    ".vto-share input{margin-top:3px;accent-color:var(--grn,#22E09A);}" +
    ".vto-share b{color:var(--t1,#fff);font-weight:500;}" +
    ".vto-fine{font-size:11.5px;color:var(--t3,rgba(255,255,255,.35));line-height:1.5;margin-top:.75rem;}" +
    ".vto-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:1.25rem;align-items:center;}" +
    ".vto-primary{background:var(--grn,#22E09A);color:#052e1e;border:none;border-radius:10px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-block;}" +
    ".vto-primary[disabled]{opacity:.6;cursor:default;}" +
    ".vto-ghost{background:none;color:var(--t2,rgba(255,255,255,.6));border:0.5px solid var(--bdr2,rgba(255,255,255,.14));border-radius:10px;padding:10px 16px;font-size:13px;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-block;}" +
    ".vto-err{color:var(--cor,#FF7055);font-size:12.5px;margin-top:.5rem;min-height:1em;}" +
    ".vto-extra{margin-top:1rem;padding-top:1rem;border-top:0.5px solid var(--bdr,rgba(255,255,255,.08));}" +
    ".vto-extra:empty{display:none;}";

  function injectCss() {
    if (document.getElementById("vto-css")) return;
    var st = document.createElement("style");
    st.id = "vto-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // opts:
  //   submit(report)    required; returns a promise. report = {found_job, via_verde, job_title,
  //                     company, quote, share_consent, application_id, asked_from}
  //   askedFrom         'dashboard_card' | 'dashboard_link' | 'checkin_email' | 'status_change' | 'alerts_off'
  //   application       {id, job_title, company} when it's about one Apply click (skips question 1)
  //   firstName         for the "first name only" example
  //   title / lede      optional wording for question 1
  //   afterDone(report, el)  optional: add more to the final screen (e.g. update current employer)
  //   onClose(report|null)
  //   inline            an element to render into instead of a modal (landing page)
  function open(opts) {
    injectCss();
    var app = opts.application || null;
    var report = {
      found_job: null, via_verde: app ? "yes" : null,
      job_title: app ? app.job_title || "" : "", company: app ? app.company || "" : "",
      quote: "", share_consent: "first_name",
      application_id: app ? app.id : null, asked_from: opts.askedFrom,
    };
    if (opts.prefill) {
      if (opts.prefill.job_title) report.job_title = opts.prefill.job_title;
      if (opts.prefill.company) report.company = opts.prefill.company;
    }
    var sent = false;

    var scrim = null, box;
    if (opts.inline) {
      box = document.createElement("div");
      box.className = "vto-box";
      box.style.margin = "0 auto";
      opts.inline.innerHTML = "";
      opts.inline.appendChild(box);
    } else {
      scrim = document.createElement("div");
      scrim.className = "vto-scrim";
      scrim.setAttribute("role", "dialog");
      scrim.setAttribute("aria-modal", "true");
      box = document.createElement("div");
      box.className = "vto-box";
      scrim.appendChild(box);
      document.body.appendChild(scrim);
      scrim.addEventListener("click", function (e) { if (e.target === scrim) close(); });
      document.addEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    function close() {
      if (scrim) { scrim.remove(); document.removeEventListener("keydown", onKey); }
      if (opts.onClose) opts.onClose(sent ? report : null);
    }
    function closeBtn() { return scrim ? '<button type="button" class="vto-x" aria-label="Close">&#10005;</button>' : ""; }
    function wireClose() { var x = box.querySelector(".vto-x"); if (x) x.addEventListener("click", close); }

    async function send(btn, err) {
      if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
      try {
        await opts.submit(report);
        sent = true;
        track("job_report", { found_job: report.found_job, via_verde: report.via_verde || "", asked_from: report.asked_from });
        return true;
      } catch (e) {
        if (err) err.textContent = (e && e.message) || "Something went wrong - please try again.";
        if (btn) { btn.disabled = false; btn.textContent = "Send"; }
        return false;
      }
    }

    function stepFound() {
      box.innerHTML = closeBtn() +
        "<h2>" + esc(opts.title || "Did you find a new job?") + "</h2>" +
        "<p>" + esc(opts.lede || "Wherever you found it, we'd love to know. It takes a few seconds.") + "</p>" +
        '<div class="vto-pills"><button type="button" class="vto-pill" data-a="yes">' + esc(opts.yesLabel || "Yes, I did!") + '</button>' +
        '<button type="button" class="vto-pill" data-a="no">' + esc(opts.noLabel || "Not yet") + '</button></div>' +
        '<div class="vto-err"></div>';
      wireClose();
      var err = box.querySelector(".vto-err");
      box.querySelector('[data-a="yes"]').addEventListener("click", function () { report.found_job = true; stepDetails(); });
      box.querySelector('[data-a="no"]').addEventListener("click", async function () {
        report.found_job = false;
        // e.g. "No, just updating my profile" after an employer change - not an answer about job hunting.
        if (opts.noRecord) { close(); return; }
        if (await send(null, err)) stepThanks();
      });
    }

    function stepThanks() {
      box.innerHTML = closeBtn() + "<h2>Thanks for letting us know</h2>" +
        "<p>Your profile stays up, and new roles keep coming in. Good luck!</p>" +
        '<div class="vto-actions"><button type="button" class="vto-primary vto-done">Close</button></div>';
      wireClose();
      box.querySelector(".vto-done").addEventListener("click", close);
    }

    function stepDetails() {
      report.found_job = true;
      var first = (opts.firstName || "").trim();
      var example = first ? "“…” - " + first : "“…” - your first name";
      box.innerHTML = closeBtn() +
        "<h2>" + (app ? "Congratulations!" : "Congratulations on the new job!") + "</h2>" +
        (app ? "<p>You got the " + esc(app.job_title || "job") + (app.company ? " role at " + esc(app.company) : "") + ". That's great news.</p>" : "") +
        '<div class="vto-q">Did you find it through Verde Talent?</div>' +
        '<div class="vto-pills" role="radiogroup">' +
        '<button type="button" class="vto-pill" data-via="yes" role="radio">Yes</button>' +
        '<button type="button" class="vto-pill" data-via="partly" role="radio">Partly, Verde Talent helped</button>' +
        '<button type="button" class="vto-pill" data-via="no" role="radio">No, somewhere else</button></div>' +
        '<div class="vto-row"><div><label class="vto-l" for="vto-role">Role</label><input type="text" id="vto-role" maxlength="300" autocomplete="off"/></div>' +
        '<div><label class="vto-l" for="vto-co">Company</label><input type="text" id="vto-co" maxlength="200" autocomplete="organization"/></div></div>' +
        '<label class="vto-l" for="vto-quote">Anything you’d tell someone job hunting in clean energy? (optional)</label>' +
        '<textarea id="vto-quote" maxlength="600" placeholder="What helped, what surprised you, any advice…"></textarea>' +
        '<div class="vto-q" style="margin-top:.9rem;">Can we share your words?</div>' +
        '<div class="vto-share">' +
        '<label><input type="radio" name="vto-share" value="first_name" checked/><span><b>Yes, with my first name</b> <span style="white-space:nowrap;">(' + esc(example) + ")</span></span></label>" +
        '<label><input type="radio" name="vto-share" value="anonymous"/><span><b>Yes, without my name</b></span></label>' +
        '<label><input type="radio" name="vto-share" value="none"/><span><b>No, keep it private</b></span></label></div>' +
        '<div class="vto-fine">We only ever show a first name, never a last name. Employers never see your answers, and we read every story before anything appears on the site.</div>' +
        '<div class="vto-err"></div>' +
        '<div class="vto-actions"><button type="button" class="vto-primary vto-send">Send</button></div>';
      wireClose();
      var err = box.querySelector(".vto-err");
      var role = box.querySelector("#vto-role"), co = box.querySelector("#vto-co");
      role.value = report.job_title || "";
      co.value = report.company || "";
      function setVia(v) {
        report.via_verde = v;
        box.querySelectorAll("[data-via]").forEach(function (b) {
          var on = b.dataset.via === v;
          b.classList.toggle("on", on);
          b.setAttribute("aria-checked", on ? "true" : "false");
        });
      }
      setVia(report.via_verde);
      box.querySelectorAll("[data-via]").forEach(function (b) {
        b.addEventListener("click", function () { setVia(b.dataset.via); err.textContent = ""; });
      });
      box.querySelector(".vto-send").addEventListener("click", async function () {
        if (!report.via_verde) { err.textContent = "Did you find it through Verde Talent? Pick one above."; return; }
        report.job_title = role.value.trim().slice(0, 300);
        report.company = co.value.trim().slice(0, 200);
        report.quote = box.querySelector("#vto-quote").value.trim().slice(0, 600);
        var pick = box.querySelector('input[name="vto-share"]:checked');
        report.share_consent = pick ? pick.value : "first_name";
        if (await send(this, err)) stepDone();
      });
    }

    function stepDone() {
      var helped = report.via_verde === "yes" || report.via_verde === "partly";
      var first = (opts.firstName || "").trim();
      box.innerHTML = closeBtn() +
        "<h2>Congratulations" + (first ? ", " + esc(first) : "") + "!</h2>" +
        "<p>" + (helped ? "We're so glad Verde Talent played a part. " : "") + "Thanks for telling us - it helps other people looking for work in clean energy.</p>" +
        (helped ? "<p>Would you take a minute to say so on Trustpilot? It's the best way to help others find us.</p>" : "") +
        '<div class="vto-actions">' +
        (helped ? '<a class="vto-primary vto-tp" href="' + TRUSTPILOT_URL + '" target="_blank" rel="noopener">Review us on Trustpilot</a>' : "") +
        '<button type="button" class="' + (helped ? "vto-ghost" : "vto-primary") + ' vto-done">Close</button></div>' +
        '<div class="vto-extra"></div>';
      wireClose();
      var tp = box.querySelector(".vto-tp");
      if (tp) tp.addEventListener("click", function () { track("trustpilot_invite_click", { asked_from: report.asked_from }); });
      box.querySelector(".vto-done").addEventListener("click", close);
      if (opts.afterDone) opts.afterDone(report, box.querySelector(".vto-extra"));
    }

    if (app || opts.found) stepDetails();
    else stepFound();
    var first = box.querySelector("button, input");
    if (first && !opts.inline) try { first.focus(); } catch (e) {}
    return { close: close };
  }

  window.VTOutcomes = { open: open };
})();
