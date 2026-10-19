#!/usr/bin/env node
// Install, upgrade or remove Gewu Harness in a git repository.
//   node install.mjs [--hosts claude,codex,cursor] [--language en|zh-CN] <project-dir>
//   node install.mjs --uninstall <project-dir>
// Idempotent. Harness-owned files are refreshed; files you own are merged, never overwritten;
// dropping an agent or uninstalling reverses exactly what was added and keeps your work records.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kit');
const HOSTS = ['claude', 'codex', 'cursor'];
const HOOK_CONFIG = { claude: '.claude/settings.json', codex: '.codex/hooks.json', cursor: '.cursor/hooks.json' };
const SKILL_DIR = { claude: '.claude/skills', agents: '.agents/skills' };
const SEEDED = ['REVIEW.md', '.github/workflows/gw-audit.yml'];
const CONFIG = '.harness/config.json';
const RULES = '.harness/RULES.md';
const IMPORT_BLOCK = '\n\n## Gewu Harness\n\n@.harness/RULES.md\n';
const RULES_BLOCK = /<!-- gewu:rules -->[\s\S]*?<!-- \/gewu:rules -->\n?/; // the block itself, for refreshing in place
const AGENTS_BLOCK = /\n*<!-- gewu:rules -->[\s\S]*?<!-- \/gewu:rules -->\n*/; // with its surrounding blank lines, for removal
const IGNORE_HEADER = '# Gewu Harness local state';
const IGNORES = ['.harness/state.json', '.harness/tmp/'];
const LANGUAGES = ['en', 'zh-CN'];
// Installed by earlier Gewu versions and no longer part of the core.
const OBSOLETE = [
  ...['approval', 'artifacts', 'conversation', 'delivery', 'design-systems', 'design', 'extensions', 'flow',
    'intent-language', 'project', 'quality', 'question', 'state-store', 'user-event', 'workflow'].map((m) => `.harness/${m}.mjs`),
  '.harness/CLAUDE.md', '.harness/WORKFLOW.md', '.harness/EXTENSIONS.md', '.harness/install-manifest.json', '.harness/design-system',
  '.harness/templates/intent.md', '.harness/templates/spec.md', '.harness/templates/plan.md',
  '.claude/skills/gw-design', '.claude/skills/gw-quality', '.claude/agents/gw-design-critic.md', '.agents/skills/gewu',
];
const OLD_AGENTS_BLOCK = /\n*<!-- gewu:workflow -->[\s\S]*?<!-- \/gewu:workflow -->\n*/;

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const uninstall = args.includes('--uninstall');
const target = path.resolve(args.filter((a, i) => !a.startsWith('--') && !['--language', '--hosts'].includes(args[i - 1]))[0] || '.');

const log = (s) => console.log(s);
const abs = (rel) => path.join(target, rel);
const has = (rel) => fs.existsSync(abs(rel));
const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
const touched = new Set(); // top-level paths written or removed, for the commit hint
const write = (rel, content) => {
  touched.add(rel.split('/')[0]);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content);
};
const remove = (rel) => {
  touched.add(rel.split('/')[0]);
  fs.rmSync(abs(rel), { recursive: true, force: true });
};
const tracked = (rel) => spawnSync('git', ['ls-files', '--', rel], { cwd: target, encoding: 'utf8' }).stdout.trim() !== '';
const withNewline = (text) => (text.trimEnd() ? `${text.trimEnd()}\n` : '');
const writeOrRemove = (rel, text) => (text ? write(rel, text) : remove(rel));

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function kitFiles(dir) {
  const root = path.join(KIT, dir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    return d.isDirectory() ? kitFiles(rel) : [rel];
  });
}
const kitText = (rel) => fs.readFileSync(path.join(KIT, rel), 'utf8');
const kitJSON = (rel) => JSON.parse(kitText(rel));
const skillNames = () => fs.readdirSync(path.join(KIT, 'skills'));

function removeEmptyDirs(...rels) {
  for (const rel of [...rels].sort((a, b) => b.split('/').length - a.split('/').length)) {
    if (has(rel) && fs.statSync(abs(rel)).isDirectory() && !fs.readdirSync(abs(rel)).length) fs.rmdirSync(abs(rel));
  }
}

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
  const chosen = flag('--language');
  if (chosen) {
    if (!LANGUAGES.includes(chosen)) die(`--language must be one of ${LANGUAGES.join(', ')}`);
    return chosen;
  }
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  return /^zh/i.test(locale) ? 'zh-CN' : 'en';
}

// ───────────────────────────── hook configs (Claude, Codex and Cursor share the shape) ─────────────────────────────

const isHarnessHook = (h) => typeof h?.command === 'string' && /\.harness\/(gw|vf)\.mjs/.test(h.command);

// Claude and Codex nest handlers in matcher groups ({ hooks: [...] }); Cursor lists handlers directly.
function withoutHarness(config) {
  const out = { ...config };
  if (out.hooks) {
    const hooks = {};
    for (const [event, entries] of Object.entries(out.hooks)) {
      const kept = entries
        .map((e) => (Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter((h) => !isHarnessHook(h)) } : e))
        .filter((e) => (Array.isArray(e.hooks) ? e.hooks.length : !isHarnessHook(e)));
      if (kept.length) hooks[event] = kept;
    }
    if (Object.keys(hooks).length) out.hooks = hooks; else delete out.hooks;
  }
  if (isHarnessHook(out.statusLine)) delete out.statusLine;
  return out;
}

function readJSON(rel) {
  if (!has(rel)) return {};
  try { return JSON.parse(read(rel)); } catch { return die(`${rel} is not valid JSON; fix it first.`); }
}

function mergeHookConfig(rel, kit) {
  const existing = readJSON(rel);
  const out = withoutHarness(existing);
  if (kit.version !== undefined) out.version ??= kit.version;
  out.hooks = { ...(out.hooks ?? {}) };
  for (const [event, entries] of Object.entries(kit.hooks)) out.hooks[event] = [...(out.hooks[event] ?? []), ...entries];
  if (kit.statusLine) out.statusLine ??= kit.statusLine;
  if (kit.permissions) {
    const union = (key) => [...new Set([...(existing.permissions?.[key] ?? []), ...kit.permissions[key]])];
    out.permissions = { ...(existing.permissions ?? {}), allow: union('allow'), ask: union('ask') };
  }
  write(rel, JSON.stringify(out, null, 2) + '\n');
}

function unmergeHookConfig(rel, kit) {
  if (!has(rel)) return;
  const out = withoutHarness(readJSON(rel));
  if (out.permissions) {
    for (const key of ['allow', 'ask']) {
      if (!out.permissions[key]) continue;
      out.permissions[key] = out.permissions[key].filter((rule) => !kit.permissions?.[key]?.includes(rule));
      if (!out.permissions[key].length) delete out.permissions[key];
    }
    if (!Object.keys(out.permissions).length) delete out.permissions;
  }
  const meaningful = Object.keys(out).filter((k) => k !== 'version');
  writeOrRemove(rel, meaningful.length ? JSON.stringify(out, null, 2) + '\n' : '');
}

// ───────────────────────────── instructions and skills ─────────────────────────────

const createdClaude = () => `# ${path.basename(target)}\n\n@.harness/RULES.md\n\n## Commands\n\n- Full suite: see "verify" in .harness/config.json\n\n## Recurring mistakes (add a correction when the same mistake happens twice)\n\n- \n`;
const agentsBlock = () => `<!-- gewu:rules -->\n${kitText(RULES).trim()}\n<!-- /gewu:rules -->\n`;

function installSkills(dir) {
  for (const rel of kitFiles('skills')) write(`${dir}/${rel.slice('skills/'.length)}`, kitText(rel));
}
function removeSkills(dir) {
  for (const name of skillNames()) remove(`${dir}/${name}`);
  removeEmptyDirs(dir, path.dirname(dir));
}

const HOST = {
  claude: {
    add() {
      installSkills(SKILL_DIR.claude);
      for (const rel of kitFiles('hosts/claude/agents')) write(`.claude/agents/${path.basename(rel)}`, kitText(rel));
      mergeHookConfig(HOOK_CONFIG.claude, kitJSON('hosts/claude/settings.json'));
      if (!has('CLAUDE.md')) write('CLAUDE.md', createdClaude());
      else {
        const claude = read('CLAUDE.md').replace(/^@\.harness\/CLAUDE\.md$/m, '@.harness/RULES.md');
        write('CLAUDE.md', /^@\.harness\/RULES\.md$/m.test(claude) ? claude : claude.trimEnd() + IMPORT_BLOCK);
      }
    },
    remove() {
      removeSkills(SKILL_DIR.claude);
      for (const rel of kitFiles('hosts/claude/agents')) remove(`.claude/agents/${path.basename(rel)}`);
      unmergeHookConfig(HOOK_CONFIG.claude, kitJSON('hosts/claude/settings.json'));
      removeEmptyDirs('.claude/agents', '.claude');
      const claude = has('CLAUDE.md') ? read('CLAUDE.md') : '';
      if (!/^@\.harness\/(RULES|CLAUDE)\.md$/m.test(claude)) return;
      if (claude === createdClaude()) remove('CLAUDE.md');
      else write('CLAUDE.md', withNewline(claude.replace(IMPORT_BLOCK, '\n').replace(/^@\.harness\/(RULES|CLAUDE)\.md\n?/m, '')));
    },
  },
  codex: {
    add: () => mergeHookConfig(HOOK_CONFIG.codex, kitJSON('hosts/codex/hooks.json')),
    remove: () => { unmergeHookConfig(HOOK_CONFIG.codex, kitJSON('hosts/codex/hooks.json')); removeEmptyDirs('.codex'); },
  },
  cursor: {
    add: () => mergeHookConfig(HOOK_CONFIG.cursor, kitJSON('hosts/cursor/hooks.json')),
    remove: () => { unmergeHookConfig(HOOK_CONFIG.cursor, kitJSON('hosts/cursor/hooks.json')); removeEmptyDirs('.cursor'); },
  },
};

// Every agent other than Claude Code reads AGENTS.md and .agents/skills.
const AGENTS_LAYER = {
  add() {
    installSkills(SKILL_DIR.agents);
    const current = has('AGENTS.md') ? read('AGENTS.md') : '';
    write('AGENTS.md', RULES_BLOCK.test(current)
      ? current.replace(RULES_BLOCK, agentsBlock)
      : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${agentsBlock()}`);
  },
  remove() {
    removeSkills(SKILL_DIR.agents);
    const agents = has('AGENTS.md') ? read('AGENTS.md') : '';
    if (AGENTS_BLOCK.test(agents)) writeOrRemove('AGENTS.md', withNewline(agents.replace(AGENTS_BLOCK, '\n')));
  },
};

function pruneObsolete() {
  OBSOLETE.forEach(remove);
  const agents = has('AGENTS.md') ? read('AGENTS.md') : '';
  if (OLD_AGENTS_BLOCK.test(agents)) writeOrRemove('AGENTS.md', withNewline(agents.replace(OLD_AGENTS_BLOCK, '\n')));
  removeEmptyDirs('.agents/skills', '.agents');
}

// ───────────────────────────── install / uninstall ─────────────────────────────

function chosenHosts(config) {
  const chosen = flag('--hosts');
  if (chosen) {
    const hosts = chosen.split(',').map((h) => h.trim()).filter(Boolean);
    const unknown = hosts.filter((h) => !HOSTS.includes(h));
    if (unknown.length || !hosts.length) die(`--hosts takes a comma-separated list of ${HOSTS.join(', ')}`);
    return HOSTS.filter((h) => hosts.includes(h));
  }
  return config?.hosts ?? (config ? ['claude'] : HOSTS); // installs from before 0.7 were Claude-only
}

function install() {
  const existing = has(CONFIG) ? readJSON(CONFIG) : null;
  const hosts = chosenHosts(existing);
  pruneObsolete();

  for (const rel of kitFiles('.harness')) if (rel !== CONFIG) write(rel, kitText(rel));
  fs.chmodSync(abs('.harness/gw'), 0o755);
  fs.chmodSync(abs('.harness/gw.mjs'), 0o755);
  if (!existing) write(CONFIG, JSON.stringify({ ...kitJSON(CONFIG), verify: detectVerify(), language: detectLanguage(), hosts }, null, 2) + '\n');
  else if (JSON.stringify(existing.hosts) !== JSON.stringify(hosts)) write(CONFIG, JSON.stringify({ ...existing, hosts }, null, 2) + '\n');
  const seeded = SEEDED.filter((rel) => !has(rel));
  for (const rel of seeded) write(rel, kitText(rel));

  for (const host of HOSTS) HOST[host][hosts.includes(host) ? 'add' : 'remove']();
  AGENTS_LAYER[hosts.some((h) => h !== 'claude') ? 'add' : 'remove']();

  const ignore = has('.gitignore') ? read('.gitignore') : '';
  const missing = IGNORES.filter((line) => !ignore.split('\n').includes(line));
  if (missing.length) write('.gitignore', `${ignore.trimEnd()}${ignore.trim() ? '\n\n' : ''}${IGNORE_HEADER}\n${missing.join('\n')}\n`);

  const cfg = readJSON(CONFIG);
  log(`✓ Gewu Harness installed in ${target}`);
  log(`  agents: ${cfg.hosts.join(', ')} · verify = ${cfg.verify ?? 'not detected: set "verify" in .harness/config.json'} · documents in ${cfg.language}`);
  if (!existing || seeded.length) log(`  created ${[...(existing ? [] : [CONFIG]), ...seeded].join(', ')}`);
  const commit = [...touched].filter((rel) => has(rel) || tracked(rel)).sort();
  const steps = [
    '.harness/gw doctor --run',
    `Commit the harness so teammates and CI share the same guardrails:\n       git add -A -- ${commit.join(' ')}\n       git commit -m "chore: install Gewu Harness"`,
    ...(cfg.hosts.includes('codex') ? ['In Codex, review and trust the project hooks once with /hooks.'] : []),
    'Restart your agent in the project and describe what you want.',
  ];
  log('');
  log('Next:');
  steps.forEach((step, i) => log(`  ${i + 1}. ${step}`));
}

function uninstallHarness() {
  pruneObsolete();
  for (const host of HOSTS) HOST[host].remove();
  AGENTS_LAYER.remove();
  const kept = SEEDED.filter((rel) => has(rel) && read(rel) !== kitText(rel));
  SEEDED.filter((rel) => !kept.includes(rel)).forEach(remove);
  for (const rel of kitFiles('.harness')) remove(rel);
  ['.harness/state.json', '.harness/tmp', '.harness/templates'].forEach(remove);

  const ignore = has('.gitignore') ? read('.gitignore').split('\n') : [];
  const ours = (l) => l === IGNORE_HEADER || IGNORES.includes(l);
  if (ignore.some(ours)) writeOrRemove('.gitignore', withNewline(ignore.filter((l) => !ours(l)).join('\n')));
  removeEmptyDirs('.harness', '.github/workflows', '.github');
  log(`✓ Gewu Harness removed from ${target}`);
  if (kept.length) log(`  kept because you changed them: ${kept.join(', ')}`);
  if (has('.harness')) log(`  .harness/ still holds files the harness did not install: ${fs.readdirSync(abs('.harness')).join(', ')}`);
  if (has('docs/work')) log('  kept your work records in docs/work/');
  log('  Restart your agent so the removed hooks stop loading.');
}

if (!fs.existsSync(target)) die(`No such directory: ${target}`);
const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: target, encoding: 'utf8' });
if (inside.stdout?.trim() !== 'true') die(`${target} is not a git repository. Gewu keeps its evidence in git: run git init first.`);
if (uninstall) uninstallHarness(); else install();
