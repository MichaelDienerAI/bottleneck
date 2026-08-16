// Case file. One JSON per company, persisting across weeks.
//
// The system had no memory between cycles. It deduped postings and nothing else,
// so a company rejected in March could be re-promoted in May, re-diagnosed with
// the same wrong hypothesis, and re-rejected. That re-diagnosis costs a drum slot,
// and the drum is the constraint. Amnesia steals directly from the bottleneck.
//
// This module is the whole fix. No new agent, no new command, one file per company.
//
// THE WRITE PATH IS DETERMINISTIC, AND THAT IS THE POINT.
//
// Every field below is derived from the diagnosis YAML the auditor already ruled
// on. No agent hand-writes a case file, because memory written by a model is a
// claim nobody checked, filed where a later run inherits it as settled. The
// recorder refuses any artifact with no `audit:` block for the same reason: the
// gatherer that runs unattended at 7am never produces one, so it can never write
// here even though its tool set includes Write. That is a structural bound, not
// a note in a prompt.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '..');

// Every filesystem path is derived from a root that callers may override, so the
// tests can run against a temp directory and never touch the real data/cases.
const dirFor = (root = ROOT) => path.join(root, 'data/cases');

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function load(company, root = ROOT) {
  const p = path.join(dirFor(root), `${slugify(company)}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function save(file, root = ROOT) {
  const dir = dirFor(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${file.slug}.json`), JSON.stringify(file, null, 2) + '\n');
  return file;
}

export function create(company, archetype) {
  return {
    company,
    slug: slugify(company),
    archetype,
    first_seen: today(),
    // NEW CLEARED PARKED REJECTED AUDIT_REJECT SHIPPED DEAD.
    // Only SHIPPED and DEAD close a company; see shouldSkip.
    status: 'NEW',
    visits: [],
    dead_hypotheses: [],        // constraint claims already killed. never re-run these
    struck_claims: [],          // overstatements the auditor already removed
    queries_run: [],            // so the next visit does not repeat a search
    decision_maker: { name: null, title: null, source: null },
    revisit_after: null,        // ISO date. before this, skip
    revisit_trigger: null,      // plain language. what must change for this to be worth reopening
  };
}

const uniquePush = (arr, items) => {
  for (const x of items) if (x != null && x !== '' && !arr.includes(x)) arr.push(x);
  return arr;
};

export function recordVisit(file, visit, root = ROOT) {
  const row = { date: today(), ...visit };

  // Upsert on (artifact, digest) rather than always appending.
  //
  // The recorder fires from two places — the slash command in a terminal and the
  // server's post-run hook — and /ship re-reads the same diagnosis /diagnose
  // already recorded. An unconditional append would file a second visit carrying
  // the identical evidence keys, and noProgress() compares the last two, so the
  // company would close as DEAD on the strength of one reading recorded twice.
  // That is a filing artifact, not a finding.
  //
  // A materially rewritten artifact hashes differently and does append, which is
  // the real second visit the no-progress rule exists to judge.
  const i = row.artifact_digest
    ? file.visits.findIndex(
        (v) => v.artifact === row.artifact && v.artifact_digest === row.artifact_digest
      )
    : -1;
  if (i >= 0) file.visits[i] = { ...row, date: file.visits[i].date };
  else file.visits.push(row);

  if (visit.verdict === 'REJECT' && visit.hypothesis) uniquePush(file.dead_hypotheses, [visit.hypothesis]);
  if (visit.queries) uniquePush(file.queries_run, visit.queries);
  if (visit.struck_claims) uniquePush(file.struck_claims, visit.struck_claims);

  // Never overwrite a found name with an empty one. Finding the human is manual
  // work done outside this system, and it is the one field a later run cannot
  // reconstruct from the artifact.
  const dm = visit.decision_maker;
  if (dm && (dm.name || !file.decision_maker?.name)) {
    file.decision_maker = { ...file.decision_maker, ...dm };
  }

  file.status = statusFor(visit.verdict);
  if (noProgress(file)) {
    file.status = 'DEAD';
    file.revisit_trigger = 'Two visits produced no new evidence. Reopen only on a public change.';
  }
  return save(file, root);
}

function statusFor(verdict) {
  if (verdict === 'SHIP') return 'SHIPPED';
  // Diagnosis SHIP, audit PASS, packet not yet built. It does not close the
  // company: a /ship run that fails must leave the row workable, and SHIPPED
  // means "already in the ledger," which is not true until the packet exists.
  if (verdict === 'CLEARED') return 'CLEARED';
  if (verdict === 'PARK') return 'PARKED';
  if (verdict === 'REJECT' || verdict === 'INSUFFICIENT_EVIDENCE') return 'REJECTED';
  // The auditor refused the artifact. The slot returns to the pool and nothing
  // is closed — an artifact that failed on coverage did not kill its hypothesis,
  // so this state deliberately records no dead hypothesis and no cooling date.
  if (verdict === 'AUDIT_REJECT') return 'AUDIT_REJECT';
  return 'NEW';
}

// No-progress detection. Two consecutive visits that surfaced no evidence key the
// file did not already hold means the public record is not going to yield more.
// Repeating the search is the loop equivalent of rephrasing and calling it revision.
function noProgress(file) {
  const v = file.visits;
  if (v.length < 2) return false;
  const [prev, last] = v.slice(-2);
  const known = new Set(prev.evidence_keys || []);
  const fresh = (last.evidence_keys || []).filter((k) => !known.has(k));
  return fresh.length === 0;
}

// The scan gate. Answers one question: should this company consume a slot today?
export function shouldSkip(company, when = today(), root = ROOT) {
  const file = load(company, root);
  if (!file) return { skip: false };
  if (file.status === 'DEAD') return { skip: true, reason: 'DEAD: no progress across two visits' };
  if (file.status === 'SHIPPED') return { skip: true, reason: 'SHIPPED: already in the ledger' };
  if (file.revisit_after && when < file.revisit_after) {
    return { skip: true, reason: `cooling until ${file.revisit_after}: ${file.revisit_trigger || 'no trigger set'}` };
  }
  return { skip: false, priors: { dead_hypotheses: file.dead_hypotheses, queries_run: file.queries_run } };
}

export function park(file, days, trigger, root = ROOT) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  file.revisit_after = localDate(d);
  file.revisit_trigger = trigger;
  file.status = 'PARKED';
  return save(file, root);
}

// Local, not UTC, for the same reason src/ledger.js formats its week boundary on
// the local clock. `toISOString().slice(0,10)` reads the UTC calendar, so in any
// zone behind UTC every date stamped after about 5pm Phoenix time lands on
// tomorrow. That put a visit done on the 15th into the file as the 16th, moved
// every cooling window a day late, and made first_seen disagree with the log
// entry beside it. A visit belongs to the day the human did it, and this file's
// dates are the record that a reading belongs to a date.
const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function today() {
  return localDate(new Date());
}

// ---------------------------------------------------------------------------
// Deriving a visit from an audited diagnosis
// ---------------------------------------------------------------------------

// Evidence keys are the URLs a stranger would open, normalized so that a link
// differing only by a trailing slash or a capital letter does not read as a new
// finding next week. The auditor's own rows count: the Citation Isolation Rule
// requires a backstage source the diagnostician never cited, which makes those
// rows the newest evidence in the file.
const normalizeKey = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();

export function evidenceKeys(doc) {
  const rows = [...(doc?.evidence ?? []), ...(doc?.audit?.auditor_evidence ?? [])];
  return [...new Set(rows.map((r) => normalizeKey(r?.inspectable_at)).filter(Boolean))];
}

// The effective verdict, which is not the diagnosis verdict.
//
// A diagnosis that reached SHIP and then failed the audit did not ship, and
// filing it as SHIP would close the company on a packet that was never written.
// Gray Swan is exactly that case: SHIP at diagnosis, REJECT at audit, coverage
// 0.46. An audit REJECT therefore outranks whatever the diagnostician concluded.
export function effectiveVerdict(doc, stage = 'diagnose') {
  const audit = doc?.audit?.verdict ?? null;
  if (audit === 'REJECT') return 'AUDIT_REJECT';
  if (doc?.verdict === 'SHIP' && stage !== 'ship') return 'CLEARED';
  return doc?.verdict ?? null;
}

// The digest identifies THE READING, not the bytes of the file.
//
// It hashed the raw text once. Adding a `revisit_trigger:` field to two parked
// diagnoses then read as a second visit to each company, the evidence keys were
// unchanged, noProgress fired, and both companies closed as DEAD on an edit that
// surfaced no new evidence and made no new claim. A comment, a typo fix, or a
// reformat would have done the same thing.
//
// So the digest covers only what constitutes a reading: the hypothesis, the
// evidence set, the verdict chain, the kill query, and what the auditor struck.
// Prose, triggers, comments, and the decision-maker are outside it. Finding the
// human is a fact added to the file, not a second look at the company, and the
// upsert merges it onto the existing visit rather than filing a new one.
export function readingDigest(visit) {
  const reading = {
    hypothesis: visit.hypothesis ?? null,
    evidence_keys: [...(visit.evidence_keys ?? [])].sort(),
    diagnosis_verdict: visit.diagnosis_verdict ?? null,
    audit_verdict: visit.audit_verdict ?? null,
    coverage_score: visit.coverage_score ?? null,
    queries: [...(visit.queries ?? [])].sort(),
    struck_claims: [...(visit.struck_claims ?? [])].sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(reading)).digest('hex').slice(0, 12);
}

// Pure. Takes the parsed YAML, returns the visit row. Every field traces to
// something the auditor read; nothing here is inferred.
export function visitFromDiagnosis(doc, { artifact = null, digest = null, stage = 'diagnose' } = {}) {
  const audit = doc?.audit ?? null;
  return {
    artifact,
    artifact_digest: digest,
    stage,
    role: doc?.role ?? null,
    verdict: effectiveVerdict(doc, stage),
    diagnosis_verdict: doc?.verdict ?? null,
    audit_verdict: audit?.verdict ?? null,
    coverage_score: audit?.coverage_score ?? null,
    acquittal: doc?.acquittal ?? null,
    hypothesis: doc?.constraint_hypothesis?.weakest_link ?? null,
    evidence_keys: evidenceKeys(doc),
    queries: [doc?.disconfirming?.query_issued].filter(Boolean),
    struck_claims: (doc?.strikes?.struck ?? []).map((s) => s?.claim).filter(Boolean),
    audit_gaps: audit?.gaps ?? [],
    decision_maker: {
      name: String(doc?.decision_maker?.name ?? ''),
      title: doc?.decision_maker?.title ?? null,
      source: doc?.decision_maker?.source ?? null,
    },
  };
}

// Company name or path to a diagnosis. Ambiguity is an error, never a guess: a
// company can hold two queue rows, and recording one role's visit against the
// other role's reading is the kind of quiet mis-file this module exists to stop.
export function resolveDiagnosis(target, root = ROOT) {
  const asPath = path.resolve(root, String(target));
  if (/\.ya?ml$/.test(asPath) && fs.existsSync(asPath)) return asPath;

  const dir = path.join(root, 'data/diagnoses');
  const have = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
  const want = slugify(String(target));
  const hits = have.filter((f) => slugify(f.replace(/\.ya?ml$/, '')).startsWith(want));

  if (!hits.length) {
    throw new Error(
      `No diagnosis for "${target}".` +
        (have.length ? ` data/diagnoses/ holds: ${have.join(', ')}` : ' data/diagnoses/ is empty.')
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `"${target}" matches ${hits.length} diagnoses: ${hits.join(', ')}. ` +
        'Pass the file path so the visit lands on the right role.'
    );
  }
  return path.join(dir, hits[0]);
}

// Writes the case file from an audited diagnosis. Idempotent by artifact digest.
export function recordFromDiagnosis(target, { root = ROOT, parkDays = 30, stage = 'diagnose' } = {}) {
  const file = resolveDiagnosis(target, root);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));

  if (!doc?.company) throw new Error(`${path.relative(root, file)} names no company. Nothing to file it under.`);

  // The bound that keeps unattended runs out of memory. An artifact with no
  // audit block has not been ruled on, and an unruled claim does not get to
  // become a prior that a later diagnosis inherits as settled.
  if (!doc.audit) {
    throw new Error(
      `${path.relative(root, file)} carries no audit block. ` +
        'A case file records what the auditor ruled on, so nothing is written until the audit runs.'
    );
  }

  const existing = load(doc.company, root);
  const created = !existing;
  const caseFile = existing ?? create(doc.company, doc.archetype ?? null);

  const visit = visitFromDiagnosis(doc, { artifact: path.relative(root, file), stage });
  visit.artifact_digest = readingDigest(visit);
  recordVisit(caseFile, visit, root);

  // PARK carries a date and a written trigger, or PARK means nothing. The
  // trigger is judgment made during the attended run, so it is lifted from the
  // artifact when the diagnostician wrote one and left empty when they did not.
  // An invented trigger would be a claim with no author.
  let parked = false;
  if (visit.verdict === 'PARK' && caseFile.status === 'PARKED') {
    park(caseFile, parkDays, doc.revisit_trigger ?? null, root);
    parked = true;
  }

  return {
    path: path.join(dirFor(root), `${caseFile.slug}.json`),
    artifact: visit.artifact,
    company: caseFile.company,
    created,
    stage,
    status: caseFile.status,
    verdict: visit.verdict,
    diagnosis_verdict: visit.diagnosis_verdict,
    audit_verdict: visit.audit_verdict,
    visits: caseFile.visits.length,
    evidence_keys: visit.evidence_keys.length,
    struck_claims: visit.struck_claims.length,
    parked,
    revisit_after: caseFile.revisit_after,
    revisit_trigger: caseFile.revisit_trigger,
    decision_maker: caseFile.decision_maker,
  };
}

export function summary(root = ROOT) {
  const dir = dirFor(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .map((c) => ({
      company: c.company,
      status: c.status,
      visits: c.visits.length,
      dead_hypotheses: c.dead_hypotheses.length,
      revisit_after: c.revisit_after,
    }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Guarded, because the tests import this module and an unguarded argv read would
// fire the CLI inside the suite.
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  if (argv[0] === '--record') {
    const target = argv[1];
    if (!target || target.startsWith('--')) {
      console.error('usage: node src/casefile.js --record <company | data/diagnoses/x.yaml> [--stage diagnose|ship] [--park-days N]');
      process.exit(2);
    }
    try {
      const r = recordFromDiagnosis(target, {
        stage: flag('--stage', 'diagnose'),
        parkDays: Number(flag('--park-days', 30)),
      });
      console.log(`${r.created ? 'Created' : 'Updated'} ${path.relative(ROOT, r.path)}`);
      console.log(`  from        ${r.artifact}  (stage: ${r.stage})`);
      console.log(`  verdicts    diagnosis ${r.diagnosis_verdict} / audit ${r.audit_verdict} -> ${r.verdict}`);
      console.log(`  status      ${r.status}`);
      console.log(`  visits      ${r.visits}   evidence keys ${r.evidence_keys}   struck claims ${r.struck_claims}`);
      if (r.parked) {
        console.log(`  cooling     until ${r.revisit_after}`);
        if (!r.revisit_trigger) {
          console.log('  WARN: parked with no revisit trigger. A park with no written trigger is a');
          console.log('        date with no reason. Add `revisit_trigger:` to the diagnosis and re-record.');
        }
      }
      if (r.status === 'DEAD') {
        console.log('  DEAD: two visits surfaced no new evidence. Closed until a public change.');
      }
      if (!r.decision_maker?.name) {
        console.log('  decision-maker still unnamed. That is manual work and the packet stops without it.');
      }
    } catch (e) {
      console.error(`Refusing to record. ${e.message}`);
      process.exit(1);
    }
  } else if (argv[0] === '--show') {
    const rows = summary();
    if (!rows.length) console.log('No case files yet. data/cases/ is empty.');
    for (const r of rows) {
      console.log(
        `${r.company.padEnd(20)} ${String(r.status).padEnd(13)} visits ${r.visits}  dead hypotheses ${r.dead_hypotheses}  ${r.revisit_after ?? ''}`
      );
    }
  } else {
    console.error('usage: node src/casefile.js --record <company | path> [--stage diagnose|ship] [--park-days N]');
    console.error('       node src/casefile.js --show');
    process.exit(2);
  }
}
