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
  scan.js                     sourcing CLI
  ledger.js                   drum accounting, tracking, RAND readout
  verify.js                   board token checker
  gates.test.js               13 assertions, no network
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

Five checks run, each appending to `reasons` on failure:

1. Seniority. Reject list matched against the title.
2. Title family. At least one target family must appear in the title.
3. Hard disqualifiers. Grouped phrase lists matched against title plus description.
4. Location. Remote, Phoenix, or relocation enabled. Absent location passes, since missing data is not bad data.
5. Compensation. A published maximum below the floor fails. Absent band flags rather than fails.

```js
pass = reasons.length === 0
```

That single line is the architectural commitment. No weighted total, no threshold, no averaging. One failed check fails the row regardless of how strong everything else looks. Any change that introduces an aggregate score here converts the obstacle course into an assembly line and should be rejected in review.

`flags` travel forward instead of killing. A `comp:unknown` flag must be resolved before SHIP, and a `generalist_trap` flag warns the diagnostician that the role may be a wild-card posting.

`rank` sorts by archetype allocation weight, then by recency. Prestige contributes nothing and there is no field for it.

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
load(company) → file | null
save(file) → file
create(company, archetype) → file
recordVisit(file, visit) → file        // appends, updates status, checks progress
park(file, days, trigger) → file
shouldSkip(company, when?) → { skip, reason? , priors? }
summary() → [{ company, status, visits, dead_hypotheses, revisit_after }]
```

`status` moves through NEW, PARKED, REJECTED, SHIPPED, DEAD. The transition table lives in `statusFor`, which maps a diagnosis verdict to a case status.

**No-progress detection.** `noProgress` compares the last two visits. If the second surfaced no `evidence_keys` the first did not already hold, the file goes DEAD. Two passes over the same public record will not produce a third answer, and continuing is the loop equivalent of rephrasing a paragraph and calling it revision.

**Where it plugs in.** `scan.js` calls `shouldSkip` on every gated row before promotion. Skipped rows go to `data/skipped-cases.json` with the reason, so a closed case never silently reappears in the queue.

**Priors.** When `shouldSkip` returns false for a company with history, it returns `priors` containing dead hypotheses and prior queries. The diagnostician reads these before forming a hypothesis, which prevents it from re-arguing a settled question with the drum's own capacity.

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
constraint_hypothesis: { binding_part, output_capped, confidence }
evidence:
  - { claim, inspectable_at, verify_seconds, source_class, strength }
disconfirming: { query_issued, result, survived }
proof_match: { asset, tier, acts_on_constraint, mechanism }
decision_maker: { name, title, reachable_via, source }
verdict: SHIP | PARK | REJECT
```

`source_class` is `backstage` or `frontstage`. A posting is front stage, meaning the company wrote it to be read, so no evidence row may cite it alone. The one exception is a specificity leak, which matters precisely because it marks where front-stage control failed.

`disconfirming.query_issued` is required and must have been issued after the hypothesis formed. The field exists because a model stops searching the moment its prior matches, exactly as a public defender stops an interview once the case looks typical. Scoring the seeking rather than the finding is what makes the requirement enforceable.

**Auditor.** Reads the diagnosis or packet. Scores coverage against the twenty-eight-question filing standard, then attacks remaining claims.

```yaml
audit:
  coverage: 0.00
  threshold: 0.50
  unanswered: []
  mandatory_failed: []        # questions 9,10,13,19,20. any entry fails outright
  posting_only_rows: 0        # must be zero
  claims_struck:
  verdict: CLEARED | REVISE | KILL
```

The Auditor must cite at least one evidence source the Diagnostician did not. That single rule is the cheapest available fix for circular verification. Two instances of the same model reading the same evidence share the same blind spots, and confidence rises without information. One independent source breaks the circle without adding a component.

**Packet.** Writes `packets/{company}-{date}/` containing `brief.md`, `outreach.md`, `resume-delta.md`, and `ledger-row.json`. Refuses to run unless verdict is SHIP and audit is CLEARED.

---

## 8. Control loop

```
TRIGGER      /scan, weekly
GOAL         five audited packets addressed to named humans
STATE        ledger rows + case files
BUDGET       five slots per week, ten-item buffer
STEP         hypothesis → targeted query → disconfirming query → audit → write
GATES        Gate 0, evidence schema, coverage threshold, mandatory questions
STOP         SHIP, PARK, REJECT, INSUFFICIENT_EVIDENCE, KILL, DEAD, DRUM_FULL
ESCALATE     low archetype_match_confidence routes to manual review
```

The loop never lets the producing agent certify its own completion. SHIP is a charging decision, not an outcome, and the outcome variable in every measurement is reply.

---

## 9. Testing

`npm test` runs `gates.test.js`. Thirteen assertions, no network, covering title family matching, seniority rejection, each disqualifier group, location logic, published and free-text compensation, flag-not-fail behavior on missing data, and weight-based ranking.

Gate 0 is the only component testable without a network or a model, and it decides everything the bottleneck resource ever sees, so it carries the tests.

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
