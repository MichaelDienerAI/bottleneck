// The guards on the two manual dashboard routes.
//
// Pure, and separate from server.js, because the guards are the part worth
// testing and server.js starts listening the moment it is imported. What is
// decided here is not "does the form look right" but "may this click spend the
// constraint," and that question has four answers before it has a yes.
//
// A BUTTON THAT SPENDS A DRUM SLOT IS THE WHOLE HAZARD. The dashboard exists to
// make the system legible, and the fastest way to make it illegible is a control
// that quietly consumes the one resource everything else is subordinated to. So:
// a diagnose asks first, refuses when the week is spent, and refuses while
// another job holds the slot.
//
// One asymmetry, stated rather than smoothed over: /api/run does NOT check open
// slots today — it checks queue membership, concurrency and confirm, and will
// start a diagnosis on a full drum. That is a pre-existing gap. This route
// closes it for the manual path rather than leaving both open, and does not
// change /api/run, because tightening a route the user drives every week is a
// behaviour change that belongs in its own commit with its own reasoning.

export const REQUIRED = ['company', 'role_title', 'jd_text'];

const str = (v) => String(v ?? '').trim();

// Shape check only. Whether the JD is any good is not a thing code decides.
export function validateBody(body = {}) {
  const missing = REQUIRED.filter((k) => !str(body[k]));
  if (missing.length) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
        required: REQUIRED,
      },
    };
  }
  if (str(body.jd_text).length < 40) {
    // A JD of a dozen characters is a paste that went wrong, and diagnosing it
    // would spend a slot on nothing.
    return { ok: false, status: 400, body: { error: 'jd_text is too short to be a job description. Paste the whole posting.' } };
  }
  return { ok: true };
}

// ctx: { running, runningCompany, slots, bufferLength, bufferMax, existingKey }
export function decideIngest(body = {}, ctx = {}) {
  const v = validateBody(body);
  if (!v.ok) return v;

  // The queue is read by a running diagnostician. Editing it underneath one is
  // the hazard /api/strike already guards, narrowly: only the row under
  // diagnosis matters, and an insert touches no existing row.
  if (ctx.running && ctx.runningCompany && str(body.company) === ctx.runningCompany) {
    return {
      ok: false,
      status: 409,
      body: { error: `a job is running on ${ctx.runningCompany} and reads its row. Wait for it to finish.` },
    };
  }

  // Replacing an existing row discards whatever was there. Adding one does not.
  if (ctx.existingKey && !body.confirm) {
    return { ok: false, status: 428, body: { error: 'confirm required', replaces: str(body.company) } };
  }

  if (!ctx.existingKey && (ctx.bufferLength ?? 0) >= (ctx.bufferMax ?? 10) && !body.force) {
    return {
      ok: false,
      status: 409,
      body: {
        error: `the buffer already holds ${ctx.bufferMax} rows, which is what the rope set it to.`,
        hint: 'Strike a row first, or pass force to run over the cap deliberately.',
      },
    };
  }

  return { ok: true, action: 'ingest' };
}

export function decideDiagnose(body = {}, ctx = {}) {
  const v = validateBody(body);
  if (!v.ok) return v;

  if (ctx.running) {
    return { ok: false, status: 409, body: { error: 'a job is already running' } };
  }

  // Fail closed on the drum. Zero slots means the week's capacity is spent, and
  // a diagnosis started anyway is work that arrives after the thing it was for.
  if ((ctx.slots ?? 0) <= 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'no packet slots left this week. The drum is the constraint and a diagnosis spends one.',
        slots: ctx.slots ?? 0,
      },
    };
  }

  if (!body.confirm) {
    return {
      ok: false,
      status: 428,
      body: {
        error: 'confirm required',
        spends_slot: true,
        company: str(body.company),
        slots_after: (ctx.slots ?? 0) - 1,
      },
    };
  }

  return { ok: true, action: 'diagnose' };
}

// The phases the manual run passes through, for the progress indicator. Read off
// PHASES.diagnose in server.js rather than restated as prose, so the dashboard
// cannot describe a pipeline the server is not running.
export const PHASE_LABELS = [
  'ingesting',
  'diagnostician',
  'seal',
  'blind packet',
  'blind audit',
  'collision audit',
  'verify',
  'recording',
];
