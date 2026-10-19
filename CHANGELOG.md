# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain breaking changes.

## [Unreleased]

## [0.7.0] - 2026-10-19

Any coding agent can now use the harness. The rules, the stage playbooks and the evidence are shared; the real-time guards speak each agent's hook protocol.

### Added

- Codex support (beta): hooks on `apply_patch` and shell commands in `.codex/hooks.json`, judged by the files each patch touches. Codex cannot pause to ask, so actions that need the user are blocked with a note telling the agent to ask.
- Cursor support (beta): hooks on file writes and shell commands in `.cursor/hooks.json`; shell commands that need the user ask first.
- An `AGENTS.md` rulebook block and skills in `.agents/skills/`, read by Codex, Cursor and other agents that follow `AGENTS.md`.
- `install.mjs --hosts claude,codex,cursor` chooses the agents to wire up, remembered in `.harness/config.json`. Dropping an agent removes exactly its files.
- The installer prints the exact `git add` command for what it installed.
- A Tauri app's Rust suite (`src-tauri/`) is part of the detected `verify`, and Rust test modules (`tests.rs`) count as tests.
- `replaySetup` receives `$GW_ROOT`, the checkout, so replay worktrees can reuse dependencies and build caches.
- Delivery commands (`git push`, `gh pr create`, `gh pr merge`, `gh release create`, `npm publish`) are caught by the guard for every agent, not only by Claude Code's permission rules.

### Changed

- The rulebook moved from `.harness/CLAUDE.md` to `.harness/RULES.md`; upgrading rewrites the import in `CLAUDE.md`.
- Skills are agent-neutral and no longer use Claude-only syntax.
- The harness's own files, including every agent's hook config, are always guardrails. `guardGlobs` now adds to them instead of replacing them.
- Upgrading an install from before 0.7 keeps it Claude-only unless `--hosts` says otherwise.

## [0.6.0] - 2026-10-19

First public release: a lean core that does two things, runs the SDLC loop and enforces red before green. Versions up to 0.5 were internal iterations.

### Added

- `gw` CLI and Claude Code hooks for the red → green cycle: `start`, `red`, `green`, `done`, plus `reopen`, `abort` and `chore`.
- Red must be earned: a test changed in this cycle (or an explicitly adopted failing test), a failure matching the prediction, crashes only when predicted with `--expect`, never a check that cannot run.
- An untargeted cycle starts from a green full-suite baseline, so an old failure cannot pose as a new red.
- Tests freeze at red, enforced on `Edit`, `Write` and shell writes and backed by tree snapshots (`E_TAMPER`). The edit guard fails closed.
- Evidence: `[red]` and `[green]` commits, an append-only ledger per work item, and `gw audit --base --replay`, which re-proves every red in an isolated worktree.
- Work items with intent, spec and plan templates in English and Simplified Chinese; human approval bound to the exact document content.
- Permission rules that make Claude ask before `git push`, `gh pr create`, `gh pr merge`, `gh release create` and `npm publish`, even in bypass mode.
- Nine stage skills (`gw-next`, `gw-intent`, `gw-spec`, `gw-plan`, `gw-build`, `gw-fix`, `gw-review`, `gw-ship`, `gw-incident`), two subagents (`gw-test-author`, `gw-reviewer`), a review policy and a CI workflow.
- `install.mjs` installs, upgrades and `--uninstall`s, merging rather than overwriting the files you own.

### Removed

- The design-system, quality-contract, delivery-authorization, extension, Codex and evaluation layers of the internal 0.5 line. Upgrading an older install removes their files and hooks; your own files are kept.

[Unreleased]: https://github.com/yuanliang/gewu-harness/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/yuanliang/gewu-harness/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/yuanliang/gewu-harness/releases/tag/v0.6.0
