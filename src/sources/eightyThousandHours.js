// 80,000 Hours job board.
//
// Not an ATS. The other three fetchers each read one company's own board; this
// reads an aggregator carrying ~850 roles across hundreds of employers, which is
// a different kind of source and worth saying out loud: CLAUDE.md's operating
// rule is that candidate volume is a non-bottleneck and adding to it creates
// inventory. What keeps this from being inventory is the rope. `scan.js` promotes
// at most `min(buffer_max, slots + 5)` rows however many it fetched, so a new
// source changes the COMPOSITION of the pool competing for those slots and never
// the number of slots. If that ever stops being true, this file is the first
// thing to delete.
//
// HOW THE ENDPOINT WAS FOUND, because a guessed URL is a fabrication. Three
// plausible REST paths were probed and all returned 404. The board at
// 80000hours.org/job-board/ 301s to jobs.80000hours.org, whose delivered HTML
// names backend.eawork.org and Algolia, and publishes its own search credentials:
//
//   algoliaApplicationId: "W6KM1UDIB3"
//   algoliaApiKey:        "d1d7f2c8696e7b36837d5ed337c4a319"
//   algoliaJobsIndex:     "jobs_prod"
//
// Those are Algolia SEARCH-ONLY keys, embedded in the page for exactly this
// purpose — client-side search cannot work without them being public. Reading a
// public board's public search index is the same category as the ATS endpoints
// in sources.js: published deliberately, no auth negotiated, no terms bent, and
// nothing resembling the LinkedIn scraping CLAUDE.md forbids outright. Verified
// live on 2026-08-18: 854 hits, record shape as mapped below.
//
// If the credentials rotate this file stops working and says so. It does not
// hunt for new ones.

const APP_ID = 'W6KM1UDIB3';
const SEARCH_KEY = 'd1d7f2c8696e7b36837d5ed337c4a319';
const INDEX = 'jobs_prod';
const UA = 'constraint-search/0.1 (personal job search)';

export const ENDPOINT = `https://${APP_ID}-dsn.algolia.net/1/indexes/${INDEX}/query`;
export const SOURCE = '80000hours';

// Matching liveness.js, which is the only other network caller with a policy:
// an explicit AbortSignal timeout rather than a hung socket, and a bounded number
// of attempts against one host. sources.js has neither, which is a gap recorded
// in the structural audit and not fixed here.
export const TIMEOUT_MS = 8000;
export const MAX_ATTEMPTS = 3;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The aggregator carries employers of every kind, and archetype drives both the
// per-archetype floor and the composite weight. A row whose archetype is not one
// of the six in profile/companies.yaml would rank against an undefined weight, so
// every row is mapped into an existing archetype or into the configured default.
// Coarse on purpose: this is a routing decision, not a judgment about the
// company, and the diagnostician re-decides it anyway.
const ARCHETYPE_RULES = [
  [/\b(red[- ]?team|adversarial|jailbreak|security)\b/i, 'red_team_boutiques'],
  [/\b(voice|speech|conversational|assistant|agent experience)\b/i, 'conversational_ai'],
  [/\b(agent|agentic|tool use|orchestration)\b/i, 'agentic_startups'],
  [/\b(infrastructure|platform|reliability|devops|kubernetes)\b/i, 'infrastructure'],
  [/\b(alignment|interpretability|frontier|safety research)\b/i, 'frontier_labs'],
  [/\b(design|product design|experience)\b/i, 'experiential_design'],
];

export function archetypeFor(hit, fallback = 'agentic_startups') {
  const text = [hit?.title, ...(hit?.tags_role_type || []), ...(hit?.tags_area || []), ...(hit?.tags_skill || [])]
    .filter(Boolean)
    .join(' ');
  for (const [re, archetype] of ARCHETYPE_RULES) if (re.test(text)) return archetype;
  return fallback;
}

const stripHtml = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// posted_at is unix seconds. gate0's freshness rule parses whatever string it is
// given, so this has to come out as a date it can read or every row flags
// posted:unknown and blocks.
const isoDate = (unixSeconds) => {
  if (!Number.isFinite(unixSeconds)) return null;
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// Number(null) is 0 and Number('') is 0, and both are finite. Coercing first
// turned a row with no published band into a band of $0 to $0, which gate0's
// compensation floor then reads as a published maximum below $130,000 and kills
// the row outright. The rule it would have broken is stated in gates.js and in
// sources.js both: absence of a band is absence of data, never evidence of a low
// offer. Check for the absence before coercing.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const salaryOf = (hit) => {
  const min = num(hit?.salary);
  const max = num(hit?.salary_limit);
  if (min == null && max == null) return null;
  return { min, max, currency: 'USD' };
};

// One hit into the shape every downstream stage already reads. The three extra
// fields the brief asked for — ats_kind, first_seen, role_title — are carried
// ADDITIVELY beside the canonical ones rather than replacing them: 43 call sites
// read `.title` and the whole pipeline keys on `.key` and `.source`, so a row
// that renamed them would pass Gate 0 and then break the buffer, the dashboard,
// the freshness audit and the blind packet.
export function normalizeHit(hit, { fallbackArchetype, fetched } = {}) {
  const company = String(hit?.company_name || hit?.company || '').trim();
  const id = hit?.post_pk ?? hit?.objectID ?? hit?.id_external_80_000_hours;
  const location = Array.isArray(hit?.card_locations)
    ? hit.card_locations.join(', ')
    : String(hit?.card_locations || (hit?.tags_country || []).join(', ') || '');

  return {
    key: `${SOURCE}:${company}:${id}`,
    source: SOURCE,
    company,
    archetype: archetypeFor(hit, fallbackArchetype),
    title: String(hit?.title || '').trim(),
    location,
    url: hit?.url_external || '',
    description: stripHtml(hit?.description || hit?.description_short || ''),
    posted: isoDate(hit?.posted_at),
    comp: salaryOf(hit),
    fetched,

    // Additive. Named as the brief specified, carried alongside rather than
    // instead of the canonical fields.
    ats_kind: SOURCE,
    role_title: String(hit?.title || '').trim(),
    first_seen: new Date().toISOString(),
    closes_at: isoDate(hit?.closes_at),
  };
}

// One page, with the timeout and the retry policy. Separated from the paging
// loop so a test can drive it with a mocked fetch and no clock.
export async function fetchPage({ page = 0, hitsPerPage = 100, query = '', fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxAttempts = MAX_ATTEMPTS, sleepImpl = sleep } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          'X-Algolia-Application-Id': APP_ID,
          'X-Algolia-API-Key': SEARCH_KEY,
          'Content-Type': 'application/json',
          'User-Agent': UA,
        },
        body: JSON.stringify({ params: `query=${encodeURIComponent(query)}&hitsPerPage=${hitsPerPage}&page=${page}` }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) return res.json();

      // A retry is only worth making when the failure is plausibly transient. A
      // 403 means the published key rotated, and hammering it three times
      // establishes nothing that the first response did not.
      if (!RETRY_STATUS.has(res.status)) {
        const e = new Error(`HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      lastError = new Error(`HTTP ${res.status}`);
      lastError.status = res.status;
    } catch (e) {
      lastError = e;
      if (e.status && !RETRY_STATUS.has(e.status)) throw e;
    }

    if (attempt < maxAttempts) await sleepImpl(250 * 2 ** (attempt - 1));
  }

  throw lastError ?? new Error('unknown fetch failure');
}

// Every page up to a cap. The cap exists because this is an aggregator and the
// rope decides what gets promoted regardless: pulling 850 rows to fill at most
// ten slots is work nobody reads.
export async function fetchEightyThousandHours({
  maxPages = 3,
  hitsPerPage = 100,
  query = '',
  fallbackArchetype = 'agentic_startups',
  fetched = new Date().toISOString().slice(0, 10),
  ...opts
} = {}) {
  const rows = [];
  let pages = 0;
  let nbHits = null;

  for (let page = 0; page < maxPages; page++) {
    const data = await fetchPage({ page, hitsPerPage, query, ...opts });
    pages++;
    if (nbHits == null) nbHits = data?.nbHits ?? null;
    const hits = data?.hits || [];
    for (const h of hits) {
      const row = normalizeHit(h, { fallbackArchetype, fetched });
      if (row.company && row.title && row.url) rows.push(row);
    }
    if (!hits.length || page + 1 >= (data?.nbPages ?? 1)) break;
  }

  return { rows, pages, nbHits };
}
