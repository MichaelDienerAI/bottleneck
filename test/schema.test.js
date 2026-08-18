// Schema tests. These run without a network or a model, like gates.test.js,
// because they check the shape of what the bottleneck resource hands downstream.
//
// The two rules worth the file on their own: an evidence set made entirely of
// frontstage rows must fail, and a missing verify_seconds must throw at the row
// it is missing from rather than being collected into a report the caller can
// skim past.

import assert from 'node:assert';
import {
  validate,
  validateEvidence,
  validateAudit,
  loadSchema,
  derivePramana,
  pramanaFindings,
  PRAMANA_CLASSES,
  PRAMANA_REQUIRED_FROM,
  FILING_QUESTIONS,
  COVERAGE_THRESHOLD,
} from '../src/utils/schemaValidator.js';
import { calibrate } from '../src/utils/latencyGuard.js';

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

// Fails only on an AssertionError whose message names the thing it should.
const rejects = (fn, needle) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof assert.AssertionError, `expected an AssertionError, got ${e.constructor.name}`);
    assert.ok(
      e.message.includes(needle),
      `message should name ${JSON.stringify(needle)}, got: ${e.message}`
    );
    return true;
  });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const backstageRow = (over = {}) => ({
  claim: 'The voice pipeline has had no release in 94 days while the issue queue for latency grew.',
  inspectable_at: 'https://github.com/example/voice/releases',
  verify_seconds: 8,
  source_class: 'backstage',
  strength: 4,
  ...over,
});

const frontstageRow = (over = {}) => ({
  claim: 'The posting says the team is scaling voice quality work.',
  inspectable_at: 'https://boards.greenhouse.io/example/jobs/1',
  verify_seconds: 5,
  source_class: 'frontstage',
  strength: 1,
  ...over,
});

const evidencePayload = (over = {}) => ({
  dated: '2026-08-13',
  acquittal: 'EVIDENCE_SUFFICIENT',
  evidence: [backstageRow(), frontstageRow()],
  disconfirming: {
    query_issued: 'Search for a shipped latency fix in the last two release notes.',
    result: 'nothing. The last two notes cover billing and the dashboard.',
    survived: true,
  },
  ...over,
});

// 25 of 28 answered.
const auditPayload = (over = {}) => ({
  dated: '2026-08-13',
  coverage_score: 0.89,
  unanswered_question_numbers: [11, 12, 16],
  veto_results: {
    q9_link_behind_claim: true,
    q10_verify_under_60s: true,
    q13_source_beyond_posting: true,
    q19_staged_labeled: true,
    q20_agent_assisted_labeled: true,
  },
  auditor_evidence: [backstageRow({ claim: 'Release gap reproduced from the public tags page.' })],
  verdict: 'PASS',
  ...over,
});

// ---------------------------------------------------------------------------
// The schema files themselves
// ---------------------------------------------------------------------------

t('both schemas parse and name their rules', () => {
  for (const name of ['evidence.json', 'audit.json']) {
    const s = loadSchema(name);
    assert.equal(s.$id, name);
    assert.ok(Array.isArray(s['x-rules']) && s['x-rules'].length > 0, `${name} must list its extra-schema rules`);
    for (const r of s['x-rules']) {
      assert.ok(r.id && r.description && r.implemented_by, `${name}: every rule names where it is implemented`);
    }
  }
});

// ---------------------------------------------------------------------------
// Valid shapes
// ---------------------------------------------------------------------------

t('a well-formed evidence payload validates', () => {
  assert.deepEqual(validateEvidence(evidencePayload()), evidencePayload());
});

t('a single backstage row is enough', () => {
  validateEvidence(evidencePayload({ evidence: [backstageRow()] }));
});

t('strength accepts the whole 1 to 5 range', () => {
  for (const strength of [1, 2, 3, 4, 5]) {
    validateEvidence(evidencePayload({ evidence: [backstageRow({ strength })] }));
  }
});

t('an INSUFFICIENT_EVIDENCE acquittal with a named record validates on no rows', () => {
  validateEvidence(
    evidencePayload({
      acquittal: 'INSUFFICIENT_EVIDENCE',
      missing_record: 'A dated changelog. The repo is private and the status page has no history.',
      evidence: [],
    })
  );
});

t('a well-formed PASS audit validates', () => {
  assert.deepEqual(validateAudit(auditPayload()), auditPayload());
});

t('a REJECT audit validates with failed vetoes and low coverage', () => {
  // Nothing about REJECT requires the packet to be good. The vetoes are what
  // made it a REJECT.
  validateAudit(
    auditPayload({
      verdict: 'REJECT',
      coverage_score: 0.46,
      unanswered_question_numbers: [3, 4, 8, 11, 12, 15, 16, 17, 18, 21, 22, 24, 25, 27, 28],
      veto_results: {
        q9_link_behind_claim: false,
        q10_verify_under_60s: true,
        q13_source_beyond_posting: false,
        q19_staged_labeled: true,
        q20_agent_assisted_labeled: true,
      },
      auditor_evidence: [frontstageRow()],
    })
  );
});

// ---------------------------------------------------------------------------
// R-BACKSTAGE. The required failure mode.
// ---------------------------------------------------------------------------

t('an evidence payload of only frontstage rows fails', () => {
  rejects(
    () => validateEvidence(evidencePayload({ evidence: [frontstageRow(), frontstageRow()] })),
    'every row is frontstage'
  );
});

t('one frontstage row fails as surely as five', () => {
  // Volume of frontstage rows is not a substitute for one backstage trace.
  rejects(() => validateEvidence(evidencePayload({ evidence: [frontstageRow()] })), 'every row is frontstage');
  rejects(
    () => validateEvidence(evidencePayload({ evidence: Array.from({ length: 5 }, () => frontstageRow()) })),
    'every row is frontstage'
  );
});

t('a high strength score does not buy a frontstage row past the rule', () => {
  rejects(
    () => validateEvidence(evidencePayload({ evidence: [frontstageRow({ strength: 5 })] })),
    'every row is frontstage'
  );
});

t('a labeled specificity leak is admissible, and is no longer sufficient alone', () => {
  // R-BACKSTAGE used to accept an evidence set consisting of one labeled leak and
  // nothing else, and this test asserted exactly that. R-PRAMANA-INTEGRITY
  // narrows it: a leak is still the company talking, admissible as corroboration
  // and not as the sole basis for a sufficiency claim. The narrowing is
  // deliberate and the two rules are now read together — the leak passes
  // R-BACKSTAGE, and the set still needs something read off a machine.
  const leak = frontstageRow({
    claim: 'The posting names a 1.2s p95 target, a number no marketing page would volunteer.',
    specificity_leak: true,
  });

  rejects(() => validateEvidence(evidencePayload({ evidence: [leak] })), 'no DIRECT_OBSERVABLE row');

  validateEvidence(evidencePayload({ evidence: [backstageRow(), leak] }));
});

t('an unlabeled leak is just a posting', () => {
  rejects(
    () => validateEvidence(evidencePayload({ evidence: [frontstageRow({ specificity_leak: false })] })),
    'every row is frontstage'
  );
});

t('a PASS audit resting on frontstage alone fails', () => {
  rejects(
    () => validateAudit(auditPayload({ auditor_evidence: [frontstageRow()] })),
    'every row is frontstage'
  );
});

// ---------------------------------------------------------------------------
// verify_seconds. The other required failure mode.
// ---------------------------------------------------------------------------

t('a missing verify_seconds throws an assertion error', () => {
  const row = backstageRow();
  delete row.verify_seconds;
  rejects(() => validateEvidence(evidencePayload({ evidence: [row] })), 'missing required field verify_seconds');
});

t('the throw is immediate and names the first offending row', () => {
  // Not collected into a report. Two broken rows, and the error names row 0
  // only, which is what proves nothing downstream ran on a payload this shape.
  const bad = () => {
    const r = backstageRow();
    delete r.verify_seconds;
    return r;
  };
  let caught;
  try {
    validateEvidence(evidencePayload({ evidence: [bad(), bad()] }));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof assert.AssertionError, 'must be an AssertionError');
  assert.ok(caught.message.includes('evidence[0]'), `must name evidence[0], got: ${caught.message}`);
  assert.ok(!caught.message.includes('evidence[1]'), 'must not have gone on to the second row');
});

t('a missing verify_seconds in auditor_evidence throws across the file boundary', () => {
  const row = backstageRow();
  delete row.verify_seconds;
  rejects(() => validateAudit(auditPayload({ auditor_evidence: [row] })), 'missing required field verify_seconds');
});

t('verify_seconds must be a number, not a stringy one', () => {
  rejects(
    () => validateEvidence(evidencePayload({ evidence: [backstageRow({ verify_seconds: '8' })] })),
    'expected an integer'
  );
  rejects(
    () => validateEvidence(evidencePayload({ evidence: [backstageRow({ verify_seconds: -1 })] })),
    'below the minimum'
  );
});

// ---------------------------------------------------------------------------
// The rest of the evidence row
// ---------------------------------------------------------------------------

t('each required evidence field is required', () => {
  for (const field of ['claim', 'inspectable_at', 'verify_seconds', 'source_class', 'strength']) {
    const row = backstageRow();
    delete row[field];
    rejects(() => validateEvidence(evidencePayload({ evidence: [row] })), `missing required field ${field}`);
  }
});

t('inspectable_at must be a URL a stranger can open', () => {
  // A bare repo path is not inspectable without asking, which is the whole of P2.
  for (const bad of ['src/gates.js', 'see the changelog', '']) {
    rejects(
      () => validateEvidence(evidencePayload({ evidence: [backstageRow({ inspectable_at: bad })] })),
      'inspectable_at'
    );
  }
});

t('strength must be an integer inside 1 to 5', () => {
  for (const [strength, needle] of [[0, 'below the minimum'], [6, 'above the maximum'], [3.5, 'expected an integer'], ['sovereign', 'expected an integer']]) {
    rejects(() => validateEvidence(evidencePayload({ evidence: [backstageRow({ strength })] })), needle);
  }
});

t('source_class is closed to two values', () => {
  rejects(
    () => validateEvidence(evidencePayload({ evidence: [backstageRow({ source_class: 'backstage-ish' })] })),
    'is not one of backstage | frontstage'
  );
});

t('an unknown field on an evidence row is rejected rather than ignored', () => {
  rejects(
    () => validateEvidence(evidencePayload({ evidence: [backstageRow({ vibe: 'strong' })] })),
    'unexpected field vibe'
  );
});

// ---------------------------------------------------------------------------
// disconfirming
// ---------------------------------------------------------------------------

t('disconfirming is required at the root', () => {
  const p = evidencePayload();
  delete p.disconfirming;
  rejects(() => validateEvidence(p), 'missing required field disconfirming');
});

t('query_issued is required and cannot be blank', () => {
  const p = evidencePayload();
  delete p.disconfirming.query_issued;
  rejects(() => validateEvidence(p), 'missing required field query_issued');
  rejects(
    () => validateEvidence(evidencePayload({ disconfirming: { query_issued: '', result: 'nothing', survived: true } })),
    'must not be empty'
  );
});

t('a logged query with no logged result is not a logged attempt', () => {
  rejects(
    () => validateEvidence(evidencePayload({ disconfirming: { query_issued: 'q', survived: true } })),
    'missing required field result'
  );
});

// ---------------------------------------------------------------------------
// R-ACQUITTAL
// ---------------------------------------------------------------------------

t('INSUFFICIENT_EVIDENCE without a named record fails', () => {
  // P5. Naming the missing record is the finding. Leaving it out is a shrug.
  rejects(
    () => validateEvidence(evidencePayload({ acquittal: 'INSUFFICIENT_EVIDENCE', evidence: [] })),
    'requires the name of the record'
  );
  rejects(
    () =>
      validateEvidence(
        evidencePayload({ acquittal: 'INSUFFICIENT_EVIDENCE', missing_record: '   ', evidence: [] })
      ),
    'requires the name of the record'
  );
});

t('EVIDENCE_SUFFICIENT with no rows fails', () => {
  rejects(() => validateEvidence(evidencePayload({ evidence: [] })), 'EVIDENCE_SUFFICIENT with no rows');
});

t('acquittal is required and closed to the two states', () => {
  const p = evidencePayload();
  delete p.acquittal;
  rejects(() => validateEvidence(p), 'missing required field acquittal');
  rejects(() => validateEvidence(evidencePayload({ acquittal: 'NO_CONSTRAINT' })), 'is not one of');
});

t('the payload carries a date', () => {
  const p = evidencePayload();
  delete p.dated;
  rejects(() => validateEvidence(p), 'missing required field dated');
  rejects(() => validateEvidence(evidencePayload({ dated: 'August 2026' })), 'does not match');
});

// ---------------------------------------------------------------------------
// Audit vetoes and coverage
// ---------------------------------------------------------------------------

t('one false veto fails a PASS however high the coverage', () => {
  // The checkpoint the aggregate must not be able to outvote.
  for (const q of [
    'q9_link_behind_claim',
    'q10_verify_under_60s',
    'q13_source_beyond_posting',
    'q19_staged_labeled',
    'q20_agent_assisted_labeled',
  ]) {
    const p = auditPayload({ coverage_score: 1, unanswered_question_numbers: [] });
    p.veto_results[q] = false;
    rejects(() => validateAudit(p), `veto_results.${q}: false`);
  }
});

t('all five vetoes are required, so none can be quietly dropped', () => {
  for (const q of Object.keys(auditPayload().veto_results)) {
    const p = auditPayload();
    delete p.veto_results[q];
    rejects(() => validateAudit(p), `missing required field ${q}`);
  }
});

t('a sixth veto is rejected, since the mandatory set is fixed', () => {
  const p = auditPayload();
  p.veto_results.q26_named_person = true;
  rejects(() => validateAudit(p), 'unexpected field q26_named_person');
});

t('a PASS below the filing standard threshold fails', () => {
  assert.equal(COVERAGE_THRESHOLD, 0.5);
  rejects(
    () =>
      validateAudit(
        auditPayload({
          coverage_score: 0.46,
          unanswered_question_numbers: [3, 4, 8, 11, 12, 15, 16, 17, 18, 21, 22, 24, 25, 27, 28],
        })
      ),
    `below the filing standard threshold ${COVERAGE_THRESHOLD}`
  );
});

t('coverage must match its own unanswered list', () => {
  assert.equal(FILING_QUESTIONS, 28);
  rejects(
    () => validateAudit(auditPayload({ coverage_score: 0.5, unanswered_question_numbers: [] })),
    'does not match its own unanswered list'
  );
  // And the honest version of the same audit passes.
  validateAudit(auditPayload({ coverage_score: 1, unanswered_question_numbers: [] }));
});

t('question numbers stay inside the fixed list of 28 and do not repeat', () => {
  rejects(
    () => validateAudit(auditPayload({ coverage_score: 0.89, unanswered_question_numbers: [11, 12, 29] })),
    'above the maximum 28'
  );
  rejects(
    () => validateAudit(auditPayload({ coverage_score: 0.89, unanswered_question_numbers: [11, 12, 0] })),
    'below the minimum 1'
  );
  rejects(
    () => validateAudit(auditPayload({ coverage_score: 0.89, unanswered_question_numbers: [11, 11, 12] })),
    'contains duplicates'
  );
});

t('the verdict is closed to PASS and REJECT', () => {
  rejects(() => validateAudit(auditPayload({ verdict: 'CLEARED' })), 'is not one of PASS | REJECT');
  const p = auditPayload();
  delete p.verdict;
  rejects(() => validateAudit(p), 'missing required field verdict');
});

t('each required audit field is required', () => {
  for (const field of [
    'dated',
    'coverage_score',
    'unanswered_question_numbers',
    'veto_results',
    'auditor_evidence',
    'verdict',
  ]) {
    const p = auditPayload();
    delete p[field];
    rejects(() => validateAudit(p), `missing required field ${field}`);
  }
});

t('coverage_score is a fraction, not a 0 to 100 percentage', () => {
  rejects(() => validateAudit(auditPayload({ coverage_score: 89 })), 'above the maximum 1');
});

t('gaps are optional and typed when present', () => {
  validateAudit(auditPayload({ gaps: ['No dated record ties the release gap to the hiring plan.'] }));
  rejects(() => validateAudit(auditPayload({ gaps: 'none' })), 'expected array');
});

// ---------------------------------------------------------------------------
// The walker itself
// ---------------------------------------------------------------------------

t('validate names the schema it cannot find', () => {
  rejects(() => validate('nope.json', {}), 'nope.json not found');
});

t('a non-object payload fails at the root rather than silently passing', () => {
  rejects(() => validateEvidence('EVIDENCE_SUFFICIENT'), 'payload: expected object');
});


// ---------------------------------------------------------------------------
// R-PRAMANA-INTEGRITY — how a row is known, not how sure it is
// ---------------------------------------------------------------------------
//
// strength 1-5 said how sure. Nothing said HOW, and collapsing the two is how a
// confident reading of a press release outranks a hesitant reading of a commit
// log. These four classes are the means of knowledge; the number stays the
// confidence.

t('a declared DIRECT_OBSERVABLE satisfies the floor', () => {
  validateEvidence(
    evidencePayload({ evidence: [backstageRow({ pramana_class: 'DIRECT_OBSERVABLE' })] })
  );
});

t('the class defaults from source_class on artifacts predating the cutover', () => {
  // 120 evidence rows existed when the field was introduced and none carried it.
  // Requiring it retroactively would fail every artifact in the corpus at the
  // renderer and the recorder; backfilling would write a provenance claim nobody
  // made. So before the cutover it is derived and reported as derived.
  assert.equal(derivePramana({ source_class: 'backstage' }), 'DIRECT_OBSERVABLE');
  assert.equal(derivePramana({ source_class: 'frontstage' }), 'TESTIMONY');
  validateEvidence(evidencePayload({ dated: '2026-08-01', evidence: [backstageRow()] }));
});

t('the declaration is required from the cutover date onward', () => {
  rejects(
    () => validateEvidence(evidencePayload({ dated: PRAMANA_REQUIRED_FROM, evidence: [backstageRow()] })),
    'pramana_class is not declared'
  );
  validateEvidence(
    evidencePayload({
      dated: PRAMANA_REQUIRED_FROM,
      evidence: [backstageRow({ pramana_class: 'DIRECT_OBSERVABLE' })],
    })
  );
});

t('an evidence set with no DIRECT_OBSERVABLE fails whatever its date', () => {
  // A sufficiency claim resting entirely on accounts-of-self, stated in the
  // vocabulary of how rather than of where.
  rejects(
    () =>
      validateEvidence(
        evidencePayload({
          evidence: [frontstageRow({ specificity_leak: true, pramana_class: 'TESTIMONY' })],
        })
      ),
    'no DIRECT_OBSERVABLE row'
  );
});

t('TESTIMONY is admissible only as a labeled specificity leak', () => {
  rejects(
    () =>
      validateEvidence(
        evidencePayload({
          dated: PRAMANA_REQUIRED_FROM,
          evidence: [
            backstageRow({ pramana_class: 'DIRECT_OBSERVABLE' }),
            frontstageRow({ pramana_class: 'TESTIMONY' }),
          ],
        })
      ),
    'admissible only on a row flagged specificity_leak'
  );

  validateEvidence(
    evidencePayload({
      dated: PRAMANA_REQUIRED_FROM,
      evidence: [
        backstageRow({ pramana_class: 'DIRECT_OBSERVABLE' }),
        frontstageRow({ pramana_class: 'TESTIMONY', specificity_leak: true }),
      ],
    })
  );
});

t('the testimony rule is stricter than R-BACKSTAGE and is deferred, not dropped', () => {
  // R-BACKSTAGE permits unlabeled frontstage rows beside a backstage one, and six
  // of the eleven artifacts on disk carry such rows. Before the cutover the
  // violation is returned for reporting rather than thrown.
  const deferred = pramanaFindings(
    [backstageRow(), frontstageRow()],
    'evidence',
    { dated: '2026-08-01' }
  );
  assert.ok(deferred.some((m) => /specificity_leak/.test(m)), 'the finding must survive as a report');
});

t('INFERRED_RELATION requires the invariant that licenses it', () => {
  // An inference with no stated pervasion is an assertion with a longer sentence
  // in front of it. Naming the vyapti lets a stranger attack the invariant
  // instead of the conclusion.
  rejects(
    () =>
      validateEvidence(
        evidencePayload({
          evidence: [
            backstageRow({ pramana_class: 'DIRECT_OBSERVABLE' }),
            backstageRow({ pramana_class: 'INFERRED_RELATION' }),
          ],
        })
      ),
    'requires vyapti'
  );

  validateEvidence(
    evidencePayload({
      evidence: [
        backstageRow({ pramana_class: 'DIRECT_OBSERVABLE' }),
        backstageRow({
          pramana_class: 'INFERRED_RELATION',
          vyapti: 'Wherever a repository has no commits for 90 days, no one is assigned to it.',
        }),
      ],
    })
  );
});

t('an unknown pramana class is refused by the enum', () => {
  rejects(
    () => validateEvidence(evidencePayload({ evidence: [backstageRow({ pramana_class: 'VIBES' })] })),
    'is not one of'
  );
  assert.deepEqual(PRAMANA_CLASSES, ['DIRECT_OBSERVABLE', 'TESTIMONY', 'INFERRED_RELATION', 'HYPOTHETICAL']);
});

t('a HYPOTHETICAL row cannot stand in for an observable', () => {
  rejects(
    () =>
      validateEvidence(
        evidencePayload({ evidence: [backstageRow({ pramana_class: 'HYPOTHETICAL' })] })
      ),
    'no DIRECT_OBSERVABLE row'
  );
});

t('verify_seconds must be a whole number of seconds', () => {
  rejects(() => validateEvidence(evidencePayload({ evidence: [backstageRow({ verify_seconds: 7.5 })] })), 'expected an integer');
});

// ---------------------------------------------------------------------------
// The latency guard — Ibn al-Haytham, applied only where a fetch settles anything
// ---------------------------------------------------------------------------
//
// Measured 2026-08-17: a GET to the judgejudy repo returned in 0.77s while the
// corpus rows citing it declare 8s and 20s. A naive "flag anything 3x off the
// fetch" would flag every row on every run. A fetch is a floor, not an estimate:
// it proves a number impossible and proves a citation dead, and nothing else.

t('an unreachable trace fails whatever time it declares', () => {
  const f = calibrate(backstageRow({ verify_seconds: 8 }), { verdict: 'unreachable', status: 404 });
  assert.equal(f.ok, false);
  assert.equal(f.state, 'unreachable');
});

t('a declared time below the response floor is impossible', () => {
  const f = calibrate(backstageRow({ verify_seconds: 1 }), { verdict: 'reachable', seconds: 4.2 });
  assert.equal(f.state, 'impossible');
  assert.equal(f.ok, false);
});

t('a declared time inside 3x of the floor is flagged tight but not failed', () => {
  const f = calibrate(backstageRow({ verify_seconds: 2 }), { verdict: 'reachable', seconds: 1.0 });
  assert.equal(f.state, 'tight');
  assert.equal(f.ok, true);
});

t('a generous declaration is not a finding', () => {
  // Over-declaration proves nothing. 8s on a page that responds in 0.77s may be
  // entirely honest about a dense page, and manufacturing a flag out of it would
  // be the instrument reporting a concentration in a blank.
  const f = calibrate(backstageRow({ verify_seconds: 8 }), { verdict: 'reachable', seconds: 0.77 });
  assert.equal(f.state, 'plausible');
  assert.equal(f.ok, true);
});

t('a row with no url is unchecked rather than failed', () => {
  assert.equal(calibrate(backstageRow({ verify_seconds: 5 }), { verdict: 'no-url' }).state, 'unchecked');
});

t('a missing verify_seconds is caught by the guard as well as the schema', () => {
  const row = backstageRow();
  delete row.verify_seconds;
  assert.equal(calibrate(row, { verdict: 'reachable', seconds: 1 }).state, 'undeclared');
});


t('a negative observation is confirmed by its declared status, not failed', () => {
  // The first run of the trace verifier over the corpus flagged a live, correct
  // row as a dead citation: the claim was that a repository publishes no .github
  // directory, and the 404 at that path IS the evidence. Declaring the expected
  // status makes the negative observation checkable instead of broken.
  const row = backstageRow({ verify_seconds: 8, expected_status: 404 });
  const f = calibrate(row, { verdict: 'gone', status: 404, seconds: 0.4 });
  assert.equal(f.state, 'confirmed-absence');
  assert.equal(f.ok, true);
});

t('a declared expected status that no longer matches still fails', () => {
  // Not an escape hatch. If the absence stopped being the state of the world, the
  // row rests on something that is no longer true.
  const row = backstageRow({ verify_seconds: 8, expected_status: 404 });
  const f = calibrate(row, { verdict: 'reachable', status: 200, seconds: 0.4 });
  assert.equal(f.ok, false);
  assert.match(f.message, /no longer the state of the world/);
});

console.log(`\n${pass} passing`);
