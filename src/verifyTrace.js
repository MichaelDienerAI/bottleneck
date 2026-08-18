// npm run verify-trace <company>
//
// Opens every citation in a diagnosis and times it. Network, so it is not part
// of `npm test` — the suite is deterministic and stays that way. The rule it
// applies is pure and lives in src/utils/latencyGuard.js, where it is tested.
//
// What comes back is mostly one thing worth having: whether the citations still
// resolve. A diagnosis is a set of claims plus the URLs a stranger opens to check
// them, and a URL that 404s six weeks later turns a checkable claim into an
// assertion without anybody editing a word of it.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { resolveDiagnosis } from './casefile.js';
import { calibrateRows, summarize, DEFAULT_FACTOR } from './utils/latencyGuard.js';
import { pramanaOf } from './utils/schemaValidator.js';

const ROOT = path.resolve(import.meta.dirname, '..');

async function main() {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('usage: node src/verifyTrace.js <company | data/diagnoses/x.yaml> [--factor 3]');
    process.exit(2);
  }
  const fi = argv.indexOf('--factor');
  const factor = fi >= 0 && argv[fi + 1] ? Number(argv[fi + 1]) : DEFAULT_FACTOR;

  const file = resolveDiagnosis(target, ROOT);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const rows = [...(doc.evidence || []), ...(doc.audit?.auditor_evidence || [])];

  console.log(`Trace latency · ${doc.company} · ${path.relative(ROOT, file)}`);
  console.log(`${rows.length} citations, floor factor ${factor}x`);
  console.log('');
  console.log('A fetch measures time to response. verify_seconds measures time to a satisfied stranger.');
  console.log('The first is a floor on the second and no more than that, so this can prove a number');
  console.log('impossible and can prove a citation dead. It cannot prove a number right.');
  console.log('');

  const results = await calibrateRows(rows, { factor });

  for (const [i, r] of results.entries()) {
    const { pramana, declared } = pramanaOf(r.row);
    const tag = r.finding.ok ? (r.finding.state === 'tight' ? 'TIGHT' : 'ok   ') : 'FAIL ';
    console.log(`${tag} ${String(i + 1).padStart(2)}  ${pramana}${declared ? '' : ' (derived)'}`);
    console.log(`        ${String(r.row.claim ?? '').replace(/\s+/g, ' ').slice(0, 88)}`);
    console.log(`        ${r.row.inspectable_at ?? 'no url'}`);
    console.log(`        ${r.finding.message}`);
  }

  const s = summarize(results);
  console.log('');
  console.log(
    `${s.total} traces · ${s.unreachable} unreachable · ${s.impossible} impossible · ${s.tight} inside ${factor}x of the floor`
  );
  if (!s.ok) {
    console.log('');
    console.log('A failing trace does not mean the claim is false. It means a stranger cannot check it,');
    console.log('which under P2 is the same as not having it. Re-cite or drop the row.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    console.error(`verify-trace: ${e.message}`);
    process.exit(1);
  });
}
