// The dashboard's own markup and inline script.
//
// THIS SUITE EXISTS BECAUSE OF A SPECIFIC BUG. page() returns a template
// literal, and a template literal silently eats an unrecognized escape: `\d`
// becomes `d`, `\/` becomes `/`. A regex written the obvious way inside that
// string reached the browser as `/phase d+/d+/`, and a second one reached it as
// an unterminated literal — a PARSE error, which killed the entire 18KB inline
// script before its first statement ran.
//
// The dashboard then rendered its placeholder state: a dash where the slot count
// goes, three empty lists, and tabs that did nothing. Nothing in the repository
// noticed, because the page was only ever checked by a person looking at it, and
// what a person sees is "the queue is empty" rather than "the script died".
//
// So: syntax-check the emitted script, and assert the handful of element ids the
// script and the markup have to agree on. Neither is a test of whether the page
// LOOKS right. Both catch the class of failure where it stops running at all.

import assert from 'node:assert';
import vm from 'node:vm';
import { page } from '../server.js';

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
};

const html = page();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// The script parses
// ---------------------------------------------------------------------------

t('the page emits exactly one inline script', () => {
  assert.equal(scripts.length, 1, 'the whole dashboard is one script; if that changes, so does this suite');
  assert.ok(scripts[0].length > 5000, 'suspiciously small; the script may have been truncated');
});

t('the emitted script is syntactically valid JavaScript', () => {
  // The assertion the bug needed. vm.Script compiles without executing, so no
  // DOM is required and nothing runs.
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'dashboard-inline.js' }));
});

t('no backslash survives into the emitted script', () => {
  // The root cause, stated as a rule the suite can hold. A template literal
  // cannot carry `\d` to a browser, so any backslash in this string is either
  // already corrupted or about to be. The regexes use character classes
  // instead — [0-9] for \d, [/] for \/, [$] for \$ — which need none.
  const backslashes = (scripts[0].match(/\\/g) || []).length;
  assert.equal(
    backslashes,
    0,
    `${backslashes} backslash(es) reached the browser. Rewrite with character classes; a template literal eats them.`
  );
});

t('the phase regex actually matches the lines the server emits', () => {
  // The broken version compiled to /phase d+[/]d+/ and matched nothing, so the
  // strip never advanced. This runs the real pattern against a real log line.
  const m = /var m = (\/phase[^;]*?\/i)\.exec/.exec(scripts[0]);
  assert.ok(m, 'the phase regex is no longer where this test looks for it');
  const re = new vm.Script(`(${m[1]})`).runInNewContext();
  const hit = re.exec('— phase 2/6 seal (node)');
  assert.ok(hit, 'the phase regex does not match a real server log line');
  assert.equal(hit[1].trim(), 'seal');
});

t('the recorder regex matches the line the server emits', () => {
  const m = /(\/\^\[\$\][^;]*?\/)\.test\(line\)/.exec(scripts[0]);
  assert.ok(m, 'the recorder regex moved');
  const re = new vm.Script(`(${m[1]})`).runInNewContext();
  assert.ok(re.test('$ node src/casefile.js --record Vercel --stage diagnose'));
});

// ---------------------------------------------------------------------------
// The script and the markup agree on ids
// ---------------------------------------------------------------------------

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

t('every element the render path writes into exists in the markup', () => {
  // getElementById on a missing id returns null, and the next property access
  // throws — which is the other way this script dies wholesale.
  for (const id of ['slots', 'drumlabel', 'pips', 'cards', 'queuecount', 'bench', 'benchcount', 'struck', 'struckcount', 'lines', 'logsum', 'viewer', 'viewerlabel', 'viewseg', 'pktlinks']) {
    assert.ok(ids.has(id), `markup is missing #${id}, which the script writes into`);
  }
});

t('the manual form has every field its handler reads', () => {
  for (const id of ['m-company', 'm-role', 'm-url', 'm-jd', 'm-count', 'm-note', 'm-result', 'm-phases', 'm-ingest', 'm-diagnose']) {
    assert.ok(ids.has(id), `manual tab is missing #${id}`);
  }
});

t('both tab panels exist and only the board is visible by default', () => {
  assert.ok(ids.has('tab-board') && ids.has('tab-manual'));
  assert.match(html, /<section id="tab-manual" class="tabpanel" hidden>/, 'the manual panel must start hidden');
  assert.match(html, /<section id="tab-board" class="tabpanel">/, 'the board panel must start visible');
});

t('the board panel still contains the queue, bench and struck lists', () => {
  // The tab wrapper is inserted around existing markup, and the failure mode of
  // that edit is a section that closes in the wrong place and swallows a list.
  const board = html.slice(html.indexOf('<section id="tab-board"'), html.indexOf('<h2>Run log</h2>'));
  for (const frag of ['id="cards"', 'id="bench"', 'id="struck"']) {
    assert.ok(board.includes(frag), `${frag} fell outside the board panel`);
  }
});

t('the run log and the report viewer sit outside both panels', () => {
  // They are shared: a manual diagnosis streams into the same log and renders
  // into the same iframe as one started from a card. Inside a panel, they would
  // vanish when the other tab is selected.
  const afterPanels = html.slice(html.indexOf('<h2>Run log</h2>'));
  assert.ok(afterPanels.includes('id="viewer"'));
  assert.ok(!afterPanels.includes('<section id="tab-'), 'a panel opens after the shared components');
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

t('the tab handler is wrapped so one script error cannot freeze the UI', () => {
  // Tab switching is how a reader reaches anything at all. It must not depend on
  // the queue rendering, the SSE client, or the manual form.
  const tabBlock = scripts[0].slice(scripts[0].indexOf('---- tabs'), scripts[0].indexOf('---- manual tab'));
  assert.match(tabBlock, /try \{/, 'the tab initialiser is not isolated');
  assert.match(tabBlock, /catch \(e\)/);
});

t('the manual tab is isolated from the board', () => {
  const manualBlock = scripts[0].slice(scripts[0].indexOf('---- manual tab'));
  assert.match(manualBlock, /catch \(e\) \{ console\.error\('manual tab failed to initialise'/);
});

t('a failed render says so instead of showing an empty queue', () => {
  // Placeholder state and an empty buffer look identical, and they are opposite
  // findings.
  assert.match(scripts[0], /dashboard render failed/);
  assert.match(scripts[0], /could not render/);
});

console.log(`\n${pass} passing`);
