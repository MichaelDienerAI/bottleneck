// Sourcing stage. Subordinated to the drum by design.
//
// It fetches every board, gates deterministically, dedupes against what it has
// already seen, and then promotes only as many rows as the buffer allows. If the
// buffer is full it stops and says so. Filling a queue nobody can process is the
// job-search version of building inventory in front of a bottleneck.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fetchBoard } from './sources.js';
import { gate0, rank, capPerCompany } from './gates.js';
import { openSlots } from './ledger.js';
import { shouldSkip } from './casefile.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => yaml.load(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const writeJson = (p, v) =>
  fs.writeFileSync(path.join(ROOT, p), JSON.stringify(v, null, 2) + '\n');

function loadJson(p, fallback) {
  const full = path.join(ROOT, p);
  return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : fallback;
}

async function main() {
  const gatesPath = fs.existsSync(path.join(ROOT, 'profile/gates.yaml'))
    ? 'profile/gates.yaml'
    : 'profile/gates.example.yaml';
  const cfg = read(gatesPath);
  const registry = read('profile/companies.yaml');

  const weights = {};
  const targets = [];
  for (const [archetype, block] of Object.entries(registry.archetypes)) {
    weights[archetype] = block.weight;
    for (const c of block.companies) targets.push({ ...c, archetype });
  }

  const slots = openSlots(ROOT, cfg);
  const bufferMax = cfg.drum?.buffer_max ?? 10;
  if (slots <= 0) {
    console.log('Drum full. No open packet slots this week. Sourcing suspended.');
    console.log('This is the system working. Go build the packets you already have queued.');
    return;
  }

  const seen = new Set(loadJson('data/seen.json', []));
  const errors = [];
  const all = [];

  for (const t of targets) {
    try {
      const jobs = await fetchBoard(t);
      all.push(...jobs);
      process.stdout.write(`${t.name}: ${jobs.length}\n`);
    } catch (e) {
      errors.push({ company: t.name, ats: t.ats, token: t.token, error: e.message });
      process.stdout.write(`${t.name}: FAILED ${e.message}\n`);
    }
  }

  const fresh = all.filter((j) => !seen.has(j.key));
  const gated = [];
  const killed = [];

  for (const j of fresh) {
    const g = gate0(j, cfg);
    const row = { ...j, comp: g.comp, flags: g.flags };
    if (g.pass) gated.push(row);
    else killed.push({ key: j.key, company: j.company, title: j.title, reasons: g.reasons });
  }

  const ranked = rank(gated, weights);

  // Case-file gate. A company already killed, shipped, or cooling never consumes
  // a slot again. Without this the pipeline reopens closed cases forever.
  const skipped = [];
  const eligible = ranked.filter((j) => {
    const s = shouldSkip(j.company);
    if (s.skip) skipped.push({ company: j.company, reason: s.reason });
    return !s.skip;
  });

  // Per-company cap, last thing before promotion. Without it a single large
  // board can take every slot in the buffer regardless of archetype weight.
  const perCompanyMax = cfg.drum?.max_per_company ?? 2;
  const capped = capPerCompany(eligible, perCompanyMax);
  const crowdedOut = eligible.length - capped.length;

  const promote = capped.slice(0, Math.min(bufferMax, slots + 5));

  const existingQueue = loadJson('data/queue.json', []);
  const queue = [...existingQueue, ...promote].slice(0, bufferMax);

  writeJson('data/candidates.json', ranked);
  writeJson('data/skipped-cases.json', skipped);
  writeJson('data/queue.json', queue);
  writeJson('data/scan-errors.json', errors);
  writeJson('data/killed.json', killed);
  writeJson('data/seen.json', [...seen, ...fresh.map((j) => j.key)]);

  console.log('');
  console.log(`fetched      ${all.length}`);
  console.log(`new          ${fresh.length}`);
  console.log(`passed gate0 ${gated.length}`);
  console.log(`killed       ${killed.length}   see data/killed.json`);
  console.log(`closed cases ${skipped.length}   see data/skipped-cases.json`);
  console.log(`company cap  ${crowdedOut} rows held back at ${perCompanyMax}/company`);
  console.log(`promoted     ${promote.length}  buffer now ${queue.length}/${bufferMax}`);
  console.log(`open slots   ${slots}`);
  if (errors.length) console.log(`board errors ${errors.length}  run node src/verify.js`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
