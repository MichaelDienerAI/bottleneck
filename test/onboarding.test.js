// Candidate onboarding, at the intake boundary.
//
// A resume bullet and a proof unit are different objects. "Drove significant
// improvements to platform reliability" has a subject, a verb, and nothing a
// stranger can check. Most of what a candidate writes about themselves lives in
// that gap, and the useful thing this parser does is refuse to carry it across.
//
// The assertion that matters most is the last one: nothing lands in the sovereign
// half of the ledger. A unit a parser derived from something the candidate wrote
// about themselves is the definition of speculative, and promoting it would be
// the "memory written by a model is a claim nobody checked" failure with a
// different filename.

import assert from 'node:assert';
import { onboard, parseUnit, segment, mergeIntoLedger, slugify } from '../src/onboarding.js';

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

const GOOD =
  'Cut median voice pipeline latency from 1400ms to 780ms across the deployed stack https://personaio.app';

const one = (text, domain = null) => parseUnit({ text, domain });

// ---------------------------------------------------------------------------
// The three refusals
// ---------------------------------------------------------------------------

t('a claim with no URL is refused', () => {
  const r = one('Cut median latency from 1400ms to 780ms.');
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /MISSING RECORD/.test(x)));
});

t('a claim with no measured change is refused', () => {
  // A direction is not a measurement.
  const r = one('Improved the reliability of the voice pipeline https://personaio.app');
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /no metric_delta/.test(x)));
});

t('a claim nothing could falsify is refused', () => {
  const r = one('Passionate about building great products.');
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /could turn out to be wrong/.test(x)));
});

t('banned vocabulary is refused by name', () => {
  // CLAUDE.md rules these out of every generated artifact.
  for (const word of ['leveraged', 'synergy', 'optimized', 'best practices', 'move the needle']) {
    const r = one(`${word} to cut latency from 1400ms to 780ms https://x.example/a`);
    assert.equal(r.ok, false, `"${word}" should be refused`);
    assert.ok(r.reasons.some((x) => /banned vocabulary/.test(x)), word);
  }
});

t('hype adjectives are refused, and the reason says why', () => {
  const r = one('Significantly reduced latency from 1400ms to 780ms https://x.example/a');
  assert.equal(r.ok, false);
  const reason = r.reasons.find((x) => /unfalsifiable qualifier/.test(x));
  assert.ok(reason);
  assert.match(reason, /Delete it and the claim says the same checkable thing/);
});

t('the parser refuses rather than repairing', () => {
  // A parser that rewrites a claim to make it pass has authored a claim nobody
  // made. There is no repaired unit on a refusal.
  const r = one('Significantly improved things.');
  assert.equal(r.ok, false);
  assert.equal(r.unit, undefined);
  assert.equal(r.claim, 'Significantly improved things.');
});

// ---------------------------------------------------------------------------
// What gets through
// ---------------------------------------------------------------------------

t('a claim with an address and a measured change is accepted', () => {
  const r = one(GOOD, 'voice');
  assert.equal(r.ok, true);
  assert.equal(r.unit.backstage_url, 'https://personaio.app');
  assert.equal(r.unit.domain, 'voice');
  assert.match(r.unit.metric_delta, /1400ms to 780ms/);
  assert.ok(!r.unit.claim.includes('http'), 'the URL is lifted out of the claim, not left in it');
});

t('several metric shapes count as a delta', () => {
  for (const claim of [
    'Cut p95 latency by 43% https://x.example/a',
    'Raised throughput 3x https://x.example/a',
    'Wrote 467 assertions across 16 suites https://x.example/a',
    'Reduced build time from 12 minutes to 90 seconds https://x.example/a',
  ]) {
    assert.equal(one(claim).ok, true, claim);
  }
});

t('an id is derived from the claim and collisions are disambiguated', () => {
  // Two bullets about the same artifact would collide in the ledger and the
  // second would silently replace the first.
  const r = onboard([`- ${GOOD}`, `- ${GOOD}`].join('\n'));
  assert.equal(r.accepted.length, 2);
  assert.notEqual(r.accepted[0].id, r.accepted[1].id);
  assert.match(r.accepted[1].id, /_2$/);
});

t('slugify produces a ledger-safe id', () => {
  assert.equal(slugify('Cut median latency — 1400ms to 780ms!'), 'cut_median_latency_1400ms_to_780ms');
});

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

t('headings name the domain for the lines under them', () => {
  const s = segment(['## Voice', '- did a thing', '## Evaluation', '- did another'].join('\n'));
  assert.equal(s[0].domain, 'Voice');
  assert.equal(s[1].domain, 'Evaluation');
});

t('bullets, numbered lists and bare paragraphs are all read', () => {
  const s = segment(['- one', '2. two', '* three', 'four'].join('\n'));
  assert.equal(s.length, 4);
  assert.deepEqual(s.map((x) => x.text), ['one', 'two', 'three', 'four']);
});

// ---------------------------------------------------------------------------
// The whole intake
// ---------------------------------------------------------------------------

t('accepted and refused are both reported', () => {
  // A run that silently dropped eleven of twelve bullets would look like a thin
  // resume rather than a strict boundary. Those are different findings.
  const r = onboard(['## Voice', `- ${GOOD}`, '- Spearheaded transformative platform work.'].join('\n'));
  assert.equal(r.read, 2);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.ok(r.rejected[0].reasons.length >= 1);
});

t('a candidate with nothing admissible fails closed', () => {
  // Zero proof units is a finding, not an error, and an ok of true would let a
  // caller treat an empty ledger as a full one.
  const r = onboard('- Passionate self-starter with a proven track record.');
  assert.equal(r.ok, false);
  assert.equal(r.accepted.length, 0);
});

t('empty input produces no units and no crash', () => {
  const r = onboard('');
  assert.equal(r.read, 0);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// The ledger merge — the assertion that matters most
// ---------------------------------------------------------------------------

const ledger = () => ({
  sovereign: [{ id: 'persona_io', inspect_at: 'https://personaio.app' }],
  speculative: [{ id: 'resume', name: 'Resume' }],
  known_gaps: [],
});

t('nothing a parser produced lands in the sovereign half', () => {
  // A sovereign proof is deployed and inspectable by a stranger. A unit derived
  // from something the candidate wrote about themselves is the other thing, and
  // promoting it automatically is the failure this repository names everywhere.
  const r = onboard(`- ${GOOD}`);
  const m = mergeIntoLedger(ledger(), r.accepted);
  assert.equal(m.ledger.sovereign.length, 1, 'the sovereign half must be untouched');
  assert.equal(m.ledger.sovereign[0].id, 'persona_io');
  assert.equal(m.ledger.speculative.length, 2);
  assert.equal(m.ledger.speculative[1].promoted, false);
  assert.equal(m.ledger.speculative[1].source, 'onboarding');
});

t('an existing entry is left alone rather than overwritten', () => {
  // A re-run must not clobber a unit a human has since edited.
  const base = ledger();
  const r = onboard(`- ${GOOD}`);
  // Derived, not hardcoded: slugify truncates at 48 characters, and a test that
  // spells the id out drifts the moment the claim or the cap changes.
  const id = r.accepted[0].id;
  base.speculative.push({ id, claim: 'edited by hand' });
  const m = mergeIntoLedger(base, r.accepted);
  assert.equal(m.added.length, 0);
  assert.deepEqual(m.skipped, [id]);
  assert.equal(m.ledger.speculative.find((e) => e.claim === 'edited by hand').claim, 'edited by hand');
});

t('the merge does not mutate the ledger it was given', () => {
  const base = ledger();
  const before = JSON.stringify(base);
  mergeIntoLedger(base, onboard(`- ${GOOD}`).accepted);
  assert.equal(JSON.stringify(base), before);
});

t('known_gaps and every other ledger key survive the merge', () => {
  const base = { ...ledger(), known_gaps: [{ id: 'calibration_layer' }] };
  const m = mergeIntoLedger(base, onboard(`- ${GOOD}`).accepted);
  assert.deepEqual(m.ledger.known_gaps, [{ id: 'calibration_layer' }]);
});

console.log(`\n${pass} passing`);
