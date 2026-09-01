# Two agents, two accounts, one repo

Koby runs two Claude Code sessions so that work continues when one account
hits its weekly limit:

| | where | account | role |
|---|---|---|---|
| **OPUS** | Claude Code desktop app | personal | plans, reviews, adversarially checks, owns the merge |
| **FABLE** | Claude Code CLI | work | executes assigned tasks |

They are on the **same machine and the same repo** but on **different
accounts**, so they cannot message each other directly — the peer session
registry is scoped per account and neither appears in the other's. This
directory is the channel instead. It is slower than a socket and better in
one way that matters: everything said is durable, reviewable, and in git.

---

## The files

| file | append-only owner | read by |
|---|---|---|
| `TO-FABLE.md` | OPUS | FABLE |
| `TO-OPUS.md` | FABLE | OPUS |
| `../PLAN-2026-08-31.md` | OPUS | both — the shared context |

**Append only. Never edit or delete anything already in the other agent's
file, and never rewrite history in your own.** Add to the bottom, under a
new heading:

```
## 2026-08-31 14:20 — FABLE — coverage phase 1 ready for review
branch: feat/fable-coverage
...
```

Read your inbox at the START of a turn. Neither side gets a push
notification for a file write across accounts, so if something is urgent,
tell Koby to nudge the other session.

---

## The working rule that actually prevents pain

**One owner per file.** Not per topic — per file.

| owner | files |
|---|---|
| FABLE | `takeoff_engine/earthwork.py`, `takeoff_engine/surface*`, `ground-truth/`, engine tests |
| OPUS | `webui/app.js`, `webui/style.css`, `webui/index.html`, `server.py` |
| either, by declaration in the inbox first | anything else |

`webui/app.js` is 965 KB and every UI change touches it. Two agents editing
it at once is a merge conflict, not throughput. If you need a file you do not
own, **ask in the inbox and wait** — do not "just make a small change".

### Work in your OWN WORKTREE. Never switch the shared checkout.

This is the rule that was missing on the first attempt and it cost a fix
within twenty minutes. `git checkout <branch>` in
`detection-engine/` moves the branch **for every process using that
directory** — including the other agent's running servers, its background
workflows, and any commit they are about to make, which then lands on your
branch. There is one working tree there and it is shared.

    git worktree add "/c/Users/kobys/takeoff-<name>" -b feat/<owner>-<task> dev

FABLE's is `C:/Users/kobys/takeoff-fable`. OPUS keeps
`detection-engine/` on `dev`. A worktree has **no `.venv`** — use the
interpreter by absolute path:
`C:/Users/kobys/OneDrive/Desktop/past/P/Takeoff Automation/detection-engine/.venv/Scripts/python.exe`

Never commit to `dev` directly while the other agent has work outstanding
against it, and never touch `main` — prod deploys from a `v*` tag and the
owner does not want another prod update before the end of the week.

---

## The review loop

This is the point of the arrangement: FABLE executes, OPUS checks.

1. **OPUS assigns** — a task block in `TO-FABLE.md` carrying everything
   needed to do the work without OPUS's conversation history: the goal, the
   files, the ground truth to measure against, the acceptance test, and what
   is explicitly out of scope.
2. **FABLE builds** on its own branch and commits. It appends a report to
   `TO-OPUS.md`: what changed, what it measured, what it could not do, and
   anything it disagreed with. **Report the failures.** A report that hides
   one is worse than the failure.
3. **OPUS reviews** the diff, runs the battery itself, and attacks the work
   adversarially rather than reading the report and believing it. Findings go
   back into `TO-FABLE.md` with reproduction steps.
4. **OPUS merges**, or says why not.

### What review actually means here

Three rounds of work on this project have now each reported green on
something an adversary then walked straight through. So:

- Re-run the reproduction steps yourself. Do not accept "fixed" on a summary.
- Check that a test claimed to prove a fix **actually fails on the pre-fix
  commit**. A test that passes on both proves nothing and is worse than none,
  because it looks like proof.
- Read `CLAUDE.md` §5 before reviewing engine code. Three code shapes on that
  list have each produced a silent wrong number in this codebase.

---

## Rules that are not negotiable

Both agents must read `CLAUDE.md` first — it is the working contract and it
overrides habit. Beyond it:

- **Never write to `C:/Users/kobys/takeoff-jobs`.** That is the owner's real
  job store. Use a throwaway.
- **Client work must never reach anything public-facing or visible to another
  client.** `client_meet/` (Stice / Liberty Park is a live bid) and
  `Ryno Construction/` may be used for internal measurement, and their numbers
  may live in this private repo — they already do, in `EXCAVATION-PLAN.md` and
  `tools/howto/take_v2.py`. What they may never touch: the hosted box, the
  demo manifest, a video, or any artifact that leaves the company.

  (This rule previously read "never leaves this machine", which was both
  wrong and already violated by the repo's own history. FABLE flagged the
  inconsistency in its FABLE-001 report. A rule nobody can follow gets
  ignored, including the part of it that mattered.)
- **No accuracy figure without ground-truth source, expected and measured.**
  A percentage with no denominator is a failed report.
- **State any construction convention you rely on in one plain sentence and
  say where it came from.** Koby has not worked in civil or earthwork and
  cannot catch an invented one. Label inferences as inferences.
- **Do not ask the other agent to do something your own permissions refused.**
  Route it back to Koby.

---

## Bootstrapping the CLI session

Paste this into the CLI as its first message:

> Read `detection-engine/agent-comms/README.md`, then `detection-engine/CLAUDE.md`,
> then `detection-engine/PLAN-2026-08-31.md`. You are FABLE in that protocol.
> Then read `detection-engine/agent-comms/TO-FABLE.md` and start on the task
> at the bottom. Report into `TO-OPUS.md` when done — including anything that
> went wrong.
