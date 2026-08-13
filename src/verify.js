// Every token in companies.yaml is a guess until this says otherwise.
//
// A wrong slug returns zero jobs and looks identical to a company that is not
// hiring. That is a silent failure, and silent failures are how a search spends
// three weeks concluding the market is dead. Run this first, and after any edit.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fetchBoard } from './sources.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const registry = yaml.load(fs.readFileSync(path.join(ROOT, 'profile/companies.yaml'), 'utf8'));

const targets = [];
for (const [archetype, block] of Object.entries(registry.archetypes)) {
  for (const c of block.companies) targets.push({ ...c, archetype });
}

const results = [];
for (const t of targets) {
  try {
    const jobs = await fetchBoard(t);
    const status = jobs.length ? 'OK' : 'EMPTY';
    results.push({ ...t, status, count: jobs.length });
    console.log(`${status.padEnd(7)} ${t.name.padEnd(22)} ${t.ats}/${t.token}  ${jobs.length} jobs`);
  } catch (e) {
    results.push({ ...t, status: 'FAIL', error: e.message });
    console.log(`FAIL    ${t.name.padEnd(22)} ${t.ats}/${t.token}  ${e.message}`);
  }
}

fs.writeFileSync(
  path.join(ROOT, 'data/token-verification.json'),
  JSON.stringify(results, null, 2) + '\n'
);

const bad = results.filter((r) => r.status !== 'OK');
console.log(`\n${results.length - bad.length}/${results.length} tokens resolve.`);
if (bad.length) {
  console.log('\nFix these in profile/companies.yaml before scanning:');
  for (const b of bad) console.log(`  ${b.name}: ${b.status}  (${b.ats}/${b.token})`);
  console.log('\nEMPTY may mean the token is right and they are not hiring. Open the');
  console.log('careers page and confirm. FAIL means the token is wrong.');
}
