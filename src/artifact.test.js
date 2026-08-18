// The production schema gate and the pre-audit seal.
//
// src/utils/schemaValidator.js could always check an evidence payload and an
// audit payload. Nothing called it on a file. Both validators were reachable
// only from test/schema.test.js and only ever handed object literals, so every
// rule they enforce was in practice enforced by asking a model to follow
// instructions. These tests cover the call site that closes that gap, and the
// seal that answers the question the artifact could not answer before: did the
// auditor append, or did it revise?

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  validateArtifact,
  inspectArtifact,
  evidencePayloadOf,
  ArtifactError,
  VETO_QUESTIONS,
} from './validateArtifact.js';
import { digestOf, diagnosticianView, seal, verify, sealPathFor } from './integrity.js';

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

const errs = (r, needle) =>
  assert.ok(
    r.findings.some((f) => f.severity === 'error' && f.message.includes(needle)),
    `expected an error naming ${JSON.stringify(needle)}, got: ${JSON.stringify(r.findings.map((f) => f.message))}`
  );

const noErrs = (r) =>
  assert.deepEqual(
    r.findings.filter((f) => f.severity === 'error').map((f) => f.message),
    []
  );

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const backstageRow = (over = {}) => ({
  claim: 'The voice pipeline has had no release in 94 days while the latency queue grew.',
  inspectable_at: 'https://github.com/example/voice/releases',
  verify_seconds: 8,
  source_class: 'backstage',
  strength: 4,
  ...over,
});

const auditBlock = (over = {}) => ({
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
  // A DIFFERENT url from the diagnosis row. It used to reuse the same one and
  // call itself independent, which src/blind.js citationIsolation now catches:
  // an audit assembled from the diagnostician's own citations is a proofread.
  auditor_evidence: [
    backstageRow({
      claim: 'Independent backstage row the diagnostician did not cite.',
      inspectable_at: 'https://status.example.com/history',
    }),
  ],
  verdict: 'PASS',
  ...over,
});

const doc = (over = {}) => ({
  company: 'Testco',
  role: 'Engineer',
  dated: '2026-08-17',
  acquittal: 'EVIDENCE_SUFFICIENT',
  evidence: [backstageRow()],
  disconfirming: { query_issued: 'Does the team ship weekly?', result: 'nothing', survived: true },
  verdict: 'PARK',
  ...over,
});

const roots = [];
function writeArtifact(d, name = 'testco.yaml') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottleneck-artifact-'));
  roots.push(root);
  const p = path.join(root, name);
  fs.writeFileSync(p, yaml.dump(d));
  return p;
}

// ---------------------------------------------------------------------------
// The evidence payload projection
// ---------------------------------------------------------------------------

t('the projection lifts exactly the five schema-owned keys', () => {
  // The rest of a diagnosis is the wrapper and is deliberately not schema
  // checked. A projection that swept in `company` or `verdict` would fail every
  // artifact on additionalProperties: false.
  const p = evidencePayloadOf(doc());
  assert.deepEqual(Object.keys(p).sort(), ['acquittal', 'dated', 'disconfirming', 'evidence']);
});

t('missing_record is carried through when present', () => {
  const p = evidencePayloadOf(doc({ acquittal: 'INSUFFICIENT_EVIDENCE', missing_record: 'A dated count.' }));
  assert.equal(p.missing_record, 'A dated count.');
});

// ---------------------------------------------------------------------------
// Schema violations
// ---------------------------------------------------------------------------

t('a well-formed artifact passes', () => {
  noErrs(inspectArtifact(doc({ audit: auditBlock() }), { checkSeal: false }));
});

t('an unquoted YAML date fails', () => {
  // The defect class warned about in three documents and enforced in none: an
  // unquoted `dated:` parses to a Date, and the schema requires a string.
  const r = inspectArtifact(doc({ dated: new Date('2026-08-17') }), { checkSeal: false });
  errs(r, 'dated');
});

t('an evidence set that is entirely frontstage fails and names Q13', () => {
  const r = inspectArtifact(
    doc({ evidence: [backstageRow({ source_class: 'frontstage', specificity_leak: false })] }),
    { checkSeal: false }
  );
  errs(r, 'every row is frontstage');
  const f = r.findings.find((x) => x.question === 13);
  assert.ok(f, 'R-BACKSTAGE should carry the filing-standard question behind it');
});

t('a labeled specificity leak is admissible alongside an observable', () => {
  // R-PRAMANA-INTEGRITY narrowed R-BACKSTAGE: a lone labeled leak used to be a
  // complete evidence set and no longer is. The leak is still the company
  // talking, so it corroborates something read off a machine rather than
  // standing in for one.
  const leak = backstageRow({ source_class: 'frontstage', specificity_leak: true });
  errs(inspectArtifact(doc({ evidence: [leak] }), { checkSeal: false }), 'no DIRECT_OBSERVABLE row');
  noErrs(inspectArtifact(doc({ evidence: [backstageRow(), leak] }), { checkSeal: false }));
});

t('INSUFFICIENT_EVIDENCE without a named missing record fails', () => {
  const r = inspectArtifact(doc({ acquittal: 'INSUFFICIENT_EVIDENCE', evidence: [] }), { checkSeal: false });
  errs(r, 'missing_record');
});

t('a missing verify_seconds fails and names Q10', () => {
  const row = backstageRow();
  delete row.verify_seconds;
  const r = inspectArtifact(doc({ evidence: [row] }), { checkSeal: false });
  errs(r, 'verify_seconds');
  assert.ok(r.findings.some((f) => f.question === 10));
});

t('a bare repo path is not an inspectable URL', () => {
  const r = inspectArtifact(doc({ evidence: [backstageRow({ inspectable_at: 'src/gates.js' })] }), { checkSeal: false });
  errs(r, 'not an inspectable URL');
  assert.ok(r.findings.some((f) => f.question === 9));
});

// ---------------------------------------------------------------------------
// The audit payload
// ---------------------------------------------------------------------------

t('a coverage score that disagrees with its own unanswered list fails', () => {
  const r = inspectArtifact(doc({ audit: auditBlock({ coverage_score: 0.75 }) }), { checkSeal: false });
  errs(r, 'does not match its own unanswered list');
});

t('a PASS with a false veto fails and names the question number', () => {
  const a = auditBlock();
  a.veto_results.q20_agent_assisted_labeled = false;
  const r = inspectArtifact(doc({ audit: a }), { checkSeal: false });
  const f = r.findings.find((x) => x.rule === 'R-VETO' && x.question === 20);
  assert.ok(f, `expected a Q20 veto finding, got ${JSON.stringify(r.findings.map((x) => x.message))}`);
  assert.match(f.message, /mandatory regardless of coverage/);
});

t('every mandatory question is mapped to its number', () => {
  assert.deepEqual(
    Object.values(VETO_QUESTIONS).map(([n]) => n),
    [9, 10, 13, 19, 20]
  );
});

t('a PASS below the coverage threshold fails and lists the unanswered questions', () => {
  const r = inspectArtifact(
    doc({ audit: auditBlock({ coverage_score: 0.39, unanswered_question_numbers: Array.from({ length: 17 }, (_, i) => i + 1) }) }),
    { checkSeal: false }
  );
  const f = r.findings.find((x) => x.rule === 'R-THRESHOLD');
  assert.ok(f, 'below-threshold PASS should fail');
  assert.ok(f.unanswered.length === 17, 'the unanswered list travels with the failure');
});

t('a REJECT is allowed to fail its vetoes, because that is what REJECT means', () => {
  const a = auditBlock({ verdict: 'REJECT', coverage_score: 0.39, unanswered_question_numbers: Array.from({ length: 17 }, (_, i) => i + 1) });
  a.veto_results.q20_agent_assisted_labeled = false;
  noErrs(inspectArtifact(doc({ audit: a }), { checkSeal: false }));
});

t('a PASS with no backstage row in auditor_evidence fails', () => {
  const r = inspectArtifact(
    doc({ audit: auditBlock({ auditor_evidence: [backstageRow({ source_class: 'frontstage' })] }) }),
    { checkSeal: false }
  );
  errs(r, 'every row is frontstage');
});

t('no audit block is reported and is not a failure', () => {
  // renderBrief is documented to render an unaudited diagnosis as unaudited, and
  // /diagnose renders before the recorder runs. Failing here would break both.
  const r = inspectArtifact(doc(), { checkSeal: false });
  noErrs(r);
  assert.equal(r.audited, false);
  assert.ok(r.findings.some((f) => f.severity === 'info' && /no audit block/.test(f.message)));
});

// ---------------------------------------------------------------------------
// Throwing wrapper
// ---------------------------------------------------------------------------

t('validateArtifact throws ArtifactError with the schema path in the message', () => {
  assert.throws(
    () => validateArtifact(doc({ dated: 'August 2026' }), { artifact: 'x.yaml', checkSeal: false }),
    (e) => {
      assert.ok(e instanceof ArtifactError, `expected ArtifactError, got ${e.constructor.name}`);
      assert.match(e.message, /x\.yaml failed the schema gate/);
      assert.match(e.message, /dated/);
      return true;
    }
  );
});

t('the thrown message carries the filing standard question text', () => {
  const a = auditBlock();
  a.veto_results.q9_link_behind_claim = false;
  try {
    validateArtifact(doc({ audit: a }), { artifact: 'x.yaml', checkSeal: false });
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /filing standard Q9/);
    assert.match(e.message, /link behind the claim/);
  }
});

t('an empty or non-object artifact fails at the root', () => {
  errs(inspectArtifact(null, { checkSeal: false }), 'empty or is not a YAML mapping');
  errs(inspectArtifact('a string', { checkSeal: false }), 'empty or is not a YAML mapping');
});

// ---------------------------------------------------------------------------
// The pre-audit seal
// ---------------------------------------------------------------------------

t('the digest covers the reading, not the bytes', () => {
  // Same lesson as readingDigest in casefile.js, which closed two companies as
  // DEAD over an added comment. Key order must not change the hash.
  const a = doc();
  const b = { verdict: a.verdict, disconfirming: a.disconfirming, evidence: a.evidence, acquittal: a.acquittal, dated: a.dated, role: a.role, company: a.company };
  assert.equal(digestOf(a), digestOf(b));
});

t('the auditor-owned blocks are outside the digest', () => {
  const base = doc();
  assert.equal(digestOf(base), digestOf({ ...base, audit: auditBlock(), strikes: { claims_struck: 3 } }));
  assert.ok(!('audit' in diagnosticianView({ ...base, audit: auditBlock() })));
});

t('changing a claim changes the digest', () => {
  const base = doc();
  const edited = doc({ evidence: [backstageRow({ claim: 'Rewritten.' })] });
  assert.notEqual(digestOf(base), digestOf(edited));
});

t('sealing then appending an audit verifies intact', () => {
  const p = writeArtifact(doc());
  seal(p);
  const d = yaml.load(fs.readFileSync(p, 'utf8'));
  d.audit = auditBlock();
  d.strikes = { claims_tested: 4, claims_struck: 1, struck: [] };
  fs.writeFileSync(p, yaml.dump(d));
  const v = verify(p);
  assert.equal(v.state, 'intact');
  assert.equal(v.ok, true);
});

t('an auditor that edits the diagnosis is caught', () => {
  // The failure this whole mechanism exists for. The auditor appends its blocks
  // and also quietly rewrites an evidence row.
  const p = writeArtifact(doc());
  seal(p);
  const d = yaml.load(fs.readFileSync(p, 'utf8'));
  d.audit = auditBlock();
  d.evidence[0].claim = 'Quietly rewritten by the auditor.';
  fs.writeFileSync(p, yaml.dump(d));
  const v = verify(p);
  assert.equal(v.state, 'modified');
  assert.equal(v.ok, false);
  assert.match(v.message, /changed after it was sealed/);
});

t('a modified artifact is an error in the gate, not a warning', () => {
  const p = writeArtifact(doc());
  seal(p);
  const d = yaml.load(fs.readFileSync(p, 'utf8'));
  d.audit = auditBlock();
  d.verdict = 'SHIP';
  fs.writeFileSync(p, yaml.dump(d));
  errs(inspectArtifact(yaml.load(fs.readFileSync(p, 'utf8')), { artifact: p }), 'changed after it was sealed');
});

t('an unsealed artifact warns and still passes', () => {
  // Every artifact written before the seal existed is in this state. Refusing
  // them would take the whole record offline to enforce a rule that did not
  // exist when they were written.
  const p = writeArtifact(doc({ audit: auditBlock() }));
  const r = inspectArtifact(yaml.load(fs.readFileSync(p, 'utf8')), { artifact: p });
  noErrs(r);
  assert.ok(r.findings.some((f) => f.severity === 'warning' && /no seal/.test(f.message)));
  assert.equal(r.seal.state, 'unsealed');
});

t('a self-reported digest that disagrees with the seal fails', () => {
  // The auditor writes audit.diagnostician_digest by copying the sidecar. One it
  // made up instead proves nothing, and saying so is the point of the field.
  const p = writeArtifact(doc());
  seal(p);
  const d = yaml.load(fs.readFileSync(p, 'utf8'));
  d.audit = auditBlock({ diagnostician_digest: 'f'.repeat(64) });
  fs.writeFileSync(p, yaml.dump(d));
  const v = verify(p);
  assert.equal(v.state, 'digest_mismatch');
  assert.equal(v.ok, false);
});

t('a correctly copied digest verifies intact', () => {
  const p = writeArtifact(doc());
  const s = seal(p);
  const d = yaml.load(fs.readFileSync(p, 'utf8'));
  d.audit = auditBlock({ diagnostician_digest: s.digest });
  fs.writeFileSync(p, yaml.dump(d));
  assert.equal(verify(p).state, 'intact');
});

t('sealing refuses an artifact that already carries an audit block', () => {
  // Sealing after the audit would certify whatever the audit wrote, which is the
  // one thing the seal must never do.
  const p = writeArtifact(doc({ audit: auditBlock() }));
  assert.throws(() => seal(p), /already carries an audit block/);
});

t('re-sealing a changed artifact requires force and records what it replaced', () => {
  const p = writeArtifact(doc());
  const first = seal(p);
  fs.writeFileSync(p, yaml.dump(doc({ verdict: 'SHIP' })));
  assert.throws(() => seal(p), /already seals a different version/);

  const forced = seal(p, { force: true });
  assert.notEqual(forced.digest, first.digest);
  const sidecar = JSON.parse(fs.readFileSync(sealPathFor(p), 'utf8'));
  assert.equal(sidecar.replaced_digest, first.digest, 'a forced re-seal must leave the override on the record');
});

t('re-sealing an unchanged artifact is a no-op', () => {
  const p = writeArtifact(doc());
  const first = seal(p);
  const again = seal(p);
  assert.equal(again.unchanged, true);
  assert.equal(again.digest, first.digest);
});

for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passing`);
