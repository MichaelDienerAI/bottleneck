// Case file. One JSON per company, persisting across weeks.
//
// The system had no memory between cycles. It deduped postings and nothing else,
// so a company rejected in March could be re-promoted in May, re-diagnosed with
// the same wrong hypothesis, and re-rejected. That re-diagnosis costs a drum slot,
// and the drum is the constraint. Amnesia steals directly from the bottleneck.
//
// This module is the whole fix. No new agent, no new command, one file per company.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'data/cases');

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function load(company) {
  const p = path.join(DIR, `${slugify(company)}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function save(file) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${file.slug}.json`), JSON.stringify(file, null, 2) + '\n');
  return file;
}

export function create(company, archetype) {
  return {
    company,
    slug: slugify(company),
    archetype,
    first_seen: today(),
    status: 'NEW',              // NEW PARKED REJECTED SHIPPED DEAD
    visits: [],
    dead_hypotheses: [],        // constraint claims already killed. never re-run these
    struck_claims: [],          // overstatements the auditor already removed
    queries_run: [],            // so the next visit does not repeat a search
    decision_maker: { name: null, title: null, source: null },
    revisit_after: null,        // ISO date. before this, skip
    revisit_trigger: null,      // plain language. what must change for this to be worth reopening
  };
}

export function recordVisit(file, visit) {
  file.visits.push({ date: today(), ...visit });
  if (visit.verdict === 'REJECT' && visit.hypothesis) file.dead_hypotheses.push(visit.hypothesis);
  if (visit.queries) file.queries_run.push(...visit.queries);
  file.status = statusFor(visit.verdict);
  if (noProgress(file)) {
    file.status = 'DEAD';
    file.revisit_trigger = 'Two visits produced no new evidence. Reopen only on a public change.';
  }
  return save(file);
}

function statusFor(verdict) {
  if (verdict === 'SHIP') return 'SHIPPED';
  if (verdict === 'PARK') return 'PARKED';
  if (verdict === 'REJECT' || verdict === 'INSUFFICIENT_EVIDENCE') return 'REJECTED';
  return 'NEW';
}

// No-progress detection. Two consecutive visits that surfaced no evidence key the
// file did not already hold means the public record is not going to yield more.
// Repeating the search is the loop equivalent of rephrasing and calling it revision.
function noProgress(file) {
  const v = file.visits;
  if (v.length < 2) return false;
  const [prev, last] = v.slice(-2);
  const known = new Set(prev.evidence_keys || []);
  const fresh = (last.evidence_keys || []).filter((k) => !known.has(k));
  return fresh.length === 0;
}

// The scan gate. Answers one question: should this company consume a slot today?
export function shouldSkip(company, when = today()) {
  const file = load(company);
  if (!file) return { skip: false };
  if (file.status === 'DEAD') return { skip: true, reason: 'DEAD: no progress across two visits' };
  if (file.status === 'SHIPPED') return { skip: true, reason: 'SHIPPED: already in the ledger' };
  if (file.revisit_after && when < file.revisit_after) {
    return { skip: true, reason: `cooling until ${file.revisit_after}: ${file.revisit_trigger || 'no trigger set'}` };
  }
  return { skip: false, priors: { dead_hypotheses: file.dead_hypotheses, queries_run: file.queries_run } };
}

export function park(file, days, trigger) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  file.revisit_after = d.toISOString().slice(0, 10);
  file.revisit_trigger = trigger;
  file.status = 'PARKED';
  return save(file);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function summary() {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
    .map((c) => ({
      company: c.company,
      status: c.status,
      visits: c.visits.length,
      dead_hypotheses: c.dead_hypotheses.length,
      revisit_after: c.revisit_after,
    }));
}
