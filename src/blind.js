// Countercurrent audit. The auditor reads the record before it reads the claim.
//
// The auditor and the diagnostician are the same model family reading the same
// artifact in the same direction: posting → constraint → attack the constraint.
// Adversarial ROLE does not produce adversarial PRIORS. Two instances of
// correlated judgment agreeing is not corroboration, it is the same measurement
// taken twice, and the Citation Isolation Rule is a field correction to a
// problem that starts earlier than the citations.
//
// Countercurrent exchange is the fix, and it comes from gills. Blood moving one
// way past water moving the other extracts far more oxygen than co-current flow,
// which equilibrates halfway and stops. So the auditor runs BACKWARD: from the
// raw observables to a constraint of its own, with the diagnosis unread. Only
// then does it open the artifact.
//
//   PHASE 1  blind. observables and the posting. no hypothesis, no evidence
//            block, no verdict. Produce one sentence of your own.
//   PHASE 2  collision. Open the artifact. Compare the two sentences.
//
// Agreement reached from opposite directions is evidence. Agreement reached by
// reviewing someone's homework is not.
//
// HOW BLIND IS BLIND. The packet this module builds carries raw observables and
// nothing else, and assertBlind refuses to hand over a packet with any
// conclusion field in it. The server runs phase 1 with its working directory set
// to a scratch folder holding only that packet, so data/diagnoses/ is not on the
// path at all. A model with Read and an absolute path could still reach the real
// repository, which is why this is tamper-EVIDENT rather than tamper-proof: the
// blind hypothesis is written and hashed before the artifact is legible, so a
// phase-1 sentence that happens to quote the diagnosis is visible afterward.
// Claiming more than that would be the kind of overstatement the auditor exists
// to strike.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

// Everything that is the diagnostician's conclusion rather than the record. If
// any of these reaches phase 1, the audit is co-current and its agreement means
// nothing.
export const CONCLUSION_KEYS = [
  'constraint_hypothesis',
  'evidence',
  'proof_match',
  'proof_match_secondary',
  'acquittal',
  'missing_record',
  'disconfirming',
  'verdict',
  'reason',
  'strikes',
  'audit',
  'revisit_trigger',
  'relocation_pricing',
  'comp_price',
  'sydney_price',
];

// The formula the diagnostician writes. Its presence in a blind packet means a
// hypothesis leaked in as prose even if no forbidden key did.
const WEAKEST_LINK = /produces no more .{2,80} than its slowest .{2,80} allows/i;

// ---------------------------------------------------------------- observables

// One line of a brief's Observables list:
//   - claim text — https://url — 15s — backstage
// The gatherer writes em-dash separated fields. Anything that does not parse is
// returned with what could be read rather than dropped, because a dropped
// observable is a silently narrowed record.
export function parseObservableLine(line) {
  const t = String(line).replace(/^\s*[-*]\s+/, '').trim();
  if (!t) return null;
  const parts = t.split(/\s+—\s+|\s+--\s+/).map((s) => s.trim());
  const url = parts.find((p) => /^https?:\/\//.test(p)) || null;
  const secs = parts.find((p) => /^\d+\s*s$/i.test(p));
  const cls = parts.find((p) => /^(backstage|frontstage|posting)$/i.test(p));
  return {
    claim: parts[0] || t,
    inspectable_at: url,
    verify_seconds: secs ? Number(secs.replace(/\s*s$/i, '')) : null,
    // The gatherer writes "posting" for a frontstage row read off the ad. The
    // evidence schema knows two classes, so posting maps to frontstage.
    source_class: cls ? (/posting/i.test(cls) ? 'frontstage' : cls.toLowerCase()) : null,
  };
}

// Pulls the Observables list for one company out of a brief. The gatherer writes
// "## Company — title" sections with "### Observables" inside them, which is the
// same structure server.js counts.
export function parseBriefObservables(markdown, company) {
  const sections = String(markdown ?? '').split(/^## /m).slice(1);
  const want = String(company ?? '').toLowerCase();
  const section = sections.find((s) => s.toLowerCase().startsWith(want));
  if (!section) return [];
  const block = section.split(/^### /m).find((s) => /^observables/i.test(s));
  if (!block) return [];
  return block
    .split('\n')
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map(parseObservableLine)
    .filter(Boolean);
}

// ---------------------------------------------------------------- the packet

// The whole of what phase 1 may see. Raw record, no conclusions.
export function buildBlindPacket({ company, role = null, posting = null, observables = [], dated = null, brief = null }) {
  return {
    _phase: 'blind',
    _rule:
      'This is the complete material for the blind pass. Form one constraint hypothesis from it alone. ' +
      'The diagnosis for this company exists and you may not read it yet.',
    company,
    role,
    dated,
    brief_source: brief,
    posting: posting
      ? {
          title: posting.title ?? null,
          location: posting.location ?? null,
          url: posting.url ?? null,
          posted: posting.posted ?? null,
          description: posting.description ?? null,
        }
      : null,
    observables,
  };
}

// Refuses a packet carrying anything the diagnostician concluded. Deep, because
// a conclusion nested one level down is still a conclusion.
export function assertBlind(packet) {
  const found = [];

  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (WEAKEST_LINK.test(node)) found.push(`${path}: carries the Weakest Link formula as prose`);
      return;
    }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (CONCLUSION_KEYS.includes(k)) found.push(`${path ? `${path}.` : ''}${k}: the diagnostician's conclusion`);
      walk(v, path ? `${path}.${k}` : k);
    }
  };

  walk(packet, '');

  if (found.length) {
    const e = new Error(
      `the blind packet is tainted and phase 1 must not run on it:\n  ${found.join('\n  ')}\n` +
        '  An audit that has already seen the conclusion cannot corroborate it. Agreement would only record that ' +
        'the same model read the same sentence twice.'
    );
    e.tainted = found;
    throw e;
  }
  return packet;
}

// Redacts a full diagnosis down to what phase 1 may see. Used when the brief is
// missing and the posting has to come from the artifact itself.
export function redact(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc || {})) {
    if (!CONCLUSION_KEYS.includes(k)) out[k] = v;
  }
  return out;
}

export const packetDigest = (packet) =>
  crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex');

// ---------------------------------------------------------------- collision

const normalizeUrl = (u) =>
  String(u ?? '')
    .trim()
    .replace(/[#?].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

// The Citation Isolation Rule, in code rather than in a paragraph.
//
// auditor.md has always required at least one backstage trace the diagnostician
// did not cite, and has always said outright that "nothing in code checks that
// the row is new." This checks it.
//
// A row cited by both is not automatically struck — the auditor may have reached
// it independently and said so with `independent_source`. Without that, a shared
// citation is a re-read, and a re-read confirms the link resolves. It cannot
// detect a hypothesis built by looking only where it was already going to be
// confirmed, which is the thing the auditor exists to detect.
export function citationIsolation(diagnosticianRows = [], auditorRows = []) {
  const cited = new Set(diagnosticianRows.map((r) => normalizeUrl(r?.inspectable_at)).filter(Boolean));

  const rows = (auditorRows || []).map((r) => {
    const url = normalizeUrl(r?.inspectable_at);
    const shared = Boolean(url) && cited.has(url);
    const independent = Boolean(r?.independent_source);
    return {
      claim: String(r?.claim ?? '').slice(0, 120),
      url: r?.inspectable_at ?? null,
      source_class: r?.source_class ?? null,
      shared,
      independent,
      // Struck: cited by the diagnostician, and the auditor named no separate
      // route to it.
      struck: shared && !independent,
    };
  });

  const isolated = rows.filter((r) => !r.shared && r.source_class === 'backstage');
  const struck = rows.filter((r) => r.struck);

  return {
    rows,
    isolated,
    struck,
    ok: isolated.length > 0,
    reason: isolated.length
      ? null
      : 'no backstage row in auditor_evidence that the diagnostician did not already cite. An audit assembled ' +
        'from the diagnostician\'s own citations is a proofread, not a second look, and its agreement carries no information.',
  };
}

// Aristotelian form, checked as form.
//
// A syllogism has three terms across two premises. The MIDDLE term is the one
// appearing in both premises and absent from the conclusion — that is what makes
// it the middle, and its elimination is what the inference does. A conclusion
// whose middle term never appears in a premise has no causal chain behind it;
// one whose middle term survives into the conclusion has not inferred anything.
//
// This does not check that the argument is TRUE. It checks that it is an
// argument. Causa essendi — the middle term has to name the reason the thing is
// so, not merely a sign that it is so, and no code can settle that. What code
// can settle is whether the chain is unbroken, and a broken chain is the common
// case: an observable and a bottleneck asserted side by side with nothing
// connecting them.
const words = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const containsPhrase = (haystack, needle) => {
  const h = words(haystack).join(' ');
  const n = words(needle).join(' ');
  return Boolean(n) && h.includes(n);
};

export function checkSyllogism(s) {
  const problems = [];
  if (!s || typeof s !== 'object') {
    return { ok: false, problems: ['no syllogism block. A divergence has to be argued, not noted.'] };
  }
  for (const k of ['major', 'minor', 'middle_term', 'conclusion']) {
    if (!String(s[k] ?? '').trim()) problems.push(`${k} is empty`);
  }
  if (problems.length) return { ok: false, problems };

  const inMajor = containsPhrase(s.major, s.middle_term);
  const inMinor = containsPhrase(s.minor, s.middle_term);
  const inConclusion = containsPhrase(s.conclusion, s.middle_term);

  if (!inMajor) problems.push(`the middle term "${s.middle_term}" does not appear in the major premise, so the chain has no first link`);
  if (!inMinor) problems.push(`the middle term "${s.middle_term}" does not appear in the minor premise, so the chain has no second link`);
  if (inConclusion) {
    problems.push(
      `the middle term "${s.middle_term}" survives into the conclusion. A middle term is eliminated by the inference; ` +
        'one that reappears means the conclusion restates a premise rather than following from two.'
    );
  }

  return { ok: problems.length === 0, problems, unbroken: inMajor && inMinor && !inConclusion };
}

// The phase-2 block as a whole.
export function checkCollision(audit) {
  const problems = [];
  const blind = audit?.blind_phase;
  const collision = audit?.collision;

  if (!blind) return { ok: true, skipped: true, problems: [], note: 'no blind_phase on this audit; it ran co-current.' };

  if (!String(blind.hypothesis ?? '').trim()) {
    problems.push('blind_phase.hypothesis is empty. Phase 1 exists to produce one sentence, formed before the artifact was read.');
  }
  if (!Array.isArray(blind.sources) || !blind.sources.length) {
    problems.push('blind_phase.sources is empty. The blind hypothesis has to name what it was formed from.');
  }
  if (!collision) {
    problems.push('no collision block. Phase 1 without phase 2 is an unread second opinion.');
    return { ok: false, problems };
  }
  if (!['corroborated', 'diverged'].includes(collision.agreement)) {
    problems.push(`collision.agreement is ${JSON.stringify(collision.agreement ?? null)}; expected corroborated or diverged.`);
  }
  if (collision.agreement === 'diverged') {
    const syl = checkSyllogism(collision.syllogism);
    if (!syl.ok) problems.push(...syl.problems.map((p) => `syllogism: ${p}`));
  }

  return { ok: problems.length === 0, problems, agreement: collision.agreement ?? null };
}

// ---------------------------------------------------------------- cli

// Builds the scratch directory phase 1 runs inside: the packet, a symlink to
// .claude so `--agent auditor` resolves, and nothing else. data/diagnoses/ is
// not on the path, so the diagnosis is not reachable by a relative read.
export function writeBlindDir({ company, root = ROOT } = {}) {
  const queue = JSON.parse(fs.readFileSync(path.join(root, 'data/queue.json'), 'utf8'));
  const row = queue.find((r) => String(r.company).toLowerCase() === String(company).toLowerCase());
  if (!row) throw new Error(`"${company}" is not a row in data/queue.json. The blind packet is built from the posting.`);

  let observables = [];
  let briefFile = null;
  const briefDir = path.join(root, 'data/briefs');
  if (fs.existsSync(briefDir)) {
    for (const f of fs.readdirSync(briefDir).filter((x) => x.endsWith('.md')).sort().reverse()) {
      const rows = parseBriefObservables(fs.readFileSync(path.join(briefDir, f), 'utf8'), row.company);
      if (rows.length) {
        observables = rows;
        briefFile = `data/briefs/${f}`;
        break;
      }
    }
  }

  const d = new Date();
  const packet = buildBlindPacket({
    company: row.company,
    role: row.title ?? null,
    dated: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    posting: row,
    observables,
    brief: briefFile,
  });

  assertBlind(packet);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottleneck-blind-'));
  fs.writeFileSync(path.join(dir, 'observables.json'), JSON.stringify(packet, null, 2) + '\n');
  fs.symlinkSync(path.join(root, '.claude'), path.join(dir, '.claude'));
  return { dir, packet, digest: packetDigest(packet), observables: observables.length, brief: briefFile };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--packet');
  const company = i >= 0 ? argv[i + 1] : null;
  if (!company) {
    console.error('usage: node src/blind.js --packet <company>');
    process.exit(2);
  }
  try {
    const r = writeBlindDir({ company });
    console.log(`Blind packet for ${company}`);
    console.log(`  ${r.observables} observable${r.observables === 1 ? '' : 's'}${r.brief ? ` from ${r.brief}` : ', posting only'}`);
    console.log(`  digest ${r.digest}`);
    console.log('');
    console.log('Run phase 1 with this as the working directory. It holds the packet and .claude, and no diagnosis:');
    console.log(`  ${r.dir}`);
    console.log('');
    console.log('The auditor writes blind.json there: hypothesis, sources, reasoning. It may not read the diagnosis.');
  } catch (e) {
    console.error(`blind: ${e.message}`);
    process.exit(1);
  }
}
