# Corvid Tactics — Review Against the Constraint

**Dated:** 2026-08-15
**Confidence:** High on every claim about this repository. Each one names a file, and most name a line. Low-to-none on the biology, which I did not inspect — see GAPS 1.
**Sources:** a full read of `src/`, `.claude/agents/`, `.claude/references/bottleneck-detection.md`, `docs/ARCHITECTURE.md`, `docs/SYSTEM_REPORT.md`, `docs/AUTOMATION.md`, `profile/proof-ledger.yaml`, `data/protocols/deepgram.md`, `data/seen.json`, plus targeted greps recorded inline. No code was changed. No files outside this one were written.

**What this is.** A grading of the crow tactics against one question. It ends with a cut, because a review that ends without a cut has decided nothing.

---

> ## Status as of 2026-08-16
>
> Two of the three recommendations in Part 1 were built after this was written. The review is kept in its original form, because a recommendation edited after the fact to match what was done stops being a record of what was decided and why.
>
> - **R1, close the case-file write path — done.** `src/casefile.js --record` derives the visit from the audited artifact and is wired into `/diagnose`, `/ship`, and the server's post-run hook. `data/cases/` holds six files. The claims in R1 about the state of the code (`data/cases/` absent, no caller of any write function) were true on 2026-08-15 and are no longer.
> - **R3, repost detection — done.** `data/reposts.json` indexes `(company, normalized title)` with a first-seen date, and the flag is informational. The index was seeded on 2026-08-16 and cannot produce a signal for sixty days, exactly as the review's own limit predicted.
> - **R2, build more measurement protocols — outstanding, and it is now the largest item on this page.** Still one protocol, `data/protocols/deepgram.md`. `profile/proof-ledger.yaml:41` still reads `inspect_at: TODO_PUBLIC_URL`. R1 and R3 were both code; this one is operator hours and cannot be delegated.
>
> The warning in Part 2 about `relocation_cost` firing on 40% of the buffer is unchanged and still worth watching. Everything in GAPS still stands, including the two that matter most: no reply data exists, and the drum has never been measured.

---

## Part 0 — The grading rule

Every proposal gets one question: **does it feed the drum?**

The drum is five proof packets a week, each addressed to a named human. `docs/ARCHITECTURE.md:23` states the chain that makes that the constraint. Everything upstream of it is a non-bottleneck, and running a non-bottleneck harder produces inventory rather than throughput.

That rule disqualifies most of the mapping table you pasted before it is even read. "Decomposed parallel task orchestration," "pub/sub event bus," "multi-perspective adversarial review" — these all add processing capacity. This system's processing capacity is not short. Michael's five hours are short. A tactic earns work here only if it does one of three things:

1. It stops a drum slot from being spent twice on the same ground.
2. It produces a sovereign proof at zero drum cost.
3. It stops a bad packet before it reaches a human.

Three tactics clear that bar. Five are already built and need nothing. Six get cut.

---

## Part 1 — The three that earn work

### R1. Intergenerational memory — close the case-file write path

**The tactic.** A crow that has never met a particular hawk learns to recognize it from other crows, and the record survives the crow that made it.

**The state here.** The memory module is written and it is never written to.

- `src/casefile.js` exports `create()`, `recordVisit()`, `park()`, and `save()`.
- Grep across `src/`, `server.js`, `.claude/`, `bin/`, and `docs/` returns exactly one importer: `src/scan.js:14`, and it imports `shouldSkip` only. Nothing calls a write function.
- `data/cases/` does not exist. Five diagnoses have been run.
- The only mention of case files in the whole agent layer is a prohibition: `.claude/agents/brief.md:26` forbids the unattended gatherer from writing one. Nothing anywhere instructs anyone to write one.

**Why it is stuck.** The read side was wired and the write side was not. So `shouldSkip()` queries a directory that no code creates, and it returns `{skip: false}` every time by construction. The gate is installed and it has never had anything to check.

**This has already cost a visit.** `data/diagnoses/deepgram-model-evaluation.yaml` is modified in the working tree. The committed version reached SHIP and the audit struck 9 of 20 claims. The working version rebuilds the hypothesis on a corrected predicate and lands on PARK. That is a second visit to the same company, and the continuity between the two visits — the dead hypothesis, the struck claims, the prior verdict — was carried forward **by hand, inside the YAML file**. `casefile.js` was built to carry exactly those three things and carried none of them.

**Why the obvious fix does not work.** Do not have the unattended brief agent write case files. `brief.md:26` is right and the reason is stated there: an unaudited claim written into system memory at 7am gets inherited as settled by a later run. The write belongs to the attended path — the `/diagnose` and `/ship` commands, after the auditor has ruled.

**One extension worth taking with it.** `create()` already carries `decision_maker: {name, title, source}` and it is never populated. Finding that name is step 5 of the weekly workflow and it is manual. Repeating the manual lookup on a second visit is the same amnesia tax on the same scarce hours.

**Crow correction to apply while doing it.** Crow social learning is rumor. One bird transmits a verdict about a face without transmitting the evidence for it. This system cannot copy that, because P2 forbids a claim with no inspectable source. So the case file must propagate **records, not verdicts**. `recordVisit()` already stores `evidence_keys` and uses them for no-progress detection, which is the right shape. Keep it. A case file that carried only `status: REJECTED` would be a rumor with a filename.

**Cost:** small. One module already written, wired into two command definitions, plus the test file `docs/RUNBOOK.md:60` already specifies.
**Payoff:** every repeat visit stops re-arguing a settled question. The system's own report calls this the highest-value repair in the repo, and the reason is that amnesia steals directly from the constraint.

---

### R2. The raven and the wolf — build more measurement protocols

**The tactic.** A raven cannot open a frozen carcass. Its beak is wrong for the job. So it recruits something whose equipment is right, and reads what spills out.

**The mapping is not model routing.** Your pasted table read this as cheap models directing expensive ones. That is already done and it is uninteresting: `brief.md` runs sonnet, `diagnostician.md` and `auditor.md` run opus, and the deterministic gates run in code where no model is involved at all.

The real hide is this: **a company's work-in-progress is private.** `.claude/references/bottleneck-detection.md:65` names this as the one place the factory analogy breaks. A factory bottleneck announces itself as a visible pile of parts. A company's pile sits in private trackers. Michael cannot open it.

`data/protocols/deepgram.md` is the raven move against that. He cannot read Deepgram's internal latency numbers, so he makes Deepgram's own product produce them for him, against a fixed six-turn protocol, recorded to one decimal. The equipment he lacks belongs to the target, and the target runs it on request.

**Three properties make this the best-placed work in the system.**

1. **It costs no drum slot.** Stated in the protocol header, line 6: *"No drum slot is spent here. This produces a measurement; the diagnosis reads it later."*
2. **The diagnosis and the proof are the same object.** `bottleneck-detection.md:190` ranks this first by payoff for exactly that reason. Nobody else applying arrives holding a dated measurement of the product.
3. **It is the one form of added capacity the system's own experiment predicts might relocate the drum.** `src/ledger.js:144-154` prints `measurement_minutes` beside `diagnostic_minutes` specifically so a divergence is visible. If instrument hours predict reply rate and diagnosis hours do not, the drum moves out of reading postings and into building instruments. Protocols are the instrument supply.

**The state here.** One protocol exists, for one company. The buffer holds ten rows across five archetypes.

**It also fixes a named defect.** `profile/proof-ledger.yaml:41` lists `deformation_test_bank` with `inspect_at: TODO_PUBLIC_URL`. A sovereign proof is defined as one a stranger can inspect without asking, and this one cannot be inspected at all. It is the named proof for `red_team_boutiques`, which is Gray Swan — the single SHIP in the repo, rejected by the auditor at 0.46 coverage. Publishing the protocol and the instrument behind it turns a `TODO` into a URL.

**Cost:** operator hours, outside the drum.
**Payoff:** raises the ceiling on the constraint rather than the load in front of it. This is Goldratt's fourth step done honestly.

---

### R3. Behavioral history on the individual requisition — repost detection

**The tactic.** Crows track a specific hawk's history in their territory, not "hawks" as a category, and calibrate to that individual.

**The gap.** `bottleneck-detection.md:137` asks for this by name, at tier B: *"A role posted three times in nine months means they cannot fill it or cannot keep it. Either way the constraint is confirmed rather than hypothesized, because it survived their attempt to relieve it. Track your own scan history and the same key will resurface."*

The scan history cannot answer that question. `data/seen.json` is a flat array of opaque keys with no dates and no counts. `src/scan.js:64` uses it as a set membership test and `src/scan.js:232` appends to it. `data/delisted.json` does carry `delisted_at`, capped at the last 200 rows.

Worse, the matching is wrong for the job. A reposted requisition usually gets a **new** board id, so key equality will never fire on it. Catching a repost needs `(company, normalized title)` matching with a first-seen date, which is a different index than the one that exists.

**Why this one is cheap.** It is deterministic, it is code, no model is involved, and the raw material is already fetched on every run. `src/scan.js` already writes eight JSON files; this is a ninth with three fields.

**Why it earns its place.** A repost is the rarest thing in outside constraint analysis: a company's own dated record that a fix did not take. Under P4 it gives you both halves. It also raises `observable_grade` at intake for free, and `observable_grade` is one of the two variables the RAND experiment is built to test.

**Missing record, named per P5:** a dated scan history keyed by company and normalized title. Until it exists, method 8 cannot be run and the reference document is asking the diagnostician for a reading the code cannot supply.

---

## Part 2 — Five tactics that are already built

These need no work. They are listed because knowing a limit you have already reached is different from knowing one you have not, and because two of them are better than their equivalents in the pasted table.

**Mobbing, done correctly, is the Citation Isolation Rule.** Crow mobbing works because the angles are ones the target physically cannot cover — above and behind, into a raptor's forward visual bias. It does not work because five crows independently agree that the owl is bad. `.claude/agents/auditor.md:36` requires the auditor to inspect and cite at least one backstage evidence item the diagnostician did not cite, and states the reason plainly: an audit assembled from the diagnostician's own citations is a proofread, not a second look. **The value is evidence asymmetry, not vote count.** That distinction is what kills the "mob of lightweight critics" proposal in Part 3.

**Graded alarm calls exist and are typed.** `src/liveness.js:56-70` returns a verdict and a status code rather than a boolean, because "unreachable, ETIMEDOUT" and "gone, 410" are different findings. `src/gates.js` splits flags into five blocking prefixes and everything else as informational, and `diagnostician.md:169` records why: `location_tier` used to veto, it fired on 91% of rows, and a veto that fires on nearly everything is the same as no veto. That is the crow lesson about alarm calls already learned and already paid for.

*One warning light, though.* Four of ten current buffer rows carry a blocking `relocation_cost` flag. That is 40%, and it is currently the largest single source of SHIP vetoes standing in front of the drum. It is by design against `stay_until: 2027-01-01`. It is also the same drift that made `location_tier` useless. The record that would settle whether it is a real gate or a stuck alarm: ledger rows showing whether any relocation-flagged row ever cleared. There are zero ledger rows.

**Alarm calls other species can read.** `.claude/agents/brief.md:57` has the gatherer record `verify_seconds` using the same field name as `.claude/schemas/evidence.json`, so a row lifts straight into a diagnosis without being rewritten. That is deliberate interoperability between two agents that never run together.

**Calibrated response by history.** PARK carries `revisit_after` and a written `revisit_trigger` (`casefile.js:92-99`), and DEAD fires from comparing two consecutive visits (`casefile.js:71-78`). The response is scaled to what the record shows. Note this is downstream of R1 — the calibration logic works and has never had data.

**Cheap continuous perception, expensive specialist on demand.** The Monday/Wednesday/Friday run gathers observables with a cheap model under hard prohibitions, and the expensive attended agents are spent one company at a time. `docs/AUTOMATION.md:15` states the boundary: the schedule raises the drum, it does not replace it.

---

## Part 3 — The abandon list

Each of these was proposed in your table. Each is cut, with the reason.

**1. A mob of lightweight critics with opposing lenses.**
`docs/ARCHITECTURE.md:141` already cut this: two instances of the same model arguing share the same blind spots, and repetition raises confidence without adding information. The corvid data does not rescue it either — see Part 2. Crows win by covering angles the target cannot, not by agreeing. A second critic here adds information only if it arrives with evidence the first did not have, which is what the Citation Isolation Rule already demands of the one auditor there is. Adding more costs drum time and buys agreement.

**2. A vector store or graph RAG for agent memory.**
This makes the memory *less* corvid, not more. Crows do individual recognition — this face, this hawk. A vector store does similarity matching, and similarity matching is how a near-match gets treated as a match. `.claude/agents/diagnostician.md:183` names that exact failure as the thing being escaped: high-volume sorters substitute resemblance for judgment, and an item matching no category gets mis-sorted rather than examined. There are 28 target boards. `casefile.js:16` slugs a company name into an exact filename. Exact-key lookup over a few dozen records is the correct index, and it is already written.

**3. A runtime skill library that agents write to during execution.**
Cut on the strongest bound in the repo. `.claude/agents/brief.md:30`: a model asked to produce a claim at 7am will produce one every time, it will read exactly like a good one, and nothing in the output will signal that it was invented. A self-writing heuristic store is that failure with persistence attached. If a strike pattern deserves to become a standing rule, the promotion path already exists and is human-reviewed: the `known_gaps` block in `profile/proof-ledger.yaml` holds three standing overstatements the auditor must catch. Add the fourth by hand.

**4. Kafka, Redis Streams, or any message bus.**
Capacity added to a non-bottleneck. Throughput here is five artifacts a week moved by one human between launchd and a local `node:http` server. `docs/ARCHITECTURE.md:147` cut trace-evaluation infrastructure on the same grounds and the same grounds hold.

**5. Probing rate limits and low-defense operational states.**
The crows attack owls in daylight; the transfer to public ATS endpoints is neither needed nor allowed here. `src/liveness.js:74` explicitly declines to run the URL check over the full 3,479-row board — several thousand requests for a signal weaker than the free feed-membership check. The system reads published endpoints with a stated user agent and does not scrape LinkedIn. Nothing about this proposal produces a packet.

**6. Runtime few-shot self-reflection.**
`docs/ARCHITECTURE.md:143`: asking the model to critique and revise its own output without new evidence is an editing ritual. `casefile.js:70` says the same thing about search: repeating a query is the loop equivalent of rephrasing and calling it revision. The loop improves only when the feedback carries a signal the generator did not already have — which is, again, the Citation Isolation Rule.

---

## Part 4 — The honest limit of the analogy

**The predator frame does not transfer, and importing it would damage the output.** Crows are managing a threat. Michael is trying to be read by a person who has a problem. Every tactic in the video that depends on harassment, conditioning, or imposing cost on the target maps to nothing here, and an artifact written in that register would read to a hiring manager as exactly what `CLAUDE.md` bans.

What does transfer is narrower and it is not about conflict at all. It is the information economics: **individual-level records beat category-level records; involuntary traces beat published statements; an alarm that fires on everything is not an alarm; and when you lack the equipment to open something, find the party whose equipment is right.** That last one is the whole of R2, and it is the strongest item on this page.

**Three of the four ranked items in `bottleneck-detection.md:190-197` already say this**, which is the real finding of this review. The corvid material largely re-derives a method ladder that exists in the repository. Where it adds something, it adds one correction — propagate the record, never the verdict — and one repair the repo had already found on its own.

---

## GAPS

1. **I did not watch the video.** Every biological claim here is taken from your summary of it, which is a secondary source with no inspectable record behind it. Under P2 that is not admissible as evidence, so nothing above rests on it. The recommendations stand on the repository files alone, and the crow material is used as a naming scheme for findings that are sourced elsewhere. If a biological claim turns out to be wrong, no recommendation in Part 1 changes.
2. **I did not run the code.** `npm test`, `npm run scan`, and `npm run report` were not executed for this review. Counts for the buffer, the kill distribution, and the test suite are read from `docs/SYSTEM_REPORT.md` dated 2026-08-14, not re-measured on 2026-08-15.
3. **Every payoff estimate in Part 1 is unmeasured.** `data/ledger.json` does not exist and zero packets have been sent. I cannot say R1 saves a slot; I can say it was built to and that a second visit has already occurred without it. The record that would settle it is a repeat visit that consumed a slot and produced nothing new.
4. **The drum itself is still an assumption.** P3 applies to this system as hard as to any company it diagnoses: five packets a week is a limit nobody has reached. Every ranking on this page is ordered against a constraint that has not yet been measured. The record that would settle it is one timed week of packet-building.
5. **I did not verify the claims inside the five diagnosis files**, or re-audit the Deepgram working-tree version. Its verdicts are reported as recorded.
6. **Cost estimates are qualitative.** "Small" and "cheap" in Part 1 are judgments about scope, not measured build times. No estimate here has an hour figure behind it.
