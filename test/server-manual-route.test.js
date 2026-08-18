// The guards on the two manual dashboard routes.
//
// What is tested here is not "does the form post" but "may this click spend the
// constraint." A dashboard button that quietly consumes a drum slot is the
// fastest way to make this system illegible, so a diagnose has to ask first,
// refuse on a spent week, and refuse while another job holds the slot.
//
// The guards are pure and live in src/manualRoute.js rather than inside
// server.js, because server.js starts listening the moment it is imported and a
// suite that binds a port is a suite that fails on a busy machine for a reason
// nobody will connect to this file.

import assert from 'node:assert';
import { decideIngest, decideDiagnose, validateBody, REQUIRED, PHASE_LABELS } from '../src/manualRoute.js';

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

const JD = 'We are hiring a Research Engineer to own the evaluation harness end to end. Remote within the US.';
const body = (over = {}) => ({ company: 'Anthropic', role_title: 'Research Engineer', jd_text: JD, ...over });
const ctx = (over = {}) => ({ running: false, runningCompany: null, slots: 3, bufferLength: 4, bufferMax: 10, existingKey: false, ...over });

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

t('company, role_title and jd_text are all required', () => {
  assert.deepEqual(REQUIRED, ['company', 'role_title', 'jd_text']);
  for (const k of REQUIRED) {
    const b = body();
    delete b[k];
    const r = validateBody(b);
    assert.equal(r.status, 400);
    assert.match(r.body.error, new RegExp(k));
  }
});

t('whitespace is not a value', () => {
  assert.equal(validateBody(body({ company: '   ' })).ok, false);
});

t('a JD too short to be a posting is refused before a slot is spent', () => {
  const r = validateBody(body({ jd_text: 'Research Engineer' }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /too short/);
});

t('a well-formed body passes the shape check', () => {
  assert.equal(validateBody(body()).ok, true);
});

// ---------------------------------------------------------------------------
// Ingest — adds a row, spends nothing
// ---------------------------------------------------------------------------

t('a clean ingest is allowed with no confirmation', () => {
  // Adding a row is reversible by striking it. Nothing is consumed.
  const r = decideIngest(body(), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.action, 'ingest');
});

t('replacing an existing row asks first', () => {
  const r = decideIngest(body(), ctx({ existingKey: true }));
  assert.equal(r.status, 428);
  assert.match(r.body.error, /confirm required/);
  assert.equal(decideIngest(body({ confirm: true }), ctx({ existingKey: true })).ok, true);
});

t('a full buffer refuses, and force overrides deliberately', () => {
  // The rope set the buffer to min(buffer_max, slots + 5). Inserting past it is
  // how a queue becomes a pile.
  const full = ctx({ bufferLength: 10, bufferMax: 10 });
  const r = decideIngest(body(), full);
  assert.equal(r.status, 409);
  assert.match(r.body.hint, /Strike a row first/);
  assert.equal(decideIngest(body({ force: true }), full).ok, true);
});

t('a replacement does not count against the buffer cap', () => {
  assert.equal(decideIngest(body({ confirm: true }), ctx({ bufferLength: 10, existingKey: true })).ok, true);
});

t('ingesting the row a running job is reading is refused', () => {
  // /api/strike guards this narrowly and for the same reason: the diagnostician
  // reads its own row from data/queue.json while it runs.
  const r = decideIngest(body(), ctx({ running: true, runningCompany: 'Anthropic' }));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /reads its row/);
});

t('ingesting a different company during a run is allowed', () => {
  assert.equal(decideIngest(body(), ctx({ running: true, runningCompany: 'Vercel' })).ok, true);
});

// ---------------------------------------------------------------------------
// Diagnose — spends the constraint
// ---------------------------------------------------------------------------

t('a diagnose asks before it spends a slot', () => {
  const r = decideDiagnose(body(), ctx({ slots: 3 }));
  assert.equal(r.status, 428);
  assert.equal(r.body.spends_slot, true);
  assert.equal(r.body.slots_after, 2, 'the dialog has to say what it costs');
});

t('a confirmed diagnose proceeds', () => {
  const r = decideDiagnose(body({ confirm: true }), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.action, 'diagnose');
});

t('a spent week refuses, confirmed or not', () => {
  // Fail closed on the drum. This is the one route that enforces it: /api/run
  // checks queue membership, concurrency and confirm, and will start a diagnosis
  // on a full drum. That gap is left where it is rather than widened.
  for (const b of [body(), body({ confirm: true })]) {
    const r = decideDiagnose(b, ctx({ slots: 0 }));
    assert.equal(r.status, 409);
    assert.match(r.body.error, /no packet slots left/);
  }
});

t('a running job blocks any diagnose, not just the same company', () => {
  // A drum slot is serial by definition, and two concurrent diagnoses would
  // spend two slots while showing one log.
  const r = decideDiagnose(body({ confirm: true }), ctx({ running: true, runningCompany: 'Vercel' }));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already running/);
});

t('the shape check runs before the slot check', () => {
  // A malformed body should read as malformed, not as a full drum.
  const r = decideDiagnose(body({ jd_text: '' }), ctx({ slots: 0 }));
  assert.equal(r.status, 400);
});

t('confirm alone cannot buy past concurrency or the drum', () => {
  assert.equal(decideDiagnose(body({ confirm: true, force: true }), ctx({ slots: 0 })).status, 409);
  assert.equal(decideDiagnose(body({ confirm: true, force: true }), ctx({ running: true })).status, 409);
});

// ---------------------------------------------------------------------------
// The phase strip
// ---------------------------------------------------------------------------

t('the advertised phases match the pipeline the server actually runs', () => {
  // PHASES.diagnose in server.js is diagnostician, seal, blind packet, blind
  // audit, collision audit, verify — then the recorder. A dashboard describing a
  // pipeline the server is not running is worse than one describing none.
  for (const p of ['diagnostician', 'seal', 'blind packet', 'blind audit', 'collision audit', 'verify']) {
    assert.ok(PHASE_LABELS.includes(p), `phase strip is missing ${p}`);
  }
  assert.equal(PHASE_LABELS[0], 'ingesting', 'the manual run starts by writing the JD');
});

console.log(`\n${pass} passing`);
