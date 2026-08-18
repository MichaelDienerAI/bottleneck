---
description: Spend one drum slot diagnosing one company. Usage - /diagnose <company>
argument-hint: [company name, or blank for top of queue]
---

Take $ARGUMENTS, or the highest-ranked unprocessed row in `data/queue.json` if blank.

1. Run the diagnostician subagent on that single company. One company, one slot, finished.
2. Run `node src/integrity.js --seal <company>`. This hashes what the diagnostician wrote and stores it in a sidecar beside the artifact, before the auditor opens it. The auditor holds Write over the whole repository and is about to edit this file; the seal is what makes it possible to tell afterward whether it appended or revised. It refuses to run on a file that already carries an `audit:` block, because sealing after the audit would certify whatever the audit wrote. Print the digest.
3. **Blind pass.** Run `node src/blind.js --packet <company>`. It builds an observables-only packet from the day's brief and the queue row, refuses to write one carrying any part of the diagnostician's conclusion, and prints a scratch directory holding the packet and nothing else. Then run the auditor subagent **inside that directory**, with the instruction that it is phase 1 of 2, blind, and must write `blind.json` with one constraint hypothesis of its own and the sources it rests on.

   The point is the direction of travel. The auditor and the diagnostician are the same model family reading the same evidence, so an auditor that reads the diagnosis first can only proofread it. Running it backward — record to constraint, artifact unread — is the only way its agreement carries information.

4. **Collision pass.** Run the auditor subagent again, this time in the repository, with both its own blind hypothesis and the diagnosis in hand. It appends `audit:` and `strikes:`, carries `blind_phase` and `collision`, and changes nothing the diagnostician wrote. A divergence requires a syllogism whose middle term appears in both premises and not in the conclusion.
5. Run `node src/casefile.js --record <company> --stage diagnose`. This writes `data/cases/<company>.json`: the visit, the verdict chain, the evidence keys, the queries already run, the claims the auditor struck, and the decision-maker if one was found. Run it after the audit and never before — the recorder refuses an artifact with no `audit:` block, because a claim nobody ruled on does not get to become a prior a later diagnosis inherits as settled.

   Do not write the case file by hand, and do not edit one. Every field is derived from the YAML on disk, so the memory says what the auditor read rather than what anyone remembers. The step is idempotent by artifact digest, so re-running it changes nothing.
6. Report the verdict chain: diagnosis verdict, audit verdict, claims struck, slot consumed or released, the seal state, whether the collision corroborated or diverged, and the case-file status.

The recorder runs the schema gate in `src/validateArtifact.js` before it writes anything: the evidence payload against `.claude/schemas/evidence.json`, the audit payload against `.claude/schemas/audit.json`, and the seal against the sidecar from step 2. If it refuses, it names the schema path and the filing-standard question number. Fix the artifact and re-record; do not hand-write the case file to route around it.

If the diagnosis is PARK, the recorder sets a thirty-day cooling date. It writes a revisit trigger only if the diagnosis file carries a `revisit_trigger:` field, and warns when it does not. A park with no written trigger is a date with no reason, so add the field to the diagnosis and re-record.

Do not proceed to packet generation. That is a separate command and a separate decision.
