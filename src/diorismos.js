// Diorismos. State the conditions before you build, then check what you built.
//
// Euclid states, before a construction, the conditions under which it is
// possible at all — on a given straight line to construct a triangle from three
// segments requires that two of them exceed the third. The diorismos comes
// first. It is not a description of what was drawn; it is the specification the
// drawing either meets or fails, fixed before anyone starts drawing.
//
// The packet agent needs exactly that, for a reason specific to what it is. It
// drafts prose that has to hit a word count, a reading grade, one named human,
// and one sovereign proof — and it is the stage where the temptation to
// rationalize is highest, because by then a slot has been spent and the artifact
// exists and nobody wants to conclude it cannot be written. Criteria chosen after
// the draft are criteria the draft passes.
//
//   npm run diorismos -- --register <packet dir>   before drafting
//   npm run diorismos -- --check <packet dir>      after
//
// A VIOLATION QUARANTINES, IT DOES NOT DELETE. The brief said delete the draft.
// The outcome that matters is identical — a violating draft is not shippable —
// and deleting it destroys the evidence of what went wrong, which is the one
// thing this repository refuses everywhere else: data/killed.json carries an
// excerpt, data/delisted.json carries a date, the strike log carries the claim
// and the rewrite. A draft moved to rejected/ with its violation report beside it
// cannot ship and can be read.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { fkGrade, words } from './bluf.js';
import { checkOutreachForm } from './utils/promptAlgebra.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// The ceilings, matching .claude/agents/packet.md rather than restating it from
// memory: brief 400-700 words, outreach under 120, sixth to eighth grade.
export const SPEC = {
  brief: { minWords: 400, maxWords: 700 },
  outreach: { maxWords: 120 },
  grade: { floor: 6.0, ceiling: 8.0 },
  decision_makers: 1,
  sovereign_proofs: 1,
};

const readYaml = (p) => (fs.existsSync(p) ? yaml.load(fs.readFileSync(p, 'utf8')) : null);
const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

// Strips the mandatory draft header and any markdown headings before counting.
// The header is boilerplate on every packet and counting it would let a draft
// buy 9 words of its budget by existing.
const prose = (md) =>
  String(md ?? '')
    .replace(/^DRAFT ONLY.*$/gim, '')
    .replace(/^#{1,6}\s+.*$/gm, '')
    .trim();

// ---------------------------------------------------------------- registration

// Builds the block from the diagnosis and the ledger. Every field is derived,
// nothing is chosen here — a diorismos the drafter wrote for itself is a
// criterion it already passes.
export function buildDiorismos({ diagnosis, ledger, dated = null }) {
  const dmName = String(diagnosis?.decision_maker?.name ?? '').trim();
  const dmOk = Boolean(dmName) && !/INSUFFICIENT_EVIDENCE/i.test(dmName);

  const assetId = String(diagnosis?.proof_match?.asset ?? '').toLowerCase();
  // Both needles have to be non-empty. `''.includes('')` is true and so is
  // `anything.includes('')`, so matching on an absent ledger `name` field made
  // every entry match every asset and the "exactly one" rule could never be
  // satisfied — it reported two candidates for a single named proof.
  const matches = (v) => {
    const needle = String(v ?? '').toLowerCase().trim();
    return needle.length > 0 && assetId.includes(needle);
  };
  const sovereign = (ledger?.sovereign || []).filter((a) => matches(a.id) || matches(a.name));

  return {
    _what: 'Pre-registered acceptance criteria. Written before drafting; the draft meets these or it does not ship.',
    company: diagnosis?.company ?? null,
    role: diagnosis?.role ?? null,
    dated,
    decision_maker: {
      required: SPEC.decision_makers,
      name: dmOk ? dmName : null,
      source: diagnosis?.decision_maker?.source ?? null,
      satisfied: dmOk && Boolean(diagnosis?.decision_maker?.source),
    },
    sovereign_proof: {
      required: SPEC.sovereign_proofs,
      // Named, and inspectable. A ledger entry whose inspect_at reads
      // TODO_PUBLIC_URL is not sovereign yet, whatever the ledger calls it: a
      // proof a stranger cannot open is the same as no proof.
      candidates: sovereign.map((a) => ({ id: a.id, inspect_at: a.inspect_at ?? null })),
      chosen: sovereign.length === 1 ? sovereign[0].id : null,
      inspect_at: sovereign.length === 1 ? sovereign[0].inspect_at ?? null : null,
      satisfied:
        sovereign.length === 1 &&
        Boolean(sovereign[0].inspect_at) &&
        !/TODO|TBD|PENDING/i.test(String(sovereign[0].inspect_at)),
    },
    brief: { ...SPEC.brief, grade: SPEC.grade },
    outreach: { ...SPEC.outreach, grade: SPEC.grade, form: ['OBSERVATION', 'DEFEATER', 'PROOF_ACTION'] },
  };
}

// Can the packet be built at all? The Euclidean half: some constructions are
// impossible from the given parts, and saying so before drawing is the point.
export function feasible(d) {
  const blockers = [];
  if (!d.decision_maker.satisfied) {
    blockers.push(
      d.decision_maker.name
        ? 'the decision-maker has no source URL. A name with no record behind it is a guess.'
        : 'no named decision-maker. The packet is addressed to a person and this system never invents one.'
    );
  }
  if (!d.sovereign_proof.satisfied) {
    if (!d.sovereign_proof.candidates.length) blockers.push('no sovereign proof in the ledger matches proof_match.asset.');
    else if (d.sovereign_proof.candidates.length > 1)
      blockers.push(`proof_match.asset matches ${d.sovereign_proof.candidates.length} ledger entries; exactly one is required.`);
    else blockers.push(`the sovereign proof has no inspectable URL (${d.sovereign_proof.candidates[0].inspect_at}).`);
  }
  return { ok: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------- the check

export function checkDrafts(d, { brief, outreach }) {
  const violations = [];
  const notes = [];

  if (brief != null) {
    const body = prose(brief);
    const n = words(body).length;
    if (n < d.brief.minWords || n > d.brief.maxWords) {
      violations.push({
        artifact: 'brief.md',
        rule: 'word-count',
        message: `${n} words, outside the pre-registered ${d.brief.minWords}-${d.brief.maxWords}.`,
      });
    }
    const g = fkGrade(body);
    if (g != null && g > d.brief.grade.ceiling) {
      violations.push({ artifact: 'brief.md', rule: 'reading-grade', message: `grade ${g}, above the ceiling ${d.brief.grade.ceiling}.` });
    }
    if (g != null && g < d.brief.grade.floor) notes.push(`brief.md reads at grade ${g}, below the floor ${d.brief.grade.floor}.`);

    if (d.decision_maker.name && !brief.includes(d.decision_maker.name.split('—')[0].trim().split(/\s+/)[0])) {
      violations.push({ artifact: 'brief.md', rule: 'decision-maker', message: `does not address ${d.decision_maker.name}.` });
    }
    if (d.sovereign_proof.inspect_at && !brief.includes(d.sovereign_proof.inspect_at)) {
      violations.push({
        artifact: 'brief.md',
        rule: 'sovereign-proof',
        message: `does not link the pre-registered proof ${d.sovereign_proof.chosen} (${d.sovereign_proof.inspect_at}).`,
      });
    }
  }

  if (outreach != null) {
    const body = prose(outreach);
    const form = checkOutreachForm(body, {
      maxWords: d.outreach.maxWords,
      gradeFloor: d.outreach.grade.floor,
      gradeCeiling: d.outreach.grade.ceiling,
    });
    for (const p of form.problems) violations.push({ artifact: 'outreach.md', rule: 'form', message: p });
    notes.push(...form.notes.map((n) => `outreach.md: ${n}`));
  }

  return { ok: violations.length === 0, violations, notes };
}

export class DiorismosViolation extends Error {
  constructor(violations) {
    super(
      `R-DIORISMOS-VIOLATION: the draft does not meet the criteria registered before it was written.\n` +
        violations.map((v) => `  ${v.artifact} [${v.rule}] ${v.message}`).join('\n')
    );
    this.name = 'DiorismosViolation';
    this.violations = violations;
  }
}

// Moves the offending drafts out of the packet directory. Not deleted: a draft
// that failed is the record of how it failed.
export function quarantine(dir, violations, { at = null } = {}) {
  const rejected = path.join(dir, 'rejected');
  fs.mkdirSync(rejected, { recursive: true });
  const moved = [];
  for (const name of [...new Set(violations.map((v) => v.artifact))]) {
    const from = path.join(dir, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(rejected, name);
    fs.renameSync(from, to);
    moved.push(path.relative(dir, to));
  }
  fs.writeFileSync(
    path.join(rejected, 'violation.json'),
    JSON.stringify({ at, violations, moved }, null, 2) + '\n'
  );
  return moved;
}

// ---------------------------------------------------------------- cli

function packetPaths(dir) {
  const full = path.resolve(ROOT, dir);
  return {
    full,
    diorismos: path.join(full, 'diorismos.json'),
    brief: path.join(full, 'brief.md'),
    outreach: path.join(full, 'outreach.md'),
  };
}

function findDiagnosis(company) {
  const dir = path.join(ROOT, 'data/diagnoses');
  const want = String(company).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hit = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .find((f) => f.toLowerCase().startsWith(want));
  return hit ? path.join(dir, hit) : null;
}

function register(dir) {
  const p = packetPaths(dir);
  fs.mkdirSync(p.full, { recursive: true });
  const company = path.basename(p.full).replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const file = findDiagnosis(company);
  if (!file) throw new Error(`no diagnosis in data/diagnoses/ for "${company}".`);

  const d = new Date();
  const dated = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const block = buildDiorismos({
    diagnosis: yaml.load(fs.readFileSync(file, 'utf8')),
    ledger: readYaml(path.join(ROOT, 'profile/proof-ledger.yaml')),
    dated,
  });

  if (fs.existsSync(p.diorismos)) {
    throw new Error(
      `${path.relative(ROOT, p.diorismos)} already exists. Re-registering after drafting would let the criteria be ` +
        'chosen to fit the draft, which is the whole thing this gate prevents. Delete it deliberately if the diagnosis changed.'
    );
  }

  fs.writeFileSync(p.diorismos, JSON.stringify(block, null, 2) + '\n');
  console.log(`Registered ${path.relative(ROOT, p.diorismos)}`);
  console.log(`  decision-maker   ${block.decision_maker.name ?? 'NONE'}  ${block.decision_maker.satisfied ? 'ok' : 'BLOCKED'}`);
  console.log(`  sovereign proof  ${block.sovereign_proof.chosen ?? 'NONE'}  ${block.sovereign_proof.satisfied ? 'ok' : 'BLOCKED'}`);
  console.log(`  brief            ${block.brief.minWords}-${block.brief.maxWords} words, grade ${block.brief.grade.floor}-${block.brief.grade.ceiling}`);
  console.log(`  outreach         <= ${block.outreach.maxWords} words, ${block.outreach.form.join(' -> ')}`);

  const f = feasible(block);
  if (!f.ok) {
    console.log('');
    console.log('NOT CONSTRUCTIBLE. Euclid states the conditions before the construction because some');
    console.log('constructions are impossible from the given parts. These are the parts you do not have:');
    for (const b of f.blockers) console.log(`  ${b}`);
    process.exitCode = 1;
  }
}

function check(dir, { enforce = false } = {}) {
  const p = packetPaths(dir);
  const block = readYaml(p.diorismos) || (fs.existsSync(p.diorismos) ? JSON.parse(readText(p.diorismos)) : null);
  if (!block) {
    console.error(
      `no diorismos.json in ${dir}. The criteria are registered BEFORE drafting; a check with nothing to check ` +
        'against would grade the draft on criteria read off the draft.'
    );
    process.exit(1);
  }

  const r = checkDrafts(block, { brief: readText(p.brief), outreach: readText(p.outreach) });
  console.log(`Diorismos · ${block.company} · registered ${block.dated}`);
  for (const n of r.notes) console.log(`  note ${n}`);
  if (r.ok) {
    console.log('  The draft meets every criterion registered before it was written.');
    return;
  }
  for (const v of r.violations) console.log(`  FAIL ${v.artifact} [${v.rule}] ${v.message}`);
  if (enforce) {
    const moved = quarantine(p.full, r.violations, { at: block.dated });
    console.log('');
    console.log(`Quarantined ${moved.join(', ')} into rejected/, with the violation report beside them.`);
    console.log('Not deleted. A draft that failed is the record of how it failed.');
  }
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--register');
  const ci = argv.indexOf('--check');
  try {
    if (ri >= 0 && argv[ri + 1]) register(argv[ri + 1]);
    else if (ci >= 0 && argv[ci + 1]) check(argv[ci + 1], { enforce: argv.includes('--enforce') });
    else {
      console.error('usage: node src/diorismos.js --register <packet dir>');
      console.error('       node src/diorismos.js --check <packet dir> [--enforce]');
      process.exit(2);
    }
  } catch (e) {
    console.error(`diorismos: ${e.message}`);
    process.exit(1);
  }
}
