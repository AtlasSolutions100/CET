"""Corpus regression harness: the standing quality gate, made cheap.

Every engine change reruns the same five-sheet gate. Two costs dominate:
stroke extraction (deterministic per file+page+mtime, so cache it) and the
sheets themselves (independent, so run them in parallel). Detection code
changes constantly, extraction rarely - the cache keys on the PDF only.

Usage:  python -m takeoff_engine.regress            # fast gate (10 sheets)
        python -m takeoff_engine.regress --full     # + wide layer sweep
        python -m takeoff_engine.regress --no-cache # force fresh extract
"""

import argparse
import hashlib
import json
import sys
import os
import pickle
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

CACHE = Path(__file__).parent.parent / "out" / "cache"
CORPUS = [
    ("../TakeoffPro AI/Plans/C4.0-SITE-GRADING-PLAN-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/C8.0-STORM-LAYOUT-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/C3.0-Site-Plan-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/C9.0-ROAD-LAYOUT-Rev.1.pdf", 0),
    ("../TakeoffPro AI/Plans/Belle Farms Structural Plans.pdf", 0),
    ("../TakeoffPro AI/Oncor Cloudcrest Substation Civils - 20251212.pdf_safe.pdf", 2),
    ("../TakeoffPro AI/Oncor Cloudcrest Substation Civils - 20251212.pdf_safe.pdf", 3),
]

# Beaumont Excavating's own sheets - a live client, and the only layered
# ground truth in the corpus that is not the one Loves Lane civil project.
# Three of the seven sheets above (Belle Farms p0, Oncor p2, Oncor p3) carry
# NO CAD layers at all, so they can never score a layer metric; these can.
# Picked for layer breadth per second: Guide Civil p3 = printed C3.0, 55
# linework layers; Barn Landscaping p5 = printed L200 layout, 115 layers;
# Barn Landscaping p6 = printed L100 tree plan, contour-heavy and only ~3 s.
CORPUS_BEAUMONT = [
    ("../client_meet/beaumont/SWR_Guide_Residence_-_Civil_5.8.26.pdf", 3),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Landscaping_4.7.26.pdf", 5),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Landscaping_4.7.26.pdf", 6),
]

# --full only. Same measurement, more sheets and more layer families, at
# roughly triple the wall time - run it before a release or after a chain.py
# constant moves, not on every edit.
CORPUS_FULL_EXTRA = [
    ("../client_meet/beaumont/SWR_Guide_Residence_-_Civil_5.8.26.pdf", 2),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Landscaping_4.7.26.pdf", 11),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Civil_4.7.26.pdf", 6),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Civil_4.7.26.pdf", 13),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Civil_4.7.26.pdf", 14),
    ("../client_meet/beaumont/SWR_Barn_Residence_-_Structural_4.7.26.pdf", 3),
    ("../client_meet/beaumont/260603 Thielen Biggerstaff Residence.pdf", 10),
]


def corpus_root() -> Path:
    """Directory that holds the plan corpus ('TakeoffPro AI').

    CORPUS entries are written relative to the checkout, which is right for
    a normal clone and wrong inside a git worktree (.claude/worktrees/<name>):
    there the same '..' lands on .claude/worktrees/TakeoffPro AI and every
    sheet dies with a FileNotFoundError buried in a ProcessPool traceback,
    which reads like a corpus problem rather than a path problem. So the gate
    could not be run from a worktree at all - exactly where it is most wanted.
    Walking up for the corpus directory is the same fix bench.corpus_root()
    already uses, and it is a no-op in a normal clone.
    """
    base = Path(__file__).resolve().parent.parent
    for up in [base, *base.parents]:
        if (up / "TakeoffPro AI").is_dir():
            return up
    raise SystemExit(
        f"regress: could not locate the 'TakeoffPro AI' corpus root above\n"
        f"  {base}\n"
        f"The gate needs the plan corpus checked out beside the repo.")


def corpus_path(rel: str) -> str:
    """Absolute path for one CORPUS entry, resolved against corpus_root()."""
    if os.path.isabs(rel):
        return rel
    p = (corpus_root() / rel.replace("../", "", 1)).resolve()
    if not p.exists():
        raise SystemExit(f"regress: corpus sheet not found at\n  {p}\n"
                         f"  (CORPUS entry {rel!r})")
    return str(p)


def cached_extract(pdf: str, page_no: int, use_cache: bool = True):
    """Stroke units + words for a page, cached on (path, page, mtime)."""
    import pymupdf

    from .extract import extract_strokes, page_words

    pdf = corpus_path(pdf)
    # key on the EXTRACTOR's mtime too: cached units must not outlive the
    # code that produced them (the cache would otherwise serve pre-fix
    # geometry and the gate would silently test stale extraction)
    ex_src = Path(__file__).parent / "extract.py"
    key = hashlib.sha1(
        f"{pdf}|{page_no}|{os.path.getmtime(pdf)}|{os.path.getmtime(ex_src)}"
        .encode()).hexdigest()
    f = CACHE / f"{key}.pkl"
    if use_cache and f.exists():
        with open(f, "rb") as fh:
            return pickle.load(fh)
    doc = pymupdf.open(pdf)
    page = doc[page_no]
    units = extract_strokes(page)
    words = page_words(page)
    doc.close()
    if use_cache:
        CACHE.mkdir(parents=True, exist_ok=True)
        with open(f, "wb") as fh:
            pickle.dump((units, words), fh, protocol=5)
    return units, words


def _run_sheet(args):
    pdf, page_no, use_cache = args
    import numpy as np

    from .chain import build_chains, _sample_polyline
    from .eval_layers import (class_metrics, derived_layer_metrics,
                              phantom_span_audit)

    t0 = time.time()
    units, words = cached_extract(pdf, page_no, use_cache)
    t1 = time.time()
    chains = build_chains(units, words=words)
    t2 = time.time()
    m = class_metrics(chains, units)
    d = derived_layer_metrics(chains, units)
    a = phantom_span_audit(chains, units)

    # reversal points the SOURCE strokes already contain (zigzag
    # shading bands, conveyance arrows): a chain tracing one faithfully
    # is not a bad weld, so those vertices are exempt
    _src_rev = []
    for _u in units:
        _p = np.asarray(_u.pts)
        for _i in range(1, len(_p) - 1):
            _v1, _v2 = _p[_i] - _p[_i - 1], _p[_i + 1] - _p[_i]
            _la, _lb = np.hypot(*_v1), np.hypot(*_v2)
            if _la > 1 and _lb > 1 and (_v1 / _la) @ (_v2 / _lb) < -0.8 \
                    and min(_la, _lb) > 15:
                _src_rev.append(_p[_i])
    if _src_rev:
        from scipy.spatial import cKDTree as _KD
        _rev_tree = _KD(np.asarray(_src_rev))
    else:
        _rev_tree = None

    def spikes(c):
        p = np.asarray(c.pts)
        n = 0
        for i in range(1, len(p) - 1):
            v1, v2 = p[i] - p[i - 1], p[i + 1] - p[i]
            la, lb = np.hypot(*v1), np.hypot(*v2)
            if la > 1 and lb > 1 and (v1 / la) @ (v2 / lb) < -0.8 \
                    and min(la, lb) > 15:
                if _rev_tree is not None and np.isfinite(
                        _rev_tree.query(p[i], distance_upper_bound=1.5)[0]):
                    continue
                n += 1
        return n

    return {
        "sheet": f"{Path(pdf).name[:26]} p{page_no}",
        "extract_s": round(t1 - t0, 1),
        "build_s": round(t2 - t1, 1),
        "chains": len(chains),
        "phantom": len(a["bad"]),
        "spikes": sum(spikes(c) for c in chains if c.klass != "annotation"),
        "precision": {k: round(v["precision"], 4)
                      for k, v in m["per_class"].items()
                      if v["n"] and v["precision"] is not None},
        "truth": {lay.split("|")[-1]: round(v["class_acc"], 4)
                  for lay, v in m["truth_layers"].items()},
        # class_metrics has always computed these two next to class_acc and
        # the gate has always thrown them away, so a change could gut recall
        # and the headline would not move. Carried, not computed here.
        "truth_recall": {lay.split("|")[-1]: v["recall"]
                         for lay, v in m["truth_layers"].items()
                         if v["recall"] is not None},
        "truth_cov": {lay.split("|")[-1]: v["coverage"]
                      for lay, v in m["truth_layers"].items()
                      if v["coverage"] is not None},
        "truth_ink": {lay.split("|")[-1]: sum(
                          u.length for u in units
                          if u.layer == lay
                          and not getattr(u, "_absorbed", False)
                          and not (u.color and min(u.color) > 0.92
                                   and not getattr(u, "on_fill", False)))
                      for lay in m["truth_layers"]},
        # name-derived truth over EVERY layer on the sheet, not the seven
        # hand-asserted ones. rows dropped: only the summary crosses the
        # process boundary, the misses list is what a human acts on.
        "roles": d["roles"],
        "lost": [{k: r[k] for k in ("layer", "unit_ink", "recall",
                                    "coverage", "coverage_any", "n_chains")}
                 for r in d["lost"][:8]],
        "misfiled": [{k: r[k] for k in ("layer", "unit_ink", "recall",
                                        "coverage", "coverage_any",
                                        "n_chains")}
                     for r in d["misfiled"][:8]],
        # OVER-CAPTURE. Length that is not measured ink: welded gaps and
        # marks picked up from elsewhere. See LineChain.gap_pt / pickup_pt.
        "length_pt": float(sum(c.length for c in chains)),
        "gap_pt": float(sum(c.gap_pt for c in chains)),
        "pickup_pt": float(sum(c.pickup_pt for c in chains)),
        "n_lost": len(d["lost"]),
        "n_misfiled": len(d["misfiled"]),
    }


BASELINE = Path(__file__).parent.parent / "gate-baseline.json"


# ---------------------------------------------------------------------------
# The VOLUME signature.
#
# detect_page.engine_sig() fingerprints the code that decides what a detect
# result contains, and it is what invalidates cached detections. Measured
# 2026-09-01: its _ENGINE_FILES lists ten modules and earthwork.py - the
# module that computes the cubic yards a bid depends on - is not one of them.
# So an earthwork edit moved no signature, invalidated no cache and tripped
# no gate; the only volume test (tests/test_grading_zone.py) checks the
# engine against its own grid arithmetic, not against a certified recipe.
#
# This is the second fingerprint, kept SEPARATE from engine_sig on purpose:
#   * a volume-only change must not invalidate detection caches (every
#     demo page would come back stale for a change that moved no chain);
#   * a detection change must not silently re-baseline volumes.
# It lives here and not beside engine_sig() because detect_page.py is one of
# engine_sig's hashed inputs: adding a function there would move engine_sig
# for a change that touches no detection - exactly what the split forbids.
#
# WHAT IS HASHED (round two, 2026-09-02). Round one hashed the IMPORT
# CLOSURE of earthwork.py - the files an ast walk over the package's own
# import graph reaches from earthwork.py, __init__.py and surface*.py. That
# is the wrong set, and the fresh adversary showed why with numbers: a
# 12-line hook appended to takeoff_engine/ledger.py (imported by server.py
# at module level, reached by no import from earthwork.py) replaced
# earthwork.cut_fill with a wrapper that scales fill by 0.85 whenever the
# proposed surface carries more than ten spots. The gate printed "23 passed",
# both signatures unchanged; the bid call with all 46 Oncor spots came back
# fill 8248.2 -> 7011.0 (-15%). The same hook appended to regress.py - this
# file - also passed. An import-closure walk can never see a monkeypatch
# from a module the walk does not reach, and EVERYTHING importable in the
# server process can patch the engine.
#
# So the hashed set is now every *.py under takeoff_engine/ (this file
# included), plus the repo-root .py files the server process executes:
# server.py, and provision_demo.py (the provisioning entry point, which
# imports takeoff_engine.users). server.py's own imports were read on
# 2026-09-02: it imports takeoff_engine.* only (branding, ledger, chain,
# classify_page, detect_page, extract, marks, scale_detect at module level;
# users, earthwork, marks lazily) and third-party packages - no other
# repo-root module - so _EARTHWORK_ROOT_FILES is those two. The
# executed-on-import files that no import statement names (conftest.py,
# sitecustomize.py, usercustomize.py, *.pth beside the package or at the
# repo root) are hashed whenever they exist, as before.
#
# YES, this means an unrelated edit to scale_detect.py, or to a docstring
# in ledger.py, moves earthwork_sig and forces a re-accept of every recipe
# baseline. That is the point. A re-accept whose numbers are identical is
# ONE VISIBLE COMMIT that says "the volume code's process changed, the
# volumes did not, here is the proof"; an invisible volume change is a
# wrong bid. The cost is a commit; the alternative is a fence with a hole
# whose size nobody knows.
#
# The import-closure walk is kept as earthwork_closure(): it is printed
# beside the signature as the explanation of which files matter MOST - the
# ones whose bytes shape every cubic yard - and it no longer decides what
# is hashed.
#
# Site-packages .pth files and a user-site customize module live OUTSIDE
# the repo and cannot be pinned by a content hash; earthwork_import_hooks()
# reports them so the test can print them.
# ---------------------------------------------------------------------------
_EARTHWORK_ROOTS = ("__init__.py", "earthwork.py", "surface*.py")
# Executed-on-import files that no import statement names, relative to the
# package directory. Hashed when present; a baseline lists exactly which.
_EARTHWORK_HOOK_FILES = (
    "conftest.py", "sitecustomize.py", "usercustomize.py", "*.pth",
    "../conftest.py", "../sitecustomize.py", "../usercustomize.py",
    "../tests/conftest.py", "../*.pth",
)
# Repo-root .py files the server process executes. Read off server.py's and
# provision_demo.py's import statements on 2026-09-02 (see the block above);
# re-read them when a new entry point appears beside server.py.
_EARTHWORK_ROOT_FILES = ("../server.py", "../provision_demo.py")


def earthwork_import_hooks() -> list:
    """What runs on `import takeoff_engine` from OUTSIDE the repo, so it can
    be reported beside the signature rather than pretended away: every .pth
    in a site directory (each is executed at interpreter start), a loaded
    sitecustomize / usercustomize, PYTHONPATH. None of it is hashed - it is
    not in the tree - which is exactly why it is printed."""
    import site
    out = []
    dirs = []
    try:
        dirs += list(site.getsitepackages())
    except AttributeError:
        pass
    try:
        if site.ENABLE_USER_SITE:
            dirs.append(site.getusersitepackages())
    except AttributeError:
        pass
    for d in dirs:
        for p in sorted(Path(d).glob("*.pth")) if Path(d).is_dir() else []:
            out.append(f"pth {p}")
    for m in ("sitecustomize", "usercustomize"):
        mod = sys.modules.get(m)
        if mod is not None:
            out.append(f"{m} {getattr(mod, '__file__', '?')}")
    if os.environ.get("PYTHONPATH"):
        out.append(f"PYTHONPATH={os.environ['PYTHONPATH']}")
    return out


def _package_imports(path: Path, pkg: Path) -> set:
    """Module names under `pkg` that `path` imports, anywhere in the file -
    module level or inside a function, since a lazy import still runs."""
    import ast
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return set()
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level:                      # from . import x / from .x import y
                if node.module:
                    names.add(node.module.split(".")[0])
                else:
                    names.update(a.name for a in node.names)
            elif node.module == pkg.name:       # from takeoff_engine import x
                names.update(a.name for a in node.names)
            elif node.module and node.module.startswith(pkg.name + "."):
                names.add(node.module.split(".")[1])
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name.startswith(pkg.name + "."):
                    names.add(a.name.split(".")[1])
    found = set()
    for n in names:
        if (pkg / f"{n}.py").is_file():
            found.add(f"{n}.py")
        elif (pkg / n).is_dir():
            found.update(str(q.relative_to(pkg)).replace("\\", "/")
                         for q in sorted((pkg / n).rglob("*.py")))
    return found


def _hook_files(pkg: Path) -> list:
    """The executed-on-import files that exist right now, package-relative."""
    out = []
    for pat in _EARTHWORK_HOOK_FILES:
        # pathlib.glob does not walk '..' segments: split the directory off
        # the name and keep the '../' prefix in the recorded relative path
        sub, _, name = pat.rpartition("/")
        base = pkg / sub if sub else pkg
        out += [f"{sub}/{q.name}" if sub else q.name
                for q in sorted(base.glob(name)) if q.is_file()]
    return out


def earthwork_closure(pkg: "Path | None" = None) -> list:
    """The IMPORT CLOSURE of the volume code, package-relative, sorted: what
    an ast walk reaches from _EARTHWORK_ROOTS over the package's own import
    graph, plus the hook files that exist. This is the EXPLANATION printed
    beside the signature - the files whose bytes shape every cubic yard
    directly - and since 2026-09-02 it is NOT what earthwork_sig() hashes
    (see the block above: a walk cannot see a monkeypatch from a module it
    never reaches). earthwork_sig_files() is the hashed set."""
    pkg = Path(pkg) if pkg else Path(__file__).parent
    todo = []
    for pat in _EARTHWORK_ROOTS:
        todo += [q.name for q in sorted(pkg.glob(pat)) if q.is_file()]
    todo += _hook_files(pkg)
    seen = []
    while todo:
        rel = todo.pop(0)
        if rel in seen:
            continue
        seen.append(rel)
        for dep in sorted(_package_imports(pkg / rel, pkg)):
            if dep not in seen:
                todo.append(dep)
    return sorted(seen)


def earthwork_sig_files(pkg: "Path | None" = None) -> list:
    """The exact set earthwork_sig() hashes, package-relative, sorted: every
    *.py under the package (subpackages included, __pycache__ never), the
    repo-root files in _EARTHWORK_ROOT_FILES that exist, and the hook files
    in _EARTHWORK_HOOK_FILES that exist. Nothing here is discovered by
    walking imports - see the block above for the 15% that taught that."""
    pkg = Path(pkg) if pkg else Path(__file__).parent
    files = [str(q.relative_to(pkg)).replace("\\", "/")
             for q in sorted(pkg.rglob("*.py"))
             if q.is_file() and "__pycache__" not in q.parts]
    files += [rel for rel in _EARTHWORK_ROOT_FILES if (pkg / rel).is_file()]
    files += _hook_files(pkg)
    return sorted(set(files))


def earthwork_file_hashes(pkg: "Path | None" = None) -> dict:
    """sha1[:16] of each file in earthwork_sig_files(), by relative path -
    recorded in a baseline so a moved signature can NAME the file that
    moved it instead of printing two opaque hashes."""
    pkg = Path(pkg) if pkg else Path(__file__).parent
    return {rel: hashlib.sha1((pkg / rel).read_bytes()).hexdigest()[:16]
            for rel in earthwork_sig_files(pkg)}


def earthwork_sig(pkg: "Path | None" = None) -> str:
    """Content hash (sha1[:16], like engine_sig) over earthwork_sig_files().

    Bytes, not mtimes, for the reason engine_sig's docstring gives: a fresh
    checkout or image rebuild must not move it, a real edit must. And it is
    the WHOLE package plus the server entry points, not an import closure:
    an unrelated edit to scale_detect.py moves this and forces a re-accept
    with identical numbers - one visible commit - because the alternative,
    a module outside the closure patching cut_fill at import time, is an
    invisible volume change and a wrong bid (measured: -15% fill).
    """
    pkg = Path(pkg) if pkg else Path(__file__).parent
    h = hashlib.sha1()
    for rel in earthwork_sig_files(pkg):
        h.update(rel.encode() + b":")
        h.update(hashlib.sha1((pkg / rel).read_bytes()).digest())
        h.update(b"|")
    return h.hexdigest()[:16]

def stale_bytecode(pkg: "Path | None" = None) -> tuple:
    """Bytecode beside the hashed sources that the interpreter WOULD load and
    that does not match the source: (problems, audited) - a list of FAIL
    strings and a list of what was checked.

    The hole (fresh adversary, 2026-09-02, N7): earthwork.py's bytes left
    alone, __pycache__/earthwork.cpython-312.pyc rebuilt from a modified
    source with its header stamped with the original mtime and size. The
    interpreter's timestamp check passes, the pyc is what runs, every
    content hash is unchanged. The gate itself no longer loads any pyc from
    the tree (tests/test_earthwork_regress.py sets sys.pycache_prefix to a
    fresh temp dir and dont_write_bytecode before the first tree import,
    and _earthwork_check launches it with -B and PYTHONPYCACHEPREFIX), so
    its numbers come from source - which is exactly why THIS audit exists:
    the gate computing an honest number from source says nothing about the
    server process, which loads whatever __pycache__ holds. So every hashed
    .py is recompiled here and compared, as a code object, to each pyc the
    interpreter would accept for it. A mismatch is a FAIL that names the
    pyc; delete __pycache__ and re-run.

    "Would load" is decided the way importlib decides it (PEP 3147 / PEP
    552): a timestamp pyc only when its header mtime and size equal the
    source's; an unchecked hash-based pyc always; a checked hash-based pyc
    when its source hash matches. A pyc the interpreter would reject (older
    magic, superseded timestamp) is listed as ignored, never as a failure -
    an edit that has not been run yet leaves one of those behind.
    """
    import importlib.util
    import marshal
    import struct
    pkg = Path(pkg) if pkg else Path(__file__).parent
    tag = sys.implementation.cache_tag
    problems, audited = [], []
    for rel in earthwork_sig_files(pkg):
        src = (pkg / rel)
        if src.suffix != ".py":
            continue
        cache = src.parent / "__pycache__"
        if not cache.is_dir():
            continue
        source = src.read_bytes()
        st = src.stat()
        for pyc in sorted(cache.glob(f"{src.stem}.{tag}*.pyc")):
            name = f"{rel.rsplit('/', 1)[0] + '/' if '/' in rel else ''}" \
                   f"__pycache__/{pyc.name}"
            data = pyc.read_bytes()
            if len(data) < 16 or data[:4] != importlib.util.MAGIC_NUMBER:
                audited.append(f"{name}: ignored (other interpreter's magic)")
                continue
            flags = struct.unpack("<I", data[4:8])[0]
            if flags & 1:                      # hash-based (PEP 552)
                if flags & 2 and data[8:16] != importlib.util.source_hash(source):
                    audited.append(f"{name}: ignored (checked hash differs)")
                    continue
                why = "unchecked hash-based" if not flags & 2 else "hash matches"
            else:                              # timestamp-based
                mtime, size = struct.unpack("<II", data[8:16])
                if mtime != int(st.st_mtime) & 0xFFFFFFFF \
                        or size != st.st_size & 0xFFFFFFFF:
                    audited.append(f"{name}: ignored (superseded: header "
                                   f"mtime/size differ from the source)")
                    continue
                why = "header mtime/size match the source"
            opt = 2 if ".opt-2." in pyc.name else 1 if ".opt-1." in pyc.name else 0
            try:
                have = marshal.loads(data[16:])
            except Exception as e:  # noqa: BLE001
                problems.append(f"stale bytecode: {name} is unreadable ({e}) "
                                f"but the interpreter would load it ({why})")
                continue
            want = compile(source, str(src), "exec", dont_inherit=True,
                           optimize=opt)
            if have != want:
                problems.append(
                    f"stale bytecode: {name} does not match {rel} recompiled "
                    f"from source, and the interpreter would load it ({why}) - "
                    f"the server process runs THIS, not the hashed source; "
                    f"delete {cache} and re-run")
            else:
                audited.append(f"{name}: matches source")
    return problems, audited


# Tolerance on a class-accuracy fraction. Detection is deterministic (accept
# loops are order-pinned), so this is not for run-to-run noise - it is for
# float formatting drift across library versions.
_EPS = 5e-4


def _check(now: dict) -> int:
    """Compare against the committed baseline. 0 = pass, 1 = regression.

    TWO TIERS, and the split is the whole point of this function.

    HARD - fails the build. Metrics that duplicated ink cannot flatter:
      phantom      spans traced that the source does not contain. Only goes
                   up when the tracer invents geometry.
      spikes       reversal vertices the source strokes do not contain, i.e.
                   bad welds. Only goes up when a join is wrong.
      truth class  per-layer classification accuracy. Tracing the same ink
                   twice does not make its CLASS more correct.
      precision    per-class. Same argument.
      chains       any movement at all, in either direction. A chain-count
                   change is the loudest signal this harness has and it must
                   never pass silently; re-baseline with --accept when the
                   change is intended and explained.

    SOFT - printed with deltas, never fails. Recall, coverage and ink capture
    all clamp at 1.0, so tracing the same ink twice RAISES them. The repo's
    own before/after for the known double-count in chain.py:860-937 shows
    derived recall dropping 93.0 -> 91.6 when the duplicates are removed. Gate
    on that and the double-count is pinned in place for good, because every
    future fix to it reads as a regression. These become gateable only once a
    chain can say which of its length is measured ink, which is a weld across
    blank paper, and which was picked up from a neighbour - i.e. once length
    carries provenance. Until then, reporting them is honest and failing on
    them is not.
    """
    if not BASELINE.exists():
        print(f"\nGATE: no baseline at {BASELINE} - run with --accept to "
              f"create one.")
        return 1
    base = json.loads(BASELINE.read_text(encoding="utf-8"))
    if base.get("corpus") != now.get("corpus"):
        print(f"\nGATE: baseline is the {base.get('corpus')!r} corpus and "
              f"this run is {now.get('corpus')!r}. Compare like with like.")
        return 1
    fails, notes = [], []
    # THE FINGERPRINT, exactly as the earthwork gate treats earthwork_sig.
    # Until 2026-09-02 (N9) gate-baseline.json recorded no engine_sig and
    # nothing compared it, so a detection-code change that happened to
    # move no count on these ten sheets - an __init__.py patch aimed at a
    # sheet outside the corpus - moved engine_sig and PASSED. Ten sheets
    # are a sample of the corpus, not the corpus; the signature is the
    # only thing here that sees the whole code. A move is a FAIL until
    # --accept records the new one in a commit that says why, and a
    # baseline that never recorded one is unpinned, which is the same FAIL.
    # (A `now` with no engine_sig is a hand-built summary, tests/test_gate.py;
    # _run_corpus always carries one.)
    if "engine_sig" in now:
        if not base.get("engine_sig"):
            fails.append(f"engine_sig: baseline records none (unpinned) - now "
                         f"{now['engine_sig']}; re-baseline with --accept")
        elif base["engine_sig"] != now["engine_sig"]:
            fails.append(f"engine_sig moved: baseline {base['engine_sig']} now "
                         f"{now['engine_sig']} - the detection code changed; if "
                         f"every count below is unchanged, say so and re-baseline "
                         f"with --accept")
    bs, ns = base["sheets"], now["sheets"]
    for name in sorted(set(bs) | set(ns)):
        if name not in ns:
            fails.append(f"{name}: sheet missing from this run")
            continue
        if name not in bs:
            fails.append(f"{name}: sheet not in the baseline")
            continue
        b, n = bs[name], ns[name]
        if b["chains"] != n["chains"]:
            fails.append(f"{name}: chains {b['chains']} -> {n['chains']}")
        for k in ("phantom", "spikes"):
            if n[k] > b[k]:
                fails.append(f"{name}: {k} {b[k]} -> {n[k]}  (worse)")
            elif n[k] < b[k]:
                notes.append(f"{name}: {k} {b[k]} -> {n[k]}  (better)")
        for lay, bv in b["truth"].items():
            nv = n["truth"].get(lay)
            if nv is None:
                fails.append(f"{name}: truth layer {lay} disappeared")
            elif nv < bv - _EPS:
                fails.append(f"{name}: truth {lay} {bv:.1%} -> {nv:.1%}")
            elif nv > bv + _EPS:
                notes.append(f"{name}: truth {lay} {bv:.1%} -> {nv:.1%}  (better)")
        for cls, bv in b["precision"].items():
            nv = n["precision"].get(cls)
            if nv is not None and nv < bv - _EPS:
                fails.append(f"{name}: precision {cls} {bv:.1%} -> {nv:.1%}")
        # PER SHEET as well as in aggregate. An aggregate-only comparison lets
        # one sheet get worse while another gets better and the total stay
        # flat - which is exactly how the xref-layer merge hid its damage on
        # 2026-08-27: chain counts, spikes, phantom and mean truth accuracy
        # were all identical, and C9.0 alone had lost 4.3pp of ink recall.
        for k in ("n_lost", "n_misfiled"):
            if n[k] > b[k]:
                fails.append(f"{name}: {k} {b[k]} -> {n[k]}  (worse)")
            elif n[k] < b[k]:
                notes.append(f"{name}: {k} {b[k]} -> {n[k]}  (better)")

    ba, na = base["aggregate"], now["aggregate"]
    for k in ("n_lost", "n_misfiled"):
        if na[k] > ba[k]:
            fails.append(f"aggregate {k} {ba[k]} -> {na[k]}  (worse)")
        elif na[k] < ba[k]:
            notes.append(f"aggregate {k} {ba[k]} -> {na[k]}  (better)")
    # The over-capture pair. These are the metrics recall could never be:
    # welding more blank paper into a chain, or picking up more ink that
    # another chain is already counting, makes them rise and can never make
    # them fall. So "must not increase" is an honest gate, and a change that
    # REMOVES a double-count improves them instead of looking like a
    # regression - which is exactly what raw recall got wrong.
    for k in ("welded_frac", "pickup_frac"):
        bv, nv = ba.get(k), na.get(k)
        if bv is None or nv is None:
            continue
        if nv > bv + _EPS:
            fails.append(f"aggregate {k} {bv:.2%} -> {nv:.2%}  "
                         f"(worse: more length that is not measured ink)")
        elif nv < bv - _EPS:
            notes.append(f"aggregate {k} {bv:.2%} -> {nv:.2%}  (better)")

    print("\n" + "=" * 72)
    for line in notes:
        print(f"  improved  {line}")
    # The soft numbers, always, so a change that moves them is VISIBLE even
    # though it cannot fail here.
    for k, bv in (base.get("soft") or {}).items():
        nv = (now.get("soft") or {}).get(k)
        if bv is None or nv is None:
            continue
        if abs(nv - bv) > _EPS:
            print(f"  (not gated) {k} {bv:.1%} -> {nv:.1%}")
    if fails:
        print(f"GATE FAILED - {len(fails)} regression(s):")
        for line in fails:
            print(f"    {line}")
        print("\n  If every line above is intended and explained in the commit"
              "\n  message, re-baseline with:  python -m takeoff_engine.regress"
              " --accept")
        return 1
    print("GATE PASSED - no hard metric regressed.")
    return 0


def _earthwork_check(require: bool = False) -> int:
    """The volume gate: tests/test_earthwork_regress.py, run as a subprocess
    so its output streams and its exit code is the verdict (0 pass, 1 fail).
    It replays the certified recipes through earthwork.cut_fill AND through
    server.earthwork_calc and compares exact floats to committed baselines,
    and checks earthwork_sig() against the signature each baseline recorded.
    It has its OWN --accept (per truth case); this file's --accept never
    touches a volume baseline. `require` (--require here, or
    EARTHWORK_REQUIRE=1 in the environment, which the subprocess inherits)
    makes a SKIPPED client case a FAIL - set it wherever the client inputs
    are supposed to be."""
    import shutil
    import subprocess
    import tempfile
    test = Path(__file__).parent.parent / "tests" / "test_earthwork_regress.py"
    # -B and a FRESH pycache prefix: the child never reads a .pyc from the
    # tree and never writes one, so a stale pyc beside earthwork.py (bytes
    # unchanged, bytecode rebuilt from a modified source with the original
    # mtime/size in its header - the N7 attack) cannot be what computes
    # the volumes. The test guards itself the same way for a direct run;
    # this is the launcher's half. stale_bytecode() then audits what the
    # SERVER would load, which this does not change.
    prefix = tempfile.mkdtemp(prefix="earthwork_gate_pyc_")
    env = dict(os.environ, PYTHONPYCACHEPREFIX=prefix)
    print("\nEARTHWORK GATE  python -B "
          f"{test.relative_to(Path(__file__).parent.parent)}"
          + (" --require" if require else "")
          + f"   (PYTHONPYCACHEPREFIX={prefix})")
    if not test.is_file():
        print(f"GATE: earthwork test missing at {test} - FAIL")
        return 1
    sys.stdout.flush()
    try:
        return subprocess.call([sys.executable, "-B", str(test)]
                               + (["--require"] if require else []), env=env)
    finally:
        shutil.rmtree(prefix, ignore_errors=True)


def _wmean(pairs):
    """Ink-weighted mean of (value, ink) pairs; None when there is no ink."""
    tot = sum(w for _, w in pairs)
    return (sum(v * w for v, w in pairs) / tot) if tot else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--serial", action="store_true")
    ap.add_argument("--full", action="store_true",
                    help="add the wide layer sweep (slower, more sheets)")
    ap.add_argument("--check", action="store_true",
                    help="compare against gate-baseline.json and exit 1 on "
                         "a regression")
    ap.add_argument("--accept", action="store_true",
                    help="rewrite gate-baseline.json from this run (the "
                         "earthwork baselines are NOT touched: see "
                         "tests/test_earthwork_regress.py --accept)")
    ap.add_argument("--json", metavar="PATH",
                    help="also write the machine-readable summary here")
    ap.add_argument("--require", action="store_true",
                    help="with --check: a SKIPPED earthwork truth case (client "
                         "inputs absent) is a FAIL - same as EARTHWORK_REQUIRE=1")
    args = ap.parse_args()
    t0 = time.time()
    if not args.check:
        sys.exit(_run_corpus(args, t0))

    # --check: TWO gates, each with its own verdict, and the exit code is
    # the OR. The earthwork gate runs FIRST and on its own: until
    # 2026-09-01 it ran after the ten-sheet chain gate, so a chain crash (a
    # missing corpus sheet, a ProcessPool traceback) ended the run before
    # the volume verdict existed - a bid-moving earthwork change hid behind
    # an unrelated path problem. Now a crash in either gate is reported as
    # that gate's FAIL and the other gate's verdict is still printed.
    #
    # Both fingerprints, side by side: the detection one (what a cached
    # result was made by) and the volume one (what a cubic yard was made
    # by). They move independently on purpose.
    from .detect_page import engine_sig
    print(f"engine_sig {engine_sig()}   earthwork_sig {earthwork_sig()}")
    print(f"   earthwork_sig hashes {len(earthwork_sig_files())} files: "
          f"{', '.join(earthwork_sig_files())}")
    print(f"   volume import closure (the ones that matter most): "
          f"{', '.join(earthwork_closure())}")
    verdicts = {}
    try:
        verdicts["earthwork"] = _earthwork_check(require=args.require)
    except BaseException as e:  # noqa: BLE001 - a crash is a FAIL, not an exit
        _report_crash("earthwork", e)
        verdicts["earthwork"] = 1
    try:
        verdicts["chain"] = _run_corpus(args, t0)
    except BaseException as e:  # noqa: BLE001
        _report_crash("chain", e)
        verdicts["chain"] = 1
    print("\n" + "=" * 72)
    for name in ("earthwork", "chain"):
        rc = verdicts[name]
        print(f"VERDICT {name:10s} {'PASS' if rc == 0 else 'FAIL'} (exit {rc})")
    rc = max(verdicts.values())
    print(f"VERDICT both       {'PASS' if rc == 0 else 'FAIL'} (exit {rc}) "
          f"- either gate failing fails the build; wall {time.time()-t0:.0f}s")
    sys.exit(rc)


def _report_crash(gate: str, e: BaseException) -> None:
    import traceback
    print(f"\n{gate.upper()} GATE CRASHED - counted as FAIL: "
          f"{type(e).__name__}: {e}")
    if not isinstance(e, SystemExit):
        traceback.print_exc()


def _run_corpus(args, t0) -> int:
    """The chain gate: run the corpus, print the report, and with --check
    return _check()'s verdict (0 pass, 1 regression). --accept rewrites
    gate-baseline.json from this run."""
    corpus = CORPUS + CORPUS_BEAUMONT + (CORPUS_FULL_EXTRA if args.full else [])
    # resolve every sheet BEFORE forking: a missing file must say so in one
    # clear line, not as a FileNotFoundError inside a ProcessPool traceback
    for p, _ in corpus:
        corpus_path(p)
    jobs = [(p, n, not args.no_cache) for p, n in corpus]
    if args.serial:
        results = [_run_sheet(j) for j in jobs]
    else:
        with ProcessPoolExecutor(max_workers=min(len(jobs), os.cpu_count() or 4)) as ex:
            results = list(ex.map(_run_sheet, jobs))
    accs = []
    for r in results:
        pr = " ".join(f"{k}={v:.1%}" for k, v in r["precision"].items())
        print(f"{r['sheet']:32} extract={r['extract_s']:5.1f}s build={r['build_s']:5.1f}s "
              f"chains={r['chains']:4} phantom={r['phantom']} spikes={r['spikes']:2}  {pr}")
        accs += list(r["truth"].values())
    if accs:
        print(f"\nmean truth class accuracy: {sum(accs)/len(accs):.1%} "
              f"| total phantom: {sum(r['phantom'] for r in results)} "
              f"| wall time: {time.time()-t0:.0f}s")

    # --- hand truth map: the two numbers class_metrics already had --------
    rec = [(v, r["truth_ink"].get(k, 0.0))
           for r in results for k, v in r["truth_recall"].items()]
    cov = [(v, r["truth_ink"].get(k, 0.0))
           for r in results for k, v in r["truth_cov"].items()]
    if accs:
        n_sheets = sum(1 for r in results if r["truth"])
        print(f"hand truth map (TRUTH_CLASSES): {len(accs)} layer instances on "
              f"{n_sheets} of {len(results)} sheets")
        # both means, because they answer different questions and differ by
        # several points: the plain mean matches how class-acc is headlined
        # above, the ink-weighted one is what an estimator actually loses.
        print(f"   plain mean       recall {sum(v for v, _ in rec)/len(rec):6.1%}"
              f"  coverage {sum(v for v, _ in cov)/len(cov):6.1%}")
        print(f"   ink-weighted     recall {_wmean(rec):6.1%}"
              f"  coverage {_wmean(cov):6.1%}")

    # --- derived truth map: role read off the CAD layer name -------------
    print("\nDERIVED LAYER TRUTH  (expectation from the layer NAME - "
          "eval_layers.layer_role)")
    print("  cov = own-layer coverage; any = covered by ANY chain on the "
          "sheet.")
    print("  cov < any means the ink WAS traced by a chain that kept a "
          "different layer.")
    print(f"{'sheet':32} {'linework':>31}   {'symbol':>8}   "
          f"{'annotation':>8}  lost misfiled")
    print(f"{'':32} {'n':>3} {'cov':>8} {'any':>8} {'rec':>8}   {'cov':>8}   "
          f"{'cov':>8}")
    agg = {k: [] for k in ("linework", "symbol", "annotation")}
    agg_any, agg_rec = [], []
    n_lost = n_misfiled = 0
    for r in results:
        cells = []
        for role in ("linework", "symbol", "annotation"):
            s = r["roles"][role]
            if s["coverage"] is not None:
                agg[role].append((s["coverage"], s["ink"]))
                if role == "linework":
                    agg_rec.append((s["recall"], s["ink"]))
                    agg_any.append((s["coverage_any"], s["ink"]))
            cells.append(s)
        lw, sy, an = cells
        n_lost += r["n_lost"]
        n_misfiled += r["n_misfiled"]

        def _p(v):
            return f"{v:8.1%}" if v is not None else f"{'-':>8}"
        print(f"{r['sheet']:32} {lw['n']:3} {_p(lw['coverage'])} "
              f"{_p(lw['coverage_any'])} {_p(lw['recall'])}"
              f"   {_p(sy['coverage'])}   {_p(an['coverage'])}"
              f"  {r['n_lost']:4} {r['n_misfiled']:8}")
    wl, ws, wa = (_wmean(agg[k]) for k in ("linework", "symbol", "annotation"))
    wlr, wla = _wmean(agg_rec), _wmean(agg_any)

    def _q(v):
        return f"{v:.1%}" if v is not None else "-"
    n_inst = sum(r["roles"]["linework"]["n"] for r in results)
    n_sh = sum(1 for r in results if r["roles"]["linework"]["n"])
    print(f"\nlinework  traced by SOMETHING {_q(wla)}   traced and correctly "
          f"attributed {_q(wl)}   raw ink recall {_q(wlr)}")
    print(f"          ink-weighted over {n_inst} layer instances on {n_sh} of "
          f"{len(results)} sheets. The gap between the first two is "
          f"attribution,\n          not detection - and the first is an upper "
          f"bound, since an unrelated chain within 3 pt also satisfies it.")
    print(f"symbol    coverage {_q(ws)}        "
          f"| annotation coverage {_q(wa)}  "
          f"(annotation SHOULD be low - that is the junk pruner working)")
    # what the recall denominator is made of. CAD plots some text as vector
    # outlines, and that ink can never become a chain, so a recall figure
    # read without this share is pessimistic in a way nothing reveals.
    lwi = sum(r["roles"]["linework"]["ink"] for r in results)
    lwg = sum(r["roles"]["linework"]["glyph_ink"] for r in results)
    if lwi:
        print(f"          of the linework denominator, {lwg/lwi:.1%} is vector "
              f"letter outlines (eval_layers.is_letterform) - mostly the "
              f"inline\n          marks of dash-text utility runs, which "
              f"coverage credits and raw recall does not")

    for kind, n in (("lost", n_lost), ("misfiled", n_misfiled)):
        if not n:
            continue
        what = ("traced by NOTHING - a real hole in the takeoff"
                if kind == "lost"
                else "traced, but the chain kept another layer")
        print(f"\n{kind.upper()} ({n} linework layers under 50% own-layer "
              f"coverage): {what}")
        allm = [(r["sheet"], m) for r in results for m in r[kind]]
        allm.sort(key=lambda sm: -sm[1]["unit_ink"])
        for sheet, m in allm[:12]:
            print(f"   {sheet[:26]:26} {m['layer'][:32]:32} "
                  f"ink={m['unit_ink']:8.0f} rec={m['recall']:6.1%} "
                  f"cov={(m['coverage'] or 0.0):6.1%} "
                  f"any={(m['coverage_any'] or 0.0):6.1%} "
                  f"chains={m['n_chains']}")


    # ---- the verdict ----------------------------------------------------
    from .detect_page import engine_sig
    summary = {
        "corpus": "full" if args.full else "fast",
        # the code these counts were made by (see _check)
        "engine_sig": engine_sig(),
        "sheets": {
            r["sheet"]: {
                "chains": r["chains"],
                "phantom": r["phantom"],
                "spikes": r["spikes"],
                "precision": r["precision"],
                "truth": r["truth"],
                "n_lost": r["n_lost"],
                "n_misfiled": r["n_misfiled"],
                "welded_frac": (r["gap_pt"] / r["length_pt"]) if r["length_pt"] else 0.0,
                "pickup_frac": (r["pickup_pt"] / r["length_pt"]) if r["length_pt"] else 0.0,
            } for r in results
        },
        "aggregate": {
            "mean_truth_class_acc": (sum(accs) / len(accs)) if accs else None,
            "phantom_total": sum(r["phantom"] for r in results),
            "spikes_total": sum(r["spikes"] for r in results),
            "n_lost": n_lost,
            "n_misfiled": n_misfiled,
            "welded_frac": (sum(r["gap_pt"] for r in results)
                            / sum(r["length_pt"] for r in results)),
            "pickup_frac": (sum(r["pickup_pt"] for r in results)
                            / sum(r["length_pt"] for r in results)),
        },
        # Reported, never gated. See _check() for why.
        "soft": {
            "linework_coverage_any": wla,
            "linework_coverage_own": wl,
            "linework_raw_recall": wlr,
            "symbol_coverage": ws,
            "annotation_coverage": wa,
        },
    }
    if args.json:
        Path(args.json).write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if args.accept:
        BASELINE.write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(f"\nbaseline rewritten: {BASELINE}")
    if args.check:
        return _check(summary)
    return 0


if __name__ == "__main__":
    main()
