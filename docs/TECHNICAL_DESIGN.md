# Technical Design

Bottleneck. Version 0.2.
Companion to `docs/ARCHITECTURE.md`, which explains why. This explains how.

---

## 1. Runtime

Node 18 or later, ES modules, one dependency. `js-yaml` reads the config files. Everything else uses the standard library, including `fetch`, which Node ships natively from 18 onward.

The agents run in Claude Code, which reads `CLAUDE.md` on session start and loads subagent definitions from `.claude/agents/`. Nothing in this repository calls a model API directly. That split is deliberate: code does what a rule can settle, and the model does what requires judgment. A model scoring keyword overlap is an expensive regex with worse recall.

---

## 2. Repository layout

```
CLAUDE.md                     instructions Claude Code loads every session
docs/
  ARCHITECTURE.md             what the system is and why
  TECHNICAL_DESIGN.md         this file
.claude/
  agents/                     scout, diagnostician, auditor, packet
  commands/                   /scan /diagnose /ship /review
  references/
    bottleneck-detection.md   the graded method ladder
    filing-standard.md        the 28-question gate
profile/
  gates.example.yaml          copy to gates.yaml and edit
  companies.yaml              target boards and allocation weights
  proof-ledger.yaml           sovereign and speculative assets
src/
  sources.js                  ATS fetchers, one output shape
  gates.js                    Gate 0 and ranking, pure functions
  casefile.js                 per-company persistent state
  scan.js                     sourcing CLI, plus the --audit-freshness pass
  freshness.js                re-gates a buffer promoted days ago, pure functions
  ledger.js                   drum accounting, tracking, RAND readout. fails closed
  validateArtifact.js         the production schema gate, called before any write
  integrity.js                pre-audit seal. did the auditor append or revise?
  verify.js                   board token checker
  renderBrief.js              diagnosis or packet to one self-contained HTML page
  bluf.js                     the one-line headline above the Plain English view
  queue.js                    strike a buffer row, pick its replacement
  liveness.js                 delisting and posting-url checks
  gates.test.js               97 assertions, no network
  casefile.test.js            43 assertions, temp dirs only, never touches data/cases
  queue.test.js               19 assertions, pure functions only
  bluf.test.js                32 assertions, pure functions only
  ledger.test.js              19 assertions, temp roots, the fail-closed rope
  artifact.test.js            31 assertions, the schema gate and the seal
data/                         generated, gitignored
packets/                      generated, gitignored
```

`data/` and `packets/` are ignored because they contain company-specific analysis and contact details. `profile/gates.yaml` is ignored because it holds a personal salary floor. The `.example` file ships instead.

---

## 3. Data sources

Three public endpoints. Companies publish these deliberately, so reading them requires no authentication and violates no terms.

| ATS | Endpoint |
|---|---|
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` |
| Lever | `https://api.lever.co/v0/postings/{token}?mode=json` |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true` |

Every fetcher returns one shape, so no downstream stage branches on source:

```js
{
  key: "ashby:ElevenLabs:abc-123",   // stable dedupe key
  source, company, archetype,
  title, location, url,
  description,                        // html stripped to plain text
  posted,                             // ISO date or null
  comp,                               // {min, max, currency} or null
  fetched                             // ISO date
}
```

Ashby is the only source that returns structured compensation. For the other two, `extractCompFromText` runs a single regex against the description and returns null when it finds nothing. Null means unknown, never low.

Failures do not stop a scan. A failed board writes `{company, ats, token, error}` to `data/scan-errors.json` and the run continues, because a dead token is a finding.

---

## 4. Gate 0

`gates.js` exports two pure functions and imports nothing but the comp extractor. That keeps it testable without a network.

```js
gate0(job, cfg) → { pass, reasons[], flags[], comp }
rank(jobs, archetypeWeights) → jobs[]
```

Six checks run, each appending to `reasons` on failure:

1. Seniority. Reject list matched against the title.
2. Title family. At least one target family must appear in the title.
3. Hard disqualifiers. Grouped phrase lists matched against title plus description.
4. Location. Remote, Phoenix, or relocation enabled. Absent location passes, since missing data is not bad data.
5. Compensation. A published maximum below the floor fails. Absent band flags rather than fails.
6. Freshness. A posting older than `freshness.max_age_days`, default 90, fails. Absent date flags rather than fails.

The freshness rule reads whatever date the board publishes, and that is not the same fact across sources: `createdAt` for lever and `publishedAt` for ashby are true publication dates, while greenhouse sends `updated_at`, which any edit resets. Greenhouse is therefore the loosest of the three. Measured on 3,479 live rows on 2026-08-13, age ran p50 22 days, p75 83, p90 202, max 1,303, and the rule cut the passing pool from 425 rows to 254.

```js
pass = reasons.length === 0
```

That single line is the architectural commitment. No weighted total, no threshold, no averaging. One failed check fails the row regardless of how strong everything else looks. Any change that introduces an aggregate score here converts the obstacle course into an assembly line and should be rejected in review.

`flags` travel forward instead of killing. A `generalist_trap` flag warns the diagnostician that the role may be a wild-card posting; a **blocking** flag has to be resolved before SHIP. Blocking is a defined set, not "any flag." `BLOCKING_FLAGS` in `src/gates.js` is authoritative; read it there rather than trusting this table. Verified against `src/gates.js:223` on 2026-08-13:

| Flag prefix | Blocks because |
|---|---|
| `relocation_cost:` | the role needs a move before `stay_until`, so the cost needs pricing |
| `country_only:` | the posting names a country or state but no city |
| `remote_unverified:` | a remote label carries an office or travel expectation |
| `comp:unknown` | no published band, so the floor is unconfirmed |
| `posted:unknown` | the board published no date, so the freshness rule could not rule |

Everything else — `location_tier:`, `generalist_trap:`, `bureaucracy_signal:`, `repost:detected:` — is informational and never vetoes.

### Repost detection

Method 8 in `.claude/references/bottleneck-detection.md` asks for a record the code could not produce: a role posted three times in nine months is the company's own dated evidence that a fix did not take, which gives both halves of a P4 causal claim with no inference between them. The reference says "track your own scan history and the same key will resurface." It does not. `data/seen.json` is a flat set of board ids with no dates, and a reposted requisition gets a **new** id, so key equality can never fire on one.

`data/reposts.json` is the index that can: `(company, normalized title) → { company, title, first_seen, last_seen, ids[] }`.

```js
normalizeTitle(title) → string            // canonical form: case, accents, punctuation, whitespace
repostKey(company, title) → string
repostFlag(job, index, opts?) → flag | null
updateRepostIndex(index, jobs, today) → index   // pure, returns a new object
```

`scan.js` reads the index, computes flags against it, gates every row, then folds the run into the index and writes it. The read has to happen before the update, or every id is already present and nothing is ever new. All fetched rows update the index, not just the ones that pass Gate 0 — this is scan history, not gate history.

A flag fires when a `(company, title)` first seen more than `freshness.repost_min_age_days` (default 60) ago presents a posting id the index has not recorded:

```
repost:detected:first_seen_2026-06-01, posting id 2 for this title, 75 days since first seen
```

**It is informational, and that is a decision rather than an oversight.** A repost is evidence *for* spending a slot, so blocking on it would veto exactly the rows it exists to promote. It also carries a known false-positive class: two genuinely different requisitions sharing a normalized title read as a repost, and a large board with three open "Software Engineer" seats will trip it. A veto that can fire on a coincidence is a veto that gets routed around. It hands the diagnostician a question that is cheap to settle by opening both postings.

Seniority words are deliberately **not** stripped in normalization. "Senior Engineer" and "Engineer" are two seats, and merging them would invent reposts that never happened. The rule also cannot see a repost that was retitled.

**The index starts empty and cannot produce a signal for sixty days.** `seen.json` carries no dates, so there is nothing to backfill from; seeding `first_seen` from the current requisition's `posted` date was considered and rejected, because that date describes the current req rather than when this system first observed the title, and conflating the two would put a fabricated observation date in the record. The scan says so on the run that seeds the file.

**`stale:` is a kill reason, not a flag, and it is not on that list.** Reasons and flags are different fields doing different jobs: a reason ends the row at Gate 0, a flag travels with a row that survived. A stale posting never reaches a diagnosis at all, so a `stale:` veto would be a veto on rows that cannot exist. The same holds for `seniority:`, `title:`, `location:`, and the `hard_disqualifiers` groups.

Neither `unknown` flag costs a fit point: both name something the board failed to publish rather than something about the role, so charging fit for them would reorder the buffer by ATS vendor.

`rank` sorts by archetype allocation weight, then by recency. Prestige contributes nothing and there is no field for it.

---

## 4a. Liveness

Gate 0 catches a requisition that is old. It cannot catch one that is recent and already closed, and it cannot catch a buffer row that has come down since the scan that promoted it. `liveness.js` handles those, and it grades its two signals differently.

**Feed membership is authoritative.** The ATS endpoints publish open requisitions and nothing else, so a key that was in the buffer and is absent from this run's fetch has been taken down. It costs no extra request, because the scan already fetched every board. A company whose fetch failed this run is excluded from the comparison: an empty result from a 500 is not evidence that a company closed its reqs, and without that guard one bad afternoon would empty a company's rows out of the buffer.

**The posting-URL check is weak and is treated as weak.** An HTTP 200 proves the link resolves, not that the role is open — greenhouse serves a closed job as a 200 redirect to the board index, ashby as a 200 client-rendered shell. Only 404 and 410 remove a row. Every other status is recorded with its code and left for a human. Nothing reads the page body; inferring "closed" from HTML text would be pattern matching on absent data and calling the guess a gate. The check runs over the buffer only, ten requests at most, since the free signal above already covers the full board.

Removed rows are appended to `data/delisted.json` with the date and the reason, because "open on the 4th, gone by the 13th" is the dated record that makes a delisting inspectable later. Surviving buffer rows carry `verified_live_at`, `verified_via`, and `url_check`.

---

## 5. Case file

`data/cases/{slug}.json`, one per company, created on first diagnosis.

```json
{
  "company": "Simli",
  "slug": "simli",
  "archetype": "conversational_ai",
  "first_seen": "2026-08-12",
  "status": "PARKED",
  "visits": [
    {
      "date": "2026-08-12",
      "hypothesis": "avatar audio buffer handoff caps session quality",
      "verdict": "PARK",
      "evidence_keys": ["gh:issue:41", "site:changelog"],
      "observable_grade": "S",
      "minutes": 52,
      "disconfirming_query": "recent commits touching the streaming path"
    }
  ],
  "dead_hypotheses": [],
  "struck_claims": [],
  "queries_run": ["simli open issues by age"],
  "decision_maker": { "name": null, "title": "CTO", "source": null },
  "revisit_after": "2026-09-12",
  "revisit_trigger": "reopen when they post a second streaming role"
}
```

Interface:

```js
slugify(company) → string
load(company, root?) → file | null
save(file, root?) → file
create(company, archetype) → file
recordVisit(file, visit, root?) → file  // upserts by artifact digest, updates status, checks progress
park(file, days, trigger, root?) → file
shouldSkip(company, when?, root?) → { skip, reason? , priors? }
summary(root?) → [{ company, status, visits, dead_hypotheses, revisit_after }]

evidenceKeys(doc) → string[]            // normalized URLs, diagnosis rows plus auditor rows
effectiveVerdict(doc, stage?) → string
visitFromDiagnosis(doc, opts?) → visit  // pure. every field traces to the artifact
resolveDiagnosis(target, root?) → path  // company name or path. ambiguity throws
recordFromDiagnosis(target, opts?) → result
```

`status` moves through NEW, CLEARED, PARKED, REJECTED, AUDIT_REJECT, SHIPPED, DEAD. The transition table lives in `statusFor`, which maps an effective verdict to a case status. Only SHIPPED and DEAD close a company to future scans.

**The write path is deterministic, and that is the point.** `recordFromDiagnosis` derives every field from the diagnosis YAML on disk. No agent hand-writes a case file, because memory written by a model is a claim nobody checked, filed where a later run inherits it as settled. Three properties follow:

- **It refuses an artifact with no `audit:` block.** The unattended gatherer never produces one, so it can never write here even though its tool set includes `Write`. That is a structural bound rather than a line in a prompt.
- **An audit REJECT outranks the diagnosis verdict.** A diagnosis that reached SHIP and then failed the audit did not ship, so it files as `AUDIT_REJECT`: no dead hypothesis, no cooling date, nothing closed. The artifact failed on coverage, which says nothing about whether the hypothesis was right. Gray Swan is that case.
- **It is idempotent on two keys.** `/diagnose` and `/ship` both record, and the server's post-run hook records again. The first key is `(artifact, digest)`: the identical reading re-filed is a strict no-op, and the recorder says `idempotent` rather than pretending it did something. The second is `(artifact, date)`: the same artifact re-recorded on the same day replaces its row instead of appending, because refining an artifact and re-filing it is not a second look at the company. A rewrite recorded on a **later** day still appends, which is the real second visit the no-progress rule exists to judge.

`SHIP` records as `CLEARED` at diagnosis time and as `SHIP` only under `--stage ship`. A `/ship` run that fails must leave the row workable, and SHIPPED means "already in the ledger," which is not true until the packet exists.

**No-progress detection raises a flag. It does not close a company.** `noProgress` compares the last two visits; if the second surfaced no `evidence_keys` the first did not already hold, it sets `no_progress_warning` and `no_progress_since`. The verdict-derived status is left alone, `shouldSkip` still returns `skip: false`, and the warning travels with it so the next scan can report it.

It used to set `status = 'DEAD'` outright, which closes a company to every future scan. That is an irreversible decision taken by a calculation, on evidence that is only ever circumstantial — the same keys twice can mean the public record is exhausted, and it can equally mean the artifact got filed twice, or the second look was cut short, or the evidence moved without the URLs changing. It fired wrongly twice in this repository's short history: once on an added `revisit_trigger:` field, once on a same-day re-record that closed Synthesia on 2026-08-17.

DEAD is now reached only through `closeDead`, from `node src/casefile.js --close-dead <company>` or the dashboard's `POST /api/close`. Both refuse a company carrying no warning unless forced, both require an explicit confirmation, and both record `closed_at` and `closed_by`. A calculation may say "this looks exhausted." Only a person may say "stop."

**Where it plugs in.** `scan.js` calls `shouldSkip` on every gated row before promotion. Skipped rows go to `data/skipped-cases.json` with the reason, so a closed case never silently reappears in the queue.

The write side runs from three places, all attended:

| Caller | Command | Stage |
|---|---|---|
| `/diagnose` step 3 | `node src/casefile.js --record <company> --stage diagnose` | after the audit |
| `/ship` step 6 | `node src/casefile.js --record <company> --stage ship` | after the ledger row |
| `server.js` post-run hook | the same commands, spawned when the job exits 0 | both |

The server hook exists because `argsFor()` grants the dashboard's model `Task, Read, Write, Glob, Grep, WebFetch, WebSearch` and no `Bash`, so a model running from the web page cannot execute the node command its own slash command names. `bin/run.sh` never calls the recorder, and `test/automation.test.js` asserts both that the scheduled run leaves no `data/cases/` behind and that the script never names the module.

**Priors.** When `shouldSkip` returns false for a company with history, it returns `priors` containing dead hypotheses and prior queries. The diagnostician reads these before forming a hypothesis, which prevents it from re-arguing a settled question with the drum's own capacity.

---

## 5a. Striking a buffer row

Three things remove a row from the buffer, and only one of them is a judgment. Gate 0 kills on a rule and writes `data/killed.json`. Liveness delists on the board's own record and writes `data/delisted.json`. A **strike** is Michael reading a row and saying no, and it writes `data/struck.json`. Without its own log the removal would be invisible: a row that vanished from the buffer with nothing on disk explaining why.

`src/queue.js` holds the mechanics as pure functions; the dashboard does the reading and writing.

```js
strikeRow(queue, key) → { queue, struck }
strikeRecord(row, {at, reason?, source?}) → record
eligibleBackfill(candidates, opts) → rows[]     // ranked order preserved
pickBackfill(candidates, opts) → row | null
```

**A strike is not a verdict on the company.** A company can hold two buffer rows, and striking one says nothing about the other. Nothing in this path touches a case file. Closing a company is the diagnostician's call, spent from the drum and audited; a checkbox on a web page is not that.

**Backfill excludes five classes**, each of which would otherwise reintroduce a decision the system already made: rows already queued, rows previously struck, rows the board delisted, companies `shouldSkip` closes, and anything over the per-company cap counted against the queue *after* the strike.

**Two preferences decide the replacement.** First a company other than the one just struck; then an archetype with no row in the buffer, which is `archetypeFloor()` applied one row at a time. The company preference came from measurement: striking OpenAI's alignment row on 2026-08-16 backfilled a *different OpenAI row*, because the strike left `frontier_labs` unrepresented and OpenAI held the best candidate in it. Correct by the floor rule and useless to read. Rows from the struck company move to the back rather than out — if that company holds the only candidate for an unrepresented archetype it still wins, because losing the archetype costs more than the repetition does.

**The buffer never grows on a strike.** One row out, at most one row in. Its size was set by the rope at scan time, `min(buffer_max, slots + 5)`, and slots may have been spent since.

`POST /api/strike` is the only route that edits `data/queue.json`. It refuses while a job is running (`/api/run` resolves a company against the queue before spawning, so editing it mid-run could hand the child a row that no longer exists), it addresses rows by board key rather than company name (a company can hold two rows), and it writes the strike log *before* the queue, so a crash between the two leaves a log entry with no removal rather than a removal with no log.

`scan.js` filters struck keys out of promotion. Promotion already draws only from never-seen keys, so a struck row could not return by that path — but that held by accident, and the rule is worth stating in code.

`data/board.html` is written once per scan and has no server behind it, so it cannot offer this. It carries a line pointing at `npm start` instead.

---

## 6. Ledger

`data/ledger.json`, an append-only array. `weekStart` normalizes any date to the preceding Monday, which is how weekly slots get counted.

```js
openSlots(root?, cfg?) → number         // packets_per_week minus rows this week
loadLedger(root?) → rows[]
weekStart(date?) → "YYYY-MM-DD"
```

CLI: `--slots`, `--report`, `--add <file.json>`.

**Row schema.** Twelve tracking variables plus three instrumentation fields. `--add` refuses any row missing a required field, because a packet that teaches nothing is worse than no packet.

Required: `date`, `company`, `archetype`, `title`, `channel`, `narrative`, `artifact`, `observable_grade`, `diagnostic_minutes`, `hypothesis_source`.

Optional: `measurement_minutes`.

`diagnostic_minutes` is wall-clock time from the **first diagnostic work** to the audit clearing. First diagnostic work includes a live-product measurement taken before any slot opens — taking the measurement is the diagnostic work, so the clock starts when the protocol sheet opens, not when the slot does. `measurement_minutes` records the protocol run alone and is a **subset** of `diagnostic_minutes`; `--add` refuses a row where it exceeds the total.

`observable_grade` must match `S++|S|A|B|C|D|E|F|H` and gets assigned at Gate 0, before any diagnosis. Grading it afterward guarantees it matches the outcome, which destroys the experiment.

**Fitness.** `2 ** stage`, summed weekly. A hiring-manager interview is not three times better than silence, it is eight times better, and linear counting hides that.

**Narrative sample gate.** The report prints `INSUFFICIENT (n more)` for any narrative below twenty rows. Changing messaging before that threshold is tampering, which doubles variance rather than reducing it.

**RAND readout.** `randExperiment` cross-tabulates reply rate against observable grade, against minutes split at the median, and against hypothesis source. It prints nothing useful below five rows and prints the read instruction at twenty. Reply means `stage >= 1`.

---

## 7. Agent contracts

Each subagent is a markdown file with YAML front matter naming its tools and model. The contracts below are what the rest of the system depends on.

**Scout.** Reads slots, runs `scan.js`, promotes to `data/queue.json`. Forbidden from evaluating fit. Model: haiku, because nothing here needs judgment.

**Diagnostician.** Reads one queue row plus case-file priors. Writes `data/diagnoses/{company}-{slug}.yaml`. Model: opus.

Required output fields, and the packet stage refuses to run without them:

```yaml
dated: YYYY-MM-DD                   # the date the evidence was gathered
constraint_hypothesis: { weakest_link, binding_part, output_capped, confidence }
acquittal: EVIDENCE_SUFFICIENT | INSUFFICIENT_EVIDENCE
missing_record:                     # required under INSUFFICIENT_EVIDENCE. omit otherwise
evidence:
  - { claim, inspectable_at, verify_seconds, source_class, strength, specificity_leak }
disconfirming: { query_issued, result, survived }
proof_match: { asset, tier, acts_on_constraint, mechanism }
decision_maker: { name, title, reachable_via, source }
verdict: SHIP | PARK | REJECT
```

Five of those keys belong to `.claude/schemas/evidence.json` rather than to this file: `dated`, `acquittal`, `missing_record`, `evidence`, and `disconfirming`. Lifted together they are the evidence payload `validateEvidence` checks, and that object is closed with `additionalProperties: false`, so nothing diagnosis-local goes inside it. The rest — the hypothesis, the proof match, the decision maker, the verdict — are the diagnosis wrapper and are not schema-checked.

`strength` is an integer from 1 to 5: 5 a sovereign backstage trace a stranger can reproduce, 3 circumstantial, 1 asserted with a source that only repeats the assertion. `inspectable_at` is an absolute URL, since a bare repo path is not something a stranger can open. `specificity_leak` is optional and appears only on a frontstage row admissible as a leak.

`source_class` is `backstage` or `frontstage`. A posting is front stage, meaning the company wrote it to be read, so no evidence row may cite it alone. The one exception is a specificity leak, which matters precisely because it marks where front-stage control failed. R-BACKSTAGE enforces it: an `EVIDENCE_SUFFICIENT` payload needs at least one backstage row, or one frontstage row explicitly labeled `specificity_leak`.

`acquittal` is the two-state finding on whether the constraint could be established at all. `INSUFFICIENT_EVIDENCE` is an acquittal, not a finding that the company has no constraint, and R-ACQUITTAL requires `missing_record` to name the record that would settle it. That is P5 in code: a missing record is itself a finding.

`disconfirming.query_issued` is required and must have been issued after the hypothesis formed. The field exists because a model stops searching the moment its prior matches, exactly as a public defender stops an interview once the case looks typical. Scoring the seeking rather than the finding is what makes the requirement enforceable.

**Auditor.** Reads the diagnosis or packet. Scores coverage against the twenty-eight-question filing standard, then attacks remaining claims.

```yaml
audit:
  dated: YYYY-MM-DD
  coverage_score: 0.00              # answered / 28, a fraction between 0 and 1
  unanswered_question_numbers: []   # filing-standard numbers, 1-28, unique
  veto_results:                     # five checkpoints, each with its own veto
    q9_link_behind_claim: true
    q10_verify_under_60s: true
    q13_source_beyond_posting: true
    q19_staged_labeled: true
    q20_agent_assisted_labeled: true
  auditor_evidence:                 # same row shape as an evidence payload
    - { claim, inspectable_at, verify_seconds, source_class, strength }
  verdict: PASS | REJECT
  gaps: []                          # optional. what could not be verified
```

`.claude/schemas/audit.json` closes this object with `additionalProperties: false`, so those seven keys are the whole contract and a renamed field is a validation failure rather than a stylistic choice. The coverage threshold lives in `src/utils/schemaValidator.js` as `COVERAGE_THRESHOLD`, not in the payload, because a packet that carries its own passing threshold is grading itself.

Four rules sit outside what JSON Schema can express and are enforced in `validateAudit`: PASS requires all five vetoes true, PASS requires `coverage_score` at or above the threshold, `coverage_score` must equal `(28 - unanswered.length) / 28` within rounding, and PASS requires a backstage row in `auditor_evidence`. Each is listed by id in the schema's `x-rules` block, so the schema never claims to be the whole gate.

The Auditor must cite at least one evidence source the Diagnostician did not. That single rule is the cheapest available fix for circular verification. Two instances of the same model reading the same evidence share the same blind spots, and confidence rises without information. One independent source breaks the circle without adding a component.

**Packet.** Writes `packets/{company}-{date}/` containing `brief.md`, `outreach.md`, `resume-delta.md`, and `ledger-row.json`. Refuses to run unless the diagnosis verdict is SHIP and the audit verdict is PASS.

---

## 8. Control loop

```
TRIGGER      /scan, weekly
GOAL         five audited packets addressed to named humans
STATE        ledger rows + case files
BUDGET       five slots per week, ten-item buffer
STEP         hypothesis → targeted query → disconfirming query → audit → write
GATES        Gate 0, evidence schema, coverage threshold, mandatory questions
STOP         SHIP, PARK, REJECT (diagnosis or audit), INSUFFICIENT_EVIDENCE, DEAD, DRUM_FULL
ESCALATE     low archetype_match_confidence routes to manual review
```

The loop never lets the producing agent certify its own completion. SHIP is a charging decision, not an outcome, and the outcome variable in every measurement is reply.

---

## 9. Testing

`npm test` runs nine suites in order, 300 assertions, no network and no model in any of them.

| Suite | Assertions | Covers |
|---|---|---|
| `src/gates.test.js` | 81 | Title family matching, seniority rejection, each disqualifier group, location logic, published and free-text compensation, flag-not-fail behavior on missing data, blocking-versus-informational flags, per-company caps, and weight-based ranking |
| `test/schema.test.js` | 41 | Both payload schemas and the four rules JSON Schema cannot express: R-BACKSTAGE, R-ACQUITTAL, R-VETO, R-THRESHOLD, R-COVERAGE-CONSISTENT, R-AUDITOR-BACKSTAGE |
| `src/ledger.test.js` | 19 | The rope, and the one property that matters: a missing ledger opens no slots, a corrupt one opens no slots, an initialized empty one opens the cap. `initLedger` never truncates the one file in this repository that cannot be regenerated |
| `src/artifact.test.js` | 31 | The production schema gate and the pre-audit seal: the evidence and audit payloads against their schemas, the five mandatory questions by number, and the case the seal exists for — an auditor that appends its blocks and also quietly rewrites an evidence row |
| `src/bluf.test.js` | 32 | The headline above the Plain English view: the 25-word ceiling, the banned-jargon list, passive voice, the reading-grade ceiling, em dashes, and the two that matter most — a headline repeating a struck claim must fail the render, and a missing verdict must render `Verdict not recorded.` rather than infer one from the gates |
| `test/automation.test.js` | 7 | `bin/run.sh` orchestration against a fixture repo under a temporary `HOME`: a clean run, a full drum, a missing CLI, a missing brief agent, and a corrupted or non-integer ledger. Plus the week boundary: `weekStart` and `openSlots` run in child processes with `TZ` set, at hours that straddle the UTC date line in zones on both sides of it |

Gate 0, the schemas, and the runner are the three components testable without a network or a model. Gate 0 decides everything the bottleneck resource ever sees. The schemas decide what a subagent is allowed to hand back. The runner decides what happens at 7am when something has already gone wrong. Everything else needs a human reading it.

`test/automation.test.js` copies the real `bin/run.sh` and `src/ledger.js` into the fixture rather than paraphrasing them, drives half two through `CLAUDE_BIN`, and never invokes the real CLI or the network.

Case-file lifecycle is exercised manually: create, park, verify cooling, force a stale visit, confirm DEAD. Converting that to assertions is the next test to write.

Board tokens are verified by `npm run verify`, which reports OK, EMPTY, or FAIL per company and writes `data/token-verification.json`. EMPTY may mean a correct token and no open roles. FAIL means the token is wrong.

---

## 10. Setup

```bash
node --version                      # 18+
npm install
cp profile/gates.example.yaml profile/gates.yaml
$EDITOR profile/gates.yaml          # salary floor, location, dealbreakers
npm run verify                      # fix any FAIL tokens before scanning
npm test
npm run scan
```

Then open the folder in Claude Code and run `/scan`, `/diagnose <company>`, `/ship <company>`, and `/review` weekly.

---

## 11. Extension rules

Anything added later has to answer one question: does it feed the drum, or does it feed something else?

Three specific rejections stand, and reversing any of them needs a written reason:

- No aggregate scoring in `gates.js`. A gate that can be outvoted is not a gate.
- No self-verification. The Auditor must reach evidence the Diagnostician did not.
- No automated sending. The system drafts and a human sends.

Two changes would be genuinely valuable and are not built:

- An instrument runner that executes a measurement protocol against a target product and writes evidence rows directly. This would raise the drum rather than describe it, because it converts diagnosis and proof into a single act.
- Case-file assertions in the test suite.

Everything else on the candidate list is a governor. Governors keep the system honest. They do not raise the drum, and a system that only gains governors gets slower while feeling more rigorous.
