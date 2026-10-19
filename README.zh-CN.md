# Gewu Harness · 格物致知

**一个精简的 AI 编程助手 harness：按 SDLC 流程走，每次改动都先红后绿。**

[![CI](https://github.com/yuanliang/gewu-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/yuanliang/gewu-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-339933)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

[English](README.md) | 简体中文

Gewu 可以装进任何 Git 仓库，支持 **Claude Code、Codex、Cursor**，以及其他会读取 `AGENTS.md` 的智能体。它只做两件事：

1. **按 SDLC 循环走流程**：遵循 Anthropic《[AI-native SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook)》的“规划 → 设计 → 构建 → 测试 → 交付 → 维护”，每个阶段提交一个产物，每道门禁由人把关。
2. **强制一条规则**，靠 hooks 和计算出来的证据，而不是提示词：

> **没有先被观察到失败的验证，就没有行为改动。**

其他能力，比如 lint、设计系统、部署、团队规范，都在此之上按需扩展（见[扩展](#扩展)）。

格物致知：知识来自对事物本身的考察，而不是对说法的信任。

> **状态**：0.x，早期版本。核心很小，测试充分，但命令和文件格式在小版本之间仍可能变化，升级前请看[更新日志](CHANGELOG.md)。

## 为什么

AI 写代码的速度早已超过人验证的速度。常见的问题不是代码写得差，而是**没有被验证**：事后补的测试本来就会通过，测试被悄悄改到变绿，没有证据就报告“完成”。Gewu 让诚实的路成为最短的路：

- **先红后绿**：新的验证必须先按你预测的原因失败，实现才会解锁。
- **红之后测试冻结**：只能改代码，不能改测试。测试本身写错了，要显式 `reopen` 并记录在案。
- **证明是算出来的**：`gw` 自己运行检查，每一步对工作区做快照，提交 `[red]` 和 `[green]`，CI 再从历史中重放每一个红。
- **人来决定**：意图、规格、计划由你批准；没有你，任何智能体都不能推送、开 PR、合并或发布。

## 快速开始

**环境要求**

- macOS 或 Linux。Windows 请使用 [WSL](https://learn.microsoft.com/windows/wsl/)，因为检查命令通过 `/bin/sh` 执行。
- Node.js 18 或更高版本，以及 Git。
- 一个智能体。Claude Code 需要 2.1.295 或更高版本：它的编辑守卫依赖 hooks 的 `onFailure` 设置，这个设置从该版本开始提供。Codex 和 Cursor 需要支持 hooks 的版本（见[智能体](#智能体)）。

```bash
git clone https://github.com/yuanliang/gewu-harness.git
node gewu-harness/install.mjs /path/to/your/project      # 默认接入全部智能体；可用 --hosts claude,codex,cursor 只选部分
cd /path/to/your/project
.harness/gw doctor --run
```

然后提交安装的内容，让队友和 CI 用上同一套护栏。安装器会打印出确切的命令，例如：

```bash
git add -A -- .agents .claude .codex .cursor .github .gitignore .harness AGENTS.md CLAUDE.md REVIEW.md
git commit -m "chore: install Gewu Harness"
```

如果项目的格式化或 lint 工具会检查仓库里的所有文件（Biome、Prettier、ESLint），请把 `.harness/`、`.claude/`、`.codex/`、`.cursor/` 和 `.agents/` 排除在外；这些文件遵循 harness 自己的风格。

如果用 Codex，先用 `/hooks` 审核并信任一次项目的 hooks。然后在项目里重启智能体，直接说你要做什么，例如：

> 给订单接口加分页，保留旧接口兼容。

智能体会起草意图、规格和计划交给你批准，然后逐个完成红绿循环，在任何推送之前停下来。

- **升级**：再运行一次安装器，你选过的智能体会被记住。属于你的文件会被合并（`CLAUDE.md`、`AGENTS.md`、hook 配置、`.gitignore`）或保持不动（配置、评审规则、CI），不会被覆盖。
- **卸载**：`node gewu-harness/install.mjs --uninstall /path/to/your/project` 会精确撤回安装的内容。你改过的文件和 `docs/work/` 里的工作记录会保留。

## 智能体

所有智能体遵守同一份规则手册（`.harness/RULES.md`）和同一套阶段技能，区别只在约束的强度：

| 智能体 | 从哪里读取规则 | 实时护栏 | 状态 |
|---|---|---|---|
| Claude Code | `CLAUDE.md` → `.harness/RULES.md`；技能在 `.claude/skills`；两个子代理；状态栏 | hooks 拦截编辑和 shell 命令；推送、PR、合并、发布前会先问你 | 已在真实会话中验证 |
| Codex | `AGENTS.md`；技能在 `.agents/skills` | hooks 拦截 `apply_patch` 和 shell 命令。Codex 不能中途停下来询问，所以需要你决定的操作会被拦下，并提示智能体去问你 | Beta：按官方文档的 hook 协议实现，尚未在真实会话中运行 |
| Cursor | `AGENTS.md`；技能在 `.agents/skills` | hooks 拦截文件写入和 shell 命令；推送、PR、合并、发布前会先问你 | Beta：按官方文档的 hook 协议实现，尚未在真实会话中运行 |
| 其他读取 `AGENTS.md` 的智能体 | `AGENTS.md` | 无。但 `gw` 依然拒绝虚假的红与绿，CI 依然重放证据 | 仅指令 |

无论用哪个智能体，证据都是一样的：`gw` 自己运行每一个检查，CI 里的 `gw audit --replay` 会从 git 历史中重新证明每一个红。

## 工作方式

### 循环

| 阶段 | 技能 | 产物（`docs/work/<id>/`） | 门禁 |
|---|---|---|---|
| 规划 | `gw-intent` | `intent.md`：问题、期望结果、**可证伪的**验收信号 | 你批准 |
| 设计 | `gw-spec` | `spec.md`：每条需求都有 Given/When/Then 检查 | 你批准 |
| 构建 | `gw-plan` → `gw-build` | `plan.md`：有序的红绿循环，每个都写出预测的失败 | 你批准 |
| 测试 | 内建于每个循环；bug 用 `gw-fix` | `evidence.jsonl` 与 `evidence.md` | `gw audit` |
| 交付 | `gw-review` → `gw-ship` | 按 `REVIEW.md` 的独立评审；PR 草稿 | 每次推送、PR、合并由你批准 |
| 维护 | `gw-incident` | 失败的复现测试、一条教训、新的意图 | |

流程随任务大小伸缩：bug 只需批准意图，`quick` 类型不需要任何文档。不确定下一步？让智能体执行 `gw-next`（在 Claude Code 中输入 `/gw-next`）。

### 一个循环

```mermaid
stateDiagram-v2
    direction LR
    IDLE --> TEST: gw start
    TEST --> RED: gw red（按预测失败）
    RED --> GREEN: gw green（目标 + 全量）
    GREEN --> IDLE: gw done（再验证，提交）
    RED --> TEST: gw reopen（记录在案）
```

| 阶段 | 测试 | 实现 | 离开这个阶段的条件 |
|---|---|---|---|
| IDLE | 锁定 | 锁定 | `start`：没有 `--check` 时，全量测试必须已经是绿的 |
| TEST | 可写 | 锁定 | `red`：有测试改动，检查失败，且按预测失败。崩溃只有用 `--expect` 预测过才算；无法运行的检查永远不算 |
| RED | **冻结** | 可写 | `green`：红之后测试没动过，目标检查和全量测试都通过 |
| GREEN | **冻结** | 可写 | `done`：重构后依然是绿的 |

hooks 会在智能体的每一条写入路径上强制这些锁：编辑工具、补丁和 shell 写入。用其他方式改动的测试，会在 `green` 时被 tree 快照查出（`E_TAMPER`）。

### 可审计的证据

- `[red]` 提交只含新测试；`[green]` 提交含实现和证据链。
- `gw audit --base main` 会列出分支上没有被任何循环验证过的源码改动。
- `gw audit --replay` 在临时 worktree 中，于每个红提交上重跑当时的检查，确认它真的失败，并确认 HEAD 是绿的。你的工作区不会被切换，手改过的证据链过不了重放。安装的 CI 会在每个 PR 上运行它。

## 命令

这些命令由智能体替你执行，你很少需要自己输入。

| 命令 | 作用 |
|---|---|
| `gw start <R#> "<行为>" [--check <命令>] [--expect <文本>]` | 开启循环（TEST） |
| `gw red [--expect <文本>] [--adopt <测试>]` | 证明新检查失败；冻结测试；`[red]` 提交 |
| `gw green` | 证明通过：先目标检查，再全量 |
| `gw done` | 重构后再验证，写证据，`[green]` 提交 |
| `gw reopen "<原因>"` · `gw abort "<原因>"` | 修正写错的测试（回到 TEST）· 放弃当前循环 |
| `gw chore "<原因>"` | 非行为改动；需要你确认；全量通过才能结束 |
| `gw new "<标题>" [--type feature\|bug\|incident\|quick]` · `gw use <id>` | 工作项 |
| `gw approve <intent\|spec\|plan>` | **由你执行**：批准当前的确切内容（在 Claude Code 中输入 `! .harness/gw approve plan`） |
| `gw status` · `gw evidence` · `gw check` · `gw doctor [--run]` | 查看 |
| `gw audit [--base <ref>] [--replay]` | CI 门禁 |

每个错误都有稳定的错误码（`E_NOT_RED`、`E_WRONG_REASON`、`E_TAMPER`、`E_REGRESSION`、`E_GATE` 等），并告诉你下一步怎么做。

## 配置

`.harness/config.json`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `verify` | 自动识别 | 全量测试命令，退出码 0 为绿。可识别 npm、pnpm、yarn、bun、pytest、Go、Cargo（包括 Tauri 应用的 `src-tauri/`）、Mix、RSpec、Maven、Gradle、SwiftPM 和 Make。如果希望绿也覆盖 lint 和类型检查，就把它们串进来 |
| `hosts` | 全部 | 要接入的智能体：`claude`、`codex`、`cursor`。用 `install.mjs --hosts` 修改 |
| `language` | 取自系统语言 | 工作项模板的语言：`en` 或 `zh-CN` |
| `enforce` | `strict` | `strict` 拦截；`warn` 只提醒智能体；`off` 关闭 hooks |
| `gates` | `warn` | `strict` 时，`start` 要求所需文档已批准且未改动 |
| `commit` | `true` | 只提交本循环涉及的文件，形成 `[red]` / `[green]` 提交 |
| `replaySetup` | `null` | 为每个重放用的 worktree 做准备，例如 `npm ci`；依赖不在 git 中时必须设置。`$GW_ROOT` 指向你的检出目录，可以借它复用缓存，例如 `ln -s "$GW_ROOT/target" target` |
| `postEdit` | `null` | Claude Code：每次编辑后运行，例如 `npx prettier --write {file}` |
| `testGlobs` / `freeGlobs` / `guardGlobs` | 见文件 | 把文件归类为测试、自由（文档）或额外的护栏；harness 自己的文件始终受保护 |

## 扩展

核心刻意保持精简。其他能力用你所用智能体自带的扩展点接入，安装器不会碰它们：

- **质量门禁**：串进 `verify`（`npm run lint && npm run typecheck && npm test`），绿就意味着全部通过。
- **技能与子代理**：和 harness 的放在一起即可。只有 `gw-*` 开头的名字属于 harness。
- **hooks 与权限**：加进你所用智能体的配置，重装时会保留。
- **团队规则**：约定写进 `CLAUDE.md` 或 `AGENTS.md`，评审规则写进 `REVIEW.md`。
- **接入新的智能体**：见 [CONTRIBUTING.md](CONTRIBUTING.md#adding-an-agent)。

## 局限

- **是护栏，不是沙箱**：hooks 和快照拦得住日常的走捷径，拦不住蓄意的恶意执行；配置里的命令以你的权限运行。见 [SECURITY.md](SECURITY.md)。
- **实时护栏取决于智能体**：Codex 和 Cursor 的支持是新加的，尚未在真实会话中运行；没有 hooks 的智能体只按指令行事。证据检查对所有智能体都有效。
- **管证据，不管品味**：Gewu 证明每个改动做到了它的检查所描述的事；这些检查是否描述了一个好产品，仍由你判断。

## 开发

```bash
npm test    # CLI、各智能体的 hooks、审计与重放、安装与卸载的规格测试
```

## 参与贡献

欢迎贡献，只有一条规则：**拿出你的红**。每个行为改动都要附一个改动前失败、改动后通过的测试。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 和[行为准则](CODE_OF_CONDUCT.md)。

## 致谢

流程遵循 Anthropic 的《[The AI-native SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook)》。本项目是独立项目，与 Anthropic、OpenAI、Anysphere 均无关联。

## 许可证

[MIT](LICENSE) © 2026 yuanliang
