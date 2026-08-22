# What to ask clients for, and why each part matters

Notes for the client email. **Not** the email itself — this is the spec behind it, so
whoever writes it knows which asks are load-bearing and which are nice-to-have.

The short version: **a drawing set on its own is worth a fraction of a drawing set paired
with the estimate that was actually produced from it.** The drawings tell us what our
software does. The estimate tells us whether it was right.

---

## The ask, in priority order

### 1. The drawing set AND the estimate that was built from it — as a matched pair

This is the whole point. One matched pair is worth more than ten unmatched drawing sets.

**Both must be the same revision.** Plans revise; estimates chase them. An estimate built
against Rev 2 compared to Rev 4 drawings produces differences that look exactly like
software errors and are not. Ask for the revision number or issue date on both, and treat
a pair that cannot be matched as a drawing set only.

### 2. The estimate as line items with quantities and units — not just a total

A lump-sum bid is not checkable. What makes it usable is one row per item with a
**quantity and a unit of measure**:

> `Perimeter Drain - 4" Rigid Pipe w/ gasketed fittings to daylight | 3,395 | LF | 31.00`

That row can be checked against the drawing. `Sitework — $412,000` cannot.

**Rates and totals are genuinely useful but optional** — they let us rank our own errors by
what they would actually cost on a bid, which is how we decide what to fix first. If a
client is uncomfortable sharing pricing, **quantities and units alone are still extremely
valuable.** Say so explicitly in the email; it will get more people to say yes.

### 3. The estimator's exclusions and notes

Estimate #853 carries lines like *"No maintenance included"*, *"Exclude moving existing
pile on site"*, *"Chip Seal done by others not included"*, *"one page shows SDR 35 which is
$28/LF"*.

Those notes are not clutter — **they are the difference between an explicable gap and a
mystery.** Without them we would spend days chasing a discrepancy that exists because a
human deliberately left something out. Ask for the estimate exactly as it was produced,
notes and all, rather than a cleaned-up version.

### 4. Native PDFs where they exist, scans where they don't

A native/vector PDF carries CAD layer names and exact geometry — the strongest signals our
software has. A scan carries neither.

**Ask for both anyway**, because they test different things and we need both to work:
native tests detection, scanned tests reading. Just have them say which is which. A
"print to PDF" from CAD is native; a photographed or copier-scanned sheet is not.

### 5. Breadth over volume — this is the one most likely to be got wrong

**Twenty documents from twenty different firms is worth more than two hundred sheets from
one.** The failure this exercise is designed to catch is our software having quietly
learned one drafter's habits. More sheets from a firm we already have teaches us almost
nothing; one set from a firm we have never seen teaches us a great deal.

So the email should ask for **variety** — different drafters, different trades, different
project types, older and newer — rather than "as much as possible."

### 6. Trades we currently have nothing for

Today we have depth in **civil / earthwork / grading** and in **windows, doors and
storefronts**. We have essentially nothing in concrete and foundations, framing, roofing,
mechanical / electrical / plumbing, finishes, or landscape planting as a priced trade.

Every unseen trade brings its own drafting conventions, its own linetypes and its own
units. If a client asks "what would help most?", the honest answer is **a trade we haven't
seen yet.**

---

## The discipline that has to survive contact with the data

**Split the pairs on arrival and do not tune on all of them.**

This is the single most important rule in this document and it is the easiest one to
break, because every pair looks like something to improve against.

If we use every pair for tuning, we have simply built a bigger training set with no test
set, and we are back exactly where we are today — unable to say anything honest about a
document we have not seen. **Hold a portion back, untouched, and do not look at it** until
we want to state a real generalization number.

Suggested split: tune on roughly two thirds, hold one third blind. The holdout should
cover trades and drafters that also appear in the tuning set *and* some that do not.

**A gap is not automatically our error.** Estimators round, add waste and laps, measure to
a different edge, aggregate across sheets, apply minimums, and price to a scope that is
not purely geometric. Every comparison has to carry that caveat, or we will "fix" the
software toward one estimator's rounding habit and make it worse for everyone else.

---

## What to tell clients about how it will be used

They are being asked for commercially sensitive material — their quantities, and possibly
their rates and margins. That deserves a straight answer in the email rather than a
footnote, and getting it right will get more yeses:

- what it will be used for (measuring our software's accuracy)
- whether anything is shared outside the company, and with whom
- how it is stored, and for how long
- whether they can have it deleted on request
- whether they want it anonymised — **quantities and units survive anonymisation fine**,
  so a client who will not share rates can still send a genuinely useful pair

This is a real decision for the business, not a technical one. It should be settled before
the email goes out rather than answered ad hoc afterwards.

---

## What this changes, honestly

**What it closes fast:** the ability to say a defensible sentence with a denominator —
*"across N real jobs in M trades, our quantities matched the estimator's within X% on Y of
Z measurable line items"*. That is a far stronger claim than any percentage we generate
about ourselves, because the numbers came from their side. It also gives ground truth to
populations that currently have none, and lets the confidence indicator be **calibrated**
against outcomes rather than being a rule someone wrote.

**What it does not close:** none of the infrastructure — accounts, hosting, multi-user,
durability, billing. Those are unaffected by having better data.

**How fast:** not this weekend. Collection takes days, and parsing arbitrary estimate
formats — Excel, QuickBooks exports, proprietary takeoff software, handwritten — is real
work on its own. The value compounds over weeks. It is the highest-leverage thing on the
list precisely because it keeps paying after it arrives.

**One caution worth naming:** the first few pairs may well show worse agreement than
Estimate #853 does, because #853 is a set we have already worked hard on. That is not a
regression, it is the first honest measurement. Expect it, and do not let it be read as
the software getting worse.
