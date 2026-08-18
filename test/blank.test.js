// The false-positive harness. Two halves of one question: does this system
// manufacture findings?
//
// PART ONE, the method blank. test/fixtures/mundane-co.json is a company with a
// complete, unremarkable public record and no bottleneck. The only correct
// diagnosis is INSUFFICIENT_EVIDENCE with a named missing record. evaluateBlank
// is the judge, and these tests judge the judge — feeding it the outputs a
// contaminated instrument would produce and requiring that it catches each one.
//
// The live run is NOT here. Every suite in this repository is deterministic and
// docs/TECHNICAL_DESIGN.md commits to "no network and no model in any of them,"
// which a model call would break: the CLI would have to be installed, the suite
// would cost money per run, it would go flaky, and bin/run.sh would fail at 7am
// on a machine with no credentials. `npm run blank` does the live spawn and
// applies this same evaluateBlank to the result. What is tested here is exactly
// what runs there.
//
// PART TWO, the apoha filter. Evidence that ordinary growth predicts just as
// well as a bottleneck rules nothing out, and a pile of it is still nothing.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateBlank, loadFixture, blankPrompt, FIXTURE } from '../src/blank.js';
import {
  inferLikelihoodRatio,
  scoreRow,
  applyLikelihoodRatio,
  shipSupport,
  LR_FLOOR,
  ANCHORS,
} from '../src/utils/likelihoodRatio.js';
import { inspectArtifact } from '../src/validateArtifact.js';

const REPO = path.resolve(import.meta.dirname, '..');

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

const failed = (r, rule) =>
  assert.ok(
    r.failures.some((f) => f.rule === rule),
    `expected a ${rule} failure, got: ${JSON.stringify(r.failures.map((f) => f.rule))}`
  );

// The correct answer. Anything else in these tests is a mutation of it.
const clean = (over = {}) => ({
  company: 'Halcyon Ledger Systems',
  dated: '2026-08-17',
  acquittal: 'INSUFFICIENT_EVIDENCE',
  missing_record:
    'A reachable measurement of the live product, or any dated public trace showing a part of this company operating at its limit.',
  constraint_hypothesis: { weakest_link: null, binding_part: null, output_capped: null },
  evidence: [],
  disconfirming: { query_issued: 'is any public surface measurable', result: 'nothing', survived: false },
  verdict: 'REJECT',
  ...over,
});

// ---------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------

t('the fixture exists and is a complete record', () => {
  const f = loadFixture(REPO);
  assert.equal(f.record_is_complete, true);
  assert.ok(f.postings.length >= 2, 'a blank with one posting is thin enough to look like missing data');
  assert.ok(f.backstage.releases.length >= 5);
});

t('the fixture enumerates its absences rather than merely lacking them', () => {
  // Bacon's Table of Absence. An absence nobody wrote down is an absence nobody
  // controlled for, and the fixture would drift into "we forgot to add issues."
  const f = loadFixture(REPO);
  assert.ok(f.table_of_absence.length >= 6, 'too few signatures controlled for');
  for (const a of f.table_of_absence) {
    assert.ok(a.signature && a.observable_that_would_show_it && a.absent_because, `incomplete row: ${a.signature}`);
  }
});

t('every fixture URL is unresolvable by construction', () => {
  // .invalid is reserved by RFC 2606. No real employer can be implicated by this
  // file, and no accidental fetch can succeed against it.
  const raw = fs.readFileSync(path.join(REPO, FIXTURE), 'utf8');
  const urls = raw.match(/https?:\/\/[^"\s]+/g) || [];
  assert.ok(urls.length >= 5, 'expected the fixture to carry URLs');
  for (const u of urls) assert.match(u, /\.invalid(\/|$|")/, `${u} is not on the reserved .invalid TLD`);
});

t('the fixture shows a healthy operation, not a starved one', () => {
  // A blank has to be a company plainly WORKING. A fixture with no commits and no
  // releases is not a blank, it is a dead company, and finding no bottleneck in
  // one is not a test of anything.
  const b = loadFixture(REPO).backstage;
  assert.ok(b.commits_last_90_days > 100);
  assert.ok(b.closed_issues_last_90_days > b.open_issues);
  assert.equal(b.incidents_last_12_months, 0);
  assert.ok(b.open_issue_age_days.p90 < 30, 'a p90 issue age in the hundreds would be a real signature');
});

t('the blank prompt hands over the record and forbids searching', () => {
  // Without this the run tests whether the web knows Halcyon Ledger Systems,
  // which it does not, and INSUFFICIENT_EVIDENCE would come back for the wrong
  // reason. The question is whether a complete unremarkable record produces an
  // invented constraint.
  const p = blankPrompt(loadFixture(REPO), '/tmp/x.yaml');
  assert.match(p, /complete public record/i);
  assert.match(p, /should not\s+issue one/i);
  assert.match(p, /Do not adjust it because the record is short/i);
});

// ---------------------------------------------------------------------------
// The judge — the correct answer
// ---------------------------------------------------------------------------

t('the correct answer passes', () => {
  const r = evaluateBlank(clean());
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
  assert.equal(r.drift, null);
});

t('an empty constraint hypothesis in any falsy shape passes', () => {
  for (const v of [null, '', '   ', 'none', 'N/A', 'INSUFFICIENT_EVIDENCE']) {
    const r = evaluateBlank(clean({ constraint_hypothesis: { binding_part: v, weakest_link: v, output_capped: v } }));
    assert.deepEqual(r.failures, [], `${JSON.stringify(v)} should not read as an asserted constraint`);
  }
});

// ---------------------------------------------------------------------------
// The judge — every way a contaminated instrument reports a concentration
// ---------------------------------------------------------------------------

t('claiming EVIDENCE_SUFFICIENT on the blank fails', () => {
  const r = evaluateBlank(clean({ acquittal: 'EVIDENCE_SUFFICIENT' }));
  failed(r, 'R-ACQUITTAL');
  assert.equal(r.drift, 'false-positive');
});

t('a missing acquittal fails rather than defaulting', () => {
  const doc = clean();
  delete doc.acquittal;
  failed(evaluateBlank(doc), 'R-ACQUITTAL');
});

t('inventing a binding part fails, and is recorded as drift', () => {
  // The specific output the whole procedure pulls toward. It reads as a finding
  // whether or not anything supports it.
  const r = evaluateBlank(
    clean({ constraint_hypothesis: { binding_part: 'the integrations team, which cannot keep pace with upstream API changes' } })
  );
  failed(r, 'P3');
  assert.equal(r.drift, 'false-positive');
});

t('writing the Weakest Link formula fails', () => {
  const r = evaluateBlank(
    clean({
      constraint_hypothesis: {
        weakest_link: 'Halcyon Ledger Systems produces no more reconciled ledgers than its slowest connector allows.',
      },
    })
  );
  failed(r, 'P3');
});

t('naming a capped output fails', () => {
  failed(evaluateBlank(clean({ constraint_hypothesis: { output_capped: 'connectors kept current per quarter' } })), 'P3');
});

t('a SHIP verdict on the blank fails', () => {
  failed(evaluateBlank(clean({ verdict: 'SHIP' })), 'verdict');
});

t('an acquittal with no missing record fails under P5', () => {
  const doc = clean();
  delete doc.missing_record;
  failed(evaluateBlank(doc), 'P5');
});

t('a shrug in place of a named record fails under P5', () => {
  // "nothing" is not the name of a document. P5 wants the record that would
  // settle it, which is a finding; the absence of one is not.
  for (const shrug of ['nothing', 'none', 'N/A', 'unknown', 'no record', 'not enough evidence']) {
    failed(evaluateBlank(clean({ missing_record: shrug })), 'P5');
  }
});

t('no artifact at all is caught rather than passing vacuously', () => {
  for (const v of [null, undefined, 'a string']) {
    const r = evaluateBlank(v);
    assert.equal(r.ok, false);
    assert.equal(r.drift, 'no-output');
  }
});

t('several contaminations are all reported, not just the first', () => {
  const r = evaluateBlank(
    clean({
      acquittal: 'EVIDENCE_SUFFICIENT',
      verdict: 'SHIP',
      constraint_hypothesis: { binding_part: 'the connector pipeline' },
    })
  );
  assert.ok(r.failures.length >= 3, `expected every failure, got ${r.failures.length}`);
});

t('strong backstage rows under an acquittal are noted, not failed', () => {
  // Recording what was looked at is honest. It is worth reading, not refusing.
  const r = evaluateBlank(
    clean({
      evidence: [
        {
          claim: 'The release cadence is every 14 days across 8 releases.',
          inspectable_at: 'https://github.invalid/halcyon-ledger/client-sdk/releases',
          verify_seconds: 6,
          source_class: 'backstage',
          strength: 5,
        },
      ],
    })
  );
  assert.deepEqual(r.failures, []);
  assert.ok(r.notes.some((n) => /ordinary operation/.test(n)));
});

// ---------------------------------------------------------------------------
// Apoha — the likelihood ratio filter
// ---------------------------------------------------------------------------

t('an observation ordinary growth predicts just as well scores at the floor', () => {
  // The LangChain case, recorded in that artifact's own audit gaps: five open
  // reqs after a $125M Series B. Both readings predict it, so it excludes nothing.
  const { lr, basis } = inferLikelihoodRatio({
    claim: 'Four of their nine open engineering reqs sit on the team that builds those surfaces.',
  });
  assert.equal(lr, ANCHORS.NON_DISCRIMINATING);
  assert.ok(lr < LR_FLOOR);
  assert.match(basis, /growth predicts this/);
});

t('funding and hiring language is non-discriminating', () => {
  for (const claim of [
    'The company raised a $125M Series B in March.',
    'The team is growing quickly.',
    'They have multiple open roles on the platform team.',
    'The posting says the team is scaling voice quality work.',
  ]) {
    assert.ok(inferLikelihoodRatio({ claim }).lr < LR_FLOOR, claim);
  }
});

t('a duration plus a stopped cadence discriminates strongly', () => {
  const { lr } = inferLikelihoodRatio({
    claim: 'No releases in 94 days, and the oldest open issue has been unresolved since 2025-02-19.',
  });
  assert.equal(lr, ANCHORS.STRONG);
});

t('a single qualifier discriminates moderately', () => {
  const { lr, basis } = inferLikelihoodRatio({ claim: 'The p90 open issue age is 240 days.' });
  assert.equal(lr, ANCHORS.MODERATE);
  assert.ok(lr >= LR_FLOOR);
  assert.match(basis, /distribution/);
});

t('a qualifier attached to a growth-shaped claim is a tie, not a win', () => {
  // This is the apoha move doing real work. "Five reqs open for 18 months" reads
  // like strong evidence; the duration cuts toward a bottleneck and the req count
  // cuts toward growth, and the row cannot settle between them on its own.
  const { lr, basis } = inferLikelihoodRatio({
    claim: 'They have 5 open reqs on one team and two of them have stayed open 18 months.',
  });
  assert.equal(lr, ANCHORS.WEAK);
  assert.ok(lr < LR_FLOOR, 'a competing pair must not clear the floor');
  assert.match(basis, /compete/);
});

t('a first-hand measurement discriminates', () => {
  assert.ok(inferLikelihoodRatio({ claim: 'I measured time to first token at 2.4s across ten runs.' }).lr >= LR_FLOOR);
});

t('a declared likelihood ratio wins over the inference but still meets the floor', () => {
  const row = { claim: 'They are hiring a lot.', likelihood_ratio: 3.0 };
  const s = scoreRow(row);
  assert.equal(s.likelihood_ratio, 3.0);
  assert.equal(s.declared, true);
  assert.equal(s.discriminating, true);

  const low = scoreRow({ claim: 'No releases in 94 days.', likelihood_ratio: 1.1 });
  assert.equal(low.discriminating, false, 'a declared value below the floor is still below the floor');
});

t('scoring annotates without mutating and without touching specificity_leak', () => {
  // specificity_leak already means "a frontstage row admissible because
  // frontstage control failed" and the auditor reads it. Writing it here would
  // say something false about a field that already has a meaning.
  const rows = [{ claim: 'They are hiring.', source_class: 'frontstage' }];
  const out = applyLikelihoodRatio(rows);
  assert.equal(rows[0].likelihood_ratio, undefined, 'the input must not be mutated');
  assert.equal(out[0].discriminating, false);
  assert.ok(!('specificity_leak' in out[0]), 'the apoha filter must not overwrite an unrelated schema field');
});

t('ten non-discriminating rows do not add up to one discriminating row', () => {
  // The aggregate is exactly what lets a pile of growth-explicable observations
  // look like a case. Counting findings is the habit this bars.
  const rows = Array.from({ length: 10 }, (_, i) => ({ claim: `They have ${i + 2} open roles and are growing.` }));
  const s = shipSupport(rows);
  assert.equal(s.supported, false);
  assert.equal(s.barred.length, 10);
  assert.match(s.reason, /rest on a count rather than a discrimination/);
});

t('one discriminating row is enough to carry a SHIP', () => {
  const s = shipSupport([
    { claim: 'They are hiring three engineers.' },
    { claim: 'The instant() helper has had no commits in 210 days while its issue queue grew.' },
  ]);
  assert.equal(s.supported, true);
  assert.equal(s.supporting.length, 1);
  assert.equal(s.barred.length, 1);
});

// ---------------------------------------------------------------------------
// Where the filter bites
// ---------------------------------------------------------------------------

const shipDoc = (evidence, auditVerdict) => ({
  dated: '2026-08-17',
  acquittal: 'EVIDENCE_SUFFICIENT',
  evidence,
  disconfirming: { query_issued: 'q', result: 'nothing', survived: true },
  verdict: 'SHIP',
  audit: {
    dated: '2026-08-17',
    coverage_score: 0.89,
    unanswered_question_numbers: [11, 12, 25],
    veto_results: {
      q9_link_behind_claim: true,
      q10_verify_under_60s: true,
      q13_source_beyond_posting: true,
      q19_staged_labeled: true,
      q20_agent_assisted_labeled: true,
    },
    auditor_evidence: [
      {
        claim: 'independent backstage row',
        inspectable_at: 'https://example.com/x',
        verify_seconds: 4,
        source_class: 'backstage',
        strength: 4,
      },
    ],
    verdict: auditVerdict,
  },
});

const growthRow = {
  claim: 'They have four open reqs on one team and the team is growing.',
  inspectable_at: 'https://example.com/board',
  verify_seconds: 5,
  source_class: 'backstage',
  strength: 4,
};

t('a SHIP that cleared its audit fails when nothing discriminates', () => {
  const r = inspectArtifact(shipDoc([growthRow], 'PASS'), { checkSeal: false });
  assert.ok(
    r.findings.some((f) => f.severity === 'error' && f.rule === 'LR-FLOOR'),
    'a packet about to be written on non-discriminating evidence must be stopped'
  );
});

t('the same evidence under a PARK is reported and not blocked', () => {
  // Failing every PARK on a rule invented after they were written would take the
  // record offline to enforce it. A PARK resting on non-discriminating rows is
  // often exactly why it parked.
  const doc = shipDoc([growthRow], 'PASS');
  doc.verdict = 'PARK';
  const r = inspectArtifact(doc, { checkSeal: false });
  assert.deepEqual(r.findings.filter((f) => f.severity === 'error'), []);
  assert.ok(r.findings.some((f) => f.rule === 'LR-FLOOR' && f.severity === 'info'));
});

t('a SHIP whose audit rejected it is not blocked by the filter', () => {
  // It is already stopped by the audit. Two refusals for one artifact tells the
  // writer less, not more.
  const r = inspectArtifact(shipDoc([growthRow], 'REJECT'), { checkSeal: false });
  assert.deepEqual(r.findings.filter((f) => f.severity === 'error' && f.rule === 'LR-FLOOR'), []);
});

t('a SHIP resting on one discriminating row passes', () => {
  const strong = {
    claim: 'No releases in 94 days while the p90 issue age reached 240 days.',
    inspectable_at: 'https://example.com/releases',
    verify_seconds: 6,
    source_class: 'backstage',
    strength: 5,
  };
  const r = inspectArtifact(shipDoc([growthRow, strong], 'PASS'), { checkSeal: false });
  assert.deepEqual(r.findings.filter((f) => f.severity === 'error'), []);
});

console.log(`\n${pass} passing`);
