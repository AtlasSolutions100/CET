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

const state = window.state = {
  job: null, page: 0, kinds: [],
  img: null, result: null,
  include: new Map(), labels: new Map(), isolate: null, hot: null,
  selected: null, excluded: new Set(),
  chainLabels: new Map(),   // chain_id -> label override (separate-from-group)
  nextChainId: 1,           // ids for chains created by edits
  clickPt: null,            // last click position on the selected chain (pt)
  tool: null,               // "measure" | "extend" | null
  measurePts: [],
  faithful: true,           // draw each line with its true pattern + weight
  gen: 0,                   // bumped per document/page switch; stale async
                            // callbacks compare against it and bail out
  selPt: null,              // index of the selected vertex on state.selected
  cutA: null,               // first anchor of an in-progress cut-span
  drawPts: [],              // vertices of the in-progress drawn line
  drawSrc: null,            // chain_id whose family a drawn line joins
  hoverPt: null,            // cursor position for the draw preview
  dragPt: false,
  legendNames: [],          // trade names read off a dedicated legend sheet
  ew: null,                 // earthwork panel state {rows, result}
  conf: null,               // /confidence payload for the current page:
                            // NOT-TO-SCALE + spot-elevation provenance, the
                            // two trust facts the detect result cannot carry
  confKey: null,            // "job:page" the payload above belongs to
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
  view: { x: 0, y: 0, k: 1 },
};

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
  // the remove button belongs to whatever is on screen now
  setTimeout(syncRemoveBtn, 0);
  state.gen++;
  // a newly uploaded set should appear in the picker without a reload
  setTimeout(loadRecent, 300);
  state.job = j.job_id; state.result = null;
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
  state.ai = null; state.aiWhy = new Map(); state.aiUndo = null; state.measureMode = new Map(); state.aiAuto = false; state.seedLabels = new Map(); state.elevMap = undefined; state.aiHidden = false; $("aiBtn").textContent = "Analyze";
  $("aiBanner").hidden = true;
  state.conf = null; state.confKey = null; state.confErr = false;
  updateSelBar(null);
  // scaleMemApply BEFORE renderSheetHead, always - see loadResult().
  scaleMemApply();
  scopeApply();
  renderSheetHead();
  renderScopeBar();
  renderStyles(); renderChips(); renderLegend(); renderAreas(); renderItemized(); renderMiniLegend(); fitOnLoad();
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
  if (j.status === "done") { setStatus("done"); setPageStatus(state.page, "done"); loadResult(gen); }
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
    const badge = document.createElement("span");
    const st = state.pageStatus[p] || "idle";
    badge.className = "thumb-badge " + st;
    badge.title = BADGE_TITLE[st] || st;
    foot.append(num, badge);
    t.append(img, foot);
    t.onclick = () => {
      if (p === state.page) return;
      $("pageSel").value = p;
      selectPage(p);
    };
    list.appendChild(t);
  });
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
  state.tool = null; state.measurePts = [];
  state.ai = null; state.aiWhy = new Map(); state.aiUndo = null; state.measureMode = new Map(); state.aiAuto = false; state.seedLabels = new Map(); state.elevMap = undefined; state.aiHidden = false; $("aiBtn").textContent = "Analyze";
  state.ew = null; state.hotChain = null; state.extraItems = [];
  // a limit of work belongs to ONE sheet: the next page's grading line is
  // a different polygon, and carrying this one over would clip the new
  // sheet's volumes to an outline drawn somewhere else
  state.ewBound = null;
  state.conf = null; state.confKey = null; state.confErr = false;
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
  renderStyles(); renderChips(); renderLegend(); renderAreas();
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
    const q = ftPerIn ? st.length_pt / 72 * ftPerIn : st.length_pt;
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
  meta.append(chip(`Sheet ${state.page + 1} / ${state.kinds.length}`));
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
      if (scaleUndo.key !== scaleTypedKey()) {
        scaleUndo.key = scaleTypedKey();
        scaleUndo.scale = state.result.scale || null;
      }
      state.result.scale = scaleTypedObj(state.result.scale, p.ft, p.text);
      try {
        store.setItem(scaleTypedKey(), JSON.stringify({ ft: p.ft, text: p.text }));
        store.removeItem(scaleKey());
      } catch (e) { /* private mode: this session still honours it */ }
      scaleTypedOpen = false; scaleTypedDraft = "";
      setStatus(`scale set BY HAND to ${p.ft.toFixed(2)} ft per inch — every `
        + `quantity on this sheet recalculated from a number you typed, not `
        + `one the sheet states`);
      scaleRepaint();
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
    if (sp.from_sheet_note)
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
    if (sp.inferred)
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
  if (!state.result) { box.hidden = true; box.innerHTML = ""; return; }
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
}

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
    const ft = ftPerIn ? s.length_pt / 72 * ftPerIn : s.length_pt;
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
  const CLASS_ORDER = ["solid", "dash1", "dash2", "dash3", "dash-text"];
  const CLASS_NAME = { solid: "Solid lines", dash1: "Dashed",
    dash2: "Dash-dot", dash3: "Compound (dash-dot-dot)",
    "dash-text": "Lettered runs (W / SD / FO)" };
  const styles = [...state.result.styles].sort((a, b) =>
    CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class)
    || b.length_pt - a.length_pt);
  let lastClass = null;
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
    cb.onclick = (e) => { e.stopPropagation(); setInclude(s.style_id, cb.checked);
      // Ticking a row the scope filter set aside IS the put-back: record it,
      // or scopeApply() would untick it again on the next repaint and the
      // operator would watch their own click undo itself.
      if (sv.v === "out" && cb.checked) { scopeKeepRow(s, true); return; }
      if (sv.v === "kept" && !cb.checked) { scopeKeepRow(s, false); return; }
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
    meta.textContent = `${fmtQty(s.length_pt)} · ${s.n} lines · ${s.signature}`;
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
        const nm = document.createElement("span");
        nm.className = "sl-name"; nm.textContent = layerTail(lay);
        layerEl.append(tag, nm);
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
  const st = state.result && state.result.styles.find(x => x.style_id === sid);
  if (!st) return;                       // nothing to key the record on
  try { store.setItem(includeKey(st), on ? "1" : "0"); }
  catch (e) { /* private mode: the session still honours the click */ }
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
  for (const st of state.result.styles) {
    const inc = store.getItem(includeKey(st));
    if (inc !== null) state.include.set(st.style_id, inc === "1");
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
    sumPt += ch.length_pt;
    const p = ch.points;
    if (!p || p.length < 2) continue;
    for (let i = 1; i < p.length; i++) {
      const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      if (d < 0.05) continue;   // same skip as tools/containment.py leg_index
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
function computeTakeoffRows() {
  if (!state.result) return null;
  const sc = state.result.scale;
  const ftPerIn = sc ? sc.ft_per_paper_inch : null;
  const totals = new Map();
  const sheetChains = [];
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (!state.include.get(ch.style_id)) continue;
    const label = state.chainLabels.get(ch.chain_id) ||
      state.labels.get(ch.style_id) || "unlabeled";
    const t = totals.get(label) ||
      { count: 0, pt: 0, objects: 0, objSids: new Set(), chains: [] };
    t.count += 1; t.pt += ch.length_pt; t.chains.push(ch);
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
  const items = [...totals.entries()].map(([label, t]) => t.objects
    ? { label, cnt: "EA", unit: "EA", qty: t.objects,
        qtyText: String(t.objects), priced: true, isObj: true,
        ft: ftPerIn ? t.pt / 72 * ftPerIn : null }
    : { label, cnt: String(t.count), unit: ftPerIn ? "ft" : "pt",
        qty: pt2q(t.pt),
        sumQty: pt2q(t.pt),
        unionQty: pt2q(t.dup.unionPt),
        dupQty: pt2q(t.dup.excessPt),
        dupLegs: t.dup.sharedLegs,
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
  // always-visible tally: sum of INCLUDED footage + priced total
  let inkPt = 0;
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (!state.include.get(ch.style_id)) continue;
    inkPt += ch.length_pt;
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
  tb.textContent =
    (ovRowN
      ? abbrQ(billedQ) + " billed \u00b7 " + abbrQ(autoQ) + " measured"
      : (tf !== null
          ? (tf >= 1000 ? (tf/1000).toFixed(1) + "k" : tf.toFixed(0)) + " ft measured"
          : fmtLen(inkPt) + " measured"))
    + (sheet.excessPt > 0.05
        ? " · union " + (uf !== null
            ? (uf >= 1000 ? (uf/1000).toFixed(1) + "k" : uf.toFixed(0)) + " ft"
            : fmtLen(sheet.unionPt))
        : "")
    + (grand ? ` · $${grand.toFixed(0)}` : "");
  const ovPrefix = ovRowN
    ? `${ovRowN} row(s) on this sheet carry a quantity YOU typed, so "billed" `
      + `is your figure and "measured" is the detector's. The dollar total `
      + `follows the billed figure.\n\n`
    : "";
  tb.title = ovPrefix + (sheet.excessPt > 0.05
    ? `Sum adds every included chain's length. Union counts each polyline ` +
      `segment once: ${sheet.sharedLegs} segment(s) across ` +
      `${sheet.nChains} included chains are carried by two or more chains, ` +
      `worth ${fmtLen(sheet.excessPt)} ` +
      `(${(sheet.excessPt / sheet.sumPt * 100).toFixed(2)}% of the sum). ` +
      `Nothing is removed - both numbers are the same chains, counted two ` +
      `ways. Identical-geometry test, so it is a lower bound.`
    : `No included chain on this sheet shares a polyline segment with ` +
      `another, so the sum already counts each segment once.`);
  if (grand) {
    const row = document.createElement("div");
    row.className = "item-row total";
    row.innerHTML = `<div>TOTAL</div><div></div><div></div><div></div><div>${grand.toFixed(0)}</div>`;
    box.appendChild(row);
  }
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
let BETA_CSV_TAIL = "\n\nBETA SOFTWARE - NOT FOR COMMERCIAL USE. "
  + "Check every quantity against the drawings.\n";

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
  ["stylesHead", ["styleList", "colorChips", "styleSearch"]],
  ["takeoffHead", ["itemized"]],
  ["ewHead", ["ewRows", "ewHint", "ewLimit", "ewLayers", "ewActions",
              "ewBasis", "ewTake", "ewBalance"]],
  ["trHead", ["trBody", "trHint", "trActions"]],
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
  // a page switch nulls state.tool without touching this button's class
  $("ewAddRow").classList.remove("active");
  $("ewBoundPick").classList.remove("active");
  renderEwBound();
  if (!state.ew) {
    $("ewRows").innerHTML = '<div class="ew-hint">reading elevation labels…</div>';
    const r = await fetch(`/api/job/${state.job}/page/${state.page}/earthwork/suggest`);
    if (!r.ok) { $("ewRows").textContent = "run Detect first"; return; }
    const j = await r.json();
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
      spotOn: { FG: true, ME: true, EG: true },
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
  }
  renderEw();
  renderEwLayers();
  renderEwSpots();
  renderEwArea();
  renderEwTake();
};

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
  return true;
}
function ewBoundClear() {
  state.ewBound = null;
  renderEwBound();
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
    if (ch && ewBoundSet(ch.points, "chain " + ch.chain_id)) {
      setStatus("limit of work set from the selected line");
      return;
    }
  }
  state.tool = "ew-bound";
  $("ewBoundPick").classList.add("active");
  setStatus("limit of work: click the grading-limit line on the sheet "
    + '—' + " Esc cancels", "busy");
};
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
  if (ewBoundSet(best.points, "chain " + best.chain_id))
    setStatus("limit of work set " + '—' + " recalculate to apply it");
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
  state.hotChain = cid;
  renderEw();
  draw();
  const inp = $("ewRows").querySelector(`input[name="ew-z-${cid}"]`);
  if (inp) inp.focus();
  setStatus(`chain ${cid} added — type its elevation, then EXIST or PROP`);
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
  // Topsoil is stripped first on every job; 12" is a placeholder for the
  // soils-report thickness (Beaumont quoted 12"; their Barn bid works out
  // to ~8.3") - editable like any other row
  if (!state.ew.layers.existing.some(l => /topsoil/i.test(l.name)))
    state.ew.layers.existing.unshift({ name: "Topsoil", thickness_in: 12,
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
function ewFactor(id) {
  const el = $(id);
  const v = el ? parseFloat(el.value) : NaN;
  return (isFinite(v) && v > 0) ? v : 1;
}

// spot grades the estimator switched on, with the datum applied when the
// sheet gave us no contour label to anchor them against
function ewActiveSpots() {
  if (!state.ew || !state.ew.spots) return [];
  const base = state.ew.spotDatum;
  return state.ew.spots
    .filter(g => state.ew.spotOn[g.tag])
    .map(g => {
      if (g.resolved && isFinite(g.z)) return g;
      if (!isFinite(base)) return null;
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
  if (!sp.some(g => g.resolved)) {
    const d = document.createElement("div");
    d.className = "sp-datum";
    d.append(document.createTextNode("No contour label on this sheet to anchor them. Datum:"));
    const i = document.createElement("input");
    i.type = "number"; i.step = "100"; i.placeholder = "7700";
    i.value = isFinite(state.ew.spotDatum) ? state.ew.spotDatum : "";
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
      b.onclick = () => { row.surface = key; renderEw(); };
      seg.appendChild(b);
    }
    const x = document.createElement("button");
    x.className = "mini x"; x.textContent = "×";
    x.title = "remove this contour from the calculation";
    x.onclick = () => {
      state.ew.rows = state.ew.rows.filter(r => r !== row);
      if (state.hotChain === row.chain_id) state.hotChain = null;
      renderEw();
      draw();
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
  $("ewResult").innerHTML =
    `<b>cut ${ewCY(cutQ)} CY</b> · <b>fill ${ewCY(fillQ)} CY</b>` +
    ` · net ${ewCY(j.net_yd3)} CY over ${Number(j.area_sf).toLocaleString()} SF` +
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
  box.classList.toggle("off", !j);
  if (!j) return;
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
  draw();
}
$("ewMap").onchange = async () => {
  if (!state.ew) { $("ewMap").checked = false; return; }
  if ($("ewMap").checked) await ewFetchMap();
  else { state.ew.map = null; draw(); }
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
  if (!state.tr) {
    state.tr = {
      style_id: null, od_in: 6, d0_ft: 2, d1_ft: 8,
      rules: TR_DEFAULT_RULES.map(r => ({ ...r })),
    };
  }
  renderTr();
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
  const clrFt = (d) => {
    for (const r of t.rules) if (d <= r.to_ft) return r.clr_in / 12.0;
    return t.rules.length ? t.rules[t.rules.length - 1].clr_in / 12.0 : 0.5;
  };
  const N = 60;  // integration steps along each run
  let dig = 0, bed = 0, runFt = 0;
  for (const c of chains) {
    const L = c.length_pt * ftPerPt;
    runFt += L;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / N;
      const d = t.d0_ft + (t.d1_ft - t.d0_ft) * x;   // invert depth here
      const w = odFt + 2 * clrFt(d);                  // trench width here
      dig += w * Math.max(d, 0) * (L / N);            // dig surface->invert
      bed += w * (odFt + 2 * clrFt(d)) * (L / N);     // envelope around pipe
    }
  }
  const pipeVol = Math.PI * (odFt / 2) ** 2 * runFt;
  bed = Math.max(bed - pipeVol, 0);
  const backfill = Math.max(dig - bed - pipeVol, 0);
  const cy = (v) => Math.round(v / 27 * 10) / 10;
  $("trResult").innerHTML =
    `<b>dig ${cy(dig).toLocaleString()} CY</b> · <b>bedding ${cy(bed).toLocaleString()} CY</b>` +
    ` · backfill ${cy(backfill).toLocaleString()} CY · ${Math.round(runFt).toLocaleString()} LF of pipe`;
  const name = (state.labels.get(t.style_id) || "pipe").slice(0, 40);
  state.extraItems = state.extraItems.filter(it => !it.label.startsWith("Trench") && !it.label.startsWith("Bedding") && !it.label.startsWith("Backfill") && !it.label.endsWith("(run)"));
  // The FOOTAGE is the line item an excavator actually bids. Every utility
  // row on Beaumont's Estimate #853 is priced per LF - the perimeter drain
  // alone is 3,395 LF / $105,245 - while the CY volumes below are the
  // supporting math. Emit the run first so it leads the group.
  if (runFt > 0) state.extraItems.push({ label: `${name} (run)`, qty: Math.round(runFt * 10) / 10, unit: "LF" });
  if (dig > 0) state.extraItems.push({ label: `Trench excavation (${name})`, qty: cy(dig), unit: "CY" });
  if (bed > 0) state.extraItems.push({ label: `Bedding gravel (${name})`, qty: cy(bed), unit: "CY" });
  if (backfill > 0) state.extraItems.push({ label: `Backfill (${name})`, qty: cy(backfill), unit: "CY" });
  renderItemized();
};

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
      what += ` <span class="ai-warn">removes ${esc(aiQty(p.st.length_pt))}`
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
        picked_by_reviewer: !!scOn.picked_by_reviewer }
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
  if (state.result) {
    const f = IMG_DPI / 72; // pt -> image px
    for (const ch of state.result.chains) {
      const sid = ch.style_id;
      if (state.excluded.has(ch.chain_id)) continue;
      if (state.isolate !== null && sid !== state.isolate) continue;
      if (state.isolate === null && !state.include.get(sid)) continue;
      const hot = state.hot === sid || state.hotChain === ch.chain_id;
      const sel = state.selected === ch.chain_id;
      const st2 = state.result.styles.find(x => x.style_id === ch.style_id);
    ctx.globalAlpha = st2 && (st2.texture || st2.class === "annotation") ? 0.25 : 1.0;
    ctx.strokeStyle = sel ? "#ff00cc" : cssColor(styleColor(sid), ch.width || (st2 && st2.width));
      // real plotted weight, floored so a hairline stays visible zoomed out
      const wPt = Math.max(ch.width || 0.35, 0.35) * f;
      ctx.lineWidth = sel ? 4.5 / k : Math.max(hot ? wPt * 2.0 : wPt, 1.4 / k);
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
  // cut-span first anchor
  if (state.tool === "cutspan" && state.cutA) {
    const f2 = IMG_DPI / 72;
    ctx.beginPath();
    ctx.arc(state.cutA.q[0] * f2, state.cutA.q[1] * f2, 5 / k, 0, Math.PI * 2);
    ctx.fillStyle = "#e0245e"; ctx.fill();
    ctx.lineWidth = 1.5 / k; ctx.strokeStyle = "#ffffff"; ctx.stroke();
  }
  // in-progress drawn line
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
cv.addEventListener("mousedown", (e) => {
  // while a click-tool is armed, clicks land IN the tool - a click on a
  // vertex dot is a cut/draw/measure anchor, never a point-drag
  const v = state.tool ? null : vertexAt(e);
  if (v !== null) {           // grab the handle rather than pan the sheet
    state.selPt = v;
    state.dragPt = true;
    updateSelBar(chainById(state.selected));
    draw();
    return;
  }
  panning = { x: e.clientX, y: e.clientY };
  downAt = { x: e.clientX, y: e.clientY };
  cv.classList.add("panning");
});
addEventListener("mousemove", (e) => {
  if (state.dragPt) {
    const ch = chainById(state.selected);
    if (ch && state.selPt !== null) {
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
  if (state.dragPt) {
    state.dragPt = false;
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
    const c = materialize(sel);
    c.style_id = tgt.style_id;
    c.class = tgt.class; c.color = tgt.color; c.width = tgt.width;
    c.dash_signature = tgt.dash_signature;
    if (tgt.template) c.template = JSON.parse(JSON.stringify(tgt.template));
    state.tool = null;
    $("reclassBtn").classList.remove("active");
    state.selected = c.chain_id;
    updateSelBar(c);
    const lab = state.labels.get(tgt.style_id) || "its new family";
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
  setStatus(msg);
  renderItemized();
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
  info.textContent = sc
    ? `${(pt / 72 * sc.ft_per_paper_inch).toFixed(1)} ft`
    : fmtLen(pt);
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
  $("selInfo").textContent = `${ch.class} · ${label} · ${fmtQty(ch.length_pt)}${pt}${el}`;
}

function deleteVertex() {
  const ch = chainById(state.selected);
  if (!ch || state.selPt === null) return false;
  if (ch.points.length <= 3) {
    setStatus("too few points left — remove the whole line instead", "err");
    return true;
  }
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

function removeSelected() {
  if (state.selected === null) return;
  if (deleteVertex()) return;   // a picked point goes first, not the line
  state.excluded.add(state.selected);
  state.selected = null; state.selPt = null;
  updateSelBar(null);
  setStatus(`${state.excluded.size} line(s) removed`);
  $("restoreBtn").hidden = state.excluded.size === 0;
  renderItemized();
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
  $("restoreBtn").hidden = true;
  setStatus("removed lines restored");
  renderItemized();
  draw();
};
function typing() {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
    || el.tagName === "SELECT" || el.isContentEditable);
}
addEventListener("keydown", (e) => {
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
    removeSelected();
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
    if (state.tool === "cutspan") {
      cancelCut();
      setStatus("cut cancelled");
      draw();
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
    if (state.selPt !== null) { state.selPt = null; updateSelBar(chainById(state.selected)); }
    else { state.selected = null; updateSelBar(null); }
    // Last, so every tool above still gets Escape first. Nothing cleared an
    // isolate except clicking the same row again or changing page, and with
    // no indicator to notice (see renderStyles) an operator could leave one on
    // indefinitely and read a filtered sheet as the whole sheet.
    if (state.isolate !== null) {
      state.isolate = null;
      renderStyles(); renderMiniLegend();
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

resize();
