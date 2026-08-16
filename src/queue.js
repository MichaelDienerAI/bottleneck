// Buffer mechanics for a human decision: strike a row, backfill its slot.
//
// The scan promotes rows and liveness delists them. Neither is a judgment. This
// module is the third case — Michael reads a row and says no — and it is the
// only path in the system where a queue row leaves the buffer because a person
// decided it should.
//
// WHY A STRIKE IS NOT A KILL AND NOT A DELISTING. Gate 0 kills on a rule and
// writes data/killed.json. Liveness delists on a board's own record and writes
// data/delisted.json. A strike has no rule and no external record behind it, so
// it needs its own log or the removal is invisible: a row that vanished from the
// buffer with nothing on disk explaining why is exactly the kind of unexplained
// state this repo refuses everywhere else.
//
// WHAT A STRIKE IS NOT. It is not a verdict on the company. A company can hold
// two rows in the buffer, and striking one says nothing about the other. Nothing
// here touches a case file. Closing a company is the diagnostician's call, spent
// from the drum and audited, and a checkbox on a web page is not that.
//
// Every function here is pure. The server does the reading and writing.

// Remove one row by board key. Returns the new queue and the row that left, so
// the caller can log what it removed rather than reconstructing it afterward.
export function strikeRow(queue = [], key) {
  const struck = queue.find((r) => r.key === key) || null;
  return {
    queue: struck ? queue.filter((r) => r.key !== key) : [...queue],
    struck,
  };
}

// The audit record. Carries enough to reconstruct the decision months later
// without re-fetching the board, the same reason data/killed.json carries an
// excerpt and its reasons.
export function strikeRecord(row, { at, reason = null, source = 'dashboard' } = {}) {
  return {
    key: row.key,
    company: row.company,
    title: row.title,
    url: row.url ?? null,
    archetype: row.archetype ?? null,
    score: row.score ?? null,
    flags: row.flags ?? [],
    struck_at: at,
    reason,
    source,
  };
}

// Rows that could take a vacated slot, in the order they should take it.
//
// Input must already be ranked — data/candidates.json is written by rank(), so
// its file order IS the composite order. Same contract archetypeFloor() states.
//
// Five exclusions, each of which would otherwise reintroduce a decision the
// system already made:
//
//   in the queue    it is already in front of the drum
//   struck          a row Michael declined must never return on its own
//   delisted        the board took it down
//   closed case     the company is DEAD, SHIPPED, or cooling
//   company cap     one employer must not take the buffer, cap enforced against
//                   the queue AFTER the strike, not before
export function eligibleBackfill(candidates = [], opts = {}) {
  const {
    queue = [],
    struckKeys = new Set(),
    delistedKeys = new Set(),
    isClosed = () => false,
    maxPerCompany = 2,
  } = opts;

  const inQueue = new Set(queue.map((r) => r.key));
  const perCompany = new Map();
  for (const r of queue) perCompany.set(r.company, (perCompany.get(r.company) || 0) + 1);

  return candidates.filter((c) => {
    if (!c || !c.key) return false;
    if (inQueue.has(c.key)) return false;
    if (struckKeys.has(c.key)) return false;
    if (delistedKeys.has(c.key)) return false;
    if (isClosed(c.company)) return false;
    return (perCompany.get(c.company) || 0) < maxPerCompany;
  });
}

// One replacement, or null when the bench is empty.
//
// Two preferences, in this order.
//
// FIRST, a company other than the one just struck. Measured against the live
// buffer on 2026-08-16: striking OpenAI's alignment row backfilled a different
// OpenAI row, because the strike left frontier_labs unrepresented and OpenAI
// held the best frontier_labs candidate. That is correct by the floor rule and
// useless to read — the most common reason to strike a row is that the work or
// the employer is wrong, and answering it with the same employer reads as the
// system arguing. Rows from the struck company go to the back, not out: if it
// holds the only candidate for an unrepresented archetype, it still wins, and
// losing the archetype would cost more than the repetition does.
//
// SECOND, an archetype with no row in the buffer, over a higher-scoring row
// from one already represented. That is archetypeFloor() applied a row at a
// time: the weights describe how a week's effort should spread, and refilling
// gaps with more of what the buffer already holds narrows it on every strike.
//
// When neither preference applies, the ranked order decides.
export function pickBackfill(candidates = [], opts = {}) {
  const eligible = eligibleBackfill(candidates, opts);
  if (!eligible.length) return null;

  const avoid = opts.avoidCompany ?? null;
  const ordered = avoid
    ? [...eligible.filter((c) => c.company !== avoid), ...eligible.filter((c) => c.company === avoid)]
    : eligible;

  const present = new Set((opts.queue || []).map((r) => r.archetype).filter(Boolean));
  return ordered.find((c) => c.archetype && !present.has(c.archetype)) || ordered[0];
}
