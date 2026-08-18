// The production schema gate.
//
// src/utils/schemaValidator.js has always been able to check an evidence payload
// and an audit payload. Nothing ever called it on a real file. Both validators
// were reachable only from test/schema.test.js, and only ever handed object
// literals, so every rule they enforce — R-BACKSTAGE, R-ACQUITTAL, R-VETO,
// R-THRESHOLD, R-COVERAGE-CONSISTENT, R-AUDITOR-BACKSTAGE — was in practice
// enforced by asking a model to follow instructions. auditor.md says so outright:
// "the file you write is the only place it can be caught."
//
// This module is the missing call site. It takes a parsed diagnosis, projects the
// two payloads out of it, runs the validators that already exist, checks the
// pre-audit seal, and throws one error naming every violation with the filing
// standard question behind it where there is one.
//
// TWO DELIBERATE SOFTNESSES, both so the gate does not take the existing record
// offline to enforce a rule that did not exist when it was written:
//
//   1. NO AUDIT BLOCK IS NOT A VIOLATION. renderBrief.js is documented to render
//      an unaudited diagnosis as unaudited, and /diagnose renders before the
//      recorder runs. The audit payload is validated when present and its
//      absence is reported, not thrown. casefile.js applies its own harder rule:
//      it refuses an artifact with no audit block, and that rule predates this.
//   2. AN UNSEALED ARTIFACT IS A WARNING. Every artifact written before
//      src/integrity.js existed has no seal. A modified one is a hard failure.

import { validateEvidence, validateAudit, COVERAGE_THRESHOLD, FILING_QUESTIONS } from './utils/schemaValidator.js';
import { verify as verifySeal } from './integrity.js';
import { shipSupport } from './utils/likelihoodRatio.js';
import { citationIsolation, checkCollision } from './blind.js';

// The five keys .claude/schemas/evidence.json owns. The rest of a diagnosis is
// the wrapper and is deliberately not schema-checked, per TECHNICAL_DESIGN §.
export const EVIDENCE_KEYS = ['dated', 'acquittal', 'missing_record', 'evidence', 'disconfirming'];

// .claude/references/filing-standard.md. The five mandatory questions carry their
// number in the veto key already; this is the text, so an error says what failed
// rather than only which field.
export const VETO_QUESTIONS = {
  q9_link_behind_claim: [9, 'Is there a link behind the claim?'],
  q10_verify_under_60s: [10, 'Is the verify time under sixty seconds?'],
  q13_source_beyond_posting: [13, 'Is the hypothesis sourced from something other than the posting alone?'],
  q19_staged_labeled: [19, 'Is anything staged rather than shipped labeled as staged?'],
  q20_agent_assisted_labeled: [20, 'Is agent-assisted work labeled as agent-assisted?'],
};

// Schema paths that map to a filing-standard question without a judgment call.
// Deliberately short: a schema violation and an unanswered question are different
// objects, and inventing a mapping for the rest would make the error read as more
// authoritative than it is.
const RELATED_QUESTION = [
  [/inspectable_at/, 9, 'Is there a link behind the claim?'],
  [/verify_seconds/, 10, 'Is the verify time under sixty seconds?'],
  [/every row is frontstage/, 13, 'Is the hypothesis sourced from something other than the posting alone?'],
];

export class ArtifactError extends Error {
  constructor(message, findings) {
    super(message);
    this.name = 'ArtifactError';
    this.findings = findings;
  }
}

export function evidencePayloadOf(doc) {
  const p = {};
  for (const k of EVIDENCE_KEYS) if (doc?.[k] !== undefined) p[k] = doc[k];
  return p;
}

const questionFor = (msg) => {
  for (const [re, n, text] of RELATED_QUESTION) if (re.test(msg)) return [n, text];
  return null;
};

// Returns findings rather than throwing, for callers that want to report every
// problem at once. validateArtifact() is the throwing wrapper.
export function inspectArtifact(doc, { artifact = null, checkSeal = true } = {}) {
  const findings = [];
  const note = (severity, rule, message, extra = {}) => findings.push({ severity, rule, message, ...extra });

  if (!doc || typeof doc !== 'object') {
    note('error', 'artifact', 'the artifact is empty or is not a YAML mapping');
    return { ok: false, findings, audited: false, seal: null };
  }

  // ---- evidence payload
  try {
    validateEvidence(evidencePayloadOf(doc));
  } catch (e) {
    const q = questionFor(e.message);
    note('error', 'evidence.json', e.message, q ? { question: q[0], question_text: q[1] } : {});
  }

  // ---- audit payload, when there is one
  const audited = Boolean(doc.audit);
  if (!audited) {
    note('info', 'audit', 'no audit block. Nothing here has been attacked yet.');
  } else {
    try {
      validateAudit(doc.audit);
    } catch (e) {
      const q = questionFor(e.message);
      note('error', 'audit.json', e.message, q ? { question: q[0], question_text: q[1] } : {});
    }

    // The vetoes and the threshold, named by question number. validateAudit only
    // applies these on a PASS — a REJECT is allowed to fail them, that is what a
    // REJECT means — so this reports them on a PASS and stays quiet otherwise.
    if (doc.audit.verdict === 'PASS') {
      for (const [key, ok] of Object.entries(doc.audit.veto_results || {})) {
        if (ok) continue;
        const [n, text] = VETO_QUESTIONS[key] || [null, null];
        note('error', 'R-VETO', `Q${n ?? '?'} failed and is mandatory regardless of coverage: ${text ?? key}`, {
          question: n,
          question_text: text,
        });
      }
      const cov = doc.audit.coverage_score;
      if (typeof cov === 'number' && cov < COVERAGE_THRESHOLD) {
        note('error', 'R-THRESHOLD', `coverage ${cov} is below the filing standard threshold ${COVERAGE_THRESHOLD}`, {
          unanswered: doc.audit.unanswered_question_numbers ?? [],
        });
      }
    }

    const un = doc.audit.unanswered_question_numbers;
    if (Array.isArray(un) && un.length) {
      note('info', 'coverage', `${FILING_QUESTIONS - un.length}/${FILING_QUESTIONS} answered. Unanswered: ${un.join(', ')}.`, {
        unanswered: un,
      });
    }
  }

  // ---- countercurrent: did the audit run backward, and did it cite anything new?
  //
  // Isolation is an error on a PASS and a note otherwise: an audit that rejected
  // the artifact has already stopped it, and a second refusal for one artifact
  // tells the writer less rather than more. The collision block is checked
  // whenever a blind phase claims to have happened, because a phase 1 with no
  // phase 2 is an unread second opinion and saying so costs nothing.
  if (audited) {
    const iso = citationIsolation(doc.evidence || [], doc.audit.auditor_evidence || []);
    if (!iso.ok) {
      note(doc.audit.verdict === 'PASS' ? 'error' : 'info', 'R-ISOLATION', iso.reason);
    }
    for (const r of iso.struck) {
      note('warning', 'R-ISOLATION', `auditor_evidence re-cites a diagnostician URL with no independent route to it: ${r.url}`);
    }

    const col = checkCollision(doc.audit);
    if (col.skipped) {
      note('info', 'R-COLLISION', 'this audit ran co-current: it read the diagnosis before forming a view. Agreement here is weak evidence.');
    } else {
      for (const p of col.problems) note('error', 'R-COLLISION', p);
      if (col.ok) note('info', 'R-COLLISION', `countercurrent audit, ${col.agreement} against the blind hypothesis.`);
    }
  }

  // ---- apoha: does anything here rule out the rival explanation?
  //
  // Graded, not absolute. A diagnosis that has not reached SHIP is allowed to
  // rest on non-discriminating rows — that is often exactly why it parked. The
  // bar bites when the artifact is actually about to become a packet, which is
  // SHIP plus a passing audit. Below that it reports and does not block, because
  // failing every PARK on a rule invented after they were written would take the
  // record offline to enforce it.
  const support = shipSupport(doc.evidence || []);
  const shipping = doc.verdict === 'SHIP' && doc.audit?.verdict === 'PASS';
  if (!support.supported && (doc.evidence || []).length) {
    note(shipping ? 'error' : 'info', 'LR-FLOOR', support.reason, { barred: support.barred.length });
  }
  for (const r of support.barred) {
    note('info', 'apoha', `LR ${r.likelihood_ratio}: ${r.basis} — "${r.claim}"`);
  }

  // ---- pre-audit seal
  let seal = null;
  if (checkSeal && artifact) {
    try {
      seal = verifySeal(artifact, { doc });
      if (!seal.ok) note('error', 'integrity', seal.message);
      else if (seal.state === 'unsealed') note('warning', 'integrity', seal.message);
    } catch (e) {
      note('warning', 'integrity', `seal could not be checked: ${e.message}`);
    }
  }

  return { ok: !findings.some((f) => f.severity === 'error'), findings, audited, seal };
}

export function formatFindings(findings, artifact) {
  const lines = [];
  for (const f of findings) {
    if (f.severity === 'info') continue;
    const tag = f.severity === 'error' ? 'FAIL' : 'warn';
    lines.push(`  ${tag} [${f.rule}] ${f.message}`);
    if (f.question) lines.push(`       filing standard Q${f.question}: ${f.question_text}`);
    if (f.unanswered?.length) lines.push(`       unanswered questions: ${f.unanswered.join(', ')}`);
  }
  return `${artifact || 'artifact'} failed the schema gate.\n${lines.join('\n')}`;
}

// Throws ArtifactError on any error-severity finding. Warnings are returned on
// the result so the caller can print them.
export function validateArtifact(doc, opts = {}) {
  const result = inspectArtifact(doc, opts);
  if (!result.ok) throw new ArtifactError(formatFindings(result.findings, opts.artifact), result.findings);
  return result;
}
