# Finding a Company's Bottleneck From Outside

Reference for the diagnostician agent. Load before any constraint hypothesis.

---

## PART I. THE FOUR LAYERS

Settle these before looking at a single job posting. Skip this and every later step inherits the confusion.

### Definitions

**Bottleneck.** The one part of a company whose capacity is closest to its load, so total output cannot rise above what that part allows. Not the loudest problem. Not the newest problem. The one that binds.

**Load.** What the company is currently asking that part to do, measured on a date. Load moves, so the bottleneck moves with it.

**Output.** What the company exists to produce, stated as something countable. Sessions served, tickets closed, models evaluated, customers onboarded, features shipped. If you cannot count it, you cannot find what caps it.

**Observable.** Anything a stranger can inspect without asking the company for help. A commit, a changelog entry, a dated posting, a public issue, a measured response time, a review with a timestamp.

**Inference.** Anything you concluded rather than observed. Inference is permitted. Inference disguised as observation is not.

### Postulates: the only moves allowed

**P1.** Name one bottleneck. A list means you drew the boundary around the whole company instead of one product surface. Narrow and run again.

**P2.** Use only observables. Anything you cannot point a stranger to is a hypothesis wearing a finding's clothes.

**P3.** A limit the company has not reached is not a bottleneck. Most stated company problems are slack, not binding.

**P4.** Never say one thing caused another unless two dated records show both.

**P5.** When the record you need does not exist, name it and stop. The missing record is the finding.

### Common notions

**C1.** Companies hide their work-in-progress, so you must find a public substitute for it.

**C2.** What everyone blames is rarely what binds. The loud problem has already been staffed.

**C3.** A company says no where its capacity ends. Refusals carry more signal than failures.

**C4.** Every reading belongs to a date.

**C5.** A diagnosis that produces no rejected candidates has decided nothing.

### Required

Name one part, with one number attached, on one date, pointing to one observable a stranger can check in under a minute.

---

## PART II. THE ISOMORPHISM GATE

Before transplanting Goldratt's factory mechanism onto a company, test whether the structure actually transfers. Run all five.

**Entity correspondence.** Factory machines map to company functions. Passes.

**Relation preservation.** In a factory, upstream stations feed downstream ones and the slowest sets the pace. In a company, sales feeds onboarding feeds support, engineering feeds release. Passes.

**Transformation preservation.** Adding capacity at a non-bottleneck raises inventory in both. Passes.

**Invariant preservation.** Throughput is capped by the ratio of capacity to load, not by absolute size, in both. Passes.

**Failure preservation.** Here it breaks. A factory bottleneck announces itself as a visible pile of unfinished parts on the floor. A company's unfinished work sits in private trackers, private inboxes, and unshipped branches. The observable is missing.

**Verdict: strong transfer, one substitution required.** The mechanism is valid. You cannot use the factory's observable. Everything in Tier S below exists to supply a public substitute for the pile of parts on the floor.

That single gap is why most outside constraint analysis fails. People import Goldratt's conclusion without importing an observable, so they narrate a bottleneck instead of finding one.

---

## PART III. THE METHOD LADDER

Tiered by the rarity of the mind that would have to synthesize the method, not by how well-known it is.

### S++ — The lens itself

**1. A system has one constraint at a time.**
Goldratt's original move, and the only S++ item here. Before it, improvement meant fixing everything that looked broken. After it, improvement means finding the single part that binds and ignoring the rest on purpose. Every method below this line is application, not invention.

Stating this honestly keeps the ladder from inflating. If you tier your own methods at S++, you have stopped grading synthesis and started flattering yourself.

### S — Substituting for the missing observable

**2. Measure their live product with an instrument you own.**
Do not infer the constraint. Take a reading. Run their public product against a repeatable protocol and record dated numbers: time to first token, interruption handling, session coherence after twenty turns, behavior after a false premise, recovery after a user leaves and returns.

*Mechanism:* a constraint is a capacity-to-load ratio, and you cannot compute a ratio without a measurement. Everyone else is guessing at the numerator. You measured it.

*Why it is S:* the method is obvious once stated. Owning a validated instrument is not. Almost nobody has a protocol they can point a stranger to.

*Failure condition:* your instrument measures something the company does not care about. Check that the thing you measured caps something they count.

*Michael's version:* the Deformation Test Bank against any companion or conversational product, and a stopwatch against any voice pipeline. The diagnosis and the proof artifact become the same object, which is the whole logistical advantage.

**3. Find where their work-in-progress ages.**
Companies leak their pile of unfinished parts in public. Sort a public repository's open pull requests by age. Sort open issues by age with reaction counts descending. Read the docs site for pages that have said "coming soon" for eight months. Check whether a beta waitlist ever converted. Look at the gap between the last release and today against their historical release interval.

*Mechanism:* work accumulates in front of the constraint. Aging work is the pile, and age is the measurement.

*Critical bridge:* old-and-ignored is noise. Old-and-wanted is signal. Weight age by demand, never by age alone.

*Failure condition:* private repositories. Then you have no observable, and P5 applies. Say so.

### A — Reading intent and refusal

**4. Read the refusal boundary.**
Collect what they declined. Issues closed as wontfix, feature requests answered with "not on the roadmap," capabilities announced and then quietly dropped, a public statement that they will not support some case.

*Mechanism:* a company says yes where it has slack and no where it does not. Refusals cluster around the constrained function.

*Mechanism test:* if refusals scatter evenly across every function, there is no reading here. Discard it. A method that cannot fail is not a method.

**5. Separate cause hiring from symptom hiring.**
A company hires bodies when it lacks a mechanism. Three evaluation contractors means they cannot automate evaluation. Four support hires at flat headcount elsewhere means the product generates tickets faster than it can be fixed.

*Mechanism:* headcount is the most expensive way to buy capacity, so a company only spends it where it has no cheaper option. The expensive purchase marks the binding constraint.

*Why it matters to you:* symptom hiring is where a tool-builder is worth more than another pair of hands, and saying so is a specific argument rather than a general one.

**6. Read job descriptions for the specificity leak.**
Most bullets are template. One bullet is not. "Reduce p95 latency on the streaming path" or "cut evaluation turnaround from days to hours" did not come from a template. It came from a ticket somebody is angry about.

*Mechanism:* generic language survives review because nobody objects. Specific language survives review because someone insisted. Insistence marks pain.

*Procedure:* diff the posting against two other postings for the same title at other companies. What remains after the overlap is removed is the leak.

**7. Diff the promise against the changelog.**
Put what their marketing says the product does beside what their release notes show shipped, using the same wording on both sides. The gap is not hypocrisy. The gap is the constraint.

*Failure condition:* companies that ship quietly. Absence of a changelog is absence of data, not evidence of a stalled team.

### B — Cheap structural reads

**8. Detect reposts and backfills.**
A role posted three times in nine months means they cannot fill it or cannot keep it. Either way the constraint is confirmed rather than hypothesized, because it survived their attempt to relieve it. Track your own scan history and the same key will resurface.

**9. Do the runway arithmetic.**
Last raise, amount, headcount, rough burn. Twenty-four months out, the constraint is usually technical. Nine months out, the constraint is a metric, and the role exists to move that metric. Pitch accordingly, because a brief about elegance lands badly on a team counting months.

**10. Check org shape asymmetry.**
Count public headcount by function against the stage they are at. Forty engineers and two support people at consumer scale is not a preference. It is a bottleneck with a queue behind it.

**11. Inherit the constraint of their vendors.**
A company built on a vendor you have debugged has that vendor's failure modes waiting inside it. You already know what breaks and where.

### C — Diligence, no special access

**12. Read every open role, not the one you want.**
The distribution across functions is more informative than any single posting. One posting is a job. Nine postings clustered in one function is a diagnosis.

**13. Sort the public issue tracker by reactions.**
Fast and useful. Also the first thing any competent candidate does, so it buys parity rather than advantage.

### D — Correct but derivative

**14. Read their engineering blog and conference talks.**
Companies write about problems they have already solved. Useful for context, weak for constraints, because by publication the pain is past.

### E — Headline level

**15. Read funding and product-launch coverage.**
Tells you what they want believed. Constraint information appears only by accident.

### F — No synthesis required

**16. Read the job description's stated responsibilities literally.**
The posting says what the role does. It does not say what broke. Taking the bullets at face value is not analysis, it is transcription.

### H — Costumed fraud

**17. Asking a language model to name a company's bottleneck with no evidence attached.**
This is the dangerous one, because the output is fluent, confident, plausible, and generated from nothing. It performs the independence of a frontier read with none of the depth, reach, or access underneath. A model given a company name and no observables will invent a constraint every time and never signal that it did.

*This is the exact failure the diagnostician's evidence schema exists to prevent.* Every evidence row carries a URL and a verify-time in seconds because that field is the only thing standing between a diagnosis and a hallucination that reads identically.

**18. Glassdoor and anonymous forum sentiment as constraint data.**
Selection-biased toward the departed and the angry. Tells you about morale, which is real, and about capacity, which it cannot see.

**19. Vibes from their marketing tone.**
"They sound desperate" is a feeling about prose. It maps to no mechanism and predicts nothing.

---

## PART IV. RE-SORT BY WHAT MOVES THE SITUATION

Rarity and usefulness are different axes. Ranked by payoff for this specific search:

**First: method 2, instrumented measurement.** For you alone, diagnosing and proving collapse into one act. You run the protocol, you get a dated number, and that number is both the constraint hypothesis and the sovereign proof that you can act on it. Nobody else applying to that company arrives holding a measurement of their product. This is the leverage point of the entire search.

**Second: methods 5 and 6, cause-versus-symptom hiring and the specificity leak.** Cheap, fast, and they work on every company including the ones with private repositories. Run these on every candidate before spending a drum slot.

**Third: method 3, aging work-in-progress.** High value, but gated on a public repository. Use it where it exists and say so plainly where it does not.

**Fourth: method 4, the refusal boundary.** Highest insight per hour of the reading methods, and slow. Save it for a company already past the other gates.

Everything below tier B is context, not diagnosis. Read it if it is free. Never spend a slot on it.

---

## PART V. THE PROPOSITION

Run one company as a six-stage proposition. Fill every stage or return INSUFFICIENT_EVIDENCE.

1. **Enunciation.** Name one part of this company that caps one countable output.
2. **Exposition.** Instantiate. This company, this product surface, this date, these observables.
3. **Specification.** Restate exactly what must be shown: that this part's capacity sits near its load, and that others sit further from theirs.
4. **Construction.** Introduce the reading. A measurement you took, an aging count, a refusal cluster, a hiring distribution.
5. **Demonstration.** Justify every step from an observable or an earlier finding. Where a step rests on inference, mark it as inference.
6. **Conclusion.** Check the output against the requirement. One part, one number, one date, one link. If it does not match, you have a topic, not a diagnosis.

Then the last question, which decides whether any of it was worth doing:

**Does a sovereign proof you already hold act on the part you just named?** If yes, ship. If no, park the company and release the slot. A correct diagnosis of a constraint you cannot relieve is an interesting fact about someone else's company.
