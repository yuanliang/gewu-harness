#!/usr/bin/env node
// Install, upgrade or remove Gewu Harness in a git repository.
//   node install.mjs [--language en|zh-CN] <project-dir>
//   node install.mjs --uninstall <project-dir>
// Idempotent. Harness-owned files are refreshed; files you own are merged, never overwritten;
// uninstall reverses exactly what install added and keeps your work records.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kit');
const SEEDED = new Set(['.harness/config.json', 'REVIEW.md', '.github/workflows/gw-audit.yml']);
const SETTINGS = '.claude/settings.json';
const IMPORT_BLOCK = '\n\n## Gewu Harness\n\n@.harness/CLAUDE.md\n';
const IGNORE_HEADER = '# Gewu Harness local state';
const IGNORES = ['.harness/state.json', '.harness/tmp/'];
const LANGUAGES = ['en', 'zh-CN'];
// Installed by earlier Gewu versions and no longer part of the core.
const OBSOLETE = [
  ...['approval', 'artifacts', 'conversation', 'delivery', 'design-systems', 'design', 'extensions', 'flow',
    'intent-language', 'project', 'quality', 'question', 'state-store', 'user-event', 'workflow'].map((m) => `.harness/${m}.mjs`),
  '.harness/WORKFLOW.md', '.harness/EXTENSIONS.md', '.harness/install-manifest.json', '.harness/design-system',
  '.harness/templates/intent.md', '.harness/templates/spec.md', '.harness/templates/plan.md',
  '.claude/skills/gw-design', '.claude/skills/gw-quality', '.claude/agents/gw-design-critic.md', '.agents/skills/gewu',
];
const AGENTS_BLOCK = /\n*<!-- gewu:workflow -->[\s\S]*?<!-- \/gewu:workflow -->\n*/;

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const langFlag = args.includes('--language') ? args[args.indexOf('--language') + 1] : null;
const target = path.resolve(args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--language')[0] || '.');

const log = (s) => console.log(s);
const abs = (rel) => path.join(target, rel);
const has = (rel) => fs.existsSync(abs(rel));
const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
const write = (rel, content) => {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content);
};
const remove = (rel) => fs.rmSync(abs(rel), { recursive: true, force: true });
const withNewline = (text) => (text.trimEnd() ? `${text.trimEnd()}\n` : '');

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function kitFiles(dir = KIT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? kitFiles(p) : [path.relative(KIT, p).split(path.sep).join('/')];
  });
}
const kitText = (rel) => fs.readFileSync(path.join(KIT, rel), 'utf8');

function detectVerify() {
  if (has('package.json')) {
    let script;
    try { script = JSON.parse(read('package.json')).scripts?.test; } catch { /* not JSON */ }
    if (script && !/no test specified/.test(script)) {
      if (has('pnpm-lock.yaml')) return 'pnpm test';
      if (has('yarn.lock')) return 'yarn test';
      if (has('bun.lockb') || has('bun.lock')) return 'bun run test';
      return 'npm test';
    }
  }
  if (['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'].some(has)) return has('uv.lock') ? 'uv run pytest -q' : 'pytest -q';
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('mix.exs')) return 'mix test';
  if (has('Gemfile')) return has('.rspec') || has('spec') ? 'bundle exec rspec' : 'bundle exec rake test';
  if (has('pom.xml')) return 'mvn -q test';
  if (has('build.gradle') || has('build.gradle.kts')) return has('gradlew') ? './gradlew test' : 'gradle test';
  if (has('Package.swift')) return 'swift test';
  if (has('Makefile') && /^test:/m.test(read('Makefile'))) return 'make test';
  return null;
}

function detectLanguage() {
  if (langFlag) {
    if (!LANGUAGES.includes(langFlag)) die(`--language must be one of ${LANGUAGES.join(', ')}`);
    return langFlag;
  }
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  return /^zh/i.test(locale) ? 'zh-CN' : 'en';
}

const createdClaude = () => `# ${path.basename(target)}\n\n@.harness/CLAUDE.md\n\n## Commands\n\n- Full suite: see "verify" in .harness/config.json\n\n## Recurring mistakes (add a correction when the same mistake happens twice)\n\n- \n`;
const isHarnessHook = (h) => typeof h?.command === 'string' && /\.harness\/(gw|vf)\.mjs/.test(h.command);

function withoutHarness(settings) {
  const out = { ...settings };
  if (out.hooks) {
    const hooks = {};
    for (const [event, groups] of Object.entries(out.hooks)) {
      const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isHarnessHook(h)) })).filter((g) => g.hooks.length);
      if (kept.length) hooks[event] = kept;
    }
    if (Object.keys(hooks).length) out.hooks = hooks; else delete out.hooks;
  }
  if (isHarnessHook(out.statusLine)) delete out.statusLine;
  return out;
}

function mergeSettings(existing, kit) {
  const out = withoutHarness(existing);
  out.hooks = { ...(out.hooks ?? {}) };
  for (const [event, groups] of Object.entries(kit.hooks)) out.hooks[event] = [...(out.hooks[event] ?? []), ...groups];
  out.statusLine ??= kit.statusLine;
  const union = (key) => [...new Set([...(existing.permissions?.[key] ?? []), ...kit.permissions[key]])];
  out.permissions = { ...(existing.permissions ?? {}), allow: union('allow'), ask: union('ask') };
  return out;
}

function unmergeSettings(existing, kit) {
  const out = withoutHarness(existing);
  if (out.permissions) {
    const permissions = { ...out.permissions };
    for (const key of ['allow', 'ask']) {
      if (!permissions[key]) continue;
      permissions[key] = permissions[key].filter((rule) => !kit.permissions[key].includes(rule));
      if (!permissions[key].length) delete permissions[key];
    }
    if (Object.keys(permissions).length) out.permissions = permissions; else delete out.permissions;
  }
  return out;
}

function readSettings() {
  if (!has(SETTINGS)) return {};
  try { return JSON.parse(read(SETTINGS)); } catch { return die(`${SETTINGS} is not valid JSON; fix it first.`); }
}

function removeEmptyDirs(...rels) {
  for (const rel of rels) {
    if (has(rel) && fs.statSync(abs(rel)).isDirectory() && !fs.readdirSync(abs(rel)).length) fs.rmdirSync(abs(rel));
  }
}

function pruneObsolete() {
  OBSOLETE.forEach(remove);
  if (has('AGENTS.md')) {
    const agents = withNewline(read('AGENTS.md').replace(AGENTS_BLOCK, '\n'));
    if (agents) write('AGENTS.md', agents); else remove('AGENTS.md');
  }
  removeEmptyDirs('.agents/skills', '.agents');
}

function install() {
  const language = detectLanguage();
  pruneObsolete();
  const seeded = [];
  for (const rel of kitFiles()) {
    if (rel === SETTINGS) write(rel, JSON.stringify(mergeSettings(readSettings(), JSON.parse(kitText(rel))), null, 2) + '\n');
    else if (!SEEDED.has(rel)) write(rel, kitText(rel));
    else if (!has(rel)) {
      seeded.push(rel);
      write(rel, rel === '.harness/config.json'
        ? JSON.stringify({ ...JSON.parse(kitText(rel)), verify: detectVerify(), language }, null, 2) + '\n'
        : kitText(rel));
    }
  }
  fs.chmodSync(abs('.harness/gw'), 0o755);
  fs.chmodSync(abs('.harness/gw.mjs'), 0o755);

  if (!has('CLAUDE.md')) write('CLAUDE.md', createdClaude());
  else if (!/^@\.harness\/CLAUDE\.md$/m.test(read('CLAUDE.md'))) write('CLAUDE.md', read('CLAUDE.md').trimEnd() + IMPORT_BLOCK);

  const ignore = has('.gitignore') ? read('.gitignore') : '';
  const missing = IGNORES.filter((line) => !ignore.split('\n').includes(line));
  if (missing.length) write('.gitignore', `${ignore.trimEnd()}${ignore.trim() ? '\n\n' : ''}${IGNORE_HEADER}\n${missing.join('\n')}\n`);

  const cfg = JSON.parse(read('.harness/config.json'));
  log(`✓ Gewu Harness installed in ${target}`);
  log(`  verify = ${cfg.verify ?? 'not detected: set "verify" in .harness/config.json'} · documents in ${cfg.language}`);
  if (seeded.length) log(`  created ${seeded.join(', ')}`);
  log('');
  log('Next:');
  log('  1. .harness/gw doctor --run');
  log('  2. Review and commit the installed files so your team and CI share the same guardrails.');
  log('  3. Restart Claude Code in the project and describe what you want, or type /gw-next.');
}

function uninstallHarness() {
  const kept = [];
  for (const rel of kitFiles()) {
    if (rel === SETTINGS) continue;
    if (SEEDED.has(rel) && rel !== '.harness/config.json' && has(rel) && read(rel) !== kitText(rel)) { kept.push(rel); continue; }
    remove(rel);
  }
  ['.harness/state.json', '.harness/tmp', '.harness/templates'].forEach(remove);
  pruneObsolete();

  if (has(SETTINGS)) {
    const settings = unmergeSettings(readSettings(), JSON.parse(kitText(SETTINGS)));
    if (Object.keys(settings).length) write(SETTINGS, JSON.stringify(settings, null, 2) + '\n'); else remove(SETTINGS);
  }

  if (has('CLAUDE.md')) {
    const claude = read('CLAUDE.md');
    if (claude === createdClaude()) remove('CLAUDE.md');
    else write('CLAUDE.md', withNewline(claude.replace(IMPORT_BLOCK, '\n').replace(/^@\.harness\/CLAUDE\.md\n?/m, '')));
  }

  if (has('.gitignore')) {
    const ignore = withNewline(read('.gitignore').split('\n').filter((l) => l !== IGNORE_HEADER && !IGNORES.includes(l)).join('\n'));
    if (ignore) write('.gitignore', ignore); else remove('.gitignore');
  }

  const dirs = new Set(kitFiles().flatMap((rel) => rel.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  removeEmptyDirs(...[...dirs].sort((a, b) => b.split('/').length - a.split('/').length));
  log(`✓ Gewu Harness removed from ${target}`);
  if (kept.length) log(`  kept because you changed them: ${kept.join(', ')}`);
  if (has('.harness')) log(`  .harness/ still holds files the harness did not install: ${fs.readdirSync(abs('.harness')).join(', ')}`);
  if (has('docs/work')) log('  kept your work records in docs/work/');
  log('  Restart Claude Code so the removed hooks stop loading.');
}

if (!fs.existsSync(target)) die(`No such directory: ${target}`);
const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: target, encoding: 'utf8' });
if (inside.stdout?.trim() !== 'true') die(`${target} is not a git repository. Gewu keeps its evidence in git: run git init first.`);
if (uninstall) uninstallHarness(); else install();
