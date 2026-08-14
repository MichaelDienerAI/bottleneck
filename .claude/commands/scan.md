---
description: Pull boards, gate, and promote only what the drum can absorb
---

Run the scout subagent.

Report back: how many slots are open this week, how many raw postings were fetched, how many died at Gate 0 and why, how many buffer rows were delisted because their posting came off the board, and which candidates were promoted to `data/queue.json`.

If zero slots are open, say so and stop. Do not fetch. Do not offer to fetch anyway.
