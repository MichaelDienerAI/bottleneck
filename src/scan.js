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
import {
  gate0,
  rank,
  capPerCompany,
  fitScore,
  archetypeFloor,
  compositeScore,
  repostFlag,
  updateRepostIndex,
  REPOST_MIN_AGE_DAYS,
  MAX_AGE_DAYS,
} from './gates.js';
import { openSlots } from './ledger.js';
import { shouldSkip } from './casefile.js';
import { delisted, unverifiable, checkUrls } from './liveness.js';

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

  // Local date, not toISOString(). A run at 23:04 in Phoenix is 06:04 UTC the
  // next day, and a board stamped tomorrow is a board nobody trusts.
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Repost index, read before it is written. Keyed by (company, normalized
  // title) rather than by board id, because a reposted requisition gets a new id
  // and key equality can never catch one. See the note above repostFlag().
  const repostIndex = loadJson('data/reposts.json', {});
  const repostIndexWasEmpty = Object.keys(repostIndex).length === 0;
  const repostMinAge = cfg.freshness?.repost_min_age_days ?? REPOST_MIN_AGE_DAYS;

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
    // Computed against the prior index and appended rather than returned by
    // gate0, because gate0 is a pure function of one posting and this rule needs
    // scan history. Informational: it is not in BLOCKING_FLAGS, so it costs no
    // fit point and vetoes nothing.
    const repost = repostFlag(j, repostIndex, { minAgeDays: repostMinAge, now: new Date() });
    const row = { ...j, comp: g.comp, flags: repost ? [...g.flags, repost] : g.flags };
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

  // Reported separately because it is the largest single kill class on these
  // boards and a 40% drop in the pool should never look like a fetch problem.
  const staleKills = killed.filter((k) => k.reasons.some((r) => r.startsWith('stale:')));

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

  // Liveness. The buffer used to be append-only: `[...existingQueue, ...promote]`
  // with no exit except promotion off the top. A req that came down the day after
  // it was promoted stayed in front of the drum indefinitely and looked identical
  // to a live one, because nothing ever re-checked it. Gate 0 could not catch it
  // either — the row is fresh, it is just closed.
  //
  // The check is feed membership, and it costs nothing because every board was
  // already fetched above. A company whose fetch FAILED this run is excluded:
  // an empty result from a 500 is not evidence that a company closed its reqs.
  const liveKeys = new Set(all.map((j) => j.key));
  const failedCompanies = new Set(errors.map((e) => e.company));
  const verifiable = new Set(targets.map((t) => t.name).filter((n) => !failedCompanies.has(n)));

  const existingQueue = loadJson('data/queue.json', []);
  const gone = delisted(existingQueue, liveKeys, verifiable).map((r) => ({
    ...r,
    delisted_at: today,
    delisted_reason: `absent from the ${r.source} board feed on ${today}`,
  }));
  const goneKeys = new Set(gone.map((r) => r.key));
  const held = existingQueue.filter((r) => !goneKeys.has(r.key));

  // Rows whose board did not answer keep their previous confirmation date rather
  // than being re-stamped by a run that confirmed nothing about them.
  const unconfirmed = unverifiable(held, verifiable);
  const stamp = (r) =>
    verifiable.has(r.company) && liveKeys.has(r.key)
      ? { ...r, verified_live_at: today, verified_via: `${r.source} board api` }
      : r;

  let queue = [...held, ...promote].map(stamp).slice(0, bufferMax);

  // Second, weaker check: HTTP status on the buffer rows only, ten requests at
  // most. Only 404/410 removes a row — see the note at the top of liveness.js on
  // why a 200 is not evidence the req is open. A removed row is not backfilled
  // from the rows that missed the slice; the next scan refills the buffer, and
  // silently promoting an unchecked row in a dead row's place would defeat the
  // point of having checked.
  let urlChecks = [];
  if (cfg.freshness?.verify_queue_urls !== false && queue.length) {
    urlChecks = (await checkUrls(queue)).map((c) => ({ ...c, checked_at: today }));
    const byKey = new Map(urlChecks.map((c) => [c.key, c]));
    const dead = queue.filter((r) => byKey.get(r.key)?.verdict === 'gone');
    for (const r of dead) {
      gone.push({
        ...r,
        delisted_at: today,
        delisted_reason: `posting url returned HTTP ${byKey.get(r.key).status} on ${today}`,
      });
      goneKeys.add(r.key);
    }
    queue = queue
      .filter((r) => !goneKeys.has(r.key))
      .map((r) => {
        const c = byKey.get(r.key);
        return c ? { ...r, url_check: { verdict: c.verdict, status: c.status, at: today } } : r;
      });
  }

  // The snapshot is now always current, so there is nothing to preserve and no
  // stale-data warning to raise. What is still worth recording is whether the
  // boards moved: "nothing new since Friday" is real information, it just is not
  // a reason to distrust the counts.
  const prevMeta = loadJson('data/scan-meta.json', {});
  const meta = {
    last_run_at: today,
    last_new_rows_at: fresh.length ? today : prevMeta.last_new_rows_at ?? null,
    last_run_new_rows: fresh.length,
    fetched: all.length,
    passed: ranked.length,
    killed: killed.length,
    stale: staleKills.length,
    delisted: gone.length,
    unconfirmed: unconfirmed.length,
  };

  // Delisted rows accumulate rather than being overwritten: "this req was open
  // on the 4th and gone by the 13th" is the dated record that makes a delisting
  // inspectable later, and a file that only holds the last run cannot show it.
  const delistedLog = [...loadJson('data/delisted.json', []), ...gone].slice(-200);

  writeJson('data/candidates.json', ranked);
  writeJson('data/delisted.json', delistedLog);
  writeJson('data/liveness.json', urlChecks);
  writeJson('data/killed.json', killed);
  writeJson('data/skipped-cases.json', skipped);
  writeJson('data/queue.json', queue);
  writeJson('data/scan-errors.json', errors);
  writeJson('data/scan-meta.json', meta);
  writeJson('data/seen.json', [...seen, ...fresh.map((j) => j.key)]);
  writeJson('data/reposts.json', updateRepostIndex(repostIndex, all, today));

  console.log('');
  console.log(`fetched      ${all.length}`);
  console.log(`new          ${fresh.length}   (new rows feed the queue; the counts below are the whole board)`);
  console.log(`passed gate0 ${gated.length}`);
  console.log(`killed       ${killed.length}   see data/killed.json`);
  console.log(`  of which stale  ${staleKills.length} older than ${cfg.freshness?.max_age_days ?? MAX_AGE_DAYS} days`);
  console.log(`delisted     ${gone.length}   dropped from the buffer, see data/delisted.json`);
  if (unconfirmed.length)
    console.log(`unconfirmed  ${unconfirmed.length}   buffer rows whose board did not answer this run`);
  const reposts = gated.filter((r) => r.flags.some((f) => String(f).startsWith('repost:detected')));
  console.log(`reposts      ${reposts.length}   same title, new posting id, first seen over ${repostMinAge} days ago`);
  for (const r of reposts) console.log(`  ${r.company} — ${r.title}`);
  if (repostIndexWasEmpty) {
    console.log(`  data/reposts.json was empty, so this run seeded it. No repost can be`);
    console.log(`  detected for ${repostMinAge} days. data/seen.json carries no dates, so there is`);
    console.log(`  nothing to backfill from — the record starts today.`);
  }
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
