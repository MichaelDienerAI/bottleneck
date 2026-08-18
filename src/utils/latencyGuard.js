// Verification latency, tested rather than accepted.
//
// Ibn al-Haytham's rule is that a claim gets checked against controlled
// observation before it is believed, including — especially — your own. Every
// evidence row in this repository declares verify_seconds, the time a stranger
// needs to check it, and until now that number was accepted exactly as written.
// Nothing ever went and looked.
//
//   npm run verify-trace <company>
//
// WHAT A FETCH CAN AND CANNOT SETTLE, MEASURED RATHER THAN ASSUMED.
//
// On 2026-08-17 a GET to https://github.com/character-ai/judgejudy returned in
// 0.77s. The corpus rows citing that repository declare 8s and 20s. So a naive
// "flag anything more than 3x off the fetch time" would flag every row in the
// corpus, on every run, and mean nothing: fetch time is time-to-response, and
// verify_seconds is time-to-satisfied-stranger, which includes finding the number
// on the page and judging it. Those are different quantities and one is not an
// estimate of the other.
//
// A fetch is a FLOOR. It settles two things and no others:
//
//   UNREACHABLE   the trace cannot be inspected at all. The strongest finding
//                 here and the one worth the network call: a citation nobody can
//                 open is not evidence, whatever verify_seconds it declares.
//   IMPOSSIBLE    declared is below the floor. You cannot verify a page in less
//                 time than the page takes to arrive.
//
// And the 3x factor lands where it carries information — on the tight side.
// Claiming to open, read, and judge a page in under three times its response
// time is a claim about reading speed, not about latency, and it is usually a
// number someone estimated rather than measured.
//
// Over-declaration proves nothing. A row declaring 30s on a page that responds
// in 0.2s may be entirely honest about a dense page. This module says so instead
// of manufacturing a finding out of it.

const UA = 'constraint-search/0.1 (personal job search)';

export const DEFAULT_FACTOR = 3;

// Reuses the two statuses liveness.js already treats as conclusive. Everything
// else is recorded with its code and left for a human, for the same reason: a
// 500 is a bad afternoon, not a dead citation.
const GONE = new Set([404, 410]);

export async function measureTrace(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  if (!url) return { url: null, status: null, seconds: null, verdict: 'no-url' };
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const seconds = (Date.now() - started) / 1000;
    if (GONE.has(res.status)) return { url, status: res.status, seconds, verdict: 'gone' };
    if (res.ok) return { url, status: res.status, seconds, verdict: 'reachable' };
    return { url, status: res.status, seconds, verdict: 'unreachable' };
  } catch (e) {
    return { url, status: null, seconds: (Date.now() - started) / 1000, verdict: 'unreachable', note: e.message };
  }
}

// Pure. Takes a row and a measurement and returns the finding. No network here,
// so the rule is testable without one.
export function calibrate(row, measurement, { factor = DEFAULT_FACTOR } = {}) {
  const declared = row?.verify_seconds;
  const m = measurement || {};

  if (!Number.isInteger(declared)) {
    return { state: 'undeclared', ok: false, message: 'verify_seconds is missing or not a whole number of seconds.' };
  }

  if (m.verdict === 'no-url') {
    return { state: 'unchecked', ok: true, message: 'no inspectable_at on this row; nothing to time.' };
  }

  // A negative observation. Some claims are proved by an absence: "the
  // repository publishes no .github directory" is established by a 404 at that
  // path, and the first run of this tool over the corpus reported exactly that
  // row as a dead citation. Declaring the expected status converts the negative
  // observation from a broken link into a checkable one. It is not a way to
  // excuse a citation that rotted — the status has to match what was declared.
  if (Number.isInteger(row?.expected_status)) {
    if (m.status === row.expected_status) {
      return {
        state: 'confirmed-absence',
        ok: true,
        floor: m.seconds ?? null,
        message: `returned the declared ${row.expected_status}. The absence is the finding, and it is still there.`,
      };
    }
    return {
      state: 'unreachable',
      ok: false,
      message:
        `declares expected_status ${row.expected_status} and returned ${m.status ?? m.note ?? 'no response'}. ` +
        'The absence this row rests on is no longer the state of the world, or the citation moved.',
    };
  }

  if (m.verdict === 'gone' || m.verdict === 'unreachable') {
    return {
      state: 'unreachable',
      ok: false,
      message:
        `the trace could not be inspected (${m.status ?? m.note ?? 'no response'}). ` +
        'A citation a stranger cannot open is not evidence, whatever time it declares.',
    };
  }

  const floor = m.seconds ?? 0;
  const ratio = floor > 0 ? declared / floor : null;

  if (declared < floor) {
    return {
      state: 'impossible',
      ok: false,
      floor,
      ratio,
      message: `declares ${declared}s but the page took ${floor.toFixed(2)}s to respond. Verification cannot precede arrival.`,
    };
  }

  if (declared < floor * factor) {
    return {
      state: 'tight',
      ok: true,
      floor,
      ratio,
      message:
        `declares ${declared}s against a ${floor.toFixed(2)}s response, inside ${factor}x of the floor. ` +
        'That is a claim about reading speed rather than about latency; check it was measured and not estimated.',
    };
  }

  return {
    state: 'plausible',
    ok: true,
    floor,
    ratio,
    message: `declares ${declared}s against a ${floor.toFixed(2)}s floor. Consistent, which is not the same as correct.`,
  };
}

// Rows in, findings out. Concurrency is bounded because a diagnosis carries
// about a dozen rows and firing them all at once at one host is rude.
export async function calibrateRows(rows = [], opts = {}) {
  const out = [];
  for (const row of rows) {
    const m = await measureTrace(row?.inspectable_at, opts);
    out.push({ row, measurement: m, finding: calibrate(row, m, opts) });
  }
  return out;
}

export function summarize(results) {
  const bad = results.filter((r) => !r.finding.ok);
  return {
    total: results.length,
    unreachable: results.filter((r) => r.finding.state === 'unreachable').length,
    impossible: results.filter((r) => r.finding.state === 'impossible').length,
    tight: results.filter((r) => r.finding.state === 'tight').length,
    failing: bad.length,
    ok: bad.length === 0,
  };
}
