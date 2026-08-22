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
  hotChain: null,           // chain highlighted from a calculator row
  extraItems: [],           // calculator outputs: {label, qty, unit}
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

async function openPath(path) {
  setStatus("opening…", "busy");
  const r = await fetch("/api/open-path", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  if (!r.ok) return setStatus(`could not open (${r.status})`, "err");
  const j = await r.json();
  state.gen++;
  state.job = j.job_id; state.kinds = j.kinds; state.result = null;
  state.legendNames = []; $("legendVocab").innerHTML = "";
  $("docName").textContent = j.name;
  state.docName = j.name;
  const sel = $("pageSel");
  sel.innerHTML = "";
  j.kinds.forEach((k, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = `page ${i + 1} — ${k}`;
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
  updateSelBar(null);
  renderSheetHead();
  renderStyles(); renderChips(); renderLegend(); renderItemized(); renderMiniLegend(); fitOnLoad();
  const img = new Image();
  img.onload = () => {
    if (gen !== state.gen) return;   // a later page won the race
    state.img = img; fitView(); draw();
  };
  img.src = url(`/api/job/${state.job}/page/${p}/image?dpi=${IMG_DPI}`);
  markCurrentThumb();
  // reuse a finished result if the server has one
  const st = await (await fetch(`/api/job/${state.job}/page/${p}/status`)).json();
  if (gen !== state.gen) return;
  if (st.status === "done") loadResult(gen);
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
    t.title = `page ${p + 1} — ${kind}`;
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
  state.tr = null; state.sym = null; state.symMarks = null;
  $("ewPanel").hidden = true; $("ewBtn").hidden = false;
  $("ewMap").checked = false;
  $("ewResult").textContent = "";  // stale numbers must not survive a doc/page switch
  $("trPanel").hidden = true; $("trBtn").hidden = false;
  $("symPanel").hidden = true; $("symBtn").hidden = false;
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
  renderSheetHead();
  renderStyles(); renderChips(); renderLegend(); renderItemized(); renderMiniLegend(); draw();
  document.getElementById("aiBtn").hidden = false;
  if (state.autoAi) runAnalyze(true);   // opt-in power mode only
  const sc = state.result.scale;
  setStatus(`${state.result.chains.length} lines in ${state.result.styles.length} styles` +
    (sc ? ` · scale ${sc.text} (${sc.source})` : " · no scale found"));
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
function styleObjects(sid) {
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
  const sc = state.result && state.result.scale;
  if (state.result)
    meta.append(chip(sc ? sc.text : "no scale", sc ? "ok" : "warn"));
  const st = state.result ? "detected"
    : (state.pageStatus || [])[state.page] === "running" ? "detecting…"
    : (state.pageStatus || [])[state.page] === "error" ? "detect failed"
    : "not detected";
  meta.append(chip(st, state.result ? "ok"
    : st === "detect failed" ? "warn" : ""));
  el.append(name, meta);
}

function renderStyles() {
  const box = $("styleList");
  box.innerHTML = "";
  $("approveBtn").disabled = !state.result;
  $("csvBtn").disabled = !state.result;
  if (!state.result) return;
  const q = ($("styleSearch") ? $("styleSearch").value : "").trim().toUpperCase();
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
    if (q && !((label + " " + s.signature + " " + s.class)
               .toUpperCase().includes(q)))
      continue;
    if (s.class !== lastClass) {
      lastClass = s.class;
      const h = document.createElement("div");
      h.className = "class-head";
      h.textContent = CLASS_NAME[s.class] || s.class;
      box.appendChild(h);
    }
    const row = document.createElement("div");
    row.className = "style-row" + (state.include.get(s.style_id) ? "" : " off");
    row.dataset.sid = s.style_id;

    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!state.include.get(s.style_id);
    cb.onclick = (e) => { e.stopPropagation(); state.include.set(s.style_id, cb.checked);
      store.setItem(docKey() + "::inc::" + styleFp(s), cb.checked ? "1" : "0");
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
      memSave(s);
      renderStyles(); renderItemized(); renderMiniLegend(); draw();
    };

    const ai = state.aiWhy.get(s.style_id);
    if (ai) {
      row.classList.add(ai.keep ? "ai-keep" : "ai-drop");
      row.title = (ai.keep ? "AI: measure this — " : "AI: not takeoff — ") + (ai.why || "");
    }

    row.append(cb, sw, main, mm, badge);
    row.onmouseenter = () => { state.hot = s.style_id; draw(); };
    row.onmouseleave = () => { state.hot = null; draw(); };
    row.onclick = () => { state.isolate = state.isolate === s.style_id ? null : s.style_id; draw(); };
    box.appendChild(row);
  }
}
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
      state.include.set(sid, true);
      renderStyles(); renderLegend(); renderItemized(); draw();
    };
    box.appendChild(chip);
  }
}

$("styleSearch").oninput = () => renderStyles();
$("allBtn").onclick = () => { for (const k of state.include.keys()) state.include.set(k, true); renderStyles(); renderChips(); renderItemized(); renderMiniLegend(); draw(); };
$("noneBtn").onclick = () => { for (const k of state.include.keys()) state.include.set(k, false); renderStyles(); renderChips(); renderItemized(); renderMiniLegend(); draw(); };

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
      for (const sid of g.sids) state.include.set(sid, !anyOn);
      renderStyles(); renderChips(); renderItemized(); draw();
    };
    box.appendChild(chip);
  }
}

// ---------- live itemized takeoff ----------
// NO cross-session blueprint memory: every label, include, EA-mode, qty/ft
// override, price, and trade edit lives in THIS session only, so a reload
// here produces exactly what a client's fresh seat produces. UI prefs
// (theme, panel collapse) stay in localStorage; takeoff decisions never do.
const sessionMem = new Map();
const store = {
  getItem: (k) => sessionMem.has(k) ? sessionMem.get(k) : null,
  setItem: (k, v) => sessionMem.set(k, String(v)),
  removeItem: (k) => sessionMem.delete(k),
};
// purge memory left behind by earlier builds so it can never resurface
for (const k of Object.keys(localStorage))
  if (/^(doc::|measure::|trade::|price:)/.test(k)) localStorage.removeItem(k);
function priceKey(label) { return "price:" + label; }
// quantity/footage override: the estimator's number beats the detector's.
// Doc-scoped (this sheet has 24 shear walls; another sheet doesn't).
function ovKey(label, kind) {
  return docKey() + "::ov:" + kind + ":" + label.trim().toUpperCase();
}
// ---------- style memory: the reviewer's decisions ARE the takeoff -------
// Deterministic consistency: once a style is labeled / set to EA, that
// decision is stored against (document, style fingerprint) and reapplies
// identically on every restart, redetect, and reopen. No model involved.
function docKey() {
  return "doc::" + (state.docName || "unknown");
}
function styleFp(st) {
  return [st.class, Math.round((st.width || 0) * 2) / 2,
          cssColor(st.color), st.signature].join("|");
}
function memSave(st) {
  const label = (state.labels.get(st.style_id) || "").trim();
  const measure = state.measureMode.get(st.style_id) === "object" ? "object" : "";
  const k = docKey() + "::" + styleFp(st);
  if (label || measure)
    store.setItem(k, JSON.stringify({ label, measure }));
  else store.removeItem(k);
  // label-level measure memory travels ACROSS documents: "shear wall" set
  // to EA once means shear walls count as objects everywhere
  if (label && measure)
    store.setItem("measure::" + label.toUpperCase(), measure);
}
function memApply() {
  if (!state.result) return;
  for (const st of state.result.styles) {
    const inc = store.getItem(docKey() + "::inc::" + styleFp(st));
    if (inc !== null) state.include.set(st.style_id, inc === "1");
    const raw = store.getItem(docKey() + "::" + styleFp(st));
    if (raw) {
      try {
        const m = JSON.parse(raw);
        if (m.label) state.labels.set(st.style_id, m.label);
        if (m.measure === "object")
          state.measureMode.set(st.style_id, "object");
      } catch (e) {}
    }
    const lab = (state.labels.get(st.style_id) || "").trim().toUpperCase();
    if (lab && store.getItem("measure::" + lab) === "object")
      state.measureMode.set(st.style_id, "object");
  }
}

// ---------- trade grouping (boss roadmap: takeoff organized by trade) ----
const TRADES = ["Earthwork & Grading", "Wet Utilities", "Dry Utilities",
                "Paving & Concrete", "Structures", "Fencing & Sitework", "General"];
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
  if (has("PAVEMENT", "PAVING", "CURB", "SIDEWALK", "CONCRETE", "ASPHALT",
          "ROAD", "DRIVE", "GUTTER", "FLATWORK", "APRON", "EDGE OF")) return "Paving & Concrete";
  if (has("FOOTING", "FTG", "FOUNDATION", "PIER", "SLAB", "BUILDING", "STAIR",
          "BEAM", "COLUMN", "MASONRY", "SHEAR", "STUD", "JOIST",
          "TRUSS", "MOMENT FRAME")) return "Structures";
  if (has("FENCE", "WALL", "RAIL", "GATE", "BARRIER", "LANDSCAP", "TREE",
          "SILT", "PROPERTY", "EASEMENT", "SETBACK")) return "Fencing & Sitework";
  return "General";
}

// One computation for the itemized panel AND the CSV export: totals per
// label, object counts, overrides, prices, trade grouping. Items come back
// grouped in TRADES order, each group sorted by quantity descending.
function computeTakeoffRows() {
  if (!state.result) return null;
  const sc = state.result.scale;
  const ftPerIn = sc ? sc.ft_per_paper_inch : null;
  const totals = new Map();
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (!state.include.get(ch.style_id)) continue;
    const label = state.chainLabels.get(ch.chain_id) ||
      state.labels.get(ch.style_id) || "unlabeled";
    const t = totals.get(label) || { count: 0, pt: 0, objects: 0, objSids: new Set() };
    t.count += 1; t.pt += ch.length_pt;
    if (state.measureMode.get(ch.style_id) === "object")
      t.objSids.add(ch.style_id);
    totals.set(label, t);
  }
  for (const t of totals.values()) {
    if (t.objSids.size)
      t.objects = styleObjects([...t.objSids]).length;
  }
  // one flat list: measured line families + calculator items, then group
  const items = [...totals.entries()].map(([label, t]) => t.objects
    ? { label, cnt: "EA", qty: t.objects,
        qtyText: String(t.objects), priced: true, isObj: true,
        ft: ftPerIn ? t.pt / 72 * ftPerIn : null }
    : { label, cnt: String(t.count),
        qty: ftPerIn ? t.pt / 72 * ftPerIn : t.pt,
        qtyText: null, priced: !!ftPerIn });
  for (const it of state.extraItems)
    items.push({ label: it.label, cnt: it.unit, qty: it.qty,
                 qtyText: it.qty.toLocaleString(), priced: true });
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
    for (const it of group) {
      const ov = parseFloat(store.getItem(
        ovKey(it.label, it.cnt === "EA" ? "qty" : "ft")) || "");
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
      if (it.cnt === "EA") subEa += it.qty; else subQty += it.qty;
    }
    grand += sub;
    groups.push({ trade: tr, items: group, sub, subQty, subEa });
  }
  return { groups, grand, ftPerIn };
}

function renderItemized() {
  const box = $("itemized");
  box.innerHTML = "";
  if (!state.result) return;
  const { groups, grand, ftPerIn } = computeTakeoffRows();
  const head = document.createElement("div");
  head.className = "item-row head";
  head.innerHTML = "<div>label</div><div>count</div><div>" +
    (ftPerIn ? "feet" : "pt") + "</div><div>$/ft</div><div>ext $</div>";
  box.appendChild(head);
  for (const g of groups) {
    const { trade: tr, items: group, sub, subQty, subEa } = g;
    const th = document.createElement("div");
    th.className = "trade-head";
    const qtyStr = subQty >= 1000 ? (subQty/1000).toFixed(1) + "k" : subQty.toFixed(0);
    const parts = [];
    if (subQty) parts.push(ftPerIn ? `${qtyStr} ft` : `${qtyStr} pt`);
    if (subEa) parts.push(`${subEa} EA`);
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
      q.type = "number"; q.min = "0";
      q.step = it.cnt === "EA" ? "1" : "0.1";
      q.className = "qty-in" + (it.ov ? " ov" : "");
      q.name = "qty-" + it.label;
      const autoText = it.qtyText ||
        ((it.ov ? it.auto : it.qty) >= 1000
          ? ((it.ov ? it.auto : it.qty)/1000).toFixed(1) + "k"
          : (it.ov ? it.auto : it.qty).toFixed(1));
      if (it.ov) { q.value = it.qty; q.title = `detected ${it.auto && it.auto.toFixed ? it.auto.toFixed(1) : it.auto} — clear to restore`; }
      else { q.placeholder = autoText; q.title = "type to override the detected quantity"; }
      q.onchange = () => {
        store.setItem(ovKey(it.label, it.cnt === "EA" ? "qty" : "ft"), q.value);
        renderItemized(); renderChips();
      };
      const pin = document.createElement("input");
      pin.type = "number"; pin.step = "0.01"; pin.placeholder = "—";
      pin.name = "price-" + it.label;
      if (it.price) pin.value = it.price;
      pin.oninput = () => {
        store.setItem(priceKey(it.label), pin.value);
        renderItemized();
      };
      const e = document.createElement("div");
      e.textContent = it.ext ? it.ext.toFixed(0) : "—";
      row.append(lab, cnt, q, pin, e);
      box.appendChild(row);
    }
  }
  // always-visible tally: sum of INCLUDED footage + priced total
  let inkPt = 0;
  for (const ch of state.result.chains) {
    if (state.excluded.has(ch.chain_id)) continue;
    if (!state.include.get(ch.style_id)) continue;
    inkPt += ch.length_pt;
  }
  const tf = ftPerIn ? inkPt / 72 * ftPerIn : null;
  $("tallyBar").textContent =
    (tf !== null
      ? (tf >= 1000 ? (tf/1000).toFixed(1) + "k" : tf.toFixed(0)) + " ft measured"
      : fmtLen(inkPt) + " measured")
    + (grand ? ` · $${grand.toFixed(0)}` : "");
  if (grand) {
    const row = document.createElement("div");
    row.className = "item-row total";
    row.innerHTML = `<div>TOTAL</div><div></div><div></div><div></div><div>${grand.toFixed(0)}</div>`;
    box.appendChild(row);
  }
}

// ---------- CSV export of the itemized takeoff (client-side blob) ----------
function takeoffCsv() {
  const data = computeTakeoffRows();
  if (!data) return null;
  const { groups, grand, ftPerIn } = data;
  const csc = (v) => {
    v = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const rows = [["label", "trade", "count/EA",
                 ftPerIn ? "feet" : "pt", "$/ft", "ext $"]];
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
      ]);
    }
  }
  if (grand) rows.push(["TOTAL", "", "", "", "", grand.toFixed(2)]);
  return rows.map(r => r.map(csc).join(",")).join("\r\n") + "\r\n";
}
$("csvBtn").onclick = () => {
  const csv = takeoffCsv();
  if (csv === null) return;
  const stem = (state.docName || "takeoff").replace(/\.pdf$/i, "");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
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
  ["stylesHead", ["styleList", "colorChips", "styleSearch"]],
  ["takeoffHead", ["itemized"]],
  ["ewHead", ["ewRows", "ewHint", "ewLayers", "ewActions"]],
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
    };
  }
  renderEw();
  renderEwLayers();
  renderEwSpots();
  renderEwArea();
};

// ---- manual contour rows (F57 OPEN item: C3.4 prints no elevations) ----
// The estimator clicks a contour line and types the elevation they read
// off the overview sheet. Session-only, like every other row here.
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
    });
  }
}

$("ewStrip").onclick = () => {
  if (!state.ew) return;
  // Topsoil is stripped first on every job; 12" is a placeholder for the
  // soils-report thickness (Beaumont quoted 12"; their Barn bid works out
  // to ~8.3") - editable like any other row
  if (!state.ew.layers.existing.some(l => /topsoil/i.test(l.name)))
    state.ew.layers.existing.unshift({ name: "Topsoil", thickness_in: 12 });
  renderEwLayers();
};
$("ewAddEx").onclick = () => {
  if (!state.ew) return;
  state.ew.layers.existing.push({ name: "", thickness_in: 4 });
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
    .map(l => ({ name: (l.name || "").trim() || "layer", thickness_in: l.thickness_in }));
  return {
    existing: state.ew.rows.filter(r => r.surface === "existing" && isFinite(r.z))
      .map(r => ({ chain_id: r.chain_id, z: r.z })),
    proposed: state.ew.rows.filter(r => r.surface === "proposed" && isFinite(r.z))
      .map(r => ({ chain_id: r.chain_id, z: r.z })),
    cell_ft: 2.0,
    existing_layers: lay("existing"),
    proposed_layers: lay("proposed"),
    ...(function () {
      const pts = ewActiveSpots().map(g => ({ x: g.x, y: g.y, z: g.z }));
      const key = state.ew.spotSide === "existing" ? "existing_points" : "proposed_points";
      const o = pts.length ? { [key]: pts } : {};
      if (isFinite(state.ew.areaSf) && state.ew.areaSf > 0) o.strip_area_sf = state.ew.areaSf;
      return o;
    })(),
  };
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
const EW_ITEM_RE = /^(Site Cut|Site Fill|Strip Topsoil|Remove |Place |(Cut|Fill) \(earthwork\))/;

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
  $("ewResult").innerHTML =
    `<b>cut ${cutQ.toLocaleString()} CY</b> · <b>fill ${fillQ.toLocaleString()} CY</b>` +
    ` · net ${j.net_yd3.toLocaleString()} CY over ${Number(j.area_sf).toLocaleString()} SF` +
    (off.length ? `<br><span class="ew-meta">surfaces lowered: ${off.join(", ")}</span>` : "");
  // per-layer slabs: area x thickness, shown under the stacks
  const out = $("ewLayerOut");
  out.innerHTML = "";
  for (const lay of (j.layers || [])) {
    const d = document.createElement("div");
    d.innerHTML = `<span>${ewItemLabel(lay)} <span class="sub">· ${lay.thickness_in}" over ` +
      `${Number(j.layer_area_sf || j.area_sf).toLocaleString()} SF</span></span><b>${lay.volume_yd3.toLocaleString()} CY</b>`;
    out.appendChild(d);
  }
  // land the volumes in the itemised takeoff like any other priced row,
  // named as on Beaumont's bid sheet; every earthwork row is replaced
  // on each Calculate so edits never double-count
  state.extraItems = state.extraItems.filter(it => !EW_ITEM_RE.test(it.label));
  if (j.cut_yd3 > 0) state.extraItems.push({ label: "Site Cut", qty: j.cut_yd3, unit: "CY" });
  if (j.fill_yd3 > 0) state.extraItems.push({ label: "Site Fill", qty: j.fill_yd3, unit: "CY" });
  for (const lay of (j.layers || []))
    if (lay.volume_yd3 > 0) state.extraItems.push({ label: ewItemLabel(lay), qty: lay.volume_yd3, unit: "CY" });
  renderItemized();
  if ($("ewMap").checked) await ewFetchMap();
};

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
  state.extraItems = state.extraItems.filter(it => !it.label.startsWith("Trench") && !it.label.startsWith("Bedding") && !it.label.startsWith("Backfill"));
  if (dig > 0) state.extraItems.push({ label: `Trench excavation (${name})`, qty: cy(dig), unit: "CY" });
  if (bed > 0) state.extraItems.push({ label: `Bedding gravel (${name})`, qty: cy(bed), unit: "CY" });
  if (backfill > 0) state.extraItems.push({ label: `Backfill (${name})`, qty: cy(backfill), unit: "CY" });
  renderItemized();
};

// ---------- symbol counter ----------
$("symClose").onclick = () => { $("symPanel").hidden = true; state.symMarks = null; draw(); };
$("symBtn").onclick = async () => {
  const panel = $("symPanel");
  if (!panel.hidden) { panel.hidden = true; state.symMarks = null; draw(); return; }
  panel.hidden = false;
  if (!state.sym) {
    $("symRows").innerHTML = '<div class="ew-hint">scanning for repeated shapes…</div>';
    const r = await fetch(`/api/job/${state.job}/page/${state.page}/symbols/suggest`);
    if (!r.ok) { $("symRows").textContent = "scan failed (" + r.status + ")"; return; }
    state.sym = (await r.json()).groups;
  }
  renderSym();
};

function renderSym() {
  const box = $("symRows");
  box.innerHTML = "";
  if (!state.sym || !state.sym.length) {
    box.innerHTML = '<div class="ew-hint">no repeated closed shapes found on this page</div>';
    return;
  }
  state.sym.forEach((g, k) => {
    const row = document.createElement("div");
    row.className = "sym-row";
    const meta = document.createElement("div");
    meta.className = "sym-meta";
    let mtxt = `${g.w}×${g.h}pt · ×${g.n}`;
    if (g.schedule_qty !== undefined)
      mtxt += ` · schedule says ${g.schedule_qty} ${g.schedule_qty === g.n ? "✓" : "✗ CHECK"}`;
    meta.textContent = mtxt;
    const name = document.createElement("input");
    name.placeholder = "name it (e.g. WINDOW)";
    name.name = "sym-name-" + k;
    name.value = g.name || "";
    name.oninput = () => { g.name = name.value; };
    const add = document.createElement("button");
    add.className = "add"; add.textContent = "Add";
    add.onclick = () => {
      const label = (g.name || "").trim();
      if (!label) { setStatus("name the symbol first", "err"); return; }
      state.extraItems = state.extraItems.filter(it => it.label !== label);
      state.extraItems.push({ label, qty: g.n, unit: "EA" });
      setStatus(`${label} × ${g.n} added to takeoff`);
      renderItemized();
    };
    row.append(meta, name, add);
    row.onmouseenter = () => { state.symMarks = g.centers; draw(); };
    row.onmouseleave = () => { state.symMarks = null; draw(); };
    box.appendChild(row);
  });
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

// ---------- AI page analyst + auto-focus ----------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g,
    ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

async function runAnalyze(auto) {
  const banner = $("aiBanner");
  if (!auto) {
    banner.hidden = false;
    banner.textContent = "Reading the sheet with AI…";
  } else {
    setStatus("AI refining the takeoff…", "busy");
  }
  const gen0 = state.job + ":" + state.page;   // page may change mid-flight
  let r;
  try {
    r = await fetch(`/api/job/${state.job}/page/${state.page}/analyze`, { method: "POST" });
  } catch (e) { r = null; }
  if (gen0 !== state.job + ":" + state.page) return;  // stale reply, drop it
  if (!r || !r.ok) {
    if (auto) { setStatus(""); return; }   // demo never blocks on the model
    banner.textContent = r && r.status === 503
      ? "AI analysis needs an LLM key (XAI_API_KEY / GROQ_API_KEY / ANTHROPIC_API_KEY) on the detection service."
      : "AI analysis failed (" + (r ? r.status : "network") + ")";
    return;
  }
  const j = await r.json();
  if (gen0 !== state.job + ":" + state.page) return;  // stale reply, drop it
  state.ai = j;
  // per-style reasoning, surfaced on the style rows themselves
  state.aiWhy = new Map();
  for (const f of j.focus || []) {
    state.aiWhy.set(f.style_id, { keep: true, why: f.why, label: f.label });
    // measure verdicts apply with the rest of the verdict: in auto mode
    // only when the guardrail accepts (below); manually, right here
    if (!auto && f.measure === "object")
      state.measureMode.set(f.style_id, "object");
  }
  for (const i of j.ignore || []) state.aiWhy.set(i.style_id, { keep: false, why: i.why });
  if (auto && (j.focus || []).length) {
    // GUARDRAILS before the model's read becomes the takeoff:
    // - annotation-smelling labels (note/legend/title/dim) never focus
    // - the surviving set must cover a sane share of detected linework,
    //   or the verdict downgrades to a suggestion banner (engine result
    //   stays untouched). A wrong auto-takeoff is worse than a manual one.
    const ANNOT = /\b(note|legend|title|border|callout|dimension|typ(ical)?)\b/i;
    const focus = (j.focus || []).filter(f => !ANNOT.test(f.label || ""));
    const byId = new Map(state.result.styles.map(st => [st.style_id, st]));
    const inkOf = (arr) => arr.reduce(
      (t, f) => t + ((byId.get(f.style_id) || {}).length_pt || 0), 0);
    const totalInk = state.result.styles.reduce((t, st) => t + st.length_pt, 0);
    const share = totalInk ? inkOf(focus) / totalInk : 0;
    if (focus.length && share >= 0.12) {
      applyAiFocus(focus);
      for (const f of focus) {
        const cur = (state.labels.get(f.style_id) || "").trim();
        const seed = (state.seedLabels.get(f.style_id) || "").trim();
        if (f.label && (!cur || (cur === seed && !seed.includes("(legend)"))))
          state.labels.set(f.style_id, f.label);
        if (f.measure === "object")
          state.measureMode.set(f.style_id, "object");
      }
      state.aiAuto = true;
    } else {
      // suggestion-only: full banner with the Focus button, nothing applied
      state.aiAuto = false;
    }
    setStatus("");
  }
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

function renderAiBanner() {
  const banner = $("aiBanner"), j = state.ai;
  if (!j || state.aiHidden) { banner.hidden = true; return; }
  $("aiBtn").textContent = "Analyze";
  banner.hidden = false;
  if (state.aiAuto) {
    // pipeline mode: no ceremony - one quiet line, an undo, and the
    // sheet's calculator chips
    banner.innerHTML = "";
    banner.classList.add("slim");
    const line = document.createElement("span");
    const nf = (j.focus || []).length;
    line.innerHTML = `<b>${esc(j.purpose || "")}</b> <span class="ai-dim">· ` +
      `AI-assisted — ${nf} line type${nf === 1 ? "" : "s"} in focus` +
      (j.confidence ? ` · confidence ${esc(j.confidence)}` : "") + `</span>`;
    banner.appendChild(line);
    if (state.aiUndo) {
      const undo = document.createElement("button");
      undo.className = "mini";
      undo.textContent = "Undo AI";
      undo.onclick = () => { state.aiAuto = false; undoAiFocus(); };
      banner.appendChild(undo);
    }
    const rr = document.createElement("button");
    rr.className = "mini";
    rr.textContent = "Re-read sheet";
    rr.title = "Ask the AI to read this sheet again (verdict is otherwise pinned)";
    rr.onclick = async () => {
      const r2 = await fetch(
        `/api/job/${state.job}/page/${state.page}/analyze?fresh=1`,
        { method: "POST" });
      if (r2.ok) { state.aiUndo && undoAiFocus(); runAnalyze(true); }
    };
    banner.appendChild(rr);
    banner.appendChild(aiDismissBtn());
    const CALC = {
      earthwork: { btn: "ewBtn", label: "EARTHWORK" },
      trench:    { btn: "trBtn", label: "TRENCH" },
      count:     { btn: "symBtn", label: "COUNT" },
    };
    for (const m of (j.page_modes || []).filter(m => CALC[m])) {
      const b = document.createElement("button");
      b.className = "ai-mode";
      b.textContent = CALC[m].label;
      b.title = "This sheet calls for this calculator";
      b.onclick = () => { const t = $(CALC[m].btn); if (t) t.click(); };
      banner.appendChild(b);
    }
    return;
  }
  banner.classList.remove("slim");
  const legend = (j.inline_legend || [])
    .map(l => `${esc(l.symbol)} = ${esc(l.meaning)}`).join("; ");
  const focus = j.focus || [];
  const names = focus.map(f => esc(f.label || ("style " + f.style_id))).join(", ");
  let html = `<b>${esc(j.purpose)}</b>`;
  if (j.discipline) html += ` <span class="ai-dim">(${esc(j.discipline)})</span>`;
  if (focus.length) html += `<br><b>Measure here:</b> ${names}`;
  if (legend) html += `<br><b>Sheet legend:</b> ${legend}`;
  if (j.confidence || j._invalid_style_ids) {
    html += `<br><span class="ai-dim">`;
    if (j.confidence) html += `confidence ${esc(j.confidence)}`;
    if (j._invalid_style_ids) html += `${j.confidence ? " · " : ""}${j._invalid_style_ids} suggestion(s) ignored as unknown styles`;
    html += `</span>`;
  }
  banner.innerHTML = html;
  banner.appendChild(aiDismissBtn());

  if (focus.length) {
    const ids = new Set(focus.map(f => f.style_id));
    const offCount = [...state.include.keys()].filter(k => !ids.has(k)).length;
    const bar = document.createElement("div");
    bar.className = "ai-actions";
    const apply = document.createElement("button");
    apply.id = "aiApplyBtn";
    apply.textContent = `Focus on these ${focus.length} line type${focus.length > 1 ? "s" : ""}`;
    apply.title = `Turns ON ${focus.length} style(s) and turns OFF ${offCount}. Nothing is deleted — you can undo.`;
    apply.onclick = () => applyAiFocus(focus);
    bar.appendChild(apply);
    const note = document.createElement("span");
    note.className = "ai-dim";
    note.textContent = `suggestion only — turns off ${offCount} other style${offCount === 1 ? "" : "s"}, undoable`;
    bar.appendChild(note);
    if (state.aiUndo) {
      const undo = document.createElement("button");
      undo.textContent = "Undo";
      undo.onclick = undoAiFocus;
      bar.appendChild(undo);
    }
    banner.appendChild(bar);
  }

  // page_modes -> one-click calculator suggestions: the model says what
  // KIND of measuring this sheet needs; each chip opens the matching tool
  const CALC = {
    earthwork: { btn: "ewBtn", label: "EARTHWORK — cut & fill from these contours" },
    trench:    { btn: "trBtn", label: "TRENCH — excavation + bedding for a pipe run" },
    count:     { btn: "symBtn", label: "COUNT — tally repeated symbols" },
  };
  const modes = (j.page_modes || []).filter(m => CALC[m]);
  if (modes.length) {
    const bar2 = document.createElement("div");
    bar2.className = "ai-actions";
    const lead = document.createElement("span");
    lead.className = "ai-dim";
    lead.textContent = "This sheet also calls for:";
    bar2.appendChild(lead);
    for (const m of modes) {
      const b = document.createElement("button");
      b.className = "ai-mode";
      b.textContent = CALC[m].label;
      b.onclick = () => { const t = $(CALC[m].btn); if (t) t.click(); };
      bar2.appendChild(b);
    }
    banner.appendChild(bar2);
  }
}

function applyAiFocus(focus) {
  // snapshot first: this only flips checkboxes, so it must be reversible
  state.aiUndo = {
    include: new Map(state.include),
    labels: new Map(state.labels),
  };
  const ids = new Set(focus.map(f => f.style_id));
  for (const k of state.include.keys()) state.include.set(k, ids.has(k));
  for (const f of focus) {
    if (f.label) state.labels.set(f.style_id, f.label);
  }
  setStatus(`AI focus applied — ${ids.size} line type(s) kept`);
  renderAiBanner(); renderStyles(); renderChips(); renderItemized(); draw();
}

function undoAiFocus() {
  if (!state.aiUndo) return;
  state.include = new Map(state.aiUndo.include);
  state.labels = new Map(state.aiUndo.labels);
  state.aiUndo = null;
  setStatus("AI focus undone");
  renderAiBanner(); renderStyles(); renderChips(); renderItemized(); draw();
}

$("approveBtn").onclick = async () => {
  const labels = {};
  for (const [sid, inc] of state.include) if (inc) labels[sid] = state.labels.get(sid) || "unlabeled";
  const r = await fetch(`/api/job/${state.job}/page/${state.page}/approve`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels, image_dpi: 300,
      object_counts: Object.fromEntries((() => {
        const pools = new Map();
        for (const st of state.result.styles) {
          if (state.measureMode.get(st.style_id) !== "object") continue;
          if (!state.include.get(st.style_id)) continue;
          const label = state.labels.get(st.style_id) || "unlabeled";
          if (!pools.has(label)) pools.set(label, []);
          pools.get(label).push(st.style_id);
        }
        return [...pools.entries()].map(([l, sids]) =>
          [l, parseFloat(store.getItem(ovKey(l, "qty")) || "") ||
              styleObjects(sids).length]);
      })()),
      trades: Object.fromEntries(
        [...new Set([...Object.values(labels), ...state.extraItems.map(i => i.label)])]
          .filter(Boolean).map(l => [l, tradeFor(l)])),
      excluded_chain_ids: [...state.excluded],
      added_chains: state.result.chains
        .filter(c => c.custom && !state.excluded.has(c.chain_id))
        .map(c => ({ chain_id: c.chain_id, style_id: c.style_id,
          class: c.class, color: c.color, length_pt: c.length_pt,
          points: c.points })),
      chain_labels: Object.fromEntries(
        [...state.chainLabels].filter(([id]) => !state.excluded.has(id))),
      extra_items: state.extraItems.map(it => ({
        ...it,
        unit_price: parseFloat(store.getItem(priceKey(it.label)) || "") || null,
      })),
      prices: Object.fromEntries(
        [...Object.values(labels), ...state.chainLabels.values()]
          .map(l => [l, parseFloat(store.getItem(priceKey(l)) || "") || 0])
          .filter(([, v]) => v > 0 ? true : false)
      ) }),
  });
  const j = await r.json();
  setStatus(`exported ${j.exported} elements` +
    (j.items ? ` · ${j.items.length} items itemized` : ""));
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
    if (!store.getItem(tradeKey(label))) store.setItem(tradeKey(label), "Earthwork & Grading");
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
