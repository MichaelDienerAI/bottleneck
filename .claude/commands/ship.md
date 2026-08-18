---
description: Build the outreach packet for a cleared diagnosis. Usage - /ship <company>
argument-hint: [company name]
---

For $ARGUMENTS:

1. Confirm `data/diagnoses/` holds a diagnosis with verdict SHIP and audit verdict PASS. If not, stop and say which gate it failed.
2. Run `npm run diorismos -- --register packets/<company>-<date>`. This writes the acceptance criteria BEFORE anything is drafted: the one named decision-maker and their source, the one sovereign proof and its public URL, the word ceilings, the reading grade. Euclid states the conditions of a construction before the construction, because some constructions are impossible from the given parts — if this step reports NOT CONSTRUCTIBLE, stop. You are missing a name or a publishable proof, and no amount of drafting supplies either.

   Criteria written after a draft are criteria the draft passes. This is the stage where that temptation is strongest: a slot has been spent, the artifact exists, and nobody wants to conclude it cannot be written.

3. Run the packet subagent.
4. Run the auditor subagent again, this time against the generated brief and outreach message. The audit runs twice on purpose, because the writing stage is where unfounded claims reappear.
5. Run `npm run diorismos -- --check packets/<company>-<date> --enforce`. Measures the drafts against what was registered in step 2. A violation raises R-DIORISMOS-VIOLATION and moves the offending draft into `rejected/` with the report beside it — quarantined rather than deleted, because a draft that failed is the record of how it failed.
6. Run `node src/renderBrief.js packets/<company>-<date>` to write `brief.html` beside the markdown. Add `--pdf` if a PDF is wanted. The renderer reports the clearance state it found and does not gate anything; if it says NOT CLEARED after step 3, the packet is not shippable regardless of what the markdown says.
7. Run `node src/ledger.js --add packets/<company>-<date>/ledger-row.json`.
8. Run `node src/casefile.js --record <company> --stage ship`. `--stage ship` is what moves the case file to SHIPPED, which closes the company to future scans. `/diagnose` records the same artifact as CLEARED and deliberately does not close it, because a `/ship` run that fails must leave the row workable.
9. Report the file paths, the remaining slot count, and the case-file status.

You draft. Michael sends. Never send anything.
