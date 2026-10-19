# Contributing to Gewu Harness

Thanks for helping. This project has one rule, and it applies to its own code as much as to the projects it guards:

> **Show your red.** Every behavior change comes with a test that was observed failing before the change and passing after it, without the test being edited in between.

中文贡献者：欢迎用中文提 issue 和 PR。

## Keep the core small

Gewu does two things: it runs the SDLC loop and it enforces red before green. A feature belongs in the core only if it makes one of those two more reliable. Anything else should work through the extension points in the README (`verify`, your own skills, subagents and hooks). Open an issue before proposing something larger, and expect "keep it outside the core" to be a common answer. A test enforces the size budget.

## Development setup

Requirements: macOS or Linux (on Windows, use WSL), Node.js 18 or newer, and Git. The runtime has zero third-party dependencies; please keep it that way.

```bash
git clone https://github.com/yuanliang/gewu-harness.git
cd gewu-harness
npm test
```

## Layout

| Path | What it is |
|---|---|
| `kit/` | Installed verbatim into projects (`.harness/`, `.claude/`, `REVIEW.md`, CI) |
| `kit/.harness/gw.mjs` | The whole runtime: CLI and hook handlers in one file |
| `kit/.harness/CLAUDE.md` | The rulebook the agent reads every session (one page) |
| `install.mjs` | Install, upgrade and uninstall |
| `test/` | Specifications for the harness itself |

## Making a change

1. Write or extend a test in `test/` that describes the behavior. Run it and confirm it fails for the reason you expect.
2. Implement the smallest change that makes it pass. Do not weaken the test to get there.
3. Run `npm test`.
4. When users would notice the change, update both [README.md](README.md) and [README.zh-CN.md](README.zh-CN.md), and add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

## Pull requests

- Keep each PR to one concern.
- Fill in the PR template, including the failing output you saw before your fix.
- CI must be green on every Node version in the matrix.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not public issues.
