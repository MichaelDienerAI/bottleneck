# Operating manual

Bottleneck v0.2. How to run it, what breaks, and what to do when it does.

**Dated:** 2026-08-13. **Confidence:** High. Every command, path, and threshold below was read out of the repository rather than recalled. Anything unverified sits in `GAPS` at the bottom.

Two parts. Part 1 is what you need on a Monday. Part 2 is what you need when something is wrong.

---

# PART 1 — THE 60-SECOND BRIEF

## What this system protects

You can write five real letters a week. Not fifty. Five.

A real letter names one thing holding a company back, shows one thing you built that acts on it, and goes to a person with a name. That takes hours you cannot compress.

So jobs are not scarce. Your hours are. Five packets a week is the drum, and every other part of the system runs at the drum's pace or waits.

Three rules fall out of that:

**More candidates do not help.** Finding jobs faster changes nothing, because the jobs were never the shortage. When the week is full, the scan does not run. Not a smaller scan. No scan. Work gathered for hours you do not have becomes a pile, and a pile is not progress.

**A bad letter costs more than no letter.** One overstated claim, caught, discounts everything else you said. So a separate worker attacks each packet before it goes out and gets scored on claims killed, not packets approved.

**You send. The system drafts.** Nothing in this repository has permission to send, submit, post, or apply. The packet agent holds two tools, Read and Write, and that is on purpose. The send is a human act with your name on it.

## Cheat sheet

Run these inside Claude Code, in the repository:

| Command | What it does | When |
|---|---|---|
| `/scan` | Pulls the boards, applies Gate 0, promotes only what the drum can absorb | Start of a cycle, or after the schedule has been off |
| `/diagnose <company>` | Spends one drum slot. Runs the diagnostician, then the auditor | The main event. Once per company, per week |
| `/ship <company>` | Builds the packet for a cleared diagnosis, audits it again, renders `brief.html`, adds the ledger row | Only after a SHIP plus a PASS |
| `/review` | Weekly review from ledger data, not memory | Sunday |

Run these in a terminal:

| Command | What it does |
|---|---|
| `npm run slots` | How many packet slots are left this week. Ask this first |
| `npm run report` | Full ledger readout: weekly fitness, narrative samples, defect classes, RAND experiment |
| `npm run scan` | Half one's fetch on its own, without the agent wrapper |
| `npm run board` | Rebuilds `data/board.html` |
| `npm run walk` | Rebuilds `data/walkthrough.html` |
| `npm run brief <company>` | Renders a diagnosis, or a packet directory, to one self-contained HTML page. Add `--pdf` for a PDF via system Chrome. Reports the clearance state it found and gates nothing |
| `npm run verify` | Checks every board token in `profile/companies.yaml`. Writes `data/token-verification.json` |
| `npm test` | Six suites, 209 assertions, no network. Run before you trust anything |
| `./bin/run.sh` | Runs the whole scheduled job by hand, exactly as launchd runs it |

## The pipeline, end to end

```
  ATS boards
      │
      ▼
  INGESTED ──────► killed at Gate 0 ──► data/killed.json     (dead, with a reason)
  (data/queue.json) ─► came off the board ─► data/delisted.json  (dead, with a date)
      │
      ▼
  BRIEF ─────────► observables only, no diagnosis
  (data/briefs/<date>.md)                     unattended, MWF 07:05
      │
      ▼
  DIAGNOSE ──────► PARK ──► case file gets a revisit date and a trigger
  (one drum slot) ──► REJECT ──► hypothesis recorded dead, never re-run
      │           ──► INSUFFICIENT_EVIDENCE ──► acquittal, name the missing record
      ▼
    SHIP (diagnosis verdict)
      │
      ▼
  AUDIT ─────────► REJECT ──► slot returns to the pool. This is a good outcome
      │
      ▼
    PASS
      │
      ▼
  PACKET ────────► packets/<company>-<date>/ + one ledger row
      │
      ▼
  YOU SEND IT. Nothing here sends anything.
```

Read it as a set of gates, not a funnel. Each stage can end the run, and no stage can be talked past by the others going well.

Roughly one in four diagnoses should reach SHIP. If your SHIP rate runs over half, the diagnostician stopped testing and started agreeing with you.

## Emergency resets

**"How many slots do I have?"**
```bash
npm run slots
```

**"What is actually in the ledger?"**
```bash
node src/ledger.js --report        # same as npm run report
cat data/ledger.json                # the raw rows
```

**"Did the schedule run?"**
```bash
cat data/logs/$(date +%F).log       # today's run
ls -lt data/logs/ | head            # last several runs
```

**"Is anything broken?"**
```bash
npm test                            # expect 97 + 34 + 19 + 41 + 8 + 10 passing, 209 total
```

**"I want to see today's work."** Open `data/board.html` and `data/briefs/<today>.md` in a browser and an editor.

**"Everything looks wrong and I want to start the week clean."** The ledger is the only file you cannot safely regenerate; it is the record of what you actually sent. Everything under `data/` except `ledger.json`, `cases/`, and `protocols/` gets rebuilt by `./bin/run.sh`. Commit before you delete anything.

---

# PART 2 — STANDARD OPERATING PROCEDURE

## Section 1. System mechanics and the split

Three things run, and they are deliberately unequal in what they may do.

### Half one — deterministic, unattended

A Node script. No model, so there is nothing to fabricate and nothing to audit.

`bin/run.sh` runs, in order:

1. `node src/ledger.js --slots` — reads the drum.
2. **If slots are zero or unreadable, it exits.** It does not fetch. This is the single most important behavior in the schedule.
3. `node src/scan.js` — fetches every board in `profile/companies.yaml`, dedupes against `data/seen.json`, applies Gate 0, and re-checks that every buffer row is still on its board. Writes `data/candidates.json`, `data/killed.json`, `data/delisted.json`, and `data/liveness.json`.
4. `node src/report.js` — rebuilds `data/board.html`.
5. `node src/walkthrough.js` — rebuilds `data/walkthrough.html`.

launchd fires it Monday, Wednesday, and Friday at 07:05 through `bin/com.bottleneck.run.plist`. All output goes to `data/logs/<date>.log`. Nothing prints to your terminal, because at 7:05 there is no terminal.

This half can run unsupervised forever.

### Half two — the headless gatherer

The same script then runs Claude Code without you:

```bash
"$CLAUDE_BIN" -p "Run today's gathering pass and write the brief for $STAMP." \
  --agent brief \
  --allowedTools "Read,Write,WebSearch,WebFetch" \
  --max-turns 24 \
  --output-format text
```

`--agent brief` runs the session as `.claude/agents/brief.md`. That file holds every bound the run operates under, so the unattended run and an attended one read from the same source.

It gathers observables on the top three rows of `data/queue.json`: oldest unresolved pull requests and issues, release cadence gaps, public refusals, the one posting sentence that does not read like a template, board distribution by function, funding and incidents. Every line carries a URL and a measured `verify_seconds`. It writes one file, `data/briefs/<date>.md`.

**It is forbidden from diagnosing.** No constraint claim, no hypothesis, no packet, no ledger write, no case file. A model asked to name a bottleneck at 7am on a Wednesday will name one every time, fluently, with nothing in the output to signal that it invented it. Half two raises the drum. It does not replace it.

### Attended sessions — where judgment happens

`/diagnose` and `/ship` run with you reading them. They are the only stages that name a constraint or write to a person, and they are the only stages that consume the resource the whole system is built to protect.

If you find yourself wanting to automate one of them, read the last section of `docs/RUNBOOK.md` first.

## Section 2. A session, step by step

Budget an hour. Do it with coffee, not at the end of a day.

### 1. Read what the schedule left you

Open `data/board.html`. It shows what came in, what died at Gate 0 and why, and how many slots remain.

Open `data/briefs/<date>.md`. Three companies, evidence already collected, questions raised and deliberately unanswered. Read the `Not found` section of each. An absent record is a finding, and the brief is required to name it rather than fill the hole with inference.

Decide which company gets the slot. That decision is yours and the system does not make it for you.

### 2. Spend the slot

```
/diagnose <company>
```

Start a clock. `diagnostic_minutes` runs from your **first diagnostic work** to the audit clearing. If you ran a live-product measurement before the slot opened, the clock started when you opened the protocol sheet, not when you typed the command.

The diagnostician runs, then the auditor runs on its output.

### 3. Read the constraint hypothesis

It must be one sentence in the Weakest Link form:

> *[COMPANY] produces no more [OUTPUT] than its slowest [PART] allows.*

Check three things yourself:

- **One part, not a list.** If it names several, the boundary was drawn too wide and the diagnosis is describing a company rather than a constraint.
- **A countable output.** "Ships fewer voice sessions per week" is countable. "Struggles with quality" is not.
- **The formula came before the queries.** The hypothesis generates the search. A search that generates the hypothesis is pattern-matching with extra steps.

### 4. Read the disconfirming query

Find the `disconfirming` block. Three fields, all required:

```yaml
disconfirming:
  query_issued: Search the last two release notes for a shipped latency fix.
  result: nothing. Both cover billing and the dashboard.
  survived: true
```

`result: nothing` is a complete result. A query with no logged result is not a logged attempt.

This field exists because a model stops searching the moment its prior matches. Scoring the seeking rather than the finding is what makes the requirement enforceable. If the query looks like it was designed to confirm rather than kill, say so and reject the diagnosis yourself.

### 5. Check the evidence rows

Each row carries a claim, an absolute URL, a measured `verify_seconds`, a `source_class`, and a `strength` from 1 to 5.

Click one. Time yourself. If a row claims 8 seconds and takes you 40, the row is wrong and the audit should have caught it.

At least one row must be `backstage` — a trace the company did not choose to publish, like pull request age or a release gap. A posting is frontstage. It cannot corroborate itself. The single exception is a frontstage row labeled `specificity_leak: true`, which counts precisely because it marks where the company's presentation slipped.

### 6. Handle an INSUFFICIENT_EVIDENCE acquittal

This is not a failure and not a verdict about the company.

It means the backstage observables are absent — no public repository, no dated changelog, no status history, nothing involuntary to read — so the constraint could not be established through admissible process. The payload must name `missing_record`: the specific record that would settle it.

**Do not read it as "this company has no constraint."** That states a negative you cannot support, and it goes into the case file where a later run inherits it as settled.

What to do:

- Note the missing record. If it is something you can get another way, that is a real next action.
- The slot is spent. A rejected candidate narrows the field, which is progress.
- The case file records the visit so the next cycle does not re-run the same dead hypothesis.

### 7. Read the audit

Look for four things:

- `coverage_score` at or above **0.50**, and matching its own `unanswered_question_numbers` list. It must equal `(28 - unanswered) / 28`.
- All five entries in `veto_results` true. Any single false fails the packet regardless of coverage.
- At least one `backstage` row in `auditor_evidence` that the diagnostician did **not** cite. An audit built from the diagnostician's own links is a proofread, not a second look.
- `verdict: PASS` or `REJECT`. There is no middle state.

**Never lower the threshold to make a packet pass.** The question list stays fixed while the threshold moves, and it only ever moves up: five points every ten packets until reply rate stops improving. Rewriting a question to fit a packet turns the gate into a mirror.

A REJECT releases the slot back to the pool. Take it.

### 8. Ship it

```
/ship <company>
```

The command confirms SHIP plus PASS, runs the packet agent, runs the auditor a second time against the generated writing, and adds the ledger row. The second audit is not redundant. The writing stage is where struck claims quietly reappear.

You get `packets/<company>-<date>/` with four files. Every drafted artifact opens with:

```
DRAFT ONLY — REQUIRES HUMAN REVIEW AND MANUAL SEND
```

Read the brief yourself. Check that both standing disclosures are present and plain: the Calibration Layer is written and test-exercised but not wired into the deployed path, and the engineering work is agent-assisted with you directing Claude Code. Neither is a hedge. A hiring manager who finds the gap later discounts everything else in the packet, including the true parts.

Then you send it. Every time.

## Section 3. Data contracts and file architecture

### What lives where

| Path | What it holds | Who writes it |
|---|---|---|
| `data/queue.json` | Promoted candidates waiting for a slot | Scout |
| `data/candidates.json` | Everything that survived Gate 0 | `scan.js` |
| `data/killed.json` | What died at Gate 0, with the reason | `scan.js` |
| `data/delisted.json` | Buffer rows whose posting came off the board, dated | `scan.js` |
| `data/liveness.json` | HTTP status of each buffer row's posting URL | `scan.js` |
| `data/seen.json` | Dedupe set across cycles, board ids only, no dates | `scan.js` |
| `data/struck.json` | Buffer rows you removed by hand, dated | Dashboard |
| `data/reposts.json` | (company, normalized title) -> first_seen, last_seen, ids. Repost detection | `scan.js` |
| `data/board.html` | The page you open on Monday | `report.js` |
| `data/briefs/<date>.md` | Raw observables, no diagnosis | Brief agent |
| `data/diagnoses/<company>-<slug>.yaml` | One diagnosis plus its audit | Diagnostician, auditor |
| `data/cases/<company>.json` | Memory across weeks | `casefile.js` |
| `data/protocols/<company>.md` | Measurement protocol sheets | You, with Claude Code |
| `data/logs/<date>.log` | Everything the schedule did | `run.sh` |
| `data/ledger.json` | What you actually sent | `ledger.js --add` |
| `packets/<company>-<date>/` | The four shipping artifacts | Packet agent |
| `profile/gates.yaml` | Your floor, location, drum size | You |
| `profile/companies.yaml` | 27 boards and their tokens | You |
| `profile/proof-ledger.yaml` | Sovereign versus speculative proofs | You |

### `data/ledger.json` — the rope

An append-only array. One row per packet. `weekStart` normalizes any date to the preceding Monday, which is how weekly slots get counted.

`--add` refuses a row missing any of these:

```
date, company, archetype, title, channel, narrative, artifact,
observable_grade, diagnostic_minutes, hypothesis_source
```

Optional: `measurement_minutes`, the protocol run alone, carved **out of** `diagnostic_minutes` rather than added to it. A row claiming more instrument time than total diagnosis time is a recording error and gets refused.

`observable_grade` matches `S++|S|A|B|C|D|E|F|H` and is assigned at Gate 0, **before** any diagnosis. Grading it afterward guarantees it agrees with the outcome, which destroys the experiment.

`stage` defaults to 0. Reply means `stage >= 1`. Weekly fitness is `2 ** stage` summed, because a hiring-manager conversation is not three times better than silence, it is eight times better.

### `data/cases/<company>.json` — memory

Without this, a company rejected in March gets re-promoted in May and re-diagnosed with the same wrong hypothesis. That re-diagnosis costs a drum slot, and the drum is the constraint. Amnesia steals directly from the bottleneck.

Each file holds every prior visit, `dead_hypotheses` never to be re-run, `struck_claims` the auditor already removed, `queries_run`, a `revisit_after` date, and a `revisit_trigger` in plain language. Two visits producing no new evidence set the status to DEAD.

### `.claude/schemas/evidence.json` — what a diagnosis must return

Five keys, closed to additions: `dated`, `acquittal`, `missing_record`, `evidence`, `disconfirming`. The rest of the diagnosis file is a wrapper and is not schema-checked.

Two rules sit outside JSON Schema and run in `src/utils/schemaValidator.js`:

- **R-BACKSTAGE** — an `EVIDENCE_SUFFICIENT` payload needs at least one backstage row, or one frontstage row labeled `specificity_leak`.
- **R-ACQUITTAL** — `EVIDENCE_SUFFICIENT` needs at least one row; `INSUFFICIENT_EVIDENCE` needs `missing_record`.

### `.claude/schemas/audit.json` — what an audit must return

Seven keys, closed to additions: `dated`, `coverage_score`, `unanswered_question_numbers`, `veto_results`, `auditor_evidence`, `verdict`, `gaps`.

Four enforced rules:

- **R-VETO** — PASS requires all five vetoes true.
- **R-THRESHOLD** — PASS requires `coverage_score` at or above 0.50.
- **R-COVERAGE-CONSISTENT** — the score must equal `(28 - unanswered.length) / 28`.
- **R-AUDITOR-BACKSTAGE** — PASS requires a backstage row in `auditor_evidence`.

The threshold lives in `schemaValidator.js` as `COVERAGE_THRESHOLD`, not in the payload. A packet carrying its own passing grade is grading itself.

### `packets/<company>-<date>/`

Four files: `brief.md` (400–700 words), `outreach.md` (under 120 words), `resume-delta.md` (two or three lines, never a rewritten resume), and `ledger-row.json`.

## Section 4. Maintenance, failure modes, troubleshooting

### Check the schedule

```bash
launchctl list | grep bottleneck
```

A line back means it is loaded. Nothing back means it is not.

Install:
```bash
sed "s|REPLACE_WITH_ABSOLUTE_PATH|$HOME/Projects/bottleneck|g" \
  bin/com.bottleneck.run.plist > ~/Library/LaunchAgents/com.bottleneck.run.plist
launchctl load ~/Library/LaunchAgents/com.bottleneck.run.plist
```

Stop:
```bash
launchctl unload ~/Library/LaunchAgents/com.bottleneck.run.plist
```

Always run `./bin/run.sh` by hand first. A scheduled job that has never worked manually fails silently at 7am and you notice three weeks later.

### Nothing ran

Read `data/logs/<date>.log`, then `data/logs/launchd.err`.

**launchd does not inherit your shell.** This is the usual cause. `run.sh` sets PATH explicitly for Homebrew, `/usr/local/bin`, and the npm global directory. If `node` lives somewhere else — an nvm install, for instance — add that path in `run.sh` or the job dies with a command-not-found you will never see.

**A powered-off Mac misses the day.** launchd runs the job on wake if the machine was asleep, but a machine that was off skips it. A missing brief with no log entry is this.

### Half two failed and half one worked

By design. Half one owes nothing to half two.

| Log line | Cause | Fix |
|---|---|---|
| `claude CLI not found` | The binary is not on the PATH `run.sh` builds, or is not installed | Add its directory to the PATH line in `run.sh` |
| `WARN: brief run failed — .claude/agents/brief.md not found` | The agent file is missing or renamed | Restore it. Without it the run would have no bounds at all |
| `WARN: brief run failed or was cut short` | The CLI returned non-zero. Usually expired auth, sometimes the 24-turn cap | Run `claude` once interactively and re-authenticate |
| `no brief file produced` | The run finished but wrote nothing | Read the turns above it in the log |

The CLI uses your existing session. When auth expires, half two fails and half one keeps working, which is why the script continues instead of aborting.

### The ledger will not parse

Symptom in the log:

```
open slots: 0
Drum full. Skipping the scan entirely
```

on a week you know is not full.

`src/ledger.js` parses `data/ledger.json` without a guard, so a truncated write exits non-zero and `run.sh` forces the count to 0. A separate check catches the other shape, a clean exit with a non-number on stdout, and logs `WARN: ledger returned a non-integer slot count`.

Both fail closed on purpose. An unreadable ledger is not evidence of a free slot.

To fix:

```bash
node -e "JSON.parse(require('fs').readFileSync('data/ledger.json','utf8'))"   # names the offset
git diff data/ledger.json                                                     # see what changed
git checkout data/ledger.json                                                 # if the last commit was good
npm run slots                                                                 # confirm the count is back
```

If the file is unrecoverable, rebuild it by hand from `packets/`. Every packet directory holds the `ledger-row.json` that produced its row.

### Board tokens

```bash
npm run verify
```

Reports OK, EMPTY, or FAIL per company and writes `data/token-verification.json`.

FAIL means the token is wrong. EMPTY may mean a correct token and no open roles — check the careers page before you change anything. A wrong token returns zero jobs and looks exactly like a company that is not hiring, which is how a search spends three weeks concluding the market is dead.

### The 20-packet RAND experiment

```bash
npm run report
```

Prints nothing useful below five rows and says so. At twenty rows per narrative it starts to mean something.

The readout cross-tabulates reply rate against `observable_grade`, against `diagnostic_minutes` split at the median, against `measurement_minutes` split the same way, and against `hypothesis_source`.

One correction to the original RAND study matters here. Greenwood measured detective effort against clearance, an outcome the detective did not declare. Your SHIP verdict is declared by the same agent that spent the minutes, which is exactly that contaminated-grader failure. So the outcome variable is **reply from a human**. SHIP is an internal charging decision, and charging yourself proves nothing.

**Below twenty rows on one narrative, do not change strategy.** The report prints `INSUFFICIENT (n more)`. Changing messaging before that threshold is tampering, which doubles variance instead of reducing it.

What the answer means at twenty:

- **Grade separates reply rate, minutes do not.** The drum is in the wrong place. Hours belong in building measurement instruments, not in reading job postings. That relocates the drum and changes the architecture.
- **Minutes separate reply rate, grade does not.** Diagnosis time is buying something. Leave the drum where it is.
- **Neither separates.** The instrumentation is not measuring what matters yet. Do not conclude the system works or fails; say so plainly and keep collecting.

### Tests

```bash
npm test
```

Four suites, no network, no model:

- `src/gates.test.js` — 81 assertions on Gate 0, thirteen of them on the freshness rule.
- `test/schema.test.js` — 41 on both payload schemas and the six named rules.
- `test/liveness.test.js` — 10 on delisting and the posting-URL check, with an injected fetch so no test touches a real board.
- `test/automation.test.js` — 7 on `bin/run.sh` and the week boundary, against a fixture repository under a temporary `HOME`. It copies the real `run.sh` and `ledger.js` rather than paraphrasing them, drives half two through `CLAUDE_BIN`, and never invokes the real CLI or the network. The last two run `ledger.js` in child processes with `TZ` set, because `weekStart` once shifted the week after 5pm in zones behind UTC and quietly reset the drum.

If `npm test` fails, fix it before opening Claude Code. Gate 0 decides everything the drum ever sees.

---

## What not to build

Three requests to refuse, including when they come from you:

- **A weighted scoring model in `gates.js`.** A gate that can be outvoted is not a gate.
- **A second reviewer agent.** Two instances of the same model share the same blind spots. Confidence rises, information does not.
- **Automated sending.** The system drafts. You send.

The architecture is sufficient and unproven. Every hour spent extending it before twenty packets is an hour not spent producing the evidence that would say whether it works.

The one extension worth building early is an instrument runner that executes a measurement protocol and writes evidence rows directly, because that raises the drum instead of describing it.

---

## Sources

Read directly from the repository on 2026-08-13: `bin/run.sh`, `bin/com.bottleneck.run.plist`, `src/ledger.js`, `src/casefile.js`, `src/gates.js`, `src/utils/schemaValidator.js`, `package.json`, `.claude/agents/*.md`, `.claude/commands/*.md`, `.claude/schemas/evidence.json`, `.claude/schemas/audit.json`, `.claude/references/filing-standard.md`, `profile/proof-ledger.yaml`, `test/*.js`, and the existing `docs/` set. Test counts came from a live `npm test` run.

## GAPS

- **The `stage` ladder is undocumented.** `stage` defaults to 0, reply means `stage >= 1`, and fitness is `2 ** stage`. What stages 2 through 5 mean is not written anywhere in the repository. `INSUFFICIENT_EVIDENCE` — a definition list in `docs/TECHNICAL_DESIGN.md` or a comment in `src/ledger.js` would settle it. Until then, record `stage` consistently by your own definition and write that definition down.
- **The `channel` and `narrative` enumerations are only partly recorded.** `channel` appears as `direct|warm|github|ats` and `narrative` as `alignment-scientist|systems-plumber|structural-performance` in the packet agent's row template, but nothing validates either field, so a typo becomes a new category silently in `npm run report`.
- **No reply-rate data exists yet.** The claim that this system produces more replies than hand-tailored applications is untested. Treat the architecture as a hypothesis with a test attached.
