# Running it on a schedule

Monday, Wednesday, Friday at 7:05am. Two halves, and the split between them is the point.

Bottleneck v0.2.

## What runs unattended, and what does not

**Half one is deterministic.** Fetch 27 job boards, apply the fixed rules, rank, rebuild both pages. No model is involved, so there is nothing to fabricate and nothing to audit. This half can run forever without supervision.

**Half two gathers evidence.** Claude Code runs headlessly and writes a preparation brief on your top three rows: open roles across each company's whole board, oldest unresolved pull requests and issues, release cadence, anything they publicly refused to build, and the one sentence in the posting that does not read like a template. Every item carries a link and a rough verify time.

**Nothing diagnoses.** The brief is forbidden from naming a company's constraint, writing a packet, touching the ledger, or creating a case file. That restraint is the whole design. A constraint claim nobody read is a plausible sentence with no evidence underneath, and a model asked to produce one at 7am on a Wednesday will produce one every time without ever signalling that it invented it.

So the schedule raises the drum rather than replacing it. When you sit down with your five hours, the searching is done and the hours go to judgment. That is Goldratt's fourth step, elevate, applied honestly. It is not step five.

**It skips itself when the week is full.** If you have used all five slots, the run exits before fetching anything. Gathering work you have no time to do is how a queue becomes a pile.

## Install

```bash
cd ~/Projects/bottleneck
chmod +x bin/run.sh
```

Run it once by hand first, because a scheduled job that has never worked manually is a scheduled job that fails silently at 7am:

```bash
./bin/run.sh
cat data/logs/$(date +%F).log
```

Then install the schedule:

```bash
sed "s|REPLACE_WITH_ABSOLUTE_PATH|$HOME/Projects/bottleneck|g" \
  bin/com.bottleneck.run.plist > ~/Library/LaunchAgents/com.bottleneck.run.plist

launchctl load ~/Library/LaunchAgents/com.bottleneck.run.plist
launchctl list | grep bottleneck
```

To stop it:

```bash
launchctl unload ~/Library/LaunchAgents/com.bottleneck.run.plist
```

## Your Monday morning

Open `data/board.html`. It shows what came in, what got thrown out and why, and how many research slots you have left.

Open `data/briefs/<date>.md`. Three companies with the evidence already collected and the questions it raises. You decide what any of it means.

Then spend a slot: `/diagnose <company>` in Claude Code, attended, reading what it produces.

## Things that will go wrong

**launchd does not inherit your shell.** `run.sh` sets PATH explicitly for Homebrew, `/usr/local/bin`, and the npm global directory. If `node` or `claude` lives somewhere else on your machine, add it there or the job dies with a command-not-found you will never see.

**A sleeping Mac skips the run.** launchd fires the job on wake if the machine was asleep at 7:05, but a fully powered-off Mac misses that day. Check the log if a brief is missing.

**The `claude` CLI needs to be authenticated already.** Headless mode uses your existing session. If auth expires, half two fails and half one still works, which is why the script continues rather than aborting.

**Every run costs tokens.** Three companies with web searches, twice or three times a week. Bounded at 24 turns per run, but watch it for the first two weeks before assuming the number.

## The honest limit

None of this sends anything. None of it decides anything. It reads job boards on a timer and does your homework, and the part that converts still costs you five hours and cannot be delegated to a cron job.

If the automation ever feels like progress on its own, check the ledger. That table is the only one that measures whether any of this works.
