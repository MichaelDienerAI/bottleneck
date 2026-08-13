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
if ! command -v claude >/dev/null; then
  echo "claude CLI not found. Half one is done; the pages are current."
  echo "=== done ==="
  exit 0
fi

BRIEF="data/briefs/$STAMP.md"
echo "writing preparation brief -> $BRIEF"

claude -p "$(cat bin/brief-prompt.md)" \
  --allowedTools "Read,Write,WebSearch,WebFetch" \
  --max-turns 24 \
  --output-format text \
  || echo "WARN: brief run failed or was cut short"

if [ -f "$BRIEF" ]; then
  echo "brief written, $(wc -l < "$BRIEF") lines"
else
  echo "no brief file produced — check the log above"
fi

echo "=== $(date '+%H:%M') done ==="
