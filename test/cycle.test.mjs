// The red → green cycle: start → red → green → done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { project, fullCycle, MUL_TEST, MUL_CRASH_TEST, MUL_IMPL } from './helpers.mjs';

const ok = (r) => assert.equal(r.code, 0, r.out);
const refused = (r, code) => {
  assert.notEqual(r.code, 0, `expected refusal ${code}, got success:\n${r.out}`);
  assert.match(r.out, new RegExp(code), r.out);
};
const CHECK = ['--check', 'node --test test/mul.test.mjs'];

test('new creates an active work item with an intent draft (CJK titles kept)', () => {
  const p = project();
  ok(p.gw('new', '乘法 支持'));
  assert.match(p.work, /^\d{4}-\d{2}-\d{2}-乘法-支持$/);
  const intent = p.read(`docs/work/${p.work}/intent.md`);
  assert.match(intent, /^---\n/);
  assert.match(intent, /^title: 乘法 支持$/m);
  assert.match(intent, /^status: draft/m);
  assert.match(intent, /^author: Test Dev$/m);
  assert.match(intent, /^## Acceptance signals/m);
});

test('templates follow the configured language', () => {
  const p = project({ config: { language: 'zh-CN' } });
  ok(p.gw('new', 'Multiply'));
  assert.match(p.read(`docs/work/${p.work}/intent.md`), /^## 验收信号/m);
});

test('start without an active work item creates a quick one', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  assert.equal(p.state().phase, 'test');
  assert.ok(p.work);
  assert.equal(p.ledger()[0].ev, 'start');
});

test('start is refused while a cycle is open', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'one', ...CHECK));
  refused(p.gw('start', 'R2', 'two', ...CHECK), 'E_PHASE');
});

test('an untargeted cycle needs a green baseline, so an old failure cannot pose as the new red', () => {
  const p = project({ files: { 'test/broken.test.mjs': "import { test } from 'node:test';\ntest('old', () => { throw new Error('old failure'); });\n" } });
  const r = p.gw('start', 'R1', 'mul multiplies');
  refused(r, 'E_BASELINE_RED');
  assert.match(r.out, /--check/);
  assert.equal(p.state().phase, 'idle');
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
});

test('a green baseline is recorded for untargeted cycles', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies'));
  assert.equal(p.ledger()[0].baseline.exit, 0);
});

test('red is refused when no test changed in this cycle', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  const r = p.gw('red');
  refused(r, 'E_NO_TEST_CHANGE');
  assert.match(r.out, /--adopt/);
  assert.equal(p.state().phase, 'test');
});

test('red is refused when the new test already passes', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'add again', '--check', 'node --test test/add2.test.mjs'));
  p.write('test/add2.test.mjs', "import { test } from 'node:test';\ntest('passes', () => {});\n");
  refused(p.gw('red'), 'E_NOT_RED');
  assert.equal(p.state().phase, 'test');
});

test('red is refused when it fails for an unpredicted reason', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK, '--expect', 'ZZZ_NOT_IN_OUTPUT'));
  p.write('test/mul.test.mjs', MUL_TEST);
  refused(p.gw('red'), 'E_WRONG_REASON');
  assert.equal(p.state().phase, 'test');
});

test('a crash only counts as red when it was predicted', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  p.write('test/mul.test.mjs', MUL_CRASH_TEST);
  const r = p.gw('red');
  refused(r, 'E_WRONG_REASON');
  assert.match(r.out, /--expect/);
  ok(p.gw('red', '--expect', "does not provide an export named 'mul'"));
  assert.equal(p.state().phase, 'impl');
});

test('a check that cannot run is never red', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', '--check', 'gewu-definitely-missing-command test/mul.test.mjs'));
  p.write('test/mul.test.mjs', MUL_TEST);
  refused(p.gw('red'), 'E_BROKEN_CHECK');
  assert.equal(p.state().phase, 'test');
});

test('red proves the failure, locks tests, and commits only the test', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK, '--expect', 'AssertionError'));
  p.write('test/mul.test.mjs', MUL_TEST);
  ok(p.gw('red'));
  assert.equal(p.state().phase, 'impl');
  const red = p.ledger().at(-1);
  assert.equal(red.ev, 'red');
  assert.notEqual(red.exit, 0);
  assert.deepEqual(red.tests, ['test/mul.test.mjs']);
  assert.equal(red.matched, true);
  assert.ok(red.commit, 'red commit sha recorded');
  assert.match(p.subject(), /\[red\]/);
  assert.deepEqual(p.filesIn(), ['test/mul.test.mjs']);
});

test('red is not entered when the red commit cannot be made', () => {
  const p = project();
  fs.writeFileSync(p.path('.git/hooks/pre-commit'), '#!/bin/sh\necho "rejected by hook"\nexit 1\n', { mode: 0o755 });
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  p.write('test/mul.test.mjs', MUL_TEST);
  const r = p.gw('red');
  refused(r, 'E_COMMIT');
  assert.match(r.out, /rejected by hook/);
  assert.equal(p.state().phase, 'test');
});

test('commit:false keeps the cycle but records no commits', () => {
  const p = project({ config: { commit: false } });
  const head = p.git('rev-parse', 'HEAD').trim();
  fullCycle(p);
  assert.equal(p.git('rev-parse', 'HEAD').trim(), head);
  assert.equal(p.ledger().find((e) => e.ev === 'red').commit, null);
});

test('green is refused while still red', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  p.write('test/mul.test.mjs', MUL_TEST);
  ok(p.gw('red'));
  refused(p.gw('green'), 'E_NOT_GREEN');
  assert.equal(p.state().phase, 'impl');
});

test('green is refused when a test was changed after red', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  p.write('test/mul.test.mjs', MUL_TEST);
  ok(p.gw('red'));
  p.write('test/mul.test.mjs', "import { test } from 'node:test';\ntest('gutted', () => {});\n");
  const r = p.gw('green');
  refused(r, 'E_TAMPER');
  assert.match(r.out, /test\/mul\.test\.mjs/);
});

test('green is refused when the targeted check passes but the full suite regresses', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  p.write('test/mul.test.mjs', MUL_TEST);
  ok(p.gw('red'));
  p.write('src/math.mjs', 'export const add = () => 0;\nexport const mul = (a, b) => a * b;\n');
  refused(p.gw('green'), 'E_REGRESSION');
});

test('green then done closes the cycle with evidence and a green commit', () => {
  const p = project();
  fullCycle(p);
  assert.equal(p.state().phase, 'idle');
  assert.deepEqual(p.ledger().map((e) => e.ev), ['start', 'red', 'green', 'done']);
  const done = p.ledger().at(-1);
  assert.ok(done.touched.source.includes('src/math.mjs'));
  assert.ok(done.touched.test.includes('test/mul.test.mjs'));
  const evidence = p.read(`docs/work/${p.work}/evidence.md`);
  assert.match(evidence, /C1/);
  assert.match(evidence, /R1/);
  assert.match(p.subject(), /\[green\]/);
  const files = p.filesIn();
  assert.ok(files.includes('src/math.mjs'), files.join(','));
  assert.ok(files.includes(`docs/work/${p.work}/evidence.jsonl`), files.join(','));
});

test('reopen returns to the test phase, is recorded, and red must be proven again', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  p.write('test/mul.test.mjs', MUL_TEST);
  ok(p.gw('red'));
  ok(p.gw('reopen', 'assertion used the wrong value'));
  assert.equal(p.state().phase, 'test');
  assert.equal(p.ledger().at(-1).ev, 'reopen');
  assert.equal(p.ledger().at(-1).reason, 'assertion used the wrong value');
  refused(p.gw('green'), 'E_PHASE');
  ok(p.gw('red'));
  p.write('src/math.mjs', MUL_IMPL);
  ok(p.gw('green'));
});

test('abort ends the cycle and is recorded', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  ok(p.gw('abort', 'wrong approach'));
  assert.equal(p.state().phase, 'idle');
  assert.equal(p.ledger().at(-1).ev, 'abort');
});

test('chore allows a non-behavioral change, verified by the full suite', () => {
  const p = project();
  ok(p.gw('chore', 'rename parameters'));
  assert.equal(p.state().phase, 'chore');
  p.write('src/math.mjs', 'export const add = (x, y) => x + y;\n');
  ok(p.gw('done'));
  assert.equal(p.state().phase, 'idle');
  const ev = p.ledger().at(-1);
  assert.equal(ev.ev, 'chore-done');
  assert.ok(ev.touched.source.includes('src/math.mjs'));
});

// Git trusts a file's timestamp and size unless the entry is "racy" (as new as the index itself).
// A snapshot must keep that protection, or a same-size rewrite in the same second goes unseen.
test('the snapshot sees a same-size rewrite that kept its timestamp', () => {
  const p = project();
  p.git('config', 'core.trustctime', 'false');
  const past = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(p.path('src/math.mjs'), past, past);
  p.git('add', 'src/math.mjs');
  fs.utimesSync(p.path('.git/index'), past, past);
  ok(p.gw('chore', 'same-size rewrite'));
  p.write('src/math.mjs', 'export const add = (x, y) => x + y;\n');
  fs.utimesSync(p.path('src/math.mjs'), past, past);
  ok(p.gw('done'));
  assert.ok(p.ledger().at(-1).touched.source.includes('src/math.mjs'), JSON.stringify(p.ledger().at(-1).touched));
});

test('a chore that breaks the suite cannot be closed', () => {
  const p = project();
  ok(p.gw('chore', 'oops'));
  p.write('src/math.mjs', 'export const add = () => 0;\n');
  refused(p.gw('done'), 'E_NOT_GREEN');
  assert.equal(p.state().phase, 'chore');
});

test('an existing failing test can be adopted explicitly, and the evidence says so', () => {
  const p = project({ files: { 'test/mul.test.mjs': MUL_TEST } });
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK, '--expect', 'AssertionError'));
  ok(p.gw('red', '--adopt', 'test/mul.test.mjs'));
  const red = p.ledger().at(-1);
  assert.equal(red.adopted, true);
  assert.deepEqual(red.tests, ['test/mul.test.mjs']);
  assert.equal(red.commit, p.git('rev-parse', 'HEAD').trim(), 'HEAD already holds the failing test');
  p.write('src/math.mjs', MUL_IMPL);
  ok(p.gw('green'));
  ok(p.gw('done'));
  assert.match(p.read(`docs/work/${p.work}/evidence.md`), /adopted/i);
});

test('adoption needs an unchanged test file and a prediction', () => {
  const p = project({ files: { 'test/mul.test.mjs': MUL_TEST } });
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  refused(p.gw('red', '--adopt', 'test/mul.test.mjs'), 'E_USAGE');
  refused(p.gw('red', '--adopt', 'src/math.mjs', '--expect', 'AssertionError'), 'E_USAGE');
  p.write('test/mul.test.mjs', MUL_TEST.replace('6', '7'));
  refused(p.gw('red', '--adopt', 'test/mul.test.mjs', '--expect', 'AssertionError'), 'E_USAGE');
});

test('approve records the approver and the exact content approved', () => {
  const p = project();
  ok(p.gw('new', 'Multiply', '--type', 'bug'));
  ok(p.gw('approve', 'intent'));
  const intent = p.read(`docs/work/${p.work}/intent.md`);
  assert.match(intent, /^status: accepted/m);
  assert.match(intent, /^approved_by: Test Dev$/m);
  assert.match(intent, /^approved_sha: [0-9a-f]{64}$/m);
  assert.equal(p.ledger().at(-1).ev, 'approve');
});

test('strict gates need approved docs, and an edit after approval needs approval again', () => {
  const p = project({ config: { gates: 'strict' } });
  ok(p.gw('new', 'Fix overflow', '--type', 'bug'));
  refused(p.gw('start', 'B1', 'no overflow', ...CHECK), 'E_GATE');
  ok(p.gw('approve', 'intent'));
  const file = `docs/work/${p.work}/intent.md`;
  p.write(file, p.read(file) + '\nOne more requirement added after approval.\n');
  const r = p.gw('start', 'B1', 'no overflow', ...CHECK);
  refused(r, 'E_GATE');
  assert.match(r.out, /changed after approval/);
  ok(p.gw('approve', 'intent'));
  ok(p.gw('start', 'B1', 'no overflow', ...CHECK));
});

test('status --json reports phase, cycle and the next step', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', ...CHECK));
  const s = JSON.parse(p.gw('status', '--json').stdout);
  assert.equal(s.phase, 'test');
  assert.equal(s.cycle.req, 'R1');
  assert.match(s.next, /gw red/);
});

test('commands that need verify fail clearly when it is not configured', () => {
  const p = project({ config: { verify: null } });
  refused(p.gw('start', 'R1', 'mul'), 'E_NO_VERIFY');
});
