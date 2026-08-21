<div align="center">

# 📥 DSH Chat Import

**把 14 种外部 Agent 聊天历史全保真导入 DeepSeek Harness 为可继续（resume）会话——并可导出 / 同步回 Claude Code。**

本公开 fork（[AI-Scarlett/dsh-chat-import](https://github.com/AI-Scarlett/dsh-chat-import)）增加了 Claude / Codex / Grok 双向增量同步与 Web 控制面板。上游：[Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)。

[![English](https://img.shields.io/badge/Language-English-blue?style=for-the-badge)](README.md)
[![简体中文](https://img.shields.io/badge/Language-简体中文-blue?style=for-the-badge)](#)

[![npm version](https://img.shields.io/npm/v/dsh-chat-import?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-chat-import)
[![npm downloads](https://img.shields.io/npm/dm/dsh-chat-import?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-chat-import)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Node.js >= 22.13](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/Nwflower/dsh-chat-import/ci.yml?style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/Nwflower/dsh-chat-import/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Nwflower/dsh-chat-import)
[![已收录于 Awesome DeepSeek Harness](https://img.shields.io/badge/%E5%B7%B2%E6%94%B6%E5%BD%95%E4%BA%8E-Awesome_DeepSeek_Harness-6A5ACD?style=for-the-badge&logo=awesome&logoColor=white)](https://github.com/0xsline/awesome-deepseek-harness)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![已收录于 Awesome DSH Plugins](https://img.shields.io/badge/%E5%B7%B2%E6%94%B6%E5%BD%95%E4%BA%8E-Awesome_DSH_Plugins-6A5ACD?style=for-the-badge&logo=awesome&logoColor=white)](https://github.com/Dominic789654/awesome-deepseek-harness)

[💡 概念](#-概念) · [✨ 功能特性](#-功能特性) · [🗂 支持的来源](#-支持的来源) · [🚀 快速开始](#-快速开始) · [🛠 使用](#-使用) · [🔑 关键行为](#-关键行为) · [🏗️ 技术栈](#-技术栈) · [🗺️ 路线图](#-路线图) · [🤝 贡献](#-贡献)

</div>

> **一个插件，14 种来源** —— 全保真导入 DeepSeek Harness，无缝续聊，并可导出 / 同步回 Claude Code。

<div align="center">

<img src="./assets/image-20260814205401839.png" alt="从多个来源导入会话到侧边栏面板" width="600" />

**更新日志（英文）：** [CHANGELOG.md](CHANGELOG.md) · **路线图：** [ROADMAP.md](ROADMAP.md)

</div>

---

## 💡 概念

`dsh-chat-import` 从 **Claude Code、Codex、ChatGPT、Cursor、Gemini、Reasonix、opencode、ZCode、Grok Build、OpenClaw、Pi Coding Agent、Hermes、Kimi CLI 与 DSH 会话日志** 导入聊天历史——工具调用、思考过程一应俱全——成为**全保真、可继续（resume）的 DeepSeek Harness 会话**。源文件**只读**读取（绝不改写），不碰 DSH 引擎；每次导入都成为一条全新会话，并按源 `cwd` 归入对应工作区。

反向方向同样覆盖：`export_claude` 把 DSH 会话序列化回 Claude Code JSONL（只读——绝不修改你的 DSH 日志），Claude Code 可用 `--resume` 加载续聊；`sync_to_claude` 再把会话新增轮次增量写回 Claude Code 文件——带守卫、绝不静默覆盖。

---

## ✨ 功能特性

| 分类 | 特性 | 说明 |
| --- | --- | --- |
| 导入 | **14 种来源 + 本地 JSONL，一个插件** | 每种来源一条命令——从 Claude Code JSONL、Codex rollout 到 SQLite 数据库与会话目录。 |
| 导入 | **全保真** | 工具调用与结果、思考块、标题、模型与时间戳，源有记录就原样保留。 |
| 导入 | **批量导入** | 指向一个目录（或整个数据库），每个文件 / 每段对话都成为独立会话，并返回逐文件汇总。 |
| 续聊 | **可无缝续聊** | 打开导入的会话，从源记录停下的地方继续对话。 |
| 续聊 | **自动归组工作区** | 会话按源 `cwd` 挂进对应工作区（本机无此路径时回退到源文件所在目录）——不再「未分组」。 |
| 反向 | **导出回 Claude Code** | `export_claude` 把任意 DSH 会话（导入的或原生的）写到 `<outputDir>/<slug>/<uuid>.jsonl`，可直接 `--resume`。 |
| 反向 | **反向同步** | `sync_to_claude` 把会话新增完整轮次追加回 Claude Code 文件——带守卫、绝不覆盖。 |
| 保护 | **幂等 + 增量** | 重复导入未变化的源直接跳过；增长的源只追加新增轮次。 |
| 保护 | **上下文预算保护** | 超长会话按安全上下文预算裁剪，裁剪结果显式上报。 |

---

## 🗂 支持的来源

| 来源 | 存储位置 | 导入工具 |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `import_claude` |
| **Codex / ChatGPT CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `import_codex` |
| **ChatGPT**（网页导出） | 导出压缩包（任意路径）——`conversations.json` | `import_chatgpt` |
| **Cursor** | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `import_cursor` |
| **Gemini CLI** | `~/.gemini/history/<slot>/chats/session-*.json` | `import_gemini` |
| **Reasonix** | `~/.reasonix/sessions/desktop-*.jsonl` | `import_reasonix` |
| **opencode** | `~/.local/share/opencode/opencode.db` | `import_opencode` |
| **ZCode**（z.ai CLI） | `~/.zcode/cli/db/db.sqlite` | `import_zcode` |
| **Grok Build** | `~/.grok/sessions/<project>/<session_id>/` | `import_grokbuild` |
| **OpenClaw** | `~/.openclaw/agents/<agent>/sessions/*.jsonl` | `import_openclaw` |
| **Pi Coding Agent** | `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl` | `import_pi` |
| **Hermes** | `~/.hermes/`（Windows `%LOCALAPPDATA%\hermes`） | `import_hermes` |
| **Kimi CLI** | `~/.kimi/sessions/<workdir-md5>/<sessionId>/wire.jsonl` | `import_kimi` |
| **DSH 会话日志** | `~/.dsh/sessions/<encoded-workspace>/<sessionId>/session.jsonl(.zstd)` | `import_dsh` |
| **任意本地 JSONL** | 任意 `.jsonl` 文件 / 目录（自动识别格式） | `import_local_jsonl` |

每次导入都会保留源实际记录的内容——sessionId、`cwd`、标题、模型、时间戳、工具调用与结果、思考过程。数据较少的源导入其已有的内容；源格式无法保留的部分，会在导入报告里显式标注（如 Kimi 镜像进父 wire 的 `SubagentEvent` 子代理对话会跳过——父 `Agent` 工具调用与结果保留，子代理自己的 `subagents/<agentId>/wire.jsonl` 可直接导入）。

---

## 🚀 快速开始

**1. 安装** — 把插件加进 profile：

```bash
dsh plugin --profile web add dsh-chat-import                    # npm 包
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # 本地源码（符号链接）
```

**2. 导入** — 在任意 DSH 会话里导入单个文件或整个目录（15 个导入工具调用方式一致——见上方来源表）：

```
import_claude({ path: "~/.claude/projects" })
```

**3. 续聊** — 刷新一次会话列表，打开导入的会话，继续对话——它会从源记录停下的地方无缝接上。

**4. 双向增量同步（本机二次开发）** — 侧边栏「导入会话」面板新增 **同步** 页：

- **外部 → DSH**：按间隔巡检 Claude / Codex / Grok 的新增或增长会话，走既有幂等续写。
- **DSH → 外部**：把 DSH 新增完整轮次写回对应 agent。导入源追加到原文件；原生 DSH 会话在该 agent 默认根下落一份副本。
- 两个方向**默认关闭**，必须在面板里打开开关，或点「立即同步」。配置在 `$DSH_HOME/dsh-chat-import/sync.json`。
- 在 rc.8 上，出站同步先比较轻量的 `sessionPersistence.listSnapshots()` revision，再决定是否读取日志：未变化会话零完整读取；首次迁移 / 变化会话默认每轮最多处理 **25 个**（面板可配 1–500），`outbound.json` 每轮只原子提交一次。

<details>
<summary><b>卸载</b></summary>

`dsh plugin` 把插件的 bundle 声明收编进 profile；重启 dsh 后插件生效。卸载：从 profile 的 bundles 移除 `import-claude` insert 行并重启 dsh。已导入的会话保留在 DSH 数据目录，不受影响。

</details>

---

## 🛠 使用

> **注意**：导入会即时落盘，但 DSH 的会话列表不会自动刷新——导入后请刷新页面（或会话列表）才能看到新会话。

**导入——单个文件或目录。** 每个 `import_*` 工具都接受 `path`；目录递归扫描，每个文件 / 每段对话成为独立会话：

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_codex({ path: "C:\Users\<you>\.codex\sessions\2026\05\18\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\Users\<you>\Downloads\chatgpt-export\conversations.json" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
```

`import_local_jsonl({ path })` 接受任意本地 `.jsonl` 会话文件（或目录）：自动识别 `dsh` / `claude` / `codex` / `cursor` / `reasonix` / `pi` / `openclaw` / `hermes`，识别不准时可用 `format` 参数强制指定：

```
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
import_local_jsonl({ path: "D:\downloads\unknown.jsonl", format: "claude" })
```

`import_chatgpt` / `import_opencode` / `import_zcode` / `import_hermes` 恒返回批量结果——一个文件 / 数据库包含全部会话，一次调用即可让每段对话成为独立会话。

<details>
<summary><b>导入参数与行为</b></summary>

- `preview: true`（别名 `dryRun: true`）— **只读**运行：照常解析 / 读取 / 转换，但**零副作用**、不落盘。去掉该参数再调一次即正式导入。
- `force: true` — 即使已导入，也以新 id（`import-<sessionId>-<n>`）另存一份**完整副本**；旧会话绝不修改。
- `sessionId`（可选）— 覆盖目标 DSH 会话 id（默认 `import-<源sessionId>`）。
- **已归档会话可重新导入** — DSH 的归档会把会话从侧边栏隐藏，但保留在持久化里（及其 id）——面板与 `scan_discover` 现在把已归档目标标记为 **已归档 / Archived** 并提供重新导入按钮。再次导入以新 id（`import-<sessionId>-<n>`，与 `force` 同一铸键）另存完整副本，不触碰已归档会话；多会话源（chatgpt / opencode / zcode / hermes 库）内逐会话同样适用。
- **增量续写（重导）** — 重导同一源路径绝不改写已导入历史：未变文件跳过（`already-imported`，不重读）；增长文件只把**新增轮次** append 进同一会话（`appended`）；截断文件检测并上报（`sourceShrunk`）——需要完整新副本时用 `force: true`：

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
// 未变化 → "already-imported" · 增长 → "appended"（只追加新轮次）
```

</details>

每次导入结果都会上报 `status` 与任何异常——畸形行、疑似敏感信息、逐源丢弃——绝不静默吞掉。

### import_agents — 把 pi/opencode 的 agent 与 prompt 转换为 DSH skills

`import_agents` 把 **pi**（`~/.pi/agent/{agents,prompts}/*.md`）与 **opencode**（`~/.config/opencode/{agents,skill}/*.md`）的自定义 agent、mode prompt、skill 转换为**持久化 DSH skill 资产**——`$DSH_AGENTS_HOME/skills/<name>/SKILL.md`（`$DSH_AGENTS_HOME` 缺省 `~/.agents`），成为任意会话里可发现的技能。这与运行时只读的 Claude 桥（`context-bridge`，默认关）互补：后者把 Claude 的 memory/CLAUDE.md/skills 临时注入；本工具把 pi/opencode 资产持久落盘。

默认 **dry-run**（只返回 write/complete/skip 规划清单，零副作用）；传 `apply: true` 才真正写盘：

```
import_agents()                    // dry-run：仅规划
import_agents({ apply: true })     // 写入 $DSH_AGENTS_HOME/skills/<name>/SKILL.md
```

语义：跨源同名冲突加 `-pi` / `-opencode` 后缀消歧；内容相同幂等跳过；已带 `kind: dsh`/`kind: skill` frontmatter 的源不重复导入；bundle 目录缺 `SKILL.md` 时原地补全（保留既有 `scripts/` 等）；嵌套 YAML（如 `permission:`）原样保留。

### scan_discover — 只读会话发现

`scan_discover` 扫描全部 14 种格式的已知数据根，返回结构化会话索引（标题、项目、路径、导入状态），供批导入前预览。零副作用：

```
scan_discover()
scan_discover({ path: "~/.codex/sessions", format: "codex", query: "import" })
```

### list_imported_sessions & retract_import — 识别与撤回

`list_imported_sessions()` 枚举本插件已导入的全部 DSH 会话；`retract_import({ sessionId })`（或 `sourcePath`）移除其 registry 记录并返回手动删除引导。**只识别 + 引导手动删，绝不执行任何删除**：

```
list_imported_sessions()
retract_import({ sessionId: "import-019f5f27-…" })
```

### export_claude — DSH → Claude Code JSONL

`export_claude({ sessionId })` 把现有 DSH 会话（导入的或原生的）序列化为 Claude Code JSONL transcript，可直接 `--resume`。文件写到 `<outputDir>/<slug>/<uuid>.jsonl`（默认 `~/.claude/projects`），文件名是全新 UUID v4——绝不覆盖已有文件：

```
export_claude({ sessionId: "import-019f5f27-…" })
export_claude({ sessionId: "…", outputDir: "D:\backup\claude-projects", dryRun: true })
```

### sync_to_claude — 增量写回

`sync_to_claude({ sessionId })` 把会话的**新增完整轮次**追加回其 Claude Code 文件——`target: "source"`（默认，写回导入源文件）或 `"copy"`（最近一次 `export_claude` 副本）。文件被外部修改或缩小时一律上报、绝不覆盖；`force: true` 越过外部修改重锚定（被覆盖的守卫仍会上报）：

```
sync_to_claude({ sessionId: "import-019f5f27-…" })
sync_to_claude({ sessionId: "…", target: "copy", dryRun: true })
```

### 浏览器面板 — 设置中的发现与导入

DSH rc.8 没有「设置」按钮之后的受支持 Slot，因此安全回退方案通过公开的 `settings.section` 槽，把「导入会话」放进「设置」。它不做 DOM 探测、不再提供浮层触发按钮，也不覆盖官方 `sidebar.settings` 席位。设置分区**按工作区文件夹分组**列出发现的会话（各来源记录里的 `cwd`/项目名，缺省归入「(未分组)」），支持来源过滤——「全部来源」扫描全部格式的默认数据根，单选来源则只看该格式——并带逐会话导入状态徽标（已导入 / 部分 / 未导入）。搜索框按标题 / 工作区 / 路径过滤，列表**分页**展示（每页 50 条），跨页选择保留便于批量操作。

每行支持**单选导入**，复选框支持**多选导入**（「导入所选 (N)」）：面板调用与 `import_*` 工具完全相同的 host 导入管线，幂等跳过 / 增量续写 / force / 上下文预算语义完全一致；导入后自动刷新列表展示最新状态。多会话源（如 `conversations.json`、opencode/zcode/hermes 库）整源导入——opencode/zcode 只导所选 `sessionId`。

> 数据来自与 `scan_discover` 同一套只读发现（30s TTL 缓存 + 持久化 mtime 书签）；面板除你主动触发的导入外零写入。

### `/import` 斜杠命令

插件还注册了一个 **`/import <source> <path>`** 斜杠命令（在挂载了 dsh `commands` 服务的环境下可用）：直接在会话里输入即可导入，不占模型轮次——与 `import_*` 工具同一管线、同一幂等 / 增量 / force / 上下文预算语义。`<source>` 接受短名（`claude`、`codex`…）、客户端来源 id（`claude-code`）或工具全名（`import_claude`）；`<path>` 为 transcript 文件或会话目录 / 数据根（单文件导入 / 目录批量照常判定）。

### 会话启动上下文增强

两个可选钩子在 DSH 会话启动时运行（host `agent/session-start` 事件），均为 agent 级作用域、绝不触碰你的 transcript：

- **迁移提示（默认开）**——当会话工作区存在可发现的（已导入或可导入）外部聊天历史时，注入一行 `PromptContext`，告诉模型如何继续（`/import <source> <path>` 命令或侧边栏面板）。per-project 记忆保证同一工作区只提示一次；设 `DSH_IMPORT_SESSION_HINT=0` 关闭。
- **Claude 上下文桥接（默认关）**——设 `DSH_IMPORT_CONTEXT_BRIDGE=1` 把 Claude Code 的上下文资产桥进会话：`~/.claude/memory/*.md`（按 `feedback` > `project` > `reference` > `user` 分组、8 KiB 上限、mtime 缓存重读）、项目根 `CLAUDE.md`、以及 `~/.claude/skills/*/SKILL.md`（注册为该 agent 独有的 `claude-<name>` 技能）。

---

## 🔑 关键行为

- **只读导入** — 源转录与数据库绝不改写；导入的 DSH 历史 append-only（既有事件绝不修改）。
- **幂等 + 增量** — 未变源不重读直接跳过；增长只追加新增轮次；截断检测并上报。
- **自动归组工作区** — 会话按源 `cwd` 归入对应工作区；`cwd` 在本机不存在时（跨机器迁移 transcript 的常见情况）回退归到**源文件所在目录**的工作区，不会消失在「未分组」里。
- **上下文预算保护** — 导入会话没有 provider 配置，dsh 不会自动压缩它们；超长会话按上下文预算裁剪（单条内容上限，中间段压缩，保留最早提问、一条摘要与尾部）。预算可在调用时指定，或通过环境变量 `DSH_IMPORT_CONTEXT_BUDGET` 设置；裁剪结果总是上报。
- **失败要大声，绝不静默** — 畸形行与疑似敏感信息按位置计数上报（行号 / kind——绝不输出内容）；源格式无法保留的部分在导入报告里显式标注。
- **沙箱** — 读取工作区之外的源文件或写工作区之外的导出目标，需要会话沙箱放行该路径。

---

## 🏗️ 技术栈

| 层 | 技术 |
| --- | --- |
| 运行时 | Node.js ≥ 22.13 — 纯 ESM，零构建 |
| 平台 | DeepSeek Harness 插件 — Cordis「一切皆插件」，只消费公开 host 服务 |
| 解析器 | Claude/Codex/Cursor/Gemini/Reasonix/Pi/Kimi JSONL · ChatGPT JSON · opencode/ZCode/Hermes SQLite（`node:sqlite`） |
| UI | dsh web 侧边栏面板（手写 CJS bundle）· 经 `@deepseek-ai/dsh-client-locale` 多语言 |
| CI | GitHub Actions — test / lint / `check:linux` 跨平台护栏 / headless 冒烟 |

```
lib/
├── convert/          # 纯函数按源转换器（零 DSH 依赖，可独立单测）
├── export/           # 反向序列化器（DSH → Claude Code JSONL）
├── imports.mjs       # 幂等导入 registry
├── import-core.mjs   # 共享导入状态机
├── toolkit.mjs       # makeImportTool 工厂 + IMPORT_SPECS
├── panel.mjs         # 浏览器面板 JSON 路由
├── command.mjs       # /import 斜杠命令
├── prompt-hint.mjs   # 会话启动迁移提示（REQ-53）
└── context-bridge.mjs # Claude memory / CLAUDE.md / skills 桥接（REQ-28）
```

---

## ⚙️ 兼容性

面向 `dsh 0.1.x` 线（`dsh-tools >=0.1.0-rc.8 <0.2.0`，实测 `dsh 0.1.0-rc.8`），需要 **Node.js >= 22.13**（`node:sqlite` 免 flag 的首个版本）。`npm test` — 414 个用例。

---

## 🗺️ 路线图

- [x] 14 种来源导入 + 反向导出 / 同步回 Claude Code
- [x] 浏览器导入面板 + `/import` 斜杠命令 + 会话启动迁移提示与上下文桥接
- [ ] Interchange IR v1 + 便携备份 bundle（REQ-18 / REQ-56）
- [ ] `/import-all` 批量命令 · Codex 官方 App Server API 源（REQ-52）
- [ ] 更多来源：Reasonix 桌面版、Claude-3p · Hermes lineage（REQ-45 / REQ-51）

---

## 🤝 贡献

欢迎贡献——fork 本仓库，新建 `feature/<name>` 分支，提交 PR。

- **测试：** `npm test` · **跨平台护栏：** `npm run check:linux`
- 仓库规范见 [AGENTS.md](AGENTS.md)：conventional commit（中文）、双语 README 必须保持同步、插件只消费公开 dsh host 服务、多会话并发走文件认领协议。

---

## 📄 许可证

MIT — 见 [LICENSE](LICENSE)。
