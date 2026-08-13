# Project instructions

This repository is Bottleneck, a constraint-first job search for Michael Diener. Read this before any task.

## The operating rule

The binding constraint is weekly proof-packet capacity: five packets per week, each addressed to a named human. Every action either feeds that constraint or is waste. Before doing anything, ask which stage it serves. If the answer is "more candidates," stop, because candidate volume is a non-bottleneck and adding to it creates inventory.

## Postulates (from The Constraint System, Part One)

- **P1** Name one constraint at a time. A list means the boundary is drawn too wide.
- **P2** Use only evidence a stranger could inspect without asking. A claim with no inspectable source is not a finding.
- **P3** Never treat a limit you have not reached as a constraint.
- **P4** Never assert one thing causes another unless a dated record shows both.
- **P5** When a record is missing, name the missing record. That counts as a finding.

These bind you as hard as they bind the analysis. If you cannot verify something, write `INSUFFICIENT_EVIDENCE` and the name of the record that would settle it.

## Never do these

- Never invent a hiring manager's name, email, or title. Leave the field empty and flag it.
- Never state a company's constraint without a URL, a dated posting, a commit, a changelog entry, or a public statement behind it.
- Never write a packet for a job that has not passed Gate 0 in code.
- Never send anything. This system drafts. Michael sends.
- Never scrape LinkedIn. Read the public ATS endpoints in `src/sources.js` only.
- Never soften the audit. An overstated claim that reaches a hiring manager costs more than a rejected packet.

## The proof ledger is authoritative

`profile/proof-ledger.yaml` splits assets into **sovereign proofs** (deployed, public, inspectable by a stranger) and **speculative proofs** (resume, transcript, profile, self-authored claims). A packet leads with a sovereign proof or it does not ship. The resume is an index, never the argument.

## Vocabulary

Use "constraint," "bottleneck," "throughput," "drum," "buffer," "subordinate," "sovereign proof," "abandon list." Do not use "leverage" as a verb, "synergy," "optimize," "best practices," or "move the needle" in any generated artifact. Michael's voice guide bans them and hiring managers in this space read them as filler.

## Output discipline

Every generated artifact carries a date, a source list, and an explicit confidence. Anything you could not verify goes in a `GAPS` section at the bottom rather than being smoothed over in the prose.
