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

const state = {
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
  autoAi: localStorage.getItem("core-autoai") !== "off",  // detect pipeline runs AI
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
  const sel = $("pageSel");
  sel.innerHTML = "";
  j.kinds.forEach((k, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = `page ${i + 1} — ${k}`;
    sel.appendChild(o);
  });
  sel.hidden = false; $("detectBtn").hidden = false;
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
  state.ai = null; state.aiWhy = new Map(); state.aiUndo = null; state.measureMode = new Map(); state.aiAuto = false; state.seedLabels = new Map();
  $("aiBanner").hidden = true;
  updateSelBar(null);
  renderStyles(); renderChips(); renderLegend(); renderItemized(); renderMiniLegend(); fitOnLoad();
  const img = new Image();
  img.onload = () => {
    if (gen !== state.gen) return;   // a later page won the race
    state.img = img; fitView(); draw();
  };
  img.src = url(`/api/job/${state.job}/page/${p}/image?dpi=${IMG_DPI}`);
  // reuse a finished result if the server has one
  const st = await (await fetch(`/api/job/${state.job}/page/${p}/status`)).json();
  if (gen !== state.gen) return;
  if (st.status === "done") loadResult(gen);
}

$("detectBtn").onclick = async () => {
  await fetch(`/api/job/${state.job}/page/${state.page}/detect`, { method: "POST" });
  setStatus("detecting…", "busy");
  poll(state.gen);
};
async function poll(gen = state.gen) {
  if (gen !== state.gen) return;   // document/page changed under us
  const j = await (await fetch(`/api/job/${state.job}/page/${state.page}/status`)).json();
  if (gen !== state.gen) return;
  if (j.status === "running") return setTimeout(() => poll(gen), 900);
  if (j.status && j.status.startsWith("error")) return setStatus(j.status, "err");
  if (j.status === "done") { setStatus("done"); loadResult(gen); }
}

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
  state.ai = null; state.aiWhy = new Map(); state.aiUndo = null; state.measureMode = new Map(); state.aiAuto = false; state.seedLabels = new Map();
  state.ew = null; state.hotChain = null; state.extraItems = [];
  state.tr = null; state.sym = null; state.symMarks = null;
  $("ewPanel").hidden = true; $("ewBtn").hidden = false;
  $("trPanel").hidden = true; $("trBtn").hidden = false;
  $("symPanel").hidden = true; $("symBtn").hidden = false;
  $("aiBanner").hidden = true;
  state.nextChainId = 1 + Math.max(0, ...state.result.chains.map(c => c.chain_id));
  $("measureBtn").classList.remove("active"); $("measureInfo").hidden = true;
  $("restoreBtn").hidden = true;
  for (const s of state.result.styles) {
    const white = s.color && Math.min(...s.color) > 0.92;
    // white-over-wash linework is real but faint existing-conditions data;
    // it starts OFF so it never surprises the takeoff - one click turns a
    // family on when the estimator wants it
    state.include.set(s.style_id,
      white ? false : (s.class !== "solid" ? true : s.length_pt > 500));
    state.labels.set(s.style_id, s.suggested_label);
    state.seedLabels.set(s.style_id, s.suggested_label || "");
  }
  renderStyles(); renderChips(); renderLegend(); renderItemized(); renderMiniLegend(); draw();
  document.getElementById("aiBtn").hidden = state.autoAi;
  if (state.autoAi) runAnalyze(true);
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
    if (cut) { if (polyLen(run) >= 8) runs.push(run); run = [pts[i-1]]; }
    run.push(pts[i]);
  }
  if (polyLen(run) >= 8) runs.push(run);
  return runs;
}
function styleObjects(sid) {
  const out = [];
  for (const ch of state.result.chains) {
    if (ch.style_id !== sid || state.excluded.has(ch.chain_id)) continue;
    for (const r of chainRuns(ch)) out.push({ pts: r, len: polyLen(r) });
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
  sctx.strokeStyle = cssColor(s.color);
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

function renderStyles() {
  const box = $("styleList");
  box.innerHTML = "";
  $("approveBtn").disabled = !state.result;
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
    cb.onclick = (e) => { e.stopPropagation(); state.include.set(s.style_id, cb.checked); renderStyles(); renderChips(); renderItemized(); renderMiniLegend(); draw(); };

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
      clearTimeout(lab._t);   // itemized + legend regroup as you type
      lab._t = setTimeout(() => { renderItemized(); renderMiniLegend(); }, 350);
    };
    const meta = document.createElement("div");
    meta.className = "style-meta";
    meta.textContent = `${s.n} lines · ${fmtLen(s.length_pt)} · ${s.signature}`;
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
      if (state.measureMode.get(s.style_id) === "object")
        state.measureMode.delete(s.style_id);
      else state.measureMode.set(s.style_id, "object");
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
  const box = $("legendBox");
  box.innerHTML = ""; box.hidden = true;
  if (!state.result || !(state.result.legend || []).length) return;
  box.hidden = false;
  const head = document.createElement("div");
  head.className = "legend-head"; head.textContent = "Sheet legend";
  box.appendChild(head);
  for (const e of state.result.legend) {
    const sid = e.sample_style;
    if (sid === null || sid === undefined) {
      // the legend NAMES this line type but no detected style matches yet -
      // show it honestly as found-but-unmatched instead of hiding it
      const chip = document.createElement("button");
      chip.className = "legend-chip";
      chip.style.opacity = "0.55";
      chip.textContent = e.label + " (not matched)";
      chip.title = "Read from the legend, but no detected line style matches its geometry yet";
      box.appendChild(chip);
      continue;
    }
    const applied = (state.labels.get(sid) || "").startsWith(e.label);
    const chip = document.createElement("button");
    chip.className = "legend-chip" + (applied ? " applied" : "");
    chip.textContent = e.label;
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
function priceKey(label) { return "price:" + label; }
// ---------- trade grouping (boss roadmap: takeoff organized by trade) ----
const TRADES = ["Earthwork & Grading", "Wet Utilities", "Dry Utilities",
                "Paving & Concrete", "Structures", "Fencing & Sitework", "General"];
function tradeKey(label) { return "trade::" + label.trim().toUpperCase(); }
function tradeFor(label) {
  const saved = localStorage.getItem(tradeKey(label));
  if (saved && TRADES.includes(saved)) return saved;
  const L = label.toUpperCase();
  const has = (...ws) => ws.some(w => L.includes(w));
  if (has("CONTOUR", "GRADING", "GRADE", "EXCAVAT", "EARTHWORK", "TOPO", "SLOPE",
          "BERM", "DITCH", "SWALE", "ELEVATION", "CUT", "FILL")) return "Earthwork & Grading";
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

function renderItemized() {
  const box = $("itemized");
  box.innerHTML = "";
  if (!state.result) return;
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
    if (state.measureMode.get(ch.style_id) === "object"
        && !t.objSids.has(ch.style_id)) {
      t.objSids.add(ch.style_id);
      t.objects += styleObjects(ch.style_id).length;
    }
    totals.set(label, t);
  }
  const head = document.createElement("div");
  head.className = "item-row head";
  head.innerHTML = "<div>label</div><div>count</div><div>" +
    (ftPerIn ? "feet" : "pt") + "</div><div>$/ft</div><div>ext $</div>";
  box.appendChild(head);
  let grand = 0;
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
  for (const tr of TRADES) {
    const group = byTrade.get(tr);
    if (!group) continue;
    group.sort((a, b) => b.qty - a.qty);
    let sub = 0, subQty = 0, subEa = 0;
    for (const it of group) {
      const price = parseFloat(localStorage.getItem(priceKey(it.label)) || "") || null;
      it.price = price;
      it.ext = it.priced && price ? it.qty * price : null;
      if (it.ext) sub += it.ext;
      if (it.cnt === "EA") subEa += it.qty; else subQty += it.qty;
    }
    grand += sub;
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
        localStorage.setItem(tradeKey(it.label), pick.value);
        renderItemized();
      };
      lab.appendChild(document.createElement("br"));
      lab.appendChild(pick);
      const cnt = document.createElement("div"); cnt.textContent = it.cnt;
      const q = document.createElement("div");
      q.textContent = it.qtyText ||
        (it.qty >= 1000 ? (it.qty/1000).toFixed(1) + "k" : it.qty.toFixed(1));
      const pin = document.createElement("input");
      pin.type = "number"; pin.step = "0.01"; pin.placeholder = "—";
      pin.name = "price-" + it.label;
      if (it.price) pin.value = it.price;
      pin.oninput = () => {
        localStorage.setItem(priceKey(it.label), pin.value);
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

// ---------- collapsible sidebar sections ----------
// every section header toggles the elements listed for it; state is
// per-session only (a refresh reopens everything)
const SECTIONS = [
  ["stylesHead", ["styleList"]],
  ["takeoffHead", ["itemized"]],
  ["ewHead", ["ewRows", "ewHint", "ewActions"]],
  ["trHead", ["trBody", "trHint", "trActions"]],
  ["symHead", ["symRows", "symHint"]],
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
$("ewClose").onclick = () => { $("ewPanel").hidden = true; state.hotChain = null; draw(); };
$("ewBtn").onclick = async () => {
  const panel = $("ewPanel");
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
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
    };
  }
  renderEw();
};

function renderEw() {
  const box = $("ewRows");
  box.innerHTML = "";
  if (!state.ew || !state.ew.rows.length) {
    box.innerHTML = '<div class="ew-hint">No elevation labels found near contours on this page. ' +
      'Elevations can still be assigned by selecting lines and using Separate, then entering values here later.</div>';
    return;
  }
  for (const row of state.ew.rows) {
    const div = document.createElement("div");
    div.className = "ew-row";
    const z = document.createElement("input");
    z.className = "z"; z.type = "number"; z.step = "0.1"; z.value = row.z;
    z.name = "ew-z-" + row.chain_id;
    z.oninput = () => { row.z = parseFloat(z.value); };
    const meta = document.createElement("div");
    meta.className = "ew-meta";
    meta.textContent = `chain ${row.chain_id} · w ${row.width} · label ${row.dist}pt away`;
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
    div.append(z, meta, seg);
    div.onmouseenter = () => { state.hotChain = row.chain_id; draw(); };
    div.onmouseleave = () => { state.hotChain = null; draw(); };
    box.appendChild(div);
  }
}

$("ewCalc").onclick = async () => {
  if (!state.ew) return;
  const body = {
    existing: state.ew.rows.filter(r => r.surface === "existing" && isFinite(r.z))
      .map(r => ({ chain_id: r.chain_id, z: r.z })),
    proposed: state.ew.rows.filter(r => r.surface === "proposed" && isFinite(r.z))
      .map(r => ({ chain_id: r.chain_id, z: r.z })),
    cell_ft: 2.0,
  };
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
  $("ewResult").innerHTML =
    `<b>cut ${j.cut_yd3.toLocaleString()} CY</b> · <b>fill ${j.fill_yd3.toLocaleString()} CY</b>` +
    ` · net ${j.net_yd3.toLocaleString()} CY over ${Number(j.area_sf).toLocaleString()} SF`;
  // land the volumes in the itemised takeoff like any other priced row
  state.extraItems = state.extraItems.filter(it => !/^(Cut|Fill) \(earthwork\)/.test(it.label));
  if (j.cut_yd3 > 0) state.extraItems.push({ label: "Cut (earthwork)", qty: j.cut_yd3, unit: "CY" });
  if (j.fill_yd3 > 0) state.extraItems.push({ label: "Fill (earthwork)", qty: j.fill_yd3, unit: "CY" });
  renderItemized();
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
    meta.textContent = `${g.w}×${g.h}pt · ×${g.n}`;
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
    if (f.measure === "object") state.measureMode.set(f.style_id, "object");
  }
  for (const i of j.ignore || []) state.aiWhy.set(i.style_id, { keep: false, why: i.why });
  if (auto && (j.focus || []).length) {
    // pipeline mode: the model's read IS the first draft the reviewer sees.
    // Focus flips checkboxes (snapshotted, undoable); model labels fill in
    // ONLY where nothing (user, legend) named the style yet.
    applyAiFocus(j.focus);
    for (const f of j.focus) {
      const cur = (state.labels.get(f.style_id) || "").trim();
      const seed = (state.seedLabels.get(f.style_id) || "").trim();
      // model names a focused style only where nobody better has: empty,
      // or still carrying the seeded default; user & legend labels win
      if (f.label && (!cur || (cur === seed && !seed.includes("(legend)"))))
        state.labels.set(f.style_id, f.label);
    }
    state.aiAuto = true;
    setStatus("");
  }
  renderAiBanner();
  renderStyles(); renderItemized(); renderMiniLegend(); draw();
}
$("aiBtn").onclick = () => runAnalyze(false);

function renderAiBanner() {
  const banner = $("aiBanner"), j = state.ai;
  if (!j) { banner.hidden = true; return; }
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
  html += `<br><span class="ai-dim">${esc(j._provider || "")}`;
  if (j.confidence) html += ` · confidence ${esc(j.confidence)}`;
  if (j._invalid_style_ids) html += ` · ${j._invalid_style_ids} suggestion(s) ignored as unknown styles`;
  html += `</span>`;
  banner.innerHTML = html;

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
        const oc = [];
        for (const st of state.result.styles) {
          if (state.measureMode.get(st.style_id) !== "object") continue;
          if (!state.include.get(st.style_id)) continue;
          const label = state.labels.get(st.style_id) || "unlabeled";
          oc.push([label, (oc.find(x => x[0] === label) || [0, 0])[1]
                   + styleObjects(st.style_id).length]);
        }
        return oc;
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
        unit_price: parseFloat(localStorage.getItem(priceKey(it.label)) || "") || null,
      })),
      prices: Object.fromEntries(
        [...Object.values(labels), ...state.chainLabels.values()]
          .map(l => [l, parseFloat(localStorage.getItem(priceKey(l)) || "") || 0])
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
  if (state.result) {
    const f = IMG_DPI / 72; // pt -> image px
    for (const ch of state.result.chains) {
      const sid = ch.style_id;
      if (state.excluded.has(ch.chain_id)) continue;
      if (state.isolate !== null && sid !== state.isolate) continue;
      if (state.isolate === null && !state.include.get(sid)) continue;
      const hot = state.hot === sid || state.hotChain === ch.chain_id;
      const sel = state.selected === ch.chain_id;
      ctx.strokeStyle = sel ? "#ff00cc" : cssColor(styleColor(sid));
      // real plotted weight, floored so a hairline stays visible zoomed out
      const wPt = Math.max(ch.width || 0.35, 0.35) * f;
      ctx.lineWidth = sel ? 4.5 / k : Math.max(hot ? wPt * 2.0 : wPt, 1.4 / k);
      // selection recolors but keeps the true pattern - a solid magenta
      // overlay reads as "this line became solid", which it has not
      // the chain's own measured period beats any signature-derived
      // reconstruction (a d9/d45 class signature cannot say whether the
      // period has one short or two - the template knows)
      const da = state.faithful
        ? (ch.template && ch.template.length >= 2 ? ch.template
           : dashArray(ch.dash_signature))
        : null;
      ctx.setLineDash(da ? da.map(v => v * f) : []);
      ctx.beginPath();
      const pts = ch.points;
      ctx.moveTo(pts[0][0] * f, pts[0][1] * f);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * f, pts[i][1] * f);
      ctx.stroke();
    }
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
    for (const s2 of state.result.styles) {
      if (state.measureMode.get(s2.style_id) !== "object") continue;
      if (state.isolate !== null && s2.style_id !== state.isolate) continue;
      if (state.isolate === null && !state.include.get(s2.style_id)) continue;
      ctx.strokeStyle = cssColor(s2.color);
      ctx.lineWidth = 1.4 / k;
      ctx.setLineDash([]);
      for (const ob of styleObjects(s2.style_id)) {
        const a = ob.pts[0], b = ob.pts[ob.pts.length - 1];
        const dx = b[0]-a[0], dy = b[1]-a[1];
        const L = Math.hypot(dx, dy) || 1;
        const ux = dx / L, uy = dy / L;
        // half-width: the run's own lateral spread + padding
        let w2 = 0;
        for (const q of ob.pts) {
          const off = Math.abs(-(q[0]-a[0])*uy + (q[1]-a[1])*ux);
          if (off > w2) w2 = off;
        }
        w2 = (w2 + 3.5);
        const pad = 3.0;
        const c1 = [(a[0]-ux*pad+uy*w2)*f2, (a[1]-uy*pad-ux*w2)*f2];
        const c2 = [(b[0]+ux*pad+uy*w2)*f2, (b[1]+uy*pad-ux*w2)*f2];
        const c3 = [(b[0]+ux*pad-uy*w2)*f2, (b[1]+uy*pad+ux*w2)*f2];
        const c4 = [(a[0]-ux*pad-uy*w2)*f2, (a[1]-uy*pad+ux*w2)*f2];
        ctx.beginPath();
        ctx.moveTo(...c1); ctx.lineTo(...c2); ctx.lineTo(...c3);
        ctx.lineTo(...c4); ctx.closePath();
        ctx.stroke();
      }
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
function cssColor(c) {
  if (!c) return "#8f959e";
  const [r, g, b] = c.map(v => Math.round(v * 255));
  // near-white linework (white-over-wash contours) would vanish on the
  // dimmed sheet; draw it as the faint grey it visually is - NEVER as a
  // loud fallback colour, which read as random phantom lines
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
  if (state.tool === "drawline") {
    state.drawPts.push([px, py]);
    setStatus(`draw: ${state.drawPts.length} point(s) — double-click or Enter to finish`, "busy");
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
  const c = JSON.parse(JSON.stringify(src));  // inherits the family's style/pattern
  c.chain_id = state.nextChainId++;
  c.custom = true;
  c.points = pts;
  c.length_pt = polyLen(pts);
  state.result.chains.push(c);
  state.selected = c.chain_id; state.selPt = null;
  cancelDraw();
  updateSelBar(c);
  afterEdit(`drew ${fmtLen(c.length_pt)} into the family`);
}

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
  $("selInfo").textContent = `${ch.class} · ${label} · ${fmtLen(ch.length_pt)}${pt}`;
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

resize();
