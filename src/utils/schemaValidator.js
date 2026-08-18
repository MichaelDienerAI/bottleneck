// Schema validation for subagent payloads. No dependency, no validator library.
//
// Every failure is an AssertionError from node:assert, thrown at the first
// violation and never accumulated. That is deliberate. A validator that
// collects a list of problems invites the caller to read the list and decide
// which ones matter, and the whole point of Gate-style checking is that the
// decision was already made when the schema was written. First violation, throw,
// name the path.
//
// The schema files under .claude/schemas/ are the readable artifact: a stranger
// can open them and see what is required. This file implements the subset of
// JSON Schema they use, plus the handful of rules JSON Schema cannot express.
// Those rules are listed by id in each schema's x-rules block, so the schema
// never claims to be the whole gate.
//
// Supported keywords: $ref (local and cross-file), type, enum, required,
// properties, additionalProperties: false, items, minItems, uniqueItems,
// minLength, minimum, maximum, pattern, format: uri. Anything else in a schema
// file is documentation and is ignored here, which is why x-rules is safe to
// carry inline.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_DIR = path.resolve(import.meta.dirname, '../../.claude/schemas');

// The filing standard's current threshold and question count, from
// .claude/references/filing-standard.md. The question list stays fixed while
// the threshold moves; rewriting the questions to match a packet converts the
// gate into a mirror.
export const FILING_QUESTIONS = 28;
export const COVERAGE_THRESHOLD = 0.5;

const cache = new Map();

export function loadSchema(name) {
  if (!cache.has(name)) {
    const file = path.join(SCHEMA_DIR, name);
    assert.ok(fs.existsSync(file), `schema: ${name} not found in ${SCHEMA_DIR}`);
    cache.set(name, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return cache.get(name);
}

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const isUri = (s) => {
  try {
    return Boolean(new URL(s).protocol);
  } catch {
    return false;
  }
};

// `ref` is either "#/$defs/x" (this document) or "other.json#/$defs/x" (another
// file in SCHEMA_DIR). Cross-file refs carry their own document forward as the
// resolution root, or a nested ref inside the referenced file would be looked
// up in the wrong document.
function resolveRef(ref, root) {
  const [file, pointer] = ref.split('#');
  const doc = file ? loadSchema(file) : root;
  let node = doc;
  for (const seg of (pointer || '').split('/').filter(Boolean)) {
    node = node?.[decodeURIComponent(seg)];
    assert.ok(node, `schema: unresolvable $ref ${ref}`);
  }
  return { node, root: doc };
}

function validateNode(value, schema, root, at) {
  // `at` is the JSON path and is empty at the root; `where` is what the message
  // says, so a root-level failure reads "payload: ..." rather than ": ...".
  const where = at || 'payload';

  if (schema.$ref) {
    const r = resolveRef(schema.$ref, root);
    return validateNode(value, r.node, r.root, at);
  }

  if (schema.enum) {
    assert.ok(
      schema.enum.includes(value),
      `${where}: ${JSON.stringify(value)} is not one of ${schema.enum.join(' | ')}`
    );
  }

  if (schema.type) {
    const actual = typeOf(value);
    if (schema.type === 'integer') {
      assert.ok(Number.isInteger(value), `${where}: expected an integer, got ${actual} ${JSON.stringify(value)}`);
    } else if (schema.type === 'number') {
      assert.ok(
        typeof value === 'number' && Number.isFinite(value),
        `${where}: expected a number, got ${actual} ${JSON.stringify(value)}`
      );
    } else {
      assert.equal(actual, schema.type, `${where}: expected ${schema.type}, got ${actual}`);
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined) {
      assert.ok(value.length >= schema.minLength, `${where}: must not be empty`);
    }
    if (schema.pattern) {
      assert.ok(
        new RegExp(schema.pattern).test(value),
        `${where}: ${JSON.stringify(value)} does not match ${schema.pattern}`
      );
    }
    if (schema.format === 'uri') {
      assert.ok(isUri(value), `${where}: ${JSON.stringify(value)} is not an inspectable URL`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined) {
      assert.ok(value >= schema.minimum, `${where}: ${value} is below the minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined) {
      assert.ok(value <= schema.maximum, `${where}: ${value} is above the maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) {
      assert.ok(
        value.length >= schema.minItems,
        `${where}: needs at least ${schema.minItems} item(s), got ${value.length}`
      );
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      assert.equal(seen.size, value.length, `${where}: contains duplicates`);
    }
    if (schema.items) {
      value.forEach((item, i) => validateNode(item, schema.items, root, `${at || 'payload'}[${i}]`));
    }
  }

  if (typeOf(value) === 'object') {
    // Required first, and in declaration order, so a missing field is named
    // before any sibling field's contents are examined.
    for (const key of schema.required || []) {
      assert.ok(Object.hasOwn(value, key), `${where}: missing required field ${key}`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        assert.ok(allowed.has(key), `${where}: unexpected field ${key}`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) validateNode(value[key], sub, root, at ? `${at}.${key}` : key);
    }
  }

  return value;
}

export function validate(schemaName, payload, label = '') {
  const root = loadSchema(schemaName);
  return validateNode(payload, root, root, label);
}

// ---------------------------------------------------------------------------
// Rules JSON Schema cannot state
// ---------------------------------------------------------------------------

// R-BACKSTAGE. A posting is front stage: it describes what a company wants to
// appear to be, because an organization whose outcomes are largely independent
// of its activity manages appearances instead. An evidence set made entirely of
// front stage rows is the company's own account of itself, so it cannot
// establish a constraint however many rows it has.
//
// The one exception is the specificity leak, admissible precisely because it
// marks where front stage control failed. It has to be labeled to count.
export function assertBackstagePresent(items, at) {
  const admissible = (items || []).filter((e) => e.source_class === 'backstage' || e.specificity_leak === true);
  assert.ok(
    admissible.length > 0,
    `${at}: every row is frontstage. A posting cannot be its own corroboration; ` +
      `at least one backstage trace is required, or a frontstage row labeled specificity_leak.`
  );
}

// R-PRAMANA-INTEGRITY.
//
// The schema carried strength 1-5, which says how sure, and nothing that said
// HOW. Those are different axes and collapsing them is how a confident reading of
// a press release ends up outranking a hesitant reading of a commit log. Indian
// epistemology keeps them apart: pratyaksa is perception, sabda is testimony,
// anumana is inference through a stated pervasion, and a claim's means of
// knowledge is a property of the claim rather than of the claimant's confidence.
//
// Four classes, and the rule is about what each may carry:
//
//   DIRECT_OBSERVABLE   read off a machine. a commit, raw JSON, an outage log
//   TESTIMONY           an account of itself. copy, a release, the posting
//   INFERRED_RELATION   drawn from an observable through a named invariant
//   HYPOTHETICAL        a suspicion, carried for the record, supporting nothing
export const PRAMANA_CLASSES = ['DIRECT_OBSERVABLE', 'TESTIMONY', 'INFERRED_RELATION', 'HYPOTHETICAL'];

// Artifacts written on or after this date must declare the class. Before it, the
// class is derived from source_class and reported as derived rather than
// asserted. 120 evidence rows existed when the field was introduced and none
// carried it; requiring it retroactively would have failed every artifact in the
// corpus at the renderer and the recorder, and backfilling would have written a
// provenance claim nobody made — DIRECT_OBSERVABLE onto rows that may be
// inferences, which is worse than absent because it is confident.
export const PRAMANA_REQUIRED_FROM = '2026-08-18';

// The derivation, used only for rows that predate the requirement. Deliberately
// coarse: it can separate a machine trace from an account of itself, which is
// what source_class already encoded. It cannot recognize an inference, so it
// never returns INFERRED_RELATION. A row that is really an inference reads here
// as DIRECT_OBSERVABLE and the report says the class was derived, not declared.
export const derivePramana = (row) =>
  row?.source_class === 'backstage' ? 'DIRECT_OBSERVABLE' : 'TESTIMONY';

export const pramanaOf = (row) => ({
  pramana: row?.pramana_class || derivePramana(row),
  declared: Boolean(row?.pramana_class),
});

// Two tiers, and the split is about what a derivation can honestly settle.
//
// ALWAYS ENFORCED: the DIRECT_OBSERVABLE floor, and vyapti on any row that
// declares itself an inference. Both are satisfiable from what the corpus already
// says — source_class separates a machine trace from an account of itself, which
// is exactly the distinction the floor needs.
//
// ENFORCED FROM THE CUTOVER: the declaration itself, and the rule that testimony
// is admissible only as a labeled leak. Both require a judgment the author has to
// have made. The second is materially STRICTER than R-BACKSTAGE, which permits
// unlabeled frontstage rows alongside a backstage one — six of the eleven
// artifacts on disk carry such rows. Applying it retroactively would fail them at
// the renderer and the recorder, so before the cutover it is reported by
// src/validateArtifact.js and not thrown. The tightening is real and it lands on
// what gets written next, not on what was written under the older rule.
export function pramanaFindings(items, at, { dated = null } = {}) {
  const rows = items || [];
  const requiresDeclaration = Boolean(dated) && String(dated) >= PRAMANA_REQUIRED_FROM;
  const deferred = [];

  rows.forEach((row, i) => {
    const { pramana, declared } = pramanaOf(row);

    if (!declared) {
      const msg =
        `${at}[${i}]: pramana_class is not declared, so it was derived from source_class as ${pramana}. ` +
        `Required on artifacts dated ${PRAMANA_REQUIRED_FROM} or later: say how this row is known, not only how strongly.`;
      if (requiresDeclaration) assert.ok(false, msg);
      else deferred.push(msg);
    }

    // An inference with no stated pervasion is an assertion with a longer
    // sentence in front of it. Naming the invariant is what lets a stranger
    // attack the invariant instead of the conclusion. Only fires on a row that
    // declared itself an inference, so no derived row can trip it.
    if (pramana === 'INFERRED_RELATION') {
      assert.ok(
        typeof row.vyapti === 'string' && row.vyapti.trim().length > 0,
        `${at}[${i}]: INFERRED_RELATION requires vyapti naming the invariant that licenses the inference.`
      );
    }

    // Testimony is a company's account of itself. It becomes admissible exactly
    // where its control of that account failed, which is the same exception
    // R-BACKSTAGE already carves and for the same reason.
    if (pramana === 'TESTIMONY' && row.specificity_leak !== true) {
      const msg =
        `${at}[${i}]: TESTIMONY is admissible only on a row flagged specificity_leak: true. ` +
        `A company's own account of itself corroborates nothing unless it says something it would not have chosen to say.`;
      if (requiresDeclaration) assert.ok(false, msg);
      else deferred.push(msg);
    }
  });

  // Always. A sufficiency claim resting entirely on accounts-of-self is the
  // failure R-BACKSTAGE exists for, stated in the vocabulary of how rather than
  // of where.
  const direct = rows.filter((r) => pramanaOf(r).pramana === 'DIRECT_OBSERVABLE');
  assert.ok(
    direct.length > 0,
    `${at}: no DIRECT_OBSERVABLE row. Claiming sufficiency requires at least one thing a stranger reads off a ` +
      `machine rather than off an account of itself.`
  );

  return deferred;
}

// Throwing form, for callers that want the assertion rather than the report.
export function assertPramanaIntegrity(items, at, opts = {}) {
  return pramanaFindings(items, at, opts);
}

export function validateEvidence(payload) {
  validate('evidence.json', payload);

  // R-ACQUITTAL. P5: when a record is missing, name the missing record.
  if (payload.acquittal === 'INSUFFICIENT_EVIDENCE') {
    assert.ok(
      typeof payload.missing_record === 'string' && payload.missing_record.trim().length > 0,
      'missing_record: INSUFFICIENT_EVIDENCE requires the name of the record that would settle it'
    );
    return payload;
  }

  assert.ok(
    payload.evidence.length > 0,
    'evidence: EVIDENCE_SUFFICIENT with no rows. Claiming sufficiency requires at least one row, ' +
      'or the acquittal is INSUFFICIENT_EVIDENCE with a named missing_record.'
  );
  assertBackstagePresent(payload.evidence, 'evidence');
  // Returns the findings deferred by the cutover so the caller can report them.
  // validateEvidence keeps its contract of returning the payload; the deferred
  // list is read by src/validateArtifact.js through pramanaFindings directly.
  assertPramanaIntegrity(payload.evidence, 'evidence', { dated: payload.dated });
  return payload;
}

export function validateAudit(payload) {
  validate('audit.json', payload);

  // R-COVERAGE-CONSISTENT. Coverage is countable, which is the point of scoring
  // instead of debating. Two decimals of rounding are allowed because auditor.md
  // writes the field as 0.00.
  const answered = FILING_QUESTIONS - payload.unanswered_question_numbers.length;
  const expected = answered / FILING_QUESTIONS;
  assert.ok(
    Math.abs(payload.coverage_score - expected) < 0.005,
    `coverage_score: ${payload.coverage_score} does not match its own unanswered list ` +
      `(${answered}/${FILING_QUESTIONS} = ${expected.toFixed(2)})`
  );

  if (payload.verdict !== 'PASS') return payload;

  // R-VETO. Five checkpoints, each with its own veto, checked one at a time so
  // the failure names which one. An aggregate that can outvote a checkpoint
  // turns the obstacle course back into an assembly line with extra steps.
  for (const [q, ok] of Object.entries(payload.veto_results)) {
    assert.ok(ok, `veto_results.${q}: false. A mandatory question fails the packet regardless of coverage.`);
  }

  // R-THRESHOLD.
  assert.ok(
    payload.coverage_score >= COVERAGE_THRESHOLD,
    `coverage_score: ${payload.coverage_score} is below the filing standard threshold ${COVERAGE_THRESHOLD}`
  );

  // R-AUDITOR-BACKSTAGE. auditor.md's posting_only_rows: 0, in code.
  assertBackstagePresent(payload.auditor_evidence, 'auditor_evidence');
  return payload;
}
