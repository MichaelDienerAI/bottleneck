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
import { gate0, rank, capPerCompany, fitScore, archetypeFloor, compositeScore } from './gates.js';
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
  const freshKeys = new Set(fresh.map((j) => j.key));

  // Gate EVERY row currently on the boards, not just the new ones.
  //
  // candidates.json and killed.json are a snapshot of what is out there right
  // now. They used to be a delta of what arrived since the last run, which meant
  // a quiet run overwrote them with almost nothing and the board reported "1
  // jobs" — measured 2026-08-12, when Scale AI posted a single row between two
  // scans three minutes apart. Dedupe exists to stop the QUEUE re-promoting a row
  // you already saw. It was never supposed to decide what the status page knows.
  //
  // Costs nothing: gate0 is regex over already-fetched strings, no extra network.
  const gated = [];
  const killed = [];

  for (const j of all) {
    const g = gate0(j, cfg);
    const row = { ...j, comp: g.comp, flags: g.flags };
    // Fit travels with the row so the buffer can be audited without re-deriving
    // the sort. Same function rank() uses, so the two cannot drift apart.
    row.fit = fitScore(row, cfg);
    if (g.pass) gated.push(row);
    // The kill log carries enough to audit itself. Storing key/company/title
    // alone meant checking a rejection required re-fetching the board, so the
    // 2026-08-12 audit of the title gate could not be done from the file it was
    // supposed to be done from. A gate you cannot inspect is a gate you do not
    // control. Excerpt is capped because the reason lives in the title far more
    // often than the body.
    else
      killed.push({
        key: j.key,
        company: j.company,
        title: j.title,
        url: j.url,
        location: j.location,
        excerpt: j.description.slice(0, 300),
        reasons: g.reasons,
      });
  }

  // Full current-board snapshot, for the board and the kill audit.
  const ranked = rank(gated, weights, cfg);

  // Promotion draws only from rows never seen before. Behaviour is unchanged
  // here on purpose: a row you have already declined should not reappear in the
  // buffer just because a later scan re-read the same posting.
  const rankedFresh = rank(gated.filter((j) => freshKeys.has(j.key)), weights, cfg);

  // Case-file gate. A company already killed, shipped, or cooling never consumes
  // a slot again. Without this the pipeline reopens closed cases forever.
  const skipped = [];
  const eligible = rankedFresh.filter((j) => {
    const s = shouldSkip(j.company);
    if (s.skip) skipped.push({ company: j.company, reason: s.reason });
    return !s.skip;
  });

  // Per-company cap, last thing before promotion. Without it a single large
  // board can take every slot in the buffer regardless of archetype weight.
  const perCompanyMax = cfg.drum?.max_per_company ?? 2;
  const capped = capPerCompany(eligible, perCompanyMax);
  const crowdedOut = eligible.length - capped.length;

  // Per-archetype floor before the score fills the rest, then re-rank so the
  // buffer still reads in priority order.
  const room = Math.min(bufferMax, slots + 5);
  const promote = rank(archetypeFloor(capped, room), weights, cfg);
  for (const j of promote) j.score = Number(compositeScore(j, weights, cfg).toFixed(2));

  const existingQueue = loadJson('data/queue.json', []);
  const queue = [...existingQueue, ...promote].slice(0, bufferMax);

  // The snapshot is now always current, so there is nothing to preserve and no
  // stale-data warning to raise. What is still worth recording is whether the
  // boards moved: "nothing new since Friday" is real information, it just is not
  // a reason to distrust the counts.
  //
  // Local date, not toISOString(). A run at 23:04 in Phoenix is 06:04 UTC the
  // next day, and a board stamped tomorrow is a board nobody trusts.
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const prevMeta = loadJson('data/scan-meta.json', {});
  const meta = {
    last_run_at: today,
    last_new_rows_at: fresh.length ? today : prevMeta.last_new_rows_at ?? null,
    last_run_new_rows: fresh.length,
    fetched: all.length,
    passed: ranked.length,
    killed: killed.length,
  };

  writeJson('data/candidates.json', ranked);
  writeJson('data/killed.json', killed);
  writeJson('data/skipped-cases.json', skipped);
  writeJson('data/queue.json', queue);
  writeJson('data/scan-errors.json', errors);
  writeJson('data/scan-meta.json', meta);
  writeJson('data/seen.json', [...seen, ...fresh.map((j) => j.key)]);

  console.log('');
  console.log(`fetched      ${all.length}`);
  console.log(`new          ${fresh.length}   (new rows feed the queue; the counts below are the whole board)`);
  console.log(`passed gate0 ${gated.length}`);
  console.log(`killed       ${killed.length}   see data/killed.json`);
  console.log(`closed cases ${skipped.length}   see data/skipped-cases.json`);
  console.log(`company cap  ${crowdedOut} rows held back at ${perCompanyMax}/company`);
  console.log(`promoted     ${promote.length}  buffer now ${queue.length}/${bufferMax}`);
  // Archetype spread is now a designed property, so it is reported, not assumed.
  const spread = {};
  for (const j of queue) spread[j.archetype] = (spread[j.archetype] || 0) + 1;
  console.log(
    `buffer spread ${Object.entries(spread).map(([a, n]) => `${a} ${n}`).join(', ')}`
  );
  console.log(`open slots   ${slots}`);
  if (!fresh.length) {
    console.log('');
    console.log(`No new postings since ${meta.last_new_rows_at ?? 'an earlier run'}. The counts above are still`);
    console.log('the live board, not a leftover: every fetched row is gated every run.');
  }
  if (errors.length) console.log(`board errors ${errors.length}  run node src/verify.js`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
