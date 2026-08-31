// SNAP TO ANYWHERE, pinned — the geometry behind draw / extend / join, the
// crossing marquee, and the length bookkeeping all three depend on.
//
// The three operator reports this feature answers:
//
//   1. "users should be able to draw a line at any time"
//   2. "the drag and select isnt detecting unless it has the whole line
//      selected ... even if I just grabbed the middle of those lines"
//   3. "if I draw a line and then click a point on a line it connects to that
//      line rather than having 2 points on one line ... our software will
//      connect it to a beginning or end point not the one we intended"
//
// What this test pins:
//
//   * PROJECTION — the perpendicular foot on a segment, clamped, to hand
//     arithmetic; and that the foot past an end IS that end (which is what
//     makes "join end-to-end" still reachable by a click past the end).
//   * VERTEX vs MID — a corner inside the vertex tolerance wins outright and
//     returns the corner EXACTLY; outside it, the foot wins and reports mid.
//     isEnd separates "an end of the run" from "a corner in the middle",
//     because that flag is what routes join → merge vs join → tee.
//   * SCREEN-SPACE TOLERANCE at three zooms: the same 9 px budget is a very
//     different number of page pt at 0.25x and at 4x, and the pick has to
//     move with the zoom or it is unusable at one end.
//   * CROSSING-RECT — including the exact case reported: a segment that
//     crosses the box with NO vertex inside it. Pinned against the SHIPPED
//     wzSegT/wzPtIn from WZ-MATH, not a copy, so the marquee and the work
//     area can never disagree about what "meets this box" means.
//   * VERTEX-INSERTION IDEMPOTENCE — welding twice at the same point inserts
//     once, and the insertion is length-neutral to float exactness.
//   * UNDO ROUND TRIP for the spur and the tee join, replayed against the
//     real UNDO-CORE block: after one undo the document is byte-identical to
//     the pre-edit state, and the asserted footage deltas are the ones the
//     status line prints.
//
// webui/app.js is not a module and touches the DOM at load, so this evals
// ONLY the marked blocks — WZ-MATH (the shipped clip SNAP-PURE is handed),
// SNAP-PURE, and UNDO-CORE.
//
// Dependency-free, like the other suites:  node tests/test_snap_geom.js

"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "webui", "app.js"), "utf8");

function block(name) {
  const a = src.indexOf(`// ${name}-BEGIN`);
  const b = src.indexOf(`// ${name}-END`);
  if (a < 0 || b < 0 || b <= a) {
    console.error(`FAIL: ${name} markers not found in webui/app.js`);
    process.exit(1);
  }
  return src.slice(a, b);
}

const S = new Function(block("WZ-MATH") + block("SNAP-PURE") + `
  return { SNAP_EPS, snapPolyLen, snapProject, snapOnPolyline, snapPickBest,
           snapInsertVertex, snapTolFrom, snapTouchesRect,
           wzSegT, wzPtIn };`)();

const U = new Function(block("UNDO-CORE") + `
  return { undoNewStack, undoCapture, undoApply, undoPush, undoStep };`)();

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
function near(x, y, tol, msg) {
  check(Math.abs(x - y) <= (tol == null ? 1e-9 : tol),
        `${msg} (got ${x}, want ${y})`);
}

// =========================================================================
// 1. PROJECTION onto a segment
// =========================================================================
{
  const a = [0, 0], b = [100, 0];
  let r = S.snapProject(30, 7, a, b);
  near(r.t, 0.3, 1e-12, "foot of (30,7) on a horizontal 100 run is t=0.3");
  near(r.q[0], 30, 1e-12, "  ...x is 30");
  near(r.q[1], 0, 1e-12, "  ...y is 0 (on the segment, not the click)");
  near(r.dist, 7, 1e-12, "  ...distance is the perpendicular 7");

  // past the far end: CLAMPED to the end. This is what makes "click past the
  // end of a line" mean "join to that end".
  r = S.snapProject(140, 0, a, b);
  near(r.t, 1, 0, "a click past the end clamps to t=1 exactly");
  near(r.q[0], 100, 0, "  ...and returns the endpoint itself");
  near(r.dist, 40, 1e-12, "  ...distance is measured to the endpoint");

  r = S.snapProject(-25, 0, a, b);
  near(r.t, 0, 0, "a click before the start clamps to t=0 exactly");

  // 45-degree segment: the foot is the true perpendicular, not a midpoint
  r = S.snapProject(10, 0, [0, 0], [10, 10]);
  near(r.q[0], 5, 1e-12, "diagonal foot x = 5");
  near(r.q[1], 5, 1e-12, "diagonal foot y = 5");
  near(r.dist, Math.sqrt(50), 1e-12, "diagonal foot distance = sqrt(50)");

  // degenerate segment: t is 0, the point is the segment
  r = S.snapProject(3, 4, [0, 0], [0, 0]);
  near(r.t, 0, 0, "zero-length segment gives t=0");
  near(r.dist, 5, 1e-12, "  ...and the plain point distance");
}

// =========================================================================
// 2. VERTEX vs MID on a polyline
// =========================================================================
const L = [[0, 0], [100, 0], [100, 100]];   // an L: right, then down-screen

{
  // dead centre of the first leg, far from every corner -> MID
  let h = S.snapOnPolyline(50, 3, L, 5);
  check(h.isVertex === false, "mid-segment click reports isVertex false");
  check(h.isEnd === false, "  ...and isEnd false");
  check(h.segIndex === 1, "  ...on segment 1");
  near(h.point[0], 50, 1e-12, "  ...at x 50");
  near(h.point[1], 0, 1e-12, "  ...at y 0");

  // 3 pt from the corner, vtol 5 -> the CORNER wins, exactly
  h = S.snapOnPolyline(100, 3, L, 5);
  check(h.isVertex === true, "a click 3 pt from the corner snaps to the vertex");
  check(h.vertexIndex === 1, "  ...vertex index 1 (the elbow)");
  check(h.isEnd === false, "  ...an elbow is NOT an end of the run");
  check(h.point[0] === 100 && h.point[1] === 0,
    "  ...and the point is the corner EXACTLY (no float drift)");

  // the same click with vtol 1 -> the corner no longer wins, and the foot
  // lands on LEG 2, which the click is actually 0 pt from. This is the
  // vertex-vs-mid distinction doing its job: shrink the vertex budget and
  // the elbow stops absorbing clicks that belong to the leg past it.
  h = S.snapOnPolyline(100, 3, L, 1);
  check(h.isVertex === false, "with a tight vtol the elbow does not absorb it");
  check(h.segIndex === 2, "  ...the foot is on leg 2");
  check(h.point[0] === 100 && h.point[1] === 3,
    "  ...at the point on leg 2 the click is level with");
  near(h.dist, 0, 1e-12, "  ...0 pt away, because the click is ON leg 2");

  // a foot that genuinely CLAMPS onto a corner still reports as a vertex,
  // even with no vertex budget at all: this is a two-leg run where the
  // click sits beyond the elbow on the outside of the turn
  const V = [[0, 0], [100, 0], [200, 0]];      // collinear: elbow at 100
  h = S.snapOnPolyline(260, 5, V, 0);
  check(h.isVertex === true && h.isEnd === true,
    "a foot clamped onto the finish reports vertex AND end with vtol 0");

  // truly mid-segment with a tight vtol: not a vertex
  h = S.snapOnPolyline(100, 40, L, 1);
  check(h.isVertex === false, "a foot in the middle of leg 2 is not a vertex");
  check(h.segIndex === 2, "  ...and it is on segment 2");

  // the ENDS of the run
  h = S.snapOnPolyline(-8, 0, L, 5);
  check(h.isVertex && h.isEnd && h.vertexIndex === 0,
    "a click past the start reports the START as an end");
  h = S.snapOnPolyline(100, 140, L, 5);
  check(h.isVertex && h.isEnd && h.vertexIndex === L.length - 1,
    "a click past the finish reports the FINISH as an end");

  // THE ROUTING CLAIM: join uses isEnd to choose merge-vs-tee. A click on the
  // body of a line is NOT an end, however close to the elbow it is.
  check(S.snapOnPolyline(100, 3, L, 5).isEnd === false,
    "join routing: a click at the elbow is a TEE, not an end-to-end merge");
  check(S.snapOnPolyline(101, 1, L, 5).isEnd === false,
    "join routing: just past the elbow, still a tee");
}

// snapPickBest across chains: nearest wins, tolerance is respected, and the
// chain_id rides along
{
  const chains = [
    { chain_id: 11, points: [[0, 0], [100, 0]] },
    { chain_id: 22, points: [[0, 20], [100, 20]] },
  ];
  let h = S.snapPickBest(50, 6, chains, 10, 3);
  check(h && h.chain_id === 11, "pick returns the nearer chain (11)");
  h = S.snapPickBest(50, 14, chains, 10, 3);
  check(h && h.chain_id === 22, "pick flips to 22 past the halfway point");
  h = S.snapPickBest(50, 10, chains, 3, 1);
  check(h === null, "nothing within tolerance returns null, never a guess");
  h = S.snapPickBest(50, 10, chains, 10, 1);
  check(h !== null && h.dist === 10, "a hit exactly at the tolerance counts");
}

// =========================================================================
// 3. SCREEN-SPACE TOLERANCE at three zooms
// =========================================================================
{
  const DPI = 150;                        // IMG_DPI in the app
  const PX = 9;                           // the draw/extend budget
  const t = (k) => S.snapTolFrom(PX, k, DPI);

  // pt = px / k / (dpi/72) + 1.5
  near(t(0.25), 9 / 0.25 / (150 / 72) + 1.5, 1e-12, "tolerance at 0.25x zoom");
  near(t(1), 9 / (150 / 72) + 1.5, 1e-12, "tolerance at 1x zoom");
  near(t(4), 9 / 4 / (150 / 72) + 1.5, 1e-12, "tolerance at 4x zoom");

  check(t(0.25) > t(1) && t(1) > t(4),
    "the pt tolerance SHRINKS as you zoom in — a constant screen budget");
  check(t(100) > 1.5 && t(100) < 1.6,
    "the +1.5 pt floor keeps a snap reachable at absurd zoom");

  // the same 9 px must pick the same chain at every zoom for a click that is
  // 9 px away on screen; and must miss one that is 20 px away, at every zoom
  const chain = [{ chain_id: 5, points: [[0, 0], [100, 0]] }];
  const perPt = (k) => k * (DPI / 72);    // screen px per page pt
  for (const k of [0.25, 1, 4]) {
    const nine = 9 / perPt(k);            // 9 px expressed in page pt
    check(S.snapPickBest(50, nine, chain, t(k), 0) !== null,
      `at ${k}x a click 9 px off the line snaps`);
    check(S.snapPickBest(50, nine * 1.02, chain, t(k), 0) !== null ||
          k >= 1,
      `at ${k}x the budget is not narrower than 9 px`);
  }
  // What the +1.5 pt FLOOR actually costs, said out loud rather than assumed:
  // it is negligible zoomed out and it DOMINATES zoomed in. The effective
  // on-screen grab is t(k) * px-per-pt.
  const eff = (k) => t(k) * perPt(k);
  near(eff(0.25), 9 + 1.5 * perPt(0.25), 1e-9,
    "effective grab at 0.25x is ~9.8 px (the floor barely shows)");
  near(eff(1), 9 + 1.5 * perPt(1), 1e-9,
    "effective grab at 1x is ~12.1 px");
  near(eff(4), 9 + 1.5 * perPt(4), 1e-9,
    "effective grab at 4x is ~21.5 px — the floor dominates, by design");
  check(eff(0.25) < eff(1) && eff(1) < eff(4),
    "the floor makes the grab WIDER on screen the further you zoom in, which "
    + "is what keeps a snap hittable when a pt is 8 px across");
  // a click well outside the budget still misses at every zoom
  for (const k of [0.25, 1, 4])
    check(S.snapPickBest(50, 60 / perPt(k), chain, t(k), 0) === null,
      `at ${k}x a click 60 px off the line does not snap`);
}

// =========================================================================
// 4. CROSSING-RECT — the marquee rule, against the SHIPPED clip
// =========================================================================
const RECT = [40, 40, 60, 60];            // a 20x20 box in the middle
const touches = (pts) => S.snapTouchesRect(pts, RECT, S.wzSegT, S.wzPtIn);
// the rule the crossing marquee REPLACED, for the comparison assertions
const fullyInside = (pts) => pts.every(
  q => q[0] >= RECT[0] && q[0] <= RECT[2] && q[1] >= RECT[1] && q[1] <= RECT[3]);

{
  // *** THE EXACT CASE THE OWNER REPORTED ***
  // a long line whose MIDDLE the box grabs; neither vertex is inside it
  const thru = [[0, 50], [100, 50]];
  check(fullyInside(thru) === false, "the reported case: old rule missed it");
  check(touches(thru) === true,
    "the reported case: the box grabs the MIDDLE of a line and it joins");

  // a polyline crossing the box diagonally, vertices far outside
  check(touches([[0, 0], [100, 100]]) === true,
    "a diagonal through the box counts, with no vertex inside");

  // a polyline that passes CLOSE but misses
  check(touches([[0, 61], [100, 61]]) === false,
    "a line 1 pt clear of the box does not join");
  check(touches([[0, 60], [100, 60]]) === true,
    "a line riding the box edge DOES join (boundary inclusive, like wzSegT)");

  // one vertex inside, the rest outside
  check(touches([[50, 50], [500, 500]]) === true,
    "one vertex inside the box is enough");

  // fully inside: the old rule and the new one agree — no regression for
  // anything the marquee already caught
  const inside = [[45, 45], [55, 45], [55, 55]];
  check(fullyInside(inside) === true && touches(inside) === true,
    "a fully-inside line still joins (the old rule's cases all survive)");

  // fully outside stays out
  check(touches([[0, 0], [10, 0], [0, 10]]) === false,
    "a line nowhere near the box stays out");

  // a corner clip: only a sliver of one segment is inside
  check(touches([[35, 45], [45, 38]]) === true,
    "a segment clipping one corner joins");
  // ...but a segment that meets the box at EXACTLY one point (a corner
  // graze, zero length inside) does not. Deliberate, and the reason it is
  // pinned: wzSegT measures LENGTH inside, so a zero-length overlap scores 0
  // there too. The marquee and the work-area mask stay one rule.
  check(touches([[38, 42], [42, 38]]) === false,
    "a segment grazing exactly the box corner does not join (zero length in)");

  // degenerate shapes
  check(touches([[50, 50]]) === true, "a single point inside joins");
  check(touches([[5, 5]]) === false, "a single point outside does not");
  check(touches([[50, 50], [50, 50]]) === true,
    "a repeated-vertex (zero-length) run inside joins");
  check(touches([]) === false, "an empty point list never joins");

  // AGREEMENT with the work-area mask: anything wzSegT scores > 0 for must
  // be something the marquee catches, over a pile of random segments
  let sd = 7, n = 0, disagreed = 0;
  const rnd = () => (sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 4000; i++) {
    const seg = [[rnd() * 120 - 10, rnd() * 120 - 10],
                 [rnd() * 120 - 10, rnd() * 120 - 10]];
    const clip = S.wzSegT(seg[0][0], seg[0][1], seg[1][0], seg[1][1], [RECT]);
    if ((clip > 0) !== touches(seg)) disagreed++;
    n++;
  }
  check(disagreed === 0,
    `marquee and work-area agree on all ${n} random segments`);
}

// =========================================================================
// 5. VERTEX INSERTION — idempotent, and length-neutral
// =========================================================================
{
  const P = [[0, 0], [100, 0], [100, 100]];
  const before = S.snapPolyLen(P);

  let r = S.snapInsertVertex(P, 1, [40, 0], S.SNAP_EPS);
  check(r.inserted === true, "a mid-segment weld inserts a vertex");
  check(r.index === 1, "  ...at index 1");
  check(r.points.length === 4, "  ...making 4 points");
  check(r.points[1][0] === 40 && r.points[1][1] === 0,
    "  ...at the exact snapped coordinate");
  check(P.length === 3, "  ...and the caller's array is untouched (a copy)");
  near(S.snapPolyLen(r.points), before, 1e-12,
    "  ...LENGTH-NEUTRAL: splitting a segment adds no length");

  // IDEMPOTENCE — the second weld at the same point is a no-op
  const r2 = S.snapInsertVertex(r.points, 1, [40, 0], S.SNAP_EPS);
  check(r2.inserted === false, "welding the same point twice inserts once");
  check(r2.index === 1, "  ...and reports the existing vertex's index");
  check(JSON.stringify(r2.points) === JSON.stringify(r.points),
    "  ...leaving the point list identical");

  // welding AT an existing vertex is also a no-op
  const r3 = S.snapInsertVertex(P, 1, [100, 0], S.SNAP_EPS);
  check(r3.inserted === false, "welding onto an existing corner inserts nothing");
  check(r3.index === 1, "  ...and names that corner");

  // a point within eps but not exactly equal still counts as the same point
  const r4 = S.snapInsertVertex(P, 1, [100, 1e-9], S.SNAP_EPS);
  check(r4.inserted === false, "a point inside SNAP_EPS of a corner is that corner");

  // ...and just outside eps is a genuine new vertex
  const r5 = S.snapInsertVertex(P, 1, [100 - 1e-3, 0], S.SNAP_EPS);
  check(r5.inserted === true, "a point outside SNAP_EPS is a real insertion");

  // second segment
  const r6 = S.snapInsertVertex(P, 2, [100, 30], S.SNAP_EPS);
  check(r6.inserted === true && r6.index === 2,
    "a weld on segment 2 lands between the elbow and the finish");
  near(S.snapPolyLen(r6.points), before, 1e-12, "  ...still length-neutral");
}

// =========================================================================
// 6. THE UNDO ROUND TRIP for spur and tee-join
// =========================================================================
// Replayed against the real UNDO-CORE block, exactly as tests/test_undo_core
// does: capture BEFORE the mutation, then one undoStep must restore a
// byte-identical document. The FOOTAGE DELTAS asserted here are the numbers
// the status line prints at the moment of the edit.

function chain(id, sid, pts, extra) {
  return Object.assign({
    chain_id: id, style_id: sid, class: "solid", color: [0, 0, 0],
    width: 0.5, points: pts.map(p => p.slice()), length_pt: S.snapPolyLen(pts),
  }, extra || {});
}
function mkDoc() {
  const chains = [
    chain(1, 10, [[0, 0], [100, 0]]),                    // 100 pt
    chain(2, 10, [[0, 10], [50, 10], [100, 10]]),        // 100 pt
    chain(3, 20, [[0, 40], [0, 90]]),                    //  50 pt
  ];
  // length_pt is NOT polyLen for a chain that picked up across a gap; give
  // chain 2 that shape, because the weld must not "fix" it
  chains[1].length_pt = 117.5;
  return { chains, excluded: new Set(), labels: new Map(),
           nextChainId: 4, selected: null, selPt: null };
}
function snap(doc) {
  return JSON.stringify({
    chains: doc.chains,
    excluded: [...doc.excluded].sort((x, y) => x - y),
    labels: [...doc.labels.entries()].sort((x, y) => x[0] - y[0]),
    nextChainId: doc.nextChainId,
    selected: doc.selected, selPt: doc.selPt,
  });
}
function step(stack, doc, dir) {
  const r = U.undoStep(stack, doc, dir);
  if (r) { doc.nextChainId = r.nextChainId; doc.selected = r.selected;
           doc.selPt = r.selPt; }
  return r;
}
const byId = (doc, id) => doc.chains.find(c => c.chain_id === id) || null;
function materialize(doc, ch) {              // mirrors app.js materialize()
  if (ch.custom) return ch;
  doc.excluded.add(ch.chain_id);
  const clone = JSON.parse(JSON.stringify(ch));
  clone.chain_id = doc.nextChainId++;
  clone.custom = true;
  if (doc.labels.has(ch.chain_id))
    doc.labels.set(clone.chain_id, doc.labels.get(ch.chain_id));
  doc.chains.push(clone);
  return clone;
}
// mirrors snapWeld(): insert the vertex, LEAVE length_pt alone
function weld(doc, hit) {
  const tgt = byId(doc, hit.chain_id);
  if (hit.isVertex) return tgt;
  const m = materialize(doc, tgt);
  const r = S.snapInsertVertex(m.points, hit.segIndex, hit.point, S.SNAP_EPS);
  if (r.inserted) m.points = r.points;
  return m;
}
// live footage of the document, the way the sidebar totals it
function docLen(doc) {
  let t = 0;
  for (const c of doc.chains)
    if (!doc.excluded.has(c.chain_id)) t += c.length_pt;
  return t;
}

// ---- 6a. THE SPUR -------------------------------------------------------
{
  const doc = mkDoc();
  const stack = U.undoNewStack(50);
  const before = snap(doc);
  const len0 = docLen(doc);

  // the operator armed extend on chain 2 and clicked its body at (25,10),
  // then clicked (25,40) as the destination
  const anchor = S.snapOnPolyline(25, 10.4, byId(doc, 2).points, 3);
  check(anchor.isVertex === false && anchor.segIndex === 1,
    "spur: the anchor is a MID-BODY point, not an end");
  const dest = [25, 40];
  const add = Math.hypot(dest[0] - anchor.point[0], dest[1] - anchor.point[1]);
  near(add, 30, 1e-12, "spur: the branch is 30 pt long");

  U.undoPush(stack, U.undoCapture(doc, [2, null], "spur"));
  const parent = weld(doc, { chain_id: 2, segIndex: anchor.segIndex,
                             point: anchor.point, isVertex: anchor.isVertex });
  const spur = JSON.parse(JSON.stringify(parent));
  spur.chain_id = doc.nextChainId++;
  spur.custom = true;
  spur.points = [anchor.point.slice(), dest];
  spur.length_pt = add;
  doc.chains.push(spur);
  doc.selected = spur.chain_id;
  const after = snap(doc);

  check(parent.points.length === 4,
    "spur: the parent gained a vertex at the tee (3 points -> 4)");
  check(parent.length_pt === 117.5,
    "spur: the parent's measured length is UNCHANGED by the weld "
    + `(got ${parent.length_pt})`);
  near(docLen(doc) - len0, 30, 1e-12,
    "spur: the sheet grew by EXACTLY the branch — 30 pt, nothing else");
  check(spur.style_id === parent.style_id,
    "spur: the branch is in the parent's family");
  check(spur.points[0][0] === anchor.point[0] &&
        spur.points[0][1] === anchor.point[1],
    "spur: the branch STARTS on the parent, to the coordinate");

  step(stack, doc, "undo");
  check(snap(doc) === before, "spur: one undo restores the document exactly");
  near(docLen(doc), len0, 1e-12, "spur: and the footage with it");
  step(stack, doc, "redo");
  check(snap(doc) === after, "spur: redo restores the post-edit document");
  step(stack, doc, "undo");
  check(snap(doc) === before, "spur: second undo still exact (swap symmetry)");
}

// ---- 6b. THE TEE JOIN ---------------------------------------------------
{
  const doc = mkDoc();
  const stack = U.undoNewStack(50);
  const before = snap(doc);
  const len0 = docLen(doc);

  // chain 1 is selected; the operator armed join and clicked chain 2 at
  // (60,10) — mid-body, so this is a tee, not an end-to-end merge
  const hit = S.snapPickBest(60, 10.5,
    [{ chain_id: 2, points: byId(doc, 2).points }], 5, 2);
  check(hit && hit.chain_id === 2 && hit.isEnd === false,
    "join: the click resolves to a MID-BODY point on chain 2");
  near(hit.point[0], 60, 1e-12, "join: at x 60 — WHERE THE OPERATOR CLICKED");
  near(hit.point[1], 10, 1e-12, "join: on the line, not at the click's y");

  const sel = byId(doc, 1);
  const A = sel.points;
  const dFirst = Math.hypot(hit.point[0] - A[0][0], hit.point[1] - A[0][1]);
  const dLast = Math.hypot(hit.point[0] - A[A.length - 1][0],
                           hit.point[1] - A[A.length - 1][1]);
  const add = Math.min(dFirst, dLast);
  near(add, Math.hypot(40, 10), 1e-12,
    "join: the connector runs from the NEARER end (41.23 pt), not the far one");
  check(dLast < dFirst, "join: ...which here is the finish, not the start");

  // the endpoint the OLD tool would have picked instead, for the record
  const oldEnd = [[0, 10], [100, 10]]
    .map(q => Math.hypot(hit.point[0] - q[0], hit.point[1] - q[1]))
    .sort((x, y) => x - y)[0];
  check(Math.abs(oldEnd - 40) < 1e-9,
    "join: the nearest ENDPOINT of chain 2 is 40 pt from the click — the "
    + "old tool would have connected there instead of at the click");

  U.undoPush(stack, U.undoCapture(doc, [1, 2], "connect to a line"));
  const c = materialize(doc, sel);
  c.points.push(hit.point.slice());
  c.length_pt += add;
  const tgt = weld(doc, hit);
  doc.selected = c.chain_id;
  const after = snap(doc);

  near(c.length_pt, 100 + Math.hypot(40, 10), 1e-12,
    "join: the selected line grew by exactly the connector");
  check(tgt.points.length === 4,
    "join: the target gained a vertex at the clicked point");
  check(tgt.length_pt === 117.5,
    "join: the target's measured length is UNCHANGED");
  near(docLen(doc) - len0, Math.hypot(40, 10), 1e-12,
    "join: the sheet grew by the connector and NOTHING else");

  step(stack, doc, "undo");
  check(snap(doc) === before, "join: one undo restores the document exactly");
  near(docLen(doc), len0, 1e-12, "join: and the footage with it");
  step(stack, doc, "redo");
  check(snap(doc) === after, "join: redo restores the post-edit document");
  step(stack, doc, "undo");
  check(snap(doc) === before, "join: second undo still exact");
}

// ---- 6c. AN END-TO-END CLICK still reads as an end ----------------------
{
  const doc = mkDoc();
  // clicking past the finish of chain 2 must route to the OLD merge path
  const hit = S.snapPickBest(112, 10, [{ chain_id: 2, points: byId(doc, 2).points }],
                             20, 7);
  check(hit && hit.isEnd === true,
    "a click past a line's finish still reads as END-TO-END (merge, unchanged)");
  // ...and clicking right on the endpoint too
  const onEnd = S.snapPickBest(100, 11, [{ chain_id: 2, points: byId(doc, 2).points }],
                               20, 7);
  check(onEnd && onEnd.isEnd === true && onEnd.point[0] === 100,
    "a click ON the endpoint reads as end-to-end and returns it exactly");
}

// ---- 6d. A DRAWN LINE welding at both ends ------------------------------
{
  const doc = mkDoc();
  const stack = U.undoNewStack(50);
  const before = snap(doc);
  const len0 = docLen(doc);

  // drawn from a point on chain 1 to a point on chain 3
  const h1 = S.snapPickBest(30, 0.4, [{ chain_id: 1, points: byId(doc, 1).points }], 3, 1);
  const h3 = S.snapPickBest(0.4, 60, [{ chain_id: 3, points: byId(doc, 3).points }], 3, 1);
  check(h1 && !h1.isVertex && h3 && !h3.isVertex,
    "draw: both ends landed mid-body on real lines");

  const pts = [h1.point.slice(), h3.point.slice()];
  const drawnLen = S.snapPolyLen(pts);
  U.undoPush(stack, U.undoCapture(doc, [1, 3], "drawn line"));
  const drawn = JSON.parse(JSON.stringify(byId(doc, 1)));
  drawn.chain_id = doc.nextChainId++;
  drawn.custom = true;
  drawn.points = pts;
  drawn.length_pt = drawnLen;
  doc.chains.push(drawn);
  const t1 = weld(doc, h1), t3 = weld(doc, h3);
  doc.selected = drawn.chain_id;
  const after = snap(doc);

  check(t1.points.length === 3 && t3.points.length === 3,
    "draw: BOTH targets gained a vertex where the drawn line meets them");
  check(t1.length_pt === 100 && t3.length_pt === 50,
    "draw: neither target's measured length moved");
  near(docLen(doc) - len0, drawnLen, 1e-9,
    "draw: the sheet grew by exactly the drawn run");
  check(drawn.points[0][0] === t1.points[1][0] &&
        drawn.points[0][1] === t1.points[1][1],
    "draw: the drawn end and the inserted vertex are the SAME point — the "
    + "two lines genuinely meet, they do not merely overlap");

  step(stack, doc, "undo");
  check(snap(doc) === before,
    "draw: ONE undo reverses the drawn line AND both welds");
  near(docLen(doc), len0, 1e-9, "draw: and the footage with it");
  step(stack, doc, "redo");
  check(snap(doc) === after, "draw: redo restores all three chains");
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall snap-geometry tests passed");
