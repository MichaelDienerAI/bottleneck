// Apoha: exclusion of the non-discriminating.
//
// Dharmakīrti's account of concept formation is negative. "Cow" does not name a
// property shared by cows; it excludes the non-cow. Meaning is what a term rules
// OUT. Applied to evidence, the question stops being "does this observation fit
// the hypothesis" — nearly everything fits — and becomes "what does this
// observation exclude?" An observation that rules nothing out carries no
// information, however striking it looks and however many rows agree with it.
//
// The failure this addresses is visible in this repository. The LangChain audit
// recorded: "Five open reqs on one team could also mean fast growth after a
// $125M Series B rather than a bottleneck." That is a rival explanation with the
// same predictions, so the five reqs discriminate nothing. It was filed as a gap
// and the diagnosis kept leaning on the reqs anyway. Counting evidence rows
// cannot catch that. Clinical medicine unlearned the same habit: a single
// high-likelihood-ratio finding beats ten low ones, and totting up findings is
// how you get confident diagnoses that are wrong.
//
//   LR = P(observation | bottleneck) / P(observation | ordinary growth)
//
// ON THE NUMBERS, HONESTLY. Nothing here measures a probability. There is no
// corpus of labeled companies to estimate one from, and a validator that emitted
// 2.7 would be inventing precision it has not got. What this module returns is an
// ORDINAL bucket with written anchors, derived from the SHAPE of the claim: does
// it carry the qualifier that separates a bottleneck reading from a growth
// reading, or does it not? That is the apoha move made checkable. Treat the
// number as an ordering, never as a measurement, and read `basis` alongside it.
//
// A row may declare its own `likelihood_ratio` and that wins, because the writer
// knows things the regex does not. The floor still applies to the declared value.

// Below this, a row may not carry a SHIP. Set at 1.5 because that is roughly
// where a finding stops being a coin flip between two live explanations and
// starts favouring one. It is a threshold you turn, like the coverage score.
export const LR_FLOOR = 1.5;

// Ordinal anchors. These are the only values inferLikelihoodRatio returns.
export const ANCHORS = {
  NON_DISCRIMINATING: 1.0, // ordinary growth predicts this just as well
  WEAK: 1.2, // leans toward the bottleneck reading, not enough to rest on
  MODERATE: 2.0, // growth has to strain to explain it
  STRONG: 4.0, // growth does not predict this at all
};

// Observations a growing, healthy company produces as readily as a stuck one.
// This is the exclusion list: the claim shapes that rule nothing out.
const GROWTH_EXPLICABLE = [
  // Counts of open roles. Word-numbers as well as digits, and up to two
  // adjectives between the count and the noun — "nine open engineering reqs" is
  // the shape this actually arrives in.
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple|many)\s+(?:\w+\s+){0,2}(reqs?|requisitions?|roles?|postings?|openings?|seats?)\b/i,
  /\bheadcount\b/i,
  /\b(series\s+[a-e]\b|raised|funding|valuation|\$\d+\s*(m|b|million|billion))/i,
  /\bhiring\b/i,
  // Growth words only when they attach to the ORGANIZATION. "the issue queue
  // grew" is a bottleneck signature, not a growth explanation, and matching a
  // bare "grew" read it as the opposite of what it says.
  /\b(team|org|company|department|engineering|staff|headcount)\b[^.]{0,40}\b(grew|growing|expanded|expanding|scaling|scaled)\b/i,
  /\b(grew|growing|expanded|expanding|scaling|scaled)\b[^.]{0,25}\b(team|org|company|department|staff|headcount)\b/i,
  /\bthe posting (says|asks|describes|names|lists)\b/i,
  /\b(job description|careers page|about page|marketing site)\b/i,
];

// Qualifiers that make an observation discriminate. Each is a thing ordinary
// growth does not predict: a duration, a ratio, a dated comparison, a stopped
// cadence, a refusal. These are the words that convert "they are busy" into
// "this specific part is at its limit."
const DISCRIMINATING = [
  { re: /\b\d+\s*(day|week|month|year)s?\s+(old|ago|without|since|unresolved|open|empty|stale)\b/i, why: 'a duration' },
  // The same fact with the state word in front: "stayed open 18 months",
  // "has sat unmerged for 40 days". Only the word order differs.
  {
    re: /\b(stayed|been|sat|sitting|remained|left|unchanged|unresolved|unmerged|untouched|idle)\b[^.]{0,20}\b\d+\s*(day|week|month|year)s?\b/i,
    why: 'a duration',
  },
  { re: /\b(no|zero)\s+(release|commit|deploy|update|response)s?\s+(in|for|since)\b/i, why: 'a stopped cadence' },
  { re: /\b(p50|p75|p90|median|percentile)\b/i, why: 'a distribution rather than an anecdote' },
  { re: /\b\d+(\.\d+)?\s*%|\b\d+\s+(of|out of|per)\s+\d+\b|\b\d+\s*:\s*\d+\b/i, why: 'a ratio' },
  { re: /\bweighted by (demand|reactions?|votes?|usage)\b/i, why: 'age weighted by demand' },
  { re: /\b(unchanged|unresolved|still open|still listed|never merged|never closed)\s+(since|after|as of)\b/i, why: 'a dated non-event' },
  { re: /\b(declin|refus|reject|cannot|will not|unsupported|out of scope)\w*\b.*\b(request|issue|feature|ticket)s?\b/i, why: 'a refusal boundary' },
  { re: /\b(incident|outage|postmortem|regression|rollback)\b/i, why: 'a public failure' },
  { re: /\breposted?\b|\bsame (title|req|role)\b.*\b(again|second time|third time)\b/i, why: 'a repost' },
  { re: /\bmeasured\b|\bI (ran|measured|timed)\b|\btime to first token\b|\blatency of\b/i, why: 'a first-hand measurement' },
];

const textOf = (row) => `${row?.claim ?? ''} ${row?.inspectable_at ?? ''}`;

// Returns the ordinal LR, whether the row discriminates, and why. Deterministic:
// same row in, same answer out, no model and no network.
export function inferLikelihoodRatio(row) {
  const text = textOf(row);
  const hits = DISCRIMINATING.filter((d) => d.re.test(text));
  const growth = GROWTH_EXPLICABLE.filter((g) => g.test(text));

  if (hits.length >= 2) {
    return { lr: ANCHORS.STRONG, basis: `discriminates on ${hits.map((h) => h.why).join(' and ')}` };
  }
  if (hits.length === 1) {
    // One qualifier against an explicitly growth-shaped claim is a tie, not a win.
    if (growth.length) {
      return {
        lr: ANCHORS.WEAK,
        basis: `carries ${hits[0].why}, but the claim is also growth-shaped, so the two readings compete`,
      };
    }
    return { lr: ANCHORS.MODERATE, basis: `discriminates on ${hits[0].why}` };
  }
  if (growth.length) {
    return {
      lr: ANCHORS.NON_DISCRIMINATING,
      basis: 'ordinary growth predicts this observation just as well as a bottleneck does',
    };
  }
  // Neither shape. Not excluded, not established.
  return { lr: ANCHORS.WEAK, basis: 'no qualifier that separates a bottleneck reading from a growth reading' };
}

// One row, scored. A declared likelihood_ratio wins over the inference; the
// floor applies either way.
export function scoreRow(row) {
  const declared = typeof row?.likelihood_ratio === 'number' ? row.likelihood_ratio : null;
  const inferred = inferLikelihoodRatio(row);
  const lr = declared ?? inferred.lr;
  return {
    claim: String(row?.claim ?? '').slice(0, 120),
    likelihood_ratio: lr,
    declared: declared != null,
    discriminating: lr >= LR_FLOOR,
    basis: declared != null ? `declared by the writer as ${declared}` : inferred.basis,
  };
}

// Annotates rows without mutating them.
//
// It sets `discriminating`, NOT `specificity_leak`. That field already means one
// specific thing in .claude/schemas/evidence.json — a frontstage row admissible
// because frontstage control failed — and the auditor reads it. Writing
// `specificity_leak: false` onto a low-LR backstage row would say something false
// about a field that already has a meaning, and would tell the auditor the row
// failed a test it was never given.
export function applyLikelihoodRatio(rows = []) {
  return rows.map((r) => ({ ...r, ...scoreRow(r) }));
}

// The bar. A SHIP has to rest on at least one row that rules something out.
//
// Deliberately not "most rows" or "the average row." Ten non-discriminating rows
// are not one discriminating row, which is the whole point — the aggregate is
// exactly what lets a pile of growth-explicable observations look like a case.
export function shipSupport(rows = []) {
  const scored = applyLikelihoodRatio(rows);
  const supporting = scored.filter((r) => r.discriminating);
  return {
    scored,
    supporting,
    barred: scored.filter((r) => !r.discriminating),
    supported: supporting.length > 0,
    reason: supporting.length
      ? null
      : `no evidence row reaches the likelihood-ratio floor of ${LR_FLOOR}. Every row is as consistent with ordinary ` +
        'growth as with a bottleneck, so nothing here excludes the rival explanation and a SHIP would rest on a count rather than a discrimination.',
  };
}
