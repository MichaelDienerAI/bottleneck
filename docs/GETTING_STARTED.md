# Getting Started

From an empty folder to your first letter sent. Fifteen steps. Set aside about two hours for the first pass, most of which is you making decisions the system cannot make for you.

Bottleneck v0.2.

Each step tells you what to run, what a good result looks like, and what to do when it does not look like that.

---

## Before you begin

You need three things:

- **Node 18 or later.** Check with `node --version`.
- **Claude Code**, installed and signed in. Check with `claude --version`.
- **A list of things you have actually built or shipped**, with public links where possible. This is the one input nothing else can supply, and step 3 will ask you for it.

That third item decides whether this works. The system matches your proof against a company's problem, so if you have no proof, it has nothing to match.

---

## Step 1. Put the files somewhere permanent

```bash
mkdir -p ~/Projects
cd ~/Projects
# unzip or clone the project here so you end up with ~/Projects/bottleneck
cd bottleneck
ls -a
```

**Good result:** you see `.claude`, `src`, `docs`, `profile`, `package.json`.

**If `.claude` is missing:** you dragged the folder in Finder, which silently drops hidden folders. Copy it again in the terminal with `cp -R`. Everything the AI workers do lives inside `.claude`, so without it you have an ordinary Node project and none of the pipeline.

Do not work out of your Downloads folder. Files there get cleaned up automatically and you will lose work.

---

## Step 2. Install and test

```bash
npm install
npm test
```

**Good result:** the tests pass.

**If they fail:** stop here. The tests cover the rules that decide what every later stage ever sees. A broken rule quietly throws away good jobs and you will never know which ones.

---

## Step 3. Write down what you have actually built

Open `profile/proof-ledger.yaml`. This is the most important file you will edit and the only one nobody can write for you.

Split everything you have into two lists.

**Sovereign proofs** are things a stranger can inspect without asking you. A deployed product. A public repository. A published method. A dated measurement. Each one gets a link and a sentence saying what problem it solves.

**Speculative proofs** are things you assert. Your resume. Your profile. Work under an NDA. Employment history. These are real and useful, but they are an index pointing at the first list, never the argument itself.

Then add a third section, the uncomfortable one: **known gaps**. Write down the claims you cannot currently support. If you have never trained a model, write that. If your engineering is AI-assisted, write that.

**Why this matters:** the checker reads this file and strikes any draft that overstates you. A hiring manager who catches one inflated claim discounts everything else in your letter, so the gaps you name yourself cost you nothing and the ones they find cost you everything.

---

## Step 4. Set your rules

```bash
cp profile/gates.example.yaml profile/gates.yaml
```

Open the new file and answer five things:

**Your pay floor.** A job whose published maximum falls below this dies before it reaches you.

**What to do when pay is not published.** Most postings do not publish. Passing keeps your options open and carries the risk to a phone call. Rejecting is cleaner and throws away most of the market.

**Where you will work.** Your city, whether you will relocate, and which cities you would move to. Name towns people actually write in postings. A region like "Bay Area" appears in no posting and will match nothing.

**Your dealbreakers.** Phrases that kill a job outright. Add one only if you can name the specific job you want it to kill. Every dealbreaker is a veto with no appeal, and an over-tight list starves you without telling you.

**Your job titles.** The kinds of work you actually want. Be narrow. This list will do most of the filtering.

**Why this matters:** these rules run in code with no judgment involved, which makes them fast and cheap but also literal. They do exactly what you wrote, including the parts you wrote carelessly.

---

## Step 5. Pick your target companies

Open `profile/companies.yaml`. Group the companies you want into kinds, and give each kind a percentage of your week.

For each company you need its job board address. Look at their careers page and note whether the jobs live on Greenhouse, Lever, or Ashby, and what the short name in the address is.

Then check every one:

```bash
npm run verify
```

**Good result:** most say OK with a job count.

**If some say FAIL:** the short name is wrong. Open the careers page and find the real one.

**If some say EMPTY:** either the name is right and they are not hiring, or the name is wrong. Open the page and see which.

**Why this matters:** a wrong address returns zero jobs and looks exactly like a company with nothing open. That is how a search spends three weeks concluding the market is dead.

---

## Step 6. Run your first scan

```bash
npm run scan
```

**Good result:** it prints how many jobs it fetched, how many passed, how many it killed, and how many reached your queue.

Expect it to throw away more than 90 percent. That is the point. Your hours are the scarce thing, so the rules exist to protect them.

---

## Step 7. Audit what it threw away

Do not skip this. It is the difference between rules you own and rules that own you.

```bash
open data/killed.json
```

Find the reason that killed the most jobs, then read three of the jobs it killed. Each killed row carries its link, its location, and why it died.

**Ask one question:** would I have wanted that job?

**If yes:** your rule is too tight. The usual cause is a title list that catches a phrase but not its synonyms, because companies name the same job differently. Add the missing words and scan again.

**If no:** the rule is working. Move on.

Expect `stale:` to be near the top of that list. It is the ninety-day rule, and on a live run it accounts for roughly two rows in five. That is the rule working, not a fetch that went wrong. Read three of those too: if a nine-month-old requisition looks worth writing to, the number to change is `freshness.max_age_days` in `profile/gates.yaml`, and change it deliberately rather than because the count looked large.

**Why this matters:** a rule you have never checked will quietly delete the best job on the board and never mention it.

---

## Step 8. Look at your queue

```bash
npm run board && open data/board.html
```

You get a page showing how many letters you have left this week, what happened to every job, why they were thrown out, and what is sitting in your queue.

Under each queued job you may see arrows. Those are not disqualifications. They are questions with no answer yet: you would need to move, the posting only names a country, it says remote but mentions an office, or the pay is not published. A job with no arrows is ready today.

If you want the longer explanation of how the pipeline works, click through `npm run walk && open data/walkthrough.html` and pick a kind of work.

---

## Step 9. Pick one company

One. Not five.

Take the top row, or a row further down if the arrows on the top one bother you.

**Why one:** you can write about five real letters a week. Trying to research five companies at once produces five shallow letters, and a shallow letter is worse than none because it burns the contact.

---

## Step 10. Measure their product, if you can

If the company sells something you can use, spend twenty minutes using it and write down numbers. How long it takes to respond. Where it breaks. What it does when you contradict it.

**Why this matters more than anything else in this guide:** everybody else applying will describe their experience. You will arrive holding a dated measurement of their product that nobody else has. And the measurement is simultaneously your evidence and your proof, which means one activity does two jobs.

If their product is not something you can reach, skip this. The next step works without it, just with weaker evidence, and the system will grade it as weaker.

---

## Step 11. Research the company

Open Claude Code in the project folder and run:

```
/diagnose <company>
```

Start a clock when you begin, including the twenty minutes from step 10.

What happens: the researcher forms a guess about what is capping that company, then goes looking for the one fact that would prove it wrong. It reads their whole job board, their unfinished public work, and what they have refused to build. It ends with one thing named, one number, one date, and a link.

Then the checker attacks it and strikes anything that cannot be verified quickly.

**Good result:** one of three verdicts.

- **Ship.** The problem is clear and you have something that acts on it. Go to step 12.
- **Park.** The problem is clear but nothing you have built acts on it. Correct outcome. Pick another company.
- **Not enough evidence.** It could not establish anything it could prove. Also correct. Pick another company.

**Expect park or not-enough more often than ship.** Roughly one in four should ship. If everything ships, the researcher stopped testing and started agreeing with you, and you should say so and ask it to run the check again.

---

## Step 12. Write the letter

```
/ship <company>
```

You get four things: a short technical brief, a note under 120 words for the person you are writing to, the two resume lines that change for this company, and a tracking row.

The checker scores the brief against 28 questions a hiring manager needs answered and returns a percentage.

**If it comes in low:** it tells you which questions are unanswered. Answer them. Do not lower the threshold to make the letter pass. The threshold is the only thing making the letter good.

---

## Step 13. Find the person and send it

The system will not invent a name. It gives you a title, and you find the human.

Search their company page for that title. When you find the person, read the letter one more time as if you were them, then send it yourself.

**Nothing here has permission to contact anyone.** The system drafts and you send, every time, without exception.

---

## Step 14. Log what you did

Record the row that got generated: the date, the company, how you reached them, how good your evidence was when you started, how many minutes you spent, and where the idea came from.

**Why this matters:** after twenty letters, those numbers answer the only question that counts. Does better evidence at the start predict replies, or do more hours spent researching predict replies? If it is the first, your time belongs in building better ways to measure companies rather than in reading job postings, and the whole system should change shape.

You cannot know before twenty. Below that, the numbers are noise and any change is guessing.

---

## Step 15. Set it to run without you

```bash
chmod +x bin/run.sh
./bin/run.sh
cat data/logs/$(date +%F).log
```

Run it by hand first and read the log. A scheduled job that has never worked manually fails silently at 7am and you notice three weeks later.

When the manual run works, follow `docs/AUTOMATION.md` to schedule it. It will then fetch the boards, rebuild your pages, and write a research brief on your top three companies three mornings a week, and it will skip itself entirely on weeks you are already full.

---

## What week two looks like

Monday morning, ten minutes with coffee: open the board, read the brief.

Then one to two hours on one company, ending with a letter sent.

Sunday, fifteen minutes: run `/review`, read what the ledger says, and name one thing you will stop doing. A review that ends without a cut has decided nothing.

Repeat until twenty letters exist. Then read the numbers and decide what to change.

---

## The four things that go wrong most

**You skip step 3.** Without real proof, every letter reads like everyone else's. The system cannot fix an empty ledger.

**You skip step 7.** Rules you never audit throw away the best jobs and never mention it.

**You research five companies instead of one.** Five shallow letters is worse than one good one, because a shallow letter also burns the contact.

**You keep improving the system instead of sending letters.** This is the common one and the hardest to see from inside. The ledger is the only table that measures whether any of this works. If it stays empty for two weeks while the code keeps improving, the system has become the project and the search has stopped.
