import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALL = path.join(ROOT, 'install.mjs');

// Fixtures run their own `node --test`; the outer runner's context would make it skip silently.
const { NODE_TEST_CONTEXT, ...cleanEnv } = process.env;

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: cleanEnv, ...opts });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  return { code: r.status, stdout, stderr, out: stdout + stderr };
}

// Every fixture lives under one per-process directory that is removed when the process exits,
// so test runs never accumulate projects in the system temp directory.
let scratch = null;
process.on('exit', () => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

export function tmpdir(prefix = 'gw-') {
  scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), 'gewu-test-'));
  return fs.mkdtempSync(path.join(scratch, prefix));
}

export function gitInit(dir) {
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Test Dev'],
    ['config', 'user.email', 'dev@example.com'],
    ['config', 'commit.gpgsign', 'false'],
  ]) run('git', args, { cwd: dir });
}

export const ADD_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.mjs';
test('add adds', () => assert.equal(add(1, 2), 3));
`;

// Fails on an assertion, not a crash: the module loads and mul is simply missing.
export const MUL_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/math.mjs';
test('mul multiplies', () => assert.equal(m.mul?.(2, 3), 6));
`;

// Fails by crashing: the named import does not exist yet.
export const MUL_CRASH_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mul } from '../src/math.mjs';
test('mul multiplies', () => assert.equal(mul(2, 3), 6));
`;

export const MUL_IMPL = `export const add = (a, b) => a + b;
export const mul = (a, b) => a * b;
`;

export class Project {
  constructor(dir) { this.dir = dir; }
  path(rel) { return path.join(this.dir, rel); }
  write(rel, content) {
    fs.mkdirSync(path.dirname(this.path(rel)), { recursive: true });
    fs.writeFileSync(this.path(rel), content);
  }
  read(rel) { return fs.readFileSync(this.path(rel), 'utf8'); }
  exists(rel) { return fs.existsSync(this.path(rel)); }
  git(...args) {
    const r = run('git', args, { cwd: this.dir });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.out}`);
    return r.stdout;
  }
  gw(...args) {
    return run(process.execPath, [this.path('.harness/gw.mjs'), ...args], { cwd: this.dir });
  }
  hook(event, input = {}) {
    const r = run(process.execPath, [this.path('.harness/gw.mjs'), 'hook', event], {
      cwd: this.dir,
      input: JSON.stringify({ cwd: this.dir, ...input }),
    });
    try { r.json = JSON.parse(r.stdout); } catch { r.json = null; }
    return r;
  }
  // PreToolUse decision: allow (no output) | deny | ask
  decide(tool_name, tool_input) {
    const r = this.hook('pre-tool', { hook_event_name: 'PreToolUse', tool_name, tool_input });
    const out = r.json?.hookSpecificOutput;
    return { decision: out?.permissionDecision ?? 'allow', reason: out?.permissionDecisionReason ?? '', context: out?.additionalContext ?? '', raw: r };
  }
  write_(rel) { return this.decide('Write', { file_path: this.path(rel), content: 'x' }); }
  bash(command) { return this.decide('Bash', { command }); }
  config(patch) {
    const file = this.path('.harness/config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...cfg, ...patch }, null, 2) + '\n');
  }
  state() {
    return this.exists('.harness/state.json') ? JSON.parse(this.read('.harness/state.json')) : { phase: 'idle' };
  }
  get work() { return this.state().work; }
  ledger(work = this.work) {
    const file = `docs/work/${work}/evidence.jsonl`;
    if (!this.exists(file)) return [];
    return this.read(file).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  subject(ref = 'HEAD') { return this.git('log', '-1', '--format=%s', ref).trim(); }
  filesIn(ref = 'HEAD') {
    return this.git('-c', 'core.quotepath=false', 'show', '--name-only', '--format=', ref).trim().split('\n').filter(Boolean);
  }
}

export function project({ install = true, config = {}, files = {} } = {}) {
  const p = new Project(tmpdir());
  gitInit(p.dir);
  p.write('src/math.mjs', 'export const add = (a, b) => a + b;\n');
  p.write('test/math.test.mjs', ADD_TEST);
  p.write('.gitignore', 'node_modules/\n');
  for (const [rel, content] of Object.entries(files)) p.write(rel, content);
  p.git('add', '-A');
  p.git('commit', '-qm', 'init');
  if (install) {
    const r = run(process.execPath, [INSTALL, p.dir]);
    if (r.code !== 0) throw new Error('install failed: ' + r.out);
    p.config({ verify: 'node --test', ...config });
    p.git('add', '-A');
    p.git('commit', '-qm', 'install gewu');
  }
  return p;
}

// Drive a full, honest red → green cycle for `mul`.
export function fullCycle(p, { req = 'R1', behavior = 'mul multiplies' } = {}) {
  const steps = [
    p.gw('start', req, behavior, '--check', 'node --test test/mul.test.mjs', '--expect', 'AssertionError'),
    (p.write('test/mul.test.mjs', MUL_TEST), p.gw('red')),
    (p.write('src/math.mjs', MUL_IMPL), p.gw('green')),
    p.gw('done'),
  ];
  for (const s of steps) if (s.code !== 0) throw new Error('cycle step failed: ' + s.out);
  return steps;
}
