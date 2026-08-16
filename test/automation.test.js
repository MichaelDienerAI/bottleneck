// bin/run.sh, the scheduled run. Monday, Wednesday, Friday at 07:05.
//
// This file tests the shell orchestration, not the programs it calls. The
// question is never "did the scan work" — it is "when the scan, the CLI, or the
// ledger fails at 7am with nobody watching, does the script fail in the shape we
// chose?" Half one is deterministic and must survive anything half two does.
//
// Every test runs against a fixture repo under a temporary HOME, because run.sh
// resolves itself from $HOME/Projects/bottleneck. Nothing here touches the real
// repo, reaches the network, or invokes the real claude CLI. Half two is driven
// through CLAUDE_BIN, which exists so a stub can stand in for the model.

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');
const fixtures = [];

let pass = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
    pass++;
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`);
    failures.push(name);
  }
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

// A throwaway HOME holding Projects/bottleneck, which is the path run.sh hard
// codes. The real bin/run.sh is copied in — the script under test is the one
// that ships, never a paraphrase of it. src/ledger.js is copied too, because the
// slot count is the guard these tests are about and a stub would prove only that
// the stub works. node_modules is symlinked so that real ledger.js can resolve
// js-yaml; without it an import failure would exit non-zero and every ledger
// test would pass for the wrong reason.
//
// scan, report, and walkthrough are stubs. They fetch 27 boards and rewrite two
// HTML pages, and half one's contract here is that it runs them in order and
// keeps going, not what they produce.
function makeFixture({ ledger = '[]', briefAgent = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bottleneck-run-'));
  fixtures.push(home);
  const repo = path.join(home, 'Projects/bottleneck');

  for (const d of ['bin', 'src', 'data', 'profile', '.claude/agents']) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
  }

  fs.copyFileSync(path.join(REPO, 'bin/run.sh'), path.join(repo, 'bin/run.sh'));
  fs.chmodSync(path.join(repo, 'bin/run.sh'), 0o755);
  fs.copyFileSync(path.join(REPO, 'src/ledger.js'), path.join(repo, 'src/ledger.js'));
  fs.copyFileSync(
    path.join(REPO, 'profile/gates.example.yaml'),
    path.join(repo, 'profile/gates.example.yaml')
  );
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(repo, 'node_modules'));

  for (const stub of ['scan.js', 'report.js', 'walkthrough.js']) {
    fs.writeFileSync(path.join(repo, 'src', stub), `console.log('${stub} stub ran');\n`);
  }

  fs.writeFileSync(path.join(repo, 'data/ledger.json'), ledger);
  if (briefAgent) {
    // Half two runs as this subagent. Only its presence matters here — the stub
    // CLI never reads it, and what it says is the subject of its own review.
    fs.writeFileSync(
      path.join(repo, '.claude/agents/brief.md'),
      '---\nname: brief\n---\nGather observables. Do not diagnose.\n'
    );
  }

  return { home, repo };
}

// A stand-in for the claude CLI. exitCode 0 writes the brief the way a real run
// would; non-zero is the cut-short case run.sh has to survive.
function stubClaude(repo, { exitCode = 0 } = {}) {
  const p = path.join(repo, 'bin/claude-stub.sh');
  fs.writeFileSync(
    p,
    [
      '#!/bin/bash',
      'echo "stub claude invoked"',
      `if [ ${exitCode} -eq 0 ]; then`,
      '  mkdir -p data/briefs',
      '  echo "# Evidence brief — stub" > "data/briefs/$(date +%Y-%m-%d).md"',
      'fi',
      `exit ${exitCode}`,
      '',
    ].join('\n')
  );
  fs.chmodSync(p, 0o755);
  return p;
}

// A ledger row dated inside the current week, at local noon. src/ledger.js now
// does the whole week calculation on the local clock, so any hour buckets
// correctly; noon is kept because a bare YYYY-MM-DD string still parses as UTC
// midnight, which is a property of Date rather than of the ledger. The tests
// below cover the hours that used to break.
const thisWeekRow = (hour = '12:00') => ({ date: `${new Date().toLocaleDateString('en-CA')}T${hour}:00` });

// Runs the script and returns the log it wrote. run.sh redirects all output to
// data/logs/<date>.log, so stdout here is empty by design and the log file is
// the only witness — which is also true at 7am.
function run(repo, env = {}) {
  const home = path.resolve(repo, '../..');
  try {
    execFileSync('bash', [path.join(repo, 'bin/run.sh')], {
      env: { ...process.env, HOME: home, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
  } catch (e) {
    // A non-zero exit is itself a finding. Return the log and let the test judge.
    if (e.code === 'ETIMEDOUT') throw e;
  }
  const dir = path.join(repo, 'data/logs');
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

const halfOneRan = (log) => {
  for (const stub of ['scan.js', 'report.js', 'walkthrough.js']) {
    assert.ok(log.includes(`${stub} stub ran`), `half one did not reach ${stub}\n--- log ---\n${log}`);
  }
  // The closing line carries a timestamp on the full path and not on the early
  // exits, so match the part that is always there.
  assert.ok(/done ===/.test(log), `run did not reach its own end\n--- log ---\n${log}`);
};

// ---------------------------------------------------------------------------
// Baseline. The edge cases below are only meaningful against a run that works.
// ---------------------------------------------------------------------------

t('a clean run completes both halves', () => {
  const { repo } = makeFixture();
  const log = run(repo, { CLAUDE_BIN: stubClaude(repo) });
  halfOneRan(log);
  assert.ok(log.includes('open slots: 5'), `expected five open slots\n--- log ---\n${log}`);
  assert.ok(log.includes('stub claude invoked'), `half two never invoked the CLI\n--- log ---\n${log}`);
  assert.ok(log.includes('brief written'), `the brief was not recorded\n--- log ---\n${log}`);
  assert.ok(!log.includes('WARN'), `a clean run should warn about nothing\n--- log ---\n${log}`);
});

t('a full drum skips the scan entirely', () => {
  // Five rows this week. Gathering work there is no time to do is how a queue
  // becomes a pile, so the correct behavior is to fetch nothing at all.
  const rows = Array.from({ length: 5 }, thisWeekRow);
  const { repo } = makeFixture({ ledger: JSON.stringify(rows) });
  const log = run(repo, { CLAUDE_BIN: stubClaude(repo) });
  assert.ok(log.includes('Drum full'), `expected the drum guard\n--- log ---\n${log}`);
  assert.ok(!log.includes('scan.js stub ran'), `the scan ran with no slots to fill\n--- log ---\n${log}`);
  assert.ok(!log.includes('stub claude invoked'), `half two ran with no slots\n--- log ---\n${log}`);
});

t('the scheduled run writes no case file', () => {
  // Case files are the system's memory across weeks, and they are written only
  // by src/casefile.js --record, from a diagnosis the auditor already ruled on.
  // Half two's tool set includes Write, so the bound in .claude/agents/brief.md
  // is the part that stops it, and nothing in the script may quietly add a
  // second write path. A claim nobody read, filed into memory at 7am, is
  // inherited as settled by every later run — which is the one failure this
  // whole system is built around.
  const { repo } = makeFixture();
  const log = run(repo, { CLAUDE_BIN: stubClaude(repo) });

  halfOneRan(log);
  assert.ok(
    !fs.existsSync(path.join(repo, 'data/cases')),
    'the unattended run created data/cases — memory was written with nobody reading'
  );

  const script = fs.readFileSync(path.join(REPO, 'bin/run.sh'), 'utf8');
  assert.ok(
    !/casefile/.test(script),
    'bin/run.sh names casefile. The recorder belongs to the attended path only.'
  );
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

t('missing claude CLI graceful exit', () => {
  // The CLI is the one dependency half two cannot work around, and it goes away
  // for boring reasons: an uninstall, a PATH launchd did not inherit, an expired
  // auth that never resolves. Half one is deterministic and owes nothing to half
  // two, so it must finish and leave the pages current.
  const { repo } = makeFixture();
  const log = run(repo, { CLAUDE_BIN: path.join(repo, 'bin/does-not-exist-claude') });

  halfOneRan(log);
  assert.ok(log.includes('claude CLI not found'), `expected the missing-CLI notice\n--- log ---\n${log}`);
  assert.ok(
    log.includes('Half one is done; the pages are current'),
    `the notice must say half one still stands\n--- log ---\n${log}`
  );
  assert.ok(!log.includes('writing preparation brief'), `half two started anyway\n--- log ---\n${log}`);
  assert.ok(
    !fs.existsSync(path.join(repo, 'data/briefs')) ||
      fs.readdirSync(path.join(repo, 'data/briefs')).filter((f) => f.endsWith('.md')).length === 0,
    'a brief file appeared with no CLI to write it'
  );
});

t('brief prompt missing', () => {
  // .claude/agents/brief.md carries every bound half two runs under: no diagnosis,
  // no constraint claim, no ledger write, no case file. Losing it must not degrade
  // into a 7am run on the default system prompt with none of those bounds. That is
  // a failed brief and gets logged as one.
  const { repo } = makeFixture({ briefAgent: false });
  const log = run(repo, { CLAUDE_BIN: stubClaude(repo) });

  halfOneRan(log);
  assert.ok(log.includes('WARN: brief run failed'), `expected the brief warning\n--- log ---\n${log}`);
  assert.ok(
    !log.includes('stub claude invoked'),
    `the CLI ran with no prompt to run\n--- log ---\n${log}`
  );
  assert.ok(log.includes('no brief file produced'), `the log must name the missing brief\n--- log ---\n${log}`);
});

t('non-integer or corrupted ledger state', () => {
  // The ledger is the rope. src/ledger.js JSON.parses it unguarded, so a truncated
  // write exits non-zero and `|| echo 0` forces the count to zero. Zero slots
  // closes the gate. An unreadable ledger is not evidence of a free slot, and the
  // failure the fixture must never allow is a corrupted ledger opening one.
  const { repo } = makeFixture({ ledger: '[{"date": "2026-08-13"' });
  const log = run(repo, { CLAUDE_BIN: stubClaude(repo) });

  assert.ok(log.includes('open slots: 0'), `the fallback did not force 0\n--- log ---\n${log}`);
  assert.ok(log.includes('Drum full'), `zero slots did not reach the drum guard\n--- log ---\n${log}`);
  assert.ok(!log.includes('scan.js stub ran'), `a corrupted ledger let the scan run\n--- log ---\n${log}`);
  assert.ok(!log.includes('stub claude invoked'), `a corrupted ledger let half two run\n--- log ---\n${log}`);

  // The other shape of the same failure: a zero exit with a non-number on stdout.
  // `|| echo 0` cannot catch that one, so run.sh sanitizes it separately. Without
  // that, the `-le` comparison errors, the guard reads false, and the run proceeds.
  const { repo: repo2 } = makeFixture();
  fs.writeFileSync(path.join(repo2, 'src/ledger.js'), "console.log('NaN');\n");
  const log2 = run(repo2, { CLAUDE_BIN: stubClaude(repo2) });

  assert.ok(log2.includes('non-integer slot count'), `expected the sanitizer notice\n--- log ---\n${log2}`);
  assert.ok(log2.includes('open slots: 0'), `a non-integer count was not forced to 0\n--- log ---\n${log2}`);
  assert.ok(log2.includes('Drum full'), `a non-integer count did not close the gate\n--- log ---\n${log2}`);
});

// ---------------------------------------------------------------------------
// The week boundary
// ---------------------------------------------------------------------------

// weekStart used to read the day with local getDay/setDate and then format with
// toISOString. In any zone behind UTC that pushed the date forward once local
// time passed midnight-minus-offset, so the same Thursday returned Monday at 9am
// and Tuesday at 6pm. openSlots buckets every ledger row by that value, so five
// spent slots read as five open ones after about 5pm Phoenix time and the drum
// silently reset every evening.
//
// The only test that caught it was the drum guard above, and only when the suite
// happened to run late in the day — which is a test that passes in CI at 09:00
// and fails at 18:00 for reasons no one will connect to timezones. These two run
// the real src/ledger.js in a child process with TZ set, so they assert the same
// thing at every hour and on every machine.
//
// TZ cannot be changed inside a running process; Date caches the zone at startup.
// A child process is the only honest way to test this.
const inZone = (tz, code) =>
  JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    })
  );

const LEDGER_URL = pathToFileURL(path.join(REPO, 'src/ledger.js')).href;
const ZONES = ['UTC', 'America/Phoenix', 'America/New_York', 'Asia/Tokyo'];

// Today's calendar date as the target zone sees it. The row has to be dated the
// child's today, not the parent's: run the suite at 18:30 in Phoenix and it is
// already tomorrow in Tokyo, so a date computed here would land the row in a
// different week there and fail for a reason that has nothing to do with the bug.
const todayIn = (tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date()
  );

t('weekStart is the same local Monday at every hour of the day', () => {
  // A fixed Thursday, read at three hours that straddle the UTC date boundary in
  // zones both behind and ahead of it. All nine answers must be the Monday of
  // that week, 2026-08-10, because the calendar week a human is in does not
  // change at 5pm.
  for (const tz of ZONES) {
    const got = inZone(
      tz,
      `const {weekStart} = await import(${JSON.stringify(LEDGER_URL)});
       console.log(JSON.stringify(['09:00','18:00','23:30'].map(h => weekStart(new Date('2026-08-13T'+h+':00')))));`
    );
    assert.deepEqual(got, ['2026-08-10', '2026-08-10', '2026-08-10'], `${tz} shifted the week within a single day: ${got.join(' ')}`);
  }
});

t('openSlots counts evening and small-hours rows in the right week', () => {
  // The consequence, not the helper. Five rows timestamped today close the drum,
  // whatever hour they carry. Under the old arithmetic an 18:30 row in a zone
  // behind UTC bucketed into next week and left the drum reading wide open, and
  // it did that no matter when the suite ran.
  for (const tz of ZONES) {
    for (const hour of ['00:30', '18:30', '23:30']) {
      const { repo } = makeFixture({
        ledger: JSON.stringify(Array.from({ length: 5 }, () => ({ date: `${todayIn(tz)}T${hour}:00` }))),
      });
      const got = inZone(
        tz,
        `const {openSlots} = await import(${JSON.stringify(LEDGER_URL)});
         console.log(JSON.stringify(openSlots(${JSON.stringify(repo)})));`
      );
      assert.equal(got, 0, `${tz} at ${hour}: five rows this week left ${got} slots open, so the drum reset`);
    }
  }
});

// ---------------------------------------------------------------------------
// Fixture cleanup
// ---------------------------------------------------------------------------

for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passing${failures.length ? `, ${failures.length} failing` : ''}`);
if (failures.length) process.exit(1);
