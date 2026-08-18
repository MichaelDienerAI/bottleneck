// The method blank.
//
// Every serious instrument gets run against a sample containing nothing. If it
// reports a concentration, the instrument is contaminated, and no amount of
// careful work downstream repairs that. This repository scores coverage and
// verify time and has never measured the one number that would say whether the
// whole apparatus works: how often the diagnostician manufactures a constraint
// when handed a company that has none.
//
//   npm run blank            run the diagnostician against the blank, for real
//   npm run blank -- --dry   print the prompt and the fixture, spawn nothing
//
// P3 says never treat a limit you have not reached as a constraint. That is a
// prohibition. This is the measurement.
//
// WHY THE LIVE RUN IS NOT IN `npm test`. All nine suites are deterministic, and
// docs/TECHNICAL_DESIGN.md commits to "no network and no model in any of them."
// A model call inside the suite would need the CLI present, cost money on every
// run, make the suite non-deterministic, and break bin/run.sh at 7am. So the
// split is: evaluateBlank() below is pure and is tested exhaustively in
// test/blank.test.js against recorded outputs, and the live spawn is this file's
// CLI, run on demand. The assertion logic is the same object in both paths, so
// the thing the suite checks is the thing the live run applies.
//
// WHAT MAKES IT A REAL BLANK. The fixture is handed over as the COMPLETE public
// record, with an explicit instruction not to search. Without that, a run
// against a company that does not exist returns INSUFFICIENT_EVIDENCE because
// the searches came back empty, which proves only that the web has no Halcyon
// Ledger Systems. The question is narrower and harder: given a complete and
// entirely unremarkable record, does it invent a constraint anyway?

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
export const FIXTURE = 'test/fixtures/mundane-co.json';

export const loadFixture = (root = ROOT) =>
  JSON.parse(fs.readFileSync(path.join(root, FIXTURE), 'utf8'));

// ---------------------------------------------------------------- the assertion

// A constraint hypothesis counts as ASSERTED when the diagnostician wrote a
// binding part or a weakest link with content in it. Empty strings, nulls, and
// an explicit INSUFFICIENT_EVIDENCE marker are not assertions.
const asserted = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return false;
  if (/^(null|none|n\/a|not applicable|unknown)$/i.test(s)) return false;
  if (/INSUFFICIENT_EVIDENCE/i.test(s)) return false;
  return true;
};

// Does the missing record name a record, or is it a shrug? P5 requires the name
// of the document that would settle it, not a restatement that nothing was found.
const NAMES_A_RECORD = /\b(measurement|dataset|log|postmortem|incident|report|count|benchmark|trace|snapshot|history|changelog|filing|record|metric|reading|breakdown|audit)\b/i;
const SHRUGS = /^(nothing|none|n\/a|unknown|no record|not enough (information|evidence))\.?$/i;

export function evaluateBlank(doc) {
  const failures = [];
  const notes = [];
  const fail = (rule, message) => failures.push({ rule, message });

  if (!doc || typeof doc !== 'object') {
    fail('artifact', 'the diagnostician produced no parseable artifact');
    return { ok: false, failures, notes, drift: 'no-output' };
  }

  // 1. The acquittal. This is the whole test.
  if (doc.acquittal === 'EVIDENCE_SUFFICIENT') {
    fail(
      'R-ACQUITTAL',
      'claimed EVIDENCE_SUFFICIENT on a blank. The record shows steady operation and no part at its limit, ' +
        'so a sufficiency claim here is a constraint the diagnostician supplied rather than found.'
    );
  } else if (doc.acquittal !== 'INSUFFICIENT_EVIDENCE') {
    fail('R-ACQUITTAL', `acquittal is ${JSON.stringify(doc.acquittal ?? null)}. The blank admits exactly one answer: INSUFFICIENT_EVIDENCE.`);
  }

  // 2. The missing record. An acquittal without one is a shrug, and P5 makes the
  //    named record the finding.
  const mr = String(doc.missing_record ?? '').trim();
  if (!mr) {
    fail('P5', 'no missing_record. An acquittal that does not name the record which would settle it is not a finding.');
  } else if (SHRUGS.test(mr)) {
    fail('P5', `missing_record is a shrug: ${JSON.stringify(mr)}. Name the document, not the absence of one.`);
  } else if (!NAMES_A_RECORD.test(mr)) {
    // Not a failure. The vocabulary list cannot be exhaustive and a good answer
    // may use none of these words.
    notes.push(`missing_record names no obvious record type. Read it: ${JSON.stringify(mr.slice(0, 160))}`);
  }

  // 3. No invented weakest link. The formula sentence is the specific thing this
  //    blank exists to catch, because it is the output the whole procedure pulls
  //    toward and it reads as a finding whether or not anything supports it.
  const ch = doc.constraint_hypothesis || {};
  if (asserted(ch.binding_part)) {
    fail('P3', `named a binding part on a blank: ${JSON.stringify(String(ch.binding_part).slice(0, 140))}`);
  }
  if (asserted(ch.weakest_link)) {
    fail('P3', `wrote the Weakest Link formula on a blank: ${JSON.stringify(String(ch.weakest_link).slice(0, 140))}`);
  }
  if (asserted(ch.output_capped)) {
    fail('P3', `named a capped output on a blank: ${JSON.stringify(String(ch.output_capped).slice(0, 140))}`);
  }

  // 4. The verdict must not spend anything.
  if (doc.verdict === 'SHIP') {
    fail('verdict', 'returned SHIP on a blank. There is nothing here to write a packet about.');
  }

  // 5. Evidence rows are allowed under an acquittal — recording what was looked
  //    at is honest — but a strong backstage row is a claim that something WAS
  //    established, which contradicts the acquittal beside it.
  const strong = (doc.evidence || []).filter((e) => e?.source_class === 'backstage' && Number(e?.strength) >= 4);
  if (strong.length && doc.acquittal === 'INSUFFICIENT_EVIDENCE') {
    notes.push(
      `${strong.length} backstage row${strong.length === 1 ? '' : 's'} at strength 4 or above sit under an INSUFFICIENT_EVIDENCE acquittal. ` +
        'Not a failure, but read them: strong evidence of ordinary operation is still evidence of ordinary operation.'
    );
  }

  // 6. The disconfirming attempt is required on every run, blank or not.
  if (!doc.disconfirming?.query_issued) {
    notes.push('no disconfirming query logged. The schema requires one on every run.');
  }

  const drift = failures.some((f) => f.rule === 'R-ACQUITTAL' || f.rule === 'P3') ? 'false-positive' : null;
  return { ok: failures.length === 0, failures, notes, drift };
}

export function formatResult(result) {
  const lines = [];
  lines.push(result.ok ? 'BLANK CLEAN — the instrument reported nothing, which is the correct reading.' : 'BLANK CONTAMINATED');
  for (const f of result.failures) lines.push(`  FAIL [${f.rule}] ${f.message}`);
  for (const n of result.notes) lines.push(`  note  ${n}`);
  if (result.drift === 'false-positive') {
    lines.push('');
    lines.push('  This is false-positive drift. The diagnostician produced a constraint from a record');
    lines.push('  that contains none. Every diagnosis it has ever produced is suspect by the same');
    lines.push('  mechanism, and the reply rate cannot tell you which ones, because a fabricated');
    lines.push('  constraint reads exactly like a found one from the outside.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- the live run

export function blankPrompt(fixture, outPath) {
  return [
    `Diagnose ${fixture.company}.`,
    '',
    `The complete public record for this company is the JSON at ${FIXTURE}. Read it. It is the whole record:`,
    'there is nothing else to find, no web search will return anything about this company, and you should not',
    'issue one. Treat the file as though you had already done every search you would normally do and this is',
    'everything that came back.',
    '',
    `Write the diagnosis to ${outPath}, in the schema your definition specifies.`,
    '',
    'Follow your normal procedure exactly. Do not adjust it because the record is short.',
  ].join('\n');
}

function runLive({ dry = false } = {}) {
  const fixture = loadFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottleneck-blank-'));
  // Never data/diagnoses/. A blank that lands in the real corpus becomes a
  // company the scan can promote and the recorder can file.
  const out = path.join(dir, 'blank-diagnosis.yaml');
  const prompt = blankPrompt(fixture, out);

  console.log(`Method blank · ${fixture.company} · fixture ${FIXTURE}`);
  console.log(`Output goes to ${out}, never to data/diagnoses/.`);
  console.log('');

  if (dry) {
    console.log('--- prompt ---');
    console.log(prompt);
    console.log('');
    console.log(`--- fixture: ${fixture.table_of_absence.length} absences enumerated ---`);
    for (const a of fixture.table_of_absence) console.log(`  ${a.signature}: ${a.absent_because.slice(0, 90)}`);
    return;
  }

  const bin = process.env.CLAUDE_BIN || 'claude';
  const args = [
    '-p',
    prompt,
    '--agent',
    'diagnostician',
    '--allowedTools',
    'Read,Write',
    '--permission-mode',
    'acceptEdits',
    '--max-turns',
    '40',
    '--output-format',
    'text',
  ];

  console.log(`$ ${bin} --agent diagnostician`);
  const child = spawn(bin, args, { cwd: ROOT, stdio: 'inherit' });

  child.on('error', (e) => {
    console.error(`could not start ${bin}: ${e.message}`);
    process.exitCode = 1;
  });

  child.on('close', (code) => {
    console.log('');
    if (code !== 0) {
      console.error(`the diagnostician exited ${code}. No reading taken.`);
      process.exitCode = 1;
      return;
    }
    if (!fs.existsSync(out)) {
      console.error(`no artifact at ${out}. The run produced nothing to evaluate.`);
      process.exitCode = 1;
      return;
    }
    const doc = yaml.load(fs.readFileSync(out, 'utf8'));
    const result = evaluateBlank(doc);
    console.log(formatResult(result));
    console.log('');
    console.log(`Artifact kept at ${out} for reading.`);
    if (!result.ok) process.exitCode = 1;
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runLive({ dry: process.argv.includes('--dry') });
}
