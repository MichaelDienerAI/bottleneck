// The rope, and the one property that matters: it fails closed.
//
// openSlots subtracts spent slots from the weekly cap, and loadLedger used to
// return [] for a missing file, so an absent ledger reported the full five. On
// 2026-08-17 data/ledger.json did not exist and `npm run slots` printed 5 — the
// system's one constraint reading wide open because the record of what was spent
// was gone. Absence of a record is not a record of absence.
//
// The distinction every test here draws: an initialized empty ledger is a claim
// that nothing has been sent, and opens the cap. A missing file is no claim at
// all, and opens nothing.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSlots, ledgerState, loadLedger, initLedger, weekStart } from './ledger.js';

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
};

const CFG = { drum: { packets_per_week: 5 } };
const roots = [];

// A throwaway repo root. `ledger` undefined means the file is never created,
// which is the case this suite exists for.
function makeRoot(ledger) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottleneck-ledger-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  if (ledger !== undefined) fs.writeFileSync(path.join(root, 'data/ledger.json'), ledger);
  return root;
}

// A row inside the current week, at local noon. A bare YYYY-MM-DD parses as UTC
// midnight, which is a property of Date rather than of the ledger; the automation
// suite covers the hours that used to bucket wrong.
const thisWeekRow = () => ({ date: `${new Date().toLocaleDateString('en-CA')}T12:00:00` });

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

t('a missing ledger opens no slots', () => {
  // The whole point of the file. Before this, the answer was 5.
  assert.equal(openSlots(makeRoot(undefined), CFG), 0);
});

t('a missing ledger is reported as missing, not as empty', () => {
  const s = ledgerState(makeRoot(undefined));
  assert.equal(s.state, 'missing');
  assert.deepEqual(s.rows, []);
  assert.match(s.reason, /does not exist/);
});

t('an initialized empty ledger opens the full cap', () => {
  // The other half of the distinction. `[]` is a claim that nothing was sent, and
  // a claim is exactly what a missing file does not make.
  assert.equal(openSlots(makeRoot('[]'), CFG), 5);
  assert.equal(ledgerState(makeRoot('[]')).state, 'ok');
});

t('a truncated ledger opens no slots', () => {
  const root = makeRoot('[{"date": "2026-08-13"');
  assert.equal(openSlots(root, CFG), 0);
  assert.equal(ledgerState(root).state, 'corrupt');
});

t('a ledger that parses but is not an array opens no slots', () => {
  // `{}` used to sail through: JSON.parse succeeds, .filter throws or .length is
  // undefined. Neither is a slot count.
  for (const body of ['{}', '"five"', 'null', '42']) {
    const root = makeRoot(body);
    assert.equal(openSlots(root, CFG), 0, `${body} should close the drum`);
    assert.equal(ledgerState(root).state, 'corrupt', body);
  }
});

t('an unreadable ledger names why it could not be read', () => {
  const s = ledgerState(makeRoot('[{'));
  assert.equal(s.state, 'corrupt');
  assert.match(s.reason, /will not parse/);
});

// ---------------------------------------------------------------------------
// Counting, once the ledger is readable
// ---------------------------------------------------------------------------

t('rows sent this week reduce the open slots', () => {
  assert.equal(openSlots(makeRoot(JSON.stringify([thisWeekRow(), thisWeekRow()])), CFG), 3);
});

t('five rows this week close the drum', () => {
  const rows = Array.from({ length: 5 }, thisWeekRow);
  assert.equal(openSlots(makeRoot(JSON.stringify(rows)), CFG), 0);
});

t('more rows than the cap never returns a negative count', () => {
  const rows = Array.from({ length: 9 }, thisWeekRow);
  assert.equal(openSlots(makeRoot(JSON.stringify(rows)), CFG), 0);
});

t('rows from a previous week do not count against this one', () => {
  const old = { date: '2020-01-08T12:00:00' };
  assert.equal(openSlots(makeRoot(JSON.stringify([old, old, old])), CFG), 5);
});

t('a corrupt ledger closes the drum whatever the cap says', () => {
  assert.equal(openSlots(makeRoot('nope'), { drum: { packets_per_week: 50 } }), 0);
});

// ---------------------------------------------------------------------------
// loadLedger
// ---------------------------------------------------------------------------

t('loadLedger returns rows for a readable ledger', () => {
  assert.equal(loadLedger(makeRoot(JSON.stringify([thisWeekRow()]))).length, 1);
});

t('loadLedger returns an empty array for a missing one rather than inventing rows', () => {
  assert.deepEqual(loadLedger(makeRoot(undefined)), []);
});

t('loadLedger throws on a corrupt ledger instead of reporting a quiet week', () => {
  // A report drawn from an array the reader invented is a report about nothing
  // that reads as a report about a week with no sends.
  assert.throws(() => loadLedger(makeRoot('[{')), /will not parse/);
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

t('initLedger creates an empty ledger where none exists', () => {
  const root = makeRoot(undefined);
  const r = initLedger(root);
  assert.equal(r.created, true);
  assert.equal(openSlots(root, CFG), 5, 'after init the cap should open');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data/ledger.json'), 'utf8')), []);
});

t('initLedger never truncates an existing ledger', () => {
  // The one file in this repository that cannot be regenerated. An init that
  // overwrote it would destroy the record it exists to protect.
  const rows = [thisWeekRow(), thisWeekRow()];
  const root = makeRoot(JSON.stringify(rows));
  const r = initLedger(root);
  assert.equal(r.created, false);
  assert.equal(r.rows, 2);
  assert.equal(loadLedger(root).length, 2);
});

t('initLedger reports a corrupt ledger rather than replacing it', () => {
  const root = makeRoot('[{');
  const r = initLedger(root);
  assert.equal(r.created, false);
  assert.equal(r.state, 'corrupt');
  assert.equal(fs.readFileSync(path.join(root, 'data/ledger.json'), 'utf8'), '[{', 'the bad file must survive for repair');
});

t('initLedger is idempotent', () => {
  const root = makeRoot(undefined);
  initLedger(root);
  const second = initLedger(root);
  assert.equal(second.created, false);
  assert.equal(second.state, 'ok');
});

// ---------------------------------------------------------------------------
// weekStart, which openSlots buckets by
// ---------------------------------------------------------------------------

t('weekStart returns a Monday', () => {
  for (const d of ['2026-08-17T09:00', '2026-08-19T23:30', '2026-08-23T00:30']) {
    assert.equal(weekStart(new Date(d)), '2026-08-17', d);
  }
});

for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passing`);
