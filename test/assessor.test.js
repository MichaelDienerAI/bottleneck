// The epistemic asset assessor.
//
// The load-bearing assertion in this file is the one that says match_score is
// not a verdict. A number attached to a candidate-company pair invites being read
// as fit, and this one counts inspectable preconditions: whether a proof is
// named, resolves to one ledger entry, opens to something, and carries a stated
// causal middle term with the form of an inference. Whether it actually resolves
// the bottleneck is a causal claim, P4 governs it, and no string comparison
// produces a dated record.

import assert from 'node:assert';
import {
  assessProof,
  resolveProof,
  domainOverlap,
  assessMiddleTerm,
  isInspectable,
  commercialReady,
  COMPONENTS,
  MAX_SCORE,
  HIT_REQUIREMENTS,
} from '../src/assessor.js';

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

const ledger = {
  sovereign: [
    {
      id: 'deformation_test_bank',
      name: 'Deformation Test Bank',
      inspect_at: 'https://example.com/bank',
      acts_on_constraints: ['evaluation harness coverage', 'adversarial eval methodology'],
    },
    { id: 'persona_io', name: 'Persona iO', inspect_at: 'https://personaio.app', acts_on_constraints: ['conversational latency'] },
  ],
  speculative: [{ id: 'resume', name: 'Resume', role: 'index' }],
};

// A syllogism whose middle term appears in both premises and not the conclusion.
const middle = {
  major: 'A team with no adversarial eval harness cannot measure policy coverage.',
  minor: 'This team has no adversarial eval harness.',
  middle_term: 'adversarial eval harness',
  conclusion: 'This team cannot measure policy coverage.',
};

const backstage = (over = {}) => ({
  claim: 'No commits to the eval repo in 94 days.',
  inspectable_at: 'https://example.com/commits',
  verify_seconds: 8,
  source_class: 'backstage',
  strength: 4,
  ...over,
});

const diagnosis = (over = {}) => ({
  company: 'Testco',
  dated: '2026-08-15',
  constraint_hypothesis: { binding_part: 'The adversarial evaluation harness for policy coverage.' },
  evidence: [backstage()],
  proof_match: { asset: 'deformation_test_bank', tier: 'sovereign', acts_on_constraint: true, middle_term: middle },
  ...over,
});

const delta = (over) => assessProof({ diagnosis: diagnosis(over), ledger }).proof_delta;

// ---------------------------------------------------------------------------
// What the score is, and is not
// ---------------------------------------------------------------------------

t('the components sum to the advertised maximum', () => {
  assert.equal(COMPONENTS.reduce((n, c) => n + c.points, 0), MAX_SCORE);
  assert.equal(MAX_SCORE, 100);
});

t('every result carries the caveat that the score is not fit', () => {
  // A number invites being read as a verdict. This one counts preconditions.
  const r = assessProof({ diagnosis: diagnosis(), ledger });
  assert.match(r.caveat, /counts inspectable preconditions, not fit/);
  assert.match(r.caveat, /P4/);
});

t('every awarded point traces to a named repeatable check', () => {
  const d = delta();
  for (const c of d.components) {
    assert.ok(c.key && c.describe, 'a component with no description is a number nobody can argue with');
    assert.equal(c.awarded, c.passed ? c.points : 0);
  }
  assert.equal(d.components.reduce((n, c) => n + c.awarded, 0), d.match_score);
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

t('an empty asset field matches nothing rather than everything', () => {
  // `''.includes('')` is true for every string. That bug once made every ledger
  // entry match every asset in src/diorismos.js.
  assert.equal(resolveProof('', ledger).candidates.length, 0);
  assert.equal(resolveProof(null, ledger).entry, null);
});

t('an asset naming two entries resolves to neither', () => {
  const r = resolveProof('deformation_test_bank and persona_io', ledger);
  assert.equal(r.entry, null);
  assert.equal(r.candidates.length, 2);
});

t('a speculative proof resolves but is not sovereign', () => {
  const r = resolveProof('resume', ledger);
  assert.equal(r.tier, 'speculative');
  const d = delta({ proof_match: { asset: 'resume', acts_on_constraint: true, middle_term: middle } });
  assert.equal(d.direct_hits.length, 0);
  assert.ok(d.unverified_gaps.some((g) => /speculative half/.test(g)));
});

t('a proof with no public URL is not inspectable, whatever the ledger calls it', () => {
  // profile/proof-ledger.yaml really does carry TODO_PUBLIC_URL on this entry.
  assert.equal(isInspectable('TODO_PUBLIC_URL'), false);
  assert.equal(isInspectable(''), false);
  assert.equal(isInspectable('src/gates.js'), false, 'a repo path is not something a stranger opens');
  assert.equal(isInspectable('https://example.com/bank'), true);

  const stale = { sovereign: [{ ...ledger.sovereign[0], inspect_at: 'TODO_PUBLIC_URL' }], speculative: [] };
  const d = assessProof({ diagnosis: diagnosis(), ledger: stale }).proof_delta;
  assert.equal(d.direct_hits.length, 0);
  assert.ok(d.unverified_gaps.some((g) => /MISSING RECORD/.test(g)));
});

// ---------------------------------------------------------------------------
// The middle term
// ---------------------------------------------------------------------------

t('an absent middle term is a missing record, not an inferred one', () => {
  // Nothing is guessed. An unstated causal link is a finding under P5.
  const r = assessMiddleTerm({ proof_match: { asset: 'x' } });
  assert.equal(r.present, false);
  assert.match(r.problems[0], /assertion with a proof beside it/);
});

t('a broken middle term fails the hit requirement', () => {
  const broken = { ...middle, middle_term: 'something that appears nowhere' };
  const d = delta({ proof_match: { asset: 'deformation_test_bank', acts_on_constraint: true, middle_term: broken } });
  assert.ok(d.failed_requirements.includes('middle_term'));
  assert.equal(d.direct_hits.length, 0);
});

t('a middle term surviving into the conclusion is not an inference', () => {
  const restated = {
    major: 'A repo with no commits in 94 days is stalled.',
    minor: 'The eval repo has no commits in 94 days.',
    middle_term: 'no commits in 94 days',
    conclusion: 'The eval repo has no commits in 94 days.',
  };
  const d = delta({ proof_match: { asset: 'deformation_test_bank', acts_on_constraint: true, middle_term: restated } });
  assert.ok(d.failed_requirements.includes('middle_term'));
});

// ---------------------------------------------------------------------------
// Domain overlap — weak evidence, weighted as weak
// ---------------------------------------------------------------------------

t('overlap is shared terms, and is worth ten points out of a hundred', () => {
  const o = domainOverlap(['adversarial eval methodology'], 'The adversarial evaluation harness for policy coverage.');
  assert.ok(o.overlaps);
  assert.ok(o.shared.includes('adversarial'));
  assert.equal(COMPONENTS.find((c) => c.key === 'domain_overlap').points, 10);
});

t('overlap is never a hit requirement', () => {
  // Two documents about evaluation harnesses share words whether or not one
  // fixes the other.
  assert.ok(!HIT_REQUIREMENTS.includes('domain_overlap'));
});

t('stopwords do not manufacture an overlap', () => {
  assert.equal(domainOverlap(['the and of for'], 'the and of for').overlaps, false);
});

// ---------------------------------------------------------------------------
// Direct hits
// ---------------------------------------------------------------------------

t('a complete chain is a direct hit', () => {
  const d = delta();
  assert.equal(d.direct_hits.length, 1);
  assert.equal(d.direct_hits[0].proof, 'deformation_test_bank');
  assert.equal(d.match_score, MAX_SCORE);
  assert.deepEqual(d.failed_requirements, []);
});

t('acts_on_constraint false is respected, not overruled', () => {
  // The diagnostician recorded a judgment. This module does not second-guess it.
  const d = delta({
    proof_match: { asset: 'deformation_test_bank', acts_on_constraint: false, middle_term: middle },
  });
  assert.equal(d.direct_hits.length, 0);
  assert.ok(d.unverified_gaps.some((g) => /does not overrule that/.test(g)));
});

t('a high score with a failed requirement is still zero hits', () => {
  // The point of the conjunction. A proof nobody can open does not become
  // defensible by scoring well elsewhere.
  const stale = { sovereign: [{ ...ledger.sovereign[0], inspect_at: 'TODO_PUBLIC_URL' }], speculative: [] };
  const d = assessProof({ diagnosis: diagnosis(), ledger: stale }).proof_delta;
  assert.ok(d.match_score >= 60, `expected a high score, got ${d.match_score}`);
  assert.equal(d.direct_hits.length, 0);
});

// ---------------------------------------------------------------------------
// Gaps are the useful half
// ---------------------------------------------------------------------------

t('an evidence set with no DIRECT_OBSERVABLE is named as a gap', () => {
  const d = delta({ evidence: [backstage({ source_class: 'frontstage', pramana_class: 'TESTIMONY' })] });
  assert.ok(d.unverified_gaps.some((g) => /rests on accounts rather than on traces/.test(g)));
});

t('evidence is counted by how it is known', () => {
  const d = delta({
    evidence: [backstage(), backstage({ source_class: 'frontstage', pramana_class: 'TESTIMONY', specificity_leak: true })],
  });
  assert.equal(d.evidence_by_pramana.DIRECT_OBSERVABLE, 1);
  assert.equal(d.evidence_by_pramana.TESTIMONY, 1);
});

t('every gap names a record or a field rather than a feeling', () => {
  const d = delta({ proof_match: { asset: 'nothing_by_this_name' } });
  assert.ok(d.unverified_gaps.length >= 2);
  for (const g of d.unverified_gaps) {
    assert.ok(g.length > 30, `a gap too short to act on: ${g}`);
  }
});

// ---------------------------------------------------------------------------
// The commercial gate
// ---------------------------------------------------------------------------

t('zero direct hits refuses a commercial dossier', () => {
  const r = commercialReady(assessProof({ diagnosis: diagnosis({ proof_match: { asset: 'resume' } }), ledger }));
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /opinion with a letterhead/);
});

t('one direct hit clears it', () => {
  assert.equal(commercialReady(assessProof({ diagnosis: diagnosis(), ledger })).ok, true);
});

t('the gate is a conjunction, not a threshold on the score', () => {
  // A proof nobody can open does not become defensible by scoring 80.
  const stale = { sovereign: [{ ...ledger.sovereign[0], inspect_at: 'TODO_PUBLIC_URL' }], speculative: [] };
  const r = commercialReady(assessProof({ diagnosis: diagnosis(), ledger: stale }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /failed requirement: inspectable/.test(x)));
});

t('a missing delta refuses rather than passing vacuously', () => {
  assert.equal(commercialReady(null).ok, false);
  assert.equal(commercialReady({}).ok, false);
});

console.log(`\n${pass} passing`);
