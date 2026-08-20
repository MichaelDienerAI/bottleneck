// Epistemic asset assessor. Does a proof this candidate holds act on the failure
// this company actually has?
//
// The question sounds like matching and is not. Keyword overlap between a resume
// and a posting is the thing every applicant tracking system already does badly,
// and adding a model to it produces an expensive regex with worse recall. What is
// worth computing is narrower and harder: given a bottleneck established from
// backstage evidence, and a proof a stranger can open, is there an unbroken
// causal link between them, and which of its links are missing?
//
// WHAT CODE CAN AND CANNOT SETTLE HERE, because the difference is the whole
// design. Code can check that a proof is named, that exactly one ledger entry
// answers to that name, that its URL resolves to something rather than to
// TODO_PUBLIC_URL, that the diagnostician wrote acts_on_constraint: true, that the
// proof's declared constraints share terms with the binding part, and that the
// stated causal middle term has the FORM of an inference. Code cannot settle
// whether the proof actually resolves the bottleneck. That is a causal claim, P4
// governs it, and no amount of string comparison produces a dated record.
//
// So match_score is a score over INSPECTABLE PROPERTIES, not over fit. Every
// point it awards traces to a check a stranger can repeat, and the components are
// returned alongside the total so the number can be argued with rather than
// believed. A high score means "the preconditions for a defensible claim are
// present," never "this candidate will fix it."
//
// The gaps are the more useful half. P5: when a record is missing, name the
// missing record. A proof_delta whose direct_hits is empty and whose
// unverified_gaps names three specific absent traces is a work order.

import { checkSyllogism } from './blind.js';
import { pramanaOf } from './utils/schemaValidator.js';

// A ledger URL that promises a URL later. profile/proof-ledger.yaml really does
// carry TODO_PUBLIC_URL on deformation_test_bank, and a proof a stranger cannot
// open is not sovereign yet whatever the ledger calls it.
const PLACEHOLDER = /TODO|TBD|PENDING|COMING SOON|^$/i;

export const isInspectable = (url) => {
  const u = String(url ?? '').trim();
  return u.length > 0 && !PLACEHOLDER.test(u) && /^https?:\/\//i.test(u);
};

// Each component is a check a stranger can repeat. The weights are a judgment and
// are stated here rather than buried, so a reader can disagree with the judgment
// instead of the arithmetic.
export const COMPONENTS = [
  { key: 'named', points: 10, describe: 'the diagnosis names a proof' },
  { key: 'resolves', points: 10, describe: 'exactly one ledger entry answers to that name' },
  { key: 'sovereign', points: 15, describe: 'the entry is sovereign rather than speculative' },
  { key: 'inspectable', points: 20, describe: 'its URL opens to something a stranger can read' },
  { key: 'acts_on', points: 15, describe: 'the diagnostician recorded acts_on_constraint: true' },
  { key: 'domain_overlap', points: 10, describe: "the proof's declared constraints share terms with the binding part" },
  { key: 'middle_term', points: 20, describe: 'a stated causal middle term with the form of an inference' },
];

export const MAX_SCORE = COMPONENTS.reduce((n, c) => n + c.points, 0);

// A direct hit is not a high score. It is the conjunction of the four checks
// without which the claim cannot be defended at all, and it is deliberately
// unforgiving: a proof nobody can open is not a hit however well it matches.
export const HIT_REQUIREMENTS = ['sovereign', 'inspectable', 'acts_on', 'middle_term'];

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'on', 'to', 'that', 'is', 'are', 'it', 'its', 'their',
  'with', 'by', 'at', 'as', 'from', 'this', 'than', 'no', 'not', 'more', 'one', 'can', 'has', 'have',
]);

const terms = (s) =>
  new Set(
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, ''))
  );

// Shared vocabulary between what the proof claims to act on and what the
// diagnosis named as binding. Weak evidence on its own — two documents about
// evaluation harnesses share words whether or not one fixes the other — which is
// why it is worth ten points out of a hundred and never a hit requirement.
export function domainOverlap(proofConstraints = [], bindingPart = '') {
  const want = terms(bindingPart);
  const shared = new Set();
  for (const c of proofConstraints) {
    for (const t of terms(c)) if (want.has(t)) shared.add(t);
  }
  return { shared: [...shared], overlaps: shared.size > 0 };
}

// Finds the ledger entry the diagnosis is talking about. Both needles must be
// non-empty: `assetId.includes('')` is true for every string, which in
// src/diorismos.js once made every ledger entry match every asset.
export function resolveProof(assetField, ledger) {
  const asset = String(assetField ?? '').toLowerCase();
  if (!asset.trim()) return { entry: null, candidates: [], tier: null };

  const match = (v) => {
    const needle = String(v ?? '').toLowerCase().trim();
    return needle.length > 0 && asset.includes(needle);
  };

  const sovereign = (ledger?.sovereign || []).filter((a) => match(a.id) || match(a.name));
  const speculative = (ledger?.speculative || []).filter((a) => match(a.id) || match(a.name));
  const candidates = [...sovereign, ...speculative];

  return {
    entry: candidates.length === 1 ? candidates[0] : null,
    candidates,
    tier: candidates.length === 1 ? (sovereign.length === 1 ? 'sovereign' : 'speculative') : null,
  };
}

// The middle term. src/blind.js checks the FORM — the term appears in both
// premises and not in the conclusion, because a middle term is what the inference
// eliminates. Whether it names the reason rather than a sign of it, causa
// essendi, is judgment and stays judgment.
//
// The artifact carries it in proof_match.middle_term when the diagnostician wrote
// one. Nothing is inferred when it is absent: an unstated middle term is a
// missing record, which is a finding under P5, not a thing to guess at.
export function assessMiddleTerm(diagnosis) {
  const pm = diagnosis?.proof_match ?? {};
  const stated = pm.middle_term;
  if (!stated || typeof stated !== 'object') {
    return {
      present: false,
      unbroken: false,
      problems: [
        'proof_match.middle_term is absent. Nothing states WHY this proof acts on this bottleneck, ' +
          'so the claim is an assertion with a proof beside it rather than an argument.',
      ],
    };
  }
  const r = checkSyllogism(stated);
  return { present: true, unbroken: Boolean(r.unbroken), problems: r.problems ?? [] };
}

// ---------------------------------------------------------------- the delta

export function assessProof({ diagnosis, ledger } = {}) {
  const bindingPart = diagnosis?.constraint_hypothesis?.binding_part ?? '';
  const pm = diagnosis?.proof_match ?? {};
  const resolved = resolveProof(pm.asset, ledger);
  const entry = resolved.entry;

  const overlap = domainOverlap(entry?.acts_on_constraints ?? [], bindingPart);
  const middle = assessMiddleTerm(diagnosis);

  const checks = {
    named: Boolean(String(pm.asset ?? '').trim()),
    resolves: Boolean(entry),
    sovereign: resolved.tier === 'sovereign',
    inspectable: Boolean(entry) && isInspectable(entry.inspect_at),
    acts_on: pm.acts_on_constraint === true,
    domain_overlap: overlap.overlaps,
    middle_term: middle.unbroken,
  };

  const components = COMPONENTS.map((c) => ({ ...c, passed: Boolean(checks[c.key]), awarded: checks[c.key] ? c.points : 0 }));
  const match_score = components.reduce((n, c) => n + c.awarded, 0);

  // P5, applied item by item. Each gap names the record that would close it.
  const unverified_gaps = [];
  if (!checks.named) unverified_gaps.push('proof_match.asset is empty. No proof is being claimed, so there is nothing to assess.');
  else if (!checks.resolves) {
    unverified_gaps.push(
      resolved.candidates.length > 1
        ? `proof_match.asset matches ${resolved.candidates.length} ledger entries (${resolved.candidates.map((c) => c.id).join(', ')}). Exactly one is required.`
        : `no ledger entry answers to "${pm.asset}". Add it to profile/proof-ledger.yaml or correct the name.`
    );
  }
  if (checks.resolves && !checks.sovereign) {
    unverified_gaps.push(
      `${entry.id} sits in the speculative half of the ledger. A speculative proof is a claim about the candidate, not a thing a stranger inspects.`
    );
  }
  if (checks.resolves && !checks.inspectable) {
    unverified_gaps.push(
      `${entry.id} has no inspectable URL (${entry.inspect_at ?? 'absent'}). MISSING RECORD: a public address a stranger can open without asking.`
    );
  }
  if (checks.resolves && !checks.acts_on) {
    unverified_gaps.push(
      'proof_match.acts_on_constraint is not true. The diagnostician did not record that this proof acts on the named part, and this module does not overrule that.'
    );
  }
  if (checks.resolves && !checks.domain_overlap) {
    unverified_gaps.push(
      `${entry.id} declares acts_on_constraints that share no term with the binding part. Either the proof is aimed elsewhere or the ledger entry is stale.`
    );
  }
  for (const p of middle.problems) unverified_gaps.push(`middle term: ${p}`);

  // The supporting evidence, by how it is known rather than how strong it feels.
  const rows = diagnosis?.evidence ?? [];
  const byPramana = { DIRECT_OBSERVABLE: 0, TESTIMONY: 0, INFERRED_RELATION: 0, HYPOTHETICAL: 0 };
  for (const r of rows) {
    const { pramana } = pramanaOf(r);
    if (pramana in byPramana) byPramana[pramana] += 1;
  }
  if (!byPramana.DIRECT_OBSERVABLE) {
    unverified_gaps.push(
      'no DIRECT_OBSERVABLE row supports the bottleneck. The failure this proof would act on rests on accounts rather than on traces.'
    );
  }

  const failedRequirements = HIT_REQUIREMENTS.filter((k) => !checks[k]);
  const direct_hits = failedRequirements.length
    ? []
    : [
        {
          proof: entry.id,
          inspect_at: entry.inspect_at,
          binding_part: bindingPart,
          middle_term: diagnosis.proof_match.middle_term,
          shared_terms: overlap.shared,
        },
      ];

  return {
    company: diagnosis?.company ?? null,
    proof_delta: {
      direct_hits,
      unverified_gaps,
      match_score,
      max_score: MAX_SCORE,
      components,
      failed_requirements: failedRequirements,
      evidence_by_pramana: byPramana,
    },
    // Said out loud on every result, because a number invites being read as a
    // verdict and this one is a readiness check on the preconditions.
    caveat:
      'match_score counts inspectable preconditions, not fit. It cannot establish that this proof resolves this bottleneck; ' +
      'that is a causal claim and P4 requires a dated record showing both halves.',
  };
}

// The gate the commercial packet path uses. Deliberately not a threshold on the
// score: a packet is defensible or it is not, and a proof nobody can open does
// not become defensible by scoring 80.
export function commercialReady(delta) {
  const d = delta?.proof_delta ?? delta;
  if (!d) return { ok: false, reasons: ['no proof delta was computed'] };
  if (!d.direct_hits?.length) {
    return {
      ok: false,
      reasons: [
        'zero direct proof hits. A dossier resting on no proof that provably acts on the named failure is an opinion with a letterhead.',
        ...(d.failed_requirements ?? []).map((k) => `failed requirement: ${k}`),
      ],
    };
  }
  return { ok: true, reasons: [] };
}
