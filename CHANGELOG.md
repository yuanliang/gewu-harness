# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/yuanliang/gewu-harness/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/yuanliang/gewu-harness/releases/tag/v0.6.0
