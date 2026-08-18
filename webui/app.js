"use strict";
const $ = (id) => document.getElementById(id);
const IMG_DPI = 130; // must match /image endpoint default

const state = {
  job: null, page: 0, kinds: [],
  img: null, result: null,
  include: new Map(), labels: new Map(), isolate: null, hot: null,
  selected: null, excluded: new Set(),
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
  state.job = j.job_id; state.kinds = j.kinds; state.result = null;
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
  state.page = p; state.result = null; state.isolate = null;
  renderStyles(); fitOnLoad();
  const img = new Image();
  img.onload = () => { state.img = img; fitView(); draw(); };
  img.src = `/api/job/${state.job}/page/${p}/image?dpi=${IMG_DPI}`;
  // reuse a finished result if the server has one
  const st = await (await fetch(`/api/job/${state.job}/page/${p}/status`)).json();
  if (st.status === "done") loadResult();
}

$("detectBtn").onclick = async () => {
  await fetch(`/api/job/${state.job}/page/${state.page}/detect`, { method: "POST" });
  setStatus("detecting…", "busy");
  poll();
};
async function poll() {
  const j = await (await fetch(`/api/job/${state.job}/page/${state.page}/status`)).json();
  if (j.status === "running") return setTimeout(poll, 900);
  if (j.status && j.status.startsWith("error")) return setStatus(j.status, "err");
  if (j.status === "done") { setStatus("done"); loadResult(); }
}

async function loadResult() {
  const r = await fetch(`/api/job/${state.job}/page/${state.page}/result`);
  if (!r.ok) return;
  state.result = await r.json();
  state.include = new Map(); state.labels = new Map();
  state.selected = null; state.excluded = new Set();
  for (const s of state.result.styles) {
    state.include.set(s.style_id, s.class !== "solid" ? true : s.length_pt > 500);
    state.labels.set(s.style_id, s.suggested_label);
  }
  renderStyles(); renderChips(); renderLegend(); renderItemized(); draw();
  document.getElementById("aiBtn").hidden = false;
  const sc = state.result.scale;
  setStatus(`${state.result.chains.length} lines in ${state.result.styles.length} styles` +
    (sc ? ` · scale ${sc.text} (${sc.source})` : " · no scale found"));
}

// ---------- sidebar ----------
function renderStyles() {
  const box = $("styleList");
  box.innerHTML = "";
  $("approveBtn").disabled = !state.result;
  if (!state.result) return;
  for (const s of state.result.styles) {
    const row = document.createElement("div");
    row.className = "style-row" + (state.include.get(s.style_id) ? "" : " off");
    row.dataset.sid = s.style_id;

    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!state.include.get(s.style_id);
    cb.onclick = (e) => { e.stopPropagation(); state.include.set(s.style_id, cb.checked); renderStyles(); renderChips(); renderItemized(); draw(); };

    const sw = document.createElement("div");
    sw.className = "swatch"; sw.style.background = cssColor(s.color);

    const main = document.createElement("div");
    main.className = "style-main";
    const lab = document.createElement("input");
    lab.className = "style-label"; lab.value = state.labels.get(s.style_id) ?? "";
    lab.onclick = (e) => e.stopPropagation();
    lab.oninput = () => state.labels.set(s.style_id, lab.value);
    const meta = document.createElement("div");
    meta.className = "style-meta";
    meta.textContent = `${s.n} lines · ${fmtLen(s.length_pt)} · ${s.signature}`;
    main.append(lab, meta);

    const badge = document.createElement("span");
    badge.className = `badge ${s.class}`; badge.textContent = s.class;

    row.append(cb, sw, main, badge);
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

$("allBtn").onclick = () => { for (const k of state.include.keys()) state.include.set(k, true); renderStyles(); renderChips(); renderItemized(); draw(); };
$("noneBtn").onclick = () => { for (const k of state.include.keys()) state.include.set(k, false); renderStyles(); renderChips(); renderItemized(); draw(); };

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
    const label = state.labels.get(ch.style_id) || "unlabeled";
    const t = totals.get(label) || { count: 0, pt: 0 };
    t.count += 1; t.pt += ch.length_pt;
    totals.set(label, t);
  }
  const head = document.createElement("div");
  head.className = "item-row head";
  head.innerHTML = "<div>label</div><div>count</div><div>" +
    (ftPerIn ? "feet" : "pt") + "</div><div>$/ft</div><div>ext $</div>";
  box.appendChild(head);
  let grand = 0;
  const rows = [...totals.entries()].sort((a, b) => b[1].pt - a[1].pt);
  for (const [label, t] of rows) {
    const qty = ftPerIn ? t.pt / 72 * ftPerIn : t.pt;
    const price = parseFloat(localStorage.getItem(priceKey(label)) || "") || null;
    const ext = ftPerIn && price ? qty * price : null;
    if (ext) grand += ext;
    const row = document.createElement("div");
    row.className = "item-row";
    const lab = document.createElement("div");
    lab.className = "lab"; lab.title = label; lab.textContent = label;
    const cnt = document.createElement("div"); cnt.textContent = t.count;
    const q = document.createElement("div");
    q.textContent = qty >= 1000 ? (qty/1000).toFixed(1) + "k" : qty.toFixed(1);
    const pin = document.createElement("input");
    pin.type = "number"; pin.step = "0.01"; pin.placeholder = "—";
    if (price) pin.value = price;
    pin.oninput = () => {
      localStorage.setItem(priceKey(label), pin.value);
      renderItemized();
    };
    const e = document.createElement("div");
    e.textContent = ext ? ext.toFixed(0) : "—";
    row.append(lab, cnt, q, pin, e);
    box.appendChild(row);
  }
  if (grand) {
    const row = document.createElement("div");
    row.className = "item-row total";
    row.innerHTML = `<div>TOTAL</div><div></div><div></div><div></div><div>${grand.toFixed(0)}</div>`;
    box.appendChild(row);
  }
}

// ---------- AI page analyst ----------
$("aiBtn").onclick = async () => {
  const banner = $("aiBanner");
  banner.hidden = false;
  banner.textContent = "Analyzing page with AI…";
  const r = await fetch(`/api/job/${state.job}/page/${state.page}/analyze`, { method: "POST" });
  if (!r.ok) {
    banner.textContent = r.status === 503
      ? "AI analysis needs ANTHROPIC_API_KEY set on the detection service."
      : "AI analysis failed (" + r.status + ")";
    return;
  }
  const j = await r.json();
  const legend = (j.inline_legend || []).map(l => `${l.symbol} = ${l.meaning}`).join("; ");
  banner.innerHTML =
    `<b>${j.purpose || ""}</b>` +
    (j.takeoff_focus ? ` · <b>Measure:</b> ${j.takeoff_focus.join(", ")}` : "") +
    (j.ignore ? ` · <b>Ignore:</b> ${j.ignore.join(", ")}` : "") +
    (legend ? ` · <b>Sheet legend:</b> ${legend}` : "");
};

$("approveBtn").onclick = async () => {
  const labels = {};
  for (const [sid, inc] of state.include) if (inc) labels[sid] = state.labels.get(sid) || "unlabeled";
  const r = await fetch(`/api/job/${state.job}/page/${state.page}/approve`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels, image_dpi: 300,
      excluded_chain_ids: [...state.excluded],
      prices: Object.fromEntries(
        Object.values(labels).map(l => [l, parseFloat(localStorage.getItem(priceKey(l)) || "") || 0])
          .filter(([, v]) => v > 0 ? true : false)
      ) }),
  });
  const j = await r.json();
  setStatus(`exported ${j.exported} elements` +
    (j.items ? ` · ${j.items.length} items itemized` : ""));
  const a = $("dlLink");
  a.href = `/api/job/${state.job}/page/${state.page}/elements`;
  a.hidden = false;
  const rl = $("reportLink");
  rl.href = `/api/job/${state.job}/report.pdf`;
  rl.hidden = false;
};

// ---------- canvas ----------
const cv = $("view"), ctx = cv.getContext("2d");
function resize() {
  cv.width = cv.clientWidth * devicePixelRatio;
  cv.height = cv.clientHeight * devicePixelRatio;
  fitView();
  draw();
}
addEventListener("resize", resize);

function fitOnLoad() { state.img = null; draw(); }
function fitView() {
  if (!state.img) return;
  const kx = cv.clientWidth / state.img.width, ky = cv.clientHeight / state.img.height;
  state.view.k = Math.min(kx, ky) * 0.97;
  state.view.x = (cv.clientWidth - state.img.width * state.view.k) / 2;
  state.view.y = (cv.clientHeight - state.img.height * state.view.k) / 2;
}

function draw() {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
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
      const hot = state.hot === sid;
      const sel = state.selected === ch.chain_id;
      ctx.strokeStyle = sel ? "#ff00cc" : cssColor(styleColor(sid));
      ctx.lineWidth = (sel ? 4.5 : hot ? 3.4 : 1.8) / k;
      ctx.beginPath();
      const pts = ch.points;
      ctx.moveTo(pts[0][0] * f, pts[0][1] * f);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * f, pts[i][1] * f);
      ctx.stroke();
    }
  }
  ctx.restore();
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
  if (!c) return "#e6b800";
  const [r, g, b] = c.map(v => Math.round(v * 255));
  // near-white detected colors would vanish on the dimmed sheet
  if (r > 225 && g > 225 && b > 225) return "#e6b800";
  return `rgb(${r},${g},${b})`;
}

let panning = null;
let downAt = null;
cv.addEventListener("mousedown", (e) => {
  panning = { x: e.clientX, y: e.clientY };
  downAt = { x: e.clientX, y: e.clientY };
  cv.classList.add("panning");
});
addEventListener("mousemove", (e) => {
  if (!panning) return;
  state.view.x += e.clientX - panning.x; state.view.y += e.clientY - panning.y;
  panning = { x: e.clientX, y: e.clientY };
  draw();
});
addEventListener("mouseup", (e) => {
  cv.classList.remove("panning");
  const wasClick = panning && downAt &&
    Math.abs(e.clientX - downAt.x) < 4 && Math.abs(e.clientY - downAt.y) < 4;
  panning = null;
  if (wasClick && state.result && state.img) handleCanvasClick(e);
});

function handleCanvasClick(e) {
  const r = cv.getBoundingClientRect();
  const { x, y, k } = state.view;
  const f = IMG_DPI / 72;
  // click position in pt coordinates
  const px = ((e.clientX - r.left) - x) / k / f;
  const py = ((e.clientY - r.top) - y) / k / f;
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
  updateSelBar(best && state.selected ? best : null);
  draw();
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
  const bar = $("selBar");
  if (!ch) { bar.hidden = true; return; }
  const st = state.result.styles.find(s => s.style_id === ch.style_id);
  $("selInfo").textContent =
    `${ch.class} · ${state.labels.get(ch.style_id) || (st && st.suggested_label) || ""} · ${fmtLen(ch.length_pt)}`;
  bar.hidden = false;
}

function removeSelected() {
  if (state.selected === null) return;
  state.excluded.add(state.selected);
  state.selected = null;
  updateSelBar(null);
  setStatus(`${state.excluded.size} line(s) removed`);
  $("restoreBtn").hidden = state.excluded.size === 0;
  renderItemized();
  draw();
}
$("removeBtn").onclick = removeSelected;
$("restoreBtn").onclick = () => {
  state.excluded.clear();
  $("restoreBtn").hidden = true;
  setStatus("removed lines restored");
  renderItemized();
  draw();
};
addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") &&
      document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    removeSelected();
  }
  if (e.key === "Escape") { state.selected = null; updateSelBar(null); draw(); }
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
