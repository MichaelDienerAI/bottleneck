// Liveness, tested without a network. checkUrl takes an injected fetch for
// exactly this reason: a test that reaches a real ATS endpoint fails on a plane
// and passes on a bad answer, which is not a test.

import assert from 'node:assert';
import { delisted, unverifiable, checkUrl, checkUrls, GONE_STATUSES } from '../src/liveness.js';

let pass = 0;
const t = (name, fn) => {
  const done = () => {
    pass++;
    console.log(`ok   ${name}`);
  };
  const fail = (e) => {
    console.log(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  };
  try {
    const out = fn();
    return out instanceof Promise ? out.then(done, fail) : done();
  } catch (e) {
    fail(e);
  }
};

const row = (over = {}) => ({
  key: 'ashby:ElevenLabs:1',
  company: 'ElevenLabs',
  source: 'ashby',
  url: 'https://jobs.ashbyhq.com/elevenlabs/1',
  ...over,
});

const queue = [
  row(),
  row({ key: 'ashby:ElevenLabs:2', url: 'https://jobs.ashbyhq.com/elevenlabs/2' }),
  row({ key: 'greenhouse:Sierra:9', company: 'Sierra', source: 'greenhouse' }),
];

const all = new Set(['ashby:ElevenLabs:1', 'greenhouse:Sierra:9']);
const everyBoardAnswered = new Set(['ElevenLabs', 'Sierra']);

await t('a buffer row absent from its board feed is delisted', () => {
  const out = delisted(queue, all, everyBoardAnswered);
  assert.deepEqual(out.map((r) => r.key), ['ashby:ElevenLabs:2']);
});

await t('a failed board delists nothing, because an empty fetch is not a closure', () => {
  // ElevenLabs 500'd this run, so its feed is empty. Without this guard the
  // whole company's buffer rows would be deleted by a transient error.
  const out = delisted(queue, new Set(['greenhouse:Sierra:9']), new Set(['Sierra']));
  assert.deepEqual(out.map((r) => r.key), []);
});

await t('rows from a board that did not answer are reported as unconfirmed', () => {
  const out = unverifiable(queue, new Set(['Sierra']));
  assert.deepEqual(out.map((r) => r.key), ['ashby:ElevenLabs:1', 'ashby:ElevenLabs:2']);
});

await t('404 and 410 are the only statuses that mean gone', () => {
  assert.deepEqual([...GONE_STATUSES].sort(), [404, 410]);
});

await t('a 404 posting url is gone', async () => {
  const r = await checkUrl('https://example.test/job', { fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(r.verdict, 'gone');
  assert.equal(r.status, 404);
});

await t('a 200 is reachable, which is deliberately not the same as open', async () => {
  const r = await checkUrl('https://example.test/job', { fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(r.verdict, 'reachable');
});

await t('a 500 is unreachable, not gone, so a bad afternoon cannot delist a row', async () => {
  const r = await checkUrl('https://example.test/job', { fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(r.verdict, 'unreachable');
  assert.equal(r.status, 500);
});

await t('a network error is unreachable and keeps the error text', async () => {
  const r = await checkUrl('https://example.test/job', {
    fetchImpl: async () => {
      throw new Error('ETIMEDOUT');
    },
  });
  assert.equal(r.verdict, 'unreachable');
  assert.equal(r.status, null);
  assert.match(r.note, /ETIMEDOUT/);
});

await t('a row with no url is unchecked rather than silently reachable', async () => {
  const r = await checkUrl('', { fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(r.verdict, 'unchecked');
});

await t('checkUrls returns one verdict per row, keyed back to the row', async () => {
  const statuses = { 'https://jobs.ashbyhq.com/elevenlabs/1': 200, 'https://jobs.ashbyhq.com/elevenlabs/2': 410 };
  const out = await checkUrls(queue, {
    fetchImpl: async (u) => ({ ok: statuses[u] === 200, status: statuses[u] ?? 200 }),
  });
  assert.equal(out.length, 3);
  assert.equal(out.find((c) => c.key === 'ashby:ElevenLabs:2').verdict, 'gone');
  assert.equal(out.find((c) => c.key === 'ashby:ElevenLabs:1').verdict, 'reachable');
});

console.log(`\n${pass} passing`);
