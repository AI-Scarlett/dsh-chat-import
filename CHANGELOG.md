# Changelog

All notable changes to `dsh-chat-import` are documented here, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every entry maps to commits in the repository history
(`git log --oneline --no-decorate`); the 0.1.0 boundary is anchored to the first
npm publish timestamp (cross-checked with `npm view dsh-chat-import time`).
Release dates are the npm publish timestamps in Asia/Shanghai (UTC+8).

## [Unreleased]

### Fixed

- 0.4.2: adapt session reads and durable import writes to DSH 0.1.3-alpha.1 handles; emit self-contained synthesized format 2 imports and preserve legacy hosts. Close handles on failures and retain single-writer ownership errors.
- Enforce project identity before reading shared DSH logs and exclude reasoning blocks from shared text.

### Added

- **Same-project session sharing (0.4.0)** — two read-only model tools replace
  full transcript copying as the primary handoff path. `project_sessions_list`
  uses the current DSH session's canonical `cwd` to find exact-project Codex,
  Claude Code and DSH sessions and returns only short-lived opaque locators.
  `project_session_read` revalidates the source id and project, streams the
  selected source with a 64 MiB scan cap, and returns at most 24 user/assistant
  messages / 24,000 characters. Reasoning, tool results and injected context
  are excluded; common credential shapes are redacted. Source paths and full
  transcripts never enter the model result, and no DSH session copy is created.

- **Legacy two-way incremental sync control panel** — Settings gains a Legacy Sync tab
  (`GET/POST /api-import/sync`). Optional inbound watch (Claude / Codex / Grok
  new or grown sessions → DSH append) and outbound writeback (DSH complete
  turns → Claude source file, or Codex / Grok copies). Manual **Sync now**
  remains available. A periodic timer now also requires the explicit Host opt-in
  `DSH_CHAT_IMPORT_LEGACY_SYNC=1`, so a persisted older `enabled: true` config
  cannot silently restart background scans after upgrading. Outbound
  copies for native DSH sessions are tracked in `outbound.json` so inbound
  scans skip them (no echo loop).

- **`import_agents` (REQ-59, 14th tool)** — converts custom agents / mode
  prompts / skills from **pi** (`~/.pi/agent/{agents,prompts}/*.md`) and
  **opencode** (`~/.config/opencode/{agents,skill}/*.md`) into persistent DSH
  skill assets (`$DSH_AGENTS_HOME/skills/<name>/SKILL.md`, default
  `~/.agents`). Dry-run by default (plan only, zero side effects); `apply:
  true` writes. Same-name conflicts get a `-pi`/`-opencode` suffix, identical
  content is skipped, `kind: dsh|skill` sources are not re-imported, bundle
  dirs lacking `SKILL.md` are completed in place, and nested YAML is preserved.
  Complements the runtime-only Claude bridge (`context-bridge`, REQ-28).
- **Local JSONL session-file import (auto-detect)** — new
  `import_local_jsonl` tool accepts any local `.jsonl` file or directory and
  auto-detects the transcript structure across `dsh` / `claude` / `codex` /
  `cursor` / `reasonix` / `pi` / `openclaw` / `hermes` (path hints order the
  candidates; the first converter that yields a session wins), with an
  optional `format` parameter to force one parser. Directory mode imports
  every `.jsonl` as its own session through the same idempotent/incremental
  state machine.
- **DSH session-log source (14th import source)** — new `import_dsh` tool
  imports DeepSeek Harness' own session logs (`session.jsonl` and
  `session.jsonl.zstd`, default root `~/.dsh/sessions`), decompressing zstd
  logs with the system `zstd` binary and keeping the durable
  turn/step/user/assistant/tool events while streaming chunks and runtime
  state events are dropped. `scan_discover`, the sidebar panel source filter
  (`dsh`), `/import dsh <path>` and `format: 'dsh'` cover the new source too.
- **Kimi CLI source (REQ-14, 13th import source)** — new `import_kimi` tool
  imports Moonshot AI's open-source terminal agent sessions from
  `~/.kimi/sessions/<workdir-md5>/<sessionId>/wire.jsonl` (single session
  directory or a whole `sessions/` tree), mapping the wire event stream —
  `TurnBegin` / `SteerInput` user inputs, `TextPart` / `ThinkPart` content
  (streamed chunks merged), `ToolCall` / `ToolResult` tool calls & results
  (paired with `sourceEventSeqs`), status/control events filtered, and
  `SubagentEvent` sub-agent mirrors skipped & counted — onto the shared turns
  IR. Titles come from `state.json` `custom_title` (authoritative) with the
  first user text as fallback; `cwd` resolves via `~/.kimi/kimi.json`
  (workdir → md5 directory name); idempotent skip / incremental append /
  context-budget trim are identical to the other 12 sources. `scan_discover`,
  the sidebar panel filter and `format: 'kimi'` cover the new source too.
  `npm test` — 367 cases.

- **Import panel follows the DSH web language (zh / en)** — every panel string
  (trigger title/label, panel title, source filter, search, select-all,
  pagination, import-status labels, per-item buttons and result summaries) moved
  from hardcoded Chinese into a `chat-import` dictionary registered with
  `@deepseek-ai/dsh-client-locale` (`LocaleRuntime.register`), switching live
  with the web UI's language via `subscribe`. Missing `locale` service degrades
  to the built-in zh dictionary (previous behavior). The bilingual README
  tagline is corrected to 12 sources.

### Changed

- **Reference instead of copy by default (0.4.0)** — full `import_*`, export and
  sync capabilities remain available for explicit migration workflows, while
  same-project continuation uses metadata-only listing and one bounded,
  on-demand read. The Settings UI labels copy/sync operations as legacy and
  points users to the project-sharing flow.

- **Zero-I/O session-start hint (0.4.0)** — replaces the old startup discovery
  scan and `hints.json` write with one small scoped instruction that tells the
  model to prefer project sharing. External roots are touched only after an
  explicit `project_sessions_list` call.

- **DSH rc.8 Settings entry (0.3.3)** — removes the sidebar footer button and
  registers one `settings.section` named **导入会话**. rc.8 does not expose a
  supported slot after the Settings button, so this is the approved fallback;
  no official DOM or DSH package is modified.

- **Bounded rc.8 outbound sync** — automatic writeback now uses
  `sessionPersistence.listSnapshots()` and persists each target's opaque source
  revision. Unchanged sessions skip `readFrom()` entirely; first-run / changed
  sessions are capped at 25 per cycle by default (configurable from 1–500), and
  all mapping changes are committed to `outbound.json` in one atomic write per
  cycle instead of one read/write transaction per session.
- **Compact official-slot sidebar entry** — the import panel trigger is now an
  icon-only `sidebar.footer.action` entry ordered after other footer actions.
  The old fixed overlay, Cordis badge DOM query and `MutationObserver` were
  removed. The plugin does not replace `sidebar.settings`; rc.8 currently
  renders its public footer-action slot immediately above Settings, and exposes
  no supported after-Settings slot.

### Fixed

- **Archived imported sessions can be re-imported (REQ-55)** — previously the
  import status was derived purely from the imports registry, so after
  archiving an imported DSH session (hidden from the sidebar; the session and
  its id remain in persistence) the panel and `scan_discover` still reported
  it as `imported` and a re-import was skipped as already-imported. Both layers
  now consult the workspace registry's global archive set
  (`workspaceRegistry.archivedSessionIds`):
  - discovery reports such sessions as a new **`archived`** status (已归档 /
    Archived badge) and the panel shows the **导入** button instead of the
    sync-only row, so the source is re-importable;
  - re-importing an archived target creates a fresh copy under a suffixed id
    (`import-<sessionId>-<n>`, same minting as `force`), leaving the archived
    session untouched, for single-file sources (all 13) and per-session inside
    multi-session sources (chatgpt / opencode / zcode / hermes db); the
    registry record points at the new copy. `scan_discover`'s `importStatus`
    enum and summary include `archived`.
  `npm test` — 385 cases.

## [0.3.1] - 2026-08-14

### Added

- **Browser-side session discovery & import panel (REQ-41)** — the dsh web
  sidebar gains an **导入会话** entry (a `sidebar.footer.action` list slot; the
  client is a hand-written CJS bundle `lib/client.js` declared via `dsh.client`
  in `package.json`). Stage 1 added the read-only discovery panel — a source
  filter + session list backed by the new host route `POST /api-import/sessions`
  (the same discovery as `scan_discover`: 30s TTL cache + persistent mtime
  bookmarks, zero side effects). Stage 2 adds **workspace-folder grouping**
  (sessions grouped by each source's `cwd`/project, "(未分组)" bucket),
  **single import** and **multi-select import** (checkbox + "导入所选 (N)") via
  the new host route `POST /api-import/import`, which reuses the exact
  `import_*` tool pipeline — idempotent skip / incremental append / `force` /
  context-budget semantics are identical, multi-session sources
  (`conversations.json`, opencode/zcode/hermes DBs) import whole-source
  (opencode/zcode restrict to the selected `sessionId`s), and the list refreshes
  with the new statuses after importing. The `pi` source joins the panel filter,
  and the `source` filter may be omitted to scan all formats at once. Stage 3
  adds **search** (by title / workspace / path, server-side filtered) and
  **pagination** (50 per page, `offset`/`limit` + `total` from
  `/api-import/sessions`), with selections kept across pages for bulk imports.

### Changed

- **Export serializer split into `lib/export/`** — the reverse-export
  serializer (DSH session events → Claude Code JSONL) moved from the root
  `export.mjs` into `lib/export/claude.mjs`, mirroring how `convert.mjs` keeps
  its implementation in `lib/convert/`. The root `export.mjs` is now a
  re-export shim, so the `exports["./export.mjs"]` subpath contract and every
  existing `import` stay intact; `lib/export/` is reserved per target format
  (future REQ-23 interchange targets).

- **Cross-platform path discipline guard — `npm run check:linux`** — CI's
  `npm test` (ubuntu / node 22) used to stay red while the suite passed on
  Windows: tests build synthetic trees with backslash paths while the code's
  `join()` produces mixed separators under posix, so bare mock `tree[key]`
  lookups missed on Linux, and assertions compared `node:path` results against
  hardcoded `X:\…` literals. The new static guard (`.github/scripts/
  check-linux-compat.mjs`, run in CI after lint) fails on those two
  anti-patterns; all mock `stat`/`readText`/`listDir` lookups now normalize
  separators (three-way `norm` + `lookup`, uniform across `index`/`req26`/
  `req33`/`zcode` test mocks). Also documented in `AGENTS.md` (命令 /
  提交纪律 / 质量约定) and available as a local pre-push hook
  (`git config core.hooksPath dev/hooks`).
- **Sidebar trigger restyled to match the Settings entry, with the plugin logo
  as its icon** — the floating **导入会话** trigger (fixed overlay so the
  full-width Cordis badge can never squeeze it out) now uses the same visual
  language as the sidebar's **设置** button: transparent background, 12px
  radius, 16px icon + 14px label, subtle hover; the text glyph was replaced by
  an inline render of `assets/import.svg` (currentColor, so it follows the
  light/dark theme). Dimensions and typography are matched pixel-for-pixel with
  the Settings entry (full-width 264×34, 22px line height, `6px 2px 6px 10px`
  padding, 8px gap, and the same CSS variables for label color / hover
  background). Placement is now **conditional on the Cordis badge**: the button
  only floats above the footer while the official badge occupies the footer
  row; when the badge is hidden or absent it drops into the footer row itself
  (right above 设置), detected via `[data-cordis-badge]` visibility watched by a
  `MutationObserver`.
- **`index.mjs` split by responsibility into `lib/` host modules** — the plugin
  entry shrank from ~2500 lines to a 54-line composition that only assembles the
  pieces; every moved line is byte-identical (pure refactor, zero
  behavior change, verified by the full mock-integration suite). New layout:
  `lib/budget.mjs` (REQ-37 context-budget chain), `lib/import-core.mjs` (shared
  import orchestration: `importTranscript` state machine / `importDirectory` /
  `runDecision` / workspace attach / projection warm-up / standard previews),
  `lib/import-variants.mjs` (special-shaped sources: chatgpt / grokbuild /
  hermes orchestration + opencode / zcode dry-run previews), `lib/toolkit.mjs`
  (`makeImportTool` factory + `IMPORT_SPECS`), `lib/export-tool.mjs`
  (`export_claude` body), `lib/retract.mjs` (REQ-33 identify / retract),
  `lib/discovery-host.mjs` (REQ-25/40 `scan_discover` host adapter),
  `lib/panel.mjs` (REQ-41 panel routes), `lib/tools.mjs` (all 17 tool
  registrations). `package.json` `files` whitelist and `AGENTS.md` layout /
  DSH-dependency rules updated to match; the `index.mjs` public export surface
  (`apply` / `inject` / `name` / `readOpencodeDb` / `readZcodeDb` /
  `exportClaudeSession`) is unchanged.

### Fixed

- **Import panel: session list now scrolls; workspace groups collapse on click**
  — the session list lost its scroll container in the Stage-3 rewrite (groups
  were rendered straight into the fixed panel, so long lists overflowed past
  the viewport with no way to scroll; `clientH` vs `scrollH` mismatch). The
  list is a proper `flex:1; overflow-y:auto` container again, and the
  workspace-folder group headers (`▾`) now toggle collapse/expand on click.
- **Imported sessions stay findable when the transcript `cwd` does not exist
  locally (REQ-39-lite)** — `workspaceRegistry` only owns workspaces for
  directories that exist (`fs.realpath`); transcripts migrated from another
  machine carry cwds that do not exist here, so every such import silently
  landed in the collapsed "未分组" group and looked like "nothing was
  imported". `attachToWorkspace` now falls back to the **source file's
  directory** (the source directory itself when the source is a directory) as
  the workspace when the `cwd` cannot be resolved — e.g. a `conversations.json`
  without a cwd is grouped under its export directory. Opened sessions always
  render their messages (verified); this fixes their visibility in the sidebar.
- **Import panel reports actionable errors instead of a raw `Failed to execute
  'json'…Unexpected end of JSON input`** — the panel's `fetch` now reads the
  response as text and parses defensively: an empty / non-JSON response (e.g.
  the host route not being registered because the dsh process predates the
  `webServer`-optional fix) shows a clear hint ("路由可能未注册，请重启 dsh 后
  重试") instead of surfacing the browser's `Response.json()` exception.
- **Import-panel trigger no longer covered by other footer entries (REQ-41)** —
  `sidebar.footer.action` is a 256px flex row; the official Cordis plugin badge
  is a `flex: none; width: 256px` entry that occupies the whole row, squeezing
  any sibling entry out of the container where the sidebar's `overflow: hidden`
  clips it and the main content column covers it. The **导入会话** trigger is
  now rendered as a fixed-position floating pill above the sidebar footer
  (z-index above page content), so it stays visible and clickable regardless of
  other footer occupants (icon-only in rail mode). The panel also closes on
  `Escape` — its full-screen overlay previously had no keyboard escape and
  blocked the whole page while open.
- **`webServer` demoted from hard `inject` to an optional service** — REQ-41 had
  added `webServer` to the plugin's `inject` list, which made the whole plugin
  (all 12 import tools included) fail to activate in any dsh profile without a
  web server (headless CLI sessions, the CI headless smoke job). The
  `/api-import/*` panel routes are now registered through
  `ctx.inject(['webServer'], …)` — a callback Cordis starts once the service is
  available — so routes appear in web profiles (including when the web-server
  service mounts *after* this plugin's `apply`, which a plain `ctx.get` at apply
  time misses) while headless profiles never run the callback and the import
  tools stay available. Also regenerated `package-lock.json` so the REQ-41 peer
  dependencies (`@deepseek-ai/dsh-client-locale`, `react`) are recorded and
  `npm ci` stops failing with EUSAGE.
- **Tool registration fails loudly on a stale `@deepseek-ai/dsh-tools` copy** —
  the plugin now declares a named import of `TOOL_RUNTIME_SCHEDULER` (which only
  exists since `^0.1.0-rc.6`) and checks at registration time that it is the
  expected symbol. Resolving the old `dsh-tools@0.0.1-rc.1` ABI (which only
  exports `TOOL_REGISTRY_SCHEDULER`) now fails the module load / plugin
  activation immediately with a clear message, instead of silently registering
  tools against the old ABI and crashing the host agent-loop later
  (`Cannot read properties of undefined (reading 'prepare')`).

## [0.3.0] - 2026-08-14

Third minor release — shipped 2026-08-14 with four new import sources (Grok
Build, OpenClaw, Hermes, Pi Coding Agent — the 9th–12th), automatic session
discovery with persistent scan bookmarks, import identification / retraction,
zero-side-effect import preview, and the reverse export + incremental
write-back bridge (`export_claude` / `sync_to_claude`). Release tag `v0.3.0`
pending publish.

### Added

- **Imported-session listing + retract guidance — `list_imported_sessions` /
  `retract_import`** (REQ-33) — a new read-only pair of tools: `list_imported_sessions`
  enumerates every DSH session imported by this plugin (the `session/imported`
  marker at `seq 0` is the authoritative signal; the imports-registry `dshId` set
  is the fallback when a session log cannot be read — sessions without a marker
  never appear), returning `sessionId` / `title` (when an explicit title exists) /
  `sourcePath` / `artifactPath` (`sessionPersistence.locate`) / `importedAt`;
  `retract_import` (`sessionId` or `sourcePath`, one of the two) removes the
  imports-registry record and returns the manual-delete artifact guidance
  (`manualDelete`) — nothing is ever deleted, because the platform has no delete
  surface (`sessionPersistence.remove` / `fs.removeFile` do not exist). The marker
  stays in the log, so re-retracting the same session is idempotent
  (`wasRegistered: false` on a repeat call); delete the artifact manually first,
  then a re-import creates a genuinely fresh full copy.
- **Persistent scan bookmarks — `scan_discover`** (REQ-40) — `scan_discover`
  now persists mtime/size bookmarks to `scan-cache.json` under
  `$DSH_HOME/dsh-chat-import/` (the same directory as the imports registry),
  partitioned per format as `<sourcePath> → { mtimeMs, sizeBytes, entries }`:
  unchanged files are not re-scanned across process restarts, on top of the
  in-process 30s TTL cache. Writes are atomic (temp + fsync + rename); a
  corrupted or missing cache falls back to a full scan with a warning and never
  affects results.
- **Automatic session discovery — `scan_discover`** (REQ-25) — a new
  read-only tool that scans the known data roots of all **12 source
  formats** (Claude / Codex / ChatGPT CLI / Cursor / Gemini / Reasonix /
  opencode / ZCode / Grok Build / OpenClaw / Pi Coding Agent / Hermes,
  plus ChatGPT web exports) and returns a structured session index
  (`format` / `sessionId` / `title` / `project` / `createdAt` /
  `lastActiveAt` / `messageCount` / `sourcePath` / `importStatus`) for
  previewing before a batch import. Optional `path` (scan root or single
  file), `format` (restrict one format) and `query` (title / project /
  path substring filter) parameters; zero side effects (no `create` /
  `append`, no registry writes, no workspace attach); injection-filtered
  title extraction and an in-process **30s TTL scan cache** (a same-key
  re-scan within 30s hits the cache without re-reading source files).
- **Malformed-line line numbers + secret locations + permission counts**
  (REQ-26) — import reports now carry `skippedLines` (malformed-record
  details `{ line, error }`, line numbers from 1 — count unlimited,
  detail list capped at 200), `secrets` (suspected-secret locations
  `{ line, kind }` — position only, content is never output) and
  `permissionCount` (Claude-source permission records, counted only),
  alongside the existing `skipped` count.
- **Zero-side-effect import preview — `preview` / `dryRun`** (REQ-17) —
  every `import_*` tool accepts `preview: true` (alias `dryRun: true`):
  the source is resolved / read / converted exactly like a real import
  but nothing is persisted (no `create` / `append`, no registry read or
  write, no workspace attach). It returns the same `mode` / `total` /
  `results` skeleton with a `preview: true` marker and no write-state
  fields; each entry carries the would-be session's title / `cwd` /
  creation time / scale (turns / messages / tool calls) and skip details.
- **Grok Build source import** (`import_grokbuild`) (REQ-46) — the 9th import
  source: reads `~/.grok/sessions/<project>/<session_id>/` session
  directories (archived ones under `~/.grok/archived_sessions/`), each holding
  `summary.json` (`info.id` / `info.cwd`, `generated_title`,
  `session_summary`, timestamps) + `chat_history.jsonl` (`user` /
  `assistant` / `tool` / `system` / `reasoning` records with string or
  Claude-style block `content`). `reasoning` (encrypted internal state) and
  `system` (harness injection) records are filtered and counted; `tool_use` /
  `tool_result` pair by `tool_use_id` back to the declaring step (cross-step
  async results included), orphan results dropped and counted; titles resolve
  `generated_title` > `session_summary` (pinned) with a first-question
  fallback; `provider='grokbuild'`. A single session directory imports as one
  session, a `sessions` / `archived_sessions` root scans recursively (batch).
- **OpenClaw source import** (`import_openclaw`) (REQ-47) — the 10th import
  source: reads `~/.openclaw/agents/<agent>/sessions/*.jsonl` (one session
  per file) with `{type:"session", id, cwd, timestamp}` metadata lines and
  `{type:"message", message:{role, content}}` messages; the `toolResult`
  role pairs results back to their `tool_use` (by `tool_use_id`, or the most
  recent unresolved call for plain-text results), `[message_id: …]` gateway
  suffixes are stripped, and results in one step are ordered to match the
  step's calls; a sibling `sessions.json` index supplies the `displayName`
  used as the pinned title (fallback: first user text, then the `cwd`
  basename); `provider='openclaw'`.
- **Hermes source import** (`import_hermes`) (REQ-48) — the 11th import
  source: reads `~/.hermes/` (Windows `%LOCALAPPDATA%\hermes`) history —
  `state.db` (SQLite `sessions` + `messages` tables, the authority index;
  column variants `cwd`/`directory`, `started_at`/`created_at`,
  `ended_at`/`updated_at`, messages ordered by time) is read first, with a
  `sessions/*.jsonl` fallback (flat `{role, content, ts}` or nested
  `{type:"session"|"message", message, timestamp}`) when the DB is
  unavailable. `thinking` → `reasoning`, `tool_use` / `tool_result` pair by
  `tool_use_id` back to the declaring step; `provider='hermes'`. A
  `state.db` always returns the batch shape (one DB holds all sessions); a
  lone `.jsonl` imports as a single session.
- **ZCode source import** (`import_zcode`) (REQ-38) — the 8th import source:
  reads the z.ai official CLI's `~/.zcode/cli/db/db.sqlite` (SQLite authority
  index) read-only via `node:sqlite`; the `message` / `part` rows carry no
  `sequence` column, so the message stream is rebuilt by
  `ORDER BY time_created, id`, and only main sessions (`parent_id IS NULL`)
  are imported. `compaction` parts restore their compressed summary
  (`data.summary.body`) as a leading `reasoning` block (the compaction body
  itself never enters the conversation), tool parts emit `tool/call` +
  `tool/result` in pairs (`state.output` inline), `<system-reminder>`
  injections are filtered, and `provider='zcode'`. When the DB is unavailable
  the import falls back to the legacy `transcript.jsonl` (last `model_request`
  messages, tool results back-filled into the tool part's `state.output`).
  One DB holds all sessions, so the tool always returns the batch shape
  (`zcode://<id>` pseudo-path / `sessionIds` filtering, DB-level
  fingerprinting, per-session append / `sourceShrunk`).
- **Title fallback** `custom-title > ai-title > first question` (REQ-27) —
  every source now resolves its session title by priority: `custom-title` >
  `ai-title` (Claude) / the source-recorded title (ChatGPT, opencode, ZCode,
  Reasonix meta summary) > the first user prompt as a fallback; titles are
  normalized (trim, collapse inner whitespace) and truncated at 80 characters
  (an ellipsis is appended on overflow). Explicit titles are still pinned with
  a `session/title` event; a pure first-question fallback only fills the title
  field without writing an event (DSH auto-falls back to the first user text
  for untitled sessions), and blank titles never emit a title event.
- **Codex `custom_tool_call` JS arguments → standard JSON** (REQ-44) — 2026+
  Codex writes `custom_tool_call.input` as JS code (e.g.
  `tools.exec_command({cmd: "...", workdir: "..."})`); the importer now
  recognizes the object-literal call shape and converts it to standard JSON
  arguments so the model never learns a JS/XML hybrid call format.
  Unconvertible shapes (`apply_patch`, `ALL_TOOLS` dynamic calls) degrade to a
  descriptive note text instead of passing JS code through as `arguments`;
  conversion failures are counted (`droppedMalformedArgs`) and never break the
  message stream.
- **Pi Coding Agent import — `import_pi`** — the 12th import source:
  imports Pi Coding Agent session
  JSONL (`~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`) as
  resumable DSH sessions: header `id`/`timestamp`/`cwd` → session id / creation
  time / workspace grouping, the tree structure rebuilt along the **active
  branch only** (last entry → root walk via `id`/`parentId`; v1 linear files
  chain in file order), `toolCall`/`toolResult` paired by `toolCallId` (orphan
  results dropped and counted), `thinking` → `reasoning`, and
  `bashExecution` / `custom` / `branchSummary` / `compactionSummary` injected
  messages mapped with Pi’s own `convertToLlm` wording onto the adjacent
  assistant step. Context compaction is respected by default (last summary +
  `retainedTail` / legacy `firstKeptEntryId` range + tail) with an optional
  `fullHistory: true` (part of the import-args fingerprint → `argsChanged` on
  a value switch), `session_info` name → title, `model_change` / per-message
  model → session / step model. Single-file and recursive-directory modes,
  idempotent re-import, incremental append and budget trimming reuse the
  shared import machinery. `scan_discover` gains the `pi` format (root
  `~/.pi/agent/sessions`, header `version` as the format signature,
  `session_info` name → title).
- **Pi converter unit + integration coverage** — synthetic fixtures
  (`pi-simple` / `pi-tool` / `pi-branch` / `pi-compaction` / `pi-v1`) covering
  turn balance, tool pairing, active-branch walk, branch-summary reasoning,
  compaction default vs `fullHistory`, v1 linear fallback and malformed-input
  skipping; `import_pi` integration tests cover persist + workspace attach,
  directory batch import, idempotency and the `fullHistory` args fingerprint.

- **Incremental re-import** (REQ-24) — re-importing the same source path no
  longer just skips: a grown source file appends only its **new turns** to the
  same DSH session (contiguous `seq` continued from the authoritative stored
  log, source turn numbering, no duplicated `session/imported` marker or
  title), an unchanged file is skipped on a stat-level short path without
  re-reading it, a truncated file is detected and reported (`sourceShrunk`),
  in-place growth inside existing turns reports `changedInPlace`, and
  `force: true` creates a fresh full copy under `import-<sessionId>-<n>` while
  the old session stays untouched.
- **Source-path idempotency registry** — new `lib/imports.mjs` persists
  `$DSH_HOME/dsh-chat-import/imports.json` (source absolute path → import
  record, `{ kind, dshId, turns, events, sizeBytes, version, args, importedAt }`)
  with atomic temp+fsync+rename writes via `node:fs/promises` (never `ctx.fs`),
  in-process serialized writes, and missing/corrupted-file tolerance. Two
  different source paths sharing one session id now both import (suffix
  avoidance) instead of one silently shadowing the other; sessions imported
  before the registry existed are detected via the `session/imported` marker
  and back-filled (`backfilled`).
- **Projection-cache warm-up on import** (external PR #1) — after a session is
  created, its projection cache is cold-read and written back so the sidebar
  shows the real title / model metadata immediately instead of the `cwd`
  directory name until the session is opened; a warm-up failure never affects
  the import result.
- **eslint flat config + CI lint** (REQ-10) — `eslint.config.mjs` added
  (dev-only, not shipped), `npm run lint` wired into CI, and existing
  violations fixed in the same commit.
- **`tailSessionEvents`** — pure event-level tail extraction in `convert.mjs`
  (slice by `turn/start` boundaries, renumber `seq` from `fromSeq`, remap
  in-tail `sourceEventSeqs`, keep out-of-tail references with a
  `droppedBoundaryResults` count, strip `session/title` by default).
- **Multi-session sources go incremental** — ChatGPT (`kind:'multi'` +
  `conversations` sub-records: per-conversation append / new / removed
  `missingFromSource`, `force` = full new copies) and opencode (`kind:'multi'` +
  `sessions` sub-records: DB-level version/size fingerprinting, compaction
  shrinking turns → `sourceShrunk`, `fullHistory` in the args fingerprint →
  `argsChanged`).
- **Shared `force: boolean` parameter** on all twelve import tools, and extended
  return shapes: single-mode `status` (`imported` / `already-imported` /
  `appended` / `skipped`) plus optional `appendedTurns`, `appendedEvents`,
  `appendedSkipped`, `sourceShrunk`, `changedInPlace`, `argsChanged`,
  `backfilled`, `forceImported` and `droppedBoundaryResults`; batch mode gains
  an `appended` counter, `appended` result status and `missingFromSource`.
- **Reverse export — `export_claude`** (REQ-16) — serializes an existing DSH
  session (imported or native, read-only via `sessionPersistence.list` +
  `readFrom`, never `load`/`prepare`, never rewritten) into a Claude Code
  JSONL transcript at `<outputDir>/<slug>/<uuid>.jsonl` (fresh UUID v4 file
  name plus a `createIfAbsent` write guard so an existing file is never
  overwritten; `dryRun` support). The pure serializer lives in the new
  `export.mjs` (zero DSH deps, injectable uuid for deterministic tests):
  user / assistant / `tool_result` records in `seq` order, tool results
  chained to the declaring assistant (`parentUuid` /
  `sourceToolAssistantUUID`, parallel results fan out to the same assistant),
  `thinking` from `reasoning` (empty `signature`), `ai-title` from the session
  title, trailing empty `tool_result` for interrupted calls, orphan results
  dropped and counted (`droppedToolResults`), non-human injections skipped and
  counted (`skippedInjections`), non-text blocks skipped and counted
  (`skippedBlocks`). The tool return carries a `mapping` shape
  (sourceSessionId → new UUID, file path, record counts) reserved for the
  reverse-sync registry (REQ-24/36); for imported sessions the mapping is now
  persisted into the registry (`record.exports`), which anchors the REQ-36
  `target: "copy"` write-back.
- **Reverse sync — incremental write-back `sync_to_claude`** (REQ-36) — the
  first step of the bidirectional sync bridge: appends a DSH session's **new
  complete turns** back to a Claude Code JSONL file (the import source with
  `target: "source"`, or the last `export_claude` copy with `target: "copy"`)
  so the file keeps being resumable. The pure core lives in the new
  `lib/backfill.mjs` (zero DSH deps, ctx-injected `fs` /
  `sessionPersistence`): the serializer is a shared-core variant
  (`serializeClaudeJsonlTail` — no mode / permission-mode / ai-title header,
  first record chained to the previous watermark's `prevUuid`,
  cross-watermark delayed tool results counted as orphans) fed by
  `tailClaudeEvents` (only turns closed by `turn/end`; half-open in-progress
  turns are dropped and reported as `incompleteFinalTurn`). The first sync
  baselines the watermark from the target file itself; afterwards three pure
  guards (`evaluateWritebackGuards`) plus a stored-log check refuse to
  overwrite: `sourceShrunk`, `source-modified-externally`, `tail-mismatch`,
  `write-version-mismatch` (CAS `replaceIfVersion`), `storedShrunk`,
  `source-missing` — `force: true` skips the guards and re-anchors the bridge
  to the file's current state. A `verifyClaudeJsonl` format pre-check rolls a
  bad write back and never advances the watermark. The registry record gains
  `writeback` (`{ sessionUuid, filePath, lastWrittenSeq, lastWrittenTurn,
  prevUuid, lastSize, lastVersion, writtenAt }`) with `turns` re-converted so
  a later re-import stays idempotent (no duplicate append). Multi-session
  sources and native sessions are rejected; `dryRun` computes everything
  without writing.
- **Oversized-session protection** (REQ-37) — three-layer guard for very long
  imports (without it an over-limit session fails with a 400 on resume when the
  model has no provider config and auto-compaction cannot engage): L1 crops
  individual content blocks (text / reasoning ≤ 16K chars, tool results ≤ 40K
  chars, keeping the head 75% + tail with a crop marker); L2 truncates turns to
  the resolved context budget (keeps the earliest 3 user texts as an anchor,
  prepends a compression summary as a `reasoning` block, keeps the tail
  greedily within the remaining budget); L3 drops any single message still over
  half the budget after cropping — the first turn's prompt is never dropped,
  oversized steps go with their tool calls, oversized tool results are replaced
  by empty ones — so a resumable conversation always survives. Sessions within
  budget are left intact except for L1 single-block cropping. The pure core
  lives in `convert.mjs` (`estimateTokens` — CJK 1 token/char, ASCII 1
  token/4 chars — plus `cropContentBlocks`, `trimTurns`, `applyBudgetTrim`) and
  is wired into all twelve sources before `synthesizeSession`; trimming reports
  `trimmed: null` when nothing was actually cut.
- **Adaptive import budget + explicit trim reporting** (REQ-37) —
  `resolveImportBudget` in `index.mjs` resolves the per-import context budget as
  tool parameter `budget` > env `DSH_IMPORT_CONTEXT_BUDGET` > dynamic model
  window (`agentDefaultModel.currentSelection()` + `llm.resolveModelInfo`
  minus the output cap and `max(25%, 40K)`) > static 550K default, silently
  falling back when any link is unavailable. Import reports gain a `trimmed`
  counter (budget, source, original / estimated tokens, cropped blocks, dropped
  turns / messages / tool calls / tool results, oversized drops, summary
  marker), and the imports registry records the budget so a budget change skips
  with `budgetChanged` (same semantics as `argsChanged`; `force: true`
  rebuilds).

### Fixed

- **`trimTurns` L2 anchor shrink silently dropped turns** (REQ-49) — when
  the whole turn list was within the 3-anchor minimum and the budget was
  so small that even the anchor plus summary allowance exceeded it, turns
  shrunk off the anchor tail vanished without being counted, so `trimmed`
  could report `null` despite real loss (violating "fail loudly"). Turns
  dropped by anchor shrink are now counted into `trimmed`
  (`droppedTurns` / `droppedMessages` / `droppedToolCalls` /
  `droppedToolResults`) so the report reflects the real loss; at least
  one resumable turn is still guaranteed.

### Changed

- Idempotency contract updated (bilingual README): "already imported → skip"
  becomes "already imported → skip if unchanged, incrementally append new
  turns if grown" — re-importing a live session now follows the source file.
- Append discipline: appended events keep `surfaceOp: 'append'`, never re-attach
  workspaces, and never re-emit the import marker or session title.
- **Conversion core split per source** (REQ-08) — `convert.mjs` became a
  re-export shim over `lib/convert/*.mjs` (a shared `core` plus one converter
  per source; pure functions, zero DSH deps), and opencode SQLite reading moved
  into `lib/opencode.mjs`. No tool names, schemas or return shapes changed; the
  npm `files` whitelist was extended for the new modules.
- **README slimmed to a user-facing document** — technical / engineering detail
  moved to the local, never-published `dev/REQUIREMENTS.md`; the tagline and
  badge area reworked for the 11-source line-up.


## [0.2.0] - 2026-08-14

Second minor release — shipped 2026-08-14 with two new import sources
(Reasonix, opencode), engineering guardrails (clean lockfile and CI checks,
package metadata) and P0 fixes that keep imported sessions resumable. Tagged
`v0.2.0` (`ae01548`).

### Added

- **Reasonix session import** (`import_reasonix`) — OpenAI-style JSONL sessions
  with v1/v2 `tool_calls`, sibling meta-file for `cwd` and a pinned title, and a
  filename-embedded creation-time fallback ([b50b1cd](https://github.com/Nwflower/dsh-chat-import/commit/b50b1cd)).
- **opencode session import** (`import_opencode`) — reads the SQLite
  `session`/`message`/`part` tables with inline tool results, respects opencode
  conversation compaction by default, supports `sessionIds` and `fullHistory`
  ([02a87a2](https://github.com/Nwflower/dsh-chat-import/commit/02a87a2)).
- **`package-lock.json` for reproducible CI installs**, with the npm cache
  re-enabled in CI ([651f202](https://github.com/Nwflower/dsh-chat-import/commit/651f202), [67f7c2b](https://github.com/Nwflower/dsh-chat-import/commit/67f7c2b));
  later regenerated clean, with CI moved to `npm ci` and a lockfile-drift check
  added ([0389307](https://github.com/Nwflower/dsh-chat-import/commit/0389307)).
- **Awesome-list badges** on the bilingual READMEs ([1f1e7ce](https://github.com/Nwflower/dsh-chat-import/commit/1f1e7ce), [e1d3faa](https://github.com/Nwflower/dsh-chat-import/commit/e1d3faa)).
- **CHANGELOG itself** — 0.1.0 / 0.1.1 / 0.2.0 sections following Keep a
  Changelog, shipped in the npm package ([f9a1918](https://github.com/Nwflower/dsh-chat-import/commit/f9a1918)).
- **Bilingual README structure sync check in CI** — heading hierarchy and
  anchor keys compared between `README.md` and `README.zh-CN.md`
  ([a12480d](https://github.com/Nwflower/dsh-chat-import/commit/a12480d)).
- **Headless real-load smoke job in CI** — boots the plugin with a mock LLM to
  verify it activates outside the live harness ([0e8bdd7](https://github.com/Nwflower/dsh-chat-import/commit/0e8bdd7)).

### Fixed

- **Imported sessions stay resumable when a `tool/call` has no matching
  result** (P0) — model APIs reject an assistant message whose `tool_calls`
  never get a corresponding tool message, so a synthetic empty `tool/result` is
  appended to keep continuation working ([1d9a8e5](https://github.com/Nwflower/dsh-chat-import/commit/1d9a8e5)).
- **Imported message order follows the wire rules** (P0) — `tool/result` is
  attached to the step owning its `tool/call`, and Codex imports gain the
  missing tool-call block, so the projected order no longer violates the
  assistant-`tool_calls`-then-tool-message contract and sessions stay resumable
  ([d13f790](https://github.com/Nwflower/dsh-chat-import/commit/d13f790)).
- **Claude directory imports only recognize the main transcript** — subagent /
  workflow fragments are skipped so they can never shadow or collide with the
  main conversation ([77de7cd](https://github.com/Nwflower/dsh-chat-import/commit/77de7cd)).
- **`tool/result` links its `tool/call` across steps** — `sourceEventSeqs` now
  points at the originating call even when the result lands in a later step
  ([f33824d](https://github.com/Nwflower/dsh-chat-import/commit/f33824d)).
- **Reasonix creation-time falls back to the filename timestamp** when neither
  the transcript nor the meta file carries one ([bf8b05e](https://github.com/Nwflower/dsh-chat-import/commit/bf8b05e)).
- **opencode directory import joins paths portably** instead of hard-coding a
  separator ([72238ba](https://github.com/Nwflower/dsh-chat-import/commit/72238ba)).

### Changed

- **README rewritten (bilingual)** around quick start, features and a 7-source
  overview table; test count corrected 68 → 79 ([585cece](https://github.com/Nwflower/dsh-chat-import/commit/585cece)).
- Reasonix import documented in the bilingual READMEs ([0aded42](https://github.com/Nwflower/dsh-chat-import/commit/0aded42)).
- Multi-session protocol documents the pending-merge area ([c691324](https://github.com/Nwflower/dsh-chat-import/commit/c691324)).
- Peer dependency policy relaxed to `^0.1.0-rc.6` so the plugin installs
  alongside newer DSH releases ([117e7a1](https://github.com/Nwflower/dsh-chat-import/commit/117e7a1)).
- `package.json` metadata completed and `engines` pinned to `>=22.13`, with the
  lockfile's engines entry synced to match ([7162957](https://github.com/Nwflower/dsh-chat-import/commit/7162957), [41ad12a](https://github.com/Nwflower/dsh-chat-import/commit/41ad12a)).

## [0.1.1] - 2026-08-14

First patch release — shipped the batch-import error-detail fix together with
the Cursor and Gemini sources, the bilingual README and the project LOGO.
Tagged `v0.1.1` (`586a5f9`).

### Added

- **Cursor agent transcript import** (`import_cursor`) — strips the
  `<user_query>` wrapper on the first user message, filters `[REDACTED]`
  sentinels, maps `tool_use` blocks to `tool/call` (no result in the transcript)
  ([73571f6](https://github.com/Nwflower/dsh-chat-import/commit/73571f6)).
- **Gemini CLI session import** (`import_gemini`) — user/gemini/info message
  types, `thoughts` → reasoning, inline tool calls and results
  ([20c3f17](https://github.com/Nwflower/dsh-chat-import/commit/20c3f17), [0a1aea7](https://github.com/Nwflower/dsh-chat-import/commit/0a1aea7)).
- **Bilingual README** (`README.md` + `README.zh-CN.md` with a language
  switcher), with the Chinese edition shipped in the npm package
  ([6a880cb](https://github.com/Nwflower/dsh-chat-import/commit/6a880cb), [795bf83](https://github.com/Nwflower/dsh-chat-import/commit/795bf83)).
- **Project LOGO** (`assets/import.svg`) wired into the READMEs and the npm
  publish surface ([c696178](https://github.com/Nwflower/dsh-chat-import/commit/c696178), [586a5f9](https://github.com/Nwflower/dsh-chat-import/commit/586a5f9)).
- **`npm pack --dry-run` as a publish-surface regression guard** in CI
  ([7422e48](https://github.com/Nwflower/dsh-chat-import/commit/7422e48)).

### Fixed

- **Batch import reports per-file error detail** — the completion summary now
  lists up to five failed/skipped paths with their reasons instead of aggregate
  counts only (the reason for this release; [fb657a2](https://github.com/Nwflower/dsh-chat-import/commit/fb657a2)).

### Changed

- README first-screen: badge row, tagline and a compatibility matrix for the
  then-four sources ([572222c](https://github.com/Nwflower/dsh-chat-import/commit/572222c)).
- CI npm cache dropped (no lockfile yet at the time) ([ad9ce48](https://github.com/Nwflower/dsh-chat-import/commit/ad9ce48));
  `.gitignore` extended for editor/system noise ([243fbb2](https://github.com/Nwflower/dsh-chat-import/commit/243fbb2)).

## [0.1.0] - 2026-08-13

Initial release — the plugin's first npm publish (untagged). Imports Claude
Code, Codex / ChatGPT CLI and ChatGPT web-export histories as full-fidelity,
resumable DSH sessions.

### Added

- **Claude Code JSONL import** (`import_claude`) — full-fidelity tool history
  (real `tool/call` + `tool/result` pairs with `sourceEventSeqs` linkage),
  multi-step assistant messages and thinking blocks; `ai-title` becomes the
  session title ([e791dbe](https://github.com/Nwflower/dsh-chat-import/commit/e791dbe), [775d675](https://github.com/Nwflower/dsh-chat-import/commit/775d675), [fe619d7](https://github.com/Nwflower/dsh-chat-import/commit/fe619d7)).
- **Codex / ChatGPT CLI rollout import** (`import_codex`) — `session_meta` /
  `turn_context` header, `response_item` messages, function / custom tool calls
  paired by `call_id`; harness-injection blocks and encrypted reasoning skipped
  ([681ff08](https://github.com/Nwflower/dsh-chat-import/commit/681ff08)).
- **ChatGPT web export import** (`import_chatgpt`) — `conversations.json` as a
  batch, main thread rebuilt from the `mapping` DAG, placeholder / system nodes
  skipped ([adbc8fd](https://github.com/Nwflower/dsh-chat-import/commit/adbc8fd)).
- **Batch import** — recursive directory scan, one session per file, per-file
  summary ([d39c509](https://github.com/Nwflower/dsh-chat-import/commit/d39c509)).
- **Idempotent import** — re-importing skips sessions that already exist
  ([abb930d](https://github.com/Nwflower/dsh-chat-import/commit/abb930d)).
- **Skipped-malformed reporting** — malformed records are counted and reported,
  never silently dropped ([a8a5fc4](https://github.com/Nwflower/dsh-chat-import/commit/a8a5fc4)).
- **Pure conversion core** (`convert.mjs`) split from the host-facing entry
  ([73396c8](https://github.com/Nwflower/dsh-chat-import/commit/73396c8)).

### Changed

- Project scaffolding for npm / GitHub: publish metadata, MIT license, peer
  dependency, publish-surface split, CI workflow, AGENTS.md and the
  multi-session protocol ([8de15e0](https://github.com/Nwflower/dsh-chat-import/commit/8de15e0), [4ff8390](https://github.com/Nwflower/dsh-chat-import/commit/4ff8390), [69702de](https://github.com/Nwflower/dsh-chat-import/commit/69702de), [1f0fddd](https://github.com/Nwflower/dsh-chat-import/commit/1f0fddd), [e7b1acd](https://github.com/Nwflower/dsh-chat-import/commit/e7b1acd), [8d485d2](https://github.com/Nwflower/dsh-chat-import/commit/8d485d2), [f6bfb65](https://github.com/Nwflower/dsh-chat-import/commit/f6bfb65)).
- Line endings normalized to LF via `.gitattributes` / `.editorconfig` to
  prevent cross-machine churn ([912c28d](https://github.com/Nwflower/dsh-chat-import/commit/912c28d)).
