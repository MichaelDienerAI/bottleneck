---
description: Spend one drum slot diagnosing one company. Usage - /diagnose <company>
argument-hint: [company name, or blank for top of queue]
---

Take $ARGUMENTS, or the highest-ranked unprocessed row in `data/queue.json` if blank.

1. Run the diagnostician subagent on that single company. One company, one slot, finished.
2. Run `node src/integrity.js --seal <company>`. This hashes what the diagnostician wrote and stores it in a sidecar beside the artifact, before the auditor opens it. The auditor holds Write over the whole repository and is about to edit this file; the seal is what makes it possible to tell afterward whether it appended or revised. It refuses to run on a file that already carries an `audit:` block, because sealing after the audit would certify whatever the audit wrote. Print the digest.
3. Run the auditor subagent on the resulting diagnosis file. It appends `audit:` and `strikes:` and changes nothing else.
4. Run `node src/casefile.js --record <company> --stage diagnose`. This writes `data/cases/<company>.json`: the visit, the verdict chain, the evidence keys, the queries already run, the claims the auditor struck, and the decision-maker if one was found. Run it after the audit and never before — the recorder refuses an artifact with no `audit:` block, because a claim nobody ruled on does not get to become a prior a later diagnosis inherits as settled.

   Do not write the case file by hand, and do not edit one. Every field is derived from the YAML on disk, so the memory says what the auditor read rather than what anyone remembers. The step is idempotent by artifact digest, so re-running it changes nothing.
5. Report the verdict chain: diagnosis verdict, audit verdict, claims struck, slot consumed or released, the seal state the recorder printed, and the case-file status.

The recorder runs the schema gate in `src/validateArtifact.js` before it writes anything: the evidence payload against `.claude/schemas/evidence.json`, the audit payload against `.claude/schemas/audit.json`, and the seal against the sidecar from step 2. If it refuses, it names the schema path and the filing-standard question number. Fix the artifact and re-record; do not hand-write the case file to route around it.

If the diagnosis is PARK, the recorder sets a thirty-day cooling date. It writes a revisit trigger only if the diagnosis file carries a `revisit_trigger:` field, and warns when it does not. A park with no written trigger is a date with no reason, so add the field to the diagnosis and re-record.

Do not proceed to packet generation. That is a separate command and a separate decision.
