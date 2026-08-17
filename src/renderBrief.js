// Brief renderer.
//
// A diagnosis is a YAML file and a packet is three markdown files, which is the
// right storage format and the wrong reading format. During a five-hour weekly
// session the question is not "what does the file contain" but "does this stand
// up," and that question is answered by layout: the constraint first, the
// backstage evidence next to its verify time, the proof next to its shortfall.
// This reads one artifact and writes one self-contained HTML page beside it, no
// server, no network, no framework.
//
//   node src/renderBrief.js deepgram
//   node src/renderBrief.js packets/deepgram-2026-08-13
//   node src/renderBrief.js deepgram --pdf
//
// Two rules this file will not bend, because the page is more sendable than the
// YAML it came from and sendability is exactly the risk:
//
//   1. The draft header is rendered verbatim, on screen and on paper, at the top
//      of the page and again in the footer. It is drawn with borders rather than
//      a fill, because browsers drop background graphics when printing by
//      default and a banner that vanishes in the PDF is worse than no banner at
//      all. It does not repeat on every printed page: that needs a running
//      header, and Chrome supports neither @page margin boxes nor fixed elements
//      in the page margin. The title carries DRAFT for the same reason.
//   2. The page reports the clearance state it actually found. The accent color
//      and the PASS badge are reserved for an audit that returned PASS. An
//      unaudited diagnosis renders as unaudited. Nothing here decides whether an
//      artifact is cleared; it only refuses to imply that it is.
//
// It also checks the prose against the writing rules in
// .claude/agents/diagnostician.md and prints what it finds: banned vocabulary,
// corporate filler, and an estimated reading grade against the sixth-to-eighth
// grade target. A renderer cannot follow a writing rule, so it measures one. The
// warnings go to stdout, never onto the page, because the page goes to a stranger
// and the warning is for the person rewriting.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { deriveBluf } from './bluf.js';
import { validateArtifact } from './validateArtifact.js';

const ROOT = path.resolve(import.meta.dirname, '..');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const readYaml = (p) => {
  const full = path.isAbsolute(p) ? p : path.join(ROOT, p);
  return fs.existsSync(full) ? yaml.load(fs.readFileSync(full, 'utf8')) : null;
};

const readText = (p) => {
  const full = path.isAbsolute(p) ? p : path.join(ROOT, p);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
};

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// An unquoted YAML date is a Date, not a string, so `dated: 2026-08-13` arrives
// here as an object and renders as a timezone-shifted timestamp if printed raw.
// Also worth knowing: the same value fails validateAudit, which requires a
// string. Reported at the end of the run.
const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ''));

const DRAFT_HEADER = 'DRAFT ONLY — REQUIRES HUMAN REVIEW AND MANUAL SEND';

// CLAUDE.md bans these outright. Reported to stdout rather than printed on the
// page: the page goes to a stranger, the warning is for the person rewriting.
const BANNED = [/\bleverag(e|es|ed|ing)\b/i, /\bsynerg/i, /\boptimiz/i, /\bbest practices\b/i, /\bmove the needle\b/i];

// Corporate filler the writing rules in .claude/agents/diagnostician.md rule out.
// Not banned by CLAUDE.md, so these are warnings rather than errors.
const JARGON = [
  /\butiliz(e|es|ed|ing|ation)\b/i,
  /\brobust\b/i,
  /\bstreamlin/i,
  /\bsurface area\b/i,
  /\boperationaliz/i,
  /\bholistic/i,
  /\bseamless/i,
  /\bmission[- ]critical\b/i,
  /\bstakeholder/i,
  /\bdeep dive\b/i,
];

// Flesch-Kincaid grade, which counts syllables and knows nothing about clarity.
// It catches long sentences stacked with long words, which is the failure mode
// worth catching, and it will happily pass gibberish. A smoke alarm, not a grade.
const syllables = (w) => {
  const s = w.toLowerCase().replace(/[^a-z]/g, '');
  if (s.length <= 3) return 1;
  const groups = s
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
};

function readingGrade(text) {
  const clean = String(text)
    .replace(/https?:\/\/\S+/g, '')  // URLs are not prose and wreck the count
    .replace(/`[^`]*`/g, '')
    .replace(/[#*_>|]/g, ' ');
  const sentences = clean.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().split(/\s+/).length > 2);
  const words = clean.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (sentences.length < 3 || words.length < 40) return null;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syl / words.length) - 15.59;
  return {
    grade: Math.round(grade * 10) / 10,
    perSentence: Math.round((words.length / sentences.length) * 10) / 10,
    sentences: sentences.length,
  };
}

// The diagnostician writes strength as a word, the audit schema as an integer
// 1-5. Both appear in the same file once an audit is appended, so normalize.
const STRENGTH_WORD = { 5: 'sovereign', 4: 'strong', 3: 'circumstantial', 2: 'weak', 1: 'absent' };
const STRENGTH_NUM = { sovereign: 5, strong: 4, circumstantial: 3, weak: 2, absent: 1 };

const strengthWord = (v) =>
  typeof v === 'number' ? STRENGTH_WORD[v] || String(v) : String(v ?? '').trim().toLowerCase();
const strengthNum = (v) => (typeof v === 'number' ? v : STRENGTH_NUM[strengthWord(v)] ?? null);

// ---------------------------------------------------------------- input

// Accepts a company name, a diagnosis path, or a packet directory. A packet
// directory carries the brief; the diagnosis beside it carries the structured
// fields, and the page wants both.
function resolveInput(arg) {
  const diagDir = path.join(ROOT, 'data/diagnoses');
  const abs = path.isAbsolute(arg) ? arg : path.join(ROOT, arg);

  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const brief = readText(path.join(abs, 'brief.md'));
    if (!brief) fail(`${arg} is a directory with no brief.md in it.`);
    const company = path.basename(abs).replace(/-\d{4}-\d{2}-\d{2}$/, '');
    return { mode: 'packet', packetDir: abs, brief, diagnosisPath: findDiagnosis(diagDir, company) };
  }

  if (fs.existsSync(abs) && /\.ya?ml$/.test(abs)) return { mode: 'diagnosis', diagnosisPath: abs };

  const found = findDiagnosis(diagDir, arg);
  if (!found) {
    const have = fs.existsSync(diagDir) ? fs.readdirSync(diagDir).filter((f) => /\.ya?ml$/.test(f)) : [];
    fail(`No diagnosis found for "${arg}".` + (have.length ? ` data/diagnoses/ holds: ${have.join(', ')}` : ' data/diagnoses/ is empty.'));
  }
  return { mode: 'diagnosis', diagnosisPath: found };
}

function findDiagnosis(dir, company) {
  if (!fs.existsSync(dir)) return null;
  const want = slug(company);
  const hit = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .find((f) => slug(f.replace(/\.ya?ml$/, '')).startsWith(want));
  return hit ? path.join(dir, hit) : null;
}

function fail(msg) {
  console.error(`renderBrief: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- clearance

// The four gates .claude/agents/packet.md reads before it will draft, plus the
// named human it refuses to invent. Reported, never enforced here.
function clearance(d) {
  const auditVerdict = d.audit?.verdict ?? null;
  const dmName = String(d.decision_maker?.name ?? '');
  const dmMissing = !dmName || /INSUFFICIENT_EVIDENCE/i.test(dmName);
  const tier = d.proof_match?.tier ?? null;

  return {
    auditVerdict,
    cleared: d.verdict === 'SHIP' && auditVerdict === 'PASS',
    dmMissing,
    // `key` is a stable identifier for the gate, not a new gate and not a change
    // to an existing one. src/bluf.js reads it to name which failure decided the
    // headline, and matching on a label would break the moment one is reworded.
    gates: [
      { key: 'verdict', label: 'Diagnosis verdict', ok: d.verdict === 'SHIP', detail: d.verdict || 'absent' },
      {
        key: 'audit',
        label: 'Audit verdict',
        ok: auditVerdict === 'PASS',
        detail: auditVerdict || 'not audited',
      },
      {
        key: 'acquittal',
        label: 'Acquittal',
        ok: d.acquittal === 'EVIDENCE_SUFFICIENT',
        detail: d.acquittal || 'field absent from file',
      },
      {
        key: 'proof',
        label: 'Sovereign proof on the constraint',
        ok: tier === 'sovereign' && d.proof_match?.acts_on_constraint === true,
        detail: tier ? `${tier}${d.proof_match?.acts_on_constraint === true ? ', acts on it' : ', does not'}` : 'absent',
      },
      {
        key: 'decision_maker',
        label: 'Named decision-maker',
        ok: !dmMissing,
        detail: dmMissing ? 'no name established' : dmName.split('—')[0].trim(),
      },
    ],
  };
}

// Vendor dependency, from the ledger rather than from memory. The proof_match
// asset field is prose, so match ledger entries by id and by name against it.
function vendorDeps(d, ledger) {
  const asset = String(d.proof_match?.asset ?? '').toLowerCase();
  const rows = (ledger?.sovereign || []).filter(
    (a) => asset.includes(String(a.id).toLowerCase()) || asset.includes(String(a.name).toLowerCase())
  );
  const deps = new Map();
  for (const r of rows) for (const v of r.depends_on || []) deps.set(v, r.name);
  return { rows, deps: [...deps.entries()] };
}

// A strike has to land on the thing it struck. The auditor names the field it
// hit at the head of each claim — "binding_part:", "Evidence row 4:", "Gap 7:",
// "proof_match mechanism:" — so read that rather than comparing prose. It is a
// convention rather than a contract, so anything unparsed falls through to its
// own section instead of being dropped. A struck claim that renders as unstruck
// is the one failure this page must not have.
// The prefix table in .claude/agents/auditor.md, anchored at the start of the
// string and tested in priority order, so a strike naming its own target is read
// as naming it even when it quotes another field later on.
const PREFIXES = [
  [/^evidence rows?\s+(\d+)(?:\s*(?:and|,|&)\s*(\d+))?/i, 'evidence'],
  [/^gaps?\s+(\d+)/i, 'gap'],
  [/^(?:binding_part|output_capped|constraint_hypothesis)\b/i, 'constraint'],
  [/^proof_match\b|^proof\b/i, 'proof'],
  [/^disconfirming\b/i, 'kill'],
];

function targetOf(claim) {
  const t = String(claim ?? '').replace(/\s+/g, ' ').trim();

  for (const [re, kind] of PREFIXES) {
    const m = t.match(re);
    if (!m) continue;
    if (kind === 'evidence') {
      const idx = [m[1], m[2]].filter(Boolean).map((n) => Number(n) - 1);
      return { kind, idx };
    }
    if (kind === 'gap') return { kind, idx: [Number(m[1]) - 1] };
    return { kind, idx: [] };
  }

  // Fallback for artifacts written before the prefix was mandated: scan anywhere
  // in the string. Looser, so it runs only after the anchored pass fails.
  const rows = [...t.matchAll(/\bevidence rows?\s+(\d+)(?:\s*(?:and|,|&)\s*(\d+))?/gi)];
  if (rows.length) {
    const idx = new Set();
    for (const m of rows) for (const n of [m[1], m[2]]) if (n) idx.add(Number(n) - 1);
    return { kind: 'evidence', idx: [...idx] };
  }
  const gap = t.match(/\bgaps?\s+(\d+)/i);
  if (gap) return { kind: 'gap', idx: [Number(gap[1]) - 1] };
  if (/\bbinding_part\b|\boutput_capped\b/i.test(t)) return { kind: 'constraint', idx: [] };
  if (/\bproof_match\b/i.test(t)) return { kind: 'proof', idx: [] };
  if (/\bdisconfirming\b/i.test(t)) return { kind: 'kill', idx: [] };
  return { kind: 'unmatched', idx: [] };
}

// A row that opens by declaring it was NOT struck is not a strike, whatever array
// it was filed in. Rendering one as struck would show a claim as killed that the
// auditor explicitly recorded as surviving, which inverts the finding. Pull them
// out before anything else looks at them.
const NOT_STRUCK = /^\s*(?:not[ _-]?struck|survived|not a strike)\b/i;

function distributeStrikes(evidence, strikes) {
  const all = strikes?.struck || [];
  const survived = all.filter((s) => NOT_STRUCK.test(String(s.claim ?? '')));
  const struck = all.filter((s) => !NOT_STRUCK.test(String(s.claim ?? '')));
  const buckets = { constraint: [], proof: [], kill: [], unmatched: [], survived };
  const byRow = new Map();
  const byGap = new Map();

  for (const s of struck) {
    const { kind, idx } = targetOf(s.claim);
    if (kind === 'evidence') {
      const hits = idx.filter((i) => i >= 0 && i < evidence.length);
      for (const i of hits) byRow.set(i, [...(byRow.get(i) || []), s]);
      if (!hits.length) buckets.unmatched.push(s);
    } else if (kind === 'gap') {
      byGap.set(idx[0], [...(byGap.get(idx[0]) || []), s]);
    } else {
      buckets[kind].push(s);
    }
  }

  const rows = evidence.map((e, i) => ({ ...e, strikes: byRow.get(i) || [] }));
  return { rows, byGap, struckCount: struck.length, ...buckets };
}

// ---------------------------------------------------------------- markdown

// Enough markdown for brief.md and outreach.md, which are prose with links. Not
// a general converter, and not pretending to be one.
function md(src) {
  const lines = String(src).split('\n');
  const out = [];
  let para = [];
  let list = null;

  const inline = (t) =>
    esc(t)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, '$1<a href="$2">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<ul class="prose-list">${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === DRAFT_HEADER) continue; // rendered as the banner instead
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      out.push(`<h3 class="prose-h">${inline(h[2])}</h3>`);
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      flushPara();
      (list ||= []).push(li[1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('\n');
}

// ---------------------------------------------------------------- render

const CSS = `
:root {
  --paper:  #F9F9FB;
  --ink:    #111111;
  --rule:   #E5E5E7;
  --muted:  #6B6B70;
  --accent: #FF4500;
  --sans: Inter, -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: "SF Mono", ui-monospace, Menlo, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font-family: var(--sans); font-size: 16px; line-height: 1.55;
  -webkit-font-smoothing: antialiased; font-feature-settings: "kern" 1;
}
.wrap { max-width: 1040px; margin: 0 auto; padding: 40px 32px 88px; }
a { color: inherit; text-decoration: none; border-bottom: 1px solid var(--rule); }
a:hover { border-bottom-color: var(--ink); }

/* Draft header. Borders, not a fill: printing drops backgrounds by default and
   this line has to survive the trip into a PDF. */
.draft {
  border: 2px solid var(--ink); border-left-width: 8px;
  padding: 11px 16px; margin: 0 0 36px;
  font-family: var(--mono); font-size: 12px; font-weight: 600;
  letter-spacing: 0.09em; text-transform: uppercase;
}

header { border-bottom: 1px solid var(--ink); padding-bottom: 20px; margin-bottom: 0; }
.eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.11em;
           text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
h1 { font-size: 34px; line-height: 1.15; letter-spacing: -0.021em; font-weight: 600; margin: 0; }
.role { font-size: 19px; color: var(--muted); margin: 6px 0 0; letter-spacing: -0.01em; }
.meta { font-family: var(--mono); font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase;
        color: var(--muted); margin: 16px 0 0; display: flex; gap: 20px; flex-wrap: wrap; }

/* Asymmetrical: the sidebar is the standing, the wide column is the argument. */
.grid { display: grid; grid-template-columns: 1fr 2.05fr; gap: 0 52px; margin-top: 40px; align-items: start; }
aside { border-right: 1px solid var(--rule); padding-right: 34px; }
main { min-width: 0; }
section { margin: 0 0 40px; }
aside section { margin-bottom: 34px; }
h2 {
  font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--muted);
  margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--rule);
}
p { margin: 0 0 12px; }
p:last-child { margin-bottom: 0; }
.small { font-size: 14.5px; }
.mutedtext { color: var(--muted); }

/* The one accent. Reserved for the binding constraint and a PASS badge. */
.constraint { border-left: 4px solid var(--accent); padding: 2px 0 2px 20px; }
.constraint.struck { border-left-color: var(--muted); }
.constraint.struck .binding { color: var(--muted); text-decoration: line-through; text-decoration-thickness: 1px; }
.constraint .binding { font-size: 20px; line-height: 1.42; letter-spacing: -0.011em; margin-bottom: 14px; }
.capped { font-size: 15px; color: var(--muted); }
.capped b { color: var(--ink); font-weight: 600; }

.badge {
  display: inline-block; font-family: var(--mono); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.1em; text-transform: uppercase; padding: 4px 9px; border: 1.5px solid var(--muted);
  color: var(--muted);
}
.badge.pass { border-color: var(--accent); color: var(--accent); }
.badge.open { border-color: var(--ink); color: var(--ink); }

/* Gates */
.gates { list-style: none; margin: 0; padding: 0; }
.gates li { display: flex; gap: 10px; align-items: baseline; padding: 9px 0; border-bottom: 1px solid var(--rule); }
.gates li:last-child { border-bottom: 0; }
.mark { font-family: var(--mono); font-size: 12px; width: 16px; flex: none; }
.gate-l { flex: 1 1 auto; font-size: 14.5px; }
.gate-d { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em;
          color: var(--muted); text-align: right; max-width: 46%; }
.gates li.no .gate-l { font-weight: 600; }

/* Evidence */
table { width: 100%; border-collapse: collapse; }
th { font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: 0.1em;
     text-transform: uppercase; color: var(--muted); text-align: left;
     border-bottom: 1px solid var(--ink); padding: 0 12px 8px 0; }
td { padding: 14px 12px 14px 0; border-bottom: 1px solid var(--rule); vertical-align: top; font-size: 14.5px; }
th.n, td.n { text-align: right; white-space: nowrap; width: 62px; padding-right: 0; }
td.n { font-family: var(--mono); font-size: 12px; }
tr.ev { break-inside: avoid; }
.cls { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
       color: var(--muted); display: block; margin-bottom: 5px; }
.cls .sov { color: var(--ink); font-weight: 600; }
.leak { border: 1px solid var(--rule); padding: 1px 5px; margin-left: 6px; }
.claim { display: block; }
.src { display: block; margin-top: 7px; font-family: var(--mono); font-size: 10.5px;
       word-break: break-all; color: var(--muted); }
tr.gone td { color: var(--muted); }
tr.gone .claim, li.gone .claim { text-decoration: line-through; text-decoration-thickness: 1px; color: var(--muted); }
.rowno { display: inline-block; min-width: 15px; color: var(--ink); font-weight: 600; }
.strike-note { display: block; margin-top: 8px; padding-left: 11px; border-left: 2px solid var(--ink);
               font-size: 13px; color: var(--ink); }
.strike-note b { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }

/* Callouts for the boundaries. Honest by construction: they get the same weight
   as the claims they qualify, and they print. */
.callout { border: 1px solid var(--ink); padding: 15px 17px; margin: 0 0 14px; font-size: 14.5px; break-inside: avoid; }
.callout .cl-h { font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: 0.1em;
                 text-transform: uppercase; margin: 0 0 7px; }
.deps { list-style: none; margin: 0; padding: 0; font-family: var(--mono); font-size: 12px; }
.deps li { padding: 5px 0; border-bottom: 1px solid var(--rule); }
.deps li:last-child { border-bottom: 0; }
ol.gaps, ul.gaps { margin: 0; padding-left: 20px; font-size: 14.5px; }
ol.gaps li, ul.gaps li { margin-bottom: 11px; break-inside: avoid; }
ul.prose-list { padding-left: 20px; }
.prose-h { font-size: 16px; font-weight: 600; margin: 22px 0 8px; letter-spacing: -0.008em; }
.prose p { margin-bottom: 13px; }
code { font-family: var(--mono); font-size: 0.9em; }
.kill { font-size: 14.5px; }
.kill dt { font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: 0.1em;
           text-transform: uppercase; color: var(--muted); margin-top: 13px; }
.kill dt:first-child { margin-top: 0; }
.kill dd { margin: 5px 0 0; }
footer { margin-top: 60px; padding-top: 14px; border-top: 1px solid var(--rule);
         font-family: var(--mono); font-size: 10px; letter-spacing: 0.09em;
         text-transform: uppercase; color: var(--muted);
         display: flex; justify-content: space-between; gap: 18px; flex-wrap: wrap; }

@media (max-width: 860px) {
  .grid { grid-template-columns: 1fr; gap: 0; }
  aside { border-right: 0; padding-right: 0; border-bottom: 1px solid var(--rule); margin-bottom: 36px; }
  h1 { font-size: 28px; }
}

/* ---------------------------------------------------------------- view toggle

   Two readings of one artifact. Plain English leads with the argument; the
   Technical Audit carries the receipts.

   THIS HIDES, IT NEVER OMITS. Every section is in the DOM in both views, so
   nothing a reader might want to check is unreachable, the page stays one
   self-contained file, and Cmd-F still finds a struck claim from either view.

   THREE THINGS ARE NEVER HIDDEN, and they are the ones a reader would be hurt
   by not seeing: the draft header, the standing disclosures, and Gaps. Hiding
   Gaps behind a toggle would be smoothing over what could not be verified in
   the default view, which is the one thing CLAUDE.md's output discipline names
   outright. The plain view also states how many evidence rows and struck claims
   exist rather than leaving a reader unaware there are receipts to read. */
.viewbar { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
           margin: 26px 0 0; padding-bottom: 16px; border-bottom: 1px solid var(--rule); }
.seg { display: inline-flex; border: 1.5px solid var(--ink); flex: none; }
.seg button { font: inherit; font-family: var(--mono); font-size: 10.5px; font-weight: 600;
              letter-spacing: 0.09em; text-transform: uppercase; padding: 8px 14px;
              background: transparent; color: var(--ink); border: 0; cursor: pointer; }
.seg button + button { border-left: 1.5px solid var(--ink); }
.seg button[aria-pressed="true"] { background: var(--ink); color: #fff; }
.viewnote { font-size: 12.5px; color: var(--muted); margin: 0; }

/* ---------------------------------------------------------------- bluf

   The first thing in the Plain English view, above the clearance panel, because
   a reader who stops after one line should still leave holding the decision.
   Derived in src/bluf.js from the recorded verdict and the gate that failed. It
   reports; it never re-decides, and it carries no prose lifted from the file, so
   a struck claim cannot ride up here. Plain view only: the Technical Audit is
   unchanged, and print shows both. */
.bluf { border-left: 4px solid var(--accent); padding: 2px 0 2px 20px; margin: 26px 0 0; }
.bluf .cl-h { font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: 0.1em;
              text-transform: uppercase; color: var(--muted); margin: 0 0 7px; }
.bluf-t { font-size: 23px; line-height: 1.34; letter-spacing: -0.014em; font-weight: 600; margin: 0; }
.bluf-src { font-size: 12.5px; color: var(--muted); margin: 9px 0 0; }
/* No verdict on file. The accent is for a decision that exists. */
.bluf.bluf-fail { border-left-color: var(--ink); }

body[data-view="plain"] .audit-only { display: none; }
body[data-view="audit"] .plain-only { display: none; }

/* Plain English leads with the verdict, then the constraint. Done with flex
   order rather than by moving the markup, so the DOM order — and therefore the
   printed order and the reading order for anything that ignores CSS — stays the
   technical one. */
main { display: flex; flex-direction: column; }
body[data-view="plain"] .sec-verdict { order: -2; }
body[data-view="plain"] .sec-constraint { order: -1; }

@page { size: letter; margin: 13mm 14mm 15mm; }
@media print {
  /* Paper carries the whole record. A PDF is an artifact someone keeps, and one
     that silently dropped the evidence table because of a toggle state at print
     time would be a different document from the one on screen. */
  .audit-only, .plain-only { display: block !important; }
  .viewbar { display: none; }
  main { display: block; }
  html, body { background: #fff; }
  body { font-size: 9.6pt; line-height: 1.42; }
  .wrap { max-width: none; padding: 0; }
  a { border-bottom: 0; }
  h1 { font-size: 19pt; }
  .role { font-size: 11.5pt; }
  .grid { gap: 0 26px; grid-template-columns: 1fr 2.05fr; margin-top: 22px; }
  aside { padding-right: 20px; }
  section { margin-bottom: 22px; }
  .constraint .binding { font-size: 12.5pt; }
  td, .gate-l, .small, .callout, ol.gaps li, ul.gaps li { font-size: 9.4pt; }
  td { padding: 8px 10px 8px 0; }
  .src { font-size: 7.4pt; }
  .draft { margin-bottom: 18px; padding: 7px 11px; font-size: 8pt; }
  .bluf { margin-top: 18px; }
  .bluf-t { font-size: 13pt; }
  .bluf-src { font-size: 8pt; }
  /* One column on paper. The sidebar is a third of the screen layout and much
     shorter than the argument, so on paper the two-column grid leaves a third of
     every page after it blank and squeezes the evidence into 55% of the width.
     Stacked, the same artifact prints in roughly half the pages. */
  .grid { display: block; }
  aside { border-right: 0; padding-right: 0; padding-bottom: 14px;
          border-bottom: 1px solid var(--rule); margin-bottom: 26px; }
  aside .callout, aside section { max-width: none; }
  /* A section taller than a page must be allowed to break. Only units that fit
     on one page get break-inside: avoid, or the section drags a blank page in
     front of itself. */
  section { break-inside: auto; }
  .callout, tr.ev, ol.gaps li, ul.gaps li, .gates li, .deps li { break-inside: avoid; }
  h2 { break-after: avoid; }
  thead { display: table-header-group; }
  .deps { column-count: 3; column-gap: 22px; }
  .printonly { display: inline; }
  footer { margin-top: 26px; }
}
.printonly { display: none; }
`;

function render(ctx) {
  const { d, mode, brief, outreach, resumeDelta, today, cl, deps, ev, unmatched, strikes, audit, bluf } = ctx;

  const auditBadge = audit
    ? `<span class="badge ${audit.verdict === 'PASS' ? 'pass' : 'open'}">Audit ${esc(audit.verdict)}</span>`
    : `<span class="badge open">Not audited</span>`;

  const gates = cl.gates
    .map(
      (g) => `<li class="${g.ok ? 'yes' : 'no'}">
        <span class="mark">${g.ok ? '&#10003;' : '&#8212;'}</span>
        <span class="gate-l">${esc(g.label)}</span>
        <span class="gate-d">${esc(g.detail)}</span>
      </li>`
    )
    .join('');

  const strikeNote = (s) =>
    `<span class="strike-note"><b>Struck by audit.</b> ${esc(s.reason || '')}${
      s.rewrite ? ` <em>Defensible version:</em> ${esc(s.rewrite)}` : ' <em>No rewrite. The claim cannot be saved.</em>'
    }</span>`;

  const evidenceRows = ev
    .map((e, i) => {
      const w = strengthWord(e.strength);
      const n = strengthNum(e.strength);
      const sov = w === 'sovereign' || n === 5;
      const gone = e.strikes.length > 0;
      return `<tr class="ev${gone ? ' gone' : ''}">
        <td>
          <span class="cls"><span class="rowno">${i + 1}</span><span class="${sov && !gone ? 'sov' : ''}">${esc(
        e.source_class || '?'
      )} &middot; ${esc(w)}${n ? ` (${n}/5)` : ''}</span>${
        e.specificity_leak ? '<span class="leak">labeled leak</span>' : ''
      }${gone ? '<span class="leak">struck</span>' : ''}</span>
          <span class="claim">${esc(e.claim)}</span>
          ${e.inspectable_at ? `<span class="src">${esc(e.inspectable_at)}</span>` : ''}
          ${e.strikes.map(strikeNote).join('')}
        </td>
        <td class="n">${e.verify_seconds != null ? `${esc(e.verify_seconds)}s` : '&#8212;'}</td>
      </tr>`;
    })
    .join('');

  // The accent is the argument's confidence made visible. A struck binding part
  // does not get it.
  const constraintStruck = ctx.constraintStrikes.length > 0;

  // What the plain view says about the evidence it is not showing. A reader who
  // does not know receipts exist cannot decide to go read them, and a default
  // view that quietly implies there is nothing more to check is the failure this
  // whole repo is arranged against.
  const receiptLine = [
    `${ev.length} evidence ${ev.length === 1 ? 'row' : 'rows'}`,
    strikes?.claims_struck != null ? `${strikes.claims_struck} claims struck` : null,
    audit?.coverage_score != null ? `coverage ${audit.coverage_score}` : 'not audited',
  ]
    .filter(Boolean)
    .join(' · ')
    .concat('. Switch to Technical Audit to inspect them.');

  const briefProse = brief ? `<section><h2>The brief as drafted</h2><div class="prose">${md(brief)}</div></section>` : '';
  const outreachProse = outreach
    ? `<section><h2>Outreach as drafted</h2><div class="prose">${md(outreach)}</div></section>`
    : '';
  const deltaProse = resumeDelta
    ? `<section><h2>Resume delta</h2><div class="prose">${md(resumeDelta)}</div></section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DRAFT — ${esc(d.company)} — ${esc(today)}</title>
<style>${CSS}</style>
</head>
<body data-view="plain">
<div class="wrap">

<p class="draft">${esc(DRAFT_HEADER)}</p>

<header>
  <p class="eyebrow">${esc(mode === 'packet' ? 'Outreach packet' : 'Diagnosis')} &middot; ${esc(
    d.archetype || ''
  )} &middot; one drum slot</p>
  <h1>${esc(d.company)}</h1>
  <p class="role">${esc(d.role || '')}</p>
  <div class="meta">
    <span>Diagnosed ${esc(dateStr(d.dated))}</span>
    ${audit ? `<span>Audited ${esc(dateStr(audit.dated))}</span>` : ''}
    <span>Rendered ${esc(today)}</span>
    ${d.url ? `<span><a href="${esc(d.url)}">Posting</a><span class="printonly"> ${esc(d.url)}</span></span>` : ''}
  </div>
</header>

<div class="viewbar">
  <div class="seg" role="group" aria-label="Reading view">
    <button type="button" data-setview="plain" aria-pressed="true">Plain English</button>
    <button type="button" data-setview="audit" aria-pressed="false">Technical Audit &amp; Evidence</button>
  </div>
  <p class="viewnote plain-only">${esc(receiptLine)}</p>
  <p class="viewnote audit-only">Every claim with its source, what the auditor struck, and what is still open. Printing includes both views.</p>
</div>

<section class="bluf plain-only${bluf.missingVerdict ? ' bluf-fail' : ''}" aria-label="Bottom line up front">
  <p class="cl-h">Bottom line</p>
  <p class="bluf-t">${esc(bluf.text)}</p>
  <p class="bluf-src">${
    bluf.missingVerdict
      ? 'No verdict on file for this diagnosis. This page will not guess one.'
      : bluf.decidingGate && bluf.decidingGate !== 'verdict'
        ? `Restates the recorded verdict and ${esc(bluf.basis)}. It decides nothing.`
        : 'Restates the recorded verdict. It decides nothing.'
  }</p>
</section>

<div class="grid">
<aside>

  <section>
    <h2>Clearance</h2>
    <p style="margin-bottom:14px">${auditBadge}</p>
    <ul class="gates">${gates}</ul>
    <p class="small mutedtext" style="margin-top:14px">${
      cl.cleared
        ? 'Diagnosis SHIP and audit PASS. The remaining gates above still gate the packet.'
        : 'Not cleared for a packet. This page reports the state; it does not change it.'
    }</p>
  </section>

  <section>
    <h2>Decision-maker</h2>
    ${
      cl.dmMissing
        ? `<div class="callout">
             <p class="cl-h">Name not established</p>
             <p>${esc(String(d.decision_maker?.name ?? '').replace(/^INSUFFICIENT_EVIDENCE\s*[—-]\s*/, ''))}</p>
           </div>`
        : `<p><strong>${esc(d.decision_maker?.name)}</strong></p>`
    }
    ${d.decision_maker?.title ? `<p class="small"><span class="cls">Title</span>${esc(d.decision_maker.title)}</p>` : ''}
    ${
      d.decision_maker?.reachable_via
        ? `<p class="small"><span class="cls">Reachable via</span>${esc(d.decision_maker.reachable_via)}</p>`
        : ''
    }
    ${d.decision_maker?.source ? `<p class="small mutedtext"><span class="cls">Source</span>${esc(d.decision_maker.source)}</p>` : ''}
  </section>

  ${
    deps.deps.length
      ? `<section class="audit-only">
           <h2>Not ours to control</h2>
           <p class="small mutedtext">The lead proof runs on vendors. A claim about the pipeline that ignores this is a claim about someone else's product.</p>
           <ul class="deps">${deps.deps.map(([v, owner]) => `<li>${esc(v)} <span class="mutedtext">&middot; ${esc(owner)}</span></li>`).join('')}</ul>
         </section>`
      : ''
  }

  <section>
    <h2>Standing disclosures</h2>
    <div class="callout">
      <p class="cl-h">Calibration Layer</p>
      <p>Written and test-exercised. Not wired into the deployed path. Staged, never shipped.</p>
    </div>
    <div class="callout">
      <p class="cl-h">Agent-assisted engineering</p>
      <p>Michael directs Claude Code and owns requirements, vendor selection, test design, and acceptance. Not unassisted systems programming.</p>
    </div>
    <div class="callout">
      <p class="cl-h">No fine-tuning claim</p>
      <p>Experience is black-box evaluation and commercial API orchestration. No public evidence of training loops or loss design.</p>
    </div>
  </section>

</aside>
<main>

  <section class="sec-constraint">
    <h2>The binding constraint${constraintStruck ? ' &middot; struck' : ''}</h2>
    <div class="constraint${constraintStruck ? ' struck' : ''}">
      <p class="binding">${esc(d.constraint_hypothesis?.binding_part || 'No binding part named.')}</p>
      <p class="capped"><b>Output capped.</b> ${esc(d.constraint_hypothesis?.output_capped || '')}</p>
      <p class="capped" style="margin-top:8px"><b>Confidence.</b> ${esc(
        d.constraint_hypothesis?.confidence || 'unstated'
      )}</p>
      ${ctx.constraintStrikes.map(strikeNote).join('')}
    </div>
  </section>

  <section class="audit-only">
    <h2>Evidence a stranger can inspect</h2>
    <table>
      <thead><tr><th>Claim and source</th><th class="n">Verify</th></tr></thead>
      <tbody>${evidenceRows || '<tr><td colspan="2" class="mutedtext">No evidence rows.</td></tr>'}</tbody>
    </table>
  </section>

  ${
    audit
      ? `<section class="audit-only">
           <h2>What the audit did</h2>
           <p class="small">Coverage <strong>${esc(audit.coverage_score)}</strong> against the twenty-eight filing-standard questions, threshold 0.50.${
             audit.unanswered_question_numbers?.length
               ? ` Unanswered: ${audit.unanswered_question_numbers.map((n) => esc(n)).join(', ')}.`
               : ' Every question answered.'
           }</p>
           <ul class="gates">${Object.entries(audit.veto_results || {})
             .map(
               ([k, v]) => `<li class="${v ? 'yes' : 'no'}">
                  <span class="mark">${v ? '&#10003;' : '&#8212;'}</span>
                  <span class="gate-l">${esc(k.replace(/^q(\d+)_/, 'Q$1 ').replace(/_/g, ' '))}</span>
                  <span class="gate-d">${v ? 'pass' : 'veto'}</span>
                </li>`
             )
             .join('')}</ul>
           ${
             strikes
               ? `<p class="small" style="margin-top:14px">${esc(strikes.claims_tested ?? '?')} claims tested, <strong>${esc(
                   strikes.claims_struck ?? '?'
                 )} struck.</strong></p>`
               : ''
           }
           ${
             ctx.survived.length
               ? `<p class="small" style="margin-top:14px"><span class="cls">Attacked and survived</span></p>
                  <ul class="gaps">${ctx.survived
                    .map(
                      (s) =>
                        `<li>${esc(String(s.claim).replace(NOT_STRUCK, '').replace(/^[,:\s]+/, ''))}<br><span class="mutedtext">${esc(
                          s.reason || ''
                        )}</span></li>`
                    )
                    .join('')}</ul>`
               : ''
           }
           ${
             unmatched.length
               ? `<p class="small" style="margin-top:10px">Struck claims not matched to an evidence row above:</p>
                  <ul class="gaps">${unmatched
                    .map(
                      (s) =>
                        `<li>${esc(s.claim)}<br><span class="mutedtext">${esc(s.reason || '')}${
                          s.rewrite ? ` Rewrite: ${esc(s.rewrite)}` : ' No rewrite offered.'
                        }</span></li>`
                    )
                    .join('')}</ul>`
               : ''
           }
           ${
             audit.auditor_evidence?.length
               ? `<p class="small" style="margin-top:14px"><span class="cls">Independent evidence the auditor found</span></p>
                  <table><tbody>${audit.auditor_evidence
                    .map(
                      (e) => `<tr class="ev"><td>
                        <span class="cls">${esc(e.source_class || '?')} &middot; ${esc(strengthWord(e.strength))}</span>
                        <span class="claim">${esc(e.claim)}</span>
                        ${e.inspectable_at ? `<span class="src">${esc(e.inspectable_at)}</span>` : ''}
                      </td><td class="n">${e.verify_seconds != null ? `${esc(e.verify_seconds)}s` : '&#8212;'}</td></tr>`
                    )
                    .join('')}</tbody></table>`
               : ''
           }
         </section>`
      : `<section class="audit-only">
           <h2>What the audit did</h2>
           <div class="callout"><p class="cl-h">No audit block in this file</p><p>Nothing here has been attacked yet. Claims below the constraint are the diagnostician's own, unreviewed. Run the auditor before anything is drafted from this page.</p></div>
         </section>`
  }

  ${
    d.disconfirming
      ? `<section class="audit-only">
           <h2>The attempt to kill it</h2>
           <dl class="kill">
             <dt>Query issued</dt><dd>${esc(d.disconfirming.query_issued)}</dd>
             <dt>Result</dt><dd>${esc(d.disconfirming.result)}${ctx.killStrikes.map(strikeNote).join('')}</dd>
             <dt>Survived</dt><dd>${d.disconfirming.survived ? 'Yes, as filed.' : 'No.'}</dd>
           </dl>
         </section>`
      : ''
  }

  <section>
    <h2>The proof, and what it does not reach</h2>
    <p class="small"><span class="cls">Asset &middot; ${esc(d.proof_match?.tier || '?')} tier</span>${esc(
      d.proof_match?.asset || 'none named'
    )}</p>
    ${d.proof_match?.mechanism ? `<p>${esc(d.proof_match.mechanism)}</p>` : ''}
    ${
      d.proof_match?.honest_shortfall
        ? `<div class="callout"><p class="cl-h">Honest shortfall</p><p>${esc(d.proof_match.honest_shortfall)}</p></div>`
        : ''
    }
    ${ctx.proofStrikes.map(strikeNote).join('')}
    ${
      d.proof_match?.known_gaps_respected
        ? `<p class="small mutedtext">${esc(d.proof_match.known_gaps_respected)}</p>`
        : ''
    }
  </section>

  ${briefProse}
  ${outreachProse}
  ${deltaProse}

  ${
    d.reason
      ? `<section class="sec-verdict"><h2>Verdict ${esc(d.verdict || '')}</h2><p>${esc(d.reason)}</p></section>`
      : ''
  }

  <section>
    <h2>Gaps &middot; ${(d.gaps || []).length + (audit?.gaps?.length || 0)} open</h2>
    <p class="small mutedtext">Named rather than smoothed over. A missing record is a finding.</p>
    <ol class="gaps">${
      (d.gaps || [])
        .map((g, i) => {
          const s = ctx.gapStrikes.get(i) || [];
          return `<li${s.length ? ' class="gone"' : ''}><span class="claim">${esc(g)}</span>${s
            .map(strikeNote)
            .join('')}</li>`;
        })
        .join('') || '<li>None recorded.</li>'
    }</ol>
    ${
      audit?.gaps?.length
        ? `<p class="small" style="margin-top:14px"><span class="cls">Raised by the auditor</span></p>
           <ul class="gaps">${audit.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`
        : ''
    }
  </section>

</main>
</div>

<footer>
  <span>${esc(DRAFT_HEADER)}</span>
  <span>Bottleneck &middot; rendered ${esc(today)}</span>
</footer>
</div>
<script>
// Vanilla, inline, no dependency, and it degrades to the plain view with the
// full audit still reachable by scrolling if it never runs: the sections are
// only hidden by CSS that keys off body[data-view], and the default attribute
// is written into the markup rather than set here.
(function () {
  var body = document.body;
  var buttons = [].slice.call(document.querySelectorAll('[data-setview]'));

  function apply(view, remember) {
    if (view !== 'plain' && view !== 'audit') return;
    body.setAttribute('data-view', view);
    buttons.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.setview === view));
    });
    if (remember) {
      // Per artifact, not global. Two diagnoses open in two tabs should not
      // fight over one setting.
      try { localStorage.setItem('bottleneck:view:' + location.pathname + location.search, view); } catch (e) {}
    }
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () { apply(b.dataset.setview, true); });
  });

  // A ?view= in the URL wins, so the dashboard can deep-link straight into the
  // audit. Otherwise the last choice for this artifact, otherwise plain.
  var wanted = new URLSearchParams(location.search).get('view');
  if (!wanted) {
    try { wanted = localStorage.getItem('bottleneck:view:' + location.pathname + location.search); } catch (e) {}
  }
  if (wanted) apply(wanted, false);

  // Printing takes the whole record regardless of the toggle, which the print
  // stylesheet already forces. Nothing to do here; noted so nobody adds a
  // beforeprint handler that "helpfully" narrows it back down.
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------- pdf

// No new dependency. Chrome is already on this machine, and headless Chrome
// prints the same CSS the browser does.
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function toPdf(htmlPath) {
  const bin = CHROME_PATHS.find((p) => fs.existsSync(p));
  const out = htmlPath.replace(/\.html$/, '.pdf');
  if (!bin) {
    console.log('No Chrome found for --pdf. Open the HTML and print to PDF; the print CSS is built for it.');
    return null;
  }
  execFileSync(bin, [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${out}`,
    `file://${htmlPath}`,
  ], { stdio: 'ignore' });
  return out;
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
const wantPdf = args.includes('--pdf');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('usage: node src/renderBrief.js <company | data/diagnoses/x.yaml | packets/co-DATE> [--pdf]');
  process.exit(1);
}

const input = resolveInput(target);
if (!input.diagnosisPath) fail(`No diagnosis in data/diagnoses/ for this packet. The page needs it for the constraint and the gates.`);

const d = readYaml(input.diagnosisPath);
if (!d) fail(`Could not read ${input.diagnosisPath}.`);

// The schema gate and the pre-audit seal, before a single tag is written.
//
// This page is the most sendable artifact the repository produces, which makes
// it the last place an unvalidated claim should reach. An unaudited diagnosis
// still renders — the page is built to report that state and says so on its face
// — but an artifact that violates its own schema, or whose diagnostician half
// was altered after the seal was taken, does not become a page.
const artifactRel = path.relative(ROOT, input.diagnosisPath);
try {
  const check = validateArtifact(d, { artifact: artifactRel });
  for (const w of check.findings.filter((f) => f.severity === 'warning')) {
    console.log(`  warn [${w.rule}] ${w.message}`);
  }
} catch (e) {
  console.error(e.message);
  fail('the artifact did not pass the schema gate, so nothing was rendered.');
}

const ledger = readYaml('profile/proof-ledger.yaml');
const cl = clearance(d);
const st = distributeStrikes(d.evidence || [], d.strikes);
const today = new Date().toISOString().slice(0, 10);

// Downstream of the audit, and structurally so rather than by ordering luck: the
// gate list handed in already carries the audit verdict, and the strike list goes
// with it, so the headline is checked against every claim the auditor killed
// before it can reach the top of the page. A violation stops the render. A page
// that leads with a struck claim is worse than no page, because the first line is
// the one a reader takes on trust.
const bluf = deriveBluf({ verdict: d.verdict, gates: cl.gates, struck: d.strikes?.struck });
if (!bluf.ok && !bluf.missingVerdict) {
  for (const e of bluf.errors) console.error(`renderBrief: ${e}`);
  fail('the BLUF failed its own limits, so nothing was written. Fix src/bluf.js before rendering.');
}

const outPath =
  input.mode === 'packet'
    ? path.join(input.packetDir, 'brief.html')
    : input.diagnosisPath.replace(/\.ya?ml$/, '.html');

const html = render({
  d,
  mode: input.mode,
  brief: input.brief || null,
  outreach: input.mode === 'packet' ? readText(path.join(input.packetDir, 'outreach.md')) : null,
  resumeDelta: input.mode === 'packet' ? readText(path.join(input.packetDir, 'resume-delta.md')) : null,
  today,
  cl,
  deps: vendorDeps(d, ledger),
  ev: st.rows,
  unmatched: st.unmatched,
  constraintStrikes: st.constraint,
  proofStrikes: st.proof,
  killStrikes: st.kill,
  gapStrikes: st.byGap,
  survived: st.survived,
  strikes: d.strikes || null,
  audit: d.audit || null,
  bluf,
});

fs.writeFileSync(outPath, html);
const relOf = (p) => {
  const r = path.relative(ROOT, p);
  return r.startsWith('..') ? p : r;
};
const rel = relOf(outPath);
console.log(`Wrote ${rel}`);

// Report the state rather than burying it. The page is honest about clearance;
// so is the run that produced it.
console.log(
  `  diagnosis ${d.verdict || 'none'} · audit ${cl.auditVerdict || 'NOT RUN'} · ${
    cl.gates.filter((g) => !g.ok).length
  } of ${cl.gates.length} gates open`
);
if (!cl.cleared) console.log('  NOT CLEARED for a packet. Rendered with the draft header and the open gates shown.');
if (cl.dmMissing) console.log('  Decision-maker name is unresolved, which blocks a packet on one lookup.');

// The headline, and what produced it. Printed every run so the line at the top
// of the page is never something only the reader has seen.
console.log(`  BLUF: ${bluf.text}`);
console.log(`  ${bluf.wordCount} words, grade ${bluf.grade ?? 'n/a'}, from ${bluf.basis}`);
for (const w of bluf.warnings) console.log(`  ${w}`);
if (bluf.missingVerdict) {
  // Loudly, and with a non-zero exit, but the page is still written: it says
  // 'Verdict not recorded.' at the top, which is the honest thing for it to say.
  for (const e of bluf.errors) console.error(`renderBrief: ${e}`);
  console.error(`renderBrief: the page reads "${bluf.text}" at the top. Record a verdict and render again.`);
  process.exitCode = 1;
}

if (d.strikes?.struck?.length) {
  const rows = st.struckCount;
  const landed = rows - st.unmatched.length;
  console.log(`  ${rows} strikes: ${landed} placed on the claim they hit, ${st.unmatched.length} listed separately`);
  if (st.survived.length) {
    console.log(
      `  ${st.survived.length} row${st.survived.length === 1 ? '' : 's'} in \`struck\` declare NOT STRUCK. Shown as attacked and survived, not as strikes.`
    );
  }
  // claims_struck is the auditor's own count. If it disagrees with the rows that
  // are actually strikes, one of the two is wrong and the page shows the rows.
  if (d.strikes.claims_struck != null && Number(d.strikes.claims_struck) !== rows) {
    console.log(`  claims_struck says ${d.strikes.claims_struck} but ${rows} strikes are listed. The rows are shown.`);
  }
}

// The validators only ever see JS objects in the test suite, so nothing catches
// this on the artifacts themselves: an unquoted YAML date is a Date, and
// validateAudit requires a string matching the date pattern.
for (const [where, v] of [
  ['diagnosis', d.dated],
  ['audit', d.audit?.dated],
]) {
  if (v instanceof Date) console.log(`  ${where} 'dated' is an unquoted YAML date, so it fails the schema. Quote it.`);
}

// Read every prose field the writing rules govern, not just the headline ones, so
// the warning covers what the page actually shows a reader.
const prose = [
  d.constraint_hypothesis?.binding_part,
  d.constraint_hypothesis?.output_capped,
  d.proof_match?.mechanism,
  d.proof_match?.honest_shortfall,
  d.reason,
  ...(d.evidence || []).map((e) => e.claim),
  ...(d.gaps || []),
  ...(d.strikes?.struck || []).flatMap((s) => [s.reason, s.rewrite]),
  input.brief,
]
  .filter(Boolean)
  .join('\n\n');

const hits = BANNED.filter((r) => r.test(prose));
if (hits.length) console.log(`  Banned vocabulary present: ${hits.map((r) => r.source).join(', ')}`);

const filler = JARGON.filter((r) => r.test(prose));
if (filler.length) console.log(`  Corporate filler present: ${filler.map((r) => r.source).join(', ')}`);

// Sixth to eighth grade is the target. Above nine, say so and say what drove it,
// because a long-sentence problem and a long-word problem need different edits.
const read = readingGrade(prose);
if (read) {
  const verdict = read.grade > 9 ? 'ABOVE the 6-8 target' : 'within the 6-8 target';
  console.log(
    `  Reading grade about ${read.grade}, ${verdict} · ${read.perSentence} words per sentence across ${read.sentences} sentences`
  );
  if (read.grade > 9) console.log('  Estimated by syllable count, so it cannot judge clarity. Shorten sentences first.');
}

if (wantPdf) {
  const pdf = toPdf(outPath);
  if (pdf) console.log(`Wrote ${relOf(pdf)}`);
}
console.log(`Open it: open ${rel}`);
