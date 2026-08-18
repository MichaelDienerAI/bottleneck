# Runbook

Sequenced prompts for Claude Code. Run them in order. Each one has an exit condition, and you do not move to the next prompt until the current one clears.

Bottleneck v0.2.

Do not paste these all at once. The order encodes dependencies, and running prompt 6 before prompt 2 produces confident work on unverified inputs, which is the exact failure the system exists to prevent.

---

## Before you start

Download the repository files and unzip them into a folder. Open that folder in VS Code. Do not ask Claude Code to regenerate the files from a description, because regeneration produces drift and you already hold the working versions.

```bash
cd bottleneck
node --version        # must be 18 or higher
npm install
npm test              # expect 437 passing across 14 suites: 97 gates, 43 casefile, 19 queue, 32 bluf, 19 ledger, 31 artifact, 32 blank, 31 blind, 27 algebra, 13 eightyk, 16 ingest, 59 schema, 8 automation, 10 liveness
```

If `npm test` fails, stop and fix that before opening Claude Code. Gate 0 decides everything the bottleneck resource ever sees, the schemas decide what a subagent may hand back, and the automation suite decides what happens at 7am when something has already gone wrong.

---

## Prompt 1. Confirm Claude Code can see the harness

> Read CLAUDE.md, then list every subagent you can see in .claude/agents and every slash command in .claude/commands. For each one, tell me the model it declares and one sentence on what it does. Then tell me which files in .claude/references you would load before a diagnosis. Do not do any other work.

**Exit condition.** It names five agents, four commands, and two references. The fifth agent is `brief`, the headless gatherer the schedule runs unattended; the other four are `scout`, `diagnostician`, `auditor`, and `packet`. If it cannot see them, the front matter format is wrong for your Claude Code version, and you fix that now rather than discovering it at packet time.

---

## Prompt 2. Verify the board tokens

> Run `npm run verify`. Every token in profile/companies.yaml is a guess, not a confirmed value. For each FAIL, search the web for that company's careers page, find the real Greenhouse, Lever, or Ashby slug, and correct profile/companies.yaml. For each EMPTY, open the careers page and tell me whether the token is right and they are simply not hiring, or whether the token is wrong. Report a table of company, old token, new token, and status. Do not change anything else in the file.

**Exit condition.** `data/token-verification.json` shows OK or a confirmed EMPTY for every row. A wrong token returns zero jobs and looks identical to a company with no openings, which is how a search spends three weeks concluding the market is dead.

---

## Prompt 3. Fill in your gates

> Read profile/gates.example.yaml. Ask me one question at a time about anything you cannot determine from profile/proof-ledger.yaml: salary floor, relocation, work modes, and any dealbreaker phrases I want added. Then write profile/gates.yaml with my answers. Do not invent values and do not copy the example values silently.

**Exit condition.** `profile/gates.yaml` exists and every value in it came from you rather than from the example file.

---

## Prompt 4. First scan

> Run /scan. Then show me data/killed.json grouped by rejection reason, and tell me which reason killed the most rows. If any reason killed more than half the total, tell me whether the rule is correctly calibrated or too aggressive, and show me three specific postings it killed so I can judge.

**Exit condition.** A queue exists with fewer than ten items, and you have personally looked at three killed postings and agreed with the kills. A gate you have never audited is a gate you do not actually control.

---

## Prompt 5. Audit the case-file memory

Done as of 2026-08-15. `src/casefile.test.js` holds 34 assertions and the write path is wired into `/diagnose` and `/ship`. What is left is checking that it behaves, because a memory nobody audits is worse than none.

> Show me data/cases/ after my first two diagnoses. For each file, tell me which visit produced which status, whether any hypothesis is recorded as dead, and whether the decision-maker field survived across visits. Then run node src/casefile.js --show.

**Exit condition.** Every status in `data/cases/` matches a verdict you personally read. A company marked DEAD or SHIPPED is closed to future scans, so those two are the ones to check first. Nothing reaches DEAD on its own — a no-progress flag is a prompt to look, not a closure.

---

## Prompt 6. The first real measurement

This is the prompt that matters. Everything above is setup.

> Pick the highest-ranked conversational AI company in data/queue.json that has a publicly usable product. Before any diagnosis, I am going to run the Deformation Test Bank against it myself. Write me a one-page protocol sheet at data/protocols/<company>.md containing: the exact sequence of turns to run, what to record after each one, the specific numbers to capture such as time to first token and turn count before drift, and the three failure signatures to watch for. Keep it to one page and make every field something I can fill in with a stopwatch and a notepad. Do not diagnose anything yet.

**Exit condition.** A protocol sheet exists and you have run it against the live product. You now hold a dated measurement of a company's product that nobody else applying there has.

---

## Prompt 7. First diagnosis

> Run /diagnose <company>. I have a measurement at data/protocols/<company>.md, so use it as the primary observable and grade it accordingly. Record the start time before you begin and the elapsed minutes when the audit clears. Follow the hypothesis-first ordering: form the constraint hypothesis before you search, then issue one query designed to kill it, and log that query whether or not it found anything.

**Exit condition.** A diagnosis file exists with a verdict, a disconfirming query logged, and no evidence row citing the posting as its only source. Expect roughly one in four to reach SHIP. A SHIP on the first try is more likely a sign the diagnostician stopped testing than a sign you found a perfect fit.

---

## Prompt 8. First packet

> Run /ship <company>. After the packet is written, show me the audit coverage percentage and the numbered list of unanswered questions from the filing standard. Do not lower the threshold to make the packet pass. If coverage is under 0.50, tell me which questions I need to answer myself before this can go out.

**Exit condition.** `packets/<company>-<date>/` contains four files, and `data/ledger.json` has one row with `observable_grade`, `diagnostic_minutes`, and `hypothesis_source` filled in, plus `measurement_minutes` if a protocol was run. Then you send it. The system drafts and you send, every time.

`diagnostic_minutes` starts at the **first diagnostic work**, which includes a live-product measurement taken before the slot opened — not at slot-open. Start the clock when you open the protocol sheet.

---

## Prompt 9. Weekly, every Sunday

> Run /review. Then answer the four questions in the command file using only ledger data. End with the abandon list: name one thing that stops this week.

**Exit condition.** A stated constraint for the coming week with ledger evidence behind it, and one named cut. A review that ends without a cut has decided nothing.

---

## Prompt 10. After twenty packets, and not before

> Run `npm run report` and read the RAND EXPERIMENT section to me. Tell me whether observable_grade separates reply rate, whether diagnostic_minutes separates reply rate, whether measurement_minutes separates it differently from diagnostic_minutes, and which hypothesis_source performs best. Then tell me plainly whether the drum is in the right place. If grade separates and minutes do not, propose the specific architectural change: move hours out of diagnosis and into building measurement instruments, and tell me what that would look like in this repo.

**Exit condition.** A decision about the architecture backed by twenty rows. Below twenty, the medians are noise and any change you make is tampering, which doubles variance rather than reducing it.

---

## What not to prompt

Do not ask Claude Code to add features while the ledger is empty. The architecture is sufficient and unproven, and every hour spent extending it is an hour not spent producing the evidence that would tell you whether it works.

Three specific requests to refuse, including from yourself:

- A weighted scoring model in gates.js. A gate that can be outvoted is not a gate.
- A second reviewer agent. Two instances of the same model share the same blind spots.
- Automated sending. The system drafts. You send.

The only extension worth building before twenty packets is an instrument runner that executes a measurement protocol and writes evidence rows directly, because that raises the drum instead of describing it.
