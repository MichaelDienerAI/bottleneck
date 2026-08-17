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
import { openSlots, ledgerState, weekStart } from './src/ledger.js';
import { shouldSkip } from './src/casefile.js';
import { compositeScore } from './src/gates.js';
import { strikeRow, strikeRecord, eligibleBackfill, pickBackfill } from './src/queue.js';
import { inspectArtifact } from './src/validateArtifact.js';

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

// Atomic. writeFileSync truncates and then fills, so a reader that opens the
// file in between gets a torn one — and the diagnostician reads data/queue.json
// while it runs, so "in between" is a real moment here rather than a
// theoretical one. Write beside it and rename, which is atomic on one
// filesystem, so a concurrent reader sees either the old file or the new one.
const writeJson = (p, v) => {
  const full = path.join(ROOT, p);
  const tmp = `${full}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, full);
};

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

// A job whose child has exited but whose 'close' never arrived would leave the
// page locked forever, every action disabled, with nothing on screen explaining
// why and no way to clear it short of restarting the server. The close handler
// is reliable in practice, so this is insurance rather than a fix: if the
// process is gone and the record still says running, close the record.
function reconcileJob() {
  if (!current || current.done || !current.child) return;
  const c = current.child;
  if (c.exitCode !== null || c.signalCode !== null) {
    push(current, 'meta', 'child exited without a close event; reconciled by the server');
    finish(current, c.exitCode ?? 1);
  }
}

function state() {
  reconcileJob();
  const cfg = readYaml('profile/gates.yaml') || readYaml('profile/gates.example.yaml') || {};
  const cap = cfg.drum?.packets_per_week ?? 5;
  const slots = openSlots(ROOT, cfg);
  const led = ledgerState(ROOT);
  const today = new Date().toISOString().slice(0, 10);

  const queue = readQueue();
  const rows = queue.map((j, i) => {
    const file = diagnosisFile(j.company, j.title);
    const d = file ? readYaml(path.relative(ROOT, file)) : null;
    const g = d ? gatesFor(d) : null;
    const reportRel = file ? path.relative(ROOT, file).replace(/\.ya?ml$/, '.html') : null;
    return {
      rank: i + 1,
      // The board key. /api/strike addresses a row by this and not by company,
      // because a company can hold two rows and striking by name would remove
      // whichever one happened to be first.
      key: j.key,
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

  const waiting = bench(queue, cfg);
  const struck = readJson('data/struck.json', []);

  return {
    today,
    weekStart: weekStart(),
    cap,
    slots,
    used: cap - slots,
    // ledgerState rather than loadLedger: this runs on every dashboard poll, and
    // loadLedger throws on a corrupt file. An unreadable ledger already closes
    // the drum through openSlots above; it should not also take the page down and
    // leave no way to see that that is why.
    sent: led.state === 'ok' ? led.rows.length : null,
    ledger_state: led.state,
    rows,
    bufferMax: cfg.drum?.buffer_max ?? 10,
    bench: waiting.slice(0, 6).map((c) => ({
      key: c.key,
      company: c.company,
      title: c.title,
      archetype: c.archetype || '',
      fit: c.fit ?? null,
      comp: c.comp ? { min: c.comp.min ?? null, max: c.comp.max ?? null } : null,
    })),
    benchTotal: waiting.length,
    struck: struck.slice(-8).reverse().map((r) => ({
      company: r.company,
      title: r.title,
      struck_at: r.struck_at,
    })),
    struckTotal: struck.length,
    job: current ? jobView(current) : null,
  };
}

function readQueue() {
  const q = readJson('data/queue.json', []);
  return Array.isArray(q) ? q : q.rows || q.queue || [];
}

// Archetype allocation weights, read the same way scan.js reads them, so a
// backfilled row carries a score computed by the same function that ordered the
// buffer. A replacement scored by a different rule would sort against rows it
// is supposed to sit beside.
function archetypeWeights() {
  const registry = readYaml('profile/companies.yaml');
  const weights = {};
  for (const [archetype, block] of Object.entries(registry?.archetypes || {})) {
    weights[archetype] = block.weight;
  }
  return weights;
}

// Everything eligible to take a vacated buffer slot, ranked. Shown on the page
// as the bench, and drawn from by /api/strike. One function for both, so what
// the page promises is what the strike actually does.
function bench(queue, cfg) {
  return eligibleBackfill(readJson('data/candidates.json', []), {
    queue,
    struckKeys: new Set(readJson('data/struck.json', []).map((r) => r.key)),
    delistedKeys: new Set(readJson('data/delisted.json', []).map((r) => r.key)),
    isClosed: (company) => shouldSkip(company).skip,
    maxPerCompany: cfg.drum?.max_per_company ?? 2,
  });
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

  // Kept so state() can tell a job that is still running from one whose child
  // is gone. Never serialized: jobView picks its fields explicitly.
  job.child = child;

  child.stdout.on('data', (b) => push(job, 'stdout', b.toString()));
  child.stderr.on('data', (b) => push(job, 'stderr', b.toString()));
  child.on('error', (err) => push(job, 'stderr', `${CLAUDE_BIN}: ${err.message}`));
  child.on('close', (code) => {
    if (code !== 0) return finish(job, code);

    // The completion gate. The model is done; nothing it produced has been
    // checked. This runs before the recorder because the case file is the store
    // a later run inherits as settled, and an artifact that fails its schema must
    // not become a prior.
    //
    // A limitation worth stating rather than hiding: this path cannot seal. The
    // seal is taken between the diagnostician and the auditor, and both run
    // inside the single child session spawned above, so there is no moment out
    // here to interpose on. argsFor() also grants no Bash, so the model cannot
    // run the seal command itself. Dashboard-run diagnoses are therefore
    // unsealed, and the gate reports that rather than implying otherwise.
    if (!gateArtifact(job)) return finish(job, code);

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

// Runs the schema gate and the seal check on the artifact this job produced, and
// writes what it found into the job log so the dashboard shows it rather than
// only the terminal.
//
// Returns false when the artifact must not proceed to the recorder. A missing
// artifact is not a gate failure: the model may have stopped for its own
// reasons, and the recorder reports that in its own words a step later.
function gateArtifact(job) {
  const row = readQueue().find((j) => j.company === job.company);
  const file = diagnosisFile(job.company, row?.title);
  if (!file) {
    push(job, 'meta', 'no diagnosis on disk to validate');
    return true;
  }

  const rel = path.relative(ROOT, file);
  const doc = readYaml(rel);
  if (!doc) {
    push(job, 'stderr', `${rel} will not parse as YAML. Refusing to record it.`);
    return false;
  }

  push(job, 'meta', `$ schema gate ${rel}`);
  const result = inspectArtifact(doc, { artifact: rel });
  for (const f of result.findings) {
    if (f.severity === 'error') push(job, 'stderr', `FAIL [${f.rule}] ${f.message}`);
    else if (f.severity === 'warning') push(job, 'stdout', `warn [${f.rule}] ${f.message}`);
    else push(job, 'stdout', `     [${f.rule}] ${f.message}`);
    if (f.question) push(job, 'stdout', `     filing standard Q${f.question}: ${f.question_text}`);
  }
  if (!result.ok) {
    push(job, 'stderr', 'Artifact failed the schema gate. The case file was not written.');
    return false;
  }
  push(job, 'stdout', `schema gate passed${result.seal ? ` · seal ${result.seal.state}` : ''}`);
  return true;
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

  // Strike one buffer row and backfill the slot it leaves.
  //
  // The only route that edits data/queue.json. Three guards, in this order:
  //
  //   1. Not while a job runs. /api/run resolves a company against the queue
  //      before it spawns, so editing the queue mid-run could hand the child a
  //      row that no longer exists.
  //   2. The key has to name a row in the queue. Same allowlist discipline as
  //      /api/run: an unrecognized key is a 400, never a no-op that reports OK.
  //   3. confirm must be true. The page asks with two buttons; this makes a
  //      stray POST from anywhere else fail closed.
  //
  // It records the strike before it writes the queue, so a crash between the two
  // leaves a log entry with no removal rather than a removal with no log.
  if (req.method === 'POST' && u.pathname === '/api/strike') {
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

      const queue = readQueue();
      const { queue: next, struck } = strikeRow(queue, body.key);
      if (!struck) return json(res, 400, { error: 'key is not a row in data/queue.json' });

      // Only the row under diagnosis is protected, not the whole buffer.
      //
      // This refused every strike while any job ran, which locked the button for
      // the twenty minutes a diagnosis takes and made it read as broken. The
      // real hazard is narrow: the diagnostician reads data/queue.json for the
      // company it was spawned on, so removing THAT row mid-run pulls the
      // posting out from under it. Every other row is untouched by that child,
      // and writeJson is atomic, so there is no torn read either.
      if (current && !current.done && struck.company === current.company) {
        return json(res, 409, {
          error: `/${current.action} ${current.company} is running and reads this row. Wait for it to finish.`,
        });
      }
      if (!body.confirm) return json(res, 428, { error: 'confirm required', removes: struck.company });

      const cfg = readYaml('profile/gates.yaml') || readYaml('profile/gates.example.yaml') || {};
      const today = localToday();

      const log = readJson('data/struck.json', []);
      log.push(strikeRecord(struck, { at: today, reason: body.reason ?? null }));
      writeJson('data/struck.json', log);

      // Backfill from the bench, which already excludes the row just struck
      // because data/struck.json was written first.
      const pick = pickBackfill(readJson('data/candidates.json', []), {
        queue: next,
        struckKeys: new Set(log.map((r) => r.key)),
        delistedKeys: new Set(readJson('data/delisted.json', []).map((r) => r.key)),
        isClosed: (company) => shouldSkip(company).skip,
        maxPerCompany: cfg.drum?.max_per_company ?? 2,
        avoidCompany: struck.company,
      });

      // Replace one with at most one. The buffer never grows on a strike: its
      // size was set by the rope at scan time (min(buffer_max, slots + 5)), and
      // slots may have been spent since.
      if (pick) {
        next.push({
          ...pick,
          score: Number(compositeScore(pick, archetypeWeights(), cfg).toFixed(2)),
          backfilled_at: today,
          backfilled_for: struck.key,
        });
      }
      writeJson('data/queue.json', next);

      return json(res, 200, {
        struck: { company: struck.company, title: struck.title },
        backfilled: pick ? { company: pick.company, title: pick.title } : null,
        queue: next.length,
      });
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
.actions, .confirm-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:2px; }
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
.seg { display:inline-flex; }
.seg button + button { margin-left:-1.5px; }
.seg button[aria-pressed="true"] { background:var(--ink); color:#fff; }
.pkt { font-size:13px; }
.pkt a { font-family:var(--mono); font-size:11.5px; margin-right:12px; }

/* Strike. The checkbox sits in the card header and reveals its own confirm row,
   so the decision and its consequence are in the same place on the page. */
.card-top { justify-content:space-between; }
.card-id { display:flex; gap:10px; align-items:baseline; min-width:0; }
.strike-box { flex:none; display:flex; align-items:center; gap:6px; cursor:pointer;
              font-family:var(--mono); font-size:10px; letter-spacing:0.08em;
              text-transform:uppercase; color:var(--muted); }
.strike-box input { accent-color:var(--accent); cursor:pointer; margin:0; }
.confirm { display:none; border:1.5px solid var(--accent); padding:10px 12px; gap:8px;
           flex-direction:column; }
.card.striking .confirm { display:flex; }
.card.striking { border-color:var(--accent); }
.confirm p { margin:0; font-size:12.5px; }
button.act.danger { border-color:var(--accent); color:var(--accent); }
button.act.danger:hover:not(:disabled) { background:var(--accent); color:#fff; }

.bench { list-style:none; margin:0; padding:0; border:1px solid var(--rule); background:#fff; }
.bench li { display:flex; gap:12px; align-items:baseline; padding:9px 15px;
            border-bottom:1px solid var(--rule); font-size:13.5px; }
.bench li:last-child { border-bottom:0; }
.bench .n { font-family:var(--mono); font-size:11px; color:var(--muted); width:18px; flex:none; }
.bench .co { font-weight:600; }
.bench .tt { color:var(--muted); flex:1; min-width:0; }
.bench .meta { font-family:var(--mono); font-size:10.5px; letter-spacing:0.06em;
               text-transform:uppercase; color:var(--muted); flex:none; }
.empty { border:1px dashed var(--rule); padding:14px 15px; color:var(--muted); font-size:13.5px; }
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

<h2>Queue <span id="queuecount" class="muted" style="text-transform:none;letter-spacing:0"></span></h2>
<div class="cards" id="cards"></div>

<h2>Next up <span id="benchcount" class="muted" style="text-transform:none;letter-spacing:0"></span></h2>
<p class="muted" style="margin:-4px 0 12px;font-size:13.5px">
  Passed Gate 0, not in the buffer. Strike a queue row and the top eligible row here takes its place.
  An archetype with no row in the buffer goes first, which is why the top of this list is not always the highest score.
</p>
<ul class="bench" id="bench"></ul>

<h2>Struck <span id="struckcount" class="muted" style="text-transform:none;letter-spacing:0"></span></h2>
<p class="muted" style="margin:-4px 0 12px;font-size:13.5px">
  Rows you removed by hand, newest first, from <span class="mono">data/struck.json</span>.
  A struck row never returns on its own — not from a backfill and not from the next scan.
</p>
<ul class="bench" id="struck"></ul>

<h2>Run log</h2>
<details id="log" open>
  <summary id="logsum">Idle</summary>
  <div id="lines"></div>
</details>

<h2>Report</h2>
<div class="viewer-head">
  <p class="muted" id="viewerlabel" style="margin:0 0 10px">Nothing loaded. Open a report from a card above.</p>
  <div class="seg" id="viewseg" role="group" aria-label="Reading view" hidden>
    <button class="act" type="button" data-view="plain" aria-pressed="true">Plain English</button>
    <button class="act" type="button" data-view="audit" aria-pressed="false">Technical Audit</button>
  </div>
  <p class="pkt" id="pktlinks"></p>
</div>
<iframe id="viewer" title="Rendered brief"></iframe>

</div>
<script>
const money = (c) => c && (c.min || c.max)
  ? '$' + Math.round((c.min||0)/1000) + 'K–$' + Math.round((c.max||0)/1000) + 'K'
  : 'no band';

let running = false;
let runningCompany = null;
let runningAction = null;

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
    '<div class="card-top">' +
      '<span class="card-id"><span class="rank">' + r.rank + '</span><span class="co">' + r.company + '</span></span>' +
      '<label class="strike-box"><input type="checkbox"> strike</label>' +
    '</div>' +
    '<p class="ttl">' + r.title + '</p>' +
    '<div class="facts"><span>' + money(r.comp) + '</span>' +
    (r.score != null ? '<span>score ' + r.score + '</span>' : '') +
    (r.observables ? '<span>' + r.observables.count + ' observables · ' + r.observables.brief + '</span>'
                   : '<span>no brief</span>') +
    '</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap">' + badge + cov + struck + '</div>' +
    gates +
    (d && d.sameDay ? '<p class="muted" style="font-size:12.5px;margin:0">Diagnosed today. Running again spends a second slot on the same company.</p>' : '') +
    '<div class="confirm"></div>' +
    '<div class="actions"></div>';

  // Resolved before anything is appended, and scoped to this card's own direct
  // child. It used to be a bare el.querySelector('.actions') AFTER the confirm
  // panel was built, and the confirm panel's button row also carried class
  // "actions" — so the first match in document order was the row inside the
  // hidden panel, and Diagnose, Re-diagnose, Ship packet and Open report were
  // all appended into a container styled display:none. The buttons existed and
  // were unreachable unless you ticked the strike box.
  const acts = el.querySelector(':scope > .actions');

  // The strike checkbox and its two buttons. Nothing happens on the check
  // itself — it only reveals the choice, and Cancel puts the card back exactly
  // as it was. The removal needs a second, deliberate click.
  const box = el.querySelector('.strike-box input');
  const confirm = el.querySelector('.confirm');

  const note = document.createElement('p');
  note.innerHTML = 'Remove <b>' + r.company + '</b> from the queue?' +
    (d ? ' Its diagnosis stays on disk.' : '') +
    ' The next eligible row takes the slot. This does not close the company.';
  confirm.appendChild(note);

  // Its own class, not "actions". Two elements sharing a class where one sits
  // inside a hidden panel is what broke this the first time.
  const confirmActs = document.createElement('div');
  confirmActs.className = 'confirm-actions';

  const del = document.createElement('button');
  del.className = 'act danger';
  del.textContent = 'Delete from queue';
  // Not the global running flag. A diagnosis reads data/queue.json for its OWN
  // company, so only that row is unsafe to remove mid-run; the rest of the
  // buffer is not its business. Disabling all ten for the twenty minutes a
  // diagnosis takes is what made this button read as broken.
  const busyOnThisRow = running && runningCompany === r.company;
  del.disabled = busyOnThisRow;
  del.title = busyOnThisRow
    ? '/' + runningAction + ' ' + runningCompany + ' is running and reads this row. Wait for it to finish.'
    : 'Removes it from the buffer and pulls up the next eligible row. Does not close the company.';
  del.onclick = () => strike(r.key, r.company);
  confirmActs.appendChild(del);

  const cancel = document.createElement('button');
  cancel.className = 'act';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => { box.checked = false; el.classList.remove('striking'); };
  confirmActs.appendChild(cancel);

  confirm.appendChild(confirmActs);
  box.onchange = () => el.classList.toggle('striking', box.checked);

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

// The rendered page owns the toggle; these buttons only deep-link into it, by
// reloading the iframe with ?view=, which the page reads on load. Kept here so
// the view can be switched without clicking inside the frame, and so the
// dashboard's own control reflects which view is showing.
let viewerRel = null;
let viewerView = 'plain';

function show(rel, company, packets) {
  viewerRel = rel;
  loadViewer();
  document.getElementById('viewerlabel').textContent = company + ' · ' + rel;
  document.getElementById('viewseg').hidden = false;
  const links = (packets || []).flatMap(p => p.files.map(f =>
    '<a href="/report?f=' + encodeURIComponent(p.dir + '/' + f) + '">' + f + '</a>'));
  document.getElementById('pktlinks').innerHTML = links.length
    ? 'Packet: ' + links.join('') : '';
}

function loadViewer() {
  if (!viewerRel) return;
  document.getElementById('viewer').src =
    '/report?f=' + encodeURIComponent(viewerRel) + '&view=' + viewerView;
  document.querySelectorAll('#viewseg button').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.view === viewerView)));
}

document.querySelectorAll('#viewseg button').forEach(b => {
  b.onclick = () => { viewerView = b.dataset.view; loadViewer(); };
});

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

async function strike(key, company) {
  const res = await fetch('/api/strike', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, confirm: true })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { alert(body.error || 'strike failed'); return; }
  await load();
  const took = body.backfilled
    ? body.backfilled.company + ' — ' + body.backfilled.title + ' took the slot.'
    : 'Nothing eligible on the bench, so the buffer is one row shorter until the next scan.';
  document.getElementById('logsum').textContent = 'Struck ' + company + '. ' + took;
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
  runningCompany = running ? s.job.company : null;
  runningAction = running ? s.job.action : null;
  const cards = document.getElementById('cards');
  cards.innerHTML = '';
  s.rows.forEach(r => cards.appendChild(card(r)));

  document.getElementById('queuecount').textContent =
    ' — ' + s.rows.length + ' of ' + s.bufferMax + ' rows in front of the drum';

  const bench = document.getElementById('bench');
  document.getElementById('benchcount').textContent =
    ' — ' + s.benchTotal + ' eligible' + (s.benchTotal > s.bench.length ? ', showing ' + s.bench.length : '');
  bench.innerHTML = s.bench.length
    ? s.bench.map((b, i) =>
        '<li><span class="n">' + (i + 1) + '</span><span class="co">' + b.company + '</span>' +
        '<span class="tt">' + b.title + '</span>' +
        '<span class="meta">' + (b.archetype || '') + (b.fit != null ? ' · fit ' + b.fit : '') + '</span></li>').join('')
    : '<li><span class="tt muted">Nothing eligible. Every Gate 0 survivor is already queued, struck, delisted, or belongs to a closed company. Run a scan.</span></li>';

  const struck = document.getElementById('struck');
  document.getElementById('struckcount').textContent = s.struckTotal ? ' — ' + s.struckTotal + ' total' : '';
  struck.innerHTML = s.struck.length
    ? s.struck.map(b =>
        '<li><span class="n">×</span><span class="co">' + b.company + '</span>' +
        '<span class="tt">' + b.title + '</span>' +
        '<span class="meta">' + b.struck_at + '</span></li>').join('')
    : '<li><span class="tt muted">Nothing struck yet.</span></li>';
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
