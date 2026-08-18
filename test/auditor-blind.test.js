// The countercurrent audit.
//
// The auditor and the diagnostician are the same model family reading the same
// artifact in the same direction. Adversarial role does not produce adversarial
// priors, so their agreement is the same measurement taken twice. Phase 1 runs
// the auditor backward — raw observables to a constraint of its own, diagnosis
// unread — and only then does phase 2 open the artifact.
//
// The load-bearing test in this file is the taint check. A blind packet carrying
// any part of the diagnostician's conclusion makes the whole exercise theatre,
// and it would fail silently: the audit would still produce a hypothesis, it
// would still agree, and the agreement would still read as corroboration.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  assertBlind,
  buildBlindPacket,
  redact,
  parseObservableLine,
  parseBriefObservables,
  citationIsolation,
  checkSyllogism,
  checkCollision,
  packetDigest,
  CONCLUSION_KEYS,
} from '../src/blind.js';
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

const obs = (over = {}) => ({
  claim: 'judgejudy has had no commit in 94 days',
  inspectable_at: 'https://github.com/character-ai/judgejudy/commits/main',
  verify_seconds: 30,
  source_class: 'backstage',
  ...over,
});

const packet = (over = {}) =>
  buildBlindPacket({
    company: 'Character.AI',
    role: 'TPM, Model Alignment',
    dated: '2026-08-17',
    posting: { title: 'TPM', url: 'https://jobs.example.com/1', description: 'ordinary posting text' },
    observables: [obs()],
    ...over,
  });

// ---------------------------------------------------------------------------
// The taint check — a blind packet must carry no conclusion
// ---------------------------------------------------------------------------

t('a clean packet passes', () => {
  assert.doesNotThrow(() => assertBlind(packet()));
});

t('every conclusion key is refused at the top level', () => {
  // Each of these is the diagnostician's answer rather than the record. One of
  // them in the packet and phase 1 is reading the homework it is meant to be
  // independent of.
  for (const key of CONCLUSION_KEYS) {
    const p = { ...packet(), [key]: 'anything at all' };
    assert.throws(() => assertBlind(p), new RegExp(key), `${key} should taint the packet`);
  }
});

t('a conclusion nested inside the packet is still a conclusion', () => {
  const p = packet();
  p.posting = { ...p.posting, evidence: [{ claim: 'leaked' }] };
  assert.throws(() => assertBlind(p), /evidence/);
});

t('the Weakest Link formula in prose taints the packet even with no forbidden key', () => {
  // The leak that no key check catches: the hypothesis pasted into a description
  // or an observable claim.
  const p = packet({
    observables: [obs({ claim: 'Character.AI produces no more aligned model releases than its slowest eval harness allows.' })],
  });
  assert.throws(() => assertBlind(p), /Weakest Link formula/);
});

t('the taint error names every problem, not the first', () => {
  const p = { ...packet(), verdict: 'SHIP', evidence: [], constraint_hypothesis: {} };
  try {
    assertBlind(p);
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.tainted.length, 3, `expected three taints, got ${JSON.stringify(e.tainted)}`);
  }
});

t('redact turns a full diagnosis into something a blind pass may read', () => {
  const doc = {
    company: 'Testco',
    role: 'Engineer',
    url: 'https://example.com/job',
    constraint_hypothesis: { binding_part: 'the thing' },
    evidence: [{ claim: 'x' }],
    verdict: 'SHIP',
    audit: { verdict: 'PASS' },
  };
  const r = redact(doc);
  assert.deepEqual(Object.keys(r).sort(), ['company', 'role', 'url']);
  assert.doesNotThrow(() => assertBlind(r));
});

t('a real diagnosis is refused as a blind packet', () => {
  // The co-current file this whole mechanism exists to reject. Reading the
  // artifact itself is exactly what phase 1 may not do.
  const file = path.join(REPO, 'data/diagnoses/synthesia-solutions-architect.yaml');
  if (!fs.existsSync(file)) return; // corpus is gitignored; skip rather than fail
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.throws(() => assertBlind(doc), /tainted/);
});

t('the packet digest ties a hypothesis to the material it was formed from', () => {
  const a = packet();
  const b = packet();
  assert.equal(packetDigest(a), packetDigest(b));
  assert.notEqual(packetDigest(a), packetDigest(packet({ observables: [obs({ claim: 'different' })] })));
});

// ---------------------------------------------------------------------------
// Reading the raw record
// ---------------------------------------------------------------------------

t('an observable line parses into a row', () => {
  const r = parseObservableLine(
    '- `judgejudy` (Go, MIT), 0 open issues, last commit 2026-07-06 — https://github.com/character-ai/judgejudy — 15s — backstage'
  );
  assert.match(r.claim, /judgejudy/);
  assert.equal(r.inspectable_at, 'https://github.com/character-ai/judgejudy');
  assert.equal(r.verify_seconds, 15);
  assert.equal(r.source_class, 'backstage');
});

t('a posting-class observable maps to frontstage', () => {
  // The gatherer writes "posting"; the evidence schema knows two classes.
  const r = parseObservableLine('- Posting is live, published 2026-06-01 — https://jobs.example.com/1 — 5s — posting');
  assert.equal(r.source_class, 'frontstage');
});

t('an unparseable line keeps what could be read rather than being dropped', () => {
  // A dropped observable is a silently narrowed record, which is the failure the
  // whole brief exists to avoid.
  const r = parseObservableLine('- something with no url and no timing');
  assert.equal(r.claim, 'something with no url and no timing');
  assert.equal(r.inspectable_at, null);
});

t('observables are pulled from the right company section of a brief', () => {
  const md = [
    '# Evidence brief',
    '## Alpha Corp — Engineer',
    '### Observables',
    '- alpha one — https://a.example/1 — 5s — backstage',
    '## Beta Corp — Engineer',
    '### Observables',
    '- beta one — https://b.example/1 — 5s — backstage',
    '- beta two — https://b.example/2 — 8s — frontstage',
  ].join('\n');
  assert.equal(parseBriefObservables(md, 'Alpha Corp').length, 1);
  assert.equal(parseBriefObservables(md, 'Beta Corp').length, 2);
  assert.deepEqual(parseBriefObservables(md, 'Nobody'), []);
});

// ---------------------------------------------------------------------------
// Citation isolation — in code, at last
// ---------------------------------------------------------------------------

const diagRows = [
  { claim: 'a', inspectable_at: 'https://github.com/x/y/releases' },
  { claim: 'b', inspectable_at: 'https://example.com/changelog' },
];

t('an auditor row the diagnostician never cited satisfies isolation', () => {
  const r = citationIsolation(diagRows, [
    { claim: 'c', inspectable_at: 'https://example.com/status/history', source_class: 'backstage' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.isolated.length, 1);
  assert.equal(r.struck.length, 0);
});

t('an audit assembled only from the diagnostician\'s citations fails isolation', () => {
  // A proofread, not a second look. Re-reading their links confirms the links
  // resolve; it cannot detect a hypothesis built by looking only where it was
  // going to be confirmed.
  const r = citationIsolation(diagRows, [
    { claim: 'same', inspectable_at: 'https://github.com/x/y/releases', source_class: 'backstage' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.struck.length, 1);
  assert.match(r.reason, /proofread, not a second look/);
});

t('a shared citation with a declared independent route is not struck', () => {
  const r = citationIsolation(diagRows, [
    { claim: 'same url, reached separately', inspectable_at: 'https://example.com/changelog', source_class: 'backstage', independent_source: 'found via the RSS feed before reading the diagnosis' },
    { claim: 'new', inspectable_at: 'https://example.com/other', source_class: 'backstage' },
  ]);
  assert.equal(r.struck.length, 0);
  assert.equal(r.ok, true);
});

t('isolation compares urls, not their punctuation', () => {
  const r = citationIsolation([{ inspectable_at: 'https://Example.com/Changelog/' }], [
    { claim: 'x', inspectable_at: 'https://example.com/changelog?utm=1#top', source_class: 'backstage' },
  ]);
  assert.equal(r.struck.length, 1, 'a trailing slash and a tracking param must not read as a new source');
});

t('a frontstage-only auditor row does not satisfy isolation', () => {
  // The rule asks for a backstage trace. A new marketing page is not one.
  const r = citationIsolation(diagRows, [
    { claim: 'their about page', inspectable_at: 'https://example.com/about', source_class: 'frontstage' },
  ]);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// The syllogism, checked as form
// ---------------------------------------------------------------------------

const goodSyllogism = {
  major: 'A team whose only reviewer is on leave cannot merge changes.',
  minor: 'The eval repo has one reviewer and that reviewer is on leave.',
  middle_term: 'reviewer',
  conclusion: 'The eval repo cannot merge changes.',
};

t('a well-formed syllogism passes', () => {
  const r = checkSyllogism(goodSyllogism);
  assert.equal(r.ok, true);
  assert.equal(r.unbroken, true);
});

t('a middle term missing from a premise breaks the chain', () => {
  const r = checkSyllogism({ ...goodSyllogism, middle_term: 'deployment pipeline' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /major premise/.test(p)));
  assert.ok(r.problems.some((p) => /minor premise/.test(p)));
});

t('a middle term surviving into the conclusion is not an inference', () => {
  // The middle term is eliminated by the inference. One that reappears means the
  // conclusion restates a premise rather than following from two — which is what
  // an observable and a bottleneck asserted side by side look like.
  const r = checkSyllogism({
    major: 'A repo with no commits in 94 days is stalled.',
    minor: 'The eval repo has no commits in 94 days.',
    middle_term: 'no commits in 94 days',
    conclusion: 'The eval repo has no commits in 94 days.',
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /survives into the conclusion/.test(p)));
});

t('an empty or missing syllogism is refused', () => {
  assert.equal(checkSyllogism(null).ok, false);
  assert.equal(checkSyllogism({ major: 'x', minor: '', middle_term: 'y', conclusion: 'z' }).ok, false);
});

// ---------------------------------------------------------------------------
// The collision block
// ---------------------------------------------------------------------------

const blind = { hypothesis: 'Testco produces no more X than its slowest Y allows.', sources: ['https://a.example/1'] };

t('a corroborated collision needs no syllogism', () => {
  const r = checkCollision({ blind_phase: blind, collision: { agreement: 'corroborated' } });
  assert.equal(r.ok, true);
});

t('a diverged collision requires an argued syllogism', () => {
  const bad = checkCollision({ blind_phase: blind, collision: { agreement: 'diverged' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /no syllogism block/.test(p)));

  const good = checkCollision({ blind_phase: blind, collision: { agreement: 'diverged', syllogism: goodSyllogism } });
  assert.equal(good.ok, true);
});

t('a blind phase with no collision is an unread second opinion', () => {
  const r = checkCollision({ blind_phase: blind });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /unread second opinion/.test(p)));
});

t('a blind hypothesis with no sources fails', () => {
  const r = checkCollision({ blind_phase: { hypothesis: 'x', sources: [] }, collision: { agreement: 'corroborated' } });
  assert.equal(r.ok, false);
});

t('an audit with no blind phase is reported as co-current, not refused', () => {
  // Every audit written before this existed ran co-current. Refusing them would
  // take the record offline to enforce a rule that did not exist.
  const r = checkCollision({ verdict: 'PASS' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

// ---------------------------------------------------------------------------
// Where it bites in the gate
// ---------------------------------------------------------------------------

const row = (over = {}) => ({
  claim: 'no releases in 94 days on a repo whose prior cadence was every 14 days',
  inspectable_at: 'https://example.com/releases',
  verify_seconds: 6,
  source_class: 'backstage',
  strength: 4,
  ...over,
});

const doc = (auditOver = {}) => ({
  dated: '2026-08-17',
  acquittal: 'EVIDENCE_SUFFICIENT',
  evidence: [row()],
  disconfirming: { query_issued: 'q', result: 'nothing', survived: true },
  verdict: 'PARK',
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
    auditor_evidence: [row({ claim: 'independent', inspectable_at: 'https://example.com/status-history' })],
    verdict: 'PASS',
    ...auditOver,
  },
});

t('a PASS whose auditor cited nothing new is an error in the gate', () => {
  const d = doc({ auditor_evidence: [row({ claim: 're-read', inspectable_at: 'https://example.com/releases' })] });
  const r = inspectArtifact(d, { checkSeal: false });
  assert.ok(r.findings.some((f) => f.severity === 'error' && f.rule === 'R-ISOLATION'));
});

t('the same failure under a REJECT is a note, because the audit already stopped it', () => {
  const d = doc({
    verdict: 'REJECT',
    auditor_evidence: [row({ claim: 're-read', inspectable_at: 'https://example.com/releases' })],
  });
  const r = inspectArtifact(d, { checkSeal: false });
  assert.deepEqual(r.findings.filter((f) => f.severity === 'error' && f.rule === 'R-ISOLATION'), []);
});

t('a co-current audit is reported on every artifact that has one', () => {
  const r = inspectArtifact(doc(), { checkSeal: false });
  assert.ok(r.findings.some((f) => f.rule === 'R-COLLISION' && /co-current/.test(f.message)));
});

t('a malformed collision block fails the artifact', () => {
  const r = inspectArtifact(doc({ blind_phase: blind, collision: { agreement: 'diverged' } }), { checkSeal: false });
  assert.ok(r.findings.some((f) => f.severity === 'error' && f.rule === 'R-COLLISION'));
});

t('a complete countercurrent audit passes and says so', () => {
  const r = inspectArtifact(
    doc({ blind_phase: blind, collision: { agreement: 'corroborated', note: 'both named the eval harness' } }),
    { checkSeal: false }
  );
  assert.deepEqual(r.findings.filter((f) => f.severity === 'error'), []);
  assert.ok(r.findings.some((f) => f.rule === 'R-COLLISION' && /countercurrent audit, corroborated/.test(f.message)));
});

console.log(`\n${pass} passing`);
