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

// Two haystacks, and the split between them is load-bearing.
//
// `hay` is title plus description. `title` is the title alone. Seniority and
// target_titles read `title` only. hard_disqualifiers and soft_flags read `hay`.
// Nothing enforces this; it is a property of which variable each rule happens to
// pass to has(), and it is easy to undo by accident.
//
// Why it matters, measured 2026-08-12: nine synonym tokens were added to
// target_titles, including bare `voice` and `abuse`. The predicted failure was
// that those words appear constantly in the body text of audio-company postings
// and would admit hundreds of irrelevant rows. They admitted 9 and 5. The gate
// held because target_titles never sees the description. Widen it to `hay` and
// the title gate stops discriminating at all.
//
// The cost of that choice, stated plainly so it is a decision and not an
// oversight: a posting titled "Software Engineer" whose body is entirely
// persona-evaluation work can never pass Gate 0. The title gate cannot see it,
// and no later stage re-reads killed rows. That row is lost silently. This is
// accepted, not fixed: the alternative admits far more noise than it recovers
// signal, and Gate 0 exists to protect the drum, not to be exhaustive. Revisit
// only with a kill-log audit showing the missed class is large enough to pay
// for the noise.
// Default staleness limit in days, overridable with freshness.max_age_days in
// gates.yaml. Set the config value to 0 to turn the rule off entirely.
export const MAX_AGE_DAYS = 90;

// Posting dates arrive in two shapes and both have to parse: a bare `2026-08-01`
// from a test or a hand-written fixture, and a full ISO timestamp from the
// boards. asDate() below cannot be reused for this — it appends `T00:00:00Z`
// unconditionally, which turns a full timestamp into Invalid Date, and every
// comparison against Invalid Date is false, which is how the relocation_cost
// flag silently never fired before 2026-08-12. Same defect, one field over.
function postedDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Whole days since the posting date. null means the board published no usable
// date, which is a missing record and not an age of zero. Future dates return a
// negative age and are never stale.
export function ageInDays(posted, now = new Date()) {
  const d = postedDate(posted);
  if (!d) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86400000);
}

export function gate0(job, cfg, now = new Date()) {
  const hay = `${job.title} ${job.description}`.toLowerCase(); // title + body
  const title = job.title.toLowerCase(); // title ONLY — see note above
  const reasons = [];
  const flags = [];

  // 1. Seniority. Wrong rung is a hard no in both directions.
  const rejectSeniority = (cfg.seniority?.reject || []).find((t) => has(title, t));
  if (rejectSeniority) reasons.push(`seniority:${rejectSeniority}`);

  // 2. Title relevance. Gracian aphorism 85: refuse to be the wild card.
  // Reads `title`, never `hay`. That is deliberate. See the note above gate0().
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

  // 6. Freshness. A requisition that has sat untouched for months is inventory
  // on the employer's side of the transaction, and a packet aimed at it lands on
  // a req that is filled, frozen, or forgotten. The date is the only age evidence
  // the boards publish, so it is the only one this gate rules on.
  //
  // WHAT `posted` ACTUALLY MEANS, because it is not the same fact per source and
  // the gate treats all three identically:
  //   greenhouse  updated_at   last edit of any kind, so this reads "untouched for N days"
  //   lever       createdAt    true first-publication date
  //   ashby       publishedAt  true publication date
  // Greenhouse is therefore the loosest of the three: a recruiter re-saving a
  // year-old req resets its clock. That is a false negative the gate accepts. It
  // does not produce false positives, which is what would cost a slot.
  //
  // Measured against the live boards 2026-08-13, 3,479 rows fetched: age p50 22
  // days, p75 83, p90 202, max 1,303. At a 90-day limit the gate-0 pool drops
  // from 425 rows to 254. That is 171 rows and it is meant to be that many —
  // among them ElevenLabs "Deployment Strategist - North America" at 392 days,
  // which had been sitting in the candidate pool eligible for a slot. Ashby
  // carries almost all of it (789 stale rows of 2,357); greenhouse shows 22 of
  // 1,114, which is the updated_at semantics above, not a fresher employer.
  //
  // Every one of those 3,479 rows carried a parseable date, so the posted:unknown
  // branch below is currently unexercised in production. It exists because a
  // board that stops publishing dates must not silently become a board with no
  // freshness gate.
  const maxAgeDays = cfg.freshness?.max_age_days ?? MAX_AGE_DAYS;
  const age = ageInDays(job.posted, now);
  if (age === null) {
    // P5: name the missing record rather than guessing at the age. Blocking, so
    // the diagnostician confirms the req is open before a slot is spent on it.
    flags.push(
      `posted:unknown, ${job.source || 'the board'} published no date, age unverifiable`
    );
  } else if (maxAgeDays && age > maxAgeDays) {
    reasons.push(
      `stale:posted ${String(job.posted).slice(0, 10)}, ${age} days old, limit ${maxAgeDays}`
    );
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
  'posted:unknown', // no date published, so the freshness gate could not rule
];
// `repost:detected:` is deliberately absent from that list, the same way
// `location_tier:` is. A repost is evidence FOR spending a slot — the company
// tried to fill the seat and could not — so blocking on it would veto the rows
// it is meant to promote. It also carries a known false-positive class (two real
// seats sharing a title), and a veto that can fire on a coincidence is a veto
// that gets routed around. It informs the diagnostician and decides nothing.

// Blocking flags that do NOT cost a fit point. Both name something the BOARD
// failed to publish, not something about the role, so charging fit for them
// would sort against whole ATS sources at once. comp:unknown is also already
// priced at zero by the comp term, and charging it twice would make a missing
// band a two-point swing against a token range of about one to three.
const FIT_EXEMPT_FLAGS = ['comp:unknown', 'posted:unknown'];

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

// ---------------------------------------------------------------------------
// Repost detection
// ---------------------------------------------------------------------------
//
// Method 8 in .claude/references/bottleneck-detection.md, tier B, and it asks for
// a record the code could not produce: "A role posted three times in nine months
// means they cannot fill it or cannot keep it. Either way the constraint is
// confirmed rather than hypothesized, because it survived their attempt to
// relieve it. Track your own scan history and the same key will resurface."
//
// It will not resurface. data/seen.json is a flat set of board ids with no dates,
// and a reposted requisition usually gets a NEW id, so key equality can never
// fire on one. Catching a repost needs a different index: (company, normalized
// title) with a first-seen date. That is what this pair of functions maintains.
//
// WHY THIS IS THE STRONGEST CHEAP OBSERVABLE. Nearly everything else readable
// from outside is a company describing itself. A repost is the company's own
// dated record that a fix did not take, which is both halves of a P4 causal
// claim without an inference in between.
//
// FALSE POSITIVE CLASS, stated rather than discovered later: two genuinely
// different requisitions sharing a normalized title read as a repost. A large
// board with three open "Software Engineer" seats will trip it. That is why the
// flag is informational and never a veto — it hands the diagnostician a question,
// not a verdict, and the question is cheap to settle by opening both postings.
//
// WHAT IT CANNOT SEE. A repost that was retitled. Normalization is canonical
// form only: case, accents, punctuation, whitespace. Seniority words are left
// alone deliberately, because "Senior Engineer" and "Engineer" are two seats and
// merging them would invent reposts that never happened.
export const REPOST_MIN_AGE_DAYS = 60;

export const normalizeTitle = (t) => canon(t);
export const repostKey = (company, title) => `${canon(company)}::${normalizeTitle(title)}`;

// Read against the index as it stood BEFORE this run folded today's ids into it.
// Check after the update and every id is already present, so nothing is ever new.
export function repostFlag(job, index = {}, { minAgeDays = REPOST_MIN_AGE_DAYS, now = new Date() } = {}) {
  const entry = index?.[repostKey(job.company, job.title)];
  if (!entry) return null; // never seen this title. today is its first_seen
  const ids = entry.ids || [];
  if (ids.includes(job.key)) return null; // same requisition, still up. not a repost
  const age = ageInDays(entry.first_seen, now);
  if (age === null || age <= minAgeDays) return null; // too recent to mean anything
  return (
    `repost:detected:first_seen_${entry.first_seen}, posting id ${ids.length + 1} for this title, ` +
    `${age} days since first seen`
  );
}

// Fold this run's rows into the index. Pure: returns a new object.
//
// Every fetched row updates it, not just the ones that pass Gate 0. The index is
// scan history, not gate history, and a title that keeps getting killed on
// seniority is still a title the company keeps reposting.
//
// Entries are never pruned. The whole value is the first_seen date, and a
// pruning rule would delete exactly the old entries the rule exists to read.
// Growth is bounded by distinct requisitions, not by run count.
export function updateRepostIndex(index = {}, jobs = [], today) {
  const next = { ...index };
  for (const j of jobs) {
    const k = repostKey(j.company, j.title);
    const prev = next[k];
    if (!prev) {
      next[k] = { company: j.company, title: j.title, first_seen: today, last_seen: today, ids: [j.key] };
      continue;
    }
    next[k] = {
      ...prev,
      last_seen: today,
      ids: prev.ids.includes(j.key) ? prev.ids : [...prev.ids, j.key],
    };
  }
  return next;
}

// Fit. The middle sort key, and the fix for a defect measured 2026-08-12.
//
// rank() was archetype weight, then posted date, then nothing. Inside a tier a
// posting's only merit was freshness. Measured consequences: Sierra's Product
// Manager, Voice ($230-390K, a voice PM at a voice-agent company) sat at rank
// 147 of 424, behind roughly thirty fresher rows from its own board including
// five localization variants of "Software Engineer, Agent (<language> speaking)".
// Deepgram's Model Evaluation role, the cleanest row in the pool, lost its slot
// by twenty-four hours to a product marketing role.
//
// Deterministic by construction. Every term is a count a regex can settle,
// because the model's attention is the bottleneck resource and must never be
// spent ordering a list.
//
// SCALE DISCIPLINE, the thing to check if this ever misbehaves:
//
//   title    0..3   the HIGHEST SINGLE cfg.title_weights phrase in the title
//   comp     0 or 1 BINARY. A published band whose ceiling clears the floor.
//   penalty  -1 ea. per unresolved blocking flag.
//
// The title term reads title_weights, NOT target_titles. Those are separate
// lists doing separate jobs: target_titles filters, title_weights scores. The
// first version of this function counted target_titles matches, which measured
// string overlap rather than fit. "Senior PMM, Voice Agent" scored 2 because the
// gate list happened to contain both `voice` and `agent` as separate entries,
// while "Senior SWE, Model Evaluation & AI Systems" scored 1, and product
// marketing took a Deepgram slot from the cleanest eval row in the pool.
//
// Highest single match, never the sum. Summing rewards long titles and long
// titles are a marketing artifact. A role either names the work or it does not.
//
// The comp term is binary on purpose. It is worth exactly one point whether the
// band is $131K or $500K, so it can act as a tiebreaker between equally-fitting
// rows and can NEVER sort the buffer by salary. Fit is whether a sovereign proof
// acts on the role; a high band on the wrong work is still the wrong work.
//
// FIT_EXEMPT_FLAGS are excluded from the penalty: comp:unknown, because the
// comp term already prices a missing band at zero and charging it twice would
// make compensation a two-point swing against a token range of about one to
// three; posted:unknown, because a board that omits dates omits them for every
// row it publishes, so the penalty would reorder the buffer by ATS vendor rather
// than by fit. Both are still blocking, so neither can ship unresolved.
export function fitScore(job, cfg) {
  const title = String(job.title || '').toLowerCase();

  // max, not sum. An absent title_weights block scores every row 0 rather than
  // silently falling back to counting, because falling back would reintroduce
  // the exact defect this replaced.
  let best = 0;
  for (const [phrase, points] of Object.entries(cfg.title_weights || {})) {
    if (has(title, phrase) && points > best) best = points;
  }

  const floor = cfg.compensation?.floor_usd ?? 0;
  const ceiling = job.comp ? job.comp.max ?? job.comp.min : null;
  const compBonus = ceiling && ceiling > floor ? 1 : 0;

  const penalty = blockingFlags(job.flags || []).filter(
    (f) => !FIT_EXEMPT_FLAGS.some((p) => String(f).startsWith(p))
  ).length;

  return best + compBonus - penalty;
}

// Archetype weight biases allocation. It does not decide the order by itself.
//
// It used to. rank() sorted weight first as a strict lexicographic key, so a
// 0.15 difference was absolute and no amount of fit could cross it. Measured
// 2026-08-12, that produced exactly the capture it should have prevented:
//
//   IN  buffer  fit 0  Sesame       Product Manager, Hardware   [w0.30]
//   OUT of it   fit 4  Gray Swan AI Red Team Engineer           [w0.15]
//
// A hardware PM scoring nothing sat in front of the drum while the single
// clearest match for the Deformation Test Bank in a 481-row pool did not, and
// nine of ten buffer rows came from one archetype. The weights were written as
// effort allocation across a week. Used as a sort key they stopped allocating
// and started excluding.
//
// One composite number instead: weight * 10 + fit.
//
// WHY 10. The weight ladder spans 0.05 to 0.30, so at x10 it spans 2.5 points
// against an observed fit spread of about 5 (-1 to 4 in the live pool). Weight
// therefore carries roughly half the authority of fit: enough to keep a heavier
// archetype ahead at equal fit, not enough to hold a zero above a four. The
// resulting ladder, in fit points needed to overtake conversational_ai:
// agentic_startups 1, red_team_boutiques 2, infrastructure 3, frontier_labs 3.
// At x20 the weight spread reaches 5 and the tier recaptures the sort. At x5 it
// falls to 1.25 and a single fit point erases the whole ladder, making weight
// decorative. Every weight lands on an exact binary half at x10, so there is no
// float-comparison hazard.
export const WEIGHT_MULTIPLIER = 10;

export function compositeScore(job, archetypeWeights, cfg = null, multiplier = WEIGHT_MULTIPLIER) {
  const w = archetypeWeights[job.archetype] ?? 0;
  const fit = cfg ? fitScore(job, cfg) : job.fit ?? 0;
  return w * multiplier + fit;
}

// Composite score, then recency. cfg is optional; omitted, fit falls back to a
// precomputed j.fit and then to 0, so weight alone still orders the list rather
// than throwing.
export function rank(jobs, archetypeWeights, cfg = null) {
  const cache = new Map();
  const scoreOf = (j) => {
    if (!cache.has(j)) cache.set(j, compositeScore(j, archetypeWeights, cfg));
    return cache.get(j);
  };
  return [...jobs].sort((a, b) => {
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    if (sb !== sa) return sb - sa;
    return String(b.posted || '').localeCompare(String(a.posted || ''));
  });
}

// Per-archetype floor. Every archetype with a passing candidate gets at least
// one row in the buffer before the remaining slots go by score.
//
// Composite scoring alone does not guarantee this. A heavy archetype with many
// good rows can still take every slot, which is capture wearing a fairer hat.
// The weights say how a week's effort should be spread; a buffer that is nine
// tenths one archetype is not spreading it. Input must already be ranked. Order
// is not preserved: callers re-rank the selection for display.
export function archetypeFloor(ranked, limit, perArchetype = 1) {
  const taken = new Map();
  const floor = [];
  for (const j of ranked) {
    if (floor.length >= limit) break;
    const n = taken.get(j.archetype) || 0;
    if (n < perArchetype) {
      taken.set(j.archetype, n + 1);
      floor.push(j);
    }
  }
  const claimed = new Set(floor);
  const out = [...floor];
  for (const j of ranked) {
    if (out.length >= limit) break;
    if (!claimed.has(j)) out.push(j);
  }
  return out;
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
