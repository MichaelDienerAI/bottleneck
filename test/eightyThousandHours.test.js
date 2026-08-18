// The 80,000 Hours adapter. Mocked payloads only — no network in any suite.
//
// The live endpoint was verified once, by hand, on 2026-08-18: 854 hits, and the
// record shape these fixtures copy. The fixtures are a snapshot of that shape and
// will drift from it silently, which is the standing weakness of every mocked
// network test. `npm run scan` is what notices.

import assert from 'node:assert';
import {
  normalizeHit,
  archetypeFor,
  fetchPage,
  fetchEightyThousandHours,
  ENDPOINT,
  SOURCE,
  TIMEOUT_MS,
  MAX_ATTEMPTS,
} from '../src/sources/eightyThousandHours.js';

let pass = 0;
const t = (name, fn) => {
  let done;
  const settle = (err) => {
    if (err) {
      console.log(`FAIL ${name}: ${err.message}`);
      process.exitCode = 1;
    } else {
      pass++;
      console.log(`ok   ${name}`);
    }
  };
  // A synchronous throw inside fn() used to escape this helper entirely, which
  // killed the process on the first failing assertion and reported nothing.
  try {
    done = fn();
  } catch (e) {
    settle(e);
    return Promise.resolve();
  }
  if (done && typeof done.then === 'function') return done.then(() => settle(), settle);
  settle();
  return Promise.resolve();
};

// Shaped from the live record read on 2026-08-18.
const hit = (over = {}) => ({
  post_pk: 20607,
  objectID: '20607',
  title: 'Senior Cyber Offense Specialist, Center for AI Standards and Innovation',
  company_name: 'US Government, National Institute of Standards and Technology',
  url_external: 'https://www.usajobs.gov/job/880883200?utm_source=80000hours',
  description: '<p>Work on <b>red team</b> evaluation of frontier systems.</p>',
  posted_at: 1787011500,
  closes_at: 1787529600,
  salary: 120000,
  salary_limit: 187093,
  card_locations: ['Washington, DC'],
  tags_role_type: ['Information security'],
  tags_area: ['AI safety'],
  ...over,
});

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

await t('a hit maps into the canonical row shape', () => {
  const r = normalizeHit(hit(), { fetched: '2026-08-18' });
  // Every field the rest of the pipeline reads. 43 call sites read `.title`, and
  // the buffer, dashboard, freshness audit and blind packet all key on these.
  for (const k of ['key', 'source', 'company', 'archetype', 'title', 'location', 'url', 'description', 'posted', 'comp', 'fetched']) {
    assert.ok(k in r, `missing canonical field ${k}`);
  }
  assert.equal(r.source, SOURCE);
  assert.equal(r.key, `80000hours:US Government, National Institute of Standards and Technology:20607`);
  assert.equal(r.location, 'Washington, DC');
});

await t('the brief\'s fields are carried additively, not instead', () => {
  // role_title replacing title would pass Gate 0 and then break everything
  // downstream that reads .title. Both are present.
  const r = normalizeHit(hit(), { fetched: '2026-08-18' });
  assert.equal(r.ats_kind, '80000hours');
  assert.equal(r.role_title, r.title);
  assert.ok(r.first_seen, 'first_seen is written');
  assert.ok(r.title, 'and title survives beside it');
});

await t('posted_at unix seconds become a date gate0 can parse', () => {
  // gate0's freshness rule reads whatever string it is handed. A raw epoch would
  // flag posted:unknown on every row, which is a blocking flag.
  const r = normalizeHit(hit(), { fetched: '2026-08-18' });
  assert.match(r.posted, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(normalizeHit(hit({ posted_at: null })).posted, null);
});

await t('html is stripped from the description', () => {
  const r = normalizeHit(hit());
  assert.ok(!/[<>]/.test(r.description), r.description);
  assert.match(r.description, /red team evaluation/);
});

await t('salary maps to the comp shape, and absence is null not zero', () => {
  assert.deepEqual(normalizeHit(hit()).comp, { min: 120000, max: 187093, currency: 'USD' });
  assert.equal(normalizeHit(hit({ salary: null, salary_limit: null })).comp, null);
});

await t('every row lands in an archetype that exists in the registry', () => {
  // An unknown archetype would rank against an undefined weight.
  const known = ['conversational_ai', 'agentic_startups', 'red_team_boutiques', 'experiential_design', 'infrastructure', 'frontier_labs'];
  assert.equal(archetypeFor(hit()), 'red_team_boutiques');
  assert.equal(archetypeFor(hit({ title: 'Voice Platform Engineer', tags_role_type: [], tags_area: [] })), 'conversational_ai');
  assert.ok(known.includes(archetypeFor(hit({ title: 'Grants Officer', tags_role_type: [], tags_area: [], tags_skill: [] }))));
});

// ---------------------------------------------------------------------------
// Network policy
// ---------------------------------------------------------------------------

await t('the request carries a timeout signal', async () => {
  // liveness.js has one and sources.js does not, which the structural audit
  // recorded as a High finding. A hung socket on an aggregator would stall the
  // whole scheduled run with nobody watching.
  let seen = null;
  await fetchPage({ fetchImpl: async (url, opts) => ((seen = opts), okResponse({ hits: [] })) });
  assert.ok(seen.signal, 'no AbortSignal on the request');
  assert.equal(TIMEOUT_MS, 8000);
});

await t('a transient status is retried up to the attempt limit', async () => {
  let calls = 0;
  const res = await fetchPage({
    fetchImpl: async () => {
      calls++;
      return calls < 3 ? { ok: false, status: 503 } : okResponse({ hits: [hit()] });
    },
    sleepImpl: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(res.hits.length, 1);
});

await t('a non-transient status is not retried', async () => {
  // A 403 means the published search key rotated. Hammering it three times
  // establishes nothing the first response did not.
  let calls = 0;
  await assert.rejects(
    () =>
      fetchPage({
        fetchImpl: async () => {
          calls++;
          return { ok: false, status: 403 };
        },
        sleepImpl: async () => {},
      }),
    /HTTP 403/
  );
  assert.equal(calls, 1);
});

await t('retries are bounded and the last error surfaces', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchPage({
        fetchImpl: async () => {
          calls++;
          return { ok: false, status: 500 };
        },
        sleepImpl: async () => {},
      }),
    /HTTP 500/
  );
  assert.equal(calls, MAX_ATTEMPTS);
});

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

await t('paging stops at nbPages rather than running to the cap', async () => {
  let pages = 0;
  const r = await fetchEightyThousandHours({
    maxPages: 10,
    fetchImpl: async () => {
      pages++;
      return okResponse({ hits: [hit({ post_pk: pages })], nbHits: 2, nbPages: 2 });
    },
    sleepImpl: async () => {},
  });
  assert.equal(pages, 2);
  assert.equal(r.rows.length, 2);
});

await t('rows missing a company, title or url are dropped', async () => {
  // The aggregator carries partial records. A row with no url is not a posting.
  const r = await fetchEightyThousandHours({
    maxPages: 1,
    fetchImpl: async () =>
      okResponse({
        hits: [hit(), hit({ post_pk: 2, url_external: '' }), hit({ post_pk: 3, company_name: '' })],
        nbHits: 3,
        nbPages: 1,
      }),
    sleepImpl: async () => {},
  });
  assert.equal(r.rows.length, 1);
});

await t('the endpoint is the published index, not a guessed path', () => {
  // Three plausible REST paths were probed and all 404'd. This one was read out
  // of the delivered page.
  assert.match(ENDPOINT, /^https:\/\/W6KM1UDIB3-dsn\.algolia\.net\/1\/indexes\/jobs_prod\/query$/);
});

console.log(`\n${pass} passing`);
