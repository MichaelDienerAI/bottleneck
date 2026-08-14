# System Architecture

Bottleneck. Version 0.2.
Last updated 2026-08-12.

---

## 1. What this system does

It finds a small number of companies where a proof I already own acts on a problem that company already has, and it produces a technical brief I can send to a named person there.

It does not find more jobs. Finding jobs is easy and finding them faster changes nothing.

---

## 2. Why it exists, as cause and effect

Thousands of AI roles post every week.
→ Job discovery is cheap and effectively unlimited.
→ Adding discovery capacity produces more candidates, not more replies.
→ The thing that actually converts is a company-specific technical brief sent to a named human.
→ I can build about five of those a week.
→ Therefore five packets per week is the constraint, and every part of this system exists to keep that capacity fed and never to exceed it.

That single chain determines every design decision below. When a decision looks arbitrary, trace it back to this paragraph.

---

## 3. The five focusing steps, as implemented

| Step | Implementation |
|---|---|
| Identify the constraint | Weekly packet capacity, five, set in `profile/gates.yaml` |
| Exploit it | Diagnosis never touches a job that failed a deterministic gate |
| Subordinate to it | The scanner reads open slots before it fetches, and stops at zero |
| Elevate it | Reusable proof modules and case-file priors cut build time per packet |
| Repeat | Weekly review re-derives the constraint from ledger data, not from memory |

---

## 4. Components

```
                          ┌──────────────┐
                          │  LEDGER      │  the rope
                          │  slots, rows │
                          └──────┬───────┘
                                 │ open slots
                                 ▼
  ATS boards ──► SCOUT ──► GATE 0 ──► CASE FILE ──► QUEUE
                 (code)    (code)      (code)         │
                                                      ▼
                                              DIAGNOSTICIAN  ◄── the drum
                                                (agent)
                                                      │
                                                      ▼
                                                  AUDITOR
                                                  (agent)
                                                      │
                                             PASS     │     REJECT
                                                      ▼      └──► slot released
                                                   PACKET
                                                   (agent)
                                                      │
                                                      ▼
                                              packets/ + ledger row
```

**Scout.** Reads published job feeds from Greenhouse, Lever, and Ashby. Deterministic, cheap, and deliberately dumb. It checks the ledger before it fetches anything, and when the week's slots are gone it fetches nothing.

**Gate 0.** Fixed rules in code. Pay floor, location, seniority, target title family, posting age, and hard dealbreakers such as a ban on AI coding tools or a requirement for training-loop experience. A posting older than ninety days is killed here: it is the largest single kill class on these boards, and a req nobody has touched since spring is inventory on the employer's side. Each rule holds its own veto. No rule can be outvoted by the others passing.

**Case file.** One JSON per company, persisting across weeks. Holds every prior visit, every hypothesis already killed, every claim already struck, every search already run, and a revisit date. This is the newest component and section 7 explains why it exists.

**Diagnostician.** The bottleneck. Works one company at a time. Forms a constraint hypothesis first, then queries for the fact that would confirm or kill it. Produces one named part, one number, one date, and one link a stranger can check.

**Auditor.** Scores the artifact as a percentage of a fixed twenty-eight-question filing standard, then attacks every remaining claim. It is measured on claims killed, not packets approved.

**Packet.** Writes the brief, the outreach note, the resume delta, and the ledger row. Runs only after the Auditor returns PASS.

**Ledger.** Tracks what shipped, what replied, and how far each conversation reached. It also reports open slots, which is how the whole pipeline learns when to stop.

---

## 5. How work moves

The rope runs backward against the flow of work.

The ledger counts packets written this week.
→ The scout reads that count before fetching.
→ Zero slots means zero fetches, so the queue never grows past what the drum can process.
→ The buffer in front of diagnosis holds at most ten items.
→ Work never piles up in front of the bottleneck.

A stale diagnosis is worse than no diagnosis, because a constraint reading belongs to a date and load moves. Holding forty half-researched companies produces the job-search version of factory inventory.

---

## 6. Terminal states

The system stops in named ways. "Keep looking" is not a stopping rule, because an agent that decides its own completion will always decide it has completed.

| State | Meaning | What happens next |
|---|---|---|
| SHIP | Constraint named, proof matches, decision-maker identified | Packet gets built |
| PARK | Constraint legible, no proof acts on it | Case file gets a revisit date and a trigger |
| REJECT (diagnosis) | Hypothesis failed the evidence test | Hypothesis recorded as dead, never re-run |
| INSUFFICIENT_EVIDENCE | Cannot establish a constraint through admissible process | Acquittal, not a claim the company has no constraint |
| REJECT (audit) | Audit found the packet unfounded | Slot returns to the pool |
| DEAD | Two visits produced no new evidence | Company closed until a public change |
| DRUM_FULL | Weekly capacity consumed | Sourcing suspends |

---

## 7. The state layer, and why it was missing

The system had five stages and no memory between weeks. It deduped postings, and that was all.

A company rejected in March could be re-promoted in May.
→ The diagnostician had no record of the March hypothesis.
→ It would form the same hypothesis, run the same searches, and reach the same rejection.
→ That repeat consumed a drum slot.
→ The drum is the constraint.
→ Therefore amnesia was stealing directly from the bottleneck.

That is a logistics failure, not a strategy failure, which is why it outranked every other candidate improvement. The fix is one module and one JSON file per company. It required no new agent and no new command.

The case file also gives four other things away for free:

- PARK finally means something, because a parked company carries a date and a written trigger describing what must change before reopening.
- Dead hypotheses travel forward, so the diagnostician never re-argues a settled question.
- Searches already run travel forward, so the expensive resource stops repeating work.
- No-progress detection falls out of comparing two consecutive visits. If the second surfaced no evidence the first did not already hold, the public record is exhausted and the company closes.

---

## 8. What this system deliberately does not have

Naming the abandon list matters as much as naming the build list. Each item below was considered and cut.

**Multi-agent debate.** Two instances of the same model arguing share the same blind spots. Repetition raises confidence without adding information. The Auditor is useful because it applies a fixed external checklist, not because it is a second opinion.

**Reflection loops.** Asking the model to critique and revise its own output without new evidence is an editing ritual. The loop improves only when feedback introduces a signal the generator did not already have.

**Token and cost budgets.** Real in principle. The binding budget here is my hours, and the drum already counts those.

**Trace evaluation infrastructure.** Valuable at scale. At five packets a week I can read the diagnosis files directly.

**Automated sending.** The system drafts. I send. Every time.

**A scoring model that ranks companies on a weighted total.** An aggregate score lets a strong dimension outvote a failed gate, which converts an obstacle course into an assembly line with extra steps.

---

## 9. Known limits

LinkedIn is not a source, because scraping it violates their terms. It stays a manual tool for finding the decision-maker's name.

Company board tokens in `profile/companies.yaml` are guesses until `src/verify.js` confirms them. A wrong token returns zero jobs and looks identical to a company that is not hiring.

Salary bands appear only where local law requires disclosure. Absence of a band is absence of data.

Constraint diagnosis can fabricate. A model handed a company name and no observables will invent a plausible constraint every time and give no signal that it did. The evidence schema requires a URL and a verify-time on every row for exactly this reason. Removing that field does not degrade the system gradually. It converts it into a fiction generator that reads identically to the working version.

---

## 10. Claims status

Euclid separates making something from showing it works. This section keeps them apart, because collapsing them is the most common failure in technical documentation and I would rather label my own gap than have a reader find it.

**Constructed and running.** The board fetchers, Gate 0 with eighty-one passing tests, the liveness checks with ten more, the ledger with drum accounting and the RAND readout, the case file with lifecycle tests, the token verifier, the agent and command definitions, the two reference documents.

The freshness rule is the one part of Gate 0 that has been exercised against a named live posting rather than only against fixtures. On 2026-08-13 it rejected Notion's Model Behavior Engineer requisition, published 2026-02-20 and 174 days old, which LinkedIn was simultaneously showing as "reposted 2 days ago." The buffer-delisting half has not yet fired on a real row: measured the same day, every row in the buffer was still on its board.

**Constructed but not yet exercised on real data.** The full diagnose-to-ship path. No company has been diagnosed. No packet has been written. No row has entered the ledger from an actual send.

**Not demonstrated.** That this system produces more replies than sending tailored applications by hand. That claim requires twenty packets and a reply rate, and it does not exist yet. Anyone reading this repository should treat the architecture as a hypothesis with a test attached, not as a validated method.

The test is specified in section 11.

---

## 11. The one experiment

RAND studied thousands of criminal cases and found that clearance depended on information available at the initial report, while detective hours barely moved the number. Effort correlated negatively with success, because effort is what you spend when the evidence is thin.

The same test runs here.

Every ledger row records `observable_grade`, assigned at Gate 0 before any diagnosis begins, and `diagnostic_minutes`, the wall-clock time from the first diagnostic work to the audit clearing. First diagnostic work includes a live-product measurement taken before any slot opens, because taking the measurement is the diagnostic work. Rows may also carry `measurement_minutes`, optional, recording the protocol run alone as a subset of the total. After twenty packets, `npm run report` compares all of them against reply rate, and prints the two minute splits side by side. If they disagree, the hours that matter are instrument hours rather than diagnosis hours, and that relocates the drum.

Reply is the outcome, not SHIP. SHIP is declared by the same agent that spent the minutes, and a system that grades its own work proves nothing. Reply comes from a human I do not control.

If grade separates reply rate and minutes do not, the drum is in the wrong place. The hours belong in building measurement instruments rather than in reading job postings, and the architecture changes accordingly.
