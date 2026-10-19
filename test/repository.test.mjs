// Open-source readiness: what a stranger needs to legally use, understand and contribute to this repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, run, tmpdir } from './helpers.mjs';

const REPO = 'https://github.com/yuanliang/gewu-harness';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const pkg = () => JSON.parse(read('package.json'));
const tracked = () => run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT })
  .stdout.split('\0').filter(Boolean).filter((f) => exists(f));

test('the project is licensed, and package metadata agrees', () => {
  assert.ok(exists('LICENSE'), 'LICENSE');
  const license = read('LICENSE');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) \d{4} \S/);
  const p = pkg();
  assert.equal(p.license, 'MIT');
  assert.equal(p.repository?.url, `git+${REPO}.git`);
  assert.equal(p.homepage, `${REPO}#readme`);
  assert.equal(p.bugs?.url, `${REPO}/issues`);
  assert.ok(p.author, 'author');
  assert.ok(p.keywords?.length >= 3, 'keywords');
});

test('community health files are present', () => {
  for (const rel of [
    'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md',
    '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml',
  ]) assert.ok(exists(rel), rel);
});

test('newcomers learn requirements, status, adoption and removal before installing', () => {
  for (const rel of ['README.md', 'README.zh-CN.md']) {
    const readme = read(rel);
    for (const fact of [/macOS/, /Linux/, /WSL/, /Claude Code[^\n]*2\.1\.295/, /0\.x/, /git commit/, /install\.mjs --uninstall/, /Codex/, /Cursor/, /AGENTS\.md/, /--hosts/]) assert.match(readme, fact, `${rel}: ${fact}`);
  }
});

test('the core stays lean: one small runtime, a one-page rulebook, no dependencies', () => {
  const runtime = fs.readdirSync(path.join(ROOT, 'kit/.harness')).filter((f) => f.endsWith('.mjs'));
  const lines = runtime.reduce((n, f) => n + read(`kit/.harness/${f}`).split('\n').length, 0);
  assert.ok(lines <= 1600, `kit runtime is ${lines} lines`);
  assert.ok(read('kit/.harness/RULES.md').split('\n').length <= 60, 'agent rulebook fits on one page');
  const p = pkg();
  assert.equal(Object.keys({ ...p.dependencies, ...p.devDependencies }).length, 0);
});

test('questions, ownership and security each have a route', () => {
  assert.match(read('.github/CODEOWNERS'), /^\*\s+@yuanliang$/m);
  const config = read('.github/ISSUE_TEMPLATE/config.yml');
  assert.match(config, /discussions/);
  assert.match(config, /security\/advisories\/new/);
});

test('the changelog documents the current version', () => {
  assert.match(read('CHANGELOG.md'), new RegExp(`^## \\[${pkg().version.replaceAll('.', '\\.')}\\]`, 'm'));
});

test('the English landing page orients a newcomer and links the Chinese one', () => {
  const readme = read('README.md');
  const cjk = (readme.match(/[㐀-鿿]/g) ?? []).length;
  assert.ok(cjk / readme.length < 0.02, `README.md should be English (CJK ratio ${(cjk / readme.length).toFixed(3)})`);
  for (const heading of [/^## Quick start/m, /^## How it works/m, /^## License/m, /^## Contributing/m]) assert.match(readme, heading);
  assert.match(readme, /\]\(README\.zh-CN\.md\)/);
  assert.match(read('README.zh-CN.md'), /\]\(README\.md\)/);
});

test('every relative link in the docs resolves to a file in the repository', () => {
  const files = new Set(tracked());
  const dirs = new Set([...files].flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
  const broken = [];
  for (const md of [...files].filter((f) => f.endsWith('.md'))) {
    for (const [, target] of read(md).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(md), decodeURI(target.split('#')[0])));
      if (!files.has(rel) && !dirs.has(rel.replace(/\/$/, ''))) broken.push(`${md} → ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('nothing private or bulky is published', () => {
  const leaks = [];
  for (const f of tracked()) {
    const size = fs.statSync(path.join(ROOT, f)).size;
    if (size > 1024 * 1024) leaks.push(`${f}: ${size} bytes`);
    if (f.split('/').includes('.git')) leaks.push(`${f}: nested git data`);
    if (size < 2 * 1024 * 1024 && /\/Users\/yuanliang|\/private\/tmp\/claude-|@360\.cn/.test(fs.readFileSync(path.join(ROOT, f), 'latin1'))) {
      leaks.push(`${f}: personal path or address`);
    }
  }
  assert.deepEqual(leaks, []);
});

test('shell entry points survive any checkout', () => {
  assert.match(read('.gitattributes'), /^\* text=auto eol=lf$/m);
  assert.ok(fs.statSync(path.join(ROOT, 'kit/.harness/gw')).mode & 0o111, 'kit/.harness/gw is executable');
});

test('fixture projects are removed when the test process exits', () => {
  const probe = path.join(tmpdir('gw-probe-'), 'probe.mjs');
  fs.writeFileSync(probe, `import { tmpdir, project } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'test/helpers.mjs')).href)};
console.log('DIR=' + tmpdir());
console.log('DIR=' + project({ install: false }).dir);
`);
  const r = run(process.execPath, [probe]);
  const dirs = [...r.out.matchAll(/^DIR=(.+)$/gm)].map((m) => m[1]);
  assert.equal(dirs.length, 2, r.out);
  for (const dir of dirs) assert.equal(fs.existsSync(dir), false, `${dir} was left behind`);
});

test('tests create temporary directories only through the self-cleaning helper', () => {
  const direct = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.mjs') && f !== 'helpers.mjs')
    .filter((f) => /mkdtempSync\(/.test(read(`test/${f}`)));
  assert.deepEqual(direct, []);
});

test('npm scripts and CI only reference files that exist', () => {
  const commands = [...Object.values(pkg().scripts), ...read('.github/workflows/ci.yml').split('\n').filter((l) => /^\s*(-\s*)?run:/.test(l))];
  const missing = commands.flatMap((c) => [...c.matchAll(/\bnode\s+(?:--\S+\s+)*([\w./-]+\.m?js)\b/g)].map((m) => m[1]))
    .filter((file) => !file.includes('*') && !exists(file));
  assert.deepEqual(missing, []);
});

test('CI exercises the oldest Node version the package claims to support', () => {
  const min = pkg().engines.node.match(/>=\s*(\d+)/)[1];
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, new RegExp(`node: \\[${min}[,\\]]`), `CI matrix should start at Node ${min}`);
});
