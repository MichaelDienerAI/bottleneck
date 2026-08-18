// Manual JD ingestion.
//
// The one path into the buffer that does not come from a board. Two things have
// to hold: the JD is stored verbatim, and the queue row is shaped like every
// other queue row. The second is what makes the manual path free — a canonical
// row runs through the pre-audit seal, the blind packet, the countercurrent audit
// and validateArtifact with no special case anywhere. A row with its own shape
// would need a branch in each of them, and the branch nobody added is where the
// bug lives.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planIngest, ingest, buildRow, buildRecord, jdContextFor, slugify } from '../src/ingestManual.js';

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
};

const roots = [];
function makeRoot(queue = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottleneck-ingest-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/queue.json'), JSON.stringify(queue, null, 2) + '\n');
  return root;
}

const JD = 'We are hiring a Research Engineer to work on evaluation harnesses. You will own the eval pipeline.';
const cfg = { drum: { buffer_max: 10 }, comp: { floor_usd: 130000 }, freshness: { max_age_days: 90 } };

const plan = (over = {}) =>
  planIngest({ company: 'Anthropic', role: 'Research Engineer', text: JD, queue: [], cfg, at: '2026-08-18T10:00:00.000Z', ...over });

// ---------------------------------------------------------------------------
// The row shape, which is the whole point
// ---------------------------------------------------------------------------

t('the row carries every canonical field the pipeline reads', () => {
  const r = plan().row;
  for (const k of ['key', 'source', 'company', 'archetype', 'title', 'location', 'url', 'description', 'posted', 'fetched']) {
    assert.ok(k in r, `missing canonical field ${k}`);
  }
  assert.equal(r.title, 'Research Engineer');
  assert.equal(r.source, 'manual');
});

t('the brief\'s fields are carried additively', () => {
  // role_title INSTEAD of title would pass Gate 0 and then break 43 call sites.
  const r = plan().row;
  assert.equal(r.ats_kind, 'manual');
  assert.equal(r.role_title, 'Research Engineer');
  assert.equal(r.raw_jd_path, 'data/manual_jds/anthropic.json');
  assert.equal(r.first_seen, '2026-08-18T10:00:00.000Z');
  assert.equal(r.title, r.role_title, 'both, not one');
});

t('a missing url becomes the manual scheme, and a real one is kept', () => {
  assert.equal(plan().row.url, 'manual://anthropic');
  assert.equal(plan({ url: 'https://example.com/jd' }).row.url, 'https://example.com/jd');
});

t('the JD text is the description, so the blind packet carries it unchanged', () => {
  // buildBlindPacket reads posting.description. Nothing about the manual path
  // needs teaching if the text is where every other row keeps it.
  assert.equal(plan().row.description, JD);
});

t('the record stores the JD verbatim and does not summarize it', () => {
  const rec = buildRecord({ company: 'Anthropic', role: 'X', text: JD });
  assert.equal(rec.text, JD);
  assert.equal(rec.chars, JD.length);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

t('company, role and text are all required', () => {
  assert.equal(planIngest({ role: 'X', text: JD, cfg }).ok, false);
  assert.equal(planIngest({ company: 'X', text: JD, cfg }).ok, false);
  const noText = planIngest({ company: 'X', role: 'Y', text: '   ', cfg });
  assert.equal(noText.ok, false);
  assert.ok(noText.problems.some((p) => /stdin|--file/.test(p)));
});

t('Gate 0 runs and reports, and does not veto', () => {
  // A human choosing a posting is a reason to spend a slot and not a reason to
  // stop checking. A failing row still goes in, carrying its reasons.
  const p = plan({ role: 'Chief Financial Officer' });
  assert.equal(p.ok, true, 'the override is the point');
  assert.equal(p.gate.pass, false);
  assert.ok(p.gate.reasons.length > 0, 'and the reasons travel with it');
});

t('a full buffer is reported rather than silently overflowed', () => {
  // The rope set the buffer to min(buffer_max, slots + 5). Inserting past it is
  // how a queue becomes a pile.
  const full = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, company: `C${i}` }));
  assert.equal(plan({ queue: full }).wouldOverflow, true);
  assert.equal(plan({ queue: full.slice(0, 9) }).wouldOverflow, false);
});

t('re-ingesting the same company replaces its row rather than duplicating it', () => {
  const existing = [{ key: 'manual:Anthropic:anthropic', company: 'Anthropic' }];
  const p = plan({ queue: existing });
  assert.equal(p.replaces, true);
  assert.equal(p.wouldOverflow, false, 'a replacement cannot overflow');
});

// ---------------------------------------------------------------------------
// Writing, without corrupting state
// ---------------------------------------------------------------------------

t('ingest writes the JD and appends exactly one queue row', () => {
  const root = makeRoot([{ key: 'existing:1', company: 'Other', title: 'Keep me' }]);
  const r = ingest(plan(), { root });

  const queue = JSON.parse(fs.readFileSync(path.join(root, 'data/queue.json'), 'utf8'));
  assert.equal(queue.length, 2, 'the existing row must survive');
  assert.equal(queue[0].key, 'existing:1');
  assert.equal(queue[1].key, 'manual:Anthropic:anthropic');
  assert.equal(r.replaced, false);

  const jd = JSON.parse(fs.readFileSync(path.join(root, 'data/manual_jds/anthropic.json'), 'utf8'));
  assert.equal(jd.text, JD);
});

t('a second ingest of the same company replaces in place', () => {
  const root = makeRoot();
  ingest(plan(), { root });
  const second = ingest(plan({ role: 'Member of Technical Staff' }), { root });
  const queue = JSON.parse(fs.readFileSync(path.join(root, 'data/queue.json'), 'utf8'));
  assert.equal(queue.length, 1, 'no duplicate');
  assert.equal(queue[0].title, 'Member of Technical Staff');
  assert.equal(second.replaced, true);
});

t('the queue is written atomically and leaves no temp file', () => {
  // The diagnostician reads data/queue.json while it runs, so a truncate-then-fill
  // write is a real torn read rather than a theoretical one.
  const root = makeRoot();
  ingest(plan(), { root });
  assert.equal(fs.existsSync(path.join(root, 'data/queue.json.tmp')), false);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(root, 'data/queue.json'), 'utf8')));
});

// ---------------------------------------------------------------------------
// What the diagnostician reads instead of fetching
// ---------------------------------------------------------------------------

t('jdContextFor resolves a manual row to its stored text', () => {
  // A manual:// URI is not a URL and WebFetch on one fails. This is the resolver
  // that keeps the agent from trying.
  const root = makeRoot();
  const p = plan();
  ingest(p, { root });
  const ctx = jdContextFor(p.row, root);
  assert.equal(ctx.text, JD);
  assert.equal(ctx.company, 'Anthropic');
  assert.equal(ctx.path, 'data/manual_jds/anthropic.json');
});

t('jdContextFor returns null for a board row, so nothing changes for them', () => {
  assert.equal(jdContextFor({ source: 'ashby', company: 'X', ats_kind: 'ashby' }, makeRoot()), null);
});

t('jdContextFor returns null rather than throwing when the file is gone', () => {
  const root = makeRoot();
  assert.equal(jdContextFor({ source: 'manual', company: 'Ghost', raw_jd_path: 'data/manual_jds/ghost.json' }, root), null);
});

t('slugify matches the convention the rest of the repo uses', () => {
  assert.equal(slugify('Gray Swan AI'), 'gray-swan-ai');
  assert.equal(slugify('Character.AI'), 'character-ai');
  assert.equal(buildRow({ company: 'Character.AI', role: 'X', slug: slugify('Character.AI'), text: '' }).raw_jd_path,
    'data/manual_jds/character-ai.json');
});

for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passing`);
