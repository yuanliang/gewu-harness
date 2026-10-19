// Deterministic guardrails: PreToolUse / Stop / SessionStart / statusline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { project, tmpdir, run, ROOT, MUL_TEST } from './helpers.mjs';

const ok = (r) => assert.equal(r.code, 0, r.out);

function inPhase(phase) {
  const p = project();
  if (phase === 'idle') return p;
  if (phase === 'chore') { ok(p.gw('chore', 'tidy')); return p; }
  ok(p.gw('start', 'R1', 'mul multiplies', '--check', 'node --test test/mul.test.mjs'));
  if (phase === 'test') return p;
  p.write('test/mul.test.mjs', MUL_TEST);
  ok(p.gw('red'));
  return p;
}

test('projects without the harness are left alone', () => {
  const dir = tmpdir();
  const r = run(process.execPath, [path.join(ROOT, 'kit/.harness/gw.mjs'), 'hook', 'pre-tool'], {
    cwd: dir,
    input: JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.mjs'), content: 'x' } }),
  });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout.trim(), '');
});

test('idle: source and tests are locked, docs are free', () => {
  const p = inPhase('idle');
  const src = p.write_('src/math.mjs');
  assert.equal(src.decision, 'deny');
  assert.match(src.reason, /gw start/);
  assert.equal(p.write_('test/x.test.mjs').decision, 'deny');
  assert.equal(p.write_('docs/notes.md').decision, 'allow');
  assert.equal(p.write_('README.md').decision, 'allow');
});

test('test phase: only verification may be written', () => {
  const p = inPhase('test');
  assert.equal(p.write_('test/mul.test.mjs').decision, 'allow');
  const src = p.write_('src/math.mjs');
  assert.equal(src.decision, 'deny');
  assert.match(src.reason, /gw red/);
});

test('red phase: source unlocked, tests frozen with a reopen hint', () => {
  const p = inPhase('impl');
  assert.equal(p.write_('src/math.mjs').decision, 'allow');
  const t = p.write_('test/mul.test.mjs');
  assert.equal(t.decision, 'deny');
  assert.match(t.reason, /gw reopen/);
  assert.equal(p.write_('src/__tests__/a.js').decision, 'deny');
  assert.equal(p.write_('pkg/a_test.go').decision, 'deny');
  assert.equal(p.write_('tests/test_api.py').decision, 'deny');
});

test('state and evidence are never hand-edited, even in a chore', () => {
  const p = inPhase('chore');
  assert.equal(p.write_('.harness/state.json').decision, 'deny');
  assert.equal(p.write_('docs/work/x/evidence.jsonl').decision, 'deny');
  assert.equal(p.write_('docs/work/x/evidence.md').decision, 'deny');
});

test('guardrail files need a human to approve the edit', () => {
  const p = inPhase('chore');
  assert.equal(p.write_('.harness/config.json').decision, 'ask');
  assert.equal(p.write_('.claude/settings.json').decision, 'ask');
  assert.equal(p.write_('REVIEW.md').decision, 'ask');
});

test('the agent cannot mark a document approved', () => {
  const p = inPhase('idle');
  const file = p.path('docs/work/x/plan.md');
  for (const new_string of ['status: approved', 'approved_sha: 0123']) {
    const d = p.decide('Edit', { file_path: file, old_string: 'status: draft', new_string });
    assert.equal(d.decision, 'deny', new_string);
    assert.match(d.reason, /! \.harness\/gw approve/);
  }
  assert.equal(p.decide('Edit', { file_path: file, old_string: 'a', new_string: 'b' }).decision, 'allow');
});

test('bash: writes to locked paths are blocked, reads and test runs are not', () => {
  const p = inPhase('impl');
  assert.equal(p.bash(`sed -i '' 's/6/5/' test/mul.test.mjs`).decision, 'deny');
  assert.equal(p.bash('echo x > test/new.test.mjs').decision, 'deny');
  assert.equal(p.bash('cat src/a.mjs | tee test/mul.test.mjs').decision, 'deny');
  assert.equal(p.bash('git checkout -- test/mul.test.mjs').decision, 'deny');
  assert.equal(p.bash('rm -f .harness/state.json').decision, 'deny');
  assert.equal(p.bash('node --test test/mul.test.mjs 2>&1 | tail -20').decision, 'allow');
  assert.equal(p.bash('cat test/mul.test.mjs').decision, 'allow');
  assert.equal(p.bash('echo hi > /tmp/gewu-x.txt').decision, 'allow');
  assert.equal(p.bash('echo "x" > src/math.mjs').decision, 'allow');
});

// Found in a real session: an arrow function in a heredoc body looked like a redirect.
test('bash: heredoc bodies are content, not commands', () => {
  const heredoc = (target) => `cat >> ${target} <<'EOF'\n\ntest('excludes n', () => assert.deepEqual(range(3), [0, 1, 2]));\nEOF`;
  const writing = inPhase('test');
  assert.equal(writing.bash(heredoc('test/mul.test.mjs')).decision, 'allow');
  assert.equal(writing.bash(heredoc('src/math.mjs')).decision, 'deny');
  assert.equal(inPhase('impl').bash(heredoc('test/mul.test.mjs')).decision, 'deny');
});

test('bash: idle locks source writes too, but not branch switches', () => {
  const p = inPhase('idle');
  assert.equal(p.bash('rm src/math.mjs').decision, 'deny');
  assert.equal(p.bash('mv src/math.mjs src/m.mjs').decision, 'deny');
  assert.equal(p.bash('git status && ls src').decision, 'allow');
  assert.equal(p.bash('git checkout -b feature').decision, 'allow');
});

test('bash: guardrail files cannot be rewritten from the shell', () => {
  const p = inPhase('chore');
  const d = p.bash('echo "{}" > .harness/config.json');
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /Edit/);
});

test('bash: declaring a chore or approving a gate asks the human', () => {
  const p = inPhase('idle');
  assert.equal(p.bash('.harness/gw chore "rename"').decision, 'ask');
  assert.equal(p.bash('node .harness/gw.mjs approve plan').decision, 'ask');
  assert.equal(p.bash('.harness/gw status').decision, 'allow');
  assert.equal(p.bash('.harness/gw start R1 "x"').decision, 'allow');
});

test('enforce=warn allows but tells the agent what rule it broke', () => {
  const p = project({ config: { enforce: 'warn' } });
  const d = p.write_('src/math.mjs');
  assert.equal(d.decision, 'allow');
  assert.match(d.context, /gw start/);
});

test('a broken guard fails closed instead of letting edits through', () => {
  const p = inPhase('idle');
  p.write('.harness/config.json', '{ not json');
  const d = p.write_('src/math.mjs');
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /config\.json/);
});

test('settings ask before external actions and gate decisions, even in bypass mode', () => {
  const p = inPhase('idle');
  const ask = JSON.parse(p.read('.claude/settings.json')).permissions.ask;
  for (const rule of [
    'Bash(git push)', 'Bash(git push *)', 'Bash(gh pr merge *)', 'Bash(npm publish *)',
    'Bash(.harness/gw chore *)', 'Bash(.harness/gw approve *)', 'Edit(/.harness/**)', 'Edit(/.claude/settings.json)', 'Edit(/REVIEW.md)',
  ]) assert.ok(ask.includes(rule), rule);
});

test('stop: blocks once when changes since the last proof are unverified', () => {
  const p = inPhase('impl');
  assert.equal(p.hook('stop', { stop_hook_active: false }).json, null, 'nothing changed since red → may stop');
  p.write('src/math.mjs', 'export const add = (a, b) => a + b;\nexport const mul = () => 0;\n');
  const r = p.hook('stop', { stop_hook_active: false });
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /gw green/);
  assert.equal(p.hook('stop', { stop_hook_active: true }).json, null, 'never traps the agent in a loop');
});

test('stop: idle never blocks', () => {
  const p = inPhase('idle');
  p.write('docs/notes.md', 'hi');
  assert.equal(p.hook('stop', { stop_hook_active: false }).json, null);
});

test('session start injects the loop status and the next step', () => {
  const p = inPhase('test');
  const r = p.hook('session-start', { source: 'startup' });
  ok(r);
  assert.match(r.stdout, /TEST/);
  assert.match(r.stdout, /gw red/);
  assert.match(r.stdout, /red before green/i);
});

test('statusline shows phase and lock', () => {
  const p = inPhase('impl');
  const r = p.hook('statusline', { workspace: { current_dir: p.dir, project_dir: p.dir } });
  ok(r);
  assert.match(r.stdout, /RED/);
  assert.match(r.stdout, /R1/);
  assert.match(r.stdout, /🔒/);
});
