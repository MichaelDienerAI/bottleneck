// Gate 0 is the only part of this system that can be tested without a network
// or a model. Test it, because it decides what the bottleneck resource ever sees.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import assert from 'node:assert';
import { gate0, rank, capPerCompany, blockingFlags, isBlocked, BLOCKING_FLAGS } from './gates.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = yaml.load(fs.readFileSync(path.join(ROOT, 'profile/gates.example.yaml'), 'utf8'));

const job = (over = {}) => ({
  key: 'x',
  company: 'Test',
  archetype: 'conversational_ai',
  title: 'Senior Conversational AI Engineer',
  location: 'Remote (US)',
  description: 'Build voice agents. Own behavioral specs.',
  posted: '2026-08-01',
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
const at = (loc) => job({ location: loc });

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
  const r = gate0(at('London, UK'), relocCfg, new Date('2027-02-01T00:00:00Z'));
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
  const after = gate0(at('London, UK'), asDateCfg, new Date('2027-02-01T00:00:00Z'));
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
  const r = gate0(at('London, UK'), relocCfg, new Date('2027-02-01T00:00:00Z'));
  assert.ok(r.flags.some((f) => f.startsWith('location_tier:')));
  assert.deepEqual(blockingFlags(r.flags).filter((f) => f.startsWith('location_tier:')), []);
});

t('the four blocking classes block', () => {
  assert.deepEqual(BLOCKING_FLAGS, [
    'relocation_cost:',
    'country_only:',
    'remote_unverified:',
    'comp:unknown',
  ]);
  for (const f of [
    'relocation_cost:prefers Phoenix, AZ until 2027-01-01',
    'country_only:United States, resolve the city before shipping',
    'remote_unverified:Remote-Friendly, confirm where the team sits',
    'comp:unknown, verify before spending a slot',
  ]) {
    assert.ok(isBlocked([f]), f);
  }
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

console.log(`\n${pass} passing`);
