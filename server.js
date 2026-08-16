// Local dashboard.
//
// The terminal is a fine place to run this system and a poor place to see it.
// This serves one page on localhost that shows the queue, the drum, and the
// clearance state of every diagnosis on disk, and lets a click spend a slot.
//
//   npm start   →   http://localhost:3000
//
// Built on node:http. The repo has one dependency and the page it serves has no
// framework, so adding Express to route four paths would cost more than it pays.
//
// Three things this server does not do, all of them deliberate:
//
//   1. It never sends. `/ship` drafts into `packets/`, exactly as it does from
//      the terminal, and the page says so on every packet it links. The send
//      stays a human act performed somewhere else.
//   2. It never interpolates a company name into a shell string. Names are
//      matched against `data/queue.json` first and passed to spawn as one
//      argument in an array, with no shell. An unrecognized name is a 400.
//   3. It runs one job at a time. A drum slot is serial by definition, and two
//      concurrent diagnoses would spend two slots while showing one log.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { openSlots, loadLedger, weekStart } from './src/ledger.js';

const ROOT = path.resolve(import.meta.dirname);
const PORT = Number(process.env.PORT || 3000);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ''));

const readJson = (p, fallback) => {
  try {
    const full = path.join(ROOT, p);
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
};

const readYaml = (p) => {
  try {
    const full = path.join(ROOT, p);
    return fs.existsSync(full) ? yaml.load(fs.readFileSync(full, 'utf8')) : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- state

// A company can hold two queue rows — the scout caps at two, it does not cap at
// one — and the filename only carries a role slug, so matching on company alone
// hands one role's diagnosis to the other role's card. That would offer to ship a
// packet written about a different job. Match the company from the filename and
// then the role from inside the file.
const roleKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function diagnosisFile(company, title) {
  const dir = path.join(ROOT, 'data/diagnoses');
  if (!fs.existsSync(dir)) return null;
  const want = slug(company);
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f) && slug(f.replace(/\.ya?ml$/, '')).startsWith(want))
    .map((f) => path.join(dir, f));
  if (!candidates.length) return null;
  if (!title) return candidates.length === 1 ? candidates[0] : null;

  const t = roleKey(title);
  for (const file of candidates) {
    const r = roleKey(readYaml(path.relative(ROOT, file))?.role);
    if (r && (r === t || r.includes(t) || t.includes(r))) return file;
  }
  return null;
}

// packet.md's four entry gates plus the named human it refuses to invent. The
// page reports them; it does not decide them.
function gatesFor(d) {
  const dmName = String(d.decision_maker?.name ?? '');
  const dmOk = Boolean(dmName) && !/INSUFFICIENT_EVIDENCE/i.test(dmName);
  const gates = [
    { label: 'Diagnosis SHIP', ok: d.verdict === 'SHIP', detail: d.verdict || 'absent' },
    { label: 'Audit PASS', ok: d.audit?.verdict === 'PASS', detail: d.audit?.verdict || 'not audited' },
    { label: 'Acquittal', ok: d.acquittal === 'EVIDENCE_SUFFICIENT', detail: d.acquittal || 'field absent' },
    {
      label: 'Sovereign proof on it',
      ok: d.proof_match?.tier === 'sovereign' && d.proof_match?.acts_on_constraint === true,
      detail: d.proof_match?.tier || 'absent',
    },
    { label: 'Named decision-maker', ok: dmOk, detail: dmOk ? dmName.split('—')[0].trim() : 'no name' },
  ];
  return { gates, shippable: gates.every((g) => g.ok) };
}

// Observables per company, counted from the newest brief that names it. The
// briefs are markdown with "## Company — title" sections and a "### Observables"
// list, so this counts list items inside that section and nothing else.
function observablesFor(company) {
  const dir = path.join(ROOT, 'data/briefs');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse();
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const sections = text.split(/^## /m).slice(1);
    const section = sections.find((s) => s.toLowerCase().startsWith(String(company).toLowerCase()));
    if (!section) continue;
    const obs = section.split(/^### /m).find((s) => /^observables/i.test(s));
    if (!obs) continue;
    const n = (obs.match(/^- /gm) || []).length;
    return { count: n, brief: f.replace(/\.md$/, '') };
  }
  return null;
}

function state() {
  const cfg = readYaml('profile/gates.yaml') || readYaml('profile/gates.example.yaml') || {};
  const cap = cfg.drum?.packets_per_week ?? 5;
  const slots = openSlots(ROOT, cfg);
  const today = new Date().toISOString().slice(0, 10);

  const rows = readQueue().map((j, i) => {
    const file = diagnosisFile(j.company, j.title);
    const d = file ? readYaml(path.relative(ROOT, file)) : null;
    const g = d ? gatesFor(d) : null;
    const reportRel = file ? path.relative(ROOT, file).replace(/\.ya?ml$/, '.html') : null;
    return {
      rank: i + 1,
      company: j.company,
      title: j.title,
      archetype: j.archetype || '',
      url: j.url || '',
      score: j.compositeScore ?? j.score ?? j.fitScore ?? null,
      fit: j.fitScore ?? j.fit ?? null,
      comp: j.comp ? { min: j.comp.min ?? null, max: j.comp.max ?? null } : null,
      flags: j.flags || [],
      observables: observablesFor(j.company),
      diagnosis: d
        ? {
            file: path.relative(ROOT, file),
            dated: dateStr(d.dated),
            verdict: d.verdict || null,
            audit: d.audit?.verdict || null,
            coverage: d.audit?.coverage_score ?? null,
            struck: d.strikes?.claims_struck ?? null,
            tested: d.strikes?.claims_tested ?? null,
            sameDay: dateStr(d.dated) === today,
            gates: g.gates,
            shippable: g.shippable,
            report: reportRel && fs.existsSync(path.join(ROOT, reportRel)) ? reportRel : null,
          }
        : null,
      packets: packetsFor(j.company),
    };
  });

  return {
    today,
    weekStart: weekStart(),
    cap,
    slots,
    used: cap - slots,
    sent: loadLedger(ROOT).length,
    rows,
    job: current ? jobView(current) : null,
  };
}

function readQueue() {
  const q = readJson('data/queue.json', []);
  return Array.isArray(q) ? q : q.rows || q.queue || [];
}

function packetsFor(company) {
  const dir = path.join(ROOT, 'packets');
  if (!fs.existsSync(dir)) return [];
  const want = slug(company);
  return fs
    .readdirSync(dir)
    .filter((f) => slug(f).startsWith(want) && fs.existsSync(path.join(dir, f)))
    .map((f) => ({
      dir: `packets/${f}`,
      files: ['brief.md', 'outreach.md', 'resume-delta.md', 'brief.html'].filter((n) =>
        fs.existsSync(path.join(dir, f, n))
      ),
    }));
}

// ---------------------------------------------------------------- jobs

// One at a time. The log is a ring of lines the page replays on connect, so a
// reload mid-run does not lose the transcript.
let current = null;
let jobSeq = 0;
const listeners = new Set();

const jobView = (j) => ({
  id: j.id,
  action: j.action,
  company: j.company,
  started: j.started,
  done: j.done,
  code: j.code,
  lines: j.lines,
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(payload);
    } catch {
      listeners.delete(res);
    }
  }
}

function push(job, stream, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    job.lines.push({ stream, line });
    if (job.lines.length > 2000) job.lines.shift();
    broadcast('line', { stream, line });
  }
}

// The prompt is the slash command, exactly what the terminal runs. Tools are
// bounded the way bin/run.sh bounds them: Task so the command can reach its
// subagent, and the file and network reads those subagents declare. No Bash.
function argsFor(action, company) {
  return [
    '-p',
    `/${action} ${company}`,
    '--allowedTools',
    'Task,Read,Write,Glob,Grep,WebFetch,WebSearch',
    '--permission-mode',
    'acceptEdits',
    '--max-turns',
    action === 'diagnose' ? '40' : '30',
    '--output-format',
    'text',
  ];
}

function startJob(action, company) {
  const job = {
    id: ++jobSeq,
    action,
    company,
    started: new Date().toISOString(),
    done: false,
    code: null,
    lines: [],
  };
  current = job;
  broadcast('start', jobView(job));

  push(job, 'meta', `$ ${CLAUDE_BIN} -p "/${action} ${company}"`);

  let child;
  try {
    child = spawn(CLAUDE_BIN, argsFor(action, company), { cwd: ROOT, env: process.env });
  } catch (err) {
    push(job, 'stderr', `could not start ${CLAUDE_BIN}: ${err.message}`);
    finish(job, 127);
    return job;
  }

  child.stdout.on('data', (b) => push(job, 'stdout', b.toString()));
  child.stderr.on('data', (b) => push(job, 'stderr', b.toString()));
  child.on('error', (err) => push(job, 'stderr', `${CLAUDE_BIN}: ${err.message}`));
  child.on('close', (code) => {
    if (code !== 0) return finish(job, code);

    // Two deterministic steps run after the model is done.
    //
    // The case file is the system's memory across weeks, and it is written here
    // rather than by the agent because this path has no Bash: argsFor() grants
    // Task, Read, Write, Glob, Grep and the two web tools, so a model running
    // from the dashboard cannot execute the node command the slash command
    // names. The recorder derives every field from the audited artifact on
    // disk, and it refuses an artifact with no audit block, so what reaches
    // memory is only what the auditor already ruled on. It is idempotent by
    // artifact digest, which is why running it from both paths is safe.
    //
    // Then render, so the page has something to show. /ship already calls the
    // renderer itself; /diagnose does not, by design, because rendering is not
    // part of diagnosing.
    const steps = [['src/casefile.js', '--record', company, '--stage', action]];
    if (action === 'diagnose') steps.push(['src/renderBrief.js', company]);
    runSteps(job, steps, () => finish(job, code));
  });

  return job;
}

// Sequential node steps, logged into the same job. A failing step is recorded
// and does not change the job's exit code: the model's run either worked or it
// did not, and a bookkeeping failure afterward must not report the diagnosis as
// failed. The log carries the stderr either way.
function runSteps(job, steps, done) {
  const [next, ...rest] = steps;
  if (!next) return done();
  push(job, 'meta', `$ node ${next.join(' ')}`);
  let step;
  try {
    step = spawn(process.execPath, next, { cwd: ROOT, env: process.env });
  } catch (err) {
    push(job, 'stderr', `${next[0]}: ${err.message}`);
    return runSteps(job, rest, done);
  }
  step.stdout.on('data', (b) => push(job, 'stdout', b.toString()));
  step.stderr.on('data', (b) => push(job, 'stderr', b.toString()));
  step.on('error', (err) => push(job, 'stderr', `${next[0]}: ${err.message}`));
  step.on('close', () => runSteps(job, rest, done));
}

function finish(job, code) {
  job.done = true;
  job.code = code;
  push(job, 'meta', code === 0 ? 'done' : `exited ${code}`);
  broadcast('done', { id: job.id, code });
}

// ---------------------------------------------------------------- routes

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

function serveReport(res, rel) {
  // Only ever a rendered page inside the repo, resolved and re-checked.
  const full = path.resolve(ROOT, rel);
  const okRoot = full.startsWith(path.join(ROOT, 'data/diagnoses')) || full.startsWith(path.join(ROOT, 'packets'));
  if (!okRoot || !/\.html$/.test(full) || !fs.existsSync(full)) return json(res, 404, { error: 'no report' });
  const body = fs.readFileSync(full);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && u.pathname === '/') {
    const body = page();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    return res.end(body);
  }

  if (req.method === 'GET' && u.pathname === '/api/state') return json(res, 200, state());

  if (req.method === 'GET' && u.pathname === '/report') return serveReport(res, u.searchParams.get('f') || '');

  if (req.method === 'GET' && u.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    listeners.add(res);
    if (current) res.write(`event: replay\ndata: ${JSON.stringify(jobView(current))}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      listeners.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/run') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4096) req.destroy();
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { error: 'bad json' });
      }

      const action = body.action;
      if (action !== 'diagnose' && action !== 'ship') return json(res, 400, { error: 'action must be diagnose or ship' });

      // The allowlist. A company the queue does not name never reaches spawn.
      const row = readQueue().find((j) => j.company === body.company);
      if (!row) return json(res, 400, { error: 'company is not a row in data/queue.json' });

      if (current && !current.done) return json(res, 409, { error: 'a job is already running' });

      if (action === 'ship') {
        const file = diagnosisFile(row.company, row.title);
        const d = file ? readYaml(path.relative(ROOT, file)) : null;
        if (!d) return json(res, 409, { error: 'no diagnosis on disk' });
        const g = gatesFor(d);
        if (!g.shippable)
          return json(res, 409, {
            error: 'not cleared',
            failing: g.gates.filter((x) => !x.ok).map((x) => x.label),
          });
      }

      if (action === 'diagnose' && !body.confirm) {
        const file = diagnosisFile(row.company, row.title);
        const d = file ? readYaml(path.relative(ROOT, file)) : null;
        const sameDay = d && dateStr(d.dated) === new Date().toISOString().slice(0, 10);
        return json(res, 428, {
          error: 'confirm required',
          spends_slot: true,
          already_today: Boolean(sameDay),
        });
      }

      return json(res, 200, { job: jobView(startJob(action, row.company)) });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

// ---------------------------------------------------------------- page

function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bottleneck</title>
<style>
:root {
  --paper:#F9F9FB; --ink:#111111; --rule:#E5E5E7; --muted:#6B6B70; --accent:#FF4500;
  --sans: Inter, -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: "SF Mono", ui-monospace, Menlo, monospace;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font-family:var(--sans);
       font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased; }
.wrap { max-width:1180px; margin:0 auto; padding:34px 28px 80px; }
a { color:inherit; }
button { font:inherit; cursor:pointer; }
h1 { font-size:27px; font-weight:600; letter-spacing:-0.02em; margin:0; }
h2 { font-family:var(--mono); font-size:11px; font-weight:600; letter-spacing:0.12em;
     text-transform:uppercase; color:var(--muted); margin:38px 0 12px;
     padding-bottom:8px; border-bottom:1px solid var(--rule); }
.mono { font-family:var(--mono); }
.muted { color:var(--muted); }

header { display:flex; justify-content:space-between; align-items:flex-start;
         gap:24px; border-bottom:1px solid var(--ink); padding-bottom:18px; flex-wrap:wrap; }
.drum { text-align:right; }
.drum-n { font-size:40px; font-weight:600; line-height:1; letter-spacing:-0.03em; }
.drum-l { font-family:var(--mono); font-size:10px; letter-spacing:0.1em;
          text-transform:uppercase; color:var(--muted); margin-top:6px; }
.pips { display:flex; gap:5px; justify-content:flex-end; margin-top:8px; }
.pip { width:16px; height:16px; border:1.5px solid var(--ink); }
.pip.spent { background:var(--ink); }

.notice { border:1px solid var(--ink); border-left-width:6px; padding:11px 15px; margin:22px 0 0;
          font-size:13.5px; }
.notice b { font-family:var(--mono); font-size:10.5px; letter-spacing:0.09em; text-transform:uppercase; }

.cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px,1fr)); gap:16px; }
.card { border:1px solid var(--rule); background:#fff; padding:16px 17px; display:flex;
        flex-direction:column; gap:10px; }
.card.open { border-color:var(--ink); }
.card-top { display:flex; gap:10px; align-items:baseline; }
.rank { font-family:var(--mono); font-size:11px; color:var(--muted); }
.co { font-weight:600; letter-spacing:-0.01em; }
.ttl { font-size:13.5px; color:var(--muted); margin:0; }
.facts { display:flex; gap:14px; flex-wrap:wrap; font-family:var(--mono); font-size:10.5px;
         letter-spacing:0.06em; text-transform:uppercase; color:var(--muted); }
.badge { display:inline-block; font-family:var(--mono); font-size:10px; font-weight:600;
         letter-spacing:0.09em; text-transform:uppercase; padding:3px 7px;
         border:1.5px solid var(--muted); color:var(--muted); }
.badge.pass { border-color:var(--accent); color:var(--accent); }
.badge.rej { border-color:var(--ink); color:var(--ink); }
.gates { list-style:none; margin:0; padding:0; font-size:12.5px; }
.gates li { display:flex; gap:7px; padding:3px 0; }
.gates .m { font-family:var(--mono); width:13px; flex:none; }
.gates li.no { color:var(--ink); }
.gates li.yes { color:var(--muted); }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:2px; }
button.act { border:1.5px solid var(--ink); background:transparent; color:var(--ink);
             font-family:var(--mono); font-size:10.5px; font-weight:600; letter-spacing:0.09em;
             text-transform:uppercase; padding:7px 12px; }
button.act:hover:not(:disabled) { background:var(--ink); color:#fff; }
button.act:disabled { border-color:var(--rule); color:var(--rule); cursor:not-allowed; }
button.act.go { border-color:var(--accent); color:var(--accent); }
button.act.go:hover:not(:disabled) { background:var(--accent); color:#fff; }

#log { border:1px solid var(--rule); background:#fff; }
#log summary { font-family:var(--mono); font-size:11px; font-weight:600; letter-spacing:0.1em;
               text-transform:uppercase; padding:11px 15px; cursor:pointer; }
#lines { font-family:var(--mono); font-size:11.5px; line-height:1.55; max-height:340px;
         overflow:auto; padding:0 15px 14px; white-space:pre-wrap; word-break:break-word; }
#lines .stderr { color:var(--accent); }
#lines .meta { color:var(--muted); }
iframe { width:100%; height:78vh; border:1px solid var(--rule); background:#fff; }
.viewer-head { display:flex; justify-content:space-between; align-items:baseline; gap:14px; flex-wrap:wrap; }
.pkt { font-size:13px; }
.pkt a { font-family:var(--mono); font-size:11.5px; margin-right:12px; }
</style>
</head>
<body>
<div class="wrap">

<header>
  <div>
    <h1>Bottleneck</h1>
    <p class="muted" style="margin:5px 0 0">The slowest part sets the pace for everything else.</p>
  </div>
  <div class="drum">
    <div class="drum-n" id="slots">–</div>
    <div class="pips" id="pips"></div>
    <div class="drum-l" id="drumlabel">packet slots</div>
  </div>
</header>

<div class="notice">
  <b>This drafts. It never sends.</b><br>
  Diagnose spends a drum slot and asks first. Ship writes a packet into <span class="mono">packets/</span>
  and nothing else. No mail client, no ATS, no posting. The send stays yours, somewhere else.
</div>

<h2>Queue</h2>
<div class="cards" id="cards"></div>

<h2>Run log</h2>
<details id="log" open>
  <summary id="logsum">Idle</summary>
  <div id="lines"></div>
</details>

<h2>Report</h2>
<div class="viewer-head">
  <p class="muted" id="viewerlabel" style="margin:0 0 10px">Nothing loaded. Open a report from a card above.</p>
  <p class="pkt" id="pktlinks"></p>
</div>
<iframe id="viewer" title="Rendered brief"></iframe>

</div>
<script>
const money = (c) => c && (c.min || c.max)
  ? '$' + Math.round((c.min||0)/1000) + 'K–$' + Math.round((c.max||0)/1000) + 'K'
  : 'no band';

let running = false;

function card(r) {
  const d = r.diagnosis;
  const el = document.createElement('div');
  el.className = 'card' + (d ? '' : ' open');

  const gates = d ? '<ul class="gates">' + d.gates.map(g =>
    '<li class="' + (g.ok?'yes':'no') + '"><span class="m">' + (g.ok?'✓':'—') + '</span>' +
    '<span>' + g.label + '</span><span class="muted"> · ' + g.detail + '</span></li>').join('') + '</ul>' : '';

  const badge = d
    ? (d.audit === 'PASS' ? '<span class="badge pass">Audit PASS</span>'
      : d.audit === 'REJECT' ? '<span class="badge rej">Audit REJECT</span>'
      : '<span class="badge">Diagnosed, not audited</span>')
    : '<span class="badge">Not diagnosed</span>';

  const struck = d && d.struck != null
    ? '<span class="badge">' + d.struck + ' of ' + d.tested + ' struck</span>' : '';
  const cov = d && d.coverage != null ? '<span class="badge">Coverage ' + d.coverage + '</span>' : '';

  el.innerHTML =
    '<div class="card-top"><span class="rank">' + r.rank + '</span><span class="co">' + r.company + '</span></div>' +
    '<p class="ttl">' + r.title + '</p>' +
    '<div class="facts"><span>' + money(r.comp) + '</span>' +
    (r.score != null ? '<span>score ' + r.score + '</span>' : '') +
    (r.observables ? '<span>' + r.observables.count + ' observables · ' + r.observables.brief + '</span>'
                   : '<span>no brief</span>') +
    '</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap">' + badge + cov + struck + '</div>' +
    gates +
    (d && d.sameDay ? '<p class="muted" style="font-size:12.5px;margin:0">Diagnosed today. Running again spends a second slot on the same company.</p>' : '') +
    '<div class="actions"></div>';

  const acts = el.querySelector('.actions');

  const diag = document.createElement('button');
  diag.className = 'act' + (d ? '' : ' go');
  diag.textContent = d ? 'Re-diagnose' : 'Diagnose';
  diag.disabled = running;
  diag.onclick = () => run('diagnose', r.company, d && d.sameDay);
  acts.appendChild(diag);

  if (d) {
    const ship = document.createElement('button');
    ship.className = 'act' + (d.shippable ? ' go' : '');
    ship.textContent = 'Ship packet';
    ship.disabled = running || !d.shippable;
    ship.title = d.shippable ? 'Drafts into packets/' :
      'Blocked: ' + d.gates.filter(g => !g.ok).map(g => g.label).join(', ');
    ship.onclick = () => run('ship', r.company, false);
    acts.appendChild(ship);

    if (d.report) {
      const view = document.createElement('button');
      view.className = 'act';
      view.textContent = 'Open report';
      view.onclick = () => show(d.report, r.company, r.packets);
      acts.appendChild(view);
    }
  }
  return el;
}

function show(rel, company, packets) {
  document.getElementById('viewer').src = '/report?f=' + encodeURIComponent(rel);
  document.getElementById('viewerlabel').textContent = company + ' · ' + rel;
  const links = (packets || []).flatMap(p => p.files.map(f =>
    '<a href="/report?f=' + encodeURIComponent(p.dir + '/' + f) + '">' + f + '</a>'));
  document.getElementById('pktlinks').innerHTML = links.length
    ? 'Packet: ' + links.join('') : '';
}

async function run(action, company, alreadyToday) {
  if (action === 'diagnose') {
    const warn = alreadyToday
      ? company + ' already has a diagnosis dated today. Running again spends a SECOND drum slot on the same company. Continue?'
      : 'This spends one drum slot on ' + company + '. Continue?';
    if (!confirm(warn)) return;
  } else {
    if (!confirm('Draft a packet for ' + company + '? It writes files into packets/ and sends nothing.')) return;
  }
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, company, confirm: true })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(body.error + (body.failing ? ': ' + body.failing.join(', ') : ''));
    return;
  }
  document.getElementById('log').open = true;
}

function line(l) {
  const box = document.getElementById('lines');
  const div = document.createElement('div');
  div.className = l.stream;
  div.textContent = l.line;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function load() {
  const s = await (await fetch('/api/state')).json();
  document.getElementById('slots').textContent = s.slots;
  document.getElementById('drumlabel').innerHTML =
    'packet slots left of ' + s.cap + ' · week of ' + s.weekStart + '<br>' + s.sent + ' sent, counted from the ledger';
  document.getElementById('pips').innerHTML =
    Array.from({length: s.cap}, (_, i) => '<span class="pip' + (i < s.used ? ' spent' : '') + '"></span>').join('');
  running = Boolean(s.job && !s.job.done);
  const cards = document.getElementById('cards');
  cards.innerHTML = '';
  s.rows.forEach(r => cards.appendChild(card(r)));
  if (s.job) {
    document.getElementById('logsum').textContent =
      (s.job.done ? 'Finished' : 'Running') + ' · /' + s.job.action + ' ' + s.job.company;
  }
}

const es = new EventSource('/api/stream');
es.addEventListener('replay', (e) => {
  const j = JSON.parse(e.data);
  document.getElementById('lines').innerHTML = '';
  j.lines.forEach(line);
});
es.addEventListener('start', (e) => {
  const j = JSON.parse(e.data);
  document.getElementById('lines').innerHTML = '';
  document.getElementById('logsum').textContent = 'Running · /' + j.action + ' ' + j.company;
  running = true;
  load();
});
es.addEventListener('line', (e) => line(JSON.parse(e.data)));
es.addEventListener('done', () => {
  running = false;
  const sum = document.getElementById('logsum');
  sum.textContent = sum.textContent.replace('Running', 'Finished');
  load();
});

load();
</script>
</body>
</html>`;
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Bottleneck dashboard on http://localhost:${PORT}`);
  console.log(`  ${readQueue().length} queue rows · ${openSlots(ROOT)} packet slots open · drafts only, never sends`);
});
