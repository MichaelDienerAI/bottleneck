// Structural operators and the diorismos gate.
//
// PROVENANCE. The nine operator names came from a brief citing a
// "Metre-Mechanism Guide" that is not in this repository — searched for by title
// and by every term in it, not found. The definitions under test are therefore
// mine, written from first principles, and these assertions pin MY semantics
// rather than that document's. If the guide surfaces and disagrees, the guide
// wins and both the module and this file are wrong.
//
// What is actually load-bearing here is the diorismos gate. Criteria chosen
// after a draft are criteria the draft passes, and the packet stage is where the
// pull to rationalize is strongest: a slot has been spent, the artifact exists,
// and nobody wants to conclude it cannot be written.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OPERATORS,
  OPERATOR_NAMES,
  analyze,
  compose,
  segmentOutreach,
  checkOutreachForm,
  MOVEMENTS,
} from '../src/utils/promptAlgebra.js';
import { buildDiorismos, feasible, checkDrafts, quarantine, SPEC } from '../src/diorismos.js';
import { deriveBluf, MAX_WORDS } from '../src/bluf.js';

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

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bottleneck-dior-'));
  dirs.push(d);
  return d;
};

// ---------------------------------------------------------------------------
// The nine operators
// ---------------------------------------------------------------------------

t('all nine operators exist and each describes itself', () => {
  assert.deepEqual(OPERATOR_NAMES, [
    'RECURRENCE',
    'SEGMENTATION',
    'PARALLELISM',
    'ASYMMETRY',
    'CHAINING',
    'COMPRESSION',
    'EXPANSION',
    'PIVOT',
    'CLOSURE',
  ]);
  for (const [name, op] of Object.entries(OPERATORS)) {
    assert.ok(op.describe && typeof op.detect === 'function', `${name} is incomplete`);
  }
});

t('RECURRENCE finds the term that binds a passage', () => {
  const bound = 'The harness is unmaintained. The harness has no owner. Nobody runs the harness before a release.';
  assert.equal(OPERATORS.RECURRENCE.detect(bound).present, true);
  assert.equal(OPERATORS.RECURRENCE.detect('One thing. Another thing. A third.').present, false);
});

t('CHAINING requires causal connectives, not additive ones', () => {
  // "and then" is a list. "so" is an argument. The distinction is the point.
  const chained = 'The reviewer left, so nothing merges. Because nothing merges, the queue grew.';
  const listed = 'The reviewer left. Also the queue grew. Furthermore releases slowed.';
  assert.equal(OPERATORS.CHAINING.detect(chained).present, true);
  assert.equal(OPERATORS.CHAINING.detect(listed).present, false);
});

t('ASYMMETRY sees a long sentence answered by a short one', () => {
  const asym = 'They have spent eighteen months trying to fill a seat that their own board shows is still open today. It did not work.';
  const flat = 'They posted a role. They kept it open. They posted again.';
  assert.equal(OPERATORS.ASYMMETRY.detect(asym).present, true);
  assert.equal(OPERATORS.ASYMMETRY.detect(flat).present, false);
});

t('COMPRESSION measures named specifics against length', () => {
  const dense = 'No releases since 2026-04-03. 94 days. 12 open issues at https://example.com/x.';
  const thin =
    'Their release process appears to have slowed considerably over a meaningful period and the situation seems to have deteriorated in ways that are hard to characterize precisely without more information.';
  assert.equal(OPERATORS.COMPRESSION.detect(dense).present, true);
  assert.equal(OPERATORS.COMPRESSION.detect(thin).present, false);
});

t('PIVOT finds the turn and CLOSURE finds an ending rather than a stop', () => {
  assert.equal(OPERATORS.PIVOT.detect('They are hiring. But the obvious guess is wrong.').present, true);
  assert.equal(OPERATORS.CLOSURE.detect('Here is the record. Worth a look?').present, true);
  assert.equal(
    OPERATORS.CLOSURE.detect('Here is the record and it goes on at some length about many different things at once.').present,
    false
  );
});

t('compose requires and forbids by name', () => {
  const text = 'The reviewer left, so nothing merges. Because nothing merges, the queue grew. Worth a look?';
  assert.equal(compose(text, { require: ['CHAINING', 'CLOSURE'] }).ok, true);
  const bad = compose(text, { require: ['CHAINING'], forbid: ['CLOSURE'] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.forbidden, ['CLOSURE']);
});

t('analyze reports every operator without returning a verdict', () => {
  const a = analyze('Anything at all.');
  assert.deepEqual(Object.keys(a).sort(), [...OPERATOR_NAMES].sort());
  for (const v of Object.values(a)) assert.equal(typeof v.present, 'boolean');
});

// ---------------------------------------------------------------------------
// The outreach form
// ---------------------------------------------------------------------------

const goodOutreach =
  'Your eval harness has had no commit since 2026-04-03, 94 days. ' +
  'The obvious read is that nobody needs it, but the issue queue against it grew by 11 in the same window. ' +
  'I built the same thing and published it at https://example.com/bank. Worth ten minutes?';

t('a well-formed outreach passes all three movements in order', () => {
  const r = checkOutreachForm(goodOutreach);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  for (const m of MOVEMENTS) assert.ok(r.movements[m.key], `missing ${m.key}`);
});

t('a missing defeater is named', () => {
  // Observation and a link with nothing between them: two facts, no argument.
  const r = checkOutreachForm('Your harness has had no commit since 2026-04-03. See https://example.com/bank. Worth ten minutes?');
  assert.ok(r.problems.some((p) => /DEFEATER/.test(p)));
});

t('movements out of order fail', () => {
  const backwards =
    'I built the same thing and published it at https://example.com/bank. ' +
    'But the obvious read is wrong. Your harness has had no commit since 2026-04-03.';
  const r = checkOutreachForm(backwards);
  assert.ok(r.problems.some((p) => /out of order/.test(p)), JSON.stringify(r.problems));
});

t('the word ceiling is enforced', () => {
  const long = goodOutreach + ' ' + 'Additional padding sentence here. '.repeat(20);
  const r = checkOutreachForm(long);
  assert.ok(r.problems.some((p) => /over the 120-word ceiling/.test(p)));
});

t('the distich asymmetry is a note, not a failure', () => {
  // What the elegiac distich actually contributes is the shape: a long line
  // answered by a shorter one that closes. Three movements is a tricolon, not a
  // distich, so the count is not enforced — the asymmetry is, and only as a note,
  // because a close that runs long is weak rather than wrong.
  const evenClose =
    'No commit since 2026-04-03. ' +
    'But the queue grew, however, which is not what an abandoned repository looks like at all in practice. ' +
    'I built the same instrument and published every run of it in full at https://example.com/bank for anyone to reproduce.';
  const r = checkOutreachForm(evenClose);
  assert.ok(r.notes.some((n) => /not shorter than the opening/.test(n)));
  assert.ok(!r.problems.some((p) => /shorter/.test(p)), 'asymmetry must not fail the draft');
});

t('segmentation assigns each movement to the first sentence that shows it', () => {
  const s = segmentOutreach(goodOutreach);
  assert.equal(s.movements.OBSERVATION.index, 0);
  assert.ok(s.movements.PROOF_ACTION.index > s.movements.DEFEATER.index);
});

// ---------------------------------------------------------------------------
// Diorismos — registered before, checked after
// ---------------------------------------------------------------------------

// Sentence-shaped filler. `'word '.repeat(n)` produces one 431-word "sentence"
// and Flesch-Kincaid scores it at 166, which is a property of the fixture rather
// than of the checker. A brief is prose; the fixture has to be prose too.
const filler = (n) => {
  const out = [];
  while (out.join(' ').split(/\s+/).filter(Boolean).length < n) {
    out.push('The team ships a fix each week and the queue stays short.');
  }
  return out.join(' ');
};

const diagnosis = (over = {}) => ({
  company: 'Testco',
  role: 'Engineer',
  decision_maker: { name: 'Dana Reyes', title: 'Head of Eval', source: 'https://example.com/team' },
  proof_match: { asset: 'deformation_test_bank', tier: 'sovereign', acts_on_constraint: true },
  ...over,
});

const ledger = {
  sovereign: [
    { id: 'deformation_test_bank', inspect_at: 'https://example.com/bank' },
    { id: 'persona_io', inspect_at: 'https://personaio.app' },
  ],
};

t('a registrable packet names one human and one inspectable proof', () => {
  const d = buildDiorismos({ diagnosis: diagnosis(), ledger, dated: '2026-08-17' });
  assert.equal(d.decision_maker.satisfied, true);
  assert.equal(d.sovereign_proof.chosen, 'deformation_test_bank');
  assert.equal(feasible(d).ok, true);
});

t('an unnamed decision-maker makes the packet not constructible', () => {
  // Euclid states the conditions first because some constructions are impossible
  // from the given parts. This is one.
  const d = buildDiorismos({ diagnosis: diagnosis({ decision_maker: { name: '', source: null } }), ledger });
  assert.equal(feasible(d).ok, false);
  assert.ok(feasible(d).blockers.some((b) => /never invents one/.test(b)));
});

t('a proof with no public URL is not sovereign yet, whatever the ledger says', () => {
  // profile/proof-ledger.yaml really does carry TODO_PUBLIC_URL on
  // deformation_test_bank as of this writing. A proof a stranger cannot open is
  // the same as no proof.
  const d = buildDiorismos({
    diagnosis: diagnosis(),
    ledger: { sovereign: [{ id: 'deformation_test_bank', inspect_at: 'TODO_PUBLIC_URL' }] },
  });
  assert.equal(d.sovereign_proof.satisfied, false);
  assert.ok(feasible(d).blockers.some((b) => /no inspectable URL/.test(b)));
});

t('exactly one proof is required, not at least one', () => {
  const d = buildDiorismos({
    diagnosis: diagnosis({ proof_match: { asset: 'deformation_test_bank and persona_io' } }),
    ledger,
  });
  assert.equal(d.sovereign_proof.chosen, null);
  assert.ok(feasible(d).blockers.some((b) => /exactly one is required/.test(b)));
});

const spec = () => buildDiorismos({ diagnosis: diagnosis(), ledger, dated: '2026-08-17' });

t('a brief under the registered floor violates', () => {
  const r = checkDrafts(spec(), { brief: 'Dana Reyes. https://example.com/bank. Too short.', outreach: null });
  assert.ok(r.violations.some((v) => v.rule === 'word-count'));
});

t('a brief that does not link the registered proof violates', () => {
  const body = `Dana Reyes, here is the argument. ${filler(450)}`;
  const r = checkDrafts(spec(), { brief: body, outreach: null });
  assert.ok(r.violations.some((v) => v.rule === 'sovereign-proof'));
});

t('a brief that does not address the registered human violates', () => {
  const body = `Here is the argument. https://example.com/bank ${filler(450)}`;
  const r = checkDrafts(spec(), { brief: body, outreach: null });
  assert.ok(r.violations.some((v) => v.rule === 'decision-maker'));
});

t('the outreach form is checked against the registered criteria', () => {
  const r = checkDrafts(spec(), { brief: null, outreach: 'Hello. Nothing here at all.' });
  assert.ok(r.violations.some((v) => v.artifact === 'outreach.md' && v.rule === 'form'));
});

t('a conforming pair passes', () => {
  const body = `Dana Reyes, the record is at https://example.com/bank. ${filler(430)}`;
  const r = checkDrafts(spec(), { brief: body, outreach: goodOutreach });
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
});

t('the header does not buy word budget', () => {
  // The draft header is on every packet. Counting it would let a draft spend
  // nine words of its ceiling by existing.
  const withHeader = `DRAFT ONLY — REQUIRES HUMAN REVIEW AND MANUAL SEND\n\n${filler(395)}`;
  const r = checkDrafts(spec(), { brief: withHeader, outreach: null });
  assert.ok(r.violations.some((v) => v.rule === 'word-count'), 'the header must not count toward the floor');
});

t('a violation quarantines the draft and keeps it readable', () => {
  // Not deleted. data/killed.json carries an excerpt, delisted carries a date,
  // the strike log carries the rewrite. A draft that failed is the record of how.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'brief.md'), 'too short');
  const moved = quarantine(dir, [{ artifact: 'brief.md', rule: 'word-count', message: 'x' }], { at: '2026-08-17' });
  assert.deepEqual(moved, ['rejected/brief.md']);
  assert.equal(fs.existsSync(path.join(dir, 'brief.md')), false, 'it must leave the shippable directory');
  assert.equal(fs.readFileSync(path.join(dir, 'rejected/brief.md'), 'utf8'), 'too short', 'and it must survive');
  assert.ok(fs.existsSync(path.join(dir, 'rejected/violation.json')));
});

t('the spec matches what packet.md already required', () => {
  // Restating a contract from memory is how two documents drift. These numbers
  // are the ones in .claude/agents/packet.md.
  assert.deepEqual(SPEC.brief, { minWords: 400, maxWords: 700 });
  assert.equal(SPEC.outreach.maxWords, 120);
  assert.deepEqual(SPEC.grade, { floor: 6.0, ceiling: 8.0 });
});

// ---------------------------------------------------------------------------
// The BLUF ceilings, verified from outside src/bluf.js
// ---------------------------------------------------------------------------

t('every derived BLUF still holds the 25-word ceiling and stays active', () => {
  const gates = (over = {}) =>
    Object.entries({ verdict: true, audit: true, acquittal: true, proof: true, decision_maker: true, ...over }).map(
      ([key, ok]) => ({ key, ok })
    );
  const all = [
    deriveBluf({ verdict: 'SHIP', gates: gates() }),
    ...['acquittal', 'proof', 'audit', 'decision_maker', 'verdict'].flatMap((k) =>
      ['PARK', 'REJECT'].map((v) => deriveBluf({ verdict: v, gates: gates({ verdict: false, [k]: false }) }))
    ),
  ];
  for (const b of all) {
    assert.ok(b.wordCount <= MAX_WORDS, `${b.wordCount} words: ${b.text}`);
    assert.deepEqual(b.errors, [], b.text);
  }
  assert.equal(MAX_WORDS, 25);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n${pass} passing`);
