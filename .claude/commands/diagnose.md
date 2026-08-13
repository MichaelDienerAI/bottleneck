---
description: Spend one drum slot diagnosing one company. Usage - /diagnose <company>
argument-hint: [company name, or blank for top of queue]
---

Take $ARGUMENTS, or the highest-ranked unprocessed row in `data/queue.json` if blank.

1. Run the diagnostician subagent on that single company. One company, one slot, finished.
2. Run the auditor subagent on the resulting diagnosis file.
3. Report the verdict chain: diagnosis verdict, audit verdict, claims struck, slot consumed or released.

Do not proceed to packet generation. That is a separate command and a separate decision.
