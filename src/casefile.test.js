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
  closeDead,
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

// A minimal audited diagnosis, where minimal now means "the smallest artifact
// that is actually valid."
//
// This fixture used to carry only the fields the recorder reads, on the
// reasoning that a fuller one hides which field the code depends on. That stopped
// being true when the recorder started calling src/validateArtifact.js: it now
// depends on the artifact passing evidence.json and audit.json, so a fixture
// missing verify_seconds or unanswered_question_numbers is not a lean fixture,
// it is an artifact the production path would refuse. It was refused, by this
// suite, the first time the gate was wired in.
//
// coverage_score and unanswered_question_numbers have to agree: R-COVERAGE-CONSISTENT
// recomputes (28 - unanswered.length) / 28, so 11 unanswered is 17/28 = 0.61.
const diagnosis = (over = {}) => ({
  company: 'Testco',
  role: 'Senior Evaluation Engineer',
  archetype: 'conversational_ai',
  dated: '2026-08-15',
  acquittal: 'EVIDENCE_SUFFICIENT',
  constraint_hypothesis: { weakest_link: 'Testco produces no more X than its slowest Y allows.' },
  // Claims carry real shape rather than the placeholders 'a' and 'b' they used
  // to. src/utils/likelihoodRatio.js bars a SHIP whose evidence is as consistent
  // with ordinary growth as with a bottleneck, and a one-letter claim
  // discriminates nothing — correctly. One of these rows names a duration, which
  // is what makes it evidence of a limit rather than of activity.
  evidence: [
    {
      claim: 'The oldest open issue on the eval repo has been unresolved 240 days while its reaction count grew to 31.',
      inspectable_at: 'https://example.com/issues/1',
      verify_seconds: 8,
      source_class: 'backstage',
      strength: 5,
    },
    {
      claim: 'No releases in 94 days on a repo whose prior cadence was every 14 days.',
      inspectable_at: 'https://example.com/releases',
      verify_seconds: 6,
      source_class: 'backstage',
      strength: 4,
    },
  ],
  disconfirming: { query_issued: 'did a sandbox exist', result: 'nothing', survived: true },
  proof_match: { asset: 'persona_io', tier: 'sovereign', acts_on_constraint: false },
  decision_maker: { name: '', title: 'Head of Eval', source: 'https://example.com/team' },
  verdict: 'PARK',
  reason: 'no proof acts on the named part',
  audit: {
    dated: '2026-08-15',
    coverage_score: 0.61,
    unanswered_question_numbers: [4, 11, 12, 16, 17, 18, 23, 24, 25, 27, 28],
    veto_results: {
      q9_link_behind_claim: true,
      q10_verify_under_60s: true,
      q13_source_beyond_posting: true,
      q19_staged_labeled: true,
      q20_agent_assisted_labeled: true,
    },
    verdict: 'PASS',
    auditor_evidence: [
      { claim: 'c', inspectable_at: 'https://example.com/status/history', verify_seconds: 4, source_class: 'backstage', strength: 5 },
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

t('two visits with no new evidence flag the company and do not close it', () => {
  // This used to set DEAD, and DEAD is read by shouldSkip as closed forever. An
  // irreversible decision taken by a calculation on circumstantial evidence: the
  // same keys twice can mean the record is exhausted, or that the artifact got
  // filed twice, or that the second look was cut short. It fired wrongly twice in
  // this repository. The calculation now reports; a person decides.
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a', 'b'], artifact_digest: 'd1' }, root);
  assert.equal(load('Testco', root).status, 'PARKED', 'one visit is not two');

  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a', 'b'], artifact_digest: 'd2' }, root);
  const back = load('Testco', root);
  assert.equal(back.status, 'PARKED', 'the verdict-derived status must survive a bookkeeping observation');
  assert.equal(back.no_progress_warning, true);
  assert.ok(back.no_progress_since, 'the flag carries the date it was raised');

  const skip = shouldSkip('Testco', '2026-08-15', root);
  assert.equal(skip.skip, false, 'a flagged company is still workable');
  assert.match(skip.warning, /no new evidence/);
});

t('the no-progress flag clears when a later visit surfaces something new', () => {
  // Otherwise the flag is a permanent mark that outlives the condition, and the
  // close prompt keeps firing on a company that started producing again.
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact_digest: 'd1' }, root);
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact_digest: 'd2' }, root);
  assert.equal(load('Testco', root).no_progress_warning, true);

  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a', 'new'], artifact_digest: 'd3' }, root);
  const back = load('Testco', root);
  assert.equal(back.no_progress_warning, false);
  assert.equal(back.no_progress_since, null);
});

t('closeDead is the only path to DEAD, and it records who and when', () => {
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact_digest: 'd1' }, root);
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact_digest: 'd2' }, root);
  assert.notEqual(load('Testco', root).status, 'DEAD', 'nothing automatic may reach DEAD');

  closeDead(load('Testco', root), { at: '2026-08-17', reason: 'record exhausted', by: 'cli' }, root);
  const back = load('Testco', root);
  assert.equal(back.status, 'DEAD');
  assert.equal(back.closed_at, '2026-08-17');
  assert.equal(back.closed_by, 'cli');
  assert.equal(back.revisit_trigger, 'record exhausted');
  assert.equal(shouldSkip('Testco', '2026-08-18', root).skip, true, 'a closed company is closed');
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
  // and /ship both record, and the second call files the identical evidence keys
  // as a fresh visit.
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact: 'x.yaml', artifact_digest: 'same' }, root);
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact: 'x.yaml', artifact_digest: 'same' }, root);
  const back = load('Testco', root);
  assert.equal(back.visits.length, 1);
  assert.equal(back.status, 'PARKED', 'an idempotent re-record must not close the company');
  assert.equal(back.no_progress_warning, false, 'one visit recorded twice is not two visits');
});

t('an identical re-record reports itself as a duplicate', () => {
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  const v = { verdict: 'PARK', evidence_keys: ['a'], artifact: 'x.yaml', artifact_digest: 'same' };
  assert.equal(recordVisit(f, v, root).duplicate, false, 'the first filing is not a duplicate');
  const second = recordVisit(f, v, root);
  assert.equal(second.duplicate, true);
  assert.equal(second.visits, 1);
});

t('ten identical re-records leave one visit', () => {
  // Strict idempotence, not "usually idempotent". The server records on every run
  // and the slash commands record again, so this path runs more often than any
  // other in the module.
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  for (let i = 0; i < 10; i++) {
    recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact: 'x.yaml', artifact_digest: 'same' }, root);
  }
  assert.equal(load('Testco', root).visits.length, 1);
});

t('the same artifact re-recorded on the same day is one visit, even after an edit', () => {
  // The Synthesia case, 2026-08-17. An artifact filed once, re-audited, and
  // re-recorded the same day appended a second visit with the identical six
  // evidence keys — and the old no-progress rule closed the company on it.
  // Refining an artifact and re-filing it is not a second look at the company.
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact: 'x.yaml', artifact_digest: 'first' }, root);
  recordVisit(f, { verdict: 'REJECT', evidence_keys: ['a'], artifact: 'x.yaml', artifact_digest: 'second' }, root);
  const back = load('Testco', root);
  assert.equal(back.visits.length, 1, 'same artifact, same day, one visit');
  assert.equal(back.visits[0].artifact_digest, 'second', 'the later reading replaces the earlier one');
  assert.equal(back.status, 'REJECTED', 'the replacement still drives the status');
  assert.equal(back.no_progress_warning, false);
});

t('the same artifact re-recorded on a later day is a real second visit', () => {
  // The other side of the rule. A genuine second look, days apart, must still be
  // countable — otherwise the no-progress signal can never fire at all.
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact: 'x.yaml', artifact_digest: 'first', date: '2026-08-10' }, root);
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact: 'x.yaml', artifact_digest: 'second', date: '2026-08-17' }, root);
  const back = load('Testco', root);
  assert.equal(back.visits.length, 2);
  assert.equal(back.no_progress_warning, true, 'two real looks with no new keys is what the flag is for');
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

t('an edit that does not change the reading is not a second visit', () => {
  // This one is a regression. The digest hashed the raw file text, so adding a
  // revisit_trigger field to two parked diagnoses read as a second visit to each
  // company. The evidence keys were unchanged, noProgress fired, and both closed
  // as DEAD on an edit that surfaced no evidence and made no claim. A comment or
  // a typo fix would have done the same.
  const root = makeRoot();
  writeDiagnosis(root, diagnosis());
  recordFromDiagnosis('Testco', { root });

  writeDiagnosis(root, diagnosis({ revisit_trigger: 'a role on the voice runtime', reason: 'reworded entirely' }));
  const second = recordFromDiagnosis('Testco', { root });

  assert.equal(second.visits, 1, 'a trigger and a reworded reason are not a second look at the company');
  assert.equal(second.status, 'PARKED');
  assert.equal(second.revisit_trigger, 'a role on the voice runtime', 'the trigger still has to land');
});

t('finding the decision-maker updates the file without filing a visit', () => {
  // Same principle. Naming the human is a fact added to the file, not a second
  // reading of the constraint.
  const root = makeRoot();
  writeDiagnosis(root, diagnosis());
  recordFromDiagnosis('Testco', { root });
  writeDiagnosis(root, diagnosis({ decision_maker: { name: 'A. Human', title: 'Head of Eval', source: 'https://example.com/team' } }));
  const second = recordFromDiagnosis('Testco', { root });

  assert.equal(second.visits, 1);
  assert.equal(second.decision_maker.name, 'A. Human');
});

t('a same-day rewrite supersedes the visit rather than appending one', () => {
  // The Deepgram case: a committed SHIP file re-diagnosed onto a corrected
  // predicate. This used to append, on the reasoning that different content is a
  // different reading. It is — but a reading is not a visit, and counting it as
  // one is what let a same-day re-record close Synthesia on 2026-08-17.
  //
  // The rewrite still replaces the row and still drives the status and the dead
  // hypothesis, which is the substantive half of this test. Only the count
  // changed. A rewrite recorded on a later day still appends; that is the test
  // above.
  const root = makeRoot();
  writeDiagnosis(root, diagnosis());
  recordFromDiagnosis('Testco', { root });
  writeDiagnosis(
    root,
    diagnosis({
      evidence: [
        {
          claim: 'new',
          inspectable_at: 'https://example.com/prs?sort=created-asc',
          verify_seconds: 9,
          source_class: 'backstage',
          strength: 4,
        },
      ],
      verdict: 'REJECT',
    })
  );
  const second = recordFromDiagnosis('Testco', { root });
  assert.equal(second.visits, 1, 'same artifact, same day, one visit');
  assert.equal(second.duplicate, false, 'the content changed, so it is not an idempotent no-op');
  const back = load('Testco', root);
  assert.equal(back.status, 'REJECTED', 'the rewrite still drives the status');
  assert.deepEqual(back.dead_hypotheses, ['Testco produces no more X than its slowest Y allows.']);
  assert.equal(back.visits[0].verdict, 'REJECT', 'the row carries the later reading');
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

// casefile.js is copied into the fixture rather than imported, so the CLI under
// test is the one that ships. It now imports the artifact gate, which imports the
// integrity check and the schema validator, and the validator resolves its schema
// directory relative to its own location — so the fixture needs the module graph
// and .claude/schemas beside it. Copying casefile.js alone left the child dying on
// ERR_MODULE_NOT_FOUND, which would have read as a CLI failure rather than a
// missing fixture.
function installCli(root) {
  fs.mkdirSync(path.join(root, 'src/utils'), { recursive: true });
  // The gate's whole import graph. It has grown three times now — the seal, the
  // likelihood ratio, the countercurrent check — and each time the fixture died
  // on ERR_MODULE_NOT_FOUND, which reads as a CLI failure rather than a missing
  // dependency. Anything validateArtifact.js imports belongs on this list.
  for (const f of [
    'casefile.js',
    'validateArtifact.js',
    'integrity.js',
    'blind.js',
    'utils/schemaValidator.js',
    'utils/likelihoodRatio.js',
    'assessor.js',
    'utils/promptAlgebra.js',
  ]) {
    fs.copyFileSync(path.join(REPO, 'src', f), path.join(root, 'src', f));
  }
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.symlinkSync(path.join(REPO, '.claude/schemas'), path.join(root, '.claude/schemas'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
}

t('the CLI records, reports the verdict chain, and exits 0', () => {
  const root = makeRoot();
  writeDiagnosis(root, diagnosis());
  installCli(root);

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
  installCli(root);

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

t('--close-dead refuses a company that never stalled', () => {
  // Closing costs every future scan that would have surfaced the company, and
  // nothing in the record says this one is exhausted.
  const root = makeRoot();
  save(Object.assign(create('Testco', 'conversational_ai'), { status: 'PARKED' }), root);
  installCli(root);

  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, ['src/casefile.js', '--close-dead', 'Testco'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    code = e.status;
    stderr = e.stderr;
  }
  assert.equal(code, 1);
  assert.match(stderr, /no no-progress warning/);
  assert.equal(load('Testco', root).status, 'PARKED', 'a refusal must change nothing');
});

t('--close-dead closes a flagged company and records the act', () => {
  const root = makeRoot();
  const f = create('Testco', 'conversational_ai');
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact_digest: 'd1' }, root);
  recordVisit(f, { verdict: 'PARK', evidence_keys: ['a'], artifact_digest: 'd2' }, root);
  assert.equal(load('Testco', root).no_progress_warning, true, 'precondition: the flag is up');
  installCli(root);

  const out = execFileSync(
    process.execPath,
    ['src/casefile.js', '--close-dead', 'Testco', '--reason', 'the public record is exhausted'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.match(out, /Closed Testco as DEAD/);
  const back = load('Testco', root);
  assert.equal(back.status, 'DEAD');
  assert.equal(back.closed_by, 'cli');
  assert.equal(back.revisit_trigger, 'the public record is exhausted');
});

t('--close-dead --force closes an unflagged company', () => {
  const root = makeRoot();
  save(Object.assign(create('Testco', 'conversational_ai'), { status: 'PARKED' }), root);
  installCli(root);

  execFileSync(process.execPath, ['src/casefile.js', '--close-dead', 'Testco', '--force', '--reason', 'wrong archetype'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(load('Testco', root).status, 'DEAD');
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
