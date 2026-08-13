#!/bin/bash
# Bottleneck — scheduled run.
#
# Runs Monday, Wednesday, Friday. Two halves, and the split is the whole design.
#
# HALF ONE is deterministic. Fetch the boards, apply the fixed rules, rank, rebuild
# the pages. No model, no judgment, no risk. This half can run unattended forever.
#
# HALF TWO asks Claude Code, headlessly, for a PREPARATION BRIEF on the top few
# rows. It gathers observables. It does not diagnose, does not decide, does not
# write a packet, and does not touch the ledger. That restraint is deliberate:
# an unattended diagnostician producing constraint claims nobody audited is a
# fiction generator, and the whole system exists to prevent exactly that.
#
# What half two actually buys you: when you sit down with five hours, the
# evidence gathering is already done. That raises the drum. It does not replace it.
#
# Install: see docs/AUTOMATION.md

set -uo pipefail

REPO="$HOME/Projects/bottleneck"
LOG="$REPO/data/logs"
STAMP=$(date +%Y-%m-%d)
mkdir -p "$LOG" "$REPO/data/briefs"
exec >> "$LOG/$STAMP.log" 2>&1

echo "=== $(date '+%Y-%m-%d %H:%M') run start ==="
cd "$REPO" || { echo "FAIL: repo not found at $REPO"; exit 1; }

# PATH for launchd, which does not inherit your shell environment.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"
command -v node >/dev/null || { echo "FAIL: node not on PATH"; exit 1; }

# ---------------------------------------------------------------- half one
SLOTS=$(node src/ledger.js --slots 2>/dev/null || echo 0)

# A ledger that will not parse exits non-zero and the || above already forced a 0.
# This catches the other shape: a zero exit with something that is not a number on
# stdout. Without it, `[ "$SLOTS" -le 0 ]` errors on the comparison, the guard reads
# false, and a corrupted ledger opens the gate instead of closing it. Fail closed —
# an unreadable ledger is not evidence of a free slot.
case "$SLOTS" in
  ''|*[!0-9]*) echo "WARN: ledger returned a non-integer slot count. Treating as 0."; SLOTS=0 ;;
esac

echo "open slots: $SLOTS"

if [ "$SLOTS" -le 0 ]; then
  echo "Drum full. Skipping the scan entirely — gathering work you have no time to"
  echo "do is how a queue becomes a pile. Nothing else runs today."
  echo "=== done ==="
  exit 0
fi

node src/scan.js       || echo "WARN: scan failed"
node src/report.js     || echo "WARN: board failed"
node src/walkthrough.js || echo "WARN: walkthrough failed"

# ---------------------------------------------------------------- half two
# CLAUDE_BIN is overridable so the test harness can point half two at a stub and
# at a path that does not exist. Nothing else sets it; the default is the CLI.
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

if ! command -v "$CLAUDE_BIN" >/dev/null; then
  echo "claude CLI not found. Half one is done; the pages are current."
  echo "=== done ==="
  exit 0
fi

BRIEF="data/briefs/$STAMP.md"
# The gatherer's instructions live in the subagent definition, not in a prompt
# file beside this script. --agent runs the session as that subagent, so the
# bounds it carries — no diagnosis, no hypothesis, no ledger write, no case file
# — are the same ones an attended run gets. Two copies of those bounds is one
# copy too many; the copy that drifts is always the one nobody is reading.
AGENT=".claude/agents/brief.md"
echo "writing preparation brief -> $BRIEF"

if [ ! -f "$AGENT" ]; then
  # Without the guard the CLI still runs, with the default system prompt and no
  # bounds at all. An unbounded 7am run is worse than a missing brief, so this is
  # a failure and gets logged as one.
  echo "WARN: brief run failed — $AGENT not found"
else
  "$CLAUDE_BIN" -p "Run today's gathering pass and write the brief for $STAMP." \
    --agent brief \
    --allowedTools "Read,Write,WebSearch,WebFetch" \
    --max-turns 24 \
    --output-format text \
    || echo "WARN: brief run failed or was cut short"
fi

if [ -f "$BRIEF" ]; then
  echo "brief written, $(wc -l < "$BRIEF") lines"
else
  echo "no brief file produced — check the log above"
fi

echo "=== $(date '+%H:%M') done ==="
