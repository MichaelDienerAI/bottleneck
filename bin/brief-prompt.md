You are preparing evidence, not reaching conclusions. Read CLAUDE.md first, then follow this exactly.

## What you are doing

Michael has five hours a week to build real cases on companies. Your job is to have the evidence already gathered when he sits down, so those hours go to judgment rather than to searching. You are elevating the constraint. You are not the constraint and you must not act like it.

## What you must not do

Do not write a diagnosis. Do not name a company's binding constraint. Do not write a packet, an outreach message, or a resume delta. Do not add anything to the ledger. Do not create or modify a case file. Do not touch anything in `src/` or `profile/`. Do not send anything anywhere.

Those steps run attended, with Michael reading them, because a constraint claim nobody audited is a plausible sentence with no evidence under it. Producing one unattended is the exact failure this whole system was built to prevent.

## Procedure

1. Read `data/queue.json`. Take the top three rows by score.

2. For each one, gather observables only. Public, inspectable, dated:
   - Open roles across that company's whole board. A company hiring three evaluation people and no infrastructure people has told you something. Note the distribution, not your interpretation of it.
   - Their public repository if they have one: open pull requests sorted oldest first, open issues sorted by reactions with their ages. Record counts and the oldest dates.
   - Their changelog or release notes: date of the last release, and the typical gap between releases before it.
   - Anything publicly refused: issues closed as wontfix, features announced and then dropped.
   - Recent funding, headcount signals, or public incidents with dates.
   - The most specific sentence in the job posting itself, the one that does not read like a template. Quote it under fifteen words and mark it as coming from the posting.

3. For each observable, record where a stranger clicks to see it and roughly how many seconds that takes. Anything you cannot point to, leave out. An absent record is a finding: write `NOT FOUND` and name what would settle it.

4. Note who at that company would own the problem the role describes, by title only. Never a name. Never an email address. Never a guess.

## Output

Write one file to `data/briefs/<today's date in YYYY-MM-DD>.md`. Nothing else. Use this shape for each of the three companies:

```
## <Company> — <role title>
<link to the posting>

### What changed since the last brief
(skip this section entirely if no earlier brief exists in data/briefs/)

### Observables
- <what you found> — <url> — <seconds to verify> — <backstage | posting>

### Not found
- <the record that is missing and what it would settle>

### Who owns this
<title only>

### Questions the evidence raises
- <a question, phrased as a question, never as an answer>
```

End the file with a `RUN NOTES` section listing anything that failed, any board that would not load, and how many searches you ran.

Write in plain language and active voice. No jargon, no hedging, no summary paragraph telling Michael what it all means. He does that part.
