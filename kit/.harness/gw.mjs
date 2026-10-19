#!/usr/bin/env node
// gw — Gewu Harness · 格物致知. Verification first: red before green.
//
// One zero-dependency file: the CLI that drives red → green cycles and the Claude Code
// hook handlers that enforce them. Local state lives in .harness/state.json (ignored);
// evidence lives in <workDir>/<work>/evidence.jsonl (committed, append-only).
//
// Proofs are computed, never claimed: gw runs the checks itself and compares git tree
// snapshots to know exactly what changed between start, red, green and done.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const GW = '.harness/gw';
const STATE = '.harness/state.json';
const CONFIG = '.harness/config.json';
const TMP = '.harness/tmp';
const MIN_CLAUDE = [2, 1, 295];

const DEFAULTS = {
  verify: null,
  language: 'en',
  workDir: 'docs/work',
  enforce: 'strict', // strict | warn | off
  gates: 'warn', // strict | warn | off
  commit: true,
  timeoutSec: 900,
  replaySetup: null,
  postEdit: null,
  testGlobs: [
    '**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/e2e/**', '**/__snapshots__/**',
    '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*-test.*', '**/test_*.py', '**/*_spec.rb',
    '**/*Test.*', '**/*Tests.*', '**/tests.rs',
  ],
  freeGlobs: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc', 'docs/**', 'LICENSE*', '.gitignore', '.gitattributes', '.editorconfig'],
  guardGlobs: ['REVIEW.md'],
};

// The harness's own files are always guardrails; config.guardGlobs can only add to them.
const OWNED_GUARDS = [
  '.harness/**', '.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.cursor/hooks.json',
  '.claude/skills/gw-*/**', '.agents/skills/gw-*/**', '.claude/agents/gw-*', '.github/workflows/gw-*',
];

const REQUIRED_DOCS = { feature: ['intent', 'spec', 'plan'], bug: ['intent'], incident: ['intent'], quick: [] };
const APPROVED = { intent: 'accepted', spec: 'approved', plan: 'approved' };
const APPROVAL_KEYS = ['status', 'approved_by', 'approved_at', 'approved_sha'];

const PHASE = {
  idle: { label: 'IDLE', about: 'no cycle in progress', color: 90, glyph: '○', locked: ['test', 'source'] },
  test: { label: 'TEST', about: 'write a check that fails', color: 35, glyph: '✎', locked: ['source'] },
  impl: { label: 'RED', about: 'red proven, make it pass', color: 31, glyph: '●', locked: ['test'] },
  refactor: { label: 'GREEN', about: 'green proven, refactor if needed', color: 32, glyph: '●', locked: ['test'] },
  chore: { label: 'CHORE', about: 'non-behavioral change', color: 34, glyph: '◌', locked: [] },
};

const NEXT = {
  idle: (s) => (s.work
    ? `start the next cycle: ${GW} start <R#> "<behavior>" --check "<targeted test command>" --expect "<predicted failure>"`
    : `begin with ${GW} new "<title>", or go straight to ${GW} start <R#> "<behavior>"`),
  test: () => `write a check that fails for the reason you predict, then ${GW} red`,
  impl: () => `write the smallest change that passes (tests are frozen 🔒), then ${GW} green`,
  refactor: () => `refactor while green if useful, then ${GW} done`,
  chore: () => `finish the non-behavioral change, then ${GW} done (runs the full suite)`,
};

const LOCKED_BECAUSE = {
  idle: (rel) => `⛔ Verification first: no red → green cycle is open, so ${rel} is locked.
Start one: ${GW} start <R#> "<behavior>", write a failing test, then ${GW} red.
For a non-behavioral change (rename, formatting, dependency bump): ${GW} chore "<reason>" (asks the user).`,
  test: (rel) => `⛔ Red before green: in TEST only checks can be written. ${rel} unlocks after ${GW} red proves the new test fails.`,
  impl: (rel) => `⛔ Tests are frozen since red 🔒 (${rel}). Change the code, not the test.
If the test itself is wrong: ${GW} reopen "<why>". It is recorded, and red must be proven again.`,
  refactor: (rel) => `⛔ Tests stay frozen while refactoring 🔒 (${rel}). Run ${GW} done first, then open a new cycle to change tests.`,
};

const STOP_BECAUSE = {
  test: `You changed files in TEST but have not proven red. Run ${GW} red, or say why you are stopping.`,
  impl: `Changes since red are unverified. Run ${GW} green, or say what is blocking you before stopping.`,
  refactor: `Refactoring changes are unverified. Run ${GW} done to close the cycle.`,
  chore: `Chore changes are unverified. Run ${GW} done (it runs the full suite).`,
};

// Failures that look like crashes rather than assertions. Legitimate for a symbol that does
// not exist yet, but only when predicted: the agent must confirm it with --expect.
const CRASH = /SyntaxError|ReferenceError|Cannot find module|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|ImportError|error TS\d+|error\[E\d+\]|cannot find symbol|undefined: \w+|Segmentation fault|panic:/;

// ───────────────────────────── utilities ─────────────────────────────

class GwError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new GwError(code, message); };

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const say = (...lines) => console.log(lines.join('\n'));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  try { cur = fs.realpathSync(cur); } catch { /* keep as is */ }
  return path.join(cur, ...rest);
}

function findRoot(start) {
  let dir = realish(start);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function toRel(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function loadConfig(root) {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(root, CONFIG), 'utf8')) };
  } catch (e) {
    return fail('E_CONFIG', `${CONFIG} cannot be read: ${e.message}`);
  }
}

function loadState(root) {
  const empty = { phase: 'idle', work: null, cycle: null, chore: null };
  try { return { ...empty, ...JSON.parse(fs.readFileSync(path.join(root, STATE), 'utf8')) }; } catch { return empty; }
}

function saveState(root, state) {
  fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(root, STATE), JSON.stringify(state, null, 2) + '\n');
}

function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function matches(rel, globs) {
  const base = rel.split('/').pop();
  return globs.some((g) => globRe(g).test(g.includes('/') ? rel : base));
}

const isEvidence = (rel, cfg) => rel.startsWith(cfg.workDir + '/') && /\/evidence\.(jsonl|md)$/.test(rel);

// protected > guard > test > free > source
function classify(rel, cfg) {
  if (rel === STATE || rel.startsWith(TMP + '/') || isEvidence(rel, cfg)) return 'protected';
  if (matches(rel, OWNED_GUARDS) || matches(rel, cfg.guardGlobs)) return 'guard';
  if (matches(rel, cfg.testGlobs)) return 'test';
  if (matches(rel, cfg.freeGlobs)) return 'free';
  return 'source';
}

function categorize(paths, cfg) {
  const out = { test: [], source: [], free: [], guard: [] };
  for (const p of paths) {
    const cat = classify(p, cfg);
    if (cat !== 'protected') out[cat].push(p);
  }
  return out;
}

function gitRun(root, args, opts = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
}

function git(root, args, opts) {
  const r = gitRun(root, args, opts);
  if (r.code !== 0) fail('E_GIT', `git ${args.join(' ')} failed: ${r.err.trim()}`);
  return r.out;
}

const isGitRepo = (root) => gitRun(root, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true';

// Snapshot the whole working tree (tracked + untracked, minus ignored files and gw's own
// bookkeeping) as a git tree object, without touching the real index.
function snapshot(root, cfg) {
  if (!isGitRepo(root)) fail('E_NOT_GIT', 'gw needs a git repository: the evidence lives in git. Run git init first.');
  const index = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim());
  fs.mkdirSync(path.join(root, TMP), { recursive: true });
  const tmp = path.join(root, TMP, `index-${process.pid}-${Date.now()}`);
  try {
    if (fs.existsSync(index)) {
      fs.copyFileSync(index, tmp);
      // Keep the index's own timestamp: git re-reads entries as new as the index ("racy"
      // entries), and a fresher copy would make a same-second, same-size edit look unchanged.
      const { atime, mtime } = fs.statSync(index);
      fs.utimesSync(tmp, atime, mtime);
    }
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    git(root, ['add', '-A', '--', '.'], { env });
    git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', STATE, TMP, `:(glob)${cfg.workDir}/*/evidence.*`], { env });
    return git(root, ['write-tree'], { env }).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function changed(root, a, b) {
  if (!a || !b || a === b) return [];
  return git(root, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', a, b]).split('\0').filter(Boolean);
}

function runCheck(cwd, cfg, cmd, env = {}) {
  const t0 = Date.now();
  const r = spawnSync('/bin/sh', ['-c', `{ ${cmd}\n} 2>&1`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: cfg.timeoutSec * 1000,
    env: { ...process.env, CI: process.env.CI ?? '1', NO_COLOR: '1', FORCE_COLOR: '0', ...env },
  });
  return { cmd, exit: r.status ?? 1, ms: Date.now() - t0, out: (r.stdout || '') + (r.stderr || ''), timedOut: r.error?.code === 'ETIMEDOUT' };
}

function tail(text, n = 30) {
  const t = text.trimEnd().split('\n').slice(-n).join('\n');
  return t.length > 4000 ? t.slice(-4000) : t;
}

function printRun(res, n = 25) {
  say(paint(90, `$ ${res.cmd}   → exit ${res.exit} · ${(res.ms / 1000).toFixed(1)}s`));
  if (res.out.trim()) say(paint(90, tail(res.out, n)));
}

function verifyCmd(cfg) {
  return cfg.verify || fail('E_NO_VERIFY', `No verification command yet. Set "verify" in ${CONFIG} (for example "npm test").`);
}

const checkCmd = (cfg, cycle) => cycle?.check || verifyCmd(cfg);

// A run that timed out or could not start proves nothing: it is neither red nor green.
function refuse(res, condition, code, message) {
  if (res.timedOut) fail('E_TIMEOUT', `The check timed out after ${Math.round(res.ms / 1000)}s. A timeout is neither red nor green.`);
  if (res.exit === 126 || res.exit === 127) fail('E_BROKEN_CHECK', `The check could not run (exit ${res.exit}: command not found or not executable). A check that cannot run is never red or green.`);
  if (condition) fail(code, message);
}

// Commit exactly these paths. Returns the new sha, or null when there was nothing to commit.
function commitPaths(root, paths, message) {
  const tracked = new Set(git(root, ['ls-files', '-z']).split('\0'));
  const list = [...new Set(paths)].filter((p) => tracked.has(p) || fs.existsSync(path.join(root, p)));
  if (!list.length) return null;
  const add = gitRun(root, ['add', '-A', '--', ...list]);
  if (add.code !== 0) fail('E_COMMIT', `git add failed: ${add.err.trim()}`);
  if (gitRun(root, ['diff', '--cached', '--quiet', '--', ...list]).code === 0) return null;
  const c = gitRun(root, ['commit', '-q', '-m', message, '--', ...list]);
  if (c.code !== 0) {
    gitRun(root, ['reset', '-q', '--', ...list]);
    fail('E_COMMIT', `The commit "${message}" failed, so the evidence would be lost:\n${(c.out + c.err).trim()}\nFix the cause (often a pre-commit hook), or set "commit": false in ${CONFIG} to keep evidence local only.`);
  }
  return git(root, ['rev-parse', 'HEAD']).trim();
}

function cleanHead(root) {
  if (gitRun(root, ['status', '--porcelain', '--untracked-files=no']).out.trim()) return null;
  return gitRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).out.trim() || null;
}

const author = (root) => gitRun(root, ['config', 'user.name']).out.trim() || process.env.USER || 'unknown';

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slugify(title) {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'work';
}

// ───────────────────────────── frontmatter & approvals ─────────────────────────────

function fmGet(text, key) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const line = m?.[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  return line ? line[1].replace(/\s+#.*$/, '').trim() : null;
}

function fmSet(text, fields) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${text}`;
  let body = m[1];
  for (const [k, v] of Object.entries(fields)) {
    const re = new RegExp(`^${k}:.*$`, 'm');
    body = re.test(body) ? body.replace(re, `${k}: ${v}`) : `${body}\n${k}: ${v}`;
  }
  return `---\n${body}\n---` + text.slice(m[0].length);
}

// What a human approves: the document without its approval bookkeeping.
function contentSha(text) {
  return sha256(text.replace(/^---\n([\s\S]*?)\n---/, (_, fm) => `---\n${fm.split('\n').filter((l) => !APPROVAL_KEYS.some((k) => l.startsWith(`${k}:`))).join('\n')}\n---`));
}

// ───────────────────────────── work items & ledger ─────────────────────────────

const workDir = (root, cfg, work) => path.join(root, cfg.workDir, work);
const ledgerFile = (root, cfg, work) => path.join(workDir(root, cfg, work), 'evidence.jsonl');
const docFile = (root, cfg, work, doc) => path.join(workDir(root, cfg, work), `${doc}.md`);

function readDoc(root, cfg, work, doc) {
  const f = docFile(root, cfg, work, doc);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

function workType(root, cfg, work) {
  const intent = work && readDoc(root, cfg, work, 'intent');
  return (intent && fmGet(intent, 'type')) || 'feature';
}

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function append(root, cfg, work, ev) {
  const file = ledgerFile(root, cfg, work);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...ev }) + '\n');
}

function template(root, cfg, doc) {
  for (const lang of [cfg.language, 'en']) {
    const file = path.join(root, '.harness/templates', lang, `${doc}.md`);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  return '---\nid: {{id}}\ntitle: {{title}}\ntype: {{type}}\nstatus: draft\nauthor: {{author}}\ncreated: {{date}}\n---\n# {{title}}\n';
}

function newWork(root, cfg, title, type) {
  const base = `${today()}-${slugify(title)}`;
  let id = base;
  for (let n = 2; fs.existsSync(workDir(root, cfg, id)); n++) id = `${base}-${n}`;
  fs.mkdirSync(workDir(root, cfg, id), { recursive: true });
  const vars = { id, title, type, author: author(root), date: today() };
  fs.writeFileSync(docFile(root, cfg, id, 'intent'), template(root, cfg, 'intent').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ''));
  return id;
}

function ensureWork(ctx, title) {
  if (ctx.state.work && fs.existsSync(workDir(ctx.root, ctx.cfg, ctx.state.work))) return;
  ctx.state.work = newWork(ctx.root, ctx.cfg, title, 'quick');
  say(paint(90, `Created quick work item ${ctx.cfg.workDir}/${ctx.state.work}/ (fill in its intent later with the gw-intent skill).`));
}

function gateProblems(root, cfg, work) {
  return (REQUIRED_DOCS[workType(root, cfg, work)] ?? REQUIRED_DOCS.feature).flatMap((doc) => {
    const text = readDoc(root, cfg, work, doc);
    if (!text) return [`${doc}.md does not exist`];
    const status = fmGet(text, 'status');
    if (status !== APPROVED[doc]) return [`${doc}.md is ${status ?? 'unknown'} (needs ${APPROVED[doc]})`];
    if (fmGet(text, 'approved_sha') !== contentSha(text)) return [`${doc}.md changed after approval`];
    return [];
  });
}

function filesUnder(root, dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const abs = path.join(dir, d.name);
    return d.isDirectory() ? filesUnder(root, abs) : [toRel(root, abs)];
  });
}

const commitPrefix = (root, cfg, work) => (['bug', 'incident'].includes(workType(root, cfg, work)) ? 'fix' : 'feat');

// ───────────────────────────── evidence ─────────────────────────────

// Rebuild cycles from the ledger. Each event is only legal from one phase; anything else
// means the story was edited, and the cycle is marked broken.
function replayLedger(events) {
  const cycles = new Map();
  const chores = new Map();
  const approvals = [];
  const STEP = { red: [['test'], 'impl'], reopen: [['impl', 'refactor'], 'test'], green: [['impl'], 'refactor'], done: [['refactor'], 'closed'] };
  for (const e of events) {
    if (e.ev === 'start') cycles.set(e.cycle, { id: e.cycle, req: e.req, behavior: e.behavior, check: e.check, expect: e.expect, state: 'test', reds: [], reopens: [], green: null, done: null });
    else if (e.ev === 'chore') chores.set(e.chore, { id: e.chore, reason: e.reason, state: 'open', done: null });
    else if (e.ev === 'chore-done') Object.assign(chores.get(e.chore) ?? {}, { state: 'closed', done: e });
    else if (e.ev === 'approve') approvals.push(e);
    else if (e.ev === 'abort') {
      const x = cycles.get(e.cycle) ?? chores.get(e.chore);
      if (x) Object.assign(x, { state: 'aborted', abortReason: e.reason });
    } else if (STEP[e.ev] && cycles.has(e.cycle)) {
      const c = cycles.get(e.cycle);
      const [from, to] = STEP[e.ev];
      if (!from.includes(c.state)) c.broken ??= `${e.ev} after ${PHASE[c.state]?.label ?? c.state} is out of order`;
      c.state = to;
      if (e.ev === 'red') c.reds.push(e);
      if (e.ev === 'reopen') { c.reopens.push(e); c.green = null; }
      if (e.ev === 'green') c.green = e;
      if (e.ev === 'done') c.done = e;
    }
  }
  return { cycles: [...cycles.values()], chores: [...chores.values()], approvals };
}

function renderEvidence(root, cfg, work) {
  const { cycles, chores, approvals } = replayLedger(readLedger(ledgerFile(root, cfg, work)));
  const sha = (s) => (s ? `\`${s.slice(0, 7)}\`` : '—');
  const count = (t) => (t ? Object.entries(t).filter(([, v]) => v.length).map(([k, v]) => `${v.length} ${k}`).join(' · ') : '—');
  const redCell = (r) => (r ? `exit ${r.exit} · ${r.matched ? `matched “${r.expect}”` : 'failed'}${r.adopted ? ' · adopted' : ''} · ${sha(r.commit)}` : '—');
  const state = { closed: '✅ done', aborted: '⏹ aborted', test: '✎ writing check', impl: '🔴 red', refactor: '🟢 green' };
  const L = [
    `# Evidence · ${work}`,
    '',
    '> Generated by `.harness/gw`; do not edit. Every behavior change below was first observed failing, then observed passing, with its tests frozen in between.',
    '',
    '| Cycle | Req | Behavior | 🔴 Red | 🟢 Green | Reopened | Changes | State |',
    '|---|---|---|---|---|---|---|---|',
    ...cycles.map((c) => `| ${c.id} | ${c.req} | ${c.behavior} | ${redCell(c.reds.at(-1))} | ${c.green ? `✓${c.green.full ? ' · full suite ✓' : ''}` : '—'} | ${c.reopens.length} | ${count(c.done?.touched)} | ${state[c.state] ?? c.state} |`),
    '',
  ];
  for (const c of cycles) {
    const r = c.reds.at(-1);
    L.push(`## ${c.id} · ${c.req} · ${c.behavior}`, '');
    L.push(`- Check: \`${c.check ?? cfg.verify}\`${c.expect ? ` · predicted failure: “${c.expect}”` : ''}`);
    if (r) {
      L.push(`- 🔴 Red: ${r.t} · exit ${r.exit} · ${(r.ms / 1000).toFixed(1)}s · commit ${sha(r.commit)}`);
      L.push(`- 🔒 Frozen tests: ${r.tests.map((t) => `\`${t}\``).join(', ')}${r.adopted ? ' (adopted: this test was already failing)' : ''}`);
      L.push('', '<details><summary>Red output (tail)</summary>', '', '```text', r.tail, '```', '', '</details>', '');
    }
    for (const o of c.reopens) L.push(`- ↩ Reopened: ${o.t} · ${o.reason}`);
    if (c.green) L.push(`- 🟢 Green: ${c.green.t} · \`${c.green.cmd}\` exit 0${c.green.full ? ` · full suite \`${c.green.full.cmd}\` exit ${c.green.full.exit}` : ''}`);
    if (c.done) L.push(`- Changes: ${Object.entries(c.done.touched).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.map((x) => `\`${x}\``).join(', ')}`).join('; ')}`);
    if (c.abortReason) L.push(`- ⏹ Aborted: ${c.abortReason}`);
    L.push('');
  }
  if (chores.length) {
    L.push('## Chores (non-behavioral)', '', '| Id | Reason | Changes | State |', '|---|---|---|---|');
    for (const k of chores) L.push(`| ${k.id} | ${k.reason} | ${count(k.done?.touched)} | ${k.state === 'closed' ? '✅ full suite green' : k.state} |`);
    L.push('');
  }
  if (approvals.length) {
    L.push('## Human gates', '');
    for (const a of approvals) L.push(`- ${a.t} · ${a.doc} → ${APPROVED[a.doc]} · ${a.by} · content ${a.sha.slice(0, 12)}`);
    L.push('');
  }
  fs.writeFileSync(path.join(workDir(root, cfg, work), 'evidence.md'), L.join('\n'));
}

// Append a closing event, render evidence and commit them with the change. If the commit
// fails the ledger is restored, so the record never claims a commit that does not exist.
function closeWith(ctx, ev, paths, message) {
  const { root, cfg, state } = ctx;
  const file = ledgerFile(root, cfg, state.work);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  append(root, cfg, state.work, ev);
  renderEvidence(root, cfg, state.work);
  try {
    return cfg.commit ? commitPaths(root, [...paths, ...filesUnder(root, workDir(root, cfg, state.work))], message) : null;
  } catch (e) {
    fs.writeFileSync(file, before);
    renderEvidence(root, cfg, state.work);
    throw e;
  }
}

// ───────────────────────────── commands ─────────────────────────────

function needPhase(ctx, allowed) {
  if (allowed.includes(ctx.state.phase)) return;
  const P = PHASE[ctx.state.phase];
  fail('E_PHASE', `The phase is ${P.label} (${P.about}); this command needs ${allowed.map((a) => PHASE[a].label).join(' / ')}.\nNext: ${NEXT[ctx.state.phase](ctx.state)}`);
}

function header(state, extra = '') {
  const P = PHASE[state.phase];
  const c = state.cycle;
  const what = c ? `  ${c.id} · ${c.req} · ${c.behavior}` : state.chore ? `  ${state.chore.id} · ${state.chore.reason}` : '';
  return `${paint(P.color, `${P.glyph} ${P.label}`)}${what}${extra}`;
}

function assertUntampered(ctx, tree) {
  const tampered = categorize(changed(ctx.root, ctx.state.cycle.redTree, tree), ctx.cfg).test;
  if (tampered.length) {
    fail('E_TAMPER', `Tests changed after red:\n  - ${tampered.join('\n  - ')}\nChange the code, not the test. If the test really is wrong: ${GW} reopen "<why>" (recorded; red must be proven again).`);
  }
}

function adoptable(ctx, list, tree) {
  const { root, cfg, state } = ctx;
  const files = String(list).split(',').map((f) => f.trim()).filter(Boolean);
  const edited = new Set(changed(root, state.cycle.startTree, tree));
  for (const f of files) {
    if (!fs.existsSync(path.join(root, f)) || classify(f, cfg) !== 'test') fail('E_USAGE', `--adopt only takes existing test files: ${f}`);
    if (edited.has(f)) fail('E_USAGE', `${f} changed during this cycle, so it is a new check, not an adopted one. Run ${GW} red without --adopt.`);
  }
  if (!state.cycle.expect) fail('E_USAGE', 'Adopting a failing test needs a prediction: pass --expect "<its failure message>" so the red is tied to this test.');
  return files;
}

const commands = {
  new(ctx, { pos, opt }) {
    needPhase(ctx, ['idle']);
    const title = pos.join(' ').trim() || fail('E_USAGE', `Usage: ${GW} new "<title>" [--type feature|bug|incident|quick]`);
    const type = opt.type || 'feature';
    if (!REQUIRED_DOCS[type]) fail('E_USAGE', `Unknown type ${type}: use ${Object.keys(REQUIRED_DOCS).join(' / ')}`);
    ctx.state.work = newWork(ctx.root, ctx.cfg, title, type);
    saveState(ctx.root, ctx.state);
    say(`Created ${ctx.cfg.workDir}/${ctx.state.work}/intent.md (${type}, status: draft).`,
      `Next: complete the intent (gw-intent skill), then ask the user to approve it by running: ${GW} approve intent`);
  },

  use(ctx, { pos }) {
    needPhase(ctx, ['idle']);
    const id = pos[0] || fail('E_USAGE', `Usage: ${GW} use <work-id>`);
    if (!fs.existsSync(workDir(ctx.root, ctx.cfg, id))) fail('E_NO_WORK', `No work item ${ctx.cfg.workDir}/${id}`);
    ctx.state.work = id;
    saveState(ctx.root, ctx.state);
    say(`Active work item: ${id}`);
  },

  start(ctx, { pos, opt }) {
    const [req, ...words] = pos;
    const behavior = words.join(' ').trim();
    if (!req || !behavior) fail('E_USAGE', `Usage: ${GW} start <R#> "<behavior>" [--check "<targeted test command>"] [--expect "<predicted failure>"]`);
    needPhase(ctx, ['idle']);
    const { root, cfg, state } = ctx;
    const gaps = state.work && cfg.gates !== 'off' && fs.existsSync(workDir(root, cfg, state.work)) ? gateProblems(root, cfg, state.work) : [];
    if (gaps.length && cfg.gates === 'strict') fail('E_GATE', `Human gate not passed:\n  - ${gaps.join('\n  - ')}\nShow the document to the user; they approve it by running: ${GW} approve <intent|spec|plan>`);
    let baseline = null;
    if (!opt.check) {
      // Without a targeted check, red is judged on the full suite, so it must start green.
      const res = runCheck(root, cfg, verifyCmd(cfg));
      refuse(res, res.exit !== 0, 'E_BASELINE_RED', `The full suite is already red before this cycle (exit ${res.exit}):\n${tail(res.out, 15)}\nAn old failure cannot prove a new behavior. Pass --check "<command that runs only your new test>", or fix the existing failure first.`);
      baseline = { cmd: res.cmd, exit: res.exit, ms: res.ms };
    }
    ensureWork(ctx, behavior);
    if (gaps.length) say(paint(33, `⚠ Gate reminder: ${gaps.join('; ')}`));
    const n = readLedger(ledgerFile(root, cfg, state.work)).filter((e) => e.ev === 'start').length + 1;
    const cycle = { id: `C${n}`, req, behavior, check: opt.check || null, expect: opt.expect || null, startTree: snapshot(root, cfg) };
    append(root, cfg, state.work, { ev: 'start', cycle: cycle.id, req, behavior, check: cycle.check, expect: cycle.expect, baseline });
    Object.assign(state, { phase: 'test', cycle, verifiedTree: cycle.startTree });
    saveState(root, state);
    say(header(state), `Next: ${NEXT.test()}`);
  },

  red(ctx, { opt }) {
    needPhase(ctx, ['test']);
    const { root, cfg, state } = ctx;
    const c = state.cycle;
    if (opt.expect) c.expect = opt.expect;
    const tree = snapshot(root, cfg);
    const adopted = opt.adopt ? adoptable(ctx, opt.adopt, tree) : null;
    const tests = adopted ?? categorize(changed(root, c.startTree, tree), cfg).test;
    if (!tests.length) {
      fail('E_NO_TEST_CHANGE', `No test file was added or changed in this cycle. Red must come from a new check: write the test first.
If an existing failing test already describes this behavior, adopt it explicitly: ${GW} red --adopt <test file> --expect "<its failure>"`);
    }
    const cmd = checkCmd(cfg, c);
    const res = runCheck(root, cfg, cmd);
    state.verifiedTree = tree;
    saveState(root, state);
    printRun(res);
    refuse(res, res.exit === 0, 'E_NOT_RED', 'The check passed, so this is not red. The new test does not catch the missing behavior: strengthen the assertion, or confirm the behavior already exists.');
    const matched = c.expect ? res.out.includes(c.expect) : null;
    refuse(res, c.expect && !matched, 'E_WRONG_REASON', `It failed, but not as predicted: the output does not contain “${c.expect}”. Find out why before going on; correct the test, or the prediction with ${GW} red --expect "<new prediction>".`);
    refuse(res, !c.expect && CRASH.test(res.out), 'E_WRONG_REASON', `This looks like a crash or compile error, not a failed assertion. If that is the failure you predicted (for example, the function does not exist yet), confirm it: ${GW} red --expect "<the error text>".`);
    const sha = !cfg.commit ? null : adopted ? cleanHead(root) : commitPaths(root, tests, `test(${c.req}): ${c.behavior} [red]`);
    append(root, cfg, state.work, { ev: 'red', cycle: c.id, cmd, exit: res.exit, ms: res.ms, tree, tests, adopted: !!adopted, expect: c.expect, matched, commit: sha, tail: tail(res.out) });
    Object.assign(c, { redTree: tree, redCommit: sha });
    state.phase = 'impl';
    saveState(root, state);
    say(header(state, `  ${paint(31, `red proven (exit ${res.exit})`)}${sha ? paint(90, ` · commit ${sha.slice(0, 7)}`) : ''}`),
      `🔒 Frozen: ${tests.join(', ')}`, `Next: ${NEXT.impl()}`);
  },

  green(ctx) {
    needPhase(ctx, ['impl']);
    const { root, cfg, state } = ctx;
    const c = state.cycle;
    const tree = snapshot(root, cfg);
    assertUntampered(ctx, tree);
    const cmd = checkCmd(cfg, c);
    const res = runCheck(root, cfg, cmd);
    state.verifiedTree = tree;
    saveState(root, state);
    printRun(res, res.exit === 0 ? 8 : 25);
    refuse(res, res.exit !== 0, 'E_NOT_GREEN', 'Still red. Change the code, not the test.');
    let full = null;
    if (cfg.verify && cmd !== cfg.verify) {
      full = runCheck(root, cfg, cfg.verify);
      printRun(full, full.exit === 0 ? 5 : 25);
      refuse(full, full.exit !== 0, 'E_REGRESSION', 'The targeted check passes, but the full suite fails: this change broke something else.');
    }
    append(root, cfg, state.work, { ev: 'green', cycle: c.id, cmd, exit: 0, ms: res.ms, tree, full: full && { cmd: full.cmd, exit: full.exit, ms: full.ms } });
    c.greenTree = tree;
    state.phase = 'refactor';
    saveState(root, state);
    say(header(state, `  ${paint(32, 'green proven ✓')}`), `Next: ${NEXT.refactor()}`);
  },

  done(ctx) {
    needPhase(ctx, ['refactor', 'chore']);
    const { root, cfg, state } = ctx;
    const isChore = state.phase === 'chore';
    const c = state.cycle;
    const tree = snapshot(root, cfg);
    if (!isChore) assertUntampered(ctx, tree);
    if (isChore || tree !== c.greenTree) {
      const res = runCheck(root, cfg, cfg.verify ?? checkCmd(cfg, c));
      state.verifiedTree = tree;
      saveState(root, state);
      printRun(res, 8);
      refuse(res, res.exit !== 0, 'E_NOT_GREEN', isChore ? 'The full suite fails after this chore: it changed behavior or broke something.' : 'The suite fails after refactoring. Undo or fix the refactor to stay green.');
    }
    const touched = categorize(changed(root, isChore ? state.chore.startTree : c.startTree, tree), cfg);
    const paths = Object.values(touched).flat();
    const sha = isChore
      ? closeWith(ctx, { ev: 'chore-done', chore: state.chore.id, reason: state.chore.reason, tree, touched }, paths, `chore: ${state.chore.reason}`)
      : closeWith(ctx, { ev: 'done', cycle: c.id, tree, touched }, paths, `${commitPrefix(root, cfg, state.work)}(${c.req}): ${c.behavior} [green]`);
    const what = isChore ? `${state.chore.id} ${state.chore.reason}` : `${c.id} ${c.req} · ${c.behavior}`;
    Object.assign(state, { phase: 'idle', cycle: null, chore: null, verifiedTree: tree });
    saveState(root, state);
    say(`${paint(32, `✅ ${what}`)}${sha ? paint(90, ` · commit ${sha.slice(0, 7)}`) : ''}`,
      `Evidence: ${cfg.workDir}/${state.work}/evidence.md`, `Next: ${NEXT.idle(state)}`);
  },

  reopen(ctx, { pos }) {
    needPhase(ctx, ['impl', 'refactor']);
    const reason = pos.join(' ').trim() || fail('E_USAGE', `Usage: ${GW} reopen "<why the test must change>"`);
    const { root, cfg, state } = ctx;
    append(root, cfg, state.work, { ev: 'reopen', cycle: state.cycle.id, reason });
    Object.assign(state.cycle, { redTree: null, redCommit: null, greenTree: null });
    state.phase = 'test';
    saveState(root, state);
    say(header(state, paint(90, '  ↩ reopened (recorded)')), `Next: fix the test, then prove red again: ${GW} red`);
  },

  abort(ctx, { pos }) {
    needPhase(ctx, ['test', 'impl', 'refactor', 'chore']);
    const reason = pos.join(' ').trim() || fail('E_USAGE', `Usage: ${GW} abort "<why>"`);
    const { root, cfg, state } = ctx;
    append(root, cfg, state.work, state.chore ? { ev: 'abort', chore: state.chore.id, reason } : { ev: 'abort', cycle: state.cycle.id, reason });
    Object.assign(state, { phase: 'idle', cycle: null, chore: null });
    saveState(root, state);
    say(`⏹ Aborted (recorded): ${reason}`, 'Files are left as they are; unverified changes will show up in gw audit.');
  },

  chore(ctx, { pos }) {
    needPhase(ctx, ['idle']);
    const reason = pos.join(' ').trim() || fail('E_USAGE', `Usage: ${GW} chore "<why this changes no behavior>"`);
    ensureWork(ctx, reason);
    const { root, cfg, state } = ctx;
    const n = readLedger(ledgerFile(root, cfg, state.work)).filter((e) => e.ev === 'chore').length + 1;
    state.chore = { id: `K${n}`, reason, startTree: snapshot(root, cfg) };
    append(root, cfg, state.work, { ev: 'chore', chore: state.chore.id, reason });
    Object.assign(state, { phase: 'chore', verifiedTree: state.chore.startTree });
    saveState(root, state);
    say(header(state), 'All files are unlocked. A chore must not change behavior; review checks it line by line.', `Next: ${NEXT.chore()}`);
  },

  check(ctx) {
    const { root, cfg, state } = ctx;
    const tree = snapshot(root, cfg);
    const res = runCheck(root, cfg, verifyCmd(cfg));
    state.verifiedTree = tree;
    saveState(root, state);
    printRun(res);
    refuse(res, res.exit !== 0, 'E_NOT_GREEN', 'The full suite fails.');
    say(paint(32, '✓ full suite green'));
  },

  approve(ctx, { pos, opt }) {
    const doc = pos[0];
    if (!APPROVED[doc]) fail('E_USAGE', `Usage: ${GW} approve <intent|spec|plan> [--work <id>]`);
    const { root, cfg, state } = ctx;
    const work = opt.work || state.work || fail('E_NO_WORK', 'No active work item.');
    const file = docFile(root, cfg, work, doc);
    if (!fs.existsSync(file)) fail('E_NO_DOC', `${toRel(root, file)} does not exist.`);
    const by = author(root);
    const text = fmSet(fs.readFileSync(file, 'utf8'), { status: APPROVED[doc], approved_by: by, approved_at: new Date().toISOString() });
    const sha = contentSha(text);
    fs.writeFileSync(file, fmSet(text, { approved_sha: sha }));
    append(root, cfg, work, { ev: 'approve', doc, by, sha });
    say(`✅ ${doc} → ${APPROVED[doc]} by ${by} (content ${sha.slice(0, 12)}; any later edit needs approval again)`);
  },

  status(ctx, { opt }) {
    const s = statusOf(ctx);
    if (opt.json) return say(JSON.stringify(s, null, 2));
    const docs = Object.entries(s.docs).map(([d, st]) => `${d} ${st === APPROVED[d] ? '✓' : st ? '✎' : '·'}${st ? ` ${st}` : ''}`).join(' · ');
    const P = PHASE[s.phase];
    say(paint(90, 'gw · verification first · red before green'),
      `Work   ${s.work ?? '—'}${s.work ? `  (${s.type} · ${docs})` : ''}`,
      `Phase  ${header(ctx.state)}`,
      `       ${P.about}${P.locked.length ? `  🔒 ${P.locked.join(' + ')}` : ''}`,
      `Next   ${s.next}`);
  },

  evidence(ctx, { pos }) {
    const work = pos[0] || ctx.state.work || fail('E_NO_WORK', 'No active work item.');
    renderEvidence(ctx.root, ctx.cfg, work);
    say(`${ctx.cfg.workDir}/${work}/evidence.md`);
  },

  audit: (ctx, { opt }) => audit(ctx, opt),
  doctor: (ctx, { opt }) => doctor(ctx, opt),

  help() {
    say(`gw — Gewu Harness · verification first, red before green

Cycle   start <R#> "<behavior>" [--check <cmd>] [--expect <text>]   open a cycle → TEST
        red [--expect <text>] [--adopt <test files>]   prove the new check fails → tests frozen → RED
        green                    prove it passes (targeted + full suite) → GREEN
        done                     re-verify after refactoring, commit → IDLE
        reopen "<why>"           the test was wrong: back to TEST (recorded)
        abort "<why>"            abandon the cycle (recorded)
        chore "<why>"            non-behavioral change (asks the user); done runs the full suite
Work    new "<title>" [--type feature|bug|incident|quick] · use <id> · approve <intent|spec|plan>
Inspect status [--json] · evidence [id] · check · audit [--base <ref>] [--replay] · doctor [--run]`);
  },
};

function statusOf({ root, cfg, state }) {
  const docs = {};
  for (const d of Object.keys(APPROVED)) {
    const text = state.work && readDoc(root, cfg, state.work, d);
    docs[d] = text ? fmGet(text, 'status') : null;
  }
  const c = state.cycle;
  return {
    root,
    phase: state.phase,
    label: PHASE[state.phase].label,
    locked: PHASE[state.phase].locked,
    work: state.work,
    type: state.work ? workType(root, cfg, state.work) : null,
    docs,
    cycle: c ? { id: c.id, req: c.req, behavior: c.behavior, check: c.check, expect: c.expect } : null,
    chore: state.chore ? { id: state.chore.id, reason: state.chore.reason } : null,
    next: NEXT[state.phase](state),
  };
}

// ───────────────────────────── audit (CI gate) ─────────────────────────────

function cycleIssue(c) {
  if (c.broken) return c.broken;
  if (c.state === 'aborted') return null;
  if (c.state !== 'closed') return `cycle not closed (stopped in ${PHASE[c.state]?.label ?? c.state})`;
  const red = c.reds.at(-1);
  if (!red || red.exit === 0 || !red.tests?.length) return 'no proven red before done';
  if (!c.green || c.green.exit !== 0 || (c.green.full && c.green.full.exit !== 0)) return 'no passing green';
  if (c.green.t < red.t) return 'green is older than red';
  return null;
}

function audit(ctx, opt) {
  const { root, cfg, state } = ctx;
  const problems = [];
  const notes = [];
  if (state.phase !== 'idle') problems.push(`a ${state.chore ? `chore ${state.chore.id}` : `cycle ${state.cycle?.id}`} is still open locally (${PHASE[state.phase].label})`);

  let branchFiles = null;
  if (opt.base) {
    if (gitRun(root, ['rev-parse', '--verify', '--quiet', opt.base]).code !== 0) fail('E_USAGE', `Unknown base ${opt.base}`);
    branchFiles = git(root, ['diff', '--name-only', '-z', `${opt.base}...HEAD`]).split('\0').filter(Boolean);
  }
  const base = path.join(root, cfg.workDir);
  let ledgers = fs.existsSync(base) ? fs.readdirSync(base).map((d) => path.join(base, d, 'evidence.jsonl')).filter((f) => fs.existsSync(f)) : [];
  if (branchFiles) ledgers = ledgers.filter((f) => branchFiles.includes(toRel(root, f)));

  const covered = new Set();
  const closed = [];
  for (const file of ledgers) {
    const rel = toRel(root, file);
    const { cycles, chores } = replayLedger(readLedger(file));
    for (const c of cycles) {
      const issue = cycleIssue(c);
      if (issue) problems.push(`${rel} · ${c.id} ${c.req}: ${issue}`);
      else if (c.state === 'closed') {
        closed.push(c);
        notes.push(`✓ ${c.id} ${c.req} ${c.behavior}: red (exit ${c.reds.at(-1).exit}) → green${c.reopens.length ? ` · reopened ${c.reopens.length}×` : ''}`);
        for (const p of Object.values(c.done.touched).flat()) covered.add(p);
      }
    }
    for (const k of chores) {
      if (k.state === 'open') problems.push(`${rel} · chore ${k.id} is not closed`);
      if (k.state === 'closed') {
        notes.push(`◌ ${k.id} chore: ${k.reason}`);
        for (const p of Object.values(k.done.touched).flat()) covered.add(p);
      }
    }
  }

  if (branchFiles) {
    const cats = categorize(branchFiles, cfg);
    for (const f of [...cats.source, ...cats.test]) if (!covered.has(f)) problems.push(`${f}: changed on this branch, but no cycle or chore verified it`);
    if (cats.guard.length) notes.push(`🛡 Guardrail files changed (review them closely): ${cats.guard.join(', ')}`);
  }

  if (opt.replay) replayReds(ctx, closed, problems, notes);

  say(paint(90, 'gw audit · verification first · red before green'), `Scope: ${ledgers.length} evidence ledger(s)${opt.base ? ` changed since ${opt.base}` : ''}`);
  if (notes.length) say(...notes);
  if (problems.length) {
    say(paint(31, `✗ ${problems.length} problem(s):`), ...problems.map((p) => `  - ${p}`));
    process.exitCode = 1;
  } else say(paint(32, '✓ audit passed'));
}

// Replay in a detached worktree: the user's checkout is never switched, and files that are not
// in git (like node_modules) are absent there, so their setup must be declared, not assumed.
// replaySetup sees $GW_ROOT, the checkout, so it can reuse caches instead of rebuilding them.
function inWorktree(root, cfg, ref, fn) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-replay-'));
  const dir = path.join(parent, 'tree');
  try {
    const add = gitRun(root, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '--detach', dir, ref]);
    if (add.code !== 0) return { error: `cannot check out ${ref.slice(0, 7)}: ${add.err.trim()}` };
    if (cfg.replaySetup) {
      const setup = runCheck(dir, cfg, cfg.replaySetup, { GW_ROOT: root });
      if (setup.exit !== 0 || setup.timedOut) return { error: `replaySetup failed (exit ${setup.exit}): ${tail(setup.out, 5)}` };
    }
    return fn(dir);
  } finally {
    gitRun(root, ['worktree', 'remove', '--force', dir]);
    gitRun(root, ['worktree', 'prune']);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function replayReds(ctx, closed, problems, notes) {
  const { root, cfg } = ctx;
  const deps = ['node_modules', '.venv', 'venv'].filter((d) => fs.existsSync(path.join(root, d)));
  if (deps.length && !cfg.replaySetup) {
    problems.push(`replay: ${deps.join(', ')} is not in git, so replay worktrees would lack it and a missing dependency could pose as red. Set "replaySetup" in ${CONFIG} (for example "npm ci").`);
    return;
  }
  for (const c of closed) {
    const red = c.reds.at(-1);
    if (!red.commit) { notes.push(`· ${c.id}: no red commit (commit disabled), replay skipped`); continue; }
    const r = inWorktree(root, cfg, red.commit, (dir) => runCheck(dir, cfg, red.cmd));
    if (r.error) { problems.push(`replay ✗ ${c.id}: ${r.error}`); continue; }
    const honest = !r.timedOut && ![0, 126, 127].includes(r.exit) && (!red.expect || r.out.includes(red.expect));
    if (honest) notes.push(`replay ✓ ${c.id}: re-ran at red commit ${red.commit.slice(0, 7)}, and it really fails (exit ${r.exit})`);
    else problems.push(`replay ✗ ${c.id}: at the claimed red commit ${red.commit.slice(0, 7)} the check does not fail as recorded (exit ${r.exit})`);
  }
  if (!cfg.verify) return;
  const head = inWorktree(root, cfg, 'HEAD', (dir) => runCheck(dir, cfg, cfg.verify));
  if (head.error) problems.push(`replay ✗ HEAD: ${head.error}`);
  else if (head.exit === 0) notes.push('replay ✓ HEAD: full suite green');
  else problems.push(`replay ✗ HEAD: full suite fails (exit ${head.exit})`);
}

// ───────────────────────────── doctor ─────────────────────────────

function atLeast(version, min) {
  for (let i = 0; i < min.length; i++) if (version[i] !== min[i]) return version[i] > min[i];
  return true;
}

function claudeVersion() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 });
  const m = (r.stdout || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

function doctor({ root, cfg }, opt) {
  const read = (rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : '');
  const has = (rel) => fs.existsSync(path.join(root, rel));
  const wired = (file, events) => {
    let s = {};
    try { s = JSON.parse(read(file) || '{}'); } catch { /* reported as not wired */ }
    return events.every((ev) => (s.hooks?.[ev] ?? []).some((g) => (g.hooks ?? [g]).some((h) => h.command?.includes('.harness/gw.mjs'))));
  };
  const hosts = cfg.hosts ?? ['claude'];
  const checks = [
    [`Node ≥ 18 (found ${process.versions.node})`, Number(process.versions.node.split('.')[0]) >= 18],
    ['git repository', isGitRepo(root)],
    [`verify = ${cfg.verify ?? 'not set'}`, !!cfg.verify, `set "verify" in ${CONFIG}`],
    ...(hosts.includes('claude') ? [
      ['Claude Code hooks wired (.claude/settings.json)', wired('.claude/settings.json', ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart']), 'reinstall the harness'],
      ['CLAUDE.md imports @.harness/RULES.md', /^@\.harness\/RULES\.md$/m.test(read('CLAUDE.md')), 'add the line @.harness/RULES.md to CLAUDE.md'],
      ['skills in .claude/skills', has('.claude/skills/gw-next/SKILL.md')],
    ] : []),
    ...(hosts.includes('codex') ? [['Codex hooks wired (.codex/hooks.json; trust them once with /hooks in Codex)', wired('.codex/hooks.json', ['PreToolUse', 'Stop', 'SessionStart']), 'reinstall the harness']] : []),
    ...(hosts.includes('cursor') ? [['Cursor hooks wired (.cursor/hooks.json)', wired('.cursor/hooks.json', ['preToolUse', 'beforeShellExecution', 'stop', 'sessionStart']), 'reinstall the harness']] : []),
    ...(hosts.some((h) => h !== 'claude') ? [
      ['AGENTS.md carries the rulebook', read('AGENTS.md').includes('<!-- gewu:rules -->'), 'reinstall the harness'],
      ['skills in .agents/skills', has('.agents/skills/gw-next/SKILL.md')],
    ] : []),
    ['.gitignore ignores .harness/state.json', /^\.harness\/state\.json$/m.test(read('.gitignore'))],
    ['review policy REVIEW.md', has('REVIEW.md')],
  ];
  if (opt.run && cfg.verify) {
    const res = runCheck(root, cfg, cfg.verify);
    checks.push([`verify runs and passes (exit ${res.exit})`, res.exit === 0]);
  }
  for (const [label, okay, hint] of checks) say(`${okay ? paint(32, '✓') : paint(31, '✗')} ${label}${!okay && hint ? paint(90, `  → ${hint}`) : ''}`);
  if (hosts.includes('claude')) {
    const v = claudeVersion();
    const recent = v && atLeast(v, MIN_CLAUDE);
    if (!v) say(`${paint(33, '!')} Claude Code not found on PATH (its hooks need ${MIN_CLAUDE.join('.')} or later)`);
    else say(`${recent ? paint(32, '✓') : paint(33, '!')} Claude Code ${v.join('.')}${recent ? '' : paint(90, `  → update to ${MIN_CLAUDE.join('.')}+ so failing guards block instead of passing silently`)}`);
  }
  if (checks.some(([, okay]) => !okay)) process.exitCode = 1;
}

// ───────────────────────────── hooks ─────────────────────────────

// One decision procedure, three wire formats. Claude Code and Codex share a protocol (Codex cannot
// pause to ask the user); Cursor answers with a permission object.

const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'target_file', 'filePath'];
const TEXT_KEYS = ['content', 'contents', 'new_string', 'code_edit', 'text'];
const DELIVERY = [['git', 'push'], ['gh', 'pr', 'create'], ['gh', 'pr', 'merge'], ['gh', 'release', 'create'], ['npm', 'publish']];
const NEEDS_USER = '\nThis agent cannot pause to ask, so the action is blocked: stop and ask the user to do it themselves.';

// hard deny > deny > ask > a warn-mode note, so no combination can soften a hard denial.
const rank = (v) => (!v ? 0 : v.warn ? 1 : v.decision === 'ask' ? 2 : v.hard ? 4 : 3);
const strongest = (a, b) => (rank(b) > rank(a) ? b : a);

function editVerdict(cat, state, rel) {
  if (cat === 'protected') return { decision: 'deny', hard: true, reason: `⛔ ${rel} is maintained by gw (state / evidence) and cannot be edited by hand. Use ${GW} commands.` };
  if (cat === 'guard') return { decision: 'ask', reason: `🛡 ${rel} is a guardrail file (harness config, hooks, skills or review policy). Changing it needs the user's confirmation.` };
  if (cat === 'free') return null;
  return PHASE[state.phase].locked.includes(cat) ? { decision: 'deny', reason: LOCKED_BECAUSE[state.phase](rel) } : null;
}

const gateDenied = (rel) => {
  const doc = path.basename(rel, '.md');
  return { decision: 'deny', hard: true, reason: `⛔ Human gate: you cannot mark ${rel} as approved. Show it to the user; they approve it by running ${GW} approve ${doc} (in Claude Code: ! ${GW} approve ${doc}).` };
};

const isGateFlip = (cfg, rel, text) => rel.startsWith(cfg.workDir + '/') && /\/(intent|spec|plan)\.md$/.test(rel)
  && /^\s*(status:\s*(accepted|approved)\b|approved_(sha|by|at):)/m.test(text);

// Codex patches name their files in the patch text, whether sent as apply_patch or through the shell.
function parsePatch(patch) {
  const files = [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) => m[1].trim());
  return { files, text: patch.split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n') };
}

// Reduce any host's tool call to the files it writes (with their new text) or a shell command.
function toolCall(input) {
  const ti = input.tool_input ?? {};
  if (input.hook_event_name === 'beforeShellExecution') return { command: input.command ?? '' };
  if (['Bash', 'Shell'].includes(input.tool_name)) return { command: ti.command ?? '' };
  if (input.tool_name === 'apply_patch') return parsePatch(String(ti.command ?? ''));
  if (input.tool_name === 'MultiEdit') return { files: [ti.file_path], text: (ti.edits ?? []).map((e) => e.new_string ?? '').join('\n') };
  const file = PATH_KEYS.map((k) => ti[k]).find(Boolean);
  return { files: file ? [file] : [], text: TEXT_KEYS.map((k) => ti[k]).filter((v) => typeof v === 'string').join('\n') };
}

// The project's enforce mode: off lets everything through, warn turns soft denials into notes.
function enforced(cfg, verdict) {
  if (!verdict || cfg.enforce === 'off') return null;
  if (cfg.enforce === 'warn' && verdict.decision === 'deny' && !verdict.hard && !verdict.warn) return { ...verdict, warn: true, reason: `⚠ [gw warn mode] ${verdict.reason}` };
  return verdict;
}

// A small shell lexer: enough to find write targets in everyday commands.
// Best effort by design; the tree-snapshot tamper check is the real backstop.
function lex(cmd) {
  const segs = [[]];
  const heredocs = [];
  let cur = null;
  const push = () => { if (cur !== null) { segs.at(-1).push({ v: cur }); cur = null; } };
  const split = () => { push(); if (segs.at(-1).length) segs.push([]); };
  for (let i = 0; i < cmd.length;) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      cur = (cur ?? '') + cmd.slice(i + 1, j < 0 ? cmd.length : j);
      i = j < 0 ? cmd.length : j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < cmd.length) { buf += cmd[j + 1]; j += 2; } else buf += cmd[j++];
      }
      cur = (cur ?? '') + buf;
      i = j + 1;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur = (cur ?? '') + cmd[i + 1];
      i += 2;
    } else if (c === ' ' || c === '\t') {
      push();
      i++;
    } else if (c === '&' && cmd[i + 1] === '>') {
      push();
      segs.at(-1).push({ op: '>' });
      i += cmd[i + 2] === '>' ? 3 : 2;
    } else if (c === '\n' && heredocs.length) {
      // Heredoc bodies are content up to their delimiter line, never commands.
      split();
      let pos = i + 1;
      for (const h of heredocs.splice(0)) {
        while (pos < cmd.length) {
          const end = cmd.indexOf('\n', pos);
          const line = cmd.slice(pos, end < 0 ? cmd.length : end);
          pos = end < 0 ? cmd.length : end + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        }
      }
      i = pos;
    } else if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      push();
      let j = i + 2;
      const strip = cmd[j] === '-';
      if (strip) j++;
      while (cmd[j] === ' ' || cmd[j] === '\t') j++;
      const m = cmd.slice(j).match(/^(['"]?)([^\s'";|&<>()]+)\1/);
      if (m) heredocs.push({ delim: m[2], strip });
      i = j + (m ? m[0].length : 0);
    } else if ('\n;|&()'.includes(c)) {
      split();
      i += (c === '|' || c === '&') && cmd[i + 1] === c ? 2 : 1;
    } else if (c === '>' || c === '<') {
      if (cur !== null && /^\d+$/.test(cur)) cur = null; else push();
      i++;
      if (cmd[i] === c) i++;
      if (c === '>' && cmd[i] === '&') { // 2>&1: fd duplication, not a file
        i++;
        while (i < cmd.length && /[\d-]/.test(cmd[i])) i++;
        continue;
      }
      if (cmd[i] === '|') i++;
      segs.at(-1).push({ op: c });
    } else {
      cur = (cur ?? '') + c;
      i++;
    }
  }
  push();
  return segs.filter((s) => s.length);
}

const WRAPPERS = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'xargs', 'exec']);

function words(seg) {
  const w = [];
  for (let i = 0; i < seg.length; i++) {
    if (seg[i].op) { i++; continue; }
    w.push(seg[i].v);
  }
  while (w.length && (/^\w+=/.test(w[0]) || WRAPPERS.has(w[0]))) w.shift();
  return w;
}

function writeTargets(seg, cwd) {
  const targets = [];
  for (let i = 0; i < seg.length; i++) if (seg[i].op === '>' && seg[i + 1]?.v !== undefined) targets.push(seg[i + 1].v);
  const [prog, ...args] = words(seg);
  if (!prog) return targets;
  const name = path.basename(prog);
  const plain = args.filter((a) => a && !a.startsWith('-'));
  const scriptArgs = () => { // sed/perl: drop the inline script unless it is given via -e
    const out = [];
    let sawE = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-e' || args[i] === '--expression') { sawE = true; i++; continue; }
      if (args[i] && !args[i].startsWith('-')) out.push(args[i]);
    }
    return sawE ? out : out.slice(1);
  };
  if (['rm', 'unlink', 'truncate', 'touch', 'chmod', 'chown', 'shred', 'mv', 'rmdir', 'tee'].includes(name)) targets.push(...plain);
  else if (['cp', 'install', 'ln', 'rsync'].includes(name)) targets.push(...plain.slice(-1));
  else if (name === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) targets.push(...scriptArgs());
  else if (name === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a))) targets.push(...scriptArgs());
  else if (name === 'dd') targets.push(...args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
  else if (name === 'git' && ['checkout', 'restore', 'rm', 'mv', 'clean'].includes(plain[0])) {
    targets.push(...plain.slice(1).filter((p) => fs.existsSync(path.resolve(cwd, p))));
  }
  return targets;
}

function gwSubcommand(w) {
  if (path.basename(w[0] ?? '') === 'gw') return w[1];
  if (path.basename(w[0] ?? '') === 'node' && path.basename(w[1] ?? '') === 'gw.mjs') return w[2];
  return null;
}

function judgeFiles(files, text, cwd) {
  let verdict = null;
  for (const file of files) {
    const abs = realish(path.resolve(cwd, file));
    const root = findRoot(path.dirname(abs));
    const rel = root && toRel(root, abs);
    if (!rel) continue;
    const cfg = loadConfig(root);
    const cat = classify(rel, cfg);
    verdict = strongest(verdict, enforced(cfg, cat !== 'protected' && isGateFlip(cfg, rel, text) ? gateDenied(rel) : editVerdict(cat, loadState(root), rel)));
  }
  return verdict;
}

function judgeShell(command, cwd) {
  const root = findRoot(cwd);
  if (!root) return null;
  const cfg = loadConfig(root);
  const state = loadState(root);
  let verdict = null;
  if (command.includes('*** Begin Patch')) {
    const { files, text } = parsePatch(command);
    verdict = judgeFiles(files, text, cwd);
  }
  for (const seg of lex(command)) {
    const w = words(seg);
    const sub = gwSubcommand(w);
    if (sub === 'chore') verdict = strongest(verdict, { decision: 'ask', reason: '🛡 A chore lifts red-before-green for a non-behavioral change. The user confirms it.' });
    if (sub === 'approve') verdict = strongest(verdict, { decision: 'ask', reason: '🛡 Human gate: only the user approves intent, spec and plan.' });
    if (DELIVERY.some((d) => d.every((x, i) => w[i] === x))) verdict = strongest(verdict, { decision: 'ask', reason: "🛡 Push, PR, merge and release are the user's decision." });
    for (const t of writeTargets(seg, cwd)) {
      const rel = toRel(root, realish(path.resolve(cwd, t)));
      if (!rel) continue;
      const cat = classify(rel, cfg);
      const v = cat === 'guard'
        ? { decision: 'deny', hard: true, reason: `⛔ ${rel} is a guardrail file and cannot be rewritten from the shell. Use the Edit tool (your agent's file editor), which asks the user.` }
        : editVerdict(cat, state, rel);
      if (v) verdict = strongest(verdict, { ...v, reason: `${v.reason}\n(Shell write blocked. To only read the file, use your read or search tool.)` });
    }
  }
  return enforced(cfg, verdict);
}

function respond(host, event, verdict) {
  const canAsk = host === 'claude' || (host === 'cursor' && event === 'beforeShellExecution');
  const v = verdict?.decision === 'ask' && !canAsk ? { ...verdict, decision: 'deny', reason: verdict.reason + NEEDS_USER } : verdict;
  if (host === 'cursor') {
    if (!v || v.warn) return say(JSON.stringify(v ? { permission: 'allow', agent_message: v.reason } : { permission: 'allow' }));
    return say(JSON.stringify({ permission: v.decision, user_message: v.reason, agent_message: v.reason }));
  }
  if (!v) return;
  const out = v.warn ? { additionalContext: v.reason } : { permissionDecision: v.decision, permissionDecisionReason: v.reason };
  say(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }));
}

function hookPreTool(input, host) {
  const call = toolCall(input);
  const cwd = realish(input.cwd || input.workspace_roots?.[0] || process.cwd());
  respond(host, input.hook_event_name, call.command !== undefined ? judgeShell(call.command, cwd) : judgeFiles(call.files, call.text, cwd));
}

function hookPostTool(input) {
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!file) return;
  const abs = realish(path.resolve(input.cwd || process.cwd(), file));
  const root = findRoot(path.dirname(abs));
  if (!root) return;
  const cfg = loadConfig(root);
  const rel = toRel(root, abs);
  if (!cfg.postEdit || !rel || !['source', 'test'].includes(classify(rel, cfg))) return;
  const res = runCheck(root, { ...cfg, timeoutSec: 60 }, cfg.postEdit.replaceAll('{file}', `'${rel.replaceAll("'", "'\\''")}'`));
  if (res.exit !== 0) {
    say(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `postEdit (${res.cmd}) failed:\n${tail(res.out, 15)}` } }));
  }
}

function hookStop(input, host) {
  const reply = (reason) => {
    if (host === 'cursor') say(JSON.stringify(reason ? { followup_message: reason } : {}));
    else if (reason) say(JSON.stringify({ decision: 'block', reason }));
  };
  if (host === 'cursor' ? input.loop_count > 0 : input.stop_hook_active) return reply(null);
  const root = findRoot(input.cwd || input.workspace_roots?.[0] || process.cwd());
  const cfg = root && loadConfig(root);
  const state = root && loadState(root);
  if (!root || cfg.enforce === 'off' || state.phase === 'idle') return reply(null);
  let tree;
  try { tree = snapshot(root, cfg); } catch { return reply(null); }
  reply(tree === state.verifiedTree ? null : `[gw] ${STOP_BECAUSE[state.phase]}`);
}

function hookSessionStart(input, host) {
  const root = findRoot(input.cwd || input.workspace_roots?.[0] || process.cwd());
  if (!root) return;
  const s = statusOf({ root, cfg: loadConfig(root), state: loadState(root) });
  const P = PHASE[s.phase];
  const lines = [
    '[gw] This project uses Gewu Harness: verification first, red before green.',
    `Phase: ${P.glyph} ${P.label} (${P.about})${P.locked.length ? ` · 🔒 ${P.locked.join(' + ')}` : ''}`,
  ];
  if (s.work) lines.push(`Work item: ${s.work} (${s.type})`);
  if (s.cycle) lines.push(`Cycle: ${s.cycle.id} · ${s.cycle.req} · ${s.cycle.behavior}`);
  if (s.chore) lines.push(`Chore: ${s.chore.id} · ${s.chore.reason}`);
  lines.push(`Next: ${s.next}`, 'Rule: no behavior change without a check first observed failing. Tests freeze at red; change the code, not the test. See .harness/RULES.md.');
  say(host === 'cursor' ? JSON.stringify({ additional_context: lines.join('\n') }) : lines.join('\n'));
}

function hookStatusline(input) {
  const root = findRoot(input.workspace?.current_dir || input.cwd || process.cwd());
  if (!root) return;
  const state = loadState(root);
  const P = PHASE[state.phase];
  const c = state.cycle;
  const short = (s, n = 36) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const what = c ? ` ${c.id}·${c.req} ${short(c.behavior)}` : state.chore ? ` ${state.chore.id} ${short(state.chore.reason)}` : '';
  const lock = P.locked.length ? ` 🔒${P.locked.map((l) => (l === 'source' ? 'src' : l)).join('+')}` : '';
  process.stdout.write(`\x1b[${P.color}m${P.glyph} gw ${P.label}\x1b[0m${what}${lock}\x1b[90m │ ${state.work ?? 'no work item'}\x1b[0m\n`);
}

const HOOKS = { 'pre-tool': hookPreTool, 'post-tool': hookPostTool, stop: hookStop, 'session-start': hookSessionStart, statusline: hookStatusline };

// ───────────────────────────── main ─────────────────────────────

function parseArgs(argv) {
  const VALUED = new Set(['check', 'expect', 'type', 'base', 'work', 'adopt']);
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    opt[k] = v !== undefined ? v : VALUED.has(k) ? argv[++i] : true;
  }
  return { pos, opt };
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  const [name = 'status', ...rest] = process.argv.slice(2);
  if (name === 'hook') {
    const [event] = rest;
    const host = rest.includes('--host') ? rest[rest.indexOf('--host') + 1] : 'claude';
    const input = readStdin();
    try {
      HOOKS[event]?.(input, host);
    } catch (e) {
      // The edit guard fails closed: a broken guard must not wave edits through.
      // Every other hook fails open so a bug never traps the session.
      if (event === 'pre-tool') respond(host, input.hook_event_name, { decision: 'deny', hard: true, reason: `⛔ [gw] The edit guard failed: ${e.message}\nFix it (or set "enforce": "off" in ${CONFIG} yourself) before editing.` });
      else process.stderr.write(`[gw hook ${event}] ${e.message}\n`);
    }
    return;
  }
  const cmd = commands[name];
  if (!cmd || name === 'help') return commands.help();
  try {
    const root = findRoot(process.cwd()) || fail('E_NO_CONFIG', `Not a Gewu project (no ${CONFIG}). Run install.mjs from the harness first.`);
    cmd({ root, cfg: loadConfig(root), state: loadState(root) }, parseArgs(rest));
  } catch (e) {
    if (!(e instanceof GwError)) throw e;
    console.error(`${paint(31, '✗')} [${e.code}] ${e.message}`);
    process.exitCode = e.code === 'E_USAGE' ? 2 : 1;
  }
}

main();
