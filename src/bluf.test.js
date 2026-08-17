// BLUF tests. No network, no model, like the rest of the suite.
//
// The line at the top of the Plain English view is the one sentence a reader
// takes on trust and the one most likely to be quoted back. So the checks here
// are not style preferences: each is a way the headline could say something the
// audit already killed, or say it in a register a hiring manager reads as
// filler. The two worth the file on their own are the struck-claim injection
// check and the missing-verdict case, because both fail silently if nobody
// tests them.

import assert from 'node:assert';
import {
  deriveBluf,
  validateBluf,
  struckOverlap,
  struckClaims,
  fkGrade,
  words,
  MAX_WORDS,
  FK_CEILING,
  BANNED_JARGON,
  MISSING_VERDICT_TEXT,
} from './bluf.js';

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

// True when some error names the thing it should. Errors are strings, so the
// assertion is on the message a person would read, not on a code.
const errs = (r, needle) =>
  assert.ok(
    r.errors.some((e) => e.toLowerCase().includes(needle.toLowerCase())),
    `expected an error naming ${JSON.stringify(needle)}, got: ${JSON.stringify(r.errors)}`
  );

const noErrs = (r) => assert.deepEqual(r.errors, []);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const gates = (over = {}) => {
  const base = { verdict: true, audit: true, acquittal: true, proof: true, decision_maker: true, ...over };
  return Object.entries(base).map(([key, ok]) => ({ key, ok }));
};

// Every verdict the derivation table covers, so a loop can assert the limits
// hold for all of them rather than for the one that happened to be written.
const ALL = [
  deriveBluf({ verdict: 'SHIP', gates: gates() }),
  ...['acquittal', 'proof', 'audit', 'decision_maker', 'verdict'].flatMap((k) =>
    ['PARK', 'REJECT'].map((v) => deriveBluf({ verdict: v, gates: gates({ verdict: false, [k]: false }) }))
  ),
];

// ---------------------------------------------------------------------------
// Word count
// ---------------------------------------------------------------------------

t('every derived BLUF is 25 words or fewer', () => {
  for (const b of ALL) {
    assert.ok(b.wordCount <= MAX_WORDS, `${b.wordCount} words: ${b.text}`);
    assert.ok(b.wordCount > 0, 'a BLUF with no words is not a BLUF');
  }
});

t('a 26-word BLUF fails on the count', () => {
  const long = Array.from({ length: 26 }, () => 'word').join(' ');
  errs(validateBluf(long), '26 words');
});

t('exactly 25 words passes and 25 is the boundary the code checks', () => {
  const at = Array.from({ length: MAX_WORDS }, () => 'word').join(' ');
  assert.ok(!validateBluf(at).errors.some((e) => e.includes('word limit')));
  assert.equal(words(at).length, 25);
});

// ---------------------------------------------------------------------------
// Banned jargon
// ---------------------------------------------------------------------------

t('every banned jargon word fails', () => {
  for (const term of BANNED_JARGON) {
    const r = validateBluf(`Apply. This line says ${term} out loud.`);
    errs(r, `banned jargon "${term}"`);
  }
});

t('jargon is caught whatever the case and whatever punctuation follows', () => {
  errs(validateBluf('Apply. The CONSTRAINT holds.'), 'constraint');
  errs(validateBluf('Apply. Read the ledger, then act.'), 'ledger');
  errs(validateBluf('Apply. It cleared Gate 0 already.'), 'Gate 0');
  errs(validateBluf('Apply. Check inspect_at first.'), 'inspect_at');
});

t('a word that merely contains a banned word is not a hit', () => {
  // "constrain" is not "constraint" and "assets" would be, so the boundary is
  // the whole word. A substring match here would fail honest prose.
  noErrs(validateBluf('Apply. Nothing here will constrain the team much at all.'));
});

t('no derived BLUF uses banned jargon', () => {
  for (const b of ALL) noErrs(b);
});

// ---------------------------------------------------------------------------
// Passive voice
// ---------------------------------------------------------------------------

t('passive voice is rejected', () => {
  errs(validateBluf('Apply. The packet was written by the diagnostician last week.'), 'passive');
  errs(validateBluf('Not yet. The claim is struck.'), 'passive');
  errs(validateBluf('Not yet. Nothing has been recorded here.'), 'passive');
  errs(validateBluf('Not yet. The name is not established anywhere.'), 'passive');
});

t('active voice passes', () => {
  noErrs(validateBluf('Apply. Michael holds public proof that acts on this problem.'));
  noErrs(validateBluf('Skip this one. The review rejected this file.'));
});

t('no derived BLUF is passive', () => {
  for (const b of ALL) assert.ok(!b.errors.some((e) => e.includes('passive')), b.text);
});

// ---------------------------------------------------------------------------
// Reading grade
// ---------------------------------------------------------------------------

t('a Flesch-Kincaid grade above 8.0 fails', () => {
  const dense =
    'Organizational infrastructure modernization necessitates comprehensive administrative reconsideration throughout every operational department.';
  assert.ok(fkGrade(dense) > FK_CEILING, `expected a high grade, got ${fkGrade(dense)}`);
  errs(validateBluf(dense), 'above the 8 ceiling');
});

t('every derived BLUF reads at or below grade 8.0', () => {
  for (const b of ALL) assert.ok(b.grade <= FK_CEILING, `grade ${b.grade}: ${b.text}`);
});

t('a grade below the 6.0 floor warns and does not fail', () => {
  // The floor cannot be an error. Flesch-Kincaid rewards long sentences and long
  // words, so a plain 18-word line scores near 2 precisely because it is plain.
  // Enforcing the floor would push filler into the one line that must not have
  // any. Recorded as a warning so the number is still visible.
  const b = deriveBluf({ verdict: 'SHIP', gates: gates() });
  assert.ok(b.grade < 6.0, `expected a low grade for a short line, got ${b.grade}`);
  noErrs(b);
  assert.ok(b.warnings.some((w) => w.includes('floor')), 'the floor should still be reported');
});

t('the grader scores a one-fragment line rather than returning nothing', () => {
  // readingGrade() in renderBrief.js refuses anything under three sentences,
  // which is every BLUF ever written. This one has to answer.
  assert.ok(typeof fkGrade('Apply. Michael holds proof.') === 'number');
  assert.equal(fkGrade(''), null);
});

// ---------------------------------------------------------------------------
// Em dashes
// ---------------------------------------------------------------------------

t('an em dash fails', () => {
  errs(validateBluf('Apply. Michael holds proof — send it today.'), 'em dash');
});

t('no derived BLUF carries an em dash', () => {
  for (const b of ALL) assert.ok(!/—/.test(b.text), b.text);
});

// ---------------------------------------------------------------------------
// Struck-text injection
// ---------------------------------------------------------------------------

const STRIKE = {
  claim:
    'binding_part: Front-end engineering seats on the AI Observability and Evals team. Four seats sit open.',
  reason: 'Fails the prove-the-claim test.',
};

t('a BLUF repeating a struck claim fails the render', () => {
  const r = validateBluf(
    'Apply. Front-end engineering seats on the AI Observability team cap the work.',
    struckClaims([STRIKE])
  );
  errs(r, 'repeats a struck claim');
});

t('an unrelated BLUF passes the same strike list', () => {
  noErrs(validateBluf('Apply. Michael holds public proof that acts on this problem.', struckClaims([STRIKE])));
});

t('overlap is measured on words, not on punctuation or case', () => {
  const hit = struckOverlap(
    'Not yet. FOUR SEATS SIT OPEN, and nobody filled them.',
    struckClaims([{ claim: 'evidence row 1: four seats sit open' }])
  );
  assert.ok(hit, 'normalization should let a requoted phrase land');
});

t('a row declaring NOT STRUCK is not treated as a strike', () => {
  // Rendering one of these as a strike would invert the auditor's finding, and
  // checking a BLUF against it would fail the render on a claim that survived.
  const rows = [
    { claim: 'NOT STRUCK: Michael holds public proof that acts on this problem.' },
    { claim: 'survived: the comp arithmetic held.' },
  ];
  assert.deepEqual(struckClaims(rows), []);
  noErrs(validateBluf('Apply. Michael holds public proof that acts on this problem.', struckClaims(rows)));
});

t('deriveBluf runs the injection check against the strikes it is handed', () => {
  // The templates are canned, so this can only fail if someone later writes a
  // template out of the diagnosis prose. That is exactly when it should fail.
  const b = deriveBluf({ verdict: 'SHIP', gates: gates(), struck: [{ claim: b0() }] });
  errs(b, 'repeats a struck claim');
  function b0() {
    return 'proof_match: Michael holds public, working proof that acts on the exact problem this team must solve now.';
  }
});

// ---------------------------------------------------------------------------
// Verdict derivation
// ---------------------------------------------------------------------------

t('SHIP opens with Apply', () => {
  assert.ok(deriveBluf({ verdict: 'SHIP', gates: gates() }).text.startsWith('Apply.'));
});

t('PARK opens with Not yet and names the deciding gate plus one action', () => {
  const b = deriveBluf({ verdict: 'PARK', gates: gates({ verdict: false, proof: false }) });
  assert.ok(b.text.startsWith('Not yet.'), b.text);
  assert.equal(b.decidingGate, 'proof');
  assert.ok(/Build and publish/.test(b.text), 'a PARK must carry the one action that unblocks it');
});

t('REJECT opens with Skip this one and names the failing gate', () => {
  const b = deriveBluf({ verdict: 'REJECT', gates: gates({ verdict: false, acquittal: false }) });
  assert.ok(b.text.startsWith('Skip this one.'), b.text);
  assert.equal(b.decidingGate, 'acquittal');
});

t('the deciding gate is the most specific failure, not the verdict restated', () => {
  // The verdict gate fails by definition on every PARK and REJECT, so reading it
  // as the reason would make every line say the same empty thing.
  const b = deriveBluf({ verdict: 'PARK', gates: gates({ verdict: false, audit: false }) });
  assert.equal(b.decidingGate, 'audit');
});

t('a PARK with no failing gate but its own verdict still derives a line', () => {
  const b = deriveBluf({ verdict: 'PARK', gates: gates({ verdict: false }) });
  assert.ok(b.text.startsWith('Not yet.'));
  assert.equal(b.decidingGate, 'verdict');
  noErrs(b);
});

t('the line is derived from the verdict, never re-decided from the gates', () => {
  // Same failing gate, two recorded verdicts, two different openers. The gate
  // chooses the reason; the verdict chooses the decision.
  const g = gates({ verdict: false, proof: false });
  assert.ok(deriveBluf({ verdict: 'PARK', gates: g }).text.startsWith('Not yet.'));
  assert.ok(deriveBluf({ verdict: 'REJECT', gates: g }).text.startsWith('Skip this one.'));
});

t('lowercase and padded verdicts still resolve', () => {
  assert.ok(deriveBluf({ verdict: '  ship ', gates: gates() }).text.startsWith('Apply.'));
});

// ---------------------------------------------------------------------------
// Missing verdict
// ---------------------------------------------------------------------------

t('a missing verdict renders the fixed text and fails loudly', () => {
  for (const v of [undefined, null, '', '   ']) {
    const b = deriveBluf({ verdict: v, gates: gates() });
    assert.equal(b.text, MISSING_VERDICT_TEXT);
    assert.equal(b.missingVerdict, true);
    assert.equal(b.ok, false);
    errs(b, 'refuses to guess');
  }
});

t('an unrecognized verdict is not guessed at either', () => {
  const b = deriveBluf({ verdict: 'MAYBE', gates: gates() });
  assert.equal(b.text, MISSING_VERDICT_TEXT);
  assert.equal(b.missingVerdict, true);
  errs(b, 'Unrecognized verdict');
});

t('a missing verdict does not borrow the gates to invent one', () => {
  // All five gates pass and there is still no verdict. The temptation is to read
  // that as SHIP. P4: no dated record says so.
  const b = deriveBluf({ gates: gates() });
  assert.equal(b.text, MISSING_VERDICT_TEXT);
  assert.ok(!/Apply/.test(b.text));
});

t('deriveBluf called with nothing at all still returns a rendered line', () => {
  const b = deriveBluf();
  assert.equal(b.text, MISSING_VERDICT_TEXT);
  assert.equal(b.ok, false);
});

console.log(`\n${pass} passing`);
