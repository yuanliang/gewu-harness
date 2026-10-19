# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.6.x | Yes |
| < 0.6 | No |

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for security problems.

Include the affected version, steps to reproduce, and what an attacker gains. You can expect an acknowledgement within a few days. Once a fix is available, the report is disclosed along with it.

## Threat model

What Gewu does and does not protect against helps you judge whether something is a vulnerability.

**In scope**

- An agent getting past a phase lock, the test freeze or an approval gate through normal tool use (Edit, Write, ordinary shell commands).
- Evidence that `gw audit --replay` accepts although it does not match what actually ran.
- The installer or `--uninstall` changing or deleting files it does not own.

**Out of scope**

- **Gewu is not a sandbox.** Hooks and snapshots are guardrails against everyday shortcuts, not against a deliberately malicious executor or scripts written to bypass them.
- **Commands from the project run with your privileges.** `verify`, `--check`, `replaySetup` and `postEdit` are shell commands read from the project's configuration. Install the harness only in repositories whose configuration you trust, as you would before running their test suite.
- Agents other than Claude Code, which follow the rules by instruction only.
- Bugs in Claude Code, Node.js or Git themselves.
