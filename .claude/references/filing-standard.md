# The Filing Standard

The mechanism, in one paragraph. Two prosecutor's offices received reports from police who were never retrained. Office A filed only what it could prove to a jury, and the reports arriving there answered 45 percent of the office's 39 evidence questions, and Office A dismissed nothing. Office B accepted routine minimums, got 26 percent coverage, and lost a quarter of its cases. The downstream gate raised upstream quality on its own. Nobody edited the writer.

So this file is the gate, not a style guide. The Auditor scores a packet as a percentage of the questions below that it answers, and rejects with the list of unanswered ones. Packet quality becomes a function of the threshold, which is a number you turn.

**Current threshold: 50 percent.** Raise it by five points every ten packets until reply rate stops improving, then stop. Do not lower it after a rejection.

The question list stays fixed while the threshold moves. That is the invariant. Rewriting the questions to match what a packet already says converts the gate into a mirror.

---

## I. Standing (can they place you in ten seconds)

1. Does one sentence say what you do, in their vocabulary, not yours?
2. Is the single strongest artifact named and linked?
3. Can they inspect or run it without contacting you?
4. Is your availability stated, with a date?
5. Is location and work mode stated?

## II. The constraint claim

6. Is exactly one part of their system named as binding?
7. Is the output it caps stated as something countable?
8. Does the reading carry a date?
9. Is there a link behind the claim?
10. Is the verify time under sixty seconds?
11. Is at least one alternative explanation named and rejected?
12. Is there a stated fact that would falsify the claim?
13. Is the hypothesis sourced from something other than the posting alone?

## III. The proof match

14. Is the artifact that acts on that part named?
15. Is the mechanism stated in one sentence, cause to effect?
16. Has the artifact been applied to a comparable case they can see?
17. Is there a measured result, with a number?
18. Is it stated where the artifact stops working?

## IV. The capability boundary

19. Is anything staged rather than shipped labeled as staged?
20. Is agent-assisted work labeled as agent-assisted?
21. Are vendor dependencies named?
22. Is at least one thing you cannot do stated plainly?

## V. Transfer

23. Are the first thirty days described as work rather than as intent?
24. Is what you would need from them stated?
25. Is there a smaller, cheaper version they could test first?

## VI. Decision

26. Is it addressed to a named person with a title?
27. Is there exactly one ask?
28. Is the next step low-cost enough that doing nothing is not the easier option?

---

## Scoring

```
coverage = answered / 28
```

Answered means the packet contains it, not that you could answer it if asked. An unanswered question is a defect, and the rejection returns the numbers of the unanswered ones. A silent rejection teaches nothing and only lowers throughput.

Questions 9, 10, 13, 19, and 20 are **mandatory regardless of coverage.** A packet failing any one of them fails outright, because each is a Packer-style checkpoint with its own veto. Coverage is an aggregate, and an aggregate that can outvote a checkpoint turns the obstacle course back into an assembly line with extra steps.
