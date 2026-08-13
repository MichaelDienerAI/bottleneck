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
  FILING_QUESTIONS,
  COVERAGE_THRESHOLD,
} from '../src/utils/schemaValidator.js';

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

t('a labeled specificity leak is the one frontstage row that counts', () => {
  validateEvidence(
    evidencePayload({
      evidence: [
        frontstageRow({
          claim: 'The posting names a 1.2s p95 target, a number no marketing page would volunteer.',
          specificity_leak: true,
        }),
      ],
    })
  );
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
    'expected a number'
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

console.log(`\n${pass} passing`);
