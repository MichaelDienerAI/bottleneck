# Bottleneck

> The slowest part sets the pace for everything else.

An agentic job-search system built on Theory of Constraints. It does not find more jobs. It finds the small number of jobs where a proof you already own acts directly on a problem the employer already has, and it refuses to spend effort anywhere else.

## The constraint this system respects

Your Constraint System document, C1: *effort spent away from the constraint changes nothing.*

Job discovery is not your constraint. Thousands of AI roles are posted every week and you can already name your twelve target archetypes. Volume is a non-bottleneck. Running it harder produces exactly what The Goal predicts: excess inventory. In a job search, inventory is a pile of half-researched companies and unsent drafts.

Your binding constraint is **proof-packet throughput to a named decision-maker.** You can build roughly five high-fidelity, company-specific proof artifacts per week. That number is the drum. Everything upstream of it releases work at that rate and no faster.

So the architecture inverts the usual job-search tool. Discovery is subordinated. Diagnosis is the bottleneck resource, and every stage exists to keep it fed with work it can actually convert.

```
SOURCES  ──►  GATE 0      ──►  DIAGNOSIS   ──►  AUDIT     ──►  PACKET   ──►  LEDGER
(ATS APIs)    deterministic    the DRUM         evidence      artifact     tracking
              disqualifiers    5 slots/week     test P2       + outreach   + fitness
              (code)           (agent)          (agent)       (agent)      (code)
```

The rope runs backward: the ledger reports open slots, the scanner only promotes as many candidates as there are slots, and the buffer in front of diagnosis holds at most ten. Work never piles up in front of the bottleneck, because a stale diagnosis is worse than none.

## The five focusing steps, mapped

| Goldratt | This system |
|---|---|
| 1. Identify | Named: weekly proof-packet capacity, five per week |
| 2. Exploit | Diagnosis never spends a slot on a job that failed a deterministic gate |
| 3. Subordinate | Scanner rate-limits to open slots; scoring runs in code, not in the model |
| 4. Elevate | Reusable proof modules cut per-packet build time, raising the drum |
| 5. Repeat | Weekly review re-derives the constraint from ledger data, not from memory |

## What the code does and what the agent does

The split is deliberate. Code handles anything deterministic, because a model that scores keyword overlap is an expensive regex with worse recall. Agents handle judgment, because inferring what actually binds a company from a job description is inference, not matching.

**Code:** fetch public ATS boards, dedupe, apply hard disqualifiers, extract compensation, compute fitness, enforce drum capacity, write the ledger.

**Agents:** diagnose the employer's constraint, test that diagnosis against inspectable evidence, map it to a sovereign proof, write the packet.

## Setup

```bash
node --version          # needs 18+
npm install
cp profile/gates.example.yaml profile/gates.yaml   # then edit
node src/verify.js      # checks which company board tokens actually resolve
node src/scan.js        # fetches, gates, writes data/candidates.json
```

Then open the folder in VS Code with Claude Code and run `/scan`, `/diagnose`, `/ship`.

## Documentation

`docs/ARCHITECTURE.md` explains what the system is and why each part exists, in cause-and-effect form.
`docs/TECHNICAL_DESIGN.md` explains how it is built: schemas, interfaces, gates, and the test plan.
`docs/RUNBOOK.md` is the sequenced set of Claude Code prompts that take this from unzipped to first packet sent.

Read the architecture document first. Section 10 labels which claims are constructed and which are demonstrated, and section 11 states the one experiment that could change the design.

## Files

```
CLAUDE.md               project instructions Claude Code reads on every session
.claude/agents/         four subagents: scout, diagnostician, auditor, packet
.claude/commands/       slash commands that chain them
profile/proof-ledger.yaml   your sovereign vs speculative proofs, from Isocrates section
profile/gates.yaml          hard disqualifiers and the compensation floor
profile/companies.yaml      target boards by archetype, with allocation weights
src/                    fetchers, gates, case files, ledger
data/cases/             generated: one persistent case file per company
data/                   generated: candidates, diagnoses, ledger
packets/                generated: one folder per shipped packet
```

## Known limits, stated up front

**LinkedIn is not a source.** Scraping job listings or profiles breaks their terms and gets accounts restricted. This system reads public ATS endpoints that companies publish deliberately: Greenhouse, Lever, Ashby. Those endpoints cover most of your target archetypes, because AI startups almost all run one of the three. Use LinkedIn manually for the decision-maker name, which is the one thing it does better than anything else.

**The Indeed connector is your second source.** You already have it connected in Claude. It reaches postings from companies not on your target board list, which matters for discovering archetypes you have not mapped yet. Use it inside a Claude session rather than in code, and feed anything interesting into `profile/companies.yaml` so the scanner picks up that company's whole board on the next run. One posting is a data point. A board is a hiring pattern, and hiring patterns are where constraints show.

**Board tokens are unverified.** `profile/companies.yaml` ships with likely slugs, not confirmed ones. `src/verify.js` exists because guessing a token and getting a 404 is a finding, not a failure. Run it before the first scan and correct the file.

**Constraint diagnosis can fabricate.** A job description rarely states what binds the company. The diagnostician is instructed to produce a hypothesis with a named, inspectable evidence source or to return `INSUFFICIENT_EVIDENCE` and stop. That is postulate P2 enforced as a schema field. If you loosen it, the system will happily generate confident fiction about the hiring priorities of companies it has never observed.

**Comp data is thin.** Only Colorado, NYC, California, and Washington postings reliably carry salary bands. Everywhere else the floor gate passes on absence, and you carry the risk manually.
