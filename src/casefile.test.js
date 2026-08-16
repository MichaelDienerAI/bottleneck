// The case file is the system's memory across weeks, and until this suite existed
// it was the one module with logic and no tests. It is also the module whose
// failures are silent: a wrong status does not throw, it just quietly closes a
// company, or quietly re-opens one that should have stayed shut, and the cost
// lands on the drum weeks later where nobody connects it back.
//
// Every test writes to a temp directory. Nothing here touches data/cases, reaches
// the network, or runs a model.

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  create,
  effectiveVerdict,
  evidenceKeys,
  load,
  park,
  recordFromDiagnosis,
  recordVisit,
  save,
  shouldSkip,
  slugify,
  summary,
  visitFromDiagnosis,
} from './casefile.js';

const REPO = path.resolve(import.meta.dirname, '..');
const roots = [];

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

// A throwaway repo root. Only the two directories the module touches exist.
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottleneck-case-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data/diagnoses'), { recursive: true });
  return root;
}

// A minimal audited diagnosis. The recorder reads exactly these fields, so the
// fixture carries them and nothing else — a fixture that mirrors a whole real
// file hides which field the code actually depends on.
const diagnosis = (over = {}) => ({
  company: 'Testco',
  role: 'Senior Evaluation Engineer',
  archetype: 'conversational_ai',
  dated: '2026-08-15',
  acquittal: 'EVIDENCE_SUFFICIENT',
  constraint_hypothesis: { weakest_link: 'Testco produces no more X than its slowest Y allows.' },
  evidence: [
    { claim: 'a', inspectable_at: 'https://example.com/issues/1', source_class: 'backstage', strength: 5 },
    { claim: 'b', inspectable_at: 'https://example.com/releases', source_class: 'backstage', strength: 4 },
  ],
  disconfirming: { query_issued: 'did a sandbox exist', result: 'nothing', survived: true },
  proof_match: { asset: 'persona_io', tier: 'sovereign', acts_on_constraint: false },
  decision_maker: { name: '', title: 'Head of Eval', source: 'https://example.com/team' },
  verdict: 'PARK',
  reason: 'no proof acts on the named part',
  audit: {
    dated: '2026-08-15',
    coverage_score: 0.61,
    verdict: 'PASS',
    auditor_evidence: [
      { claim: 'c', inspectable_at: 'https://example.com/status/history', source_class: 'backstage', strength: 5 },
    ],
    gaps: ['attacked row 2, it held'],
  },
  strikes: {
    claims_tested: 9,
    claims_struck: 1,
    struck: [{ claim: 'Evidence row 1: overstated the count', reason: 'fails prove the claim', rewrite: 'narrower' }],
  },
  ...over,
});

const writeDiagnosis = (root, doc, name = 'testco-senior-evaluation-engineer.yaml') => {
  // Hand-rolled rather than js-yaml dumped, so the fixture on disk is the shape
  // the recorder parses and the test does not depend on a serializer round trip.
  const file = path.join(root, 'data/diagnoses', name);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2)); // JSON is valid YAML
  return file;
};

// ---------------------------------------------------------------------------
// Round trip and the basic lifecycle
// ---------------------------------------------------------------------------

t('slugify makes a filename out of a company name', () => {
  assert.equal(slugify('Gray Swan AI'), 'gray-swan-ai');
  assert.equal(slugify('Character.AI'), 'character-ai');
});

t('create, save and load round-trip', () => {
  const root = makeRoot();
  assert.equal(load('Testco', root), null, 'a company with no file must read as null, not throw');
  save(create('Testco', 'conversational_ai'), root);
  const back = load('Testco', root);
  assert.equal(back.company, 'Testco');
  assert.equal(back.status, 'NEW');
  assert.deepEqual(back.visits, []);
});

t('recordVisit appends and sets status', () => {
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact_digest: 'd1' }, root);
  const back = load('Testco', root);
  assert.equal(back.visits.length, 1);
  assert.equal(back.status, 'PARKED');
  assert.ok(back.visits[0].date, 'a visit with no date cannot be ordered later');
});

t('a REJECT verdict kills the hypothesis for good', () => {
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'REJECT', hypothesis: 'the wrong one', evidence_keys: ['a'], artifact_digest: 'd1' }, root);
  const back = load('Testco', root);
  assert.deepEqual(back.dead_hypotheses, ['the wrong one']);
  assert.equal(back.status, 'REJECTED');
  // REJECTED does not close the company. A dead hypothesis is not a dead company.
  assert.equal(shouldSkip('Testco', '2026-08-15', root).skip, false);
});

t('an audit REJECT kills no hypothesis and closes nothing', () => {
  // Gray Swan: diagnosis SHIP, audit REJECT at coverage 0.46. The artifact failed
  // on coverage, which says nothing about whether the hypothesis was right, so
  // filing it as dead would bar a question the auditor never ruled on.
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(
    f,
    { verdict: 'AUDIT_REJECT', hypothesis: 'still open', evidence_keys: ['a'], artifact_digest: 'd1' },
    root
  );
  const back = load('Testco', root);
  assert.deepEqual(back.dead_hypotheses, []);
  assert.equal(back.status, 'AUDIT_REJECT');
  assert.equal(shouldSkip('Testco', '2026-08-15', root).skip, false, 'the slot returns to the pool, so the row stays workable');
});

t('park sets a cooling date and a written trigger', () => {
  const root = makeRoot();
  const f = save(create('Testco', 'conversational_ai'), root);
  park(f, 30, 'reopen if they post on the voice runtime', root);
  const back = load('Testco', root);
  assert.equal(back.status, 'PARKED');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(back.revisit_after));
  assert.ok(back.revisit_after > new Date().toISOString().slice(0, 10));
  assert.equal(back.revisit_trigger, 'reopen if they post on the voice runtime');
});

// ---------------------------------------------------------------------------
// shouldSkip — the gate the scan actually calls
// ---------------------------------------------------------------------------

t('dates are stamped on the local clock, not UTC', () => {
  // src/ledger.js formats its week boundary locally for this reason and says so
  // at length. This module used toISOString, so in any zone behind UTC every
  // date stamped after about 5pm Phoenix time landed on tomorrow: a visit done
  // on the 15th filed as the 16th, and every cooling window ran a day late.
  //
  // TZ cannot be changed inside a running process — Date caches the zone at
  // startup — so this runs in a child, at an hour that straddles the boundary.
  const src = JSON.stringify(path.join(REPO, 'src/casefile.js'));
  for (const tz of ['UTC', 'America/Phoenix', 'America/New_York', 'Asia/Tokyo']) {
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${src});
         const f = m.create('Testco', 'x');
         console.log(JSON.stringify(f.first_seen));`,
      ],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' }
    );
    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    assert.equal(JSON.parse(out), expected, `${tz} stamped a date the local calendar does not agree with`);
  }
});

t('a cooling window lands the right number of local days out', () => {
  const root = makeRoot();
  const f = save(create('Testco', 'x'), root);
  park(f, 30, 'a trigger', root);
  const d = new Date();
  d.setDate(d.getDate() + 30);
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(load('Testco', root).revisit_after, expected);
});

t('shouldSkip passes an unknown company through', () => {
  const root = makeRoot();
  assert.deepEqual(shouldSkip('Nobody', '2026-08-15', root), { skip: false });
});

t('shouldSkip closes DEAD and SHIPPED and nothing else', () => {
  const root = makeRoot();
  for (const [status, expected] of [
    ['DEAD', true],
    ['SHIPPED', true],
    ['CLEARED', false],
    ['PARKED', false],
    ['REJECTED', false],
    ['AUDIT_REJECT', false],
    ['NEW', false],
  ]) {
    const f = create(`Co${status}`, 'conversational_ai');
    f.status = status;
    save(f, root);
    assert.equal(
      shouldSkip(`Co${status}`, '2026-08-15', root).skip,
      expected,
      `status ${status} should ${expected ? '' : 'not '}skip`
    );
  }
});

t('shouldSkip honours the cooling date and reopens after it', () => {
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  f.revisit_after = '2026-09-15';
  f.revisit_trigger = 'a role on the voice runtime';
  save(f, root);
  const before = shouldSkip('Testco', '2026-08-15', root);
  assert.equal(before.skip, true);
  assert.ok(before.reason.includes('2026-09-15'), 'the reason must name the date');
  assert.ok(before.reason.includes('voice runtime'), 'the reason must carry the trigger');
  assert.equal(shouldSkip('Testco', '2026-09-16', root).skip, false, 'the cooling window has to end');
});

t('shouldSkip hands the priors forward', () => {
  // The whole point of the module: the next visit does not re-argue a settled
  // question or repeat a search the last visit already ran.
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(
    f,
    { verdict: 'REJECT', hypothesis: 'dead one', queries: ['q1'], evidence_keys: ['a'], artifact_digest: 'd1' },
    root
  );
  const { priors } = shouldSkip('Testco', '2026-08-15', root);
  assert.deepEqual(priors.dead_hypotheses, ['dead one']);
  assert.deepEqual(priors.queries_run, ['q1']);
});

// ---------------------------------------------------------------------------
// Sequential visits and no-progress detection
// ---------------------------------------------------------------------------

t('two visits with no new evidence close the company', () => {
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a', 'b'], artifact_digest: 'd1' }, root);
  assert.equal(load('Testco', root).status, 'PARKED', 'one visit is not two');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a', 'b'], artifact_digest: 'd2' }, root);
  const back = load('Testco', root);
  assert.equal(back.status, 'DEAD');
  assert.ok(back.revisit_trigger.includes('public change'));
  assert.equal(shouldSkip('Testco', '2026-08-15', root).skip, true);
});

t('a second visit carrying one new key keeps the company open', () => {
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a', 'b'], artifact_digest: 'd1' }, root);
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['b', 'c'], artifact_digest: 'd2' }, root);
  assert.equal(load('Testco', root).status, 'PARKED');
});

t('re-recording the same artifact does not manufacture a second visit', () => {
  // Without the digest upsert this is the worst defect in the module: /diagnose
  // and /ship both record, the second call files the identical evidence keys as
  // a fresh visit, no-progress fires, and the company closes as DEAD on one
  // reading counted twice.
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact: 'x.yaml', artifact_digest: 'same' }, root);
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact: 'x.yaml', artifact_digest: 'same' }, root);
  const back = load('Testco', root);
  assert.equal(back.visits.length, 1);
  assert.equal(back.status, 'PARKED', 'an idempotent re-record must not close the company');
});

t('accumulated lists never carry duplicates', () => {
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  const visit = (digest) => ({
    verdict: 'REJECT',
    hypothesis: 'same one',
    queries: ['q1'],
    struck_claims: ['claim A'],
    evidence_keys: ['a'],
    artifact_digest: digest,
  });
  recordVisit(f, visit('d1'), root);
  recordVisit(f, visit('d2'), root);
  const back = load('Testco', root);
  assert.deepEqual(back.dead_hypotheses, ['same one']);
  assert.deepEqual(back.queries_run, ['q1']);
  assert.deepEqual(back.struck_claims, ['claim A']);
});

t('a found decision-maker is never overwritten by an empty one', () => {
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(
    f,
    { verdict: 'PARK', evidence_keys: ['a'], artifact_digest: 'd1', decision_maker: { name: 'A. Human', title: 'Head of Eval' } },
    root
  );
  recordVisit(
    f,
    { verdict: 'PARK', evidence_keys: ['b'], artifact_digest: 'd2', decision_maker: { name: '', title: 'Head of Eval' } },
    root
  );
  assert.equal(load('Testco', root).decision_maker.name, 'A. Human');
});

// ---------------------------------------------------------------------------
// Deriving the visit from an audited diagnosis
// ---------------------------------------------------------------------------

t('evidence keys come from both the diagnosis and the auditor, normalized', () => {
  const keys = evidenceKeys({
    evidence: [{ inspectable_at: 'https://Example.com/A/' }, { inspectable_at: 'https://example.com/a' }],
    audit: { auditor_evidence: [{ inspectable_at: 'https://example.com/history' }] },
  });
  assert.deepEqual(keys, ['https://example.com/a', 'https://example.com/history']);
});

t('an audit REJECT outranks the diagnosis verdict', () => {
  assert.equal(effectiveVerdict({ verdict: 'SHIP', audit: { verdict: 'REJECT' } }), 'AUDIT_REJECT');
  assert.equal(effectiveVerdict({ verdict: 'PARK', audit: { verdict: 'REJECT' } }), 'AUDIT_REJECT');
});

t('SHIP is CLEARED at diagnosis and SHIP only at ship', () => {
  const doc = { verdict: 'SHIP', audit: { verdict: 'PASS' } };
  assert.equal(effectiveVerdict(doc, 'diagnose'), 'CLEARED');
  assert.equal(effectiveVerdict(doc, 'ship'), 'SHIP');
});

t('visitFromDiagnosis lifts every field the auditor read', () => {
  const v = visitFromDiagnosis(diagnosis(), { artifact: 'data/diagnoses/x.yaml', digest: 'abc', stage: 'diagnose' });
  assert.equal(v.verdict, 'PARK');
  assert.equal(v.audit_verdict, 'PASS');
  assert.equal(v.coverage_score, 0.61);
  assert.equal(v.acquittal, 'EVIDENCE_SUFFICIENT');
  assert.equal(v.evidence_keys.length, 3, 'two diagnosis rows plus the auditor isolation row');
  assert.deepEqual(v.queries, ['did a sandbox exist']);
  assert.deepEqual(v.struck_claims, ['Evidence row 1: overstated the count']);
  assert.deepEqual(v.audit_gaps, ['attacked row 2, it held']);
  assert.equal(v.decision_maker.title, 'Head of Eval');
});

// ---------------------------------------------------------------------------
// recordFromDiagnosis — the write path the pipeline actually calls
// ---------------------------------------------------------------------------

t('recording an audited diagnosis creates the case file', () => {
  const root = makeRoot();
  writeDiagnosis(root, diagnosis());
  const r = recordFromDiagnosis('Testco', { root });

  assert.equal(r.created, true);
  assert.equal(r.company, 'Testco');
  assert.equal(r.verdict, 'PARK');
  assert.equal(r.visits, 1);

  const back = load('Testco', root);
  assert.equal(back.archetype, 'conversational_ai');
  assert.equal(back.status, 'PARKED');
  assert.equal(back.visits[0].artifact, 'data/diagnoses/testco-senior-evaluation-engineer.yaml');
  assert.equal(back.visits[0].role, 'Senior Evaluation Engineer');
  assert.deepEqual(back.struck_claims, ['Evidence row 1: overstated the count']);
  assert.deepEqual(back.queries_run, ['did a sandbox exist']);
  assert.equal(back.decision_maker.title, 'Head of Eval');
});

t('a PARK gets a cooling date, and no trigger is invented', () => {
  const root = makeRoot();
  writeDiagnosis(root, diagnosis());
  const r = recordFromDiagnosis('Testco', { root, parkDays: 30 });
  assert.equal(r.parked, true);
  assert.ok(r.revisit_after > new Date().toISOString().slice(0, 10));
  assert.equal(r.revisit_trigger, null, 'the diagnosis wrote no trigger, so the recorder must not supply one');

  const root2 = makeRoot();
  writeDiagnosis(root2, diagnosis({ revisit_trigger: 'a role on the voice runtime' }));
  assert.equal(recordFromDiagnosis('Testco', { root: root2 }).revisit_trigger, 'a role on the voice runtime');
});

t('recording refuses an artifact the auditor has not ruled on', () => {
  // The structural bound. The unattended gatherer never produces an audit block,
  // so this is what keeps a 7am run out of the system's memory.
  const root = makeRoot();
  const doc = diagnosis();
  delete doc.audit;
  writeDiagnosis(root, doc);
  assert.throws(() => recordFromDiagnosis('Testco', { root }), /no audit block/);
  assert.equal(load('Testco', root), null, 'a refused record must leave no file behind');
});

t('recording is idempotent across /diagnose and /ship', () => {
  const root = makeRoot();
  writeDiagnosis(root, diagnosis({ verdict: 'SHIP', proof_match: { tier: 'sovereign', acts_on_constraint: true } }));

  const first = recordFromDiagnosis('Testco', { root, stage: 'diagnose' });
  assert.equal(first.verdict, 'CLEARED');
  assert.equal(load('Testco', root).status, 'CLEARED');
  assert.equal(shouldSkip('Testco', '2026-08-15', root).skip, false, 'a cleared row must stay workable until the packet exists');

  const second = recordFromDiagnosis('Testco', { root, stage: 'ship' });
  assert.equal(second.visits, 1, 'the same artifact must not file a second visit');
  assert.equal(second.verdict, 'SHIP');
  assert.equal(load('Testco', root).status, 'SHIPPED');
  assert.equal(shouldSkip('Testco', '2026-08-15', root).skip, true, 'a shipped company is closed to the scan');
});

t('a materially rewritten diagnosis is a real second visit', () => {
  // The Deepgram case: a committed SHIP file re-diagnosed onto a corrected
  // predicate. Different content, so it appends rather than replacing.
  const root = makeRoot();
  writeDiagnosis(root, diagnosis());
  recordFromDiagnosis('Testco', { root });
  writeDiagnosis(
    root,
    diagnosis({
      evidence: [{ claim: 'new', inspectable_at: 'https://example.com/prs?sort=created-asc' }],
      verdict: 'REJECT',
    })
  );
  const second = recordFromDiagnosis('Testco', { root });
  assert.equal(second.visits, 2);
  assert.deepEqual(load('Testco', root).dead_hypotheses, ['Testco produces no more X than its slowest Y allows.']);
});

t('an ambiguous company name is an error, never a guess', () => {
  // A company can hold two queue rows. Recording one role's visit against the
  // other role's reading is exactly the quiet mis-file this module exists to stop.
  const root = makeRoot();
  writeDiagnosis(root, diagnosis(), 'testco-senior-evaluation-engineer.yaml');
  writeDiagnosis(root, diagnosis({ role: 'PMM' }), 'testco-pmm-voice.yaml');
  assert.throws(() => recordFromDiagnosis('Testco', { root }), /matches 2 diagnoses/);

  // The path form resolves it.
  const r = recordFromDiagnosis('data/diagnoses/testco-pmm-voice.yaml', { root });
  assert.equal(r.visits, 1);
});

t('an unknown company names what is actually on disk', () => {
  const root = makeRoot();
  writeDiagnosis(root, diagnosis());
  assert.throws(() => recordFromDiagnosis('Nobody', { root }), /testco-senior-evaluation-engineer\.yaml/);
});

t('summary reports each file once', () => {
  const root = makeRoot();
  assert.deepEqual(summary(root), [], 'no directory is not an error');
  writeDiagnosis(root, diagnosis());
  recordFromDiagnosis('Testco', { root });
  const rows = summary(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'PARKED');
  assert.equal(rows[0].visits, 1);
});

// ---------------------------------------------------------------------------
// The CLI, which is what the slash commands and the server actually invoke
// ---------------------------------------------------------------------------

t('the CLI records, reports the verdict chain, and exits 0', () => {
  const root = makeRoot();
  writeDiagnosis(root, diagnosis());
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'src/casefile.js'), path.join(root, 'src/casefile.js'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));

  const out = execFileSync(process.execPath, ['src/casefile.js', '--record', 'Testco'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ok(out.includes('Created data/cases/testco.json'), out);
  assert.ok(/diagnosis PARK \/ audit PASS -> PARK/.test(out), out);
  assert.ok(out.includes('decision-maker still unnamed'), 'the missing human is the packet blocker and must be said');
  assert.ok(fs.existsSync(path.join(root, 'data/cases/testco.json')));
});

t('the CLI refuses an unaudited artifact and exits non-zero', () => {
  const root = makeRoot();
  const doc = diagnosis();
  delete doc.audit;
  writeDiagnosis(root, doc);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'src/casefile.js'), path.join(root, 'src/casefile.js'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));

  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, ['src/casefile.js', '--record', 'Testco'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    code = e.status;
    stderr = e.stderr;
  }
  assert.equal(code, 1);
  assert.ok(/no audit block/.test(stderr), stderr);
  assert.ok(!fs.existsSync(path.join(root, 'data/cases')), 'a refusal must leave no directory behind');
});

t('importing the module does not fire the CLI', () => {
  // The CLI block is guarded on argv[1]. Without the guard, this suite's own
  // import would run it, and every test file that touches casefile.js would
  // acquire a side effect nobody asked for.
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(path.join(REPO, 'src/casefile.js'))}); console.log('clean');`],
    { encoding: 'utf8' }
  );
  assert.equal(out.trim(), 'clean');
});

for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passing`);
