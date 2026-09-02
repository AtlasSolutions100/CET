"""An import hook outside the tree is a FAIL under --require, not a line.

WHY (measured 2026-09-02, adversarial round two on the earthwork gate): a
sitecustomize.py on PYTHONPATH installing a sys.meta_path finder that wrapped
takeoff_engine.earthwork.cut_fill took 15% off fill through the product route
while the gate exited 0 with "25 cases passed, 0 failed". The hook WAS named
on the "import hooks outside the tree (not hashed)" line - and a line nobody
has to read is not a gate. Every file in the tree is hashed; a hook outside
it can replace any of them at import time, so while one exists the signature
pins nothing.

--require is the mode this machine and the production box run, and on
neither does a legitimate hook exist - PYTHONPATH included, since that is the
directory the exploit's sitecustomize was found on. A plain run still only
prints, so a developer with PYTHONPATH set is not blocked.

    python tests/test_gate_import_hooks.py
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GATE = REPO / "tests" / "test_earthwork_regress.py"
# One entry, so this test does not depend on the gitignored Stice inputs.
ONLY = ["--only", "oncor_c04"]

fails = 0


def check(ok, msg):
    global fails
    if ok:
        print("ok: " + msg)
    else:
        fails += 1
        print("FAIL: " + msg)


def run(extra, hook_dir=None):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env.pop("EARTHWORK_REQUIRE", None)
    if hook_dir is None:
        env.pop("PYTHONPATH", None)
    else:
        env["PYTHONPATH"] = str(hook_dir)
    r = subprocess.run([sys.executable, str(GATE)] + ONLY + extra,
                       capture_output=True, text=True, env=env, cwd=str(REPO))
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def main():
    d = Path(tempfile.mkdtemp(prefix="gate_hook_test_"))
    # An inert hook: this test is about whether the gate NOTICES one, and an
    # inert file proves that without patching anything.
    (d / "sitecustomize.py").write_text("pass\n", encoding="utf-8")

    code, out = run(["--require"])
    check(code == 0, f"clean tree under --require passes (exit {code})")
    check("import hooks outside the tree (not hashed): none" in out,
          "and says so on the hooks line")

    code, out = run([], hook_dir=d)
    check(code == 0, f"a hook on a PLAIN run only prints (exit {code}) - a "
                     f"developer with PYTHONPATH set is not blocked")
    check("sitecustomize" in out, "and the hook is named there")

    code, out = run(["--require"], hook_dir=d)
    check(code != 0, f"THE RULE: the same hook under --require FAILS "
                     f"(exit {code}); before 2026-09-02 this exited 0")
    check("import hook outside the tree" in out,
          "with a failure line that names the hook")
    check("pins nothing" in out,
          "and says why it matters - the signature covers nothing while it "
          "exists")
    # the numbers still ran: this is a gate failure, not a crash
    check("cases passed" in out,
          "and the cases still ran and reported (a verdict, not a traceback)")

    env_only = dict(os.environ)
    env_only["PYTHONPATH"] = str(d)
    env_only["EARTHWORK_REQUIRE"] = "1"
    env_only["PYTHONIOENCODING"] = "utf-8"
    r = subprocess.run([sys.executable, str(GATE)] + ONLY, capture_output=True,
                       text=True, env=env_only, cwd=str(REPO))
    check(r.returncode != 0,
          "EARTHWORK_REQUIRE=1 in the environment behaves like --require "
          f"(exit {r.returncode}) - the production box sets that, not a flag")

    print()
    if fails:
        print(f"{fails} FAILED")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
