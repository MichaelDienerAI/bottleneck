// Liveness. Is this requisition still open, today, on the company's own board.
//
// Gate 0's freshness rule reads the date the board publishes. That catches a req
// that is old. It cannot catch a req that is recent and already closed, and it
// cannot catch a row sitting in the buffer from a scan three weeks ago that has
// since come down. Those are the ones that waste a slot, because they look fine.
//
// TWO SIGNALS, AND THEY ARE NOT THE SAME STRENGTH:
//
// 1. FEED MEMBERSHIP is the authoritative one. The ATS endpoints in sources.js
//    publish the currently-open reqs and nothing else, so a key that was on the
//    board last scan and is absent from this one has been taken down. This is
//    free — the scan already fetched every board — and it is the check that
//    actually matters. Nothing else in this file outranks it.
//
// 2. THE URL CHECK is weak evidence and is treated as weak. An HTTP 200 on a
//    posting URL proves the link resolves. It does NOT prove the req is open:
//    Greenhouse serves a closed job's URL as a redirect to the board index with
//    a 200, and Ashby serves an empty client-rendered shell with a 200. So the
//    only verdict this file draws a conclusion from is 404/410, which is
//    unambiguous. Everything else is recorded with its status code and left for
//    a human. Inferring "closed" from body text would be pattern matching on
//    absent data and calling the guess a gate, which is the failure mode
//    locationOk() in gates.js already refuses.
//
// Nothing here reads a page's HTML. Nothing here touches LinkedIn.

const UA = 'constraint-search/0.1 (personal job search)';

// The two statuses that mean the posting is gone rather than merely unreachable.
export const GONE_STATUSES = new Set([404, 410]);

// Rows that were in the buffer and are no longer on their board.
//
// `verifiable` exists because absence is only evidence when the fetch succeeded.
// A board that 500'd this run publishes an empty set, and treating that as "every
// req at that company closed" would delete a whole company's buffer rows on a
// transient error. P4: a dated record has to show both halves before the
// conclusion is drawn.
export function delisted(rows, liveKeys, verifiable) {
  return rows.filter((r) => verifiable.has(r.company) && !liveKeys.has(r.key));
}

// Rows whose company could not be fetched this run. They stay in the buffer and
// keep whatever verified_live_at they already had, so the staleness of the
// confirmation is visible instead of being refreshed by a run that confirmed
// nothing.
export function unverifiable(rows, verifiable) {
  return rows.filter((r) => !verifiable.has(r.company));
}

// One posting URL. Returns a verdict and the status that produced it, never a
// bare boolean: "unreachable, ETIMEDOUT" and "gone, 410" are different findings
// and the buffer should be able to tell them apart six weeks later.
export async function checkUrl(url, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  if (!url) return { verdict: 'unchecked', status: null, note: 'no url on the row' };
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (GONE_STATUSES.has(res.status)) return { verdict: 'gone', status: res.status };
    // Deliberately not called "live". The link resolved. See the note above.
    if (res.ok) return { verdict: 'reachable', status: res.status };
    return { verdict: 'unreachable', status: res.status };
  } catch (e) {
    return { verdict: 'unreachable', status: null, note: e.message };
  }
}

// Buffer-sized only. The buffer is capped at ten rows, so this is ten requests
// against endpoints the scan already talks to. Running it over the full 3,479-row
// board would be several thousand requests per scan for a signal weaker than the
// feed membership check that is already free, which is why it is not offered.
export async function checkUrls(rows, opts = {}) {
  return Promise.all(
    rows.map(async (r) => ({ key: r.key, url: r.url, ...(await checkUrl(r.url, opts)) }))
  );
}
