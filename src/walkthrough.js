// Walkthrough page generator.
//
//   npm run walk && open data/walkthrough.html
//
// One self-contained page. You pick a kind of work, and it walks the pipeline
// stage by stage on YOUR real numbers, explaining in plain words what each agent
// does, which sources it reads, and why.
//
// What this page does NOT do, stated up front because the alternative is a lie:
// it does not run the agents. The diagnostician and the auditor run on Opus
// inside Claude Code and nothing in a browser can call them. Where an agent has
// not run yet, the page says so and hands you the exact prompt to run it. Where
// it has run, the page reads data/diagnoses/ and packets/ and shows the real
// output. An animated fake would be the exact failure the evidence schema exists
// to prevent.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { openSlots, loadLedger } from './ledger.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const rd = (p, f) => {
  try {
    const full = path.join(ROOT, p);
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : f;
  } catch {
    return f;
  }
};
const ry = (p) => {
  const full = path.join(ROOT, p);
  return fs.existsSync(full) ? yaml.load(fs.readFileSync(full, 'utf8')) : null;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cfg = ry('profile/gates.yaml') || ry('profile/gates.example.yaml') || {};
const registry = ry('profile/companies.yaml') || { archetypes: {} };
const queue = rd('data/queue.json', []);
const candidates = rd('data/candidates.json', []);
const killed = rd('data/killed.json', []);
const errors = rd('data/scan-errors.json', []);
const ledger = loadLedger(ROOT);
const slots = openSlots(ROOT, cfg);
const capWeek = cfg.drum?.packets_per_week ?? 5;

const dxDir = path.join(ROOT, 'data/diagnoses');
const diagnoses = fs.existsSync(dxDir)
  ? fs.readdirSync(dxDir).filter((f) => f.endsWith('.yaml')).map((f) => {
      try {
        return { file: f, ...yaml.load(fs.readFileSync(path.join(dxDir, f), 'utf8')) };
      } catch {
        return { file: f };
      }
    })
  : [];
const pkDir = path.join(ROOT, 'packets');
const packets = fs.existsSync(pkDir) ? fs.readdirSync(pkDir).filter((f) => !f.startsWith('.')) : [];

// Plain-language identity for each kind of company. The approach lines come from
// The $130K Search, sections 4 and 5, which named the decision-maker and the
// highest-leverage opening for each one.
const KINDS = {
  conversational_ai: {
    name: 'Voice and companion products',
    blurb: 'Companies building AI you talk to. They fight the same problems you already solved: keeping a character consistent, closing the loop fast enough that it feels alive.',
    who: 'Founders, VPs of Product, engineering leads',
    open: 'Measure their live product, then send the reading with the fix attached.',
  },
  agentic_startups: {
    name: 'Agent builders',
    blurb: 'Teams shipping AI that takes actions on its own. They need someone who can keep an agent inside its boundaries when a user pushes.',
    who: 'Founders and engineering leads',
    open: 'Lead with how you debugged a live pipeline, not with what you believe about agents.',
  },
  red_team_boutiques: {
    name: 'Red-team shops',
    blurb: 'Firms paid to find where safe-looking models break. No credential gate. Your test bank is the whole application.',
    who: 'Director of Trust and Safety, lead evaluator',
    open: 'Send the Replika and Character.AI findings as a case study. Nothing else.',
  },
  infrastructure: {
    name: 'Developer tools',
    blurb: 'The companies whose SDKs you already use in production. You have debugged their systems in ways their own docs do not cover.',
    who: 'Head of Developer Relations, VP of Solutions Engineering',
    open: 'Publish the fix you found in their streaming buffer, then send it to their solutions lead.',
  },
  experiential_design: {
    name: 'Creative studios',
    blurb: 'Agencies building interactive work for brands. Portfolio beats pedigree here.',
    who: 'Creative directors and agency founders',
    open: 'Lead with the performance background and the graduate work.',
  },
  frontier_labs: {
    name: 'Frontier labs',
    blurb: 'The largest labs. Highest pay, hardest door. The front door does not work, so do not use it.',
    who: 'Alignment science leads',
    open: 'Never apply. Send a red-teaming brief directly and let it stand alone.',
  },
};

const REASON = {
  title: 'The job title is not work you do',
  location: 'Somewhere you would not go',
  seniority: 'Wrong rung, too junior or too senior',
  comp: 'Published pay tops out below your floor',
  clearance: 'Needs a security clearance',
  contract_staffing: 'Contract, temp, or staffing agency',
  wrong_shape: 'Unpaid, commission-only, or equity-only',
  capability_gap: 'Wants skills you have not shown publicly',
  ai_tooling_ban: 'Bans AI coding tools',
  credential_gate: 'Requires a PhD',
};
const FLAG = {
  relocation_cost: 'You would have to move before January. Decide if this one is worth it.',
  country_only: 'The posting only names a country. Find out which city before you write.',
  remote_unverified: 'Says remote but mentions an office. Ask what they actually mean.',
  comp: 'No published salary band. Get the number on the first call.',
};
const flagSay = (f) => FLAG[String(f).split(':')[0]];

// Per-kind slices of the real run.
const kinds = [];
for (const [key, block] of Object.entries(registry.archetypes || {})) {
  const cos = (block.companies || []).map((c) => c.name);
  const cand = candidates.filter((r) => r.archetype === key);
  const kil = killed.filter((k) => cos.includes(k.company));
  const q = queue.filter((r) => r.archetype === key);
  const reasons = new Map();
  for (const k of kil) {
    for (const f of new Set((k.reasons || []).map((r) => String(r).split(':')[0]))) {
      reasons.set(f, (reasons.get(f) || 0) + 1);
    }
  }
  kinds.push({
    key,
    ...(KINDS[key] || { name: key, blurb: '', who: '', open: '' }),
    weight: block.weight,
    companies: (block.companies || []).map((c) => ({ name: c.name, ats: c.ats, token: c.token })),
    fetched: cand.length + kil.length,
    passed: cand.length,
    killed: kil.length,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    queued: q.length,
    rows: q.map((r) => ({
      company: r.company,
      title: r.title,
      url: r.url,
      posted: r.posted ? String(r.posted).slice(0, 10) : '',
      comp: r.comp ? `$${Math.round((r.comp.min ?? 0) / 1000)}K–$${Math.round((r.comp.max ?? 0) / 1000)}K` : 'No band published',
      settle: (r.flags || []).map(flagSay).filter(Boolean),
    })),
    diagnosed: diagnoses.filter((d) => q.some((r) => r.company === d.company)).length,
  });
}
kinds.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

const DATA = { kinds, capWeek, slots, ledger: ledger.length, packets: packets.length, errors };
const today = new Date().toISOString().slice(0, 10);

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bottleneck — how it works</title>
<style>
:root{
  --paper:#EDEEF0; --ink:#14161A; --rule:#C3C7CE; --muted:#62676F;
  --signal:#A8430F; --steady:#2F5D50; --wash:#E3E5E8;
  --display:"Avenir Next Condensed","Oswald","Arial Narrow",system-ui,sans-serif;
  --body:Charter,"Iowan Old Style",Georgia,serif;
  --data:"SF Mono",ui-monospace,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--body);
  font-size:17px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto;padding:52px 26px 110px}
h1{font-family:var(--display);text-transform:uppercase;font-size:clamp(40px,8vw,76px);
  line-height:.92;letter-spacing:-.01em;margin:0}
.sub{font-family:var(--data);font-size:12px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--muted);margin:12px 0 0}
.intro{max-width:60ch;margin:26px 0 0;font-size:19px}
h2{font-family:var(--display);text-transform:uppercase;letter-spacing:.02em;font-size:25px;
  margin:64px 0 6px;padding-bottom:6px;border-bottom:1px solid var(--rule)}
.lede{color:var(--muted);margin:0 0 24px;font-size:16px;max-width:64ch}

/* Kind picker */
.kinds{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:14px;margin-top:8px}
.kind{text-align:left;background:none;border:1px solid var(--rule);padding:18px;cursor:pointer;
  font:inherit;color:inherit;transition:border-color .12s, background .12s}
.kind:hover{border-color:var(--ink);background:var(--wash)}
.kind[aria-pressed=true]{border:2px solid var(--signal);background:var(--wash)}
.kind:focus-visible{outline:3px solid var(--signal);outline-offset:2px}
.kind h3{font-family:var(--display);text-transform:uppercase;font-size:19px;margin:0 0 6px;letter-spacing:.02em}
.kind p{margin:0;font-size:15px;color:var(--muted)}
.kind .stat{font-family:var(--data);font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  margin-top:12px;color:var(--ink)}

/* Relay */
#relay{margin-top:16px}
.stage{border-left:3px solid var(--rule);padding:0 0 34px 24px;position:relative;
  opacity:0;transform:translateY(8px);transition:opacity .4s ease,transform .4s ease}
.stage.on{opacity:1;transform:none}
.stage.on .marker{background:var(--ink)}
.stage:last-child{padding-bottom:0}
.marker{position:absolute;left:-9px;top:4px;width:15px;height:15px;background:var(--rule);
  border:3px solid var(--paper);border-radius:50%}
.who{font-family:var(--data);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--signal)}
.stage h3{font-family:var(--display);text-transform:uppercase;font-size:23px;margin:4px 0 10px;letter-spacing:.02em}
.stage p{margin:0 0 12px;max-width:64ch}
.reads{font-size:15px;color:var(--muted);border-top:1px solid var(--rule);padding-top:12px;margin-top:14px}
.reads b{font-family:var(--data);font-size:11px;letter-spacing:.08em;text-transform:uppercase;
  display:block;color:var(--ink);margin-bottom:5px;font-weight:600}
.count{font-family:var(--data);font-size:34px;display:block;margin:2px 0 4px}
ul.why{margin:8px 0 0;padding-left:18px;font-size:15px;color:var(--muted)}
ul.why li{margin-bottom:5px}
.bar{height:10px;background:var(--ink);margin:8px 0 4px}
.bar.pass{background:var(--steady)}
.bar.queue{background:var(--signal)}

/* Report rows */
.rows{list-style:none;padding:0;margin:14px 0 0}
.rowi{border-top:1px solid var(--rule);padding:16px 0}
.rowi h4{margin:0;font-size:17px}
.rowi h4 a{color:var(--ink)}
.rowi .meta{font-family:var(--data);font-size:12px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.05em;margin:4px 0 0}
.settle{margin:10px 0 0;padding:0;list-style:none}
.settle li{font-size:14px;color:var(--signal);padding-left:15px;position:relative}
.settle li::before{content:"→";position:absolute;left:0}
.ready{font-size:14px;color:var(--steady);margin:10px 0 0}

/* Prompt block */
.prompt{background:var(--ink);color:#EDEEF0;padding:18px;font-family:var(--data);
  font-size:13px;line-height:1.6;white-space:pre-wrap;margin:12px 0 0}
.copy{font:inherit;font-family:var(--data);font-size:11px;letter-spacing:.08em;
  text-transform:uppercase;background:none;border:1px solid var(--ink);padding:7px 13px;
  cursor:pointer;margin-top:10px}
.copy:hover{background:var(--ink);color:var(--paper)}
.hint{color:var(--muted);font-size:15px;margin:24px 0 0;padding:14px 16px;border:1px dashed var(--rule)}
footer{margin-top:80px;padding-top:16px;border-top:1px solid var(--rule);font-family:var(--data);
  font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
@media (prefers-reduced-motion:reduce){.stage{transition:none}}
@media (max-width:600px){.wrap{padding:34px 18px 80px}}
</style></head><body><div class="wrap">

<h1>How this<br>actually works</h1>
<p class="sub">Bottleneck · ${today} · every number below came from your last scan</p>
<p class="intro">Pick a kind of work. The page walks the whole pipeline on your real data, one stage at a time, and tells you plainly what each part did, what it read, and why.</p>

<h2>Pick the kind of work</h2>
<p class="lede">These are the six kinds of company this searches. The percentage is how much of a week each one is supposed to get.</p>
<div class="kinds" id="kinds"></div>

<div id="relay"></div>

<footer>Bottleneck · the slowest part sets the pace for everything else</footer>
</div>

<script>
const D = ${JSON.stringify(DATA)};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = (n,t) => t ? Math.max(0.4, (n/t)*100) : 0;

document.getElementById('kinds').innerHTML = D.kinds.map((k,i) => \`
  <button class="kind" aria-pressed="false" data-i="\${i}">
    <h3>\${esc(k.name)}</h3>
    <p>\${esc(k.blurb)}</p>
    <span class="stat">\${Math.round((k.weight||0)*100)}% of a week · \${k.queued} in the queue</span>
  </button>\`).join('');

function stage(who, title, body, extra) {
  return \`<section class="stage"><span class="marker"></span>
    <span class="who">\${who}</span><h3>\${title}</h3>\${body}\${extra||''}</section>\`;
}

function render(k) {
  const boards = k.companies.map(c => c.name).join(', ');
  const kills = k.reasons.map(([f,n]) => \`<li><b>\${n.toLocaleString()}</b> — \${esc(REASONS[f]||f)}</li>\`).join('');

  const rows = k.rows.length ? \`<ul class="rows">\${k.rows.map(r => \`
    <li class="rowi">
      <h4><a href="\${esc(r.url)}" target="_blank" rel="noopener">\${esc(r.title)}</a></h4>
      <p class="meta">\${esc(r.company)} · \${esc(r.comp)}\${r.posted ? ' · posted '+esc(r.posted) : ''}</p>
      \${r.settle.length
        ? '<ul class="settle">'+r.settle.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ul>'
        : '<p class="ready">Nothing to settle. You could write to them today.</p>'}
    </li>\`).join('')}</ul>\`
    : '<p class="hint">Nothing from this kind of company made the queue this week. That is a finding, not a failure — either they are not hiring the work you do, or the rules are too tight. The kill reasons above tell you which.</p>';

  const dxPrompt = 'Run /diagnose ' + (k.rows[0]?.company || '<company>') +
    '. Form the constraint hypothesis before you search, then issue one query designed to kill it, and log that query whether or not it found anything. Record the start time and the elapsed minutes when the audit clears.';

  document.getElementById('relay').innerHTML = \`
    <h2>What happens, in order</h2>
    <p class="lede">Four workers, one after another. Each one hands off to the next and none of them skips ahead.</p>

    \${stage('Worker one · the scout',' It reads the job boards',
      \`<p>The scout opens the job pages that \${esc(k.companies.length.toString())} companies publish themselves. Not LinkedIn, not a scraper — these are feeds the companies put out on purpose for anyone to read.</p>
       <p>It checks your calendar first. If you have already used your \${D.capWeek} research slots this week, it fetches nothing at all and says so. That is the point of the whole design: there is no reason to gather work you have no time to do.</p>\`,
      \`<div class="reads"><b>Read this run</b>\${esc(boards)}
        <span class="count">\${k.fetched.toLocaleString()}</span> jobs these companies were advertising
        <div class="bar" style="width:100%"></div></div>\`)}

    \${stage('Worker one, still · the fixed rules','It throws almost everything out',
      \`<p>Every job goes through the same rules, in code, with no judgment involved. Is the title work you actually do. Is it somewhere you would go. Does the published pay clear your floor. Does it demand something you have never shown publicly.</p>
       <p>One failed rule kills the job. The rules cannot outvote each other, because a rule that can be overruled is not a rule.</p>\`,
      \`<div class="reads"><b>Why they were thrown out</b>
        <ul class="why">\${kills || '<li>Nothing thrown out from this group.</li>'}</ul>
        <span class="count">\${k.passed.toLocaleString()}</span> worth a second look
        <div class="bar pass" style="width:\${pct(k.passed,k.fetched)}%"></div></div>\`)}

    \${stage('The handoff','It keeps only what you can actually get to',
      \`<p>What survives gets sorted: the kind of company first, then how closely the job matches work you can prove you have done, then how recently it posted. Two per company, so one big employer cannot swallow the whole list.</p>
       <p>Then it stops. The queue holds ten and the week holds \${D.capWeek}, and filling a queue past that just makes a pile.</p>\`,
      \`<div class="reads"><span class="count">\${k.queued}</span> in your queue from this group
        <div class="bar queue" style="width:\${pct(k.queued,k.fetched)}%"></div></div>\`)}

    \${stage('Worker two · the researcher','It works out what is actually broken there',
      \`<p>This is the slow one, and the whole system is built around protecting its time. It takes one company and works backward from the job posting to the problem that made them post it.</p>
       <p>A posting says what the role does. It almost never says what hurts. So the researcher measures their live product, sorts their public unfinished work by how long it has sat, reads what they have publicly refused to build, and checks whether they are hiring bodies because they lack a tool. Then it names one thing, with one number, on one date, and a link a stranger can check in under a minute.</p>
       <p>If it cannot find that, it says so and stops. That counts as a result.</p>\`,
      k.diagnosed
        ? \`<div class="reads"><b>Done</b><span class="count">\${k.diagnosed}</span> \${k.diagnosed===1?'company researched':'companies researched'} in this group</div>\`
        : \`<div class="reads"><b>Not run yet</b>This page cannot do it — the researcher runs on Opus inside Claude Code and nothing in a browser can call it. Paste this there:
            <div class="prompt">\${esc(dxPrompt)}</div>
            <button class="copy" data-copy="\${esc(dxPrompt)}">Copy this prompt</button></div>\`)}

    \${stage('Worker three · the checker','It attacks the research before anyone else can',
      \`<p>The checker's job is to kill claims, not approve them. For every sentence it asks what a stranger clicks to verify it and how long that takes. Anything that fails goes.</p>
       <p>It also compares what you are claiming against what you have actually shipped, and it knows the two places your own record says to be careful: the calibration layer is written but not wired in, and the engineering is agent-directed rather than hand-written. Any draft that blurs either one gets struck, because a hiring manager who finds that gap later discounts everything else you said.</p>\`,
      \`<div class="reads"><b>Scores against</b>a fixed list of 28 questions a hiring manager needs answered. Coverage is a percentage, so the checker measures instead of arguing.</div>\`)}

    \${stage('Worker four · the writer','It writes the thing you send',
      \`<p>Only after the checker clears. A short technical brief that opens inside their problem, one link to something you built that acts on it, what the first thirty days would look like as work, and a paragraph naming what you do not know.</p>
       <p>That last paragraph is the part that earns the reply. Anyone can send a confident letter. Almost nobody sends one that names its own limits, and for a job about judging what models get wrong, that is the qualification.</p>\`,
      \`<div class="reads"><b>Written so far</b><span class="count">\${D.packets}</span> \${D.packets===1?'letter':'letters'} · \${D.ledger} sent · \${D.slots} of \${D.capWeek} slots left this week</div>\`)}

    <h2>Your queue, and how to come at it</h2>
    <p class="lede">\${esc(k.blurb)}</p>
    <p><b>Who to reach:</b> \${esc(k.who)}<br><b>How to open:</b> \${esc(k.open)}</p>
    \${rows}

    <div class="hint"><b>The method, in one line.</b> Do not tell them what you are good at. Find the one thing capping what they can ship, prove you already built something that acts on it, and send that to a named person. Everything above exists to protect the handful of hours a week you can spend doing that well.</div>\`;

  const stages = [...document.querySelectorAll('.stage')];
  stages.forEach((s,i) => setTimeout(() => s.classList.add('on'), i * 260));
  document.getElementById('relay').scrollIntoView({behavior:'smooth', block:'start'});
}

const REASONS = ${JSON.stringify(REASON)};

document.getElementById('kinds').addEventListener('click', e => {
  const btn = e.target.closest('.kind'); if (!btn) return;
  document.querySelectorAll('.kind').forEach(b => b.setAttribute('aria-pressed','false'));
  btn.setAttribute('aria-pressed','true');
  render(D.kinds[+btn.dataset.i]);
});
document.addEventListener('click', e => {
  const c = e.target.closest('.copy'); if (!c) return;
  navigator.clipboard.writeText(c.dataset.copy).then(() => {
    const t = c.textContent; c.textContent = 'Copied'; setTimeout(() => c.textContent = t, 1400);
  });
});
</script></body></html>`;

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/walkthrough.html'), html);
console.log(`Wrote data/walkthrough.html — ${kinds.length} kinds of work, ${queue.length} queued, ${diagnoses.length} researched.`);
console.log('Open it: open data/walkthrough.html');
