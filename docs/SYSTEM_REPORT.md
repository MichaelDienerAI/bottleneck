# Bottleneck — System Report

**Dated:** 2026-08-14
**Version:** 0.2.0
**Confidence:** High on everything measured. Every number below was read out of the repository or produced by running the code on this date, not recalled. Anything I could not verify sits in `GAPS` at the bottom.

**Sources:** `npm test` (live run), `data/scan-meta.json`, `data/killed.json`, `data/queue.json`, `data/token-verification.json`, `data/logs/2026-08-14.log`, `data/diagnoses/*.yaml`, `git status`, `launchctl list`, and a full read of `src/`, `server.js`, `.claude/`, `profile/`, `docs/`, and `bin/`.

This report consolidates. It does not replace `docs/ARCHITECTURE.md` (why), `docs/TECHNICAL_DESIGN.md` (how it is built), `docs/USER_GUIDE.md` (plain language), `docs/OPERATING_MANUAL.md` (Monday operations), or `docs/RUNBOOK.md` (setup prompts). What is new here is Part 4, the diagnostic, which is a dated reading of the system as it actually stands today.

---

> ## Status as of 2026-08-16 — read this before trusting Part 4
>
> This report is a dated snapshot and it is kept as one rather than rewritten, because a diagnostic that gets edited to stay flattering is not a diagnostic. Four of its findings have since changed. Everything else below still holds.
>
> | Finding in Part 4 | Now |
> |---|---|
> | 139 assertions, 4 suites | **381 assertions, 11 suites** — 97 gates, 43 casefile, 19 queue, 32 bluf, 19 ledger, 31 artifact, 32 blank, 31 blind, 59 schema, 8 automation, 10 liveness |
> | **D1** case files never written | **Fixed.** `src/casefile.js --record` is wired into `/diagnose`, `/ship`, and the server's post-run hook. `data/cases/` holds six files. |
> | **D2** `casefile.js` has no tests | **Fixed.** `src/casefile.test.js`, 43 assertions, temp directories only. |
> | **D4** raw `Date` in the relocation flag | **Fixed.** Formats as `YYYY-MM-DD`. Existing `data/queue.json` rows carry the old string until the next scan rewrites them. |
> | **D3** `deformation_test_bank` has no public URL | **Still open.** `profile/proof-ledger.yaml:41` still reads `TODO_PUBLIC_URL`. |
> | **D5** board count hardcoded | **Still open.** `src/report.js:136` still says "the 27 company job boards". |
>
> Added since, neither of them in Part 4: repost detection (`data/reposts.json`, informational flag, index seeded 2026-08-16 and cannot fire for 60 days) and dashboard queue strikes (`data/struck.json`, backfill from the bench).
>
> **The headline finding of section 4.7 is unchanged and is still the thing that matters.** `packets/` is empty, zero packets have been built and zero sent. Every fix above is internal plumbing. None of it is evidence that the system works, and the drum of five per week remains a planning figure rather than a measured constraint.
>
> One correction to that finding as originally written, dated 2026-08-17. It said `data/ledger.json` does not exist, and that was true, and it was worse than it read: `loadLedger` returned `[]` for a missing file, so `openSlots` subtracted nothing from the cap and `npm run slots` printed **5**. The rope reported full capacity because the record of what had been spent was gone. `src/ledger.js` now fails closed — missing or corrupt returns 0 — and the file has been initialized to `[]`, which is the true claim that nothing has been sent. The count of 5 open slots is now a statement about an empty ledger rather than about a missing one.

---

# PART 1 — WHAT IT IS

Bottleneck is a constraint-first job search. It runs as a small Node codebase plus five Claude Code subagents, operated from a terminal or a local web page.

It does not find more jobs. It finds the small number of companies where a proof Michael already owns acts directly on a problem that company already has, and it produces a technical brief addressed to a named human there.

The system drafts. Michael sends. That line is enforced in three separate places — the packet agent has only `Read` and `Write`, every generated artifact opens with `DRAFT ONLY — REQUIRES HUMAN REVIEW AND MANUAL SEND`, and the local server refuses to interpolate anything into a mail client.

---

# PART 2 — WHY IT WAS BUILT

The argument is a single causal chain, and every design decision traces back to it:

```
Thousands of AI roles post every week.
→ Job discovery is cheap and effectively unlimited.
→ Adding discovery capacity produces more candidates, not more replies.
→ What converts is a company-specific technical brief sent to a named human.
→ Michael can build about five of those a week.
→ Therefore five packets per week is the constraint.
```

Everything upstream of that number is a non-bottleneck. Running a non-bottleneck harder does not raise output; in *The Goal* it produces inventory, and in a job search inventory is a pile of half-researched companies and unsent drafts. So discovery is deliberately throttled, and the scan refuses to run at all when the week is full.

The five focusing steps, mapped:

| Goldratt | This system |
|---|---|
| 1. Identify | Weekly proof-packet capacity, five per week |
| 2. Exploit | Diagnosis never spends a slot on a job that failed a deterministic gate |
| 3. Subordinate | Scanner rate-limits to open slots; scoring runs in code, not in the model |
| 4. Elevate | Scheduled evidence-gathering pre-collects observables so the five hours go to judgment |
| 5. Repeat | Weekly review re-derives the constraint from ledger data, not from memory |

Five postulates bind the analysis and the agents equally (`CLAUDE.md`):

- **P1** Name one constraint at a time.
- **P2** Use only evidence a stranger could inspect without asking.
- **P3** Never treat a limit you have not reached as a constraint.
- **P4** Never assert causation unless a dated record shows both halves.
- **P5** When a record is missing, name the missing record. That counts as a finding.

---

# PART 3 — HOW IT WORKS

## 3.1 The pipeline

```
SOURCES  ──►  GATE 0      ──►  DIAGNOSIS   ──►  AUDIT     ──►  PACKET   ──►  LEDGER
(ATS APIs)    deterministic    the DRUM         evidence      artifact     tracking
              disqualifiers    5 slots/week     test P2       + outreach   + fitness
              (code)           (agent)          (agent)       (agent)      (code)
```

The rope runs backward. `openSlots()` reports how many packet slots remain this week; `scan.js` reads that number *before* it fetches anything and promotes at most `slots + 5` rows into a buffer capped at ten. Work never piles up in front of the drum, because a stale diagnosis is worse than none.

## 3.2 The code / agent split

The split is deliberate. A model that scores keyword overlap is an expensive regex with worse recall.

**Code does** — fetch public ATS boards, dedupe, apply hard disqualifiers, extract compensation, kill postings older than ninety days, delist buffer rows that came off their board, compute fit, enforce drum capacity, validate agent payloads against schemas, write the ledger and the HTML pages.

**Agents do** — infer the employer's binding constraint, test it against inspectable evidence, map it to a sovereign proof, attack the result, write the packet.

## 3.3 Gate 0 — the deterministic filter

`src/gates.js`. Six rules, all settled by string matching, applied to every fetched row on every run:

1. **Seniority** — reject list matched against the title only.
2. **Title relevance** — must hit one of `target_titles`, matched against **the title only**. This is load-bearing. `target_titles` includes bare tokens like `voice` and `abuse`; widened to the description they would admit hundreds of irrelevant rows.
3. **Hard disqualifiers** — matched against title + description. AI-tooling bans, PhD requirements, training-loop capability gaps, clearances, unpaid/equity-only, contract staffing.
4. **Location** — remote passes, base city passes, an accepted hub passes when relocation is on. A country-level string passes carrying a blocking `country_only` flag, because "United States" is a rejection on vagueness rather than geography.
5. **Compensation floor** — $130,000. A missing band passes carrying a `comp:unknown` flag; absence of a band is absence of data, never evidence of a low offer.
6. **Freshness** — 90 days. A missing date passes carrying a blocking `posted:unknown` flag.

Gate 0 kills rows. It never ranks them.

## 3.4 Ranking, and why it looks the way it does

Three functions, applied in order, each fixing a measured defect:

- **`fitScore()`** — the *highest single* `title_weights` match (0–3), plus 1 if a published band clears the floor, minus 1 per unresolved blocking flag. Highest single, never the sum, because summing rewards long titles and long titles are a marketing artifact. `title_weights` is a separate object from `target_titles`: one filters, one scores. Merging them once let "Senior PMM, Voice Agent" outscore "Senior SWE, Model Evaluation" and take a Deepgram slot.
- **`compositeScore()`** — `archetype_weight × 10 + fit`. The ×10 is calibrated: the weight ladder spans 0.05–0.30, so at ×10 it spans 2.5 points against an observed fit spread of about 5. Weight carries roughly half the authority of fit — enough to keep a heavier archetype ahead at equal fit, not enough to hold a zero above a four. At ×20 the tier recaptures the sort; at ×5 weight becomes decorative.
- **`capPerCompany()` (max 2) and `archetypeFloor()` (min 1 each)** — a single large board publishing hundreds of near-duplicate reqs would otherwise take every slot.

## 3.5 Liveness — two signals, not the same strength

`src/liveness.js`.

1. **Feed membership** is authoritative and free. The ATS endpoints publish currently-open reqs and nothing else, so a key on the board last scan and absent this scan has been taken down. A company whose fetch *failed* is excluded: an empty result from a 500 is not evidence that a company closed its reqs.
2. **HTTP status on buffer rows** is weak and treated as weak. Only 404/410 delists. A 200 proves the link resolves, not that the req is open — Greenhouse serves closed jobs as a 200 redirect and Ashby serves an empty client-rendered shell.

## 3.6 The five agents

| Agent | Model | Tools | Role |
|---|---|---|---|
| **scout** | haiku | Bash, Read, Write, WebFetch | Non-bottleneck. Runs the scan, reports the funnel. Never evaluates fit. |
| **diagnostician** | opus | Read, Write, WebFetch, WebSearch | **The drum.** One company per slot. |
| **auditor** | opus | Read, Write, WebFetch | Adversarial. Scored on claims killed, not packets approved. |
| **packet** | opus | Read, Write **only** | Builds the shipping artifact. Cannot send, by tool set. |
| **brief** | sonnet | Read, Write, WebSearch, WebFetch | Headless evidence gatherer. Runs unattended at 07:05. |

**The diagnostician** writes the constraint hypothesis *before* issuing a single query, using the Weakest Link formula verbatim: *"[COMPANY] produces no more [OUTPUT] than its slowest [PART] allows."* It must then issue at least one query designed to *kill* its own hypothesis and log `query_issued`, `result`, and `survived` — all three, always. It is scored on disconfirming evidence sought, not found. Roughly one in four diagnoses should reach SHIP; a SHIP rate above half means it stopped testing and started rationalizing.

**The auditor** walks all 28 questions of `.claude/references/filing-standard.md`, writes `coverage_score` as a fraction, and must clear five independent vetoes. Any single false veto fails the packet regardless of coverage — an aggregate that can outvote a checkpoint is an assembly line with extra steps. It must also cite at least one backstage evidence item the diagnostician did not cite; an audit assembled only from the diagnostician's own citations is a proofread, not a second look.

A REJECT **releases the slot back to the pool**. That is a good outcome. A slot spent discovering a packet was unfounded is cheaper than a packet that reaches a decision-maker and does not survive scrutiny.

**The brief agent** is the most constrained thing in the repo, because it runs at 7am with nobody reading. It may not name a constraint, form a hypothesis, write a packet, touch the ledger, or create a case file. It writes to exactly one path, `data/briefs/<date>.md`. A model asked to produce a constraint claim at 7am will produce one every time, it will read exactly like a good one, and nothing in the output will signal that it was invented.

## 3.7 Schema enforcement

`src/utils/schemaValidator.js` implements the subset of JSON Schema the two schema files use, plus four rules JSON Schema cannot express:

- **R-BACKSTAGE** — an evidence set that is entirely frontstage is the company's own account of itself. At least one backstage trace is required, or a frontstage row explicitly labeled `specificity_leak`.
- **R-ACQUITTAL** — `INSUFFICIENT_EVIDENCE` requires `missing_record`. P5 in code.
- **R-COVERAGE-CONSISTENT** — `coverage_score` is recomputed from the unanswered list and must match.
- **R-VETO / R-THRESHOLD** — all five vetoes true and coverage ≥ 0.50 before a PASS validates.

Failures throw at the first violation and name the path. A validator that accumulates a list invites the caller to decide which problems matter, and the decision was already made when the schema was written.

## 3.8 The scheduled run

`bin/run.sh`, fired by launchd Monday/Wednesday/Friday at 07:05.

- **Half one is deterministic.** Read slots; if zero, exit before fetching anything. Otherwise scan, rebuild the board page, rebuild the walkthrough page. No model, nothing to fabricate.
- **Half two is the brief agent**, invoked headlessly via `claude -p ... --agent brief --allowedTools "Read,Write,WebSearch,WebFetch" --max-turns 24`.

The slot guard fails closed: a ledger that returns a non-integer is treated as zero, because an unreadable ledger is not evidence of a free slot.

---

# PART 4 — FULL DIAGNOSTIC

All readings taken 2026-08-14.

## 4.1 Test suite — PASS

```
npm test  →  139 assertions passing across 4 suites
  src/gates.test.js       81
  test/schema.test.js     41
  test/automation.test.js  7
  test/liveness.test.js   10
```

Matches the count claimed in `README.md` and `docs/RUNBOOK.md`. No drift.

## 4.2 Sources — 27 of 28 boards resolve

`data/token-verification.json`: 28 targets, 27 OK, 1 FAIL — `ashby/simli` returns 404. That failure is **documented and deliberate**: Simli is in the `excluded` block of `profile/companies.yaml` with the reason recorded (no public ATS board, careers link points to LinkedIn, and this repo does not scrape LinkedIn). It remains a listed dependency of the Persona iO sovereign proof, so it is excluded because it is unreadable, not because it is uninteresting.

`data/scan-errors.json` is empty. No board failed on the last run.

## 4.3 Last scan — 2026-08-14

```
fetched          3,479
new                  7
passed gate 0      254   (7.3%)
killed           3,225
  of which stale   814
delisted             0
unconfirmed          0
queue               10 / 10
open slots           5 / 5
```

Kill distribution, from `data/killed.json`. "Alone" means that rule was the only thing standing between the row and the queue — those are the rules actually doing the work:

| Reason family | Total | Alone |
|---|---:|---:|
| title | 3,008 | 1,970 |
| stale | 814 | 172 |
| location | 445 | 27 |
| seniority | 32 | 1 |
| comp | 25 | 0 |
| clearance | 15 | 1 |
| contract_staffing | 7 | 0 |
| wrong_shape | 5 | 0 |
| capability_gap | 5 | 0 |

The title gate is carrying the system. It kills 93% of the board and 61% of everything it touches it kills alone. Freshness is the second real filter at 814 rows. Everything below `location` is functionally decorative on current supply — `comp`, `contract_staffing`, `wrong_shape`, and `capability_gap` have never killed a row on their own.

## 4.4 The buffer — 10 rows, spread across 5 archetypes

| # | Company | Role | Score | Fit | Blocking |
|---|---|---|---:|---:|---|
| 1 | Deepgram | Senior SWE, Model Evaluation & AI Systems | 7.0 | 4 | — |
| 2 | Deepgram | Senior PMM, Voice Agent | 6.0 | 3 | — |
| 3 | Character.AI | TPM, Model Alignment and Deployment | 6.0 | 3 | relocation |
| 4 | Synthesia | Solutions Architect | 6.0 | 3 | — |
| 5 | Character.AI | Research Engineer, AI Safety & Alignment | 6.0 | 3 | relocation |
| 6 | Gray Swan AI | Red Team Engineer | 5.5 | 4 | — |
| 7 | LangChain | Frontend Engineer, AI Observability & Evals | 5.5 | 3 | relocation |
| 8 | Decagon | Strategic Solutions Engineer, East | 5.5 | 3 | — |
| 9 | Vercel | Senior Manager, Solutions Architect | 4.0 | 3 | — |
| 10 | OpenAI | Researcher, Alignment CoT Monitorability | 3.5 | 3 | relocation |

Spread: conversational_ai 5, agentic_startups 2, red_team_boutiques 1, infrastructure 1, frontier_labs 1. The per-company cap and archetype floor are both visibly working — Deepgram holds exactly 2, and four archetypes each got their floor row.

**Four of ten rows carry a blocking `relocation_cost` flag** and cannot reach SHIP until the location cost is priced in the diagnosis. That is by design (`stay_until: 2027-01-01`), but it is 40% of the buffer, and it is worth knowing that the relocation preference is currently the single largest source of SHIP vetoes in front of the drum.

## 4.5 Diagnoses — 5 on disk, 0 cleared both gates

| Company | Diagnosis | Audit | Coverage |
|---|---|---|---:|
| Character.AI | PARK | PASS | 0.71 |
| Decagon | PARK | PASS | 0.54 |
| Deepgram | PARK | REJECT | 0.64 |
| Gray Swan AI | **SHIP** | **REJECT** | 0.46 |
| Synthesia | PARK | REJECT | 0.57 |

All five carry `acquittal: EVIDENCE_SUFFICIENT`. Four PARK, one SHIP.

**The one SHIP was correctly blocked.** Gray Swan's diagnosis reached SHIP, and the auditor rejected it at coverage 0.46, below the 0.50 filing-standard threshold. `packets/` is empty as a direct consequence, and that is the gate working rather than the pipeline stalling.

The SHIP rate is 1 of 5, which sits exactly on the "roughly one in four" target in `diagnostician.md`. On n=5 that is not yet a measurement.

**The Deepgram file is a live re-diagnosis, uncommitted in the working tree.** The committed version was SHIP with an audit REJECT and 9 of 20 claims struck. The working version rebuilds the hypothesis on the corrected predicate — the old one said customers were the first automated check; a Deepgram employee filed those reports — and lands on PARK on weaker evidence. The file names the prior verdict, names what changed, and gives the `git show` command to recover the old version. This is the correction loop doing exactly what it was built to do, and it is worth committing.

## 4.6 The scheduler — installed and running

`com.bottleneck.run` is loaded in launchd, last exit status 0, plist installed in `~/Library/LaunchAgents/`. `data/logs/launchd.err` is empty.

The 2026-08-14 run completed both halves in seven minutes: scan → board → walkthrough → brief. The brief agent wrote 140 lines, reported a real tooling limit rather than papering over it (WebFetch truncated the Ashby posting API to 6 of ~79 Deepgram reqs, and it marked the affected numbers `NOT FOUND` instead of restating Tuesday's figures as if re-verified), ended every section with a question rather than a conclusion, and touched no case file, ledger, diagnosis, or packet. The bounds held unattended.

`data/briefs/2026-08-14.md` is untracked. Worth committing.

## 4.7 The measurement layer is unexercised — this is the headline finding

```
data/ledger.json    does not exist
packets/            empty
data/cases/         does not exist
```

Zero packets have ever been built. Zero letters have ever been sent. Zero ledger rows exist.

Three consequences follow, and they should be stated plainly rather than smoothed over:

**First, no claim about this system working is currently supported.** The RAND experiment in `ledger.js` needs n≥20 before it says anything and prints "too few packets" below n=5. Narrative fitness needs 20 outreaches on a single narrative before a strategy change is anything but tampering. Defect classes need rejections to classify. All three are at n=0. The board page states this itself: *"Nothing has been sent, so none of the numbers above have been tested against a real reply yet."*

**Second, the drum number itself is untested, and P3 applies to this system as hard as it applies to any company it diagnoses.** Five packets per week is an *assumed* capacity. Zero packets have been built, so the limit has never been reached, and P3 says never treat a limit you have not reached as a constraint. The five is a reasonable planning figure and a defensible design input. It is not yet a measured constraint, and the first real week of packet-building is the experiment that would settle it.

**Third, the whole system is currently one blocked packet away from producing its first datum.** Gray Swan is the nearest: diagnosis SHIP, audit REJECT on coverage alone at 0.46, four points short of threshold. That is a coverage problem in the artifact, not a verdict problem in the evidence.

## 4.8 Defects found

**D1 — The case-file memory subsystem is never written to.** `src/casefile.js` exports `create()`, `recordVisit()`, `park()`, and `save()`. Nothing calls any of them. `scan.js` calls only `shouldSkip()`; `report.js` only counts files in the directory. No agent definition, no slash command, and no script instructs anyone to write a case file. After five diagnoses, `data/cases/` does not exist.

The module's own header states the problem it was built to fix: *"a company rejected in March could be re-promoted in May, re-diagnosed with the same wrong hypothesis, and re-rejected. That re-diagnosis costs a drum slot, and the drum is the constraint."* That defect is still live. The fix is written and wired on the read side only. This is the highest-value repair in the repo, because it steals directly from the bottleneck.

**D2 — `src/casefile.js` has no tests.** The other four modules with logic all have suites. `docs/RUNBOOK.md` already names this as outstanding work and specifies the shape of the fix.

**D3 — A sovereign proof has no public URL.** `profile/proof-ledger.yaml` lists `deformation_test_bank` with `inspect_at: TODO_PUBLIC_URL`. A sovereign proof is defined as one a stranger can inspect without asking. This one cannot be inspected at all. It is the named proof for the `red_team_boutiques` archetype — which is Gray Swan, the single SHIP verdict in the repo, rejected at 0.46 coverage. Filing-standard questions 2 and 3 ask whether the strongest artifact is named-and-linked and whether a stranger can inspect it without contacting you. A `TODO` cannot answer either.

**D4 — A raw `Date` object is interpolated into the relocation flag string.** In `locationFlags()` (`src/gates.js`), `until` is a `Date` and `${until}` stringifies to `Thu Dec 31 2026 17:00:00 GMT-0700 (Mountain Standard Time)`. It appears verbatim in four `data/queue.json` rows. Cosmetic, not behavioral — the flag still blocks correctly — but it is the same class of Date-versus-string defect the file's own comments document twice.

**D5 — The board count is hardcoded.** `src/report.js` writes "the 27 company job boards" as a literal string. There are 28 targets, 27 of which resolve. The number is right today by coincidence and will drift the moment a company is added.

---

# PART 5 — USER GUIDE

## 5.1 First-time setup

```bash
node --version                                     # needs 18+
npm install
cp profile/gates.example.yaml profile/gates.yaml   # then edit
node src/verify.js                                 # confirm board tokens resolve
npm test                                           # expect 139 passing
node src/scan.js                                   # first fetch
```

`profile/gates.yaml` is gitignored and personal. Every token in `companies.yaml` is a guess until `verify.js` says otherwise — a wrong slug returns zero jobs and looks identical to a company that is not hiring, which is how a search spends three weeks concluding the market is dead.

## 5.2 Commands

**Shell:**

| Command | Does |
|---|---|
| `npm test` | 139 assertions, 4 suites, no network |
| `npm run verify` | Which board tokens resolve. Run after any edit to `companies.yaml` |
| `npm run scan` | Fetch, gate, rank, delist, promote |
| `npm run slots` | Open packet slots this week |
| `npm run report` | Ledger report: fitness run chart, narrative sample sizes, RAND split |
| `npm run board` | Write `data/board.html` — where the search stands, in plain language |
| `npm run walk` | Write `data/walkthrough.html` — the pipeline explained on your real numbers |
| `npm run brief -- <company>` | Render a diagnosis or packet to HTML. Add `--pdf` for paper |
| `npm start` | Local dashboard on `http://localhost:3000` |
| `node src/ledger.js --add <row.json>` | Record a sent packet |

**Claude Code slash commands:**

| Command | Does |
|---|---|
| `/scan` | Runs the scout. Reports the funnel and what got delisted |
| `/diagnose <company>` | Spends one drum slot. Runs diagnostician, then auditor |
| `/ship <company>` | Builds the packet. Runs the auditor a second time |
| `/review` | Weekly review. Re-derives the constraint from ledger data |

## 5.3 The weekly workflow

**Monday, Wednesday, Friday 07:05 — unattended.** Boards fetched, pages rebuilt, evidence brief written. Skipped entirely if the week is full.

**Your five hours, once a week:**

1. `open data/board.html`. Read the drum count and the queue.
2. `open data/briefs/<today>.md`. The observables are already gathered — this is what half two bought you.
3. `/diagnose <top company>`. One slot. The diagnostician writes the hypothesis before querying, then tries to kill it. The auditor attacks the result.
4. If the audit PASSes and the diagnosis is SHIP: `/ship <company>`. If the audit REJECTs, the slot goes back to the pool and you diagnose someone else — that is a good outcome, not a lost week.
5. Find the decision-maker's name by hand. LinkedIn is fine for this and is the one thing it does better than anything else. **A packet with no name is not a packet**; the packet agent will stop and tell you the name is the missing input.
6. Read the draft. Send it yourself.
7. `node src/ledger.js --add packets/<company>-<date>/ledger-row.json`.

**Sunday:** `/review`. Four questions — where did work pile up, is it signal or noise, what is the fitness run chart doing, and what goes on the abandon list. A review that ends without a cut has decided nothing.

## 5.4 What the system will refuse to do

These are not preferences. They are enforced in code, in tool sets, or in agent bounds:

- It will not scan when the week is full.
- It will not write a packet for a job that failed Gate 0.
- It will not write a packet past a failed entry gate, and will name which gate.
- It will not address a packet to anyone but a named, sourced human.
- It will not pass an audit below 0.50 coverage or with any veto false.
- It will not accept an evidence set that is entirely frontstage.
- It will not accept `INSUFFICIENT_EVIDENCE` without naming the missing record.
- It will not delist a buffer row because a board returned a 500.
- It will not send anything, ever.

---

# PART 6 — FILE MAP

## Configuration and instructions

| File | What it does |
|---|---|
| `CLAUDE.md` | Project instructions loaded on every Claude Code session. The operating rule, the five postulates, the never-do list, the banned vocabulary, output discipline. |
| `profile/gates.yaml` | Personal, gitignored. Drum size, comp floor, location hubs and tiers, hard disqualifiers, `target_titles` (filter), `title_weights` (scorer). Densely commented with measured counts for nearly every entry. |
| `profile/gates.example.yaml` | Shipped template with placeholder hubs. |
| `profile/companies.yaml` | 28 target boards across 6 archetypes with allocation weights, plus an `excluded` block recording what is deliberately not scanned and why. |
| `profile/proof-ledger.yaml` | **Authoritative.** Four sovereign proofs (inspectable by a stranger), five speculative (self-asserted), and three standing overstatements the auditor must catch. |

## Source

| File | Lines | What it does |
|---|---:|---|
| `src/sources.js` | 139 | Greenhouse, Lever, and Ashby readers. All three normalize to one shape so nothing downstream branches on source. Also extracts salary bands from free text. |
| `src/gates.js` | 468 | Gate 0, fit scoring, composite ranking, the blocking-flag set, per-company cap, per-archetype floor. Comments record what each rule was measured to do. |
| `src/scan.js` | 264 | Orchestrates a scan run: read slots, fetch, gate every row, dedupe for promotion only, skip closed cases, cap, floor, delist, URL-check, write eight JSON files. |
| `src/ledger.js` | 226 | The rope. `openSlots()`, `weekStart()` on local time, exponential fitness (2^stage), narrative sample sizes, defect classes, the RAND experiment, and the `--add` validator that refuses a row missing its instrumentation. |
| `src/liveness.js` | 80 | Feed-membership delisting and the weak URL check. Only 404/410 concludes anything. |
| `src/casefile.js` | 118 | Per-company memory across weeks: dead hypotheses, struck claims, queries already run, cooling dates, no-progress detection. **Currently read-only in practice — see D1.** |
| `src/verify.js` | 45 | Board-token checker. Writes `data/token-verification.json`. Run before the first scan and after any edit. |
| `src/report.js` | 398 | Writes `data/board.html`. Funnel bars drawn to real proportions, kill reasons in plain English, the queue with what must be resolved, a "do this next" line. |
| `src/walkthrough.js` | 370 | Writes `data/walkthrough.html`. Pick a kind of work, walk the pipeline on your real numbers. Explicitly does not fake agent runs — it hands you the prompt instead. |
| `src/renderBrief.js` | 1162 | Renders a diagnosis or packet to self-contained HTML, optionally PDF. Draft header drawn with borders so it survives printing. Also measures prose against the writing rules: banned vocabulary, corporate filler, Flesch-Kincaid grade. |
| `src/bluf.js` | 366 | The one line above the Plain English view. Derives it from the recorded verdict and the gate that failed, never from the file's prose, and stops the render if it breaks a limit or repeats a struck claim. Also the `npm run bluf` table. |
| `src/utils/schemaValidator.js` | 245 | Hand-rolled JSON Schema subset plus the four cross-cutting rules. Throws at first violation and names the path. |
| `src/validateArtifact.js` | 166 | The call site that was missing. Projects the two payloads out of a diagnosis, runs the validators, checks the seal, and throws naming the schema path and the filing-standard question. Wired into the recorder, the renderer, and the server's completion hook. |
| `src/integrity.js` | 223 | The pre-audit seal. Hashes every top-level key except `audit` and `strikes` before the auditor opens the file, so an auditor that revises rather than appends is visible afterward. |
| `server.js` | 695 | Local dashboard on `node:http`. Shows queue, drum, and the clearance state of every diagnosis; a click spends a slot. Never sends, never interpolates a name into a shell string, runs one job at a time. |

## Agents, commands, schemas, references

| File | What it does |
|---|---|
| `.claude/agents/scout.md` | Sourcing. Explicitly a non-bottleneck. Does not evaluate fit. |
| `.claude/agents/diagnostician.md` | The drum. Weakest Link formula, hypothesis-before-query, mandatory disconfirming query, evidence scoring, SHIP/PARK/REJECT rules, writing rules. |
| `.claude/agents/auditor.md` | 28-question coverage score, five vetoes, citation isolation rule, three tests, strike log format. |
| `.claude/agents/packet.md` | Four entry gates, brief structure, the two mandatory disclosures, invariant output path, the draft header, the no-send rule. |
| `.claude/agents/brief.md` | Headless gatherer. Explicit prohibitions, observable classes, output format, questions-not-answers. |
| `.claude/commands/{scan,diagnose,ship,review}.md` | The four slash commands that chain the agents. |
| `.claude/schemas/evidence.json` | The diagnosis evidence payload. Closed to five keys. Carries `x-rules` naming what JSON Schema cannot express. |
| `.claude/schemas/audit.json` | The audit payload. Closed to seven keys, verdict closed to PASS/REJECT. |
| `.claude/references/bottleneck-detection.md` | The method ladder, isomorphism gate, six-stage proposition. Loaded before any hypothesis. |
| `.claude/references/filing-standard.md` | The 28 questions and the threshold. The gate that raises upstream quality without editing the writer. |

## Automation, tests, data

| File | What it does |
|---|---|
| `bin/run.sh` | The scheduled run. Two halves, fail-closed slot guard, headless brief invocation. |
| `bin/com.bottleneck.run.plist` | launchd job. Mon/Wed/Fri 07:05. |
| `src/gates.test.js` | 81 assertions. Every Gate 0 rule, fit scoring, composite ranking, cap, floor. |
| `test/schema.test.js` | 41 assertions. Both schemas and all four cross-cutting rules. |
| `test/automation.test.js` | 7 assertions. `run.sh` behavior including the corrupted-ledger case. |
| `test/liveness.test.js` | 10 assertions. Delisting, unverifiable rows, every HTTP verdict. |
| `data/queue.json` | The buffer. Max 10. |
| `data/candidates.json` | Full current-board snapshot of everything passing Gate 0. |
| `data/killed.json` | The kill log, with excerpt and reasons, so a gate can be audited from the file it should be audited from. |
| `data/delisted.json` | Accumulating record of reqs that came off their board. |
| `data/diagnoses/` | One YAML per diagnosis with the audit block appended, plus rendered HTML. |
| `data/briefs/` | One markdown file per scheduled gathering run. |
| `data/protocols/` | Live-product measurement sheets, run by hand before a slot opens. |
| `data/logs/` | Per-day run logs plus launchd stdout/stderr. |
| `packets/` | One directory per drafted packet. Currently empty. |

---

# GAPS

Stated rather than smoothed over, per `CLAUDE.md`.

1. **No reply data exists.** Zero packets sent, zero ledger rows. Every claim in this report about whether the *design* works is a claim about internal consistency, not about outcomes. The record that would settle it is 20 ledger rows on one narrative.
2. **The five-per-week drum is unmeasured.** No packet has been built end to end, so packet build time is unknown and the constraint is asserted rather than demonstrated. P3 applies. The record that would settle it is a timed week of packet-building.
3. **`diagnostic_minutes` has never been recorded.** The `--add` validator requires it, but with n=0 the RAND experiment — the one designed test of whether diagnosis hours or instrument hours predict replies — cannot run.
4. **The SHIP rate of 1 in 5 is not a rate.** n=5.
5. **I did not run a live scan for this report.** The funnel numbers are the 2026-08-14 07:05 scheduled run as recorded in `data/scan-meta.json` and `data/killed.json`, not a fresh fetch.
6. **I did not open the rendered HTML pages or the dashboard in a browser.** `data/board.html`, `data/walkthrough.html`, and `server.js` were read as source and their generators inspected; visual output is unverified.
7. **I did not verify the claims inside the five diagnosis files.** Their verdicts, coverage scores, and audit results are reported as recorded, not re-audited. Re-auditing them is the auditor's job and costs the same attention the drum protects.
8. **Two files are uncommitted:** the Deepgram re-diagnosis and the 2026-08-14 brief.
