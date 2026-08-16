// Gate 0 is the only part of this system that can be tested without a network
// or a model. Test it, because it decides what the bottleneck resource ever sees.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import assert from 'node:assert';
import { gate0, rank, capPerCompany, blockingFlags, isBlocked, BLOCKING_FLAGS, fitScore, compositeScore, archetypeFloor, WEIGHT_MULTIPLIER, ageInDays, MAX_AGE_DAYS, normalizeTitle, repostKey, repostFlag, updateRepostIndex, REPOST_MIN_AGE_DAYS } from './gates.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = yaml.load(fs.readFileSync(path.join(ROOT, 'profile/gates.example.yaml'), 'utf8'));

// Relative to the run, never a literal date. Gate 0 kills anything older than
// ninety days, so a hard-coded fixture date turns this whole file red about
// three months after somebody writes it, for reasons having nothing to do with
// the rule under test.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const job = (over = {}) => ({
  key: 'x',
  company: 'Test',
  archetype: 'conversational_ai',
  title: 'Senior Conversational AI Engineer',
  location: 'Remote (US)',
  description: 'Build voice agents. Own behavioral specs.',
  posted: daysAgo(10),
  comp: null,
  ...over,
});

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

t('target title on a remote senior role passes', () => {
  assert.equal(gate0(job(), cfg).pass, true);
});

t('junior titles die', () => {
  const r = gate0(job({ title: 'Junior AI Developer' }), cfg);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => x.startsWith('seniority')));
});

t('off-family titles die', () => {
  const r = gate0(job({ title: 'Senior Accountant' }), cfg);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => x.startsWith('title')));
});

t('an AI tooling ban kills the row', () => {
  const r = gate0(job({ description: 'Note: candidates may not use AI tools during work.' }), cfg);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => x.startsWith('ai_tooling_ban')));
});

t('a training-loop requirement kills the row', () => {
  const r = gate0(job({ description: 'You will write a PyTorch training loop daily.' }), cfg);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => x.startsWith('capability_gap')));
});

t('onsite outside Phoenix dies while relocation is off', () => {
  const r = gate0(job({ location: 'New York, NY' }), cfg);
  assert.equal(r.pass, false);
});

t('Phoenix onsite passes', () => {
  assert.equal(gate0(job({ location: 'Phoenix, AZ' }), cfg).pass, true);
});

t('a published band under the floor kills the row', () => {
  const r = gate0(job({ comp: { min: 90000, max: 110000 } }), cfg);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => x.startsWith('comp')));
});

t('a band over the floor passes', () => {
  assert.equal(gate0(job({ comp: { min: 150000, max: 190000 } }), cfg).pass, true);
});

t('a band in free text is extracted', () => {
  const r = gate0(job({ description: 'Range is $95,000 - $115,000 plus equity.' }), cfg);
  assert.equal(r.pass, false);
});

t('missing comp flags rather than kills', () => {
  const r = gate0(job(), cfg);
  assert.equal(r.pass, true);
  assert.ok(r.flags.some((f) => f.startsWith('comp:unknown')));
});

t('generalist phrasing flags without killing', () => {
  const r = gate0(job({ description: 'We want a full stack engineer mindset on voice agents.' }), cfg);
  assert.equal(r.pass, true);
  assert.ok(r.flags.some((f) => f.startsWith('generalist_trap')));
});

t('ranking follows allocation weight, not prestige', () => {
  const weights = { conversational_ai: 0.3, frontier_labs: 0.05 };
  const out = rank(
    [job({ company: 'BigLab', archetype: 'frontier_labs' }), job({ company: 'Small', archetype: 'conversational_ai' })],
    weights
  );
  assert.equal(out[0].company, 'Small');
});

// Relocation-on config, declared inline rather than read from profile/gates.yaml.
// That file is gitignored, so a test depending on it would pass on Michael's
// machine and fail everywhere else.
const relocCfg = {
  ...cfg,
  location: {
    base: 'Phoenix, AZ',
    accept: ['remote', 'hybrid', 'onsite'],
    accept_relocation: true,
    preference: { stay_until: '2027-01-01' },
    hubs: {
      tier_1: ['San Francisco', 'Redwood City', 'New York', 'London'],
      tier_2: ['Berlin', 'Toronto', 'Zurich'],
      tier_3: ['Valencia', 'Denver'],
    },
    accept_country_only: [
      'United States', 'United Kingdom', 'Europe', 'Global', 'Worldwide', 'California', 'Washington',
    ],
    remote_office_signals: ['Remote-Friendly', 'Travel-Required', 'Travel Required'],
  },
};
// Past relocCfg's stay_until of 2027-01-01.
const FUTURE = new Date('2027-02-01T00:00:00Z');

// The location tests pass an explicit `now`, sometimes years out to get past
// stay_until. The posting date has to move with it: a fixture posted ten days
// before today is six months stale when the test asks what the gate says in
// February 2027, and every one of these rows would fail on freshness instead of
// testing the location rule it was written for.
const at = (loc, now = new Date()) =>
  job({ location: loc, posted: new Date(now.getTime() - 10 * 86400000).toISOString().slice(0, 10) });

t('a London onsite role passes once relocation is on', () => {
  assert.equal(gate0(at('London, UK'), relocCfg).pass, true);
});

t('a Valencia role passes, tier 3 is accepted not merely noted', () => {
  assert.equal(gate0(at('Valencia, Spain'), relocCfg).pass, true);
});

t('an unlisted city fails even with relocation on', () => {
  const r = gate0(at('Omaha, NE'), relocCfg);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => x.startsWith('location')));
});

t('remote still passes', () => {
  assert.equal(gate0(at('Remote (US)'), relocCfg).pass, true);
});

t('an empty location still passes', () => {
  assert.equal(gate0(at(''), relocCfg).pass, true);
});

t('the base city passes without consulting the hub list', () => {
  assert.equal(gate0(at('Phoenix, AZ'), relocCfg).pass, true);
});

t('relocation off returns the gate to base plus remote', () => {
  const off = { ...relocCfg, location: { ...relocCfg.location, accept_relocation: false } };
  assert.equal(gate0(at('London, UK'), off).pass, false);
  assert.equal(gate0(at('Remote (US)'), off).pass, true);
  assert.equal(gate0(at('Phoenix, AZ'), off).pass, true);
});

t('a hub row carries its tier as a flag', () => {
  const r = gate0(at('Valencia, Spain'), relocCfg);
  assert.ok(r.flags.some((f) => f.startsWith('location_tier:tier_3')));
});

t('before stay_until a relocation row is priced, not killed', () => {
  const r = gate0(at('London, UK'), relocCfg, new Date('2026-08-12T00:00:00Z'));
  assert.equal(r.pass, true);
  assert.ok(r.flags.some((f) => f.startsWith('relocation_cost')));
});

t('after stay_until the relocation cost flag falls away', () => {
  const r = gate0(at('London, UK', FUTURE), relocCfg, FUTURE);
  assert.equal(r.pass, true);
  assert.ok(!r.flags.some((f) => f.startsWith('relocation_cost')));
  assert.ok(r.flags.some((f) => f.startsWith('location_tier:tier_1')));
});

t('remote and base rows carry no relocation cost', () => {
  const now = new Date('2026-08-12T00:00:00Z');
  for (const loc of ['Remote (US)', 'Phoenix, AZ']) {
    const r = gate0(at(loc), relocCfg, now);
    assert.ok(!r.flags.some((f) => f.startsWith('relocation_cost')), loc);
    assert.ok(!r.flags.some((f) => /^(location_tier|country_only|remote_unverified):/.test(f)), loc);
  }
});

t('a named Bay Area town passes where the region abstraction could not', () => {
  assert.equal(gate0(at('Redwood City, CA'), relocCfg).pass, true);
  // The abstraction itself is not a place anyone writes, so it must not be
  // what carries the match.
  assert.equal(gate0(at('Bay Area'), relocCfg).pass, false);
});

t('diacritics do not hide a hub', () => {
  const r = gate0(at('Zürich, Switzerland'), relocCfg);
  assert.equal(r.pass, true);
  assert.ok(r.flags.some((f) => f.startsWith('location_tier:tier_2')));
});

t('a country-only string passes with a country_only flag', () => {
  for (const loc of ['United States', 'United Kingdom', 'Europe']) {
    const r = gate0(at(loc), relocCfg);
    assert.equal(r.pass, true, loc);
    assert.ok(r.flags.some((f) => f.startsWith('country_only:')), loc);
  }
});

t('globally distributed values pass with the country_only flag', () => {
  for (const loc of ['Global', 'Worldwide']) {
    const r = gate0(at(loc), relocCfg);
    assert.equal(r.pass, true, loc);
    assert.ok(r.flags.some((f) => f.startsWith('country_only:')), loc);
  }
});

t('remote-valued locations pass on the remote rule, not the country list', () => {
  // Anywhere/Distributed/Fully Remote short-circuit in isRemote before the
  // country list is reached. Pinning it so nobody adds them there as dead
  // config on the theory that they are currently being dropped.
  const noCountries = { ...relocCfg, location: { ...relocCfg.location, accept_country_only: [] } };
  for (const loc of ['Anywhere', 'Distributed', 'Fully Remote']) {
    const r = gate0(at(loc), noCountries);
    assert.equal(r.pass, true, loc);
    assert.ok(!r.flags.some((f) => /^(location_tier|country_only|remote_unverified):/.test(f)), loc);
  }
});

t('a state-level string passes with the country_only flag', () => {
  const r = gate0(at('California'), relocCfg);
  assert.equal(r.pass, true);
  assert.ok(r.flags.some((f) => f.startsWith('country_only:')));
});

t('a bare state does not admit its unlisted cities', () => {
  // "Washington" the state is accepted; Washington, DC is a different place
  // with no hub, and whole-string matching is what keeps them apart.
  assert.equal(gate0(at('Washington'), relocCfg).pass, true);
  assert.equal(gate0(at('Washington, DC'), relocCfg).pass, false);
});

t('a state containing a hub resolves as the hub when the city is named', () => {
  const r = gate0(at('San Francisco, California'), relocCfg);
  assert.equal(r.pass, true);
  assert.ok(r.flags.some((f) => f.startsWith('location_tier:tier_1')));
  assert.ok(!r.flags.some((f) => f.startsWith('country_only:')));
});

t('a country string does not smuggle an unlisted city past the gate', () => {
  // The whole point of whole-string matching. If this ever passes, the country
  // list has become a back door around the hub list.
  assert.equal(gate0(at('Omaha, NE, United States'), relocCfg).pass, false);
  assert.equal(gate0(at('Chicago, United States'), relocCfg).pass, false);
});

t('a country with no accepted hub is still a real rejection', () => {
  for (const loc of ['Brazil', 'Colombia', 'Sweden']) {
    assert.equal(gate0(at(loc), relocCfg).pass, false, loc);
  }
});

t('country_only carries no relocation cost, since no city is known yet', () => {
  const r = gate0(at('United States'), relocCfg, new Date('2026-08-12T00:00:00Z'));
  assert.ok(!r.flags.some((f) => f.startsWith('relocation_cost')));
});

t('a hub city inside a country string still resolves as the hub', () => {
  const r = gate0(at('London, United Kingdom'), relocCfg);
  assert.equal(r.pass, true);
  assert.ok(r.flags.some((f) => f.startsWith('location_tier:tier_1')));
  assert.ok(!r.flags.some((f) => f.startsWith('country_only:')));
});

t('country strings do not pass while relocation is off', () => {
  const off = { ...relocCfg, location: { ...relocCfg.location, accept_relocation: false } };
  assert.equal(gate0(at('United States'), off).pass, false);
});

t('stay_until works when YAML hands it over as a Date, not a string', () => {
  // js-yaml parses an unquoted 2027-01-01 into a Date. Interpolating that into
  // a template produced Invalid Date, and every comparison against Invalid Date
  // is false, so relocation_cost fired on 0 real rows while the string-based
  // tests all passed. Both types must work.
  const asDateCfg = {
    ...relocCfg,
    location: { ...relocCfg.location, preference: { stay_until: new Date('2027-01-01T00:00:00Z') } },
  };
  const before = gate0(at('London, UK'), asDateCfg, new Date('2026-08-12T00:00:00Z'));
  assert.ok(before.flags.some((f) => f.startsWith('relocation_cost:')));
  const after = gate0(at('London, UK', FUTURE), asDateCfg, FUTURE);
  assert.ok(!after.flags.some((f) => f.startsWith('relocation_cost:')));
});

t('an unparseable stay_until does not fire the flag or throw', () => {
  const junk = {
    ...relocCfg,
    location: { ...relocCfg.location, preference: { stay_until: 'not-a-date' } },
  };
  const r = gate0(at('London, UK'), junk, new Date('2026-08-12T00:00:00Z'));
  assert.equal(r.pass, true);
  assert.ok(!r.flags.some((f) => f.startsWith('relocation_cost:')));
});

t('remote with an office signal is flagged remote_unverified', () => {
  for (const loc of [
    'Remote-Friendly (Travel-Required) | San Francisco, CA',
    'Remote-Friendly, United States',
    'Remote-Friendly (Travel Required) | New York, NY',
  ]) {
    const r = gate0(at(loc), relocCfg);
    assert.equal(r.pass, true, loc);
    assert.ok(r.flags.some((f) => f.startsWith('remote_unverified:')), loc);
  }
});

t('a remote string naming a hub city is flagged even without a signal word', () => {
  const r = gate0(at('London or Remote'), relocCfg);
  assert.equal(r.pass, true);
  assert.ok(r.flags.some((f) => f.startsWith('remote_unverified:')));
});

t('bare remote stays clean', () => {
  // The whole point of targeting. If these ever pick up a flag, blocking
  // coverage goes to 100% and the SHIP veto stops discriminating.
  for (const loc of ['Remote', 'Remote (US)', 'USA | Remote', 'US - Remote', 'Canada - Remote']) {
    const r = gate0(at(loc), relocCfg);
    assert.equal(r.pass, true, loc);
    assert.ok(!r.flags.some((f) => f.startsWith('remote_unverified:')), loc);
  }
});

t('a tier tag is informational and does not block SHIP', () => {
  // After stay_until, so relocation_cost is gone and the tier tag stands alone.
  const r = gate0(at('London, UK', FUTURE), relocCfg, FUTURE);
  assert.ok(r.flags.some((f) => f.startsWith('location_tier:')));
  assert.deepEqual(blockingFlags(r.flags).filter((f) => f.startsWith('location_tier:')), []);
});

t('the five blocking classes block', () => {
  assert.deepEqual(BLOCKING_FLAGS, [
    'relocation_cost:',
    'country_only:',
    'remote_unverified:',
    'comp:unknown',
    'posted:unknown',
  ]);
  for (const f of [
    'relocation_cost:prefers Phoenix, AZ until 2027-01-01',
    'country_only:United States, resolve the city before shipping',
    'remote_unverified:Remote-Friendly, confirm where the team sits',
    'comp:unknown, verify before spending a slot',
    'posted:unknown, ashby published no date, age unverifiable',
  ]) {
    assert.ok(isBlocked([f]), f);
  }
});

t('the relocation flag carries a plain date, not a stringified Date', () => {
  // D4. The flag interpolated the Date object itself, so every affected row in
  // data/queue.json read "until Thu Dec 31 2026 17:00:00 GMT-0700 (Mountain
  // Standard Time)". Behaviourally harmless — the flag still blocked — but it
  // reached two files on disk, and the test above never caught it because it
  // asserts on a hand-written literal rather than on real output. This one
  // reads what gate0 actually produced.
  const r = gate0(at('London, UK'), relocCfg, new Date('2026-08-16T12:00:00Z'));
  const flag = r.flags.find((f) => f.startsWith('relocation_cost:'));
  assert.ok(flag, `expected a relocation_cost flag, got ${JSON.stringify(r.flags)}`);
  assert.ok(flag.includes('until 2027-01-01,'), flag);
  assert.ok(!/GMT|\(.*Time\)|[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2}/.test(flag), `a Date leaked into the flag: ${flag}`);

  // The same string still blocks. The fix is cosmetic and must stay cosmetic.
  assert.equal(isBlocked([flag]), true);
});

t('informational flags do not block on their own', () => {
  for (const f of ['location_tier:tier_1 london', 'generalist_trap:ai developer', 'bureaucracy_signal:requisition']) {
    assert.equal(isBlocked([f]), false, f);
  }
});

t('one company with ten passing rows contributes only two', () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    job({ key: `monks-${i}`, company: 'Media.Monks', posted: `2026-08-${10 - i}` })
  );
  const out = capPerCompany(rank(rows, { conversational_ai: 0.3 }), 2);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.company === 'Media.Monks'));
});

t('the cap keeps the two best rows, not an arbitrary two', () => {
  const rows = [
    job({ key: 'a', company: 'Media.Monks', posted: '2026-08-01' }),
    job({ key: 'b', company: 'Media.Monks', posted: '2026-08-09' }),
    job({ key: 'c', company: 'Media.Monks', posted: '2026-08-05' }),
  ];
  const out = capPerCompany(rank(rows, { conversational_ai: 0.3 }), 2);
  assert.deepEqual(out.map((r) => r.key), ['b', 'c']);
});

t('the cap does not touch a company already under it', () => {
  const rows = [job({ key: 'solo', company: 'Sierra' })];
  assert.equal(capPerCompany(rows, 2).length, 1);
});

t('archetype weight ordering survives the cap across companies', () => {
  const weights = { conversational_ai: 0.3, agentic_startups: 0.25, frontier_labs: 0.05 };
  const rows = [
    ...Array.from({ length: 10 }, (_, i) =>
      job({ key: `lab-${i}`, company: 'BigLab', archetype: 'frontier_labs' })
    ),
    job({ key: 'sierra-1', company: 'Sierra', archetype: 'agentic_startups' }),
    job({ key: 'sierra-2', company: 'Sierra', archetype: 'agentic_startups' }),
    job({ key: 'hume-1', company: 'Hume AI', archetype: 'conversational_ai' }),
    job({ key: 'hume-2', company: 'Hume AI', archetype: 'conversational_ai' }),
  ];
  const out = capPerCompany(rank(rows, weights), 2);

  // Six rows survive: two each from three companies. The big board is not special.
  assert.equal(out.length, 6);
  assert.equal(out.filter((r) => r.company === 'BigLab').length, 2);

  // And they are still in descending weight order, which is the property the
  // cap must not break: heaviest archetype first, frontier labs last.
  assert.deepEqual(
    out.map((r) => r.archetype),
    ['conversational_ai', 'conversational_ai', 'agentic_startups', 'agentic_startups', 'frontier_labs', 'frontier_labs']
  );

  const w = out.map((r) => weights[r.archetype]);
  assert.deepEqual(w, [...w].sort((a, b) => b - a));
});

t('a flooding board cannot crowd out a lighter archetype entirely', () => {
  const weights = { conversational_ai: 0.3, frontier_labs: 0.05 };
  const rows = [
    ...Array.from({ length: 50 }, (_, i) =>
      job({ key: `flood-${i}`, company: 'Media.Monks', archetype: 'conversational_ai' })
    ),
    job({ key: 'lab-1', company: 'BigLab', archetype: 'frontier_labs' }),
  ];
  // Buffer of 10. Before the cap the flood took all ten slots.
  const buffer = capPerCompany(rank(rows, weights), 2).slice(0, 10);
  assert.equal(buffer.filter((r) => r.company === 'Media.Monks').length, 2);
  assert.ok(buffer.some((r) => r.company === 'BigLab'));
});

// ---------------------------------------------------------------------------
// Fit term. Added 2026-08-12 after measuring that rank() had no fit key at all
// and ordered every row inside an archetype tier by posted date alone.
// ---------------------------------------------------------------------------

// gates.example.yaml title_weights used below: 3 for "model evaluation",
// "evals", "persona", "conversational ai", "alignment"; 2 for "agent",
// "solutions engineer", "forward deployed"; 1 for "voice", "abuse",
// "integrity". Floor is 130000.
const W = { conversational_ai: 0.3, agentic_startups: 0.25, frontier_labs: 0.05 };

t('fit takes the highest single title_weights match', () => {
  assert.equal(fitScore(job({ title: 'Voice Operations Coordinator', flags: [] }), cfg), 1);
  assert.equal(fitScore(job({ title: 'Agent Engineer', flags: [] }), cfg), 2);
  assert.equal(fitScore(job({ title: 'Model Evaluation Lead', flags: [] }), cfg), 3);
});

t('fit never sums matches, however many the title carries', () => {
  // Three weak-to-adjacent phrases in one title. Highest is `agent` at 2.
  const stuffed = fitScore(job({ title: 'Voice Agent Integrity Abuse Analyst', flags: [] }), cfg);
  assert.equal(stuffed, 2);
  // And a single precise phrase still beats it.
  assert.ok(fitScore(job({ title: 'Evals Engineer', flags: [] }), cfg) > stuffed);
});

t('a precise single-phrase title outranks a title with two weak tokens', () => {
  const out = rank(
    [
      // Two weak tokens (`voice` 1 + `agent` 2), posted today, with a band.
      job({
        key: 'stuffed',
        title: 'Senior Product Marketing Manager, Voice Agent',
        posted: '2026-08-12',
        comp: { min: 150000, max: 190000 },
        flags: [],
      }),
      // One precise phrase (`model evaluation` 3), older, same band shape.
      job({
        key: 'precise',
        title: 'Senior Software Engineer - Model Evaluation & AI Systems',
        posted: '2026-07-28',
        comp: { min: 180000, max: 240000 },
        flags: [],
      }),
    ],
    W,
    cfg
  );
  assert.equal(out[0].key, 'precise');
  // This is the Deepgram pair from the 2026-08-12 rebuild, where the old
  // token-counting fit put the marketing row first.
  assert.equal(fitScore(out[0], cfg), 4);
  assert.equal(fitScore(out[1], cfg), 3);
});

t('a published band above the floor is worth exactly one point', () => {
  const base = { title: 'Agent Engineer', flags: [] };
  assert.equal(fitScore(job({ ...base, comp: null }), cfg), 2);
  assert.equal(fitScore(job({ ...base, comp: { min: 140000, max: 190000 } }), cfg), 3);
});

t('the comp bonus is binary, so fit can never sort by salary', () => {
  const base = { title: 'Agent Engineer', flags: [] };
  const modest = fitScore(job({ ...base, comp: { min: 131000, max: 135000 } }), cfg);
  const huge = fitScore(job({ ...base, comp: { min: 400000, max: 900000 } }), cfg);
  assert.equal(modest, huge);
});

t('a band whose ceiling is below the floor earns nothing', () => {
  const r = fitScore(job({ title: 'Agent Engineer', flags: [], comp: { min: 90000, max: 110000 } }), cfg);
  assert.equal(r, 2);
});

t('each blocking flag costs a point, and comp:unknown is not double-charged', () => {
  const base = { title: 'Agent Engineer', comp: null };
  assert.equal(fitScore(job({ ...base, flags: [] }), cfg), 2);
  assert.equal(fitScore(job({ ...base, flags: ['relocation_cost:London'] }), cfg), 1);
  assert.equal(
    fitScore(job({ ...base, flags: ['relocation_cost:London', 'country_only:UK'] }), cfg),
    0
  );
  // comp:unknown is already priced by the absent comp bonus. Charging it again
  // would make compensation a two-point swing on a three-point scale.
  assert.equal(fitScore(job({ ...base, flags: ['comp:unknown, verify'] }), cfg), 2);
});

t('informational flags do not cost anything', () => {
  const r = fitScore(
    job({ title: 'Agent Engineer', comp: null, flags: ['location_tier:tier_1 London'] }),
    cfg
  );
  assert.equal(r, 2);
});

t('a better-fitting title outranks a weaker one posted more recently', () => {
  const out = rank(
    [
      job({ key: 'fresh-thin', title: 'Agent Engineer', posted: '2026-08-11', flags: [] }),
      job({ key: 'stale-rich', title: 'Conversational AI Designer', posted: '2026-04-15', flags: [] }),
    ],
    W,
    cfg
  );
  assert.equal(out[0].key, 'stale-rich');
});

t('a clean row outranks a flagged row of equal fit', () => {
  const out = rank(
    [
      job({ key: 'flagged', title: 'Agent Engineer', posted: '2026-08-11', flags: ['relocation_cost:London'] }),
      job({ key: 'clean', title: 'Agent Engineer', posted: '2026-08-11', flags: [] }),
    ],
    W,
    cfg
  );
  assert.equal(out[0].key, 'clean');
});

t('at equal fit the heavier archetype still wins', () => {
  const out = rank(
    [
      job({ key: 'light', company: 'BigLab', archetype: 'frontier_labs', title: 'Agent Engineer', flags: [] }),
      job({ key: 'heavy', company: 'Small', archetype: 'conversational_ai', title: 'Agent Engineer', flags: [] }),
    ],
    W,
    cfg
  );
  assert.equal(out[0].key, 'heavy');
});

t('a strong fit in a light archetype beats a zero fit in a heavy one', () => {
  // The Sesame / Gray Swan pair, measured 2026-08-12. Under the old strict-tier
  // sort the hardware PM took a buffer slot and the red team role did not.
  const out = rank(
    [
      job({
        key: 'sesame-hardware',
        company: 'Sesame',
        archetype: 'conversational_ai',
        title: 'Product Manager, Hardware',
        posted: '2026-08-12',
        comp: { min: 175000, max: 280000 },
        flags: ['relocation_cost:San Francisco'],
      }),
      job({
        key: 'grayswan-redteam',
        company: 'Gray Swan AI',
        archetype: 'red_team_boutiques',
        title: 'Red Team Engineer',
        posted: '2026-01-01',
        comp: { min: 180000, max: 240000 },
        flags: [],
      }),
    ],
    { ...W, red_team_boutiques: 0.15 },
    cfg
  );
  assert.equal(out[0].key, 'grayswan-redteam');
  // 0.15*10 + 4 = 5.5  beats  0.30*10 + 0 = 3.0
  assert.equal(compositeScore(out[0], { ...W, red_team_boutiques: 0.15 }, cfg), 5.5);
  assert.equal(compositeScore(out[1], { ...W, red_team_boutiques: 0.15 }, cfg), 3);
});

t('the multiplier keeps weight worth less than the fit spread', () => {
  // A one-step weight gap must be crossable by one fit point, or the ladder is
  // a tier again under another name.
  const w = { conversational_ai: 0.3, agentic_startups: 0.25 };
  const heavyZero = compositeScore(job({ archetype: 'conversational_ai', fit: 0 }), w);
  const lightOne = compositeScore(job({ archetype: 'agentic_startups', fit: 1 }), w);
  assert.ok(lightOne > heavyZero);
});

t('the archetype floor seats every archetype that has a candidate', () => {
  const rows = rank(
    [
      ...Array.from({ length: 12 }, (_, i) =>
        job({ key: `convo-${i}`, company: `C${i}`, archetype: 'conversational_ai', title: 'Persona Engineer', flags: [] })
      ),
      job({ key: 'red-1', company: 'Gray Swan AI', archetype: 'red_team_boutiques', title: 'Red Team Engineer', flags: [] }),
      job({ key: 'infra-1', company: 'Modal', archetype: 'infrastructure', title: 'Solutions Engineer', flags: [] }),
    ],
    { ...W, red_team_boutiques: 0.15, infrastructure: 0.1 },
    cfg
  );
  const out = archetypeFloor(rows, 10);
  assert.equal(out.length, 10);
  assert.ok(out.some((r) => r.key === 'red-1'), 'red team must be seated');
  assert.ok(out.some((r) => r.key === 'infra-1'), 'infrastructure must be seated');
  // And the heavy archetype still takes every remaining slot.
  assert.equal(out.filter((r) => r.archetype === 'conversational_ai').length, 8);
});

t('the floor never seats a second row before the score does', () => {
  const rows = rank(
    [
      job({ key: 'a', company: 'A', archetype: 'conversational_ai', title: 'Persona Engineer', flags: [] }),
      job({ key: 'b', company: 'B', archetype: 'conversational_ai', title: 'Agent Engineer', flags: [] }),
      job({ key: 'c', company: 'C', archetype: 'frontier_labs', title: 'Agent Engineer', flags: [] }),
    ],
    W,
    cfg
  );
  const out = archetypeFloor(rows, 2);
  // One slot each: the best conversational row and the only frontier row.
  assert.deepEqual(out.map((r) => r.key).sort(), ['a', 'c']);
});

t('recency still breaks ties at equal weight and equal fit', () => {
  const out = rank(
    [
      job({ key: 'older', title: 'Agent Engineer', posted: '2026-01-01', flags: [] }),
      job({ key: 'newer', title: 'Agent Engineer', posted: '2026-08-01', flags: [] }),
    ],
    W,
    cfg
  );
  assert.equal(out[0].key, 'newer');
});

t('rank without cfg degrades to weight then recency rather than throwing', () => {
  const out = rank(
    [
      job({ key: 'older', title: 'Conversational AI Agent Designer', posted: '2026-01-01' }),
      job({ key: 'newer', title: 'Agent Engineer', posted: '2026-08-01' }),
    ],
    W
  );
  assert.equal(out[0].key, 'newer');
});

t('the cap now keeps the two best-fitting rows, not the two most recent', () => {
  const rows = [
    job({ key: 'clone-a', company: 'Sierra', archetype: 'agentic_startups', title: 'Software Engineer, Agent (Dutch speaking)', posted: '2026-06-10', flags: [] }),
    job({ key: 'clone-b', company: 'Sierra', archetype: 'agentic_startups', title: 'Software Engineer, Agent (Korean speaking)', posted: '2026-06-09', flags: [] }),
    job({ key: 'real', company: 'Sierra', archetype: 'agentic_startups', title: 'Conversational AI Agent, Persona', posted: '2026-04-15', flags: [] }),
  ];
  const out = capPerCompany(rank(rows, W, cfg), 2);
  assert.ok(out.some((r) => r.key === 'real'), 'the well-fitting April row must survive the cap');
  assert.equal(out[0].key, 'real');
});

// Freshness. Measured 2026-08-13 on 3,479 live rows: this rule is the largest
// single kill class Gate 0 has, so it gets tested at both edges rather than in
// the middle where an off-by-one cannot show.
const NOW = new Date('2026-08-13T12:00:00Z');

t('a posting older than the limit dies', () => {
  const r = gate0(job({ posted: '2026-01-01' }), cfg, NOW);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => x.startsWith('stale:')));
});

t('the reason names the date, the age, and the limit it broke', () => {
  const r = gate0(job({ posted: '2026-01-01' }), cfg, NOW);
  const reason = r.reasons.find((x) => x.startsWith('stale:'));
  assert.match(reason, /2026-01-01/);
  assert.match(reason, /224 days old/);
  assert.match(reason, /limit 90/);
});

t('exactly at the limit still passes, one day past it does not', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  at.setUTCDate(at.getUTCDate() + 90);
  const past = new Date(at.getTime() + 86400000 + 1000);
  assert.equal(gate0(job({ posted: '2026-01-01' }), cfg, at).pass, true, '90 days is not stale');
  assert.equal(gate0(job({ posted: '2026-01-01' }), cfg, past).pass, false, '91 days is');
});

t('a full ISO timestamp parses, so board rows are not all read as undated', () => {
  // The trap asDate() fell into on stay_until: appending T00:00:00Z to a string
  // that already carries a time yields Invalid Date, and every comparison
  // against Invalid Date is false, so the gate silently never fires.
  assert.equal(ageInDays('2026-08-03T17:04:22.000Z', NOW), 9);
  assert.equal(gate0(job({ posted: '2025-02-11T09:12:00Z' }), cfg, NOW).pass, false);
});

t('a date in the future is not stale', () => {
  assert.equal(ageInDays('2026-09-01', NOW), -19);
  assert.equal(gate0(job({ posted: '2026-09-01' }), cfg, NOW).pass, true);
});

t('max_age_days 0 turns the rule off rather than killing everything', () => {
  const off = { ...cfg, freshness: { max_age_days: 0 } };
  assert.equal(gate0(job({ posted: '2019-01-01' }), off, NOW).pass, true);
});

t('the limit is configurable and the default is 90', () => {
  const tight = { ...cfg, freshness: { max_age_days: 30 } };
  assert.equal(MAX_AGE_DAYS, 90);
  assert.equal(gate0(job({ posted: '2026-07-01' }), cfg, NOW).pass, true);
  assert.equal(gate0(job({ posted: '2026-07-01' }), tight, NOW).pass, false);
});

t('a config with no freshness block still gets the 90 day default', () => {
  const bare = { ...cfg };
  delete bare.freshness;
  assert.equal(gate0(job({ posted: '2026-01-01' }), bare, NOW).pass, false);
});

t('a missing date flags rather than kills, and names the board', () => {
  const r = gate0(job({ posted: null, source: 'ashby' }), cfg, NOW);
  assert.equal(r.pass, true, 'a missing record is not evidence of an old posting');
  const flag = r.flags.find((f) => f.startsWith('posted:unknown'));
  assert.ok(flag, 'P5: the missing record has to be named');
  assert.match(flag, /ashby/);
});

t('an unparseable date is treated as missing, not as age zero', () => {
  assert.equal(ageInDays('not a date', NOW), null);
  assert.equal(ageInDays('', NOW), null);
  const r = gate0(job({ posted: 'sometime last spring' }), cfg, NOW);
  assert.equal(r.pass, true);
  assert.ok(r.flags.some((f) => f.startsWith('posted:unknown')));
});

t('posted:unknown blocks SHIP', () => {
  assert.ok(BLOCKING_FLAGS.includes('posted:unknown'));
  assert.equal(isBlocked(gate0(job({ posted: null }), cfg, NOW).flags), true);
});

t('posted:unknown costs no fit point, so an undated board is not sorted last', () => {
  const dated = job({ title: 'Model Evaluation Engineer', flags: ['comp:unknown'] });
  const undated = job({ title: 'Model Evaluation Engineer', flags: ['comp:unknown', 'posted:unknown, ashby published no date'] });
  assert.equal(fitScore(undated, cfg), fitScore(dated, cfg));
});

t('a stale row is killed even when everything else about it is perfect', () => {
  // The shape of the 392-day ElevenLabs row measured 2026-08-13, which cleared
  // every other gate. Its actual title was Deployment Strategist, which the
  // example config scores but does not list as a target family, so the sibling
  // forward-deployed title stands in.
  const r = gate0(
    job({
      title: 'Forward Deployed Engineer - North America',
      location: 'Remote',
      comp: { min: 180000, max: 260000 },
      posted: '2025-07-17',
    }),
    cfg,
    NOW
  );
  assert.equal(r.pass, false);
  assert.deepEqual(r.reasons.map((x) => x.split(':')[0]), ['stale']);
});

// ---------------------------------------------------------------------------
// Repost detection
//
// Method 8 in the reference asks for the one observable that is a company's own
// dated record that a fix did not take. The tests below are about the two ways
// this rule can be wrong: missing a real repost because the id changed, and
// inventing one out of an ordinary re-scan.
// ---------------------------------------------------------------------------

t('titles normalize to a canonical form, and no further', () => {
  assert.equal(normalizeTitle('Senior SWE, Model Evaluation'), 'senior swe model evaluation');
  assert.equal(normalizeTitle('  Senior   SWE — Model   Evaluation  '), 'senior swe model evaluation');
  assert.equal(normalizeTitle('Zürich Support Lead'), 'zurich support lead');
  // Seniority is NOT stripped. Two rungs are two seats, and merging them would
  // invent reposts that never happened.
  assert.notEqual(normalizeTitle('Senior Engineer'), normalizeTitle('Engineer'));
});

t('the repost key is company plus title, so two companies never collide', () => {
  assert.notEqual(repostKey('Deepgram', 'Engineer'), repostKey('Decagon', 'Engineer'));
  assert.equal(repostKey('Character.AI', 'TPM, Alignment'), repostKey('character ai', 'tpm alignment'));
});

t('an unseen title is not a repost, it is a first sighting', () => {
  assert.equal(repostFlag(job({ key: 'a:1', title: 'Senior Conversational AI Engineer' }), {}), null);
});

t('the same posting id seen again is a dedupe, never a repost', () => {
  // This is the ordinary case: every scan re-reads every open req. Flagging it
  // would fire on the whole board every run, which is the same as not having a
  // rule. Old enough to qualify on age, so only the id check can save it.
  const index = updateRepostIndex({}, [job({ key: 'a:1' })], daysAgo(200));
  assert.equal(repostFlag(job({ key: 'a:1' }), index), null);
});

t('a new posting id for an old title is a repost, and it names the first-seen date', () => {
  const first = daysAgo(120);
  const index = updateRepostIndex({}, [job({ key: 'ashby:Deepgram:aaa', company: 'Deepgram' })], first);
  const flag = repostFlag(job({ key: 'ashby:Deepgram:bbb', company: 'Deepgram' }), index);

  assert.ok(flag, 'a new id on a title first seen 120 days ago is the whole point of the rule');
  assert.ok(flag.startsWith(`repost:detected:first_seen_${first}`), flag);
  assert.ok(flag.includes('posting id 2'), flag);
  assert.ok(flag.includes('120 days'), flag);
});

t('a new id on a title first seen recently is not yet evidence of anything', () => {
  // Below the threshold a new id is more likely an edit, a duplicate posting, or
  // a second seat than a failed hire. P3: a limit nobody has reached.
  const index = updateRepostIndex({}, [job({ key: 'a:1' })], daysAgo(REPOST_MIN_AGE_DAYS - 1));
  assert.equal(repostFlag(job({ key: 'a:2' }), index), null);

  const older = updateRepostIndex({}, [job({ key: 'a:1' })], daysAgo(REPOST_MIN_AGE_DAYS + 1));
  assert.ok(repostFlag(job({ key: 'a:2' }), older));
});

t('the threshold is configurable per call', () => {
  const index = updateRepostIndex({}, [job({ key: 'a:1' })], daysAgo(30));
  assert.equal(repostFlag(job({ key: 'a:2' }), index), null);
  assert.ok(repostFlag(job({ key: 'a:2' }), index, { minAgeDays: 20 }));
});

t('a third posting counts the ids it has actually seen', () => {
  const first = daysAgo(300);
  let index = updateRepostIndex({}, [job({ key: 'a:1' })], first);
  index = updateRepostIndex(index, [job({ key: 'a:2' })], daysAgo(150));
  const flag = repostFlag(job({ key: 'a:3' }), index);
  assert.ok(flag.includes('posting id 3'), flag);
  assert.equal(index[repostKey('Test', job().title)].ids.length, 2);
});

t('the index keeps first_seen and moves last_seen', () => {
  const first = daysAgo(90);
  let index = updateRepostIndex({}, [job({ key: 'a:1' })], first);
  index = updateRepostIndex(index, [job({ key: 'a:2' })], '2026-08-15');
  const entry = index[repostKey('Test', job().title)];

  assert.equal(entry.first_seen, first, 'first_seen is the whole value of the index and must never move');
  assert.equal(entry.last_seen, '2026-08-15');
  assert.deepEqual(entry.ids, ['a:1', 'a:2']);
  assert.equal(entry.company, 'Test');
});

t('updateRepostIndex does not mutate what it was given', () => {
  const index = updateRepostIndex({}, [job({ key: 'a:1' })], daysAgo(90));
  const before = JSON.stringify(index);
  updateRepostIndex(index, [job({ key: 'a:2' })], '2026-08-15');
  assert.equal(JSON.stringify(index), before, 'a pure function that edits its input will corrupt the file on disk');
});

t('a repost flag is informational and can never veto Gate 0', () => {
  // The rule that matters. A repost is evidence FOR spending a slot, so blocking
  // on it would veto exactly the rows it exists to promote. Same class as
  // location_tier:, which fired on 91% of rows when it was briefly a veto.
  const index = updateRepostIndex({}, [job({ key: 'a:1' })], daysAgo(200));
  const flag = repostFlag(job({ key: 'a:2' }), index);

  assert.ok(!BLOCKING_FLAGS.some((p) => flag.startsWith(p)), 'repost: must not appear in BLOCKING_FLAGS');
  assert.deepEqual(blockingFlags([flag]), []);
  assert.equal(isBlocked([flag]), false);
});

t('a repost flag costs no fit point', () => {
  const index = updateRepostIndex({}, [job({ key: 'a:1' })], daysAgo(200));
  const flag = repostFlag(job({ key: 'a:2' }), index);
  const row = { ...job(), comp: { min: 200000, max: 240000 } };
  assert.equal(fitScore({ ...row, flags: [flag] }, cfg), fitScore({ ...row, flags: [] }, cfg));
});

t('a reposted row still passes Gate 0 on its own merits, and a bad one still fails', () => {
  // The flag rides alongside gate0's verdict and changes nothing about it.
  const index = updateRepostIndex({}, [job({ key: 'a:1' })], daysAgo(200));
  const good = job({ key: 'a:2' });
  const g = gate0(good, cfg);
  assert.equal(g.pass, true);

  // Adding the flag must not change what blocks. Asserting isBlocked is false
  // outright would test the fixture instead: job() publishes no band, so
  // comp:unknown blocks it whether or not a repost was ever detected.
  const withRepost = [...g.flags, repostFlag(good, index)];
  assert.deepEqual(blockingFlags(withRepost), blockingFlags(g.flags));

  // A repost of a role that fails on title is still killed. The flag is not a
  // back door around Gate 0.
  const bad = job({ key: 'a:2', title: 'Chief Financial Officer' });
  assert.equal(gate0(bad, cfg).pass, false);
});

t('two companies reposting the same title do not contaminate each other', () => {
  const index = updateRepostIndex({}, [job({ key: 'x:1', company: 'Deepgram' })], daysAgo(200));
  assert.equal(repostFlag(job({ key: 'y:1', company: 'Decagon' }), index), null);
  assert.ok(repostFlag(job({ key: 'x:2', company: 'Deepgram' }), index));
});

t('an index entry with no usable first_seen flags nothing', () => {
  // P5 rather than a guess. A corrupt or hand-edited entry must not be read as
  // an infinitely old title, which would flag every new id on that board.
  assert.equal(repostFlag(job({ key: 'a:2' }), { [repostKey('Test', job().title)]: { first_seen: null, ids: ['a:1'] } }), null);
  assert.equal(repostFlag(job({ key: 'a:2' }), { [repostKey('Test', job().title)]: { first_seen: 'not a date', ids: ['a:1'] } }), null);
});

console.log(`\n${pass} passing`);
