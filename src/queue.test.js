// Striking a row is the one place a person removes work from in front of the
// drum, so the failure modes are worth naming: a struck row that comes back, a
// backfill that reopens a closed company, and a backfill that hands one employer
// the buffer. Each has a test below.
//
// No network, no filesystem, no model. Every function under test is pure.

import assert from 'node:assert';
import { strikeRow, strikeRecord, eligibleBackfill, pickBackfill } from './queue.js';

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

const row = (over = {}) => ({
  key: 'ashby:Test:1',
  company: 'Test',
  archetype: 'conversational_ai',
  title: 'Senior Conversational AI Engineer',
  url: 'https://example.com/1',
  score: 5,
  flags: [],
  ...over,
});

// ---------------------------------------------------------------------------
// Striking
// ---------------------------------------------------------------------------

t('striking removes exactly one row and hands it back', () => {
  const queue = [row({ key: 'a' }), row({ key: 'b' }), row({ key: 'c' })];
  const { queue: next, struck } = strikeRow(queue, 'b');
  assert.deepEqual(next.map((r) => r.key), ['a', 'c']);
  assert.equal(struck.key, 'b');
});

t('striking an unknown key changes nothing and reports nothing struck', () => {
  const queue = [row({ key: 'a' })];
  const { queue: next, struck } = strikeRow(queue, 'nope');
  assert.equal(struck, null);
  assert.deepEqual(next.map((r) => r.key), ['a']);
});

t('striking does not mutate the queue it was given', () => {
  const queue = [row({ key: 'a' }), row({ key: 'b' })];
  strikeRow(queue, 'a');
  assert.equal(queue.length, 2, 'a pure function that edits its input corrupts the file on disk');
});

t('the strike record carries enough to audit the decision later', () => {
  const r = strikeRecord(row({ key: 'a', flags: ['comp:unknown'] }), { at: '2026-08-16' });
  assert.equal(r.key, 'a');
  assert.equal(r.company, 'Test');
  assert.equal(r.title, 'Senior Conversational AI Engineer');
  assert.equal(r.url, 'https://example.com/1');
  assert.equal(r.struck_at, '2026-08-16');
  assert.equal(r.source, 'dashboard');
  assert.deepEqual(r.flags, ['comp:unknown']);
  assert.equal(r.reason, null, 'no reason is recorded as null rather than invented');
});

// ---------------------------------------------------------------------------
// Backfill eligibility
// ---------------------------------------------------------------------------

t('a row already in the queue is not a backfill candidate', () => {
  const queue = [row({ key: 'a' })];
  const out = eligibleBackfill([row({ key: 'a' }), row({ key: 'b', company: 'Other' })], { queue });
  assert.deepEqual(out.map((r) => r.key), ['b']);
});

t('a struck row never returns on its own', () => {
  // The whole point of data/struck.json. Without this the next backfill hands
  // back the row that was just declined, which reads as the system arguing.
  const out = eligibleBackfill([row({ key: 'a' }), row({ key: 'b', company: 'Other' })], {
    queue: [],
    struckKeys: new Set(['a']),
  });
  assert.deepEqual(out.map((r) => r.key), ['b']);
});

t('a delisted row is not backfilled', () => {
  const out = eligibleBackfill([row({ key: 'a' })], { queue: [], delistedKeys: new Set(['a']) });
  assert.deepEqual(out, []);
});

t('a closed case is not reopened by a backfill', () => {
  // shouldSkip closes DEAD, SHIPPED, and cooling companies. A backfill that
  // ignored it would walk a company back into the buffer the week after a
  // diagnosis closed it, and the drum would pay for it.
  const out = eligibleBackfill([row({ key: 'a', company: 'Closed' }), row({ key: 'b', company: 'Open' })], {
    queue: [],
    isClosed: (c) => c === 'Closed',
  });
  assert.deepEqual(out.map((r) => r.key), ['b']);
});

t('the company cap counts the queue as it stands after the strike', () => {
  const queue = [row({ key: 'a', company: 'Big' }), row({ key: 'b', company: 'Big' })];
  const candidates = [row({ key: 'c', company: 'Big' }), row({ key: 'd', company: 'Small' })];
  assert.deepEqual(
    eligibleBackfill(candidates, { queue, maxPerCompany: 2 }).map((r) => r.key),
    ['d'],
    'Big already holds two rows, so a third must not backfill'
  );
  // Strike one of Big's rows and the third becomes eligible.
  const { queue: next } = strikeRow(queue, 'a');
  assert.deepEqual(
    eligibleBackfill(candidates, { queue: next, maxPerCompany: 2 }).map((r) => r.key),
    ['c', 'd']
  );
});

t('eligibility preserves the ranked order it was given', () => {
  const candidates = [row({ key: 'a', company: 'A' }), row({ key: 'b', company: 'B' }), row({ key: 'c', company: 'C' })];
  assert.deepEqual(eligibleBackfill(candidates, { queue: [] }).map((r) => r.key), ['a', 'b', 'c']);
});

t('malformed candidate rows are skipped rather than promoted', () => {
  const out = eligibleBackfill([null, {}, row({ key: 'a' })], { queue: [] });
  assert.deepEqual(out.map((r) => r.key), ['a']);
});

// ---------------------------------------------------------------------------
// Picking the replacement
// ---------------------------------------------------------------------------

t('an empty bench returns null rather than throwing', () => {
  assert.equal(pickBackfill([], { queue: [] }), null);
  assert.equal(pickBackfill([row({ key: 'a' })], { queue: [row({ key: 'a' })] }), null);
});

t('an unrepresented archetype outranks a higher-scoring row from a represented one', () => {
  // archetypeFloor() applied one row at a time. Refilling a gap with more of
  // what the buffer already holds narrows the spread on every strike.
  const queue = [row({ key: 'q', archetype: 'conversational_ai' })];
  const candidates = [
    row({ key: 'a', company: 'A', archetype: 'conversational_ai', score: 9 }),
    row({ key: 'b', company: 'B', archetype: 'red_team_boutiques', score: 2 }),
  ];
  assert.equal(pickBackfill(candidates, { queue }).key, 'b');
});

t('with every archetype represented, the ranked order decides', () => {
  const queue = [
    row({ key: 'q1', archetype: 'conversational_ai' }),
    row({ key: 'q2', archetype: 'red_team_boutiques' }),
  ];
  const candidates = [
    row({ key: 'a', company: 'A', archetype: 'red_team_boutiques', score: 9 }),
    row({ key: 'b', company: 'B', archetype: 'conversational_ai', score: 8 }),
  ];
  assert.equal(pickBackfill(candidates, { queue }).key, 'a');
});

t('a candidate with no archetype cannot claim the floor preference', () => {
  const queue = [row({ key: 'q', archetype: 'conversational_ai' })];
  const candidates = [
    row({ key: 'a', company: 'A', archetype: null }),
    row({ key: 'b', company: 'B', archetype: 'infrastructure' }),
  ];
  assert.equal(pickBackfill(candidates, { queue }).key, 'b');
});

t('the replacement prefers a company other than the one just struck', () => {
  // Measured against the live buffer: striking OpenAI's alignment row backfilled
  // a different OpenAI row, because the strike left frontier_labs unrepresented
  // and OpenAI held the best candidate in it. Correct by the floor rule and
  // useless to read.
  const queue = [row({ key: 'q', company: 'Other', archetype: 'conversational_ai' })];
  const candidates = [
    row({ key: 'a', company: 'OpenAI', archetype: 'frontier_labs', score: 9 }),
    row({ key: 'b', company: 'Anthropic', archetype: 'frontier_labs', score: 1 }),
  ];
  assert.equal(pickBackfill(candidates, { queue, avoidCompany: 'OpenAI' }).key, 'b');
  // Without the preference the higher-scoring row still wins.
  assert.equal(pickBackfill(candidates, { queue }).key, 'a');
});

t('the struck company still wins when it holds the only row of a missing archetype', () => {
  // Going back to the same company beats losing the archetype entirely. The
  // preference reorders; it never excludes.
  const queue = [row({ key: 'q', company: 'Other', archetype: 'conversational_ai' })];
  const candidates = [
    row({ key: 'a', company: 'Elsewhere', archetype: 'conversational_ai' }),
    row({ key: 'b', company: 'OpenAI', archetype: 'frontier_labs' }),
  ];
  assert.equal(pickBackfill(candidates, { queue, avoidCompany: 'OpenAI' }).key, 'b');
});

t('with archetypes all covered, avoiding the struck company still applies', () => {
  const queue = [row({ key: 'q', company: 'Other', archetype: 'conversational_ai' })];
  const candidates = [
    row({ key: 'a', company: 'OpenAI', archetype: 'conversational_ai', score: 9 }),
    row({ key: 'b', company: 'Anthropic', archetype: 'conversational_ai', score: 1 }),
  ];
  assert.equal(pickBackfill(candidates, { queue, avoidCompany: 'OpenAI' }).key, 'b');
});

t('the replacement respects every exclusion at once', () => {
  const queue = [row({ key: 'q', company: 'Big', archetype: 'conversational_ai' })];
  const candidates = [
    row({ key: 'struck', company: 'A', archetype: 'frontier_labs' }),
    row({ key: 'closed', company: 'Closed', archetype: 'frontier_labs' }),
    row({ key: 'gone', company: 'B', archetype: 'frontier_labs' }),
    row({ key: 'ok', company: 'C', archetype: 'frontier_labs' }),
  ];
  const pick = pickBackfill(candidates, {
    queue,
    struckKeys: new Set(['struck']),
    delistedKeys: new Set(['gone']),
    isClosed: (c) => c === 'Closed',
    maxPerCompany: 2,
  });
  assert.equal(pick.key, 'ok');
});

console.log(`\n${pass} passing`);
