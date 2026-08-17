// BLUF: bottom line up front.
//
// One line at the top of the Plain English view that says what to do. It is
// derived, never authored. Nothing in this file decides anything: it reads a
// verdict that was already recorded and the gate that already failed, and picks
// the sentence that reports them. A generator that could re-decide would be a
// second opinion competing with the audit, and the audit wins by construction.
//
//   node src/bluf.js            table of every diagnosis, its verdict, its BLUF
//
// Four rules this file enforces rather than hopes for:
//
//   1. The text is canned per (verdict, failing gate). No prose from the
//      diagnosis is interpolated into it. This is the only way to guarantee a
//      struck claim cannot reach the top of the page: text that was never
//      copied from the file cannot carry a claim the auditor killed.
//   2. It runs downstream of the audit. The caller passes the gate results and
//      the strike list, so a file whose audit rejected it derives the REJECT
//      line, not the line its own verdict field would like.
//   3. Every candidate is checked against the strike list anyway, by shingle
//      overlap, and a hit fails the render. Belt and braces, because rule 1 is
//      a property of today's templates and rule 3 is a property of the code.
//   4. A missing verdict renders 'Verdict not recorded.' and fails loudly. It
//      never guesses, because the guess would be the one field a reader trusts.
//
// On the reading grade. The target in CLAUDE.md and .claude/agents/diagnostician.md
// is sixth to eighth grade, and Flesch-Kincaid cannot express the floor on a
// sentence this short: the formula rewards long sentences and long words, so
// "Apply. Michael holds public, working proof" scores near 5 precisely because
// it is plain. The ceiling is the half that means something at 25 words, so the
// ceiling is an error and the floor is a warning. Raising the floor to an error
// would force filler into the one line that must not have any.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------- hard limits

export const MAX_WORDS = 25;
export const FK_CEILING = 8.0;
export const FK_FLOOR = 6.0;

// The vocabulary a reader outside this system does not have. Distinct from the
// BANNED list in renderBrief.js, which is CLAUDE.md's ban on corporate filler
// everywhere in an artifact. This list is narrower and stricter: these are
// house words that are correct in the audit and unreadable in the first line.
export const BANNED_JARGON = [
  'constraint',
  'binding',
  'sovereign',
  'requisition',
  'Gate 0',
  'asset',
  'tier',
  'ledger',
  'coverage',
  'acquittal',
  'veto',
  'inspect_at',
];

const jargonPattern = (term) =>
  new RegExp(`(?:^|[^A-Za-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?:[^A-Za-z0-9_]|$)`, 'i');

// Past participles that do not end in -ed. Not exhaustive and not trying to be:
// it covers the irregulars that show up in this repository's prose.
const IRREGULAR_PARTICIPLES = [
  'struck', 'written', 'shown', 'held', 'found', 'given', 'taken', 'made', 'seen',
  'known', 'drawn', 'sent', 'built', 'met', 'left', 'kept', 'read', 'set', 'put',
  'run', 'done', 'gone', 'told', 'paid', 'said', 'brought', 'caught', 'chosen',
  'driven', 'proven', 'spent',
];

// be-verb, optional adverbs, past participle. "was written", "is not recorded",
// "has been struck" (the 'been' carries it). Adjectival uses like "is closed"
// trip it too, which is the right side to err on for a single headline line.
const PASSIVE = new RegExp(
  `\\b(?:is|are|was|were|be|been|being|am)\\b` +
    `(?:\\s+(?:not|never|already|still|also|only|now|just|then|again|being))*` +
    `\\s+(?:\\w+ed|${IRREGULAR_PARTICIPLES.join('|')})\\b`,
  'i'
);

// Mirrors the same-named constant in src/renderBrief.js. A row that opens by
// declaring it was NOT struck is not a strike, and running the injection check
// against it would fail the render on a claim the auditor let stand.
const NOT_STRUCK = /^\s*(?:not[ _-]?struck|survived|not a strike)\b/i;

// ---------------------------------------------------------------- measurement

// Same heuristic renderBrief.js uses, exported so the two agree by construction
// rather than by coincidence.
export const syllables = (w) => {
  const s = w.toLowerCase().replace(/[^a-z]/g, '');
  if (s.length <= 3) return 1;
  const groups = s
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
};

export const words = (text) =>
  String(text ?? '')
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w));

// Flesch-Kincaid on a short line. readingGrade() in renderBrief.js refuses text
// under three sentences or forty words, because on a paragraph that short the
// number is noise. A BLUF is always that short and still needs a ceiling, so
// this one scores what it is given and counts a fragment like "Apply." as the
// sentence it functions as.
export function fkGrade(text) {
  const w = words(text);
  if (!w.length) return null;
  const sentences = Math.max(1, (String(text).match(/[.!?]+(?=\s|$)/g) || []).length);
  const syl = w.reduce((n, x) => n + syllables(x), 0);
  const grade = 0.39 * (w.length / sentences) + 11.8 * (syl / w.length) - 15.59;
  return Math.round(grade * 10) / 10;
}

// ---------------------------------------------------------------- strike guard

// The auditor opens every claim with the field it hit: "binding_part:",
// "Evidence row 4:", "Gap 7:", "proof_match mechanism:". That prefix is a
// pointer, not part of the claim, and leaving it in shifts the comparison
// window by two or three words, which is enough for a requoted phrase to slip
// past the check. Same convention renderBrief.js reads in targetOf().
const STRIKE_PREFIX =
  /^\s*(?:evidence\s+rows?\s+\d+(?:\s*(?:and|,|&)\s*\d+)?|gaps?\s+\d+|[a-z_]+(?:[.\s][a-z_]+)?)\s*:\s*/i;

export const stripStrikePrefix = (claim) =>
  String(claim ?? '')
    .replace(STRIKE_PREFIX, '')
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();

// Every claim the auditor actually struck, as one flat list of strings, with the
// pointer prefix removed. Takes the raw `strikes.struck` array from a diagnosis.
export function struckClaims(struck) {
  return (struck || [])
    .map((s) => String(s?.claim ?? ''))
    .filter((c) => c.trim() && !NOT_STRUCK.test(c))
    .map(stripStrikePrefix)
    .filter(Boolean);
}

const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const shingles = (text, n) => {
  const w = normalize(text).split(' ').filter(Boolean);
  const out = new Set();
  if (w.length && w.length < n) out.add(w.join(' '));
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
};

export const SHINGLE = 6;

// Does any run of SHINGLE words in the BLUF also appear in a struck claim?
// Returns the offending phrase and the claim it came from, or null. Whole-claim
// containment is checked separately so a struck fragment shorter than the
// shingle window still lands.
export function struckOverlap(text, claims, n = SHINGLE) {
  const mine = shingles(text, n);
  const flat = normalize(text);
  for (const claim of claims || []) {
    const c = normalize(claim);
    if (!c) continue;
    const cw = c.split(' ');
    if (cw.length >= 4 && cw.length < n && flat.includes(c)) return { phrase: c, claim };
    for (const sh of shingles(claim, n)) {
      if (mine.has(sh)) return { phrase: sh, claim };
    }
  }
  return null;
}

// ---------------------------------------------------------------- validation

// Errors fail the render. Warnings print and do not.
export function validateBluf(text, claims = []) {
  const errors = [];
  const warnings = [];
  const w = words(text);

  if (!String(text ?? '').trim()) errors.push('BLUF is empty.');

  if (w.length > MAX_WORDS) errors.push(`BLUF runs ${w.length} words, over the ${MAX_WORDS}-word limit.`);

  if (/—/.test(text)) errors.push('BLUF contains an em dash. Use a full stop.');

  for (const term of BANNED_JARGON) {
    if (jargonPattern(term).test(text)) errors.push(`BLUF uses banned jargon "${term}".`);
  }

  const passive = String(text).match(PASSIVE);
  if (passive) errors.push(`BLUF is passive at "${passive[0]}". Name who acts.`);

  const grade = fkGrade(text);
  if (grade != null && grade > FK_CEILING) {
    errors.push(`BLUF reads at grade ${grade}, above the ${FK_CEILING} ceiling.`);
  }
  if (grade != null && grade < FK_FLOOR) {
    warnings.push(
      `BLUF reads at grade ${grade}, below the ${FK_FLOOR} floor. Flesch-Kincaid cannot score a line this short; not treated as a failure.`
    );
  }

  const hit = struckOverlap(text, claims);
  if (hit) errors.push(`BLUF repeats a struck claim: "${hit.phrase}".`);

  return { ok: errors.length === 0, errors, warnings, grade, wordCount: w.length };
}

// ---------------------------------------------------------------- derivation

export const MISSING_VERDICT_TEXT = 'Verdict not recorded.';

// The gate whose failure decides the line, most specific first. The 'verdict'
// gate is last because it restates the verdict itself: for any PARK or REJECT
// it fails by definition, so it carries no information and can only stand in
// when nothing else failed.
const DECIDING_ORDER = ['acquittal', 'proof', 'audit', 'decision_maker', 'verdict'];

// One canned sentence per (verdict, failing gate). No field from the diagnosis
// is interpolated. See rule 1 at the top of this file.
const LINES = {
  SHIP: {
    default: 'Apply. Michael holds public, working proof that acts on the exact problem this team must solve now.',
  },
  PARK: {
    acquittal: 'Not yet. No public record shows where this company is stuck. Find that record, then look again.',
    proof: 'Not yet. Michael holds no public work that acts on this problem. Build and publish that proof first.',
    audit: 'Not yet. The review struck claims this file rests on. Rewrite them, then run the review again.',
    decision_maker: 'Not yet. No named person will read this packet. Find the hiring manager, then send it.',
    verdict: 'Not yet. The file parks this role and names no blocker. Read the file again before you act.',
  },
  REJECT: {
    acquittal: 'Skip this one. No public record shows where this company is stuck. Nobody can write an honest packet.',
    proof: 'Skip this one. Michael holds no public work that acts on the problem this team must solve.',
    audit: 'Skip this one. The review rejected this file. Its claims will not hold up for a stranger.',
    decision_maker: 'Skip this one. No named person will read this packet, and this system never invents a name.',
    verdict: 'Skip this one. The file rejects this role and names no blocker. Read the file again.',
  },
};

// The reader-facing name of the gate the line came from. Shown under the BLUF
// so the line is traceable to the thing that produced it.
const BASIS_LABEL = {
  acquittal: 'the acquittal on the evidence',
  proof: 'the proof match',
  audit: 'the audit verdict',
  decision_maker: 'the named decision-maker',
  verdict: 'the recorded verdict',
  default: 'the recorded verdict',
};

// input: { verdict, gates, struck }
//   verdict  the diagnosis verdict field, as recorded
//   gates    the clearance gate list, each { key, ok }. Comes from the caller so
//            this file never re-derives a gate and never disagrees with the page
//            it sits on top of.
//   struck   the raw strikes.struck array, for the injection check
export function deriveBluf({ verdict, gates = [], struck = [] } = {}) {
  const claims = struckClaims(struck);
  const v = String(verdict ?? '').trim().toUpperCase();

  if (!LINES[v]) {
    return {
      text: MISSING_VERDICT_TEXT,
      verdict: v || null,
      basis: 'no verdict on file',
      missingVerdict: true,
      ok: false,
      errors: [
        verdict == null || !v
          ? 'No verdict recorded on this diagnosis. The BLUF refuses to guess one.'
          : `Unrecognized verdict "${verdict}". Expected SHIP, PARK or REJECT.`,
      ],
      warnings: [],
      grade: null,
      wordCount: words(MISSING_VERDICT_TEXT).length,
    };
  }

  const failed = new Set(gates.filter((g) => g && !g.ok).map((g) => g.key));
  const decidingGate = DECIDING_ORDER.find((k) => failed.has(k)) || null;
  const table = LINES[v];
  const key = decidingGate && table[decidingGate] ? decidingGate : 'default';
  const text = table[key] || table.default || table.verdict;

  const check = validateBluf(text, claims);
  return {
    text,
    verdict: v,
    basis: BASIS_LABEL[key] || BASIS_LABEL.default,
    decidingGate: key === 'default' ? null : key,
    missingVerdict: false,
    ...check,
  };
}

// ---------------------------------------------------------------- cli

// Every diagnosis on file, its verdict, and the line it derives. Kept here
// rather than in a script so the table and the renderer cannot drift.
function gatesOf(d) {
  const dmName = String(d.decision_maker?.name ?? '');
  const dmMissing = !dmName || /INSUFFICIENT_EVIDENCE/i.test(dmName);
  const tier = d.proof_match?.tier ?? null;
  return [
    { key: 'verdict', ok: d.verdict === 'SHIP' },
    { key: 'audit', ok: d.audit?.verdict === 'PASS' },
    { key: 'acquittal', ok: d.acquittal === 'EVIDENCE_SUFFICIENT' },
    { key: 'proof', ok: tier === 'sovereign' && d.proof_match?.acts_on_constraint === true },
    { key: 'decision_maker', ok: !dmMissing },
  ];
}

function table() {
  const dir = path.join(ROOT, 'data/diagnoses');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  if (!files.length) {
    console.log('No diagnoses in data/diagnoses/.');
    return;
  }

  const rows = files.map((f) => {
    const d = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) || {};
    const b = deriveBluf({ verdict: d.verdict, gates: gatesOf(d), struck: d.strikes?.struck });
    return { company: String(d.company ?? f), verdict: b.verdict || 'ABSENT', b };
  });

  const wCo = Math.max(7, ...rows.map((r) => r.company.length));
  const wV = Math.max(7, ...rows.map((r) => r.verdict.length));
  const head = `${'COMPANY'.padEnd(wCo)}  ${'VERDICT'.padEnd(wV)}  BLUF`;
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of rows) {
    console.log(`${r.company.padEnd(wCo)}  ${r.verdict.padEnd(wV)}  ${r.b.text}`);
  }

  console.log('');
  for (const r of rows) {
    const g = r.b.grade == null ? 'n/a' : r.b.grade;
    console.log(`${r.company}: ${r.b.wordCount} words, grade ${g}, from ${r.b.basis}${r.b.ok ? '' : '  FAILED'}`);
    for (const e of r.b.errors) console.log(`   error: ${e}`);
    for (const w of r.b.warnings) console.log(`   note:  ${w}`);
  }

  const bad = rows.filter((r) => !r.b.ok);
  console.log(`\n${rows.length} diagnoses, ${rows.length - bad.length} clean, ${bad.length} failing.`);
  if (bad.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) table();
