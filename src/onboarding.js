// Candidate onboarding. Unstructured achievements in, proof units out, and most
// of what goes in does not come out.
//
//   npm run onboard -- --file achievements.md
//   pbpaste | npm run onboard -- --dry
//
// A resume bullet and a proof unit are different objects. "Drove significant
// improvements to platform reliability" is a bullet: it has a subject, a verb,
// and nothing a stranger can check. A proof unit is a claim, an address, and a
// measured change. The gap between those two is where most of a candidate's
// self-description lives, and the useful thing this module does is refuse to
// carry it across.
//
// THREE REFUSALS AT THE INTAKE BOUNDARY, and all three are the same refusal in
// different clothes: a claim with no inspectable source is not a finding (P2).
//
//   NO URL          a claim nobody can open is a claim about the candidate
//   NO METRIC       "improved" without a from and a to is a direction, not a delta
//   UNFALSIFIABLE   nothing in the sentence could turn out to be wrong
//
// WHAT IT WRITES, AND WHERE. Parsed units land in the SPECULATIVE half of
// profile/proof-ledger.yaml, never the sovereign half, and the CLI will not
// promote them. The ledger's own distinction is that a sovereign proof is
// deployed and inspectable by a stranger; a unit that a parser derived from
// something the candidate wrote about themselves is the definition of the other
// thing. Promotion is a human act performed after opening the URL.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '..');

// CLAUDE.md bans these outright, in any generated artifact.
const BANNED = [
  /\bleverag(e|es|ed|ing)\b/i,
  /\bsynerg/i,
  /\boptimiz/i,
  /\bbest practices\b/i,
  /\bmove the needle\b/i,
];

// Words that describe the candidate's feeling about the work rather than the
// work. Each one can be deleted without changing what a stranger could check,
// which is the test for whether it was carrying information.
const HYPE = [
  /\b(significant|significantly|substantial|substantially|dramatic|dramatically)\b/i,
  /\b(seamless|robust|scalable|cutting[- ]edge|state[- ]of[- ]the[- ]art|world[- ]class|best[- ]in[- ]class)\b/i,
  /\b(spearhead|championed|drove|drove significant|owned end[- ]to[- ]end|passionate|proven track record)\b/i,
  /\b(highly|extremely|incredibly|deeply|strongly)\s+\w+/i,
  /\b(innovative|transformative|game[- ]chang\w+|revolutionary|next[- ]generation)\b/i,
  /\b(utiliz(e|es|ed|ing|ation)|holistic|mission[- ]critical|stakeholder|deep dive|streamlin\w+)\b/i,
];

// A metric delta is a measured change: a from and a to, a percentage, a
// multiplier, a count against a unit, or an absolute with a unit attached.
const METRIC = [
  /\bfrom\s+[\d.,]+\s*\w*\s+to\s+[\d.,]+\s*\w*/i,
  /\b\d+(\.\d+)?\s*%/,
  /\b\d+(\.\d+)?\s*x\b/i,
  /\b\d[\d,.]*\s*(ms|s|sec|seconds?|min|minutes?|hours?|days?|weeks?|months?)\b/i,
  /\b\d[\d,.]*\s*(requests?|users?|rows?|tests?|assertions?|commits?|issues?|calls?|records?|packets?|queries)\b/i,
  /\b(reduced|cut|raised|grew|fell|rose|dropped)\b[^.]{0,40}\b\d/i,
];

// Something in the sentence has to be capable of turning out false: a number, a
// date, or a named artifact a stranger could go and look at.
const FALSIFIABLE = [/\b\d/, /\b\d{4}-\d{2}-\d{2}\b/, /https?:\/\/\S+/];

const URL_RE = /https?:\/\/[^\s)<>\]]+/;

export const slugify = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);

// Splits raw text into candidate lines. Markdown bullets, numbered lists, and
// bare paragraphs all count; a heading names the domain for everything under it.
export function segment(raw) {
  const out = [];
  let domain = null;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const h = t.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      domain = h[1].trim();
      continue;
    }
    const item = t.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    out.push({ text: (item ? item[1] : t).trim(), domain });
  }
  return out;
}

// One line, judged. Returns the unit or the reasons it was refused — never a
// repaired version, because a parser that rewrites a claim to make it pass has
// authored a claim nobody made.
export function parseUnit({ text, domain }, { index = 0 } = {}) {
  const reasons = [];
  const claim = String(text ?? '').trim();

  const url = (claim.match(URL_RE) || [null])[0];
  const prose = claim.replace(URL_RE, '').replace(/\s{2,}/g, ' ').trim();

  if (!url) {
    reasons.push('no backstage_url. MISSING RECORD: an address a stranger can open without contacting the candidate.');
  }

  const metric = METRIC.some((re) => re.test(prose));
  if (!metric) {
    reasons.push('no metric_delta. A direction is not a measurement: name the from and the to, or the count and the unit.');
  }

  for (const re of BANNED) {
    const m = prose.match(re);
    if (m) reasons.push(`banned vocabulary "${m[0]}". CLAUDE.md rules it out of every generated artifact.`);
  }

  const hype = HYPE.map((re) => (prose.match(re) || [])[0]).filter(Boolean);
  for (const h of hype) {
    reasons.push(`unfalsifiable qualifier "${h}". Delete it and the claim says the same checkable thing, which is the test.`);
  }

  if (!FALSIFIABLE.some((re) => re.test(claim))) {
    reasons.push('nothing here could turn out to be wrong. A proof unit needs a number, a date, or a named artifact.');
  }

  if (reasons.length) return { ok: false, reasons, claim };

  return {
    ok: true,
    reasons: [],
    unit: {
      id: slugify(prose.split(/[.,:;]/)[0]) || `unit_${index + 1}`,
      domain: domain || 'unspecified',
      claim: prose,
      backstage_url: url,
      metric_delta: (METRIC.map((re) => (prose.match(re) || [])[0]).filter(Boolean)[0] || '').trim(),
    },
  };
}

// The whole intake. Accepted and rejected are both returned: a run that silently
// dropped eleven of twelve bullets would look like a thin resume rather than a
// strict boundary, and those are different findings.
export function onboard(raw) {
  const segments = segment(raw);
  const accepted = [];
  const rejected = [];

  segments.forEach((s, i) => {
    const r = parseUnit(s, { index: i });
    if (r.ok) accepted.push(r.unit);
    else rejected.push({ claim: r.claim, reasons: r.reasons });
  });

  // Two bullets about the same artifact with the same slug would collide in the
  // ledger, and the second would silently replace the first.
  const seen = new Map();
  for (const u of accepted) {
    const n = (seen.get(u.id) || 0) + 1;
    seen.set(u.id, n);
    if (n > 1) u.id = `${u.id}_${n}`;
  }

  return {
    accepted,
    rejected,
    read: segments.length,
    ok: accepted.length > 0,
  };
}

// Merges into the speculative half. Never the sovereign half, and never
// in-place: an existing entry with the same id is left alone and reported, so a
// re-run cannot overwrite a unit a human has since edited.
export function mergeIntoLedger(ledger, units) {
  const next = { ...ledger, speculative: [...(ledger?.speculative || [])] };
  const have = new Set(next.speculative.map((e) => e.id));
  const added = [];
  const skipped = [];
  for (const u of units) {
    if (have.has(u.id)) skipped.push(u.id);
    else {
      next.speculative.push({ ...u, source: 'onboarding', promoted: false });
      added.push(u.id);
    }
  }
  return { ledger: next, added, skipped };
}

// ---------------------------------------------------------------- cli

const readStdin = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => resolve(d));
  });

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const file = flag('--file');
  const dry = argv.includes('--dry');
  const raw = file ? fs.readFileSync(path.resolve(ROOT, file), 'utf8') : await readStdin();

  if (!String(raw).trim()) {
    console.error('onboard: no input. Pipe achievements in on stdin or pass --file.');
    console.error('usage: pbpaste | npm run onboard -- --dry');
    process.exit(2);
  }

  const r = onboard(raw);
  console.log(`Read ${r.read} line${r.read === 1 ? '' : 's'} · ${r.accepted.length} accepted · ${r.rejected.length} refused`);
  console.log('');

  for (const u of r.accepted) {
    console.log(`  ok   ${u.id}  [${u.domain}]`);
    console.log(`       ${u.claim.slice(0, 96)}`);
    console.log(`       ${u.backstage_url}  ·  delta: ${u.metric_delta || '(none captured)'}`);
  }
  for (const x of r.rejected) {
    console.log(`  REFUSED  ${x.claim.slice(0, 90)}`);
    for (const reason of x.reasons) console.log(`           ${reason}`);
  }

  // Fail closed. A candidate with zero admissible proof units is a finding, and
  // an exit code of 0 would let a caller treat an empty ledger as a full one.
  if (!r.ok) {
    console.log('');
    console.error('onboard: no admissible proof units. Nothing written.');
    console.error('  That is a finding rather than an error: what the candidate wrote is not yet inspectable by a stranger.');
    process.exit(1);
  }

  if (dry) {
    console.log('');
    console.log('--dry: profile/proof-ledger.yaml was not written.');
    return;
  }

  const ledgerPath = path.join(ROOT, 'profile/proof-ledger.yaml');
  const ledger = yaml.load(fs.readFileSync(ledgerPath, 'utf8'));
  const merged = mergeIntoLedger(ledger, r.accepted);

  const tmp = `${ledgerPath}.tmp`;
  fs.writeFileSync(tmp, yaml.dump(merged.ledger, { lineWidth: 100 }));
  fs.renameSync(tmp, ledgerPath);

  console.log('');
  console.log(`Wrote ${merged.added.length} unit(s) into the SPECULATIVE half of profile/proof-ledger.yaml.`);
  if (merged.skipped.length) console.log(`  left alone, already present: ${merged.skipped.join(', ')}`);
  console.log('  Nothing was promoted to sovereign. A sovereign proof is one a stranger can open,');
  console.log('  and deciding that a URL actually shows what the claim says is a human act.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    console.error(`onboard: ${e.message}`);
    process.exit(1);
  });
}
