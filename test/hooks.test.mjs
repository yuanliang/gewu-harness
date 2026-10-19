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
  for (const rel of ['.harness/config.json', '.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.agents/skills/gw-next/SKILL.md', 'REVIEW.md']) {
    assert.equal(p.write_(rel).decision, 'ask', rel);
  }
});

test("the harness's own files stay guarded even if guardGlobs is narrowed", () => {
  const p = project({ config: { guardGlobs: [] } });
  ok(p.gw('chore', 'tidy'));
  assert.equal(p.write_('.harness/gw.mjs').decision, 'ask');
  assert.equal(p.write_('.codex/hooks.json').decision, 'ask');
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

test('enforce=warn never softens a hard denial hiding in the same command', () => {
  const p = project({ config: { enforce: 'warn' } });
  assert.equal(p.bash('rm src/math.mjs .harness/state.json').decision, 'deny');
  assert.equal(p.bash('rm .harness/state.json src/math.mjs').decision, 'deny');
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

test('bash: delivery actions ask the user', () => {
  const p = inPhase('idle');
  for (const cmd of ['git push origin main', 'gh pr merge 3 --squash', 'npm publish']) assert.equal(p.bash(cmd).decision, 'ask', cmd);
  assert.equal(p.bash('git pull origin main').decision, 'allow');
});

// ── Codex: Claude's hook protocol, but edits arrive as apply_patch text and "ask" does not exist.
const patch = (file, body = '+x', op = 'Update') => `*** Begin Patch\n*** ${op} File: ${file}\n@@\n${body}\n*** End Patch\n`;
const codex = (p, tool_name, command) =>
  p.hook('pre-tool', { hook_event_name: 'PreToolUse', tool_name, tool_input: { command } }, 'codex').json?.hookSpecificOutput;

test('codex: apply_patch is judged by the files it touches', () => {
  const p = inPhase('test');
  assert.equal(codex(p, 'apply_patch', patch('test/mul.test.mjs')), undefined, 'tests are writable in TEST');
  const src = codex(p, 'apply_patch', patch('src/math.mjs'));
  assert.equal(src.permissionDecision, 'deny');
  assert.match(src.permissionDecisionReason, /gw red/);
  assert.equal(codex(p, 'apply_patch', patch('src/new.mjs', '+x', 'Add')).permissionDecision, 'deny');
  assert.equal(codex(p, 'Bash', `apply_patch <<'EOF'\n${patch('src/math.mjs')}EOF`).permissionDecision, 'deny', 'patches through the shell too');
});

test('codex: anything that needs the user is denied with a reason, since Codex cannot ask', () => {
  const p = inPhase('idle');
  for (const [tool, command] of [['Bash', 'git push origin main'], ['Bash', '.harness/gw chore "rename"'], ['apply_patch', patch('docs/work/x/plan.md', '+status: approved')]]) {
    const d = codex(p, tool, command);
    assert.equal(d.permissionDecision, 'deny', command);
    assert.match(d.permissionDecisionReason, /user/i, command);
  }
});

test('codex: stop and session start speak the Claude-compatible protocol', () => {
  const p = inPhase('impl');
  p.write('src/math.mjs', 'export const add = (a, b) => a + b;\nexport const mul = () => 0;\n');
  assert.equal(p.hook('stop', { stop_hook_active: false }, 'codex').json?.decision, 'block');
  assert.match(p.hook('session-start', { source: 'startup' }, 'codex').stdout, /gw green/);
});

// ── Cursor: its own permission protocol; only shell commands can ask the user.
const cursor = (p, input) => p.hook('pre-tool', input, 'cursor').json;

test('cursor: file writes answer with a permission', () => {
  const p = inPhase('test');
  assert.deepEqual(cursor(p, { hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: p.path('test/mul.test.mjs') } }), { permission: 'allow' });
  const src = cursor(p, { hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: p.path('src/math.mjs') } });
  assert.equal(src.permission, 'deny');
  assert.match(src.agent_message, /gw red/);
  assert.equal(cursor(p, { hook_event_name: 'preToolUse', tool_name: 'Delete', tool_input: { path: p.path('src/math.mjs') } }).permission, 'deny');
});

test('cursor: shell commands are guarded, and delivery asks the user', () => {
  const p = inPhase('impl');
  const shell = (command) => cursor(p, { hook_event_name: 'beforeShellExecution', command, cwd: p.dir }).permission;
  assert.equal(shell('git push origin main'), 'ask');
  assert.equal(shell(`sed -i '' 's/6/5/' test/mul.test.mjs`), 'deny');
  assert.equal(shell('node --test'), 'allow');
});

test('cursor: stop follows up once, and session start adds context', () => {
  const p = inPhase('impl');
  p.write('src/math.mjs', 'export const add = (a, b) => a + b;\nexport const mul = () => 0;\n');
  assert.match(p.hook('stop', { status: 'completed', loop_count: 0 }, 'cursor').json?.followup_message ?? '', /gw green/);
  assert.equal(p.hook('stop', { status: 'completed', loop_count: 1 }, 'cursor').json?.followup_message, undefined);
  assert.match(p.hook('session-start', {}, 'cursor').json?.additional_context ?? '', /RED/);
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
