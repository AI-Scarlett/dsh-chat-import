<div align="center">

# 📥 DSH Chat Import

**Import 14 external agent conversation histories into DeepSeek Harness as full-fidelity, resumable sessions — and export / sync back to Claude Code.**

This public fork ([AI-Scarlett/dsh-chat-import](https://github.com/AI-Scarlett/dsh-chat-import)) adds two-way incremental sync (Claude / Codex / Grok) and a Web control panel. Upstream: [Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import).

[![English](https://img.shields.io/badge/Language-English-blue?style=for-the-badge)](#)
[![简体中文](https://img.shields.io/badge/Language-简体中文-blue?style=for-the-badge)](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/dsh-chat-import?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-chat-import)
[![npm downloads](https://img.shields.io/npm/dm/dsh-chat-import?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-chat-import)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Node.js >= 22.13](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/Nwflower/dsh-chat-import/ci.yml?style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/Nwflower/dsh-chat-import/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Nwflower/dsh-chat-import)
[![Listed in Awesome DeepSeek Harness](https://img.shields.io/badge/Listed_in-Awesome_DeepSeek_Harness-6A5ACD?style=for-the-badge&logo=awesome&logoColor=white)](https://github.com/0xsline/awesome-deepseek-harness)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![Listed in Awesome DSH Plugins](https://img.shields.io/badge/Listed_in-Awesome_DSH_Plugins-6A5ACD?style=for-the-badge&logo=awesome&logoColor=white)](https://github.com/Dominic789654/awesome-deepseek-harness)

[💡 Concept](#-concept) · [✨ Features](#-features) · [🗂 Supported sources](#-supported-sources) · [🚀 Quick start](#-quick-start) · [🛠 Usage](#-usage) · [🔑 Key behaviors](#-key-behaviors) · [🏗️ Tech Stack](#-tech-stack) · [🗺️ Roadmap](#-roadmap) · [🤝 Contributing](#-contributing)

</div>

> **14 agent sources, one plugin** — full-fidelity import into DeepSeek Harness, seamless resume, and export / sync back to Claude Code.

<div align="center">

<img src="./assets/image-20260814205401839.png" alt="Import sessions from multiple sources into the dsh sidebar panel" width="600" />

**Changelog:** [CHANGELOG.md](CHANGELOG.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)

</div>

---

## 💡 Concept

`dsh-chat-import` imports conversation histories from **Claude Code, Codex, ChatGPT, Cursor, Gemini, Reasonix, opencode, ZCode, Grok Build, OpenClaw, Pi Coding Agent, Hermes, Kimi CLI and DSH session logs** — tool calls, reasoning and all — as **full-fidelity, resumable DeepSeek Harness sessions**. Source files are read **read-only** (never rewritten), the DSH engine is never touched, and every import becomes a fresh session grouped into the workspace of its source `cwd`.

The reverse direction is covered too: `export_claude` serializes a DSH session back into a Claude Code JSONL transcript that Claude Code can load with `--resume` (read-only — your DSH log is never modified), and `sync_to_claude` incrementally appends a session's new turns back to a Claude Code file — guarded, never silently overwriting.

---

## ✨ Features

| Category | Feature | Description |
| --- | --- | --- |
| Import | **14 sources + local JSONL, one plugin** | One tool per source — from Claude Code JSONL and Codex rollouts to SQLite databases and session directories. |
| Import | **Full fidelity** | Tool calls & results, thinking blocks, titles, models and timestamps carry over wherever the source records them. |
| Import | **Batch import** | Point at a directory (or a whole database) and every file / conversation becomes its own session, with a per-file summary. |
| Resume | **Seamlessly resumable** | Open an imported session and keep chatting exactly where the source left off. |
| Resume | **Auto workspace grouping** | Sessions land in the workspace of their source `cwd` (falling back to the source file's directory when that path does not exist locally) — no more "ungrouped". |
| Reverse | **Export to Claude Code** | `export_claude` writes any DSH session (imported or native) to `<outputDir>/<slug>/<uuid>.jsonl`, ready for `--resume`. |
| Reverse | **Sync back** | `sync_to_claude` appends a session's new complete turns to its Claude Code file — guarded, never overwriting. |
| Protection | **Idempotent + incremental** | Re-importing an unchanged source skips it; a grown source appends only its new turns. |
| Protection | **Context budget protection** | Oversized sessions are trimmed to fit a safe context budget, and the trim is reported. |

---

## 🗂 Supported sources

| Source | Storage location | Import tool |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `import_claude` |
| **Codex / ChatGPT CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `import_codex` |
| **ChatGPT** (web export) | anywhere you saved the export — `conversations.json` | `import_chatgpt` |
| **Cursor** | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `import_cursor` |
| **Gemini CLI** | `~/.gemini/history/<slot>/chats/session-*.json` | `import_gemini` |
| **Reasonix** | `~/.reasonix/sessions/desktop-*.jsonl` | `import_reasonix` |
| **opencode** | `~/.local/share/opencode/opencode.db` | `import_opencode` |
| **ZCode** (z.ai CLI) | `~/.zcode/cli/db/db.sqlite` | `import_zcode` |
| **Grok Build** | `~/.grok/sessions/<project>/<session_id>/` | `import_grokbuild` |
| **OpenClaw** | `~/.openclaw/agents/<agent>/sessions/*.jsonl` | `import_openclaw` |
| **Pi Coding Agent** | `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl` | `import_pi` |
| **Hermes** | `~/.hermes/` (Windows `%LOCALAPPDATA%\hermes`) | `import_hermes` |
| **Kimi CLI** | `~/.kimi/sessions/<workdir-md5>/<sessionId>/wire.jsonl` | `import_kimi` |
| **DSH session logs** | `~/.dsh/sessions/<encoded-workspace>/<sessionId>/session.jsonl(.zstd)` | `import_dsh` |
| **Any local JSONL** | any `.jsonl` file / directory (auto-detected) | `import_local_jsonl` |

Each import preserves what the source actually records — session id, `cwd`, title, model, timestamps, tool calls & results, reasoning. Sources that record less import what exists; anything a format cannot preserve is explicitly flagged in the import report (e.g. Kimi sub-agent conversations mirrored into the parent wire as `SubagentEvent` are skipped — the parent's `Agent` tool call & result are kept, and a sub-agent's own `subagents/<agentId>/wire.jsonl` can be imported directly).

---

## 🚀 Quick start

**1. Install** — add the plugin to a profile:

```bash
dsh plugin --profile web add dsh-chat-import                    # npm package
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # local checkout (symlink)
```

**2. Import** — in any DSH session, import a single file or a whole directory (the same call shape works for all 15 import tools — see the table above):

```
import_claude({ path: "~/.claude/projects" })
```

**3. Resume** — refresh the session list once, open the imported session, and continue chatting — it resumes exactly where the source left off.

**4. Two-way incremental sync (local fork)** — the sidebar **Import Sessions** panel now has a **Sync** tab:

- **External → DSH**: periodically scan Claude / Codex / Grok for new or grown sessions and import incrementally (same idempotent append state machine).
- **DSH → External**: write new complete DSH turns back. Imported sessions append to their source file; native DSH sessions get a copy under that agent's default root.
- Both directions are **off by default**. Turn them on in the panel, or click **Sync now**. Config lives in `$DSH_HOME/dsh-chat-import/sync.json`.
- On rc.8, outbound sync compares the lightweight `sessionPersistence.listSnapshots()` revision before reading a log. Unchanged sessions are not loaded; first-run / changed work is bounded to **25 sessions per cycle** by default (configurable from 1–500), and `outbound.json` is committed once per cycle.

<details>
<summary><b>Uninstall</b></summary>

`dsh plugin` folds the plugin's bundle declaration into the profile; the plugin becomes active after restarting dsh. To uninstall, remove the `import-claude` insert line from the profile's bundles and restart dsh. Already-imported sessions stay in the DSH data directory and are unaffected.

</details>

---

## 🛠 Usage

> **Note:** imports persist to disk immediately, but the DSH session list does not auto-refresh — refresh the page (or the session list) after importing to see the new sessions.

**Import — a single file or a directory.** Every `import_*` tool takes a `path`; directories are scanned recursively and each file / conversation becomes its own session:

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_codex({ path: "C:\Users\<you>\.codex\sessions\2026\05\18\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\Users\<you>\Downloads\chatgpt-export\conversations.json" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
```

`import_local_jsonl({ path })` accepts any local `.jsonl` session file (or directory): it auto-detects `dsh` / `claude` / `codex` / `cursor` / `reasonix` / `pi` / `openclaw` / `hermes`, and the `format` parameter forces one parser when detection is wrong:

```
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
import_local_jsonl({ path: "D:\downloads\unknown.jsonl", format: "claude" })
```

`import_chatgpt` / `import_opencode` / `import_zcode` / `import_hermes` always return a batch result — one file / database holds all conversations, so each conversation becomes its own session in a single call.

<details>
<summary><b>Import parameters & behaviors</b></summary>

- `preview: true` (alias `dryRun: true`) — run the import **read-only**: resolve, read and convert exactly like a real import, but persist nothing (zero side effects). Drop the flag and call again to actually import.
- `force: true` — create a **fresh full copy** under a new id (`import-<sessionId>-<n>`) even when the source was already imported; the old session is never modified.
- `sessionId` (optional) — override the target DSH session id (default `import-<source sessionId>`).
- **Archived sessions are re-importable** — DSH's archive hides a session from the sidebar but keeps it (and its id) in persistence, so the panel and `scan_discover` now report an archived target as **已归档 / Archived** with a re-import button. Importing again creates a fresh copy under a new id (`import-<sessionId>-<n>`, same minting as `force`) without touching the archived session; the same applies per-session inside multi-session sources (chatgpt / opencode / zcode / hermes DBs).
- **Incremental re-import** — re-importing the same source never rewrites imported history. Unchanged files are skipped (`already-imported`) without re-reading; grown files append only their **new turns** to the same session (`appended`); truncated files are detected and reported (`sourceShrunk`) — use `force: true` for a complete fresh copy:

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
// unchanged → "already-imported" · grew → "appended" (new turns only)
```

</details>

Every import result reports its `status` and any anomalies — malformed lines, suspected secrets, per-source drops — nothing is silently swallowed.

### import_agents — convert pi/opencode agents & prompts into DSH skills

`import_agents` converts custom agents, mode prompts and skills from **pi** (`~/.pi/agent/{agents,prompts}/*.md`) and **opencode** (`~/.config/opencode/{agents,skill}/*.md`) into **persistent DSH skill assets** — `$DSH_AGENTS_HOME/skills/<name>/SKILL.md` (`$DSH_AGENTS_HOME` defaults to `~/.agents`), so they become discoverable skills in any session. This complements the runtime-only Claude bridge (`context-bridge`, off by default): that one injects Claude memory/CLAUDE.md/skills transiently; this one persists pi/opencode assets.

By default it **dry-runs** (returns the write/complete/skip plan with zero side effects); pass `apply: true` to actually write:

```
import_agents()                    // dry-run: plan only
import_agents({ apply: true })     // write $DSH_AGENTS_HOME/skills/<name>/SKILL.md
```

Semantics: same-name conflicts across sources get a `-pi` / `-opencode` suffix; identical content is skipped (idempotent); sources already carrying `kind: dsh`/`kind: skill` frontmatter are not re-imported; a bundle directory that lacks `SKILL.md` is completed in place (preserving existing `scripts/` etc.); nested YAML (e.g. `permission:`) is preserved.

### scan_discover — read-only session discovery

`scan_discover` scans the known data roots of all 14 formats and returns a structured session index (title, project, path, import status) so you can preview before a batch import. Zero side effects:

```
scan_discover()
scan_discover({ path: "~/.codex/sessions", format: "codex", query: "import" })
```

### list_imported_sessions & retract_import — identify & retract

`list_imported_sessions()` enumerates every DSH session this plugin has imported; `retract_import({ sessionId })` (or `sourcePath`) removes its registry record and returns manual-deletion guidance. **Identification and guided manual deletion only — nothing is ever deleted**:

```
list_imported_sessions()
retract_import({ sessionId: "import-019f5f27-…" })
```

### export_claude — DSH → Claude Code JSONL

`export_claude({ sessionId })` serializes an existing DSH session (imported or native) into a Claude Code JSONL transcript, ready for `--resume`. It is written to `<outputDir>/<slug>/<uuid>.jsonl` (default `~/.claude/projects`), with a fresh UUID v4 file name — an existing file is never overwritten:

```
export_claude({ sessionId: "import-019f5f27-…" })
export_claude({ sessionId: "…", outputDir: "D:\backup\claude-projects", dryRun: true })
```

### sync_to_claude — incremental write-back

`sync_to_claude({ sessionId })` appends a session's **new complete turns** back to its Claude Code file — `target: "source"` by default (the import source) or `"copy"` (the last `export_claude` copy). Guards report an externally modified or shrunken file instead of overwriting it; `force: true` re-anchors past external edits (the overridden guard is still reported):

```
sync_to_claude({ sessionId: "import-019f5f27-…" })
sync_to_claude({ sessionId: "…", target: "copy", dryRun: true })
```

### Browser panel — discover & import from the sidebar

The dsh web sidebar shows a compact, icon-only **导入会话** button through rc.8's public `sidebar.footer.action` list slot. It uses no fixed overlay, DOM probing or replacement of the official `sidebar.settings` seat. The current rc.8 shell renders footer actions immediately **above** Settings; an exact after-Settings position needs a future public slot from DSH. The button opens a panel listing discovered sessions **grouped by workspace folder** (each source's `cwd`/project when available, otherwise an "(未分组)" bucket), with a source filter — "全部来源" scans every format's default data root, a single source restricts the view — and a per-session import-status badge (已导入 / 部分 / 未导入). A search box filters by title / workspace / path, and the list is **paginated** (50 per page) with selections kept across pages for bulk operations. The panel closes on `Escape`.

Each row supports **single import**, and the checkboxes enable **multi-select import** ("导入所选 (N)"): the panel calls the same host import pipeline as the `import_*` tools, so idempotent skip / incremental append / `force` / context-budget semantics are identical, and the list refreshes with the new statuses after importing. A multi-session source (e.g. `conversations.json`, an opencode/zcode/hermes DB) is imported whole — opencode/zcode restrict to the selected `sessionId`s.

> The data comes from the same read-only discovery as `scan_discover` (30s TTL cache + persistent mtime bookmarks); the panel itself never writes anything except the imports you trigger.

### `/import` slash command

The plugin also registers a **`/import <source> <path>`** slash command (available where the dsh `commands` service is mounted): type it directly in a session to import without a model round-trip — the same pipeline and the same idempotent / incremental / `force` / context-budget semantics as the `import_*` tools. `<source>` accepts the short name (`claude`, `codex`, …), the client source id (`claude-code`), or the full tool name (`import_claude`); `<path>` is a transcript file or a session directory / data root (single-file import vs. directory batch as usual).

### Session-start context enhancements

Two optional hooks run when a DSH session starts (the host `agent/session-start` event), both agent-scoped and never touching your transcripts:

- **Migration hint (default on)** — when the session's workspace has discoverable external history (already-imported or importable), a one-line `PromptContext` is injected telling the model how to continue (`/import <source> <path>` or the sidebar panel). Per-project memory shows the hint only once per workspace; set `DSH_IMPORT_SESSION_HINT=0` to disable.
- **Claude context bridge (default off)** — set `DSH_IMPORT_CONTEXT_BRIDGE=1` to bridge Claude Code context assets into the session: `~/.claude/memory/*.md` (grouped `feedback` > `project` > `reference` > `user`, 8 KiB cap, re-read via mtime cache), the project-root `CLAUDE.md`, and `~/.claude/skills/*/SKILL.md` (registered as `claude-<name>` skills on this agent only).

---

## 🔑 Key behaviors

- **Read-only import** — source transcripts and databases are never rewritten; imported DSH history is append-only (existing events are never modified).
- **Idempotent + incremental** — unchanged sources are skipped without re-reading; growth appends only the new turns; truncation is detected and reported.
- **Auto workspace grouping** — sessions are grouped into the workspace of their source `cwd`; when the `cwd` does not exist on this machine (common when migrating transcripts from another machine), the session falls back to the workspace of the **source file's directory** so it never disappears into "未分组".
- **Context budget protection** — imported sessions carry no provider configuration, so dsh never auto-compacts them; oversized sessions are trimmed to fit a context budget (per-message caps, then a compressed middle keeping the earliest prompts, a summary and the tail). The budget can be set per call or via the `DSH_IMPORT_CONTEXT_BUDGET` env var; the trim is always reported in the result.
- **Fail loudly, never silently** — malformed lines and suspected secrets are counted and reported by position (line numbers / kind — content is never output); anything a source format cannot preserve is explicitly flagged in the import report.
- **Sandbox** — reading source files or writing exports outside the workspace requires the session sandbox to allow the path.

---

## 🏗️ Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js ≥ 22.13 — pure ESM, zero build |
| Platform | DeepSeek Harness plugin — Cordis `everything-is-a-plugin`, consumes only public host services |
| Parsers | Claude/Codex/Cursor/Gemini/Reasonix/Pi/Kimi JSONL · ChatGPT JSON · opencode/ZCode/Hermes SQLite (`node:sqlite`) |
| UI | dsh web sidebar panel (hand-written CJS bundle) · i18n via `@deepseek-ai/dsh-client-locale` |
| CI | GitHub Actions — test / lint / `check:linux` cross-platform guard / headless smoke |

```
lib/
├── convert/          # pure per-source converters (zero DSH deps, unit-tested)
├── export/           # reverse serializer (DSH → Claude Code JSONL)
├── imports.mjs       # idempotent import registry
├── import-core.mjs   # shared import state machine
├── toolkit.mjs       # makeImportTool factory + IMPORT_SPECS
├── panel.mjs         # browser panel JSON routes
├── command.mjs       # /import slash command
├── prompt-hint.mjs   # session-start migration hint (REQ-53)
└── context-bridge.mjs # Claude memory / CLAUDE.md / skills bridge (REQ-28)
```

---

## ⚙️ Compatibility

Targets the `dsh 0.1.x` line (`dsh-tools >=0.1.0-rc.8 <0.2.0`, tested on `dsh 0.1.0-rc.8`) and requires **Node.js >= 22.13** (the first release where `node:sqlite` is available without a flag). `npm test` — 414 cases.

---

## 🗺️ Roadmap

- [x] 14 import sources + reverse export / sync back to Claude Code
- [x] Browser import panel + `/import` slash command + session-start migration hint & context bridge
- [ ] Interchange IR v1 + portable backup bundle (REQ-18 / REQ-56)
- [ ] `/import-all` batch command · Codex App Server API source (REQ-52)
- [ ] More sources: Reasonix desktop, Claude-3p · Hermes lineage (REQ-45 / REQ-51)

---

## 🤝 Contributing

Contributions are welcome — fork the repo, create a `feature/<name>` branch, and open a PR.

- **Tests:** `npm test` · **Cross-platform guard:** `npm run check:linux`
- Repo conventions live in [AGENTS.md](AGENTS.md): conventional commits (Chinese), bilingual README must stay in sync, plugin consumes only public dsh host services, multi-session coordination via the file-claim protocol.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
