// Gate 0. Deterministic filtering.
//
// Everything here is a rule a regex can settle. Nothing here requires judgment,
// which is the point: the model's attention is the bottleneck resource, so it
// never spends a token on a decision a string match can make.
//
// Gate 0 kills rows. It never ranks them. Ranking is allocation weight, applied
// after gating, in scan.js.

import { extractCompFromText } from './sources.js';

const has = (hay, needle) => hay.includes(needle.toLowerCase());

export function gate0(job, cfg, now = new Date()) {
  const hay = `${job.title} ${job.description}`.toLowerCase();
  const title = job.title.toLowerCase();
  const reasons = [];
  const flags = [];

  // 1. Seniority. Wrong rung is a hard no in both directions.
  const rejectSeniority = (cfg.seniority?.reject || []).find((t) => has(title, t));
  if (rejectSeniority) reasons.push(`seniority:${rejectSeniority}`);

  // 2. Title relevance. Gracian aphorism 85: refuse to be the wild card.
  const titleHit = (cfg.target_titles || []).some((t) => has(title, t));
  if (!titleHit) reasons.push('title:no target family match');

  // 3. Hard disqualifiers.
  for (const [group, phrases] of Object.entries(cfg.hard_disqualifiers || {})) {
    const hit = phrases.find((p) => has(hay, p));
    if (hit) reasons.push(`${group}:${hit}`);
  }

  // 4. Location.
  if (!locationOk(job.location, cfg)) reasons.push(`location:${job.location}`);

  // 5. Compensation floor. Missing data is missing data, per P5.
  const comp = job.comp || extractCompFromText(job.description);
  const floor = cfg.compensation?.floor_usd ?? 0;
  if (comp) {
    const ceiling = comp.max ?? comp.min;
    if (cfg.compensation?.reject_if_max_below_floor && ceiling && ceiling < floor) {
      reasons.push(`comp:max ${ceiling} below floor ${floor}`);
    }
  } else if (cfg.compensation?.on_missing_data === 'reject') {
    reasons.push('comp:no band published');
  } else {
    flags.push('comp:unknown, verify before spending a slot');
  }

  // Soft flags travel with the row. They inform the diagnostician, they do not kill.
  for (const [group, phrases] of Object.entries(cfg.soft_flags || {})) {
    const hit = phrases.find((p) => has(hay, p));
    if (hit) flags.push(`${group}:${hit}`);
  }
  flags.push(...locationFlags(job.location, cfg, now));

  return { pass: reasons.length === 0, reasons, flags, comp };
}

// Recognized relocation destinations, flattened out of the tiered hub list.
// Tier travels with the city because a tier 3 dark horse is not equivalent to
// San Francisco and should not be silently promoted to it.
export function acceptedHubs(cfg) {
  const out = [];
  for (const [tier, cities] of Object.entries(cfg.location?.hubs || {})) {
    for (const c of cities || []) out.push({ tier, city: String(c) });
  }
  return out;
}

// Diacritics and punctuation are stripped before matching. Measured 2026-08-12:
// postings write "Zürich", not "Zurich", so an unnormalized token matched zero
// rows while its two rows were rejected. Normalizing kills that class of defect
// generally instead of one accent at a time. It does NOT fix local names that
// are different words, like Bengaluru for Bangalore. Those need their own token.
const canon = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function matchHub(loc, cfg) {
  const l = canon(loc);
  return acceptedHubs(cfg).find((h) => l.includes(canon(h.city))) || null;
}

// A location that names a country or region but no city. Matched on the WHOLE
// string, not as a substring: "United States" passes, "Omaha, NE, United
// States" must not, or the country list would become a back door around the
// hub list.
function matchCountryOnly(loc, cfg) {
  const l = canon(loc);
  if (!l) return null;
  return (cfg.location?.accept_country_only || []).find((c) => canon(c) === l) || null;
}

const isRemote = (l) => /remote|distributed|anywhere/.test(l);

// stay_until arrives as a Date when js-yaml parses an unquoted 2027-01-01, and
// as a string when it is quoted or passed from a test. Interpolating a Date
// into `${v}T00:00:00Z` yields Invalid Date, and every comparison against
// Invalid Date is false, so the relocation_cost flag silently never fired.
// Measured 2026-08-12: 0 rows flagged when roughly 2400 should have been.
function asDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A remote label that also carries an office expectation. "Remote-Friendly
// (Travel-Required) | San Francisco, CA" is remote in name and onsite in fact,
// and nothing downstream would catch it if the row passed clean.
function remoteOfficeSignal(loc, cfg) {
  const raw = String(loc || '');
  const signals = cfg.location?.remote_office_signals || [];
  const hit = signals.find((s) => canon(raw).includes(canon(s)));
  if (hit) return hit;
  // Or the string names a city alongside the remote label.
  const hub = matchHub(raw, cfg);
  if (hub) return hub.city;
  return null;
}

// Flags split into two classes. A tier tag is metadata: nothing about a London
// role needs a human decision, so it must not veto SHIP. Only a flag naming
// something genuinely unresolved blocks. The list is explicit rather than
// "any flag" so the blocking set is auditable in one place, and
// .claude/agents/diagnostician.md reads its SHIP rule from here.
export const BLOCKING_FLAGS = [
  'relocation_cost:', // location is known but carries a cost before stay_until
  'country_only:', // no city named yet
  'remote_unverified:', // remote label with an office signal attached
  'comp:unknown', // no published band
];

export function blockingFlags(flags = []) {
  return flags.filter((f) => BLOCKING_FLAGS.some((p) => String(f).startsWith(p)));
}

export const isBlocked = (flags = []) => blockingFlags(flags).length > 0;

// One rule, decided on the city alone. Work modes are recorded in gates.yaml as
// documentation of intent and are deliberately NOT read here: almost no posting
// puts "hybrid" in its location string, so a mode filter would be pattern
// matching on absent data and calling the guess a gate.
function locationOk(loc, cfg) {
  const l = (loc || '').toLowerCase();
  if (!l) return true; // absent location is not evidence of a bad one

  const base = canon((cfg.location?.base || '').split(',')[0]);
  if (isRemote(l)) return true;
  if (base && canon(l).includes(base)) return true;

  // Relocation off returns the gate to base-plus-remote. Relocation on makes the
  // hub list the allowlist, which is the only thing standing between the drum
  // and every onsite role on earth.
  if (!cfg.location?.accept_relocation) return false;
  if (matchHub(l, cfg)) return true;

  // A country-level string is a rejection on vagueness, not on geography.
  // "United States" is not a place the gate can rule on, so it passes carrying
  // a location:country_only flag. Unresolved Gate 0 flags are a SHIP veto in
  // .claude/agents/diagnostician.md, so the diagnostician must resolve the real
  // location before a packet goes out. That judgment belongs there, not here.
  return Boolean(matchCountryOnly(l, cfg));
}

// Location cost never kills a row. Before location.preference.stay_until a
// relocation-required role carries a real cost, and the diagnostician is who
// should price it, not a regex at the front door.
function locationFlags(loc, cfg, now) {
  const l = (loc || '').toLowerCase();
  if (!l) return [];

  // Remote. Bare remote passes clean and stays clean: it is a settled fact and
  // flagging all of it would push blocking coverage to 100% and stop the SHIP
  // veto discriminating at all. Only remote with an office signal is flagged.
  if (isRemote(l)) {
    const signal = remoteOfficeSignal(loc, cfg);
    return signal
      ? [`remote_unverified:${loc}, remote label with "${signal}" attached, confirm where the team sits`]
      : [];
  }

  const base = canon((cfg.location?.base || '').split(',')[0]);
  if (base && canon(l).includes(base)) return [];

  const hub = matchHub(l, cfg);
  if (!hub) {
    const country = matchCountryOnly(l, cfg);
    // No relocation_cost here: a country-only string does not yet say whether
    // relocation is required. Resolve the city first, then price it.
    return country ? [`country_only:${country}, resolve the city before shipping`] : [];
  }

  // Informational. Does not block SHIP.
  const flags = [`location_tier:${hub.tier} ${hub.city}`];
  const until = asDate(cfg.location?.preference?.stay_until);
  if (until && now < until) {
    flags.push(
      `relocation_cost:prefers ${cfg.location.base} until ${until}, price this in the diagnosis`
    );
  }
  return flags;
}

// Allocation weight, then recency. Never prestige.
export function rank(jobs, archetypeWeights) {
  return [...jobs].sort((a, b) => {
    const wa = archetypeWeights[a.archetype] ?? 0;
    const wb = archetypeWeights[b.archetype] ?? 0;
    if (wb !== wa) return wb - wa;
    return String(b.posted || '').localeCompare(String(a.posted || ''));
  });
}

// Per-company cap. Ranking alone cannot stop one large board from filling the
// whole buffer: a parent-company token like greenhouse/monks publishes hundreds
// of rows, and a flat slice off the top would hand every drum slot to one
// employer. That is inventory in front of the bottleneck wearing a diverse hat.
//
// Runs after rank() and before promotion. Input order is preserved, so the
// weight ordering rank() established survives untouched.
export function capPerCompany(jobs, max = 2) {
  const taken = new Map();
  return jobs.filter((j) => {
    const n = taken.get(j.company) || 0;
    if (n >= max) return false;
    taken.set(j.company, n + 1);
    return true;
  });
}
