---
description: Build the outreach packet for a cleared diagnosis. Usage - /ship <company>
argument-hint: [company name]
---

For $ARGUMENTS:

1. Confirm `data/diagnoses/` holds a diagnosis with verdict SHIP and audit verdict PASS. If not, stop and say which gate it failed.
2. Run the packet subagent.
3. Run the auditor subagent again, this time against the generated brief and outreach message. The audit runs twice on purpose, because the writing stage is where unfounded claims reappear.
4. Run `node src/ledger.js --add packets/<company>-<date>/ledger-row.json`.
5. Report the file paths and the remaining slot count.

You draft. Michael sends. Never send anything.
