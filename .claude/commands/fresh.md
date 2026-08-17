---
description: Re-run the deduplication rules against the buffer and repair it
---

Run `npm run fresh`. That is `node src/scan.js --audit-freshness`: no network, no board fetch, no drum slot. Add `--dry-run` if the buffer should be inspected without being written.

The scan enforces every deduplication rule at the moment it promotes a row, and nothing re-enforces them afterward. The rules move underneath the buffer: a company diagnosed and parked on Sunday leaves Saturday's promoted row sitting in front of the drum pointing at a company the scan would now refuse. Gate 0 cannot catch that, liveness cannot catch that, and the next scan carries held rows forward without re-gating them. This command is the only thing that closes that gap.

Report back, in this order:

1. **History.** How many postings `data/seen.json` tracks, how many rows are on the current board past Gate 0, and how many case files exist with how many recorded visits.
2. **Closed or cooling.** Every company `shouldSkip` refuses today, with its status and the reason and date it gave. Read it from the case files, never from memory.
3. **Held back.** The rows struck by hand, and how many current board rows are already in `seen.json` and so will never be promoted again.
4. **The buffer, row by row.** All ten, each marked fresh or stale, with its visit count and its repeat visits that produced no new evidence. A row is fresh only if no rule stands against it and no visit added nothing.
5. **What was repaired.** Every purged row with the rule it broke, and every backfilled replacement with the company it replaced.

Then stop. Do not fetch a board, do not diagnose anything, do not spend a slot.

## What the command will and will not purge

It purges a buffer row on four rules: the row was struck by hand, the board delisted it, `shouldSkip` closes or cools its company, or the same key appears twice. Each vacated slot is refilled with `pickBackfill()` from `data/candidates.json`, one at a time so the per-company cap and the archetype spread are re-derived against the buffer as it actually stands.

It does not purge on `data/seen.json`, and it must never be changed to. `src/scan.js` writes every promoted key into `seen.json` on the same run that promotes it, so every buffer row is in `seen.json` by construction. That file gates promotion, so a posting already declined does not come back. It says nothing about whether a row already in front of the drum belongs there, and reading it as a residency rule would empty the buffer on the first run while reporting it as a deduplication success.

It reports a per-company cap breach and does not purge on it. Two rows from one employer is the configured maximum, not a fault. More than that means promotion is broken, and deleting the rows would erase the evidence of the bug that made them.

Every purge leaves a dated record in `data/freshness-audit.json`: what left, which rule it broke, and what replaced it. Purged rows are not written to `data/struck.json`, which would mean Michael declined them and would block them forever, nor to `data/delisted.json`, which would mean the board took them down. Neither is true of a row whose company is cooling until a date that will pass.
