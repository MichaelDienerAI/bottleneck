// Status board generator.
//
// Everything this system does lives in terminal output and JSON files, which is
// fine for the machine and useless for answering "where does this stand today."
// This reads whatever data/ currently holds and writes one self-contained HTML
// page with the numbers inlined, so it opens straight from the filesystem with
// no server and no network.
//
//   npm run board && open data/board.html

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { openSlots, loadLedger, weekStart } from './ledger.js';

const ROOT = path.resolve(import.meta.dirname, '..');

const readJson = (p, fallback) => {
  const full = path.join(ROOT, p);
  try {
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
};

const readYaml = (p) => {
  const full = path.join(ROOT, p);
  return fs.existsSync(full) ? yaml.load(fs.readFileSync(full, 'utf8')) : null;
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- gather

const cfg = readYaml('profile/gates.yaml') || readYaml('profile/gates.example.yaml') || {};
const registry = readYaml('profile/companies.yaml') || { archetypes: {} };

const queue = readJson('data/queue.json', []);
const candidates = readJson('data/candidates.json', []);
const killed = readJson('data/killed.json', []);
const errors = readJson('data/scan-errors.json', []);
const skippedCases = readJson('data/skipped-cases.json', []);
const ledger = loadLedger(ROOT);

// scan.js gates every fetched row on every run, so these counts are always the
// live board rather than a delta since the last scan. What the page still needs
// to say is whether anything NEW arrived, because "nothing new since Friday" is
// worth knowing and reads completely differently from "the boards are empty."
const scanMeta = readJson('data/scan-meta.json', {});
const lastNew = scanMeta.last_new_rows_at || null;
const ranToday = scanMeta.last_run_at || null;
const nothingNew = Boolean(scanMeta.last_run_new_rows === 0 && lastNew);

const capWeek = cfg.drum?.packets_per_week ?? 5;
const slots = openSlots(ROOT, cfg);
const used = capWeek - slots;
const bufferMax = cfg.drum?.buffer_max ?? 10;

const fetched = candidates.length + killed.length;
const passed = candidates.length;

// Kill reasons, grouped by family, sole reasons counted separately because a row
// killed by one rule alone is the rule actually doing the work.
const reasonFamilies = new Map();
for (const k of killed) {
  const fams = new Set((k.reasons || []).map((r) => String(r).split(':')[0]));
  for (const f of fams) {
    if (!reasonFamilies.has(f)) reasonFamilies.set(f, { occ: 0, sole: 0 });
    reasonFamilies.get(f).occ += 1;
    if (fams.size === 1) reasonFamilies.get(f).sole += 1;
  }
}
const reasonRows = [...reasonFamilies.entries()].sort((a, b) => b[1].occ - a[1].occ);

// Plain-language names. The file speaks in rule ids; a person does not.
const REASON_LABEL = {
  title: 'Job title is not work you do',
  location: 'Somewhere you would not go',
  seniority: 'Wrong rung, too junior or too senior',
  comp: 'Published pay tops out below your floor',
  clearance: 'Needs a security clearance',
  contract_staffing: 'Contract, temp, or staffing agency',
  wrong_shape: 'Unpaid, commission-only, or equity-only',
  capability_gap: 'Requires skills you have not shown publicly',
  ai_tooling_ban: 'Bans AI coding tools',
  credential_gate: 'Requires a PhD',
};

const FLAG_LABEL = {
  relocation_cost: 'You would have to move before January',
  country_only: 'Only names a country, so the city is unknown',
  remote_unverified: 'Says remote but mentions an office',
  comp: 'No published salary band',
  location_tier: null, // informational, not blocking
};

const flagLabel = (f) => {
  const key = String(f).split(':')[0];
  return FLAG_LABEL[key];
};

const archetypeLabel = {
  conversational_ai: 'Conversational AI',
  agentic_startups: 'Agentic startups',
  red_team_boutiques: 'Red-team shops',
  experiential_design: 'Experiential design',
  infrastructure: 'Infrastructure',
  frontier_labs: 'Frontier labs',
};

const spread = {};
for (const j of queue) spread[j.archetype] = (spread[j.archetype] || 0) + 1;

const casesDir = path.join(ROOT, 'data/cases');
const caseCount = fs.existsSync(casesDir)
  ? fs.readdirSync(casesDir).filter((f) => f.endsWith('.json')).length
  : 0;

const protocolsDir = path.join(ROOT, 'data/protocols');
const protocols = fs.existsSync(protocolsDir)
  ? fs.readdirSync(protocolsDir).filter((f) => f.endsWith('.md'))
  : [];

// ---------------------------------------------------------------- render

const pct = (n) => (fetched ? (n / fetched) * 100 : 0);
const fmt = (n) => n.toLocaleString('en-US');
const today = new Date().toISOString().slice(0, 10);

const funnel = [
  {
    n: fetched,
    label: 'Jobs on the boards',
    say: `Everything the 27 company job boards were advertising when the scan ran.`,
  },
  {
    n: passed,
    label: 'Worth a second look',
    say: `Survived the fixed rules: right kind of work, somewhere you would go, pay above your floor, no dealbreakers.`,
  },
  {
    n: queue.length,
    label: 'In the queue',
    say: `The best of those, capped at two per company so one big employer cannot take every slot.`,
  },
  {
    n: capWeek,
    label: 'You can research this week',
    say: `Your real capacity for building a proper case on a company. This number is the whole point.`,
  },
];

const buffer = queue
  .map((j, i) => {
    const blocking = (j.flags || []).map(flagLabel).filter(Boolean);
    const comp = j.comp
      ? `$${Math.round((j.comp.min ?? 0) / 1000)}K–$${Math.round((j.comp.max ?? 0) / 1000)}K`
      : 'No band published';
    return `
      <li class="row">
        <span class="rank">${i + 1}</span>
        <div class="row-main">
          <p class="row-title">${esc(j.title)}</p>
          <p class="row-co">${esc(j.company)}<span class="dot">·</span><span class="arch">${esc(
            archetypeLabel[j.archetype] || j.archetype || ''
          )}</span></p>
          ${
            blocking.length
              ? `<ul class="blocks">${blocking.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
              : `<p class="clear">Nothing to resolve. Ready to research.</p>`
          }
        </div>
        <div class="row-meta">
          <span class="pay">${esc(comp)}</span>
          <span class="posted">${j.posted ? `posted ${esc(String(j.posted).slice(0, 10))}` : ''}</span>
        </div>
      </li>`;
  })
  .join('');

const nextStep = ledger.length
  ? `You have ${ledger.length} ${ledger.length === 1 ? 'letter' : 'letters'} out. Run the Sunday review to see what the replies are telling you.`
  : slots === 0
  ? `This week is full. Nothing to do until Monday, and that is the system working.`
  : queue.length === 0
  ? `The queue is empty. Run a scan.`
  : `Pick the top company, research it, and write one letter. Nothing here counts until a person reads one.`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bottleneck — ${today}</title>
<style>
  :root {
    --paper:   #EDEEF0;
    --ink:     #14161A;
    --rule:    #C3C7CE;
    --muted:   #62676F;
    --signal:  #A8430F;
    --steady:  #2F5D50;
    --display: "Avenir Next Condensed", "Oswald", "Arial Narrow", system-ui, sans-serif;
    --body:    Charter, "Iowan Old Style", Georgia, serif;
    --data:    "SF Mono", ui-monospace, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font-family: var(--body); font-size: 17px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 940px; margin: 0 auto; padding: 48px 28px 96px; }

  header { border-bottom: 2px solid var(--ink); padding-bottom: 18px; margin-bottom: 40px; }
  h1 {
    font-family: var(--display); font-size: clamp(44px, 9vw, 84px);
    letter-spacing: -0.01em; text-transform: uppercase; margin: 0; line-height: 0.92;
  }
  .sub { font-family: var(--data); font-size: 12px; letter-spacing: 0.08em;
         text-transform: uppercase; color: var(--muted); margin: 10px 0 0; }

  h2 {
    font-family: var(--display); text-transform: uppercase; letter-spacing: 0.02em;
    font-size: 26px; margin: 56px 0 6px; padding-bottom: 6px;
    border-bottom: 1px solid var(--rule);
  }
  .lede { color: var(--muted); margin: 0 0 22px; font-size: 16px; }

  /* Drum */
  .drum { display: flex; align-items: baseline; gap: 18px; flex-wrap: wrap; margin: 4px 0 0; }
  .drum-n { font-family: var(--display); font-size: 92px; line-height: 0.85; }
  .pips { display: flex; gap: 7px; }
  .pip { width: 26px; height: 26px; border: 2px solid var(--ink); }
  .pip.spent { background: var(--ink); }

  /* Funnel: bar widths are the real proportions, not decoration. */
  .stage { margin: 0 0 22px; }
  .bar { height: 30px; background: var(--ink); }
  .stage:nth-child(2) .bar { background: #3C4149; }
  .stage:nth-child(3) .bar { background: var(--steady); }
  .stage:nth-child(4) .bar { background: var(--signal); }
  .stage-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 5px; }
  .stage-n { font-family: var(--data); font-size: 20px; font-weight: 600; }
  .stage-l { font-family: var(--display); text-transform: uppercase;
             letter-spacing: 0.04em; font-size: 17px; }
  .stage-say { color: var(--muted); font-size: 15px; margin: 6px 0 0; max-width: 62ch; }
  .drop { font-family: var(--data); font-size: 12px; color: var(--muted);
          text-transform: uppercase; letter-spacing: 0.06em; margin: 6px 0 0; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 16px; }
  th { font-family: var(--data); font-size: 11px; letter-spacing: 0.08em;
       text-transform: uppercase; color: var(--muted); text-align: left;
       border-bottom: 1px solid var(--rule); padding: 0 10px 7px 0; font-weight: 600; }
  td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  td.n { font-family: var(--data); text-align: right; width: 74px; white-space: nowrap; }

  /* Queue rows */
  ol.queue { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--rule); }
  .rank { font-family: var(--display); font-size: 30px; color: var(--rule); width: 34px; flex: none; }
  .row-main { flex: 1 1 auto; min-width: 0; }
  .row-title { margin: 0; font-weight: 600; }
  .row-co { margin: 2px 0 0; color: var(--muted); font-size: 15px; }
  .dot { padding: 0 8px; }
  .arch { font-family: var(--data); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  .blocks { margin: 9px 0 0; padding: 0; list-style: none; }
  .blocks li { font-size: 14px; color: var(--signal); padding-left: 15px; position: relative; }
  .blocks li::before { content: "→"; position: absolute; left: 0; }
  .clear { margin: 9px 0 0; font-size: 14px; color: var(--steady); }
  .row-meta { flex: none; text-align: right; }
  .pay { display: block; font-family: var(--data); font-size: 14px; }
  .posted { display: block; font-family: var(--data); font-size: 11px;
            color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }

  .next { border-left: 4px solid var(--signal); padding: 4px 0 4px 18px; margin: 20px 0 0; font-size: 19px; }
  .note { color: var(--muted); font-size: 15px; }
  ul.plain { padding-left: 18px; }
  ul.plain li { margin-bottom: 7px; }
  footer { margin-top: 72px; padding-top: 16px; border-top: 1px solid var(--rule);
           font-family: var(--data); font-size: 11px; text-transform: uppercase;
           letter-spacing: 0.07em; color: var(--muted); }
  @media (max-width: 620px) {
    .drum-n { font-size: 66px; }
    .row { flex-wrap: wrap; }
    .row-meta { text-align: left; width: 100%; padding-left: 50px; }
  }
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>Where the<br>search stands</h1>
  <p class="sub">Bottleneck · generated ${today} · reads whatever is in data/ right now</p>
  ${
    nothingNew
      ? `<p class="sub" style="color:var(--signal)">Scanned ${esc(ranToday || today)} · no new postings since ${esc(
          lastNew
        )}. The counts below are the live boards, not a leftover.</p>`
      : ''
  }
</header>

<h2>This week</h2>
<p class="lede">You can build about ${capWeek} proper cases a week. That number, not the number of jobs out there, is what limits this whole thing.</p>
<div class="drum">
  <span class="drum-n">${slots}</span>
  <div>
    <div class="pips">${Array.from({ length: capWeek }, (_, i) => `<span class="pip${i < used ? ' spent' : ''}"></span>`).join('')}</div>
    <p class="note" style="margin:10px 0 0">${used} used, ${slots} left. Week starts Monday ${weekStart()}.</p>
  </div>
</div>

<h2>What happened to ${fmt(fetched)} jobs</h2>
<p class="lede">The bars below are drawn to scale. Almost everything gets thrown out, on purpose, because your time is the scarce thing rather than the job listings.${
  nothingNew ? ` Nothing new has been posted since ${esc(lastNew)}, but these are still today's boards.` : ''
}</p>
${funnel
  .map((s, i) => {
    const w = Math.max(0.35, pct(s.n));
    const prev = i > 0 ? funnel[i - 1].n : null;
    const dropped = prev != null ? prev - s.n : null;
    return `
    <div class="stage">
      <div class="stage-head"><span class="stage-n">${fmt(s.n)}</span><span class="stage-l">${s.label}</span></div>
      <div class="bar" style="width:${w}%"></div>
      <p class="stage-say">${s.say}</p>
      ${dropped != null && dropped > 0 ? `<p class="drop">${fmt(dropped)} dropped here</p>` : ''}
    </div>`;
  })
  .join('')}

<h2>Why jobs got thrown out</h2>
<p class="lede">"Killed on its own" means that rule was the only thing standing between the job and your queue. Those are the rules actually doing the work.</p>
<table>
  <tr><th>Reason</th><th class="n">Total</th><th class="n">Alone</th></tr>
  ${reasonRows
    .map(
      ([fam, v]) =>
        `<tr><td>${esc(REASON_LABEL[fam] || fam)}</td><td class="n">${fmt(v.occ)}</td><td class="n">${fmt(v.sole)}</td></tr>`
    )
    .join('') || '<tr><td colspan="3" class="note">No scan has run yet.</td></tr>'}
</table>

<h2>In the queue</h2>
<p class="lede">Ranked best first. An arrow means something has to be settled before you write to them; a job with arrows is not disqualified, it just needs an answer you have not given yet.</p>
<ol class="queue">${buffer || '<li class="note" style="padding:16px 0">Empty. Run a scan.</li>'}</ol>
${
  Object.keys(spread).length
    ? `<p class="note" style="margin-top:16px">Spread across kinds of company: ${Object.entries(spread)
        .map(([a, n]) => `${esc(archetypeLabel[a] || a)} ${n}`)
        .join(', ')}.</p>`
    : ''
}

<h2>Letters sent</h2>
${
  ledger.length
    ? `<table>
        <tr><th>Date</th><th>Company</th><th>Sent to</th><th class="n">Stage</th></tr>
        ${ledger
          .map(
            (r) =>
              `<tr><td>${esc(r.date)}</td><td>${esc(r.company)}</td><td>${esc(
                r.decision_maker_role || r.channel || ''
              )}</td><td class="n">${r.stage ?? 0}</td></tr>`
          )
          .join('')}
      </table>`
    : `<p class="note">None yet. This is the only table on the page that measures whether any of the rest of it works. Everything above is preparation.</p>`
}

<h2>Do this next</h2>
<p class="next">${esc(nextStep)}</p>

<h2>Loose ends</h2>
<ul class="plain">
  ${errors.length ? `<li>${errors.length} job ${errors.length === 1 ? 'board' : 'boards'} did not answer: ${errors.map((e) => esc(e.company)).join(', ')}. A silent board looks the same as a company that is not hiring, so it is worth fixing.</li>` : ''}
  ${skippedCases.length ? `<li>${skippedCases.length} ${skippedCases.length === 1 ? 'company was' : 'companies were'} skipped because you already looked at them and closed the file.</li>` : ''}
  ${caseCount ? `<li>${caseCount} ${caseCount === 1 ? 'company file' : 'company files'} on record, so you will not research the same company twice.</li>` : `<li>No company files yet. They get written the first time you research a company.</li>`}
  ${protocols.length ? `<li>Measurement sheets waiting: ${protocols.map((p) => esc(p.replace('.md', ''))).join(', ')}.</li>` : ''}
  ${!ledger.length ? `<li>Nothing has been sent, so none of the numbers above have been tested against a real reply yet.</li>` : ''}
</ul>

<footer>Bottleneck · the slowest part sets the pace for everything else</footer>
</div>
</body>
</html>`;

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/board.html'), html);
console.log(`Wrote data/board.html — ${fmt(fetched)} jobs, ${queue.length} queued, ${slots} slots open.`);
console.log(`Open it: open data/board.html`);

