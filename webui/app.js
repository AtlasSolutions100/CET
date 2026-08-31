"use strict";
// If the page was opened as http://user:pass@host (how people reach a
// password-protected demo link), every relative URL inherits the
// credentials and fetch() refuses to construct such a Request. Chrome
// scrubs location.href but NOT document.baseURI, which is what relative
// URLs actually resolve against - so test baseURI, not location.
(() => {
  let dirty = false;
  try {
    const b = new URL(document.baseURI);
    dirty = !!(b.username || b.password);
  } catch (e) { /* opaque base */ }
  if (!dirty) return;
  const tag = document.createElement("base");
  tag.href = location.origin + "/";
  document.head.appendChild(tag);
  // A <base> tag alone is not enough: the credentials live in the document
  // base URL that fetch() resolves against, so absolutise root-relative
  // API paths explicitly. Everything in this app requests "/api/...".
  const raw = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string" && input.startsWith("/")) {
      input = location.origin + input;
    }
    return raw(input, init);
  };
})();
// resolve a same-origin path for src/href, immune to a credentialed base
const url = (p) => location.origin + p;
const $ = (id) => document.getElementById(id);
const IMG_DPI = 130; // must match /image endpoint default
const LF = String.fromCharCode(10);   // newline for title= tooltips

const state = window.state = {
  job: null, page: 0, kinds: [],
  triage: null,             // /triage reply: per-page excavation tiers
  img: null, result: null,
  include: new Map(), labels: new Map(), isolate: null, hot: null,
  inheritedInc: new Map(),  // style_id -> tick that came from ANOTHER sheet's
                            // hand decision (set-level inherit); drives the
                            // one-line disclosure in renderStyles()
  selected: null, excluded: new Set(),
  chainLabels: new Map(),   // chain_id -> label override (separate-from-group)
  nextChainId: 1,           // ids for chains created by edits
  clickPt: null,            // last click position on the selected chain (pt)
  tool: null,               // one of POINT_TOOLS below, or null
  measurePts: [],
  vScale: null,             // ft per paper inch for the VERTICAL axis on a
                            // profile sheet, when it differs from horizontal.
                            // null = one scale governs both, as on a plan.
  faithful: true,           // draw each line with its true pattern + weight
  gen: 0,                   // bumped per document/page switch; stale async
                            // callbacks compare against it and bail out
  selPt: null,              // index of the selected vertex on state.selected
  cutA: null,               // first anchor of an in-progress cut-span
  drawPts: [],              // vertices of the in-progress drawn line
  ewBoundDraft: [],         // vertices of an in-progress hand-drawn limit of work
  drawSrc: null,            // chain_id whose family a drawn line joins
  hoverPt: null,            // cursor position for the draw preview
  dragPt: false,
  multiSel: new Set(),      // marquee multi-select: chain_ids boxed by
                            // Shift+drag; bulk delete / bulk reclass act on it
  marquee: null,            // in-progress Shift+drag box {a:[x,y], b:[x,y]} pt
  legendNames: [],          // trade names read off a dedicated legend sheet
  ew: null,                 // earthwork panel state {rows, result}
  conf: null,               // /confidence payload for the current page:
                            // NOT-TO-SCALE + spot-elevation provenance, the
                            // two trust facts the detect result cannot carry
  confKey: null,            // "job:page" the payload above belongs to
  ckDone: null,             // Set of review-queue entry ids the operator has
                            // clicked through; null until the calcstate
                            // sidecar has answered so a saved check-off is
                            // never clobbered by an empty first save
  ckShowAll: false,         // "and N more" pressed: the cap is open
  ckCollapsed: false,       // queue body folded to its header (session-only)
  hotChain: null,           // chain highlighted from a calculator row
  extraItems: [],           // calculator outputs: {label, qty, unit}
  areaInc: new Map(),       // area group_id -> included in the takeoff
  areaLabels: new Map(),    // area group_id -> reviewer's label
  areaRows: [],             // {group_id, unit} - a region can feed SEVERAL
                            // priced rows (Estimate #853 bills the same
                            // 22,796 SF twice: to subgrade, then road base),
                            // so rows REFERENCE a group and the quantity is
                            // recomputed from it, never copied
  areaHot: null,            // group_id highlighted from a hovered row
  ai: null,                 // last page-analyst result
  aiWhy: new Map(),         // style_id -> {keep, why, label}
  measureMode: new Map(),   // style_id -> "object" (absent = line footage)
  autoAi: false,   // OPT-IN per session, never remembered: detect stays deterministic
  seedLabels: new Map(),    // style_id -> the default we seeded (AI may replace)
  aiAuto: false,            // this page's verdicts were auto-applied
  aiUndo: null,             // snapshot taken before applying AI focus
  workZones: [],            // WORK AREA quantity mask: [[x0,y0,x1,y1],...] in
                            // page pt. Chains COUNT only by their length
                            // inside the union; detection itself is untouched
  wzDrag: null,             // in-progress work-area drag {a:[x,y], b:[x,y]}
  wzRev: 0,                 // bumped on any zone or geometry change so the
                            // per-chain inside-fraction memo invalidates
  gzones: [],               // GRADING ZONES: declared-design regions
                            // [{id, name, polygon, design, strip_in, added,
                            //   showNums, labels, result, img, err}].
                            // result/img are recomputed via the zone
                            // endpoint, never restored from storage.
  gzDraft: [],              // corners of an in-progress hand-drawn zone
  gzHover: null,            // cursor position for the zone draft preview
  gzDrag: null,             // in-progress zone box drag {a:[x,y], b:[x,y]}
  gzSeq: 1,                 // next default zone number ("Zone 3")
  view: { x: 0, y: 0, k: 1 },
};

// CURSOR. `grab` - the open hand - is a promise that dragging is what happens
// next. It is the wrong promise the moment a tool is armed, because the next
// click places a point. First piece of client feedback we got, on the measure
// tool; every tool in this set has the same problem, so they all get it.
const POINT_TOOLS = new Set([
  "measure", "extend", "cutspan", "drawline", "merge", "reclass",
  "ew-bound", "ew-bound-draw", "ew-pick", "st-pick", "st-draw", "wz-draw",
  "gz-draw", "gz-box",
]);

function syncCursor() {
  const cv = document.getElementById("view");
  if (cv) cv.classList.toggle("tool-point", POINT_TOOLS.has(state.tool));
  // The work-area button's lit state rides the same chokepoint as the
  // cursor: ~20 places assign state.tool, and any of them can take the
  // tool away (arming measure, a page switch). Hooked here so the button
  // can never stay lit for a tool that is no longer armed.
  const wb = document.getElementById("wzBtn");
  if (wb) wb.classList.toggle("active", state.tool === "wz-draw");
}

// Hooked to ASSIGNMENT, not to each of the ~20 places that arm or clear a
// tool - including `state.tool = mode`, where the value is not even a literal.
// This is the lesson from the loading overlay: a thing you must remember to
// call at every site is a thing that gets forgotten at the next one.
(() => {
  let current = state.tool;
  Object.defineProperty(state, "tool", {
    get: () => current,
    // enumerable so the property still behaves like the plain field it
    // replaced, for anything that iterates or copies state
    enumerable: true,
    configurable: true,
    set: (v) => { current = v; syncCursor(); },
  });
})();

// ---------- boot ----------
fetch("/api/samples").then(r => r.json()).then(samples => {
  for (const s of samples) {
    const o = document.createElement("option");
    o.value = s.path; o.textContent = `${s.name} (${s.mb} MB)`;
    $("sampleSel").appendChild(o);
  }
});
$("sampleSel").onchange = () => { if ($("sampleSel").value) openPath($("sampleSel").value); };
$("openBtn").onclick = () => { if ($("pathInput").value.trim()) openPath($("pathInput").value.trim()); };

// ---------- getting a plan set in --------------------------------------
// Two ways: the button, and dropping a file anywhere on the window. On a
// hosted box (TAKEOFF_HOSTED=1) filesystem paths are refused on purpose, so
// this is the ONLY way in - which is why the drop target is the whole window
// and not a small rectangle someone has to find.
let UPLOADING = false;

function uploadProgress(name, pct) {
  const bar = $("upBar");
  if (pct === null) { bar.hidden = true; return; }
  bar.hidden = false;
  $("upName").textContent = name;
  $("upFill").style.width = pct + "%";
  $("upPct").textContent = pct + "%";
}

function uploadPdf(file) {
  if (UPLOADING) { setStatus("already uploading \u2014 one at a time", "err"); return; }
  if (!file) return;
  const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  if (!isPdf) {
    setStatus(`${file.name} is not a PDF \u2014 plans have to be a PDF`, "err");
    return;
  }
  UPLOADING = true;
  uploadProgress(file.name, 0);
  const mb = (file.size / 1e6).toFixed(1);
  setStatus(`uploading ${file.name} (${mb} MB)\u2026`, "busy");

  // XHR, not fetch: fetch gives no upload progress, and a 40 MB plan set over
  // a hotel wifi with a silent UI is indistinguishable from a hang - which is
  // exactly the failure this app has already had once.
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable)
      uploadProgress(file.name, Math.round(e.loaded / e.total * 100));
  };
  xhr.onload = () => {
    UPLOADING = false;
    uploadProgress(null, null);
    if (xhr.status < 200 || xhr.status >= 300) {
      let why = `upload failed (${xhr.status})`;
      // These two come from the reverse proxy, not the app, so there is no
      // JSON detail to read and the operator would see a bare number. The
      // 413 is OUR OWN 512 MB cap in the Caddyfile - measured, not a default:
      // Caddy ships with no body limit at all.
      if (xhr.status === 413)
        why = "that plan set is too large — the limit is 512 MB per upload";
      else if (xhr.status === 401)
        why = "signed out — reload the page and enter the password again";
      try {
        const e = JSON.parse(xhr.responseText);
        if (e && e.detail) why = "upload failed: " + String(e.detail);
      } catch (err) { /* not JSON */ }
      return setStatus(why, "err");
    }
    let j = null;
    try { j = JSON.parse(xhr.responseText); } catch (e) { /* below */ }
    if (!j || !j.job_id) return setStatus("upload failed: unreadable reply", "err");
    applyOpened(j);
  };
  xhr.onerror = () => {
    UPLOADING = false; uploadProgress(null, null);
    setStatus("upload failed \u2014 the connection dropped", "err");
  };
  xhr.onabort = () => {
    UPLOADING = false; uploadProgress(null, null);
    setStatus("upload cancelled");
  };
  const fd = new FormData();
  fd.append("file", file, file.name);
  xhr.send(fd);
}

// Plan sets already on this box. On a hosted box paths are refused and the
// sample list is empty, so without this the only way back to a document is to
// re-upload it - a 40 MB transfer, and on a large set a detection the server
// has already done. Keyed by job id; no path ever reaches the client.
async function loadRecent() {
  const sel = $("recentSel");
  if (!sel) return;
  let rows = [];
  try {
    const r = await fetch("/api/recent");
    if (r.ok) rows = await r.json();
  } catch (e) { return; }
  sel.innerHTML = "";
  const head = document.createElement("option");
  head.value = "";
  head.textContent = rows.length ? "Recent plans\u2026" : "No plans on this server yet";
  sel.appendChild(head);

  // Remember, per job, whether the SERVER said it may be deleted. The button
  // below only reads this to decide what to show; the service decides again
  // when asked, because a disabled button is decoration, not a permission.
  RECENT_META = {};
  const opt = (d) => {
    const o = document.createElement("option");
    o.value = d.job_id;
    // say how much is already detected: it is the difference between opening
    // instantly and waiting out a cold run in front of a client
    const state = d.detected >= d.pages && d.pages
      ? "ready" : d.detected ? `${d.detected}/${d.pages} detected` : "not detected";
    o.textContent = `${d.name} \u00b7 ${d.pages}p \u00b7 ${state}`;
    RECENT_META[d.job_id] = d;
    return o;
  };

  // Only group once there is something to separate. In single-password mode
  // every row is "shared" and two headings over one list is just noise.
  const mine = rows.filter(d => d.mine);
  const shared = rows.filter(d => !d.mine);
  if (mine.length && shared.length) {
    const g1 = document.createElement("optgroup");
    g1.label = "My plans";
    for (const d of mine) g1.appendChild(opt(d));
    sel.appendChild(g1);
    const g2 = document.createElement("optgroup");
    g2.label = "Shared demo plans";
    for (const d of shared) g2.appendChild(opt(d));
    sel.appendChild(g2);
  } else {
    for (const d of rows) sel.appendChild(opt(d));
  }
  sel.hidden = false;
  syncRemoveBtn();
}

// job_id -> the row /api/recent returned for it
let RECENT_META = {};

// The remove button is only offered for a document the server called
// deletable, and only while that document is the one on screen.
function syncRemoveBtn() {
  const b = $("docRemoveBtn");
  if (!b) return;
  const meta = state.job ? RECENT_META[state.job] : null;
  const can = !!(meta && meta.deletable);
  b.hidden = !can;
  if (can) b.title = "Remove \"" + meta.name + "\" from this server "
    + "\u2014 the uploaded PDF and everything detected from it";
}
$("docRemoveBtn").onclick = async () => {
  const meta = state.job ? RECENT_META[state.job] : null;
  if (!meta) return;
  // Name what goes and what it costs. This is the one control that destroys
  // a client's uploaded document, so the wording says "permanently" and says
  // the PDF itself goes too - which is exactly how it differs from Reset.
  if (!confirm("Remove \"" + meta.name + "\" from this server?\n\n"
    + "This permanently deletes the uploaded PDF and everything detected from "
    + "it \u2014 " + meta.detected + " of " + meta.pages + " page(s) already "
    + "detected, plus any approved exports and report for it.\n\n"
    + "Use this when a client's plans should not outlive the meeting. To "
    + "re-run a demo from scratch while KEEPING the PDF, use \"Reset this "
    + "document\" instead.\n\nThis cannot be undone.")) return;
  setStatus("removing\u2026", "busy");
  try {
    const r = await fetch("/api/job/" + state.job, { method: "DELETE" });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      return setStatus(e.detail || ("could not remove it (" + r.status + ")"), "err");
    }
    const j = await r.json();
    setStatus("removed " + j.name);
    location.reload();
  } catch (e) {
    setStatus("could not remove it \u2014 the server did not answer", "err");
  }
};

$("recentSel").onchange = async () => {
  const id = $("recentSel").value;
  if (!id) return;
  setStatus("opening…", "busy");
  try {
    const r = await fetch(`/api/job/${id}/open`);
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      return setStatus(e.detail || `could not reopen (${r.status})`, "err");
    }
    applyOpened(await r.json());
  } catch (e) {
    setStatus("could not reopen — the server did not answer", "err");
  }
};
loadRecent();

$("uploadBtn").onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  // reset so choosing the SAME file twice still fires a change
  e.target.value = "";
  uploadPdf(f);
};

// Drag and drop over the whole window. dragenter/dragleave fire for every
// child element the pointer crosses, so count them rather than toggling on
// each one - otherwise the overlay flickers off the moment the cursor moves
// over the canvas.
let DRAG_DEPTH = 0;
function dragHasFile(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types) for (const t of dt.types) if (t === "Files") return true;
  return false;
}
addEventListener("dragenter", (e) => {
  if (!dragHasFile(e)) return;
  e.preventDefault();
  DRAG_DEPTH += 1;
  $("dropZone").hidden = false;
});
addEventListener("dragover", (e) => { if (dragHasFile(e)) e.preventDefault(); });
addEventListener("dragleave", (e) => {
  if (!dragHasFile(e)) return;
  DRAG_DEPTH = Math.max(0, DRAG_DEPTH - 1);
  if (!DRAG_DEPTH) $("dropZone").hidden = true;
});
addEventListener("drop", (e) => {
  if (!dragHasFile(e)) return;
  e.preventDefault();
  DRAG_DEPTH = 0;
  $("dropZone").hidden = true;
  const files = [...(e.dataTransfer.files || [])];
  if (!files.length) return;
  if (files.length > 1)
    setStatus(`${files.length} files dropped \u2014 opening the first, `
      + `${files[0].name}`, "busy");
  uploadPdf(files[0]);
});

// What kind of box is this? A hosted one refuses filesystem paths, so the
// path box is a dead control there and is removed rather than left to fail.
fetch("/api/config").then(r => r.ok ? r.json() : null).then(cfg => {
  if (!cfg || !cfg.hosted) return;
  for (const id of ["pathInput", "openBtn", "sampleSel"]) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  $("uploadBtn").textContent = "Upload plans";
  $("uploadBtn").title = "Choose a PDF, or drag one anywhere onto this window.";
}).catch(() => { /* a local box with no /api/config: leave the UI alone */ });

async function openPath(path) {
  setStatus("opening…", "busy");
  const r = await fetch("/api/open-path", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  if (!r.ok) {
    // 403 is the hosted box refusing a filesystem path on purpose - say what
    // to do instead rather than leaving a bare status code on screen.
    if (r.status === 403)
      return setStatus("this server does not open files by path — use Upload plans", "err");
    return setStatus(`could not open (${r.status})`, "err");
  }
  const j = await r.json();
  applyOpened(j);
}

// Everything that happens once a document exists, whichever way it arrived:
// opened by path on a local box, or uploaded on the hosted one. Extracted so
// the two entry points cannot drift - the upload path used to be unreachable
// from the UI at all, which on a hosted server meant there was no way in.
function applyOpened(j) {
  // the landing page yields to a document, whichever way it arrived: card
  // click, recents pick, sample, path, upload, or a drop on the window
  showProjects(false);
  // ...and so does the pricing settings page (the header's upload/drop
  // controls stay reachable while it is up)
  if (svIsOpen()) showSettings(false);
  // the remove button belongs to whatever is on screen now
  setTimeout(syncRemoveBtn, 0);
  state.gen++;
  // a newly uploaded set should appear in the picker without a reload
  setTimeout(loadRecent, 300);
  state.job = j.job_id; state.result = null;
  state.triage = null;      // the old document's tiers must not paint this one
  // The server no longer blocks the open on classifying every page (it read
  // every drawing on every page: 16s for a 20-page set, 38s for a 15-page
  // one, with nothing on screen saying the app had not hung). The page list
  // is built immediately and the kind labels arrive on their own.
  state.kinds = j.kinds || new Array(j.pages).fill(null);
  state.legendNames = []; $("legendVocab").innerHTML = "";
  $("docName").textContent = j.name;
  state.docName = j.name;
  const sel = $("pageSel");
  sel.innerHTML = "";
  state.kinds.forEach((k, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = `page ${i + 1}` + (k ? ` — ${k}` : "");
    sel.appendChild(o);
  });
  sel.hidden = false; $("detectBtn").hidden = false;
  state.pageStatus = [];
  state.detectAll = null;
  $("detectAllBtn").textContent = "Detect all";
  renderPageStrip();
  refreshPageStatuses();
  loadTriage(state.job);
  selectPage(0);
  setStatus(`${j.pages} pages`);
  if (!j.kinds) pollKinds(state.job, state.gen);
}

// The per-page vector/hybrid/raster labels, once the server's background
// pass has them. Opening no longer waits for it, so the page list is usable
// immediately and this fills the labels in behind the operator. Guarded on
// state.gen: a document opened while this is in flight must not have the
// previous document's kinds written over its page list.
async function pollKinds(job, gen) {
  for (let i = 0; i < 400; i++) {
    if (state.gen !== gen || state.job !== job) return;   // moved on
    let k = null;
    try {
      const r = await fetch(`/api/job/${job}/kinds`);
      if (r.ok) k = await r.json();
    } catch (e) { return; }
    if (!k) return;
    if (state.gen !== gen || state.job !== job) return;
    if (k.done && Array.isArray(k.kinds)) {
      state.kinds = k.kinds;
      const sel = $("pageSel");
      state.kinds.forEach((kind, i) => {
        if (sel.options[i])
          sel.options[i].textContent = `page ${i + 1}`
            + (kind && kind !== "unknown" ? ` — ${kind}` : "");
      });
      renderPageStrip();
      renderSheetHead();
      if (/reading page kinds/.test($("status").textContent))
        setStatus(`${state.kinds.length} pages`);
      return;
    }
    // Only speak up once it is slow enough to look broken. On a small set
    // this never fires and the operator sees nothing at all.
    if (i >= 2 && !state.result)
      setStatus(`reading page kinds ${k.progress}/${k.pages || "?"} — the sheets are usable now`, "busy");
    await new Promise(r => setTimeout(r, 600));
  }
}
$("pageSel").onchange = () => selectPage(+$("pageSel").value);

async function selectPage(p) {
  // Everything below is async. Without a generation token a slow image or
  // result from the PREVIOUS document lands after the switch and paints
  // itself over the current one - which is how a Belle Farms sheet ended up
  // under another plan with the old itemised takeoff still listed.
  const gen = ++state.gen;
  state.page = p; state.result = null; state.isolate = null;
  state.img = null;
  state.selected = null; state.selPt = null;
  // chains are per page: an undo stack that outlived the sheet would
  // "restore" chains onto a page they never belonged to. Same rule as the
  // work area below - page switch is the reliable chokepoint.
  state.multiSel = new Set(); state.marquee = null;
  undoClear(undoStack);
  // The WORK AREA belongs to ONE sheet. loadResult also clears it, but
  // loadResult only runs when the new page HAS a loadable result - an
  // undetected page skipped it and kept the PREVIOUS sheet's boxes armed
  // (caught live on Kayden 38->39: detect would then have silently masked
  // the wrong sheet). Page switch is the reliable chokepoint; the new
  // page's own saved boxes come back via wzApplySaved in calcStateLoad.
  state.workZones = []; state.wzDrag = null; state.wzRev++;
  state.ewBoundDraft = []; state.ewBoundHover = null;
  // grading zones belong to ONE sheet, drafts included; this page's own
  // saved zones come back via gzApplySaved in calcStateLoad
  gzPageReset();
  state.ai = null; state.aiWhy = new Map(); state.aiUndo = null; state.measureMode = new Map(); state.aiAuto = false; state.seedLabels = new Map(); state.elevMap = undefined; state.aiHidden = false; $("aiBtn").textContent = "Analyze";
  $("aiBanner").hidden = true;
  state.conf = null; state.confKey = null; state.confErr = false;
  // check-offs are per page and per detection; loadResult reseeds them, but
  // a page with no result yet must not inherit the previous page's set
  state.ckDone = null; state.ckShowAll = false; state.ckCollapsed = false;
  updateSelBar(null);
  // scaleMemApply BEFORE renderSheetHead, always - see loadResult().
  scaleMemApply();
  scopeApply();
  renderSheetHead();
  renderScopeBar();
  renderStyles(); renderChips(); renderLegend(); renderAreas(); renderItemized(); renderMiniLegend(); renderMultiBar(); fitOnLoad();
  const img = new Image();
  img.onload = () => {
    if (gen !== state.gen) return;   // a later page won the race
    state.img = img; fitView(); draw();
  };
  img.src = url(`/api/job/${state.job}/page/${p}/image?dpi=${IMG_DPI}`);
  markCurrentThumb();
  // reuse a finished result if the server has one - unless the engine has
  // changed since it was produced, in which case the server reports it as
  // idle+stale and we make the reviewer re-detect rather than showing a
  // number the current engine would not produce
  const st = await (await fetch(`/api/job/${state.job}/page/${p}/status`)).json();
  if (gen !== state.gen) return;
  if (st.status === "done") loadResult(gen);
  else if (st.stale) setStatus("this sheet was detected with an older engine — press Detect to refresh it", "busy");
}

$("detectBtn").onclick = async () => {
  await fetch(`/api/job/${state.job}/page/${state.page}/detect`, { method: "POST" });
  setStatus("detecting…", "busy");
  setPageStatus(state.page, "running");
  poll(state.gen);
};
async function poll(gen = state.gen) {
  if (gen !== state.gen) return;   // document/page changed under us
  const j = await (await fetch(`/api/job/${state.job}/page/${state.page}/status`)).json();
  if (gen !== state.gen) return;
  if (j.status === "running") return setTimeout(() => poll(gen), 900);
  if (j.status && j.status.startsWith("error")) {
    setPageStatus(state.page, "error");
    return setStatus(j.status, "err");
  }
  if (j.status === "done") { setStatus("done"); setPageStatus(state.page, "done"); loadResult(gen); return; }
  // "idle" while we are polling = the worker exited without writing a
  // result OR an error. The old code fell through here silently: no timer,
  // no message, "detecting…" frozen on screen until a reload (measured on
  // ellis p42 when a memory-starved child died during numpy import). The
  // server now reports most of these as errors (fresh-result check in
  // _sched_finish_locked); this is the belt for a race or an old server.
  setPageStatus(state.page, "idle");
  setStatus("the detection worker exited without a result — press Detect to retry", "err");
}

// ---------- page thumbnail strip: the whole-PDF page-by-page flow --------
// Thumbnails reuse the existing /image endpoint at a low dpi; the server
// caches one PNG per (page, dpi) so the strip costs one cheap render each.
const THUMB_DPI = 28;
const BADGE_TITLE = { idle: "not detected yet", running: "detecting…",
                      done: "detected", error: "detection failed" };

function renderPageStrip() {
  const strip = $("pageStrip"), list = $("thumbList");
  list.innerHTML = "";
  if (!state.job) { strip.hidden = true; return; }
  strip.hidden = false;
  strip.classList.toggle("collapsed",
    localStorage.getItem("core-pagestrip") === "min");
  state.kinds.forEach((kind, p) => {
    const t = document.createElement("div");
    t.className = "thumb" + (p === state.page ? " current" : "");
    t.title = `page ${p + 1}` + (kind ? ` — ${kind}` : "");
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = `page ${p + 1}`;
    img.src = url(`/api/job/${state.job}/page/${p}/image?dpi=${THUMB_DPI}`);
    const foot = document.createElement("div");
    foot.className = "thumb-foot";
    const num = document.createElement("span");
    num.textContent = p + 1;
    const tag = document.createElement("span");
    tag.className = "tri-tag";        // filled by applyTriageToStrip()
    const badge = document.createElement("span");
    const st = state.pageStatus[p] || "idle";
    badge.className = "thumb-badge " + st;
    badge.title = BADGE_TITLE[st] || st;
    foot.append(num, tag, badge);
    t.append(img, foot);
    t.onclick = () => {
      if (p === state.page) return;
      $("pageSel").value = p;
      selectPage(p);
    };
    list.appendChild(t);
  });
  applyTriageToStrip();
}
function markCurrentThumb() {
  const list = $("thumbList");
  [...list.children].forEach((el, p) =>
    el.classList.toggle("current", p === state.page));
  const cur = list.children[state.page];
  if (cur) cur.scrollIntoView({ block: "nearest" });
}
function setPageStatus(p, st) {
  if (!state.pageStatus) state.pageStatus = [];
  state.pageStatus[p] = st;
  const t = $("thumbList").children[p];
  const b = t && t.querySelector(".thumb-badge");
  if (b) { b.className = "thumb-badge " + st; b.title = BADGE_TITLE[st] || st; }
  if (p === state.page) renderSheetHead();   // status chip mirrors the badge
}
async function refreshPageStatuses() {
  const job = state.job;
  if (!job) return;
  const pages = [...state.kinds.keys()];
  const res = await Promise.all(pages.map(p =>
    fetch(`/api/job/${job}/page/${p}/status`)
      .then(r => r.json()).catch(() => ({ status: "idle" }))));
  if (job !== state.job) return;   // another document won the race
  res.forEach((j, p) => setPageStatus(p,
    j.status === "done" ? "done" : j.status === "running" ? "running" : "idle"));
}
// ---------- sheet triage: which pages LOOK like excavation work ----------
// Attention paint only. The tiers come from GET /triage - a text-layer
// keyword score computed server-side, with the evidence attached (hits =
// the term-by-term computation). Nothing here detects, excludes, or touches
// a quantity: a tint, a tooltip that shows WHY, and an operator-toggled dim
// of the other-trade pages. Dimmed is never hidden - every thumb stays in
// place, stays clickable, and opens its page exactly as before.
const TRI_TIER_WORD = {
  core: "strong excavation signals",
  maybe: "some excavation signals",
  other: "looks like another trade",
  unknown: "no text - not triaged",
};
async function loadTriage(job) {
  let d = null;
  try {
    const r = await fetch(`/api/job/${job}/triage`);
    if (r.ok) d = await r.json();
  } catch (e) { return; }             // no triage is just an unpainted strip
  if (!d || !Array.isArray(d.pages)) return;
  // Job-scoped guard, NOT the page generation token: triage is a property
  // of the DOCUMENT, and openJob calls selectPage(0) right after this -
  // which bumps state.gen, so a gen guard discarded every reply (caught
  // live on ellis: endpoint 200 with 54 pages scored, strip never painted).
  if (state.job !== job) return;      // a different document opened since
  state.triage = d;
  applyTriageToStrip();
}
function triageTitle(p, r) {
  const kind = state.kinds[p];
  const head = `page ${p + 1}`
    + (r.sheet_no ? ` — sheet ${r.sheet_no}` : "")
    + (kind && kind !== "unknown" ? ` — ${kind}` : "");
  if (r.tier === "unknown") return head + LF + TRI_TIER_WORD.unknown;
  const ev = (r.hits || []).slice(0, 5)
    .map(h => `${h[0]}×${h[1]} (${h[2] > 0 ? "+" : ""}${h[2]})`)
    .join(", ");
  return head + LF
    + `${TRI_TIER_WORD[r.tier] || r.tier} (score ${r.score})` + LF
    + (ev || "no keyword hits");
}
function applyTriageToStrip() {
  const d = state.triage;
  const hl = localStorage.getItem("core-triage-hl") === "on";
  [...$("thumbList").children].forEach((t, p) => {
    t.classList.remove("tri-core", "tri-maybe", "tri-other",
                       "tri-unknown", "tri-dim");
    const r = d && d.pages && d.pages[p];
    if (!r) return;
    t.classList.add("tri-" + r.tier);
    if (hl && (r.tier === "other" || r.tier === "unknown"))
      t.classList.add("tri-dim");     // dim, never hide
    t.title = triageTitle(p, r);
    const tag = t.querySelector(".tri-tag");
    if (tag) tag.textContent =
      r.tier === "unknown" ? "no text" : (r.sheet_no || "");
  });
  renderTriageBar();
}
function renderTriageBar() {
  const bar = $("triageBar");
  const d = state.triage;
  if (!d || !Array.isArray(d.pages) || !d.pages.length) {
    bar.hidden = true;
    return;
  }
  const n = d.pages.filter(r => r.tier === "core" || r.tier === "maybe").length;
  const dim = d.pages.length - n;     // what "highlight" would dim
  const unk = (d.counts && d.counts.unknown) || 0;
  const hl = localStorage.getItem("core-triage-hl") === "on";
  bar.innerHTML = "";
  const txt = document.createElement("span");
  txt.className = "tri-text";
  txt.textContent =
    `${n} of ${d.pages.length} sheets look like excavation work`
    + (unk ? ` (${unk} not triaged: no text)` : "");
  bar.appendChild(txt);
  if (dim > 0) {
    const b = document.createElement("button");
    b.className = "mini";
    b.textContent = hl ? `undim ${dim}` : "highlight";
    b.title = hl
      ? "Restore full brightness on the dimmed pages"
      : `Dim the ${dim} pages that look like other trades (or have no`
        + ` text). Nothing is hidden or excluded — every page still opens,`
        + ` and detection and quantities are untouched.`;
    b.onclick = () => {
      localStorage.setItem("core-triage-hl", hl ? "off" : "on");
      applyTriageToStrip();
    };
    bar.appendChild(b);
  }
  bar.hidden = false;
}
$("stripToggle").onclick = () => {
  const min = $("pageStrip").classList.toggle("collapsed");
  localStorage.setItem("core-pagestrip", min ? "min" : "on");
};
$("detectAllBtn").onclick = async () => {
  if (state.detectAll) {          // second click stops the sweep
    state.detectAll = null;
    $("detectAllBtn").textContent = "Detect all";
    setStatus("detect-all stopped (pages already started keep running)");
    return;
  }
  const job = state.job;
  if (!job) return;
  state.detectAll = job;
  $("detectAllBtn").textContent = "Stop";
  const n = state.kinds.length;
  for (let p = 0; p < n; p++) {
    if (state.detectAll !== job || state.job !== job) return;
    if (state.pageStatus[p] === "done") continue;
    setStatus(`detecting page ${p + 1} / ${n}…`, "busy");
    setPageStatus(p, "running");
    await fetch(`/api/job/${job}/page/${p}/detect`, { method: "POST" });
    while (true) {
      if (state.detectAll !== job || state.job !== job) return;
      let j;
      try {
        j = await (await fetch(`/api/job/${job}/page/${p}/status`)).json();
      } catch (e) { j = { status: "running" }; }
      if (j.status === "done") {
        setPageStatus(p, "done");
        // the user may be sitting on this page waiting — load it live
        if (state.job === job && p === state.page && !state.result)
          loadResult(state.gen);
        break;
      }
      if (j.status && String(j.status).startsWith("error")) {
        setPageStatus(p, "error");
        break;
      }
      await new Promise(res => setTimeout(res, 1200));
    }
  }
  if (state.detectAll === job) {
    state.detectAll = null;
    $("detectAllBtn").textContent = "Detect all";
    const bad = state.pageStatus.filter(s => s === "error").length;
    setStatus(bad ? `all pages done — ${bad} failed` : "all pages detected");
  }
};

async function loadResult(gen = state.gen) {
  const r = await fetch(`/api/job/${state.job}/page/${state.page}/result`);
  if (!r.ok || gen !== state.gen) return;
  const parsed = await r.json();
  if (gen !== state.gen) return;
  state.result = parsed;
  state.include = new Map(); state.labels = new Map();
  state.selected = null; state.excluded = new Set();
  state.chainLabels = new Map(); state.clickPt = null;
  // a fresh result invalidates every snapshot on the undo stack ("Reset
  // edits" reloads through here, and re-detect replaces every chain object)
  state.multiSel = new Set(); state.marquee = null;
  undoClear(undoStack);
  state.tool = null; state.measurePts = []; state.vScale = null;
  state.ai = null; state.aiWhy = new Map(); state.aiUndo = null; state.measureMode = new Map(); state.aiAuto = false; state.seedLabels = new Map(); state.elevMap = undefined; state.aiHidden = false; $("aiBtn").textContent = "Analyze";
  state.ew = null; state.hotChain = null; state.extraItems = [];
  // a limit of work belongs to ONE sheet: the next page's grading line is
  // a different polygon, and carrying this one over would clip the new
  // sheet's volumes to an outline drawn somewhere else
  state.ewBound = null;
  // the WORK AREA is per sheet for the same reason; this page's own boxes
  // come back from the calcstate sidecar below (wzApplySaved)
  state.workZones = []; state.wzDrag = null; state.wzRev++;
  state.ewBoundDraft = []; state.ewBoundHover = null;
  // grading zones too - restored by gzApplySaved once the sidecar answers
  gzPageReset();
  state.conf = null; state.confKey = null; state.confErr = false;
  // review queue: check-offs belong to a page and a detection; reseeded
  // from the calcstate sidecar once it loads (renderCheckQueue)
  state.ckDone = null; state.ckShowAll = false; state.ckCollapsed = false;
  state.areaInc = new Map(); state.areaLabels = new Map();
  state.areaRows = []; state.areaHot = null;
  state.tr = null; state.sym = null; state.symMarks = null; state.symInfo = null;
  $("ewPanel").hidden = true; $("ewBtn").hidden = false;
  $("ewMap").checked = false;
  $("ewResult").textContent = "";  // stale numbers must not survive a doc/page switch
  // ...and neither must the basis line or the consent button that belonged
  // to them: state.ew is null above, so "Remove from takeoff" on the new
  // sheet would be a button with nothing behind it
  $("ewBasis").innerHTML = ""; $("ewBasis").classList.add("off");
  $("ewTake").classList.add("off"); $("ewAdd").classList.remove("on");
  $("trPanel").hidden = true; $("trBtn").hidden = false;
  // trench: same three rules as earthwork just above. Stale numbers must
  // not survive a doc/page switch, the consent button must not offer to
  // "Remove" rows state.tr no longer describes, and the band table must
  // not describe the previous sheet's run.
  $("trResult").textContent = "";
  $("trTake").classList.add("off"); $("trAdd").classList.remove("on");
  $("trBandBox").classList.add("off"); $("trBandRows").innerHTML = "";
  $("symPanel").hidden = true; $("symBtn").hidden = false;
  $("rollPanel").hidden = true; $("rollBtn").hidden = false;
  $("xsPanel").hidden = true; $("xsBtn").hidden = false; state.xs = null;
  $("coPanel").hidden = true; $("coBtn").hidden = false; state.co = null;
  $("aiBanner").hidden = true;
  state.nextChainId = 1 + Math.max(0, ...state.result.chains.map(c => c.chain_id));
  $("measureBtn").classList.remove("active"); $("measureInfo").hidden = true;
  $("restoreBtn").hidden = true;
  for (const s of state.result.styles) {
    const white = s.color && Math.min(...s.color) > 0.92;
    // white-over-wash linework is real but faint existing-conditions data;
    // it starts OFF so it never surprises the takeoff - one click turns a
    // family on when the estimator wants it
    // annotation (text/label/leader strokes) starts OFF like texture:
    // it is real ink but not takeoff linework, and ON-by-default is how
    // leader lines ended up welded into wall tallies
    state.include.set(s.style_id,
      (white || s.texture || s.class === "annotation") ? false
        : (s.class !== "solid" ? true : s.length_pt > 500));
    state.labels.set(s.style_id, s.suggested_label);
    state.seedLabels.set(s.style_id, s.suggested_label || "");
  }
  memApply();   // the reviewer's saved decisions win over seeds, every load
  // Calculator rows and area selections are decisions too, and they are
  // restored here for the same reason: they belong to this sheet, and the
  // operator committed them.
  calcRestore();
  // ...and the INPUTS behind those rows - contour surface picks, layer
  // stacks, trench depths, structure outlines - live in a server-side
  // sidecar (p<N>_calcstate.json, audit item 11), so a reload and every
  // other seat get them back too. Awaited BEFORE the first render of the
  // calculator panels: an opened panel must start from the saved record,
  // not from defaults that a slower fetch corrects behind the operator.
  await calcStateLoad(gen);
  if (gen !== state.gen) return;
  // The remembered scale pick has to be back in state.result BEFORE anything
  // paints. renderSheetHead draws the scale chip, the picker's ON highlight
  // AND the confidence banner's opening sentence straight off
  // state.result.scale; painting first and re-applying after left all three
  // asserting the ENGINE's scale while every quantity on the sheet was
  // already computed from the REVIEWER's. It only ever corrected itself
  // because /confidence happened to answer and repaint - so a 503 on that
  // endpoint stranded "1 inch = 8 ft" on screen permanently over a sheet
  // priced at 1.33 (6x on length, 36x on area). Making the first paint true
  // is not a repaint's job.
  scaleMemApply();
  scopeApply();   // verdicts before the first paint; see scopeApply()
  renderSheetHead();
  renderScopeBar();
  renderStyles(); renderChips(); renderLegend(); renderAreas(); renderMultiBar();
  // arApplyItems, not renderItemized: calcRestore brought back WHICH areas the
  // operator ticked, and the priced rows are DERIVED from that selection at
  // the scale in force. Rendering without re-deriving would show the
  // calculator rows returning while the area rows silently did not.
  arApplyItems();
  renderMiniLegend(); draw();
  // and the durable one: a scale this page's reviewer approved on an earlier
  // visit lives in the server sidecar, not in this browser. Async on purpose
  // - the first paint above is already true, and this only corrects it.
  scaleRestore(gen);
  document.getElementById("aiBtn").hidden = false;
  if (state.autoAi) runAnalyze(true);   // opt-in power mode only
  const sc = state.result.scale;
  setStatus(`${state.result.chains.length} lines in ${state.result.styles.length} styles` +
    (sc ? ` · scale ${sc.text} (${sc.source}` +
      (sc.agrees === true ? ", matches the drawn bar"
        : sc.agrees === false ? `, but the drawn bar says ${sc.bar_ft_per_paper_inch} ft/in`
        : "") + ")"
      : " · no scale found"),
    sc && sc.agrees === false ? "err" : "");
}

// ---------- sidebar ----------
// ---------- object mode: discrete countable pieces --------------------
// Split a chain into straight runs: cut at corners (an object like a
// shear-wall segment is straight; the building turns, the object ends)
// and at jumps far beyond the pattern's own rhythm (an opening between
// two collinear segments). General geometry - no per-sheet templating.
function chainRuns(ch) {
  const pts = ch.points;
  if (pts.length < 2) return [];
  const tpl = ch.template && ch.template.length >= 2 ? ch.template : null;
  const period = tpl ? tpl.reduce((a, b) => a + b, 0) : null;
  const segs = [];
  for (let i = 1; i < pts.length; i++)
    segs.push(Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));
  const med = [...segs].sort((a, b) => a - b)[Math.floor(segs.length / 2)] || 1;
  const jump = Math.max(period ? 2.2 * period : 0, 3 * med, 18);
  const runs = [];
  let run = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    let cut = segs[i-1] > jump;
    if (!cut) {
      const b = [pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]];
      const lb = Math.hypot(...b);
      if (lb > 1) {
        // local turn catches sharp corners; deviation from the RUN's own
        // direction catches corners a dashed polyline wraps GRADUALLY
        // (tiny sub-40-degree steps that sum to 90) - objects are straight
        if (i >= 2) {
          const a = [pts[i-1][0]-pts[i-2][0], pts[i-1][1]-pts[i-2][1]];
          const la = Math.hypot(...a);
          if (la > 1)
            cut = (a[0]*b[0] + a[1]*b[1]) / (la * lb) < 0.76;
        }
        if (!cut) {
          const r0 = run[0];
          const rv = [pts[i-1][0]-r0[0], pts[i-1][1]-r0[1]];
          const lr = Math.hypot(...rv);
          if (lr > 12)
            cut = (rv[0]*b[0] + rv[1]*b[1]) / (lr * lb) < 0.76;
        }
      }
    }
    if (cut) { if (polyLen(run) >= 6) runs.push(run); run = [pts[i-1]]; }
    run.push(pts[i]);
  }
  if (polyLen(run) >= 6) runs.push(run);
  return runs;
}
// `onlyChains`, when given, is the set of chain_ids that belong to the ROW
// being counted. Without it this function knows only about styles, and
// state.chainLabels means a style's chains can be split across two rows: a
// line SEPARATED into its own priced item was counted in full by both its own
// row and its parent's, so the panel could report 48 objects where the export
// reported 24. Callers that mean "this style" still pass one argument.
function styleObjects(sid, onlyChains) {
  const sids = Array.isArray(sid) ? new Set(sid) : new Set([sid]);
  // straight runs are the DRAWING's pieces; an estimator's OBJECT is a
  // contiguous band: corners connect (a wall turning is one wall), real
  // openings split (a doorway gap is two walls), and the two drawn faces
  // of a double-line wall are one object, one footage.
  const opens = state.result.openings || [];
  const maxR = opens.length ? Math.max(...opens.map(o => o.r)) : 0;
  const splitAtOpenings = (pts) => {
    // a doorway is a zone the takeoff never measures through - but the
    // swing DISK is centered at the hinge ON the wall, so cutting the
    // whole disk erased a 2r span (and rows of adjacent swings tiled
    // whole walls away: Belle p2 Grand Hall / restroom runs). The engine
    // now ships the arc midpoint (mx,my); the opening's chord runs from
    // the hinge toward the arc's side of this run, width r. Cut only
    // that span, laterally within the wall's own thickness.
    if (!opens.length) return [pts];
    // door hardware first: leaf strokes and solid-drawn swing arcs live
    // INSIDE their disk and are door-sized - drop the whole run rather
    // than boxing a phantom at the opening (Belle p2 double doors)
    const L = polyLen(pts);
    if (L <= 2.2 * maxR) {
      let nin = 0;
      for (const q of pts)
        if (opens.some(o => Math.hypot(q[0] - o.cx, q[1] - o.cy) <= o.r * 1.05)) nin++;
      if (nin / pts.length >= 0.7) return [];
    }
    // NO geometric cut at swings: the drawing itself breaks the band
    // where the shear wall truly stops (human-confirmed on Belle p2 -
    // the band runs CONTINUOUS over the folding-door row and that whole
    // run is ONE counted object, ground-truth 24). Drawn gaps wider than
    // the union tolerance separate objects on their own.
    return [pts];
  };
  let runs = [];
  for (const ch of state.result.chains) {
    if (!sids.has(ch.style_id) || state.excluded.has(ch.chain_id)) continue;
    if (onlyChains && !onlyChains.has(ch.chain_id)) continue;
    for (const r of chainRuns(ch))
      for (const part of splitAtOpenings(r))
        runs.push({ pts: part, len: polyLen(part) });
  }
  // the legend's own swatch bars share the symbol's style but are sheet
  // furniture, not takeoff (Belle p2 counted its legend as a 25th wall)
  const lsamps = state.result.legend_samples || [];
  if (lsamps.length) {
    runs = runs.filter(r => {
      const m = r.pts[Math.floor(r.pts.length / 2)];
      return !lsamps.some(b => m[0] >= b[0] - 2 && m[0] <= b[2] + 2 &&
                               m[1] >= b[1] - 2 && m[1] <= b[3] + 2);
    });
  }
  if (!runs.length) return [];
  // annotation riding the same pen: real object faces sit ON a fill band
  // (walls are drawn filled); dimension strings and leaders are bare. Only
  // applies when the style is visibly MIXED - unfilled plans keep all runs.
  const fills = state.result.fills || [];
  if (fills.length && fills.length < 3000) {
    const sc0 = state.result.scale;
    const maxSide = sc0 ? (2.5 / sc0.ft_per_paper_inch) * 72 : 30;
    const bands = fills.filter(f =>
      Math.min(f[2] - f[0], f[3] - f[1]) <= maxSide);
    if (bands.length) {
      const onFill = (r) => {
        const m = r.pts[Math.floor(r.pts.length / 2)];
        return bands.some(f => m[0] >= f[0] - 2 && m[0] <= f[2] + 2 &&
                               m[1] >= f[1] - 2 && m[1] <= f[3] + 2);
      };
      const flags = runs.map(onFill);
      const frac = flags.filter(Boolean).length / runs.length;
      // when the sheet HAS bands and this pool touches them at all, the
      // object geometry IS the on-band runs: off-band leftovers are zone
      // rectangles, dimension strings, leaders - at ANY minority share
      // (a >0.9 upper bound let the conservatory note-zone rect through
      // as the only off-band run in an otherwise clean pool)
      if (frac > 0) {
        const kept2 = runs.filter((_, i) => flags[i]);
        if (kept2.length) runs = kept2;
      }
    }
  }
  if (!runs.length) return [];
  // touch tolerance: corners touch at ~0; the smallest door is ~30in, so
  // anything under ~1.2 ft of paper distance is the same object. Falls
  // back to 14pt when the sheet has no scale.
  const sc = state.result.scale;
  const tol = sc ? (1.2 / sc.ft_per_paper_inch) * 72 : 14;
  const dirOf = (r) => {
    const a = r.pts[0], b = r.pts[r.pts.length - 1];
    const L = Math.hypot(b[0]-a[0], b[1]-a[1]) || 1;
    return [(b[0]-a[0]) / L, (b[1]-a[1]) / L];
  };
  const near = (a, b) => {
    // same OBJECT = near AND parallel: the two faces of one wall, or its
    // collinear continuation. A perpendicular touch (T-junction, corner)
    // is a DIFFERENT object - that is how an estimator counts bands.
    const da = dirOf(a), db = dirOf(b);
    if (Math.abs(da[0]*db[0] + da[1]*db[1]) < 0.87) return false;
    // side-by-side (projection overlap) = two faces of one wall: lateral
    // up to the wall thickness. End-to-end = continuation: COLLINEAR
    // only (lat <= 8pt) - a parallel run a jog-step away is the NEXT
    // object (human-confirmed segment convention, Belle p2 west wall)
    const a0 = a.pts[0];
    const proj = (p) => (p[0]-a0[0])*da[0] + (p[1]-a0[1])*da[1];
    const aP = [proj(a.pts[0]), proj(a.pts[a.pts.length-1])].sort((x,y)=>x-y);
    const bP = [proj(b.pts[0]), proj(b.pts[b.pts.length-1])].sort((x,y)=>x-y);
    const overlap = Math.min(aP[1], bP[1]) - Math.max(aP[0], bP[0]);
    const bm = b.pts[Math.floor(b.pts.length/2)];
    const lat = Math.abs((bm[0]-a0[0])*da[1] - (bm[1]-a0[1])*da[0]);
    const sideBySide = overlap > 4 &&
      overlap >= 0.3 * Math.min(aP[1]-aP[0], bP[1]-bP[0]);
    if (sideBySide ? lat > Math.max(tol, 12) : lat > 8) return false;
    for (const p of [a.pts[0], a.pts[a.pts.length - 1]]) {
      for (let i = 1; i < b.pts.length; i++) {
        if (distToSeg(p[0], p[1], b.pts[i - 1], b.pts[i]) <= tol) return true;
      }
    }
    return false;
  };
  const parent = runs.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++)
      if (find(i) !== find(j) && (near(runs[i], runs[j]) || near(runs[j], runs[i])))
        parent[find(i)] = find(j);
  const comps = new Map();
  runs.forEach((r, i) => {
    const k = find(i);
    if (!comps.has(k)) comps.set(k, []);
    comps.get(k).push(r);
  });
  const out = [];
  for (const members of comps.values()) {
    // footage: drop parallel FACE ECHOES (the second drawn face of the
    // same wall) - a run mostly alongside a longer kept run within a
    // wall's thickness is the same wall, not more wall
    members.sort((a, b) => b.len - a.len);
    const kept = [];
    for (const r of members) {
      const mid = r.pts[Math.floor(r.pts.length / 2)];
      const a = r.pts[0], b = r.pts[r.pts.length - 1];
      const dx = b[0]-a[0], dy = b[1]-a[1];
      const L = Math.hypot(dx, dy) || 1;
      let echo = false;
      for (const k of kept) {
        const ka = k.pts[0], kb = k.pts[k.pts.length - 1];
        const kdx = kb[0]-ka[0], kdy = kb[1]-ka[1];
        const kL = Math.hypot(kdx, kdy) || 1;
        const cos = Math.abs((dx*kdx + dy*kdy) / (L * kL));
        if (cos < 0.92) continue;
        let insideBoth = 0;
        for (const q of [a, mid, b]) {
          let dmin = Infinity;
          for (let i = 1; i < k.pts.length; i++)
            dmin = Math.min(dmin, distToSeg(q[0], q[1], k.pts[i-1], k.pts[i]));
          if (dmin <= Math.max(tol, 12)) insideBoth++;
        }
        if (insideBoth >= 2) { echo = true; break; }
      }
      if (!echo) kept.push(r);
    }
    const len = kept.reduce((t, r) => t + r.len, 0);
    // scraps below ~1 ft are pattern debris; short stall walls between
    // clustered doors (restrooms) are REAL per-segment objects and stay
    if (len < (sc ? (1.0 / sc.ft_per_paper_inch) * 72 : 10)) continue;
    out.push({
      runs: members,                       // every run, for the boxes
      pts: members[0].pts,                 // representative
      len,
    });
  }
  return out;
}

// paint a style's REAL line sample onto a small canvas (retina 2x)
function drawPatternSample(cnv, s, w, h) {
  cnv.width = w; cnv.height = h;
  const sctx = cnv.getContext("2d");
  const rep = state.result.chains.find(c => c.style_id === s.style_id);
  const tpl = rep && rep.template && rep.template.length >= 2
    ? rep.template : dashArray(s.signature);
  sctx.strokeStyle = cssColor(s.color, s.width);
  sctx.lineWidth = Math.min(2 + (s.width || 0.5) * 1.6, 7);
  if (s.class !== "solid" && tpl && tpl.length >= 2) {
    const span = tpl.reduce((a, b) => a + b, 0);
    const k2 = span > 0 ? Math.min((w - 8) / span, 3.2) : 1;
    sctx.setLineDash(tpl.map(v => Math.max(v * k2, 1.6)));
  }
  sctx.beginPath(); sctx.moveTo(4, h / 2); sctx.lineTo(w - 4, h / 2);
  sctx.stroke();
}

// ---------- on-sheet mini legend ----------
function renderMiniLegend() {
  const box = $("miniLegend");
  if (!state.result) { box.hidden = true; return; }
  if (localStorage.getItem("core-minilegend") === "off") { box.hidden = true; return; }
  box.hidden = false;
  box.classList.toggle("collapsed",
    localStorage.getItem("core-minilegend") === "min");
  const rows = $("mlRows");
  rows.innerHTML = "";
  const vis = state.result.styles
    .filter(st => state.include.get(st.style_id))
    .sort((a, b) => b.length_pt - a.length_pt);
  const sc = state.result.scale;
  const ftPerIn = sc ? sc.ft_per_paper_inch : null;
  for (const st of vis.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "ml-row" + (state.isolate === st.style_id ? " iso" : "");
    const cnv = document.createElement("canvas");
    cnv.className = "ml-swatch";
    drawPatternSample(cnv, st, 80, 18);
    const lab = document.createElement("span");
    lab.className = "ml-lab";
    lab.textContent = state.labels.get(st.style_id) || st.suggested_label
      || `${st.class} · ${st.signature}`;
    const ft = document.createElement("span");
    ft.className = "ml-ft";
    const q = ftPerIn ? styleLenPt(st) / 72 * ftPerIn : styleLenPt(st);
    ft.textContent = (q >= 1000 ? (q/1000).toFixed(1) + "k" : q.toFixed(0))
      + (ftPerIn ? " ft" : " pt");
    row.append(cnv, lab, ft);
    row.onclick = () => {
      state.isolate = state.isolate === st.style_id ? null : st.style_id;
      renderMiniLegend(); draw();
    };
    rows.appendChild(row);
  }
  if (vis.length > 8) {
    const more = document.createElement("div");
    more.className = "ml-more";
    more.textContent = `+ ${vis.length - 8} MORE IN SIDEBAR`;
    rows.appendChild(more);
  }
}
$("mlToggle").onclick = () => {
  const min = localStorage.getItem("core-minilegend") === "min";
  localStorage.setItem("core-minilegend", min ? "on" : "min");
  renderMiniLegend();
};

// ---------- sidebar sheet header: doc / page / scale / status ----------
// quantity in feet whenever the sheet has a scale; honest pt fallback
function fmtQty(pt) {
  const sc = state.result && state.result.scale;
  if (!sc) return fmtLen(pt);
  const ft = pt / 72 * sc.ft_per_paper_inch;
  return (ft >= 1000 ? (ft / 1000).toFixed(1) + "k" : ft.toFixed(0)) + " LF";
}
function renderSheetHead() {
  const el = $("sheetHead");
  if (!state.job) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = "";
  const name = document.createElement("div");
  name.className = "sh-name";
  name.title = state.docName || "";
  name.textContent = state.docName || "";
  const meta = document.createElement("div");
  meta.className = "sh-meta";
  const chip = (txt, cls) => {
    const s = document.createElement("span");
    s.className = "sh-chip" + (cls ? " " + cls : "");
    s.textContent = txt;
    return s;
  };
  // The printed sheet number when the engine read one off the title block
  // ("C3.1"), with the 1-based page position kept beside it: the client's
  // drawings are named by the printed number, but every filename and API
  // call in this tool is indexed - showing only one of the two is how
  // "page 4" has already meant two different sheets (CLAUDE.md §5).
  const sheetNo = state.result && state.result.sheet_no;
  meta.append(chip(sheetNo
    ? `${sheetNo} (page ${state.page + 1} of ${state.kinds.length})`
    : `Sheet ${state.page + 1} / ${state.kinds.length}`));
  const kind = state.kinds[state.page];
  if (kind && kind !== "unknown") meta.append(chip(kind));
  // Scale, with its second opinion. A wrong scale is this engine's most
  // expensive silent failure - 14 corpus pages read wrong and every one
  // reached this chip in confident green (F92). Where the sheet also draws a
  // GRAPHIC SCALE bar, its tick geometry is an independent reading, so the
  // chip now says whether the two agree instead of implying certainty it
  // does not have.
  const sc = state.result && state.result.scale;
  if (state.result) {
    if (!sc) {
      // "calibrate" used to be the only place that word appeared in this UI
      // and nothing implemented it. The box below does, so the chip points
      // at it instead of naming a thing that did not exist.
      meta.append(chip("no scale — type one below", "warn"));
    } else if (sc.typed_by_reviewer) {
      // A number a person typed has nothing behind it but their word. It can
      // never wear the corroborated colour, and it says whose it is
      // everywhere it is read - chip, banner, export, report PDF.
      meta.append(chip(sc.text + " — SET BY HAND", "warn"));
    } else if (sc.agrees === false) {
      meta.append(chip(sc.text, "bad"));
      meta.append(chip(`drawn bar says ${sc.bar_ft_per_paper_inch} ft/in` +
        ` · ${sc.delta_pct}% apart — CHECK`, "bad"));
    } else if (sc.agrees === true) {
      meta.append(chip(sc.text + " ✓ matches drawn bar", "ok"));
    } else {
      // one source only: honest, but not corroborated
      meta.append(chip(sc.text + (sc.source === "ocr" ? " (read off a scan)" : ""),
        sc.source === "ocr" ? "warn" : "ok"));
    }
  }
  const st = state.result ? "detected"
    : (state.pageStatus || [])[state.page] === "running" ? "detecting…"
    : (state.pageStatus || [])[state.page] === "error" ? "detect failed"
    : "not detected";
  meta.append(chip(st, state.result ? "ok"
    : st === "detect failed" ? "warn" : ""));
  el.append(name, meta);
  renderScalePick(el);
  renderScaleTyped(el);
  renderConfidence();
}

// ---------- more than one scale on the sheet -----------------------------
// A sheet with a plan AND details carries several scale captions. The engine
// USED to pick by how many times each appears, which on a detail sheet runs
// exactly backwards: many small details, one big plan. Over the whole plan
// corpus, 67 of 6,714 pages carry two or more distinct candidates, and on one
// landscape sheet the count picked a detail over the plan - 4x on every
// length, 16x on every area.
//
// scale_detect._rank now does read what each caption is attached to (the
// linework above its title bar) and ranks on that, so the default is no
// longer a tally. It is still ONE default for a sheet that genuinely has
// several - it does not scale each detail separately - and on a thin margin
// it can still be the wrong one. So the picker stays: show the estimator
// every reading the sheet offers and let one click switch. The choice is
// remembered per document and page, like the style decisions.
//
// DEFERRED, not fixed here - this run owns the confidence banner and was told
// to leave the picker as it stands. The button tooltip below prints `count`
// as "printed Nx". `count` is REGEX MATCHES, not printed captions, and runs
// at exactly 2x: on Barn Landscaping engine page index 29 the 3/4" caption is
// printed at 3 sites and the tooltip advertises 6, and all 11 candidates
// measured across engine page indices 29, 18 and 27 are 2x. The honest field
// is the candidate's `sites`, which the engine now emits alongside `count`;
// the fix is `c.sites` in place of `c.count` on the line below and nothing
// else. Nobody is on it.
function scaleKey() {
  return "scale::" + (state.docName || "?") + "::p" + state.page;
}
// The distinct scales this sheet prints, in the engine's own order. Shared
// with the confidence banner on purpose: the sentence that says "this sheet
// prints 3 different scales" and the buttons that switch between them must
// never be able to count differently.
function scaleCandidates() {
  const sc = state.result && state.result.scale;
  const uniq = [];
  for (const c of ((sc && sc.candidates) || [])) {
    if (!c || !c.ft_per_paper_inch) continue;
    if (!uniq.some(u => Math.abs(u.ft_per_paper_inch - c.ft_per_paper_inch) < 1e-6))
      uniq.push(c);
  }
  return uniq;
}
function renderScalePick(host) {
  const sc = state.result && state.result.scale;
  const uniq = scaleCandidates();
  if (uniq.length < 2) return;
  const row = document.createElement("div");
  row.className = "sh-scales";
  const lab = document.createElement("span");
  lab.className = "dim";
  lab.textContent = `this sheet prints ${uniq.length} different scales — using:`;
  row.appendChild(lab);
  for (const c of uniq) {
    const b = document.createElement("button");
    b.className = "sh-scale-pick" +
      (Math.abs(c.ft_per_paper_inch - sc.ft_per_paper_inch) < 1e-6 ? " on" : "");
    b.textContent = `${(+c.ft_per_paper_inch).toFixed(2)} ft/in`;
    b.title = c.text + (c.count > 1 ? ` — printed ${c.count}x` : " — printed once");
    b.onclick = () => {
      // keep the reading's own text and provenance; drop the bar
      // corroboration, which was computed against the engine's pick
      state.result.scale = Object.assign({}, sc, {
        text: c.text, ft_per_paper_inch: c.ft_per_paper_inch,
        count: c.count, near_scale_keyword: c.near_scale_keyword,
        agrees: null, bar_ft_per_paper_inch: sc.bar_ft_per_paper_inch,
        delta_pct: null, picked_by_reviewer: true,
        // this is a reading PRINTED on the sheet, so it clears any hand-typed
        // one. Object.assign copies forward, and a stale typed_by_reviewer
        // would keep saying SET BY HAND over a caption the sheet prints.
        typed_by_reviewer: false,
      });
      try { store.setItem(scaleKey(), String(c.ft_per_paper_inch)); } catch (e) { /* private mode */ }
      try { store.removeItem(scaleTypedKey()); } catch (e) { /* private mode */ }
      setStatus(`scale set to ${(+c.ft_per_paper_inch).toFixed(2)} ft per inch — every quantity on this sheet recalculated`);
      renderSheetHead(); renderStyles(); renderAreas(); renderItemized();
      renderMiniLegend(); draw();
    };
    row.appendChild(b);
  }
  host.appendChild(row);
  renderVScalePick(host, uniq);
}

// ---------- the second scale, on the OTHER axis --------------------------
// A profile sheet prints two scales that are both correct at once: the run
// at one, the rise at the other. The picker above chooses which single scale
// governs, which is right for a plan sheet printing a detail at a different
// scale, and wrong here - picking one leaves every sloped pipe measured with
// the other axis exaggerated.
//
// SUGGESTED, NEVER APPLIED. Measured on Kayden Springs Unit 2 p39: the
// engine finds 1"=50' governing 100% of the linework and 1"=5' governing
// 0.0%, because the ranking is region-scoped and a vertical scale governs no
// REGION - it governs an axis. That 0%/100% split with the smaller reading
// scoring zero is a good signal, but acting on it silently would change
// every length on the page, which is the worst failure this product has.
// So it is offered with the reason shown, and the operator confirms.
// WITHDRAWN 2026-08-27 - do not re-enable without the region test below.
//
// The control applies one ratio to the WHOLE PAGE. On a plan-and-profile
// sheet only the bottom graph carries two scales, so the plan half above it
// gets divided down too. Measured on the delivered approve for Kayden Springs
// U2 engine page index 39 = printed sheet C5.2
// (takeoff-jobs/d0e10205df40/p39_elements.json, 354 elements):
//
//   sheet total                       52,854.3 ft -> 33,949.7 ft   -35.8%
//   "Profile sewer pipe" - the ONLY thing it exists to fix    -1.6 ft  -0.1%
//   C-U2-PROP-LOT                                         -2,288.7 ft -85.9%
//   TITLEBLOCK - SHEET                                    -2,004.6 ft -37.3%
//   G-TBLK-LOGO                                             -675.5 ft -44.7%
//
// It buys 1.6 ft of correctness and destroys 18,904 ft. It shrinks the
// sheet's own title block by 37% and the company logo by 45%, because those
// have vertical edges and the ratio hits every y component on the page.
//
// Two things compound it. state.vScale is persisted nowhere, so the same
// sheet approved twice ships 33,949.7 ft and then 52,854.3 ft under a
// byte-identical scale block. And _scale_report_lines() in server.py can only
// print one "Scale: 1 inch = X ft", so the report states a single scale above
// a table computed from two.
//
// The fix is not a patch: the ratio has to apply only to chains inside the
// profile region. The two bands ARE separable in the shipped file - plan
// geometry at export-px y 1600-2731, profile pipes at y 4956-5119 - so the
// region test is available and none is applied.
//
// Safe to withdraw this way: with no vertical scale set every path returns
// the engine's own number untouched, and this suggestion is the only thing
// that can set one. Nothing approved to date is affected.
const V_SCALE_ENABLED = false;

function vScaleSuggestion(uniq) {
  if (!V_SCALE_ENABLED) return null;
  if (!uniq || uniq.length !== 2) return null;
  const sc = state.result && state.result.scale;
  if (!sc) return null;
  const sorted = [...uniq].sort(
    (x, y) => x.ft_per_paper_inch - y.ft_per_paper_inch);
  const small = sorted[0], large = sorted[1];
  // vertical exaggeration means the vertical scale shows FEWER feet per inch
  if (!(small.ft_per_paper_inch < large.ft_per_paper_inch * 0.5)) return null;
  // and the axis one governs no region, while the plan one governs the sheet
  const gs = small.governs_pct, gl = large.governs_pct;
  if (gs === null || gs === undefined || gl === null || gl === undefined)
    return null;
  if (!(gs <= 5 && gl >= 60)) return null;
  return { vert: small, horiz: large };
}

function renderVScalePick(host, uniq) {
  const sug = vScaleSuggestion(uniq);
  const on = state.vScale !== null && state.vScale !== undefined;
  if (!sug && !on) return;
  const sc = state.result.scale;

  const row = document.createElement("div");
  row.className = "sh-scales";
  const lab = document.createElement("span");
  lab.className = "dim";
  lab.textContent = on
    ? `two axes \u2014 across ${(+sc.ft_per_paper_inch).toFixed(2)} ft/in, `
      + `up ${(+state.vScale).toFixed(2)} ft/in:`
    : "looks like a profile \u2014 second scale is for the VERTICAL axis:";
  row.appendChild(lab);

  const mk = (text, title, active, fn) => {
    const b = document.createElement("button");
    b.className = "sh-scale-pick" + (active ? " on" : "");
    b.textContent = text;
    b.title = title;
    b.onclick = fn;
    row.appendChild(b);
  };

  if (sug) {
    mk(`use ${(+sug.vert.ft_per_paper_inch).toFixed(2)} ft/in up`,
       `${sug.vert.text} governs no area of this sheet, and shows fewer feet `
       + `per inch than ${sug.horiz.text}. On a profile that is the vertical `
       + `exaggeration. Applying it measures each line's rise at this scale `
       + `and its run at the other.`,
       on,
       () => {
         // the horizontal scale must be the one governing the drawing
         if (Math.abs(sc.ft_per_paper_inch - sug.horiz.ft_per_paper_inch) > 1e-6) {
           state.result.scale = Object.assign({}, sc, {
             text: sug.horiz.text,
             ft_per_paper_inch: sug.horiz.ft_per_paper_inch,
             count: sug.horiz.count, agrees: null, delta_pct: null,
             picked_by_reviewer: true, typed_by_reviewer: false,
           });
         }
         state.vScale = sug.vert.ft_per_paper_inch;
         setStatus(`two scales applied \u2014 across `
           + `${(+sug.horiz.ft_per_paper_inch).toFixed(2)} ft/in, up `
           + `${(+sug.vert.ft_per_paper_inch).toFixed(2)} ft/in. Sloped lines `
           + `are no longer measured as if the sheet were flat.`);
         renderSheetHead(); renderStyles(); renderAreas(); renderItemized();
         renderMiniLegend(); draw();
       });
  }
  if (on) {
    mk("one scale", "Go back to measuring both axes at the horizontal scale",
       false,
       () => {
         state.vScale = null;
         setStatus("back to a single scale for both axes");
         renderSheetHead(); renderStyles(); renderAreas(); renderItemized();
         renderMiniLegend(); draw();
       });
  }
  host.appendChild(row);
}
  // reapply a remembered pick after a detect
function scaleMemApply() {
  if (!state.result) return;
  const sc = state.result.scale;
  // A TYPED scale is checked first and can exist where the engine read
  // nothing at all - which the candidate path below cannot represent,
  // because it needs a candidate to match against.
  let typed = null;
  try { typed = JSON.parse(store.getItem(scaleTypedKey()) || "null"); }
  catch (e) { typed = null; }
  if (typed && scaleSane(typed.ft) !== null) {
    state.result.scale = scaleTypedObj(sc, typed.ft, typed.text);
    return;
  }
  if (!sc || !sc.candidates) return;
  let want;
  try { want = store.getItem(scaleKey()); } catch (e) { return; }
  if (!want) return;
  const hit = sc.candidates.find(
    c => Math.abs(c.ft_per_paper_inch - parseFloat(want)) < 1e-6);
  if (!hit || Math.abs(hit.ft_per_paper_inch - sc.ft_per_paper_inch) < 1e-6) return;
  state.result.scale = Object.assign({}, sc, {
    text: hit.text, ft_per_paper_inch: hit.ft_per_paper_inch,
    count: hit.count, agrees: null, delta_pct: null, picked_by_reviewer: true,
    typed_by_reviewer: false,
  });
}

// ---------- the operator types the scale ---------------------------------
// The picker above can only offer readings the ENGINE found, and it does not
// draw at all under two candidates. So a sheet with no reading was stuck, and
// a sheet with ONE WRONG reading was stuck in exactly the same way - there
// was no second button to click. Two server routes told the estimator to
// "calibrate first" and the word `calibrate` appeared once in this whole UI,
// as a chip label, with nothing behind it.
//
// Measured before this box existed: of the cold-corpus pages that produce
// real traced linework, 62% carry no scale and therefore no price; on the
// client's 208-page set, 72 pages return no value at all.
//
// This is a TYPED NUMBER ONLY. Two-point canvas calibration is a different,
// larger job (hit-testing, snapping, a drawn ruler) and is deliberately not
// here. And a typed scale travels the way a picked candidate travels - the
// same `state.result.scale`, the same approve payload, the same
// `p<N>_scale.json` sidecar, the same `set by the reviewer` provenance on the
// export and the report PDF. There is no second path.

// The band, mirrored from server.py SCALE_FT_MIN / SCALE_FT_MAX. The SERVER
// is the guard - it refuses an out-of-band approve whatever the browser did,
// and it is the only thing standing between a script and the export. This
// copy exists ONLY so the refusal can be shown while the number is still
// being typed. Change both or neither; server.py carries the evidence
// (6,714 corpus pages, every reading between 0.3333 and 250.0 ft per inch).
// 0.0833 is 1/12 rounded DOWN to four places - full size, 1 paper inch = 1
// real inch - so the floor this app PRINTS in a refusal is itself accepted
// when the reader types it back.
const SCALE_FT_MIN = 0.0833;
const SCALE_FT_MAX = 1000;        // 4x the corpus maximum (1" = 250')

function scaleSane(v) {
  const f = +v;
  if (!isFinite(f)) return null;
  return (f >= SCALE_FT_MIN && f <= SCALE_FT_MAX) ? f : null;
}
function scaleTypedKey() {
  return "scaletyped::" + (state.docName || "?") + "::p" + state.page;
}
// The scale object a typed number produces. Built from the engine's, so the
// candidate list and the drawn bar's reading survive for the banner - but
// every CORROBORATION field is cleared, because none of it was measured
// against this number.
function scaleTypedObj(sc, ft, text) {
  return Object.assign({}, sc || {}, {
    ft_per_paper_inch: ft,
    text: text,
    agrees: null, delta_pct: null,
    picked_by_reviewer: true,
    typed_by_reviewer: true,
  });
}

// What an estimator actually writes, and nothing else. Every form below is
// echoed back in words before it is applied; anything not on the list is
// REFUSED with the reason, never guessed at.
//
//   1" = 20'        1"=20'      1 inch = 20 feet     1 IN = 20 FT
//   1/4" = 1'-0"    3/16"=1'    1-1/2" = 1'-0"
//   20              20.5        20'                  20 ft
//   1:200           1:100
//
// CONVENTIONS, and where they come from:
//   * `1/4" = 1'-0"` is the architect's form: a quarter inch of paper is one
//     foot of building, so 4 ft per paper inch. Read straight off every
//     Beaumont and Thielen title block in this corpus.
//   * A bare number is FEET PER PAPER INCH, the unit this whole app is
//     built on (server.py ApproveScale.ft_per_paper_inch,
//     scale_detect.ScaleCandidate.ft_per_paper_inch).
//   * `1:200` is the unit-free drawing ratio: one unit of paper is 200 of
//     the same units on the ground, so 200 inches = 16.67 ft per paper inch.
//     GENERAL DRAFTING PRACTICE (the ISO/metric convention) - NOT evidenced
//     from this corpus, which prints imperial captions and no ratios in any
//     of the 279 pages that yield a scale. That is precisely why the echo
//     spells the arithmetic out before it is applied: if the writer meant
//     "1 inch = 200 feet" they will see 16.67 and stop.
const SC_FRAC = String.raw`\d+(?:\.\d+)?|\d+\s*\/\s*\d+|1[\s-]1\/2`;
const SC_INCH = String.raw`(?:"|”|″|in\.?|inch(?:es)?)`;
const SC_FEET = String.raw`(?:'|’|′|ft\.?|feet|foot)`;

function scaleNum(s) {
  s = s.trim();
  let m = /^(\d+)[\s-](\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) return +m[1] + (+m[2]) / (+m[3]);
  m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) return (+m[2]) === 0 ? NaN : (+m[1]) / (+m[2]);
  return parseFloat(s);
}

// -> {ft, text, said} on success, {err} on refusal. Never both, never a
// guess. `said` is the plain-words echo shown BEFORE the number is applied.
function parseScale(raw) {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return { err: "" };
  const bad = (why) => ({ err: why });
  const ok = (ft, text, said) => {
    if (scaleSane(ft) === null)
      return bad(`that works out to ${ft > 1e6 ? ft.toExponential(2)
        : (+ft).toFixed(4)} feet per paper inch, which this app refuses. `
        + `It accepts ${SCALE_FT_MIN.toFixed(4)} (full size, 1 inch of paper `
        + `= 1 real inch) up to ${SCALE_FT_MAX} ft per inch. Every scale this `
        + `app has read anywhere in the plan corpus is between 0.33 and 250.`);
    return { ft: ft, text: text, said: said };
  };
  const fmt = (v) => (+v).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

  // 1/4" = 1'-0"  |  1" = 20'  |  1 inch = 20 ft  |  3/16"=1'
  let m = new RegExp(String.raw`^(${SC_FRAC})\s*${SC_INCH}\s*[=:]\s*`
    + String.raw`(\d+(?:\.\d+)?)\s*${SC_FEET}?\s*`
    + String.raw`(?:-\s*(\d+(?:\.\d+)?)\s*${SC_INCH}?)?$`, "i").exec(s);
  if (m) {
    const paper = scaleNum(m[1]);
    const feet = parseFloat(m[2]) + (m[3] ? parseFloat(m[3]) / 12 : 0);
    if (!isFinite(paper) || paper <= 0)
      return bad("the paper side of that scale is not a number.");
    if (paper > 12)
      return bad(`${m[1]} inches of paper is wider than any scale's paper `
        + `side - an architect's rule stops at 3 inches to the foot.`);
    if (!isFinite(feet) || feet <= 0)
      return bad("the ground side of that scale is zero, so nothing on the "
        + "sheet would have a size.");
    const txt = `${m[1]}" = ${m[3] ? `${m[2]}'-${m[3]}"` : `${m[2]}'`}`;
    return ok(feet / paper, txt,
      `${fmt(paper)} inch${paper === 1 ? "" : "es"} on paper = `
      + `${fmt(feet)} ft on the ground, i.e. <b>1 inch = ${fmt(feet / paper)} `
      + `ft</b>.`);
  }

  // 1:200 - the unit-free ratio. See the convention note above.
  m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (m) {
    const a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (!(a > 0) || !(b > 0))
      return bad("a ratio needs two numbers above zero, like 1:200.");
    const ft = (b / a) / 12;
    return ok(ft, `1:${fmt(b / a)}`,
      `a ratio: 1 unit of paper = ${fmt(b / a)} of the same units on the `
      + `ground. In inches that is ${fmt(b / a)} inches, i.e. <b>1 inch = `
      + `${fmt(ft)} ft</b>. If you meant 1 inch = ${fmt(b / a)} feet, type `
      + `<code>${fmt(b / a)}</code> instead.`);
  }

  // a bare number, with or without a foot mark: feet per paper inch
  m = new RegExp(String.raw`^(\d+(?:\.\d+)?)\s*(?:${SC_FEET})?$`, "i").exec(s);
  if (m) {
    const ft = parseFloat(m[1]);
    if (!(ft > 0)) return bad("zero is not a scale.");
    return ok(ft, `1" = ${fmt(ft)}'`,
      `<b>1 inch on paper = ${fmt(ft)} ft on the ground.</b>`);
  }

  // A bare fraction is the one form this refuses on purpose. `1/4` is read
  // in the trade as quarter-inch scale, but it is also just a number, and
  // this app's bare numbers are FEET per inch - so the same three keystrokes
  // could mean 4 ft per inch or 0.25. Refusing costs four keystrokes;
  // guessing costs a 16x error on every area.
  if (/^\d+\s*\/\s*\d+$/.test(s) || /^\d+[\s-]\d+\s*\/\s*\d+$/.test(s))
    return bad(`<b>${esc(s)}</b> on its own could mean ${esc(s)}" = 1'-0" or `
      + `${esc(s)} feet per inch. Write it out: <code>${esc(s)}" = 1'-0"</code>.`);
  if (/\b(m|cm|mm|metre|meter)\b/i.test(s))
    return bad("this app measures in feet per paper inch; a metric caption "
      + "is not read. Convert it, or type the ratio (1:200).");
  return bad(`not a scale this app reads. It takes <code>1" = 20'</code>, `
    + `<code>1/4" = 1'-0"</code>, a bare <code>20</code> meaning 20 feet per `
    + `paper inch, or a ratio <code>1:200</code>.`);
}

// undo target for "put it back": the scale in force before this page's box
// was used. Keyed, so it cannot leak onto another sheet.
const scaleUndo = { key: null, scale: undefined };
// is the box open, and what is half-typed in it - so a repaint from anywhere
// else (a /confidence answer, a restore) does not eat the keystrokes.
// `scaleTypedFor` is the page it was opened on: without it, opening the box,
// switching sheets and coming back would show the box still open with the
// previous sheet's half-typed number in it.
let scaleTypedOpen = false;
let scaleTypedDraft = "";
let scaleTypedFor = null;

// The ONE way a human-entered scale lands: undo capture, scaleTypedObj (which
// stamps typed_by_reviewer so the approve payload and the p<N>_scale.json
// sidecar both record whose number this is), session store, repaint. The
// typed-scale box and the measure-line calibration both commit through here -
// two entrances, one path, so they cannot drift apart.
function applyTypedScale(ft, text) {
  if (scaleUndo.key !== scaleTypedKey()) {
    scaleUndo.key = scaleTypedKey();
    scaleUndo.scale = state.result.scale || null;
  }
  state.result.scale = scaleTypedObj(state.result.scale, ft, text);
  try {
    store.setItem(scaleTypedKey(), JSON.stringify({ ft, text }));
    store.removeItem(scaleKey());
  } catch (e) { /* private mode: this session still honours it */ }
  scaleRepaint();
}

function renderScaleTyped(host) {
  if (!state.result) return;
  if (scaleTypedFor !== scaleTypedKey()) {
    scaleTypedOpen = false; scaleTypedDraft = ""; scaleTypedFor = null;
  }
  const sc = state.result.scale;
  const row = document.createElement("div");
  row.className = "sh-scales sh-typed";
  const openBox = () => {
    scaleTypedOpen = true; scaleTypedFor = scaleTypedKey(); renderSheetHead();
  };

  if (sc && sc.typed_by_reviewer) {
    const lab = document.createElement("span");
    lab.className = "sh-typed-on";
    lab.innerHTML = `scale set by hand: <b>${esc(sc.text)}</b> = `
      + `${(+sc.ft_per_paper_inch).toFixed(2)} ft/in`;
    row.appendChild(lab);
    const ch = document.createElement("button");
    ch.className = "sh-scale-pick"; ch.textContent = "change";
    ch.onclick = openBox;
    row.appendChild(ch);
    // Undo is offered ONLY back to a reading the engine actually made.
    //
    // Undoing to NOTHING would put the screen and the deliverable at odds,
    // which is the one thing _page_scale exists to prevent: approving a
    // screen with no scale sends `scale: null`, and the server then honours
    // the pick already recorded for the page (its "an older UI, or a
    // re-approve from a script" branch). The export would quote the typed
    // number under a screen that says the sheet has none. There is no way
    // to retire a record from here without inventing a second write path,
    // so the button is simply not offered - to change the number, press
    // `change` and type another. See VERIFY.md.
    if (scaleUndo.key === scaleTypedKey() && scaleUndo.scale
        && +scaleUndo.scale.ft_per_paper_inch > 0) {
      // What it goes back to is whatever the screen was showing before this
      // page's box was used - usually the engine's reading, but on a second
      // edit it is the reviewer's previous number, so the wording must not
      // claim the engine said it.
      const prev = scaleUndo.scale;
      const prevFt = (+prev.ft_per_paper_inch).toFixed(2);
      const whose = prev.typed_by_reviewer ? "set by hand earlier"
        : prev.picked_by_reviewer ? "the reading you had picked"
        : "the reading the engine made";
      const un = document.createElement("button");
      un.className = "sh-scale-pick"; un.textContent = "put it back";
      un.title = `back to ${prevFt} ft/in - ${whose}`;
      un.onclick = () => {
        state.result.scale = prev;
        try {
          if (prev.typed_by_reviewer)
            store.setItem(scaleTypedKey(), JSON.stringify(
              { ft: +prev.ft_per_paper_inch, text: prev.text }));
          else store.removeItem(scaleTypedKey());
        } catch (e) { /* private mode */ }
        scaleUndo.key = null; scaleUndo.scale = undefined;
        scaleTypedOpen = false;
        setStatus(`back to ${prevFt} ft per inch — ${whose}. Approve to make `
          + `that this page's record.`);
        scaleRepaint();
      };
      row.appendChild(un);
    }
  } else if (!scaleTypedOpen) {
    const lab = document.createElement("span");
    lab.className = "dim";
    lab.textContent = sc
      ? "the reading above is wrong?"
      : "nothing on this sheet says what it was drawn to.";
    const b = document.createElement("button");
    b.className = "sh-scale-pick sh-scale-set";
    b.textContent = sc ? "set the scale by hand" : "type the scale";
    b.onclick = openBox;
    row.append(lab, b);
  }

  if (scaleTypedOpen) {
    const ed = document.createElement("div");
    ed.className = "sh-typed-edit";
    const inp = document.createElement("input");
    inp.type = "text"; inp.className = "sh-typed-in";
    inp.placeholder = `1" = 20'`;
    inp.setAttribute("value", scaleTypedDraft);
    inp.value = scaleTypedDraft;
    const use = document.createElement("button");
    use.className = "sh-scale-pick"; use.textContent = "use this";
    const cancel = document.createElement("button");
    cancel.className = "sh-scale-pick"; cancel.textContent = "cancel";
    const echo = document.createElement("div");
    echo.className = "sh-typed-echo";
    const bar = document.createElement("div");
    bar.className = "sh-typed-bar";
    bar.append(inp, use, cancel);
    ed.append(bar, echo);
    row.appendChild(ed);

    // The echo is the whole safety story of this box: the operator sees the
    // interpretation in words BEFORE the number touches a quantity.
    const reread = () => {
      scaleTypedDraft = inp.value;
      const p = parseScale(inp.value);
      if (p.err === "") { echo.className = "sh-typed-echo"; echo.innerHTML =
        `accepted: <code>1" = 20'</code> · <code>1/4" = 1'-0"</code> · `
        + `<code>20</code> (feet per paper inch) · <code>1:200</code>`;
      } else if (p.err) {
        echo.className = "sh-typed-echo bad";
        echo.innerHTML = "won't use that — " + p.err;
      } else {
        echo.className = "sh-typed-echo ok";
        echo.innerHTML = "reads as " + p.said
          + ` Nothing on this sheet corroborates it.`;
      }
      use.disabled = !!(p.err || p.err === "");
      return p;
    };
    inp.oninput = reread;
    // The app's single-key review shortcuts are already held off by
    // typing() while an <input> has focus; this only adds the two keys a
    // one-line form is expected to answer to.
    inp.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); use.onclick(); }
      if (e.key === "Escape") { e.preventDefault(); cancel.onclick(); }
    };
    cancel.onclick = () => {
      scaleTypedOpen = false; scaleTypedDraft = "";
      renderSheetHead();
    };
    use.onclick = () => {
      const p = reread();
      if (p.err || p.err === "") { inp.focus(); return; }
      applyTypedScale(p.ft, p.text);
      scaleTypedOpen = false; scaleTypedDraft = "";
      setStatus(`scale set BY HAND to ${p.ft.toFixed(2)} ft per inch — every `
        + `quantity on this sheet recalculated from a number you typed, not `
        + `one the sheet states`);
    };
    reread();
    setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
  }
  host.appendChild(row);
}

// Everything downstream of the scale, repainted. Same list the candidate
// picker uses, so the two paths can never disagree about what is stale.
function scaleRepaint() {
  renderSheetHead(); renderStyles(); renderAreas(); renderItemized();
  renderMiniLegend(); draw();
  // Cut/fill does NOT follow a scale change - the surfaces are integrated
  // server-side at whatever scale was in force when Calculate was pressed
  // (see ewScaleStale). The warning banner existed for exactly this case but
  // was only painted by the Calculate handler itself, so the natural order -
  // Calculate, notice the lengths look wrong, correct the scale - repainted
  // the stale cubic yards as priced rows with no banner at all. Volume moves
  // with the SQUARE of the scale; a silent 2x here is 4x on every CY.
  renderEwStale();
}

// Restore a scale a reviewer set on an EARLIER visit to this page. The
// browser's own memory is a session Map (see `store`), so a reload forgets
// it; the durable record is the server sidecar `p<N>_scale.json` that
// approve writes, and GET .../scale was built to hand it back. A pick made
// in THIS session is newer and wins, so the restore stands down when the
// session already holds one.
async function scaleRestore(gen) {
  const job = state.job, page = state.page;
  let live = false;
  try {
    live = !!(store.getItem(scaleTypedKey()) || store.getItem(scaleKey()));
  } catch (e) { live = false; }
  if (live) return;
  let j;
  try {
    const r = await fetch(`/api/job/${job}/page/${page}/scale`);
    if (!r.ok) return;
    j = await r.json();
  } catch (e) { return; }
  if (gen !== state.gen || !state.result) return;   // page changed under us
  const rv = j && j.reviewer;
  const ft = rv && scaleSane(rv.ft_per_paper_inch);
  if (!ft) return;
  const sc = state.result.scale;
  if (sc && Math.abs(+sc.ft_per_paper_inch - ft) < 1e-9) return;
  // Was it typed, or picked off a printed caption? The sidecar does not say,
  // and it must not be invented: if the value matches a reading the engine
  // found, restore it as a PICK; otherwise no caption on this sheet says it,
  // which is what "typed" means.
  const hit = (sc && sc.candidates || []).find(
    c => c && Math.abs(+c.ft_per_paper_inch - ft) < 1e-6);
  if (hit) {
    state.result.scale = Object.assign({}, sc, {
      text: hit.text, ft_per_paper_inch: hit.ft_per_paper_inch,
      count: hit.count, agrees: null, delta_pct: null,
      picked_by_reviewer: true, typed_by_reviewer: false,
    });
    try { store.setItem(scaleKey(), String(hit.ft_per_paper_inch)); } catch (e) {}
  } else {
    const text = (rv.text || "").trim() || `1" = ${(+ft).toFixed(2)}'`;
    state.result.scale = scaleTypedObj(sc, ft, text);
    try { store.setItem(scaleTypedKey(), JSON.stringify({ ft: ft, text: text })); }
    catch (e) {}
  }
  setStatus(`scale restored from this page's approved record: `
    + `${(+ft).toFixed(2)} ft per inch, set by the reviewer`);
  scaleRepaint();
}

// ---------- the confidence banner ----------------------------------------
// This engine's dangerous failure mode is not being wrong. It is being wrong
// QUIETLY: F92 shipped 14 pages whose scale was wrong and every one reached
// this screen as a confident green chip. A wrong number that looks right
// costs the manual work the estimator was already doing PLUS the time to
// catch it - and if it is missed it goes into a bid. So the review panel
// opens with a plain-English statement of what corroborates this sheet and
// what does not, above everything that depends on it.
//
// The colour rule is the contract, and it is deliberately pessimistic:
//   GREEN  only where a SECOND, INDEPENDENT source agrees with the first
//          (the drawn scale bar against the printed caption; the sheet's own
//          printed "N sf" area tags against the scale in force; a datum the
//          sheet states in its own legend)
//   AMBER  one source only, or a choice the reviewer has to make
//   RED    two sources contradict each other, or there is no scale at all
// Absence of evidence is never green. Where nothing corroborates a number
// the banner says so in words rather than staying silent.
//
// Reporting only: nothing here changes a quantity, a detection or a pick.

const CONF_RANK = { ok: 0, warn: 1, stop: 2 };

// 20 -> "20", 5.333 -> "5.33", 0.667 -> "0.67". Estimators read feet per
// paper inch, never a 3-decimal float.
function confFt(v) {
  const n = +v;
  if (!isFinite(n)) return "?";
  return n.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}
function confScale(v) { return `1 inch = ${confFt(v)} ft`; }
// The sheet's own words, set apart without quote marks: a caption like
// 1" = 1'-0" ends in an inch mark, and “...” around it prints a stray
// double quote in the sentence the estimator most needs to read.
function confQuote(t) { return `<span class="conf-q">${esc(t)}</span>`; }
function confPlural(n, one, many) { return n === 1 ? one : (many || one + "s"); }

// The sheet's own printed "N sf" area tags are a THIRD reading of the scale,
// independent of both the caption and the drawn bar: they are areas the
// drafter typed, measured against regions we traced. areas.py already
// computes what they imply, and that number does not depend on the scale we
// chose - so it is compared against the scale in force RIGHT NOW and a
// reviewer's pick re-runs the check instead of inheriting the engine's.
function confTagCheck() {
  const res = state.result;
  const sc = res && res.scale;
  const tc = ((res && res.areas && res.areas.scale) || {}).tag_check || {};
  if (!sc || !sc.ft_per_paper_inch) return null;
  if (!tc.implied_ft_per_paper_inch || !tc.n_matched) return null;
  const d = Math.abs(tc.implied_ft_per_paper_inch - sc.ft_per_paper_inch)
    / sc.ft_per_paper_inch;
  return { tc, agrees: d <= 0.02, implied: tc.implied_ft_per_paper_inch,
           ratio: Math.pow(tc.implied_ft_per_paper_inch / sc.ft_per_paper_inch, 2) };
}

// Why the engine used the scale it used - READ from what the engine reports,
// not replayed from the candidate list.
//
// This function used to re-run scale_detect._choose's ranking in JavaScript.
// That stopped being the truth when scale_detect gained `_rank`: a sheet
// printing several scales is now ranked by how much of the DRAWING sits under
// each caption's title bar, and `ScaleResult.pick` states the outcome. A
// replay is wrong two ways against that engine, and the second way is worse.
// Measured over the whole plan corpus - 6,714 pages, 67 of which print two or
// more distinct scales and so render the banner block below
// (out/verify/2026-08-23/pickwhy/work/replay_vs_read.log):
//
//   26 pages  the replay does not land on the scale in force and falls to
//             its honest "we cannot show what picked it" arm. Wasteful.
//   41 pages  the replay DOES land on it and names a mechanism the engine no
//             longer uses - 25 "its text matched more times than the others",
//             6 "the only one printed next to the word SCALE", and 10 "nothing
//             on the sheet separated them, so the pick fell to whichever the
//             reader reached first" on pages the engine had in fact ranked
//             (63.8% against 36.2% on two of them). A false mechanism, printed
//             on the one line whose whole job is to tell the estimator how far
//             to trust the pick - and the last of the three is false in the
//             other direction, manufacturing doubt about a measured answer.
//
// So: read `pick`, and where it says anything this function does not
// recognise, abstain. `pick.why` is one of:
//   "governs"   ranked by the linework each printed caption governs; with
//               `governs_pct`, `runner_up`, `runner_up_pct`, `margin`,
//               `unassigned_pct`
//   "unranked"  no ranking could be made - `reason` says what stopped it, and
//               the value in force is the OLD keyword-then-count order, which
//               must be presented as UNCHECKED rather than explained
//   "single"    one distinct value - nothing to rank
//   "bar"       the drawn graphic bar; no printed caption at all
//
// One thing this must never quote as a number: `count`. It counts REGEX
// MATCHES, not captions printed on paper - _scan runs several patterns over
// the same text - so no branch below turns it into "printed N times". Each
// candidate now also carries `sites`, which IS the printed-location count:
// on all 11 candidates of Barn Landscaping engine page indices 29, 18 and 27,
// `sites` equals pymupdf page.search_for's own count of the caption on the
// page and `count` is exactly 2x it (A8_DEFERRED_picker_tooltip_counts.png).
// `sites` is still not quoted below - the governed SHARE is the story, and a
// second tally on the same line invites the reader straight back into the
// count reasoning this change exists to remove.

// Below what margin does "we picked this" become "we could not really tell"?
//
// `margin` is the winner's governed linework divided by the runner-up's. Two
// things fix where the copy has to change.
//
// 1. What the sentence claims. "It barely leads" has to be TRUE where it
//    fires. A runner-up governing more than two thirds of what the winner
//    governs is a lead worth calling thin; at 66.1% against 33.9% - a clean
//    2:1 - it is not, and saying so would be over-warning on a banner whose
//    warnings have to keep meaning something. Two thirds is margin 1.5.
//
// 2. Where the corpus actually separates. Of the 67 multi-scale pages, the 59
//    with a finite margin run 1.02, 1.16, 1.26, 1.29 | 1.75, 1.76, 1.76, 1.93,
//    1.95, 2.08, 2.18, ... (margins_full.json). The widest gap anywhere below
//    4.0 is that one, 1.29 -> 1.75, and 1.5 sits inside it - 0.21 clear of the
//    page below, 0.25 clear of the page above. It is not one drafter's habit
//    either: the four pages under it come from three documents in two separate
//    corpora, the three over it from two more.
//
// What this number does NOT do is make the pick reliable, and the measurement
// says so plainly. The app ranks on a PROXY - raw stroke units, because
// detect_page calls detect_scale without the page's live chains. Re-ranking
// every corpus page reported at 8.5 or under on those chains instead
// (proxy_shift.log, 37 pages) moves the margin by 0.54x to 2.14x, and on 2 of
// the 37 the two measures do not even agree WHICH scale wins - at reported
// margins of 1.02 and 2.33. So:
//   - the 1.02 page is caught here;
//   - the 2.33 page (Town Pump 007^S-01 New Foundation p0, reported 2.33,
//     1.09 the other way on chains) is NOT, and nothing below 2.35 would
//     catch it - at which point "barely leads" would be firing on 2:1 leads
//     and claim (1) would be false. Left uncaught deliberately;
//   - two more read clear here and thin on chains (061^S2.1 p0 1.75 -> 1.38,
//     Barn Landscaping p27 1.93 -> 1.45), and two read thin on this side of
//     nothing and clearer on chains (the Church p3 pair, 1.76 -> 1.93).
// That residue is why the clear arm below states the mechanism and both
// shares instead of asserting confidence, and why BOTH arms stay amber. The
// threshold moves emphasis, never the colour, and never which scale is in
// force - so it cannot move a quantity.
//
// Direction of error is chosen: calling a decisive lead thin costs the
// estimator a moment; calling a thin lead decisive is a confident wrong story.
const PICK_THIN_MARGIN = 1.5;

function scalePickWhy() {
  const sc = state.result && state.result.scale;
  if (!sc || !sc.ft_per_paper_inch) return null;
  const p = sc.pick;
  if (!p || typeof p !== "object" || !p.why) return { kind: "unknown" };
  if (p.why === "single" || p.why === "bar") return { kind: p.why };
  if (p.why === "unranked")
    return { kind: "unranked", reason: String(p.reason || "") };
  if (p.why !== "governs") return { kind: "unknown" };
  const pct = +p.governs_pct;
  const runnerPct = +p.runner_up_pct;
  const runnerUp = +p.runner_up;
  if (!isFinite(pct) || !isFinite(runnerPct) || !isFinite(runnerUp))
    return { kind: "unknown" };
  // `pick` describes the value the ENGINE ranked first. If the scale in force
  // is not that value the story belongs to a different number, so abstain
  // rather than attach it - the same refusal the replay made, kept. (A
  // reviewer's own pick is caught before this is called; this guards every
  // other way the two can come apart.) governs_pct 0.0 is a MEASURED zero, so
  // the winner's share is tested for null, never for truthiness.
  const win = (sc.candidates || []).find(
    c => c && Math.abs(+c.ft_per_paper_inch - +sc.ft_per_paper_inch) < 1e-6);
  const wg = (win && win.governs_pct !== null && win.governs_pct !== undefined)
    ? +win.governs_pct : null;
  if (wg === null || !isFinite(wg) || Math.abs(wg - pct) > 0.05)
    return { kind: "unknown" };
  // margin is null when the runner-up governs nothing at all: the most
  // decisive case there is, never the thin one. Test for null, not falsiness.
  const margin = (p.margin === null || p.margin === undefined
                  || !isFinite(+p.margin)) ? null : +p.margin;
  const un = +p.unassigned_pct;
  return { kind: "governs", pct: pct, runnerUp: runnerUp,
           runnerPct: runnerPct, margin: margin,
           thin: margin !== null && margin <= PICK_THIN_MARGIN,
           unassigned: (isFinite(un) && un > 0) ? un : 0 };
}

function confLines() {
  const out = [];
  const say = (level, html) => out.push({ level, html });
  const res = state.result;
  if (!res) return out;
  const sc = res.scale;
  const cf = state.conf;
  const tag = confTagCheck();
  const uniq = scaleCandidates();

  // ---- scale: the number every length, area and volume sits on ----------
  if (!sc) {
    say("stop", `<b>No scale could be read off this sheet.</b> Until one `
      + `is set, nothing here can be quoted in feet, square feet or cubic `
      + `yards — the lengths below are paper measurements of the drawing, `
      + `not real-world distances. Set the scale by hand before pricing `
      + `anything from this sheet: the reader does miss captions that are `
      + `printed, so check the sheet itself rather than assuming it has none.`);
    if (cf && cf.has_nts)
      say("stop", `The sheet also prints <b>NOT TO SCALE</b>. If that note `
        + `covers the drawing rather than one detail on it, measuring it is `
        + `unsafe even by hand — take the numbers written on the drawing.`);
  } else if (sc.typed_by_reviewer) {
    // AMBER, and FIRST of the branches that can be reached with a scale in
    // force - before the two that can print green. Green's contract is a
    // SECOND, INDEPENDENT source; a number typed by hand is not a source at
    // all, it is the reviewer's word. scaleTypedObj already clears `agrees`
    // and `delta_pct`, so green is unreachable that way too, but the
    // ordering makes the guarantee structural rather than incidental.
    const was = (scaleUndo.key === scaleTypedKey() && scaleUndo.scale
                 && +scaleUndo.scale.ft_per_paper_inch)
      ? ` It replaces the <span class="conf-num">`
        + `${confScale(scaleUndo.scale.ft_per_paper_inch)}</span> this screen `
        + `was showing before you typed.`
      : ``;
    say("warn", `<b>Scale set by hand: <span class="conf-num">`
      + `${confScale(sc.ft_per_paper_inch)}</span></b> (you typed `
      + `${confQuote(sc.text)}). <b>Nothing on the sheet corroborates it</b> — `
      + `no printed caption, no drawn scale bar and no printed area figure `
      + `has been matched against this number. Every length, area and volume `
      + `below is computed from it, and the exported takeoff and the report `
      + `PDF both say on their face that the reviewer set it.` + was);
  } else if (sc.agrees === false) {
    say("stop", `<b>Two readings of this sheet's scale disagree — settle `
      + `this before pricing.</b> The printed caption reads `
      + `${confQuote(sc.text)}, which is <span class="conf-num">`
      + `${confScale(sc.ft_per_paper_inch)}</span>. The ruler drawn on the `
      + `sheet measures <span class="conf-num">`
      + `${confScale(sc.bar_ft_per_paper_inch)}</span> — they are `
      + `${confFt(sc.delta_pct)}% apart. One of them is wrong, and every `
      + `length, area and volume below is wrong with it. We used the caption.`);
  } else if (sc.agrees === true) {
    say("ok", `<b>Scale confirmed two ways: <span class="conf-num">`
      + `${confScale(sc.ft_per_paper_inch)}</span>.</b> The sheet prints it `
      + `in words (${confQuote(sc.text)}) and the ruler drawn on the sheet `
      + `measures the same thing. Two independent readings agree.`);
  } else if (sc.picked_by_reviewer) {
    say("warn", `<b>You set this sheet to <span class="conf-num">`
      + `${confScale(sc.ft_per_paper_inch)}</span></b> (${confQuote(sc.text)}). `
      + `Nothing on the sheet has been checked against that choice — every `
      + `number below is computed from it.`);
  } else if (sc.source === "ocr") {
    say("warn", `<b>The scale was read off a scanned picture, not from the `
      + `drawing's own text: <span class="conf-num">`
      + `${confScale(sc.ft_per_paper_inch)}</span></b> (recognised as `
      + `${confQuote(sc.text)}). Character recognition is the least trustworthy `
      + `reading this app has, and nothing else found on this sheet backs it `
      + `up. Check it against a dimension printed on the drawing.`);
  } else if (sc.source === "graphic-bar") {
    say("warn", `<b>No scale caption was found on this sheet, so the ruler `
      + `drawn on it was measured instead: <span class="conf-num">`
      + `${confScale(sc.ft_per_paper_inch)}</span>.</b> That number comes `
      + `from the spacing of the bar's tick marks. It is one reading, with `
      + `nothing to confirm it.`);
  } else {
    say("warn", `<b>Scale taken from one printed caption: `
      + `<span class="conf-num">${confScale(sc.ft_per_paper_inch)}</span></b> `
      + `(the sheet reads ${confQuote(sc.text)}). No drawn scale bar and no `
      + `printed area figure were found here, so there is nothing on the `
      + `sheet to check that caption against.`);
  }

  // ---- several scales printed: which one governs the drawing? -----------
  // The reason clause states what the ENGINE reports it keyed on, branch by
  // branch, and REFUSES to give one where nothing decided. A fabricated
  // mechanism is at its most expensive inside the sentence whose whole job
  // is to teach the estimator to distrust the pick.
  if (sc && uniq.length > 1) {
    const lo = Math.min(...uniq.map(c => +c.ft_per_paper_inch));
    const hi = Math.max(...uniq.map(c => +c.ft_per_paper_inch));
    const used = `<span class="conf-num">`
      + `${confScale(sc.ft_per_paper_inch)}</span>`;
    const head = `<b>This sheet prints ${uniq.length} different scales</b>, `
      + `from <span class="conf-num">${confScale(lo)}</span> to `
      + `<span class="conf-num">${confScale(hi)}</span> — a plan and its `
      + `details, usually. `;
    const swap = ` The buttons just above switch it, and everything `
      + `recalculates.`;
    const why = sc.typed_by_reviewer ? { kind: "typed" }
      : sc.picked_by_reviewer ? { kind: "reviewer" } : scalePickWhy();
    const kind = (why && why.kind) || "unknown";
    if (kind === "typed") {
      // none of them: the number in force is not one of the readings this
      // sheet prints, so "you picked" would be false
      say("warn", head + `You are using ${used}, which is <b>none of them</b> `
        + `— you typed it. The buttons just above switch to a printed `
        + `reading instead, and everything recalculates.`);
    } else if (kind === "reviewer") {
      say("warn", head + `You picked ${used}.` + swap);
    } else if (kind === "governs") {
      const other = `<span class="conf-num">${confScale(why.runnerUp)}</span>`;
      const share = `<span class="conf-num">${confFt(why.pct)}%</span>`;
      const oshare = `<span class="conf-num">${confFt(why.runnerPct)}%</span>`;
      // DENOMINATORS, because the engine reports these two out of different
      // wholes and a sentence that blurs them is a wrong number:
      //   governs_pct / runner_up_pct  are shares of the linework that sits
      //     under SOME caption ("assigned"), so both are introduced that way;
      //   unassigned_pct is a share of the whole drawing - assigned plus
      //     unassigned - the title-block strip having been cut off as sheet
      //     furniture and counted in neither.
      // So `rest` says "of the drawing", the shares say "of what sits under a
      // caption", and the two never get added together. This is not academic:
      // 8 of the corpus' 67 multi-scale pages are plan-and-profile sheets
      // whose winner takes 100% of the assigned linework while 41-52% of the
      // drawing sits under no caption at all - there, 100% means under half
      // the sheet, and any phrasing like "most of the drawing belongs to it"
      // would be plainly false. Hence "more ... than under any other".
      const rest = why.unassigned
        ? ` A further ${confFt(why.unassigned)}% of the drawing on this sheet `
          + `sat under no caption at all, and is outside both figures.`
        : ``;
      if (why.thin) {
        say("warn", head + `We used ${used}, but <b>it barely leads</b>. Of `
          + `the drawing that sits under a scale caption, ${share} sits under `
          + `that one and ${oshare} under ${other} — close enough that `
          + `measuring this sheet a slightly different way could put the `
          + `other one in front.${rest} <b>Treat the choice as unsettled:</b> `
          + `set the scale for the drawing you are actually taking off, with `
          + `the buttons just above.`);
      } else {
        say("warn", head + `We used ${used} because more of this drawing sits `
          + `under its caption than under any other: of the linework sitting `
          + `under a scale caption, ${share} sits under that one, against `
          + `${oshare} under ${other}. That is measured from where the `
          + `drawings sit on the page — not from how often the caption is `
          + `printed.${rest}` + swap);
      }
    } else if (kind === "unranked") {
      const r = why.reason || "";
      let stopped;
      if (r === "tie")
        stopped = `Two of them cover so nearly the same amount of this `
          + `drawing that nothing on the sheet separates them.`;
      else if (r === "compound caption")
        stopped = `One printed caption gives two different scales on the one `
          + `line — the way a profile prints its sideways scale and its `
          + `up-and-down scale together — so there is no telling which of `
          + `them the drawing under it was drawn to.`;
      else if (r.indexOf("no caption located") === 0)
        stopped = `One of the scales this sheet prints could not be found `
          + `anywhere on the page, so there was nothing to measure it `
          + `against.`;
      else if (r === "no linework beneath any caption")
        stopped = `None of the captions has any drawing beneath it that `
          + `could be measured.`;
      else if (r === "no geometry" || r.indexOf("geometry failed") === 0)
        stopped = `This sheet's linework could not be measured.`;
      else
        stopped = `Something on this sheet stopped that measurement.`;
      say("warn", head + `<b>We could not work out which of them governs `
        + `this drawing.</b> ${stopped} So ${used} is in force only because `
        + `of the older rule — the reading printed next to the word SCALE, `
        + `then the one whose text matched most often while the sheet was `
        + `read — and neither of those says which drawing a caption belongs `
        + `to. <b>Treat it as unchecked:</b> set the scale for the drawing `
        + `you are taking off, with the buttons just above.`);
    // "single" and "bar" are DEFENSIVE, and neither fires on any page of the
    // corpus. The two counts disagree only at the edges: the engine calls a
    // sheet "single" when its readings match to 4 decimal places, this block
    // renders when any two differ by 1e-6, so "single" reaches here only for
    // a pair between those - and "bar" reaches here never, because a graphic
    // -bar result carries exactly one candidate and this block needs two.
    // Both are kept so that if the engine ever does hand the banner one, it
    // says something true instead of abstaining. Exercised synthetically only
    // (out/verify/2026-08-23/pickwhy/).
    } else if (kind === "single") {
      say("warn", head + `Those readings all come out to the same scale once `
        + `rounded, so there was nothing to choose between them. We used `
        + `${used}.` + swap);
    } else if (kind === "bar") {
      say("warn", head + `No scale caption was read on this sheet, so the `
        + `ruler drawn on it was measured instead: ${used}.` + swap);
    } else {
      say("warn", head + `We used ${used}. <b>We cannot show what picked it</b> `
        + `out of what this sheet gave us, so treat that as unchecked: `
        + `confirm the scale that governs the drawing you are taking off, `
        + `with the buttons just above.`);
    }
  }

  // ---- the sheet's own printed areas, checked against that scale --------
  if (tag && tag.agrees) {
    say("ok", `<b>Checked against the sheet's own figures.</b> `
      + `${tag.tc.n_matched} area${confPlural(tag.tc.n_matched, "")} printed `
      + `on this page as “N sf” agree with what we measured at this scale, `
      + `within 2%.`);
  } else if (tag) {
    say("stop", `<b>The sheet's own square-foot figures contradict the `
      + `scale.</b> ${tag.tc.n_matched} area`
      + `${confPlural(tag.tc.n_matched, "")} printed on this page imply `
      + `<span class="conf-num">${confScale(tag.implied)}</span>, not the `
      + `<span class="conf-num">${confFt(sc.ft_per_paper_inch)} ft</span> we `
      + `used — so every square-foot number below is out by roughly `
      + `${tag.ratio >= 10 ? Math.round(tag.ratio) : tag.ratio.toFixed(1)}`
      + ` times.`);
  }

  // ---- NOT TO SCALE printed alongside a scale ---------------------------
  if (sc && ((cf && cf.has_nts) || sc.has_nts))
    say("warn", `<b>The sheet also says NOT TO SCALE somewhere.</b> That is `
      + `normally a detail or an inset declaring that it alone must not be `
      + `measured. If it covers the drawing you are taking off, the scale `
      + `above does not apply to it.`);

  // ---- spot elevations: whose datum? ------------------------------------
  // The distinction is worth 200 ft an elevation. A sheet printing
  // "FG: 05.25" is missing its hundreds; the sheet's own legend note is the
  // drafter telling us what they are, while consensus off other numbers on
  // the page is arithmetic that has already come out a clean 200 ft wrong on
  // a sheet in this client's set - with every value still reading as a
  // plausible elevation. See takeoff_engine/earthwork.read_spot_datum.
  const sp = cf && cf.spots;
  if (sp && sp.n) {
    // A sheet can disagree WITH ITSELF: Barn C3.3's legend note reads 7605.25
    // while its own printed contours sit at 7720-7735. The old banner called
    // the note "the drafter's statement" unconditionally and coloured it
    // green - over 171 elevations that were exactly 100 ft low. When the two
    // sources conflict, say so first, in warn colour, with both numbers.
    const dtm = sp.datum;
    if (dtm && dtm.conflict)
      say("warn", `<b>This sheet disagrees with itself about the spot-`
        + `elevation datum.</b> Its legend note reads <span class="conf-num">`
        + `${confFt(dtm.declared)} ft</span>, but ${dtm.band_n} full `
        + `elevation${confPlural(dtm.band_n, "")} printed on the drawing sit`
        + `${dtm.band_n === 1 ? "s" : ""} in the <span class="conf-num">`
        + `${confFt(dtm.band_base)} ft</span> band. Using <b>`
        + `${confFt(dtm.chosen === "band" ? dtm.band_base : dtm.declared)} ft`
        + `</b>. Check one printed elevation by eye before pricing anything `
        + `built on these.`);
    if (sp.from_sheet_note && !(dtm && dtm.conflict))
      say("ok", `<b>${sp.from_sheet_note} spot elevation`
        + `${confPlural(sp.from_sheet_note, "")} read from this sheet.</b> `
        + `The sheet prints them shortened, and its own legend states what `
        + `they count up from (<span class="conf-num">`
        + `${confFt(sp.declared_datum)} ft</span>). That is the drafter's `
        + `statement, not our arithmetic.`);
    if (sp.printed_in_full)
      say("ok", `<b>${sp.printed_in_full} spot elevation`
        + `${confPlural(sp.printed_in_full, "")} printed in full</b> on the `
        + `sheet — nothing about ${confPlural(sp.printed_in_full, "it", "them")}`
        + ` had to be worked out.`);
    if (sp.inferred && dtm && dtm.conflict)
      // The conflict banner above already carries the story; this one must
      // not claim "no note could be read" when a note WAS read and overruled.
      say("warn", `<b>${sp.inferred} spot elevation`
        + `${confPlural(sp.inferred, "")} anchored to the sheet's printed `
        + `elevations</b> after its legend note was overruled (above). `
        + `Confirm one against an elevation you can read before trusting `
        + `any cut or fill volume.`);
    if (sp.inferred && !(dtm && dtm.conflict))
      say("warn", `<b>${sp.inferred} spot elevation`
        + `${confPlural(sp.inferred, "")} rest on a guess.</b> The sheet `
        + `prints them shortened (“FG: 15.96”) and no note saying what the `
        + `missing hundreds are could be read, so they were worked out `
        + `instead from other numbers `
        + `printed on the page. That guess has come out a clean 200 ft high `
        + `on a sheet in this same set, and every value still looked like a `
        + `plausible elevation. Confirm one against an elevation you can `
        + `read before trusting any cut or fill volume.`);
    if (sp.unresolved)
      say("warn", `<b>${sp.unresolved} spot elevation`
        + `${confPlural(sp.unresolved, "")} could not be turned into real `
        + `elevations at all.</b> The sheet prints them shortened and there `
        + `is nothing readable on the page to say what the missing `
        + `hundreds are. Type `
        + `the base elevation in the Earthwork panel; until then those `
        + `points carry no height.`);
  }

  // ---- checks that have not answered yet, or could not be run -----------
  // /confidence carries the four spot-elevation lines and the NOT-TO-SCALE
  // note, and it costs a page parse (0.4-2.7 s measured). Until it lands
  // this page has NOT been checked for a guessed elevation datum, so the
  // banner says so in a line and the badge above says so too. Absence of
  // evidence is never green, and "not looked yet" is not evidence.
  if (!cf) {
    if (state.confErr)
      say("warn", `<b>Two of the checks on this sheet could not be run.</b> `
        + `The reader that says where each spot elevation's base height came `
        + `from, and whether the sheet prints NOT TO SCALE, did not answer. `
        + `Nothing here has ruled out a guessed elevation datum on this `
        + `page. Reload the sheet before pricing any cut or fill from it.`);
    else
      say("warn", `<b>Still checking this sheet.</b> Where each spot `
        + `elevation's base height came from, and whether NOT TO SCALE is `
        + `printed anywhere, are still being read off the page. Until they `
        + `land this sheet has not been checked for either, so nothing above `
        + `is the final word on it.`);
  }

  // ---- anything else already known to be shaky on this page -------------
  const trunc = (res.areas || {}).truncated || 0;
  if (trunc)
    say("warn", `<b>${trunc} filled area${confPlural(trunc, "")} on this `
      + `page ${trunc === 1 ? "was" : "were"} not measured</b> — the page `
      + `carries more shaded regions than the reader takes in one pass, so `
      + `the square-foot list below is incomplete.`);

  // Repeated shapes the symbol reader counted but nothing named. An
  // unnamed group means no mark code was found inside the shape (see
  // server._symbols_compute._mark_at) - NOT that a code was read badly.
  // Only known once the Counts panel has been opened, so the banner gains
  // this line then rather than claiming a clean page it has not looked at.
  if (state.sym && state.sym.length) {
    const un = state.sym.filter(g => !g.name && !g.off_schedule)
      .reduce((a, g) => a + g.n, 0);
    if (un)
      say("warn", `<b>${un} repeated shape${confPlural(un, "")} on this page `
        + `${un === 1 ? "was" : "were"} counted but not identified.</b> `
        + `${un === 1 ? "It was" : "They were"} found by shape, and no `
        + `name for ${un === 1 ? "it" : "them"} was found on the sheet — no `
        + `mark code `
        + `(the “W-3” a drafter writes inside a bubble) is printed inside. `
        + `${un === 1 ? "It sits" : "They sit"} unnamed in the Counts panel `
        + `and ${un === 1 ? "is" : "are"} in no takeoff row until you name `
        + `${un === 1 ? "it" : "them"}.`);
  }
  return out;
}

// One fetch per page for the two facts the stored result cannot carry.
// Async on purpose: the banner paints immediately from the detect result and
// gains the elevation and NOT-TO-SCALE lines a second later, rather than
// making every page switch wait on a page parse. What it must NOT do is
// present a verdict during that window - see renderConfidence.
//
// A failure repaints too. Leaving state.conf null on a 503 used to be called
// "degrading softly", but it is the same lie held forever: the four
// elevation lines simply never arrive and a scale-corroborated grading sheet
// sits there green.
async function confLoad(gen, key) {
  let j = null;
  try {
    const r = await fetch(`/api/job/${state.job}/page/${state.page}/confidence`);
    if (r.ok) j = await r.json();
  } catch (e) { /* network/parse: falls through to the failed branch */ }
  if (gen !== state.gen || key !== state.confKey) return;   // a later page won
  if (j) state.conf = j; else state.confErr = true;
  renderConfidence();
}

function renderConfidence() {
  const box = $("confBanner");
  if (!box) return;
  if (!state.result) { box.hidden = true; box.innerHTML = "";
    renderCheckQueue(); return; }   // hides the review queue too
  const key = state.job + ":" + state.page;
  if (state.confKey !== key) {
    state.confKey = key; state.conf = null; state.confErr = false;
    confLoad(state.gen, key);
  }
  const lines = confLines();
  if (!lines.length) { box.hidden = true; box.innerHTML = ""; return; }
  // The worst line sets the banner, and green needs a positive: a page whose
  // every line is merely "nothing contradicts this" is amber, not green.
  let worst = "ok";
  for (const l of lines) if (CONF_RANK[l.level] > CONF_RANK[worst]) worst = l.level;
  if (worst === "ok" && !lines.some(l => l.level === "ok")) worst = "warn";
  // A verdict is only a verdict once the checks it depends on have answered.
  // While /confidence is outstanding the banner starts UNRESOLVED and can
  // only move toward green from there; it never opens on a claim it has to
  // take back. Measured before this: Barn Civil engine p4 painted "conf ok /
  // CORROBORATED" at t=210 ms and dropped to "conf warn / check first" at
  // t=1373 ms - 1.16 s warm, 2.7 s cold - labelling a page whose 104
  // elevations rest on the consensus guess as corroborated. 5 of the 182
  // client pages did that.
  const waiting = !state.conf && !state.confErr;
  const badge = waiting ? "checking…"
    : { ok: "corroborated", warn: "check first", stop: "stop" }[worst];
  box.hidden = false;
  box.className = "conf " + worst + (waiting ? " checking" : "");
  box.innerHTML =
    `<div class="conf-head"><span class="conf-badge `
    + `${waiting ? "checking" : worst}">${badge}</span>`
    + `<span class="conf-title">Before you price this sheet</span></div>`
    + lines.map(l => `<div class="conf-line ${l.level}">`
        + `<span class="conf-dot ${l.level}"></span>`
        + `<span class="conf-txt">${l.html}</span></div>`).join("");
  renderCheckQueue();
}

// ---------- CHECK THESE: the confidence-ranked review queue ---------------
// The style list on a civil sheet runs to 280 undifferentiated rows (Barn
// C3.0, engine page index 2 = printed sheet 3), and a list with no opinion
// about which rows matter moves the checking work onto the operator instead
// of removing it (EXCAVATION-PLAN.md section 7 item 2). This panel lists the
// specific things the engine is LEAST sure about on this sheet, most
// consequential first, and presents everything else as decided.
//
// Rules it lives under:
//   * Nothing here is a new number. Every entry is a regrouping of
//     measurements and flags the app already holds - state.result, the
//     /confidence payload, the /earthwork/suggest payload, the calcstate
//     sidecar, the symbol groups. The panel never fetches: a source that has
//     not been loaded contributes no entries, and the panel SAYS which
//     checks could not run yet rather than implying a clean bill.
//   * The cap is disclosed. At most CK_CAP entries show; the rest are one
//     click away behind "and N more", never silently gone.
//   * Clicking an entry navigates to the thing and marks it checked - a
//     visible struck-through state, undoable, persisted per page through
//     the calcstate sidecar (additive `checks` key). A check-off changes
//     NOTHING about the takeoff; it is the operator's own reading log.
//   * Severity colours match the confidence banner's contract for the same
//     facts (stop = two sources contradict or no scale at all; warn = one
//     source, or a choice the reviewer has to make), so the two surfaces
//     can never disagree about the same doubt.
//
// The block between the markers below is PURE - no DOM, no state.*, no
// fetch - and tests/test_check_queue.js evals exactly that block standalone
// (same technique as tests/test_trench_math.js). Keep it that way.

// CHECK-QUEUE-BEGIN

// At most this many entries render before the "and N more" button. The
// target the plan states is "show the ~12 things the engine is least sure
// about"; 12 also keeps the panel under one screen at the sidebar's 330px.
const CK_CAP = 12;

// A style whose welded-gap + picked-up-ink share exceeds this fraction of
// its footage is queued: a quarter of the length being paper the drafter
// never inked is past what routine stitching produces (Kayden C5.1's whole
// sheet measures 2.27% welded; its worst billable layer 6.10%), so 25%
// marks a style whose number is substantially inferred rather than drawn.
const CK_WELD_FRAC = 0.25;

// Footage floor for per-style entries. 500 pt is the codebase's own
// existing "big enough to matter" line - loadResult ticks a solid style on
// by default only above it - and the 1%-of-sheet term keeps the floor
// proportionate on dense sheets so the queue is never 12 slivers while a
// real doubt waits below the cap.
const CK_STYLE_FLOOR_PT = 500;
const CK_STYLE_FLOOR_SHARE = 0.01;
function ckStyleFloor(totalPt) {
  return Math.max(CK_STYLE_FLOOR_PT, CK_STYLE_FLOOR_SHARE * (totalPt || 0));
}

// Ranking weights. The common currency is AFFECTED FOOTAGE in paper points
// (paper points, not feet, because the no-scale case still has to rank and
// feet do not exist there). Per-style entries carry exactly the footage in
// doubt; page-wide entries carry the page's included footage times a share
// factor:
//   CK_W_PAGE  = 1.0   no-scale / caption-vs-bar / printed-sf-vs-scale /
//                      datum conflict: the doubt multiplies EVERY quantity
//                      on the page (scale) or every volume (datum), so it
//                      carries the whole page.
//   CK_W_OCR   = 0.6   a scale read by OCR off a scan: one page-wide number
//                      from the least trustworthy reader this app has, with
//                      no second reading on the sheet to catch it - below
//                      the outright contradictions, above the multi-scale
//                      choice (which at least prints its alternatives).
//   CK_W_MULTI = 0.5   several printed scales and the engine could not
//                      settle which governs: an even choice between
//                      captions puts half the expected footage at stake.
//   CK_W_MULTI_RANKED = 0.25  several printed scales but the engine ranked
//                      one decisively (governs, margin > 1.5): the residual
//                      doubt of a measured pick that is still, finally, the
//                      reviewer's choice to confirm.
//   CK_W_DROPS = 0.4   saved operator inputs that no longer match this
//                      detection: a silently reverted decision. Bounded by
//                      the calculators' scope rather than the whole sheet,
//                      but it undoes work the operator believes done - so
//                      above any single style short of ~40% of the page.
//   CK_W_SCHED = 0.35  a mark count the sheet's own schedule contradicts:
//                      a genuine two-source disagreement, but bounded to
//                      one mark family; |delta| breaks ties inside it.
//   spots unresolved:  totalPt * (unresolved / n) - the share of the
//                      sheet's elevation evidence that carries no height.
// Severity sorts before weight (stop always outranks warn), so these
// factors order entries WITHIN a colour, never across it.
const CK_W_PAGE = 1.0;
const CK_W_OCR = 0.6;
const CK_W_MULTI = 0.5;
const CK_W_MULTI_RANKED = 0.25;
const CK_W_DROPS = 0.4;
const CK_W_SCHED = 0.35;

// 720 pt at 30 ft/in -> "300 ft"; no scale -> honest paper units, because a
// queue entry must never print a foot the sheet cannot back.
function ckFt(pt, ftPerIn) {
  if (!ftPerIn) {
    const inch = pt / 72;
    return (inch >= 100 ? Math.round(inch) : +inch.toFixed(1)) + " paper-inches";
  }
  const ft = pt / 72 * ftPerIn;
  return (ft >= 1000 ? (ft / 1000).toFixed(1) + "k" : ft.toFixed(0)) + " ft";
}
// 30 -> "30", 5.333 -> "5.33" (same trim rule as confFt, kept local so the
// marked block stays standalone)
function ckDec(v) {
  const n = +v;
  if (!isFinite(n)) return "?";
  return n.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

// How many of the calcstate sidecar's chain/style-keyed inputs would NOT
// survive being applied to this detection. Mirrors the drop arms of
// ewApplySaved (a contour row or limit-of-work seed whose chain id is gone)
// and trApplySaved (a pipe-run style id that renumbered) so this count and
// the in-panel calcDropText can never disagree - with one honest gap: a
// bound seed whose chain exists but no longer stitches into a ring is only
// discovered by the stitcher at panel-open, so this may undercount by that
// one case, never overcount.
function ckDrops(saved, chainIds, styleIds) {
  const cs = new Set(chainIds || []), ss = new Set(styleIds || []);
  let ew = 0, tr = 0;
  const sv = saved && saved.ew;
  if (sv && Array.isArray(sv.rows))
    for (const r of sv.rows)
      if (r && typeof r.chain_id === "number" && !cs.has(r.chain_id)) ew++;
  const bd = saved && saved.ew_bound;
  if (bd && typeof bd.chain_id === "number" && !cs.has(bd.chain_id)) ew++;
  const tv = saved && saved.tr;
  if (tv && typeof tv.style_id === "number" && !ss.has(tv.style_id)) tr++;
  return { ew: ew, tr: tr };
}

// Build the queue from plain data. Input contract (everything optional
// except totalPt/styles; an absent source contributes no entries and, where
// it means a check has not run, one `pending` line):
//   totalPt   included footage on the sheet, paper pt
//   ftPerIn   ft per paper inch, or null when no scale is in force
//   styles    [{sid, pt, name, legend, layerLeaf, named, included, weldPt}]
//   scale     {present, text, ftIn, conflict, corroborated, barFt,
//              deltaPct, source, operator, multi:{n,lo,hi,settled}|null}
//   tag       {agrees, implied, ratio, n} | null   (printed-sf cross-check)
//   datum     {state:"checked"|"pending"|"failed", conflict, declared,
//              bandBase, bandN}
//   spots     {state, n, unresolved}
//   drops     {state, ew, tr, sigChanged}
//   marks     [{code, n, sched}] | null   (null = Count never pressed)
// Returns {entries:[{id, sev, w, head, text, act}], pending:[string]}.
// Entries are NOT capped or ordered here - ckOrder does that - so no
// caller can accidentally rank and cap with different rules.
function ckBuild(inp) {
  const out = [], pending = [];
  const totalPt = +inp.totalPt || 0;
  const fpi = inp.ftPerIn || null;
  const sc = inp.scale || { present: false };

  // ---- the scale: the one number under every other number ---------------
  if (!sc.present) {
    out.push({ id: "scale", sev: "stop", w: totalPt * CK_W_PAGE,
      head: "No scale could be read off this sheet.",
      text: "Nothing below is real feet until one is set - use the scale "
        + "box in the sheet header before pricing anything from this page.",
      act: { t: "sheethead" } });
  } else if (sc.conflict) {
    out.push({ id: "scale", sev: "stop", w: totalPt * CK_W_PAGE,
      head: "Two readings of the scale disagree.",
      text: "The printed caption says 1 in = " + ckDec(sc.ftIn) + " ft, the "
        + "drawn bar measures 1 in = " + ckDec(sc.barFt) + " ft - "
        + ckDec(sc.deltaPct) + "% apart, and every foot on this sheet moves "
        + "with the answer. The caption is in force; settle it in the header.",
      act: { t: "sheethead" } });
  } else if (!sc.operator && sc.source === "ocr" && sc.corroborated !== true) {
    out.push({ id: "scale", sev: "warn", w: totalPt * CK_W_OCR,
      head: "The scale was read by OCR off a scan.",
      text: "Character recognition is the least trustworthy reading this app "
        + "has and nothing on the sheet backs it up - check 1 in = "
        + ckDec(sc.ftIn) + " ft against a dimension printed on the drawing.",
      act: { t: "sheethead" } });
  }
  // A single uncorroborated printed caption is deliberately NOT queued: it
  // is the normal case on this corpus, the banner already says it in words,
  // and a queue that fires on the norm stops meaning "least sure".
  if (sc.present && sc.multi && !sc.operator) {
    // reviewer-picked or typed scales are the operator's own decision and
    // do not queue; the engine's unsettled or merely-ranked pick does
    const m = sc.multi;
    out.push({ id: "scales", sev: "warn",
      w: totalPt * (m.settled ? CK_W_MULTI_RANKED : CK_W_MULTI),
      head: "This sheet prints " + m.n + " different scales.",
      text: (m.settled
        ? "The engine measured 1 in = " + ckDec(sc.ftIn) + " ft as governing "
          + "most of the drawing, but details here are drawn to others ("
          + ckDec(m.lo) + " to " + ckDec(m.hi) + " ft/in) and the pick is "
          + "still yours to confirm in the header."
        : "From 1 in = " + ckDec(m.lo) + " ft to 1 in = " + ckDec(m.hi)
          + " ft, and nothing on the sheet settled which governs the "
          + "drawing - confirm the pick in the header before pricing."),
      act: { t: "sheethead" } });
  }
  if (inp.tag && inp.tag.agrees === false) {
    out.push({ id: "scaletag", sev: "stop", w: totalPt * CK_W_PAGE,
      head: "The sheet's own printed areas contradict the scale.",
      text: inp.tag.n + " area figure" + (inp.tag.n === 1 ? "" : "s")
        + " printed on this page impl" + (inp.tag.n === 1 ? "ies" : "y")
        + " 1 in = " + ckDec(inp.tag.implied) + " ft, not the "
        + ckDec(sc.ftIn) + " ft in force - square-foot numbers are out "
        + "roughly " + (inp.tag.ratio >= 10 ? Math.round(inp.tag.ratio)
                        : (+inp.tag.ratio).toFixed(1)) + "x.",
      act: { t: "sheethead" } });
  }

  // ---- the spot-elevation datum: worth 100 ft per elevation -------------
  const dt = inp.datum || { state: "pending" };
  if (dt.state === "checked" && dt.conflict) {
    out.push({ id: "datum", sev: "warn", w: totalPt * CK_W_PAGE,
      head: "The sheet disagrees with itself about the elevation datum.",
      text: "Its own note reads " + ckDec(dt.declared) + " ft while "
        + dt.bandN + " printed elevation" + (dt.bandN === 1 ? " sits" : "s sit")
        + " in the " + ckDec(dt.bandBase) + " ft band - a wrong pick moves "
        + "every cut/fill volume by the difference. Open Earthwork and check "
        + "one printed elevation by eye.",
      act: { t: "ew" } });
  }
  const sp = inp.spots || { state: "pending" };
  if (sp.state === "checked" && sp.n > 0 && sp.unresolved > 0) {
    out.push({ id: "spots", sev: "warn",
      w: totalPt * (sp.unresolved / sp.n),
      head: sp.unresolved + " of " + sp.n
        + " spot elevations carry no height.",
      text: "The sheet prints them shortened and nothing readable on the "
        + "page says what the missing hundreds are - they stay out of every "
        + "volume until a base elevation is typed in Earthwork.",
      act: { t: "ew" } });
  }
  if (dt.state === "pending" || sp.state === "pending")
    pending.push("Elevation checks have not answered yet - where each spot "
      + "elevation's base height came from is still being read off the page "
      + "(earthwork not opened; the page reader runs on its own).");
  else if (dt.state === "failed" || sp.state === "failed")
    pending.push("Elevation checks could not run - the page reader did not "
      + "answer, so nothing here has ruled out a guessed datum. Reload the "
      + "sheet, or open Earthwork to read the elevations directly.");

  // ---- saved operator inputs that no longer apply ------------------------
  const dr = inp.drops || { state: "pending" };
  if (dr.state === "checked") {
    const sig = dr.sigChanged
      ? " (the engine has changed since they were saved)" : "";
    if (dr.ew > 0)
      out.push({ id: "drops:ew", sev: "warn", w: totalPt * CK_W_DROPS,
        head: dr.ew + " saved earthwork input" + (dr.ew === 1 ? "" : "s")
          + " no longer match" + (dr.ew === 1 ? "es" : "") + " this detection.",
        text: "Contour or boundary picks made on an earlier detection"
          + sig + " cannot be applied, and any volume they fed needs "
          + "re-checking - open Earthwork to see what survives.",
        act: { t: "ew" } });
    if (dr.tr > 0)
      out.push({ id: "drops:tr", sev: "warn", w: totalPt * CK_W_DROPS,
        head: "The saved trench pipe-run no longer matches this detection.",
        text: "The line style it pointed at" + sig + " is gone or "
          + "renumbered, so the saved trench setup cannot be applied - "
          + "open Trench and re-pick the run.",
        act: { t: "tr" } });
  } else if (dr.state === "failed") {
    pending.push("The saved-inputs record could not be read, so stale "
      + "operator inputs cannot be checked this load.");
  } else {
    pending.push("Saved calculator inputs not read yet - the stale-input "
      + "check is pending.");
  }

  // ---- mark counts vs the sheet's own schedule ---------------------------
  if (inp.marks === null || inp.marks === undefined) {
    pending.push("Mark counts vs the sheet's schedule: unchecked - press "
      + "Count to scan this page's symbols.");
  } else {
    for (const mk of inp.marks) {
      if (typeof mk.sched !== "number" || mk.sched === mk.n) continue;
      out.push({ id: "sym:" + mk.code, sev: "warn",
        w: totalPt * CK_W_SCHED + Math.abs(mk.n - mk.sched),
        head: mk.code + ": counted " + mk.n + ", the schedule says "
          + mk.sched + ".",
        text: "The sheet's own schedule contradicts the geometric count - "
          + "one of the two is wrong. Hover the row in Counts to see every "
          + "counted instance.",
        act: { t: "sym" } });
    }
  }

  // ---- per-style doubts ---------------------------------------------------
  const floor = ckStyleFloor(totalPt);
  for (const s of (inp.styles || [])) {
    if (!s.included || !(s.pt >= floor)) continue;
    // Unnamed AND unfiled: no legend row matched it, the drafter gave it no
    // usable layer (empty, or AutoCAD's default "0"), and the operator has
    // not named it. On Barn C4.0, 38.8% of the footage had no name at all
    // (EXCAVATION-PLAN.md section 15 item 14) - footage that reaches the
    // priced takeoff under a pattern string.
    const leaf = (s.layerLeaf || "").trim();
    if (!s.legend && !s.named && (leaf === "" || leaf === "0")) {
      out.push({ id: "style:" + s.sid, sev: "warn", w: s.pt,
        head: ckFt(s.pt, fpi) + " of linework has no name.",
        text: "No legend row matched it and the drafter filed it under "
          + (leaf === "0" ? "layer \"0\"" : "no CAD layer")
          + " (shown as \"" + (s.name || "unnamed") + "\") - if it is your "
          + "trade it is unpriced under that blank; if not, it pads the "
          + "sheet totals. Click to isolate it on the canvas.",
        act: { t: "style", sid: s.sid } });
    }
    // Substantially inferred footage: welded gap + picked-up ink past a
    // quarter of the style's length. The number is real geometry, but much
    // of it is paper the drafter never inked - the operator should look at
    // the run before pricing it.
    if (s.pt > 0 && s.weldPt / s.pt > CK_WELD_FRAC) {
      out.push({ id: "weld:" + s.sid, sev: "warn", w: s.weldPt,
        head: Math.round(100 * s.weldPt / s.pt) + "% of \""
          + (s.name || "style " + s.sid) + "\" is inferred, not drawn.",
        text: "Of " + ckFt(s.pt, fpi) + ", " + ckFt(s.weldPt, fpi)
          + " is welded gap or ink picked up from elsewhere rather than "
          + "drawn line. Click to isolate the run and look before pricing.",
        act: { t: "style", sid: s.sid } });
    }
  }
  return { entries: out, pending: pending };
}

// Order and cap. Checked-off entries sink to the bottom (dealt with, still
// visible), severity sorts before weight (stop always above warn), weight
// before id (id keeps the order deterministic on ties). The cap never
// hides: callers must render `more` as an opener when it is nonzero.
function ckOrder(entries, doneIds, cap, showAll) {
  const done = new Set(doneIds || []);
  const sevRank = (e) => e.sev === "stop" ? 2 : 1;
  const sorted = [...entries].sort((a, b) =>
    (done.has(a.id) ? 1 : 0) - (done.has(b.id) ? 1 : 0)
    || sevRank(b) - sevRank(a)
    || b.w - a.w
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const shown = showAll ? sorted : sorted.slice(0, cap);
  return { shown: shown, more: sorted.length - shown.length,
           total: sorted.length,
           unchecked: entries.reduce((n, e) => n + (done.has(e.id) ? 0 : 1), 0) };
}
// CHECK-QUEUE-END

// Everything the pure block needs, read out of live state in one place.
// READ-ONLY over state: collecting must never mutate a pick, a label or a
// fetch. Sources that have not been loaded map to state:"pending"/"failed"
// or marks:null - the pure block turns those into `pending` lines.
function ckCollect() {
  const res = state.result;
  const sc = res.scale;
  let totalPt = 0, allPt = 0;
  for (const s of res.styles) {
    const pt = styleLenPt(s);
    allPt += pt;
    if (state.include.get(s.style_id)) totalPt += pt;
  }
  if (!totalPt) totalPt = allPt;   // nothing ticked: rank against the sheet
  // welded/picked-up footage per style, honouring excluded chains the same
  // way sheetOverCapture does
  const weld = new Map();
  for (const ch of res.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    weld.set(ch.style_id, (weld.get(ch.style_id) || 0)
      + (ch.gap_pt || 0) + (ch.pickup_pt || 0));
  }
  const styles = res.styles.map(s => {
    const seed = (state.seedLabels.get(s.style_id) || "").trim();
    const cur = (state.labels.get(s.style_id) ?? s.suggested_label ?? "").trim();
    return {
      sid: s.style_id,
      pt: styleLenPt(s),
      name: cur || (s.suggested_label || "").trim(),
      legend: /\(legend\)\s*$/.test(s.suggested_label || ""),
      layerLeaf: layerSplit((s.layer || "").trim()).leaf,
      // named = anything beyond the seeded default: the operator typed, the
      // label memory restored a past decision, or a legend-sheet name was
      // applied. All three are decisions; a decided row is not queued.
      named: cur !== "" && cur !== seed,
      included: !!state.include.get(s.style_id),
      weldPt: weld.get(s.style_id) || 0,
    };
  });
  let scale = { present: false };
  if (sc) {
    const uniq = scaleCandidates();
    const why = (sc.typed_by_reviewer || sc.picked_by_reviewer)
      ? null : scalePickWhy();
    scale = {
      present: true,
      text: sc.text || "",
      ftIn: +sc.ft_per_paper_inch,
      conflict: sc.agrees === false,
      corroborated: sc.agrees === true,
      barFt: sc.bar_ft_per_paper_inch,
      deltaPct: sc.delta_pct,
      source: sc.source || "text",
      operator: !!(sc.typed_by_reviewer || sc.picked_by_reviewer),
      multi: uniq.length > 1 ? {
        n: uniq.length,
        lo: Math.min(...uniq.map(c => +c.ft_per_paper_inch)),
        hi: Math.max(...uniq.map(c => +c.ft_per_paper_inch)),
        settled: !!(why && why.kind === "governs" && !why.thin),
      } : null,
    };
  }
  const tc = confTagCheck();
  const tag = tc ? { agrees: tc.agrees, implied: tc.implied,
                     ratio: tc.ratio, n: tc.tc.n_matched } : null;
  // datum + spots: the earthwork suggest payload when the panel has been
  // opened, else the /confidence payload, else pending/failed. Item 3 and
  // item 5 of the queue spec, one truth each, never both counted twice.
  const dj = (state.ew && state.ew.datum)
    || (state.conf && state.conf.spots && state.conf.spots.datum) || null;
  const checkedSrc = !!(state.ew || state.conf);
  const dstate = checkedSrc ? "checked" : (state.confErr ? "failed" : "pending");
  const datum = { state: dstate, conflict: !!(dj && dj.conflict),
    declared: dj && dj.declared, bandBase: dj && dj.band_base,
    bandN: (dj && dj.band_n) || 0 };
  let spots = { state: dstate, n: 0, unresolved: 0 };
  if (state.ew && Array.isArray(state.ew.spots)) {
    spots = { state: "checked", n: state.ew.spots.length,
      unresolved: state.ew.spots.filter(g => !g.resolved).length };
  } else if (state.conf && state.conf.spots) {
    spots = { state: "checked", n: state.conf.spots.n || 0,
      unresolved: state.conf.spots.unresolved || 0 };
  }
  let drops = { state: state.calcSaveBroken ? "failed" : "pending",
                ew: 0, tr: 0, sigChanged: false };
  if (state.calcSavedLoaded) {
    const saved = state.calcSaved || {};
    // custom chains are excluded from the live set on purpose: ewApplySaved
    // drops a saved row that points at one, so this count must too
    const d = ckDrops(saved,
      res.chains.filter(c => !c.custom).map(c => c.chain_id),
      res.styles.map(s => s.style_id));
    drops = { state: "checked", ew: d.ew, tr: d.tr,
      sigChanged: !!(saved.engine_sig && res.engine_sig
                     && saved.engine_sig !== res.engine_sig) };
  }
  const marks = state.sym
    ? state.sym.filter(g => (g.name || "").trim()
                            && g.schedule_qty !== undefined)
        .map(g => ({ code: g.name.trim(), n: g.n, sched: g.schedule_qty }))
    : null;
  return { totalPt: totalPt, ftPerIn: sc ? sc.ft_per_paper_inch : null,
           styles: styles, scale: scale, tag: tag, datum: datum,
           spots: spots, drops: drops, marks: marks };
}

function renderCheckQueue() {
  const panel = $("ckPanel");
  if (!panel) return;
  if (!state.result) { panel.hidden = true; return; }
  // Seed the check-offs from the calcstate sidecar exactly once per page
  // load. A check-off attests to what the operator SAW, and style ids
  // renumber when the engine changes - so on an engine_sig mismatch every
  // saved check-off is dropped rather than re-attached to whatever now
  // wears the id. Dropped check-offs come back as UNCHECKED entries: the
  // conservative direction (re-ask, never silently vouch).
  if (state.ckDone === null && state.calcSavedLoaded) {
    const saved = state.calcSaved || {};
    const ids = (saved.checks && Array.isArray(saved.checks.done))
      ? saved.checks.done.filter(x => typeof x === "string") : [];
    const same = saved.engine_sig && state.result.engine_sig
      && saved.engine_sig === state.result.engine_sig;
    state.ckDone = new Set(same ? ids : []);
  }
  const built = ckBuild(ckCollect());
  const done = state.ckDone || new Set();
  const ord = ckOrder(built.entries, [...done], CK_CAP, state.ckShowAll);
  panel.hidden = false;
  $("ckTitle").textContent = "Check these (" + ord.unchecked + ")";
  $("ckToggle").textContent = state.ckCollapsed ? "show" : "hide";
  $("ckBody").hidden = state.ckCollapsed;
  if (state.ckCollapsed) return;
  const rows = $("ckRows");
  rows.innerHTML = "";
  $("ckHint").hidden = !built.entries.length;
  if (!built.entries.length) {
    const d = document.createElement("div");
    d.className = "ck-clean";
    d.textContent = built.pending.length
      ? "Nothing queued by the checks that have run. Some could not run "
        + "yet - see below."
      : "Every check that could run on this sheet came back with nothing "
        + "to hold.";
    rows.appendChild(d);
  }
  for (const e of ord.shown) {
    const isDone = done.has(e.id);
    const row = document.createElement("div");
    row.className = "ck-row " + e.sev + (isDone ? " done" : "");
    const dot = document.createElement("span");
    dot.className = "ck-dot " + e.sev;
    const txt = document.createElement("span");
    txt.className = "ck-txt";
    const b = document.createElement("b");
    b.textContent = e.head;
    txt.appendChild(b);
    txt.appendChild(document.createTextNode(" " + e.text));
    row.append(dot, txt);
    row.title = isDone
      ? "You checked this off. Click to go there again; “not done” puts it back."
      : "Click to go to it - that marks it checked (undoable, and it changes nothing in the takeoff).";
    if (isDone) {
      const un = document.createElement("button");
      un.className = "mini ck-undo";
      un.textContent = "not done";
      un.onclick = (ev) => { ev.stopPropagation(); ckSetDone(e.id, false); };
      row.appendChild(un);
    }
    row.onclick = () => {
      if (!isDone) ckSetDone(e.id, true);
      ckGo(e);
    };
    rows.appendChild(row);
  }
  const more = $("ckMore");
  if (ord.more > 0) {
    more.hidden = false;
    more.textContent = "and " + ord.more + " more, ranked lower - show the "
      + "whole list (the cap hides nothing; this opens it)";
    more.onclick = () => { state.ckShowAll = true; renderCheckQueue(); };
  } else if (state.ckShowAll && ord.total > CK_CAP) {
    more.hidden = false;
    more.textContent = "showing all " + ord.total
      + " - collapse to the top " + CK_CAP;
    more.onclick = () => { state.ckShowAll = false; renderCheckQueue(); };
  } else {
    more.hidden = true;
  }
  const pend = $("ckPending");
  if (built.pending.length) {
    pend.hidden = false;
    pend.innerHTML = "";
    const h = document.createElement("div");
    h.className = "ck-pend-line";
    h.textContent = "Could not run yet:";
    pend.appendChild(h);
    for (const p of built.pending) {
      const d = document.createElement("div");
      d.className = "ck-pend-line";
      d.textContent = "· " + p;
      pend.appendChild(d);
    }
  } else pend.hidden = true;
}

// The check-off itself. Session state plus the calcstate sidecar (additive
// `checks` key), through the same debounced push every calculator input
// uses. It is the operator's reading log - it never touches a quantity.
function ckSetDone(id, val) {
  if (!state.ckDone) state.ckDone = new Set();   // sidecar broken: session-only
  if (val) state.ckDone.add(id); else state.ckDone.delete(id);
  calcStateDirty();
  renderCheckQueue();
}

// Go TO the thing. Isolation reuses the style list's own mechanic
// (state.isolate + the row's .iso class via renderStyles), panels reuse
// their own open buttons - opening Earthwork from here runs the exact
// handler the toolbar button runs, fetch and consent story included,
// because the click on this row IS the operator asking for that panel.
function ckGo(e) {
  const a = e.act || {};
  if (a.t === "style") {
    state.isolate = a.sid;
    renderStyles(); renderMiniLegend(); draw();
    const row = document.querySelector(
      '#styleList .style-row[data-sid="' + a.sid + '"]');
    if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
    const st = state.result.styles.find(s => s.style_id === a.sid);
    setStatus("isolated: "
      + (state.labels.get(a.sid) || (st && st.suggested_label) || ("style " + a.sid))
      + " — Esc shows everything again");
  } else if (a.t === "sheethead") {
    const el = $("sheetHead");
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  } else if (a.t === "ew") {
    if ($("ewPanel").hidden) $("ewBtn").onclick();
    else $("ewPanel").scrollIntoView({ block: "start", behavior: "smooth" });
  } else if (a.t === "tr") {
    if ($("trPanel").hidden) $("trBtn").onclick();
    else $("trPanel").scrollIntoView({ block: "start", behavior: "smooth" });
  } else if (a.t === "sym") {
    if (!$("symPanel").hidden)
      $("symPanel").scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

$("ckToggle").onclick = () => {
  state.ckCollapsed = !state.ckCollapsed;
  renderCheckQueue();
};

// ---------- what the drafter called it -----------------------------------
// `s.layer` is the CAD layer name and it is the only field on a style row
// that comes from the DOCUMENT rather than from our measurements. It matters
// most exactly where it is least likely to be looked for: read_legend's
// label OVERWRITES the layer-derived name (detect_page's
// `label = _legend_labels.get(sid, label)`), so on a row whose legend match
// is wrong the layer is the only surviving evidence that it is wrong - and
// until this it was not on screen anywhere. Barn Civil engine page index 12
// = printed sheet 13 = C4.3 emits style 106, 23 chains / 380.9 LF, layer
// `BR FND - BARN EAST|A-WALL`, labelled `PROPOSED PVC SURFACE STORM DRAIN
// PIPE (legend)` and ticked on: at the $50/LF rate on the client's own
// Estimate #853 that is $19,045 of foundation wall priced as pipe, with
// nothing on the row saying A-WALL. Isolating the style on the canvas draws
// the building footprint, not the pipe
// (out/verify/2026-08-23/stylelayer/PLATE-2-app-vs-source-it-is-a-wall.png).
//
// ONE layer per row, not a representative. detect_page writes
// `s["layer"] = c.layer` inside a loop over the style's chains - a
// last-writer-wins shape - but it cannot lose anything, because
// chain._assign_styles keys the style family on `c.layer` itself and nothing
// mutates `c.layer` afterwards. Measured over every detect result cached on
// this machine (114 pages, 12,634 style rows): 0 rows whose chains span more
// than one layer, 0 that mix a layer with the blank, 0 where the emitted
// value is not some chain's own. So the line below states the layer flatly
// and does not hedge it as "one of several"; if that ever stops being true
// the hedge has to come back.
//
// PyMuPDF hands back an xref-qualified name for anything that arrived
// through an external reference: `<xref block>|<layer>`. Over the 9,207
// cached style rows that carry a layer, 63.9% are xref-qualified, and the
// prefix names the DRAWING the layer came in through, not the thing drawn -
// five separate C4.3 rows share `BR FND - BARN EAST|`. Printing the string
// left to right therefore spends the readable width on the half that repeats
// and truncates the half that identifies. Full strings run 27 / 42 / 73
// characters at p50 / p90 / max; the part after the last `|` runs 13 / 21 /
// 44, and only 1.2% of tails pass 28 characters against 47.7% of full
// strings. So print the tail, mark the elision with a leading ellipsis, and
// keep the complete string one hover away.
function layerTail(lay) {
  const parts = String(lay).split("|");
  return parts.length > 1 ? "…" + parts[parts.length - 1] : parts[0];
}

// The same string, split rather than truncated. AutoCAD stamps every layer
// that arrives through an external reference with the source drawing's name,
// so `A|B` is layer B seen through xref A. layerTail() prints "…B", which
// makes a bare B and an xref'd B indistinguishable on screen - and those two
// are routinely different things: on Kayden Springs U2 sheet 39 the bare
// C-U2-SSWR-LAT is two NTS lot details, the xref'd one is the actual laterals.
function layerSplit(lay) {
  const s = String(lay);
  const i = s.lastIndexOf("|");
  return i < 0 ? { xref: null, leaf: s } : { xref: s.slice(0, i), leaf: s.slice(i + 1) };
}

// ======================= operator-declared trade scope =====================
// The engine measures everything drawn. On Beaumont's Barn Civil that is
// 697,036 ft of default-on linework across 12 scaled sheets against a bid
// (Beaumont Excavating Estimate #853) whose entire linear scope is 7,248 LF -
// 96x more line than the job bills. Nothing in the document says which of it
// is the operator's, because a drawing does not know who is reading it. So
// the operator says, and this filters on what they said.
//
// WHAT A TRADE IS, IN DATA
// ------------------------
// A trade is a named set of tokens, and every token is bound to the KIND of
// document evidence it may be tested against. Three kinds, because the corpus
// writes three kinds:
//
//   layer     the CAD layer tail the drafter filed the geometry under
//             (`SE-P-UT-STORM`, `A-DOOR`, `C-TOPO`). Measured over the 115
//             detect results cached on this machine: 9,343 of 12,772 style
//             rows carry one (73.2%) - but only 52.2% of the FOOTAGE does,
//             and 42 of 115 sheets carry none at all. Layer-first, never
//             layer-only.
//   label     a legend row's own text, or the name the reviewer typed.
//   material  a schedule row's MATERIAL cell. NOTHING PRODUCES THIS TODAY -
//             `/symbols/suggest` returns codes, not schedule rows. The branch
//             exists because these tokens are only meaningful against that
//             cell and must never be tried against a layer name: Beaumont has
//             77 style rows on `BG-L-Steel Retaining`, a landscape edging
//             layer, which a loose STEEL token would read as a hollow-metal
//             door.
//
// The first six trades and their tokens are `TRADES` / `tradeFor()` above,
// copied verbatim - the grouping the itemized panel and the CSV already use.
// They are deliberately NOT edited here: editing them would move the itemized
// panel's grouping, which is a quantity-facing surface.
//
// The last two are new, and their provenance is stated because the owner is
// not an estimator and cannot catch a fabricated convention:
//   * the layer tokens are strings THIS corpus prints - A-DOOR, A-DOOR-GLAZ,
//     A-DOOR-FRAM, A-GLAZ, P1-BLDG-DOORS, C-BLDG-DOOR, over 38 style rows in
//     the 115 cached results.
//   * the material tokens are cells printed in Mission Bell's own
//     "Window - Storefront - Door schedules.pdf" (dumped verbatim at
//     out/verify/2026-08-22/billscope/SCHEDULES.txt), and the split between
//     them - VINYL / ALUM / GLASS is a glazed leaf, STEEL / HM / SC,WOOD is
//     not - is this project's own measured finding (that folder's
//     HYPOTHESES.txt: right on 46 of the 50 codes the project prints). It is
//     a measurement made here, not an industry prior being asserted.
const SCOPE_GLAZED = "Openings - glazed (windows / storefront)";
const SCOPE_OPAQUE = "Openings - doors, hollow metal / wood";
const SCOPE_TOKENS = {
  "Earthwork & Grading": {
    layer: ["CONTOUR", "GRADING", "GRADE", "EXCAVAT", "EARTHWORK", "TOPO",
      "SLOPE", "BERM", "DITCH", "SWALE", "ELEVATION", "CUT", "FILL", "TOPSOIL"],
    label: ["CONTOUR", "GRADING", "GRADE", "EXCAVAT", "EARTHWORK", "TOPO",
      "SLOPE", "BERM", "DITCH", "SWALE", "ELEVATION", "CUT", "FILL", "TOPSOIL"],
    material: [] },
  "Wet Utilities": {
    layer: ["WATER", "SEWER", "STORM", "SANITARY", "DRAIN", "PIPE", "MAIN",
      "HYDRANT", "MANHOLE", "CULVERT", "IRRIG", "FORCE", "CLEANOUT", "TRENCH",
      "VALVE", "WELL", "FIREWATER"],
    label: ["WATER", "SEWER", "STORM", "SANITARY", "DRAIN", "PIPE", "MAIN",
      "HYDRANT", "MANHOLE", "CULVERT", "IRRIG", "FORCE", "CLEANOUT", "TRENCH",
      "VALVE", "WELL", "FIREWATER"],
    material: [] },
  "Dry Utilities": {
    layer: ["ELECTRIC", "TELEPHONE", "GAS", "FIBER", "CABLE", "COMM", "POWER",
      "CONDUIT", "LIGHT", "OHP"],
    label: ["ELECTRIC", "TELEPHONE", "GAS", "FIBER", "CABLE", "COMM", "POWER",
      "CONDUIT", "LIGHT", "OHP"],
    material: [] },
  "Paving & Concrete": {
    layer: ["PAVEMENT", "PAVING", "CURB", "SIDEWALK", "CONCRETE", "ASPHALT",
      "ROAD", "DRIVE", "GUTTER", "FLATWORK", "APRON", "EDGE OF"],
    label: ["PAVEMENT", "PAVING", "CURB", "SIDEWALK", "CONCRETE", "ASPHALT",
      "ROAD", "DRIVE", "GUTTER", "FLATWORK", "APRON", "EDGE OF"],
    material: [] },
  // Split out of "Structures" on 2026-08-24. Jeff Ellis (ECI Foundations) was
  // asked in the demo which trade he needed and answered "Footing and
  // foundation" - and the filter built to narrow a sheet to HIS work could not
  // express his work. Structures held FOOTING, FTG, FOUNDATION, PIER and SLAB
  // alongside JOIST, TRUSS, STUD and BEAM, so declaring it handed a foundations
  // sub the whole superstructure. A framer and a foundations sub are not the
  // same trade and must not share one token set.
  "Footing & Foundation": {
    layer: ["FOOTING", "FOOTINGS", "FOOTER", "FTG", "FOUNDATION", "FNDN",
      "STEM WALL", "STEMWALL", "GRADE BEAM", "PIER", "CAISSON",
      "PILE CAP", "PILASTER", "SLAB", "SOG", "SLAB ON GRADE"],
    label: ["FOOTING", "FOOTINGS", "FOOTER", "FTG", "FOUNDATION", "FNDN",
      "STEM WALL", "STEMWALL", "GRADE BEAM", "PIER", "CAISSON",
      "PILE CAP", "PILASTER", "SLAB", "SOG", "SLAB ON GRADE"],
    material: [] },
  "Structures": {
    layer: ["BUILDING", "STAIR", "BEAM", "COLUMN", "MASONRY", "SHEAR", "STUD",
      "JOIST", "TRUSS", "MOMENT FRAME"],
    label: ["BUILDING", "STAIR", "BEAM", "COLUMN", "MASONRY", "SHEAR", "STUD",
      "JOIST", "TRUSS", "MOMENT FRAME"],
    material: [] },
  "Fencing & Sitework": {
    layer: ["FENCE", "WALL", "RAIL", "GATE", "BARRIER", "LANDSCAP", "TREE",
      "SILT", "PROPERTY", "EASEMENT", "SETBACK"],
    label: ["FENCE", "WALL", "RAIL", "GATE", "BARRIER", "LANDSCAP", "TREE",
      "SILT", "PROPERTY", "EASEMENT", "SETBACK"],
    material: [] },
  [SCOPE_GLAZED]: {
    layer: ["A-GLAZ", "A-DOOR", "GLAZ", "WINDOW", "STOREFRONT", "CURTAIN",
      "MULLION", "BLDG-DOOR"],
    label: ["WINDOW", "STOREFRONT", "GLAZING", "GLAZED", "GLASS",
      "CURTAIN WALL", "MULLION", "SASH", "SLIDER", "PATIO DOOR"],
    material: ["VINYL", "ALUM", "GLASS", "GLAZ"] },
  [SCOPE_OPAQUE]: {
    layer: [],
    label: ["HOLLOW METAL", "HM DOOR", "WOOD DOOR", "FIRE DOOR"],
    material: ["STEEL", "HM", "SC,WOOD", "SC WOOD", "SC.WOOD", "HOLLOW METAL"] },
};
const SCOPE_NAMES = Object.keys(SCOPE_TOKENS);

// Every trade whose `kind` tokens appear in `text`. A SET, not a winner: a
// string that names two trades is a contradiction to show, not a tie to break
// (CLAUDE.md section 5, shape B - first-writer-wins discards the right answer).
function scopeTradesNamed(kind, text) {
  const out = new Set();
  if (!text) return out;
  const T = String(text).toUpperCase();
  for (const tr of SCOPE_NAMES)
    if ((SCOPE_TOKENS[tr][kind] || []).some(w => T.includes(w))) out.add(tr);
  return out;
}

// The verdict for one row. Three values, never two.
//
//   in       SOME witness names a declared trade. Any witness will do:
//            keeping a row needs only one reason.
//   out      no witness names a declared trade, AND the best witness that is
//            ALLOWED TO HIDE names a different one.
//   unknown  everything else - no witness, or only witnesses that may not
//            hide, or a hiding-capable witness that names nothing.
//
// Two asymmetries, both deliberate, both measured.
//
// 1. `in` beats `out`. One witness for you keeps the row even when another
//    witness says somebody else. A contradiction never hides.
//
// 2. Not every witness may hide. `mayHide` is false for anything read by OCR
//    off a scan. The alternative was measured on Bill's Mission Bell answer
//    key: reading each bubble independently at 8x, one of his 283 detected
//    openings reads as a scheduled non-glazed door, so letting an OCR'd code
//    set a row aside costs one real opening in 285 with no symptom
//    (out/verify/2026-08-22/billscope/HYPOTHESES.txt). That is harm class 1 in
//    AGENT-BRIEF section 0, so the raster mark path abstains BY CONSTRUCTION
//    rather than by luck.
//
// Among witnesses that may hide, only the best-ranked one is consulted, so a
// legend label can never set aside a row whose CAD layer is silent. The legend
// label is attached by proximity and this codebase has shipped it wrong twice
// over: 1,449.6 ft of footer drain labelled `> > >` (CLAUDE.md section 5), and
// C4.3 style 106, whose legend label says PROPOSED PVC SURFACE STORM DRAIN
// PIPE while the isolated style draws the foundation wall
// (out/verify/2026-08-23/state, PLATE-1).
function scopeVerdict(evidence, trades) {
  if (!trades || !trades.length) return { v: "unknown", why: "no trade declared", src: "" };
  const mine = new Set(trades);
  for (const e of evidence) {
    const named = scopeTradesNamed(e.kind, e.text);
    if ([...named].some(t => mine.has(t)))
      return { v: "in", why: `${e.src} says ${e.text}`, src: e.src };
  }
  const hiders = evidence.filter(e => e.mayHide);
  if (hiders.length) {
    const best = Math.min(...hiders.map(e => e.rank));
    for (const e of hiders) {
      if (e.rank !== best) continue;
      const others = [...scopeTradesNamed(e.kind, e.text)].filter(t => !mine.has(t)).sort();
      if (others.length)
        return { v: "out", why: `${e.src} says ${e.text} — ${others[0]}`, src: e.src };
    }
  }
  return { v: "unknown",
    why: (evidence.length && !hiders.length)
      ? "read by OCR off a scan — not allowed to set a row aside"
      : "nothing on this row names a trade", src: "" };
}

// The witnesses a LINE STYLE has. Layer first (rank 0), label second (rank 1).
function scopeEvidenceForStyle(s) {
  const ev = [];
  const tail = String(s.layer || "").split("|").pop().trim();
  if (tail) ev.push({ rank: 0, kind: "layer", src: "CAD layer", text: tail, mayHide: true });
  const lab = (state.labels.get(s.style_id) || s.suggested_label || "").trim();
  // A label that only repeats the layer tail is not a second witness, and a
  // pattern description ("solid solid", "dash1 3.0/2.0") is not a name.
  const echoesLayer = !!tail && lab.toUpperCase().includes(tail.toUpperCase());
  if (lab && !echoesLayer
      && !/^(solid|dash\d|dash-text|annotation)\b/i.test(lab))
    ev.push({ rank: 1, kind: "label",
      src: /\(legend\)/.test(lab) ? "legend" : "label", text: lab, mayHide: true });
  return ev;
}

// The witnesses a MARK GROUP has. On a scanned sheet the code came out of an
// OCR of a 300-dpi raster, so it may name a trade but may never hide one -
// see asymmetry 2 above. `source === "raster"` is already in the payload.
// `schedule_cells` is the field the endpoint described in the report would
// add; no server produces it today, so this branch is inert on every document
// in the corpus and is here as the contract, clearly marked.
function scopeEvidenceForMark(g) {
  const ev = [];
  if (g.schedule_cells)
    ev.push({ rank: 0, kind: "material", src: `schedule row ${g.name || ""}`.trim(),
      text: g.schedule_cells, mayHide: true });
  const code = (g.name || g.off_schedule || "").trim();
  if (code)
    ev.push({ rank: 2, kind: "label",
      src: g.source === "raster" ? "read off the scan" : "mark code",
      text: code, mayHide: g.source !== "raster" });
  return ev;
}

// ---- the declaration itself -------------------------------------------
// PER DOCUMENT, because that is the unit the evidence lives in: the CAD layer
// vocabulary, the legend and the schedules all belong to one drawing set, and
// an operator who does windows on one job does site utilities on the next.
// Per session would be wrong (a session opens several documents); per page
// would be wrong (a scope that changes sheet to sheet is a scope nobody can
// audit, and the whole-job rollup adds sheets together).
//
// TAKING A DEFAULT FROM AN ACCOUNT LATER. The owner's plan is to ask at login.
// When that exists, the login answer becomes the DEFAULT VALUE of this record
// and nothing else changes: `scopeRec()` would fall back to the account trades
// when the document has no record of its own, `scopeSetTrades` would keep
// writing per document, and the bar would say "from your account" instead of
// "not declared" so an operator can always see which one is talking. The
// per-document record must stay the winner - the account says what you usually
// do, the document says what you are doing here.
function scopeKey() { return docKey() + "::scope"; }
function scopeRec() {
  try {
    const r = JSON.parse(store.getItem(scopeKey()) || "{}");
    return { trades: Array.isArray(r.trades) ? r.trades.filter(t => SCOPE_TOKENS[t]) : [],
      showAside: !!r.showAside };
  } catch (e) { return { trades: [], showAside: false }; }
}
function scopeSave(r) {
  try { store.setItem(scopeKey(), JSON.stringify(r)); } catch (e) {}
}

// Recompute every style's verdict and reconcile the tick boxes.
//
// NOTHING HERE CHANGES A QUANTITY. Every row keeps the footage the detector
// measured, in every state; what moves is whether the row is shown and whether
// it is ticked into the takeoff. `offBy` records exactly which rows THIS
// filter unticked, keyed on the same style fingerprint the include memory
// uses, so clearing the declaration puts back exactly those and touches
// nothing the operator turned off by hand.
function scopeApply() {
  state.scopeV = new Map();
  state.scopeOwnerOn = new Set();
  if (!state.result) { state.scopeKeep = new Set(); state.scopeOffBy = new Set(); return; }
  const rec = scopeRec();
  // `keep` and `offBy` are both page state keyed on style_id, not on
  // styleFp: the fingerprint is NOT unique (Barn Civil C3.0's 280 style rows
  // collapse to 194 fingerprints), and keyed on it a put-back of one 25.0k ft
  // row returned two rows and 25.5k ft. Only `trades` and `showAside` - the
  // declaration itself - are document-scoped.
  const keep = state.scopeKeep || new Set();
  const wasOff = state.scopeOffBy || new Set();
  const nowOff = new Set();
  // STEP 1 - undo whatever this filter did last time, before deciding
  // anything. What is left is the operator's own tick state: the detector's
  // defaults plus every box they moved by hand. Restoring first is what makes
  // "show everything" exact rather than approximately right, and it is what
  // lets the bar quote a footage that is genuinely IN the takeoff.
  //
  // Keyed on style_id, NOT on styleFp. The fingerprint is not unique: on
  // Barn Civil C3.0 the sheet's 280 style rows collapse to 194 distinct
  // fingerprints, so restoring by fingerprint ticked 39 rows back on that
  // this filter had never touched (measured live: ownerOn 204 where the
  // detector had ticked 165). style_id is unique within a page, and the set
  // lives in page state rather than the document record because ids are
  // page-local - a page switch rebuilds state.include from scratch anyway.
  for (const s of state.result.styles)
    if (wasOff.has(s.style_id) && !state.include.get(s.style_id))
      setIncludeTransient(s.style_id, true);
  for (const s of state.result.styles)
    if (state.include.get(s.style_id)) state.scopeOwnerOn.add(s.style_id);
  // STEP 2 - the verdicts, and the unticking that follows from them
  for (const s of state.result.styles) {
    let d = scopeVerdict(scopeEvidenceForStyle(s), rec.trades);
    if (d.v === "out" && keep.has(s.style_id))
      d = { v: "kept", why: "you put this back by hand", src: "you" };
    state.scopeV.set(s.style_id, d);
    // Only rows this filter ACTUALLY unticked are recorded - never ones the
    // detector had already turned off. Recording those too made step 1 hand
    // the operator rows the detector deliberately suppressed, and inflated
    // the footage the bar claimed to remove (191.1k against a sheet holding
    // 178.0k).
    if (d.v === "out" && state.include.get(s.style_id)) {
      nowOff.add(s.style_id);
      setIncludeTransient(s.style_id, false);
    }
  }
  state.scopeOffBy = nowOff;
}

function scopeSetTrades(list) {
  const rec = scopeRec();
  rec.trades = list.filter(t => SCOPE_TOKENS[t]);
  scopeSave(rec);
  scopeApply();
  renderScopeBar(); renderStyles(); renderChips(); renderItemized();
  renderMiniLegend(); if (state.sym) renderSym(); draw();
}
function scopeToggleTrade(tr) {
  const t = scopeRec().trades;
  scopeSetTrades(t.includes(tr) ? t.filter(x => x !== tr) : t.concat([tr]));
}
// One click puts a set-aside row back, and it stays back for as long as the
// sheet is open. This is the "out-of-scope rows stay countable" guarantee -
// adding one back is ONE action on a row that was never removed, not a
// re-detect. Kept in page state alongside the tick boxes it mirrors; the app
// deliberately holds no cross-session takeoff memory (see `store`).
function scopeKeepRow(s, on) {
  if (!state.scopeKeep) state.scopeKeep = new Set();
  if (on) state.scopeKeep.add(s.style_id); else state.scopeKeep.delete(s.style_id);
  // Handing a kept row BACK to the filter has to tick it on first, or the
  // filter never records that IT is the reason the row is off and "show
  // everything" leaves it behind. Measured live on Barn Civil C3.0 before
  // this line existed: put style 209 back (25.0k ft), hand it back to the
  // filter, then clear the declaration - the sheet returned 153.0k ft where
  // it started at 178.0k, one row and 25.0k ft short, with nothing on screen
  // saying so. That is the exact failure this whole feature is not allowed
  // to have.
  if (!on) setIncludeTransient(s.style_id, true);
  scopeApply();
  renderScopeBar(); renderStyles(); renderChips(); renderItemized();
  renderMiniLegend(); draw();
}
function scopeShowAside(on) {
  const rec = scopeRec(); rec.showAside = !!on; scopeSave(rec);
  renderScopeBar(); renderStyles();
}
function scopeSeesRow(s) {
  const d = (state.scopeV && state.scopeV.get(s.style_id)) || { v: "unknown" };
  return d.v !== "out" || scopeRec().showAside;
}

// Row COUNTS are over every line type the list can show. FOOTAGE is only
// over the rows that are in the takeoff - ticked, or ticked until this filter
// unticked them - because a row the detector already turned off (white
// wash, texture, annotation) was never in the number and counting it here
// would inflate what the filter appears to remove.
function scopeTally() {
  const t = { in: 0, unknown: 0, out: 0, kept: 0, on: 0,
    ftIn: 0, ftUnknown: 0, ftOut: 0, ftKept: 0, layered: 0 };
  if (!state.result) return t;
  const sc = state.result.scale;
  const ftPerIn = sc ? sc.ft_per_paper_inch : null;
  for (const s of state.result.styles) {
    const d = (state.scopeV && state.scopeV.get(s.style_id)) || { v: "unknown" };
    t[d.v] = (t[d.v] || 0) + 1;
    if (String(s.layer || "").trim()) t.layered += 1;
    // the operator's own tick state, before this filter touched anything
    if (!(state.scopeOwnerOn && state.scopeOwnerOn.has(s.style_id))) continue;
    t.on += 1;
    const ft = ftPerIn ? styleLenPt(s) / 72 * ftPerIn : styleLenPt(s);
    t["ft" + d.v.charAt(0).toUpperCase() + d.v.slice(1)] += ft;
  }
  t.ftUnit = ftPerIn ? "ft" : "pt";
  return t;
}

function renderScopeBar() {
  const box = $("scopeBar");
  if (!box) return;
  box.innerHTML = "";
  if (!state.result) { box.hidden = true; return; }
  box.hidden = false;
  const rec = scopeRec(), t = scopeTally();
  const declared = rec.trades.length > 0;

  const head = document.createElement("div");
  head.className = "scope-head";
  const h = document.createElement("span");
  h.className = "scope-title";
  h.textContent = declared ? "Counting for" : "Whose scope is this?";
  head.appendChild(h);
  if (declared) {
    const clr = document.createElement("button");
    clr.className = "mini"; clr.id = "scopeClear"; clr.textContent = "show everything";
    clr.title = "Clear the declaration. Every row this filter unticked goes "
      + "back on, and nothing you turned off by hand is touched.";
    clr.onclick = () => scopeSetTrades([]);
    head.appendChild(clr);
  }
  box.appendChild(head);

  const chips = document.createElement("div");
  chips.className = "scope-chips";
  for (const tr of SCOPE_NAMES) {
    const b = document.createElement("button");
    b.className = "scope-chip" + (rec.trades.includes(tr) ? " on" : "");
    b.textContent = tr;
    b.name = "scope-" + tr;
    b.title = "Tokens tested against the CAD layer: "
      + ((SCOPE_TOKENS[tr].layer || []).join(", ") || "(none)")
      + (SCOPE_TOKENS[tr].material.length
        ? "\nTested against a schedule MATERIAL cell: "
          + SCOPE_TOKENS[tr].material.join(", ") : "");
    b.onclick = () => scopeToggleTrade(tr);
    chips.appendChild(b);
  }
  box.appendChild(chips);

  const note = document.createElement("div");
  note.className = "scope-note";
  const fmt = n => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : n.toFixed(0));
  if (!declared) {
    note.innerHTML = "<b>Nothing declared, so nothing is filtered.</b> All "
      + `${state.result.styles.length} line types on this sheet are listed, and `
      + `the <b>${t.on}</b> rows the detector ticked (${fmt(t.ftUnknown)} `
      + `${t.ftUnit}) are ticked still. `
      + "Pick one or more trades above and this list narrows "
      + "to what the sheet itself says is yours — it never deletes a row and "
      + "never changes a length, and one click brings everything back.";
  } else if (!t.out && !t.in) {
    // ABSTAIN. Nothing on this sheet supports a scope decision, so say that
    // rather than narrow on a guess.
    note.innerHTML = "<b>Not narrowed — this sheet says nothing that "
      + "separates your work from anybody else&rsquo;s.</b> All "
      + `${state.result.styles.length} line types are still listed and the `
      + `<b>${t.on}</b> the detector ticked are still ticked. `
      + (t.layered ? "" : "No row on this sheet carries a CAD layer name, ")
      + "and no legend label names a trade, so there is nothing to filter on. "
      + "Nothing has been hidden.";
  } else {
    note.innerHTML =
      `<b>${t.in}</b> line type${t.in === 1 ? "" : "s"} the sheet says are yours `
      + `(${fmt(t.ftIn)} ${t.ftUnit}) · <b>${t.unknown}</b> it does not say, `
      + `kept and ticked (${fmt(t.ftUnknown)} ${t.ftUnit}) · <b>${t.out}</b> set `
      + `aside (${fmt(t.ftOut)} ${t.ftUnit} out of the takeoff, still listed)`
      + (t.kept ? ` · <b>${t.kept}</b> you put back by hand `
        + `(${fmt(t.ftKept)} ${t.ftUnit})` : "");
  }
  box.appendChild(note);

  if (declared && (t.out || t.kept)) {
    const act = document.createElement("div");
    act.className = "scope-act";
    const sh = document.createElement("button");
    sh.className = "mini"; sh.id = "scopeAside";
    sh.textContent = rec.showAside
      ? `hide the ${t.out} set aside again`
      : `show the ${t.out} set aside`;
    sh.title = "Set aside is not deleted. Every row keeps its measured "
      + "length; showing them lists them in place with a one-click put-back.";
    sh.onclick = () => scopeShowAside(!rec.showAside);
    act.appendChild(sh);
    const w = document.createElement("span");
    w.className = "scope-warn";
    w.textContent = "a set-aside row is not a corrected row — its footage is unchanged";
    act.appendChild(w);
    box.appendChild(act);
  }
}

// The same declaration, said again over the Count panel, because a symbol
// count is a separate number on a separate surface and an operator who
// declared a trade for the linework must not have to guess whether it applied
// to the bubbles too.
function renderSymScope() {
  const box = $("symScope");
  if (!box) return;
  const rec = scopeRec();
  if (!state.sym || !state.sym.length) { box.hidden = true; return; }
  let nIn = 0, nOut = 0, nUnk = 0, nRaster = 0;
  for (const g of state.sym) {
    const d = scopeVerdict(scopeEvidenceForMark(g), rec.trades);
    g._scope = d;
    if (g.source === "raster") nRaster += g.n;
    if (d.v === "in") nIn += g.n; else if (d.v === "out") nOut += g.n; else nUnk += g.n;
  }
  box.hidden = false;
  if (!rec.trades.length) {
    box.innerHTML = "<b>No trade declared</b> — every symbol found is listed, "
      + "including any that belong to somebody else. Declare a trade in "
      + "<i>Whose scope is this?</i> above the line-type list.";
    return;
  }
  if (!nOut && !nIn) {
    box.innerHTML = `<b>Not narrowed to ${rec.trades.join(" + ")}.</b> `
      + `All <b>${nUnk}</b> symbols are still listed and countable. `
      + (nRaster
        ? "These bubbles were read by OCR off a scan, and an OCR read is never "
          + "allowed to set a row aside — measured on the answer key for a "
          + "285-opening project, letting one do so hides one real opening with "
          + "no symptom. What would narrow this is the project&rsquo;s window / "
          + "door schedule rows and the material each row names; they live in a "
          + "different PDF and nothing reads them yet."
        : "Nothing in the mark codes names a trade.");
    return;
  }
  box.innerHTML = `Counting for <b>${rec.trades.join(" + ")}</b>: `
    + `<b>${nIn}</b> yours · <b>${nUnk}</b> unattributed (kept) · `
    + `<b>${nOut}</b> set aside, still listed below and still countable.`;
}
// ===================== end operator-declared trade scope ===================

// ---- one bid line, more than one place on the sheet ----------------------
// computeTakeoffRows() groups by LABEL, not by style, so every style carrying
// the same name sums into a single itemized row. Usually that is exactly
// right: one CAD layer drawn in two weights is one item. It is NOT right when
// the contributing styles come from DIFFERENT CAD layers AND sit in different
// parts of the sheet, because that is the shape a typical-detail block makes -
// same layer name, own scale, parked in a corner.
//
// Measured on Kayden Springs U2 sheet 39: the itemized panel reads
// `C-U2-SSWR-LAT 79 lines 3913.6 ft` while the plan holds 71 lines / 3,308 ft.
// The surplus is eight lines inside TYPICAL 35' and 25' WIDE LOT - LATERAL
// DETAIL, both captioned NTS, so they have no length at the sheet's scale at
// all. Nothing on screen could have led anyone to that.
//
// Both narrowing tests earn their place. Same-label-different-style alone
// fires on 74% of that sheet's rows (median 52% across 110 cached client
// sheets) - wallpaper. Requiring different layer STRINGS and disjoint bounding
// boxes drops it to 20% there and a median of 0% across the corpus, with 63 of
// 110 sheets showing nothing at all.
//
// It states the arithmetic and shows you where the other piece is. It does not
// judge which piece belongs - an engine-side merge of these was tried and cost
// C9.0 4.3pp of ink recall, because that sheet's bare layers are legend
// swatches. Deciding is the estimator's.
function splitItems() {
  if (!state.result) return new Map();
  const chains = new Map();
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (!state.include.get(ch.style_id)) continue;
    // work-area mask: a detail block the operator boxed out no longer
    // counts, so it must not raise a "counted twice" chip either - the
    // chip's claim is about footage that is IN the numbers
    const cPt = chainCountedPt(ch);
    if (wzActive() && !(cPt > 0)) continue;
    let e = chains.get(ch.style_id);
    if (!e) chains.set(ch.style_id, e = { n: 0, pt: 0, bb: null });
    e.n++; e.pt += cPt;
    for (const p of ch.points) {
      if (!e.bb) e.bb = [p[0], p[1], p[0], p[1]];
      else {
        if (p[0] < e.bb[0]) e.bb[0] = p[0];
        if (p[1] < e.bb[1]) e.bb[1] = p[1];
        if (p[0] > e.bb[2]) e.bb[2] = p[0];
        if (p[1] > e.bb[3]) e.bb[3] = p[1];
      }
    }
  }
  // Aggregate by LAYER inside each label, not by style. The chip's claim is
  // "this item comes from N layers in different places", so the disjointness
  // test has to be between LAYERS. Comparing style to style instead fired on
  // NOTES: that label carries 14 styles across only 2 layers - the same
  // annotation layer drawn at a dozen widths, scattered over the sheet - and
  // each little blob is disjoint from the others, so every one of them lit up.
  // 14 of the first build's 22 chips on Kayden sheet 39 were that, and a chip
  // on a 14-way split is useless anyway: there is nothing to go and look at.
  const byLabel = new Map();
  for (const [sid, e] of chains) {
    const st = state.result.styles.find(x => x.style_id === sid);
    if (!st) continue;
    const lab = (state.labels.get(sid) || st.suggested_label || "unlabeled").trim();
    const lay = (st.layer || "").trim();
    if (!byLabel.has(lab)) byLabel.set(lab, new Map());
    const byLayer = byLabel.get(lab);
    let g = byLayer.get(lay);
    if (!g) byLayer.set(lay, g = { layer: lay, n: 0, pt: 0, bb: null, sids: [] });
    g.n += e.n; g.pt += e.pt; g.sids.push(sid);
    if (e.bb) {
      if (!g.bb) g.bb = e.bb.slice();
      else {
        g.bb[0] = Math.min(g.bb[0], e.bb[0]); g.bb[1] = Math.min(g.bb[1], e.bb[1]);
        g.bb[2] = Math.max(g.bb[2], e.bb[2]); g.bb[3] = Math.max(g.bb[3], e.bb[3]);
      }
    }
  }
  const apart = (p, q) => p.bb && q.bb &&
    (p.bb[2] < q.bb[0] || q.bb[2] < p.bb[0] ||
     p.bb[3] < q.bb[1] || q.bb[3] < p.bb[1]);
  const out = new Map();
  for (const [lab, byLayer] of byLabel) {
    const parts = [...byLayer.values()];
    if (parts.length < 2) continue;
    // The chip exists to point at ONE other place worth looking at. When an
    // item is spread over more than a handful of style rows, no row-level chip
    // can do that, and plain fragmentation is a likelier read than a hidden
    // detail block. Measured: this cut takes Kayden sheet 39 from 22 flagged
    // rows to 8 - exactly the four civil layers that are genuinely split - and
    // across 110 cached client sheets it drops the worst sheet from 89% of
    // rows to 10%, mean 5% to 2%, without changing the 67 sheets that flag
    // nothing at all.
    const rowsInLabel = parts.reduce((t, p) => t + p.sids.length, 0);
    if (rowsInLabel > 4) continue;
    const total = parts.reduce((t, p) => t + p.pt, 0);
    for (const p of parts) {
      if (!parts.some(q => q !== p && apart(p, q))) continue;
      for (const sid of p.sids) out.set(sid, { label: lab, total, parts, me: p });
    }
  }
  return out;
}

function renderStyles() {
  const box = $("styleList");
  box.innerHTML = "";
  $("approveBtn").disabled = !state.result;
  $("csvBtn").disabled = !state.result;
  if (!state.result) return;
  const q = ($("styleSearch") ? $("styleSearch").value : "").trim().toUpperCase();
  // Roughly 23% of chains corpus-wide carry no CAD layer, and it is not
  // spread thinly - whole documents have none: 42 of the 114 detect results
  // cached here carry not one layer on any style row. Absence is the common
  // case and has to read as "the drafter did not write it down", never as a
  // missing feature. So: per row where the sheet HAS layers, and once for
  // the sheet where it has none, because 60 rows each reading "no CAD layer"
  // is noise rather than evidence.
  const anyLayer = state.result.styles.some(s => (s.layer || "").trim());
  if (!anyLayer && state.result.styles.length) {
    const note = document.createElement("div");
    note.className = "layer-none-note";
    note.textContent = "This PDF carries no CAD layer names. Every name below "
      + "comes from the legend or from the line's own pattern — there is "
      + "nothing the drafter wrote to check them against.";
    box.appendChild(note);
  }
  // Set-level disclosure. Ticks this page INHERITED from hand decisions on
  // other sheets are announced, never a side effect: one line, with a count,
  // and the way out stated. memApply() counts them; setInclude() removes a
  // row from the count the moment the operator overrides it here.
  const nInh = state.inheritedInc ? state.inheritedInc.size : 0;
  if (nInh) {
    const note = document.createElement("div");
    note.className = "layer-none-note";
    note.textContent = nInh + (nInh === 1 ? " choice" : " choices")
      + " carried over from other sheets of this set — page-level changes "
      + "override.";
    box.appendChild(note);
  }
  const CLASS_ORDER = ["solid", "dash1", "dash2", "dash3", "dash-text"];
  const CLASS_NAME = { solid: "Solid lines", dash1: "Dashed",
    dash2: "Dash-dot", dash3: "Compound (dash-dot-dot)",
    "dash-text": "Lettered runs (W / SD / FO)" };
  const styles = [...state.result.styles].sort((a, b) =>
    CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class)
    || b.length_pt - a.length_pt);
  let lastClass = null;
  const splits = splitItems();
  for (const s of styles) {
    const label = state.labels.get(s.style_id) ?? "";
    // The layer joins the searchable text as the WHOLE string, not the
    // displayed tail: typing `A-WALL` has to find `BR FND - BARN EAST|A-WALL`
    // (substring, so the tail matches anyway) and typing `BARN EAST` has to
    // find it too.
    //
    // The failure this repairs is nastier than "the field was not searchable".
    // 31 of C4.3's 151 styles carry A-WALL in their layer, and the unpatched
    // box returns 30 of them - because `suggested_label` DEFAULTS to the layer
    // tail, so a layer-named row is findable by accident, through its label.
    // The single row it cannot return is the single row whose label the legend
    // overwrote: style 106, 380.9 LF, labelled PROPOSED PVC SURFACE STORM
    // DRAIN PIPE. Searching the sheet's walls quietly omitted the one wall
    // that is not filed as a wall. Both counts measured live off
    // #styleList .style-row (PLATE-3-search-a-wall-30-of-31.png).
    if (q && !((label + " " + s.signature + " " + s.class
                + " " + (s.layer || "")).toUpperCase().includes(q)))
      continue;
    // The declared-trade filter, applied AFTER the text filter and only when
    // the text box is empty. A search that cannot return a row the operator
    // knows is on the sheet is a search that lies, so typing anything at all
    // is itself the "show me everything" gesture - the row comes back with
    // its set-aside badge on, never silently missing.
    if (!q && !scopeSeesRow(s)) continue;
    if (s.class !== lastClass) {
      lastClass = s.class;
      const h = document.createElement("div");
      h.className = "class-head";
      h.textContent = CLASS_NAME[s.class] || s.class;
      box.appendChild(h);
    }
    const row = document.createElement("div");
    const sv = (state.scopeV && state.scopeV.get(s.style_id)) || { v: "unknown" };
    row.className = "style-row" + (state.include.get(s.style_id) ? "" : " off")
      + (sv.v === "out" ? " scope-out" : sv.v === "in" ? " scope-in"
        : sv.v === "kept" ? " scope-kept" : "");
    row.dataset.sid = s.style_id;
    row.dataset.scope = sv.v;

    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!state.include.get(s.style_id);
    if (state.inheritedInc && state.inheritedInc.has(s.style_id))
      cb.title = "Carried over from another sheet of this set — change it "
        + "here to override for this page.";
    cb.onclick = (e) => { e.stopPropagation(); setInclude(s.style_id, cb.checked);
      // Ticking a row the scope filter set aside IS the put-back: record it,
      // or scopeApply() would untick it again on the next repaint and the
      // operator would watch their own click undo itself.
      if (sv.v === "out" && cb.checked) { scopeKeepRow(s, true); return; }
      if (sv.v === "kept" && !cb.checked) { scopeKeepRow(s, false); return; }
      // A hand tick on the row itself - and only that - also speaks for the
      // set (scope put-backs returned above; bulk buttons never come here).
      setIncludeSetWide(s, cb.checked);
      renderStyles(); renderChips(); renderItemized(); renderMiniLegend(); draw(); };

    // a real pattern sample, not a flat chip: estimators match rows to
    // linework by PATTERN (the flat chip caused every "legend shows a
    // straight line" report). Template from any chain of this style wins;
    // signature-derived dashes otherwise.
    const sw = document.createElement("canvas");
    sw.className = "swatch-line";
    drawPatternSample(sw, s, 92, 20);

    const main = document.createElement("div");
    main.className = "style-main";
    const lab = document.createElement("input");
    lab.className = "style-label"; lab.name = "label-" + s.style_id;
    lab.value = state.labels.get(s.style_id) ?? "";
    if (state.legendNames.length) lab.setAttribute("list", "legendVocab");
    lab.onclick = (e) => e.stopPropagation();
    lab.oninput = () => {
      state.labels.set(s.style_id, lab.value);
      memSave(s);   // decisions persist: same label on every future load
      clearTimeout(lab._t);   // itemized + legend regroup as you type
      lab._t = setTimeout(() => { renderItemized(); renderMiniLegend(); }, 350);
    };
    const meta = document.createElement("div");
    meta.className = "style-meta";
    meta.textContent = `${fmtQty(styleLenPt(s))} · ${styleLiveCount(s.style_id)} lines · ${s.signature}`;
    // work-area disclosure, per row: a row that lost footage to the mask
    // says how much, on its own line, compactly
    {
      const wOut = styleLiveOut(s.style_id);
      if (wOut > 0.05) {
        meta.textContent += ` · ${fmtQty(wOut)} outside work area`;
        meta.title = `${fmtQty(wOut)} of this style lies outside the drawn `
          + `work area and is not counted anywhere below. Clear the work `
          + `area to count it again.`;
      }
    }
    main.append(lab, meta);

    const badge = document.createElement("span");
    badge.className = `badge ${s.class}`; badge.textContent = s.class;
    const mm = document.createElement("button");
    mm.className = "mm-toggle" +
      (state.measureMode.get(s.style_id) === "object" ? " ea" : "");
    mm.textContent = state.measureMode.get(s.style_id) === "object" ? "EA" : "LF";
    mm.title = "How this line type is priced: LF = footage, EA = count each piece";
    mm.onclick = (e) => {
      e.stopPropagation();
      if (state.measureMode.get(s.style_id) === "object") {
        state.measureMode.delete(s.style_id);
        const lab = (state.labels.get(s.style_id) || "").trim().toUpperCase();
        if (lab) store.removeItem("measure::" + lab);
      } else state.measureMode.set(s.style_id, "object");
      memSave(s, true);   // the toggle WAS touched - record the decision
      renderStyles(); renderItemized(); renderMiniLegend(); draw();
    };

    const ai = state.aiWhy.get(s.style_id);
    if (ai) {
      row.classList.add(ai.keep ? "ai-keep" : "ai-drop");
      // wording matters: this is a note, not a state. Nothing about the row
      // has been changed by the model - the banner's Accept buttons are the
      // only thing that writes.
      row.title = (ai.keep ? "AI suggests measuring this (not applied) — "
                           : "AI suggests this is not takeoff (not applied) — ")
        + (ai.why || "");
    }

    // Its OWN line, spanning the row from the label column out, rather than
    // a fourth item on the meta line. The meta line has no room, and this is
    // measured, not guessed: the panel is 330px and the row's main column is
    // 109px of it, in which 57 of C4.3's 151 meta lines ALREADY hit their
    // ellipsis. A layer appended there is cut off first on exactly the rows
    // whose names are longest. A tooltip alone fails the way the missing
    // field failed: nobody hovers 90 rows looking for a contradiction he has
    // not been told exists. The cost is real and worth stating plainly -
    // measured live on C4.3, the row goes 53px -> 66px and the 151-style
    // list 8,111px -> 10,059px, +24.0% of scroll. On a sheet with no layers
    // at all nothing is added and the row stays at 53px.
    let layerEl = null;
    if (anyLayer) {
      layerEl = document.createElement("div");
      const lay = (s.layer || "").trim();
      layerEl.className = "style-layer" + (lay ? "" : " none");
      if (lay) {
        const tag = document.createElement("span");
        tag.className = "sl-tag"; tag.textContent = "layer";
        const parts = layerSplit(lay);
        layerEl.append(tag);
        if (parts.xref) {
          // the xref name may be elided - it says where the layer came from,
          // not what it is - but it must be VISIBLE, because its presence or
          // absence is the only thing separating two same-named rows
          const xr = document.createElement("span");
          xr.className = "sl-xref"; xr.textContent = parts.xref + "|";
          layerEl.appendChild(xr);
        }
        const nm = document.createElement("span");
        nm.className = "sl-name"; nm.textContent = parts.leaf;
        layerEl.appendChild(nm);
        // The full string, un-elided, plus what the field IS - the row shows
        // both names side by side and says nothing about which is right,
        // because deciding that is the estimator's job and a wrong verdict
        // here would be worse than the silence it replaces.
        layerEl.title = "CAD layer: " + lay
          + "\n\nWhat the drafter filed this linework under, read out of the "
          + "PDF. The name in the box above can instead have come from the "
          + "sheet's legend, and where the two disagree this is the one the "
          + "document itself asserts.";
      } else {
        layerEl.textContent = "no CAD layer";
        layerEl.title = "This PDF does name layers, but not on this line "
          + "type — so there is nothing from the drafter to check the name "
          + "above against.";
      }
    }

    // The scope verdict, on the row, in the words of whatever asserted it.
    // Only where a trade is declared AND the filter reached a verdict: a line
    // reading "nothing here names a trade" on 967 of 1,459 rows would be the
    // layer-none noise the list already refuses to print.
    let scopeEl = null;
    if (sv.v === "out" || sv.v === "in" || sv.v === "kept") {
      scopeEl = document.createElement("div");
      scopeEl.className = "style-scope " + sv.v;
      const tag = document.createElement("span");
      tag.className = "sl-tag";
      tag.textContent = sv.v === "out" ? "set aside"
        : sv.v === "kept" ? "put back" : "your trade";
      const nm = document.createElement("span");
      nm.className = "sc-why"; nm.textContent = sv.why;
      scopeEl.append(tag, nm);
      scopeEl.title = sv.v === "out"
        ? "Set aside, not deleted. " + sv.why
          + ". Its measured length is unchanged and it is still counted in "
          + "the bar above. Tick the box to put it back — one click, and the "
          + "exception is remembered for this document."
        : sv.v === "kept"
          ? "You put this back by hand. The filter will not set it aside "
            + "again on this document. Untick it to let the filter decide."
          : sv.why;
    }

    row.append(cb, sw, main, mm, badge);
    if (layerEl) row.appendChild(layerEl);
    const sp = splits.get(s.style_id);
    if (sp) {
      const el = document.createElement("button");
      el.className = "item-split";
      const others = sp.parts.filter(p => p !== sp.me);
      el.innerHTML = '<span class="is-tag">item</span>'
        + '<span class="is-txt">' + fmtQty(sp.total) + " total, from "
        + sp.parts.length + " layers</span>";
      el.title = 'The takeoff adds up by NAME, so the item "' + sp.label
        + '" is the total of these ' + sp.parts.length + " CAD layers:" + LF + LF
        + sp.parts.map(p => "   " + (p === sp.me ? "→ " : "   ")
            + (p.layer || "(no layer)") + "   " + fmtQty(p.pt) + ", "
            + p.n + " lines").join(LF)
        + LF + LF
        + "They are different CAD layers and they sit in different parts of "
        + "the sheet. Often that is fine. Sometimes one of them is a TYPICAL "
        + "… DETAIL drawn to its own scale, or marked NTS, filed under the "
        + "same layer name as the real linework - and it is being added to "
        + "your quantity." + LF + LF
        + "Click to isolate the other row on the canvas so you can see where "
        + "it is. Nothing is added, removed or merged.";
      el.onclick = (ev) => {
        ev.stopPropagation();
        const cur = others.findIndex(p => p.sids.includes(state.isolate));
        const next = others[(cur + 1) % others.length];
        const tgt = next.sids[0];
        state.isolate = state.isolate === tgt ? null : tgt;
        for (const r of box.querySelectorAll(".style-row.iso")) r.classList.remove("iso");
        if (state.isolate !== null) {
          const t = box.querySelector('.style-row[data-sid="' + state.isolate + '"]');
          if (t) { t.classList.add("iso"); t.scrollIntoView({ block: "nearest" }); }
        }
        setStatus(state.isolate === null ? "isolate off"
          : "isolated: " + (next.layer || "(no layer)") + " — "
            + fmtQty(next.pt) + ", " + next.n + " lines of the "
            + fmtQty(sp.total) + ' in "' + sp.label + '". Esc shows everything again');
        draw();
      };
      row.appendChild(el);
    }
    if (scopeEl) row.appendChild(scopeEl);
    row.onmouseenter = () => { state.hot = s.style_id; draw(); };
    row.onmouseleave = () => { state.hot = null; draw(); };
    // Isolating from the style list had NO on-screen indicator of any kind.
    // The mini legend's green cue is only repainted by the mini legend's own
    // click handler and by the I key, and it only lists the top eight styles
    // by length - so a click here changed what the canvas drew and left every
    // panel asserting the sheet was still whole. An operator who forgot an
    // isolate was active would read a filtered canvas as the drawing. The row
    // itself now carries the state, which is the one place the operator is
    // certain to be looking, and the status line names what is isolated.
    if (state.isolate === s.style_id) row.classList.add("iso");
    row.onclick = () => {
      const on = state.isolate !== s.style_id;
      state.isolate = on ? s.style_id : null;
      // Toggle the class in place rather than re-rendering: renderStyles()
      // here would rebuild the list under the cursor and throw away the
      // operator's scroll position on a 280-row sheet.
      for (const r of box.querySelectorAll(".style-row.iso")) r.classList.remove("iso");
      if (on) row.classList.add("iso");
      setStatus(on
        ? `isolated: ${(state.labels.get(s.style_id) || s.suggested_label || "unnamed line type")} \u2014 Esc shows everything again`
        : "isolate off");
      renderMiniLegend(); draw();
    };
    box.appendChild(row);
  }
}
// ---------- filled AREA regions: the square-foot takeoff ----------
// Hardscape is bought by the square foot - Beaumont's own Estimate #853
// prices "Paths To Subgrade 22,796 SF", "Slab Prep 9,237 SF" (client
// document, not an industry prior). A group here is one APPEARANCE (fill
// colour + CAD layer); its regions are the measured things, and takeoff
// rows reference the group rather than copying its number, so one region
// can feed several priced rows at different depths or materials - which is
// exactly how #853 bills the same 22,796 SF twice.
const AR_COLOR = "#00c2a8";
const AR_HOT = "#ffd166";

function arData() { return (state.result && state.result.areas) || null; }
function arGroup(gid) {
  const a = arData();
  return a ? a.groups.find(g => g.group_id === gid) : null;
}
function arRegionsOf(g) {
  const a = arData();
  return a && g ? g.region_ids.map(i => a.regions[i]).filter(Boolean) : [];
}
// the label an estimator sees: their own edit wins, then the sheet's name,
// then an honest placeholder - never a fabricated material name
function arLabel(g) {
  const own = state.areaLabels.get(g.group_id);
  if (own !== undefined && own !== "") return own;
  if (g.name) return g.name;
  const c = g.fill.map(v => Math.round(v * 255));
  return `unnamed area (rgb ${c.join(",")})`;
}
const arFmt = (v, d = 0) =>
  v === null || v === undefined ? "—"
    : v.toLocaleString(undefined, { maximumFractionDigits: d });

// ---------- areas follow the scale IN FORCE, not the one at detect --------
// The server computes area_sf / perim_lf once, at detection, from the ENGINE's
// reading. A scale the reviewer set afterwards never reached them, so this
// panel printed one scale while the sheet header printed another - and the
// code simply said so and told the operator not to price it. It does not have
// to: every region and group also carries `area_pt2` and `perim_pt`, which are
// pure geometry, so the real figures are one exact multiplication away.
//
//   sf = pt2 / 72^2 * (ft per paper inch)^2      lf = pt / 72 * (ft per inch)
//
// Checked against the server's own output on Barn Civil printed sheet 3:
// 822,301.2 pt2 at 30 ft/in gives 142,760.6 SF, and 3,957.3 pt gives 1,648.9
// LF - both exact to the tenth the server reported.
function arFpi() {
  const sc = state.result && state.result.scale;
  const f = sc && sc.ft_per_paper_inch;
  return (typeof f === "number" && isFinite(f) && f > 0) ? f : null;
}
function arSf(o) {
  const f = arFpi();
  return (f === null || !o || !isFinite(o.area_pt2)) ? null
       : o.area_pt2 / 5184 * f * f;
}
function arLf(o) {
  const f = arFpi();
  return (f === null || !o || !isFinite(o.perim_pt)) ? null
       : o.perim_pt / 72 * f;
}
// The regions in this group whose area the DRAFTER printed on the sheet, and
// what they say about the scale now in force. `printed_sf` is the drafter's
// own number, so it is ground truth independent of any scale we choose - which
// makes it a LIVE check on the reviewer's scale rather than a frozen verdict
// about the engine's.
function arTagged(g) {
  const regs = arRegionsOf(g).filter(r => r && r.printed_sf);
  if (!regs.length) return null;
  const pt2 = regs.reduce((a, r) => a + (r.area_pt2 || 0), 0);
  const printed = regs.reduce((a, r) => a + (r.printed_sf || 0), 0);
  const f = arFpi();
  let mismatch = 0;
  if (f !== null)
    for (const r of regs) {
      const mine = (r.area_pt2 || 0) / 5184 * f * f;
      if (Math.abs(mine - r.printed_sf) / r.printed_sf > 0.02) mismatch += 1;
    }
  return {
    n: regs.length,
    sf: f === null ? null : pt2 / 5184 * f * f,
    printed,
    mismatch,
    // the scale those printed areas imply, solved from the same equation
    implied: (pt2 > 0 && printed > 0) ? Math.sqrt(printed * 5184 / pt2) : null,
  };
}

// Rows are DERIVED from the group every time, so a scale correction or a
// re-detect flows straight through instead of leaving a stale number.
function arApplyItems() {
  const a = arData();
  state.extraItems = state.extraItems.filter(it => !it._area);
  if (!a) { renderItemized(); return; }
  const seen = new Map();
  for (const row of state.areaRows) {
    const g = arGroup(row.group_id);
    if (!g || !state.areaInc.get(g.group_id)) continue;
    const qty = row.unit === "LF" ? arLf(g) : arSf(g);
    if (qty === null || qty === undefined) continue;   // no scale: no number
    const base = arLabel(g);
    let label = row.label || (row.unit === "LF" ? `${base} (edge)` : base);
    // The second row on one region is the POINT of this shape (#853 bills
    // the same 22,796 SF to subgrade and again for road base), but prices
    // and overrides are keyed by LABEL - two identical labels would share
    // one rate. Number the repeats so each can carry its own.
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    if (n > 1) label = `${label} (${n})`;
    state.extraItems.push({
      label, qty: Math.round(qty * 10) / 10, unit: row.unit,
      _area: true, group_id: g.group_id, region_ids: g.region_ids,
    });
  }
  renderItemized();
}

function renderAreas() {
  const head = $("arHead"), scaleBox = $("arScale");
  const box = $("arList"), un = $("arUnmatched");
  const a = arData();
  box.innerHTML = ""; un.innerHTML = ""; scaleBox.innerHTML = "";
  // furniture (title block, text masks) is LISTED, not hidden - nothing is
  // silently dropped - but it starts unticked and "all" skips it
  const groups = a ? a.groups : [];
  const any = a && (groups.length || a.unmatched_legend.length);
  head.hidden = !any; scaleBox.hidden = !any;
  box.hidden = !any || head.classList.contains("closed");
  un.hidden = !any || head.classList.contains("closed");
  if (!any) return;

  // --- scale provenance. An area is only as good as the scale under it, so
  // the reader must SEE which scale was used and what the sheet's own
  // printed areas say about it.
  const sc = a.scale || {};
  // NOTE: sc is the scale the SERVER used at detection. It is kept only to
  // report what changed; every figure in this panel is recomputed live by
  // arSf/arLf. sc.tag_check is deliberately NOT read - it froze a verdict
  // about the engine's scale, and arTagged re-derives it at the live one.
  const parts = [];
  parts.push(sc.ft_per_paper_inch
    ? `scale used: 1 inch = ${(+sc.ft_per_paper_inch).toFixed(2)} ft`
      + (sc.text ? ` (read as “${esc(sc.text)}”)` : "")
    : `<b>no scale on this sheet</b> — areas shown in pt², no SF`);
  let cls = "ar-scale";
  // Every SF and LF in this panel is now recomputed from `area_pt2` /
  // `perim_pt` at the scale IN FORCE (see arSf / arLf), so the old "these
  // figures are not the scale in force, do not price them" warning is gone -
  // there is nothing stale left to warn about. What replaces it is better:
  // because the drafter's own printed "N sf" tags are ground truth whatever
  // scale we pick, they now CHECK the reviewer's scale live. Set the wrong
  // scale by hand and the sheet's own figures contradict you immediately,
  // instead of agreeing with an engine reading nobody is using any more.
  const inForce = arFpi();
  const detected = sc.ft_per_paper_inch ? +sc.ft_per_paper_inch : null;
  const scSrc = state.result && state.result.scale;
  if (inForce !== null && detected !== null
      && Math.abs(inForce - detected) > 1e-6)
    parts.push(`recomputed at <b>1 inch = ${inForce.toFixed(2)} ft</b>`
      + (scSrc && scSrc.typed_by_reviewer ? " (set by hand)"
         : scSrc && scSrc.picked_by_reviewer ? " (you picked it)" : "")
      + `, not the ${detected.toFixed(2)} ft read at detection.`);

  // The live check, aggregated over every tagged region on the sheet.
  let tPt2 = 0, tPrinted = 0, tN = 0, tBad = 0;
  for (const g of groups) {
    const t = arTagged(g);
    if (!t) continue;
    tN += t.n; tBad += t.mismatch; tPrinted += t.printed;
    if (t.implied) tPt2 += t.printed * 5184 / (t.implied * t.implied);
  }
  const impliedAll = (tPt2 > 0 && tPrinted > 0)
    ? Math.sqrt(tPrinted * 5184 / tPt2) : null;
  if (tN && inForce !== null && impliedAll) {
    if (tBad) {
      cls += " bad";
      parts.push(`<b>the sheet disagrees.</b> ${tN} printed “N sf” tag`
        + `${tN === 1 ? "" : "s"} on this page imply <b>1 inch = `
        + `${impliedAll.toFixed(2)} ft</b>, not ${inForce.toFixed(2)}. `
        + `${tBad} of them ${tBad === 1 ? "is" : "are"} out by more than 2% `
        + `at the scale in force — about `
        + `${Math.pow(impliedAll / inForce, 2).toFixed(1)}× on area. `
        + `Fix the scale before pricing these.`);
    } else {
      cls += " ok";
      parts.push(`checked against ${tN} area${tN === 1 ? "" : "s"} printed on `
        + `the sheet at this scale — they agree.`);
    }
  } else if (inForce !== null) {
    parts.push(`no printed “N sf” tag on this sheet to check it against.`);
  }
  scaleBox.className = cls;
  scaleBox.innerHTML = parts.join("<br>");

  for (const g of groups) {
    const row = document.createElement("div");
    row.className = "ar-row" + (state.areaInc.get(g.group_id) ? "" : " off");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!state.areaInc.get(g.group_id);
    cb.onclick = (e) => {
      e.stopPropagation();
      state.areaInc.set(g.group_id, cb.checked);
      if (cb.checked && !state.areaRows.some(r => r.group_id === g.group_id))
        state.areaRows.push({ group_id: g.group_id, unit: "SF" });
      renderAreas(); arApplyItems(); draw();
    };
    const sw = document.createElement("span");
    sw.className = "ar-swatch";
    sw.style.background = `rgb(${g.fill.map(v => Math.round(v * 255)).join(",")})`;

    const main = document.createElement("div");
    main.className = "ar-main";
    const lab = document.createElement("input");
    lab.className = "ar-label"; lab.name = "area-" + g.group_id;
    lab.value = state.areaLabels.get(g.group_id) ?? (g.name || "");
    lab.placeholder = arLabel(g);
    lab.onclick = (e) => e.stopPropagation();
    lab.oninput = () => {
      state.areaLabels.set(g.group_id, lab.value);
      clearTimeout(lab._t);
      lab._t = setTimeout(() => arApplyItems(), 350);
    };
    const meta = document.createElement("div");
    meta.className = "ar-meta";
    const src = g.name_source
      ? { tag: "named by the sheet's own area tag",
          legend: "named from the legend swatch of the same colour",
          layer: "named from the CAD layer" }[g.name_source]
      : "no name on the sheet — type one";
    meta.textContent = `${arFmt(arSf(g))} SF · ${arFmt(arLf(g))} LF edge · `
      + `${g.n} region${g.n === 1 ? "" : "s"}`;
    const why = document.createElement("span");
    why.className = "ar-why " + (g.name_source || "none");
    why.textContent = g.name_source || "unnamed";
    why.title = src;
    meta.appendChild(why);
    if (g.furniture) {
      const f = document.createElement("span");
      f.className = "ar-why none"; f.textContent = "sheet furniture";
      f.title = "Its CAD layer names a title block, text mask or border, so "
        + "this is almost certainly not a takeoff area. Listed rather than "
        + "hidden — tick it if the guess is wrong.";
      meta.appendChild(f);
    }
    // Recomputed at the scale IN FORCE, so this is a live check on the
    // reviewer's scale and not a frozen verdict about the engine's.
    const tg = arTagged(g);
    if (tg) {
      const chk = document.createElement("span");
      const bad = tg.mismatch > 0;
      chk.className = "ar-check " + (bad ? "bad" : "ok");
      chk.textContent = bad
        ? `sheet says ${arFmt(tg.printed)} SF`
        : `matches the sheet (${tg.n})`;
      // compare like with like: our measurement of the TAGGED regions only,
      // never the group total against a partial set of tags
      chk.title = bad
        ? `The sheet prints its own area for ${tg.n} of these `
          + `${g.n} regions, totalling ${arFmt(tg.printed)} SF. At the scale `
          + `in force we measure ${arFmt(tg.sf)} SF for those same ${tg.n}. `
          + `${tg.mismatch} disagree by more than 2% — almost always the `
          + `page scale.`
        : `${tg.n} of these ${g.n} regions carry an area printed on the `
          + `sheet (${arFmt(tg.printed)} SF); at the scale in force we measure `
          + `${arFmt(tg.sf)} SF for those same ${tg.n}, agreeing within 2%.`;
      meta.appendChild(chk);
    }
    main.append(lab, meta);

    const add = document.createElement("button");
    add.className = "mini ar-add";
    add.textContent = "+row";
    add.title = "Add another priced row for this same area — one region often "
      + "bills more than once (subgrade, then road base).";
    add.onclick = (e) => {
      e.stopPropagation();
      state.areaInc.set(g.group_id, true);
      state.areaRows.push({ group_id: g.group_id, unit: "SF" });
      renderAreas(); arApplyItems(); draw();
    };
    const edge = document.createElement("button");
    edge.className = "mini ar-add";
    edge.textContent = "+LF";
    edge.title = "Add the perimeter as its own row — edge forming and curb "
      + "are priced by the foot, separately from the slab.";
    edge.onclick = (e) => {
      e.stopPropagation();
      state.areaInc.set(g.group_id, true);
      state.areaRows.push({ group_id: g.group_id, unit: "LF" });
      renderAreas(); arApplyItems(); draw();
    };

    const nrows = state.areaRows.filter(r => r.group_id === g.group_id).length;
    if (nrows > 1) {
      const badge = document.createElement("span");
      badge.className = "ar-nrows";
      badge.textContent = `${nrows} rows`;
      badge.title = "This one measured area feeds several priced takeoff rows.";
      main.appendChild(badge);
    }

    row.append(cb, sw, main, edge, add);
    row.onmouseenter = () => { state.areaHot = g.group_id; draw(); };
    row.onmouseleave = () => { state.areaHot = null; draw(); };
    box.appendChild(row);
  }

  // Legend classes with NO geometry on this sheet. Named, never quantified:
  // the legend is a document-wide key, so most rows describe another sheet.
  if (a.unmatched_legend.length) {
    const h = document.createElement("div");
    h.className = "ar-un-head";
    h.textContent = "in the legend, not drawn on this sheet";
    h.title = "These classes are named in the sheet legend but no matching "
      + "filled region exists on this page, so there is nothing to measure. "
      + "No quantity is shown rather than a zero.";
    un.appendChild(h);
    for (const u of a.unmatched_legend) {
      const r = document.createElement("div");
      r.className = "ar-un";
      const s = document.createElement("span");
      s.className = "ar-swatch";
      s.style.background = `rgb(${u.fill.map(v => Math.round(v * 255)).join(",")})`;
      const t = document.createElement("span");
      t.textContent = u.label;
      const q = document.createElement("span");
      q.className = "ar-noqty"; q.textContent = "no quantity";
      r.append(s, t, q);
      un.appendChild(r);
    }
  }
}

$("arAllBtn").onclick = () => {
  const a = arData(); if (!a) return;
  for (const g of a.groups) {
    if (g.furniture) continue;
    state.areaInc.set(g.group_id, true);
    if (!state.areaRows.some(r => r.group_id === g.group_id))
      state.areaRows.push({ group_id: g.group_id, unit: "SF" });
  }
  renderAreas(); arApplyItems(); draw();
};
$("arNoneBtn").onclick = () => {
  state.areaInc = new Map(); state.areaRows = [];
  renderAreas(); arApplyItems(); draw();
};

// ---------- sheet legend (detector-read) ----------
function renderLegend() {
  const box = $("legendBox"), head = $("legendHead");
  box.innerHTML = ""; box.hidden = true; head.hidden = true;
  if (!state.result || !(state.result.legend || []).length) return;
  head.hidden = false;
  // respect a collapse the user made; new content never forces it open
  box.hidden = head.classList.contains("closed");
  for (const e of state.result.legend) {
    const sid = e.sample_style;
    // every chip SHOWS its line: the matched style's true pattern, or the
    // swatch cadence measured off the sheet when nothing matched yet
    const mkSample = (styleOrNull) => {
      const cnv = document.createElement("canvas");
      cnv.className = "chip-line";
      cnv.width = 56; cnv.height = 12;
      const c2 = cnv.getContext("2d");
      const col = (styleOrNull && styleOrNull.color) || e.color || [0, 0, 0];
      const wgt = styleOrNull ? styleOrNull.width : 1.0;
      c2.strokeStyle = cssColor(col, wgt);
      c2.lineWidth = Math.min(1.5 + (wgt || 0.5) * 1.2, 6);
      // the swatch's own measured cadence is the truth of what the sheet
      // legend DRAWS (paper-space); the matched style's absolute lengths
      // differ under LTSCALE, so never render the chip from those
      let tpl = e.swatch_template;
      if (!tpl || tpl.length < 2) {
        const rep = styleOrNull &&
          state.result.chains.find(c3 => c3.style_id === styleOrNull.style_id);
        tpl = rep && rep.template;
      }
      if (tpl && tpl.length >= 2 && e.klass !== "solid") {
        const span = tpl.reduce((a, b) => a + b, 0);
        const k3 = span > 0 ? Math.min(48 / span, 3.2) : 1;
        c2.setLineDash(tpl.map(v => Math.max(v * k3, 1.4)));
      }
      c2.beginPath(); c2.moveTo(4, 6); c2.lineTo(52, 6); c2.stroke();
      return cnv;
    };
    if (sid === null || sid === undefined) {
      // the legend NAMES this line type but no detected style matches yet -
      // show it honestly as found-but-unmatched instead of hiding it
      const chip = document.createElement("button");
      chip.className = "legend-chip";
      chip.style.opacity = "0.55";
      chip.appendChild(mkSample(null));
      chip.appendChild(document.createTextNode(e.label + " (not matched)"));
      chip.title = "Read from the legend, but no detected line style matches its geometry yet";
      box.appendChild(chip);
      continue;
    }
    const applied = (state.labels.get(sid) || "").startsWith(e.label);
    const chip = document.createElement("button");
    chip.className = "legend-chip" + (applied ? " applied" : "");
    chip.appendChild(mkSample(state.result.styles.find(s2 => s2.style_id === sid)));
    chip.appendChild(document.createTextNode(e.label));
    chip.title = applied
      ? `applied to style ${sid}`
      : `click to label style ${sid} "${e.label}" — hover to highlight`;
    chip.onmouseenter = () => { state.hot = sid; draw(); };
    chip.onmouseleave = () => { state.hot = null; draw(); };
    chip.onclick = () => {
      state.labels.set(sid, e.label + " (legend)");
      setInclude(sid, true);
      renderStyles(); renderLegend(); renderItemized(); draw();
    };
    box.appendChild(chip);
  }
}

$("styleSearch").oninput = () => renderStyles();
// The box now matches CAD layer names too, and a capability nobody is told
// about is one nobody uses - `A-WALL` is not a thing an estimator would try
// in a field advertising "water, dash, solid". Set here rather than in
// index.html so the promise and the filter that keeps it live in one file.
$("styleSearch").placeholder = "Filter line types… (water, dash, solid, A-WALL)";
$("allBtn").onclick = () => { for (const k of [...state.include.keys()]) setInclude(k, true); renderStyles(); renderChips(); renderItemized(); renderMiniLegend(); draw(); };
$("noneBtn").onclick = () => { for (const k of [...state.include.keys()]) setInclude(k, false); renderStyles(); renderChips(); renderItemized(); renderMiniLegend(); draw(); };

// ---------- color bulk-toggle chips ----------
function renderChips() {
  const box = $("colorChips");
  box.innerHTML = "";
  if (!state.result) return;
  const groups = new Map(); // colorKey -> {css, sids: []}
  for (const s of state.result.styles) {
    const key = JSON.stringify(s.color);
    if (!groups.has(key)) groups.set(key, { css: cssColor(s.color), sids: [] });
    groups.get(key).sids.push(s.style_id);
  }
  for (const [, g] of groups) {
    const anyOn = g.sids.some(sid => state.include.get(sid));
    const chip = document.createElement("div");
    chip.className = "color-chip" + (anyOn ? "" : " off");
    chip.style.background = g.css;
    chip.title = `${g.sids.length} style(s) — click to ${anyOn ? "hide" : "show"} all of this color`;
    chip.onclick = () => {
      for (const sid of g.sids) setInclude(sid, !anyOn);
      renderStyles(); renderChips(); renderItemized(); draw();
    };
    box.appendChild(chip);
  }
}

// ---------- live itemized takeoff: the reviewer's memory ----------
// This was a Map that died with the tab, and the comment that stood here
// argued the death was a feature: with nothing kept, a reloaded seat and a
// brand-new seat produce identical output, so nothing in a demo can be
// pre-baked. That property is real and it is preserved below. What it was
// costing is not acceptable though - every label, price, trade, override and
// scale the operator entered was gone the moment the tab closed, and on a
// 15-sheet set that is an evening of work thrown away with no warning.
//
// The two requirements only LOOK like the same requirement:
//   demo integrity - a document NOBODY HAS TOUCHED must read empty
//   usability      - MY edits to MY document must still be here tomorrow
// Both hold at once if memory is written ONLY by an operator action, scoped
// to the document, never seeded, and visibly clearable. An untouched document
// has no entries, so it still reads exactly as a fresh seat does; #memBtn
// says how much is remembered and clears all of it in one click, which is
// what makes a demo on a document we HAVE touched honest instead of lucky.
//
// MEM_V is the schema version and it is load-bearing. The old comment was
// right that a key-shape change cannot catch a reviewer mid-session while the
// store is a Map of the same vintage as the key functions that fill it. Once
// memory outlives the page that guarantee is gone, so any change to a key
// shape MUST bump MEM_V: entries under a superseded version are never read
// and are purged on load, which is the migration.
const MEM_V = "tk1::";
const memWritable = (() => {
  try {
    localStorage.setItem(MEM_V + "?probe", "1");
    localStorage.removeItem(MEM_V + "?probe");
    return true;
  } catch (e) { return false; }  // private window / quota 0 - session-only
})();
let memFull = false;             // quota refused a write: say so, never lie
// Doc-scoped quantity overrides dropped at load - see the purge below. They
// are COUNTED because silently deleting numbers the operator typed is the
// second-worst thing this file can do, and saying so is what keeps it second.
let memDropped = 0;
const sessionMem = new Map();    // mirror, and the entire store when !memWritable
if (memWritable) {
  for (const k of Object.keys(localStorage)) {
    // keys from builds that wrote takeoff decisions into localStorage bare,
    // before any of this was versioned
    if (/^(doc::|measure::|trade::|price:)/.test(k)) localStorage.removeItem(k);
    // a superseded schema: never read, and not left to rot
    else if (/^tk\d+::/.test(k) && !k.startsWith(MEM_V)) localStorage.removeItem(k);
    else if (k.startsWith(MEM_V)) {
      const lk = k.slice(MEM_V.length);
      // A quantity override written before ovKey carried a page. It applied to
      // EVERY sheet of its document and carries no record of which sheet it
      // was typed on, so it cannot be assigned to one. Assigning it to a guess
      // - page 0, say - would put a number the operator never typed for that
      // sheet onto that sheet, rendered identically to one they did: rank-1
      // harm manufactured by the fix. Dropping it restores the DETECTED
      // quantity, which is the defensible number, and the emptied box is
      // visible. Lost work the operator can retype is rank 3.
      //
      // Targeted rather than a MEM_V bump. Bumping the schema would also
      // destroy every key whose shape did NOT change - including the shared
      // price list and trade assignments the Saved-work menu twice promises
      // survive a document reset - silently, on the next page load, with none
      // of the confirmation "Forget everything" demands. That is strictly
      // more destructive than this app's most dangerous button, fired at a
      // moment the operator did not choose.
      if (/^doc::.+::ov:(ft|qty):/.test(lk) && !/::p\d+::ov:/.test(lk)) {
        localStorage.removeItem(k);
        memDropped++;
      } else sessionMem.set(lk, localStorage.getItem(k));
    }
  }
}
const store = {
  getItem: (k) => sessionMem.has(k) ? sessionMem.get(k) : null,
  setItem: (k, v) => {
    const val = String(v);
    // Renderers re-save the value they just read, every render. Only a real
    // CHANGE is allowed to reach the disk, or one price keystroke on a 73-row
    // sheet turns into 73 writes of a string that did not move.
    if (sessionMem.get(k) === val) return;
    const isNew = !sessionMem.has(k);
    sessionMem.set(k, val);
    if (memWritable) {
      try { localStorage.setItem(MEM_V + k, val); }
      catch (e) { memFull = true; }        // full: keep working, warn on the button
    }
    if (isNew || memFull) memBtnDirty();
  },
  // A default the APP chose, not a decision the OPERATOR made. Sibling of
  // setItem in the same way setIncludeTransient is a sibling of setInclude,
  // and for the same reason: writing an app-chosen default into the operator's
  // saved record makes it indistinguishable from a real choice, so it survives
  // a "clear", it inflates the count on the button, and it would quietly
  // outrank a better default later. ewApplyItems and the structure bid sheet
  // both file their rows under Earthwork & Grading this way; the reviewer's
  // own pick still goes through setItem and is still remembered.
  setSession: (k, v) => { sessionMem.set(k, String(v)); },
  removeItem: (k) => {
    if (!sessionMem.delete(k)) return;
    if (memWritable) { try { localStorage.removeItem(MEM_V + k); } catch (e) {} }
    memBtnDirty();
  },
};

// The button is only as honest as it is current, but setItem is called from
// inside render loops - so coalesce to one repaint per task rather than one
// per key.
let memBtnQueued = false;
function memBtnDirty() {
  if (memBtnQueued) return;
  memBtnQueued = true;
  queueMicrotask(() => { memBtnQueued = false; renderMemBtn(); });
}
function renderMemBtn() {
  const b = $("memBtn");
  if (!b) return;
  const n = sessionMem.size;
  // memDropped keeps the button on screen even when nothing else survived,
  // because the one thing the operator must not miss is that numbers they
  // typed are gone.
  b.hidden = n === 0 && memDropped === 0;
  // The deletion is named on the FACE of the button whenever it happened, not
  // only when nothing else survived. On any real seat labels, prices and
  // trades survive the purge, so the old condition put the one thing the
  // operator must not miss behind a hover.
  b.textContent = "Saved work \u00b7 " + n
    + (memDropped ? " \u00b7 " + memDropped + " cleared" : "");
  b.classList.toggle("warn", memFull || !memWritable || memDropped > 0);
  b.title = !memWritable
    ? n + " decisions are being held for THIS SESSION ONLY. This browser will "
      + "not let the page store anything (a private window does this), so "
      + "closing the tab loses all of it."
    : memFull
    ? n + " remembered decisions, and THIS BROWSER'S STORAGE IS FULL. The most "
      + "recent edits are held for this session only and will be lost when the "
      + "tab closes. Clear saved work to make room."
    : n + " decisions remembered in this browser - labels, prices, trades, "
      + "quantity overrides, scales, and which rows are ticked. They come back "
      + "when you reopen a document. Click to forget all of them.";
  if (memDropped)
    b.title += "\n\n" + memDropped + " quantity override(s) saved by an older "
      + "build applied to EVERY sheet of their document and did not record "
      + "which sheet they were typed on. They have been cleared, so those rows "
      + "show the DETECTED quantity again.";
}
// Which saved keys belong to the document currently open. Everything
// doc-scoped is built from docKey(), except the two scale keys, which predate
// it and key on the document name directly.
function memDocPrefixes() {
  const n = state.docName || "unknown";
  return ["doc::" + n + "::", "scale::" + n + "::", "scaletyped::" + n + "::"];
}
function memDocKeys() {
  const pre = memDocPrefixes();
  return [...sessionMem.keys()].filter(k => pre.some(x => k.startsWith(x)));
}

// Two different jobs, and conflating them is how you either destroy an
// evening of pricing or walk into a client demo with last week's labels
// already on screen. So the button asks which one you meant.
$("memBtn").onclick = (e) => {
  e.stopPropagation();
  // A visible, warning-coloured button that does nothing when clicked is
  // worse than no button. When the purge is the only thing left to report,
  // there is nothing to clear - so say that, rather than silently ignoring
  // the click.
  if (!sessionMem.size) {
    if (memDropped)
      setStatus(memDropped + " quantity override(s) from an older build were "
        + "cleared at startup. There is nothing else saved in this browser.", "err");
    return;
  }
  const open = document.querySelector(".mem-menu");
  if (open) { open.remove(); return; }

  const nDoc = memDocKeys().length;
  const nAll = sessionMem.size;
  const m = document.createElement("div");
  m.className = "mem-menu";
  m.onclick = (ev) => ev.stopPropagation();

  const head = document.createElement("div");
  head.className = "mem-menu-head";
  head.textContent = "Saved work";
  m.appendChild(head);

  const mk = (label, note, fn, danger) => {
    const b = document.createElement("button");
    b.className = "mem-menu-item" + (danger ? " danger" : "");
    const t = document.createElement("div");
    t.className = "mem-menu-label"; t.textContent = label;
    const d = document.createElement("div");
    d.className = "mem-menu-note"; d.textContent = note;
    b.append(t, d);
    b.onclick = fn;
    return b;
  };

  m.appendChild(mk(
    "Reset this document \u00b7 " + nDoc,
    state.job
      ? "Clears this PDF's labels, ticks, scales and overrides, AND the "
        + "service's cached detection for it, so the next run is genuinely "
        + "cold. Your shared price list and trade assignments stay."
      : "Open a document first.",
    async () => {
      if (!state.job) return;
      // Ask the service what is actually there BEFORE asking the operator to
      // agree to lose it. The first version of this dialog said "every
      // detection it has cached", which quietly covered the approved sheet
      // exports and the report PDF - operator work, not cache. Naming them
      // with real counts is the difference between consent and a surprise.
      let inv = null;
      try {
        const q = await fetch("/api/job/" + state.job + "/reset?preview=1", { method: "POST" });
        if (q.ok) inv = await q.json();
      } catch (err) { /* fall through to the generic wording */ }
      const c = (inv && inv.counts) || {};
      const bits = [];
      if (c.detection) bits.push(c.detection + " cached sheet detection(s)");
      if (c.render) bits.push(c.render + " page render(s)");
      if (c.approved) bits.push(c.approved + " APPROVED SHEET EXPORT(S)");
      if (c.report) bits.push(c.report + " REPORT PDF");
      if (c.other) bits.push(c.other + " other cached file(s)");
      const willLose = bits.length
        ? "The service will delete, for this PDF:\n  \u2022 " + bits.join("\n  \u2022 ")
          + "\n\nso the next detect runs from scratch in front of whoever is watching."
        : "The service will delete every cached detection for this PDF so the "
          + "next detect runs from scratch.";
      const warn = (c.approved || c.report)
        ? "\n\nNOTE: approved exports and the report PDF are your WORK, not a "
          + "cache. Download the report first if you still need it.\n"
        : "\n";
      if (!confirm("Reset \"" + (state.docName || "this document") + "\" for a fresh run?\n\n"
        + nDoc + " saved decision(s) for this PDF will be forgotten.\n\n"
        + willLose + warn
        + "\nThe PDF itself is not touched. Prices and trade assignments, which "
        + "are shared across documents, are NOT cleared - use \"Forget "
        + "everything\" for those.\n\nThis cannot be undone.")) return;
      for (const k of memDocKeys()) store.removeItem(k);
      let srv = "";
      try {
        const r = await fetch("/api/job/" + state.job + "/reset", { method: "POST" });
        // Say what actually happened. A reset that silently half-failed and
        // then replayed a cached sheet during a demo is the whole reason this
        // button exists.
        if (!r.ok) srv = "the service refused to clear its cache (" + r.status + ")";
      } catch (err) { srv = "the service could not be reached"; }
      if (srv && !confirm("This browser's saved work for the document was cleared, but "
        + srv + ".\n\nThe next detect may still serve a cached result. Reload anyway?")) return;
      location.reload();
    }));

  m.appendChild(mk(
    "Forget everything \u00b7 " + nAll,
    "Every document's labels, ticks, scales and overrides, plus the shared "
      + "price list and trade assignments. Cached detections are left alone.",
    () => {
      if (!confirm("Forget all " + nAll + " remembered decisions?\n\n"
        + "This clears every label, price, trade, quantity override, scale and "
        + "row choice this browser has saved, for every document.\n\n"
        + "The drawings and the detections are untouched - a sheet reopened "
        + "after this detects exactly as it would on a brand-new seat.\n\n"
        + "This cannot be undone.")) return;
      sessionMem.clear();
      if (memWritable)
        for (const k of Object.keys(localStorage))
          if (k.startsWith(MEM_V)) localStorage.removeItem(k);
      memFull = false;
      // Reload rather than re-render: state.include and the rest of the live
      // page were built FROM this memory, and leaving them applied over an
      // emptied store is the exact "screen disagrees with the record" shape
      // that cost 78% of a sheet in F131. A reload IS the fresh seat.
      location.reload();
    }, true));

  // Anchor under the button, then CLAMP into the viewport. Right-anchoring
  // alone put the menu at x = -202 on a 283 px window: the header wraps, which
  // drops the button to the left edge, and a 340 px panel hung off the screen
  // where it could not be clicked at all. Caught by driving the live app -
  // every static check passed, because nothing static knows how wide the
  // window is. Measure first (the panel is in the DOM but not yet painted),
  // then place.
  m.style.visibility = "hidden";
  m.style.left = "0px";
  document.body.appendChild(m);
  const r = $("memBtn").getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight, pad = 8;
  let left = r.right - mw;                                  // prefer right-aligned
  left = Math.min(left, window.innerWidth - mw - pad);
  left = Math.max(pad, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - pad)                  // no room below
    top = Math.max(pad, r.top - 6 - mh);                    // flip above
  if (top + mh > window.innerHeight - pad)                  // still no room
    top = Math.max(pad, window.innerHeight - mh - pad);
  m.style.left = Math.round(left) + "px";
  m.style.top = Math.round(top) + "px";
  m.style.visibility = "";
};
document.addEventListener("click", () => {
  const m = document.querySelector(".mem-menu");
  if (m) m.remove();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const m = document.querySelector(".mem-menu");
  if (m) m.remove();
});
// Memory loaded from a previous session is memory nobody has written to yet
// this page, so nothing has called memBtnDirty. Paint the count once at start
// or a returning operator sees no sign that anything was kept.
renderMemBtn();
// The button title is a hover; deleting the operator's own numbers has to be
// readable without one.
if (memDropped)
  setStatus(memDropped + " quantity override(s) from an older build were "
    + "cleared: they applied to EVERY sheet of their document and did not "
    + "record which sheet you typed them on. Those rows now show the DETECTED "
    + "quantity. Re-enter any you still want, on the sheet it belongs to.", "err");
function priceKey(label) { return "price:" + label; }
// quantity/footage override: the estimator's number beats the detector's.
// PAGE-scoped and UNIT-scoped. The comment that stood here argued for exactly
// that while the key did the opposite: "this sheet has 24 shear walls; another
// sheet doesn't" is the argument for a page in the key, and there was no page
// in the key. A LABEL travels across sheets BY DESIGN - labelKey is doc-wide
// on purpose and measure::<LABEL> is global - so the same named row exists on
// most sheets of a set, and every one of them read the one override. The
// calculators do not even need the transfer: "Site Cut", "Site Fill" and the
// structure labels are literal constants emitted on every sheet. Mirrors
// includeKey's ::p<N> segment.
//
// The UNIT is in the key because a quantity typed while the sheet has NO
// scale is in raw PDF points, and the old key filed it under "ft" - so the
// moment a scale was set, a points figure was served back as feet. Different
// unit, different key, no silent reinterpretation.
//
// No engine_sig here, unlike includeKey. That key names a style_id, which
// only means something inside one result; this one names an operator-typed
// LABEL, which survives a re-detect. Adding the signature would silently
// discard the estimator's own number on every engine change.
// Calculator output the operator COMMITTED - earthwork cut and fill, trench
// volumes, structure rows, symbol counts, and which filled areas they ticked.
// These were page state and died on a page change, silently: run Earthwork,
// flick to the next sheet to check something, come back, and the cubic yards
// were gone with nothing saying so. They are decisions (every one of them is
// behind an explicit "Add to takeoff" or a tick), so they persist like every
// other decision.
//
// Area rows are stored as the SELECTION, not as the resulting rows: their
// quantities are re-derived from the geometry at the scale in force every
// render (see arApplyItems), which is what makes them follow a scale
// correction. Storing the numbers would freeze exactly what that fixed.
function calcKey() { return docKey() + "::p" + state.page + "::calc"; }
function areaSelKey() { return docKey() + "::p" + state.page + "::areasel"; }

function calcSave() {
  if (!state.result) return;
  // `_area` rows are derived; never store them.
  const rows = state.extraItems.filter(it => !it._area)
    .map(it => ({ label: it.label, qty: it.qty, unit: it.unit }));
  if (rows.length) store.setItem(calcKey(), JSON.stringify(rows));
  else store.removeItem(calcKey());

  const sel = {
    rows: state.areaRows.map(r => ({ group_id: r.group_id, unit: r.unit,
                                     label: r.label })),
    inc: [...state.areaInc].filter(([, v]) => v).map(([k]) => k),
    labels: [...state.areaLabels],
  };
  if (sel.rows.length || sel.inc.length || sel.labels.length)
    store.setItem(areaSelKey(), JSON.stringify(sel));
  else store.removeItem(areaSelKey());
}

function calcRestore() {
  try {
    const rows = JSON.parse(store.getItem(calcKey()) || "[]");
    if (Array.isArray(rows))
      for (const r of rows)
        if (r && r.label && isFinite(r.qty))
          state.extraItems.push({ label: String(r.label), qty: +r.qty,
                                  unit: String(r.unit || "EA") });
  } catch (e) { /* corrupt entry: start clean rather than throw */ }
  try {
    const sel = JSON.parse(store.getItem(areaSelKey()) || "null");
    if (sel) {
      state.areaRows = Array.isArray(sel.rows) ? sel.rows : [];
      state.areaInc = new Map((sel.inc || []).map(k => [k, true]));
      state.areaLabels = new Map(sel.labels || []);
    }
  } catch (e) { /* same */ }
}

// ---------- calculator INPUT sidecar (the server record) -----------------
// calcSave above keeps the priced ROWS in this browser; this keeps the
// INPUTS behind them on the SERVER - p<N>_calcstate.json in the job dir,
// the same pattern as the scale pick - so a reload, and any OTHER seat
// opening the same page, gets the earthwork surface assignments, corrected
// elevations, layer stacks, spot toggles, datum, limit of work, trench
// setup and structure outlines back instead of an empty panel underneath a
// priced takeoff row.
//
// Inputs, never results. Earthwork volumes are integrated server-side, so
// a restored panel shows its inputs and NO result until Calculate is
// pressed again - nothing is staged. Chain- and style-keyed choices apply
// only while those ids still exist in the loaded detection; the rest are
// COUNTED and said out loud in the panel (calcDropText), never dropped
// silently. The blob carries engine_sig so "the chain renumbered" can be
// told from "the engine changed since these were saved".
let calcStateTimer = null;
let calcStatePending = null;  // {url, txt, gen} snapshot taken at edit time
let calcStateSent = null;     // last blob known to be on the server, as text

function calcStateUrl() {
  return `/api/job/${state.job}/page/${state.page}/calcstate`;
}

// JSON numbers only - +null is 0 and +"" is 0, and both have already put
// wrong elevations into panels elsewhere in this file's history
const calcNum = v => (typeof v === "number" && isFinite(v)) ? v : null;

function calcStatePayload() {
  if (!state.result) return null;
  const saved = state.calcSaved || {};
  const out = { v: 1, engine_sig: state.result.engine_sig || null };
  if (state.ew) {
    out.ew = {
      rows: state.ew.rows.map(r => ({
        chain_id: r.chain_id,
        z: calcNum(r.z), surface: r.surface || null,
        width: r.width || 0, dist: r.dist == null ? null : r.dist,
        manual: !!r.manual,
      })),
      layers: {
        existing: state.ew.layers.existing.map(l => Object.assign({}, l)),
        proposed: state.ew.layers.proposed.map(l => Object.assign({}, l)),
      },
      removed: (state.ew.removed || []).slice(),
      spotOn: Object.assign({}, state.ew.spotOn),
      spotSide: state.ew.spotSide,
      spotDatum: calcNum(state.ew.spotDatum),
      areaSf: calcNum(state.ew.areaSf),
      added: !!state.ew.added,
    };
    // Picked/stitched boundary: the SEED chain, not the ring - geometry
    // re-derives from the live detection on restore, so a re-detect that
    // renumbers or improves the family re-stitches instead of replaying
    // stale points. HAND-DRAWN boundary: the points themselves - they are
    // the operator's own geometry, tied to no chain, and a re-detect can
    // neither improve nor orphan them.
    const m = state.ewBound && /^chain (\d+)$/.exec(state.ewBound.src || "");
    const seed = state.ewBound && typeof state.ewBound.seed === "number"
      ? state.ewBound.seed : (m ? +m[1] : null);
    if (seed !== null) out.ew_bound = { chain_id: seed };
    else if (state.ewBound && state.ewBound.src === "drawn outline")
      out.ew_bound = { pts: state.ewBound.pts.map(q =>
        [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]) };
    else out.ew_bound = null;
  } else {
    // panel never opened this session: the earlier record stands untouched
    if (saved.ew) out.ew = saved.ew;
    if (saved.ew_bound) out.ew_bound = saved.ew_bound;
  }
  if (state.tr) {
    out.tr = {
      style_id: typeof state.tr.style_id === "number" ? state.tr.style_id : null,
      od_in: state.tr.od_in, d0_ft: state.tr.d0_ft, d1_ft: state.tr.d1_ft,
      rules: state.tr.rules.map(r => ({ to_ft: r.to_ft, clr_in: r.clr_in })),
    };
  } else if (saved.tr) out.tr = saved.tr;
  const st = (state.st && state.st.result === state.result
              && state.calcStApplied) ? state.st : null;
  if (st) {
    out.st = {
      items: st.items.map(it => ({
        name: it.name, pts: it.pts.map(p => [p[0], p[1]]),
        source: it.source, chain_id: it.chain_id == null ? null : it.chain_id,
        gap_pt: it.gap_pt || 0, depth_ft: it.depth_ft,
        layback_ft: it.layback_ft, footing_ft: it.footing_ft,
      })),
      seq: st.seq, depth_ft: st.depth_ft,
      layback_ft: st.layback_ft, footing_ft: st.footing_ft,
    };
  } else if (saved.st) out.st = saved.st;
  // WORK AREA boxes (additive key "zones"): plain page-pt rects, keyed to
  // no chain or style id, so a re-detect can never orphan them - restore
  // re-applies them against whatever the live detection holds. Unlike the
  // panels above there is no "never opened" case: wzApplySaved() runs on
  // every load before the first snapshot, so state.workZones IS the truth
  // and an empty list correctly writes no key (= zones cleared).
  if (state.workZones && state.workZones.length)
    out.zones = state.workZones.map(z => [z[0], z[1], z[2], z[3]]);
  // GRADING ZONES (additive key "gzones"): the operator's INPUTS only -
  // polygon, declared design, strip, name, added flag. Results are
  // recomputed through the zone endpoint on restore, never staged from
  // storage (the rule every calculator here follows). Like the work-area
  // boxes there is no "never opened" carry case: gzApplySaved runs on
  // every load before the first snapshot, so state.gzones IS the truth
  // and an empty list correctly writes no key (= zones cleared).
  if (state.gzones && state.gzones.length)
    out.gzones = state.gzones.map(z => ({
      id: z.id, name: z.name,
      polygon: z.polygon.map(q => [Math.round(q[0] * 10) / 10,
                                   Math.round(q[1] * 10) / 10]),
      design: z.design, strip_in: z.strip_in,
      added: !!z.added, show_nums: !!z.showNums,
    }));
  // Review-queue check-offs (additive key, same carry-forward rule as the
  // panels above: until the queue has seeded from the sidecar, the earlier
  // record stands untouched). Ids only - a check-off is the operator saying
  // "I looked at this", never a number.
  if (state.ckDone) out.checks = { done: [...state.ckDone].sort() };
  else if (saved.checks) out.checks = saved.checks;
  return out;
}

// Debounced save. The payload is SNAPSHOTTED at edit time: the operator can
// flip pages inside the debounce window, and this save must go to the page
// the edit was made on, not wherever state.page points a second later.
function calcStateDirty() {
  if (!state.result) return;
  if (!state.calcSavedLoaded) {
    if (state.calcSaveBroken && !state.calcSaveWarned) {
      state.calcSaveWarned = true;
      setStatus("calculator inputs are NOT being saved: the saved-inputs "
        + "record could not be read when this page loaded. Reload to retry.", "err");
    }
    return;
  }
  const body = calcStatePayload();
  if (!body) return;
  calcStatePending = { url: calcStateUrl(), txt: JSON.stringify(body), gen: state.gen };
  if (calcStateTimer) clearTimeout(calcStateTimer);
  calcStateTimer = setTimeout(calcStatePush, 1000);
}

async function calcStatePush() {
  if (calcStateTimer) { clearTimeout(calcStateTimer); calcStateTimer = null; }
  const p = calcStatePending;
  calcStatePending = null;
  if (!p || p.txt === calcStateSent) return;
  try {
    const r = await fetch(p.url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: p.txt,
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      setStatus(e.detail || ("calculator inputs NOT saved (" + r.status + ")"), "err");
      return;
    }
    if (p.gen === state.gen) {
      calcStateSent = p.txt;
      state.calcSaved = JSON.parse(p.txt);
    }
  } catch (e) {
    setStatus("calculator inputs NOT saved " + '\u2014' + " server unreachable", "err");
  }
}

// One GET per page load, awaited by loadResult before the panels can paint.
async function calcStateLoad(gen) {
  state.calcSaved = null; state.calcSavedLoaded = false; state.calcStApplied = false;
  state.calcSaveBroken = false; state.calcSaveWarned = false;
  calcStateSent = null;
  const job = state.job, page = state.page;
  let j = {}, ok = false;
  try {
    const r = await fetch(`/api/job/${job}/page/${page}/calcstate`);
    if (r.ok) { j = await r.json(); ok = true; }
  } catch (e) { /* fall through: ok stays false */ }
  if (gen !== state.gen) return;
  if (!ok) {
    // A record that CANNOT BE READ is not the same as no record: saving
    // over it from a blank panel would destroy the operator's inputs.
    // Saves stay off for this page load, and the first edit says so.
    state.calcSaveBroken = true;
    return;
  }
  state.calcSaved = (j && typeof j === "object" && !Array.isArray(j)) ? j : {};
  state.calcSavedLoaded = true;
  // zones BEFORE the snapshot below: they restore straight into state (no
  // panel to wait for), and a snapshot taken without them would make the
  // first unrelated edit's save look like a change to them
  wzApplySaved();
  // grading zones restore straight into state too (their geometry and
  // design are page facts, tied to no chain); their RESULTS recompute
  // asynchronously through the endpoint after the snapshot below
  gzApplySaved();
  // what the server holds right now, so a no-op save is never sent
  calcStateSent = JSON.stringify(calcStatePayload());
  stApplySaved();
  gzRestoreCompute();
}

// The count-of-dropped sentence, in the panel where the loss happened.
function calcNotePut(hintId, txt) {
  const anchor = $(hintId);
  if (!anchor || !anchor.parentElement) return;
  let n = anchor.parentElement.querySelector(".calc-restore-note");
  if (!txt) { if (n) n.remove(); return; }
  if (!n) {
    n = document.createElement("div");
    n.className = "calc-restore-note";
    anchor.insertAdjacentElement("afterend", n);
  }
  n.textContent = txt;
}

function calcDropText(n) {
  const sig = state.calcSaved && state.calcSaved.engine_sig;
  const cur = state.result && state.result.engine_sig;
  return n + " earlier choice" + (n === 1 ? "" : "s") + " no longer "
    + (n === 1 ? "matches" : "match") + " this detection"
    + (sig && cur && sig !== cur
        ? " (the engine has changed since they were saved)" : "")
    + " and " + (n === 1 ? "was" : "were") + " not applied.";
}

// Merge the saved earthwork inputs into the panel state ewBtn just built
// from /earthwork/suggest. Chain-keyed values only where the chain still
// exists; everything else counted into the panel note.
function ewApplySaved() {
  const saved = state.calcSaved || {};
  const sv = saved.ew;
  let dropped = 0, applied = 0;
  const chains = new Map(state.result.chains.map(c => [c.chain_id, c]));
  if (sv) {
    const live = new Map(state.ew.rows.map(r => [r.chain_id, r]));
    for (const r of (Array.isArray(sv.rows) ? sv.rows : [])) {
      if (!r || typeof r.chain_id !== "number") continue;
      const surf = (r.surface === "existing" || r.surface === "proposed") ? r.surface : null;
      const row = live.get(r.chain_id);
      const ch = chains.get(r.chain_id);
      if (row) {
        if (calcNum(r.z) !== null) row.z = r.z;
        row.surface = surf;
        applied++;
      } else if (ch && !ch.custom) {
        // usually a hand-added contour: its chain is still on the sheet
        state.ew.rows.push({ chain_id: r.chain_id,
          z: calcNum(r.z) !== null ? r.z : NaN,
          width: calcNum(r.width) !== null ? r.width : (ch.width || 0),
          dist: r.dist == null ? null : r.dist,
          surface: surf, manual: !!r.manual });
        applied++;
      } else dropped++;
    }
    if (Array.isArray(sv.removed) && sv.removed.length) {
      // deletions the operator saved: drop what the fresh suggest re-seeded,
      // except chains the saved rows themselves still carry (add > delete)
      const savedIds = new Set((Array.isArray(sv.rows) ? sv.rows : [])
        .filter(r => r && typeof r.chain_id === "number").map(r => r.chain_id));
      const rm = new Set(sv.removed.filter(id => !savedIds.has(id)));
      const n0 = state.ew.rows.length;
      state.ew.rows = state.ew.rows.filter(r => !rm.has(r.chain_id));
      state.ew.removed = sv.removed.slice();
      applied += n0 - state.ew.rows.length;
    }
    if (sv.layers && Array.isArray(sv.layers.existing) && Array.isArray(sv.layers.proposed)) {
      const lay = (l, ex) => Object.assign(
        { name: String((l && l.name) || ""), thickness_in: calcNum(l && l.thickness_in) || 0 },
        ex ? { reuse_pct: calcNum(l && l.reuse_pct),
               respread_pct: calcNum(l && l.respread_pct),
               destination: (l && l.destination !== undefined) ? l.destination : "on site" } : {});
      state.ew.layers = { existing: sv.layers.existing.map(l => lay(l, true)),
                          proposed: sv.layers.proposed.map(l => lay(l, false)) };
    }
    if (sv.spotOn && typeof sv.spotOn === "object") state.ew.spotOn = Object.assign({}, sv.spotOn);
    if (sv.spotSide === "existing" || sv.spotSide === "proposed") state.ew.spotSide = sv.spotSide;
    if (calcNum(sv.spotDatum) !== null) state.ew.spotDatum = sv.spotDatum;
    if (calcNum(sv.areaSf) !== null && sv.areaSf > 0) state.ew.areaSf = sv.areaSf;
    state.ew.added = !!sv.added;
  }
  const bd = saved.ew_bound;
  if (bd && Array.isArray(bd.pts) && bd.pts.length >= 3 && !state.ewBound) {
    if (ewBoundSet(bd.pts, "drawn outline")) {
      state.ewBound.seed = null;
      applied++;
    } else dropped++;
  } else if (bd && typeof bd.chain_id === "number" && !state.ewBound) {
    const ch = chains.get(bd.chain_id);
    const st = ch ? ewBoundStitch(ch) : null;
    if (st && ewBoundSet(st.pts, st.n > 1
          ? `${st.n} lines stitched (${(ch.layer || "style " + ch.style_id).split("|").pop()})`
          : "chain " + ch.chain_id)) {
      state.ewBound.seed = ch.chain_id;
      applied++;
    }
    else dropped++;
  }
  calcNotePut("ewHint", dropped ? calcDropText(dropped) : "");
  if (applied) setStatus("earthwork inputs restored from this page's saved record "
    + '\u2014' + " press Calculate to recompute");
  return dropped;
}

function trApplySaved() {
  const sv = (state.calcSaved || {}).tr;
  let dropped = 0;
  if (sv) {
    const t = state.tr;
    if (typeof sv.style_id === "number") {
      if (state.result.styles.some(s => s.style_id === sv.style_id)) t.style_id = sv.style_id;
      else dropped++;   // style ids renumber on a re-detect, like chain ids
    }
    if (calcNum(sv.od_in) !== null) t.od_in = sv.od_in;
    if (calcNum(sv.d0_ft) !== null) t.d0_ft = sv.d0_ft;
    if (calcNum(sv.d1_ft) !== null) t.d1_ft = sv.d1_ft;
    if (Array.isArray(sv.rules) && sv.rules.length)
      t.rules = sv.rules.map(r => ({
        to_ft: calcNum(r && r.to_ft) !== null ? r.to_ft : 99,
        clr_in: calcNum(r && r.clr_in) !== null ? r.clr_in : 6 }));
    setStatus("trench inputs restored from this page's saved record "
      + '\u2014' + " press Calculate to recompute");
  }
  calcNotePut("trHint", dropped ? calcDropText(dropped) : "");
  return dropped;
}

// Structure outlines are geometry in page pt, not chain references, so they
// survive a re-detect intact. Their bid-sheet rows are re-DERIVED (stCalc at
// the scale in force), never restored as stored numbers - and they were all
// behind an explicit "Add to takeoff" when they were saved, so re-deriving
// them into the takeoff honours a consent that was actually given.
function stApplySaved() {
  if (state.calcStApplied || !state.calcSavedLoaded) return;
  if (!state.st || state.st.result !== state.result) return;
  state.calcStApplied = true;
  const sv = (state.calcSaved || {}).st;
  if (!sv) return;
  const st = state.st;
  if (Array.isArray(sv.items) && !st.items.length) {
    for (const it of sv.items) {
      if (!it || !Array.isArray(it.pts)) continue;
      const pts = it.pts
        .filter(p => Array.isArray(p) && calcNum(p[0]) !== null && calcNum(p[1]) !== null)
        .map(p => [p[0], p[1]]);
      if (pts.length < 3) continue;
      st.items.push({
        name: String(it.name || ("Structure " + (st.items.length + 1))), pts,
        source: it.source === "line" ? "line" : "drawn",
        chain_id: typeof it.chain_id === "number" ? it.chain_id : null,
        gap_pt: calcNum(it.gap_pt) || 0,
        depth_ft: calcNum(it.depth_ft) !== null ? it.depth_ft : 8,
        layback_ft: calcNum(it.layback_ft) !== null ? it.layback_ft : 4,
        footing_ft: calcNum(it.footing_ft) !== null ? it.footing_ft : 0,
      });
    }
  }
  if (calcNum(sv.seq) !== null) st.seq = sv.seq;
  if (calcNum(sv.depth_ft) !== null) st.depth_ft = sv.depth_ft;
  if (calcNum(sv.layback_ft) !== null) st.layback_ft = sv.layback_ft;
  if (calcNum(sv.footing_ft) !== null) st.footing_ft = sv.footing_ft;
  if (st.items.length && stFtPerPt()) {
    stApplyItems();
    if (!$("stPanel").hidden) renderSt();
    setStatus(st.items.length + " structure outline" + (st.items.length === 1 ? "" : "s")
      + " restored from this page's saved record");
  }
}

// Any input or click inside a calculator panel may be an input edit; the
// 1s debounce collapses bursts, and an identical blob is never re-sent.
// Delegation instead of per-field hooks so a field added later cannot be
// forgotten. Edits made on the CANVAS (limit-of-work pick, + Add contour)
// call calcStateDirty at their own mutation sites.
for (const pid of ["ewPanel", "trPanel", "stPanel"]) {
  const el = $(pid);
  if (el) {
    el.addEventListener("input", calcStateDirty);
    el.addEventListener("click", calcStateDirty);
  }
}

function ovKey(label, unit) {
  return docKey() + "::p" + state.page + "::ov:" + unit + ":"
       + label.trim().toUpperCase();
}
// ---------- style memory: the reviewer's decisions ARE the takeoff -------
// Deterministic consistency: once a style is labeled / set to EA, that
// decision is stored against (document, style fingerprint) and reapplies
// identically on every restart, redetect, and reopen. No model involved.
//
// TWO records, TWO keys, on purpose. A label is a statement about a LINE
// TYPE ("this cadence on this layer is the sanitary sewer") and must follow
// it from sheet to sheet - that transfer is the feature, it is why a
// fingerprint exists at all. An include tick is a statement about THIS
// SHEET ("measure these 22 rows of C4.3"); carrying it to another page is
// not a feature, it is the lost prune. They shared a key and both were
// wrong in different directions. See labelKey / includeKey below.
function docKey() {
  return "doc::" + (state.docName || "unknown");
}
// The engine's identity for a result, when it publishes one: older cached
// results predate the field (50 of 115 on this box), and a result with no
// signature is self-consistent for as long as it is the loaded result, so
// a constant stand-in is correct rather than merely convenient.
function sigKey() {
  return (state.result && state.result.engine_sig) || "nosig";
}
// SET-DECISIONS-BEGIN
// Everything from here to SET-DECISIONS-END is kept pure (no DOM, no
// state.*, no store.*) so tests/test_set_decisions.js can eval the block
// alone - the same technique as the TRENCH-MATH block.
// chain._weight_class (chain.py:3310), ported verbatim: hairline / light /
// medium / heavy / extra. Kept as a five-line duplicate rather than a new
// server field because the fix is then one file and no engine_sig moves;
// if it ever drifts from the Python, styles that the engine split start
// sharing a key again - which is the defect below, not a new one.
function weightClass(w) {
  const lim = [0.35, 0.75, 1.5, 2.6];
  for (let i = 0; i < lim.length; i++) if (w <= lim[i]) return i;
  return 4;
}
// The colour AS THE ENGINE HOLDS IT. cssColor() is a rendering decision -
// it rounds to 8 bits and collapses every near-white to one grey so faint
// plotter linework is visible on screen - and a rendering decision has no
// business deciding which two styles are the same thing. Measured: 7 groups
// in the wide sample fuse two distinct engine colours, all of them through
// that near-white collapse.
function rawColor(c) {
  if (!c || !c.length) return "-";
  return c.map(v => Math.round(v * 1e6) / 1e6).join(",");
}
// The style fingerprint = the engine's OWN family key.
//
// chain._assign_styles (chain.py:3247) groups chains on
//     (klass, color, _weight_class(width), layer)
// and then splits each family by dash cadence, so two style rows differ in
// at least one of those five terms BY CONSTRUCTION. This function used to
// keep three of them, in coarsened form, and drop `layer` entirely:
//
//     [st.class, Math.round((st.width||0)*2)/2, cssColor(st.color),
//      st.signature].join("|")
//
// so every collision it produced was a distinction the engine had already
// decided to make. Measured over 14,945 style rows on 240 sheets (48 cached
// detect results + a 192-page stratified recompute): 33.1% / 28.7% of styles
// shared a fingerprint with a different style, worst group 41 on one page,
// and 91.4% of the colliding groups the CAD layer can adjudicate were two or
// more GENUINELY DIFFERENT layers. Splitting by whether the sheet has layers
// at all: 37.4% collisions on layered pages, 0.8% on unlayered ones. The
// dropped layer was almost the whole of it.
// (out/verify/2026-08-23/stylefp/STYLEFP.md, tables in q1_*/q2_* .tsv)
//
// Restoring all five terms takes that to zero, and zero here is a theorem
// rather than a corpus result: two rows that agree on class, weight class,
// exact colour, layer and cadence are the same family, and _assign_styles
// does not emit a family twice. Measured 0 of 5,577 and 0 of 9,368.
//
// What it costs is real and is the reason this is a judgement and not an
// obvious win: the FULL layer string keeps the XREF host prefix, so
// `BARN EAST|S-FNDN` and `PRIM BDRM|S-FNDN` no longer share a label. Net on
// the cached corpus: 1,621 -> 1,557 true cross-page label transfers (-64);
// on the wide corpus 906 -> 907 (+1). Enumerated (22_lostxfers.js): 86 lost
// and 22 gained on cached, 16 and 17 on wide. 78 of the 86 are the XREF
// host prefix; the other 8 are the same layer plotted either side of a
// _weight_class edge on two sheets (0.3 vs 0.4 pt at 0.35, 2.4 vs 2.7 at
// 2.6) - which the engine also treats as two families. The gains are
// transfers that main scored as landing on the WRONG layer and now land
// only on the right one.
// A transfer that fails to happen is an empty label box the operator can
// see and retype; a transfer that happens to the wrong linework is a priced
// number with no symptom. AGENT-BRIEF section 0 ranks those, and that
// ranking is what picks the full layer over its leaf.
//
// WHAT THIS STILL DOES NOT FIX. Every term added here comes from the
// document, so two styles on DIFFERENT PAGES that carry no CAD layer at all
// remain indistinguishable and a label still travels between them. 21.0%
// (cached) / 27.8% (wide) of style rows have no layer, and 460 / 590
// cross-page label transfers under this key have no layer on either side
// (residual.txt). Reproduced live: page 11 style 61, 483.2 ft of contour,
// takes the name typed on style 47 of page 12 under BOTH builds. Within one
// page it cannot happen (0 collisions), and every transfer the CAD layer can
// adjudicate as wrong is gone (304 -> 0 cached, 323 -> 0 wide). Refusing to
// transfer a label at all when neither side has a layer would also throw
// away the correct ones in that class; that trade is not measured and is
// DEFERRED - nobody is on it.
function styleFp(st) {
  return [st.class, "w" + weightClass(st.width || 0), rawColor(st.color),
          st.signature, "L=" + (st.layer || "")].join("|");
}
// ---------- set-level decisions (EXCAVATION-PLAN §7 item 5) ----------
// An include/exclude the operator makes BY HAND on one style row is also
// recorded against the whole document, so excluding the title-block style
// on sheet 1 holds on sheets 2-48. Three rules, ranked:
//   1. the page's own record (includeKey) ALWAYS outranks the set-level
//      one - the page-level override the operator sees is just the same
//      checkbox, and it keeps winning on that page forever;
//   2. only styles with a CAD layer participate (setDecEligible). The
//      styleFp comment above documents the residue: rows with NO layer on
//      DIFFERENT pages are indistinguishable under every key this file can
//      build, and a label that travels wrongly is a visible typo while an
//      EXCLUSION that travels wrongly is silently deleted footage. So
//      no-layer rows abstain and keep their per-page seeds - 529/2,664
//      rows (19.9%) on Barn, 103/1,059 (9.7%) on Kayden, 22/22 on the
//      ellis sheet, where the whole feature therefore stays inert;
//   3. only the row's own checkbox writes the set-level record. Bulk
//      gestures (all / none / color chips / AI apply / scope filter) stay
//      page-scoped: "none" on sheet 1 must not empty sheets 2-48.
//
// MEASURED 2026-08-30, before building, offline detect_page on this tree:
// Barn 15 pages / 2,664 style rows, Kayden 12-page spread / 1,059 rows,
// plus cached Kayden p38-39 (327) and ellis p42 (22). A candidate key of
// (layer LEAF, class, signature rounded to 1 pt) fuses rows the engine
// split ON THE SAME PAGE - different-looking styles by construction - for
// 714/2,664 rows (26.8%) on Barn and 262/1,059 (24.7%) on Kayden, worst
// group 14 rows, and 7 Kayden groups put 54,985 pt of real linework under
// an annotation row's key: an exclusion there deletes footage silently,
// so leaf-keyed inheritance is dead on arrival. styleFp collides on
// 0/2,664, 0/1,059, 0/327 and 0/22 (the theorem above, re-measured
// anyway). Coverage under styleFp with this eligibility rule: 948/2,067
// eligible later-page rows (45.9%) already have a key on an earlier page
// on Barn, 495/956 (51.8%) on Kayden - the misses are mostly dash-cadence
// jitter (of 6,581 Barn cross-page pairs matched on layer+class+weight+
// colour, 3,328 = 50.6% agree on cadence too), which fails SAFE: the row
// keeps its seed and its checkbox. The headline case holds: excluding
// C3.0's four G-ANNO-TTLB title-block styles reaches every TTLB row on
// all 14 other Barn sheets (40/40). A rounded-signature styleFp variant
// also measured 0 collisions and would add +84/+18 covered rows, but its
// zero is a corpus fact, not a construction (Kayden p38 carries
// 'd8.8 g4.5' and 'd9.1 g4.5' as two rows, kept apart only by the XREF
// prefix in the full layer), and the label record travels on the exact
// signature - one identity for both records, so exact it stays.
function setDecEligible(st) {
  return !!(st && (st.layer || "").trim());
}
// The record's identity = styleFp, the SAME fingerprint the label record
// travels on: if the name typed on sheet 1 follows a row to sheet 40, the
// exclusion clicked next to that name follows the same row - one identity
// for both records, never two that can disagree.
function setDecKey(docKeyStr, st) {
  return docKeyStr + "::setinc::" + styleFp(st);
}
// Precedence, pure so the test can pin it. Records are the stored strings
// ("1" / "0"), null or undefined = no record. Returns null (no decision -
// the per-page seed stands) or {on, inherited}.
function setDecResolve(pageRec, docRec, eligible) {
  if (pageRec === "1" || pageRec === "0")
    return { on: pageRec === "1", inherited: false };
  if (eligible && (docRec === "1" || docRec === "0"))
    return { on: docRec === "1", inherited: true };
  return null;
}
// SET-DECISIONS-END
// The label / EA record: keyed on the line type, doc-wide, so it travels
// across pages. That is the capability; do not scope this one to a page.
function labelKey(st) {
  return docKey() + "::" + styleFp(st);
}
// The include record: keyed on the exact style row of THIS page of THIS
// result. style_id is an ordinal inside one page's style table - it means
// nothing anywhere else - so the key names the only scope in which it is
// valid, and _assign_styles is deterministic inside it (measured: two runs
// of Barn Civil p12 agree 151/151, C4.0 p0 113/113). Two consequences:
//   * within a page an include tick can no longer reach another row, which
//     is the lost prune (5 styles / 16,558.7 ft came back as 22 styles /
//     28,248.2 ft, x1.706, through one page round trip);
//   * across pages it no longer transfers at all - 942 (cached) / 674
//     (wide) leaks stop. Include defaults are seeded per page anyway.
// engine_sig is in the key because style_id only survives while the result
// does: across an engine change only 43 of 154 style_ids kept their meaning.
function includeKey(st) {
  return docKey() + "::p" + state.page + "::" + sigKey()
       + "::inc::" + st.style_id;
}
// Every write to state.include goes through here. The individual row
// checkbox persisted its choice and NOTHING ELSE DID, so `none` + a hand
// pick, then navigating away and back, silently restored every style the
// operator had turned off - memApply() reads the store and the store still
// said ON. Measured live on Barn Civil C4.3: an approved 4,927.3 ft became
// 44,352.9 ft on re-approve, 9.00x, same button, no warning. Shape B from
// CLAUDE.md section 5, in the UI: one fact, five writers, one of them
// keeping the record. Route new writers through here too.
// (That fix made every writer record; it left the record keyed on a
// fingerprint shared with other styles and other pages, which is the
// second half of the same bug - see includeKey.)
function setInclude(sid, on) {
  state.include.set(sid, !!on);
  // any page-level write supersedes an inherited tick for this row, so the
  // disclosure line stops counting it the moment the operator overrides it
  state.inheritedInc.delete(sid);
  const st = state.result && state.result.styles.find(x => x.style_id === sid);
  if (!st) return;                       // nothing to key the record on
  try { store.setItem(includeKey(st), on ? "1" : "0"); }
  catch (e) { /* private mode: the session still honours the click */ }
}

// The set-level twin of setInclude's record: called ONLY from the row's own
// checkbox (rule 3 above), AFTER setInclude has kept the page record, and
// never from bulk gestures or the scope filter's put-back branches. Writing
// it is what makes the same hand decision hold on the sheets the operator
// has not visited yet; their visited sheets keep their own page records,
// which outrank this one.
function setIncludeSetWide(st, on) {
  if (!st || !setDecEligible(st)) return;
  try { store.setItem(setDecKey(docKey(), st), on ? "1" : "0"); }
  catch (e) { /* private mode: the page record already failed the same way */ }
}

// The scope filter's twin of setInclude, and the difference is the whole
// point: it moves the tick WITHOUT recording it. A declared trade is a
// VIEW over the sheet, not a decision about it - "show everything" must
// put every row back exactly, and a page change must leave no trace.
// Writing these through setInclude laundered them into the include record,
// where scopeApply's own undo set (page state) could no longer reach them:
// measured live on Barn Civil printed sheet 3, 178.0k ft / 165 ticked ->
// declare -> 64.9k / 126 -> page away and back -> 39.2k / 104 -> "show
// everything" -> still 39.2k / 104, with the bar reporting the reduced set
// as the detector's own baseline. 138.8k ft, 78.0%, gone with no symptom.
// Found by Gate 1 driving the app; the patch passed every static check.
// An operator ticking a row by hand still goes through setInclude and is
// still remembered - that IS a decision.
function setIncludeTransient(sid, on) {
  state.include.set(sid, !!on);
}
function memSave(st, touchedMeasure) {
  const label = (state.labels.get(st.style_id) || "").trim();
  const measure = state.measureMode.get(st.style_id) === "object" ? "object" : "";
  const k = labelKey(st);
  // The record carries `measure` ONLY when the LF/EA toggle was actually
  // touched. memApply distinguishes three states by hasOwnProperty - EA,
  // explicitly-LF, and never-decided - and writing measure:"" on every
  // LABEL edit made the third unreachable for any named style, which
  // silently cut the cross-document measure::<LABEL> memory off from
  // exactly the typed names it exists to serve. Gate 1 demonstrated it
  // live on Barn Civil engine page 12 = printed sheet 13, style 84.
  const prev = (() => { try { return JSON.parse(store.getItem(k) || "null"); }
                        catch (e) { return null; } })();
  const keepMeasure = touchedMeasure ||
        (prev && Object.prototype.hasOwnProperty.call(prev, "measure"));
  const rec = keepMeasure ? { label, measure } : { label };
  if (label || (keepMeasure && measure))
    store.setItem(k, JSON.stringify(rec));
  else store.removeItem(k);
  // label-level measure memory travels ACROSS documents: "shear wall" set
  // to EA once means shear walls count as objects everywhere
  if (label && measure)
    store.setItem("measure::" + label.toUpperCase(), measure);
}
function memApply() {
  if (!state.result) return;
  state.inheritedInc = new Map();
  for (const st of state.result.styles) {
    // page record first, set-level record second, seed otherwise - the
    // ranking lives in setDecResolve so the test can pin it. Inherited
    // applications are counted and DISCLOSED (renderStyles), never silent.
    const dec = setDecResolve(store.getItem(includeKey(st)),
                              store.getItem(setDecKey(docKey(), st)),
                              setDecEligible(st));
    if (dec) {
      state.include.set(st.style_id, dec.on);
      if (dec.inherited) state.inheritedInc.set(st.style_id, dec.on);
    }
    // three states, not two: EA / explicitly-LF / never decided. The record
    // stores measure:"" for "the operator put this back to LF", and reading
    // that as "no opinion" let the label-level default below overrule it -
    // first-writer-wins again, CLAUDE.md section 5. Rank them instead: this
    // style's own record is the more specific fact and wins outright.
    let own = null;
    const raw = store.getItem(labelKey(st));
    if (raw) {
      try {
        const m = JSON.parse(raw);
        if (m.label) state.labels.set(st.style_id, m.label);
        if (Object.prototype.hasOwnProperty.call(m, "measure"))
          own = (m.measure === "object");
      } catch (e) {}
    }
    if (own !== null) {
      if (own) state.measureMode.set(st.style_id, "object");
      else state.measureMode.delete(st.style_id);
    } else {
      // no record of its own: the cross-document label memory is the
      // default ("shear wall counts as objects everywhere").
      const lab = (state.labels.get(st.style_id) || "").trim().toUpperCase();
      if (lab && store.getItem("measure::" + lab) === "object")
        state.measureMode.set(st.style_id, "object");
    }
  }
}

// ---------- trade grouping (boss roadmap: takeoff organized by trade) ----
const TRADES = ["Earthwork & Grading", "Wet Utilities", "Dry Utilities",
                "Paving & Concrete", "Footing & Foundation", "Structures",
                "Fencing & Sitework", "General"];
function tradeKey(label) { return "trade::" + label.trim().toUpperCase(); }
function tradeFor(label) {
  const saved = store.getItem(tradeKey(label));
  if (saved && TRADES.includes(saved)) return saved;
  const L = label.toUpperCase();
  const has = (...ws) => ws.some(w => L.includes(w));
  if (has("CONTOUR", "GRADING", "GRADE", "EXCAVAT", "EARTHWORK", "TOPO", "SLOPE",
          "BERM", "DITCH", "SWALE", "ELEVATION", "CUT", "FILL", "TOPSOIL")) return "Earthwork & Grading";
  if (has("WATER", "SEWER", "STORM", "SANITARY", "DRAIN", "PIPE", "MAIN",
          "HYDRANT", "MANHOLE", "CULVERT", "IRRIG", "FORCE", "CLEANOUT",
          "TRENCH", "VALVE", "WELL", "FIREWATER")) return "Wet Utilities";
  if (has("ELECTRIC", "TELEPHONE", "GAS", "FIBER", "CABLE", "COMM", "POWER",
          "CONDUIT", "LIGHT", "OHP")) return "Dry Utilities";
  // Ahead of Paving & Concrete on purpose: "CONCRETE FOOTING" belongs to the
  // foundations sub, while a bare "CONCRETE SIDEWALK" still falls through to
  // flatwork.
  if (has("FOOTING", "FOOTINGS", "FOOTER", "FTG", "FOUNDATION", "FNDN",
          "STEM WALL", "STEMWALL", "GRADE BEAM", "PIER", "CAISSON", "PILE CAP",
          "PILASTER", "SLAB", "SOG")) return "Footing & Foundation";
  if (has("PAVEMENT", "PAVING", "CURB", "SIDEWALK", "CONCRETE", "ASPHALT",
          "ROAD", "DRIVE", "GUTTER", "FLATWORK", "APRON", "EDGE OF")) return "Paving & Concrete";
  if (has("BUILDING", "STAIR", "BEAM", "COLUMN", "MASONRY", "SHEAR", "STUD",
          "JOIST", "TRUSS", "MOMENT FRAME")) return "Structures";
  if (has("FENCE", "WALL", "RAIL", "GATE", "BARRIER", "LANDSCAP", "TREE",
          "SILT", "PROPERTY", "EASEMENT", "SETBACK")) return "Fencing & Sitework";
  return "General";
}

// ---------- counted twice, WITHIN one sheet -----------------------------
// A stroke can end up in two emitted chains, so summing chain lengths counts
// it twice. Corpus-wide that is 925,968 pt of 56,999,763 = 1.62% on 301 of
// 354 sheets (out/verify/2026-08-22/containment/CONTAINMENT.md sec 1.2), and
// 1.60% of the UI-included tally the operator actually reads. The engine-side
// repair is deliberately deferred - the comment at `_pickup_end_marks` in
// chain.py says why - so the summing layer shows BOTH numbers instead.
//
// A "leg" is one polyline segment, keyed as its unordered endpoint pair
// rounded to 0.01 pt. That is an IDENTITY test, not a proximity test: no
// tolerance, nothing to tune, and it can never merge two lines that merely
// run close together. It is therefore a LOWER BOUND - a duplicate drawn
// 0.3 pt to the side does not match (CONTAINMENT sec 1.5 measures the
// geometric version at 2.3x larger, and refuses it in sec 7.2 because the
// overlap histogram has no gap at any threshold and a naive collapse erases
// 168 style rows, 95 of them UI-included, including A-WALL and VU-SSWR-SERV).
function legKey(ax, ay, bx, by) {
  const a = Math.round(ax * 100), b = Math.round(ay * 100);
  const c = Math.round(bx * 100), d = Math.round(by * 100);
  return (a < c || (a === c && b <= d))
    ? a + "," + b + "|" + c + "," + d
    : c + "," + d + "|" + a + "," + b;
}

// O(legs) with one dict - NOT a chain-vs-chain pass. CONTAINMENT sec 1.4
// counts 171,652,550 naive C(n,2) pairs corpus-wide and 21,278,026 on one
// sheet, which is the CO3 marker-collapse shape; this never compares two
// chains to each other at all.
//
// excess = sum over legs of (k-1) x len, where k is the number of DISTINCT
// chains in `chains` carrying that leg - the same convention CONTAINMENT
// used, so these numbers reproduce its tables. Union = sum - excess.
function unionStats(chains) {
  const legs = new Map();   // key -> [k, len, lastChainIdx]
  let sumPt = 0;
  for (let ci = 0; ci < chains.length; ci++) {
    const ch = chains[ci];
    // work-area mask: the sum this function discloses against is the same
    // zone-clipped sum every other reader shows, and each LEG is clipped
    // the same way, so union <= sum still holds with zones on
    sumPt += chainCountedPt(ch);
    const p = ch.points;
    if (!p || p.length < 2) continue;
    const _r = axisRatio();
    for (let i = 1; i < p.length; i++) {
      let d = Math.hypot(p[i][0] - p[i - 1][0], (p[i][1] - p[i - 1][1]) * _r);
      if (d < 0.05) continue;   // same skip as tools/containment.py leg_index
      if (wzActive())
        d *= wzSegT(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1], state.workZones);
      if (!(d > 0)) continue;   // leg entirely outside the work area
      const key = legKey(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
      const e = legs.get(key);
      if (e === undefined) legs.set(key, [1, d, ci]);
      else if (e[2] !== ci) { e[0] += 1; e[2] = ci; }
    }
  }
  let excessPt = 0, sharedLegs = 0;
  for (const e of legs.values())
    if (e[0] > 1) { excessPt += (e[0] - 1) * e[1]; sharedLegs += 1; }
  // A pickup adds its approach GAP to chain.length without adding a leg, so
  // sum can exceed the polyline total; clamp rather than print a union above
  // the sum it is meant to be a subset of.
  if (excessPt > sumPt) excessPt = sumPt;
  return { sumPt, excessPt, unionPt: sumPt - excessPt, sharedLegs,
           nChains: chains.length };
}

// One computation for the itemized panel AND the CSV export: totals per
// label, object counts, overrides, prices, trade grouping. Items come back
// grouped in TRADES order, each group sorted by quantity descending.
// ---- two scales on one sheet ------------------------------------------
// A sewer PROFILE prints a horizontal scale and a vertical one, deliberately
// different - 1"=50' across, 1"=5' up - so the slope is legible. A single
// sloped line therefore needs BOTH at once: its run measured at one scale, its
// rise at the other. No per-page or per-region scale can express that, which
// is why this could not just be another entry in the scale list.
//
// Rather than thread two factors through the seven-odd places that turn points
// into feet, everything funnels through an EFFECTIVE pt length: scale the y
// component by fy/fx, and the existing `pt / 72 * ftPerIn` conversion then
// yields hypot(dx*fx, dy*fy) / 72, which is the right answer.
//
// With no vertical scale set the ratio is exactly 1 and chainLenPt returns the
// engine's own length_pt UNTOUCHED - not recomputed and re-rounded, the same
// number. Every single-scale sheet is provably unaffected.
function axisRatio() {
  const sc = state.result && state.result.scale;
  const fx = sc ? sc.ft_per_paper_inch : null;
  if (!fx || !state.vScale) return 1;
  const r = state.vScale / fx;
  return (isFinite(r) && r > 0) ? r : 1;
}

function chainLenPt(ch) {
  const r = axisRatio();
  if (r === 1) return ch.length_pt;
  const p = ch.points;
  if (!p || p.length < 2) return ch.length_pt;
  // SCALE the engine's length, never replace it. length_pt is NOT the polyline
  // length of `points`: a chain that picks up across a gap adds that gap to its
  // length without adding a leg. Measured on Kayden Springs p39, 515 of 682
  // chains differ, one by 17.8%. Recomputing from points would silently drop
  // every one of those gaps the moment a vertical scale was switched on.
  let plain = 0, axis = 0;
  for (let i = 1; i < p.length; i++) {
    const dx = p[i][0] - p[i - 1][0], dy = p[i][1] - p[i - 1][1];
    plain += Math.hypot(dx, dy);
    axis += Math.hypot(dx, dy * r);
  }
  if (!(plain > 0)) return ch.length_pt;
  return ch.length_pt * (axis / plain);
}

// ==================== WORK AREA - quantity mask ==========================
// The operator drags one or more rectangles; a chain COUNTS only by its
// length inside the union. Detection is untouched - this masks what is
// COUNTED, never what was found. Exact segment/rect clipping (Liang-Barsky
// parameter intervals, merged across rectangles), not midpoint voting: a
// contour that clips a corner of the legend box counts exactly the piece
// that is inside, to float precision.
//
// tests/test_workzone_math.js evals ONLY the block between the WZ-MATH
// markers - keep it pure (no DOM, no state.*), like the TRENCH-MATH block.
// WZ-MATH-BEGIN

// [[x0,y0,x1,y1],...] -> normalized rects; junk rows dropped, corners sorted
function wzNorm(zones) {
  const out = [];
  for (const z of Array.isArray(zones) ? zones : []) {
    if (!Array.isArray(z) || z.length < 4) continue;
    const v = [+z[0], +z[1], +z[2], +z[3]];
    if (!v.every(Number.isFinite)) continue;
    const x0 = Math.min(v[0], v[2]), x1 = Math.max(v[0], v[2]);
    const y0 = Math.min(v[1], v[3]), y1 = Math.max(v[1], v[3]);
    if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;   // a line is not an area
    out.push([x0, y0, x1, y1]);
  }
  return out;
}

// boundary-inclusive: ink drawn exactly on the box edge counts
function wzPtIn(x, y, zones) {
  for (const z of zones)
    if (x >= z[0] && x <= z[2] && y >= z[1] && y <= z[3]) return true;
  return false;
}

// Fraction of segment a->b inside the UNION of rects, as summed merged
// t-intervals in [0,1]. Per-rect clipping is the axis-aligned slab test
// (exact); overlapping rects cannot double-count because the intervals are
// MERGED before summing. A zero-length segment is scored by point-in-union.
function wzSegT(ax, ay, bx, by, zones) {
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return wzPtIn(ax, ay, zones) ? 1 : 0;
  const iv = [];
  for (const z of zones) {
    let t0 = 0, t1 = 1;
    if (dx === 0) {
      if (ax < z[0] || ax > z[2]) continue;
    } else {
      let ta = (z[0] - ax) / dx, tb = (z[2] - ax) / dx;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (dy === 0) {
      if (ay < z[1] || ay > z[3]) continue;
    } else {
      let ta = (z[1] - ay) / dy, tb = (z[3] - ay) / dy;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (t1 > t0) iv.push([t0, t1]);
  }
  if (!iv.length) return 0;
  iv.sort((p, q) => p[0] - q[0]);
  let total = 0, s = iv[0][0], e = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    if (iv[i][0] <= e) { if (iv[i][1] > e) e = iv[i][1]; }
    else { total += e - s; s = iv[i][0]; e = iv[i][1]; }
  }
  total += e - s;
  return total;
}

// Inside vs total length of a polyline against the union. yScale carries
// the vertical-scale ratio (axisRatio) so a profile sheet's mask uses the
// same axis weighting as every other length in the app: the inside PORTION
// is decided in true page space (t-intervals), the LENGTH it contributes is
// axis-weighted, segment by segment.
function wzPolyInsideLen(points, zones, yScale) {
  const r = (Number.isFinite(yScale) && yScale > 0) ? yScale : 1;
  let inside = 0, total = 0;
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1][0], ay = points[i - 1][1];
    const bx = points[i][0], by = points[i][1];
    const L = Math.hypot(bx - ax, (by - ay) * r);
    if (!(L > 0)) continue;
    total += L;
    const t = wzSegT(ax, ay, bx, by, zones);
    if (t > 0) inside += t * L;
  }
  return { inside, total };
}

// Disjoint rects covering [0,w]x[0,h] MINUS the union - for the canvas
// wash over everything outside the work area. x-slab sweep: within one
// vertical slab the union is a set of y-intervals; the complement of those
// intervals is emitted as rects. Disjoint by construction, so the wash can
// never double-paint (which would read as "more excluded" where two boxes
// overlap).
function wzComplementRects(zones, w, h) {
  const zs = zones.filter(z => z[0] < w && z[2] > 0 && z[1] < h && z[3] > 0);
  if (!zs.length) return [[0, 0, w, h]];
  const xs = [0, w];
  for (const z of zs) {
    if (z[0] > 0 && z[0] < w) xs.push(z[0]);
    if (z[2] > 0 && z[2] < w) xs.push(z[2]);
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < xs.length; i++) {
    const xa = xs[i - 1], xb = xs[i];
    if (!(xb > xa)) continue;
    // y-intervals of zones covering this whole slab, merged
    const iv = [];
    for (const z of zs)
      if (z[0] <= xa && z[2] >= xb)
        iv.push([Math.max(0, z[1]), Math.min(h, z[3])]);
    iv.sort((p, q) => p[0] - q[0]);
    let y = 0;
    for (const [a, b] of iv) {
      if (a > y) out.push([xa, y, xb, a]);
      if (b > y) y = b;
    }
    if (y < h) out.push([xa, y, xb, h]);
  }
  return out;
}
// WZ-MATH-END

function wzActive() {
  return !!(state.workZones && state.workZones.length);
}

// Per-chain inside fraction, memoised: renderStyles + renderItemized walk
// every chain on the sheet on every repaint, and a heavy topo sheet carries
// six figures of segments. Keyed on page generation, zone revision and the
// axis ratio; afterEdit() bumps wzRev so a moved point or a merge cannot
// serve a stale fraction.
let _wzFrac = null, _wzFracKey = "";
function wzChainFrac(ch) {
  if (!wzActive()) return 1;
  const key = state.gen + ":" + state.wzRev + ":" + axisRatio();
  if (_wzFracKey !== key) { _wzFrac = new Map(); _wzFracKey = key; }
  let f = _wzFrac.get(ch.chain_id);
  if (f === undefined) {
    const p = ch.points;
    if (!p || !p.length) f = 0;
    else if (p.length === 1) f = wzPtIn(p[0][0], p[0][1], state.workZones) ? 1 : 0;
    else {
      const m = wzPolyInsideLen(p, state.workZones, axisRatio());
      f = m.total > 0 ? m.inside / m.total
        : (wzPtIn(p[0][0], p[0][1], state.workZones) ? 1 : 0);
    }
    _wzFrac.set(ch.chain_id, f);
  }
  return f;
}

// What a chain CONTRIBUTES to any quantity: its engine length scaled by the
// measured inside fraction of its polyline. SCALES chainLenPt rather than
// summing clipped legs directly, for the same reason chainLenPt scales
// length_pt: the engine length includes welded pickup gaps that are not
// polyline legs, so a whole-sheet zone must return chainLenPt EXACTLY
// (fraction 1 -> same number, bit for bit), never a re-measured one. The
// welded gap is apportioned by the inside fraction - disclosed in the tally
// tooltip, not hidden.
function chainCountedPt(ch) {
  const f = wzChainFrac(ch);
  return f === 1 ? chainLenPt(ch) : chainLenPt(ch) * f;
}
// ================== end WORK AREA quantity mask ==========================

// A STYLE's total, axis-aware. state.result.styles carries a length the engine
// summed at detect time, which knows nothing about a second scale, so it has to
// be re-summed from that style's chains. Memoised on (ratio, generation): the
// sidebar redraws on every tick and this walks every chain on the sheet.
let _styleLen = null, _styleLenKey = null;
// What is actually LEFT on a style row, after the reviewer's deletions.
//
// st.length_pt and st.n are the ENGINE's totals. They are written once at
// detection and cannot know that a reviewer erased a line, so every readout
// built on them goes stale the moment somebody uses the trash tool. Measured
// on Kayden engine page index 38 = printed sheet C5.1: deleting chain 2151
// (107.7pt) moved the bid line 3,913.6 -> 3,838.8 ft and the count 79 -> 78,
// while the style row went on reading "606 LF - 8 lines" with 764pt / 7 lines
// remaining. The money was right; the panel the estimator reads while
// DECIDING was not.
//
// Summed live rather than subtracted from the stored total, for two reasons.
// A split excludes the original and adds custom chains that were never in
// st.length_pt, so subtraction over-counts the removal. And computeTakeoffRows
// already sums chainLenPt over live chains, so summing the same way is what
// makes the row and the bid line agree - which is the whole point.
//
// Cost, measured with NOTHING deleted: the displayed text changes on 4 of 148
// rows on sheet C5.2 (2.7%) and 3 of 179 on C5.1 (1.7%), worst underlying
// difference 0.05 pt - about 0.035 ft at 1"=50', i.e. a rounding boundary in
// fmtQty. The new figure is the more accurate one; the stored total is the
// engine's rounded copy.
let _liveLen = null, _liveN = null, _liveOut = null, _liveKey = "";

function _liveStyleTotals() {
  const key = state.gen + ":" + state.excluded.size + ":" + axisRatio()
    + ":" + state.wzRev;
  if (_liveKey !== key) {
    _liveLen = new Map(); _liveN = new Map(); _liveOut = new Map();
    for (const ch of (state.result ? state.result.chains : [])) {
      if (state.excluded.has(ch.chain_id)) continue;
      // work-area mask: the row shows what COUNTS; what fell outside is
      // tracked per style so the row can disclose its own loss
      const full = chainLenPt(ch);
      const counted = chainCountedPt(ch);
      _liveLen.set(ch.style_id, (_liveLen.get(ch.style_id) || 0) + counted);
      if (counted > 0 || !wzActive())
        _liveN.set(ch.style_id, (_liveN.get(ch.style_id) || 0) + 1);
      if (full - counted > 0)
        _liveOut.set(ch.style_id,
                     (_liveOut.get(ch.style_id) || 0) + (full - counted));
    }
    _liveKey = key;
  }
}

// 0 is a real answer here: a row whose every chain the reviewer deleted holds
// nothing, and must say so. Falling back to the engine's total in that case is
// exactly the bug this replaces.
function styleLiveLen(sid) {
  if (!state.result) return 0;
  _liveStyleTotals();
  return _liveLen.get(sid) || 0;
}

function styleLiveCount(sid) {
  if (!state.result) return 0;
  _liveStyleTotals();
  return _liveN.get(sid) || 0;
}

// Footage this style LOST to the work-area mask (0 when no zones, or when
// every chain of the style is inside). The style row prints it compactly so
// a row that shrank says why on its own line.
function styleLiveOut(sid) {
  if (!state.result || !wzActive()) return 0;
  _liveStyleTotals();
  return _liveOut.get(sid) || 0;
}

function styleLenPt(st) {
  if (state.result) return styleLiveLen(st.style_id);
  const r = axisRatio();
  if (r === 1) return st.length_pt;          // exact no-op, same as chainLenPt
  const key = r + "@" + state.gen;
  if (_styleLenKey !== key) {
    _styleLen = new Map();
    for (const ch of (state.result ? state.result.chains : []))
      _styleLen.set(ch.style_id, (_styleLen.get(ch.style_id) || 0) + chainLenPt(ch));
    _styleLenKey = key;
  }
  const v = _styleLen.get(st.style_id);
  return v === undefined ? st.length_pt : v;
}

// How much of this sheet's included length is NOT measured ink.
//
// Every chain now carries gap_pt (blank paper welded into it by a stitch, a
// join, or the approach to a picked-up mark) and pickup_pt (ink taken from
// elsewhere, which the chain it came from may still be counting). Neither was
// knowable before 2026-08-27, so a quantity could never state its own
// denominator - which the project's accuracy contract requires.
//
// Measured on Kayden sheet C5.1: 2.27% of the sheet is welded gap, and on its
// billable layers C-U2-PROP-LOT carries 1,923 ft of blank paper (6.10% of
// 31,497 ft) and C-U2-ROAD-DRWY 848 ft (4.90%). That is footage an estimator
// would price and which is not on the drawing.
function sheetOverCapture() {
  if (!state.result) return null;
  let len = 0, gap = 0, pick = 0;
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (!state.include.get(ch.style_id)) continue;
    // work-area mask: the welded-gap ratio describes the footage that is
    // COUNTED, so numerator and denominator are scaled by the same inside
    // fraction (fr = 1 whenever no zones are drawn)
    const fr = wzChainFrac(ch);
    if (!(fr > 0)) continue;
    len += ch.length_pt * fr;
    gap += (ch.gap_pt || 0) * fr;
    pick += (ch.pickup_pt || 0) * fr;
  }
  return len > 0 ? { len, gap, pick } : null;
}

function computeTakeoffRows() {
  if (!state.result) return null;
  const sc = state.result.scale;
  const ftPerIn = sc ? sc.ft_per_paper_inch : null;
  const totals = new Map();
  const sheetChains = [];
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (!state.include.get(ch.style_id)) continue;
    // WORK AREA quantity mask: a chain counts by its length INSIDE the
    // drawn boxes. Fully outside = contributes nothing, not to footage and
    // not to a count - the mask exists to keep the legend block and the
    // NTS details out of these exact rows. Partially inside counts the
    // exact clipped length and stays one line in the count.
    const counted = chainCountedPt(ch);
    if (wzActive() && !(counted > 0)) continue;
    const label = state.chainLabels.get(ch.chain_id) ||
      state.labels.get(ch.style_id) || "unlabeled";
    const t = totals.get(label) ||
      { count: 0, pt: 0, objects: 0, objSids: new Set(), chains: [] };
    t.count += 1; t.pt += counted; t.chains.push(ch);
    sheetChains.push(ch);
    if (state.measureMode.get(ch.style_id) === "object")
      t.objSids.add(ch.style_id);
    totals.set(label, t);
  }
  for (const t of totals.values()) {
    if (t.objSids.size)
      t.objects = styleObjects([...t.objSids],
                               new Set(t.chains.map(c => c.chain_id))).length;
    t.dup = unionStats(t.chains);
  }
  // The sheet figure is computed over EVERY included chain, so it also sees a
  // leg shared by two chains carrying DIFFERENT labels - which no per-row
  // figure can. It is therefore <= the sum of the per-row unions, and the two
  // are not meant to add up. Both are disclosed; neither replaces the sum.
  const sheet = unionStats(sheetChains);
  const pt2q = (pt) => ftPerIn ? pt / 72 * ftPerIn : pt;
  // one flat list: measured line families + calculator items, then group
  // Every row carries its UNIT explicitly. Until 2026-08-24 the unit was
  // reverse-engineered from `cnt` - which holds a chain COUNT for a measured
  // row and a UNIT STRING for a calculator row - and the three readers of
  // that field each guessed differently. That is how "Earthwork & Grading"
  // came to print (contour feet + cut CY + fill CY + slab SF) as one number
  // with "ft" after it: the subtotal test was `cnt === "EA"`, and "CY" is not
  // "EA". `cnt` is left alone so nothing downstream moves yet.
  // sids: which style rows this item's chains came from. Additive, for the
  // bid view's drill-down (isolate a member's linework) - the quantities
  // above do not read it.
  const items = [...totals.entries()].map(([label, t]) => t.objects
    ? { label, cnt: "EA", unit: "EA", qty: t.objects,
        qtyText: String(t.objects), priced: true, isObj: true,
        sids: [...new Set(t.chains.map(c => c.style_id))],
        ft: ftPerIn ? t.pt / 72 * ftPerIn : null }
    : { label, cnt: String(t.count), unit: ftPerIn ? "ft" : "pt",
        qty: pt2q(t.pt),
        sumQty: pt2q(t.pt),
        unionQty: pt2q(t.dup.unionPt),
        dupQty: pt2q(t.dup.excessPt),
        dupLegs: t.dup.sharedLegs,
        sids: [...new Set(t.chains.map(c => c.style_id))],
        qtyText: null, priced: !!ftPerIn });
  for (const it of state.extraItems)
    items.push({ label: it.label, cnt: it.unit, unit: it.unit, qty: it.qty,
                 qtyText: it.qty.toLocaleString(), priced: true, isCalc: true });
  const byTrade = new Map();
  for (const it of items) {
    const tr = tradeFor(it.label);
    if (!byTrade.has(tr)) byTrade.set(tr, []);
    byTrade.get(tr).push(it);
  }
  let grand = 0;
  const groups = [];
  for (const tr of TRADES) {
    const group = byTrade.get(tr);
    if (!group) continue;
    group.sort((a, b) => b.qty - a.qty);
    let sub = 0, subQty = 0, subEa = 0;
    const subByUnit = new Map();
    for (const it of group) {
      const ov = parseFloat(store.getItem(
        ovKey(it.label, it.unit)) || "");
      if (!isNaN(ov) && ov > 0) {
        it.auto = it.qty; it.qty = ov;
        if (it.cnt === "EA") it.qtyText = String(ov);
        it.ov = true;
      }
      const price = parseFloat(store.getItem(priceKey(it.label)) || "") || null;
      it.price = price;
      it.trade = tr;
      it.ext = it.priced && price ? it.qty * price : null;
      if (it.ext) sub += it.ext;
      subByUnit.set(it.unit, (subByUnit.get(it.unit) || 0) + it.qty);
      if (it.unit === "EA") subEa += it.qty;
      else if (it.unit === "ft" || it.unit === "pt") subQty += it.qty;
    }
    grand += sub;
    groups.push({ trade: tr, items: group, sub, subQty, subEa, subByUnit });
  }
  return { groups, grand, ftPerIn, sheet };
}

// The disclosure line under an itemized row whose chains overlap each other.
// Reads "sum X - union Y - Z drawn by both", never picks, and offers the
// union through the SAME override the quantity box already uses, so taking it
// is one click and giving it back is one click.
// Full precision here on purpose: the rest of the panel abbreviates to "2.4k"
// because the exact figure is one click away in the box, but this line IS the
// figure - "2.4k vs 1.5k" hides the 898.4 ft it exists to disclose.
const q1 = (v) => v.toLocaleString(undefined,
  { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function dupNote(it, u) {
  const n = document.createElement("div");
  n.className = "dup-note";
  const onUnion = it.ov && Math.abs(it.qty - it.unionQty) < 0.05;
  const pct = it.sumQty > 0 ? (it.dupQty / it.sumQty * 100) : 0;
  const txt = document.createElement("span");
  txt.innerHTML =
    `sum <b>${q1(it.sumQty)}</b> &middot; union <b>${q1(it.unionQty)}</b> ${u}` +
    ` &mdash; ${q1(it.dupQty)} ${u} (${pct.toFixed(1)}%) drawn by more than one` +
    ` of these ${it.cnt} lines`;
  txt.title = `${it.dupLegs} polyline segment(s) of this label are carried by ` +
    `two or more chains, so the sum counts them more than once. ` +
    `Union counts each segment exactly once. Nothing is deleted either way; ` +
    `identical-geometry test only, so this is a lower bound.`;
  const b = document.createElement("button");
  b.className = "mini dup-take";
  b.textContent = onUnion ? "restore sum" : "use union";
  b.title = onUnion
    ? "put the summed quantity back in the box"
    : "write the union into this row's quantity override (reversible)";
  b.onclick = () => {
    const k = ovKey(it.label, it.unit);
    if (onUnion) store.removeItem(k);
    else store.setItem(k, it.unionQty.toFixed(1));
    renderItemized(); renderChips();
  };
  n.append(txt, b);
  return n;
}

// The row's number is the OPERATOR'S. Say so, with the engine's figure beside
// it and one click to take it back.
function ovNote(it, u) {
  const n = document.createElement("div");
  n.className = "dup-note ov-note";
  const unit = it.unit === "ft" || it.unit === "pt" ? u : it.unit;
  const txt = document.createElement("span");
  txt.innerHTML = "<b>overridden</b> — this sheet uses " + q1(it.qty) + " "
    + unit + "; the engine detected <b>" + q1(it.auto) + "</b> " + unit;
  n.appendChild(txt);
  // dupNote's "restore sum" removes the SAME key. When the override IS the
  // union, that button renders directly beneath this one, so do not print two
  // differently worded buttons that do the same thing.
  const dupWillOffer = it.dupQty > 0.05
    && it.unionQty !== undefined && Math.abs(it.qty - it.unionQty) < 0.05;
  if (!dupWillOffer) {
    const b = document.createElement("button");
    b.className = "mini dup-take";
    b.textContent = "restore detected";
    b.title = "put the engine's figure back in the box and forget the override";
    b.onclick = () => {
      store.removeItem(ovKey(it.label, it.unit));
      renderItemized(); renderChips();
    };
    n.appendChild(b);
  }
  return n;
}

// The quantity box holds a NUMBER, so it must be fed a string that
// input[type=number] can parse. it.qtyText must NEVER be used here: for a
// calculator row it is it.qty.toLocaleString(), which yields "1,234.5" - not
// a valid floating-point number, so the browser's value-sanitisation blanks
// the control and q.value reads "".
// One decimal, because that is already this app's canonical precision in
// three independent places: takeoffCsv writes it.qty.toFixed(1), q1() in
// dupNote prints one decimal, and server.py rounds length_ft and extra-item
// qty to one. "Full precision" means the figure the CSV carries, not "3.3k".
function qtyBoxValue(v, unit) {
  if (!Number.isFinite(v)) return "";
  if (unit === "EA") return String(Math.round(v * 100) / 100);
  return v.toFixed(1);
}

// A step the operator can feel AT THIS MAGNITUDE. 0.1 on a 3,278 ft run is
// 32,000 clicks to move it one percent; 1 on a 3.4 EA row cannot express 3.4.
function qtyStep(v, unit) {
  const m = Math.abs(v);
  if (unit === "EA") return m >= 1000 ? "10" : "1";
  if (m >= 10000) return "100";
  if (m >= 1000) return "10";
  if (m >= 100) return "1";
  return "0.1";
}

// renderItemized() rebuilds the whole panel with box.innerHTML = "", which
// DESTROYS whatever input is focused inside it - and roughly thirty call
// sites reach it, one of them formerly the price box's own oninput. Every
// input the panel builds carries a unique, stable `name`, so remember the
// name and put focus back on the replacement.
// CARET: selectionStart is not available on input[type=number] - the getter
// returns null per spec and setSelectionRange throws InvalidStateError. Both
// boxes here are number inputs, so focus is all that can be carried. That is
// precisely why the price handler below stops rebuilding on every keystroke
// instead of leaning on this.
function panelFocus(root) {
  const el = document.activeElement;
  if (!el || !el.name || !root.contains(el)) return null;
  let s = null, e2 = null;
  try { s = el.selectionStart; e2 = el.selectionEnd; } catch (err) { /* number input */ }
  return { name: el.name, s, e2 };
}
function panelRefocus(root, f) {
  if (!f) return;
  // A label can contain a double quote (PROPOSED 4" RIGID ... FOOTER DRAIN),
  // so match on the property, never on an attribute selector built from it.
  for (const el of root.querySelectorAll("input,select"))
    if (el.name === f.name) {
      el.focus({ preventScroll: true });
      if (f.s !== null) { try { el.setSelectionRange(f.s, f.e2); } catch (err) {} }
      return;
    }
}

// ---------- bid view: the takeoff regrouped as a bid schedule -------------
// EXCAVATION-PLAN.md section 7 item 1: "Organise the panel around a bid
// schedule, not a style list. ~15 line items with quantities, not 280 rows.
// The style list becomes the drill-down."
//
// This block is the deterministic rule table that files a takeoff row into
// a bid-schedule bucket by keywords over the names the document and the
// operator already gave it (legend/operator label first, CAD layer as the
// tie-breaker). It is a REGROUPING only - no AI, no new quantity anywhere:
// every bucket figure the panel shows is the sum of rows produced by the
// same computeTakeoffRows() pass the itemized takeoff and the tally bar
// read, so the three can never disagree. A row no rule names lands in
// UNASSIGNED, with its count and footage said out loud, never silently.
//
// Kept pure (no DOM, no state.*) between the markers so
// tests/test_bidview_rules.js can eval it standalone - same technique as
// the TRENCH-MATH block below.
// BIDVIEW-RULES-BEGIN

// Bucket names, in DISPLAY order. The set is EXCAVATION-PLAN.md section 0's
// excavator bid families (cut/fill CY, topsoil strip, trench by depth band,
// pipe by size and material, structures EA, erosion control LF/EA,
// aggregate/base) crossed with the line families the one estimate on disk
// actually bills - Beaumont Estimate #853: nine per-LF utility lines
// $224,200 (section 15 item 2), the topsoil family $88,815 (item 10),
// Clear & Grub 224,058 SF (item 9), Perimeter Drain 3,395 LF (item 14),
// Paths To Subgrade / Slab Prep by the SF (quoted at arData() above) - and
// the Pierce transcript conventions (section 13: pipe separated by size,
// sewer priced in 2-ft depth bands). Structures (manholes, inlets,
// hydrants) ride their SYSTEM's bucket, which is how #853 bills them.
// There is deliberately no dry-utilities bucket: gas/electric/telecom are
// not in section 0's families, so they land in UNASSIGNED - which says so
// - rather than being filed under a wet system by default.
const BID_UNASSIGNED = "UNASSIGNED";
const BID_BUCKETS = [
  "Erosion & Sediment Control",
  "Clearing/Limits",
  "Earthwork",
  "Storm Drainage",
  "Sanitary Sewer",
  "Water",
  "Site Concrete/Paving",
  "Walls",
  "Landscape/Other",
  BID_UNASSIGNED,
];

// The rule table. FIRST MATCH WINS, top to bottom, tokens tried in the
// order written; display order above and rule order here differ where a
// stated collision forces it. Token grammar (see bidTokenHit):
//   - 3 characters or fewer: whole-word match over the normalised text
//     ("SD" must never match inside "SDWK")
//   - "=" prefix: whole-word match regardless of length ("=FILL" must not
//     match inside "BACKFILL", which belongs to the trench rows)
//   - otherwise: substring over the normalised text ("WALL" matches
//     "A WALL" and "HEADWALL"; the ordering settles those collisions)
// Normalisation uppercases and collapses every non-alphanumeric run to one
// space, so hyphens and pipes in CAD layer paths split into words.
// A rule may instead carry `re`, a regex over the RAW label - used only to
// mirror label families this file itself emits.
const BID_RULES = [
  // 1. The earthwork calculator's own rows. Verbatim mirror of EW_ITEM_RE
  //    (defined near ewClearItems below - keep the two identical; the node
  //    test compares their sources) plus the structure panel's dig/backfill
  //    labels (ST_LABELS). These names are emitted by this file, so they
  //    are matched exactly rather than by keyword - and BEFORE everything
  //    else, so "Export Asphalt" stays earthwork rather than paving.
  { bucket: "Earthwork",
    re: /^(Site Cut|Site Fill|Strip Topsoil|Remove |Rough Place |Place |Export |Import Structural$|(Cut|Fill) \(earthwork\))/ },
  { bucket: "Earthwork",
    tokens: ["MASS EXCAVATION", "STRUCTURE EXCAVATION",
             "STRUCTURE BACKFILL"] },
  //    Slab Prep is billed as hardscape by the SF ("Slab Prep 9,237 SF",
  //    Estimate #853, quoted at arData() above), not as dirt.
  { bucket: "Site Concrete/Paving", tokens: ["SLAB PREP"] },
  // 2. Erosion & sediment control - section 0's "erosion control LF/EA"
  //    family. BEFORE Clearing/Limits and Landscape so SILT FENCE and TREE
  //    PROTECTION never fall through to FENCE/TREE, and INLET PROTECTION
  //    never reads as a storm INLET.
  { bucket: "Erosion & Sediment Control",
    tokens: ["SILT", "EROSION", "SWPPP", "SEDIMENT", "WATTLE",
             "FIBER ROLL", "INLET PROTECTION", "CONSTRUCTION ENTRANCE",
             "TREE PROTECTION", "RIPRAP", "ESC"] },
  // 3. Clearing / limits - #853's own "Clear & Grub 224,058 SF" and Barn
  //    C3.0's "BG-Limit of disturbance" layer (section 15 item 9).
  { bucket: "Clearing/Limits",
    tokens: ["LIMIT OF DISTURBANCE", "LIMITS OF DISTURBANCE",
             "LIMIT OF WORK", "LIMITS OF WORK", "LOD", "CLEARING", "CLEAR",
             "GRUB", "DEMOLITION", "DEMO"] },
  // 4. Reference linework the sheet draws but nobody digs - property,
  //    easement, right-of-way, setback, boundary, centerline. Filed under
  //    Landscape/Other (the named-but-not-excavation catch-all) BEFORE the
  //    system rules so a SEWER EASEMENT or a ROAD R.O.W. line reads as the
  //    reference line it is, not as pipe or pavement. ESMT / BNDY /
  //    PROP LOT are the Kayden p39 drafter's own abbreviations
  //    (C-U2-ESMT-UTIL, C-U2-BNDY, C-U2-PROP-LOT).
  { bucket: "Landscape/Other",
    tokens: ["PROPERTY", "EASEMENT", "ESMT", "SETBACK", "RIGHT OF WAY",
             "R O W", "ROW", "BOUNDARY", "BNDY", "LOT LINE", "PROP LOT",
             "CENTERLINE", "CENTER LINE"] },
  // 5. Earthwork keywords - contours are the grading surface source
  //    (section 3); topsoil is #853's $88,815 family (section 15 item 10);
  //    import/export/haul is section 0's haul-off family. "=CUT"/"=FILL"
  //    are word-bound so BACKFILL stays with its trench run; "=GRADE" so
  //    "PATHS TO SUBGRADE" (#853 hardscape) never reads as grading;
  //    "=BERM" so BERMUDA sod never reads as a berm. EXCAVAT is
  //    deliberately ABSENT: the trench tool emits "Trench excavation
  //    (<run name>)" and that row must follow its run's system in rules
  //    6-8 (an unnamed run still lands in Earthwork via rule 13, and the
  //    structure panel's excavation rows matched exactly in rule 1).
  { bucket: "Earthwork",
    tokens: ["CONTOUR", "GRADING", "=GRADE", "TOPO", "TOPSOIL",
             "EARTHWORK", "SLOPE", "SWALE", "DITCH", "=BERM", "=CUT",
             "=FILL", "IMPORT", "EXPORT", "HAUL"] },
  // 6. Storm drainage - #853's Perimeter Drain 3,395 LF is drawn as
  //    FOUNDATION DRAIN / FOOTER DRAIN and the drafter's own typo FOTER
  //    (section 15 item 14), so all three are tokens. BEFORE Sanitary so
  //    STORM SEWER stays storm; BEFORE Walls so a HEADWALL stays a storm
  //    structure. Bare DRAIN is the family's net and comes last. A bare
  //    "CB" token was tried and WITHDRAWN: Barn's own xref namespace is
  //    BG-SWCR-CB-MATERIALS / -CB-PLANTING, so one two-letter project code
  //    read a whole planting plan as catch basins (caught by the node
  //    test). Catch basins still arrive via CATCH BASIN and INLET.
  { bucket: "Storm Drainage",
    tokens: ["STORM", "SD", "RCP", "CMP", "CULVERT", "CATCH BASIN",
             "INLET", "HEADWALL", "FES", "ROOF DRAIN", "DOWNSPOUT",
             "UNDERDRAIN", "PERIMETER DRAIN", "FOUNDATION DRAIN",
             "FOOTER DRAIN", "FOTER", "INFILTR", "DRAIN"] },
  // 7. Sanitary sewer - "sanitary + storm + water + force main" are #853's
  //    per-LF utility families (section 15 item 2); SSMH / MANHOLE per the
  //    Kayden legend's SANITARY SEWER MANHOLE row (section 19); SSWR is
  //    that drafter's layer abbreviation (C-U2-SSWR-PIPE); OWTS is an
  //    onsite wastewater treatment system (septic - Barn's
  //    SE-P-OWTS-PDchmbr-trench sys). A storm MANHOLE already matched
  //    STORM above, so the bare word lands here.
  { bucket: "Sanitary Sewer",
    tokens: ["SANITARY", "SEWER", "SSWR", "SSMH", "SS", "FORCE MAIN",
             "FORCEMAIN", "OWTS", "CLEANOUT", "MANHOLE", "MH"] },
  // 8. Water - hydrants and gate valves are the Kayden legend's own water
  //    rows (section 19); WATR is that drafter's layer abbreviation. "W"
  //    is the lettered-run code (the dash-text class prints W for
  //    waterline) and is tested against the LABEL only (BID_LABEL_ONLY),
  //    so a layer path can never read as water by one letter.
  { bucket: "Water",
    tokens: ["WATER", "WATR", "HYDRANT", "GATE VALVE", "DOMESTIC",
             "POTABLE", "FIRE LINE", "FIRELINE", "FIREWATER", "IRRIG",
             "WM", "W"] },
  // 9. Walls BEFORE concrete/paving, mirroring tradeFor()'s
  //    footing-before-paving precedent: CONCRETE RETAINING WALL is a wall.
  //    A-WALL is C4.3's own building-wall layer (section 15 item 14).
  { bucket: "Walls",
    tokens: ["RETAINING", "GABION", "MSE", "SCREEN WALL", "WALL"] },
  //    The trench tool's bedding row for a run whose name matched nothing
  //    above. BEFORE the aggregate GRAVEL token so "Bedding gravel (run)"
  //    stays with its trench (a named run's bedding already matched its
  //    system in rules 6-8, because the run name is inside the label).
  { bucket: "Earthwork", tokens: ["BEDDING GRAVEL"] },
  // 10. Site concrete / paving - #853 bills hardscape by the SF ("Paths To
  //     Subgrade 22,796 SF", quoted at arData()); aggregate/base is
  //     section 0's own family. GUT / FOC / BOC / SWLK / DRWY are the
  //     Kayden road-layer abbreviations (gutter, face/back of curb,
  //     sidewalk, driveway).
  { bucket: "Site Concrete/Paving",
    tokens: ["CURB", "GUTTER", "=GUT", "FOC", "BOC", "SIDEWALK", "SWLK",
             "SDWK", "CROSSWALK", "PAVEMENT", "PAVING", "PAVER", "ASPHALT",
             "CONCRETE", "CONC", "FLATWORK", "APRON", "DRIVEWAY", "DRWY",
             "ROAD", "PARKING", "AGGREGATE", "BASE COURSE", "GRAVEL",
             "EOP", "SLAB", "PATH", "STAIR"] },
  // 11. Landscape / other named families. FENCE and RAIL sit here so a
  //     PIPE RAIL never reads as pipe (the generic-pipe rule is below);
  //     "=TREE" is word-bound so STREET never reads as a tree; PLNT /
  //     EDGER / BOULDER are Barn's own planting-plan layer names.
  { bucket: "Landscape/Other",
    tokens: ["LANDSCAP", "=TREE", "TREES", "SHRUB", "PLNT", "PLANT",
             "SOD", "SEED", "MULCH", "EDGER", "BOULDER", "POOL", "FENCE",
             "RAIL", "=GATE", "BUILDING", "BLDG"] },
  // 12. A pipe named only by its material. The one measured instance in
  //     this corpus is storm - C4.3 style 106, PROPOSED PVC SURFACE STORM
  //     DRAIN PIPE, 380.9 LF (the section 15 item 14 family) - so the
  //     default is Storm Drainage. The material is genuinely ambiguous
  //     (sanitary runs PVC too); the per-row override exists for exactly
  //     this row, and the row is listed under the bucket, never hidden.
  { bucket: "Storm Drainage",
    tokens: ["PVC", "HDPE", "CPP", "DIP", "PIPE"] },
  // 13. Trench tool rows whose run name matched nothing above - the dig
  //     and backfill of an unnamed run is dirt work (section 0's "trench,
  //     BY DEPTH BAND" family).
  { bucket: "Earthwork", tokens: ["TRENCH", "BEDDING", "BACKFILL"] },
];
// Tokens matched against the LABEL alone, never the CAD layer: a single
// letter is a line code only when the legend or the lettered-run
// classifier wrote it; in a layer path it is noise.
const BID_LABEL_ONLY = ["W"];

// Uppercase, and collapse every non-alphanumeric run to one space, so
// hyphenated CAD layer paths split into words. Padded with spaces so
// whole-word tests are one indexOf.
function bidNormText(s) {
  return (" " + String(s == null ? "" : s).toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ").trim() + " ");
}
function bidTokenHit(norm, tok) {
  const word = tok.charAt(0) === "=";
  const t = word ? tok.slice(1) : tok;
  if (word || t.length <= 3) return norm.indexOf(" " + t + " ") >= 0;
  return norm.indexOf(t) >= 0;
}
// Two passes: the name the legend or the operator gave the row outranks
// the CAD layer path (a FIRE HYDRANT filed on a PROP-LOT layer is a
// hydrant). The layer is the tie-breaker for rows whose label matches
// nothing (Kayden's garbled "$nWonLo (legend)" label on the
// C-U2-ESMT-SSWR layer is an easement).
function bidBucketFor(label, layer) {
  const rawLabel = String(label == null ? "" : label);
  const passes = [bidNormText(rawLabel),
                  bidNormText(rawLabel + " "
                    + String(layer == null ? "" : layer))];
  for (let p = 0; p < passes.length; p++)
    for (const r of BID_RULES) {
      if (r.re) {
        if (p === 0 && r.re.test(rawLabel))
          return { bucket: r.bucket, token: "re" };
        continue;
      }
      for (const tok of r.tokens) {
        if (p === 1 && BID_LABEL_ONLY.indexOf(tok) >= 0) continue;
        if (bidTokenHit(passes[p], tok))
          return { bucket: r.bucket, token: tok };
      }
    }
  return { bucket: BID_UNASSIGNED, token: null };
}
// A size token the LABEL itself carries - 8", 10'', 8IN, 12-INCH. Display
// grouping only (Pierce, section 13: "Combined the 8\" and 12\" sewer line
// into one item. It would be preferable if it was separated"). Nothing is
// inferred: no token in the name, no size on the row. A bare "8 PVC" is
// deliberately NOT read as a size - a number with no inch mark could be a
// station, a count, or a type code.
function bidSizeToken(label) {
  const m = /(\d{1,3})\s*(?:"|”|''|[- ]?IN(?:CH)?\b)/i
    .exec(String(label == null ? "" : label));
  return m ? m[1] + '"' : null;
}
// The grouping. rows: [{label, layer, unit, qty, ...}] - the takeoff rows,
// already filtered and override-adjusted by computeTakeoffRows, NEVER the
// raw chains. ovFor(label) -> bucket name or null is the operator's
// override; an unknown name is ignored (the rule bucket stands) rather
// than inventing a bucket. Returns every bucket in display order; sums are
// kept PER UNIT - ft, EA, CY, SF are never added together.
function bidGroupRows(rows, ovFor) {
  const byB = {};
  for (const b of BID_BUCKETS)
    byB[b] = { bucket: b, n: 0, byUnit: {}, members: [] };
  for (const r of rows || []) {
    const ruled = bidBucketFor(r.label, r.layer);
    const ovRaw = ovFor ? ovFor(r.label) : null;
    const ov = ovRaw && BID_BUCKETS.indexOf(ovRaw) >= 0 ? ovRaw : null;
    const m = Object.assign({}, r, {
      bucket: ov || ruled.bucket,
      ruleBucket: ruled.bucket,
      token: ruled.token,
      via: ov ? "override" : "rule",
      size: bidSizeToken(r.label),
    });
    const B = byB[m.bucket];
    B.n += 1;
    if (typeof m.qty === "number" && isFinite(m.qty))
      B.byUnit[m.unit] = (B.byUnit[m.unit] || 0) + m.qty;
    B.members.push(m);
  }
  for (const b of BID_BUCKETS)
    byB[b].members.sort((x, y) => y.qty - x.qty);
  return BID_BUCKETS.map((b) => byB[b]);
}
// Footage per size token within one bucket's members, for the Storm
// Drainage sub-line (Pierce, section 13). Rows with no size token in their
// own name are reported as such - never guessed into a size.
function bidBySize(members, unit) {
  const out = {};
  for (const m of members) {
    if (m.unit !== unit) continue;
    const k = m.size || "no size in name";
    out[k] = (out[k] || 0) + m.qty;
  }
  return out;
}
// BIDVIEW-RULES-END

// The operator's bucket override for one takeoff row: doc-scoped and
// label-keyed like the trade store (tradeKey), page-free on purpose - "this
// document's THERMAL WELLS row bids as Water" holds on every sheet the
// label appears on, exactly like a trade pick. Written with store.setItem
// (a real decision: it persists and counts on the Saved-work button).
function bidKey(label) {
  return docKey() + "::bid::" + label.trim().toUpperCase();
}
// Which buckets stay expanded across repaints. Session-only, like the
// collapsible sections.
const bidOpen = new Set();

// Isolate a bid member's linework on the canvas, reusing the style-row
// isolation state (state.isolate + .iso on the style row + mini legend +
// draw). A member can span several styles (the takeoff adds up by NAME);
// repeated clicks cycle through them and then turn the isolate off, the
// same gesture as the style list's item-split button.
function bidIsolate(m, rowEl) {
  const sids = m.sids || [];
  if (!sids.length) return;
  const cur = sids.indexOf(state.isolate);
  const next = cur < 0 ? sids[0]
    : (cur + 1 < sids.length ? sids[cur + 1] : null);
  state.isolate = next;
  const list = $("styleList");
  for (const r of list.querySelectorAll(".style-row.iso"))
    r.classList.remove("iso");
  for (const r of $("bidBox").querySelectorAll(".bid-member.bid-iso"))
    r.classList.remove("bid-iso");
  if (next !== null) {
    const t = list.querySelector('.style-row[data-sid="' + next + '"]');
    if (t) { t.classList.add("iso"); t.scrollIntoView({ block: "nearest" }); }
    if (rowEl) rowEl.classList.add("bid-iso");
  }
  setStatus(next === null ? "isolate off"
    : "isolated: " + m.label
      + (sids.length > 1
        ? " — style " + (sids.indexOf(next) + 1) + " of " + sids.length
          + ", click again for the next" : "")
      + " — Esc shows everything again");
  renderMiniLegend(); draw();
}

// Painted from the rows renderItemized just computed - one source, so the
// bid view, the itemized takeoff and the tally can never disagree.
function renderBidView(groups, ftPerIn) {
  const head = $("bidHead"), box = $("bidBox");
  if (!head || !box) return;
  if (!groups) {
    head.hidden = true; box.hidden = true; box.innerHTML = "";
    return;
  }
  head.hidden = false;
  box.hidden = head.classList.contains("closed");
  box.innerHTML = "";
  const u = ftPerIn ? "ft" : "pt";
  // Flatten the trade groups back to plain rows: the bid view is a second
  // GROUPING of the same items, never a second computation. it.qty here
  // already carries the operator's quantity override, like every reader
  // of computeTakeoffRows.
  const rows = [];
  for (const g of groups)
    for (const it of g.items) {
      const layers = [];
      for (const sid of (it.sids || [])) {
        const st = state.result.styles.find((s) => s.style_id === sid);
        const lay = st && st.layer ? String(st.layer) : "";
        if (lay && layers.indexOf(lay) < 0) layers.push(lay);
      }
      rows.push({ label: it.label, layer: layers.join(" | "),
                  unit: it.unit === "pt" || it.unit === "ft" ? u : it.unit,
                  qty: it.qty, cnt: it.cnt, sids: it.sids || [],
                  isCalc: !!it.isCalc, ov: !!it.ov });
    }
  const buckets = bidGroupRows(rows, (label) => {
    const v = store.getItem(bidKey(label));
    return v && BID_BUCKETS.indexOf(v) >= 0 ? v : null;
  });
  const abbr = (v) => v >= 1000 ? (v / 1000).toFixed(1) + "k"
    : String(Math.round(v * 10) / 10);
  const unitOrder = (x) => x === "ft" || x === "pt" ? 0 : x === "EA" ? 1 : 2;
  const chipText = (byUnit) => {
    const parts = [];
    for (const k of Object.keys(byUnit).sort(
           (a, b) => unitOrder(a) - unitOrder(b) || a.localeCompare(b)))
      if (byUnit[k]) parts.push(abbr(byUnit[k]) + " " + k);
    return parts.join(" · ");
  };
  let any = false;
  for (const B of buckets) {
    if (!B.n) continue;   // an empty bucket is not a bid line
    any = true;
    const un = B.bucket === BID_UNASSIGNED;
    const d = document.createElement("details");
    d.className = "bid-bucket" + (un ? " bid-unassigned" : "");
    d.open = bidOpen.has(B.bucket);
    d.addEventListener("toggle", () => {
      if (d.open) bidOpen.add(B.bucket); else bidOpen.delete(B.bucket);
    });
    const sum = document.createElement("summary");
    const nm = document.createElement("span");
    nm.className = "bid-b-name"; nm.textContent = B.bucket;
    const sub = document.createElement("span");
    sub.className = "bid-b-sub";
    sub.textContent = un
      ? B.n + " row" + (B.n === 1 ? "" : "s") + " / "
        + (chipText(B.byUnit) || "0 " + u)
        + " not yet assigned — open the style list"
      : (chipText(B.byUnit) || "0") + " · " + B.n
        + " row" + (B.n === 1 ? "" : "s");
    sum.append(nm, sub);
    sum.title = un
      ? "No name rule matched these rows and no bucket was picked by hand. "
        + "They are still measured and still in the takeoff - this line "
        + "exists so they cannot vanish quietly. Expand to file each one, "
        + "or open the style list below to work on them."
      : "The sum of the measured takeoff rows filed under this bid line by "
        + "the name rules (or by your own pick on a row). Same rows, same "
        + "filters, same overrides as the itemized takeoff - regrouped, "
        + "never recomputed. Expand for the rows; click a row to isolate "
        + "its linework.";
    d.appendChild(sum);
    // Storm by size, when any member's own label carries a size token
    // (Pierce: pipe separated by size).
    if (B.bucket === "Storm Drainage") {
      const bs = bidBySize(B.members, u);
      const keys = Object.keys(bs);
      if (keys.length > 1 || (keys.length === 1 && keys[0] !== "no size in name")) {
        const line = document.createElement("div");
        line.className = "bid-bysize";
        line.textContent = "by size: " + keys.sort()
          .map((k) => k + " " + abbr(bs[k]) + " " + u).join(" · ");
        line.title = "Split by the size token in each row's own name. "
          + "Rows with no size in the name are never guessed into one.";
        d.appendChild(line);
      }
    }
    for (const m of B.members) {
      const row = document.createElement("div");
      row.className = "bid-member" + (m.sids.length ? "" : " nogeom")
        + (m.sids.indexOf(state.isolate) >= 0 ? " bid-iso" : "");
      const lab = document.createElement("span");
      lab.className = "bm-label";
      lab.textContent = m.label;
      lab.title = m.label + (m.layer ? "\nCAD layer: " + m.layer : "")
        + (m.sids.length
          ? "\n\nClick to isolate this row's linework on the canvas."
          : "\n\nA calculator row - no linework of its own to isolate.");
      row.appendChild(lab);
      if (m.size) {
        const sz = document.createElement("span");
        sz.className = "bm-size"; sz.textContent = m.size;
        sz.title = "size token read from the row's own name";
        row.appendChild(sz);
      }
      const q = document.createElement("span");
      q.className = "bm-qty";
      q.textContent = abbr(m.qty) + " " + m.unit
        + (m.isCalc || m.unit === "EA" ? "" : " · " + m.cnt + " lines");
      q.title = m.qty.toLocaleString(undefined,
        { maximumFractionDigits: 1 }) + " " + m.unit
        + (m.ov ? " (your override; the itemized row discloses the "
                  + "detected figure)" : "");
      row.appendChild(q);
      const pick = document.createElement("select");
      pick.className = "bid-pick" + (m.via === "override" ? " ov" : "");
      pick.name = "bid-" + m.label;
      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = "auto · " + m.ruleBucket;
      auto.selected = m.via !== "override";
      pick.appendChild(auto);
      for (const b of BID_BUCKETS) {
        const o = document.createElement("option");
        o.value = b; o.textContent = b;
        o.selected = m.via === "override" && m.bucket === b;
        pick.appendChild(o);
      }
      pick.title = "Which bid line this row belongs to. “auto” is "
        + "the name rule's filing; your pick overrides it for this document "
        + "and is remembered.";
      pick.onclick = (e) => e.stopPropagation();
      pick.onchange = () => {
        if (pick.value === "") store.removeItem(bidKey(m.label));
        else store.setItem(bidKey(m.label), pick.value);
        renderItemized();
      };
      row.appendChild(pick);
      if (m.sids.length) {
        row.onclick = () => bidIsolate(m, row);
        row.onmouseenter = () => { state.hot = m.sids[0]; draw(); };
        row.onmouseleave = () => { state.hot = null; draw(); };
      }
      d.appendChild(row);
    }
    box.appendChild(d);
  }
  if (!any) {
    const none = document.createElement("div");
    none.className = "bid-none";
    none.textContent = "nothing measured yet";
    box.appendChild(none);
  }
}

function renderItemized() {
  const box = $("itemized");
  const keepFocus = panelFocus(box);
  box.innerHTML = "";
  if (!state.result) {
    // The tally is written far below, after this guard, so it was never
    // cleared: paging to an undetected sheet emptied the table and left the
    // PREVIOUS sheet's "12.4k ft measured - $84320" sitting under it. A stale
    // number with no table under it reads as this sheet's total.
    $("tallyBar").textContent = "";
    // ...and the bid view mirrors these rows, so it goes stale the same way
    renderBidView(null);
    return;
  }
  const { groups, grand, ftPerIn, sheet } = computeTakeoffRows();
  const u = ftPerIn ? "ft" : "pt";
  const head = document.createElement("div");
  head.className = "item-row head";
  head.innerHTML = "<div>label</div><div>count</div><div>" +
    (ftPerIn ? "feet" : "pt") + "</div><div>$/ft</div><div>ext $</div>";
  box.appendChild(head);
  for (const g of groups) {
    const { trade: tr, items: group, sub, subByUnit } = g;
    const th = document.createElement("div");
    th.className = "trade-head";
    // One chip per unit, each labelled with its OWN unit. Never add two units
    // together: a heading reading "31.4k ft" over a group holding 17.5k ft of
    // contour plus 13,677 CY of cut is a number that exists nowhere on earth.
    const abbr = (v) => v >= 1000 ? (v/1000).toFixed(1) + "k" : String(Math.round(v * 10) / 10);
    const unitOrder = (u) => u === "ft" || u === "pt" ? 0 : u === "EA" ? 1 : 2;
    const parts = [];
    for (const [u, v] of [...subByUnit].sort(
           (a, b) => unitOrder(a[0]) - unitOrder(b[0]) || a[0].localeCompare(b[0])))
      if (v) parts.push(`${abbr(v)} ${u}`);
    if (sub) parts.push(`$${sub.toFixed(0)}`);
    th.innerHTML = `<span>${tr}</span><span class="t-sub">` +
      (parts.join(" · ") || "0") + `</span>`;
    box.appendChild(th);
    for (const it of group) {
      const row = document.createElement("div");
      row.className = "item-row";
      const lab = document.createElement("div");
      lab.className = "lab"; lab.title = it.label;
      lab.textContent = it.label;
      const pick = document.createElement("select");
      pick.className = "trade-pick"; pick.name = "trade-" + it.label;
      for (const t2 of TRADES) {
        const o = document.createElement("option");
        o.value = t2; o.textContent = t2; o.selected = t2 === tr;
        pick.appendChild(o);
      }
      pick.onchange = () => {
        store.setItem(tradeKey(it.label), pick.value);
        renderItemized();
      };
      lab.appendChild(document.createElement("br"));
      lab.appendChild(pick);
      const cnt = document.createElement("div"); cnt.textContent = it.cnt;
      const q = document.createElement("input");
      q.type = "number";
      // NO `min`. The HTML step base is the `min` content attribute when one
      // is present and only otherwise the `value` attribute - and making the
      // VALUE the step base is the entire point here: the arrows must nudge
      // from the detected figure (3278.8 -> 3288.8) rather than snap to a
      // multiple of the step counted from zero. With an empty box and
      // min="0", one arrow click wrote 0.1 and wiped the quantity. Dropping
      // min costs nothing: there is no <form> in index.html and nothing calls
      // checkValidity, so it only ever clamped the spinner, and the handler
      // below now rejects <= 0 outright.
      const boxStr = qtyBoxValue(it.qty, it.unit);
      const detStr = qtyBoxValue(it.ov ? it.auto : it.qty, it.unit);
      q.step = qtyStep(it.qty, it.unit);
      q.setAttribute("value", boxStr);   // sets the value AND the step base
      // The box is no longer empty-vs-filled, so the detected/overridden
      // state is stated POSITIVELY: dashed border = the engine's figure,
      // solid accent + bold = yours, plus an ov-note sentence under the row
      // for anything that has to survive a screenshot or a colour-blind read.
      q.className = "qty-in " + (it.ov ? "ov" : "auto");
      q.name = "qty-" + it.label;
      const qUnit = it.unit === "ft" || it.unit === "pt" ? u : it.unit;
      q.title = it.ov
        ? `YOUR figure. The engine detected ${detStr} ${qUnit}.`
          + ` Use "restore detected" under the row, or clear the box.`
        : `Detected by the engine: ${detStr} ${qUnit}.`
          + ` The arrows step by ${q.step}; typing or stepping makes it yours.`;
      // A wheel over a FOCUSED number input steps it in Chrome and Firefox,
      // and this panel lives in a scrolling 330 px sidebar. Scrolling past a
      // box you just clicked must not change a bid quantity.
      q.addEventListener("wheel",
        (ev) => { if (document.activeElement === q) ev.preventDefault(); },
        { passive: false });
      q.onchange = () => {
        const k = ovKey(it.label, it.unit);
        const v = parseFloat(q.value);
        // Empty, zero or negative means NO OVERRIDE, and that has to REMOVE
        // the key rather than store "" or "0". computeTakeoffRows already
        // ignores anything not > 0, but a dead entry survived the reload and
        // counted on the "Saved work" button as a decision nobody made.
        // dupNote's restore already uses removeItem on this key; now they
        // agree.
        // Typing (or stepping back to) the engine's own figure is NOT an
        // override. Storing it anyway produced a row asserting "this sheet
        // uses 25,027.8 ft; the engine detected 25,027.8 ft", counted a
        // decision nobody made on the Saved-work button, and would have sent
        // a redundant entry to the server. Compared at the box's own display
        // precision, so what the operator sees is what the test uses.
        const det = it.ov ? it.auto : it.qty;
        // Compared as the BOX RENDERS THEM, not with a tolerance. An epsilon
        // here would be a tolerance nobody measured, silently swallowing a
        // value the operator typed just inside it; string equality at the
        // display precision has no edge to fall the wrong side of, and means
        // exactly "you typed back what was already showing".
        if (!Number.isFinite(v) || v <= 0) store.removeItem(k);
        else if (Number.isFinite(det)
                 && qtyBoxValue(v, it.unit) === qtyBoxValue(det, it.unit))
          store.removeItem(k);
        else store.setItem(k, String(v));
        renderItemized(); renderChips();
      };
      const pin = document.createElement("input");
      pin.type = "number"; pin.step = "0.01"; pin.placeholder = "—";
      pin.name = "price-" + it.label;
      if (it.price) pin.value = it.price;
      pin.oninput = () => {
        store.setItem(priceKey(it.label), pin.value);
        // NOT renderItemized(). That clears #itemized, detaching THIS input
        // mid-keystroke: focus drops to <body>, and a caret cannot be restored
        // on a number input by any DOM API. Only this row's money can change
        // on a keystroke, so repaint that one cell in place. The subtotals,
        // the TOTAL and the tally bar rebuild on blur - one blur behind, which
        // is the deliberate trade for not deleting the control being typed in.
        const pv = parseFloat(pin.value);
        e.textContent = (it.priced && pv > 0) ? (it.qty * pv).toFixed(0) : "—";
      };
      pin.onchange = () => {
        store.setItem(priceKey(it.label), pin.value);
        renderItemized();
      };
      pin.addEventListener("wheel",
        (ev) => { if (document.activeElement === pin) ev.preventDefault(); },
        { passive: false });
      const e = document.createElement("div");
      e.textContent = it.ext ? it.ext.toFixed(0) : "—";
      row.append(lab, cnt, q, pin, e);
      box.appendChild(row);
      // Both numbers, side by side, only where they differ. The row's own
      // quantity box keeps showing the SUM - nothing here changes a total or
      // hides a chain; it discloses how much of the sum is drawn twice.
      // With the box always filled, detected-vs-overridden can no longer lean
      // on empty-vs-filled. Say it in words: a border colour does not survive
      // a screenshot review, a theme swap, or a colour-blind reader.
      if (it.ov) box.appendChild(ovNote(it, u));
      if (it.dupQty > 0.05) box.appendChild(dupNote(it, u));
    }
  }
  // always-visible tally: sum of INCLUDED footage + priced total.
  // With a work area drawn, inkPt is what COUNTS and wzOutPt is what the
  // mask set aside - both are printed, per the disclosure rule: a cap or
  // mask states what it removed, never silently.
  let inkPt = 0, wzOutPt = 0;
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (!state.include.get(ch.style_id)) continue;
    const full = chainLenPt(ch);
    const counted = chainCountedPt(ch);
    inkPt += counted;
    wzOutPt += full - counted;
  }
  // What the sheet is BILLING, which is not always what the detector measured.
  // The tally used to print the raw chain sum beside a dollar figure that came
  // from computeTakeoffRows and therefore DID honour the operator's
  // corrections - so one sentence reported a corrected total next to an
  // uncorrected footage, and the "sanity check" line disagreed with every row
  // above it. Both halves now come from the same rows; where they differ the
  // detector's figure is printed too, labelled, rather than silently winning.
  let billedQ = 0, autoQ = 0, ovRowN = 0;
  for (const g of groups)
    for (const it of g.items) {
      if (it.unit !== "ft" && it.unit !== "pt") continue;
      billedQ += it.qty;
      autoQ += (it.ov && Number.isFinite(it.auto)) ? it.auto : it.qty;
      if (it.ov) ovRowN += 1;
    }
  const tf = ftPerIn ? inkPt / 72 * ftPerIn : null;
  // The union is over EVERY included chain on the sheet, so unlike the
  // per-row figures it also catches a segment shared by two chains with
  // different labels. Shown beside the sum, never instead of it.
  const uf = ftPerIn ? sheet.unionPt / 72 * ftPerIn : null;
  const tb = $("tallyBar");
  const abbrQ = (v) => (v >= 1000 ? (v/1000).toFixed(1) + "k" : v.toFixed(0)) + " " + u;
  // pt->display for the two work-area figures, in the sheet's own unit
  const wzFmt = (ptv) => {
    if (ftPerIn === null) return fmtLen(ptv);
    const ftv = ptv / 72 * ftPerIn;
    return (ftv >= 1000 ? (ftv / 1000).toFixed(1) + "k" : ftv.toFixed(0)) + " ft";
  };
  tb.textContent =
    (wzActive()
      ? "work area: " + wzFmt(inkPt) + " counted \u00b7 "
        + wzFmt(wzOutPt) + " outside excluded"
        + (ovRowN ? " \u00b7 " + abbrQ(billedQ) + " billed" : "")
      : ovRowN
      ? abbrQ(billedQ) + " billed \u00b7 " + abbrQ(autoQ) + " measured"
      : (tf !== null
          ? (tf >= 1000 ? (tf/1000).toFixed(1) + "k" : tf.toFixed(0)) + " ft measured"
          : fmtLen(inkPt) + " measured"))
    + (sheet.excessPt > 0.05
        ? " · union " + (uf !== null
            ? (uf >= 1000 ? (uf/1000).toFixed(1) + "k" : uf.toFixed(0)) + " ft"
            : fmtLen(sheet.unionPt))
        : "")
    + (() => {
        // Stated once, on the sheet total, rather than on every row: a
        // per-row threshold is a judgement about how much welded gap matters
        // to a given trade, and that is the estimator's call, not this
        // function's. Hidden under 0.5% only because a figure that small is
        // rounding, not a finding.
        const oc = sheetOverCapture();
        if (!oc || oc.gap / oc.len <= 0.005) return "";
        return ` · ${(100 * oc.gap / oc.len).toFixed(1)}% welded`;
      })()
    + (grand ? ` · $${grand.toFixed(0)}` : "");
  const wzPrefix = wzActive()
    ? `WORK AREA: ${state.workZones.length} box(es) drawn on the sheet. `
      + `Every list here - the style rows, these itemized rows, the CSV and `
      + `the approve export - counts only length inside the boxes; a line `
      + `crossing an edge counts exactly its inside piece. Nothing is `
      + `deleted: clear the work area and every number returns. Welded-gap `
      + `footage inside a chain is apportioned by that chain's inside `
      + `fraction. The earthwork and trench calculators keep their own `
      + `boundary (the limit of work) and are NOT masked by the work area.\n\n`
    : "";
  const ovPrefix = ovRowN
    ? `${ovRowN} row(s) on this sheet carry a quantity YOU typed, so "billed" `
      + `is your figure and "measured" is the detector's. The dollar total `
      + `follows the billed figure.\n\n`
    : "";
  tb.title = wzPrefix + ovPrefix + (sheet.excessPt > 0.05
    ? `Sum adds every included chain's length. Union counts each polyline ` +
      `segment once: ${sheet.sharedLegs} segment(s) across ` +
      `${sheet.nChains} included chains are carried by two or more chains, ` +
      `worth ${fmtLen(sheet.excessPt)} ` +
      `(${(sheet.excessPt / sheet.sumPt * 100).toFixed(2)}% of the sum). ` +
      `Nothing is removed - both numbers are the same chains, counted two ` +
      `ways. Identical-geometry test, so it is a lower bound.`
    : `No included chain on this sheet shares a polyline segment with ` +
      `another, so the sum already counts each segment once.`);
  const _oc = sheetOverCapture();
  if (_oc && _oc.len > 0) {
    tb.title += `

Of the measured length, ${fmtLen(_oc.gap)} `
      + `(${(100 * _oc.gap / _oc.len).toFixed(2)}%) is blank paper the tracer `
      + `welded into a chain - a stitch across a gap, a join between two `
      + `chains, or the approach to a mark it picked up. A further `
      + `${fmtLen(_oc.pick)} (${(100 * _oc.pick / _oc.len).toFixed(2)}%) is `
      + `ink picked up from elsewhere on the sheet, which the chain it came `
      + `from may also still be counting.

Both are included in every `
      + `figure above. They are shown so the number can state what it is made `
      + `of; nothing is removed.`;
  }
  if (grand) {
    const row = document.createElement("div");
    row.className = "item-row total";
    row.innerHTML = `<div>TOTAL</div><div></div><div></div><div></div><div>${grand.toFixed(0)}</div>`;
    box.appendChild(row);
  }
  // The bid view is the SAME rows regrouped, so it repaints wherever the
  // itemized takeoff does - one call site, and the two cannot drift.
  renderBidView(groups, ftPerIn);
  // The panel was torn down and rebuilt; put the operator's cursor back on the
  // same field. This covers the ~30 callers other than the price box, notably
  // the 350 ms label-typing timer and every spinner click on a quantity box.
  panelRefocus(box, keepFocus);
  // Every mutation of the takeoff ends here, so this is the one place the
  // operator's committed calculator rows and area selections can be saved
  // without a caller being able to forget. store.setItem skips an unchanged
  // value, so a repaint that changed nothing writes nothing.
  calcSave();
}

// Appended to every CSV. Set from /api/beta-notice so it cannot drift from
// the banner and the report stamp; the fallback matters because a CSV with no
// caveat is the version that ends up pasted into a bid.
let BETA_CSV_TAIL = "\n\nBETA SOFTWARE - quantities are produced by "
  + "automated detection and can be wrong. Check every figure against the "
  + "source drawings before relying on it.\n";

async function loadBetaNotice() {
  let n = null;
  try {
    const r = await fetch("/api/beta-notice");
    if (r.ok) n = await r.json();
  } catch (e) { /* keep the built-in wording */ }
  if (n && n.long) BETA_CSV_TAIL = "\n\n" + n.long.replace(/"/g, '""') + "\n";
  const el = $("betaBanner");
  if (el && n && n.short) el.textContent = n.short;
}
loadBetaNotice();

// Who is signed in, and a way to stop being signed in. A session cookie with
// no sign-out is the same trap HTTP Basic was: a browser stuck with
// credentials the user cannot clear.
async function loadWhoami() {
  let me = null;
  try {
    const r = await fetch("/api/me");
    if (r.ok) me = await r.json();
  } catch (e) { return; }
  // The CSV button is decided BEFORE the early return. On a box with no
  // accounts (a laptop, or a freshly provisioned server) there is no user to
  // name, but whoever is sitting there is effectively staff and the export
  // endpoint already lets them through - hiding the button would only make it
  // undiscoverable, not more private.
  const x = $("fbExportBtn");
  if (x && (!me || !me.accounts || me.staff)) x.hidden = false;
  if (!me || !me.user) return;          // no accounts configured; nothing to show
  const w = $("whoami");
  if (w) {
    w.textContent = me.user + (me.staff ? " · staff" : "");
    w.hidden = false;
  }
  const b = $("signOutBtn");
  if (b) {
    b.hidden = false;
    b.onclick = async () => {
      try { await fetch("/api/logout", { method: "POST" }); } catch (e) { /* go anyway */ }
      location.href = "/login";
    };
  }
}
loadWhoami();

// ---------------------------------------------------------------- feedback
// Exists so a client does not have to phone somebody. The free text is the
// least useful half: "the lines are wrong" cannot be acted on without knowing
// which sheet, which style and which build, and the person reporting it should
// not have to know that either. So it is collected here and sent with them.
function fbContext() {
  const sel = state.selected !== null ? chainById(state.selected) : null;
  const styleId = sel ? sel.style_id : state.isolate;
  return {
    document: state.docName || null,
    page: state.page !== undefined && state.page !== null ? state.page + 1 : null,
    style: styleId !== null && styleId !== undefined
      ? (state.labels.get(styleId) || "style " + styleId) : null,
    scale: state.result && state.result.scale
      ? (state.result.scale.text || String(state.result.scale.ft_per_in || "")) : null,
    chains: state.result && state.result.chains ? state.result.chains.length : null,
    app: (document.querySelector('script[src*="app.js"]') || {}).src?.split("?")[1] || null,
    url: location.pathname + location.search,
  };
}

function fbClose() {
  const el = document.querySelector(".fb-back");
  if (el) el.remove();
}

$("fbBtn").onclick = () => {
  if (document.querySelector(".fb-back")) return fbClose();
  const ctx = fbContext();

  const back = document.createElement("div");
  back.className = "fb-back";
  // click-outside closes, but never mid-typing inside the card
  back.onclick = (e) => { if (e.target === back) fbClose(); };

  const card = document.createElement("div");
  card.className = "fb-card";
  card.innerHTML = `
    <div class="fb-head">Send feedback</div>
    <div class="fb-sub">Goes straight to Koby and Christian. No phone call needed.</div>

    <label class="fb-lab" for="fbSev">How much is it hurting you?</label>
    <select id="fbSev" class="fb-in">
      <option value="wrong-number">A number came out wrong</option>
      <option value="blocked">I am stuck and cannot carry on</option>
      <option value="annoying" selected>Annoying, but I worked around it</option>
      <option value="idea">Just an idea</option>
    </select>

    <label class="fb-lab" for="fbCat">What is it about?</label>
    <select id="fbCat" class="fb-in">
      <option value="wrong-quantity">A quantity or measurement is wrong</option>
      <option value="missed-lines">It missed lines that are on the drawing</option>
      <option value="extra-lines">It drew lines that are not there</option>
      <option value="error">Something errored or would not load</option>
      <option value="confusing">Confusing or hard to use</option>
      <option value="feature">I want it to do something new</option>
      <option value="other" selected>Something else</option>
    </select>

    <label class="fb-lab" for="fbMsg">What happened?</label>
    <textarea id="fbMsg" class="fb-in fb-msg" rows="5" maxlength="4000"
      placeholder="What you expected, and what you got instead."></textarea>

    <label class="fb-check"><input type="checkbox" id="fbShot" checked>
      Attach a picture of the sheet as it looks now</label>

    <div class="fb-ctx">
      <div class="fb-ctx-h">Sent with this, so you do not have to describe it:</div>
      <div class="fb-ctx-b">${
        [["Sheet", ctx.document], ["Page", ctx.page], ["Line style", ctx.style],
         ["Scale", ctx.scale], ["Lines detected", ctx.chains]]
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `${k}: ${String(v).replace(/[<>&]/g, "")}`)
          .join(" &middot; ") || "nothing open yet"
      }</div>
    </div>

    <div class="fb-actions">
      <button id="fbCancel" class="ghost">Cancel</button>
      <button id="fbSend">Send</button>
    </div>`;
  back.appendChild(card);
  document.body.appendChild(back);
  $("fbMsg").focus();
  $("fbCancel").onclick = fbClose;

  $("fbSend").onclick = async () => {
    const msg = $("fbMsg").value.trim();
    if (!msg) { $("fbMsg").focus(); return; }
    const btn = $("fbSend");
    btn.disabled = true; btn.textContent = "Sending…";

    let shot = null;
    if ($("fbShot").checked) {
      const cv = $("view");
      if (cv) {
        try {
          // Downscaled deliberately: full size is several MB per report and
          // the point is to see WHICH bit of the sheet, not to read it.
          const sc = Math.min(1, 1100 / Math.max(cv.width, 1));
          const off = document.createElement("canvas");
          off.width = Math.round(cv.width * sc);
          off.height = Math.round(cv.height * sc);
          off.getContext("2d").drawImage(cv, 0, 0, off.width, off.height);
          shot = off.toDataURL("image/png");
        } catch (e) { shot = null; }
      }
    }
    try {
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg, severity: $("fbSev").value,
          category: $("fbCat").value, context: fbContext(), shot,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        btn.disabled = false; btn.textContent = "Send";
        return setStatus(e.detail || `could not send that (${r.status})`, "err");
      }
      fbClose();
      setStatus("thanks \u2014 feedback sent");
    } catch (e) {
      btn.disabled = false; btn.textContent = "Send";
      setStatus("could not reach the server \u2014 try again", "err");
    }
  };
};

// Staff only. The button is hidden for everyone else, and the endpoint 404s
// for them too - a hidden button is a courtesy, not a permission.
$("fbExportBtn").onclick = () => { location.href = "/api/feedback.csv"; };


// ---------- CSV export of the itemized takeoff (client-side blob) ----------
function takeoffCsv() {
  const data = computeTakeoffRows();
  if (!data) return null;
  const { groups, grand, ftPerIn, sheet } = data;
  const csc = (v) => {
    v = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const uq = (pt) => ftPerIn ? pt / 72 * ftPerIn : pt;
  // Two columns appended, never substituted: the existing quantity column is
  // byte-for-byte what it was. "union" counts each polyline segment once;
  // "drawn twice" is what the sum counts more than once (sum - union).
  const rows = [["label", "trade", "count/EA",
                 ftPerIn ? "feet" : "pt", "$/ft", "ext $",
                 ftPerIn ? "union feet" : "union pt",
                 ftPerIn ? "drawn twice feet" : "drawn twice pt"]];
  for (const g of groups) {
    for (const it of g.items) {
      const isLf = !isNaN(parseFloat(it.cnt));   // plain line-count rows
      rows.push([
        it.label,
        g.trade,
        isLf ? it.cnt : `${it.qty} ${it.cnt}`,
        isLf ? it.qty.toFixed(1)
             : (it.ft !== undefined && it.ft !== null ? it.ft.toFixed(1) : ""),
        it.price !== null && it.price !== undefined ? it.price : "",
        it.ext ? it.ext.toFixed(2) : "",
        it.unionQty !== undefined ? it.unionQty.toFixed(1) : "",
        it.dupQty !== undefined ? it.dupQty.toFixed(1) : "",
      ]);
    }
  }
  if (grand) rows.push(["TOTAL", "", "", "", "", grand.toFixed(2), "", ""]);
  rows.push(["SHEET TOTAL (every included line)", "", "",
             uq(sheet.sumPt).toFixed(1), "", "",
             uq(sheet.unionPt).toFixed(1), uq(sheet.excessPt).toFixed(1)]);
  // Disclosure travels WITH the numbers: a CSV opened next week must say
  // that a mask was on and what it removed, or the clipped figures above
  // read as the whole sheet. Two rows, same unit column as everything else.
  if (wzActive()) {
    let cIn = 0, cOut = 0;
    for (const ch of state.result.chains) {
      if (state.excluded.has(ch.chain_id)) continue;
      if (!state.include.get(ch.style_id)) continue;
      const full = chainLenPt(ch), counted = chainCountedPt(ch);
      cIn += counted; cOut += full - counted;
    }
    rows.push([`WORK AREA counted (${state.workZones.length} box(es) drawn; `
               + `quantities above count only length inside them)`,
               "", "", uq(cIn).toFixed(1), "", "", "", ""]);
    rows.push(["WORK AREA excluded (outside the boxes; not in any figure above)",
               "", "", uq(cOut).toFixed(1), "", "", "", ""]);
  }
  return rows.map(r => r.map(csc).join(",")).join("\r\n") + "\r\n";
}
$("csvBtn").onclick = () => {
  const csv = takeoffCsv();
  if (csv === null) return;
  const stem = (state.docName || "takeoff").replace(/\.pdf$/i, "");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv + BETA_CSV_TAIL], { type: "text/csv" }));
  a.download = `${stem}_p${state.page + 1}_takeoff.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`CSV downloaded — ${a.download}`);
};

// ---------- collapsible sidebar sections ----------
// every section header toggles the elements listed for it; state is
// per-session only (a refresh reopens everything)
const SECTIONS = [
  ["legendHead", ["legendBox"]],
  ["arHead", ["arList", "arScale", "arUnmatched"]],
  ["bidHead", ["bidBox"]],
  ["stylesHead", ["styleList", "colorChips", "styleSearch"]],
  ["takeoffHead", ["itemized"]],
  ["ewHead", ["ewRows", "ewHint", "ewLimit", "ewLayers", "ewActions",
              "ewBasis", "ewTake", "ewBalance"]],
  ["trHead", ["trBody", "trHint", "trBandBox", "trActions", "trTake"]],
  ["symHead", ["symRows", "symHint"]],
  ["coHead", ["coRows", "coHint"]],
];
for (const [headId, contentIds] of SECTIONS) {
  const head = document.getElementById(headId);
  if (!head) continue;
  const h2 = head.querySelector("h2");
  if (!h2) continue;
  h2.onclick = () => {
    const closed = head.classList.toggle("closed");
    for (const cid of contentIds) {
      const el = document.getElementById(cid);
      if (el) el.hidden = closed;
    }
  };
}

// ---------- earthwork calculator ----------
$("ewClose").onclick = () => { $("ewPanel").hidden = true; state.hotChain = null; ewDisarmPick(); draw(); };
$("ewBtn").onclick = async () => {
  const panel = $("ewPanel");
  if (!panel.hidden) { panel.hidden = true; ewDisarmPick(); return; }
  panel.hidden = false;
  panel.scrollIntoView({ block: "start", behavior: "smooth" });
  // a page switch nulls state.tool without touching this button's class
  $("ewAddRow").classList.remove("active");
  $("ewBoundPick").classList.remove("active");
  renderEwBound();
  if (!state.ew) {
    $("ewRows").innerHTML = '<div class="ew-hint">reading elevation labels…</div>';
    if (!await ewEnsure()) { $("ewRows").textContent = "run Detect first"; return; }
  }
  renderEw();
  renderEwLayers();
  renderEwSpots();
  renderEwArea();
  renderEwTake();
  renderGz();
  // Re-anchor AFTER the async suggest + renders: the CHECK FIRST banner
  // above this panel grows when the datum note lands, which shoved the
  // panel head 58px above the fold on C3.1 (measured) - the smooth scroll
  // that ran at open had already finished aiming at the old layout.
  panel.scrollIntoView({ block: "start" });
  // the suggest payload carries the datum + spot facts the review queue
  // reports (items 3 and 5), and ewApplySaved just settled the drop count
  renderCheckQueue();
};

// Build state.ew from /earthwork/suggest. Extracted from the EARTHWORK
// button so the grading-zone restore path can load the same rows without
// the panel being open - a restored zone recomputes through the endpoint
// and the endpoint takes the suggest-derived existing surface as input.
// Returns false when the suggest fetch fails or the page changed under it.
async function ewEnsure() {
  if (state.ew) return true;
  const gen = state.gen;
  const r = await fetch(`/api/job/${state.job}/page/${state.page}/earthwork/suggest`);
  if (!r.ok || gen !== state.gen) return false;
  {
    const j = await r.json();
    if (gen !== state.gen || state.ew) return false;
    const ws = j.suggestions.map(s => s.width || 0).sort((a, b) => a - b);
    const wmed = ws.length ? ws[Math.floor(ws.length / 2)] : 0;
    state.ew = {
      rows: j.suggestions.map(s => ({
        chain_id: s.chain_id, z: s.z, width: s.width || 0, dist: s.dist,
        // default split by stroke weight - existing plots lighter than
        // proposed on most grading sheets; every row is user-flippable
        surface: (s.width || 0) <= wmed ? "existing" : "proposed",
      })),
      result: null,
      // suggest-seeded rows the operator deleted, BY chain id - persisted
      // so a fresh suggest on the next visit cannot resurrect them
      removed: [],
      // layer stacks (Beaumont workflow): what comes OFF the existing
      // ground before cut/fill starts (topsoil strip, old asphalt, road
      // base) and what gets BUILT on the proposed side (base, paving).
      // Session-only like the rest of this panel. {name, thickness_in}
      layers: { existing: [], proposed: [] },
      // Spot grades: the FG/TS/TW elevations the sheet prints as "FG: 15.96".
      // On a detailed grading sheet these outnumber labelled contours many to
      // one, and they are POINT elevations, not lines. Ground tags default ON;
      // structure tops (RIM, wall, step) are not ground and stay off.
      spots: j.spot_grades || [],
      // How the truncated spot values were anchored, and whether the sheet's
      // two sources disagreed: {declared, band_base, band_n, chosen,
      // conflict}. On Barn C3.3 the legend note says 7600 while four printed
      // contours say 7700 - the engine now resolves by band strength, but a
      // disagreement like that must reach the operator's eyes either way.
      datum: j.spot_datum || null,
      spotOn: { FG: true, ME: true, EG: true, PE: true },  // PE = pad elevation, proposed ground
      spotSide: "proposed",
      spotDatum: null,
      areaSf: null,
      map: null,   // {img, bbox} once "Show cut/fill map" is on
      // Consent, not a cache. Calculating is LOOKING at the number;
      // putting it in the priced takeoff is a decision the estimator makes
      // by pressing "Add to takeoff". Until then nothing earthwork reaches
      // state.extraItems, so an approve produces no earthwork line at all.
      // Session-only and per detection result, like the rest of this panel.
      added: false,
    };
    // the durable inputs for this page (server sidecar), applied before
    // the panel's first paint; chain-keyed values only where the chain
    // still exists - ewApplySaved counts and reports the rest
    if (state.calcSavedLoaded) ewApplySaved();
    else if (state.calcSaveBroken)
      calcNotePut("ewHint", "This page's saved calculator inputs could not be read when it loaded, and edits here are NOT being saved. Reload to retry.");
  }
  return true;
}

// ---- manual contour rows (F57 OPEN item: C3.4 prints no elevations) ----
// The estimator clicks a contour line and types the elevation they read
// off the overview sheet. Session-only, like every other row here.
// ---------- limit of work ------------------------------------------------
// state.ewBound = { pts: [[x,y],...], src: "chain 412" | "outline", closed }
// Page points, the same space the chains live in, which is what the server
// integrates over. Held OUTSIDE state.ew so re-running the calculator does
// not silently drop it; cleared on a page change like every other page fact.
function ewBoundSet(pts, src) {
  const p = (pts || []).filter(q => Array.isArray(q) && q.length >= 2)
                       .map(q => [+q[0], +q[1]]);
  if (p.length < 3) {
    setStatus("that line has fewer than 3 points " + '—' + " it cannot bound an area", "err");
    return false;
  }
  // A limit-of-work line is usually drawn closed, but a traced one often is
  // not. The polygon test treats the last point as joined to the first
  // anyway, so an open line is USABLE - say so rather than refusing, and say
  // how far apart the ends are so the operator can judge it.
  const dx = p[0][0] - p[p.length - 1][0], dy = p[0][1] - p[p.length - 1][1];
  const gap = Math.hypot(dx, dy);
  state.ewBound = { pts: p, src: src || "picked", gap };
  renderEwBound();
  calcStateDirty();
  return true;
}
// A limit-of-work line is almost never ONE chain. Measured on Barn C3.0
// (the audit's own example): the BG-Limit of disturbance layer is 10 open
// chains across three styles - dash runs broken at labels and corners -
// and picking the longest one alone gave 4,730 SF against the estimator's
// own 224,058 SF Clear & Grub, a 47x under-read returned as a success.
// Stitching the layer family end-to-end reads 312,044 SF, the right order
// of magnitude, with every join on the record.
//
// Joins are tiered from the same measurement: real label/dash breaks on
// C3.0 run 0-124 pt, the two genuine long bridges are 368 and 125 pt, and
// nothing legitimate exceeded that - so joins up to EW_STITCH_MAX = 500 pt
// are taken but every join >= 12 pt is REPORTED (count + the largest, in
// feet when the scale is known), the closure gap is reported the same way,
// and family chains further than the cap are left out LOUDLY. The operator
// sees the ring and its SF on the panel and judges; nothing is silent.
const EW_STITCH_MAX = 500;  // pt; > the largest genuine bridge measured (368)
function ewBoundStitch(start) {
  const fam = (start.layer
    ? state.result.chains.filter(c => c.layer === start.layer)
    : state.result.chains.filter(c => c.style_id === start.style_id))
    .filter(c => !state.excluded.has(c.chain_id));
  const own = Math.hypot(
    start.points[0][0] - start.points[start.points.length-1][0],
    start.points[0][1] - start.points[start.points.length-1][1]);
  // already a ring, or nothing to stitch with: the chain speaks for itself
  if (own < 2 || fam.length < 2)
    return { pts: start.points.slice(), n: 1, joins: [], leftover: 0 };
  const dist = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
  const used = new Set([start.chain_id]);
  let poly = start.points.slice();
  const joins = [];
  for (;;) {
    let best = null;
    for (const endIdx of [0, 1]) {
      const e = endIdx === 0 ? poly[poly.length-1] : poly[0];
      for (const c of fam) {
        if (used.has(c.chain_id)) continue;
        const q = c.points;
        for (const rev of [false, true]) {
          const d = dist(e, rev ? q[q.length-1] : q[0]);
          if (!best || d < best.d) best = { d, c, rev, endIdx };
        }
      }
    }
    if (!best || best.d > EW_STITCH_MAX) break;
    let q = best.c.points.slice();
    if (best.rev) q.reverse();
    if (best.endIdx === 0) poly = poly.concat(q);
    else poly = q.slice().reverse().concat(poly);
    used.add(best.c.chain_id);
    joins.push(best.d);
  }
  return { pts: poly, n: used.size, joins,
           leftover: fam.length - used.size };
}
// One message covering what the stitcher did, in the operator's units.
function ewStitchStatus(st) {
  const ftPerPt = (state.result && state.result.scale
    && state.result.scale.ft_per_paper_inch)
    ? state.result.scale.ft_per_paper_inch / 72 : null;
  const fmt = pt => ftPerPt ? Math.round(pt * ftPerPt) + " ft" : Math.round(pt) + " pt";
  const big = st.joins.filter(j => j >= 12);
  let m = st.n > 1 ? `limit of work stitched from ${st.n} lines` : "limit of work set";
  if (big.length) m += ` ${'—'} ${big.length} gap${big.length>1?"s":""} bridged, largest ${fmt(Math.max(...big))}`;
  if (st.leftover) m += ` ${'—'} ${st.leftover} line${st.leftover>1?"s":""} of this layer left OUT (further than ${fmt(EW_STITCH_MAX)})`;
  return m + ` ${'—'} recalculate to apply`;
}
function ewBoundClear() {
  state.ewBound = null;
  renderEwBound();
  calcStateDirty();
}
function renderEwBound() {
  const box = $("ewBound"), st = $("ewBoundState"), clr = $("ewBoundClear");
  if (!box) return;
  const b = state.ewBound;
  box.classList.toggle("on", !!b);
  if (clr) clr.hidden = !b;
  const ftPerPt = (state.result && state.result.scale
    && state.result.scale.ft_per_paper_inch)
    ? state.result.scale.ft_per_paper_inch / 72 : null;
  if (st) {
    if (!b) {
      st.textContent = "not set " + '—' + " the whole overlap of both surfaces";
      st.title = "Cut and fill are integrated wherever BOTH surfaces are "
        + "defined, which is the intersection of their convex hulls. That "
        + "reaches into ground nobody is grading.";
    } else {
      const a = Math.abs(polyAreaPt(b.pts));
      const sf = ftPerPt ? a * ftPerPt * ftPerPt : null;
      st.textContent = `${b.src} ${'—'} ${b.pts.length} points`
        + (sf ? ` ${'—'} ${Math.round(sf).toLocaleString()} SF` : "");
      st.title = (b.gap > 1
        ? `The line does not close: its ends are ${b.gap.toFixed(1)} pt apart. `
          + `They are joined for the area test, so check the shape is what you meant. `
        : "") + "Volume outside this outline is not counted.";
    }
  }
  // the standing caveat is no longer true once a boundary is in force
  const w = $("ewWhere");
  if (w) w.innerHTML = b
    ? "<b>Where it applies.</b> Inside the limit of work you set "
      + "(" + b.pts.length + " points" + (b.src ? ", " + b.src : "") + "). "
      + "Ground outside it is not counted at all."
    : "<b>Where it applies.</b> Each surface exists only inside a "
      + "straight-sided envelope drawn around the contours you gave it (its "
      + "convex hull), and the volume is integrated where the two envelopes "
      + "overlap. That envelope cuts straight across every bay and notch in "
      + "the real limit of disturbance and reaches out to the furthest "
      + "contour, so <b>the region is not the graded area</b>. Set a limit of "
      + "work below and it will be.";
}
// shoelace, page pt^2
function polyAreaPt(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return a / 2;
}

$("ewBoundClear").onclick = () => {
  ewBoundClear();
  setStatus("limit of work cleared " + '—' + " volumes cover the whole overlap again");
};
$("ewBoundPick").onclick = () => {
  if (!state.result) return setStatus("run Detect first", "err");
  if (state.tool === "ew-bound") { ewDisarmBound("limit of work cancelled"); return; }
  if (state.selected !== null) {
    const ch = chainById(state.selected);
    if (ch) {
      const st = ewBoundStitch(ch);
      if (ewBoundSet(st.pts, st.n > 1
            ? `${st.n} lines stitched (${(ch.layer || "style " + ch.style_id).split("|").pop()})`
            : "chain " + ch.chain_id)) {
        state.ewBound.seed = ch.chain_id;
        calcStateDirty();
        setStatus(ewStitchStatus(st));
        return;
      }
    }
  }
  state.tool = "ew-bound";
  $("ewBoundPick").classList.add("active");
  setStatus("limit of work: click the grading-limit line on the sheet "
    + '—' + " Esc cancels", "busy");
};
// Hand-drawn limit of work (Jason Knudson's requirement, verbatim: "an
// automatic boundary would be cool, but it would have to be editable" -
// F145). A picked chain only works when the sheet draws ONE clean limit
// line; Stice's Coral Mountain sheet fragments its GRADING LIMITS line and
// the tract ring over-includes interior no-work areas. Drawing follows the
// odd cuts a real site has. Same interaction grammar as the structure
// outline (st-draw): click corners, Enter/double-click closes, Esc backs
// up one corner then cancels.
$("ewBoundDraw").onclick = () => {
  if (!state.result) return setStatus("run Detect first", "err");
  if (state.tool === "ew-bound-draw") { ewBoundDrawCancel("limit of work: drawing cancelled"); return; }
  state.tool = "ew-bound-draw";
  state.ewBoundDraft = [];
  $("ewBoundDraw").classList.add("active");
  syncCursor();
  setStatus("limit of work: click the corners of the graded area "
    + '—' + " Enter or double-click closes, Esc backs up", "busy");
};
function ewBoundDrawClick(px, py) {
  const d = state.ewBoundDraft;
  const last = d[d.length - 1];
  if (last && Math.hypot(px - last[0], py - last[1]) < 0.5) return;  // dblclick echo
  d.push([px, py]);
  const ftPerPt = (state.result && state.result.scale
    && state.result.scale.ft_per_paper_inch)
    ? state.result.scale.ft_per_paper_inch / 72 : null;
  let live = "";
  if (d.length >= 3 && ftPerPt) {
    const sf = Math.abs(polyAreaPt(d)) * ftPerPt * ftPerPt;
    live = ` ${'·'} ${Math.round(sf).toLocaleString()} SF so far`;
  }
  setStatus(`limit of work: ${d.length} corner(s)${live} ${'—'} Enter/double-click closes, Esc backs up`, "busy");
  draw();
}
function ewBoundDrawFinish() {
  const pts = [];
  for (const q of state.ewBoundDraft)
    if (!pts.length || Math.hypot(q[0] - pts[pts.length-1][0], q[1] - pts[pts.length-1][1]) > 0.5)
      pts.push(q);
  if (pts.length < 3) {
    return ewBoundDrawCancel("limit of work: a boundary needs at least 3 corners "
      + '—' + " drawing cancelled");
  }
  state.tool = null;
  state.ewBoundDraft = [];
  $("ewBoundDraw").classList.remove("active");
  syncCursor();
  if (ewBoundSet(pts, "drawn outline")) {
    state.ewBound.seed = null;        // persisted by its points, not a chain
    calcStateDirty();
    setStatus(`limit of work drawn ${'—'} ${pts.length} corners ${'—'} recalculate to apply`);
  }
  draw();
}
function ewBoundDrawCancel(msg) {
  state.tool = null;
  state.ewBoundDraft = [];
  $("ewBoundDraw").classList.remove("active");
  syncCursor();
  if (msg) setStatus(msg);
  draw();
}

function ewDisarmBound(msg) {
  if (state.tool !== "ew-bound") return;
  state.tool = null;
  $("ewBoundPick").classList.remove("active");
  if (msg !== undefined) setStatus(msg);
}
function ewBoundAt(px, py) {
  const { k } = state.view;
  const f = IMG_DPI / 72;
  const tolPt = 6 / k / f * 4 + 1.5;
  let best = null, bestD = tolPt;
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    for (let i = 1; i < ch.points.length; i++) {
      const d = distToSeg(px, py, ch.points[i-1], ch.points[i]);
      if (d < bestD) { bestD = d; best = ch; }
    }
  }
  if (!best)
    return setStatus("no line there " + '—' + " click closer to the grading-limit line, or Esc", "err");
  ewDisarmBound(undefined);
  const st = ewBoundStitch(best);
  if (ewBoundSet(st.pts, st.n > 1
        ? `${st.n} lines stitched (${(best.layer || "style " + best.style_id).split("|").pop()})`
        : "chain " + best.chain_id)) {
    state.ewBound.seed = best.chain_id;
    calcStateDirty();
    setStatus(ewStitchStatus(st));
  }
}
const _ewBoundClickBefore = handleCanvasClick;
handleCanvasClick = function (e) {
  if (state.tool === "ew-bound") {
    const [px, py] = ptFromEvent(e);
    return ewBoundAt(px, py);
  }
  return _ewBoundClickBefore(e);
};
addEventListener("keydown", (e) => {
  if (typing() || state.tool !== "ew-bound") return;
  if (e.key === "Escape") {
    e.preventDefault(); e.stopImmediatePropagation();
    ewDisarmBound("limit of work cancelled");
  }
}, true);

function ewDisarmPick(msg) {
  if (state.tool !== "ew-pick") return;
  state.tool = null;
  $("ewAddRow").classList.remove("active");
  setStatus(msg || "");
}
function ewAppendRow(cid) {
  const ch = chainById(cid);
  if (!ch) return setStatus(`chain ${cid} not found`, "err");
  if (ch.custom) {
    // volumes are computed server-side from the DETECTED result file;
    // locally drawn/edited copies don't exist there and would be
    // silently ignored - refuse loudly instead
    return setStatus("that line is a local edit — pick an original detected line", "err");
  }
  if (state.ew.rows.some(r => r.chain_id === cid)) {
    state.hotChain = cid; draw();
    return setStatus(`chain ${cid} is already in the list`, "err");
  }
  state.ew.rows.push({ chain_id: cid, z: NaN, width: ch.width || 0, dist: null,
                       surface: null, manual: true });
  if (state.ew.removed) state.ew.removed = state.ew.removed.filter(id => id !== cid);
  state.hotChain = cid;
  renderEw();
  draw();
  const inp = $("ewRows").querySelector(`input[name="ew-z-${cid}"]`);
  if (inp) inp.focus();
  setStatus(`chain ${cid} added — type its elevation, then EXIST or PROP`);
  calcStateDirty();
}
$("ewAddRow").onclick = () => {
  if (!state.ew) return setStatus("run Detect first", "err");
  if (state.tool === "ew-pick") { ewDisarmPick("add contour cancelled"); return; }
  // a line already selected on the canvas is what the user means - take it
  if (state.selected !== null && chainById(state.selected) !== null) {
    ewAppendRow(state.selected);
    return;
  }
  state.tool = "ew-pick";
  $("ewAddRow").classList.add("active");
  setStatus("add contour: click the contour line on the sheet — Esc cancels", "busy");
};
// nearest VISIBLE chain, same eligibility + zoom-scaled tolerance as a
// plain canvas click (handleCanvasClick)
function ewPickAt(px, py) {
  const { k } = state.view;
  const f = IMG_DPI / 72;
  const tolPt = 6 / k / f * 4 + 1.5;
  let best = null, bestD = tolPt;
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (state.isolate !== null ? ch.style_id !== state.isolate
                               : !state.include.get(ch.style_id)) continue;
    for (let i = 1; i < ch.points.length; i++) {
      const d = distToSeg(px, py, ch.points[i-1], ch.points[i]);
      if (d < bestD) { bestD = d; best = ch; }
    }
  }
  if (!best) return setStatus("no line there — click closer to the contour, or Esc to cancel", "err");
  ewDisarmPick();
  ewAppendRow(best.chain_id);
}
// clicks land in the contour picker while it is armed; declared before the
// structure tool's wrapper, which chains onto this one at load time
const _ewClickBefore = handleCanvasClick;
handleCanvasClick = function (e) {
  if (state.tool === "ew-pick") {
    const [px, py] = ptFromEvent(e);
    return ewPickAt(px, py);
  }
  return _ewClickBefore(e);
};
// capture phase so the generic Esc (clear selection) never fires while the
// picker owns the key - same pattern as the structure tool
addEventListener("keydown", (e) => {
  if (typing() || state.tool !== "ew-pick") return;
  if (e.key === "Escape") {
    e.preventDefault(); e.stopImmediatePropagation();
    ewDisarmPick("add contour cancelled");
  }
}, true);

function renderEwLayers() {
  if (!state.ew) return;
  for (const [side, boxId] of [["existing", "ewExLayers"], ["proposed", "ewPrLayers"]]) {
    const box = $(boxId);
    box.innerHTML = "";
    state.ew.layers[side].forEach((lay, i) => {
      const row = document.createElement("div");
      row.className = "ew-layer-row";
      const name = document.createElement("input");
      name.type = "text"; name.value = lay.name; name.placeholder = "layer name";
      name.name = `ew-layer-${side}-${i}-name`;
      name.oninput = () => { lay.name = name.value; };
      const th = document.createElement("input");
      th.type = "number"; th.step = "0.5"; th.min = "0"; th.value = lay.thickness_in;
      th.name = `ew-layer-${side}-${i}-in`;
      th.oninput = () => { lay.thickness_in = parseFloat(th.value); };
      const unit = document.createElement("span");
      unit.className = "unit"; unit.textContent = "in";
      const x = document.createElement("button");
      x.className = "mini x"; x.textContent = "×"; x.title = "remove layer";
      x.onclick = () => { state.ew.layers[side].splice(i, 1); renderEwLayers(); };
      row.append(name, th, unit, x);
      box.appendChild(row);
      // material balance: only a REMOVAL has anywhere to go. A proposed
      // layer is purchased material sitting above subgrade, not site dirt,
      // so it gets no disposition and never enters the reuse pool.
      if (side === "existing") box.appendChild(ewDispRow(lay, i));
    });
  }
}

// ---------- material balance: where each removal goes ----------
// Defaults to 100% export. Beaumont Estimate #853 shows the stripped topsoil
// is NOT structural reuse: their Import Structural reads 11,581 CY, and had
// the 5,730 CY strip counted as reuse it would read 5,842. The respread /
// export split is the estimator's judgement (soils report, landscape area),
// so nothing is seeded - #853's exact 50/50 is a fact about that job, not a
// rule.
const EW_DISP_DEFAULT = { reuse_pct: null, respread_pct: null, destination: "on site" };

function ewDispRow(lay, i) {
  const d = document.createElement("div");
  d.className = "ew-layer-disp";
  const pctIn = (key) => {
    const el = document.createElement("input");
    el.type = "number"; el.min = "0"; el.max = "100"; el.step = "5";
    el.placeholder = "0";
    el.name = `ew-disp-${i}-${key}`;
    el.value = isFinite(lay[key]) ? lay[key] : "";
    el.oninput = () => {
      const v = parseFloat(el.value);
      lay[key] = isFinite(v) ? Math.min(Math.max(v, 0), 100) : null;
      paint();
    };
    return el;
  };
  const reuse = pctIn("reuse_pct"), resp = pctIn("respread_pct");
  const exp = document.createElement("span");
  exp.className = "exp";
  const dest = document.createElement("input");
  dest.type = "text"; dest.placeholder = "on site";
  dest.name = `ew-disp-${i}-dest`;
  dest.value = lay.destination === undefined ? "on site" : lay.destination;
  // Bid-sheet exclusion 6: "Topsoil and fill material required fro the job
  // will be stockpiled onsite" - their export often never leaves the
  // property, and exclusion 23 says import/export carries its own fee.
  dest.title = 'Where it goes. Both #853 export lines say "On site".';
  dest.oninput = () => { lay.destination = dest.value; };
  function paint() {
    const r = isFinite(lay.reuse_pct) ? lay.reuse_pct : 0;
    const s = isFinite(lay.respread_pct) ? lay.respread_pct : 0;
    exp.textContent = `${Math.max(100 - r - s, 0)}% export`;
    exp.style.color = (r + s > 100) ? "var(--bad, #c0483c)" : "";
  }
  paint();
  const span = (cls, txt) => {
    const e = document.createElement("span");
    e.className = cls; e.textContent = txt;
    return e;
  };
  d.append(span("", "reuse"), reuse, span("", "%"),
           span("", "respread"), resp, span("", "%"),
           span("sep", "\u2192"), exp, span("sep", "\u00b7"), dest);
  return d;
}

$("ewStrip").onclick = () => {
  if (!state.ew) return;
  // Topsoil comes off first on every job. Default thickness is the LOCAL
  // prior: Beaumont Estimate #853's own arithmetic is 8.29 in (5,730 CY
  // strip x 27 / 224,058 SF clear-and-grub), inside the national 4-8 in
  // band (NRCS IL Urban Manual spec 752; MS DEQ) - see
  // webui/ew_defaults.js and docs/earthwork-defaults-research.json.
  // Editable like any other row; the soils report outranks every default.
  if (!state.ew.layers.existing.some(l => /topsoil/i.test(l.name)))
    state.ew.layers.existing.unshift({ name: "Topsoil",
      thickness_in: (typeof EW_RESEARCH !== "undefined"
                     ? EW_RESEARCH.strip_depth_in.value : 8),
      ...EW_DISP_DEFAULT });
  renderEwLayers();
};
$("ewAddEx").onclick = () => {
  if (!state.ew) return;
  state.ew.layers.existing.push({ name: "", thickness_in: 4, ...EW_DISP_DEFAULT });
  renderEwLayers();
  const rows = $("ewExLayers").querySelectorAll("input[type=text]");
  if (rows.length) rows[rows.length - 1].focus();
};
$("ewAddPr").onclick = () => {
  if (!state.ew) return;
  state.ew.layers.proposed.push({ name: "", thickness_in: 8 });
  renderEwLayers();
  const rows = $("ewPrLayers").querySelectorAll("input[type=text]");
  if (rows.length) rows[rows.length - 1].focus();
};

// the request body the volumes AND the map endpoints both take
function ewBody() {
  const lay = side => state.ew.layers[side]
    .filter(l => isFinite(l.thickness_in) && l.thickness_in > 0)
    .map(l => {
      const o = { name: (l.name || "").trim() || "layer", thickness_in: l.thickness_in };
      // the balance rides on removals only; blank means 0, i.e. 100% export
      if (side === "existing") {
        o.reuse_pct = isFinite(l.reuse_pct) ? l.reuse_pct : 0;
        o.respread_pct = isFinite(l.respread_pct) ? l.respread_pct : 0;
        o.destination = l.destination === undefined ? "on site" : l.destination;
      }
      return o;
    });
  return {
    existing: state.ew.rows.filter(r => r.surface === "existing" && isFinite(r.z))
      .map(r => ({ chain_id: r.chain_id, z: r.z })),
    proposed: state.ew.rows.filter(r => r.surface === "proposed" && isFinite(r.z))
      .map(r => ({ chain_id: r.chain_id, z: r.z })),
    cell_ft: 2.0,
    // The limit of work, if the operator set one. Omitted when they have not,
    // so the server takes the original path and every existing number stands.
    boundary: state.ewBound ? state.ewBound.pts : null,
    existing_layers: lay("existing"),
    proposed_layers: lay("proposed"),
    // #853 reuses site cut against site fill 1:1 (import 11,581 against
    // fill - cut 11,572, a 0.08% residual), so this is on by default - the
    // only defaulted assumption in the balance.
    cut_reuse_pct: ($("ewCutReuse") && $("ewCutReuse").checked) ? 100 : 0,
    export_factor: ewFactor("ewFacExp"),
    import_factor: ewFactor("ewFacImp"),
    ...(function () {
      const pts = ewActiveSpots().map(g => ({ x: g.x, y: g.y, z: g.z }));
      const key = state.ew.spotSide === "existing" ? "existing_points" : "proposed_points";
      const o = pts.length ? { [key]: pts } : {};
      if (isFinite(state.ew.areaSf) && state.ew.areaSf > 0) o.strip_area_sf = state.ew.areaSf;
      return o;
    })(),
  };
}

// A factor left blank, zeroed or nonsense means NO factor. Volumes are
// in-place yards between the two surfaces, and #853 applies no swell,
// shrink or compaction factor anywhere, so 1.0 is the evidenced default;
// these fields exist only for a job that needs one.
// Material presets fill the two factor boxes from the researched table in
// webui/ew_defaults.js - export rides bank->loose (dug yards swell into the
// truck), import rides 1/bank->compacted (buying enough bank yards that the
// compacted fill measures out). Defaults stay 1.0 until the operator picks
// one - #853 applies no factor anywhere and that evidence stands - and the
// boxes remain editable after; picking a preset is a suggestion accepted,
// not a lock. The title carries the citation so the operator can see WHERE
// the number came from before pricing on it.
(function ewWireMatPresets() {
  const sel = $("ewMatPreset");
  if (!sel || typeof EW_RESEARCH === "undefined") return;
  for (const name of Object.keys(EW_RESEARCH.materials)) {
    const o = document.createElement("option");
    o.value = name; o.textContent = name;
    sel.append(o);
  }
  sel.onchange = () => {
    const m = EW_RESEARCH.materials[sel.value];
    if (!m) { sel.title = ""; return; }
    $("ewFacExp").value = m.b2l.toFixed(2);
    $("ewFacImp").value = (1 / m.b2c).toFixed(2);
    sel.title = m.src;
    $("ewFacExp").dispatchEvent(new Event("input", { bubbles: true }));
    $("ewFacImp").dispatchEvent(new Event("input", { bubbles: true }));
  };
})();

function ewFactor(id) {
  const el = $(id);
  const v = el ? parseFloat(el.value) : NaN;
  return (isFinite(v) && v > 0) ? v : 1;
}

// spot grades the estimator switched on, with the datum applied when the
// sheet gave us no contour label to anchor them against
function ewActiveSpots() {
  if (!state.ew || !state.ew.spots) return [];
  // Number.isFinite, NEVER bare isFinite: isFinite(null) is TRUE in JS
  // (null coerces to 0), so the fresh-open default spotDatum: null acted
  // as a TYPED DATUM OF ZERO and every truncated spot served raw 29-49 ft
  // values - resolved 7,7xx elevations destroyed until the operator
  // touched the box. The "0.0 is not None" trap (CLAUDE.md section 5),
  // JavaScript edition. Caught live 2026-08-30 during the joint UI pass.
  const base = Number.isFinite(state.ew.spotDatum) ? state.ew.spotDatum : NaN;
  return state.ew.spots
    .filter(g => state.ew.spotOn[g.tag])
    .map(g => {
      // A typed datum outranks the engine's resolution for every TRUNCATED
      // value - resolved ones included. The old order (resolved wins, datum
      // only fills the unresolved) made the override useless on the sheet
      // that needs it most: a bogus legend note resolves everything, so a
      // correct typed 7700 changed nothing. Authority is human > sheet note
      // > consensus band. Values printed in full (>= 1000) keep their
      // printed elevation - the datum is the hundreds the sheet OMITTED,
      // and nothing was omitted from those.
      if (Number.isFinite(base) && g.value < 100.0)
        return { ...g, z: base + g.value };
      if (g.resolved && isFinite(g.z)) return g;
      if (!Number.isFinite(base)) return null;
      return { ...g, z: base + g.value };   // datum = the hundreds the sheet omitted
    })
    .filter(g => g && isFinite(g.z));
}

function renderEwSpots() {
  const box = $("ewSpots");
  const sp = state.ew && state.ew.spots;
  if (!sp || !sp.length) { if (box) box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = "";
  const counts = {};
  for (const g of sp) counts[g.tag] = (counts[g.tag] || 0) + 1;
  const head = document.createElement("div");
  head.className = "sp-head";
  head.innerHTML = `<span>Spot grades on this sheet</span><b>${sp.length}</b>`;
  const seg = document.createElement("div");
  seg.className = "seg";
  for (const [key, lab] of [["existing", "EXIST"], ["proposed", "PROP"]]) {
    const b = document.createElement("button");
    b.textContent = lab;
    if (state.ew.spotSide === key) b.className = key === "existing" ? "on-ex" : "on-pr";
    b.onclick = () => { state.ew.spotSide = key; renderEwSpots(); };
    seg.appendChild(b);
  }
  head.appendChild(seg);
  box.appendChild(head);
  const tags = document.createElement("div");
  tags.className = "sp-tags";
  for (const t of Object.keys(counts).sort()) {
    const l = document.createElement("label");
    l.className = "sp-tag" + (state.ew.spotOn[t] ? " on" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!state.ew.spotOn[t];
    cb.onchange = () => { state.ew.spotOn[t] = cb.checked; renderEwSpots(); draw(); };
    l.append(cb, document.createTextNode(` ${t} ${counts[t]}`));
    tags.appendChild(l);
  }
  box.appendChild(tags);
  // The override box shows when nothing resolved (nothing to anchor to) OR
  // when the sheet's two datum sources DISAGREE. The old gate was
  // resolved-only, which is precisely how Barn C3.3 shipped 171 grades
  // 100 ft low with the override hidden: a bogus legend note resolved
  // everything, so the one control that could fix it never rendered.
  // Wrong-and-visible is survivable; wrong-and-green-with-no-override is
  // what loses a client.
  const dat = state.ew.datum;
  if (dat && dat.conflict) {
    const d = document.createElement("div");
    d.className = "sp-datum sp-conflict";
    const chose = dat.chosen === "band" ? dat.band_base : dat.declared;
    const msg = document.createElement("div");
    msg.innerHTML = `<b>This sheet disagrees with itself about the datum.</b> `
      + `Its legend note reads <b>${dat.declared}</b>; its own printed `
      + `elevations (${dat.band_n} of them) sit in the <b>${dat.band_base}</b> `
      + `band. Using <b>${chose}</b> — ${dat.chosen === "band"
          ? `${dat.band_n} full elevations printed on the drawing outrank one `
            + `boilerplate legend sentence`
          : `a ${dat.band_n}-label band is the shape the legend's own sample `
            + `text produces, so the note stands`}. `
      + `If the sheet means the other one, type it:`;
    d.appendChild(msg);
    const i = document.createElement("input");
    i.type = "number"; i.step = "100"; i.placeholder = String(chose);
    i.value = Number.isFinite(state.ew.spotDatum) ? state.ew.spotDatum : "";
    i.oninput = () => { state.ew.spotDatum = parseFloat(i.value); renderEwSpots(); };
    d.appendChild(i);
    box.appendChild(d);
  } else if (!sp.some(g => g.resolved)) {
    const d = document.createElement("div");
    d.className = "sp-datum";
    d.append(document.createTextNode("No contour label on this sheet to anchor them. Datum:"));
    const i = document.createElement("input");
    i.type = "number"; i.step = "100"; i.placeholder = "7700";
    i.value = Number.isFinite(state.ew.spotDatum) ? state.ew.spotDatum : "";
    i.oninput = () => { state.ew.spotDatum = parseFloat(i.value); renderEwSpots(); };
    d.appendChild(i);
    box.appendChild(d);
  }
  const n = ewActiveSpots().length;
  const note = document.createElement("div");
  note.className = "sp-note";
  note.textContent = n
    ? `${n} of ${sp.length} will be used as ${state.ew.spotSide} surface points. RIM / TW / BW / TS / BS are structure tops, not ground — leave them off unless you mean them.`
    : `None selected. FG is finished ground; the rest are structure tops.`;
  box.appendChild(note);
}

function renderEwArea() {
  const note = $("ewAreaNote"), inp = $("ewAreaIn");
  if (!note || !inp || !state.ew) return;
  inp.value = isFinite(state.ew.areaSf) ? state.ew.areaSf : "";
  inp.oninput = () => {
    const v = parseFloat(inp.value);
    state.ew.areaSf = isFinite(v) && v > 0 ? v : null;
    renderEwArea();
  };
  const auto = state.ew.result ? state.ew.result.area_sf : null;
  note.textContent = isFinite(state.ew.areaSf)
    ? "Layer volumes use the area you typed."
    : "Blank = where the two surfaces overlap"
      + (auto ? ` (last run: ${Number(auto).toLocaleString()} SF)` : "")
      + ". Topsoil is stripped over the whole disturbed area, which is usually larger — type that here.";
}

// Bid-sheet names (Beaumont's 22-item sheet) for the itemized takeoff
function ewItemLabel(layer) {
  if (layer.side === "existing")
    return /topsoil/i.test(layer.name) ? "Strip Topsoil" : `Remove ${layer.name}`;
  return `Place ${layer.name}`;
}
// every earthwork row is replaced on each Calculate, so this has to match
// the material-balance rows too. "Rough Place " does NOT start with
// "Place ", so it needs its own alternative.
const EW_ITEM_RE = /^(Site Cut|Site Fill|Strip Topsoil|Remove |Rough Place |Place |Export |Import Structural$|(Cut|Fill) \(earthwork\))/;

function renderEw() {
  const box = $("ewRows");
  box.innerHTML = "";
  if (!state.ew || !state.ew.rows.length) {
    box.innerHTML = '<div class="ew-hint">No elevations printed on this sheet — ' +
      'click <b>+ Add contour</b>, click the line, type its elevation.</div>';
    return;
  }
  // blank (not-yet-typed) elevations sink to the bottom; NaN must never
  // reach the comparator (NaN-returning comparators scramble the sort)
  const zk = v => Number.isFinite(v) ? v : 1e9;
  state.ew.rows.sort((a, b) => zk(a.z) - zk(b.z));
  for (const row of state.ew.rows) {
    const div = document.createElement("div");
    div.className = "ew-row has-x";
    div.title = "click to select this contour on the sheet";
    div.onclick = (ev) => {
      if (ev.target.tagName === "INPUT" || ev.target.tagName === "BUTTON") return;
      state.selected = row.chain_id; state.selPt = null;
      updateSelBar(chainById(row.chain_id));
      draw();
    };
    const z = document.createElement("input");
    z.className = "z"; z.type = "number"; z.step = "0.1";
    z.value = Number.isFinite(row.z) ? row.z : "";
    z.placeholder = "elev";
    z.name = "ew-z-" + row.chain_id;
    z.oninput = () => { row.z = parseFloat(z.value); };
    // Enter commits (blur), never submits anything; Esc leaves the field
    // without reaching the global Esc (which clears the canvas selection)
    z.onkeydown = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); z.blur(); }
      else if (ev.key === "Escape") { ev.stopPropagation(); z.blur(); }
    };
    // no re-render on change/blur: rebuilding the rows mid-click would
    // swallow the first click on EXIST/PROP; the next renderEw (surface
    // click, add, remove) re-sorts anyway
    const meta = document.createElement("div");
    meta.className = "ew-meta";
    meta.textContent = row.manual
      ? `chain ${row.chain_id} · w ${row.width} · manual`
      : `chain ${row.chain_id} · w ${row.width} · label ${row.dist}pt away`;
    const seg = document.createElement("div");
    seg.className = "seg";
    for (const [key, lab] of [["existing", "EXIST"], ["proposed", "PROP"], [null, "skip"]]) {
      const b = document.createElement("button");
      b.textContent = lab;
      if (row.surface === key) b.className = key === "existing" ? "on-ex" : key === "proposed" ? "on-pr" : "";
      if (row.surface === key && key === null) b.style.opacity = "1";
      b.onclick = () => { row.surface = key; renderEw(); calcStateDirty(); };
      seg.appendChild(b);
    }
    const x = document.createElement("button");
    x.className = "mini x"; x.textContent = "×";
    x.title = "remove this contour from the calculation";
    x.onclick = () => {
      state.ew.rows = state.ew.rows.filter(r => r !== row);
      // remember the deletion: restore merges saved rows into a FRESH
      // suggest, and without this list the suggest re-seeds deleted rows
      (state.ew.removed = state.ew.removed || []).push(row.chain_id);
      if (state.hotChain === row.chain_id) state.hotChain = null;
      renderEw();
      draw();
      calcStateDirty();
    };
    div.append(z, meta, seg, x);
    div.onmouseenter = () => { state.hotChain = row.chain_id; draw(); };
    div.onmouseleave = () => { state.hotChain = null; draw(); };
    box.appendChild(div);
  }
}

$("ewCalc").onclick = async () => {
  if (!state.ew) return;
  const body = ewBody();
  $("ewResult").textContent = "calculating…";
  const r = await fetch(`/api/job/${state.job}/page/${state.page}/earthwork`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    $("ewResult").textContent = e.detail || ("failed (" + r.status + ")");
    return;
  }
  const j = await r.json();
  state.ew.result = j;
  const off = [];
  if (j.existing_offset_ft) off.push(`existing −${j.existing_offset_ft.toFixed(2)} ft`);
  if (j.proposed_offset_ft) off.push(`proposed −${j.proposed_offset_ft.toFixed(2)} ft`);
  // the engine reports -0.0 when nothing is cut (negated empty sum); show 0
  const cutQ = j.cut_yd3 > 0 ? j.cut_yd3 : 0, fillQ = j.fill_yd3 > 0 ? j.fill_yd3 : 0;
  renderEwStale();
  renderEwBound();
  // Layers-only (audit item 10): a clearing sheet has no cut/fill TIN, but
  // stripping is area x depth. The failure is stated, never zeroed - a
  // printed "cut 0 CY" on a sheet nobody graded is a confident wrong number.
  $("ewResult").innerHTML = j.layers_only
    ? `<b>no cut/fill:</b> ${j.cut_fill_error} ` +
      `<br><span class="ew-meta">layer volumes below still compute ` +
      `(${Number(j.layer_area_sf).toLocaleString()} SF from the ${j.area_source})</span>`
    : `<b>cut ${ewCY(cutQ)} CY</b> · <b>fill ${ewCY(fillQ)} CY</b>` +
      ` · net ${ewCY(j.net_yd3)} CY over ${Number(j.area_sf).toLocaleString()} SF` +
      (j.max_cut_ft || j.max_fill_ft
        ? `<br><span class="ew-meta">deepest cut ${j.max_cut_ft} ft · ` +
          `deepest fill ${j.max_fill_ft} ft — eyeball these against the ` +
          `contours; a peak that surprises you is a row to check</span>` : "") +
      (off.length ? `<br><span class="ew-meta">surfaces lowered: ${off.join(", ")}</span>` : "");
  // per-layer slabs: area x thickness, shown under the stacks
  const out = $("ewLayerOut");
  out.innerHTML = "";
  for (const lay of (j.layers || [])) {
    const d = document.createElement("div");
    d.innerHTML = `<span>${ewItemLabel(lay)} <span class="sub">· ${lay.thickness_in}" over ` +
      `${Number(j.layer_area_sf || j.area_sf).toLocaleString()} SF</span></span><b>${ewCY(lay.volume_yd3)} CY</b>`;
    out.appendChild(d);
  }
  renderEwBasis(j, body);
  // Calculating is LOOKING. The rows only reach the itemised takeoff once
  // the estimator presses "Add to takeoff" - see ewAdd below. If they
  // already did, refresh in place: consent was given for THIS calculation,
  // and leaving a superseded number priced would be its own silent lie.
  if (state.ew.added) ewApplyItems(j);
  renderEwTake();
  renderEwBalance(j);
  renderItemized();
  if ($("ewMap").checked) await ewFetchMap();
};

// Whole cubic yards, everywhere a volume is shown or priced. The surface is
// interpolated between contours 1-5 ft apart; 0.1 CY on it is a lie of
// precision, and it was being printed straight onto a bid.
function ewCY(v) {
  return Math.round(Number(v) || 0).toLocaleString();
}
const ewR = v => Math.round(Number(v) || 0);
// The server writes the balance's "why" sentence already formatted to 0.1
// ("fill 40,349.6 CY - reused 13,677.4 CY"). Round the CY figures inside it
// so the sentence cannot contradict the whole-CY number sitting beside it.
// Anchored on the CY unit: percentages and x-factors in the same string
// keep their decimals.
function ewRoundCYText(s) {
  return String(s == null ? "" : s).replace(
    /(\d[\d,]*)\.(\d+)(?=\s*CY\b)/g,
    (m) => ewCY(parseFloat(m.replace(/,/g, ""))));
}

// Every earthwork row is replaced on each apply so edits never double-count.
function ewClearItems() {
  state.extraItems = state.extraItems.filter(it => !EW_ITEM_RE.test(it.label));
}

// The push. Named as on Beaumont's bid sheet, rounded to whole CY.
// Cut and fill are computed at whatever scale was in force when Calculate was
// pressed, and the reviewer can change that scale afterwards. The volumes do
// NOT follow it - the surfaces are re-integrated server-side, so unlike the
// areas panel this cannot be rescaled by arithmetic on the client. Say so, and
// offer the one-click redo, rather than leaving cubic yards on screen that
// belong to a scale nobody is using any more.
function ewScaleStale() {
  const j = state.ew && state.ew.result;
  const was = j && j.ft_per_paper_inch;
  const now = arFpi();
  if (!was || now === null) return null;
  return Math.abs(now - was) > 1e-6 ? { was: +was, now } : null;
}
function renderEwStale() {
  const box = $("ewStale");
  if (!box) return;
  const st = ewScaleStale();
  box.hidden = !st;
  if (!st) return;
  box.innerHTML = "";
  const msg = document.createElement("span");
  msg.innerHTML = `<b>These cubic yards are not the scale in force.</b> They `
    + `were computed at 1 inch = ${st.was.toFixed(2)} ft; the sheet is now set `
    + `to <b>1 inch = ${st.now.toFixed(2)} ft</b>. Volume moves with the square `
    + `of the scale, so expect about `
    + `${Math.pow(st.now / st.was, 2).toFixed(1)}\u00d7. Recalculate before pricing.`;
  const b = document.createElement("button");
  b.className = "mini";
  b.textContent = "recalculate at " + st.now.toFixed(2) + " ft/in";
  b.onclick = () => $("ewCalc").click();
  box.append(msg, b);
}

function ewApplyItems(j) {
  ewClearItems();
  if (!j) return;
  if (j.cut_yd3 > 0) state.extraItems.push({ label: "Site Cut", qty: ewR(j.cut_yd3), unit: "CY" });
  if (j.fill_yd3 > 0) state.extraItems.push({ label: "Site Fill", qty: ewR(j.fill_yd3), unit: "CY" });
  for (const lay of (j.layers || []))
    if (lay.volume_yd3 > 0)
      state.extraItems.push({ label: ewItemLabel(lay), qty: ewR(lay.volume_yd3), unit: "CY" });
  // where the dirt goes. These price like any other row, but tradeFor()
  // would file "Import Structural" under General (it matches no keyword)
  // and "Export Asphalt" under Paving, so seed the trade the way
  // stApplyItems does - session default only, the reviewer's pick wins.
  for (const r of ((j.balance && j.balance.rows) || [])) {
    if (!(r.qty > 0)) continue;
    state.extraItems.push({ label: r.label,
                            qty: r.unit === "CY" ? ewR(r.qty) : r.qty,
                            unit: r.unit });
    if (!store.getItem(tradeKey(r.label)))
      store.setSession(tradeKey(r.label), "Earthwork & Grading");
  }
}

$("ewAdd").onclick = () => {
  if (!state.ew || !state.ew.result) return;
  state.ew.added = !state.ew.added;
  if (state.ew.added) ewApplyItems(state.ew.result);
  else ewClearItems();
  renderEwTake();
  renderItemized();
  setStatus(state.ew.added
    ? "earthwork added to the takeoff — it will price and print with the caveat"
    : "earthwork removed from the takeoff");
};

function renderEwTake() {
  const box = $("ewTake"), btn = $("ewAdd"), note = $("ewTakeNote");
  if (!box || !btn || !note) return;
  const j = state.ew && state.ew.result;
  box.classList.toggle("off", !j);
  if (!j) return;
  btn.textContent = state.ew.added ? "Remove from takeoff" : "Add to takeoff";
  btn.classList.toggle("on", !!state.ew.added);
  note.textContent = state.ew.added
    ? "In the itemized takeoff. It will price, export and print on the report, "
      + "with the basis above repeated on the report's own face."
    : "Not in the takeoff. Approving now exports no earthwork line at all — "
      + "press this only if you mean to bid these quantities.";
}

// What the number rests on, printed beside the number. Every field here is
// one the response or the request already carried: nothing is inferred.
function renderEwBasis(j, body) {
  const box = $("ewBasis");
  if (!box) return;
  // a layers-only answer has no interpolation to describe
  const show = j && !j.layers_only;
  box.classList.toggle("off", !show);
  if (!show) return;
  const ex = j.existing_contours, pr = j.proposed_contours;
  const nPts = ((body && body.existing_points) || []).length
             + ((body && body.proposed_points) || []).length;
  const side = (body && body.existing_points) ? "existing" : "proposed";
  box.innerHTML = "";
  const line = (html) => {
    const d = document.createElement("div");
    d.innerHTML = html;
    box.appendChild(d);
    return d;
  };
  line(`Interpolated from <b>${ex}</b> existing and <b>${pr}</b> proposed `
     + `contour${pr === 1 ? "" : "s"}`
     + (nPts ? `, plus <b>${nPts}</b> spot grade${nPts === 1 ? "" : "s"} on the ${side} surface` : "")
     + `, sampled on a <b>${j.cell_ft}</b> ft grid over <b>${Number(j.area_sf).toLocaleString()}</b> SF.`);
  const u = line("That region is <b>not the graded area</b>: it is where the "
    + "two convex hulls overlap — a straight-sided envelope round each set of "
    + "contours — so it cuts across every notch in the real limit of "
    + "disturbance. No input on this panel can bound it.");
  u.className = "unbounded";
}

// The lines the approve payload carries onto the printed report, so a reader
// of the PDF who never saw this panel learns the same three things. Empty
// unless the estimator actually added earthwork - no earthwork row, no note.
function ewApproveNotes() {
  const j = state.ew && state.ew.added && state.ew.result;
  if (!j) return [];
  return [
    "EARTHWORK (Site Cut / Site Fill / Import Structural / strip and place "
    + "rows) is a contour interpolation, not a measured volume.",
    `Interpolated from ${j.existing_contours} existing and `
    + `${j.proposed_contours} proposed contours over `
    + `${Number(j.area_sf).toLocaleString()} SF. That region is NOT the graded `
    + "area: it is where the two convex hulls of the assigned contours "
    + "overlap, and no input on the panel can bound it.",
    // keep each line under the 400-char cap `approve` applies, or the tail
    // of the disclosure is what gets cut
    "No typical cross-section, no subgrade depth, no shrink/swell factor. "
    + "Checked once against a client estimate (Beaumont Barn Civil C3.0 vs "
    + "Estimate #853) it read 2.3-2.5x high, over 1.42x that estimator's own "
    + "clear-and-grub area.",
  ];
}

// The balance panel. Every row states WHICH AREA produced it on the row
// itself, not in a tooltip: removal layers are stripped over the disturbed
// area, cut and fill exist only where the two surfaces overlap, and an
// estimator reading a strip volume beside a cut volume has to see that.
function renderEwBalance(j) {
  const box = $("ewBalOut"), note = $("ewBalNote");
  if (!box) return;
  box.innerHTML = "";
  const b = j && j.balance;
  if (!b) { if (note) note.textContent = ""; return; }
  // whole CY here too: every figure in this block is a cubic-yard volume
  // derived from the same interpolated surface (see ewCY)
  const n = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const nCY = v => ewCY(v);
  for (const r of (b.rows || [])) {
    const d = document.createElement("div");
    d.className = "bal-row k-" + r.kind;
    const lab = document.createElement("div");
    lab.className = "lab";
    lab.textContent = r.label;
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = ewRoundCYText(r.basis)
      + (r.area_sf ? ` \u00b7 over ${n(r.area_sf)} SF (${r.area_source})` : "")
      + (r.destination ? ` \u00b7 ${r.destination}` : "");
    lab.appendChild(why);
    const q = document.createElement("b");
    q.textContent = `${r.unit === "CY" ? nCY(r.qty) : n(r.qty)} ${r.unit}`;
    d.append(lab, q);
    box.appendChild(d);
  }
  const sum = document.createElement("div");
  sum.className = "bal-sum";
  const line = (...parts) => {
    const el = document.createElement("div");
    for (const p of parts) {
      if (typeof p === "string") el.append(document.createTextNode(p));
      else { const bb = document.createElement("b"); bb.textContent = nCY(p); el.append(bb); }
    }
    sum.appendChild(el);
  };
  line("site cut ", b.cut_yd3, " = reused ", b.cut_reused_yd3,
       " + exported ", b.cut_export_yd3);
  line("reuse pool ", b.reuse_pool_yd3, " = reused ", b.reuse_yd3,
       " + surplus ", b.surplus_yd3);
  line("fill needed ", b.fill_demand_yd3, " = reused ", b.reuse_yd3,
       " + imported ", b.import_yd3);
  line("total export ", b.export_total_yd3, " \u00b7 respread ",
       b.respread_total_yd3, " (CY)");
  box.appendChild(sum);
  if (note)
    note.textContent = b.basis
      + ". Beaumont Estimate #853 applies none: its Import Structural "
      + "(11,581) equals Site Fill \u2212 Site Cut (11,572) to 0.08%. "
      + '"Export" is their word, not "haul off" \u2014 both #853 export '
      + 'lines say "On site".';
}

// cut/fill map: the server paints the dz grid (cut blue, fill yellow,
// depth -> opacity) and tells us the page-pt box it covers; draw() lays
// it under the chains. Refetched on every Calculate while the toggle is on.
async function ewFetchMap() {
  if (!state.ew) return;
  const r = await fetch(`/api/job/${state.job}/page/${state.page}/earthwork/map`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ewBody()),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    $("ewResult").textContent = e.detail || ("map failed (" + r.status + ")");
    state.ew.map = null; draw();
    return;
  }
  const bbox = (r.headers.get("X-Map-Bbox") || "").split(",").map(Number);
  const refDz = r.headers.get("X-Map-Ref-Dz");
  const blob = await r.blob();
  const img = await createImageBitmap(blob);
  if (!state.ew) return;
  state.ew.map = { img, bbox, refDz: refDz ? parseFloat(refDz) : null };
  // the legend makes the ramp readable: full color = the ref depth
  const leg = $("ewMapLegend");
  if (leg) {
    const r = refDz ? parseFloat(refDz) : null;
    leg.hidden = false;
    leg.querySelector(".eml-txt").textContent = r
      ? `cut −${r.toFixed(1)} ft … +${r.toFixed(1)} ft fill (full color)`
      : "cut blue · fill orange";
  }
  draw();
}
$("ewMap").onchange = async () => {
  if (!state.ew) { $("ewMap").checked = false; return; }
  if ($("ewMap").checked) await ewFetchMap();
  else { state.ew.map = null; $("ewMapLegend").hidden = true; draw(); }
};

// ---------- pipe trench calculator ----------
// Bedding rules from the underground-utilities spec discussed with the
// client: clearance around the pipe grows with burial depth. Editable
// because every jurisdiction's spec differs.
const TR_DEFAULT_RULES = [
  { to_ft: 2, clr_in: 6 },
  { to_ft: 4, clr_in: 12 },
  { to_ft: 99, clr_in: 18 },
];

$("trClose").onclick = () => { $("trPanel").hidden = true; state.hotChain = null; draw(); };
$("trBtn").onclick = () => {
  const panel = $("trPanel");
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.scrollIntoView({ block: "start", behavior: "smooth" });
  if (!state.tr) {
    state.tr = {
      style_id: null, od_in: 6, d0_ft: 2, d1_ft: 8,
      rules: TR_DEFAULT_RULES.map(r => ({ ...r })),
    };
    if (state.calcSavedLoaded) trApplySaved();
    else if (state.calcSaveBroken)
      calcNotePut("trHint", "This page's saved calculator inputs could not be read when it loaded, and edits here are NOT being saved. Reload to retry.");
  }
  renderTr();
  renderCheckQueue();   // trApplySaved may have settled a stale-input entry
};

function renderTr() {
  const box = $("trBody");
  box.innerHTML = "";
  if (!state.result) { box.textContent = "run Detect first"; return; }
  const t = state.tr;
  const grid = document.createElement("div");
  grid.className = "tr-grid";

  const mkLabel = (txt) => { const d = document.createElement("div"); d.textContent = txt; return d; };
  const sel = document.createElement("select");
  sel.name = "tr-style";
  const opt0 = document.createElement("option");
  opt0.value = ""; opt0.textContent = "— pick the pipe run —";
  sel.appendChild(opt0);
  for (const st of state.result.styles) {
    if (!state.include.get(st.style_id)) continue;
    const o = document.createElement("option");
    o.value = st.style_id;
    o.textContent = `${(state.labels.get(st.style_id) || st.suggested_label).slice(0, 30)} · ${st.n} lines`;
    if (t.style_id === st.style_id) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => { t.style_id = sel.value === "" ? null : +sel.value; };
  grid.append(mkLabel("Pipe run (line style)"), sel);

  const num = (key, step) => {
    const i = document.createElement("input");
    i.type = "number"; i.step = step; i.value = t[key]; i.name = "tr-" + key;
    i.oninput = () => { t[key] = parseFloat(i.value); };
    return i;
  };
  grid.append(mkLabel("Pipe OD (inches)"), num("od_in", "0.5"));
  grid.append(mkLabel("Invert depth at start (ft)"), num("d0_ft", "0.5"));
  grid.append(mkLabel("Invert depth at end (ft)"), num("d1_ft", "0.5"));
  box.appendChild(grid);

  const rl = document.createElement("div");
  rl.className = "tr-rules";
  rl.textContent = "Bedding rules (per spec):";
  box.appendChild(rl);
  t.rules.forEach((r, k) => {
    const row = document.createElement("div");
    row.className = "tr-rule";
    const a = document.createElement("input");
    a.type = "number"; a.step = "0.5"; a.value = r.to_ft; a.name = `tr-to-${k}`;
    a.oninput = () => { r.to_ft = parseFloat(a.value); };
    const b = document.createElement("input");
    b.type = "number"; b.step = "1"; b.value = r.clr_in; b.name = `tr-clr-${k}`;
    b.oninput = () => { r.clr_in = parseFloat(b.value); };
    const l1 = document.createElement("div"); l1.textContent = "to depth (ft)";
    const l2 = document.createElement("div"); l2.textContent = "clearance (in)";
    row.append(l1, a, l2, b);
    box.appendChild(row);
  });
}

// ---------- trench math (pure) -------------------------------------------
// No DOM and no state.* in this block: tests/test_trench_math.js slices the
// file between the TRENCH-MATH markers and evals it standalone, so keep it
// self-contained.
// TRENCH-MATH-BEGIN

// Rules normalised for arithmetic: junk rows dropped, sorted ascending by
// depth edge, clearances in feet. Sorted on purpose - trClrAt takes the
// FIRST band the depth fits, and the panel lets the operator reorder rows,
// so an out-of-order table must not hand a 1-ft-deep pipe the 99-ft band.
// An empty table falls back to 6 in everywhere, as before.
function trNormRules(rules) {
  const rs = (rules || [])
    .filter(r => r && isFinite(r.to_ft) && r.to_ft > 0
                   && isFinite(r.clr_in) && r.clr_in >= 0)
    .map(r => ({ to: +r.to_ft, clr: r.clr_in / 12.0 }))
    .sort((a, b) => a.to - b.to);
  return rs.length ? rs : [{ to: Infinity, clr: 0.5 }];
}

// Clearance (ft) for a pipe whose invert sits at depth d. Depths past the
// last edge keep the last band's clearance - unchanged semantics.
function trClrAt(rs, d) {
  for (const r of rs) if (d <= r.to) return r.clr;
  return rs[rs.length - 1].clr;
}

// Hole cross-section (sf) at invert depth d: FULL BOTTOM WIDTH for the
// whole column, A(d) = (OD + 2 x clearance(d)) x d. The builder agent
// proposed integrating band by band down the wall instead (each depth
// band at its own rule width), which makes A(d) continuous - but that
// hole is NARROWER ABOVE THAN BELOW whenever clearance grows with depth,
// which no excavation can be, and it reads LOW against any physical
// trench (-20% at a constant 4 ft with a 6-in pipe). A low dig number
// reaching a bid is the expensive direction, so the full-width neat-line
// convention stands (CONVENTION: trench pay width = pipe OD + a
// clearance set by the trench's depth class, applied full depth - the
// vertical-wall / trench-box reading, the MINIMUM physical cut; source:
// general practice for neat-line trench payment, and it is how this
// calculator always read). The consequence is embraced, not hidden:
// crossing a rule edge re-prices the whole column, so 4.00 -> 4.01 ft
// with the default table steps +40% BY DESIGN - a depth-class boundary
// is a price step, the same shape as Pierce's 2-ft pricing bands. What
// WAS a bug is fixed downstream: along a sloped run each slice is split
// at rule-edge crossings (trRunVolumes), so the integral is exact for a
// linear profile instead of whole slices snapping with their midpoints.
function trHoleArea(rs, odFt, d) {
  if (!(d > 0)) return 0;
  return (odFt + 2 * trClrAt(rs, d)) * d;
}

// Bedding-envelope cross-section (sf): the pipe zone - a square of side
// (OD + 2 x clearance) at the trench bottom - taken as a z-sub-range of
// the hole itself, at the hole's own width. min(h, d) is what makes the
// audit-6a clamp structural: a sub-range of the hole cannot out-measure
// the hole, so bedding can never again exceed the dig (the shipped 6a
// defect had bedding at 137% of the dig on a 1-ft-deep run).
function trEnvArea(rs, odFt, d) {
  if (!(d > 0)) return 0;
  const w = odFt + 2 * trClrAt(rs, d);
  return w * Math.min(w, d);
}

// One run: lenFt of pipe, invert depth linear d0 -> d1 along it. N slices
// along the run as before (N = 60, set at the call site); WITHIN each
// slice the depth interval is split at every rule edge it crosses, and
// each sub-piece is evaluated at its MIDPOINT. Between edges both
// trHoleArea (w x d, w constant in-band) and trEnvArea are linear in d,
// so midpoint x length is the exact integral on every piece; a piece
// endpoint sitting exactly ON an edge would sample the wrong band, which
// is why midpoints and not trapezoid endpoints. Net: exact for a linear
// profile under the full-width model - the old code let whole slices
// snap with their midpoint sample, a genuine staircase error on sloped
// runs, which is the part of audit 6b that was a bug.
function trRunVolumes(rs, odFt, lenFt, d0, d1, N) {
  const a0 = Math.max(isFinite(d0) ? d0 : 0, 0);
  const a1 = Math.max(isFinite(d1) ? d1 : 0, 0);
  let dig = 0, env = 0;
  const dL = lenFt / N;
  for (let i = 0; i < N; i++) {
    const dA = a0 + (a1 - a0) * (i / N);
    const dB = a0 + (a1 - a0) * ((i + 1) / N);
    const lo = Math.min(dA, dB), hi = Math.max(dA, dB), span = hi - lo;
    if (span <= 0) {  // level slice: nothing to split
      dig += trHoleArea(rs, odFt, dA) * dL;
      env += trEnvArea(rs, odFt, dA) * dL;
      continue;
    }
    const cuts = [lo];
    for (const r of rs) if (r.to > lo && r.to < hi) cuts.push(r.to);
    cuts.push(hi);
    cuts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const u1 = cuts[k], u2 = cuts[k + 1], f = (u2 - u1) / span;
      if (!(f > 0)) continue;
      const dm = (u1 + u2) / 2;
      dig += trHoleArea(rs, odFt, dm) * f * dL;
      env += trEnvArea(rs, odFt, dm) * f * dL;
    }
  }
  return { dig, env };
}

// Whole-run totals with the audit-6a INVARIANT enforced and stated:
//   bed + backfill + pipe <= dig, always; and whenever the pipe actually
//   fits its hole (pipeVol <= dig), the three parts sum to dig EXACTLY.
// env <= dig holds structurally (see trEnvArea) - the min() mops up float
// noise only. bed and backfill floor at 0: a pipe that cannot fit its own
// trench (OD deeper than the invert) yields zeros, never negatives.
// Before this, 100 LF at 1.0 ft returned bedding = 137% of its own hole.
function trTotals(dig, env, pipeVol) {
  env = Math.min(env, dig);
  const bed = Math.max(env - pipeVol, 0);
  const backfill = Math.max(dig - bed - pipeVol, 0);
  return { dig, bed, backfill, pipeVol };
}

// Display rounding for trench volumes, unchanged: 0.1 CY.
function trCY(v) { return Math.round(v / 27 * 10) / 10; }

// LF per depth band from the TYPED d0/d1 linear profile. Rick, Pierce Site
// Work (transcript 2026-08-27): "we price by the foot to install pipe...
// it's a two-ft interval. So within 8-in sewer main we need to know how
// much of it is 0 to six feet deep, how much is 6 to 8, how much is 8 to
// 10, and so on. Sometimes we're up to 24 feet deep." First edge and step
// are arguments (panel defaults 6 and 2 = his convention, in writing at
// EXCAVATION-PLAN.md section 16), so the bands run [0,F], (F,F+S], ... out
// to the deepest typed invert. A run sitting exactly ON an edge counts in
// the SHALLOWER band - the same convention as the bedding rules' d <= to.
//
// TYPED DEPTHS ONLY - DO NOT WIRE PROFILE-DERIVED DEPTHS IN HERE. Deriving
// depth from INV/RIM text is forbidden until the datum work (commit
// 5390b3f, the abstain rule) is wired into profile reading: 81.9% of spot
// grades on the Barn set come back with the hundreds digit unresolved, and
// differencing truncated elevations puts a confident wrong number in a
// priced band. EXCAVATION-PLAN.md section 16 is the binding instruction.
function trDepthBands(runFt, d0, d1, firstEdge, step, maxRows) {
  const F = +firstEdge, S = +step;
  if (!(F > 0) || !(S > 0) || !(runFt > 0)) return null;
  const a0 = Math.max(isFinite(d0) ? d0 : 0, 0);
  const a1 = Math.max(isFinite(d1) ? d1 : 0, 0);
  const dmin = Math.min(a0, a1), dmax = Math.max(a0, a1);
  // measure of the run at depth <= d; the profile is linear, so exact
  const fracLE = (d) => d >= dmax ? 1
    : (d < dmin || dmax === dmin) ? 0
    : (d - dmin) / (dmax - dmin);
  const rows = [];
  let lo = 0, hi = F, truncated = false;
  for (;;) {
    // the first band's floor is 0 outright, so a run typed at 0 ft still
    // lands in [0,F] instead of vanishing between two edges
    rows.push({ lo, hi, lf: runFt * (fracLE(hi) - (lo === 0 ? 0 : fracLE(lo))) });
    if (hi >= dmax) break;
    if (rows.length >= (maxRows || 64)) { truncated = true; break; }
    lo = hi; hi = lo + S;
  }
  return { rows, truncated };
}
// TRENCH-MATH-END

$("trCalc").onclick = () => {
  const t = state.tr;
  if (!t || t.style_id === null) { $("trResult").textContent = "pick the pipe run first"; return; }
  const sc = state.result.scale;
  if (!sc) { $("trResult").textContent = "no scale on this page — volumes need feet"; return; }
  const ftPerPt = sc.ft_per_paper_inch / 72.0;
  const chains = state.result.chains.filter(c =>
    c.style_id === t.style_id && !state.excluded.has(c.chain_id));
  if (!chains.length) { $("trResult").textContent = "that style has no lines"; return; }
  const odFt = t.od_in / 12.0;
  if (!(odFt > 0)) { $("trResult").textContent = "pipe OD must be a positive number"; return; }
  if (!isFinite(t.d0_ft) || !isFinite(t.d1_ft)) { $("trResult").textContent = "type both invert depths"; return; }
  const rs = trNormRules(t.rules);
  const N = 60;  // slices along each run, as before; rule-edge splits happen inside
  let digRaw = 0, envRaw = 0, runFt = 0;
  for (const c of chains) {
    const L = chainLenPt(c) * ftPerPt;
    runFt += L;
    const v = trRunVolumes(rs, odFt, L, t.d0_ft, t.d1_ft, N);
    digRaw += v.dig; envRaw += v.env;
  }
  const pipeVol = Math.PI * (odFt / 2) ** 2 * runFt;
  const { dig, bed, backfill } = trTotals(digRaw, envRaw, pipeVol);
  $("trResult").innerHTML =
    `<b>dig ${trCY(dig).toLocaleString()} CY</b> · <b>bedding ${trCY(bed).toLocaleString()} CY</b>` +
    ` · backfill ${trCY(backfill).toLocaleString()} CY · ${Math.round(runFt).toLocaleString()} LF of pipe`;
  const name = (state.labels.get(t.style_id) || "pipe").slice(0, 40);
  // Consent is per system: recalculating the SAME style while its rows are
  // added refreshes them in place - consent was given for THIS calculation,
  // and a superseded number left priced is its own silent lie (same rule as
  // ewCalc). Switching styles starts the new system un-added; the previous
  // system's consented rows stay, and the exact-label filter in
  // trClearItems scopes every apply/remove to one system's four rows.
  if (t.added && t.result && t.result.style_id !== t.style_id) t.added = false;
  t.result = { style_id: t.style_id, name, runFt, dig, bed, backfill };
  t.calc = { runFt, d0: t.d0_ft, d1: t.d1_ft };  // the band table reads THIS snapshot
  // Audit item 5, the consent gate: Calculate only LOOKS. Rows reach
  // state.extraItems - and through it the priced report - only via the
  // "Add to takeoff" button (trAdd, below).
  if (t.added) trApplyItems(t.result);
  renderTrTake();
  renderTrBands();
  renderItemized();
};

// Replace only THIS system's four rows. A prefix filter here once removed
// every row starting Trench/Bedding/Backfill or ending (run), so
// calculating a second pipe system silently deleted the first - a job with
// sanitary + storm + water + force main could only ever hold one of the
// four. Matching the exact labels this calculation regenerates (the style's
// name is embedded in all four) scopes the replacement to one system.
// Label-based on purpose: calcSave strips rows to {label, qty, unit}, so a
// hidden style-id tag would not survive a session restore and restored rows
// would stop being replaced. Trade-off accepted: renaming a style between
// calculates leaves the old name's rows behind - visible and deletable,
// which beats the silent deletion this replaces.
function trClearItems(res) {
  const mine = new Set([`${res.name} (run)`, `Trench excavation (${res.name})`,
                        `Bedding gravel (${res.name})`, `Backfill (${res.name})`]);
  state.extraItems = state.extraItems.filter(it => !mine.has(it.label));
}

function trApplyItems(res) {
  trClearItems(res);
  // The FOOTAGE is the line item an excavator actually bids. Every utility
  // row on Beaumont's Estimate #853 is priced per LF - the perimeter drain
  // alone is 3,395 LF / $105,245 - while the CY volumes below are the
  // supporting math. Emit the run first so it leads the group.
  if (res.runFt > 0) state.extraItems.push({ label: `${res.name} (run)`, qty: Math.round(res.runFt * 10) / 10, unit: "LF" });
  if (res.dig > 0) state.extraItems.push({ label: `Trench excavation (${res.name})`, qty: trCY(res.dig), unit: "CY" });
  if (res.bed > 0) state.extraItems.push({ label: `Bedding gravel (${res.name})`, qty: trCY(res.bed), unit: "CY" });
  if (res.backfill > 0) state.extraItems.push({ label: `Backfill (${res.name})`, qty: trCY(res.backfill), unit: "CY" });
}

// Audit item 5: the same consent earthwork and structures already require.
// Calculating is looking; this button is the decision.
$("trAdd").onclick = () => {
  if (!state.tr || !state.tr.result) return;
  state.tr.added = !state.tr.added;
  if (state.tr.added) trApplyItems(state.tr.result);
  else trClearItems(state.tr.result);
  renderTrTake();
  renderItemized();
  setStatus(state.tr.added
    ? "trench rows added to the takeoff — they will price, export and print like any other row"
    : "trench rows removed from the takeoff");
};

function renderTrTake() {
  const box = $("trTake"), btn = $("trAdd"), note = $("trTakeNote");
  if (!box || !btn || !note) return;
  const res = state.tr && state.tr.result;
  box.classList.toggle("off", !res);
  if (!res) return;
  btn.textContent = state.tr.added ? "Remove from takeoff" : "Add to takeoff";
  btn.classList.toggle("on", !!state.tr.added);
  note.textContent = state.tr.added
    ? `${res.name}: in the itemized takeoff. Recalculating this style refreshes its rows in place; other systems' rows are never touched.`
    : "Not in the takeoff. Calculate only shows the numbers — press this to bid them.";
}

// The Pierce band table. Reads the snapshot taken at Calculate (state.tr
// .calc), so its rows always describe the run and profile the volumes above
// came from; editing d0/d1 after Calculate changes nothing here until the
// next Calculate. The edge inputs re-render live - they re-slice the same
// snapshot, which is safe because bands are read-only and never touch
// state.extraItems.
function renderTrBands() {
  const box = $("trBandBox"), out = $("trBandRows");
  if (!box || !out) return;
  const c = state.tr && state.tr.calc;
  box.classList.toggle("off", !c);
  if (!c) return;
  out.innerHTML = "";
  const bt = trDepthBands(c.runFt, c.d0, c.d1,
                          parseFloat($("trBandEdge").value),
                          parseFloat($("trBandStep").value), 64);
  if (!bt) {
    out.innerHTML = '<div class="tr-bands-note">first edge and step must be positive numbers</div>';
    return;
  }
  const fmtE = (v) => (Math.round(v * 100) / 100).toLocaleString();
  for (const b of bt.rows) {
    const row = document.createElement("div");
    row.className = "tr-band-row";
    const lab = document.createElement("span");
    lab.textContent = `${fmtE(b.lo)}–${fmtE(b.hi)} ft deep`;
    const q = document.createElement("b");
    q.textContent = `${Math.round(b.lf).toLocaleString()} LF`;
    row.append(lab, q);
    out.appendChild(row);
  }
  if (bt.truncated) {
    const d = document.createElement("div");
    d.className = "tr-bands-note";
    d.textContent = "stopped at 64 bands — widen the step to cover the full depth";
    out.appendChild(d);
  }
}
$("trBandEdge").oninput = renderTrBands;
$("trBandStep").oninput = renderTrBands;

// ---------- symbol counter ----------
$("symClose").onclick = () => { $("symPanel").hidden = true; state.symMarks = null; draw(); };

// ---------- whole job: every mark code across the document ---------------
// Bill Dunn, 2026-08-21: "I want to know that I have 27 type D windows on
// the fifth floor." A per-page count cannot answer that and neither can a
// per-page CSV - what he faxes a supplier is one quantity per type for the
// whole building. The server reads the per-page symbol caches only, so this
// never kicks off detection; sheets not yet counted are named rather than
// silently treated as zero.
$("rollClose").onclick = () => { $("rollPanel").hidden = true; };

$("rollBtn").onclick = async () => {
  const panel = $("rollPanel");
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  $("rollBody").innerHTML = '<div class="ew-hint">reading the sheets already counted…</div>';
  const r = await fetch(`/api/job/${state.job}/marks-rollup`);
  if (!r.ok) { $("rollBody").textContent = "rollup failed (" + r.status + ")"; return; }
  state.roll = await r.json();
  renderRoll();
};

function renderRoll() {
  const j = state.roll || {}, rows = j.rows || [];
  const pend = $("rollPending");
  const counted = j.pages_counted || [], pending = j.pages_pending || [];
  if (pending.length) {
    pend.innerHTML = `counted <b>${counted.length}</b> sheet${counted.length === 1 ? "" : "s"}` +
      ` &middot; <b>${pending.length}</b> not counted yet (sheet ` +
      pending.map(p => p + 1).join(", ") + `) &mdash; ` +
      `<span class="dim">open Count on those sheets and this total completes</span>`;
    pend.hidden = false;
  } else if (counted.length) {
    pend.innerHTML = `every sheet in the document counted (<b>${counted.length}</b>)`;
    pend.hidden = false;
  } else { pend.hidden = true; }

  const box = $("rollBody");
  box.innerHTML = "";
  if (!rows.length) {
    box.innerHTML = '<div class="ew-hint">no named marks yet. Run <b>Count</b> on a sheet that ' +
      'carries mark bubbles, then come back.</div>';
    $("rollTotal").hidden = true;
    return;
  }
  const pages = counted.slice();
  const tbl = document.createElement("table");
  tbl.className = "roll-tbl";
  const th = document.createElement("tr");
  th.innerHTML = "<th>mark</th>" + pages.map(p => `<th>sh ${p + 1}</th>`).join("") +
    "<th>total</th><th>schedule</th><th></th>";
  tbl.appendChild(th);
  for (const r of rows) {
    const tr = document.createElement("tr");
    let html = `<td class="roll-code">${r.code}</td>`;
    for (const p of pages) {
      const v = (r.per_page || {})[String(p)];
      html += `<td>${v == null ? '<span class="dim">&middot;</span>' : v}</td>`;
    }
    html += `<td class="roll-tot">${r.found}</td>`;
    if (r.schedule_qty == null) {
      html += '<td class="dim">&mdash;</td><td></td>';
    } else {
      const d = r.delta;
      html += `<td>${r.schedule_qty}</td>`;
      html += d === 0
        ? '<td class="sym-chk-ok">match</td>'
        : `<td class="sym-chk-bad">${d > 0 ? "+" + d : d}</td>`;
    }
    tr.innerHTML = html;
    tbl.appendChild(tr);
  }
  box.appendChild(tbl);

  const t = $("rollTotal");
  let txt = `<b>${j.total_found}</b> marks counted across ${counted.length} sheet` +
    (counted.length === 1 ? "" : "s");
  if (j.total_schedule) {
    const d = j.total_found - j.total_schedule;
    txt += ` &middot; schedule totals <b>${j.total_schedule}</b>` +
      (d === 0 ? ' <span class="sym-chk-ok">match</span>'
               : ` <span class="sym-chk-bad">${d > 0 ? "+" + d : d}</span>`);
  }
  if (pending.length) txt += `<br><span class="dim">not a whole-document total yet &mdash; ` +
    `${pending.length} sheet${pending.length === 1 ? "" : "s"} still uncounted</span>`;
  t.innerHTML = txt; t.hidden = false;
}

// ---------- counted twice, ACROSS sheets --------------------------------
// report_pdf sums length_ft per label over every approved page, and its own
// caption says so: "a run drawn on several sheets is counted once per sheet."
// True, and useless to the operator, who cannot see WHICH labels that hits.
//
// This surfaces the overlap and stops. It does NOT match geometry across
// sheets: that is rotation-invariant matching with three tolerances, the
// first attempt failed on a bucket edge, and getting it wrong deletes real
// footage. Nothing here reads a coordinate.
//
// Session-only by construction. The marks below are a judgement about ONE
// document in front of one person; persisting them would silently move a
// later job total with no symptom, which is the worst failure this tool has.
function xsKey(page, label) {
  return (state.docName || "?") + " p" + page + " :: " + label;
}

async function xsLoadApproved() {
  const n = (state.kinds || []).length;
  const pages = [];
  // p<N>_elements.json exists only for an approved page; 404 means "not
  // approved", which is a fact, not an error. Fetched 8 at a time so a
  // 200-sheet job does not open 200 sockets.
  for (let base = 0; base < n; base += 8) {
    const batch = [];
    for (let p = base; p < Math.min(base + 8, n); p++) batch.push(p);
    const got = await Promise.all(batch.map(async (p) => {
      try {
        const r = await fetch(`/api/job/${state.job}/page/${p}/elements`);
        if (!r.ok) return null;
        return { page: p, exp: await r.json() };
      } catch (e) { return null; }
    }));
    for (const g of got) if (g) pages.push(g);
  }
  return pages;
}

$("xsClose").onclick = () => { $("xsPanel").hidden = true; };

$("xsBtn").onclick = async () => {
  const panel = $("xsPanel");
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  $("xsBody").innerHTML = '<div class="ew-hint">reading the approved sheets…</div>';
  $("xsTotal").hidden = true; $("xsPending").hidden = true;
  state.xs = await xsLoadApproved();
  renderXs();
};

function renderXs() {
  const approved = state.xs || [];
  const box = $("xsBody"), tot = $("xsTotal"), pend = $("xsPending");
  box.innerHTML = "";
  if (!state.xsIgnore) state.xsIgnore = new Set();
  const nPages = (state.kinds || []).length;

  if (!approved.length) {
    box.innerHTML = '<div class="ew-hint">no approved sheets yet. Press ' +
      '<b>Approve &amp; export</b> on two sheets and this table fills in.</div>';
    tot.hidden = true; pend.hidden = true;
    return;
  }
  pend.innerHTML = `<b>${approved.length}</b> of ${nPages} sheet` +
    (nPages === 1 ? "" : "s") + ` approved (sheet ` +
    approved.map(a => a.page + 1).join(", ") + `)` +
    (approved.length < nPages
      ? ` &middot; <span class="dim">the rest are not in the Report PDF either</span>` : "");
  pend.hidden = false;

  // label -> per-sheet footage. Footage only: report_pdf's grand summary is
  // footage-only too ("summary totals stay footage-only"), so this table
  // reconciles to the number that PDF prints. EA / calculator rows are NOT
  // covered here - stated, not silently dropped.
  const byLabel = new Map();
  let allFt = 0, eaRows = 0;
  for (const a of approved) {
    for (const it of (a.exp.items || [])) {
      if (it.length_ft === null || it.length_ft === undefined) { eaRows += 1; continue; }
      const e = byLabel.get(it.label) || { per: [], ft: 0 };
      e.per.push({ page: a.page, ft: it.length_ft, count: it.count });
      e.ft += it.length_ft;
      byLabel.set(it.label, e);
      allFt += it.length_ft;
    }
  }
  const multi = [...byLabel.entries()]
    .filter(([, e]) => e.per.length > 1)
    .sort((a, b) => b[1].ft - a[1].ft);

  let overlapFt = 0, ignoredFt = 0;
  for (const [label, e] of multi) {
    overlapFt += e.ft;
    const wrap = document.createElement("div");
    wrap.className = "xs-lab";
    const h = document.createElement("div");
    h.className = "xs-lab-head";
    h.innerHTML = `<span class="xs-name" title="${label.replace(/"/g, "&quot;")}">${label}</span>` +
      `<span class="xs-ft">${e.ft.toLocaleString(undefined, {maximumFractionDigits: 1})} ft` +
      ` over ${e.per.length} sheets</span>`;
    wrap.appendChild(h);
    let kept = 0;
    for (const c of e.per) {
      const k = xsKey(c.page, label);
      const off = state.xsIgnore.has(k);
      if (off) ignoredFt += c.ft; else kept += c.ft;
      const r = document.createElement("div");
      r.className = "xs-row" + (off ? " off" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = !off;
      cb.name = `xs-${c.page}-${label}`;
      cb.title = off
        ? "counted again below"
        : "tick off to say this sheet's contribution is already counted elsewhere";
      cb.onchange = () => {
        if (cb.checked) state.xsIgnore.delete(k); else state.xsIgnore.add(k);
        renderXs();
      };
      const nm = document.createElement("button");
      nm.className = "mini xs-go";
      nm.textContent = "sheet " + (c.page + 1);
      nm.title = "open this sheet";
      nm.onclick = () => { $("pageSel").value = c.page; selectPage(c.page); };
      const ft = document.createElement("span");
      ft.className = "xs-ft";
      ft.textContent = c.ft.toLocaleString(undefined, {maximumFractionDigits: 1}) +
        " ft · " + c.count + " line" + (c.count === 1 ? "" : "s");
      r.append(cb, nm, ft);
      wrap.appendChild(r);
    }
    if (kept !== e.ft) {
      const adj = document.createElement("div");
      adj.className = "xs-adj";
      adj.textContent = "counted here: " +
        kept.toLocaleString(undefined, {maximumFractionDigits: 1}) + " ft" +
        " (was " + e.ft.toLocaleString(undefined, {maximumFractionDigits: 1}) + ")";
      wrap.appendChild(adj);
    }
    box.appendChild(wrap);
  }
  if (!multi.length) {
    box.innerHTML = '<div class="ew-hint">no label carries footage on two of the ' +
      'approved sheets. Nothing is billed twice across sheets on this set.</div>';
  }

  let txt = `<b>${allFt.toLocaleString(undefined, {maximumFractionDigits: 1})}</b> ft` +
    ` summed over ${approved.length} approved sheet` + (approved.length === 1 ? "" : "s") +
    ` &mdash; the figure the Report PDF prints.<br>` +
    `<b>${multi.length}</b> label${multi.length === 1 ? "" : "s"} on more than one sheet,` +
    ` carrying <b>${overlapFt.toLocaleString(undefined, {maximumFractionDigits: 1})}</b> ft` +
    ` of that. Whether any of it is one run drawn twice is your call, not the engine's.`;
  if (ignoredFt > 0)
    txt += `<br>after your marks: <b>` +
      (allFt - ignoredFt).toLocaleString(undefined, {maximumFractionDigits: 1}) +
      `</b> ft <span class="dim">(you set aside ` +
      ignoredFt.toLocaleString(undefined, {maximumFractionDigits: 1}) +
      ` ft as already counted; nothing was deleted and the Report PDF still prints ` +
      allFt.toLocaleString(undefined, {maximumFractionDigits: 1}) + `)</span>`;
  if (eaRows)
    txt += `<br><span class="dim">${eaRows} EA / calculator row(s) on these sheets are ` +
      `not in this table &mdash; it covers linear footage only.</span>`;
  tot.innerHTML = txt; tot.hidden = false;
}

$("rollCsv").onclick = () => {
  const j = state.roll || {}, rows = j.rows || [];
  if (!rows.length) { setStatus("nothing to export yet", "err"); return; }
  const pages = j.pages_counted || [];
  const out = [["mark", ...pages.map(p => "sheet " + (p + 1)), "total", "schedule", "delta"]];
  for (const r of rows) {
    out.push([r.code, ...pages.map(p => (r.per_page || {})[String(p)] ?? ""),
              r.found, r.schedule_qty ?? "", r.delta ?? ""]);
  }
  out.push(["TOTAL", ...pages.map(() => ""), j.total_found, j.total_schedule ?? "", ""]);
  const csv = out.map(r => r.map(c => {
    const s = String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = (state.docName || "takeoff").replace(/\.pdf$/i, "") + " - marks by sheet.csv";
  a.click(); URL.revokeObjectURL(a.href);
  setStatus("whole-job mark CSV exported");
};
$("symBtn").onclick = async () => {
  const panel = $("symPanel");
  if (!panel.hidden) { panel.hidden = true; state.symMarks = null; draw(); return; }
  panel.hidden = false;
  if (!state.sym) {
    $("symRows").innerHTML = '<div class="ew-hint">scanning for repeated shapes…' +
      '<br><span class="dim">a scanned sheet is read as a picture and takes ~20-40s the first time</span></div>';
    const r = await fetch(`/api/job/${state.job}/page/${state.page}/symbols/suggest`);
    if (!r.ok) { $("symRows").textContent = "scan failed (" + r.status + ")"; return; }
    const j = await r.json();
    state.sym = j.groups;
    state.symInfo = j;
    // the banner can only warn about counts it could not read once the
    // reader has actually looked - it gains that line here, not before
    renderConfidence();
  }
  renderSym();
};

// One takeoff line per mark: "W1L × 27 EA". Bill Dunn's trade counts by
// mark, not by symbol, so the mark IS the label.
function symAdd(g) {
  const label = (g.name || "").trim();
  if (!label) { setStatus("name the mark first", "err"); return false; }
  state.extraItems = state.extraItems.filter(it => it.label !== label);
  state.extraItems.push({ label, qty: g.n, unit: "EA" });
  return true;
}

$("symAddAll").onclick = () => {
  const named = (state.sym || []).filter(g => (g.name || "").trim());
  if (!named.length) { setStatus("nothing is named yet", "err"); return; }
  named.forEach(symAdd);
  setStatus(`${named.length} mark${named.length > 1 ? "s" : ""} added to takeoff`);
  renderItemized();
};

function renderSym() {
  const box = $("symRows"), info = state.symInfo || {};
  box.innerHTML = "";
  renderSymScope();   // sets g._scope on every group; must run before the rows

  // groups beyond the response cap exist but are not in this list - say so
  // (the count implies completeness otherwise; audit B3)
  if (info.groups_total > (state.sym || []).length) {
    const d = document.createElement("div");
    d.className = "ew-hint";
    d.textContent = `showing ${state.sym.length} of ${info.groups_total} `
      + `repeated-symbol groups - the smallest ${info.groups_total - state.sym.length} `
      + `are not listed or counted here`;
    box.appendChild(d);
  }

  // what the sheet's own schedule says, and where it was read from - the
  // estimator needs to know whether the cross-check column is trustworthy
  const sb = $("symSched");
  const sm = info.schedule_marks || [];
  if (sm.length) {
    const where = info.schedule_page === state.page ? "this sheet"
      : `sheet ${(info.schedule_page ?? 0) + 1}`;
    sb.innerHTML = `${info.schedule_header || "MARK"} schedule on ${where}: ` +
      sm.map(m => `<b>${m}</b>`).join(" ") +
      (info.schedule_source === "ocr"
        ? ' <span class="dim">(read by OCR off a scan — check it)</span>' : "");
    sb.hidden = false;
  } else { sb.hidden = true; }

  if (!state.sym || !state.sym.length) {
    box.innerHTML = '<div class="ew-hint">no repeated closed shapes found on this page</div>';
    $("symTotal").hidden = true;
    return;
  }
  state.sym.forEach((g, k) => {
    const row = document.createElement("div");
    const gv = (g._scope || { v: "unknown" });
    const aside = gv.v === "out" && !g._keep;
    row.className = "sym-row" + (g.name ? "" : " sym-unnamed")
      + (aside ? " scope-out" : gv.v === "in" ? " scope-in" : "");
    const n = document.createElement("div");
    n.className = "sym-n"; n.textContent = g.n;
    const mid = document.createElement("div");
    const nm = document.createElement("input");
    nm.className = "sym-name";
    nm.placeholder = "name it (e.g. WINDOW)";
    nm.name = "sym-name-" + k;
    nm.value = g.name || "";
    nm.oninput = () => { g.name = nm.value; };
    const meta = document.createElement("div");
    meta.className = "sym-meta";
    let mtxt = `${g.w}×${g.h}pt`;
    if (g.source === "raster") mtxt += " · read off the scan";
    meta.textContent = mtxt;
    if (g.off_schedule) {
      // a real read that is simply not one of this schedule's marks - say so
      // rather than filing it under "could not read"
      const os = document.createElement("span");
      os.className = "sym-off";
      os.textContent = ` · reads "${g.off_schedule}" — not in the schedule`;
      meta.appendChild(os);
      nm.placeholder = "not a schedule mark — name it only if you want it";
    }
    if (aside || g._keep) {
      // Set aside is a filter, never a deletion: the row stays in the list
      // with its count, and one click puts it back in the total. Nothing
      // about this changes g.n - the number the geometry produced.
      const sp = document.createElement("span");
      sp.className = "sym-aside";
      sp.textContent = g._keep ? " · you put this back" : " · " + gv.why;
      meta.appendChild(sp);
    }
    if (g.schedule_qty !== undefined) {
      const chk = document.createElement("span");
      const ok = g.schedule_qty === g.n;
      chk.className = ok ? "sym-chk-ok" : "sym-chk-bad";
      chk.textContent = ok ? ` · schedule says ${g.schedule_qty} ✓`
        : ` · schedule says ${g.schedule_qty} — CHECK`;
      meta.appendChild(chk);
    }
    mid.append(nm, meta);
    const add = document.createElement("button");
    add.className = "add";
    add.textContent = aside ? "Put back" : "Add";
    add.onclick = () => {
      if (aside) { g._keep = true; renderSym(); return; }
      if (!symAdd(g)) return;
      setStatus(`${g.name.trim()} × ${g.n} added to takeoff`);
      renderItemized();
    };
    row.append(n, mid, add);
    row.onmouseenter = () => { state.symMarks = g.centers; draw(); };
    row.onmouseleave = () => { state.symMarks = null; draw(); };
    box.appendChild(row);
  });

  const tot = $("symTotal");
  const named = state.sym.filter(g => g.name);
  const sum = named.reduce((a, g) => a + g.n, 0);
  const off = state.sym.filter(g => g.off_schedule).reduce((a, g) => a + g.n, 0);
  const un = state.sym.filter(g => !g.name && !g.off_schedule)
    .reduce((a, g) => a + g.n, 0);
  const setAside = state.sym.filter(g => (g._scope || {}).v === "out" && !g._keep)
    .reduce((a, g) => a + g.n, 0);
  let t = `<b>${sum}</b> counted across ${named.length} named mark` +
    (named.length === 1 ? "" : "s");
  if (setAside) t += ` &middot; <b>${setAside}</b> set aside as another trade` +
    ` <span class="dim">(listed below, still countable)</span>`;
  if (off) t += ` &middot; <b>${off}</b> read as a tag this schedule does not list`;
  if (un) t += ` &middot; <b>${un}</b> bubble${un === 1 ? "" : "s"} found but not read`;
  (info.notes || []).forEach(nt => { t += `<br><span class="dim">${nt}</span>`; });
  tot.innerHTML = t;
  tot.hidden = false;
}

// ---------- sheet callouts: the leaders as data ----------
function centerOn(xPt, yPt) {
  const f = IMG_DPI / 72;
  const kFit = Math.min(cv.clientWidth / state.img.width,
                        cv.clientHeight / state.img.height) * 0.97;
  const k = Math.max(state.view.k, kFit * 4.5);
  state.view.k = k;
  state.view.x = cv.clientWidth / 2 - xPt * f * k;
  state.view.y = cv.clientHeight / 2 - yPt * f * k;
  draw();
}
$("coBtn").onclick = async () => {
  const panel = $("coPanel");
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.scrollIntoView({ block: "start", behavior: "smooth" });
  if (!state.co) {
    $("coRows").innerHTML = '<div class="ew-hint">reading callouts… (first run OCRs the sheet, ~10-30s)</div>';
    const r = await fetch(`/api/job/${state.job}/page/${state.page}/callouts`);
    if (!r.ok) { $("coRows").textContent = "run Detect first"; return; }
    state.co = (await r.json()).callouts;
  }
  renderCo();
};
$("coClose").onclick = () => { $("coPanel").hidden = true; };
function renderCo() {
  const box = $("coRows");
  box.innerHTML = "";
  if (!state.co || !state.co.length) {
    box.innerHTML = '<div class="ew-hint">no leaders detected on this page</div>';
    return;
  }
  for (const c of state.co) {
    const div = document.createElement("div");
    div.className = "ew-row co-row";
    const t = document.createElement("div");
    t.className = "co-text";
    t.textContent = c.text || "(text not readable)";
    const tgt = document.createElement("div");
    tgt.className = "ew-meta";
    const st = c.target_style_id !== null &&
      state.result.styles.find(s => s.style_id === c.target_style_id);
    const lab = c.target_chain_id !== null
      ? (state.labels.get(c.target_style_id) || (st && st.suggested_label) || "line")
      : "no line at the tip";
    tgt.textContent = "→ " + lab;
    div.append(t, tgt);
    div.onmouseenter = () => {
      state.hotChain = c.target_chain_id;
      state.symMarks = [[c.gx, c.gy], [c.tx, c.ty]];
      draw();
    };
    div.onmouseleave = () => { state.hotChain = null; state.symMarks = null; draw(); };
    div.onclick = () => {
      if (c.target_chain_id !== null) {
        state.selected = c.target_chain_id;
        updateSelBar(chainById(c.target_chain_id));
      }
      centerOn(c.gx, c.gy);
    };
    box.appendChild(div);
  }
}

// ---------- AI page analyst: suggestions, one at a time ------------------
// Scored 2026-08-23 over the 33 ground-truth pages, three runs each. What
// survived, and why, is in server.py:_AI_GRADES and travels in the payload
// as j._grades - every row below prints the grade of the thing it proposes.
//
// Three rules this section exists to keep:
//   1. NOTHING here writes the takeoff on its own. Each proposal is a row
//      with its own Accept, and each accepted row has its own Undo.
//   2. The model is never evidence for the confidence banner. renderConf()
//      reads state.conf and must never read state.ai - grep them together
//      before changing either.
//   3. A failure says what failed. The server sends a sentence in .detail;
//      show it, do not translate it into a status code.
//
// The bulk "Focus on these N line types" button was REMOVED, not disabled.
// Measured: one click kept a median 18% of the sheet's drawn length and
// dropped the rest, and 17% of the ignore rows it acts on sit on a
// WALL / FTNG / SLAB / CURB / PIPE layer. That is a silent wrong quantity
// one click away, which is the one trade this product does not make.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g,
    ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function aiNorm(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function aiFt(pt) {
  const sc = state.result && state.result.scale;
  if (!sc || !+sc.ft_per_paper_inch) return null;
  return pt / 72 * +sc.ft_per_paper_inch;
}

function aiQty(pt) {
  const ft = aiFt(pt);
  return ft == null ? `${Math.round(pt).toLocaleString()} pt`
    : `${Math.round(ft).toLocaleString()} ft`;
}

async function runAnalyze(quiet) {
  const banner = $("aiBanner");
  if (!quiet) {
    banner.hidden = false;
    banner.classList.remove("slim");
    banner.textContent = "Reading the sheet with AI…";
  } else {
    setStatus("Reading the sheet with AI…", "busy");
  }
  const gen0 = state.job + ":" + state.page;   // page may change mid-flight
  let r, j = null;
  try {
    r = await fetch(`/api/job/${state.job}/page/${state.page}/analyze`, { method: "POST" });
  } catch (e) { r = null; }
  if (gen0 !== state.job + ":" + state.page) return;  // stale reply, drop it
  if (r) { try { j = await r.json(); } catch (e) { j = null; } }
  if (gen0 !== state.job + ":" + state.page) return;
  if (!r || !r.ok) {
    // The server names the actual failure - no key, key rejected, rate
    // limited, no such model, timeout, unreadable reply. Print its sentence.
    const why = (j && (j.detail || j.message))
      || (r ? `the service answered HTTP ${r.status} with no explanation`
            : "the browser could not reach the detection service");
    setStatus("");
    banner.hidden = false;
    banner.classList.remove("slim");
    banner.innerHTML = `<b>AI analysis did not run.</b> <span class="ai-dim">`
      + esc(why) + `</span><br><span class="ai-dim">Your takeoff is `
      + `unchanged. Everything else on this page works without it.</span>`;
    banner.appendChild(aiDismissBtn());
    return;
  }
  setStatus("");
  state.ai = j;
  // per-style reasoning, surfaced on the style rows themselves. This is a
  // note on the row, not a decision: renderStyles only tints and titles it.
  state.aiWhy = new Map();
  for (const f of j.focus || [])
    state.aiWhy.set(f.style_id, { keep: true, why: f.why, label: f.label });
  for (const i of j.ignore || [])
    state.aiWhy.set(i.style_id, { keep: false, why: i.why });
  state.aiAuto = false;   // there is no auto mode any more; see the header
  renderAiBanner();
  renderStyles(); renderItemized(); renderMiniLegend(); draw();
}
$("aiBtn").onclick = () => {
  // once this page is analyzed, the button re-opens the dismissed
  // banner instead of re-running; a new page/PDF resets everything
  if (state.ai && state.aiHidden) {
    state.aiHidden = false;
    renderAiBanner();
    return;
  }
  runAnalyze(false);
};

function aiDismissBtn() {
  const x = document.createElement("button");
  x.className = "mini ai-x";
  x.textContent = "✕";
  x.title = "Hide this analysis (the Analyze button brings it back on this page)";
  x.onclick = () => {
    state.aiHidden = true;
    $("aiBtn").textContent = "Analyze ▾";
    renderAiBanner();
  };
  return x;
}

// Every difference between what the model says and what is on screen right
// now, as one reversible row each. Ordered by what it costs to be wrong:
// turning a style ON adds linework the reviewer can see, renaming changes a
// word, and turning one OFF removes footage from the takeoff - so that one
// is last and carries its own quantity.
function aiProposals(j) {
  const styles = (state.result && state.result.styles) || [];
  const byId = new Map(styles.map(s => [s.style_id, s]));
  const on = [], rename = [], obj = [], off = [];
  for (const f of j.focus || []) {
    const st = byId.get(f.style_id);
    if (!st) continue;
    if (state.include.get(f.style_id) !== true)
      on.push({ id: "on:" + f.style_id, kind: "on", sid: f.style_id, st,
                why: f.why });
    const cur = (state.labels.get(f.style_id) || "").trim();
    if (f.label && aiNorm(f.label) !== aiNorm(cur))
      rename.push({ id: "label:" + f.style_id, kind: "label", sid: f.style_id,
                    st, to: f.label, from: cur, echo: !!f.echo, why: f.why });
    if (f.measure === "object" && state.measureMode.get(f.style_id) !== "object")
      obj.push({ id: "obj:" + f.style_id, kind: "obj", sid: f.style_id, st,
                 why: f.why });
  }
  for (const g of j.ignore || []) {
    const st = byId.get(g.style_id);
    if (!st) continue;
    if (state.include.get(g.style_id) === true)
      off.push({ id: "off:" + g.style_id, kind: "off", sid: g.style_id, st,
                 why: g.why });
  }
  off.sort((a, b) => b.st.length_pt - a.st.length_pt);
  return on.concat(rename, obj, off);
}

function aiApplyOne(p) {
  if (!state.aiUndo) state.aiUndo = new Map();
  if (state.aiUndo.has(p.id)) return;
  if (p.kind === "on" || p.kind === "off") {
    state.aiUndo.set(p.id, { kind: p.kind, sid: p.sid,
                             prev: state.include.get(p.sid) });
    setInclude(p.sid, p.kind === "on");
  } else if (p.kind === "label") {
    state.aiUndo.set(p.id, { kind: p.kind, sid: p.sid,
                             prev: state.labels.get(p.sid) });
    state.labels.set(p.sid, p.to);
  } else if (p.kind === "obj") {
    state.aiUndo.set(p.id, { kind: p.kind, sid: p.sid,
                             prev: state.measureMode.get(p.sid) });
    state.measureMode.set(p.sid, "object");
  }
  setStatus(`applied 1 AI suggestion — ${state.aiUndo.size} in total, each `
            + `undoable`);
  renderAiBanner(); renderStyles(); renderChips(); renderItemized();
  renderMiniLegend(); draw();
}

function aiUndoOne(id) {
  if (!state.aiUndo || !state.aiUndo.has(id)) return;
  const u = state.aiUndo.get(id);
  if (u.kind === "on" || u.kind === "off") setInclude(u.sid, u.prev === true);
  else if (u.kind === "label") {
    if (u.prev == null) state.labels.delete(u.sid);
    else state.labels.set(u.sid, u.prev);
  } else if (u.kind === "obj") {
    if (u.prev == null) state.measureMode.delete(u.sid);
    else state.measureMode.set(u.sid, u.prev);
  }
  state.aiUndo.delete(id);
  if (!state.aiUndo.size) state.aiUndo = null;
  setStatus("AI suggestion undone");
  renderAiBanner(); renderStyles(); renderChips(); renderItemized();
  renderMiniLegend(); draw();
}

function undoAiFocus() {
  if (!state.aiUndo) return;
  for (const id of [...state.aiUndo.keys()]) aiUndoOne(id);
  state.aiUndo = null;
  setStatus("every AI suggestion undone");
  renderAiBanner(); renderStyles(); renderChips(); renderItemized();
  renderMiniLegend(); draw();
}

function aiGradeChip(g) {
  const s = document.createElement("span");
  s.className = "ai-grade";
  s.textContent = "measured";
  s.title = g ? `${g.hit}\n\nrun-to-run: ${g.stable}` : "not scored";
  return s;
}

function renderAiBanner() {
  const banner = $("aiBanner"), j = state.ai;
  if (!j || state.aiHidden) { banner.hidden = true; return; }
  $("aiBtn").textContent = "Analyze";
  banner.hidden = false;
  banner.classList.remove("slim");
  banner.innerHTML = "";
  const G = j._grades || {};

  // --- who said this, and the standing disclaimer -------------------------
  const head = document.createElement("div");
  head.className = "ai-head";
  head.innerHTML =
    `<b>Read by ${esc((j._provider || "an LLM").split(":").pop())}</b>`
    + ` <span class="ai-dim">— suggestions only. Nothing below has changed `
    + `your takeoff; accept them one at a time.</span>`;
  banner.appendChild(head);
  banner.appendChild(aiDismissBtn());

  // --- what the sheet says about itself -----------------------------------
  // These three come off the title block, which is printed evidence, and
  // they scored best. They are shown, never applied: nothing in the takeoff
  // is keyed on them.
  const facts = document.createElement("div");
  facts.className = "ai-facts";
  const addFact = (name, val, grade, extra) => {
    if (!val) return;
    const d = document.createElement("div");
    d.className = "ai-fact";
    d.innerHTML = `<span class="ai-dim">${esc(name)}</span> <b>${esc(val)}</b>`
      + (extra ? ` <span class="ai-dim">${esc(extra)}</span>` : "");
    d.appendChild(aiGradeChip(grade));
    facts.appendChild(d);
  };
  addFact("sheet", j.sheet_id, G.sheet_id);
  addFact("title", j.sheet_title, G.sheet_title);
  if (j.purpose) {
    const d = document.createElement("div");
    d.className = "ai-fact ai-purpose";
    d.innerHTML = `<b>${esc(j.purpose)}</b>`
      + (j.discipline ? ` <span class="ai-dim">(${esc(j.discipline)})</span>`
                      : "");
    facts.appendChild(d);
  }
  // the scale the MODEL read, next to the one the engine read. Never
  // written into state.result.scale: 4 of the 31 scales it offered were
  // wrong, all on scanned sheets, and a wrong scale multiplies every
  // quantity on the page. The scale picker stays the only way to change it.
  if (j.scale_text) {
    const eng = state.result && state.result.scale;
    const engTxt = eng && eng.text ? eng.text : null;
    const d = document.createElement("div");
    d.className = "ai-fact";
    d.innerHTML = `<span class="ai-dim">scale printed on the sheet, as the `
      + `model reads it</span> <b>${esc(j.scale_text)}</b> `
      + `<span class="ai-dim">— not applied. `
      + (engTxt ? `The engine reads <b>${esc(engTxt)}</b>.`
                : `The engine could not find one here.`)
      + ` Check it against the sheet before you rely on it.</span>`;
    d.appendChild(aiGradeChip(G.scale_text));
    facts.appendChild(d);
  }
  if (facts.childElementCount) banner.appendChild(facts);

  const legend = (j.inline_legend || [])
    .map(l => `${esc(l.symbol)} = ${esc(l.meaning)}`).join("; ");
  if (legend) {
    const d = document.createElement("div");
    d.className = "ai-fact";
    d.innerHTML = `<span class="ai-dim">legend the model read on the sheet `
      + `(unverified):</span> ${legend}`;
    banner.appendChild(d);
  }

  // --- the proposals ------------------------------------------------------
  const props = aiProposals(j);
  const applied = state.aiUndo || new Map();
  const box = document.createElement("div");
  box.className = "ai-props";
  const KIND = {
    on:    { verb: "turn ON",  grade: G.focus,  cls: "ai-p-on" },
    off:   { verb: "turn OFF", grade: G.ignore, cls: "ai-p-off" },
    label: { verb: "rename",   grade: G.label,  cls: "ai-p-label" },
    obj:   { verb: "count as objects (EA), not feet", grade: G.focus,
             cls: "ai-p-obj" },
  };
  for (const p of props) {
    const k = KIND[p.kind];
    const row = document.createElement("div");
    row.className = "ai-prop " + k.cls;
    const name = (state.labels.get(p.sid) || p.st.suggested_label
                  || ("style " + p.sid));
    let what = `<b>${esc(k.verb)}</b> ${esc(name)}`;
    if (p.kind === "label") {
      what = `<b>rename</b> ${esc(p.from || "(unlabelled)")} → `
           + `<b>${esc(p.to)}</b>`;
      if (p.echo) what += ` <span class="ai-dim">(same as the CAD layer — `
                        + `no new information)</span>`;
    }
    if (p.kind === "off")
      what += ` <span class="ai-warn">removes ${esc(aiQty(styleLenPt(p.st)))}`
            + ` from the takeoff</span>`;
    const txt = document.createElement("span");
    txt.className = "ai-prop-txt";
    txt.innerHTML = what + (p.why ? ` <span class="ai-dim">— `
                                    + `${esc(p.why)}</span>` : "");
    row.appendChild(txt);
    row.appendChild(aiGradeChip(k.grade));
    const b = document.createElement("button");
    b.className = "mini";
    if (applied.has(p.id)) {
      row.classList.add("ai-done");
      b.textContent = "Undo";
      b.onclick = () => aiUndoOne(p.id);
    } else {
      b.textContent = "Accept";
      b.title = "Applies just this one change. It can be undone on its own.";
      b.onclick = () => aiApplyOne(p);
    }
    row.appendChild(b);
    box.appendChild(row);
  }
  // rows already accepted whose proposal no longer differs from the screen
  for (const [id, u] of applied) {
    if (props.some(p => p.id === id)) continue;
    const row = document.createElement("div");
    row.className = "ai-prop ai-done";
    const st = ((state.result && state.result.styles) || [])
      .find(s => s.style_id === u.sid);
    const DONE = { on: "turned ON", off: "turned OFF", label: "renamed",
                   obj: "counting as objects (EA)" };
    row.innerHTML = `<span class="ai-prop-txt ai-dim">accepted — `
      + `${esc(DONE[u.kind] || u.kind)} `
      + `${esc((st && (state.labels.get(u.sid)
          || st.suggested_label)) || ("style " + u.sid))}</span>`;
    const b = document.createElement("button");
    b.className = "mini";
    b.textContent = "Undo";
    b.onclick = () => aiUndoOne(id);
    row.appendChild(b);
    box.appendChild(row);
  }
  if (box.childElementCount) {
    const lead = document.createElement("div");
    lead.className = "ai-dim ai-props-lead";
    lead.textContent = `${box.childElementCount} suggested change`
      + (box.childElementCount === 1 ? "" : "s")
      + " — hover “measured” on any row to see how often that kind of "
      + "suggestion was right over 33 ground-truth pages.";
    banner.appendChild(lead);
    banner.appendChild(box);
  } else if ((j.focus || []).length || (j.ignore || []).length) {
    const d = document.createElement("div");
    d.className = "ai-dim";
    d.textContent = "The model agrees with the page as it stands — nothing "
      + "to change.";
    banner.appendChild(d);
  }

  // --- footer: re-read, undo everything, calculators ----------------------
  const bar = document.createElement("div");
  bar.className = "ai-actions";
  if (state.aiUndo && state.aiUndo.size) {
    const undo = document.createElement("button");
    undo.textContent = `Undo all ${state.aiUndo.size} AI change`
      + (state.aiUndo.size === 1 ? "" : "s");
    undo.onclick = undoAiFocus;
    bar.appendChild(undo);
  }
  const rr = document.createElement("button");
  rr.className = "mini";
  rr.textContent = "Re-read sheet";
  rr.title = "Ask the model to read this sheet again. It is not a second "
    + "opinion: the same model answered differently between runs on 24 of "
    + "32 pages, so a changed answer is noise, not news.";
  rr.onclick = async () => {
    let r2 = null;
    try {
      r2 = await fetch(
        `/api/job/${state.job}/page/${state.page}/analyze?fresh=1`,
        { method: "POST" });
    } catch (e) { r2 = null; }
    if (r2 && r2.ok) runAnalyze(true);
    else setStatus("re-read failed — the previous reading is still on screen");
  };
  bar.appendChild(rr);
  // Calculator chips only for the two modes that never flickered between
  // runs. count and objects moved on 6 and 5 of 32 pages, so a chip for
  // them is a coin toss dressed as advice.
  const CALC = {
    earthwork: { btn: "ewBtn", label: "EARTHWORK — cut & fill from these contours" },
    trench:    { btn: "trBtn", label: "TRENCH — excavation + bedding for a pipe run" },
  };
  for (const m of (j.page_modes || []).filter(m => CALC[m])) {
    const b = document.createElement("button");
    b.className = "ai-mode";
    b.textContent = CALC[m].label;
    b.title = "The model says this sheet calls for this calculator. Opens "
      + "the tool; measures nothing on its own.";
    b.onclick = () => { const t = $(CALC[m].btn); if (t) t.click(); };
    bar.appendChild(b);
  }
  banner.appendChild(bar);

  const foot = document.createElement("div");
  foot.className = "ai-dim ai-foot";
  foot.textContent = "This reading is not evidence for the sheet's "
    + "confidence banner and never counts as a second source — the model and "
    + "the engine can read the same printed caption and be wrong together.";
  if (j._invalid_style_ids)
    foot.textContent += ` ${j._invalid_style_ids} suggestion(s) were `
      + `discarded for naming a line style this sheet does not have.`;
  if (j._truncated)
    foot.textContent += " The model's reply was cut off by the token limit; "
      + "what is shown is the part that arrived.";
  banner.appendChild(foot);
}

$("approveBtn").onclick = async () => {
  const labels = {};
  for (const [sid, inc] of state.include) if (inc) labels[sid] = state.labels.get(sid) || "unlabeled";
  // The scale the estimator is LOOKING AT. Send it or the server recomputes
  // every length from the engine's own pick, and a sheet where he switched
  // 1.0 -> 4.0 ft/in exports 4x low with his approval on it, stamped "auto".
  // Sent on every approve, not only when he switched: pressing Approve on
  // the engine's reading is also a decision, and it has to be able to
  // retire an override this page recorded earlier.
  // The rows the ITEMIZED PANEL is showing, not a second walk of raw state.
  // Every hole this closes existed because the approve payload rebuilt the
  // takeoff by hand while computeTakeoffRows() - the one function the panel
  // and the CSV already share - was never consulted, so the operator's number
  // reached the screen and never the export. Deriving from it is what makes
  // this a structural fix instead of a fifth hand-maintained copy.
  const ovRows = [];
  const ovSrc = computeTakeoffRows();
  {
    const d = ovSrc;
    for (const g of (d ? d.groups : []))
      for (const it of g.items) {
        if (!it.ov) continue;
        ovRows.push({
          label: it.label,
          kind: it.unit === "EA" ? "qty" : "ft",   // the split ovKey() uses
          qty: it.qty,
          unit: it.unit,
          engine_qty: it.auto,
        });
      }
  }
  const scOn = state.result && state.result.scale;
  const scaleOnScreen = (scOn && +scOn.ft_per_paper_inch > 0)
    ? { ft_per_paper_inch: +scOn.ft_per_paper_inch,
        text: scOn.text || null,
        picked_by_reviewer: !!scOn.picked_by_reviewer,
        // the second axis, so the report cannot disagree with this panel
        v_ft_per_paper_inch: state.vScale || null }
    : null;
  const r = await fetch(`/api/job/${state.job}/page/${state.page}/approve`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels, image_dpi: 300, scale: scaleOnScreen,
      // Taken from the ROWS THE PANEL IS SHOWING, like quantity_overrides
      // above and for the same reason: the old builder re-derived the pools
      // from state.result.styles, which knows nothing about chain labels, so
      // a separated line inflated both its own count and its parent's - and
      // only in the export, because the panel counted differently. The value
      // is the DETECTED count; anything the operator typed over it travels in
      // quantity_overrides, so exactly one field says "measured" and one says
      // "typed".
      object_counts: Object.fromEntries(
        (ovSrc ? ovSrc.groups : []).flatMap(g => g.items)
          .filter(it => it.isObj)
          .map(it => [it.label, it.ov && Number.isFinite(it.auto) ? it.auto : it.qty])),
      trades: Object.fromEntries(
        [...new Set([...Object.values(labels), ...state.chainLabels.values(),
                     ...state.extraItems.map(i => i.label)])]
          .filter(Boolean).map(l => [l, tradeFor(l)])),
      excluded_chain_ids: [...state.excluded],
      added_chains: state.result.chains
        .filter(c => c.custom && !state.excluded.has(c.chain_id))
        .map(c => ({ chain_id: c.chain_id, style_id: c.style_id,
          class: c.class, color: c.color, length_pt: c.length_pt,
          points: c.points })),
      // The SAME gate the screen applies. computeTakeoffRows skips a chain on
      // an un-ticked style before it ever reads state.chainLabels, but the
      // server treats a chain label as sufficient authorisation on its own
      // (`body.chain_labels.get(...) or body.labels.get(...)`). So a line the
      // operator had SEPARATED and then un-ticked still exported, still drew
      // on the report overlay, still counted in Length (ft) and still priced -
      // with nothing on screen saying so.
      chain_labels: Object.fromEntries((() => {
        const sid = new Map(state.result.chains.map(c => [c.chain_id, c.style_id]));
        return [...state.chainLabels].filter(([id]) =>
          !state.excluded.has(id) && state.include.get(sid.get(id)));
      })()),
      quantity_overrides: ovRows,
      // The work-area quantity mask, so the export's per-label footage is
      // computed the same zone-clipped way the panel shows it. The server
      // clips with the same segment/rect math (mirrored in _wz_frac) and
      // states counted/excluded in the export - a mask the tally respects
      // but the export ignores would be a silent wrong number.
      work_zones: wzActive() ? state.workZones.map(z => z.slice()) : null,
      extra_items: state.extraItems.map(it => ({
        ...it,
        unit_price: parseFloat(store.getItem(priceKey(it.label)) || "") || null,
      })),
      // free-text lines printed on the face of the report, under the scale
      // statement. Earthwork is the only writer today: a CY figure that is
      // an interpolation has to say so where it is READ, not only in the
      // panel where it was computed. Empty when no earthwork was added.
      notes: ewApproveNotes(),
      prices: Object.fromEntries(
        [...Object.values(labels), ...state.chainLabels.values()]
          .map(l => [l, parseFloat(store.getItem(priceKey(l)) || "") || 0])
          .filter(([, v]) => v > 0 ? true : false)
      ) }),
  });
  if (!r.ok) {
    // The server refuses a scale outside its sanity band (server.py
    // _sane_ft). Nothing was written; show the reason instead of "exported
    // undefined elements", which is what a blind .json() produced.
    let why = `approve failed (${r.status})`;
    try {
      const e = await r.json();
      // FastAPI's validation errors arrive as a LIST OF OBJECTS, and
      // String([{...}]) is "[object Object]" - which is what an operator was
      // shown when an approve was rejected. Say which field and why.
      if (e && Array.isArray(e.detail))
        why = "approve rejected: " + e.detail.map(d =>
          (Array.isArray(d.loc) ? d.loc.filter(x => x !== "body").join(".") + ": " : "")
          + (d.msg || JSON.stringify(d))).join("; ");
      else if (e && e.detail) why = String(e.detail);
    } catch (err) { /* not JSON */ }
    return setStatus(why, "err");
  }
  const j = await r.json();
  // Report the round trip. A correction that silently failed to land is the
  // whole defect this change exists to close, so an override that matched no
  // row turns the line red rather than passing unmentioned.
  const ovN = (j.overrides || []).length;
  const ovW = j.override_warnings || [];
  setStatus(`exported ${j.exported} elements` +
    (j.items ? ` · ${j.items.length} items itemized` : "") +
    (ovN ? ` · ${ovN} quantity you typed ${ovN === 1 ? "is" : "are"} in the export`
         + ` and marked * on the report` : "") +
    (j.scale && j.scale.setBy === "reviewer"
      ? " · footage computed from the scale YOU set, not the engine's"
      : "") +
    (ovW.length ? " — " + ovW.join("  ") : ""),
    ovW.length ? "err" : undefined);
  const a = $("dlLink");
  a.href = url(`/api/job/${state.job}/page/${state.page}/elements`);
  a.hidden = false;
  const rl = $("reportLink");
  rl.href = url(`/api/job/${state.job}/report.pdf`);
  rl.hidden = false;
};

// ---------- legend sheet vocabulary ----------
async function loadLegendVocab(path) {
  const r = await fetch(`/api/job/${state.job}/legend-sheet`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: path || null }),
  });
  if (!r.ok) return setStatus("could not read a legend sheet", "err");
  const j = await r.json();
  state.legendNames = j.names || [];
  const dl = $("legendVocab");
  dl.innerHTML = "";
  for (const n of state.legendNames) {
    const o = document.createElement("option");
    o.value = n;
    dl.appendChild(o);
  }
  renderStyles();
  setStatus(state.legendNames.length
    ? `${state.legendNames.length} names from the legend sheet — pick them in any label box`
    : "no legend sheet found in this document");
}
$("legendBtn").onclick = () => {
  const p = prompt("Legend sheet PDF path (blank = search this document):",
                   $("legendPath").value || "");
  if (p === null) return;
  $("legendPath").value = p;
  loadLegendVocab(p.trim());
};

// ---------- theme ----------
document.documentElement.dataset.theme =
  localStorage.getItem("core-theme") || "dark";
$("themeBtn").onclick = () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("core-theme", next);
};

// ---------- canvas ----------
const cv = $("view"), ctx = cv.getContext("2d");
function resize() {
  cv.width = Math.round(cv.clientWidth * devicePixelRatio);
  cv.height = Math.round(cv.clientHeight * devicePixelRatio);
  fitView();
  draw();
}
addEventListener("resize", resize);
// Browser pinch/zoom changes devicePixelRatio and the visual viewport
// WITHOUT always firing window resize - the canvas buffer then disagrees
// with the element size and the un-repainted band shows a frozen stale
// frame. Track both signals and reallocate.
if (window.visualViewport) {
  visualViewport.addEventListener("resize", () => requestAnimationFrame(syncBuffer));
  visualViewport.addEventListener("scroll", () => requestAnimationFrame(syncBuffer));
}
let _dprWatch = null;
function watchDpr() {
  if (_dprWatch) _dprWatch.removeEventListener("change", onDprChange);
  _dprWatch = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
  _dprWatch.addEventListener("change", onDprChange);
}
function onDprChange() { watchDpr(); syncBuffer(); }
watchDpr();
function syncBuffer() {
  const w = Math.round(cv.clientWidth * devicePixelRatio);
  const h = Math.round(cv.clientHeight * devicePixelRatio);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  draw();
}

function fitOnLoad() { state.img = null; draw(); }
function fitView() {
  if (!state.img) return;
  const kx = cv.clientWidth / state.img.width, ky = cv.clientHeight / state.img.height;
  state.view.k = Math.min(kx, ky) * 0.97;
  state.view.x = (cv.clientWidth - state.img.width * state.view.k) / 2;
  state.view.y = (cv.clientHeight - state.img.height * state.view.k) / 2;
}

function draw() {
  // buffer may lag the element across browser zoom - resync before painting
  const bw = Math.round(cv.clientWidth * devicePixelRatio);
  const bh = Math.round(cv.clientHeight * devicePixelRatio);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  // clear the WHOLE buffer in raw pixels: a viewport-relative clear leaves
  // stale bands whenever devicePixelRatio moved between frames
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  $("hint").style.display = state.img ? "none" : "";
  if (!state.img) return;
  const { x, y, k } = state.view;
  ctx.save();
  ctx.translate(x, y); ctx.scale(k, k);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, state.img.width, state.img.height);
  ctx.drawImage(state.img, 0, 0);
  if (state.result) {
    // dim the sheet toward white so detected colors pop like ink on paper
    ctx.globalAlpha = 0.62;
    ctx.fillRect(0, 0, state.img.width, state.img.height);
    ctx.globalAlpha = 1.0;
  }
  // filled AREA regions, under the linework: an estimator must SEE the
  // polygon whose square footage is being billed, not just a number
  if (state.result && arData()) {
    const fA = IMG_DPI / 72;
    for (const g of arData().groups) {
      const on = state.areaInc.get(g.group_id);
      const hot = state.areaHot === g.group_id;
      if (!on && !hot) continue;
      ctx.fillStyle = hot ? AR_HOT : AR_COLOR;
      ctx.strokeStyle = hot ? AR_HOT : AR_COLOR;
      ctx.lineWidth = (hot ? 2.2 : 1.4) / k;
      ctx.globalAlpha = hot ? 0.38 : 0.22;
      for (const reg of arRegionsOf(g)) {
        const p = reg.points;
        if (!p || p.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(p[0][0] * fA, p[0][1] * fA);
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0] * fA, p[i][1] * fA);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = hot ? 0.95 : 0.75;
        ctx.stroke();
        ctx.globalAlpha = hot ? 0.38 : 0.22;
      }
    }
    ctx.globalAlpha = 1.0;
  }
  // state.result gate: on a page switch state.ew outlives the old result
  // until the new one lands (which resets it) - without the gate the old
  // page's map would paint over the new page's image in that window
  if (state.result && state.ew && state.ew.map && state.ew.map.img) {
    // cut/fill map under the linework: the PNG is one pixel per grid
    // cell, stretched to its page-pt bbox (pt -> image px like the chains)
    const fm = IMG_DPI / 72;
    const [bx0, by0, bx1, by1] = state.ew.map.bbox;
    ctx.globalAlpha = 0.55;
    ctx.drawImage(state.ew.map.img, bx0 * fm, by0 * fm, (bx1 - bx0) * fm, (by1 - by0) * fm);
    ctx.globalAlpha = 1.0;
  }
  // GRADING ZONES: each saved zone's dz map, clipped to its own polygon so
  // the tint reads as the zone, not the zone's bounding box. Same result
  // gate as the ew map above: a stale zone image must not survive a page
  // switch (gzPageReset clears them at both chokepoints anyway).
  if (state.result && state.gzones.length) {
    const fg = IMG_DPI / 72;
    for (const z of state.gzones) {
      if (!z.img || !z.result || !z.result.bbox) continue;
      const [zx0, zy0, zx1, zy1] = z.result.bbox;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(z.polygon[0][0] * fg, z.polygon[0][1] * fg);
      for (let i = 1; i < z.polygon.length; i++)
        ctx.lineTo(z.polygon[i][0] * fg, z.polygon[i][1] * fg);
      ctx.closePath();
      ctx.clip();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(z.img, zx0 * fg, zy0 * fg,
                    (zx1 - zx0) * fg, (zy1 - zy0) * fg);
      ctx.restore();
      ctx.globalAlpha = 1.0;
    }
  }
  if (state.result) {
    const f = IMG_DPI / 72; // pt -> image px
    for (const ch of state.result.chains) {
      const sid = ch.style_id;
      if (state.excluded.has(ch.chain_id)) continue;
      if (state.isolate !== null && sid !== state.isolate) continue;
      if (state.isolate === null && !state.include.get(sid)) continue;
      const hot = state.hot === sid || state.hotChain === ch.chain_id;
      const sel = state.selected === ch.chain_id;
      // marquee members light up in the same magenta family as the single
      // selection, a step thinner so the picked line still reads apart
      const msel = !sel && state.multiSel.size > 0 && state.multiSel.has(ch.chain_id);
      const st2 = state.result.styles.find(x => x.style_id === ch.style_id);
    ctx.globalAlpha = st2 && (st2.texture || st2.class === "annotation") ? 0.25 : 1.0;
    ctx.strokeStyle = (sel || msel) ? "#ff00cc" : cssColor(styleColor(sid), ch.width || (st2 && st2.width));
      // real plotted weight, floored so a hairline stays visible zoomed out
      const wPt = Math.max(ch.width || 0.35, 0.35) * f;
      ctx.lineWidth = sel ? 4.5 / k
        : msel ? 3.2 / k
        : Math.max(hot ? wPt * 2.0 : wPt, 1.4 / k);
      // selection recolors but keeps the true pattern - a solid magenta
      // overlay reads as "this line became solid", which it has not
      const pts = ch.points;
      // seg_counts partitions points into the SOURCE ink marks: draw each
      // mark as its own solid subpath so every dash lands exactly where
      // the sheet printed it. A repeating template can only approximate -
      // its phase drifts off the real bars (the Oncor property-line
      // complaint). Template remains the fallback for chains without mark
      // boundaries (native dash arrays, custom drawn lines, old results).
      if (ch._scOK === undefined)
        ch._scOK = !!(ch.seg_counts &&
          ch.seg_counts.reduce((a, b) => a + b, 0) === pts.length);
      if (state.faithful && ch._scOK && ch.class !== "solid") {
        ctx.setLineDash([]);
        ctx.beginPath();
        let off = 0;
        for (const n of ch.seg_counts) {
          ctx.moveTo(pts[off][0] * f, pts[off][1] * f);
          if (n === 1) ctx.lineTo(pts[off][0] * f + 0.75, pts[off][1] * f);
          for (let i = off + 1; i < off + n; i++)
            ctx.lineTo(pts[i][0] * f, pts[i][1] * f);
          off += n;
        }
        ctx.stroke();
      } else {
        // the chain's own measured period beats any signature-derived
        // reconstruction (a d9/d45 class signature cannot say whether the
        // period has one short or two - the template knows)
        const da = state.faithful
          ? (ch.template && ch.template.length >= 2 ? ch.template
             : dashArray(ch.dash_signature))
          : null;
        ctx.setLineDash(da ? da.map(v => v * f) : []);
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * f, pts[0][1] * f);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * f, pts[i][1] * f);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1.0;
    ctx.setLineDash([]);
  }
  // vertex handles on the selected line
  if (state.selected !== null && state.result) {
    const f2 = IMG_DPI / 72;
    const sel = state.result.chains.find(c => c.chain_id === state.selected);
    if (sel && !state.excluded.has(sel.chain_id)) {
      const rad = 3.5 / k;
      // at low zoom a dense chain's handles overlap into a solid-looking
      // bar (172 rings looked like "the line went solid"); thin them so
      // on-screen spacing stays >= ~14px, always keeping the endpoints
      // and the picked point
      const screenLen = sel.length_pt * f2 * k;
      const step = Math.max(1, Math.ceil(sel.points.length / Math.max(screenLen / 14, 1)));
      sel.points.forEach((q, i) => {
        const on = i === state.selPt;
        if (!on && i !== 0 && i !== sel.points.length - 1 && i % step) return;
        ctx.beginPath();
        ctx.arc(q[0] * f2, q[1] * f2, on ? rad * 1.9 : rad, 0, Math.PI * 2);
        ctx.fillStyle = on ? "#ffd400" : "#ffffff";
        ctx.fill();
        ctx.lineWidth = 1.2 / k;
        ctx.strokeStyle = on ? "#8a6d00" : "#ff00cc";
        ctx.stroke();
      });
    }
  }
  // object-mode styles: box every discrete piece (rotated rect along the
  // run) so a counted object reads as an object, not a continuous line
  if (state.result) {
    const f2 = IMG_DPI / 72;
    // pool object styles by LABEL: the boxes drawn are the components
    // counted - one wall drawn with two pens is one box, and a mostly-
    // annotation style gets cleaned by the pool's fill signal
    const pools = new Map();
    for (const s2 of state.result.styles) {
      if (state.measureMode.get(s2.style_id) !== "object") continue;
      if (state.isolate !== null && s2.style_id !== state.isolate) continue;
      if (state.isolate === null && !state.include.get(s2.style_id)) continue;
      const lab = (state.labels.get(s2.style_id) || "#" + s2.style_id);
      if (!pools.has(lab)) pools.set(lab, { color: s2.color, w: s2.width, sids: [] });
      pools.get(lab).sids.push(s2.style_id);
    }
    for (const pool of pools.values()) {
      ctx.strokeStyle = cssColor(pool.color, pool.w);
      ctx.lineWidth = 1.4 / k;
      ctx.setLineDash([]);
      for (const comp of styleObjects(pool.sids)) {
        // ONE box per counted object: dominant direction from the longest
        // run, extent from every member point - display equals count
        const main = comp.runs.reduce((a, b) => (b.len > a.len ? b : a));
        const a0 = main.pts[0], b0 = main.pts[main.pts.length - 1];
        let ux = b0[0]-a0[0], uy = b0[1]-a0[1];
        const L0 = Math.hypot(ux, uy) || 1;
        ux /= L0; uy /= L0;
        let uMin = Infinity, uMax = -Infinity, nMin = Infinity, nMax = -Infinity;
        for (const r of comp.runs) {
          for (const q of r.pts) {
            const du = (q[0]-a0[0])*ux + (q[1]-a0[1])*uy;
            const dn = -(q[0]-a0[0])*uy + (q[1]-a0[1])*ux;
            if (du < uMin) uMin = du; if (du > uMax) uMax = du;
            if (dn < nMin) nMin = dn; if (dn > nMax) nMax = dn;
          }
        }
        const pad = 3.0;
        uMin -= pad; uMax += pad; nMin -= pad + 1; nMax += pad + 1;
        const P = (u, n) => [(a0[0] + ux*u - uy*n) * f2,
                             (a0[1] + uy*u + ux*n) * f2];
        const c1 = P(uMin, nMin), c2 = P(uMax, nMin),
              c3 = P(uMax, nMax), c4 = P(uMin, nMax);
        ctx.beginPath();
        ctx.moveTo(...c1); ctx.lineTo(...c2); ctx.lineTo(...c3);
        ctx.lineTo(...c4); ctx.closePath();
        ctx.stroke();
      }
    }
    // door/opening zones, faint - the takeoff never measures through these
    const opens2 = state.result.openings || [];
    if (opens2.length) {
      ctx.setLineDash([3 / k, 3 / k]);
      ctx.strokeStyle = "rgba(160,120,40,.55)";
      ctx.lineWidth = 1 / k;
      for (const o of opens2) {
        ctx.beginPath();
        ctx.arc(o.cx * f2, o.cy * f2, o.r * f2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }
  // WORK AREA quantity mask: everything OUTSIDE the union of drawn boxes
  // washes toward paper - same treatment the sheet raster already gets so
  // detected ink pops - and the boxes themselves draw as faint outlines.
  // Painted AFTER the linework so outside-zone lines read dimmed the way
  // texture/annotation styles do; nothing is removed from the canvas, only
  // muted, because the mask changes what COUNTS, not what was detected.
  if (state.result && (wzActive() || state.wzDrag)) {
    const fz = IMG_DPI / 72;
    if (wzActive()) {
      const zonesPx = state.workZones.map(
        z => [z[0] * fz, z[1] * fz, z[2] * fz, z[3] * fz]);
      ctx.fillStyle = "rgba(255,255,255,0.62)";
      for (const rc of wzComplementRects(zonesPx, state.img.width, state.img.height))
        ctx.fillRect(rc[0], rc[1], rc[2] - rc[0], rc[3] - rc[1]);
      ctx.strokeStyle = "rgba(14,138,95,0.85)";
      ctx.lineWidth = 1.6 / k;
      ctx.setLineDash([7 / k, 5 / k]);
      for (const z of zonesPx)
        ctx.strokeRect(z[0], z[1], z[2] - z[0], z[3] - z[1]);
      ctx.setLineDash([]);
    }
    if (state.wzDrag) {
      const a = state.wzDrag.a, b = state.wzDrag.b;
      ctx.strokeStyle = "#0e8a5f";
      ctx.lineWidth = 1.8 / k;
      ctx.setLineDash([5 / k, 4 / k]);
      ctx.strokeRect(Math.min(a[0], b[0]) * fz, Math.min(a[1], b[1]) * fz,
                     Math.abs(b[0] - a[0]) * fz, Math.abs(b[1] - a[1]) * fz);
      ctx.setLineDash([]);
    }
  }
  // marquee multi-select box, while the Shift+drag is in flight
  if (state.marquee) {
    const fq = IMG_DPI / 72;
    const a = state.marquee.a, b = state.marquee.b;
    const rx = Math.min(a[0], b[0]) * fq, ry = Math.min(a[1], b[1]) * fq;
    const rw = Math.abs(b[0] - a[0]) * fq, rh = Math.abs(b[1] - a[1]) * fq;
    ctx.fillStyle = "rgba(255,0,204,0.07)";
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = "#ff00cc";
    ctx.lineWidth = 1.6 / k;
    ctx.setLineDash([6 / k, 4 / k]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);
  }
  // cut-span first anchor
  if (state.tool === "cutspan" && state.cutA) {
    const f2 = IMG_DPI / 72;
    ctx.beginPath();
    ctx.arc(state.cutA.q[0] * f2, state.cutA.q[1] * f2, 5 / k, 0, Math.PI * 2);
    ctx.fillStyle = "#e0245e"; ctx.fill();
    ctx.lineWidth = 1.5 / k; ctx.strokeStyle = "#ffffff"; ctx.stroke();
  }
  // in-progress drawn line
  if (state.tool === "ew-bound-draw" && state.ewBoundDraft.length) {
    const f2b = IMG_DPI / 72;
    ctx.save();
    ctx.strokeStyle = "rgba(67,160,71,.95)";
    ctx.lineWidth = 2 / state.view.k;
    ctx.setLineDash([8 / state.view.k, 5 / state.view.k]);
    ctx.beginPath();
    ctx.moveTo(state.ewBoundDraft[0][0] * f2b, state.ewBoundDraft[0][1] * f2b);
    for (let i = 1; i < state.ewBoundDraft.length; i++)
      ctx.lineTo(state.ewBoundDraft[i][0] * f2b, state.ewBoundDraft[i][1] * f2b);
    if (state.ewBoundHover && !panning)
      ctx.lineTo(state.ewBoundHover[0] * f2b, state.ewBoundHover[1] * f2b);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const q of state.ewBoundDraft) {
      ctx.beginPath();
      ctx.arc(q[0] * f2b, q[1] * f2b, 4 / state.view.k, 0, Math.PI * 2);
      ctx.fillStyle = "#43a047";
      ctx.fill();
    }
    ctx.restore();
  }
  // grading zone: in-progress hand-drawn outline (same grammar as the
  // limit of work above, purple so the two drafts cannot be confused)
  if (state.tool === "gz-draw" && state.gzDraft.length) {
    const fz = IMG_DPI / 72;
    ctx.save();
    ctx.strokeStyle = "rgba(142,36,170,.95)";
    ctx.lineWidth = 2 / k;
    ctx.setLineDash([8 / k, 5 / k]);
    ctx.beginPath();
    ctx.moveTo(state.gzDraft[0][0] * fz, state.gzDraft[0][1] * fz);
    for (let i = 1; i < state.gzDraft.length; i++)
      ctx.lineTo(state.gzDraft[i][0] * fz, state.gzDraft[i][1] * fz);
    if (state.gzHover && !panning)
      ctx.lineTo(state.gzHover[0] * fz, state.gzHover[1] * fz);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const q of state.gzDraft) {
      ctx.beginPath();
      ctx.arc(q[0] * fz, q[1] * fz, 4 / k, 0, Math.PI * 2);
      ctx.fillStyle = "#8e24aa";
      ctx.fill();
    }
    ctx.restore();
  }
  // grading zone: in-progress box drag
  if (state.gzDrag) {
    const fz = IMG_DPI / 72;
    const a = state.gzDrag.a, b = state.gzDrag.b;
    ctx.strokeStyle = "#8e24aa";
    ctx.lineWidth = 1.8 / k;
    ctx.setLineDash([5 / k, 4 / k]);
    ctx.strokeRect(Math.min(a[0], b[0]) * fz, Math.min(a[1], b[1]) * fz,
                   Math.abs(b[0] - a[0]) * fz, Math.abs(b[1] - a[1]) * fz);
    ctx.setLineDash([]);
  }
  // saved grading zones: outline + centroid badge (+ per-cell dz numbers
  // when the zone's "123" toggle is on). The badge rect is recorded on the
  // zone in page pt so a plain canvas click can reopen its modal.
  if (state.result && state.gzones.length) {
    const fz = IMG_DPI / 72;
    for (const z of state.gzones) {
      const poly = z.polygon;
      ctx.save();
      ctx.strokeStyle = "rgba(142,36,170,.9)";
      ctx.lineWidth = 2 / k;
      ctx.setLineDash([9 / k, 5 / k]);
      ctx.beginPath();
      ctx.moveTo(poly[0][0] * fz, poly[0][1] * fz);
      for (let i = 1; i < poly.length; i++)
        ctx.lineTo(poly[i][0] * fz, poly[i][1] * fz);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      // per-cell dz labels, styled like a grading plan: red = cut
      // (negative), blue = fill (positive). NOTE this is the opposite hue
      // for cut than the tint underneath (the client's map convention is
      // cut BLUE) - the reference aerial's label convention, kept as
      // specified; the panel row's title says which is which.
      if (z.showNums && z.result && z.result.cell_labels
          && z.result.cell_labels.length) {
        const aPt2 = Math.abs(polyAreaPt(poly));
        const bPt = Math.sqrt(aPt2 / z.result.cell_labels.length);
        const fontPx = Math.max(bPt * fz * 0.30, 7 / k);
        ctx.font = `600 ${fontPx}px "IBM Plex Sans", -apple-system, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = fontPx / 5;
        ctx.strokeStyle = "rgba(255,255,255,.85)";
        for (const c of z.result.cell_labels) {
          const dzv = c.dz === 0 ? 0 : c.dz;   // -0.0 reads as a cut of nothing
          const t = (dzv > 0 ? "+" : "") + dzv.toFixed(1);
          ctx.fillStyle = dzv < 0 ? "#c62828" : dzv > 0 ? "#1565c0" : "#5f6a63";
          ctx.strokeText(t, c.x * fz, c.y * fz);
          ctx.fillText(t, c.x * fz, c.y * fz);
        }
      }
      // centroid badge: name + the two volumes an estimator scans for
      const [cx, cy] = gzCentroid(poly);
      const j = z.result;
      const txt = z.err ? `${z.name} · ${z.err}`
        : j ? `${z.name} · cut ${gzK(j.cut_yd3)} / fill ${gzK(j.fill_yd3)} CY`
        : `${z.name} · computing…`;
      const fpx = 12 / k;
      ctx.font = `600 ${fpx}px "IBM Plex Sans", -apple-system, sans-serif`;
      const w = ctx.measureText(txt).width + 12 / k;
      const h = fpx + 10 / k;
      const bx = cx * fz - w / 2, by = cy * fz - h / 2;
      ctx.fillStyle = z.err ? "rgba(122,74,10,.9)" : "rgba(20,24,20,.85)";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, w, h, 4 / k);
      else ctx.rect(bx, by, w, h);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, cx * fz, cy * fz);
      // pt-space hit box for the click-to-reopen
      z._badge = [bx / fz, by / fz, (bx + w) / fz, (by + h) / fz];
      ctx.restore();
    }
  }
  if (state.tool === "drawline" && state.drawPts.length) {
    const f2 = IMG_DPI / 72;
    ctx.beginPath();
    ctx.moveTo(state.drawPts[0][0] * f2, state.drawPts[0][1] * f2);
    for (let i = 1; i < state.drawPts.length; i++)
      ctx.lineTo(state.drawPts[i][0] * f2, state.drawPts[i][1] * f2);
    if (state.hoverPt) ctx.lineTo(state.hoverPt[0] * f2, state.hoverPt[1] * f2);
    ctx.lineWidth = 2 / k;
    ctx.setLineDash([6 / k, 4 / k]);
    ctx.strokeStyle = "#ff00cc";
    ctx.stroke();
    ctx.setLineDash([]);
    for (const q of state.drawPts) {
      ctx.beginPath();
      ctx.arc(q[0] * f2, q[1] * f2, 3.5 / k, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff"; ctx.fill();
      ctx.lineWidth = 1.2 / k; ctx.strokeStyle = "#ff00cc"; ctx.stroke();
    }
  }
  // symbol-instance markers from the Count panel
  if (state.symMarks && state.symMarks.length) {
    const f3 = IMG_DPI / 72;
    ctx.strokeStyle = "#a64dff";
    ctx.lineWidth = 2.2 / k;
    for (const c of state.symMarks) {
      ctx.beginPath();
      ctx.arc(c[0] * f3, c[1] * f3, 11 / k, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (state.measurePts.length) {
    const f = IMG_DPI / 72;
    ctx.strokeStyle = "#b3369a";
    ctx.fillStyle = "#b3369a";
    ctx.lineWidth = 2 / k;
    ctx.setLineDash([7 / k, 5 / k]);
    ctx.beginPath();
    ctx.moveTo(state.measurePts[0][0] * f, state.measurePts[0][1] * f);
    for (let i = 1; i < state.measurePts.length; i++)
      ctx.lineTo(state.measurePts[i][0] * f, state.measurePts[i][1] * f);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of state.measurePts) {
      ctx.beginPath();
      ctx.arc(p[0] * f, p[1] * f, 4 / k, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  drawStructural(ctx, k);
  ctx.restore();
}

// Turn a detected cadence ("d9.0 d42.3 g9.0", "native 3 3") into a canvas
// dash array, so a property line is DRAWN as a property line instead of a
// uniform solid stroke in a colour. Lengths are in pt and get scaled into
// the image-pixel space the canvas draws in.
const dashCache = new Map();
function dashArray(sig) {
  if (dashCache.has(sig)) return dashCache.get(sig);
  let out = null;
  if (sig && sig !== "solid" && sig !== "misc") {
    const toks = String(sig).split(/\s+/);
    if (toks[0] === "native") {
      const nums = toks.slice(1).map(parseFloat).filter(v => isFinite(v) && v > 0);
      out = nums.length ? nums : null;
    } else {
      const ds = [], gs = [];
      for (const t of toks) {
        const v = parseFloat(t.slice(1));
        if (!isFinite(v)) continue;
        if (t[0] === "d") ds.push(v);
        else if (t[0] === "g") gs.push(v);
      }
      if (ds.length) {
        const gap = gs.length ? gs[0] : Math.max(ds[0] * 0.5, 2);
        ds.sort((a, b) => b - a);   // longest mark first, as the legend reads
        out = [];
        for (const d of ds) out.push(Math.max(d, 0.4), Math.max(gap, 0.4));
      }
    }
  }
  dashCache.set(sig, out);
  return out;
}

const styleColorCache = new Map();
function styleColor(sid) {
  if (!styleColorCache.has(sid)) {
    const s = state.result.styles.find(s => s.style_id === sid);
    styleColorCache.set(sid, s ? s.color : null);
  }
  return styleColorCache.get(sid);
}
function cssColor(c, w) {
  if (!c) return "#8f959e";
  const [r, g, b] = c.map(v => Math.round(v * 255));
  // near-white linework draws as the faint grey it visually is on the
  // sheet - at EVERY weight. White ink is invisible on paper: rendering
  // heavy white strokes dark (tried 2026-08-20) painted phantom dash
  // rows and squiggles along the Oncor boundary, because the white w3.3
  // family there is plotter-invisible linework, NOT an outlined core.
  // The truly bold lines (property line) are black ink and need no help.
  if (r > 225 && g > 225 && b > 225) return "#a7adb6";
  return `rgb(${r},${g},${b})`;
}

let panning = null;
let downAt = null;
let dragCap = false;   // one undo snapshot per point-drag, taken on first move
cv.addEventListener("mousedown", (e) => {
  // work-area tool: mousedown STARTS a box, it never pans - the whole
  // gesture is the drag, so the generic pan below must not see it
  if (state.tool === "wz-draw" && state.result) {
    const p = ptFromEvent(e);
    state.wzDrag = { a: p, b: p.slice() };
    return;
  }
  // grading-zone box: same drag grammar as the work area
  if (state.tool === "gz-box" && state.result) {
    const p = ptFromEvent(e);
    state.gzDrag = { a: p, b: p.slice() };
    return;
  }
  // marquee multi-select: Shift+drag boxes whole lines into a selection
  // set. Shift was free (pan never read it), and the gesture only arms when
  // NO tool owns the canvas, so wz-draw/st-draw/gz-box/measure keep their drags.
  if (e.shiftKey && !state.tool && state.result && state.img) {
    const p = ptFromEvent(e);
    state.marquee = { a: p, b: p.slice() };
    return;
  }
  // while a click-tool is armed, clicks land IN the tool - a click on a
  // vertex dot is a cut/draw/measure anchor, never a point-drag
  const v = state.tool ? null : vertexAt(e);
  if (v !== null) {           // grab the handle rather than pan the sheet
    state.selPt = v;
    state.dragPt = true;
    dragCap = false;          // snapshot happens on the first actual move
    updateSelBar(chainById(state.selected));
    draw();
    return;
  }
  panning = { x: e.clientX, y: e.clientY };
  downAt = { x: e.clientX, y: e.clientY };
  cv.classList.add("panning");
});
addEventListener("mousemove", (e) => {
  if (state.wzDrag) {
    state.wzDrag.b = ptFromEvent(e);
    draw();
    return;
  }
  if (state.gzDrag) {
    state.gzDrag.b = ptFromEvent(e);
    draw();
    return;
  }
  if (state.marquee) {
    state.marquee.b = ptFromEvent(e);
    draw();
    return;
  }
  if (state.dragPt) {
    const ch = chainById(state.selected);
    if (ch && state.selPt !== null) {
      if (!dragCap) {   // BEFORE the first mutation of this drag, only once
        captureUndo("point move", [ch.chain_id]);
        dragCap = true;
      }
      const m = ch.custom ? ch : materialize(ch);
      if (m !== ch) { state.selected = m.chain_id; }
      m.points[state.selPt] = ptFromEvent(e);
      draw();
    }
    return;
  }
  if (state.tool === "drawline" && state.drawPts.length && !panning) {
    state.hoverPt = ptFromEvent(e);
    draw();
    return;
  }
  if (!panning) return;
  state.view.x += e.clientX - panning.x; state.view.y += e.clientY - panning.y;
  panning = { x: e.clientX, y: e.clientY };
  draw();
});
addEventListener("mouseup", (e) => {
  if (state.gzDrag) {
    const d = state.gzDrag;
    state.gzDrag = null;
    const x0 = Math.min(d.a[0], d.b[0]), x1 = Math.max(d.a[0], d.b[0]);
    const y0 = Math.min(d.a[1], d.b[1]), y1 = Math.max(d.a[1], d.b[1]);
    // a click is not a zone: same 2 pt floor as the work-area box
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      setStatus("grading zone: DRAG a box (that was a click) — Esc exits the tool", "busy");
      draw();
      return;
    }
    state.tool = null;
    syncCursor();
    draw();
    gzModalOpen(null, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    return;
  }
  if (state.wzDrag) {
    const d = state.wzDrag;
    state.wzDrag = null;
    const x0 = Math.min(d.a[0], d.b[0]), x1 = Math.max(d.a[0], d.b[0]);
    const y0 = Math.min(d.a[1], d.b[1]), y1 = Math.max(d.a[1], d.b[1]);
    // a click is not a box: 2 pt is ~1/36 inch of paper, below any
    // plausible intended work area and above any mouse jitter
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      setStatus("work area: DRAG a box (that was a click) — Esc exits the tool", "busy");
      draw();
      return;
    }
    state.workZones.push([x0, y0, x1, y1]);
    wzChanged();
    wzStatusAfterBox();
    return;
  }
  if (state.marquee) {
    const mq = state.marquee;
    state.marquee = null;
    const x0 = Math.min(mq.a[0], mq.b[0]), x1 = Math.max(mq.a[0], mq.b[0]);
    const y0 = Math.min(mq.a[1], mq.b[1]), y1 = Math.max(mq.a[1], mq.b[1]);
    // a click is not a box - same 2 pt rule as the work-area tool
    if (x1 - x0 < 2 && y1 - y0 < 2) {
      setStatus("multi-select: hold Shift and DRAG a box around whole lines", "busy");
      draw();
      return;
    }
    let added = 0;
    for (const ch of marqueePick([x0, y0, x1, y1]))
      if (!state.multiSel.has(ch.chain_id)) { state.multiSel.add(ch.chain_id); added++; }
    renderMultiBar();
    if (!state.multiSel.size)
      setStatus("no whole line inside that box — a line joins only when it is FULLY inside", "err");
    else
      setStatus(`${added} line(s) added — ${state.multiSel.size} selected `
        + "(Shift+drag adds more, Esc clears)");
    draw();
    return;
  }
  if (state.dragPt) {
    state.dragPt = false;
    dragCap = false;
    const ch = chainById(state.selected);
    if (ch) {
      ch.length_pt = polyLen(ch.points);
      updateSelBar(ch);
      afterEdit(`point moved — line now ${fmtLen(ch.length_pt)}`);
    }
    return;
  }
  cv.classList.remove("panning");
  const wasClick = panning && downAt &&
    Math.abs(e.clientX - downAt.x) < 4 && Math.abs(e.clientY - downAt.y) < 4;
  panning = null;
  if (wasClick && state.result && state.img) handleCanvasClick(e);
});

function ptFromEvent(e) {
  const r = cv.getBoundingClientRect();
  const { x, y, k } = state.view;
  const f = IMG_DPI / 72;
  return [((e.clientX - r.left) - x) / k / f, ((e.clientY - r.top) - y) / k / f];
}

// index of the selected line's vertex under the cursor, or null
function vertexAt(e) {
  if (state.selected === null) return null;
  const ch = chainById(state.selected);
  if (!ch) return null;
  const [px, py] = ptFromEvent(e);
  const f = IMG_DPI / 72;
  const tol = 7 / state.view.k / f + 1.5;
  let best = null, bestD = tol;
  ch.points.forEach((q, i) => {
    const d = Math.hypot(px - q[0], py - q[1]);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// MERGE. The detector breaks one physical run into several chains wherever
// the sheet interrupts it - a label sitting in the line, or another line
// crossing it, where the drafter leaves a real gap so the crossing reads.
// Measured on SWR Guide Civil p8: 29 such breaks, 27 of them a genuinely
// empty gap on the line's own layer. Bridging those automatically is a
// separate job; this is the operator's version, for the ones automation will
// not catch.
//
// THE BRIDGED SPAN COUNTS. Two 100 ft pieces either side of a 5 ft label are
// 205 ft of pipe, not 200 - the run continues under the label. Concatenating
// without the gap would quietly under-measure every merge, so the span is
// added and the status line says how much, every time.
function mergeClick(px, py) {
  const fR = IMG_DPI / 72;
  const tolR = 6 / state.view.k / fR * 4 + 1.5;
  let tgt = null, tgtD = tolR;
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id) || ch.chain_id === state.selected) continue;
    if (state.isolate !== null ? ch.style_id !== state.isolate
                               : !state.include.get(ch.style_id)) continue;
    for (let i = 1; i < ch.points.length; i++) {
      const d = distToSeg(px, py, ch.points[i - 1], ch.points[i]);
      if (d < tgtD) { tgtD = d; tgt = ch; }
    }
  }
  const sel = chainById(state.selected);
  if (!tgt || !sel) {
    setStatus("merge: click the other half of the run", "err");
    return;
  }
  // Refuse across families rather than silently picking a winner: a merge
  // that moved footage from one priced item to another without saying so is
  // the kind of quiet wrong number this project keeps having to hunt down.
  if (tgt.style_id !== sel.style_id) {
    const la = state.labels.get(sel.style_id) || "this family";
    const lb = state.labels.get(tgt.style_id) || "that family";
    setStatus(`those are different families (${la} / ${lb}) \u2014 `
      + "use Reclassify (R) first, then merge", "err");
    return;
  }

  // Join the two NEAREST ends, whichever they are, reversing as needed. The
  // wrong pairing would double the line back on itself and invent footage.
  const A = sel.points, B = tgt.points;
  const a0 = A[0], a1 = A[A.length - 1];
  const b0 = B[0], b1 = B[B.length - 1];
  const hyp = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const opts = [
    { d: hyp(a1, b0), revA: false, revB: false },
    { d: hyp(a1, b1), revA: false, revB: true },
    { d: hyp(a0, b0), revA: true, revB: false },
    { d: hyp(a0, b1), revA: true, revB: true },
  ].sort((x, y) => x.d - y.d);
  const best = opts[0];

  // A far click is more likely a mis-click than an intended merge, so ask -
  // but only when the bridge is a real fraction of what is being joined, or
  // the prompt fires on every ordinary 5 pt label gap and stops being read.
  const combined = (sel.length_pt || 0) + (tgt.length_pt || 0);
  if (best.d > 20 && best.d > 0.2 * combined) {
    if (!confirm(`Those two ends are ${fmtLen(best.d)} apart.\n\n`
      + `Merging adds that span to the measured length, because a merged run `
      + `is treated as continuous. If they are not two halves of the same `
      + `line, cancel.\n\nMerge anyway?`)) {
      setStatus("merge cancelled");
      return;
    }
  }

  captureUndo(`merge of 2 lines — ${fmtQty(combined + best.d)}`,
    [sel.chain_id, tgt.chain_id]);
  const c = materialize(sel);
  const pa = c.points.map(p => p.slice());
  if (best.revA) pa.reverse();
  const pb = B.map(p => p.slice());
  if (best.revB) pb.reverse();
  c.points = pa.concat(pb);
  c.length_pt = combined + best.d;
  // The absorbed chain leaves the drawing the same way a deleted one does.
  state.excluded.add(tgt.chain_id);

  cancelMerge();
  state.selected = c.chain_id;
  state.selPt = null;
  updateSelBar(c);
  afterEdit(`merged 2 lines into 1 \u2014 ${fmtLen(c.length_pt)} total, `
    + `${fmtLen(best.d)} bridged`);
  renderStyles(); renderChips(); renderMiniLegend();
}

function cancelMerge() {
  state.tool = null;
  $("mergeBtn").classList.remove("active");
}

$("mergeBtn").onclick = () => {
  if (state.selected === null) {
    setStatus("select a line first, then merge it with another", "err");
    return;
  }
  state.tool = "merge";
  $("mergeBtn").classList.add("active");
  setStatus("merge: click the other half of this run (Esc cancels)", "busy");
};

function handleCanvasClick(e) {
  const [px, py] = ptFromEvent(e);
  const { k } = state.view;
  const f = IMG_DPI / 72;
  if (state.tool === "measure") {
    state.measurePts.push([px, py]);
    updateMeasureInfo();
    draw();
    return;
  }
  if (state.tool === "extend" && state.selected !== null) {
    extendTo(px, py);
    return;
  }
  if (state.tool === "cutspan" && state.selected !== null) {
    cutSpanClick(px, py);
    return;
  }
  if (state.tool === "merge" && state.selected !== null) {
    mergeClick(px, py);
    return;
  }
  if (state.tool === "reclass" && state.selected !== null) {
    // click a line of the TARGET family: the selected line joins it -
    // class, pattern, color, label pooling, itemized count, everything
    const fR = IMG_DPI / 72;
    const tolR = 6 / state.view.k / fR * 4 + 1.5;
    let tgt = null, tgtD = tolR;
    for (const ch of state.result.chains) {
      if (state.excluded.has(ch.chain_id) || ch.chain_id === state.selected) continue;
      if (state.isolate !== null ? ch.style_id !== state.isolate
                                 : !state.include.get(ch.style_id)) continue;
      for (let i = 1; i < ch.points.length; i++) {
        const d = distToSeg(px, py, ch.points[i-1], ch.points[i]);
        if (d < tgtD) { tgtD = d; tgt = ch; }
      }
    }
    const sel = chainById(state.selected);
    if (!tgt || !sel) { setStatus("click a line of the family this one belongs to", "err"); return; }
    if (tgt.style_id === sel.style_id) { setStatus("already in that family"); state.tool = null; $("reclassBtn").classList.remove("active"); return; }
    const lab = state.labels.get(tgt.style_id) || "its new family";
    captureUndo(`reclass into ${lab} — ${fmtQty(chainLenPt(sel))}`, [sel.chain_id]);
    const c = reclassCore(sel, tgt.style_id, tgt);
    state.tool = null;
    $("reclassBtn").classList.remove("active");
    state.selected = c.chain_id;
    updateSelBar(c);
    afterEdit(`moved ${fmtLen(c.length_pt)} into ${lab}`);
    renderStyles(); renderChips(); renderMiniLegend();
    return;
  }
  if (state.tool === "drawline") {
    // clicking an existing line endpoint SNAPS there - and if the draw is
    // already underway, it FINISHES the line at that point (the drawn run
    // then fuses with the touched family line in finishDraw)
    const fSnap = IMG_DPI / 72;
    const tolSnap = 7 / state.view.k / fSnap + 1.5;
    let snap = null;
    for (const ch of state.result.chains) {
      if (state.excluded.has(ch.chain_id)) continue;
      if (state.isolate !== null ? ch.style_id !== state.isolate
                                 : !state.include.get(ch.style_id)) continue;
      for (const q of [ch.points[0], ch.points[ch.points.length - 1]]) {
        const d = Math.hypot(px - q[0], py - q[1]);
        if (snap === null || d < snap.d) snap = { d, q };
      }
    }
    const pt = (snap && snap.d <= tolSnap) ? [snap.q[0], snap.q[1]] : [px, py];
    state.drawPts.push(pt);
    if (snap && snap.d <= tolSnap && state.drawPts.length >= 2) {
      finishDraw();
      return;
    }
    setStatus(`draw: ${state.drawPts.length} point(s) — click a line end to finish there, or double-click/Enter`, "busy");
    draw();
    return;
  }
  // clicking a vertex of the already-selected line picks THAT point, so a
  // single bad kink can be removed without discarding the whole line
  const v = vertexAt(e);
  if (v !== null) {
    state.selPt = state.selPt === v ? null : v;
    updateSelBar(chainById(state.selected));
    draw();
    return;
  }
  const tolPt = 6 / k / f * 4 + 1.5; // generous when zoomed out
  let best = null, bestD = tolPt;
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (state.isolate !== null && ch.style_id !== state.isolate) continue;
    if (state.isolate === null && !state.include.get(ch.style_id)) continue;
    const pts = ch.points;
    for (let i = 1; i < pts.length; i++) {
      const d = distToSeg(px, py, pts[i-1], pts[i]);
      if (d < bestD) { bestD = d; best = ch; }
    }
  }
  state.selected = best && state.selected !== best.chain_id ? best.chain_id : null;
  state.selPt = null;
  state.clickPt = state.selected !== null ? [px, py] : null;
  updateSelBar(best && state.selected !== null ? best : null);
  draw();
}

// ---------- line toolkit: split / extend / separate / measure ----------
function chainById(id) {
  return state.result.chains.find(c => c.chain_id === id) || null;
}
function polyLen(ps) {
  let L = 0;
  for (let i = 1; i < ps.length; i++)
    L += Math.hypot(ps[i][0] - ps[i-1][0], ps[i][1] - ps[i-1][1]);
  return L;
}
// editing an original detection = exclude it and work on a copy, so the
// server export sees the edit (copy travels in added_chains)
function materialize(ch) {
  if (ch.custom) return ch;
  state.excluded.add(ch.chain_id);
  const clone = JSON.parse(JSON.stringify(ch));
  clone.chain_id = state.nextChainId++;
  clone.custom = true;
  // an edited clone's points diverge from the engine's mark partition -
  // drop it so the render falls back to the template, never a stale map
  delete clone.seg_counts; delete clone._scOK;
  if (state.chainLabels.has(ch.chain_id))
    state.chainLabels.set(clone.chain_id, state.chainLabels.get(ch.chain_id));
  state.result.chains.push(clone);
  return clone;
}
function afterEdit(msg) {
  $("restoreBtn").hidden = false;
  // an edit can move a chain's geometry without changing its id (point
  // drag, extend), so the work-area inside-fraction memo must not survive
  // it; wzRev is part of that memo's key
  state.wzRev++;
  setStatus(msg);
  renderItemized();
  renderMultiBar();   // an edit can consume a multi-selected chain; the
                      // bar's count and footage must not go stale
  draw();
}

function splitSelected() {
  const ch = state.selected !== null && chainById(state.selected);
  if (!ch || !state.clickPt) return;
  const pts = ch.points;
  // nearest point on the chain to where the user clicked
  let bi = 1, bq = null, bd = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i-1], b = pts[i];
    const dx = b[0]-a[0], dy = b[1]-a[1], L2 = dx*dx + dy*dy;
    let t = L2 ? ((state.clickPt[0]-a[0])*dx + (state.clickPt[1]-a[1])*dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0]+t*dx, a[1]+t*dy];
    const d = Math.hypot(state.clickPt[0]-q[0], state.clickPt[1]-q[1]);
    if (d < bd) { bd = d; bi = i; bq = q; }
  }
  const ptsA = pts.slice(0, bi).concat([bq]);
  const ptsB = [bq].concat(pts.slice(bi));
  if (polyLen(ptsA) < 0.5 || polyLen(ptsB) < 0.5)
    return setStatus("click further from the end of the line to split it");
  captureUndo(`split of a ${fmtQty(chainLenPt(ch))} line`, [ch.chain_id]);
  const full = polyLen(pts) || 1;
  const mk = (p) => {
    const c = JSON.parse(JSON.stringify(ch));
    c.chain_id = state.nextChainId++;
    c.custom = true;
    delete c.seg_counts; delete c._scOK;
    c.points = p;
    c.length_pt = ch.length_pt * polyLen(p) / full;
    if (state.chainLabels.has(ch.chain_id))
      state.chainLabels.set(c.chain_id, state.chainLabels.get(ch.chain_id));
    state.result.chains.push(c);
    return c;
  };
  if (ch.custom)
    state.result.chains.splice(state.result.chains.indexOf(ch), 1);
  else
    state.excluded.add(ch.chain_id);
  mk(ptsA); mk(ptsB);
  state.selected = null; state.clickPt = null;
  updateSelBar(null);
  afterEdit("split into 2 lines — click the piece you don't want and press ⌫");
}
$("splitBtn").onclick = splitSelected;

$("extendBtn").onclick = () => {
  if (state.selected === null) return;
  state.tool = "extend";
  setStatus("click where the line should extend to (Esc cancels)", "busy");
};
function extendTo(px, py) {
  captureUndo("extend", [state.selected]);
  const ch = materialize(chainById(state.selected));
  const pts = ch.points;
  const dFirst = Math.hypot(px - pts[0][0], py - pts[0][1]);
  const dLast = Math.hypot(px - pts[pts.length-1][0], py - pts[pts.length-1][1]);
  if (dFirst < dLast) pts.unshift([px, py]); else pts.push([px, py]);
  ch.length_pt += Math.min(dFirst, dLast);
  state.selected = ch.chain_id;
  state.tool = null;
  updateSelBar(ch);
  afterEdit(`extended by ${fmtLen(Math.min(dFirst, dLast))}`);
}

// nearest on-path position on a chain; snaps onto a vertex ("the dots")
// when the click lands within snapTol of one
function projectOnChain(ch, px, py, snapTol) {
  const pts = ch.points;
  let bi = 1, bq = null, bd = Infinity, arc = 0, bArc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i-1], b = pts[i];
    const dx = b[0]-a[0], dy = b[1]-a[1], L2 = dx*dx + dy*dy;
    let t = L2 ? ((px-a[0])*dx + (py-a[1])*dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0]+t*dx, a[1]+t*dy];
    const d = Math.hypot(px-q[0], py-q[1]);
    const seg = Math.sqrt(L2);
    if (d < bd) { bd = d; bi = i; bq = q; bArc = arc + t * seg; }
    arc += seg;
  }
  if (snapTol) {
    let vb = null, vd = snapTol, vArc = 0, run = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i) run += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
      const d = Math.hypot(px-pts[i][0], py-pts[i][1]);
      if (d < vd) { vd = d; vb = i; vArc = run; }
    }
    if (vb !== null)
      return { i: Math.max(1, vb), q: pts[vb].slice(), arc: vArc };
  }
  return { i: bi, q: bq, arc: bArc };
}

$("cutSpanBtn").onclick = () => {
  if (state.selected === null) return;
  state.tool = "cutspan"; state.cutA = null;
  $("cutSpanBtn").classList.add("active");
  setStatus("cut: click where the span to REMOVE starts (Esc cancels)", "busy");
};
function cancelCut() {
  state.tool = null; state.cutA = null;
  $("cutSpanBtn").classList.remove("active");
}
function cutSpanClick(px, py) {
  const ch = chainById(state.selected);
  if (!ch) { cancelCut(); return; }
  const f = IMG_DPI / 72;
  const hit = projectOnChain(ch, px, py, 7 / state.view.k / f + 1.5);
  if (!state.cutA) {
    state.cutA = hit;
    setStatus("cut: now click where the span ends", "busy");
    draw();
    return;
  }
  let A = state.cutA, B = hit;
  if (A.arc > B.arc) { const t = A; A = B; B = t; }
  const pts = ch.points;
  const full = polyLen(pts) || 1;
  const sides = [pts.slice(0, A.i).concat([A.q]), [B.q].concat(pts.slice(B.i))]
    .filter(p => polyLen(p) >= 0.5);
  const removed = full - sides.reduce((t, p) => t + polyLen(p), 0);
  if (removed < 0.5) {
    cancelCut(); updateSelBar(ch); draw();
    return setStatus("those two points touch — nothing to cut", "err");
  }
  captureUndo(`cut of ${fmtQty(removed)} out of a line`, [ch.chain_id]);
  const mk = (p) => {
    const c = JSON.parse(JSON.stringify(ch));
    c.chain_id = state.nextChainId++;
    c.custom = true;
    delete c.seg_counts; delete c._scOK;
    c.points = p;
    c.length_pt = ch.length_pt * polyLen(p) / full;
    if (state.chainLabels.has(ch.chain_id))
      state.chainLabels.set(c.chain_id, state.chainLabels.get(ch.chain_id));
    state.result.chains.push(c);
  };
  if (ch.custom)
    state.result.chains.splice(state.result.chains.indexOf(ch), 1);
  else
    state.excluded.add(ch.chain_id);
  sides.forEach(mk);
  state.selected = null; state.selPt = null; state.clickPt = null;
  cancelCut();
  updateSelBar(null);
  afterEdit(`cut ${fmtLen(removed)} out — ${sides.length} piece(s) remain`);
}

$("drawBtn").onclick = () => {
  const ch = state.selected !== null && chainById(state.selected);
  if (!ch)
    return setStatus("select a line of the family to draw into, then hit draw", "err");
  state.tool = "drawline"; state.drawPts = []; state.drawSrc = ch.chain_id;
  state.hoverPt = null;
  $("drawBtn").classList.add("active");
  setStatus("draw: click points — double-click or Enter finishes, Esc backs up", "busy");
};
function cancelDraw() {
  state.tool = null; state.drawPts = []; state.drawSrc = null; state.hoverPt = null;
  $("drawBtn").classList.remove("active");
}
function finishDraw() {
  const src = chainById(state.drawSrc);
  const pts = [];
  for (const q of state.drawPts)
    if (!pts.length ||
        Math.hypot(q[0]-pts[pts.length-1][0], q[1]-pts[pts.length-1][1]) > 0.5)
      pts.push(q);
  if (!src || pts.length < 2) {
    cancelDraw(); draw();
    return setStatus("draw cancelled — a line needs at least two points", "err");
  }
  // when an end of the drawn run lands on an endpoint of a same-family
  // line, this is an EXTENSION: fuse into one line (either end works,
  // and both ends can bridge two lines into one)
  const fT = IMG_DPI / 72;
  const tolT = 7 / state.view.k / fT + 1.5;
  const endMatch = (pt, skip) => {
    for (const ch of state.result.chains) {
      if (state.excluded.has(ch.chain_id) || ch.style_id !== src.style_id) continue;
      if (skip && ch.chain_id === skip) continue;
      const P = ch.points;
      if (Math.hypot(pt[0] - P[0][0], pt[1] - P[0][1]) <= tolT)
        return { ch, at: 0 };
      if (Math.hypot(pt[0] - P[P.length-1][0], pt[1] - P[P.length-1][1]) <= tolT)
        return { ch, at: 1 };
    }
    return null;
  };
  const head = endMatch(pts[0], null);
  let tail = endMatch(pts[pts.length - 1], head ? head.ch.chain_id : null);
  // BEFORE consume() excludes the fused ends; a plain draw touches no
  // existing chain and snapshots nothing but the id counter
  captureUndo("drawn line",
    [head ? head.ch.chain_id : null, tail ? tail.ch.chain_id : null]);
  let merged = pts, label = null, fused = 0;
  const consume = (m) => {
    if (!m.ch.custom) state.excluded.add(m.ch.chain_id);
    else state.excluded.add(m.ch.chain_id);
    label = label || state.chainLabels.get(m.ch.chain_id) || null;
    fused += 1;
  };
  if (head) {
    const P = head.ch.points;
    merged = (head.at === 1 ? P : [...P].reverse()).concat(merged.slice(1));
    consume(head);
  }
  if (tail) {
    const P = tail.ch.points;
    merged = merged.slice(0, -1).concat(tail.at === 0 ? P : [...P].reverse());
    consume(tail);
  }
  const c = JSON.parse(JSON.stringify(src));  // inherits the family's style/pattern
  c.chain_id = state.nextChainId++;
  c.custom = true;
  delete c.seg_counts; delete c._scOK;
  c.points = merged;
  c.length_pt = polyLen(merged);
  if (label) state.chainLabels.set(c.chain_id, label);
  state.result.chains.push(c);
  state.selected = c.chain_id; state.selPt = null;
  cancelDraw();
  updateSelBar(c);
  afterEdit(fused
    ? `extended the line — now ${fmtLen(c.length_pt)}`
    : `drew ${fmtLen(c.length_pt)} into the family`);
}

$("reclassBtn").onclick = () => {
  const ch = state.selected !== null && chainById(state.selected);
  if (!ch)
    return setStatus("select the misclassified line first, then hit reclassify", "err");
  state.tool = state.tool === "reclass" ? null : "reclass";
  $("reclassBtn").classList.toggle("active", state.tool === "reclass");
  setStatus(state.tool === "reclass"
    ? "reclassify: click a line of the family this one SHOULD belong to (Esc cancels)"
    : "reclassify cancelled");
};

$("sepBtn").onclick = () => {
  const ch = state.selected !== null && chainById(state.selected);
  if (!ch) return;
  const current = state.chainLabels.get(ch.chain_id) ||
    state.labels.get(ch.style_id) || "";
  const name = prompt("Name for this line (its own row + price):",
    current ? current + " — separated" : "separated line");
  if (!name) return;
  captureUndo(`separate as "${name.trim()}"`, [ch.chain_id]);
  state.chainLabels.set(ch.chain_id, name.trim());
  updateSelBar(ch);
  afterEdit(`"${name.trim()}" now has its own itemized row`);
};

$("faithfulBtn").onclick = () => {
  state.faithful = !state.faithful;
  $("faithfulBtn").classList.toggle("active", state.faithful);
  setStatus(state.faithful ? "drawing true line patterns" : "drawing bold uniform strokes");
  draw();
};

$("measureBtn").onclick = () => {
  const on = state.tool === "measure";
  state.tool = on ? null : "measure";
  if (on) { state.measurePts = []; $("measureInfo").hidden = true; }
  $("measureBtn").classList.toggle("active", !on);
  setStatus(on ? "" : "measure: click points on the sheet; Esc to finish");
  draw();
};
function updateMeasureInfo() {
  const info = $("measureInfo");
  if (state.measurePts.length < 2) { info.hidden = true; return; }
  const pt = polyLen(state.measurePts);
  const sc = state.result && state.result.scale;
  info.innerHTML = "";
  const read = document.createElement("span");
  read.textContent = sc
    ? `${(pt / 72 * sc.ft_per_paper_inch).toFixed(1)} ft`
    : fmtLen(pt);
  info.appendChild(read);
  // Calibrate the sheet from this line. Jeff Ellis (ECI Foundations,
  // feedback 2026-08-27, BLOCKED): "The selected line should be 24' but is
  // showing 9'. I wonder if you can make it so that the scale can be entered
  // manually based on a selected line." The operator measures something whose
  // true dimension they know, types that dimension, and the page scale is
  // DERIVED: ft_per_paper_inch = true_feet / measured_inches. It commits
  // through applyTypedScale - the same single path as the typed-scale box -
  // so it records as reviewer-set, travels in the approve payload, and lands
  // in the p<N>_scale.json sidecar like any other human scale decision.
  if (state.result && pt > 1e-6) {
    const sep = document.createElement("span");
    sep.className = "cal-sep";
    sep.textContent = " · should be ";
    const inp = document.createElement("input");
    inp.type = "number"; inp.step = "any"; inp.min = "0";
    inp.className = "cal-ft"; inp.name = "calibrate-ft";
    inp.placeholder = "true ft";
    const go = document.createElement("button");
    go.className = "mini"; go.textContent = "set scale";
    go.title = "Derive the page scale from this line: the feet you typed "
      + "divided by the inches of paper the line spans.";
    const commit = () => {
      const trueFt = parseFloat(inp.value);
      if (!(trueFt > 0)) { inp.focus(); return; }
      const ft = trueFt / (pt / 72);
      if (!scaleSane(ft)) {
        setStatus(`refusing ${ft.toFixed(3)} ft per inch - outside the sane `
          + `band (${SCALE_FT_MIN}-${SCALE_FT_MAX}). Check the line and the `
          + `feet you typed.`);
        return;
      }
      applyTypedScale(ft, `${trueFt}' over a measured line`);
      setStatus(`scale CALIBRATED: this line = ${trueFt} ft, so 1 inch = `
        + `${ft.toFixed(2)} ft. Every quantity on this sheet recalculated. `
        + `The line now reads ${trueFt} ft - confirm that, then spot-check `
        + `one other known dimension.`);
      updateMeasureInfo();   // the reading flips to the typed feet - the
                             // operator's own confirmation the math landed
    };
    go.onclick = commit;
    inp.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      e.stopPropagation();   // keep review shortcuts off a focused input
    };
    info.append(sep, inp, document.createTextNode(" ft "), go);
  }
  info.hidden = false;
}

function distToSeg(px, py, a, b) {
  const dx = b[0]-a[0], dy = b[1]-a[1];
  const L2 = dx*dx + dy*dy;
  let t = L2 ? ((px-a[0])*dx + (py-a[1])*dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0]+t*dx, qy = a[1]+t*dy;
  return Math.hypot(px-qx, py-qy);
}

// contour elevations, read once per page off the sheet's own labels
// (the earthwork reader already pairs them); selecting a topo line then
// shows its elevation without opening any panel
async function ensureElev() {
  if (state.elevMap !== undefined) return;
  state.elevMap = undefined;
  state.elevMap = null;  // in flight
  try {
    const r = await fetch(`/api/job/${state.job}/page/${state.page}/earthwork/suggest`);
    state.elevMap = r.ok
      ? new Map((await r.json()).suggestions.map(s => [s.chain_id, s.z]))
      : new Map();
  } catch { state.elevMap = new Map(); }
  if (state.selected !== null) updateSelBar(chainById(state.selected));
}
function updateSelBar(ch) {
  for (const id of ["splitBtn", "extendBtn", "sepBtn", "cutSpanBtn", "drawBtn"])
    $(id).disabled = !ch;
  $("removeBtn").disabled = !ch;
  if (!ch) { $("selInfo").textContent = ""; return; }
  const st = state.result.styles.find(s => s.style_id === ch.style_id);
  const label = state.chainLabels.get(ch.chain_id) ||
    state.labels.get(ch.style_id) || (st && st.suggested_label) || "";
  const pt = state.selPt !== null
    ? ` · point ${state.selPt + 1}/${ch.points.length} selected`
    : ` · ${ch.points.length} points`;
  if (state.elevMap === undefined) ensureElev();
  const z = state.elevMap instanceof Map ? state.elevMap.get(ch.chain_id) : undefined;
  const el = z !== undefined ? ` · EL ${z}` : "";
  // the length here is the line's GEOMETRY; when a work area is drawn and
  // this line crosses its edge, say what part of it actually counts
  const wf = wzChainFrac(ch);
  const wz = (wzActive() && wf < 1)
    ? (wf > 0 ? ` · ${fmtQty(chainCountedPt(ch))} in work area`
              : " · outside work area (counts 0)")
    : "";
  const info = $("selInfo");
  info.textContent = "";
  const txt = document.createElement("span");
  txt.className = "sel-txt";
  txt.textContent = `${ch.class} · ${label} · ${fmtQty(chainLenPt(ch))}${wz}${pt}${el}`;
  info.appendChild(txt);
  // family switcher, right on the bar: the SAME mutation the Reclassify
  // tool ends in (reclassCore), without the pick-click trip across the
  // canvas. Listed by footage so the family you want is near the top.
  const fam = familySelect(ch.style_id, null, (sid) => familySwitch(sid));
  fam.title = "Move this line into another family — same edit as the "
    + "Reclassify tool, and Ctrl+Z undoes it.";
  info.appendChild(fam);
}

function deleteVertex() {
  const ch = chainById(state.selected);
  if (!ch || state.selPt === null) return false;
  if (ch.points.length <= 3) {
    setStatus("too few points left — remove the whole line instead", "err");
    return true;
  }
  captureUndo("point delete", [ch.chain_id]);
  const m = materialize(ch);
  const before = polyLen(m.points);
  m.points.splice(state.selPt, 1);
  const after = polyLen(m.points);
  m.length_pt = m.length_pt * (after / Math.max(before, 1e-9));
  state.selected = m.chain_id;
  state.selPt = Math.min(state.selPt, m.points.length - 1);
  updateSelBar(m);
  afterEdit(`point removed — line now ${fmtLen(m.length_pt)}`);
  return true;
}

// Update the rows IN PLACE rather than calling renderStyles(). That function
// does box.innerHTML = "" and rebuilds every row, which on a 280-row sheet
// throws away the operator's scroll position under the cursor - the reason the
// isolate handler already refuses to call it. Only two pieces of text on a row
// can move when a line is deleted, so only those are rewritten.
function refreshStyleRows() {
  if (!state.result) return;
  const byId = new Map(state.result.styles.map(s => [String(s.style_id), s]));
  const splits = splitItems();
  for (const row of document.querySelectorAll(".style-row")) {
    const s = byId.get(row.dataset.sid);
    if (!s) continue;
    const meta = row.querySelector(".style-meta");
    if (meta) {
      meta.textContent = `${fmtQty(styleLenPt(s))} · `
        + `${styleLiveCount(s.style_id)} lines · ${s.signature}`;
      const wOut = styleLiveOut(s.style_id);
      if (wOut > 0.05)
        meta.textContent += ` · ${fmtQty(wOut)} outside work area`;
    }
    const chip = row.querySelector(".item-split .is-txt");
    const sp = splits.get(s.style_id);
    if (chip && sp)
      chip.textContent = fmtQty(sp.total) + " total, from "
        + sp.parts.length + " layers";
  }
}

function removeSelected() {
  if (state.selected === null) return;
  if (deleteVertex()) return;   // a picked point goes first, not the line
  const ch = chainById(state.selected);
  captureUndo(`delete of 1 line — ${ch ? fmtQty(chainLenPt(ch)) : "?"}`,
    [state.selected]);
  state.excluded.add(state.selected);
  state.multiSel.delete(state.selected);   // it can no longer be bulk-acted on
  state.selected = null; state.selPt = null;
  updateSelBar(null);
  setStatus(`${state.excluded.size} line(s) removed — Ctrl+Z restores`);
  $("restoreBtn").hidden = state.excluded.size === 0;
  renderItemized();
  refreshStyleRows();   // the row's own footage and line count moved too
  renderMiniLegend();
  renderMultiBar();
  draw();
}
$("removeBtn").onclick = removeSelected;
$("restoreBtn").onclick = () => {
  if (state.result.chains.some(c => c.custom) || state.chainLabels.size) {
    // splits/extends replaced originals; a clean reload is the only
    // honest undo (relabels of styles are reloaded from suggestions too)
    setStatus("resetting edits…", "busy");
    loadResult();
    return;
  }
  state.excluded.clear();
  // Reset is the bigger hammer and it wins: the undo stack's snapshots
  // describe a history that no longer exists (the loadResult path above
  // clears it the same way, inside loadResult)
  undoClear(undoStack);
  state.multiSel = new Set();
  $("restoreBtn").hidden = true;
  setStatus("removed lines restored");
  renderItemized();
  refreshStyleRows();
  renderMiniLegend();
  renderMultiBar();
  draw();
};
// ==================== UNDO - the chain-edit undo stack ====================
// Before this, the only recovery from a wrong edit was "Reset edits", which
// nukes EVERY edit on the sheet to fix one. Ctrl+Z reverses just the last
// chain edit: delete (line or point), split, extend, cut span, draw,
// reclassify, merge, separate, and the bulk marquee actions.
//
// Design: every mutation site calls captureUndo() BEFORE it touches
// anything, naming ONLY the chains it is about to touch - a snapshot is a
// handful of deep-copied chain entries plus their membership in
// state.excluded and state.chainLabels, never a copy of the whole sheet.
// Measured on Barn C3.1 (1,638 chains): a single-chain snapshot is
// 476 B min / 633 B median / 29.0 KB max (a 1,701-point contour), against
// 1.49 MB for a whole-sheet copy per edit - the design this replaces.
// Chains the edit CREATES need no listing: their ids are >= the snapshot's
// nextChainId, and entries restore strictly LIFO, so at undo time any
// higher id present belongs to exactly the edit being reversed.
//
// undoApply is its own inverse builder: applying an entry first captures
// the current state of the same region, so undo and redo are one operation
// walking two stacks. The stack dies with the page (chains are per page)
// and with "Reset edits" (the bigger hammer wins).
//
// tests/test_undo_core.js evals ONLY the block between the UNDO-CORE
// markers - keep it pure (no DOM, no state.*), like TRENCH-MATH/WZ-MATH.
// UNDO-CORE-BEGIN

const UNDO_DEPTH = 50;   // bounded: ~50 edits of history, oldest evicted

function undoNewStack(depth) {
  return { depth: depth > 0 ? depth : UNDO_DEPTH, undo: [], redo: [] };
}

function undoDeep(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

// Snapshot the named chain ids out of doc, plus the scalar bookkeeping.
// doc = { chains: Array, excluded: Set, labels: Map(chain_id -> label),
//         nextChainId, selected, selPt }
// Taken BEFORE a mutation; ids lists every PRE-EXISTING chain the edit may
// touch (mutate, exclude, splice, or relabel). null/undefined ids are
// dropped so callers can pass optional participants straight through.
function undoCapture(doc, ids, label) {
  const seen = new Set();
  const chains = [], excluded = [], labels = [];
  for (const id of ids) {
    if (id === null || id === undefined || seen.has(id)) continue;
    seen.add(id);
    const idx = doc.chains.findIndex(c => c.chain_id === id);
    chains.push({ id, idx, present: idx >= 0,
                  data: idx >= 0 ? undoDeep(doc.chains[idx]) : null });
    excluded.push([id, doc.excluded.has(id)]);
    labels.push([id, doc.labels.has(id), doc.labels.get(id)]);
  }
  return { label: label || "edit", nextChainId: doc.nextChainId,
           selected: doc.selected, selPt: doc.selPt,
           chains, excluded, labels };
}

// Restore `entry` onto doc IN PLACE (arrays/sets/maps are mutated, scalars
// are returned for the caller to write back) and return the inverse entry
// that puts doc back to the moment before this call.
function undoApply(doc, entry) {
  // the full affected region: listed ids + everything the edit created
  const ids = new Set(entry.chains.map(c => c.id));
  for (const c of doc.chains)
    if (c.chain_id >= entry.nextChainId) ids.add(c.chain_id);
  for (const k of doc.labels.keys())
    if (typeof k === "number" && k >= entry.nextChainId) ids.add(k);
  const inverse = undoCapture(doc, [...ids], entry.label);
  // 1. chains the edit created go away entirely (ids >= the pre-edit
  //    counter can only have come from this edit - see LIFO note above)
  for (let i = doc.chains.length - 1; i >= 0; i--)
    if (doc.chains[i].chain_id >= entry.nextChainId) doc.chains.splice(i, 1);
  for (const k of [...doc.labels.keys()])
    if (typeof k === "number" && k >= entry.nextChainId) doc.labels.delete(k);
  for (const id of [...doc.excluded])
    if (id >= entry.nextChainId) doc.excluded.delete(id);
  // 2. listed chains return to their snapshotted content and position
  const order = [...entry.chains].sort((a, b) => a.idx - b.idx);
  for (const c of order) {
    const at = doc.chains.findIndex(x => x.chain_id === c.id);
    if (c.present) {
      const data = undoDeep(c.data);
      if (at >= 0) doc.chains[at] = data;
      else doc.chains.splice(Math.min(Math.max(c.idx, 0), doc.chains.length), 0, data);
    } else if (at >= 0) {
      doc.chains.splice(at, 1);
    }
  }
  // 3. membership and labels exactly as recorded
  for (const [id, wasIn] of entry.excluded) {
    if (wasIn) doc.excluded.add(id); else doc.excluded.delete(id);
  }
  for (const [id, had, val] of entry.labels) {
    if (had) doc.labels.set(id, val); else doc.labels.delete(id);
  }
  return { inverse, nextChainId: entry.nextChainId,
           selected: entry.selected, selPt: entry.selPt };
}

function undoPush(stack, entry) {
  stack.undo.push(entry);
  if (stack.undo.length > stack.depth) stack.undo.shift();
  stack.redo.length = 0;   // a fresh edit forks history; the old future dies
}

// dir: "undo" | "redo". Applies the top entry of that stack onto doc and
// pushes the inverse onto the other. Returns null when the stack is empty.
function undoStep(stack, doc, dir) {
  const from = dir === "redo" ? stack.redo : stack.undo;
  const to = dir === "redo" ? stack.undo : stack.redo;
  if (!from.length) return null;
  const entry = from.pop();
  const r = undoApply(doc, entry);
  to.push(r.inverse);
  return { label: entry.label, nextChainId: r.nextChainId,
           selected: r.selected, selPt: r.selPt };
}

function undoClear(stack) { stack.undo.length = 0; stack.redo.length = 0; }

// rough per-entry cost in bytes (serialized size of the snapshot)
function undoEntryBytes(entry) { return JSON.stringify(entry).length; }
// UNDO-CORE-END

const undoStack = undoNewStack(UNDO_DEPTH);

function undoDoc() {
  return { chains: state.result.chains, excluded: state.excluded,
           labels: state.chainLabels, nextChainId: state.nextChainId,
           selected: state.selected, selPt: state.selPt };
}

function captureUndo(label, ids) {
  if (!state.result) return;
  undoPush(undoStack, undoCapture(undoDoc(), ids, label));
}

// A mid-gesture tool holds references into the chains an undo may remove
// (cut anchors, merge/reclass sources, a draw's family line) - release the
// chain-owning tools first, the same way stArm() does before arming.
function undoDisarmTools() {
  if (state.tool === "cutspan") cancelCut();
  else if (state.tool === "merge") cancelMerge();
  else if (state.tool === "drawline") cancelDraw();
  else if (state.tool === "reclass") {
    state.tool = null;
    $("reclassBtn").classList.remove("active");
  } else if (state.tool === "extend") state.tool = null;
}

function undoRedo(dir) {
  if (!state.result) return;
  if (!(dir === "redo" ? undoStack.redo : undoStack.undo).length) {
    setStatus(dir === "redo" ? "nothing to redo" : "nothing to undo");
    return;   // an empty stack must not disarm a tool as a side effect
  }
  undoDisarmTools();
  const r = undoStep(undoStack, undoDoc(), dir);
  if (!r) return;   // cannot happen after the length check; belt and braces
  state.nextChainId = r.nextChainId;
  state.selected = r.selected; state.selPt = r.selPt; state.clickPt = null;
  const selCh = state.selected !== null ? chainById(state.selected) : null;
  if (!selCh || state.excluded.has(state.selected)) {
    state.selected = null; state.selPt = null;
  }
  // the set held ids from the state being stepped away from; keeping it
  // would let a bulk action fire on chains the undo just replaced
  state.multiSel = new Set();
  state.wzRev++;   // geometry may have moved; the work-area memo must not survive
  $("restoreBtn").hidden = !(state.excluded.size || state.chainLabels.size
    || state.result.chains.some(c => c.custom));
  updateSelBar(state.selected !== null ? chainById(state.selected) : null);
  setStatus((dir === "redo" ? "redo: " : "undo: ") + r.label
    + (dir === "redo" ? " — reapplied" : " — reversed"));
  renderItemized();
  refreshStyleRows();
  renderChips();
  renderMiniLegend();
  renderMultiBar();
  draw();
}

// ================== reclassify core + family switcher =====================
// The one mutation that moves a line between families, shared by the
// Reclassify pick-click, the selection-bar <select>, and the bulk "Move all
// to family". donorChain is the exact chain the operator clicked when there
// is one; otherwise a representative of the target family stands in, so the
// moved line inherits the same class/color/width/pattern either way.
function reclassCore(sel, targetSid, donorChain) {
  const donor = donorChain
    || state.result.chains.find(ch => ch.style_id === targetSid
         && ch.chain_id !== sel.chain_id && !state.excluded.has(ch.chain_id))
    || state.result.chains.find(ch => ch.style_id === targetSid
         && ch.chain_id !== sel.chain_id)
    || null;
  const c = materialize(sel);
  c.style_id = targetSid;
  if (donor) {
    c.class = donor.class; c.color = donor.color; c.width = donor.width;
    c.dash_signature = donor.dash_signature;
    if (donor.template) c.template = JSON.parse(JSON.stringify(donor.template));
  } else {
    // a family whose every chain is gone: fall back to the style row itself
    const st = state.result.styles.find(s => s.style_id === targetSid);
    if (st) {
      c.class = st.class; c.color = st.color; c.width = st.width;
      c.dash_signature = st.signature;
      delete c.template;
    }
  }
  return c;
}

// what a family is CALLED, one rule for every picker built here: the
// reviewer's label, else the seeded suggestion, else the CAD layer leaf,
// else the pattern itself
function familyName(s) {
  if (!s) return "";
  return state.labels.get(s.style_id) || s.suggested_label
    || ((s.layer || "").trim() ? layerSplit(String(s.layer).trim()).leaf : "")
    || `${s.class} · ${s.signature}`;
}

// compact <select> over the page's families, footage-first. placeholder
// non-null makes it an action picker (bulk move); null preselects
// currentSid (single-line switcher). No "(new family)" option on purpose:
// nothing in the app creates a style today, and a picker must not promise
// an edit that has no implementation behind it.
function familySelect(currentSid, placeholder, onPick) {
  const sel = document.createElement("select");
  sel.className = "fam-sel";
  sel.name = "family-switch";   // typing() sees SELECT focus; shortcuts pause
  if (placeholder !== null) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = placeholder; o.selected = true;
    sel.appendChild(o);
  }
  const styles = [...state.result.styles]
    .sort((a, b) => styleLenPt(b) - styleLenPt(a));
  for (const s of styles) {
    const o = document.createElement("option");
    o.value = String(s.style_id);
    o.textContent = familyName(s);
    if (placeholder === null && s.style_id === currentSid) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    const v = sel.value;
    sel.blur();   // hand the keyboard back to the canvas shortcuts
    if (v !== "") onPick(+v);
  };
  return sel;
}

// the selection-bar switch: same mutation, same undo, same status line as
// the Reclassify tool's pick-click
function familySwitch(sid) {
  const sel0 = state.selected !== null ? chainById(state.selected) : null;
  if (!sel0) return;
  if (sel0.style_id === sid) { setStatus("already in that family"); return; }
  const lab = familyName(state.result.styles.find(s => s.style_id === sid))
    || "its new family";
  captureUndo(`reclass into ${lab} — ${fmtQty(chainLenPt(sel0))}`, [sel0.chain_id]);
  const c = reclassCore(sel0, sid, null);
  state.selected = c.chain_id;
  updateSelBar(c);
  afterEdit(`moved ${fmtLen(c.length_pt)} into ${lab}`);
  renderStyles(); renderChips(); renderMiniLegend();
}

// ================== marquee multi-select + bulk actions ===================
// chains FULLY INSIDE the box (every vertex), same visibility rules as a
// plain canvas click: excluded/hidden/isolated-away lines cannot join
function marqueePick(rect) {
  const out = [];
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (state.isolate !== null ? ch.style_id !== state.isolate
                               : !state.include.get(ch.style_id)) continue;
    const P = ch.points;
    if (!P || !P.length) continue;
    let inside = true;
    for (const q of P)
      if (q[0] < rect[0] || q[0] > rect[2] || q[1] < rect[1] || q[1] > rect[3]) {
        inside = false;
        break;
      }
    if (inside) out.push(ch);
  }
  return out;
}

// the live members: ids still present and not excluded (an edit can consume
// a member; the set self-prunes here rather than going stale)
function multiLive() {
  if (!state.result || !state.multiSel || !state.multiSel.size) return [];
  const out = [];
  for (const id of state.multiSel) {
    if (state.excluded.has(id)) continue;
    const ch = chainById(id);
    if (ch) out.push(ch);
  }
  return out;
}

function renderMultiBar() {
  const bar = $("multiBar");
  if (!bar) return;
  const chs = multiLive();
  if (state.multiSel.size !== chs.length)
    state.multiSel = new Set(chs.map(c => c.chain_id));
  if (!chs.length) { bar.hidden = true; bar.textContent = ""; return; }
  bar.hidden = false;
  bar.textContent = "";
  const totalPt = chs.reduce((t, c) => t + chainLenPt(c), 0);
  const txt = document.createElement("span");
  txt.className = "sel-txt";
  txt.textContent = `${chs.length} line${chs.length === 1 ? "" : "s"} selected — ${fmtQty(totalPt)}`;
  const del = document.createElement("button");
  del.className = "mini danger";
  del.textContent = "Delete all";
  del.title = "Remove every selected line from the takeoff — one Ctrl+Z brings them all back";
  del.onclick = multiDeleteAll;
  const move = familySelect(null, "Move all to family…", (sid) => multiMoveAll(sid));
  move.title = "Move every selected line into one family — same edit as "
    + "Reclassify, one Ctrl+Z reverses the whole move";
  const clr = document.createElement("button");
  clr.className = "mini";
  clr.textContent = "Clear";
  clr.title = "Drop the selection (changes nothing on the sheet) — Esc does this too";
  clr.onclick = () => {
    state.multiSel = new Set();
    renderMultiBar();
    setStatus("selection cleared — nothing changed");
    draw();
  };
  bar.append(txt, del, move, clr);
}

function multiDeleteAll() {
  const chs = multiLive();
  if (!chs.length) return;
  const totalPt = chs.reduce((t, c) => t + chainLenPt(c), 0);
  // ONE undo entry for the whole set, and the same per-chain mutation the
  // trash button uses (exclude the id) - never a forked delete path
  captureUndo(`delete of ${chs.length} line${chs.length === 1 ? "" : "s"} — ${fmtQty(totalPt)}`,
    chs.map(c => c.chain_id));
  for (const c of chs) state.excluded.add(c.chain_id);
  if (state.selected !== null && state.excluded.has(state.selected)) {
    state.selected = null; state.selPt = null;
    updateSelBar(null);
  }
  state.multiSel = new Set();
  setStatus(`${chs.length} line${chs.length === 1 ? "" : "s"} deleted — `
    + `${fmtQty(totalPt)} out of the takeoff (Ctrl+Z restores all of them)`);
  $("restoreBtn").hidden = false;
  renderItemized();
  refreshStyleRows();
  renderMiniLegend();
  renderMultiBar();
  draw();
}

function multiMoveAll(sid) {
  const chs = multiLive().filter(c => c.style_id !== sid);
  if (!chs.length) { setStatus("every selected line is already in that family"); return; }
  const lab = familyName(state.result.styles.find(s => s.style_id === sid))
    || "its new family";
  const totalPt = chs.reduce((t, c) => t + chainLenPt(c), 0);
  // ONE undo entry; each line goes through the same reclassCore as the
  // Reclassify tool and the selection-bar switch
  captureUndo(`reclass of ${chs.length} line${chs.length === 1 ? "" : "s"} into ${lab}`,
    chs.map(c => c.chain_id));
  const newIds = [];
  for (const c of chs) newIds.push(reclassCore(c, sid, null).chain_id);
  state.multiSel = new Set(newIds);   // members were re-materialized under new ids
  if (state.selected !== null &&
      (state.excluded.has(state.selected) || !chainById(state.selected))) {
    state.selected = null; state.selPt = null;
    updateSelBar(null);
  }
  afterEdit(`moved ${chs.length} line${chs.length === 1 ? "" : "s"} — `
    + `${fmtQty(totalPt)} into ${lab} (Ctrl+Z reverses the whole move)`);
  renderStyles(); renderChips(); renderMiniLegend();
}

function typing() {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
    || el.tagName === "SELECT" || el.isContentEditable);
}
addEventListener("keydown", (e) => {
  // undo / redo. Ctrl+Z (Cmd+Z on a Mac); Ctrl+Shift+Z or Ctrl+Y redoes.
  // Never while typing - a focused input keeps the browser's own text undo.
  if (!typing() && (e.ctrlKey || e.metaKey) && !e.altKey) {
    const kz = e.key.toLowerCase();
    if (kz === "z" || kz === "y") {
      e.preventDefault();
      undoRedo((kz === "y" || e.shiftKey) ? "redo" : "undo");
      return;
    }
  }
  // single-key review shortcuts; never while typing in a field
  if (!typing() && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (e.key === "?") {
      e.preventDefault();
      $("kbdHelp").hidden = !$("kbdHelp").hidden;
      return;
    }
    if (k === "m") { e.preventDefault(); $("measureBtn").click(); return; }
    if (k === "f") { e.preventDefault(); $("faithfulBtn").click(); return; }
    if (k === "l") {
      e.preventDefault();
      const off = localStorage.getItem("core-minilegend") === "off";
      localStorage.setItem("core-minilegend", off ? "on" : "off");
      renderMiniLegend();
      return;
    }
    if (state.result && state.selected !== null) {
      if (k === "s") { e.preventDefault(); $("splitBtn").click(); return; }
      if (k === "x") { e.preventDefault(); $("cutSpanBtn").click(); return; }
      if (k === "e") { e.preventDefault(); $("extendBtn").click(); return; }
      if (k === "d") { e.preventDefault(); $("drawBtn").click(); return; }
      if (k === "i") {
        e.preventDefault();
        const ch = chainById(state.selected);
        if (ch) {
          state.isolate = state.isolate === ch.style_id ? null : ch.style_id;
          renderMiniLegend(); draw();
        }
        return;
      }
    }
  }
  if ((e.key === "Delete" || e.key === "Backspace") && !typing()) {
    e.preventDefault();
    // a marquee selection outranks the single selection: the operator built
    // the set on purpose, and the bar's Delete all is the same action
    if (state.multiSel && state.multiSel.size) multiDeleteAll();
    else removeSelected();
  }
  if ((e.key === "j" || e.key === "J") && !typing() && state.selected !== null) {
    e.preventDefault();
    $("mergeBtn").onclick();
    return;
  }
  if ((e.key === "r" || e.key === "R") && !typing() && state.selected !== null) {
    $("reclassBtn").onclick();
    return;
  }
  if (e.key === "Enter" && state.tool === "drawline" && !typing()) {
    e.preventDefault();
    finishDraw();
    return;
  }
  if (e.key === "Escape") {
    if (!$("kbdHelp").hidden) { $("kbdHelp").hidden = true; return; }
    if (state.marquee) {   // a box mid-drag dies without selecting anything
      state.marquee = null;
      setStatus("multi-select cancelled");
      draw();
      return;
    }
    if (state.tool === "cutspan") {
      cancelCut();
      setStatus("cut cancelled");
      draw();
      return;
    }
    if (state.tool === "merge") {
      cancelMerge();
      setStatus("merge cancelled");
      return;
    }
    if (state.tool === "reclass") {
      state.tool = null;
      $("reclassBtn").classList.remove("active");
      setStatus("reclassify cancelled");
      return;
    }
    if (state.tool === "drawline") {
      if (state.drawPts.length) {
        state.drawPts.pop();
        setStatus(state.drawPts.length
          ? `draw: ${state.drawPts.length} point(s) — Esc again removes another`
          : "all points removed — Esc again exits draw", "busy");
      } else {
        cancelDraw();
        setStatus("draw cancelled");
      }
      draw();
      return;
    }
    if (state.tool === "measure") {
      state.tool = null; state.measurePts = [];
      $("measureBtn").classList.remove("active");
      $("measureInfo").hidden = true;
      setStatus("");
    } else if (state.tool === "extend") {
      state.tool = null;
      setStatus("");
    }
    // the marquee set clears one layer before the single selection - same
    // tools-first grammar; the next Esc still reaches selPt/selected below
    if (state.multiSel && state.multiSel.size) {
      state.multiSel = new Set();
      renderMultiBar();
      setStatus("selection cleared — nothing changed");
      draw();
      return;
    }
    if (state.selPt !== null) { state.selPt = null; updateSelBar(chainById(state.selected)); }
    else { state.selected = null; updateSelBar(null); }
    // Last, so every tool above still gets Escape first. Nothing cleared an
    // isolate except clicking the same row again or changing page, and with
    // no indicator to notice (see renderStyles) an operator could leave one on
    // indefinitely and read a filtered sheet as the whole sheet.
    if (state.isolate !== null) {
      state.isolate = null;
      renderStyles(); renderMiniLegend();
      // the bid view marks its member rows the same way the style rows are
      // marked, so the same clear has to reach them
      for (const r of document.querySelectorAll("#bidBox .bid-member.bid-iso"))
        r.classList.remove("bid-iso");
      setStatus("isolate off");
    }
    draw();
  }
});
cv.addEventListener("dblclick", (e) => {
  e.preventDefault();
  if (state.tool === "drawline") finishDraw();
});
cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const z = Math.exp(-e.deltaY * 0.0015);
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  state.view.x = mx - (mx - state.view.x) * z;
  state.view.y = my - (my - state.view.y) * z;
  state.view.k *= z;
  draw();
}, { passive: false });

function fmtLen(pt) {
  return pt > 8000 ? `${(pt / 1000).toFixed(1)}k pt` : `${Math.round(pt)} pt`;
}
function setStatus(t, cls) { const el = $("status"); el.textContent = t; el.className = "status " + (cls || ""); }

// ---------- structure calculator: footprint dig + perimeter layback ----------
// The excavator's bid-sheet formulas (client_meet/beaumont, "Bid sheet" p1,
// handwritten; FINDINGS-2026-08-21 F52):
//   Mass Excavation CY      = footprint SF x depth / 27
//   Structure Excavation CY = wall length LF x depth x layback width / 27
//   Structure Backfill CY   = the same trench, filled back in ("I'm doing
//                             that calculation twice ... dig it and back fill it")
//   Slab Prep SF            = footprint SF
// The outline is a polygon in page pt - picked off a closed detected chain
// or clicked corner by corner - and feet come from the sheet scale. With no
// scale the panel shows pt and refuses volumes (same rule as the trench
// tool). Everything here is general geometry; nothing is tuned to a sheet.
SECTIONS.push(["stHead", ["stBody", "stRows", "stHint", "stActions"]]);
{
  const head = $("stHead");
  head.querySelector("h2").onclick = () => {
    const closed = head.classList.toggle("closed");
    for (const cid of ["stBody", "stRows", "stHint", "stActions"]) $(cid).hidden = closed;
  };
}
const ST_LABELS = ["Mass Excavation", "Structure Excavation", "Structure Backfill", "Slab Prep"];
const ST_UNITS = { "Mass Excavation": "CY", "Structure Excavation": "CY",
                   "Structure Backfill": "CY", "Slab Prep": "SF" };
const ST_COLOR = "#ff7a00";        // committed structures: outline + band
const ST_DRAFT_COLOR = "#00a8e8";  // the one being outlined right now
const stR1 = (v) => Math.round(v * 10) / 10;
const stFmt = (v, d = 1) => v.toLocaleString(undefined, { maximumFractionDigits: d });

function stFtPerPt() {
  const sc = state.result && state.result.scale;
  return sc ? sc.ft_per_paper_inch / 72 : null;
}
// The panel's list belongs to ONE detection result: a page switch or a
// re-detect hands loadResult a new result object (and empties extraItems),
// so the structures drawn on the old sheet must go with it.
function stSync() {
  if (!state.st || state.st.result !== state.result) {
    state.st = { result: state.result, items: [], draft: null, drawPts: [], hover: null,
                 hot: null, seq: 1, depth_ft: 8, layback_ft: 4, footing_ft: 0 };
    if (state.tool === "st-pick" || state.tool === "st-draw") state.tool = null;
    $("stPanel").hidden = true;
    $("stResult").textContent = "";
    stApplySaved();   // saved outlines for THIS page, once the sidecar answered
  }
  $("stBtn").hidden = !state.result;
  return state.st;
}
function stPolyArea(pts) {   // shoelace, pt^2
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}
function stPolyPerim(pts) {  // closed ring length, pt
  let L = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    L += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return L;
}
// one structure -> its geometry + the four bid-sheet numbers (null w/o scale)
function stCalc(it) {
  const fpp = stFtPerPt();
  const area_pt2 = stPolyArea(it.pts), perim_pt = stPolyPerim(it.pts);
  const out = { area_pt2, perim_pt, area_sf: null, perim_lf: null,
                mass_cy: null, struct_cy: null, backfill_cy: null, slab_sf: null };
  if (!fpp) return out;
  out.area_sf = area_pt2 * fpp * fpp;
  out.perim_lf = perim_pt * fpp;
  const d = Math.max(0, +it.depth_ft || 0);
  const lb = Math.max(0, +it.layback_ft || 0);
  const fd = Math.max(0, +it.footing_ft || 0);
  out.mass_cy = out.area_sf * d / 27;
  // the perimeter trench goes to the BOTTOM OF THE FOOTING: the dig depth
  // plus whatever the footing sits below the slab (0 when the depth typed
  // already is the footing bottom)
  out.struct_cy = out.perim_lf * (d + fd) * lb / 27;
  out.backfill_cy = out.struct_cy;
  out.slab_sf = out.area_sf;
  return out;
}
// every structure on the page, summed per bid-sheet label, into the takeoff
function stApplyItems() {
  const st = stSync();
  state.extraItems = state.extraItems.filter(it => !ST_LABELS.includes(it.label));
  const sum = { "Mass Excavation": 0, "Structure Excavation": 0,
                "Structure Backfill": 0, "Slab Prep": 0 };
  for (const it of st.items) {
    const c = stCalc(it);
    if (c.mass_cy === null) continue;
    sum["Mass Excavation"] += c.mass_cy;
    sum["Structure Excavation"] += c.struct_cy;
    sum["Structure Backfill"] += c.backfill_cy;
    sum["Slab Prep"] += c.slab_sf;
  }
  for (const label of ST_LABELS) {
    if (sum[label] > 0)
      state.extraItems.push({ label, qty: stR1(sum[label]), unit: ST_UNITS[label] });
    // bid-sheet rows are earthwork items; "Slab Prep" would otherwise file
    // under Structures on the SLAB keyword. Session default only - the
    // reviewer's own trade pick wins.
    if (!store.getItem(tradeKey(label))) store.setSession(tradeKey(label), "Earthwork & Grading");
  }
  renderItemized();
}

// ---- outline capture ----
function stArm(mode) {
  const st = stSync();
  if (!state.result) return setStatus("run Detect first", "err");
  // release whatever click-tool was armed so its button does not stay lit
  if (state.tool === "drawline") cancelDraw();
  else if (state.tool === "measure") $("measureBtn").click();
  else if (state.tool === "cutspan") cancelCut();
  else if (state.tool === "reclass") $("reclassBtn").onclick();
  state.tool = mode; st.drawPts = []; st.hover = null;
  setStatus(mode === "st-pick"
    ? "structure: click a closed line that is the building outline (Esc cancels)"
    : "structure: click each corner of the building — Enter or double-click closes, Esc backs up", "busy");
  renderSt(); draw();
}
function stDisarm(msg) {
  const st = stSync();
  state.tool = null; st.drawPts = []; st.hover = null;
  if (msg !== undefined) setStatus(msg);
  renderSt(); draw();
}
// nearest VISIBLE chain (same eligibility as a plain canvas click) that
// closes on itself - within a gap of 2% of its length, so a footprint whose
// last corner stops a hair short still counts
function stPickAt(px, py) {
  const { k } = state.view;
  const f = IMG_DPI / 72;
  const tolPt = 6 / k / f * 4 + 1.5;
  let best = null, bestD = tolPt;
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (state.isolate !== null ? ch.style_id !== state.isolate
                               : !state.include.get(ch.style_id)) continue;
    const P = ch.points;
    for (let i = 1; i < P.length; i++) {
      const d = distToSeg(px, py, P[i-1], P[i]);
      if (d < bestD) { bestD = d; best = ch; }
    }
  }
  if (!best) return setStatus("no line there — click closer to the building outline, or draw it instead", "err");
  const P = best.points;
  const gap = Math.hypot(P[0][0] - P[P.length-1][0], P[0][1] - P[P.length-1][1]);
  const ring = polyLen(P) + gap;
  if (P.length < 4 || gap > Math.max(3, 0.02 * ring)) {
    const fpp = stFtPerPt();
    return setStatus(`that line is not a closed outline (ends ${fpp ? stFmt(gap * fpp) + " ft" : Math.round(gap) + " pt"} apart) — draw the outline corner by corner instead`, "err");
  }
  const pts = P.map(q => [q[0], q[1]]);
  if (gap < 0.5) pts.pop();   // first == last: one ring vertex, not two
  const st = stSync();
  st.draft = { name: `Structure ${st.seq}`, pts, source: "line", chain_id: best.chain_id, gap_pt: gap,
               depth_ft: st.depth_ft, layback_ft: st.layback_ft, footing_ft: st.footing_ft };
  state.tool = null;
  const c = stCalc(st.draft);
  setStatus(c.area_sf !== null
    ? `outline taken: ${stFmt(c.area_sf, 0)} SF · ${stFmt(c.perim_lf, 0)} LF — set the depth, then Add to takeoff`
    : "outline taken — no scale on this page, so only pt can be shown");
  renderSt(); draw();
}
function stDrawClick(px, py) {
  const st = stSync();
  const last = st.drawPts[st.drawPts.length - 1];
  if (last && Math.hypot(px - last[0], py - last[1]) < 0.5) return;  // dblclick echo
  st.drawPts.push([px, py]);
  const n = st.drawPts.length;
  const fpp = stFtPerPt();
  let live = "";
  if (n >= 3 && fpp) {
    live = ` · so far ${stFmt(stPolyArea(st.drawPts) * fpp * fpp, 0)} SF, ${stFmt(stPolyPerim(st.drawPts) * fpp, 0)} LF`;
  }
  setStatus(`structure: ${n} corner(s)${live} — Enter/double-click closes, Esc backs up`, "busy");
  draw();
}
function stFinishDraw() {
  const st = stSync();
  const pts = [];
  for (const q of st.drawPts)
    if (!pts.length || Math.hypot(q[0] - pts[pts.length-1][0], q[1] - pts[pts.length-1][1]) > 0.5)
      pts.push(q);
  if (pts.length >= 2 && Math.hypot(pts[0][0] - pts[pts.length-1][0], pts[0][1] - pts[pts.length-1][1]) < 0.5)
    pts.pop();
  if (pts.length < 3) {
    return setStatus(`an outline needs at least 3 corners (have ${pts.length}) — keep clicking, or Esc to cancel`, "err");
  }
  st.draft = { name: `Structure ${st.seq}`, pts, source: "drawn", chain_id: null, gap_pt: 0,
               depth_ft: st.depth_ft, layback_ft: st.layback_ft, footing_ft: st.footing_ft };
  state.tool = null; st.drawPts = []; st.hover = null;
  const c = stCalc(st.draft);
  setStatus(c.area_sf !== null
    ? `outline closed: ${stFmt(c.area_sf, 0)} SF · ${stFmt(c.perim_lf, 0)} LF — set the depth, then Add to takeoff`
    : "outline closed — no scale on this page, so only pt can be shown");
  renderSt(); draw();
}
function stCanvasClick(e) {
  const [px, py] = ptFromEvent(e);
  if (state.tool === "st-pick") stPickAt(px, py);
  else if (state.tool === "st-draw") stDrawClick(px, py);
}
// clicks land in the structure tool while it is armed; every other tool
// and plain selection go on exactly as before
const _stClickBefore = handleCanvasClick;
handleCanvasClick = function (e) {
  if (state.tool === "st-pick" || state.tool === "st-draw") return stCanvasClick(e);
  return _stClickBefore(e);
};
addEventListener("mousemove", (e) => {
  if (state.tool !== "st-draw" || panning || !state.st || !state.st.drawPts.length) return;
  state.st.hover = ptFromEvent(e);
  draw();
});
cv.addEventListener("dblclick", () => { if (state.tool === "st-draw") stFinishDraw(); });

// same interception grammar for the hand-drawn limit of work
const _ewbClickBefore = handleCanvasClick;
handleCanvasClick = function (e) {
  if (state.tool === "ew-bound-draw") {
    const [px, py] = ptFromEvent(e);
    return ewBoundDrawClick(px, py);
  }
  return _ewbClickBefore(e);
};
cv.addEventListener("dblclick", () => {
  if (state.tool === "ew-bound-draw") ewBoundDrawFinish();
});
addEventListener("mousemove", (e) => {
  if (state.tool !== "ew-bound-draw" || panning || !state.ewBoundDraft.length) return;
  state.ewBoundHover = ptFromEvent(e);
  draw();
});
addEventListener("keydown", (e) => {
  if (typing()) return;
  if (state.tool !== "ew-bound-draw") return;
  if (e.key === "Enter") {
    e.preventDefault(); e.stopImmediatePropagation();
    ewBoundDrawFinish();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault(); e.stopImmediatePropagation();
    if (state.ewBoundDraft.length) {
      state.ewBoundDraft.pop();
      setStatus(state.ewBoundDraft.length
        ? `limit of work: ${state.ewBoundDraft.length} corner(s) ` + '—' + " Esc again removes another"
        : "all corners removed " + '—' + " Esc again exits", "busy");
      draw();
    } else {
      ewBoundDrawCancel("limit of work: drawing cancelled");
    }
  }
}, true);
// capture phase so the generic Esc (clear selection) never sees these keys
// while the structure tool owns them
addEventListener("keydown", (e) => {
  if (typing()) return;
  const armed = state.tool === "st-pick" || state.tool === "st-draw";
  if (!armed) return;
  if (e.key === "Enter" && state.tool === "st-draw") {
    e.preventDefault(); e.stopImmediatePropagation();
    stFinishDraw();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault(); e.stopImmediatePropagation();
    const st = stSync();
    if (state.tool === "st-draw" && st.drawPts.length) {
      st.drawPts.pop();
      setStatus(st.drawPts.length
        ? `structure: ${st.drawPts.length} corner(s) — Esc again removes another`
        : "all corners removed — Esc again exits the structure tool", "busy");
      draw();
    } else {
      stDisarm("structure outline cancelled");
    }
  }
}, true);

// ---- panel ----
$("stBtn").onclick = () => {
  const st = stSync();
  const panel = $("stPanel");
  if (!panel.hidden) {
    panel.hidden = true;
    if (state.tool === "st-pick" || state.tool === "st-draw") stDisarm("");
    draw();
    return;
  }
  panel.hidden = false;
  panel.scrollIntoView({ block: "start", behavior: "smooth" });
  renderSt(); draw();
};
$("stClose").onclick = () => {
  $("stPanel").hidden = true;
  if (state.tool === "st-pick" || state.tool === "st-draw") stDisarm("");
  draw();
};
function stNumInput(obj, key, step, onchange) {
  const i = document.createElement("input");
  i.type = "number"; i.step = step; i.min = "0"; i.value = obj[key]; i.name = "st-" + key;
  i.oninput = () => { obj[key] = parseFloat(i.value); if (onchange) onchange(); };
  return i;
}
function stResultText(c) {
  if (c.area_sf === null)
    return `${stFmt(c.area_pt2, 0)} pt² · ${stFmt(c.perim_pt, 0)} pt — no scale on this page, volumes need feet`;
  return `mass ${stFmt(stR1(c.mass_cy))} CY · structure dig ${stFmt(stR1(c.struct_cy))} CY` +
    ` · backfill ${stFmt(stR1(c.backfill_cy))} CY · slab prep ${stFmt(c.slab_sf, 0)} SF`;
}
function renderSt() {
  const st = stSync();
  const body = $("stBody"), rows = $("stRows");
  body.innerHTML = ""; rows.innerHTML = "";
  if (!state.result) { body.textContent = "run Detect first"; $("stAdd").disabled = true; return; }
  const fpp = stFtPerPt();
  const mk = (tag, cls, txt) => { const d = document.createElement(tag); if (cls) d.className = cls; if (txt !== undefined) d.textContent = txt; return d; };

  // mode buttons
  const modes = mk("div", "st-modes");
  const pick = mk("button", "mini", "Pick outline");
  pick.title = "Click a closed detected line that IS the building outline";
  pick.classList.toggle("active", state.tool === "st-pick");
  pick.onclick = () => state.tool === "st-pick" ? stDisarm("") : stArm("st-pick");
  const drawB = mk("button", "mini", "Draw outline");
  drawB.title = "Click each corner of the building on the sheet; Enter or double-click closes";
  drawB.classList.toggle("active", state.tool === "st-draw");
  drawB.onclick = () => state.tool === "st-draw" ? stDisarm("") : stArm("st-draw");
  modes.append(pick, drawB);
  const scaleNote = mk("span", "ew-meta",
    fpp ? `scale ${state.result.scale.text}` : "NO SCALE — pt only");
  modes.appendChild(scaleNote);
  body.appendChild(modes);

  // draft: the outline just taken, with its inputs and live numbers
  const d = st.draft;
  if (d) {
    const c = stCalc(d);
    const box = mk("div", "st-draft");
    const nameRow = mk("div", "st-name");
    const name = document.createElement("input");
    name.value = d.name; name.name = "st-name"; name.placeholder = "name (House, Barn, Garage…)";
    name.oninput = () => { d.name = name.value; };
    nameRow.append(name);
    box.appendChild(nameRow);
    const srcTxt = d.source === "line"
      ? `from line #${d.chain_id}` + (d.gap_pt >= 0.5 ? ` (ends ${fpp ? stFmt(d.gap_pt * fpp) + " ft" : Math.round(d.gap_pt) + " pt"} apart, closed for you)` : "")
      : `drawn, ${d.pts.length} corners`;
    box.appendChild(mk("div", "ew-meta", (c.area_sf !== null
      ? `${stFmt(c.area_sf, 0)} SF footprint · ${stFmt(c.perim_lf, 0)} LF of wall`
      : `${stFmt(c.area_pt2, 0)} pt² · ${stFmt(c.perim_pt, 0)} pt`) + ` · ${srcTxt}`));
    const grid = mk("div", "tr-grid");
    const upd = () => {
      st.depth_ft = d.depth_ft; st.layback_ft = d.layback_ft; st.footing_ft = d.footing_ft;
      $("stResult").textContent = stResultText(stCalc(d));
      draw();
    };
    grid.append(mk("div", null, "Dig depth (ft): ground down to the basement slab, or to the footing bottom when there is no basement"),
                stNumInput(d, "depth_ft", "0.5", upd));
    grid.append(mk("div", null, "Layback width (ft): working room dug outside the foundation wall, all the way around"),
                stNumInput(d, "layback_ft", "0.5", upd));
    grid.append(mk("div", null, "Footing below slab (ft): extra depth the perimeter trench goes past the slab; 0 if the depth above already is the footing bottom"),
                stNumInput(d, "footing_ft", "0.5", upd));
    box.appendChild(grid);
    const acts = mk("div", "st-draft-acts");
    const discard = mk("button", "mini", "discard outline");
    discard.onclick = () => { st.draft = null; $("stResult").textContent = ""; renderSt(); draw(); };
    acts.append(discard);
    box.appendChild(acts);
    body.appendChild(box);
    $("stResult").textContent = stResultText(c);
    $("stAdd").disabled = c.area_sf === null;
  } else {
    body.appendChild(mk("div", "ew-meta", st.items.length
      ? "Pick or draw the next building to add another."
      : "Pick or draw the building outline to begin."));
    $("stAdd").disabled = true;
    if (!st.items.length) $("stResult").textContent = "";
  }

  // committed structures
  st.items.forEach((it, k) => {
    const c = stCalc(it);
    const row = mk("div", "st-row");
    const top = mk("div", "st-row-top");
    top.append(mk("b", null, it.name || `Structure ${k + 1}`));
    top.append(mk("span", "ew-meta", c.area_sf !== null
      ? `${stFmt(c.area_sf, 0)} SF · ${stFmt(c.perim_lf, 0)} LF`
      : `${stFmt(c.area_pt2, 0)} pt²`));
    const rm = mk("button", "mini danger", "×");
    rm.title = "remove this structure from the takeoff";
    rm.onclick = () => { st.items.splice(k, 1); stApplyItems(); renderSt(); draw(); setStatus(`${it.name} removed`); };
    top.append(rm);
    row.appendChild(top);
    const g = mk("div", "st-row-in");
    const upd = () => { stApplyItems(); $("stResult").textContent = stResultText(stCalc(it)); draw(); };
    g.append(mk("span", null, "depth"), stNumInput(it, "depth_ft", "0.5", upd),
             mk("span", null, "layback"), stNumInput(it, "layback_ft", "0.5", upd),
             mk("span", null, "ftg"), stNumInput(it, "footing_ft", "0.5", upd));
    row.appendChild(g);
    row.appendChild(mk("div", "ew-meta", c.mass_cy !== null
      ? `mass ${stFmt(stR1(c.mass_cy))} · dig ${stFmt(stR1(c.struct_cy))} · backfill ${stFmt(stR1(c.backfill_cy))} CY`
      : "no scale"));
    row.onmouseenter = () => { st.hot = k; draw(); };
    row.onmouseleave = () => { st.hot = null; draw(); };
    rows.appendChild(row);
  });
  if (st.items.length > 1 && fpp) {
    const tot = { mass: 0, dig: 0, slab: 0 };
    for (const it of st.items) { const c = stCalc(it); tot.mass += c.mass_cy; tot.dig += c.struct_cy; tot.slab += c.slab_sf; }
    rows.appendChild(mk("div", "st-total",
      `${st.items.length} structures → mass ${stFmt(stR1(tot.mass))} CY · dig ${stFmt(stR1(tot.dig))} CY · backfill ${stFmt(stR1(tot.dig))} CY · slab prep ${stFmt(tot.slab, 0)} SF`));
  }
}
$("stAdd").onclick = async () => {
  const st = stSync();
  const d = st.draft;
  if (!d) return;
  const c = stCalc(d);
  if (c.area_sf === null) { $("stResult").textContent = "no scale on this page — volumes need feet"; return; }
  st.items.push(d); st.draft = null; st.seq += 1;
  stApplyItems();
  renderSt(); draw();
  setStatus(`${d.name}: ${stFmt(stR1(c.mass_cy))} CY mass · ${stFmt(stR1(c.struct_cy))} CY dig + backfill · ${stFmt(c.slab_sf, 0)} SF slab prep → takeoff`);
  // server-side cross-check of the same arithmetic (the export/report path
  // will read from there later); a mismatch is shown, never silently taken
  try {
    const r = await fetch(`/api/job/${state.job}/page/${state.page}/structure`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ structures: [{ name: d.name, points: d.pts, depth_ft: d.depth_ft,
                                            layback_ft: d.layback_ft, footing_ft: d.footing_ft }] }),
    });
    if (!r.ok) { $("stResult").textContent += ` · server check failed (${r.status})`; return; }
    const j = await r.json();
    const s = j.structures && j.structures[0];
    const off = s && ["mass_cy", "struct_cy", "backfill_cy"].some(k => Math.abs(s[k] - stR1(c[k])) > 0.15);
    $("stResult").textContent = stResultText(c) + (off ? " · SERVER DISAGREES: " + JSON.stringify(s) : " · server agrees ✓");
  } catch (err) {
    $("stResult").textContent += " · server check unreachable";
  }
};
// canvas: each structure's outline + the layback band outside it. The band
// is the outline stroked 2x layback wide and clipped to the OUTSIDE of the
// polygon, which is exactly the outward offset (mitred corners) without
// any polygon-offset arithmetic - it holds for concave footprints too.
function drawStructural(ctx, k) {
  const st = stSync();
  if ($("stPanel").hidden && !(state.tool === "st-pick" || state.tool === "st-draw")) return;
  const f = IMG_DPI / 72;
  const fpp = stFtPerPt();
  const ring = (pts) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * f, pts[0][1] * f);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * f, pts[i][1] * f);
    ctx.closePath();
  };
  const paint = (it, color, band, hot) => {
    const pts = it.pts;
    if (pts.length < 3) return;
    const lbPt = fpp && it.layback_ft > 0 ? it.layback_ft / fpp : 0;
    if (lbPt > 0) {
      ctx.save();
      // clip = whole sheet minus the polygon (even-odd)
      ctx.beginPath();
      ctx.rect(0, 0, state.img.width, state.img.height);
      ctx.moveTo(pts[0][0] * f, pts[0][1] * f);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * f, pts[i][1] * f);
      ctx.closePath();
      ctx.clip("evenodd");
      ring(pts);
      ctx.lineJoin = "miter"; ctx.miterLimit = 4;
      ctx.lineWidth = 2 * lbPt * f;
      ctx.strokeStyle = band;
      ctx.stroke();
      ctx.restore();
    }
    ring(pts);
    ctx.lineJoin = "miter";
    ctx.lineWidth = (hot ? 3.5 : 2.2) / k;
    ctx.strokeStyle = color;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.fillStyle = color;
    for (const q of pts) {
      ctx.beginPath();
      ctx.arc(q[0] * f, q[1] * f, 3 / k, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  st.items.forEach((it, i) => paint(it, ST_COLOR, "rgba(255,122,0,.30)", st.hot === i));
  if (st.draft) paint(st.draft, ST_DRAFT_COLOR, "rgba(0,168,232,.30)", true);
  // in-progress polygon while drawing
  if (state.tool === "st-draw" && st.drawPts.length) {
    const P = st.drawPts;
    ctx.beginPath();
    ctx.moveTo(P[0][0] * f, P[0][1] * f);
    for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0] * f, P[i][1] * f);
    if (st.hover) ctx.lineTo(st.hover[0] * f, st.hover[1] * f);
    if (P.length >= 2) ctx.lineTo(P[0][0] * f, P[0][1] * f);   // closing edge preview
    ctx.lineWidth = 2 / k;
    ctx.setLineDash([6 / k, 4 / k]);
    ctx.strokeStyle = ST_DRAFT_COLOR;
    ctx.stroke();
    ctx.setLineDash([]);
    for (const q of P) {
      ctx.beginPath();
      ctx.arc(q[0] * f, q[1] * f, 3.5 / k, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff"; ctx.fill();
      ctx.lineWidth = 1.2 / k; ctx.strokeStyle = ST_DRAFT_COLOR; ctx.stroke();
    }
  }
}

// ================= WORK AREA - operator controls ==========================
// The arming/drag/disarm shape follows st-draw; the mask math lives beside
// chainLenPt (WZ-MATH block above). Consent pattern: drawing a box is an
// explicit operator action with a visible state (dimmed outside, dashed
// outlines, tally disclosure), and CLEAR restores everything - detection
// results are never touched, so there is nothing to recompute.

function wzSyncUi() {
  // the button's lit state is handled by syncCursor (the state.tool hook);
  // this keeps the clear affordance in step with whether zones exist
  const cb = $("wzClearBtn");
  if (cb) cb.hidden = !wzActive();
}

// every reader of a length repaints; the sidecar records the change
function wzChanged() {
  state.wzRev++;
  wzSyncUi();
  calcStateDirty();
  renderStyles(); renderChips(); renderItemized(); renderMiniLegend();
  draw();
}

// after each box: say what now counts and what is out, in sheet units
function wzStatusAfterBox() {
  let cIn = 0, cOut = 0;
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (!state.include.get(ch.style_id)) continue;
    const full = chainLenPt(ch), counted = chainCountedPt(ch);
    cIn += counted; cOut += full - counted;
  }
  const n = state.workZones.length;
  setStatus(`work area: ${n} box${n === 1 ? "" : "es"} — ${fmtQty(cIn)} counted, `
    + `${fmtQty(cOut)} outside excluded. Drag to add another box; Esc finishes.`,
    "busy");
}

$("wzBtn").onclick = () => {
  if (!state.result) return setStatus("run Detect first", "err");
  if (state.tool === "wz-draw") {
    state.tool = null; state.wzDrag = null;
    setStatus(wzActive()
      ? `work area set: ${state.workZones.length} box(es) govern the takeoff lists`
      : "work area tool off — no boxes drawn, everything counts");
    draw();
    return;
  }
  // release whatever click-tool was armed so its button does not stay lit
  // (same block stArm uses)
  if (state.tool === "drawline") cancelDraw();
  else if (state.tool === "measure") $("measureBtn").click();
  else if (state.tool === "cutspan") cancelCut();
  else if (state.tool === "merge") cancelMerge();
  else if (state.tool === "reclass") $("reclassBtn").onclick();
  else if (state.tool === "st-pick" || state.tool === "st-draw") stDisarm("");
  state.tool = "wz-draw";
  setStatus("work area: drag a box around the part of the sheet that should "
    + "count — the takeoff lists then count only length inside your boxes. "
    + "Drag more boxes to add; Esc finishes. (Earthwork and trench keep "
    + "their own limit-of-work boundary.)", "busy");
};

$("wzClearBtn").onclick = () => {
  if (!wzActive()) return;
  const n = state.workZones.length;
  // measure what the clear puts BACK before dropping the zones, so the
  // status line can state the restoration instead of just "cleared"
  let backPt = 0;
  if (state.result)
    for (const ch of state.result.chains) {
      if (state.excluded.has(ch.chain_id)) continue;
      if (!state.include.get(ch.style_id)) continue;
      backPt += chainLenPt(ch) - chainCountedPt(ch);
    }
  state.workZones = [];
  state.wzDrag = null;
  if (state.tool === "wz-draw") state.tool = null;
  wzChanged();
  setStatus(`work area cleared — ${n} box${n === 1 ? "" : "es"} removed, `
    + `${fmtQty(backPt)} back in the count`);
};

// restore this page's boxes from the calcstate sidecar (additive key
// "zones"). Rects are page geometry, not chain references, so they apply
// to whatever the live detection holds - nothing can be orphaned by a
// re-detect, and the counted lengths recompute from the current chains.
function wzApplySaved() {
  const saved = state.calcSaved || {};
  state.workZones = wzNorm(saved.zones);
  state.wzDrag = null;
  state.wzRev++;
  wzSyncUi();
}

// Esc while the tool is armed: abandon an in-progress drag first, then the
// tool itself (boxes already drawn stay). Capture phase so the generic Esc
// (clear selection / isolate) never fires underneath, same as st-draw.
addEventListener("keydown", (e) => {
  if (typing()) return;
  if (state.tool !== "wz-draw" && !state.wzDrag) return;
  if (e.key !== "Escape") return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (state.wzDrag) {
    state.wzDrag = null;
    setStatus("box abandoned — drag again, or Esc to finish", "busy");
    draw();
    return;
  }
  state.tool = null;
  setStatus(wzActive()
    ? `work area set: ${state.workZones.length} box(es) govern the takeoff lists`
    : "work area: no boxes drawn, everything counts");
  draw();
}, true);
// =============== end WORK AREA operator controls ==========================

// =============== keyboard-map overlay: the mouse path =====================
// The overlay itself (#kbdHelp, index.html KBD-MAP block) and its "?" key
// toggle predate this: the single-key review handler owns the keyboard path
// (search `e.key === "?"`) and its Esc cascade closes the overlay before
// anything else. These two listeners add the discoverable mouse path - the
// "?" button at the foot of the toolkit column, and click-outside-closes.
// Kept at the END of the file on purpose: the overlay's HTML comments cite
// app.js line numbers at this revision, and inserting code above the cited
// handlers would shift every citation.
$("kbdBtn").onclick = () => {
  $("kbdHelp").hidden = !$("kbdHelp").hidden;
};
document.addEventListener("click", (e) => {
  const kh = $("kbdHelp");
  if (kh.hidden) return;
  // the toggle button just handled this same click (its onclick ran before
  // this bubble listener); a click inside the panel is reading, not closing
  if (kh.contains(e.target) || (e.target.closest && e.target.closest("#kbdBtn"))) return;
  kh.hidden = true;
});
// ====================== GRADING ZONES ======================================
// Declared-design regions (F: EXCAVATION-PLAN.md section 25, the Stice
// case): the sheet does not draw a full proposed surface, so the estimator
// outlines a region and DECLARES its design - "pad at 2716.0", "1.5% plane
// toward 90 deg", "balance it", "strip 8 inches" - and the engine computes
// that declared design against the detected existing ground inside the
// polygon only (POST /earthwork/zone). Reference UX: the AGTEK-style
// region workflow - a per-cell dz aerial with a perimeter summary card.
//
// Consent is the app's standard one: the modal's live numbers are LOOKING;
// a zone's rows reach the priced takeoff only through its own "Add to
// takeoff" button (exact-label replacement, the trench pattern). Zones
// persist through the calcstate sidecar (additive key "gzones") as INPUTS
// only; every restore recomputes through the endpoint.

// GZ-GEOM-BEGIN
// Pure geometry (no DOM, no state.*) so tests/test_grading_zone_geom.js can
// eval just this block - same discipline as WZ-MATH / TRENCH-MATH.

// even-odd ray cast, the same rule the server's _points_in_poly applies -
// the modal's "N contours + M spots in zone" line and the server's grid
// must agree on what "inside" means
function gzPtInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y)) {
      const dy = (yj - yi) || 1e-12;
      const xc = (xj - xi) * (y - yi) / dy + xi;
      if (x < xc) inside = !inside;
    }
  }
  return inside;
}

// area centroid (shoelace); vertex mean when the ring is degenerate.
// Mirrors the server's _zone_centroid, which anchors the plane mode.
function gzCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += cross;
    cx += (poly[j][0] + poly[i][0]) * cross;
    cy += (poly[j][1] + poly[i][1]) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (const q of poly) { sx += q[0]; sy += q[1]; }
    return [sx / poly.length, sy / poly.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// does any vertex of this polyline fall inside the polygon? Vertex test on
// purpose: the summary line counts which assigned contours contribute
// inside the zone, and a contour clipping a corner between two vertices is
// a display nicety, not a volume input (the server samples the TIN, not
// this list).
function gzChainTouches(points, poly) {
  for (const p of points) if (gzPtInPoly(p[0], p[1], poly)) return true;
  return false;
}
// GZ-GEOM-END

// 5,800 -> "5.8k": the badge has one line of room on the canvas
function gzK(v) {
  v = Math.round(Number(v) || 0);
  if (Math.abs(v) >= 1000) {
    const s = (v / 1000).toFixed(1).replace(/\.0$/, "");
    return s + "k";
  }
  return v.toLocaleString();
}

var gzModalZone = null;   // the zone being edited, or null for a new one
var gzModalPoly = null;   // the polygon under the modal
var gzModalTimer = null;  // 400 ms debounce for the live result block
var gzModalSeq = 0;       // drops stale live responses

// both page-switch chokepoints call this (selectPage AND loadResult), like
// ewBoundDraft: drafts, saved zones and the open modal all belong to ONE
// sheet. The new page's own zones come back via gzApplySaved.
function gzPageReset() {
  state.gzones = [];
  state.gzDraft = []; state.gzHover = null; state.gzDrag = null;
  state.gzSeq = 1;
  const m = $("gzModal");
  if (m) m.hidden = true;
  gzModalZone = null; gzModalPoly = null;
  if (gzModalTimer) { clearTimeout(gzModalTimer); gzModalTimer = null; }
  gzModalSeq++;
  for (const id of ["gzDraw", "gzBox"]) {
    const b = $(id);
    if (b) b.classList.remove("active");
  }
  renderGz();
}

// the existing ground a zone computes against: exactly what the panel has
// assigned to EXISTING (rows with a finite elevation), plus the active
// spot grades when the panel sends those to the existing side - the same
// split ewBody uses, so the zone and the whole-sheet calculator can never
// disagree about what "existing" means
function gzExistingRows() {
  if (!state.ew) return [];
  return state.ew.rows.filter(r => r.surface === "existing" && isFinite(r.z));
}
function gzExistingPoints() {
  if (!state.ew || state.ew.spotSide !== "existing") return [];
  return ewActiveSpots().map(g => ({ x: g.x, y: g.y, z: g.z }));
}

// client-side count for the modal header line: which of the assigned
// existing rows/spots actually sit inside this polygon
function gzZoneSummary(poly) {
  let nC = 0, nS = 0;
  const zs = [];
  const chains = state.result
    ? new Map(state.result.chains.map(c => [c.chain_id, c])) : new Map();
  for (const r of gzExistingRows()) {
    const ch = chains.get(r.chain_id);
    if (ch && gzChainTouches(ch.points, poly)) { nC++; zs.push(r.z); }
  }
  for (const g of gzExistingPoints())
    if (gzPtInPoly(g.x, g.y, poly)) { nS++; zs.push(g.z); }
  const mean = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null;
  return { nContours: nC, nSpots: nS, mean };
}

function gzBody(polygon, design, strip_in) {
  return {
    polygon: polygon.map(q => [q[0], q[1]]),
    design: design,
    strip_in: isFinite(strip_in) && strip_in > 0 ? strip_in : 0,
    existing_rows: gzExistingRows().map(r => ({ chain_id: r.chain_id, z: r.z })),
    existing_points: gzExistingPoints(),
  };
}

// ---- compute (shared by save, edit and restore) --------------------------
async function gzCompute(z, gen) {
  if (gen == null) gen = state.gen;
  z.err = null; z.result = null; z.img = null;
  renderGz(); draw();
  try {
    const r = await fetch(`/api/job/${state.job}/page/${state.page}/earthwork/zone`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gzBody(z.polygon, z.design, z.strip_in)),
    });
    if (gen !== state.gen) return;
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      if (gen !== state.gen) return;
      z.err = e.detail || ("failed (" + r.status + ")");
    } else {
      const j = await r.json();
      if (gen !== state.gen) return;
      z.result = j;
      const img = new Image();
      img.onload = () => { if (gen === state.gen) { z.img = img; draw(); } };
      img.src = "data:image/png;base64," + j.map_png_base64;
      // consent already given for THIS zone: refresh its rows in place so a
      // superseded number never stays priced (same rule as ewCalc)
      if (z.added) { gzApplyItems(z); renderItemized(); }
    }
  } catch (err) {
    if (gen !== state.gen) return;
    z.err = "server unreachable";
  }
  renderGz(); draw();
}

// ---- restore from the calcstate sidecar ----------------------------------
// Synchronous half: zones into state BEFORE the first snapshot, so the
// payload round-trips. Results stay null here - they are never staged.
function gzApplySaved() {
  const saved = state.calcSaved || {};
  state.gzones = [];
  let seq = 1;
  for (const s of (Array.isArray(saved.gzones) ? saved.gzones : [])) {
    if (!s || !Array.isArray(s.polygon) || s.polygon.length < 3) continue;
    const poly = s.polygon.filter(q => Array.isArray(q) && q.length >= 2)
                          .map(q => [+q[0], +q[1]]);
    if (poly.length < 3) continue;
    state.gzones.push({
      id: String(s.id || ("z" + seq)),
      name: String(s.name || ("Zone " + seq)).slice(0, 40),
      polygon: poly,
      design: (s.design && typeof s.design === "object") ? s.design : { mode: "pad" },
      strip_in: isFinite(+s.strip_in) ? Math.max(+s.strip_in, 0) : 0,
      added: !!s.added, showNums: !!s.show_nums,
      result: null, img: null, err: null,
    });
    seq++;
  }
  state.gzSeq = state.gzones.length + 1;
  renderGz();
}

// Async half, AFTER the snapshot: every restored zone recomputes through
// the endpoint. The endpoint takes the panel's existing rows as input, so
// the suggest data loads first (ewEnsure) even when the panel is closed.
async function gzRestoreCompute() {
  if (!state.gzones.length) return;
  const gen = state.gen;
  if (!await ewEnsure()) {
    if (gen !== state.gen) return;
    for (const z of state.gzones) z.err = "run Detect first";
    renderGz();
    return;
  }
  if (gen !== state.gen) return;
  for (const z of state.gzones) {
    if (gen !== state.gen) return;
    await gzCompute(z, gen);
  }
}

// ---- takeoff rows (consent + exact-label replacement) ---------------------
// Three rows per zone, named by the zone so several zones coexist: the
// trench calculator's exact-label pattern, for the same reason (a prefix
// filter once silently deleted another system's rows).
function gzRowLabels(z) {
  return [`${z.name} cut`, `${z.name} fill`, `${z.name} topsoil strip`];
}
function gzClearItems(z) {
  const mine = new Set((z.labels && z.labels.length) ? z.labels : gzRowLabels(z));
  state.extraItems = state.extraItems.filter(it => !mine.has(it.label));
}
function gzApplyItems(z) {
  gzClearItems(z);
  const j = z.result;
  if (!j) return;
  z.labels = gzRowLabels(z);
  const rows = [];
  if (j.cut_yd3 > 0) rows.push({ label: z.labels[0], qty: ewR(j.cut_yd3), unit: "CY" });
  if (j.fill_yd3 > 0) rows.push({ label: z.labels[1], qty: ewR(j.fill_yd3), unit: "CY" });
  if (j.strip_yd3 > 0) rows.push({ label: z.labels[2], qty: ewR(j.strip_yd3), unit: "CY" });
  for (const r of rows) {
    state.extraItems.push(r);
    // tradeFor() would file "Zone 1 cut" under General; seed the trade the
    // way the balance rows do - session default only, the reviewer's pick wins
    if (!store.getItem(tradeKey(r.label)))
      store.setSession(tradeKey(r.label), "Earthwork & Grading");
  }
}

// ---- the panel list -------------------------------------------------------
function renderGz() {
  const box = $("gzRows"), tot = $("gzTotals"), st = $("gzState");
  if (!box) return;
  const zs = state.gzones || [];
  if (st) st.textContent = zs.length
    ? `${zs.length} zone${zs.length === 1 ? "" : "s"}` : "none";
  const sec = $("gzSection");
  if (sec) sec.classList.toggle("on", zs.length > 0);
  box.innerHTML = "";
  for (const z of zs) {
    const row = document.createElement("div");
    row.className = "gz-row" + (z.added ? " added" : "");
    const name = document.createElement("input");
    name.className = "gz-name";
    name.value = z.name;
    name.title = "zone name - its takeoff rows are named after it";
    name.onchange = () => {
      const v = name.value.trim().slice(0, 40) || z.name;
      if (v === z.name) { name.value = z.name; return; }
      // the old name's rows are cleared by their recorded labels, then the
      // new name reapplies - rename can never leave orphan rows behind
      if (z.added) gzClearItems(z);
      z.name = v; z.labels = null;
      if (z.added && z.result) gzApplyItems(z);
      calcStateDirty(); renderGz(); renderItemized(); draw();
    };
    const sum = document.createElement("span");
    sum.className = "gz-sum";
    sum.textContent = gzDesignSummary(z);
    const cyf = document.createElement("span");
    cyf.className = "gz-cyf";
    if (z.err) { cyf.innerHTML = `<span class="gz-err">${z.err}</span>`; }
    else if (z.result) {
      cyf.innerHTML = `cut <b>${ewCY(z.result.cut_yd3 > 0 ? z.result.cut_yd3 : 0)}</b>`
        + ` · fill <b>${ewCY(z.result.fill_yd3 > 0 ? z.result.fill_yd3 : 0)}</b> CY`
        + (z.result.strip_yd3 > 0 ? ` · strip ${ewCY(z.result.strip_yd3)} CY` : "");
    } else cyf.textContent = "computing…";
    const nums = document.createElement("button");
    nums.className = "mini" + (z.showNums ? " on" : "");
    nums.textContent = "123";
    nums.title = "show the per-cell elevation change on the sheet "
      + "(red = cut, blue = fill - note the tint underneath uses the map "
      + "palette, cut blue / fill orange)";
    nums.onclick = () => { z.showNums = !z.showNums; calcStateDirty(); renderGz(); draw(); };
    const edit = document.createElement("button");
    edit.className = "mini";
    edit.textContent = "edit";
    edit.title = "reopen this zone's design (clicking its badge on the sheet does the same)";
    edit.onclick = () => gzModalOpen(z);
    const add = document.createElement("button");
    add.className = "mini" + (z.added ? " on" : "");
    add.textContent = z.added ? "Remove from takeoff" : "Add to takeoff";
    add.title = z.added
      ? "remove this zone's rows from the itemized takeoff"
      : "put this zone's cut / fill / strip rows in the itemized takeoff - "
        + "nothing prices until this is pressed";
    add.onclick = () => {
      if (!z.added && !z.result) {
        setStatus(z.err ? `${z.name}: ${z.err}` : `${z.name} is still computing — try again in a moment`, "err");
        return;
      }
      z.added = !z.added;
      if (z.added) gzApplyItems(z);
      else gzClearItems(z);
      calcStateDirty(); renderGz(); renderItemized();
      setStatus(z.added
        ? `${z.name} added to the takeoff — its rows price, export and print like any other`
        : `${z.name} removed from the takeoff`);
    };
    const del = document.createElement("button");
    del.className = "mini x";
    del.textContent = "×";
    del.title = "delete this zone" + (z.added ? " (its takeoff rows go with it)" : "");
    del.onclick = () => {
      const wasAdded = z.added;
      if (wasAdded) gzClearItems(z);
      state.gzones = state.gzones.filter(q => q !== z);
      calcStateDirty(); renderGz(); renderItemized(); draw();
      setStatus(wasAdded
        ? `${z.name} deleted — its takeoff rows were removed with it`
        : `${z.name} deleted`);
    };
    row.append(name, sum, cyf, nums, edit, add, del);
    box.appendChild(row);
  }
  if (tot) {
    const done = zs.filter(z => z.result);
    if (done.length < 2) tot.hidden = true;
    else {
      tot.hidden = false;
      const cut = done.reduce((a, z) => a + Math.max(z.result.cut_yd3, 0), 0);
      const fill = done.reduce((a, z) => a + Math.max(z.result.fill_yd3, 0), 0);
      const strip = done.reduce((a, z) => a + Math.max(z.result.strip_yd3, 0), 0);
      tot.innerHTML = `<span>all zones:</span> <b>cut ${ewCY(cut)}</b>`
        + ` · <b>fill ${ewCY(fill)}</b>`
        + (strip > 0 ? ` · strip ${ewCY(strip)}` : "") + ` CY`
        + (done.length < zs.length
            ? ` <span class="gz-err">(${zs.length - done.length} zone${zs.length - done.length === 1 ? "" : "s"} not computed - not in these totals)</span>`
            : "");
    }
  }
}

function gzDesignSummary(z) {
  const d = z.design || {};
  let s;
  if (d.mode === "pad") s = `pad @ ${d.elev_ft}`;
  else if (d.mode === "plane")
    s = `plane ${d.slope_pct || 0}% @ ${d.azimuth_deg || 0}°, ${d.elev_ft} @ centre`;
  else if (d.mode === "balance")
    s = (z.result && z.result.balance_elev_ft !== undefined)
      ? `balance @ ${z.result.balance_elev_ft}` : "balance";
  else s = "strip only";
  if (z.strip_in > 0) s += ` · strip ${z.strip_in}"`;
  return s;
}

// ---- the two arming buttons ------------------------------------------------
$("gzDraw").onclick = () => {
  if (!state.result) return setStatus("run Detect first", "err");
  if (!state.ew) return setStatus("open the EARTHWORK panel data first (press EARTHWORK)", "err");
  if (state.tool === "gz-draw") { gzDrawCancel("grading zone: drawing cancelled"); return; }
  state.tool = "gz-draw";
  state.gzDraft = [];
  $("gzDraw").classList.add("active");
  syncCursor();
  setStatus("grading zone: click the corners of the region "
    + '—' + " Enter or double-click closes, Esc backs up", "busy");
};
$("gzBox").onclick = () => {
  if (!state.result) return setStatus("run Detect first", "err");
  if (!state.ew) return setStatus("open the EARTHWORK panel data first (press EARTHWORK)", "err");
  if (state.tool === "gz-box") {
    state.tool = null; state.gzDrag = null;
    $("gzBox").classList.remove("active");
    syncCursor(); draw();
    setStatus("grading zone: box cancelled");
    return;
  }
  state.tool = "gz-box";
  $("gzBox").classList.add("active");
  syncCursor();
  setStatus("grading zone: drag a box over the region " + '—' + " Esc cancels", "busy");
};

function gzDrawClick(px, py) {
  const d = state.gzDraft;
  const last = d[d.length - 1];
  if (last && Math.hypot(px - last[0], py - last[1]) < 0.5) return; // dblclick echo
  d.push([px, py]);
  const fpi = arFpi();
  let live = "";
  if (d.length >= 3 && fpi !== null) {
    const sf = Math.abs(polyAreaPt(d)) * (fpi / 72) * (fpi / 72);
    live = ` ${'·'} ${Math.round(sf).toLocaleString()} SF so far`;
  }
  setStatus(`grading zone: ${d.length} corner(s)${live} ${'—'} Enter/double-click closes, Esc backs up`, "busy");
  draw();
}
function gzDrawFinish() {
  const pts = [];
  for (const q of state.gzDraft)
    if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 0.5)
      pts.push(q);
  if (pts.length < 3) {
    return gzDrawCancel("grading zone: a region needs at least 3 corners "
      + '—' + " drawing cancelled");
  }
  state.tool = null;
  state.gzDraft = []; state.gzHover = null;
  $("gzDraw").classList.remove("active");
  syncCursor();
  draw();
  gzModalOpen(null, pts);
}
function gzDrawCancel(msg) {
  state.tool = null;
  state.gzDraft = []; state.gzHover = null;
  $("gzDraw").classList.remove("active");
  syncCursor();
  if (msg) setStatus(msg);
  draw();
}

// clicks land in the zone tools while armed; a badge click (no tool armed)
// reopens that zone's modal
const _gzClickBefore = handleCanvasClick;
handleCanvasClick = function (e) {
  if (state.tool === "gz-draw") {
    const [px, py] = ptFromEvent(e);
    return gzDrawClick(px, py);
  }
  if (!state.tool && state.gzones && state.gzones.length) {
    const [px, py] = ptFromEvent(e);
    for (const z of state.gzones) {
      const b = z._badge;
      if (b && px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3])
        return gzModalOpen(z);
    }
  }
  return _gzClickBefore(e);
};
cv.addEventListener("dblclick", () => { if (state.tool === "gz-draw") gzDrawFinish(); });
addEventListener("mousemove", (e) => {
  if (state.tool !== "gz-draw" || panning || !state.gzDraft.length) return;
  state.gzHover = ptFromEvent(e);
  draw();
});
// capture phase, same Esc semantics as the limit-of-work draw: back up one
// corner, then cancel; Enter closes
addEventListener("keydown", (e) => {
  if (typing()) return;
  if (state.tool !== "gz-draw") return;
  if (e.key === "Enter") {
    e.preventDefault(); e.stopImmediatePropagation();
    gzDrawFinish();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault(); e.stopImmediatePropagation();
    if (state.gzDraft.length) {
      state.gzDraft.pop();
      setStatus(state.gzDraft.length
        ? `grading zone: ${state.gzDraft.length} corner(s) ` + '—' + " Esc again removes another"
        : "all corners removed " + '—' + " Esc again exits", "busy");
      draw();
    } else {
      gzDrawCancel("grading zone: drawing cancelled");
    }
  }
}, true);
// Esc for the box tool: abandon an in-progress drag first, then the tool
addEventListener("keydown", (e) => {
  if (typing()) return;
  if (state.tool !== "gz-box" && !state.gzDrag) return;
  if (e.key !== "Escape") return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (state.gzDrag) {
    state.gzDrag = null;
    setStatus("box abandoned — drag again, or Esc to cancel the tool", "busy");
    draw();
    return;
  }
  state.tool = null;
  $("gzBox").classList.remove("active");
  syncCursor();
  setStatus("grading zone: box cancelled");
  draw();
}, true);

// ---- THE ZONE MODAL --------------------------------------------------------
function gzModalOpen(zone, polygon) {
  if (!state.ew) return setStatus("open the EARTHWORK panel first", "err");
  gzModalZone = zone || null;
  gzModalPoly = zone ? zone.polygon : polygon;
  if (!gzModalPoly || gzModalPoly.length < 3) return;
  $("gzBox").classList.remove("active");
  const fpi = arFpi();
  const sf = fpi === null ? null
    : Math.abs(polyAreaPt(gzModalPoly)) * (fpi / 72) * (fpi / 72);
  const name = zone ? zone.name : "Zone " + state.gzSeq;
  $("gzMTitle").textContent = name + (sf !== null
    ? ` — ${Math.round(sf).toLocaleString()} SF` : " — no scale set");
  const s = gzZoneSummary(gzModalPoly);
  $("gzMExist").innerHTML = (s.nContours + s.nSpots) > 0
    ? `existing from the sheet: ${s.mean !== null ? `mean ${s.mean.toFixed(1)} ft, ` : ""}`
      + `${s.nContours} contour${s.nContours === 1 ? "" : "s"} + `
      + `${s.nSpots} spot${s.nSpots === 1 ? "" : "s"} in zone `
      + `(rows the panel assigns to EXISTING)`
    : `<span class="gz-warn">no EXISTING contour or spot inside this zone — `
      + `the surface interpolates from the nearest assigned elevations `
      + `outside it, or refuses if it cannot reach</span>`;
  const d = (zone && zone.design) || {};
  const mode = d.mode || "pad";
  for (const r of document.querySelectorAll('input[name="gzMode"]'))
    r.checked = r.value === mode;
  // Number.isFinite, NEVER bare isFinite: isFinite(null) is TRUE in JS
  // (the spotDatum defect, CLAUDE.md section 5 / ewActiveSpots)
  const meanTxt = s.mean !== null ? String(Math.round(s.mean * 10) / 10) : "";
  $("gzPadElev").value = (mode === "pad" && Number.isFinite(d.elev_ft)) ? d.elev_ft : meanTxt;
  $("gzPlElev").value = (mode === "plane" && Number.isFinite(d.elev_ft)) ? d.elev_ft : meanTxt;
  $("gzPlSlope").value = Number.isFinite(d.slope_pct) ? d.slope_pct : 1.0;
  $("gzPlAz").value = Number.isFinite(d.azimuth_deg) ? d.azimuth_deg : 0;
  // strip default from the researched table, citation on its face - the
  // operator sees the number AND where it came from before it computes
  const sd = (typeof EW_RESEARCH !== "undefined") ? EW_RESEARCH.strip_depth_in : null;
  $("gzStrip").value = zone ? (Number.isFinite(zone.strip_in) ? zone.strip_in : 0)
                            : (sd ? sd.value : 0);
  $("gzStripWhy").textContent = sd
    ? `default ${sd.value}" — ${sd.local}; national band ${sd.national[0]}–${sd.national[1]} in. `
      + `Set 0 for no strip.`
    : "";
  gzModalSyncMode();
  $("gzModal").hidden = false;
  gzModalCalc();
}

function gzModalClose(msg) {
  $("gzModal").hidden = true;
  gzModalZone = null; gzModalPoly = null;
  if (gzModalTimer) { clearTimeout(gzModalTimer); gzModalTimer = null; }
  gzModalSeq++;
  if (msg) setStatus(msg);
}

// enable only the inputs the picked mode reads, so a number in a greyed
// box can never be silently part of the calculation
function gzModalSyncMode() {
  const mode = (document.querySelector('input[name="gzMode"]:checked') || {}).value || "pad";
  $("gzPadElev").disabled = mode !== "pad";
  $("gzPlElev").disabled = mode !== "plane";
  $("gzPlSlope").disabled = mode !== "plane";
  $("gzPlAz").disabled = mode !== "plane";
}

function gzModalCollect() {
  const mode = (document.querySelector('input[name="gzMode"]:checked') || {}).value || "pad";
  const sv = parseFloat($("gzStrip").value);
  const strip_in = isFinite(sv) && sv > 0 ? sv : 0;
  if (mode === "pad") {
    const e = parseFloat($("gzPadElev").value);
    if (!isFinite(e)) return { err: "type the pad elevation" };
    return { design: { mode: "pad", elev_ft: e }, strip_in };
  }
  if (mode === "plane") {
    const e = parseFloat($("gzPlElev").value);
    if (!isFinite(e)) return { err: "type the plane's elevation at the zone centre" };
    const sl = parseFloat($("gzPlSlope").value);
    const az = parseFloat($("gzPlAz").value);
    return { design: { mode: "plane", elev_ft: e,
                       slope_pct: isFinite(sl) ? sl : 0,
                       azimuth_deg: isFinite(az) ? az : 0 }, strip_in };
  }
  return { design: { mode }, strip_in };
}

function gzModalDirty() {
  if ($("gzModal").hidden) return;
  gzModalSyncMode();
  if (gzModalTimer) clearTimeout(gzModalTimer);
  gzModalTimer = setTimeout(gzModalCalc, 400);
}

async function gzModalCalc() {
  if ($("gzModal").hidden || !gzModalPoly) return;
  const live = $("gzMLive");
  const c = gzModalCollect();
  if (c.err) { live.innerHTML = `<span class="gz-warn">${c.err}</span>`; return; }
  const seq = ++gzModalSeq;
  const gen = state.gen;
  live.innerHTML = '<span class="gz-meta">calculating…</span>';
  let r;
  try {
    r = await fetch(`/api/job/${state.job}/page/${state.page}/earthwork/zone`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gzBody(gzModalPoly, c.design, c.strip_in)),
    });
  } catch (err) {
    if (seq === gzModalSeq) live.innerHTML = '<span class="gz-warn">server unreachable</span>';
    return;
  }
  if (seq !== gzModalSeq || gen !== state.gen) return;
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    if (seq !== gzModalSeq) return;
    live.innerHTML = `<span class="gz-warn">${e.detail || ("failed (" + r.status + ")")}</span>`;
    return;
  }
  const j = await r.json();
  if (seq !== gzModalSeq || gen !== state.gen) return;
  const cutQ = j.cut_yd3 > 0 ? j.cut_yd3 : 0, fillQ = j.fill_yd3 > 0 ? j.fill_yd3 : 0;
  let h = `<span class="gz-big">cut ${ewCY(cutQ)} CY · fill ${ewCY(fillQ)} CY</span>`
    + ` · net ${ewCY(j.net_yd3)} CY`;
  h += `<span class="gz-meta">over ${Number(j.area_sf).toLocaleString()} SF`
    + (j.coverage < 0.999
        ? ` <span class="gz-warn">— the existing surface reaches only `
          + `${Math.round(j.coverage * 100)}% of this `
          + `${Number(j.zone_area_sf).toLocaleString()} SF zone; the volumes `
          + `cover that share only</span>`
        : ` (the whole zone)`)
    + `</span>`;
  if (j.balance_elev_ft !== undefined) {
    const bd = j.balance_delta_ft;
    h += `<span class="gz-meta"><b>balances at ${j.balance_elev_ft.toFixed(2)} ft</b>`
      + ` (${Math.abs(bd).toFixed(2)} ft ${bd < 0 ? "below" : "above"} the`
      + ` existing mean ${j.existing_mean_ft.toFixed(2)} ft`
      + (j.strip_in > 0 ? "; the strip is part of the balance" : "") + `)</span>`;
  }
  if (j.strip_yd3 > 0)
    h += `<span class="gz-meta">topsoil strip ${j.strip_in}&Prime; over `
      + `${Number(j.area_sf).toLocaleString()} SF = <b>${ewCY(j.strip_yd3)} CY</b>`
      + (j.mode !== "strip_only"
          ? " — the fill above already includes replacing that depth" : "")
      + `</span>`;
  h += `<span class="gz-meta">existing inside the zone: mean `
    + `${j.existing_mean_ft.toFixed(2)} ft, sampled from the surface built on `
    + `${j.existing_n_contours} contour row${j.existing_n_contours === 1 ? "" : "s"}`
    + ` + ${j.existing_n_spots} spot grade${j.existing_n_spots === 1 ? "" : "s"}`
    + ` (whole sheet)</span>`;
  if (j.max_cut_ft || j.max_fill_ft)
    h += `<span class="gz-meta">deepest cut ${j.max_cut_ft} ft · deepest fill `
      + `${j.max_fill_ft} ft — eyeball these against the contours</span>`;
  h += `<img class="gz-map" alt="zone cut/fill map" `
    + `src="data:image/png;base64,${j.map_png_base64}">`;
  h += `<span class="gz-meta">cut blue · fill orange — full colour = `
    + `±${j.ref_dz} ft (the sheet map's own palette)</span>`;
  live.innerHTML = h;
}

$("gzMSave").onclick = () => {
  if (!gzModalPoly) return;
  const c = gzModalCollect();
  if (c.err) { setStatus("zone not saved — " + c.err, "err"); return; }
  let z = gzModalZone;
  if (!z) {
    z = {
      id: "z" + Math.random().toString(36).slice(2, 9),
      name: "Zone " + state.gzSeq++,
      polygon: gzModalPoly.map(q => [q[0], q[1]]),
      design: c.design, strip_in: c.strip_in,
      added: false, showNums: false,
      result: null, img: null, err: null,
    };
    state.gzones.push(z);
  } else {
    z.design = c.design;
    z.strip_in = c.strip_in;
  }
  const name = z.name;
  gzModalClose();
  calcStateDirty();
  renderGz();
  draw();
  gzCompute(z);   // async; refreshes the zone's priced rows if it was added
  setStatus(`${name} saved — computing its volumes; press its "Add to takeoff" to price them`);
};
$("gzMCancel").onclick = () => gzModalClose("zone not saved");
$("gzMClose").onclick = () => gzModalClose("zone not saved");
// Esc ALWAYS cancels the modal, typing or not - registered capture-phase so
// nothing underneath sees the key while the modal is up
addEventListener("keydown", (e) => {
  const m = $("gzModal");
  if (!m || m.hidden) return;
  if (e.key === "Escape") {
    e.preventDefault(); e.stopImmediatePropagation();
    gzModalClose("zone not saved");
  }
}, true);
(function gzWireModalInputs() {
  for (const id of ["gzPadElev", "gzPlElev", "gzPlSlope", "gzPlAz", "gzStrip"]) {
    const el = $(id);
    if (el) el.addEventListener("input", gzModalDirty);
  }
  for (const r of document.querySelectorAll('input[name="gzMode"]'))
    r.addEventListener("change", gzModalDirty);
})();
// =============== end GRADING ZONES ========================================

resize();

// =============== TOOLS MENU: one entry point in the header =================
// The nine tool buttons (Analyze, Earthwork, Trench, Count, Whole job,
// Across sheets, Callouts, Structure, Legend sheet) MOVED into #toolsMenu in
// index.html with their ids, titles, and hidden attributes untouched, so
// every handler attached above and every `$("ewBtn").hidden = ...` write in
// loadResult() keeps working; this section only opens and closes the box
// around them. DETECT LINES stays in the strip - it is the workflow, not a
// tool.

// TOOLS-MENU-BEGIN -----------------------------------------------------------
// Pure block: no DOM, no state.*, so tests/test_tools_menu.js can run it
// under node (same technique as TRENCH-MATH).
//
// [buttonId, panelId]. The panel's hidden state is the SOURCE OF TRUTH for
// the "open right now" dot; null = the tool has no panel (the legend prompt).
const TOOLS_MENU_ITEMS = [
  ["aiBtn", "aiBanner"],
  ["ewBtn", "ewPanel"],
  ["trBtn", "trPanel"],
  ["symBtn", "symPanel"],
  ["rollBtn", "rollPanel"],
  ["xsBtn", "xsPanel"],
  ["coBtn", "coPanel"],
  ["stBtn", "stPanel"],
  ["legendBtn", null],
];
// rows: [{id, hidden, panelHidden|null}] ->
//   {visible: [id...], dots: {id: bool}, note: bool}
// A hidden button is an absent row (loadResult's bookkeeping IS the menu's);
// a dot only for a panel that is actually open; the note explains the short
// menu before any page has a detection.
function toolsMenuModel(rows) {
  const visible = [], dots = {};
  for (const r of rows) {
    if (!r.hidden) visible.push(r.id);
    dots[r.id] = r.panelHidden === false;
  }
  return { visible, dots, note: visible.length < rows.length };
}
// wrap-around focus target for ArrowDown(+1)/ArrowUp(-1); -1 when empty.
// i = -1 (focus outside the items) enters at the end the arrow points from.
function toolsMenuNextIdx(n, i, delta) {
  if (!n) return -1;
  if (i < 0) return delta > 0 ? 0 : n - 1;
  return ((i + delta) % n + n) % n;
}
// TOOLS-MENU-END -------------------------------------------------------------

function toolsMenuSync() {
  const model = toolsMenuModel(TOOLS_MENU_ITEMS.map(([id, panel]) => ({
    id,
    hidden: $(id).hidden,
    panelHidden: panel ? $(panel).hidden : null,
  })));
  for (const [id] of TOOLS_MENU_ITEMS)
    $(id).classList.toggle("t-on", !!model.dots[id]);
  $("toolsNote").hidden = !model.note;
  return model;
}
function toolsMenuOpen() {
  toolsMenuSync();               // dots read the panels at open, every open
  const m = $("toolsMenu");
  m.hidden = false;
  m.classList.remove("flip");
  $("toolsBtn").setAttribute("aria-expanded", "true");
  // narrow windows: flip to right-anchored when the menu would run off
  const r = m.getBoundingClientRect();
  if (r.right > innerWidth - 8) m.classList.add("flip");
}
function toolsMenuClose(focusBack) {
  const m = $("toolsMenu");
  if (m.hidden) return;
  m.hidden = true;
  $("toolsBtn").setAttribute("aria-expanded", "false");
  if (focusBack) $("toolsBtn").focus();
}
$("toolsBtn").onclick = () => {
  if ($("toolsMenu").hidden) toolsMenuOpen(); else toolsMenuClose();
};
// A click on any tool row closes the menu and the tool's own handler runs
// untouched (bubble order: the button's onclick first, then this).
$("toolsMenu").addEventListener("click", (e) => {
  if (e.target.closest("button")) toolsMenuClose();
});
// click anywhere outside the wrap closes it
addEventListener("click", (e) => {
  if ($("toolsMenu").hidden) return;
  if (!$("toolsWrap").contains(e.target)) toolsMenuClose();
});
// Esc closes the menu and must never fall through to the canvas Esc
// (cancel tool / clear selection) - capture + stopImmediatePropagation,
// the same pattern the st-draw and ew-bound-draw handlers use.
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("toolsMenu").hidden) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  toolsMenuClose(true);
}, true);
// arrows walk the visible rows, wrapping; ArrowDown on the closed button opens
$("toolsWrap").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  if ($("toolsMenu").hidden) toolsMenuOpen();
  const btns = TOOLS_MENU_ITEMS.map(([id]) => $(id)).filter(b => !b.hidden);
  if (!btns.length) return;
  const i = btns.indexOf(document.activeElement);
  btns[toolsMenuNextIdx(btns.length, i, e.key === "ArrowDown" ? 1 : -1)].focus();
});
// =============== end TOOLS MENU ============================================

// =============== MY PROJECTS: the landing page =============================
// A card per plan set on this box, in place of the workbench, whenever no
// document is open - and reachable any time from the "Projects" link on the
// brand block. A pure VIEW toggle: one class on <main> hides the workbench
// columns via CSS, so nothing here touches state.job, any panel's hidden
// attribute, or a single counted quantity, and the workbench keeps its full
// state (zoom, selection, edits) while out of sight. Opening a card goes
// through the SAME server route and applyOpened() path the recents <select>
// uses; the card's remove control reuses the DELETE /api/job flow behind
// #docRemoveBtn, with the same confirm wording.

// PROJECTS-PURE-BEGIN --------------------------------------------------------
// Pure presentation helpers: no DOM, no state.*, no fetch, so
// tests/test_projects_view.js can run them under node.
function projMetaLine(pages, detected, approved) {
  const p = pages + " page" + (pages === 1 ? "" : "s");
  const d = pages && detected >= pages ? "all detected"
    : detected ? detected + " detected" : "not detected";
  const a = approved ? " · " + approved + " approved" : "";
  return p + " · " + d + a;
}
// both arguments in unix SECONDS (the server sends st_mtime)
function projAgo(nowS, whenS) {
  const s = Math.max(0, nowS - whenS);
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400 * 2) return Math.round(s / 3600) + " h ago";
  if (s < 86400 * 60) return Math.round(s / 86400) + " d ago";
  const dt = new Date(whenS * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  return dt.getFullYear() + "-" + p2(dt.getMonth() + 1) + "-" + p2(dt.getDate());
}
// label shared demo plans only when the list also holds the user's own -
// same rule as the recents <select> (one heading over one list is noise)
function projShowsSharedBadge(rows) {
  return rows.some(r => r.mine) && rows.some(r => r.shared);
}
// the header line under the H1: silent below the cap, explicit above it
function projCountLine(shown, total) {
  if (!shown) return "";
  return total > shown ? "showing " + shown + " of " + total : String(shown);
}
// PROJECTS-PURE-END ----------------------------------------------------------

function pvIsOpen() { return !$("projectsView").hidden; }

function showProjects(on) {
  on = !!on;
  if (on === pvIsOpen()) {
    if (on) loadProjects();          // already there: refresh the cards
    return;
  }
  toolsMenuClose();                  // a floating menu belongs to no view
  // the two full-screen views are exclusive: opening Projects closes the
  // pricing settings page (svHide is the raw toggle - no history juggling,
  // no buffer resync; the workbench stays hidden under pv-open anyway)
  if (on && svIsOpen()) svHide();
  $("projectsView").hidden = !on;
  document.querySelector("main").classList.toggle("pv-open", on);
  $("pvBack").hidden = !(on && state.job);
  if (on) {
    loadProjects();
  } else {
    // the canvas buffer went 0x0 while its column was display:none; resync
    // it, and refit ONLY if the fit was never computed (image finished
    // loading while hidden) - the operator's zoom and pan must survive the
    // round trip untouched
    syncBuffer();
    if (state.img && !(state.view.k > 0)) { fitView(); draw(); }
  }
  try {
    history.replaceState(null, "",
      on ? "#projects" : location.pathname + location.search);
  } catch (err) { /* the hash is a convenience, never a requirement */ }
}

async function loadProjects() {
  let d = null;
  try {
    const r = await fetch("/api/projects");
    if (r.ok) d = await r.json();
  } catch (e) { /* reported below */ }
  if (!pvIsOpen()) return;           // the operator moved on mid-fetch
  if (!d || !Array.isArray(d.projects)) {
    $("pvGrid").innerHTML = "";
    $("pvCount").textContent = "";
    const empty = $("pvEmpty");
    empty.hidden = false;
    empty.textContent = "Could not load the plan list — reload to retry.";
    return;
  }
  renderProjects(d);
}

function renderProjects(d) {
  const grid = $("pvGrid"), empty = $("pvEmpty");
  const rows = d.projects;
  $("pvCount").textContent = projCountLine(rows.length, d.total);
  grid.innerHTML = "";
  if (!rows.length) {
    empty.hidden = false;
    empty.textContent =
      "No plans yet — drop a PDF anywhere or use Upload.";
    return;
  }
  empty.hidden = true;
  const badge = projShowsSharedBadge(rows);
  const nowS = Date.now() / 1000;
  for (const r of rows) grid.appendChild(pvCard(r, badge, nowS));
}

function pvCard(r, sharedBadge, nowS) {
  const card = document.createElement("div");
  card.className = "pv-card" + (r.job_id === state.job ? " pv-current" : "");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.title = "Open " + r.name;

  const thumb = document.createElement("div");
  thumb.className = "pv-thumb";
  if (r.has_thumb) {
    // the page strip's own 28-dpi cache - the server serves the PNG it
    // already has, so a page of cards costs no fresh renders
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = url(`/api/job/${r.job_id}/page/0/image?dpi=28`);
    thumb.appendChild(img);
  } else {
    // never rendered on this box: requesting the image would rasterize a
    // page just to draw a card, so a quiet placeholder instead
    const ph = document.createElement("span");
    ph.className = "pv-ph";
    ph.textContent = "not opened yet";
    thumb.appendChild(ph);
  }
  card.appendChild(thumb);

  const name = document.createElement("div");
  name.className = "pv-name";
  name.textContent = r.name;
  name.title = r.name;
  const meta = document.createElement("div");
  meta.className = "pv-meta";
  meta.textContent = projMetaLine(r.pages, r.detected, r.approved || 0);
  const when = document.createElement("div");
  when.className = "pv-when";
  when.textContent = "last activity " + projAgo(nowS, r.when);
  card.append(name, meta, when);

  if (sharedBadge && r.shared) {
    const b = document.createElement("span");
    b.className = "pv-badge";
    b.textContent = "shared demo";
    card.appendChild(b);
  }
  if (r.deletable) {
    const x = document.createElement("button");
    x.className = "pv-x";
    x.textContent = "×";
    x.title = "Remove “" + r.name + "” from this server — "
      + "the uploaded PDF and everything detected from it";
    x.onclick = (e) => { e.stopPropagation(); pvRemove(r); };
    card.appendChild(x);
  }
  card.onclick = () => pvOpenJob(r);
  card.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pvOpenJob(r); }
  };
  return card;
}

async function pvOpenJob(r) {
  if (r.job_id === state.job) {
    // already the open document: a plain view switch, so in-progress review
    // work (splits, exclusions, zoom) survives instead of being reloaded away
    showProjects(false);
    return;
  }
  setStatus("opening…", "busy");
  try {
    // the same route and the same applyOpened() the recents <select> uses
    const resp = await fetch(`/api/job/${r.job_id}/open`);
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      return setStatus(e.detail || `could not open (${resp.status})`, "err");
    }
    applyOpened(await resp.json());   // applyOpened leaves the projects view
  } catch (e) {
    setStatus("could not open — the server did not answer", "err");
  }
}

async function pvRemove(r) {
  // the same server flow and the same words as the header's "Remove from
  // server" button - one deletion vocabulary, not two
  if (!confirm("Remove \"" + r.name + "\" from this server?\n\n"
    + "This permanently deletes the uploaded PDF and everything detected from "
    + "it — " + r.detected + " of " + r.pages + " page(s) already "
    + "detected, plus any approved exports and report for it.\n\n"
    + "This cannot be undone.")) return;
  setStatus("removing…", "busy");
  try {
    const resp = await fetch("/api/job/" + r.job_id, { method: "DELETE" });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      return setStatus(e.detail || ("could not remove it (" + resp.status + ")"), "err");
    }
    const j = await resp.json();
    if (r.job_id === state.job) {
      // the document on the hidden workbench no longer exists; a clean
      // reload is the only honest state (same choice as #docRemoveBtn)
      location.reload();
      return;
    }
    setStatus("removed " + j.name);
    loadProjects();
    loadRecent();                    // the recents <select> lists it too
  } catch (e) {
    setStatus("could not remove it — the server did not answer", "err");
  }
}

$("projectsLink").onclick = (e) => {
  e.preventDefault();
  if (pvIsOpen()) {
    if (state.job) showProjects(false);   // second click toggles back
    return;
  }
  showProjects(true);
};
$("pvBack").onclick = () => showProjects(false);

// While the projects view is up the workbench is INVISIBLE, so none of its
// single-key shortcuts may reach it - Delete on a forgotten selection would
// remove a line nobody can see. Capture + stopImmediatePropagation, the same
// pattern as the tool handlers; browser defaults are left alone. Esc is
// repurposed: with a sheet open it returns to the sheet.
const PV_SWALLOW_KEYS = new Set(["m", "f", "l", "s", "x", "e", "d", "i",
                                 "j", "r", "?", "Delete", "Backspace"]);
addEventListener("keydown", (e) => {
  if (!pvIsOpen() || typing()) return;
  if (e.key === "Escape") {
    e.stopImmediatePropagation();
    if (state.job) { e.preventDefault(); showProjects(false); }
    return;
  }
  if (PV_SWALLOW_KEYS.has(e.key) || PV_SWALLOW_KEYS.has(e.key.toLowerCase())
      // undo/redo must not act on the hidden sheet while Projects is up
      || ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")))
    e.stopImmediatePropagation();
}, true);

// ---------- boot: land on Projects when nothing is open --------------------
if (!state.job) showProjects(true);
// =============== end MY PROJECTS ===========================================

// =============== PRICING SETTINGS: the price book page =====================
// The second page in the projects shell. Same pure view toggle (one class on
// <main>, CSS hides the three workbench columns), same capture-phase key
// swallow, Esc returns to the sheet (or to Projects when no job is open).
// It reads and writes the SAME store the itemized panel uses - priceKey()
// ("price:<label>") through `store` - so a price typed here shows in the
// itemized panel on its next render and vice versa. Nothing new is stored:
// prices live in this browser's saved work (localStorage under tk1::),
// they do NOT sync to the server, and Export CSV is the backup path.

// SETTINGS-PURE-BEGIN --------------------------------------------------------
// Pure book/CSV logic: no DOM, no state.*, no fetch, so
// tests/test_settings_view.js can run it under node.

// Merge the labels that hold a stored price with the labels on the open
// document's itemized takeoff. Dedupe by exact label (the store's own key
// is the exact label), keep the live row's unit when known, sort
// case-insensitively so "silt fence" files beside "Silt Fence".
function svBookRows(storedLabels, liveItems) {
  const m = new Map();
  for (const it of liveItems || []) {
    if (!it || !it.label) continue;
    const got = m.get(it.label);
    if (!got) m.set(it.label, { label: it.label, unit: it.unit || "",
                                inUse: true, stored: false });
    else if (!got.unit && it.unit) got.unit = it.unit;
  }
  for (const lab of storedLabels || []) {
    const got = m.get(lab);
    if (got) got.stored = true;
    else m.set(lab, { label: lab, unit: "", inUse: false, stored: true });
  }
  return [...m.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
    || a.label.localeCompare(b.label));
}

// One CSV line -> fields, honouring quotes and "" escapes. Returns null on
// an unclosed quote so the caller can report the line rather than guess.
// (A quoted field spanning multiple lines lands here too - reported, never
// silently dropped.)
function svSplitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"' && cur === "") inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  if (inQ) return null;
  out.push(cur);
  return out;
}

function svCsvField(s) {
  s = String(s == null ? "" : s);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// rows: [{label, unit, price}] -> CSV text with the label,unit,price header.
function svSerializeCSV(rows) {
  const lines = ["label,unit,price"];
  for (const r of rows)
    lines.push([svCsvField(r.label), svCsvField(r.unit || ""),
                String(r.price)].join(","));
  return lines.join("\n") + "\n";
}

// CSV text -> { rows: [{label, unit, price}], bad: [{line, text, reason}] }.
// Accepts label,unit,price or label,price; a leading header row is skipped.
// Price accepts $ and thousands separators; anything else is listed as
// unparseable with its 1-based line number - never silently dropped.
function svParseCSV(text) {
  const rows = [], bad = [];
  const lines = String(text == null ? "" : text).split(/\r\n|\r|\n/);
  let first = true;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const f = svSplitCsvLine(raw);
    if (f === null) {
      bad.push({ line: i + 1, text: raw, reason: "unclosed quote" });
      first = false;
      continue;
    }
    if (first) {
      first = false;
      const head = f.map(x => x.trim().toLowerCase()).join(",");
      if (head === "label,unit,price" || head === "label,price") continue;
    }
    let label, unit, priceRaw;
    if (f.length === 3) { label = f[0]; unit = f[1]; priceRaw = f[2]; }
    else if (f.length === 2) { label = f[0]; unit = ""; priceRaw = f[1]; }
    else {
      bad.push({ line: i + 1, text: raw,
                 reason: "expected label,unit,price (" + f.length + " field"
                   + (f.length === 1 ? "" : "s") + ")" });
      continue;
    }
    label = label.trim(); unit = unit.trim();
    const cleaned = String(priceRaw).trim().replace(/^\$/, "").replace(/,/g, "");
    const price = /^\d*\.?\d+$/.test(cleaned) ? parseFloat(cleaned) : NaN;
    if (!label)
      bad.push({ line: i + 1, text: raw, reason: "empty label" });
    else if (!(isFinite(price) && price > 0))
      bad.push({ line: i + 1, text: raw, reason: "price is not a number above 0" });
    else rows.push({ label, unit, price });
  }
  return { rows, bad };
}

// Dry-run plan: which parsed rows ADD a label and which OVERWRITE one that
// already holds a stored price. Duplicate labels inside the file collapse
// to the last occurrence (the row that would win anyway), so the counts
// shown are the counts applied.
function svImportPlan(rows, storedLabels) {
  const stored = new Set(storedLabels || []);
  const byLabel = new Map();
  for (const r of rows || []) byLabel.set(r.label, r);
  const adds = [], overwrites = [];
  for (const r of byLabel.values())
    (stored.has(r.label) ? overwrites : adds).push(r);
  return { adds, overwrites };
}

function svPreviewLine(nNew, nOver, nBad) {
  return nNew + " new, " + nOver + " overwrite, " + nBad + " unparseable"
    + (nBad ? " — shown below" : "");
}
// SETTINGS-PURE-END ----------------------------------------------------------

function svIsOpen() { return !$("settingsView").hidden; }

// raw toggle used by showProjects for view exclusivity: hide, nothing else
function svHide() {
  $("settingsView").hidden = true;
  document.querySelector("main").classList.remove("sv-open");
}

function showSettings(on) {
  on = !!on;
  if (on === svIsOpen()) {
    if (on) renderSettings();        // already there: refresh the book
    return;
  }
  toolsMenuClose();                  // a floating menu belongs to no view
  if (on && pvIsOpen()) showProjects(false);   // the two views are exclusive
  $("settingsView").hidden = !on;
  document.querySelector("main").classList.toggle("sv-open", on);
  $("svBack").hidden = !(on && state.job);
  if (on) {
    renderSettings();
  } else {
    // same resync discipline as showProjects: the canvas buffer went 0x0
    // while its column was display:none, and the operator's zoom must
    // survive the round trip
    syncBuffer();
    if (state.img && !(state.view.k > 0)) { fitView(); draw(); }
    // prices typed on the settings page must show on the itemized panel
    // the moment it is back on screen - renderItemized re-reads the store
    if (state.result) renderItemized();
  }
  try {
    history.replaceState(null, "",
      on ? "#pricing" : location.pathname + location.search);
  } catch (err) { /* the hash is a convenience, never a requirement */ }
}

// labels that hold a stored price right now, from the SAME sessionMem the
// store wrapper fronts - "price:" is priceKey()'s own prefix
function svStoredPriceLabels() {
  return [...sessionMem.keys()]
    .filter(k => k.startsWith("price:"))
    .map(k => k.slice("price:".length));
}

// the open document's itemized rows, label + unit, via the same
// computeTakeoffRows() the itemized panel and the bid view render from
function svLiveItems() {
  if (!state.result) return [];
  const t = computeTakeoffRows();
  if (!t) return [];
  const out = [];
  for (const g of t.groups)
    for (const it of g.items) out.push({ label: it.label, unit: it.unit });
  return out;
}

function renderSettings() {
  renderSvBook();
  renderSvMaterials();
  renderSvFoot();
}

function renderSvBook() {
  const box = $("svBookTable");
  box.innerHTML = "";
  const live = svLiveItems();
  const rows = svBookRows(svStoredPriceLabels(), live);
  $("svBookNote").textContent = !rows.length
    ? "No prices stored yet and no document open — add a line item below, "
      + "import a CSV, or price rows on a sheet's itemized takeoff."
    : rows.length + " label(s): every stored price plus every label on the "
      + "open document's itemized takeoff. “on this sheet” = in the "
      + "open takeoff; “stored only” = priced earlier, not on this "
      + "sheet." + (live.length ? "" : " (No document open, so all rows are "
      + "stored-only.)");
  if (!rows.length) return;
  for (const h of ["label", "unit", "$ / unit", "where", ""]) {
    const th = document.createElement("div");
    th.className = "sv-th"; th.textContent = h;
    box.appendChild(th);
  }
  for (const r of rows) {
    const lab = document.createElement("div");
    lab.className = "sv-lab"; lab.textContent = r.label; lab.title = r.label;
    const unit = document.createElement("div");
    unit.className = "sv-unit"; unit.textContent = r.unit || "";
    const pin = document.createElement("input");
    pin.type = "number"; pin.step = "0.01"; pin.min = "0"; pin.placeholder = "—";
    pin.name = "sv-price-" + r.label;
    const cur = store.getItem(priceKey(r.label));
    if (cur !== null && cur !== "") pin.value = cur;
    // the same write the itemized panel's price input does: store on every
    // keystroke (the store itself drops no-change writes), full re-render
    // only on blur so the control being typed in is never detached
    pin.oninput = () => {
      if (pin.value.trim() === "") store.removeItem(priceKey(r.label));
      else store.setItem(priceKey(r.label), pin.value);
    };
    pin.onchange = () => { renderSvBook(); renderSvFoot(); };
    pin.addEventListener("wheel",
      (ev) => { if (document.activeElement === pin) ev.preventDefault(); },
      { passive: false });
    const where = document.createElement("div");
    where.className = "sv-where";
    where.textContent = r.inUse ? "on this sheet" : "stored only";
    const x = document.createElement("button");
    x.className = "sv-x"; x.textContent = "×";
    x.title = "Clear the stored price for “" + r.label + "”";
    x.disabled = !r.stored && !(cur !== null && cur !== "");
    x.onclick = () => {
      store.removeItem(priceKey(r.label));
      renderSvBook(); renderSvFoot();
    };
    box.append(lab, unit, pin, where, x);
  }
}

$("svAddBtn").onclick = () => {
  const label = $("svAddLabel").value.trim();
  const p = parseFloat($("svAddPrice").value);
  if (!label) return setStatus("give the line item a label first", "err");
  if (!(isFinite(p) && p > 0))
    return setStatus("give it a $ / unit above 0", "err");
  const had = store.getItem(priceKey(label)) !== null;
  store.setItem(priceKey(label), String(p));
  $("svAddLabel").value = ""; $("svAddPrice").value = "";
  setStatus((had ? "updated" : "added") + " “" + label + "” at $"
    + p + " per unit");
  renderSvBook(); renderSvFoot();
};

// MATERIAL DEFAULTS - webui/ew_defaults.js rendered verbatim: name, default,
// citation, and where the operator's override actually lives today. FOUND:
// there is NO settings-scoped override store. The strip depth override is
// the Topsoil layer row in the Earthwork panel (per sheet, saved to the
// server in that page's calculator-inputs sidecar); the material factor
// override is the panel's two factor boxes (#ewFacExp/#ewFacImp), which are
// live inputs and are NOT saved across a reload. The inputs below edit
// exactly those places - no second store is invented here.
function renderSvMaterials() {
  const box = $("svMatBox");
  box.innerHTML = "";
  if (typeof EW_RESEARCH === "undefined") {
    box.textContent = "ew_defaults.js did not load — no defaults to show.";
    return;
  }
  // --- strip depth ---------------------------------------------------------
  const sd = EW_RESEARCH.strip_depth_in;
  const sdRow = document.createElement("div");
  sdRow.className = "sv-ovr";
  const sdName = document.createElement("span");
  sdName.textContent = "Topsoil strip depth — default " + sd.value
    + " in (national band " + sd.national[0] + "–" + sd.national[1] + " in)";
  sdRow.appendChild(sdName);
  const topsoil = state.ew
    && state.ew.layers.existing.find(l => /topsoil/i.test(l.name));
  const sdIn = document.createElement("input");
  sdIn.type = "number"; sdIn.step = "0.5"; sdIn.min = "0";
  sdIn.name = "sv-strip-depth";
  if (topsoil) {
    sdIn.value = topsoil.thickness_in;
    sdIn.oninput = () => {
      topsoil.thickness_in = parseFloat(sdIn.value);
      renderEwLayers();              // the panel's own row shows the same number
      calcStateDirty();              // per-page sidecar, same as other calc edits
    };
  } else {
    sdIn.disabled = true; sdIn.placeholder = "—";
  }
  const sdUnit = document.createElement("span");
  sdUnit.textContent = "in";
  sdRow.append(sdIn, sdUnit);
  const sdWhere = document.createElement("span");
  sdWhere.className = "sv-note";
  sdWhere.textContent = topsoil
    ? "edits the open sheet's Topsoil layer in the Earthwork panel (saved "
      + "with that page's calculator inputs)"
    : "override lives on the Earthwork panel's Topsoil layer row — open a "
      + "sheet, open Earthwork, press “Strip topsoil”";
  sdRow.appendChild(sdWhere);
  box.appendChild(sdRow);
  const sdCite = document.createElement("div");
  sdCite.className = "sv-cite";
  sdCite.textContent = "local prior: " + sd.local;
  box.appendChild(sdCite);
  // --- materials table -----------------------------------------------------
  const grid = document.createElement("div");
  grid.className = "sv-mat";
  for (const h of ["material", "", "bank → loose", "bank → compacted"]) {
    const th = document.createElement("div");
    th.className = "sv-th"; th.textContent = h;
    grid.appendChild(th);
  }
  for (const name of Object.keys(EW_RESEARCH.materials)) {
    const m = EW_RESEARCH.materials[name];
    const n = document.createElement("div"); n.textContent = name;
    const sp = document.createElement("div");
    const b2l = document.createElement("div");
    b2l.textContent = "× " + m.b2l.toFixed(2);
    const b2c = document.createElement("div");
    b2c.textContent = "× " + m.b2c.toFixed(2);
    grid.append(n, sp, b2l, b2c);
    const cite = document.createElement("div");
    cite.className = "sv-cite"; cite.textContent = m.src;
    grid.appendChild(cite);
  }
  box.appendChild(grid);
  // --- factor override: the SAME two live boxes the preset fills ------------
  const fac = document.createElement("div");
  fac.className = "sv-ovr";
  const facName = document.createElement("span");
  facName.textContent = "Override for the open sheet — export factor";
  const mk = (srcId, nm) => {
    const el = document.createElement("input");
    el.type = "number"; el.min = "0"; el.step = "0.05";
    el.name = nm;
    const src = $(srcId);
    el.value = src ? src.value : "";
    el.oninput = () => {
      const src2 = $(srcId);
      if (!src2) return;
      src2.value = el.value;
      // the same event the material preset dispatches, so the Earthwork
      // panel reacts exactly as if the box itself had been typed in
      src2.dispatchEvent(new Event("input", { bubbles: true }));
    };
    return el;
  };
  const facImpName = document.createElement("span");
  facImpName.textContent = "import factor";
  fac.append(facName, mk("ewFacExp", "sv-fac-exp"),
             facImpName, mk("ewFacImp", "sv-fac-imp"));
  const facNote = document.createElement("span");
  facNote.className = "sv-note";
  facNote.textContent = "these ARE the Earthwork panel's factor boxes — "
    + "applied on the sheet's next Calculate, defaulting to 1.0 (per #853), "
    + "and not saved across a reload (existing behaviour, unchanged here)";
  fac.appendChild(facNote);
  box.appendChild(fac);
}

// persistence honesty, from what the store actually is: `store` fronts
// sessionMem and mirrors to localStorage under tk1:: - this browser only
function renderSvFoot() {
  const n = svStoredPriceLabels().length;
  $("svFoot").textContent = "Prices live in this browser (the same "
    + "“Saved work” record as labels and trades — localStorage on "
    + "this machine). They do not sync to the server or to other seats, so "
    + "Export CSV is the backup and the way to move the book to another "
    + "machine. " + n + " price(s) stored.";
}

// ---------- import / export -------------------------------------------------
$("svExportBtn").onclick = () => {
  const rows = [];
  for (const r of svBookRows(svStoredPriceLabels(), svLiveItems())) {
    const p = parseFloat(store.getItem(priceKey(r.label)) || "");
    if (isFinite(p) && p > 0) rows.push({ label: r.label, unit: r.unit, price: p });
  }
  if (!rows.length) return setStatus("nothing to export — the book is empty", "err");
  const blob = new Blob([svSerializeCSV(rows)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "price-book.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  setStatus("exported " + rows.length + " price(s) to price-book.csv");
};

$("svImportBtn").onclick = () => { $("svImportFile").click(); };
$("svImportFile").onchange = async () => {
  const f = $("svImportFile").files[0];
  $("svImportFile").value = "";      // same file can be picked again
  if (!f) return;
  let text = "";
  try { text = await f.text(); }
  catch (e) { return setStatus("could not read the file", "err"); }
  const { rows, bad } = svParseCSV(text);
  const plan = svImportPlan(rows, svStoredPriceLabels());
  const box = $("svImportPreview");
  box.innerHTML = ""; box.hidden = false;
  const line = document.createElement("div");
  line.textContent = f.name + ": "
    + svPreviewLine(plan.adds.length, plan.overwrites.length, bad.length);
  box.appendChild(line);
  for (const b of bad) {
    const d = document.createElement("div");
    d.className = "sv-badline";
    d.textContent = "line " + b.line + " (" + b.reason + "): " + b.text;
    box.appendChild(d);
  }
  const apply = document.createElement("button");
  apply.className = "mini";
  apply.textContent = "Apply " + (plan.adds.length + plan.overwrites.length)
    + " price(s)";
  apply.disabled = !(plan.adds.length + plan.overwrites.length);
  apply.onclick = () => {
    if (plan.overwrites.length
        && !confirm("Import from “" + f.name + "”?\n\n"
          + plan.overwrites.length + " existing price(s) will be OVERWRITTEN ("
          + plan.overwrites.map(r => r.label).slice(0, 12).join(", ")
          + (plan.overwrites.length > 12 ? ", …" : "") + ")\n"
          + plan.adds.length + " new label(s) will be added.\n\n"
          + "The unit column is informational — prices key on the label alone."))
      return;
    for (const r of plan.adds) store.setItem(priceKey(r.label), String(r.price));
    for (const r of plan.overwrites) store.setItem(priceKey(r.label), String(r.price));
    box.hidden = true; box.innerHTML = "";
    setStatus("imported " + (plan.adds.length + plan.overwrites.length)
      + " price(s) — " + plan.adds.length + " new, "
      + plan.overwrites.length + " overwritten"
      + (bad.length ? "; " + bad.length + " line(s) were unparseable and "
        + "were NOT imported" : ""));
    renderSvBook(); renderSvFoot();
    if (state.result) renderItemized();
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = "Cancel";
  cancel.onclick = () => { box.hidden = true; box.innerHTML = ""; };
  const btns = document.createElement("div");
  btns.className = "sv-io";
  btns.append(apply, cancel);
  box.appendChild(btns);
};

// ---------- entry points ----------------------------------------------------
$("settingsLink").onclick = (e) => {
  e.preventDefault();
  if (svIsOpen()) {
    if (state.job) showSettings(false);   // second click toggles back
    return;
  }
  showSettings(true);
};
$("svBack").onclick = () => showSettings(false);

// While the settings view is up the workbench is INVISIBLE, so none of its
// single-key shortcuts may reach it - the same swallow discipline as the
// projects view, Ctrl+Z / Ctrl+Y included (undo must not act on the hidden
// sheet). Esc returns to the sheet, or to Projects when no job is open.
const SV_SWALLOW_KEYS = new Set(["m", "f", "l", "s", "x", "e", "d", "i",
                                 "j", "r", "?", "Delete", "Backspace"]);
addEventListener("keydown", (e) => {
  if (!svIsOpen() || typing()) return;
  if (e.key === "Escape") {
    e.stopImmediatePropagation();
    e.preventDefault();
    showSettings(false);
    if (!state.job) showProjects(true);
    return;
  }
  if (SV_SWALLOW_KEYS.has(e.key) || SV_SWALLOW_KEYS.has(e.key.toLowerCase())
      || ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")))
    e.stopImmediatePropagation();
}, true);
// =============== end PRICING SETTINGS ======================================

// =============== toolkit rich hover demos (TIPVID) =========================
// The Photoshop rich-tooltip pattern on the toolkit rail: rest the pointer
// on a tool button for 600ms and a small popover opens beside the rail with
// a short SILENT looping clip of that tool doing its real work (recorded
// live on Barn C3.0 - files and captions in webui/tooldemos/manifest.json),
// the button's own title text verbatim, and the shortcut key. It is a HINT,
// never a control: pointer-events:none, instant close on leave/click/Esc,
// and it never opens while a canvas tool is armed - an operator brushing
// the rail mid-gesture must not get a video in the face. Native title
// attributes are untouched: they stay the accessible description and the
// whole story for buttons without a clip (faithful toggle, help, clear).
// Zero video bytes load up front: the manifest is fetched on the first
// hover ever, and a clip's src is set only when its popover first opens.

// TIPVID-PURE-BEGIN
// Pure lookup + placement math (no DOM, no state.*) so
// tests/test_tooldemo_tips.js can eval just this block.
const TIPVID_HOVER_DELAY_MS = 600;

// manifest row for a button, or null (no clip -> native title only)
function tipvidEntry(manifest, btnId) {
  if (!manifest || typeof manifest !== "object") return null;
  const e = Object.prototype.hasOwnProperty.call(manifest, btnId)
    ? manifest[btnId] : null;
  return e && typeof e.file === "string" ? e : null;
}

// Place the popover just right of the rail button, vertically centred on
// it, clamped inside the viewport; when the right side cannot fit (tiny
// window) it flips to the left of the rail rather than covering it.
function tipvidPos(btn, pop, vw, vh, gap) {
  let x = btn.right + gap;
  if (x + pop.w > vw - 4) x = Math.max(4, btn.left - gap - pop.w);
  let y = btn.top + btn.height / 2 - pop.h / 2;
  y = Math.min(y, vh - pop.h - 4);
  y = Math.max(4, y);
  return { x, y };
}
// TIPVID-PURE-END

(() => {
  const rail = document.querySelectorAll(".toolkit .tk");
  if (!rail.length) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let manifest;            // undefined until the first hover fetches it
  let manifestReq = null;
  let pop = null, vid = null, tTitle = null, tCap = null, tKey = null;
  let timer = null;

  function withManifest(fn) {
    if (manifest !== undefined) { fn(); return; }
    if (!manifestReq)
      manifestReq = fetch("tooldemos/manifest.json")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((m) => { manifest = m; });
    manifestReq.then(fn);
  }

  function build() {
    if (pop) return;
    pop = document.createElement("div");
    pop.id = "tipvid";
    pop.hidden = true;
    pop.setAttribute("aria-hidden", "true");   // the title attr already reads
    vid = document.createElement("video");
    // muted looping inline autoplay; preload=none so no bytes move until a
    // popover actually opens and sets src
    vid.muted = true;
    vid.loop = true;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.setAttribute("playsinline", "");
    vid.preload = "none";
    tTitle = document.createElement("div");
    tTitle.className = "tv-title";
    tKey = document.createElement("kbd");
    tCap = document.createElement("div");
    tCap.className = "tv-cap";
    pop.append(vid, tTitle, tCap);
    document.body.appendChild(pop);
  }

  function closeTip() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pop && !pop.hidden) {
      pop.hidden = true;
      try { vid.pause(); } catch (e) { /* not loaded yet */ }
    }
  }

  function openTip(btn) {
    // a drawing/measuring/box gesture owns the canvas - no video in the face
    if (state.tool) return;
    const ent = tipvidEntry(manifest, btn.id);
    if (!ent) return;                    // no clip: native title only
    build();
    tTitle.textContent = btn.getAttribute("title") || "";
    tCap.textContent = ent.caption || "";
    tKey.remove();
    if (ent.key) { tKey.textContent = ent.key; tCap.append(" ", tKey); }
    const src = "tooldemos/" + ent.file;
    if (vid.getAttribute("src") !== src) vid.setAttribute("src", src);
    if (reduced.matches) {
      // reduced motion: the first frame, paused - a poster, not a loop
      const still = () => { vid.pause(); try { vid.currentTime = 0; } catch (e) {} };
      if (vid.readyState >= 2) still();
      else { vid.addEventListener("loadeddata", still, { once: true }); vid.load(); }
    } else {
      const pr = vid.play();
      if (pr && pr.catch) pr.catch(() => {});
    }
    // measure hidden, then place beside the rail, clamped to the viewport
    pop.style.visibility = "hidden";
    pop.hidden = false;
    const b = btn.getBoundingClientRect();
    const p = tipvidPos(
      { left: b.left, right: b.right, top: b.top, height: b.height },
      { w: pop.offsetWidth, h: pop.offsetHeight },
      innerWidth, innerHeight, 10);
    pop.style.left = p.x + "px";
    pop.style.top = p.y + "px";
    pop.style.visibility = "";
  }

  for (const btn of rail) {
    btn.addEventListener("pointerenter", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        withManifest(() => { if (btn.matches(":hover")) openTip(btn); });
      }, TIPVID_HOVER_DELAY_MS);
    });
    btn.addEventListener("pointerleave", closeTip);
    // a click means USE the tool, not watch it - and no re-open until the
    // pointer leaves and comes back (pointerenter will not refire in place)
    btn.addEventListener("pointerdown", closeTip);
  }
  // capture phase: the app's own Esc cascade stops propagation downstream,
  // and a hint must die on Esc no matter which panel handled the key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTip();
  }, true);
})();
// =============== end toolkit rich hover demos ==============================
