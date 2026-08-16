---
description: Spend one drum slot diagnosing one company. Usage - /diagnose <company>
argument-hint: [company name, or blank for top of queue]
---

Take $ARGUMENTS, or the highest-ranked unprocessed row in `data/queue.json` if blank.

1. Run the diagnostician subagent on that single company. One company, one slot, finished.
2. Run the auditor subagent on the resulting diagnosis file.
3. Run `node src/casefile.js --record <company> --stage diagnose`. This writes `data/cases/<company>.json`: the visit, the verdict chain, the evidence keys, the queries already run, the claims the auditor struck, and the decision-maker if one was found. Run it after the audit and never before — the recorder refuses an artifact with no `audit:` block, because a claim nobody ruled on does not get to become a prior a later diagnosis inherits as settled.

   Do not write the case file by hand, and do not edit one. Every field is derived from the YAML on disk, so the memory says what the auditor read rather than what anyone remembers. The step is idempotent by artifact digest, so re-running it changes nothing.
4. Report the verdict chain: diagnosis verdict, audit verdict, claims struck, slot consumed or released, and the case-file status the recorder printed.

If the diagnosis is PARK, the recorder sets a thirty-day cooling date. It writes a revisit trigger only if the diagnosis file carries a `revisit_trigger:` field, and warns when it does not. A park with no written trigger is a date with no reason, so add the field to the diagnosis and re-record.

Do not proceed to packet generation. That is a separate command and a separate decision.
