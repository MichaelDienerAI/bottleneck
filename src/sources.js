// Public ATS job board readers.
//
// These three endpoints are published by the companies themselves for exactly
// this purpose. No scraping, no auth, no terms violation. Between them they
// cover most of the target archetypes, because AI startups almost all run
// Greenhouse, Lever, or Ashby.
//
// Every fetcher returns the same shape so downstream stages never branch on source.

const UA = 'constraint-search/0.1 (personal job search)';

function normalize({ source, company, archetype, id, title, location, url, description, updatedAt, comp }) {
  return {
    key: `${source}:${company}:${id}`,
    source,
    company,
    archetype,
    title: title || '',
    location: location || '',
    url: url || '',
    description: stripHtml(description || ''),
    posted: updatedAt || null,
    comp: comp || null,
    fetched: new Date().toISOString().slice(0, 10),
  };
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const fetchers = {
  // https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true
  async greenhouse(token, company, archetype) {
    const data = await getJson(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
    );
    return (data.jobs || []).map((j) =>
      normalize({
        source: 'greenhouse',
        company,
        archetype,
        id: j.id,
        title: j.title,
        location: j.location?.name,
        url: j.absolute_url,
        description: j.content,
        updatedAt: j.updated_at,
      })
    );
  },

  // https://api.lever.co/v0/postings/<token>?mode=json
  async lever(token, company, archetype) {
    const data = await getJson(
      `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
    );
    return (Array.isArray(data) ? data : []).map((j) =>
      normalize({
        source: 'lever',
        company,
        archetype,
        id: j.id,
        title: j.text,
        location: j.categories?.location,
        url: j.hostedUrl,
        description: [j.descriptionPlain, ...(j.lists || []).map((l) => l.content)].join(' '),
        updatedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      })
    );
  },

  // https://api.ashbyhq.com/posting-api/job-board/<token>?includeCompensation=true
  async ashby(token, company, archetype) {
    const data = await getJson(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(
        token
      )}?includeCompensation=true`
    );
    return (data.jobs || []).map((j) =>
      normalize({
        source: 'ashby',
        company,
        archetype,
        id: j.id,
        title: j.title,
        location: j.location,
        url: j.jobUrl,
        description: j.descriptionPlain || j.descriptionHtml,
        updatedAt: j.publishedAt,
        comp: extractAshbyComp(j),
      })
    );
  },
};

function extractAshbyComp(job) {
  const tiers = job.compensation?.compensationTiers || [];
  for (const t of tiers) {
    const c = (t.components || []).find((x) => x.compensationType === 'Salary');
    if (c && (c.minValue || c.maxValue)) {
      return { min: c.minValue ?? null, max: c.maxValue ?? null, currency: c.currencyCode || 'USD' };
    }
  }
  return null;
}

// Salary bands in free text. Only some jurisdictions mandate disclosure, so
// absence of a band is absence of data, never evidence of a low offer.
export function extractCompFromText(text) {
  const m = text.match(
    /\$\s?(\d{2,3})(?:,\d{3}|k)\s*(?:-|to|–|—)\s*\$?\s?(\d{2,3})(?:,\d{3}|k)/i
  );
  if (!m) return null;
  const scale = (n) => (n < 1000 ? n * 1000 : n);
  return { min: scale(Number(m[1])), max: scale(Number(m[2])), currency: 'USD', from: 'text' };
}

export async function fetchBoard({ ats, token, name, archetype }) {
  const fn = fetchers[ats];
  if (!fn) throw new Error(`unknown ats: ${ats}`);
  return fn(token, name, archetype);
}
