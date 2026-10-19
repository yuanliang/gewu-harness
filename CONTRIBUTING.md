# Contributing to Gewu Harness

Thanks for helping. This project has one rule, and it applies to its own code as much as to the projects it guards:

> **Show your red.** Every behavior change comes with a test that was observed failing before the change and passing after it, without the test being edited in between.

中文贡献者：欢迎用中文提 issue 和 PR。

## Keep the core small

Gewu does two things: it runs the SDLC loop and it enforces red before green, for any coding agent. A feature belongs in the core only if it makes one of those two more reliable. Anything else should work through the extension points in the README (`verify`, your own skills, subagents and hooks). Open an issue before proposing something larger, and expect "keep it outside the core" to be a common answer. A test enforces the size budget.

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
| `kit/.harness/gw.mjs` | The whole runtime: the CLI, and one hook decision procedure answered in each agent's format |
| `kit/.harness/RULES.md` | The one-page rulebook every agent reads (via `CLAUDE.md` or `AGENTS.md`) |
| `kit/.harness/templates/` | Intent, spec and plan templates, in English and Simplified Chinese |
| `kit/skills/` | Agent-neutral stage playbooks, installed to `.claude/skills/` and `.agents/skills/` |
| `kit/hosts/<agent>/` | Per-agent wiring: hook configs, and Claude Code's settings and subagents |
| `kit/REVIEW.md`, `kit/.github/` | Review policy and CI workflow seeded into projects |
| `install.mjs` | Install, upgrade, choose agents (`--hosts`) and uninstall |
| `test/` | Specifications for the harness itself |

## Making a change

1. Write or extend a test in `test/` that describes the behavior. Run it and confirm it fails for the reason you expect.
2. Implement the smallest change that makes it pass. Do not weaken the test to get there.
3. Run `npm test`.
4. When users would notice the change, update both [README.md](README.md) and [README.zh-CN.md](README.zh-CN.md), and add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

## Adding an agent

An agent can be wired up when it offers hooks that run before a file edit or shell command and can block it. Everything else (the rulebook, skills, evidence and CI) already works for any agent that reads `AGENTS.md`.

1. **Specify it first.** In `test/hooks.test.mjs`, describe what the agent sends and what it must receive: a blocked edit in TEST, an allowed one, a blocked shell write, how "needs the user" is answered, and the stop and session-start replies. Base the payloads on the agent's official hook documentation, and confirm the tests fail.
2. **Reduce its tool calls.** Teach `toolCall()` in `gw.mjs` to turn the agent's payload into the files it writes (and their new text) or a shell command. The decision itself (`judgeFiles`, `judgeShell`) stays shared.
3. **Answer in its format.** Extend `respond()`, `hookStop()` and `hookSessionStart()` for the agent's output, including whether it can pause to ask the user.
4. **Wire it in.** Add `kit/hosts/<agent>/` with its hook config and a `HOST` entry in `install.mjs`, then cover install, `--hosts` and uninstall in `test/install.test.mjs`, including the test that runs every configured hook command.
5. **Document it honestly** in the Agents table of both READMEs: how strictly the agent is held, and whether it has been run in a live session.

## Pull requests

- Keep each PR to one concern.
- Fill in the PR template, including the failing output you saw before your fix.
- CI must be green on every Node version in the matrix.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not public issues.
