// Pre-audit seal. Did the auditor change the thing it was auditing?
//
// The diagnostician writes data/diagnoses/<slug>.yaml. The auditor then opens
// the same file and appends `audit:` and `strikes:`. It holds Write over the
// whole repository, so nothing stops it editing the evidence rows it was sent to
// attack, and nothing afterward could tell: the artifact is the only record of
// what the diagnostician claimed, and the auditor is the last writer to it.
//
// So the digest is taken between the two agents, by code, and written to a
// sidecar the auditor does not need to touch:
//
//   node src/integrity.js --seal <company | path>     before the auditor runs
//   node src/integrity.js --verify <company | path>   after it
//
// WHAT THIS DOES AND DOES NOT PROVE. It is tamper-EVIDENT, not tamper-PROOF. An
// agent with Write can overwrite the sidecar as easily as the artifact. The
// threat this actually addresses is the likely one: an auditor that rewrites a
// field while appending its block, or a second pass that clobbers the first.
// Making that visible is worth the file. Claiming it stops a determined rewrite
// would be the kind of overstatement the auditor exists to strike.
//
// THE DIGEST COVERS THE READING, NOT THE BYTES. Same lesson as readingDigest in
// casefile.js, which closed two companies as DEAD over an added comment. YAML is
// parsed, `audit` and `strikes` are dropped, keys are sorted, and the rest is
// hashed. Reformatting, comment edits, and key reordering are not modifications.
// Changing a claim, a URL, a verdict, or a number is.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '..');

// The two blocks the auditor owns. Everything else in the file is the
// diagnostician's and must survive the audit byte-for-meaning.
export const AUDITOR_OWNED = ['audit', 'strikes'];

export const sealPathFor = (artifactPath) => String(artifactPath).replace(/\.ya?ml$/, '') + '.seal.json';

// Stable across key order, whitespace, and the Date objects js-yaml produces for
// unquoted timestamps.
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

export function diagnosticianView(doc) {
  const view = {};
  for (const k of Object.keys(doc || {})) {
    if (!AUDITOR_OWNED.includes(k)) view[k] = doc[k];
  }
  return canonical(view);
}

export function digestOf(doc) {
  return crypto.createHash('sha256').update(JSON.stringify(diagnosticianView(doc))).digest('hex');
}

const readDoc = (p) => yaml.load(fs.readFileSync(p, 'utf8'));

// Writes the sidecar. Refuses to overwrite an existing seal unless forced,
// because a re-seal after the audit would launder exactly the change the seal
// exists to catch. A forced re-seal keeps the digest it replaced, so the
// override is on the record rather than invisible.
export function seal(artifactPath, { force = false, at = null } = {}) {
  const full = path.resolve(ROOT, artifactPath);
  const doc = readDoc(full);
  if (!doc) throw new Error(`${artifactPath} is empty or unparseable. Nothing to seal.`);

  if (doc.audit) {
    throw new Error(
      `${path.relative(ROOT, full)} already carries an audit block. The seal is taken BEFORE the auditor runs; ` +
        'sealing now would certify whatever the auditor already wrote.'
    );
  }

  const sp = sealPathFor(full);
  const digest = digestOf(doc);
  const stamp = at || new Date().toISOString().slice(0, 10);

  if (fs.existsSync(sp) && !force) {
    const prior = JSON.parse(fs.readFileSync(sp, 'utf8'));
    if (prior.digest === digest) return { path: sp, digest, created: false, unchanged: true };
    throw new Error(
      `${path.relative(ROOT, sp)} already seals a different version of this artifact.\n` +
        `  sealed:  ${prior.digest}\n  current: ${digest}\n` +
        'The artifact changed after it was sealed. Pass --force to re-seal and record the replacement.'
    );
  }

  const prior = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : null;
  const record = {
    artifact: path.relative(ROOT, full),
    digest,
    sealed_at: stamp,
    algorithm: 'sha256',
    covers: `every top-level key except ${AUDITOR_OWNED.join(' and ')}`,
    ...(prior ? { resealed_at: stamp, replaced_digest: prior.digest } : {}),
  };
  fs.writeFileSync(sp, JSON.stringify(record, null, 2) + '\n');
  return { path: sp, digest, created: true, replaced: prior?.digest ?? null };
}

// Four states. Only `modified` and `digest_mismatch` are failures.
//
//   unsealed         no sidecar. The seal step did not run. A warning, not a
//                    failure: every artifact written before this existed is in
//                    this state and refusing them would take the whole record
//                    offline to enforce a rule that did not exist when they
//                    were written.
//   intact           sidecar matches the file as it stands.
//   modified         the diagnostician's half changed after sealing.
//   digest_mismatch  audit.diagnostician_digest disagrees with the sidecar. The
//                    auditor reported a digest that is not the one taken.
export function verify(artifactPath, { doc = null } = {}) {
  const full = path.resolve(ROOT, artifactPath);
  const d = doc || readDoc(full);
  const sp = sealPathFor(full);
  const actual = digestOf(d);
  const claimed = d?.audit?.diagnostician_digest ?? null;

  if (!fs.existsSync(sp)) {
    return {
      state: 'unsealed',
      ok: true,
      actual,
      sealed: null,
      claimed,
      message: `no seal beside ${path.basename(full)}. Nothing certifies what the diagnostician wrote before the audit.`,
    };
  }

  let sealed;
  try {
    sealed = JSON.parse(fs.readFileSync(sp, 'utf8'));
  } catch (e) {
    return { state: 'modified', ok: false, actual, sealed: null, claimed, message: `${path.basename(sp)} will not parse: ${e.message}` };
  }

  if (sealed.digest !== actual) {
    return {
      state: 'modified',
      ok: false,
      actual,
      sealed: sealed.digest,
      claimed,
      message:
        `the diagnostician's half of ${path.basename(full)} changed after it was sealed on ${sealed.sealed_at}.\n` +
        `    sealed:      ${sealed.digest}\n    on disk now: ${actual}\n` +
        '    The audit may have rewritten what it was sent to attack. Diff the artifact against the seal before trusting either.',
    };
  }

  if (claimed && claimed !== sealed.digest) {
    return {
      state: 'digest_mismatch',
      ok: false,
      actual,
      sealed: sealed.digest,
      claimed,
      message:
        `audit.diagnostician_digest does not match the seal taken before the audit.\n` +
        `    seal:  ${sealed.digest}\n    audit: ${claimed}`,
    };
  }

  return { state: 'intact', ok: true, actual, sealed: sealed.digest, claimed, message: null };
}

// ---------------------------------------------------------------- cli

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const target = argv.find((a, i) => i > 0 && !a.startsWith('--'));

  // Imported here rather than at the top: casefile.js imports the artifact
  // interceptor, which imports this file, and a top-level import back into
  // casefile.js would close the cycle.
  const resolveTarget = async (t) => {
    if (/\.ya?ml$/.test(String(t))) return path.resolve(ROOT, t);
    const { resolveDiagnosis } = await import('./casefile.js');
    return resolveDiagnosis(t);
  };

  const run = async () => {
    if (!target || (cmd !== '--seal' && cmd !== '--verify')) {
      console.error('usage: node src/integrity.js --seal <company | path> [--force]');
      console.error('       node src/integrity.js --verify <company | path>');
      process.exit(2);
    }
    const file = await resolveTarget(target);

    if (cmd === '--seal') {
      const r = seal(file, { force: argv.includes('--force') });
      if (r.unchanged) console.log(`Already sealed, unchanged. ${r.digest}`);
      else {
        console.log(`Sealed ${path.relative(ROOT, file)}`);
        console.log(`  ${r.digest}`);
        if (r.replaced) console.log(`  replaced ${r.replaced}  (forced re-seal, recorded in the sidecar)`);
      }
      return;
    }

    const v = verify(file);
    console.log(`${path.relative(ROOT, file)}: ${v.state}`);
    if (v.message) console.log(`  ${v.message}`);
    if (!v.ok) process.exit(1);
  };

  run().catch((e) => {
    console.error(`integrity: ${e.message}`);
    process.exit(1);
  });
}
