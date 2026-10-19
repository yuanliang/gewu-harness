// The CI gate: the ledger must tell an honest red → green story, and git history must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, fullCycle, MUL_TEST } from './helpers.mjs';

const ok = (r) => assert.equal(r.code, 0, r.out);

function branchWithCycle(options) {
  const p = project(options);
  p.git('checkout', '-qb', 'feat');
  fullCycle(p);
  return p;
}

test('audit passes an honest history', () => {
  const p = branchWithCycle();
  ok(p.gw('audit', '--base', 'main'));
});

test('audit fails while a cycle is still open', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', '--check', 'node --test test/mul.test.mjs'));
  p.write('test/mul.test.mjs', MUL_TEST);
  ok(p.gw('red'));
  const r = p.gw('audit');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /C1/);
});

test('audit flags source changes that no cycle verified', () => {
  const p = branchWithCycle();
  p.write('src/other.mjs', 'export const sneaky = 1;\n');
  p.git('add', '-A');
  p.git('commit', '-qm', 'sneak in unverified code');
  const r = p.gw('audit', '--base', 'main');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /src\/other\.mjs/);
});

test('replay re-proves every red in an isolated worktree, leaving the checkout alone', () => {
  const p = branchWithCycle();
  p.write('README.md', 'uncommitted work in progress\n');
  const r = p.gw('audit', '--base', 'main', '--replay');
  ok(r);
  assert.match(r.out, /replay/i);
  assert.equal(p.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feat');
  assert.equal(p.read('README.md'), 'uncommitted work in progress\n');
  assert.equal(p.git('worktree', 'list').trim().split('\n').length, 1, 'temporary worktrees are removed');
});

test('replay catches a forged red', () => {
  const p = branchWithCycle();
  const main = p.git('rev-parse', 'main').trim();
  const file = `docs/work/${p.work}/evidence.jsonl`;
  const forged = p.read(file).split('\n').map((line) => {
    if (!line) return line;
    const ev = JSON.parse(line);
    if (ev.ev === 'red') ev.commit = main; // claim red at a commit where everything passes
    return JSON.stringify(ev);
  }).join('\n');
  p.write(file, forged);
  p.git('add', '-A');
  p.git('commit', '-qm', 'forge');
  const r = p.gw('audit', '--base', 'main', '--replay');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /C1/);
});

test('replay refuses to let missing dependencies pose as red', () => {
  const p = branchWithCycle();
  p.write('node_modules/dep/index.js', 'export default 1;\n');
  const r = p.gw('audit', '--base', 'main', '--replay');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /replaySetup/);
  p.config({ replaySetup: 'true' });
  p.git('add', '-A');
  p.git('commit', '-qm', 'configure replay setup');
  ok(p.gw('audit', '--base', 'main', '--replay'));
});

test('replay setup can reuse caches from the checkout through $GW_ROOT', () => {
  const p = branchWithCycle();
  p.write('node_modules/dep/index.js', 'export default 1;\n');
  p.config({ replaySetup: 'test -f "$GW_ROOT/node_modules/dep/index.js" && ln -s "$GW_ROOT/node_modules" node_modules' });
  p.git('add', '-A');
  p.git('commit', '-qm', 'reuse dependencies in replay');
  ok(p.gw('audit', '--base', 'main', '--replay'));
});
