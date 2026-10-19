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
const install = (p, ...args) => run(process.execPath, [INSTALL, ...args, p.dir], { env: { ...process.env, LANG: 'en_US.UTF-8' } });
const ok = (r) => assert.equal(r.code, 0, r.out);
const json = (p, rel) => JSON.parse(p.read(rel));
const gwHandlers = (settings, event) =>
  (settings.hooks?.[event] ?? []).flatMap((g) => g.hooks).filter((h) => h.command.includes('.harness/gw.mjs'));
const SKILLS = ['next', 'intent', 'spec', 'plan', 'build', 'fix', 'review', 'ship', 'incident'];

test('installs every layer of the harness', () => {
  const p = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
  ok(install(p));
  assert.equal(json(p, '.harness/config.json').verify, 'npm test');
  for (const rel of [
    '.harness/gw.mjs', '.harness/gw', '.harness/CLAUDE.md',
    ...['en', 'zh-CN'].flatMap((l) => ['intent', 'spec', 'plan'].map((d) => `.harness/templates/${l}/${d}.md`)),
    ...SKILLS.map((s) => `.claude/skills/gw-${s}/SKILL.md`),
    '.claude/agents/gw-reviewer.md', '.claude/agents/gw-test-author.md',
    'REVIEW.md', '.github/workflows/gw-audit.yml',
  ]) assert.ok(p.exists(rel), rel);
  assert.ok(fs.statSync(p.path('.harness/gw')).mode & 0o111, 'shim is executable');
  const settings = json(p, '.claude/settings.json');
  for (const ev of ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart']) assert.equal(gwHandlers(settings, ev).length, 1, ev);
  assert.match(settings.statusLine.command, /gw\.mjs/);
  assert.match(p.read('CLAUDE.md'), /^@\.harness\/CLAUDE\.md$/m);
  assert.match(p.read('.gitignore'), /^\.harness\/state\.json$/m);
});

test('document language follows the system locale unless chosen explicitly', () => {
  const zh = repo();
  ok(run(process.execPath, [INSTALL, zh.dir], { env: { ...process.env, LANG: 'zh_CN.UTF-8' } }));
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
  assert.equal(claude.match(/^@\.harness\/CLAUDE\.md$/gm).length, 1);
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
  assert.equal(p.exists('.claude'), false);
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
  ok(install(p));
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
