// Resume reader: turns a .pdf or .docx resume (or a LinkedIn "Save to PDF" export) into profile
// fields - name, headline, location, bio, experience, education, skills, sectors. Runs entirely in
// the browser; the file is never sent anywhere to be read.
//
// Used by create-profile.html (sign-up auto-fill) and dashboard.html (fill a profile from a newly
// uploaded resume). Needs mammoth (.docx) and pdf.js (.pdf) loaded first. A classic script on
// purpose: its functions and the two globals below are shared with the page's own scripts.
//
//   const text = await extractTextFromResumeFile(file);
//   let parsed = parseResumeText(text, lastResumeHints);
//   if (lastLinkedInParse) parsed = mergeLinkedInParse(parsed, lastLinkedInParse);
//
// Moved here unchanged from create-profile.html on 2026-11-18.

// --- Resume file selection + best-effort auto-fill of the fields below ---
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

function withTimeout(promise, ms, message) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
  return Promise.race([promise, timeout]);
}

// Layout facts from the last PDF read, for parseResumeText. Null for .docx.
let lastResumeHints = null;

// Text of the largest-font line in the top ~45% of the page.
function largestTopLine(items, pageHeight) {
  const top = items.filter(it => it.height && it.transform[5] > pageHeight * 0.55);
  if (!top.length) return null;
  const maxH = Math.max(...top.map(it => it.height));
  const big = top.filter(it => it.height >= maxH * 0.9);
  const topY = Math.max(...big.map(it => it.transform[5]));
  const row = big.filter(it => Math.abs(it.transform[5] - topY) <= 2).sort((a, b) => a.transform[4] - b.transform[4]);
  return row.map(it => it.str.trim()).join(' ').replace(/\s+/g, ' ').trim() || null;
}

async function extractTextFromPdf(arrayBuffer) {
  // Groups text items into lines by their Y position rather than joining
  // everything into one run-on paragraph, so section headers and entries
  // in the parsed resume still land on their own lines.
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pagesColumns = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    // Whitespace-only items are excluded, not just empty ones - pdf.js
    // emits some of them with an enormous advance width representing a
    // large skipped run (e.g. the wide gap in a "date ......... title"
    // header line), and that bounding box can span clean across a real
    // column gutter, masking it from detection below.
    const items = content.items.filter((it) => it.str && it.str.trim());
    if (i === 1) lastResumeHints = { name: largestTopLine(items, viewport.height) };
    pagesColumns.push(splitIntoColumns(items, viewport.width));
  }

  // A multi-page resume with a sidebar (contact info, skills, education)
  // typically has that sidebar end partway through the document while the
  // main job-history column keeps going onto later pages. Emitting page 1
  // in full before page 2 would splice a finished sidebar in between two
  // halves of the main column that are actually meant to read
  // consecutively. Emitting every page's Nth column together, in page
  // order, before moving to the (N+1)th column keeps that main thread
  // intact across page breaks. Single-column resumes (the common case)
  // only ever produce one column per page, so this reduces to the
  // original page-by-page order for them.
  const maxColumns = Math.max(0, ...pagesColumns.map((c) => c.length));
  const sections = [];
  for (let colIdx = 0; colIdx < maxColumns; colIdx++) {
    const lines = [];
    for (const columns of pagesColumns) {
      if (columns[colIdx]) lines.push(...itemsToLines(columns[colIdx]));
    }
    if (lines.length) sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

// Many resume templates use a 2-column layout (a sidebar of contact info,
// skills and education next to a main column of job history), and a PDF's
// content stream commonly interleaves the two - it emits items in whatever
// order the generator wrote them, not necessarily top-to-bottom-then-
// left-to-right. Reading the raw item order for a page like that produces
// text where a job history entry can end up sandwiched inside an unrelated
// sidebar section. Detecting a real vertical gutter (a band down the page
// no text ever crosses) and processing everything left of it, then
// everything right of it, restores natural reading order without needing
// to know anything about this specific template.
function splitIntoColumns(items, pageWidth) {
  if (items.length < 10 || !pageWidth) return [items];

  const STEP = 2;
  const searchStart = pageWidth * 0.25;
  const searchEnd = pageWidth * 0.75;
  const bins = [];
  for (let x = searchStart; x <= searchEnd; x += STEP) bins.push({ x, occupied: false });
  for (const item of items) {
    const x0 = item.transform[4];
    const x1 = x0 + (item.width || 0);
    for (const bin of bins) {
      if (bin.x >= x0 - STEP && bin.x <= x1 + STEP) bin.occupied = true;
    }
  }

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let idx = 0; idx < bins.length; idx++) {
    if (!bins[idx].occupied) {
      if (curStart === -1) curStart = idx;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  const gutterWidthPx = bestLen * STEP;
  if (bestStart === -1 || gutterWidthPx < pageWidth * 0.03) return [items];

  const gutterX0 = bins[bestStart].x;
  const gutterX1 = bins[bestStart + bestLen - 1].x;
  const left = items.filter((it) => it.transform[4] < gutterX0);
  const right = items.filter((it) => it.transform[4] >= gutterX1);
  // A real column gutter has substantial content on both sides. A thin
  // blank strip next to a headshot, or a gap under a single centered
  // line, produces a lopsided split that isn't actually two columns -
  // fall back to treating the page as one column rather than shredding it.
  if (left.length < 5 || right.length < 5) return [items];

  return [left, right];
}

// Converts one column's worth of text items into an array of lines. Items
// are explicitly re-sorted top-to-bottom then left-to-right first, since
// once a page has been split into columns, the items belonging to one
// column are no longer guaranteed to already be in that order in the
// original stream.
function itemsToLines(items) {
  const sorted = [...items].sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    if (Math.abs(dy) > 2) return dy;
    return a.transform[4] - b.transform[4];
  });

  const lines = [];
  let currentLine = '';
  let lastY = null;
  let lastEndX = null;
  let lastHeight = null;
  const pushLine = () => {
    const cleaned = currentLine.replace(/\s+/g, ' ').trim();
    if (cleaned) lines.push(collapseTrackedLine(cleaned));
  };
  for (const item of sorted) {
    const y = item.transform[5];
    const x = item.transform[4];
    if (lastY !== null && Math.abs(y - lastY) > 2) {
      pushLine();
      currentLine = '';
      lastEndX = null;
    }
    if (item.str && lastEndX !== null) {
      // A real word/section gap is comparable to (or wider than) the
      // text's own height; a gap near zero (or even slightly negative,
      // which normal kerning produces) means these items are part of
      // the same run of text and get concatenated with no space at all.
      // Some PDF generators (Chrome's Skia PDF export in particular,
      // common when a resume is built as a webpage and printed to PDF)
      // emit heavily letter-spaced/tracked text as many separate
      // single-character items with near-zero gaps between them -
      // always inserting a space there turns "PROFILE" into
      // "P R O F I L E", which fails every downstream regex.
      const gap = x - lastEndX;
      const threshold = Math.max(lastHeight || 0, item.height || 0) * 0.3;
      if (gap > threshold && !/^\s/.test(item.str) && !/\s$/.test(currentLine)) {
        currentLine += ' ';
      }
    }
    currentLine += item.str;
    lastEndX = x + (item.width || 0);
    lastHeight = item.height || lastHeight;
    lastY = y;
  }
  pushLine();
  return lines;
}

// Position-based spacing (above) still isn't enough for headers set in
// heavy letter-tracking (e.g. "E D U C A T I O N") - a designed template
// often makes the gap *within* a tracked word about as wide as the gap
// *between* words, so no gap threshold can tell them apart. Catches what
// that missed: a short line where most "words" came out as a single
// character is almost certainly one of these tracked labels, not a real
// sentence (a genuine sentence's word-length distribution never looks
// like this), so every space in it gets removed rather than just some.
function collapseTrackedLine(line) {
  if (line.length > 40) return line;
  const tokens = line.split(' ');
  if (tokens.length < 3) return line;
  const singleCharCount = tokens.filter(t => t.length === 1).length;
  if (singleCharCount / tokens.length >= 0.6) {
    return line.replace(/\s+/g, '');
  }
  return line;
}

// A block's text as lines: a soft line break (Shift+Enter) inside a Word
// paragraph is a line break, not nothing - textContent would glue
// "Jane Doe<br>Austin, TX" into "Jane DoeAustin, TX".
// A tab inside a line is kept (as one \t): Word resumes use tabs to push the dates or the city to the
// right margin ("Company<tab><tab>Chicago, IL"), and it's the only thing separating the two.
function textLinesOf(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  return clone.textContent.split('\n').map(tidyLine).filter(Boolean);
}
function tidyLine(t) {
  return t.replace(/[  ]*\t[\s]*/g, '\t').replace(/[^\S\t]+/g, ' ').trim();
}
// List items as bullets, one per line - a nested list's items are their own bullets, not glued onto
// the end of the parent ("...customer centric:Implemented Zoho + Salesforce CRM...").
function listLines(list, out) {
  for (const li of list.querySelectorAll(':scope > li')) {
    const own = li.cloneNode(true);
    own.querySelectorAll('ul, ol').forEach(n => n.remove());
    const text = own.textContent.replace(/\s+/g, ' ').trim();
    if (text) out.push('• ' + text);
    li.querySelectorAll(':scope > ul, :scope > ol').forEach(n => listLines(n, out));
  }
}

function htmlToStructuredText(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  const lines = [];
  for (const node of container.children) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      listLines(node, lines);
    } else if (tag === 'table') {
      // Header tables are a common Word template (name in one cell, contact
      // details in another); textContent runs the cells together
      // ("RiveraPhoenix, AZalex@..."), so each cell paragraph is its own line.
      for (const cell of node.querySelectorAll('td, th')) {
        const blocks = cell.children.length ? [...cell.children] : [cell];
        for (const block of blocks) lines.push(...textLinesOf(block));
      }
    } else {
      lines.push(...textLinesOf(node));
    }
  }
  return lines.join('\n');
}


// ---- LinkedIn "Save to PDF" export -----------------------------------------
// See the note in apply_linkedin_import.py: fixed fonts and a page-1-only
// sidebar, read directly instead of through the generic column splitter.
let lastLinkedInParse = null;
const LI_DATE_RE = /^((?:[A-Z][a-z]+\s+)?\d{4})\s*-\s*(Present|(?:[A-Z][a-z]+\s+)?\d{4})/;
const LI_DURATION_ONLY_RE = /^\(?\s*(?:\d+\s+years?)?\s*(?:\d+\s+months?)?\s*\)?$/i;

async function readLinkedInPdf(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const items = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    content.items.forEach((it) => {
      if (!it.str || !it.str.trim()) return;
      items.push({ page: i, x: it.transform[4], y: it.transform[5], fs: Math.hypot(it.transform[0], it.transform[1]), str: it.str });
    });
  }
  // Recognise the export: "Contact" sidebar heading on page 1, a big name to its right,
  // and the member's linkedin.com/in/ address.
  const p1 = items.filter((it) => it.page === 1);
  const contact = p1.find((it) => it.x < 200 && /^Contact$/.test(it.str.trim()) && it.fs >= 12);
  const nameItem = p1.filter((it) => it.x >= 200).sort((a, b) => b.fs - a.fs)[0];
  if (!contact || !nameItem || nameItem.fs < 18 || !items.some((it) => /linkedin\.com\/in\//i.test(it.str))) return null;

  // Group into lines per page + baseline, left to right.
  function toLines(list) {
    const map = new Map();
    list.forEach((it) => {
      const key = it.page + ':' + Math.round(it.y);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it);
    });
    return [...map.values()].map((row) => {
      row.sort((a, b) => a.x - b.x);
      return { page: row[0].page, y: row[0].y, fs: Math.max(...row.map((r) => r.fs)), text: row.map((r) => r.str.trim()).join(' ').replace(/\s+\(/g, ' (').trim() };
    }).sort((a, b) => a.page - b.page || b.y - a.y);
  }
  const main = toLines(items.filter((it) => it.x >= 200 && it.fs >= 9.5));
  const side = toLines(items.filter((it) => it.x < 200 && it.fs >= 9.5));
  const out = { experience: [], education: [], skills: [] };

  // Name, then headline lines, then location (the last ~12pt line before the first heading).
  const nameIdx = main.findIndex((l) => l.fs >= 18);
  const nameText = main[nameIdx].text.replace(/,.*$/, '').trim();
  const nameParts = nameText.split(/\s+/);
  out.firstName = nameParts[0];
  out.lastName = nameParts.slice(1).join(' ');
  const firstHeading = main.findIndex((l, i) => i > nameIdx && l.fs >= 14.5);
  const intro = main.slice(nameIdx + 1, firstHeading < 0 ? undefined : firstHeading).map((l) => l.text);
  if (intro.length >= 2) {
    out.location = intro[intro.length - 1];
    out.headline = intro.slice(0, -1).join(' ').replace(/\s+/g, ' ').slice(0, 200);
  } else if (intro.length === 1) {
    out.headline = intro[0];
  }

  // Sections of the main column.
  let section = null, company = '', title = '', titleFs = 0, summary = [], school = null;
  for (let i = (firstHeading < 0 ? main.length : firstHeading); i < main.length; i++) {
    const l = main[i];
    if (l.fs >= 14.5) { section = l.text.toLowerCase(); continue; }
    if (section === 'summary') { summary.push(l.text); continue; }
    if (section === 'experience') {
      const dm = l.text.match(LI_DATE_RE);
      if (dm && l.fs < 11.2) {
        if (title) out.experience.push({ title, co: company, dates: `${dm[1]} - ${dm[2]}` });
        title = '';
        continue;
      }
      if (l.fs >= 11.8) { company = l.text; title = ''; continue; }           // company (~12pt)
      if (l.fs >= 11.2) { title = l.text; titleFs = l.fs; continue; }          // job title (~11.5pt)
      continue;                                                                // location, description
    }
    if (section === 'education') {
      if (l.fs >= 11.8) { school = { degree: '', school: l.text, dates: '' }; out.education.push(school); continue; }
      if (school && !school.degree) {
        const m = l.text.match(/^(.*?)\s*·?\s*\((\d{4})\s*-\s*(\d{4}|Present)\)\s*$/);
        if (m) { school.degree = m[1].replace(/[·\s]+$/, '').trim(); school.dates = `${m[2]} - ${m[3]}`; }
        else school.degree = l.text.replace(/[·\s]+$/, '').trim();
      }
    }
  }
  out.education.forEach((e) => { if (!e.degree) e.degree = e.school; });
  if (summary.length) {
    let bio = summary.join(' ').replace(/\s+/g, ' ').trim();
    if (bio.length > 500) bio = bio.slice(0, 500).replace(/\s+\S*$/, '') + '…';
    out.bio = bio;
  }

  // Sidebar: Top Skills (LinkedIn exports up to three).
  let sideSection = null;
  side.forEach((l) => {
    if (l.fs >= 12.5) { sideSection = l.text.toLowerCase(); return; }
    if (sideSection === 'top skills' && l.text.length <= 60) out.skills.push(l.text);
  });

  // Plain text in reading order (main column, then sidebar) for everything the
  // generic parser still handles: email, LinkedIn URL, sectors, skill keywords.
  out.text = main.map((l) => l.text).join('\n') + '\n\n' + side.map((l) => l.text).join('\n');
  return out;
}

// The generic parse fills what it can from out.text; the LinkedIn reading wins
// wherever it found something, since it knows the layout.
function mergeLinkedInParse(parsed, li) {
  ['firstName', 'lastName', 'headline', 'location', 'bio'].forEach((k) => { if (li[k]) parsed[k] = li[k]; });
  if (li.experience.length) parsed.experience = li.experience;
  if (li.education.length) parsed.education = li.education;
  if (li.skills.length) parsed.skills = [...new Set([...li.skills, ...(parsed.skills || [])])].slice(0, 12);
  parsed.source = 'linkedin';
  return parsed;
}

async function extractTextFromResumeFile(file) {
  lastResumeHints = null;
  const ext = file.name.toLowerCase().split('.').pop();
  lastLinkedInParse = null;
  if (ext === 'pdf') {
    const buffer = await file.arrayBuffer();
    // pdf.js may detach the buffer it is given, so each reader gets its own copy.
    try {
      lastLinkedInParse = await withTimeout(readLinkedInPdf(buffer.slice(0)), 15000, 'timeout');
    } catch (e) {
      lastLinkedInParse = null;
    }
    if (lastLinkedInParse) {
      lastResumeHints = { name: [lastLinkedInParse.firstName, lastLinkedInParse.lastName].join(' ') };
      return lastLinkedInParse.text;
    }
    return await withTimeout(
      extractTextFromPdf(buffer.slice(0)),
      15000,
      'Reading that PDF took too long.'
    );
  }
  if (ext === 'docx') {
    const result = await withTimeout(
      mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }),
      15000,
      'Reading that .docx file took too long.'
    );
    return htmlToStructuredText(result.value);
  }
  throw new Error('Auto-fill only works with .pdf or .docx files — you can still fill in the fields below by hand.');
}

// Best-effort resume parser. Resume formats vary too much to parse
// reliably, so this only fills fields it's reasonably confident about,
// never overwrites anything the person already typed, and everything it
// fills stays fully editable — the submit note below still tells people
// to double-check before submitting.
const RESUME_SECTION_HEADERS = {
  summary: /^(professional\s+|career\s+|executive\s+|profile\s+)?summary$|^summary\s+of\s+qualifications$|^(qualifications|professional|career|executive)\s+(overview|profile|summary)$|^overview$|^(career\s+)?objective$|^about(\s+me)?$|^(professional\s+)?profile$/i,
  skills: /^(technical\s+|core\s+|key\s+)?skills?(\s*(&|and)\s*\w+)?$|^core\s+competenc(y|ies)$|^areas\s+of\s+expertise$|^technical\s+proficienc(y|ies)$|^tools(\s*(&|and)\s*technologies)?$/i,
  certs: /^(licen[cs]es?\s*(&|and)\s*)?certifications?(\s*(&|and)\s*(licen[cs]es?|training))?$|^licen[cs]es$/i,
  experience: /^(professional\s+|work\s+)?experience$|^employment(\s+history)?$/i,
  education: /^education(\s+&\s+\w+)?$/i,
};
// Designed resume templates often number or bullet their section headers
// ("01 Profile", "✦ Education") - stripped before matching against
// RESUME_SECTION_HEADERS above (which only recognizes the bare word) so
// those still register as real headers. Plain, unprefixed headers like
// "Education" are untouched since they have no leading \W/digit run to
// strip in the first place.
const SECTION_HEADER_PREFIX_RE = /^[\W\d]+\s*/u;
const DATE_RANGE_RE = /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{4})\s*(?:-|–|—|to)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{4}|present|current)/i;

function findResumeSections(lines) {
  const hits = [];
  lines.forEach((line, i) => {
    const clean = line.replace(/:$/, '').trim().replace(SECTION_HEADER_PREFIX_RE, '');
    if (!clean || clean.length > 40) return;
    for (const [type, re] of Object.entries(RESUME_SECTION_HEADERS)) {
      if (re.test(clean)) { hits.push({ type, start: i }); break; }
    }
  });
  hits.sort((a, b) => a.start - b.start);
  const sections = {};
  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : lines.length;
    sections[hit.type] = lines.slice(hit.start + 1, end);
  });
  return sections;
}

// Anchors each entry on a detected date range rather than blank lines -
// mammoth's HTML->text conversion collapses empty paragraphs, so a
// blank-line-based paragraph splitter would merge multiple resume entries
// (e.g. two past jobs) into one and silently drop everything after the
// first date range found.
// A line that reads like a full sentence (several words, ends in
// punctuation) is almost certainly a bullet point, not a title or company
// name - used below to stop a title/company block before it swallows the
// entry's actual bullets.
function looksLikeBulletLine(line) {
  if (!line) return true;
  // A line starting with a lowercase letter is almost always the tail end
  // of a sentence that wrapped across lines (e.g. a bullet's last line
  // after "...customer\nmanagement."), never a real title or company name
  // - those are proper nouns and always capitalized. This catches short
  // wrapped fragments a word-count check alone would miss.
  if (/^[a-z]/.test(line)) return true;
  if (/^[•·▪●◦*]\s/.test(line)) return true;
  return /[.!?]$/.test(line) && line.split(/\s+/).filter(Boolean).length > 4;
}

// Telling a job title from a company name, and a degree from a school, so each entry comes out
// the right way round whatever order the resume uses ("Company | Title", or the title on the line
// above "Company | Dates"). Positive = looks like the title/degree, negative = the company/school.
const ROLE_WORD_RE = /\b(engineer|engineering|technician|tech|manager|analyst|director|specialist|coordinator|intern|lead|supervisor|consultant|developer|associate|assistant|operator|electrician|installer|fore(?:man|woman|person)|superintendent|representative|officer|president|vp|head|administrator|planner|designer|scientist|architect|estimator|inspector|mechanic|apprentice|journeyman|lineman|lineworker|advisor|accountant|controller|recruiter|executive|owner|founder|clerk|agent|trainer|instructor|teacher|researcher|fellow|attorney|counsel|millwright|welder|carpenter|laborer|driver|scheduler|buyer|nurse|sergeant|captain|lieutenant)s?\b/i;
const ORG_WORD_RE = /\b(inc|llc|l\.l\.c|ltd|corp|corporation|co|company|group|services|solutions|partners|energy|power|renewables|electric|utilities|utility|systems|technologies|technology|holdings|industries|international|associates|construction|contractors|foundation|agency|department|army|navy|air force|marine corps|county)\b\.?/i;
const DEGREE_WORD_RE = /(^|[\s(])(b\.?s\.?c?|b\.?a\.?|m\.?s\.?c?|m\.?a\.?|mba|ph\.?d\.?|a\.?a\.?s\.?|a\.?s\.?|bachelor'?s?|master'?s?|associate'?s?|doctorate|diploma|degree|certificate|certification|ged)(?=$|[\s,.)])/i;
const SCHOOL_WORD_RE = /\b(university|college|institute|school|academy|polytechnic)\b/i;
function headScore(s, kind) {
  if (!s) return 0;
  return kind === 'experience'
    ? (ROLE_WORD_RE.test(s) ? 2 : 0) - (ORG_WORD_RE.test(s) ? 1 : 0)
    : (DEGREE_WORD_RE.test(s) ? 2 : 0) - (SCHOOL_WORD_RE.test(s) ? 2 : 0);
}
function isBulletOrHeading(line) {
  return !line || /^[•·▪●◦*–-]\s/.test(line) || looksLikeBulletLine(line) || line.length > 80
    || isSectionHeading(line) || DATE_RANGE_RE.test(line);
}
// [title, company] (or [degree, school]) from what was found on the entry's line, borrowing the
// missing half from a line just above or below when that line is clearly the other kind.
function orderEntryParts(parts, i, lines, kind) {
  let a = parts[0], b = parts[1] || '';
  if (b) {
    if (headScore(b, kind) > headScore(a, kind)) [a, b] = [b, a];
    return [a, b];
  }
  const sa = headScore(a, kind);
  for (const j of [i - 1, i + 1, i - 2, i + 2]) {
    const c = lines[j];
    if (j < 0 || j >= lines.length || isBulletOrHeading(c) || c === a) continue;
    const sc = headScore(c, kind);
    if (sc >= 2 && sc > sa) return [c, a];         // the neighbour is the title; ours is the company
    if (sa >= 2 && sc < 0) return [a, c];          // ours is the title; the neighbour is the company
  }
  return [a, b];
}

function parseEntriesFromLines(lines, kind) {
  const trimmed = lines.map(l => l.trim());
  const entries = [];
  const spans = [];   // which lines each entry's title/company/date used: [first, last]
  for (let i = 0; i < trimmed.length; i++) {
    const line = trimmed[i];
    if (!line) continue;
    const dateMatch = line.match(DATE_RANGE_RE);
    if (!dateMatch) continue;
    const withoutDate = line.replace(DATE_RANGE_RE, '').replace(/[|,–—-]\s*$/, '').trim();
    // A second date range right under an entry's own title-and-date line is the same job held
    // twice ("VP Sales  2017 - 2019 \n 2014 - 2016 \n Company") - not a new entry.
    if (withoutDate.length <= 3 && entries.length && spans[spans.length - 1][1] === i - 1
        && DATE_RANGE_RE.test(trimmed[i - 1]) && trimmed[i - 1].replace(DATE_RANGE_RE, '').trim().length > 3) {
      spans[spans.length - 1][1] = i;
      continue;
    }
    let headLine, first = i, last = i;
    if (withoutDate.length > 3) {
      headLine = withoutDate; // date shared the line with the title/company
    } else {
      // The date can sit on its own line either just above the title/
      // company (a "title | company \n date" layout) or just below it (a
      // "date \n title \n company" layout, common when the date is a
      // right-aligned badge next to a wrapped title). Try backward first
      // - if that line is itself a bullet from the *previous* entry
      // (which happens whenever this entry's own title/company turns out
      // to live below the date instead), fall back to looking forward.
      let back = i - 1;
      while (back >= 0 && !trimmed[back]) back--;
      const backLine = back >= 0 && !DATE_RANGE_RE.test(trimmed[back]) ? trimmed[back] : null;
      let fwd = i + 1;
      while (fwd < trimmed.length && !trimmed[fwd]) fwd++;
      const fwdLine = fwd < trimmed.length && !DATE_RANGE_RE.test(trimmed[fwd]) ? trimmed[fwd] : null;

      if (backLine && !looksLikeBulletLine(backLine)) {
        headLine = backLine; first = back;
      } else if (fwdLine && !looksLikeBulletLine(fwdLine)) {
        // Forward layouts commonly split title and company across two
        // lines rather than one ("Title \n Company"); grab the next line
        // too, when it also isn't a bullet, and treat it as the company.
        const secondLine = trimmed[fwd + 1] ? trimmed[fwd + 1].trim() : '';
        const two = secondLine && !looksLikeBulletLine(secondLine) && !DATE_RANGE_RE.test(secondLine);
        headLine = two ? `${fwdLine} | ${secondLine}` : fwdLine;
        last = two ? fwd + 1 : fwd;
      } else if (backLine) {
        headLine = backLine; first = back;
      } else if (fwdLine) {
        headLine = fwdLine; last = fwd;
      } else {
        continue;
      }
    }
    const parts = headLine.split(/\s+(?:at|@)\s+|\s*[|–—\t]\s*|,\s*/).filter(Boolean);
    if (!parts.length) continue;
    const dates = dateMatch[0].replace(/\s+/g, ' ');
    const [a, b] = orderEntryParts(parts, i, trimmed, kind);
    entries.push(kind === 'experience'
      ? { title: a, co: isPlaceOnly(b) ? '' : b, dates }
      : { degree: a, school: b, dates });
    spans.push([first, last]);
  }
  // What sits between one entry's heading and the next: the company line (when the heading didn't
  // have one), then a description and bullets.
  if (kind === 'experience') {
    entries.forEach((e, k) => {
      const end = k + 1 < spans.length ? spans[k + 1][0] : trimmed.length;
      let body = trimmed.slice(spans[k][1] + 1, end).filter(l => l && !isBareDateLine(l));
      if (!e.co && body.length && isCompanyLine(body[0])) {
        e.co = companyFromLine(body[0]);
        body = body.slice(1);
      }
      const bullets = bulletsFrom(body);
      if (bullets.length) e.bullets = bullets;
    });
  }
  return entries;
}

// "Chicago, IL", "IL", "Remote" on their own - a place, not a company.
function isPlaceOnly(s) {
  if (!s) return false;
  const t = s.trim();
  return /^(remote|hybrid|on-?site)$/i.test(t) || isStateExact(t)
    || (/^[A-Za-z .'-]+,\s*[A-Za-z]{2}$/.test(t) && isStateExact(t.split(',').pop()));
}
// Exactly a state ("IL", "Illinois") - not "Texas Instruments".
function isStateExact(s) {
  const t = s.trim();
  return (/^[A-Z]{2}$/.test(t) && US_STATE_ABBRS.has(t)) || !!US_STATES[t.toLowerCase()];
}
function isBareDateLine(l) {
  return DATE_RANGE_RE.test(l) && l.replace(DATE_RANGE_RE, '').replace(/[\s|,–—-]/g, '').length <= 3;
}
// A short, capitalised, non-sentence line straight under the title: "Monster Worldwide<tab>Chicago, IL".
function isCompanyLine(l) {
  if (l.length > 80 || /^[•·▪●◦*–-]\s/.test(l) || looksLikeBulletLine(l) || /:$/.test(l)) return false;
  if (l.split(/\s+/).length > 9) return false;
  // Ends in a place ("... Chicago, IL", "...<tab>Remote") - the company line, whatever its words.
  const tail = l.split(/\t|\s+[|•·]\s+/).pop().trim();
  const endsInPlace = (l !== tail && isPlaceOnly(tail)) || /,\s*([A-Z]{2})$/.test(l) && isStateExact(l.slice(-2));
  return endsInPlace || headScore(l, 'experience') <= 0 || ORG_WORD_RE.test(l);
}
// The company from that line, minus the place at the end: split on the tab or bar when there is one,
// else drop a trailing "City, ST" (one-word city - "Green Clean Chicago, IL" -> "Green Clean").
function companyFromLine(l) {
  const parts = l.split(/\s*[\t|•·]\s*|\s+[–—]\s+/).map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const kept = parts.filter(p => !isPlaceOnly(p));
    if (kept.length) return kept[0];
  }
  const m = l.match(/^(.*\S)\s+([A-Za-z.'-]+),\s*([A-Za-z]{2})$/);
  if (m && isStateExact(m[3].toUpperCase())) return m[1];
  const m2 = l.match(/^(.*\S)\s+([A-Z]{2})$/);
  if (m2 && isStateExact(m2[2]) && m2[1].length > 2) return m2[1].replace(/\s+(central|north|south|east|west|northern|southern|greater)$/i, '');
  return l;
}
// Bullets and description lines as a list: a bullet glyph starts a new item, a line that carries on a
// sentence (starts lowercase, or the last one didn't end) joins it; short sub-headings like
// "Key Contributions & Results:" are dropped. At most 8 per job, each at most 300 characters.
function bulletsFrom(body) {
  const items = [];
  body.forEach(l => {
    const glyph = /^[•·▪●◦*–-]\s*/.test(l);
    const text = l.replace(/^[•·▪●◦*–-]\s*/, '').replace(/\t+/g, ' ').trim();
    if (!text) return;
    const prev = items[items.length - 1];
    if (prev && !glyph && (/^[a-z(&]/.test(text) || !/[.!?:;)]$/.test(prev.t) && !prev.g && prev.t.length > 40)) {
      prev.t += ' ' + text;
      return;
    }
    items.push({ t: text, g: glyph });
  });
  return items.map(x => x.t)
    .filter(t => !(t.length <= 60 && /:$/.test(t)) && t.split(/\s+/).length >= 3)
    .map(t => t.length > 300 ? t.slice(0, 300).replace(/\s+\S*$/, '') + '…' : t)
    .slice(0, 8);
}

const SECTOR_KEYWORDS = {
  Solar: /\bsolar\b|\bpv\b|photovoltaic/i,
  Wind: /\bwind\b|turbine/i,
  Storage: /battery|energy storage|\bbess\b/i,
  Grid: /\bgrid\b|transmission|substation|interconnection/i,
  EV: /\bev\b|electric vehicle|charging infrastructure/i,
  Hydrogen: /hydrogen|\bfuel cell\b/i,
  Geothermal: /geotherm/i,
  Policy: /policy|regulatory|legislat/i,
  Sustainability: /sustainab|\besg\b/i,
};

// ---- Resume location + headline helpers ----------------------------------
const US_STATES = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA','colorado':'CO',
  'connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA','hawaii':'HI','idaho':'ID',
  'illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS','kentucky':'KY','louisiana':'LA',
  'maine':'ME','maryland':'MD','massachusetts':'MA','michigan':'MI','minnesota':'MN',
  'mississippi':'MS','missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
  'north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA',
  'rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN','texas':'TX',
  'utah':'UT','vermont':'VT','virginia':'VA','washington':'WA','west virginia':'WV',
  'wisconsin':'WI','wyoming':'WY','district of columbia':'DC',
};
const US_STATE_ABBRS = new Set(Object.values(US_STATES));
// Countries a resume header is likely to name. Not exhaustive on purpose: a
// country missing here just means that resume's location is left for the
// person to type, same as before - it never produces a wrong one.
const LOC_COUNTRIES = [
  'United States','USA','United Kingdom','UK','England','Scotland','Wales','Ireland','Canada',
  'South Africa','Nigeria','Kenya','Ghana','Zimbabwe','Botswana','Namibia','Zambia','Tanzania',
  'Uganda','Ethiopia','Rwanda','Mozambique','Egypt','Morocco','India','Pakistan','Bangladesh',
  'Philippines','Singapore','Malaysia','Indonesia','Thailand','Vietnam','Japan','China',
  'South Korea','Australia','New Zealand','Germany','France','Spain','Italy','Netherlands',
  'Portugal','Sweden','Norway','Denmark','Poland','Turkey','Israel','Jordan','Saudi Arabia',
  'United Arab Emirates','UAE','Mexico','Brazil','Chile','Colombia','Argentina','Peru',
];
// Words that look like a capitalized place name but aren't one - what precedes
// "ST" in "Systems Engineer, MS" or "Master of Science, MS".
const LOC_NOT_CITY_WORDS = new Set([
  'science','sciences','engineering','engineer','manager','management','technician','technology',
  'degree','bachelor','bachelors','master','masters','university','college','institute','school',
  'company','corporation','director','developer','analyst','specialist','coordinator','supervisor',
  'consultant','president','intern','lead','senior','junior','associate','certified','professional',
  'summary','experience','education','skills','email','phone','address','linkedin','mobile','tel',
  'contact','resume','curriculum','vitae','objective','profile',
  'dr','mr','mrs','ms','miss','prof','professor','sir','mx',
]);
const LOC_WORD_RE = /^[A-Z][A-Za-z.'’-]*$/;

function resolveUsState(part) {
  const cleaned = part.replace(/\s*\d.*$/, '').trim();
  if (!cleaned) return null;
  if (/^D\.?\s?C\.?$/i.test(cleaned)) return 'DC';
  // Longest state name first ("North Carolina" before "North"), tolerating
  // trailing text such as "TX USA" or "Illinois United States".
  const words = cleaned.split(/\s+/);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const candidate = words.slice(0, n).join(' ');
    if (n === 1 && /^[A-Z]{2}$/.test(candidate)) return US_STATE_ABBRS.has(candidate) ? candidate : null;
    const abbr = US_STATES[candidate.toLowerCase().replace(/\.$/, '')];
    if (abbr) return abbr;
  }
  return null;
}

function resolveCountry(part) {
  const lower = part.trim().toLowerCase().replace(/\.$/, '');
  if (!lower) return null;
  return LOC_COUNTRIES.find(c => c.toLowerCase() === lower) || null;
}

// City = the run of capitalized words (max 3: "Salt Lake City", "San Luis
// Obispo") immediately before a comma, minus any job-title/degree words that
// happen to sit in front of it on the same line.
function cityBeforeComma(left) {
  const words = left.trim().split(/[ \t]+/);
  const run = [];
  for (let i = words.length - 1; i >= 0 && run.length < 3; i--) {
    if (!LOC_WORD_RE.test(words[i])) break;
    run.unshift(words[i]);
  }
  let lastStop = -1;
  run.forEach((w, i) => { if (LOC_NOT_CITY_WORDS.has(w.toLowerCase().replace(/\.$/, ''))) lastStop = i; });
  const city = run.slice(lastStop + 1);
  return city.length ? city.join(' ') : null;
}

function matchLocationInSegment(segment, usOnly) {
  if (/@|https?:|linkedin\.com|github\.com/i.test(segment)) return null;

  // "City, ST" / "City, State" / "City, ST 60601" / "City, State, Country"
  let comma = -1;
  while ((comma = segment.indexOf(',', comma + 1)) !== -1) {
    const city = cityBeforeComma(segment.slice(0, comma));
    if (!city) continue;
    const parts = segment.slice(comma + 1).split(',').map(p => p.trim());
    const usState = resolveUsState(parts[0].split('|')[0]);
    if (usState && !(usOnly && CREDENTIAL_LOOKALIKE_ABBRS.has(usState))) return `${city}, ${usState}`;
    if (usOnly) continue;
    const country0 = resolveCountry(parts[0].replace(/\s*\d.*$/, ''));
    if (country0) return `${city}, ${country0}`;
    // "Toronto, ON, Canada" / "Johannesburg, Gauteng, South Africa"
    if (parts[1] && /^[A-Za-z. '’-]{2,25}$/.test(parts[0])) {
      const country1 = resolveCountry(parts[1].replace(/\s*\d.*$/, ''));
      if (country1) return `${city}, ${parts[0]}, ${country1}`;
    }
  }

  // No comma at all: "Brooklyn NY 11201" - only accepted with a ZIP, so a
  // stray pair of capital letters can't pass for a state.
  const noComma = segment.match(/((?:[A-Z][A-Za-z.'’-]*[ \t]+){1,3})([A-Z]{2})[ \t]+\d{5}(?:-\d{4})?\b/);
  if (noComma && US_STATE_ABBRS.has(noComma[2])) {
    const city = cityBeforeComma(noComma[1].trim());
    if (city) return `${city}, ${noComma[2]}`;
  }
  return null;
}

// Pieces of a contact line: "Austin, TX | jane@x.com | 512-555-0100", or the
// same joined with bullets, dashes or " - ".
const CONTACT_SEPARATOR_RE = /\s*[|•·●▪–—]\s*|\s+-\s+|\t| {3,}/;
// State abbreviations that are also credentials ("Dr. Sarah Smith, MD",
// "Jane Jones, MA") - ignored when searching below the header, where a
// reference's or colleague's name is far likelier than a home address.
const CREDENTIAL_LOOKALIKE_ABBRS = new Set(['MD', 'MA', 'MS', 'PA']);

function findLocationIn(lines, usOnly) {
  for (const line of lines) {
    for (const segment of line.split(CONTACT_SEPARATOR_RE)) {
      const hit = matchLocationInSegment(segment.trim(), usOnly);
      if (hit) return hit;
    }
  }
  return null;
}

// Where someone lives is in the header block (before the job history or
// school sections begin) or, on some templates, a contact footer. A city found
// anywhere else - inside Experience, Education, Projects - is a past employer,
// a school or a project site, and filling it in as home would be wrong, which
// is worse than leaving it blank for the person to type.
const BODY_SECTION_RE = /^((professional|work)\s+)?experience$|^employment(\s+history)?$|^work\s+history$|^education(\s+&\s+\w+)?$|^projects?$|^certifications?$/i;

// The header is searched first and for any country. The name line only
// contributes what follows its first separator ("Jane Doe | Austin, TX | ..."
// yes; "Jane Doe, MD" no - credentials read as a city and state). The last two
// lines count too, but only if they read as contact details (a place on its
// own, or a line with an email/phone/website), and only for US "City, ST".
function parseResumeLocation(nonEmpty, nameIdx, blocks) {
  const bodyStart = (lines, after) => lines.findIndex((l, i) => i > after
    && BODY_SECTION_RE.test(l.replace(/:$/, '').trim().replace(SECTION_HEADER_PREFIX_RE, '')));
  let end = bodyStart(nonEmpty, nameIdx);
  if (end === -1) end = nonEmpty.length;
  const headerLines = nonEmpty.slice(0, Math.min(end, 15)).map((line, i) =>
    i === nameIdx ? line.split(CONTACT_SEPARATOR_RE).slice(1).join(' | ') : line);
  const fromHeader = findLocationIn(headerLines, false);
  if (fromHeader) return fromHeader;

  // A multi-column PDF is read one column at a time, blank-line separated, so
  // a right-hand sidebar's contact block arrives after the whole main column.
  // The top of each later column, up to its first job/school section, counts
  // as header too.
  for (const block of (blocks || []).slice(1)) {
    const blockEnd = bodyStart(block, -1);
    const fromColumn = findLocationIn(block.slice(0, Math.min(blockEnd === -1 ? block.length : blockEnd, 10)), false);
    if (fromColumn) return fromColumn;
  }

  const footerLines = nonEmpty.slice(-2).filter(l => isLocationOnlyLine(l) || isContactLine(l));
  return findLocationIn(footerLines, true);
}

// "123 Main St, Austin, TX 78701" is a contact line, not a headline. Requires
// a street-type word so a headline that merely starts with a number ("10+ years
// in solar development") is left alone.
const STREET_ADDRESS_RE = /^\d+[\w\s.#-]*\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pkwy|parkway|hwy|highway|pl|place|suite|ste)\b/i;

// True for a line that is only a place ("Chicago, IL 60601", "Durban, South
// Africa") - those sit right under the name on many resumes and were being
// taken as the headline.
function isLocationOnlyLine(line) {
  const hit = findLocationIn([line], false);
  if (!hit) return false;
  const hitLower = hit.toLowerCase();
  const stateWords = new Set(Object.keys(US_STATES).join(' ').split(' '));
  const countryWords = new Set(LOC_COUNTRIES.join(' ').toLowerCase().split(' '));
  const leftover = line.replace(/\d{5}(-\d{4})?/g, '').split(/[\s,.]+/).filter(Boolean)
    .filter(w => { const lw = w.toLowerCase(); return !hitLower.includes(lw) && !stateWords.has(lw) && !countryWords.has(lw); });
  return leftover.length === 0;
}

// A line like "PROFESSIONAL SUMMARY" or "Contact" is a section heading, never
// a person's headline.
const HEADLINE_SKIP_RE = /^(contact(\s+(info|information|details))?|certifications?|licenses?(\s*&\s*certifications?)?|projects?|awards?|languages?|references|interests|key\s+skills|core\s+competencies|career\s+(summary|objective|profile|highlights)|work\s+history|qualifications|summary\s+of\s+(qualifications|skills|experience)|professional\s+(profile|objective|overview)|executive\s+summary|personal\s+(statement|profile|summary|details)|profile\s+summary|areas\s+of\s+expertise|highlights)$/i;
function isSectionHeading(line) {
  const clean = line.replace(/:$/, '').trim().replace(SECTION_HEADER_PREFIX_RE, '');
  return Object.values(RESUME_SECTION_HEADERS).some(re => re.test(clean)) || HEADLINE_SKIP_RE.test(clean);
}

// Phone numbers in any layout - "(512) 555-0100", "+27 82 555 0100",
// "555-123-4567" - and web addresses are contact lines, never a headline.
const PHONE_LIKE_RE = /\+?\(?\d[\d\s().-]{7,}\d/;
const WEBSITE_RE = /\bwww\.|https?:\/\/|\b[\w-]+\.(?:com|org|net|io|co|us|dev)\b/i;
function isContactLine(line) {
  return /@/.test(line) || PHONE_LIKE_RE.test(line) || WEBSITE_RE.test(line)
    || /linkedin\.com|github\.com/i.test(line) || STREET_ADDRESS_RE.test(line);
}

// Role and section words that mean a line is a job title or heading, not a
// person's name. Deliberately only words that are never surnames ("Power",
// "Field" are real surnames, so they are not here).
const NAME_NOT_NAME_WORDS = new Set([
  'resume','curriculum','vitae','cv','summary','experience','education','skills','profile',
  'objective','contact','engineer','engineers','engineering','manager','management','technician',
  'technologist','director','developer','analyst','specialist','coordinator','supervisor',
  'consultant','president','intern','lineman','installer','foreman','operator','estimator',
  'scheduler','designer','architect','officer','assistant','administrator','lead','solar','wind',
  'energy','storage','battery','renewable','electrical','mechanical','construction','maintenance',
  'operations','project',
]);
const NAME_PREFIX_LINE_RE = /^(resume|r[eé]sum[eé]|curriculum\s+vitae|cv|c\.v\.)$/i;
const NAME_HONORIFIC_RE = /^(dr|mr|mrs|ms|miss|mx|prof|eng|engr)\.?\s+/i;

// The words of a person's name from raw text: before any contact separator,
// before ", PE" / ", MBA, PMP" credentials, before an attached phone number or
// email, minus a "Dr." prefix. Letters in any script, so "José García" works.
function nameWordsFrom(raw) {
  let candidate = raw.split(CONTACT_SEPARATOR_RE)[0];
  candidate = candidate.split(',')[0];
  candidate = candidate.replace(/\s*\S*@.*$/, '');
  candidate = candidate.replace(/\s*[\d+(].*$/, '').trim();
  candidate = candidate.replace(NAME_HONORIFIC_RE, '').trim();
  if (!candidate || candidate.length >= 50) return null;
  if (!/^[\p{L}.'’-]+(\s+[\p{L}.'’-]+){1,3}$/u.test(candidate)) return null;
  return candidate.split(/\s+/);
}

const isNotNameWord = w => NAME_NOT_NAME_WORDS.has(w.toLowerCase().replace(/\.$/, ''));

// A title following the name on the same line, after a separator
// ("Jane Doe | Solar Engineer | Austin, TX") - the first piece that isn't
// contact info, a place, or a section heading.
function usableHeadline(p) {
  return p.length >= 4 && p.length < 90 && !isContactLine(p) && !isLocationOnlyLine(p) && !isSectionHeading(p);
}
function headlineFromLineTail(line) {
  for (const piece of line.split(CONTACT_SEPARATOR_RE).slice(1)) {
    const p = piece.trim();
    if (usableHeadline(p)) return p;
  }
  return null;
}

// The name is the first piece of the first real line (a leading "RESUME" /
// "CURRICULUM VITAE" line is skipped). If a job title follows on the same
// line ("Jane Doe Solar Engineer") the title is handed back as a headline hint.
function parseResumeName(nonEmpty) {
  let idx = 0;
  if (nonEmpty[0] && NAME_PREFIX_LINE_RE.test(nonEmpty[0].replace(/[:\s]+$/, ''))) idx = 1;
  const line = nonEmpty[idx];
  if (!line) return null;

  const words = nameWordsFrom(line);
  if (!words) return null;
  const firstBad = words.findIndex(isNotNameWord);
  if (firstBad === -1) {
    return { firstName: words[0], lastName: words.slice(1).join(' '), idx, headlineHint: headlineFromLineTail(line) };
  }
  if (firstBad < 2) return null;
  return {
    firstName: words[0],
    lastName: words.slice(1, firstBad).join(' '),
    idx,
    headlineHint: usableHeadline(words.slice(firstBad).join(' ')) ? words.slice(firstBad).join(' ') : null,
  };
}

// PDF-only cross-check. The name is almost always the largest text near the
// top of page 1 - which finds it in layouts where line order doesn't (a
// two-column resume reads the sidebar first, so the name is many lines
// down) and splits it from a title sharing its line ("PRIYA NAIR  GRID
// INTERCONNECTION ENGINEER"). Used only when the line-based guess found no
// name, or had to peel a title off the line itself.
function nameFromLargestText(nonEmpty, largestText) {
  if (!largestText) return null;
  const words = nameWordsFrom(largestText);
  if (!words || words.some(isNotNameWord)) return null;
  const hint = words.join(' ');
  const idx = nonEmpty.findIndex(l => l.includes(hint));
  if (idx === -1) return null;
  const rest = nonEmpty[idx].slice(nonEmpty[idx].indexOf(hint) + hint.length).replace(/^[\s,|•·–—-]+/, '');
  const headlineHint = usableHeadline(rest) ? rest : null;
  return { firstName: words[0], lastName: words.slice(1).join(' '), idx, headlineHint };
}

function parseResumeText(text, hints) {
  const lines = text.split('\n').map(l => l.trim());
  const nonEmpty = lines.filter(Boolean);
  const resumeBlocks = text.split(/\n\s*\n/)
    .map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(b => b.length);
  const parsed = {};

  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) parsed.email = emailMatch[0];

  const linkedinMatch = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+/i);
  if (linkedinMatch) parsed.linkedin = linkedinMatch[0].replace(/^https?:\/\//, '');

  const githubMatch = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+/i);
  if (githubMatch) parsed.github = githubMatch[0].replace(/^https?:\/\//, '');

  // Name: see parseResumeName / nameFromLargestText - tolerates credentials,
  // accents, a "Dr." prefix, contact info or a title sharing the line, and
  // (for PDFs) a name that isn't in the first lines.
  let nameInfo = parseResumeName(nonEmpty);
  if ((!nameInfo || nameInfo.headlineHint) && hints && hints.name) {
    nameInfo = nameFromLargestText(nonEmpty, hints.name) || nameInfo;
  }
  if (nameInfo) {
    parsed.firstName = nameInfo.firstName;
    parsed.lastName = nameInfo.lastName;
  }
  const nameIdx = nameInfo ? nameInfo.idx : -1;

  // Headline: a title sharing the name's line, else the first short line
  // after the name that isn't contact info, a section heading, or just a place.
  if (nameInfo && nameInfo.headlineHint) {
    parsed.headline = nameInfo.headlineHint;
  } else {
    for (let i = nameIdx + 1; i < Math.min(nonEmpty.length, nameIdx + 5); i++) {
      const l = nonEmpty[i];
      if (isSectionHeading(l)) break;
      if (isLocationOnlyLine(l) || isContactLine(l)) continue;
      if (l.length < 90 && l.length > 3) {
        parsed.headline = l;
        break;
      }
    }
  }

  // [ \t] rather than \s for the internal gaps - \s also matches newlines,
  // which let this match glue the last word of an unrelated previous line
  // onto a real "City, ST" that starts the next line (e.g. a job title
  // ending in "...Manager" immediately above a contact line beginning
  // "Austin, TX" was matching as one location, "Manager\nAustin, TX").
  const parsedLocation = parseResumeLocation(nonEmpty, nameIdx, resumeBlocks);
  if (parsedLocation) parsed.location = parsedLocation;

  const sections = findResumeSections(lines);

  // Skills, then certifications ("OSHA 30", "NABCEP PV Associate") - both end up in the skills list.
  const skillLines = [].concat(sections.skills || [], sections.certs || []).filter(Boolean);
  if (skillLines.length) {
    const skillsText = skillLines.map(l => l.replace(/^[•·▪●◦*–-]\s*/, '')).join(', ');
    const seen = new Set();
    parsed.skills = skillsText.split(/[,•|;\t]/).map(s => s.replace(/^[A-Za-z &]{2,30}:\s*/, '').trim())
      .filter(s => s && s.length < 40 && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())).slice(0, 25);
  }

  if (sections.summary) {
    // Short lines ("16 years of sales experience", "7 promotions") read as a list, so they're
    // joined with " · "; wrapped sentences are joined with a space.
    const sl = sections.summary.filter(Boolean).map(l => l.replace(/^[•·▪●◦*–-]\s*/, '').replace(/\t+/g, ' '));
    let summary = '';
    sl.forEach((l, k) => {
      const prev = sl[k - 1];
      const listy = prev && prev.length < 60 && !/[.!?:;,]$/.test(prev) && !/^[a-z]/.test(l);
      summary += !prev ? l : (listy ? ' · ' : ' ') + l;
    });
    summary = summary.trim();
    if (summary) parsed.bio = summary.length > 500 ? summary.slice(0, 498).replace(/\s+\S*$/, '') + '…' : summary;
  }

  if (sections.experience) {
    parsed.experience = parseEntriesFromLines(sections.experience, 'experience').slice(0, 6);
  }

  if (sections.education) {
    parsed.education = parseEntriesFromLines(sections.education, 'education').slice(0, 4);
  }

  const sectors = new Set();
  for (const [sector, re] of Object.entries(SECTOR_KEYWORDS)) {
    if (re.test(text)) sectors.add(sector);
  }
  if (sectors.size) parsed.sectors = sectors;

  return parsed;
}
