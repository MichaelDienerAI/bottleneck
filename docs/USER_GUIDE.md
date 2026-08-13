# Using Bottleneck

A guide to the thing you built. Read the first two pages and you will understand the whole system. Read the rest when you need it.

---

## 1. What this does

It finds the small number of companies where something you already built solves a problem they already have, and it helps you write to a named person there about that specific problem.

It does not find you more jobs. That distinction is the entire design, and section 2 explains why.

---

## 2. The one idea underneath everything

Thousands of AI jobs post every week. You can write about five real letters a week, where a real letter means you researched the company, found what is actually holding them back, and showed how something you built acts on it.

So the jobs are not scarce. Your hours are.

That single fact decides every rule in this system:

**More jobs do not help you.** → Finding them faster changes nothing. → So the search runs on a timer and stops when your week is full.

**Bad letters cost more than no letters.** → A hiring manager who catches one overstated claim discounts everything else you said. → So a separate worker attacks every letter before it goes out, and it is scored on how many claims it kills.

**A guess dressed as a finding is worse than an admission.** → An AI asked what is broken at a company will always answer, fluently, with no signal that it invented it. → So every claim carries a link and a rough time to check it, and a claim without one gets thrown out.

Everything below is those three sentences turned into machinery.

---

## 3. The five workers

Four of them are AI. The fifth is a counter, and it is the one in charge.

### The counter, which sets the pace

It counts how many letters you have written this week. Five is the limit.

Everything else asks the counter first. If the week is full, the search does not run at all. That feels wrong the first time you see it and it is the most important behavior in the system: gathering work you have no time to do turns your queue into a pile, and a pile is not progress.

### Worker one, the scout

**What it does.** It reads the job pages that 27 companies publish themselves and applies fixed rules to everything it finds.

**Why it exists.** Reading job boards is cheap and judging companies is expensive. The scout protects the expensive worker from drowning in postings nobody will have time to read.

**How it works.** It fetches the boards, then runs every job through five rules written in code with no judgment involved. Is the title work you do. Is it somewhere you would go. Does the published pay clear your floor. Is the seniority right. Does it demand something you have never shown publicly.

One failed rule kills the job. The rules cannot outvote each other, because a rule that can be overruled is not a rule.

What survives gets sorted by how much of your week that kind of company deserves, then by how closely the job matches work you can prove, then by how recently it posted. Two per company, so one large employer cannot take every slot. At least one from each kind of company, so your queue does not become nine rows from one corner of the market.

Then it stops at ten and hands off.

### Worker two, the researcher

**What it does.** It takes one company and works out what is actually capping what they can ship.

**Why it exists.** A job posting says what the role does. It almost never says what hurts. The thing that gets you a reply is naming the second one.

**How it works.** It forms a guess before it searches, then goes looking for the one fact that would prove it wrong. That order matters. Searching first and finding a pattern afterward is how you end up believing whatever you happened to read first.

It looks in four places, and none of them is the job posting:

- **What they are hiring for across the whole company.** Three evaluation people and no infrastructure people tells you where it hurts. Headcount is the most expensive way to buy capacity, so a company only spends it where nothing cheaper works.
- **How long their unfinished work has been sitting.** Old pull requests, old issues with lots of reactions, a page that has said "coming soon" for eight months. Work piles up in front of the thing that is stuck.
- **What they have publicly refused to build.** A company says yes where it has room and no where it does not, and the refusals cluster around the tight spot.
- **A measurement you took yourself.** If you can use their product, you can time it and test it. Nobody else applying will have done that.

It ends with one thing named, one number, one date, and one link a stranger can check in under a minute. If it cannot get there, it says so and stops. That counts as a result, not a failure.

### Worker three, the checker

**What it does.** It attacks the research before anyone else can.

**Why it exists.** The researcher is optimistic, the way anyone is about their own work. One overstated claim that reaches a hiring manager costs more than ten rejected drafts.

**How it works.** It scores the draft against a fixed list of 28 questions a hiring manager needs answered, and returns a percentage plus the numbers of the ones you missed. Then it goes after every remaining sentence: what does a stranger click to check this, and how long does that take. Anything that fails gets struck.

It also knows the two places your own record says to be careful. The calibration layer is written but not wired into what runs. The engineering is you directing Claude Code rather than hand-writing systems code. Any draft that blurs either one gets caught, because those are the exact gaps a technical reader would find later.

Its score is claims killed, not letters approved.

### Worker four, the writer

**What it does.** It writes the brief you send, the short note that gets it read, and the two resume lines that change for this company.

**Why it exists.** Everything before this is preparation. This is the only worker that produces something a person outside your laptop will ever see.

**How it works.** It refuses to run unless the research says ship and the checker says clear. Then it opens inside their problem, shows the mechanism, links one thing you built, describes the first thirty days as work rather than as enthusiasm, and ends by naming what you do not know.

That last paragraph earns the reply. Anyone sends a confident letter. Almost nobody sends one that names its own limits, and for a job about judging what models get wrong, that discipline is the qualification.

---

## 4. Your week

### Monday, Wednesday, Friday at 7:05am, without you

The schedule fetches all 27 boards, applies the rules, rebuilds both pages, and writes a preparation brief on your top three companies.

The brief gathers evidence and nothing else. It does not name a constraint, write a letter, or touch the ledger. An unwatched worker producing constraint claims nobody read is exactly the failure this system was built to prevent, so the brief hands you observations and questions and stops there.

If your week is already full, the whole run skips itself.

### Monday morning, with coffee, ten minutes

```bash
open data/board.html
open data/briefs/$(date +%F).md
```

The board tells you how many slots you have left, what came in, what got thrown out and why, and what is sitting in the queue with anything you need to settle first.

The brief gives you three companies with the evidence already collected.

### Then, one to two hours per company

In Claude Code:

```
/diagnose <company>
```

Start a clock when you begin, including any time you spend measuring their product yourself. That number goes in the ledger later and it is half the experiment.

Expect roughly one in four to reach ship. If everything ships, the researcher stopped testing and started agreeing with you.

```
/ship <company>
```

Read the coverage percentage. Do not lower the threshold to make a letter pass. If it comes in under half, the checker will tell you which questions you need to answer yourself.

Then you send it. The system drafts and you send, every single time.

### Sunday, fifteen minutes

```
/review
```

Four questions, answered from the ledger rather than from memory. Where did work pile up. Is what you are seeing signal or noise. What is your weekly score. What are you going to stop doing.

That last one is not optional. A review that ends without a cut has decided nothing.

---

## 5. Every command, and what it actually does

### In the terminal

| Command | What happens |
|---|---|
| `npm run verify` | Checks all 27 company job boards still answer. Run it monthly. A dead board looks identical to a company that is not hiring. |
| `npm run scan` | Fetches everything, applies the rules, rebuilds the queue. |
| `npm run board` | Rebuilds the status page from whatever the data currently holds. |
| `npm run walk` | Rebuilds the explanation page where you click a kind of work and watch the pipeline run. |
| `npm run report` | Prints the ledger analysis in the terminal, including the experiment. |
| `npm run slots` | Prints how many letters you have left this week. |
| `npm test` | Runs the rule tests. Do this after any change to the rules. |
| `./bin/run.sh` | Does the whole Monday morning by hand. |

### In Claude Code

| Command | What happens |
|---|---|
| `/scan` | The scout runs, checking your remaining slots first. |
| `/diagnose <company>` | Spends one slot. Researcher then checker, on one company. |
| `/ship <company>` | Builds the letter for a cleared diagnosis, then checks it again. |
| `/review` | Weekly. Re-derives what is limiting you from ledger data. |

---

## 6. Reading the board

**Slots left** is the only number that limits anything. Five boxes, filled as you use them.

**The funnel** is drawn to real scale. The second bar shrinks to about a tenth of the first and the last two nearly vanish. That is the system working. It throws away 97 percent on purpose.

**Why jobs were thrown out** has two columns. The second counts how often a rule was the only thing in the way, which tells you which rules are actually doing work rather than riding along.

**In the queue**, an arrow under a job means something has to be settled before you write. Those are not disqualifications. They are questions with no answer yet:

- *You would have to move before January.* Decide if this one is worth it.
- *Only names a country.* Find out which city before you write.
- *Says remote but mentions an office.* Ask what they actually mean.
- *No published salary band.* Get the number on the first call.

A job with no arrows is ready today.

**Letters sent** is the only table that measures whether any of the rest of it works. Everything above it is preparation.

---

## 7. When something goes wrong

**The board says zero jobs.** It should be structurally impossible now, since every fetched row gets scored on every run. If it happens anyway, check `data/scan-errors.json` for boards that would not answer.

**A company you expect never appears.** Read `data/killed.json` and search for the company name. Every killed row carries its url, location, and the reason. If the reason looks wrong, the rule needs adjusting rather than the company.

**Nothing runs on schedule.** Read `data/logs/`. The most common cause is that the scheduler does not inherit your shell, so `node` or `claude` is not on the path it uses.

**The queue fills with the wrong kind of work.** That means the scoring list needs attention, not the gate. The gate decides what exists; the scoring list decides what ranks. They are separate files on purpose.

---

## 8. Rules that never bend

**You send. The system drafts.** Nothing here has permission to contact anyone.

**No claim without a link.** If a stranger cannot check it in under a minute, it does not go in a letter.

**No invented names.** The system will leave a hiring manager's name empty rather than guess one, and it will leave a constraint unnamed rather than invent one.

**LinkedIn is never scraped.** It reads job pages companies publish for that purpose. Use LinkedIn by hand for the one thing it does best, which is finding the person's name.

**Not finding something is a finding.** "I cannot establish this" is a real answer and gets recorded as one.

**Never lower a threshold to make something pass.** If a letter cannot reach the bar, the letter is the problem.

---

## 9. The experiment you are running

Every letter records four things: how good the evidence was when you started, how many minutes you spent, where the idea came from, and whether a human replied.

After twenty letters, `npm run report` compares them.

Fifty years ago RAND studied thousands of criminal investigations and found something uncomfortable. Detective hours barely moved whether a case got solved. What mattered was the information available in the first hour. Worse, detectives spent *more* time on cases they never solved, because effort is what you spend when the evidence is thin.

If that holds here, then good evidence at the start predicts replies and hours spent researching does not. And if that is true, your time belongs in building better measuring instruments rather than in reading job postings, and this system should be rebuilt around that.

You will not know until twenty letters exist. Below twenty, the numbers are noise and any change you make is guessing with extra steps.

Which makes the next move the same as it has been since the beginning. Write one letter and send it.
