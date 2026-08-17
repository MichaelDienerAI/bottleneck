// Freshness audit. Does the buffer in front of the drum still deserve to be there?
//
// The scan enforces every deduplication rule at the moment it promotes a row.
// Nothing re-enforces them afterward, and the rules are not static: a company
// gets diagnosed and parked on Sunday, and the row promoted on Saturday is still
// sitting in the buffer on Monday pointing at a company the scan would now
// refuse. Measured on the live buffer on 2026-08-17: three of ten rows, two
// Character.AI and one Decagon, both cooling until 2026-09-14. Gate 0 cannot
// catch these, liveness cannot catch these, and the next scan will not either,
// because held rows are carried forward without being re-gated.
//
//   node src/scan.js --audit-freshness            purge and backfill
//   node src/scan.js --audit-freshness --dry-run  report only
//
// WHAT COUNTS AS A VIOLATION, AND WHAT EMPHATICALLY DOES NOT.
//
// data/seen.json is not a violation rule and cannot be made into one. scan.js
// writes every promoted key into seen.json in the same run that promotes it, so
// every row in the buffer is in seen.json by construction: all ten, today.
// seen.json answers "has this posting id been fetched before," which gates
// PROMOTION so a row already declined does not reappear. It says nothing about
// whether a row already in front of the drum belongs there. Reading it as a
// residency rule would empty the buffer on the first run and read as a
// deduplication triumph while doing it.
//
// The four rules that do apply to a row already in the buffer:
//
//   struck        Michael declined it by hand. It must never come back on its own.
//   delisted      the board took the posting down.
//   closed case   the company is DEAD, SHIPPED, or cooling. shouldSkip decides,
//                 not this file, so the audit and the scan cannot disagree.
//   duplicate     the same key twice in one buffer, which is a write bug.
//
// The per-company cap is reported and never purged on. Two rows from one company
// is the configured maximum, not a fault, and a cap breach means the promotion
// path is broken; silently deleting the evidence would hide the bug that caused it.
//
// Every function here is pure. The caller reads and writes.

import { pickBackfill } from './queue.js';

export const RULES = {
  struck: 'struck by hand from the dashboard',
  delisted: 'the board took this posting down',
  closed: 'the company is closed or cooling',
  duplicate: 'the same key appears twice in the buffer',
};

// Why a single row should not be in the buffer, or an empty list.
//
// ctx.isClosed returns shouldSkip()'s own shape, { skip, reason }, so the reason
// printed here is the reason the scan would give.
export function rowViolations(row, ctx = {}) {
  const {
    struckKeys = new Set(),
    delistedKeys = new Set(),
    isClosed = () => ({ skip: false }),
    duplicateKeys = new Set(),
  } = ctx;
  const out = [];

  if (struckKeys.has(row.key)) out.push({ rule: 'struck', detail: RULES.struck });
  if (delistedKeys.has(row.key)) out.push({ rule: 'delisted', detail: RULES.delisted });

  const closed = isClosed(row.company) || {};
  if (closed.skip) out.push({ rule: 'closed', detail: closed.reason || RULES.closed });

  if (duplicateKeys.has(row.key)) out.push({ rule: 'duplicate', detail: RULES.duplicate });

  return out;
}

// Two visits that surfaced no evidence key the file did not already hold. Same
// rule as noProgress() in casefile.js, applied here to report rather than to
// close a company. A row whose company is in that state is not fresh: the drum
// would spend a slot re-reading a record that has already stopped yielding.
export function repeatVisitsWithoutEvidence(file) {
  const visits = file?.visits || [];
  if (visits.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < visits.length; i++) {
    const known = new Set(visits[i - 1].evidence_keys || []);
    const fresh = (visits[i].evidence_keys || []).filter((k) => !known.has(k));
    if (!fresh.length) n++;
  }
  return n;
}

const duplicatesIn = (queue) => {
  const count = new Map();
  for (const r of queue) count.set(r.key, (count.get(r.key) || 0) + 1);
  return new Set([...count.entries()].filter(([, n]) => n > 1).map(([k]) => k));
};

// One verdict per buffer row, in buffer order.
export function auditQueue(queue = [], ctx = {}) {
  const duplicateKeys = duplicatesIn(queue);
  const caseFor = ctx.caseFor || (() => null);

  return queue.map((row) => {
    const violations = rowViolations(row, { ...ctx, duplicateKeys });
    const file = caseFor(row.company);
    const repeats = repeatVisitsWithoutEvidence(file);
    return {
      key: row.key,
      company: row.company,
      title: String(row.title || '').trim(),
      archetype: row.archetype || null,
      score: row.score ?? null,
      visits: file?.visits?.length ?? 0,
      status: file?.status ?? null,
      repeatVisits: repeats,
      violations,
      // Fresh means: no rule against it, and no history of a visit that added
      // nothing. A company seen once and parked is still fresh; the park is the
      // thing that closes it, and that is the `closed` rule above.
      fresh: violations.length === 0 && repeats === 0,
    };
  });
}

// Purge every violating row, then refill from the bench one slot at a time.
//
// One at a time, and re-deriving eligibility each time, because pickBackfill
// weighs the buffer as it stands: the per-company cap and the unrepresented
// archetype preference both read the queue, and picking three replacements
// against one stale snapshot can take three rows from the same employer or
// three from an archetype the first pick already covered.
//
// avoidCompany is the company just purged, so the slot a cooling company vacated
// is not handed straight back to it.
export function purgeAndBackfill(queue = [], candidates = [], ctx = {}) {
  const audited = auditQueue(queue, ctx);
  const bad = new Set(audited.filter((a) => a.violations.length).map((a) => a.key));
  if (!bad.size) return { queue: [...queue], purged: [], backfilled: [], audited };

  const purged = queue.filter((r) => bad.has(r.key));
  let next = queue.filter((r) => !bad.has(r.key));
  const backfilled = [];

  for (const gone of purged) {
    const pick = pickBackfill(candidates, {
      queue: next,
      struckKeys: ctx.struckKeys,
      delistedKeys: ctx.delistedKeys,
      // pickBackfill wants a boolean; shouldSkip returns a record.
      isClosed: (company) => Boolean((ctx.isClosed?.(company) || {}).skip),
      maxPerCompany: ctx.maxPerCompany ?? 2,
      avoidCompany: gone.company,
    });
    if (!pick) break;
    next = [...next, pick];
    backfilled.push({ ...pick, backfilled_for: gone.key, backfilled_reason: `replaces ${gone.company}` });
  }

  return { queue: next, purged, backfilled, audited };
}

// What the history files actually hold. Counted, not estimated, and each number
// is the length of a file a person can open.
export function historyCounts({ seen = [], candidates = [], killed = [], delisted = [], struck = [], cases = [] } = {}) {
  return {
    seen: seen.length,
    candidates: candidates.length,
    killed: killed.length,
    delisted: delisted.length,
    struck: struck.length,
    cases: cases.length,
    visits: cases.reduce((n, f) => n + (f.visits?.length || 0), 0),
  };
}

// Rows on the current board that promotion will never look at again, because
// their key is already in seen.json. This is the deduplication working, and it
// is the number that shows how much of the board is history rather than supply.
export function blockedBySeen(candidates = [], seenKeys = new Set(), queue = []) {
  const inQueue = new Set(queue.map((r) => r.key));
  return candidates.filter((c) => seenKeys.has(c.key) && !inQueue.has(c.key));
}
