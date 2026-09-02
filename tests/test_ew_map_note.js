// A MAP THAT CANNOT BE DRAWN MUST NOT ERASE THE VOLUME'S EXPLANATION.
//
// THE DEFECT (measured 2026-09-02, live on :9901 against the DEM-truth
// outline sheet). /earthwork/map can refuse a body /earthwork answered 200:
// on a layers-only sheet the cut/fill floor refuses but the named layer
// stacks over a strip area still compute, and there is then no dz grid to
// paint. ewFetchMap's error branch was
//
//     const e = await r.json().catch(() => ({}));
//     $("ewResult").textContent = e.detail || ("map failed (" + r.status + ")");
//
// which does two harmful things at once. It writes the MAP's problem into
// the VOLUME's slot, wiping the layers-only explanation - which surface was
// short, what it held, what the slabs below still mean - and r.json()
// cannot parse a text/plain body, so a 500 (which is what the server was
// then returning; see tests/test_ew_map_refusal.py) collapsed the whole
// thing to "map failed (500)".
//
//     node tests/test_ew_map_note.js
"use strict";
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "webui", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(__dirname, "..", "webui", "style.css"), "utf8");

let fails = 0;
const check = (ok, msg) => {
  if (ok) console.log("ok: " + msg);
  else { fails++; console.error("FAIL: " + msg); }
};
const eq = (got, want, msg) =>
  check(got === want, msg + " (got " + JSON.stringify(got) + ")");

function fnSrc(name) {
  let j = SRC.indexOf("function " + name + "(");
  if (j < 0) return null;
  // keep a leading `async` - ewFetchMap is one, and slicing it off leaves a
  // body full of `await` inside a plain function
  if (SRC.slice(j - 6, j) === "async ") j -= 6;
  let d = 0;
  for (let k = SRC.indexOf("{", j); k < SRC.length; k++) {
    if (SRC[k] === "{") d++;
    else if (SRC[k] === "}" && --d === 0) return SRC.slice(j, k + 1);
  }
  return null;
}

// The DOM is every id the real page has - same rule as
// tests/test_ew_abstain_ui.js, and for the same reason: a harness scoped to
// what the function touches cannot express what it fails to touch.
const PAGE_IDS = [...HTML.matchAll(/\bid="([A-Za-z0-9_.:-]+)"/g)].map(m => m[1]);
// innerHTML and textContent are COUPLED here, as they are in a browser:
// writing either wipes what the other put there. Uncoupled stubs let the
// old branch's `$("ewResult").textContent = ...` pass a check on
// #ewResult's innerHTML, which is the very overwrite under test.
function mkEl(id) {
  return {
    id, _html: "", _text: "", hidden: false, children: [], checked: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); },
                 remove(c) { this._s.delete(c); },
                 toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
                 contains(c) { return this._s.has(c); } },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return mkEl("x"); },
    get innerHTML() {
      return this._html + this.children.map(c => c.innerHTML || "").join("");
    },
    set innerHTML(v) { this._html = v; this._text = ""; this.children = []; },
    get textContent() {
      return (this._text || this._html.replace(/<[^>]*>/g, ""))
        + this.children.map(c => c.textContent).join("");
    },
    set textContent(v) { this._text = v; this._html = ""; this.children = []; },
  };
}

// ---------------------------------------------------------------------------
console.log("1. the slot exists on the page and is styled");
// ---------------------------------------------------------------------------
check(/id="ewMapNote"/.test(HTML), "index.html has the #ewMapNote slot");
check(/\.ew-map-note\s*\{/.test(CSS), "style.css styles it");

// ---------------------------------------------------------------------------
console.log("2. a failed body is read as TEXT before it is parsed as JSON");
// ---------------------------------------------------------------------------
const HAS_FD = !!fnSrc("fetchDetail");
check(HAS_FD, "webui/app.js has a fetchDetail() (the old branch called "
  + "r.json().catch(() => ({})), which turns any non-JSON body into nothing)");

async function main() {
  if (HAS_FD) {
    const fd = new Function(fnSrc("fetchDetail") + "\nreturn fetchDetail;")();
    const mk = (t) => ({ text: async () => t });
    eq(await fd(mk("Internal Server Error")), "Internal Server Error",
      "a text/plain 500 body reaches the reader");
    eq(await fd(mk(JSON.stringify({ detail: "no scale on this page" }))),
      "no scale on this page", "a string detail is unwrapped");
    const o = await fd(mk(JSON.stringify({ detail: { message: "m", code: "c" } })));
    eq(o && o.code, "c", "a structured detail comes through whole");
    eq(await fd(mk("")), null, "an empty body is null, not an empty string");
  }

  // -------------------------------------------------------------------------
  console.log("3. the refusal lands in the MAP's slot, never in the volume's");
  // -------------------------------------------------------------------------
  const DETAIL = {
    message: "the existing surface carries only ONE elevation (324 ft) across "
      + "1 contour and 0 spot grades.",
    code: "surface_no_relief",
    surface: { name: "existing", n_contours: 1, n_spots: 0,
               distinct_elevations: 1, z_min_ft: 324, z_max_ft: 324 },
    basis: { existing: {}, proposed: {} },
  };

  async function runFetch(status, bodyText, bodyIsJson) {
    const els = {};
    for (const id of PAGE_IDS) els[id] = mkEl(id);
    // e6ac867's index.html has no #ewMapNote. Supplying it anyway is what
    // keeps this file failing on BEHAVIOUR there - the old branch leaves it
    // empty and overwrites #ewResult - instead of on a missing element.
    if (!("ewMapNote" in els)) els.ewMapNote = mkEl("ewMapNote");
    // what the layers-only Calculate had just written into the volume slot
    els.ewResult.innerHTML = "<b>no cut/fill:</b> the existing surface "
      + "carries only ONE elevation (324 ft) - layer volumes below still "
      + "compute (50,000 SF from the typed strip area)";
    els.ewMapLegend.hidden = false;
    els.ewMap.checked = true;
    const calls = [];
    const state = { job: "j1", page: 0,
      ew: { rows: [], result: { layers_only: true },
            map: { img: {}, bbox: [0, 0, 10, 10], refDz: 3.4 } } };
    const $ = (id) => {
      if (!(id in els)) throw new Error("no #" + id + " in index.html");
      return els[id];
    };
    const doc = {
      createElement(tag) { const e = mkEl(tag); e.tag = tag; return e; },
      createTextNode(t) { return { textContent: t, children: [] }; },
    };
    const note = fnSrc("ewMapNote");
    // ewMapNote reads the detail through ewDetailText (the one reader,
    // shared with the zone route), so the harness supplies it too; it is
    // absent on the older trees, where the note read the field inline.
    const src = (fnSrc("ewDetailText") || "") + "\n"
      + (fnSrc("fetchDetail") || "") + "\n" + (note || "") + "\n"
      + fnSrc("ewFetchMap") + "\nreturn ewFetchMap;";
    // e6ac867 has no ewMapNote and no fetchDetail; the stub keeps the
    // failure on BEHAVIOUR - the old branch simply never calls either.
    const f = new Function("$", "state", "document", "fetch", "ewBody",
      "draw", "esc", "createImageBitmap", note ? "_unused" : "ewMapNote", src);
    const resp = {
      ok: false, status,
      text: async () => bodyText,
      json: async () => {
        if (!bodyIsJson) throw new Error("not json");
        return JSON.parse(bodyText);
      },
      headers: { get: () => null },
    };
    await f($, state, doc, async () => resp, () => ({}),
      () => calls.push("draw"), (s) => String(s), async () => ({}),
      note ? undefined : (() => calls.push("ewMapNote")))();
    return { els, state, calls };
  }

  {
    const r = await runFetch(400, JSON.stringify({ detail: DETAIL }), true);
    check(/no cut\/fill:/.test(r.els.ewResult.innerHTML),
      "the volume slot still holds the layers-only explanation it was given");
    check(!/map failed/.test(r.els.ewResult.textContent),
      "...and was not overwritten with a status code");
    check(/only ONE elevation \(324 ft\)/.test(r.els.ewMapNote.textContent),
      "the map's own slot carries the floor's sentence");
    check(/No cut\/fill map/.test(r.els.ewMapNote.textContent),
      "...under its own headline");
    const html = r.els.ewMapNote.children.map(c => c.innerHTML || "").join(" ");
    check(/<b>existing<\/b>/.test(html),
      "...and names WHICH surface was short");
    eq(r.els.ewMapNote.hidden, false, "the slot is shown");
    eq(r.state.ew.map, null, "the stale bitmap is dropped");
    eq(r.els.ewMapLegend.hidden, true, "the depth ramp legend is hidden");
    check(r.calls.includes("draw"), "and the sheet repaints without it");
  }

  // -------------------------------------------------------------------------
  console.log("4. a text/plain 500 still says something a reader can use");
  // -------------------------------------------------------------------------
  {
    const s = await runFetch(500, "Internal Server Error", false);
    check(/Internal Server Error/.test(s.els.ewMapNote.textContent),
      "the unparseable body reaches the panel instead of vanishing");
    check(/no cut\/fill:/.test(s.els.ewResult.innerHTML),
      "and the volume slot is STILL untouched");
  }

  console.log(fails ? "\n" + fails + " FAILED" : "\nall checks passed");
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR: " + e.message); process.exit(1); });
