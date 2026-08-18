// Manual JD ingestion. A role Michael found himself, put in front of the drum.
//
//   pbpaste | npm run ingest:jd -- --company "Anthropic" --role "Research Engineer"
//   npm run ingest:jd -- --company X --role Y --file jd.txt --url https://...
//
// This is the one path into the buffer that does not come from a board, and it
// is the one that most clearly serves the constraint rather than feeding it: a
// posting someone chose is not candidate volume, it is a decision already made.
//
// THREE THINGS IT DOES NOT DO, each for a reason.
//
// It does not invent a row shape. The brief specified { company, role_title,
// url, ats_kind, raw_jd_path, first_seen }. Forty-three call sites read `.title`
// and the pipeline keys on `.key` and `.source`, so a row using `role_title`
// instead of `title` would pass Gate 0 and then break the buffer, the dashboard,
// the freshness audit and the blind packet. Every field the brief named is
// written, ADDITIVELY, beside the canonical ones. That is also what makes item 3
// of the brief true for free: a manual row is shaped like every other row, so the
// pre-audit seal, the blind packet, the countercurrent audit and validateArtifact
// all run on it unchanged, with no special case anywhere.
//
// It does not skip Gate 0. A human choosing a posting is a good reason to spend a
// slot and not a reason to stop checking. The gate runs, the verdict is printed,
// and a failing row still goes in — carrying its reasons in `flags` — because the
// override is the point and a silent override is not.
//
// It does not quietly overflow the buffer. The rope sets the buffer at
// min(buffer_max, slots + 5), and inserting past that is how a queue becomes a
// pile. Over the cap it refuses and says which row to strike first.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { gate0, fitScore } from './gates.js';

const ROOT = path.resolve(import.meta.dirname, '..');

export const slugify = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const readJson = (p, fallback) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);

// Atomic, the way server.js writes. writeFileSync truncates and then fills, and
// the diagnostician reads data/queue.json while it runs.
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, p);
};

// The stored JD. Keeps the raw text verbatim — the diagnostician reads this
// instead of fetching, so a summary here would be a summary the whole diagnosis
// then rests on.
export function buildRecord({ company, role, url = null, text, at = new Date().toISOString() }) {
  const slug = slugify(company);
  return {
    _what: 'A job description pasted in by hand. The raw text is the record; nothing here is summarized.',
    company,
    role,
    slug,
    url: url || null,
    ingested_at: at,
    chars: String(text ?? '').length,
    text: String(text ?? ''),
  };
}

// The queue row. Canonical shape first, the brief's fields carried beside it.
export function buildRow({ company, role, url = null, slug, text, archetype = 'agentic_startups', at = new Date().toISOString() }) {
  const today = at.slice(0, 10);
  return {
    key: `manual:${company}:${slug}`,
    source: 'manual',
    company,
    archetype,
    title: role,
    location: '',
    url: url || `manual://${slug}`,
    description: String(text ?? ''),
    posted: today,
    comp: null,
    fetched: today,

    // As specified in the brief, additive.
    ats_kind: 'manual',
    role_title: role,
    raw_jd_path: `data/manual_jds/${slug}.json`,
    first_seen: at,
  };
}

// What the diagnostician reads instead of fetching. A manual:// URI is not a
// URL and WebFetch on one fails; this is the resolver that makes the manual row
// behave like every other row from the agent's side.
export function jdContextFor(row, root = ROOT) {
  if (row?.ats_kind !== 'manual' && row?.source !== 'manual') return null;
  const p = path.join(root, row.raw_jd_path || `data/manual_jds/${slugify(row.company)}.json`);
  if (!fs.existsSync(p)) return null;
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { path: path.relative(root, p), company: rec.company, role: rec.role, url: rec.url, text: rec.text };
}

// Pure. Returns what would be written, so a test can check the decision without
// touching the real queue.
export function planIngest({ company, role, url = null, text, queue = [], cfg = {}, at = new Date().toISOString() }) {
  const problems = [];
  if (!String(company ?? '').trim()) problems.push('--company is required. The packet is addressed to a person at a named employer.');
  if (!String(role ?? '').trim()) problems.push('--role is required.');
  if (!String(text ?? '').trim()) problems.push('no JD text. Pipe it in on stdin or pass --file.');
  if (problems.length) return { ok: false, problems };

  const slug = slugify(company);
  const row = buildRow({ company, role, url, slug, text, at });

  const existing = queue.findIndex((r) => r.key === row.key);
  const bufferMax = cfg.drum?.buffer_max ?? 10;
  const wouldOverflow = existing < 0 && queue.length >= bufferMax;

  // Gate 0 runs and reports. It does not veto: the human already decided.
  const g = gate0(row, cfg);
  row.flags = g.flags;
  row.comp = g.comp ?? row.comp;
  row.fit = fitScore(row, cfg);

  return {
    ok: true,
    problems: [],
    row,
    record: buildRecord({ company, role, url, text, at }),
    replaces: existing >= 0,
    gate: g,
    wouldOverflow,
    bufferMax,
  };
}

export function ingest(plan, { root = ROOT } = {}) {
  const jdPath = path.join(root, 'data/manual_jds', `${plan.row.key.split(':').pop()}.json`);
  writeJson(jdPath, plan.record);

  const queuePath = path.join(root, 'data/queue.json');
  const queue = readJson(queuePath, []);
  const i = queue.findIndex((r) => r.key === plan.row.key);
  if (i >= 0) queue[i] = plan.row;
  else queue.push(plan.row);
  writeJson(queuePath, queue);

  return { jdPath: path.relative(root, jdPath), queueLength: queue.length, replaced: i >= 0 };
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
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };

  const file = flag('--file');
  const text = file ? fs.readFileSync(path.resolve(ROOT, file), 'utf8') : await readStdin();

  const cfgPath = fs.existsSync(path.join(ROOT, 'profile/gates.yaml')) ? 'profile/gates.yaml' : 'profile/gates.example.yaml';
  const cfg = yaml.load(fs.readFileSync(path.join(ROOT, cfgPath), 'utf8'));

  const plan = planIngest({
    company: flag('--company'),
    role: flag('--role'),
    url: flag('--url'),
    text,
    queue: readJson(path.join(ROOT, 'data/queue.json'), []),
    cfg,
  });

  if (!plan.ok) {
    for (const p of plan.problems) console.error(`ingest: ${p}`);
    console.error('');
    console.error('usage: pbpaste | npm run ingest:jd -- --company "Anthropic" --role "Research Engineer"');
    console.error('       npm run ingest:jd -- --company X --role Y --file jd.txt [--url https://...]');
    process.exit(2);
  }

  if (plan.wouldOverflow && !argv.includes('--force')) {
    console.error(`ingest: the buffer already holds ${plan.bufferMax} rows, which is what the rope set it to.`);
    console.error('        Inserting past that is how a queue becomes a pile. Strike a row on the dashboard first,');
    console.error('        or pass --force if you mean to run over the cap deliberately.');
    process.exit(1);
  }

  const r = ingest(plan);
  console.log(`${plan.replaces ? 'Replaced' : 'Ingested'} ${plan.row.company} — ${plan.row.title}`);
  console.log(`  jd        ${r.jdPath}  (${plan.record.chars} chars, verbatim)`);
  console.log(`  queue     ${plan.row.key}  · buffer now ${r.queueLength}/${plan.bufferMax}`);
  console.log(`  archetype ${plan.row.archetype}  · fit ${plan.row.fit}`);
  console.log(`  gate 0    ${plan.gate.pass ? 'passes' : 'FAILS: ' + plan.gate.reasons.join('; ')}`);
  if (!plan.gate.pass) {
    console.log('            Ingested anyway — you chose this posting, and that is a decision the gate does not');
    console.log('            get to overrule. The reasons are on the row so the diagnostician sees them.');
  }
  if (plan.row.flags?.length) console.log(`  flags     ${plan.row.flags.join(', ')}`);
  console.log('');
  console.log(`Diagnose it with:  /diagnose ${plan.row.company}`);
  console.log('The diagnostician reads the stored JD rather than fetching the manual:// URI.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    console.error(`ingest: ${e.message}`);
    process.exit(1);
  });
}
