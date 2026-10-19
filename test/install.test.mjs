// Installing into a project: idempotent, non-destructive, stack-aware, and fully reversible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Project, tmpdir, gitInit, run, INSTALL, project } from './helpers.mjs';

function repo(files = {}) {
  const p = new Project(tmpdir());
  gitInit(p.dir);
  for (const [rel, content] of Object.entries(files)) p.write(rel, content);
  return p;
}
// LC_ALL and LC_MESSAGES outrank LANG (CI machines often set LC_ALL), so tests pin all three.
const { LC_ALL, LC_MESSAGES, ...baseEnv } = process.env;
const locale = (lang) => ({ ...baseEnv, LANG: lang });
const install = (p, ...args) => run(process.execPath, [INSTALL, ...args, p.dir], { env: locale('en_US.UTF-8') });
const ok = (r) => assert.equal(r.code, 0, r.out);
const json = (p, rel) => JSON.parse(p.read(rel));
const gwHandlers = (settings, event) =>
  (settings.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? [g]).filter((h) => h.command.includes('.harness/gw.mjs'));
const SKILLS = ['next', 'intent', 'spec', 'plan', 'build', 'fix', 'review', 'ship', 'incident'];

test('installs the core and every supported agent by default', () => {
  const p = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
  ok(install(p));
  const cfg = json(p, '.harness/config.json');
  assert.equal(cfg.verify, 'npm test');
  assert.deepEqual(cfg.hosts, ['claude', 'codex', 'cursor']);
  for (const rel of [
    '.harness/gw.mjs', '.harness/gw', '.harness/RULES.md',
    ...['en', 'zh-CN'].flatMap((l) => ['intent', 'spec', 'plan'].map((d) => `.harness/templates/${l}/${d}.md`)),
    ...SKILLS.flatMap((s) => [`.claude/skills/gw-${s}/SKILL.md`, `.agents/skills/gw-${s}/SKILL.md`]),
    '.claude/agents/gw-reviewer.md', '.claude/agents/gw-test-author.md',
    'REVIEW.md', '.github/workflows/gw-audit.yml',
  ]) assert.ok(p.exists(rel), rel);
  assert.ok(fs.statSync(p.path('.harness/gw')).mode & 0o111, 'shim is executable');
  const claude = json(p, '.claude/settings.json');
  for (const ev of ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart']) assert.equal(gwHandlers(claude, ev).length, 1, `claude ${ev}`);
  assert.match(claude.statusLine.command, /gw\.mjs/);
  assert.match(p.read('CLAUDE.md'), /^@\.harness\/RULES\.md$/m);
  const codex = json(p, '.codex/hooks.json');
  for (const ev of ['PreToolUse', 'Stop', 'SessionStart']) assert.equal(gwHandlers(codex, ev).length, 1, `codex ${ev}`);
  const cursor = json(p, '.cursor/hooks.json');
  assert.equal(cursor.version, 1);
  for (const ev of ['preToolUse', 'beforeShellExecution', 'stop', 'sessionStart']) assert.equal(gwHandlers(cursor, ev).length, 1, `cursor ${ev}`);
  const agents = p.read('AGENTS.md');
  assert.equal(agents.match(/<!-- gewu:rules -->/g).length, 1);
  assert.ok(agents.includes(p.read('.harness/RULES.md').trim()), 'AGENTS.md carries the same rulebook');
  assert.match(p.read('.gitignore'), /^\.harness\/state\.json$/m);
});

test('agents can be chosen, are remembered, and dropping one removes its files', () => {
  const p = repo({ 'AGENTS.md': '# Team rules\n', '.codex/config.toml': 'model = "x"\n' });
  ok(install(p, '--hosts', 'codex'));
  assert.deepEqual(json(p, '.harness/config.json').hosts, ['codex']);
  assert.ok(p.exists('.codex/hooks.json') && p.exists('.agents/skills/gw-next/SKILL.md'));
  assert.equal(p.exists('.claude'), false);
  assert.equal(p.exists('.cursor'), false);
  assert.equal(p.exists('CLAUDE.md'), false);
  ok(install(p));
  assert.deepEqual(json(p, '.harness/config.json').hosts, ['codex'], 'remembered on reinstall');
  ok(install(p, '--hosts', 'claude'));
  assert.equal(p.exists('.codex/hooks.json'), false);
  assert.equal(p.exists('.agents'), false);
  assert.equal(p.read('AGENTS.md'), '# Team rules\n');
  assert.equal(p.read('.codex/config.toml'), 'model = "x"\n', 'your Codex config is untouched');
  assert.ok(p.exists('.claude/settings.json'));
});

test('the installer prints the exact command to commit what it added', () => {
  const all = repo();
  const r = install(all);
  ok(r);
  const add = r.out.match(/^\s*git add (.+)$/m)?.[1].split(' ') ?? [];
  for (const path of ['.harness', '.claude', '.codex', '.cursor', '.agents', '.github', 'AGENTS.md', 'CLAUDE.md', 'REVIEW.md', '.gitignore']) assert.ok(add.includes(path), path);
  const claudeOnly = install(repo(), '--hosts', 'claude');
  assert.doesNotMatch(claudeOnly.out.match(/^\s*git add (.+)$/m)?.[1] ?? '', /\.codex|\.cursor|AGENTS\.md/);
});

// The configs carry real shell commands; run them exactly as each agent would.
test('every installed hook command runs from a subdirectory, the way each agent invokes it', () => {
  const p = project();
  ok(p.gw('start', 'R1', 'mul multiplies', '--check', 'node --test test/mul.test.mjs'));
  const sub = p.path('src');
  const command = (file, event, pick) => pick(json(p, file).hooks[event]);
  const sh = (cmd, cwd, input, env = {}) => run('/bin/sh', ['-c', cmd], { cwd, input: JSON.stringify(input), env: { ...process.env, ...env } });
  const claude = sh(command('.claude/settings.json', 'PreToolUse', (g) => g[0].hooks[0].command), sub,
    { cwd: sub, tool_name: 'Write', tool_input: { file_path: p.path('src/math.mjs') } }, { CLAUDE_PROJECT_DIR: p.dir });
  assert.equal(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision, 'deny', claude.out);
  const codex = sh(command('.codex/hooks.json', 'PreToolUse', (g) => g[0].hooks[0].command), sub,
    { cwd: sub, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: math.mjs\n+x\n*** End Patch\n' } });
  assert.equal(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision, 'deny', codex.out);
  const cursor = sh(command('.cursor/hooks.json', 'preToolUse', (h) => h[0].command), p.dir,
    { hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: p.path('src/math.mjs') }, workspace_roots: [p.dir] });
  assert.equal(JSON.parse(cursor.stdout).permission, 'deny', cursor.out);
});

test('refreshing the AGENTS.md rulebook leaves the text around it as it was', () => {
  const p = repo();
  ok(install(p, '--hosts', 'codex'));
  const stale = p.read('AGENTS.md').replace(/<!-- gewu:rules -->[\s\S]*<!-- \/gewu:rules -->/, '<!-- gewu:rules -->\nold rules\n<!-- /gewu:rules -->');
  p.write('AGENTS.md', `# Before\n\n${stale}\n## After\n\nKeep this spacing.\n`);
  ok(install(p));
  const agents = p.read('AGENTS.md');
  assert.doesNotMatch(agents, /old rules/);
  assert.match(agents, /<!-- \/gewu:rules -->\n\n## After\n\nKeep this spacing\.\n$/);
  assert.match(agents, /^# Before\n\n<!-- gewu:rules -->/);
});

test('upgrading from 0.6.0 moves the rulebook import without duplicating it', () => {
  const p = repo({ 'CLAUDE.md': '# Mine\n\n## Gewu Harness\n\n@.harness/CLAUDE.md\n', '.harness/CLAUDE.md': 'old rules\n' });
  ok(install(p, '--hosts', 'claude'));
  assert.equal(p.exists('.harness/CLAUDE.md'), false);
  const claude = p.read('CLAUDE.md');
  assert.doesNotMatch(claude, /@\.harness\/CLAUDE\.md/);
  assert.equal(claude.match(/^@\.harness\/RULES\.md$/gm).length, 1);
});

test('document language follows the system locale unless chosen explicitly', () => {
  const zh = repo();
  ok(run(process.execPath, [INSTALL, zh.dir], { env: locale('zh_CN.UTF-8') }));
  assert.equal(json(zh, '.harness/config.json').language, 'zh-CN');
  const en = repo();
  ok(install(en));
  assert.equal(json(en, '.harness/config.json').language, 'en');
  const chosen = repo();
  ok(install(chosen, '--language', 'zh-CN'));
  assert.equal(json(chosen, '.harness/config.json').language, 'zh-CN');
});

test('reinstalling is idempotent and keeps local choices', () => {
  const p = repo({
    'go.mod': 'module x\n',
    'CLAUDE.md': '# My project\n\nKeep this.\n',
    '.claude/settings.json': JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }] },
      statusLine: { type: 'command', command: 'my-status.sh' },
    }),
  });
  ok(install(p));
  assert.equal(json(p, '.harness/config.json').verify, 'go test ./...');
  const cfg = json(p, '.harness/config.json');
  fs.writeFileSync(p.path('.harness/config.json'), JSON.stringify({ ...cfg, verify: 'make check' }));
  ok(install(p));
  assert.equal(json(p, '.harness/config.json').verify, 'make check', 'config preserved');
  const settings = json(p, '.claude/settings.json');
  assert.equal(gwHandlers(settings, 'PreToolUse').length, 1, 'no duplicate hooks');
  assert.ok(settings.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command === 'my-guard.sh')), 'user hook kept');
  assert.equal(settings.statusLine.command, 'my-status.sh', 'user statusline kept');
  const claude = p.read('CLAUDE.md');
  assert.match(claude, /Keep this\./);
  assert.equal(claude.match(/^@\.harness\/RULES\.md$/gm).length, 1);
  assert.equal(p.read('AGENTS.md').match(/<!-- gewu:rules -->/g).length, 1);
});

test('detects common stacks', () => {
  const cases = [
    [{ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'pnpm-lock.yaml': '' }, 'pnpm test'],
    [{ 'pyproject.toml': '[project]\nname="x"\n' }, 'pytest -q'],
    [{ 'Cargo.toml': '[package]\n' }, 'cargo test'],
    [{ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }, null],
    [{ 'README.md': 'nothing to detect' }, null],
  ];
  for (const [files, verify] of cases) {
    const p = repo(files);
    ok(install(p));
    assert.equal(json(p, '.harness/config.json').verify, verify, JSON.stringify(files));
  }
});

test('refuses a directory that is not a git repository', () => {
  const p = new Project(tmpdir());
  const r = install(p);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /git/);
});

test('uninstall restores the project exactly, keeping only your work records', () => {
  const p = repo({
    'CLAUDE.md': '# My project\n\nKeep this.\n',
    'AGENTS.md': '# Agents\n\nOur conventions.\n',
    '.cursor/hooks.json': JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './fmt.sh' }] } }, null, 2) + '\n',
    '.codex/config.toml': 'model = "x"\n',
    '.gitignore': 'dist/\n',
    '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-stop.sh' }] }] }, permissions: { allow: ['Bash(make *)'] } }, null, 2) + '\n',
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
  });
  p.git('add', '-A');
  p.git('commit', '-qm', 'before');
  ok(install(p));
  ok(p.gw('new', 'some work'));
  ok(install(p, '--uninstall'));
  assert.equal(p.git('status', '--porcelain', '--untracked-files=all').trim().split('\n').filter((l) => !l.includes('docs/work/')).join('\n'), '');
  assert.ok(p.exists(`docs/work`), 'work records are kept');
});

test('uninstall removes files the installer created but keeps ones you changed', () => {
  const p = repo();
  ok(install(p));
  p.write('REVIEW.md', p.read('REVIEW.md') + '\nOur extra rule.\n');
  const r = install(p, '--uninstall');
  ok(r);
  assert.equal(p.exists('CLAUDE.md'), false, 'installer-created CLAUDE.md removed');
  assert.equal(p.exists('AGENTS.md'), false, 'installer-created AGENTS.md removed');
  for (const dir of ['.claude', '.codex', '.cursor', '.agents']) assert.equal(p.exists(dir), false, dir);
  assert.equal(p.exists('.harness'), false);
  assert.ok(p.exists('REVIEW.md'), 'customized REVIEW.md kept');
  assert.match(r.out, /REVIEW\.md/);
});

test('upgrading from an older Gewu removes its obsolete files but nothing of yours', () => {
  const p = repo({
    '.harness/quality.mjs': 'old module\n',
    '.harness/design-system/catalog.json': '{}\n',
    '.harness/WORKFLOW.md': 'old rules\n',
    '.claude/skills/gw-design/SKILL.md': 'old skill\n',
    '.claude/agents/gw-design-critic.md': 'old agent\n',
    '.agents/skills/gewu/SKILL.md': 'old codex entry\n',
    'AGENTS.md': '# Team rules\n\n<!-- gewu:workflow -->\nold block\n<!-- /gewu:workflow -->\n',
    '.claude/skills/my-skill/SKILL.md': 'mine\n',
    '.claude/settings.json': JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.harness/gw.mjs" hook user-prompt' }] }] } }),
  });
  ok(install(p, '--hosts', 'claude'));
  for (const gone of ['.harness/quality.mjs', '.harness/design-system', '.harness/WORKFLOW.md', '.claude/skills/gw-design', '.claude/agents/gw-design-critic.md', '.agents']) {
    assert.equal(p.exists(gone), false, gone);
  }
  assert.ok(p.exists('.claude/skills/my-skill/SKILL.md'), 'your skill kept');
  assert.equal(p.read('AGENTS.md'), '# Team rules\n');
  assert.equal(json(p, '.claude/settings.json').hooks.UserPromptSubmit, undefined);
});

test('doctor reports a healthy install', () => {
  const p = project();
  const r = p.gw('doctor');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /✗/);
});
