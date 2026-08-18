// Structural operators for drafted prose.
//
// PROVENANCE, STATED FIRST. The brief that specified this module named a
// "Metre-Mechanism Guide" as the source of nine primitives. No such document is
// in this repository — I searched for the title and for every term in it and
// found nothing. So the nine names below are the ones I was given, and the
// definitions and detectors are MINE, written here from first principles. They
// are not a citation and must not be read as one. If the guide exists, reconcile
// these against it; where they disagree, the guide wins and this file is wrong.
//
//   MISSING RECORD (P5): .claude/references/metre-mechanism.md, or whatever the
//   guide is actually called. Until it is in the repository, the operator
//   semantics here are asserted by me and inspectable only as code.
//
// WHAT THIS DOES AND DOES NOT CLAIM. These detectors read surface structure —
// repetition, sentence lengths, connectives, position. Structure is not quality.
// A paragraph can satisfy every operator and say nothing, and the repository's
// own writing rule ("if it sounds like writing, rewrite it") is a judgment no
// regex makes. What these catch is the failure mode a checklist can catch: a
// closing that never closes, a comparison with only one side, a chain with a
// missing link.

import { fkGrade, words } from '../bluf.js';

const sentences = (text) =>
  String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

const paragraphs = (text) =>
  String(text ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

const stem = (w) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '');

// ---------------------------------------------------------------- the nine

// Each operator answers one question about a passage and returns what it found,
// never a score. A caller decides whether the absence matters; several of these
// are wrong to require everywhere.
export const OPERATORS = {
  // A term or figure returning across the passage, binding it into one thing.
  // Absence reads as a list of observations that happen to share a page.
  RECURRENCE: {
    describe: 'a term returns across the passage and binds it',
    detect(text) {
      const w = words(text).map(stem).filter((x) => x.length > 4);
      const counts = new Map();
      for (const x of w) counts.set(x, (counts.get(x) || 0) + 1);
      const recurring = [...counts.entries()].filter(([, n]) => n >= 3).map(([x]) => x);
      return { present: recurring.length > 0, evidence: recurring.slice(0, 5) };
    },
  },

  // Division into parts a reader can hold separately.
  SEGMENTATION: {
    describe: 'the passage divides into parts a reader can hold separately',
    detect(text) {
      const paras = paragraphs(text);
      const bullets = (String(text).match(/^\s*[-*]\s+/gm) || []).length;
      const headings = (String(text).match(/^#{1,6}\s+/gm) || []).length;
      return { present: paras.length >= 2 || bullets >= 2 || headings >= 1, evidence: { paras: paras.length, bullets, headings } };
    },
  },

  // Two things put in the same grammatical shape so the difference between them
  // is the only thing left to notice.
  PARALLELISM: {
    describe: 'two clauses share a shape so their difference is what shows',
    detect(text) {
      const ss = sentences(text);
      const openers = ss.map((s) => words(s).slice(0, 2).map((x) => x.toLowerCase()).join(' '));
      const repeated = openers.filter((o, i) => o && openers.indexOf(o) !== i);
      const correlatives = /\b(not only .{2,60} but also|either .{2,40} or|both .{2,40} and)\b/i.test(text);
      return { present: repeated.length > 0 || correlatives, evidence: [...new Set(repeated)].slice(0, 3) };
    },
  },

  // Deliberate imbalance: the parts are not the same size, and the short one
  // lands. Symmetry reads as a template; asymmetry reads as someone choosing.
  ASYMMETRY: {
    describe: 'the parts are deliberately unequal, and the short one lands',
    detect(text) {
      const ss = sentences(text);
      if (ss.length < 2) return { present: false, evidence: 'fewer than two sentences' };
      const lens = ss.map((s) => words(s).length);
      const longest = Math.max(...lens);
      const shortest = Math.min(...lens);
      return { present: longest >= shortest * 2, evidence: { longest, shortest, ratio: +(longest / Math.max(1, shortest)).toFixed(2) } };
    },
  },

  // Each step depends on the one before it. The test is whether the connectives
  // are causal rather than merely additive.
  CHAINING: {
    describe: 'each step depends on the one before it',
    detect(text) {
      const causal = String(text).match(/\b(so|because|therefore|which means|so that|since|hence|as a result|that is why)\b/gi) || [];
      const additive = String(text).match(/\b(also|additionally|furthermore|moreover|and then)\b/gi) || [];
      return { present: causal.length >= 2, evidence: { causal: causal.length, additive: additive.length } };
    },
  },

  // The most in the fewest. Measured as information per word, crudely: named
  // specifics — numbers, dates, URLs, proper nouns — against total length.
  COMPRESSION: {
    describe: 'named specifics carry the weight, not adjectives',
    detect(text, { floor = 0.04 } = {}) {
      const total = words(text).length || 1;
      const specifics =
        (String(text).match(/\b\d[\d,.]*\b/g) || []).length +
        (String(text).match(/https?:\/\/\S+/g) || []).length +
        (String(text).match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).length;
      const density = specifics / total;
      return { present: density >= floor, evidence: { specifics, total, density: +density.toFixed(3) } };
    },
  },

  // The opposite move, and the one the repository's voice guide distrusts: a
  // claim opened out into explanation. Reported so an over-expanded draft is
  // visible, never required.
  EXPANSION: {
    describe: 'a claim opened out into explanation',
    detect(text) {
      const ss = sentences(text);
      const long = ss.filter((s) => words(s).length > 28);
      return { present: long.length > 0, evidence: { long: long.length, of: ss.length } };
    },
  },

  // The turn. Somewhere the passage stops doing one thing and does another, and
  // a reader can point at the sentence where it happened.
  PIVOT: {
    describe: 'the passage turns, and a reader can point at where',
    detect(text) {
      const marks = String(text).match(/\b(but|however|instead|the obvious guess|in fact|and yet|except|the problem is|which is why)\b/gi) || [];
      return { present: marks.length > 0, evidence: marks.slice(0, 4) };
    },
  },

  // It ends rather than stopping. The last movement resolves the first, and the
  // failure this catches is the draft that simply runs out.
  CLOSURE: {
    describe: 'it ends rather than stopping',
    detect(text) {
      const ss = sentences(text);
      if (!ss.length) return { present: false, evidence: 'empty' };
      const last = ss[ss.length - 1];
      const asks = /\?|\b(would you|can you|are you|worth|open to|reply|tell me|let me know|happy to)\b/i.test(last);
      // Shortness has to be RELATIVE. An absolute ceiling counted any final
      // sentence under twenty words as an ending, so a passage that simply ran
      // out mid-thought read as closed. What closes is a last line shorter than
      // the passage has been — the landing, not the length.
      const lens = ss.map((s) => words(s).length);
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const lands = ss.length > 1 && words(last).length <= mean * 0.7;
      return { present: asks || lands, evidence: { last: last.slice(0, 80), asks, lands, words: words(last).length, mean: +mean.toFixed(1) } };
    },
  },
};

export const OPERATOR_NAMES = Object.keys(OPERATORS);

// Runs every operator. Returns findings, never a verdict.
export function analyze(text, opts = {}) {
  const out = {};
  for (const [name, op] of Object.entries(OPERATORS)) out[name] = { ...op.detect(text, opts), describe: op.describe };
  return out;
}

// Composition: require a named set, forbid another. The algebra is nothing more
// than this — an operator is present or it is not, and a form is a set of
// requirements over them.
export function compose(text, { require: req = [], forbid = [] } = {}, opts = {}) {
  const found = analyze(text, opts);
  const missing = req.filter((n) => !found[n]?.present);
  const present = forbid.filter((n) => found[n]?.present);
  return {
    ok: missing.length === 0 && present.length === 0,
    missing,
    forbidden: present,
    found,
  };
}

// ---------------------------------------------------------------- outreach form

// The three movements the outreach has to make, in order.
//
// A NOTE ON THE NAME. The brief called this a "Bicolon / Elegiac distich"
// pattern and then named three movements. A bicolon is two cola and an elegiac
// distich is two lines, so three movements is a tricolon, not a distich. What the
// distich actually contributes is the ASYMMETRY — hexameter then a shorter
// pentameter that closes — and that property is enforced below: the closing
// movement must be shorter than the opening one. The count is three and the shape
// is long-then-short.
//
// It refines rather than replaces packet.md's "ethos, then pathos, then logos":
// standing is carried by the proof action rather than by a separate sentence,
// because a stranger's standing IS the artifact they can open.
export const MOVEMENTS = [
  {
    key: 'OBSERVATION',
    describe: 'one dated, checkable thing observed about them',
    detect: (t) => /\b\d{4}-\d{2}-\d{2}\b|\b\d+\s*(day|week|month|year|commit|issue|release|second|ms)s?\b|\b\d[\d,.]*\b/.test(t),
  },
  {
    key: 'DEFEATER',
    describe: 'the reason the obvious reading of that observation is wrong',
    detect: (t) => /\b(but|however|the obvious|not because|instead|which is not|rather than|except|would not)\b/i.test(t),
  },
  {
    key: 'PROOF_ACTION',
    describe: 'one sovereign proof a stranger can open, and one ask',
    detect: (t) => /https?:\/\/\S+/.test(t),
  },
];

// Splits an outreach draft into its movements by sentence.
//
// Each movement is located INDEPENDENTLY, at its first occurrence anywhere. The
// first version scanned greedily forward from the previous movement, which meant
// a draft whose movements ran backwards reported them as missing rather than as
// out of order — the check for order could never fire, because anything out of
// order had already been consumed as absent. Locating them independently lets
// the order be a separate question from the presence, which is what it is.
export function segmentOutreach(text) {
  const ss = sentences(text);
  const found = {};
  for (const m of MOVEMENTS) {
    const idx = ss.findIndex((s) => m.detect(s));
    if (idx >= 0) found[m.key] = { index: idx, text: ss[idx] };
  }
  return { sentences: ss, movements: found };
}

// The full outreach check: the three movements in order, the distich asymmetry,
// the word ceiling, and the reading grade.
export function checkOutreachForm(text, { maxWords = 120, gradeFloor = 6.0, gradeCeiling = 8.0 } = {}) {
  const problems = [];
  const notes = [];
  const { sentences: ss, movements } = segmentOutreach(text);

  for (const m of MOVEMENTS) {
    if (!movements[m.key]) problems.push(`missing movement ${m.key}: ${m.describe}`);
  }

  const order = MOVEMENTS.map((m) => movements[m.key]?.index).filter((i) => i != null);
  if (order.length === MOVEMENTS.length && order.some((v, i) => i > 0 && v <= order[i - 1])) {
    problems.push('the movements are out of order. Observation, then defeater, then the proof and the ask.');
  }

  // The distich property. The close lands because it is shorter than the open.
  const open = movements.OBSERVATION?.text;
  const close = movements.PROOF_ACTION?.text;
  if (open && close) {
    const o = words(open).length;
    const c = words(close).length;
    if (c >= o) {
      notes.push(
        `the closing movement (${c} words) is not shorter than the opening (${o}). The asymmetry is what makes it land; ` +
          'a close as long as the open reads as another paragraph rather than as an ending.'
      );
    }
  }

  const total = words(text).length;
  if (total > maxWords) problems.push(`${total} words, over the ${maxWords}-word ceiling.`);

  const grade = fkGrade(text);
  if (grade != null && grade > gradeCeiling) problems.push(`reads at grade ${grade}, above the ${gradeCeiling} ceiling.`);
  if (grade != null && grade < gradeFloor) notes.push(`reads at grade ${grade}, below the ${gradeFloor} floor.`);

  return { ok: problems.length === 0, problems, notes, wordCount: total, grade, sentences: ss.length, movements };
}
