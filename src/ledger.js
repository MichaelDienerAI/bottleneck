// The ledger is the rope. It reports how many packet slots remain, and sourcing
// reads that number before it does anything.
//
// The schema is the twelve-variable tracking system from Section 11. Track only
// what could change a decision. Everything else is a deluge of figures that does
// not point the way to improvement.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const LEDGER = 'data/ledger.json';

export function loadLedger(root = ROOT) {
  const p = path.join(root, LEDGER);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
}

function saveLedger(rows, root = ROOT) {
  fs.writeFileSync(path.join(root, LEDGER), JSON.stringify(rows, null, 2) + '\n');
}

export function weekStart(d = new Date()) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // monday = 0
  x.setDate(x.getDate() - day);
  return x.toISOString().slice(0, 10);
}

export function openSlots(root = ROOT, cfg = null) {
  if (!cfg) {
    const p = fs.existsSync(path.join(root, 'profile/gates.yaml'))
      ? 'profile/gates.yaml'
      : 'profile/gates.example.yaml';
    cfg = yaml.load(fs.readFileSync(path.join(root, p), 'utf8'));
  }
  const cap = cfg.drum?.packets_per_week ?? 5;
  const ws = weekStart();
  const used = loadLedger(root).filter((r) => weekStart(new Date(r.date)) === ws).length;
  return Math.max(0, cap - used);
}

// Exponential fitness. A hiring-manager interview is not three times better than
// an unanswered email, it is eight times better. Linear counting hides that.
const FITNESS = (stage) => 2 ** stage;

function report(root = ROOT) {
  const rows = loadLedger(root);
  if (!rows.length) return console.log('Ledger empty. Nothing to review yet.');

  const byWeek = new Map();
  for (const r of rows) {
    const w = weekStart(new Date(r.date));
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(r);
  }

  console.log('WEEK        SENT  FITNESS  RUN');
  const weeks = [...byWeek.keys()].sort();
  for (const w of weeks) {
    const rs = byWeek.get(w);
    const f = rs.reduce((a, r) => a + FITNESS(r.stage ?? 0), 0);
    const bar = '#'.repeat(Math.min(40, Math.round(f / 2)));
    console.log(`${w}  ${String(rs.length).padStart(4)}  ${String(f).padStart(7)}  ${bar}`);
  }

  // Narrative sample sizes. Below twenty, any strategy change is tampering.
  const byNarrative = {};
  for (const r of rows) {
    const n = r.narrative || 'unspecified';
    byNarrative[n] = byNarrative[n] || { n: 0, fitness: 0 };
    byNarrative[n].n += 1;
    byNarrative[n].fitness += FITNESS(r.stage ?? 0);
  }
  console.log('\nNARRATIVE                    N   FITNESS/OUTREACH   SAMPLE');
  for (const [k, v] of Object.entries(byNarrative)) {
    const per = (v.fitness / v.n).toFixed(2);
    const verdict = v.n >= 20 ? 'valid' : `INSUFFICIENT (${20 - v.n} more)`;
    console.log(`${k.padEnd(28)}${String(v.n).padStart(3)}${per.padStart(19)}   ${verdict}`);
  }

  // Defect classes. Rejection reasons tell you which gate is actually binding.
  const defects = {};
  for (const r of rows) if (r.defect) defects[r.defect] = (defects[r.defect] || 0) + 1;
  if (Object.keys(defects).length) {
    console.log('\nDEFECT CLASS                 N');
    for (const [k, v] of Object.entries(defects).sort((a, b) => b[1] - a[1])) {
      console.log(`${k.padEnd(28)}${String(v).padStart(3)}`);
    }
  }

  console.log(`\nOpen slots this week: ${openSlots(root)}`);
  randExperiment(rows);
  console.log('\nAbandon list: a review that ends without a cut has decided nothing.');
}

// The RAND test, with one correction that matters.
//
// Greenwood measured detective effort against CLEARANCE, an outcome the detective
// did not get to declare. Your SHIP verdict is declared by the same agent that
// spent the minutes, which is the exact contaminated-grader failure the card names.
// So the outcome here is REPLY from a human. That is your clearance. SHIP is only
// an internal charging decision, and charging yourself proves nothing.
function randExperiment(rows) {
  const shipped = rows.filter((r) => r.diagnostic_minutes != null);
  console.log(`\nRAND EXPERIMENT   n=${shipped.length}   (needs 20 before it says anything)`);
  if (shipped.length < 5) {
    console.log('  Too few packets. Keep collecting.');
    return;
  }

  const replyRate = (rs) =>
    rs.length ? ((rs.filter((r) => (r.stage ?? 0) >= 1).length / rs.length) * 100).toFixed(0) : '--';

  const order = ['S++', 'S', 'A', 'B', 'C', 'D', 'E', 'F', 'H'];
  console.log('  OBSERVABLE GRADE AT INTAKE');
  for (const g of order) {
    const rs = shipped.filter((r) => r.observable_grade === g);
    if (!rs.length) continue;
    console.log(`    ${g.padEnd(4)} n=${String(rs.length).padStart(3)}  reply ${replyRate(rs).padStart(3)}%  median min ${median(rs.map((r) => r.diagnostic_minutes))}`);
  }

  const med = median(shipped.map((r) => r.diagnostic_minutes));
  const fast = shipped.filter((r) => r.diagnostic_minutes <= med);
  const slow = shipped.filter((r) => r.diagnostic_minutes > med);
  console.log('  DIAGNOSTIC MINUTES');
  console.log(`    at or under median (${med})  n=${fast.length}  reply ${replyRate(fast)}%`);
  console.log(`    over median               n=${slow.length}  reply ${replyRate(slow)}%`);

  console.log('  HYPOTHESIS SOURCE');
  for (const s of [...new Set(shipped.map((r) => r.hypothesis_source))]) {
    const rs = shipped.filter((r) => r.hypothesis_source === s);
    console.log(`    ${String(s).padEnd(14)} n=${String(rs.length).padStart(3)}  reply ${replyRate(rs)}%`);
  }

  if (shipped.length >= 20) {
    console.log('\n  READ IT: if grade separates reply rate and minutes do not, the drum is');
    console.log('  misplaced. Move hours out of diagnosis and into instrument-building.');
    console.log(`\n  Card 2 kill rule: fail any packet running past ${med * 2} minutes.`);
  }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function add(file, root = ROOT) {
  const row = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

  // Card 1 instrumentation. These two fields are the whole experiment, so a row
  // without them is a packet that taught you nothing. Refuse it.
  const required = [
    'date', 'company', 'archetype', 'title', 'channel', 'narrative', 'artifact',
    'observable_grade',    // S..H, graded at Gate 0, BEFORE any diagnosis work
    'diagnostic_minutes',  // wall-clock minutes from slot opened to audit cleared
    'hypothesis_source',   // posting | measurement | wip_age | refusal | hiring_shape
  ];
  const missing = required.filter((k) => row[k] === undefined || row[k] === '');
  if (missing.length) {
    console.error(`Refusing to add. Missing required fields: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!/^(S\+\+|S|A|B|C|D|E|F|H)$/.test(row.observable_grade)) {
    console.error(`observable_grade must be a ladder tier, got: ${row.observable_grade}`);
    process.exit(1);
  }
  const rows = loadLedger(root);
  rows.push({ stage: 0, defect: null, replied: false, ...row });
  saveLedger(rows, root);
  console.log(`Added. Open slots now: ${openSlots(root)}`);
}

const arg = process.argv[2];
if (arg === '--slots') console.log(openSlots());
else if (arg === '--report') report();
else if (arg === '--add') add(process.argv[3]);
