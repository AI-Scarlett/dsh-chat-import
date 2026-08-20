// lib/tools.mjs — 21 个工具的注册（15 个 import_* + import_agents + export_claude
// + sync_to_claude + list_imported_sessions + retract_import + scan_discover）
//
// apply 入口只做两件事：本文件的 registerTools（工具注册）与 lib/panel.mjs 的
// registerPanelRoutes（webServer 路由，可选服务延迟挂载）。每个 import_* 工具由
// makeImportTool（lib/toolkit.mjs）按 spec 收敛 schema/render/execute；特殊形态来源
//（chatgpt / grokbuild / hermes / opencode / zcode 的导入编排与预览）在
// lib/import-variants.mjs。依赖 ctx（host 服务），非纯函数。

import { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import {
  convertClaudeJsonl, convertCodexJsonl, convertChatgptJson, convertCursorJsonl,
  convertGeminiJson, convertReasonixJsonl, convertPiJsonl, convertOpencodeJson,
  convertZcodeJson, convertGrokbuildJson, convertOpenclawJson, convertHermesJson,
  convertKimiWire, convertDshJsonl, convertLocalJsonl,
} from '../convert.mjs'
import { openclawDisplayNames } from './convert/openclaw.mjs'
import { markTrimmedSource } from './budget.mjs'
import { runDecision, collectJsonFiles } from './import-core.mjs'
import { syncClaudeSession } from './backfill.mjs'
import { importOpencodeFile, importOpencodeDirectory } from './opencode.mjs'
import { importZcodeFile, importZcodeDirectory } from './zcode.mjs'
import { FORMATS } from './discovery.mjs'
import { makeImportTool } from './toolkit.mjs'
import {
  importChatgptFile, importChatgptDirectory,
  importGrokbuildSession, importGrokbuildDirectory,
  importHermesFile, importHermesDirectory, hermesFileArgs,
  importKimiFile, importKimiDirectory, kimiDeriveArgs,
  previewChatgptFile, previewChatgptDirectory,
  previewGrokbuildSession, previewGrokbuildDirectory,
  previewHermesFile, previewHermesDirectory,
  previewKimiFile, previewKimiDirectory,
  previewOpencodeFile, previewOpencodeDirectory,
  previewZcodeFile, previewZcodeDirectory,
} from './import-variants.mjs'
import { exportClaudeSession } from './export-tool.mjs'
import { listImportedSessions, retractImport } from './retract.mjs'
import { runScanDiscover } from './discovery-host.mjs'
import { runAgentsImport } from './agents.mjs'
import { readDshText, collectDshFiles } from './dsh.mjs'

export function registerTools(ctx, registryDir) {
  // 声明 TOOL_RUNTIME_SCHEDULER 命名导入：一旦解析到旧副本 dsh-tools@0.0.1-rc.1
  //（只导出 TOOL_REGISTRY_SCHEDULER），模块加载即失败并大声报错，而不是静默用旧
  // ABI 注册工具、最终让宿主 agent-loop 在调度时崩溃
  //（Cannot read properties of undefined (reading 'prepare')）并污染会话历史。
  if (typeof TOOL_RUNTIME_SCHEDULER !== 'symbol') {
    throw new Error('dsh-chat-import: resolved @deepseek-ai/dsh-tools lacks TOOL_RUNTIME_SCHEDULER — requires >=0.1.0-rc.8 <0.2.0')
  }
  ctx.tools.register(makeImportTool(ctx, {
    format: 'claude',
    toolName: 'import_claude',
    sourceLabel: 'Claude Code',
    convert: convertClaudeJsonl,
    registryDir,
    // 文件名 stem 传给转换器做「主 transcript」判定：subagent/workflow 辅助 transcript
    // 记录携带父 sessionId，按它建会话会与主 transcript 撞 id 导致主内容被跳过
    deriveArgs: (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      return { fileStem: base.replace(/\.jsonl$/i, '') }
    },
    description:
      '从 Claude Code 的 JSONL transcript 导入历史对话为可继续的 DSH 会话。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/tool 消息、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    format: 'codex',
    toolName: 'import_codex',
    sourceLabel: 'Codex/ChatGPT',
    convert: convertCodexJsonl,
    registryDir,
    description:
      '从 Codex / ChatGPT CLI 的 rollout JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/function_call/custom_tool_call 消息、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    format: 'chatgpt',
    toolName: 'import_chatgpt',
    sourceLabel: 'ChatGPT',
    convert: convertChatgptJson,
    importFile: (c, t, a) => importChatgptFile(c, t, a, { registryDir }),
    importDir: (c, d, a) => importChatgptDirectory(c, d, a, { registryDir }),
    previewFile: (c, t, a) => previewChatgptFile(c, t, a),
    previewDir: (c, d, a) => previewChatgptDirectory(c, d, a),
    alwaysBatch: true,
    registryDir,
    description:
      '从 ChatGPT 网页导出的 conversations.json 导入历史对话为可继续的 DSH 会话。' +
      '导出 ZIP 解压后得到 conversations.json（JSON 数组，一个文件含全部会话）；' +
      'path 可以是该 .json 文件，也可以是包含多个 .json 的目录（目录模式递归扫描）。' +
      '解析 mapping 主线程（占位节点/系统消息跳过）、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回批量统计与逐会话明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    format: 'cursor',
    toolName: 'import_cursor',
    sourceLabel: 'Cursor',
    convert: convertCursorJsonl,
    registryDir,
    // Cursor 行内无会话 id：用文件名（composer uuid）作稳定 id，保证幂等
    deriveArgs: (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      return { cursorId: base.replace(/\.jsonl$/i, '') }
    },
    description:
      '从 Cursor 的 agent transcript JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.cursor/projects/<slug>/agent-transcripts/<composer-id>/<composer-id>.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant 文本与 tool_use 调用（transcript 不含 tool_result，仅导入调用历史）；' +
      '过滤 [REDACTED] 哨兵；重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    format: 'gemini',
    toolName: 'import_gemini',
    sourceLabel: 'Gemini CLI',
    convert: convertGeminiJson,
    collect: collectJsonFiles, // Gemini 是单会话 .json（非 JSONL）
    registryDir,
    description:
      '从 Gemini CLI 的会话 JSON 导入历史对话为可继续的 DSH 会话（' +
      '~/.gemini/history/<slot>/chats/session-*.json）。' +
      'path 可以是单个 .json 文件，也可以是包含多个 .json 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/gemini 消息、thoughts→reasoning、内联 toolCalls（结果同对象）并持久化；' +
      'info 系统通知跳过；重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    format: 'reasonix',
    toolName: 'import_reasonix',
    sourceLabel: 'Reasonix',
    convert: convertReasonixJsonl,
    registryDir,
    // 会话 id 用文件名 stem（幂等）；cwd/标题从同目录 <stem>.meta.json 派生
    deriveArgs: async (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      const stem = base.replace(/\.jsonl$/i, '')
      const derived = { reasonixId: stem }
      try {
        // meta 与 transcript 同目录：<stem>.meta.json
        const metaPath = String(p).replace(/[\\/][^\\/]*\.jsonl$/i, '') + '\\' + stem + '.meta.json'
        const metaTarget = await ctx.fs.resolve(metaPath)
        const raw = await ctx.fs.readText(metaTarget)
        const meta = JSON.parse(raw)
        if (meta && typeof meta.workspace === 'string' && meta.workspace) derived.cwd = meta.workspace
        if (meta && typeof meta.summary === 'string' && meta.summary.trim()) derived.title = meta.summary.trim()
      } catch {
        // meta 缺失（子代理或旧文件）不致命：仍按 stem 导入，仅无 cwd/标题
      }
      return derived
    },
    description:
      '从 Reasonix 的会话 JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.reasonix/sessions/desktop-*.jsonl 与 subagent-sub-*.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/tool 消息（兼容 v1 嵌套与 v2 扁平 tool_calls）、reasoning_content→reasoning、' +
      'tool_call_id 配对结果；会话 id 取文件名 stem，cwd/标题从同目录 .meta.json 派生；' +
      '重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    format: 'opencode',
    toolName: 'import_opencode',
    sourceLabel: 'opencode',
    convert: convertOpencodeJson,
    // 一库多会话：单 .db 文件也恒返回批量形态；目录模式自动定位 opencode.db（无递归）
    importFile: (c, t, a) => importOpencodeFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
    importDir: (c, d, a) => importOpencodeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
    previewFile: (c, t, a) => previewOpencodeFile(c, t, a),
    previewDir: (c, d, a) => previewOpencodeDirectory(c, d, a),
    alwaysBatch: true,
    registryDir,
    // opencode 无单会话 id 覆盖、无递归（目录里就是 opencode.db）
    dropParameters: ['sessionId', 'recursive'],
    pathDescription: 'opencode 历史数据库（opencode.db）的文件路径，或包含 opencode.db 的数据目录路径。',
    batchUnit: '会话',
    skippedNote: '无用户回合',
    extraParameters: {
      sessionIds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：只导入指定源会话 id（缺省导入全部会话）。',
      },
      fullHistory: {
        type: 'boolean',
        description: '可选：true 时导入全量历史（忽略 opencode 的对话压缩）；默认 false（尊重压缩：只导最后一次摘要 + 尾巴）。',
      },
    },
    description:
      '从 opencode 的 SQLite 历史库 opencode.db 导入历史会话为可继续的 DSH 会话（默认位置 ~/.local/share/opencode/opencode.db）。' +
      'path 可以是 .db 文件，也可以是包含 opencode.db 的数据目录（目录模式自动定位，无递归）。' +
      '读取 session/message/part 表重建对话（event 表是部分镜像、session_message/session_input 为空，忽略）；' +
      '文本/reasoning/工具调用（tool/call + tool/result，含错误标记与 sourceEventSeqs 关联）/图片附件/补丁/子任务完整保留；' +
      '默认尊重对话压缩（compaction，只导最后一次摘要+尾巴，摘要作 reasoning 块前置），可选 fullHistory 导全量；' +
      '可选 sessionIds 只导指定源会话；重复导入同一会话会幂等跳过。返回批量统计与逐会话明细。',
  }))
  // REQ-38 zcode 源（第 8 个导入源）：z.ai 官方 CLI（zcode.z.ai）会话存储
  // ~/.zcode/cli/db/db.sqlite（SQLite 权威索引）+ 旧版 transcript.jsonl 回退。
  // 一库多会话：单 .db / 单 transcript.jsonl 也恒返回批量形态；目录模式自动定位
  // db.sqlite（无递归）；zcode://<id> 伪路径走默认库只导该会话。
  ctx.tools.register(makeImportTool(ctx, {
    format: 'zcode',
    toolName: 'import_zcode',
    sourceLabel: 'zcode',
    convert: convertZcodeJson,
    importFile: (c, t, a) => importZcodeFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
    importDir: (c, d, a) => importZcodeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
    previewFile: (c, t, a) => previewZcodeFile(c, t, a),
    previewDir: (c, d, a) => previewZcodeDirectory(c, d, a),
    alwaysBatch: true,
    registryDir,
    // zcode 无单会话 id 覆盖、无递归（目录里就是 db.sqlite）；伪路径的会话 id
    // 由 deriveArgs 从 zcode://<id> 取出（fs.resolve 归一化后 importZcodeFile 还会
    // 从原始 args.path 兜底再取一次，见 lib/zcode.mjs）
    dropParameters: ['sessionId', 'recursive'],
    deriveArgs: (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      if (typeof p === 'string' && p.startsWith('zcode://')) {
        return { zcodeId: p.slice('zcode://'.length) }
      }
      return {}
    },
    pathDescription: 'zcode 会话数据库（db.sqlite）的文件路径、包含 db.sqlite 的数据目录路径，或 zcode://<sessionId> 伪路径（走默认 ~/.zcode/cli/db/db.sqlite）。',
    batchUnit: '会话',
    skippedNote: '无用户回合',
    extraParameters: {
      sessionIds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：只导入指定源会话 id（缺省导入全部会话）。',
      },
    },
    description:
      '从 z.ai 官方 CLI（zcode）的 SQLite 历史库 db.sqlite 导入历史会话为可继续的 DSH 会话（默认位置 ~/.zcode/cli/db/db.sqlite）。' +
      'path 可以是 .db 文件、包含 db.sqlite 的数据目录（目录模式自动定位，无递归），或 zcode://<sessionId> 伪路径（走默认库，只导该会话）。' +
      '读取 session/message/part 表重建对话（message/part 无 sequence 列，按 time_created, id 升序；主会话 parent_id IS NULL）；' +
      '文本/工具调用（tool/call + tool/result 成对输出，含错误标记与 sourceEventSeqs 关联）完整保留；' +
      'compaction 自动压缩摘要（part.type === "compaction" 的 data.summary.body）还原为前置上下文 reasoning 块；' +
      '含 <system-reminder> 的系统注入 user 消息过滤；db 不可用时回退读旧版 transcript.jsonl；' +
      '可选 sessionIds 只导指定源会话；重复导入同一会话会幂等跳过。返回批量统计与逐会话明细。',
  }))
  // grokbuild 源（第 9 个导入源）：Grok Build 本地 CLI 会话存储
  // ~/.grok/sessions/<project>/<session_id>/（及 ~/.grok/archived_sessions/），
  // 每会话目录含 summary.json + chat_history.jsonl。path 可指向单个会话目录
  // （mode single）或 sessions/archived_sessions 根（递归扫 summary.json，批量）。
  // 转换器 convertGrokbuildJson 需读两个文件再转换，编排见 lib/import-variants.mjs
  // 的 importGrokbuildSession / importGrokbuildDirectory。
  ctx.tools.register(makeImportTool(ctx, {
    format: 'grokbuild',
    toolName: 'import_grokbuild',
    sourceLabel: 'Grok Build',
    convert: convertGrokbuildJson,
    importFile: (c, t, a) => importGrokbuildSession(c, t, a, { registryDir }),
    importDir: (c, d, a) => importGrokbuildDirectory(c, d, a, { registryDir }),
    previewFile: (c, t, a) => previewGrokbuildSession(c, t, a),
    previewDir: (c, d, a) => previewGrokbuildDirectory(c, d, a),
    // 会话目录（含 summary.json）视作单源走单会话导入；其余目录走批量扫描
    dirSingle: async (ctx, target) => {
      const dirPath = target.displayPath || ctx.fs.processPath(target)
      const sumTarget = await ctx.fs.resolve(join(dirPath, 'summary.json'))
      const sumStat = await ctx.fs.stat(sumTarget)
      return !!(sumStat && sumStat.type === 'file')
    },
    registryDir,
    pathDescription: 'Grok Build 会话目录（含 summary.json + chat_history.jsonl）的路径（单会话导入），或 ~/.grok/sessions / archived_sessions 根目录路径（递归扫 summary.json，批量导入）。',
    batchUnit: '会话',
    skippedNote: '无用户回合',
    description:
      '从 Grok Build 的本地会话目录导入历史对话为可继续的 DSH 会话（' +
      '~/.grok/sessions/<project>/<session_id>/，每会话目录含 summary.json + chat_history.jsonl）。' +
      'path 可指向单个会话目录（单文件导入），或 sessions/archived_sessions 根（递归扫 summary.json，批量导入）。' +
      '解析 user/assistant/tool/system/reasoning 记录（reasoning 加密内部状态与 system 注入过滤）、' +
      'Claude 风格 content block（tool_use/tool_result 配对挂回所属 step）并持久化；' +
      '标题取 generated_title > session_summary；重复导入同一会话会幂等跳过。' +
      '返回新会话 id（或批量统计）与明细；provider=grokbuild，可用 grok --resume <id> 续聊。',
  }))
  // openclaw 源（第 10 个导入源）：OpenClaw 会话 JSONL
  // ~/.openclaw/agents/<agent>/sessions/*.jsonl（同目录 sessions.json 索引提供
  // displayName 作会话标题）。标准单文件/目录批量形态；deriveArgs 按文件 stem 从
  // sessions.json 查 displayName（openclawDisplayNames 纯函数）。
  ctx.tools.register(makeImportTool(ctx, {
    format: 'openclaw',
    toolName: 'import_openclaw',
    sourceLabel: 'OpenClaw',
    convert: convertOpenclawJson,
    registryDir,
    deriveArgs: async (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      const stem = base.replace(/\.jsonl$/i, '')
      const derived = { openclawId: stem }
      try {
        // sessions.json 与 transcript 同目录：<dir>/sessions.json（displayName 索引）
        const dirPath = String(p).replace(/[\\/][^\\/]*\.jsonl$/i, '')
        const indexTarget = await ctx.fs.resolve(join(dirPath, 'sessions.json'))
        const name = openclawDisplayNames(await ctx.fs.readText(indexTarget)).get(stem)
        if (name) derived.displayName = name
      } catch {
        // sessions.json 缺失/损坏不致命：仍按 stem 导入，仅无 displayName（标题回退首问）
      }
      return derived
    },
    description:
      '从 OpenClaw 的会话 JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.openclaw/agents/<agent>/sessions/*.jsonl，同目录 sessions.json 索引提供 displayName 作标题）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的 sessions 目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/toolResult 事件（tool_use/tool_result 配对挂回所属 step、剥 message_id 尾缀）并持久化；' +
      '重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  // hermes 源（第 11 个导入源）：Hermes（本地 AI 编码 CLI）会话存储
  // ~/.hermes/state.db（SQLite 权威索引，恒批量）+ ~/.hermes/sessions/*.jsonl 回退
  // （db 不可用 readHermesDb 返回 null 时）。.db 单文件恒批量（对齐 import_opencode）；
  // 单 .jsonl = 单会话（mode single）；目录优先 state.db、不可用则递归扫 .jsonl。
  ctx.tools.register(makeImportTool(ctx, {
    format: 'hermes',
    toolName: 'import_hermes',
    sourceLabel: 'Hermes',
    convert: convertHermesJson,
    importFile: (c, t, a) => importHermesFile(c, t, a, { registryDir }),
    importDir: (c, d, a) => importHermesDirectory(c, d, a, { registryDir }),
    previewFile: (c, t, a) => previewHermesFile(c, t, a),
    previewDir: (c, d, a) => previewHermesDirectory(c, d, a),
    deriveArgs: (target) => hermesFileArgs(ctx, target),
    // .db 单文件恒返回批量形态（SQLite 一库多会话）；.jsonl 走单会话导入
    fileBatch: (ctx, target) => /\.db$/i.test(String(target.displayPath || ctx.fs.processPath(target))),
    registryDir,
    pathDescription: 'Hermes 历史库（state.db）的文件路径、包含 state.db 的目录路径（SQLite 恒批量），或 sessions/*.jsonl 单文件/目录路径（db 不可用时回退）。',
    batchUnit: '会话',
    skippedNote: '无用户回合',
    description:
      '从 Hermes（本地 AI 编码 CLI）的会话存储导入历史对话为可继续的 DSH 会话（' +
      '~/.hermes/state.db SQLite 权威索引 + sessions/*.jsonl 回退）。' +
      'path 可指向 state.db 文件或包含 state.db 的目录（恒批量，一库多会话）；' +
      'db 不可用（readHermesDb 返回 null）时回退递归扫描 sessions/*.jsonl，单文件 = 单会话。' +
      '解析 flat/nested 双形态 JSONL 或 DB 中间 JSON（thinking→reasoning、tool_use/tool_result 成对）并持久化；' +
      '重复导入同一会话会幂等跳过。返回批量统计与逐会话明细。',
  }))
  // Pi Coding Agent 源（第 12 个导入源）：Pi Coding Agent 会话 JSONL
  // ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl（树形条目，id/parentId
  // 链接）。活动分支（叶→根）重建、compaction 默认尊重（fullHistory 入参数指纹）；
  // 头行缺失时用文件名 stem 作稳定源 id（幂等）。
  ctx.tools.register(makeImportTool(ctx, {
    format: 'pi',
    toolName: 'import_pi',
    sourceLabel: 'Pi Coding Agent',
    convert: convertPiJsonl,
    registryDir,
    // 头行缺失时用文件名 stem 作稳定源 id（幂等）；正常路径取会话头 id（uuid）
    deriveArgs: (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      return { piId: base.replace(/\.jsonl$/i, '') }
    },
    // fullHistory 计入导入参数指纹：换值重导 → argsChanged（同 opencode 语义）
    fingerprintKeys: ['fullHistory'],
    extraParameters: {
      fullHistory: {
        type: 'boolean',
        description: '可选：true 时导入全量历史（忽略 Pi 的上下文压缩）；默认 false（尊重压缩：只导最后一次摘要 + 尾巴）。',
      },
    },
    description:
      '从 Pi Coding Agent 的会话 JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析活动分支（叶→根树遍历）的 user/assistant/toolResult 消息、thinking→reasoning、' +
      'branch_summary/compaction 摘要→reasoning、bashExecution/custom 注入→文本块，合成会话事件并持久化；' +
      '默认尊重上下文压缩（只导最后一次摘要+尾巴），可选 fullHistory 导全量；' +
      '重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  // REQ-14 Kimi CLI 源（第 13 个导入源）：Moonshot AI 官方开源终端 agent（Python）
  // 会话存储 ~/.kimi/sessions/<workdir-md5>/<session-id>/wire.jsonl（+ state.json
  // 标题 / kimi.json workdir 映射）。会话目录 = 含 wire.jsonl 的目录；subagents/
  // 子代理 wire 不并入主线程批量（转换层对 SubagentEvent 镜像跳过计数）。path 可
  // 指向单个会话目录（mode single，dirSingle 判定）或 sessions 根（批量）。
  ctx.tools.register(makeImportTool(ctx, {
    format: 'kimi',
    toolName: 'import_kimi',
    sourceLabel: 'Kimi CLI',
    convert: convertKimiWire,
    importFile: (c, t, a) => importKimiFile(c, t, a, { registryDir }),
    importDir: (c, d, a) => importKimiDirectory(c, d, a, { registryDir }),
    previewFile: (c, t, a) => previewKimiFile(c, t, a),
    previewDir: (c, d, a) => previewKimiDirectory(c, d, a),
    // 会话目录（含 wire.jsonl）视作单源走单会话导入；其余目录走批量扫描
    dirSingle: async (ctx, target) => {
      const dirPath = target.displayPath || ctx.fs.processPath(target)
      const wireTarget = await ctx.fs.resolve(join(dirPath, 'wire.jsonl'))
      const wireStat = await ctx.fs.stat(wireTarget)
      return !!(wireStat && wireStat.type === 'file')
    },
    deriveArgs: (target) => kimiDeriveArgs(ctx, target),
    registryDir,
    pathDescription: 'Kimi CLI 会话目录（含 wire.jsonl）的路径（单会话导入），或 ~/.kimi/sessions 根目录路径（递归扫 wire.jsonl，批量导入）。',
    batchUnit: '会话',
    skippedNote: '无用户回合',
    description:
      '从 Kimi CLI（Moonshot AI 官方开源终端 agent）的会话目录导入历史对话为可继续的 DSH 会话（' +
      '~/.kimi/sessions/<workdir-md5>/<session-id>/，每会话含 wire.jsonl + state.json，' +
      '~/.kimi/kimi.json 提供 workdir 映射）。' +
      'path 可指向单个会话目录（单会话导入），或 sessions 根（递归扫 wire.jsonl，批量导入）。' +
      '解析 wire 事件流（TurnBegin/SteerInput 用户输入、TextPart/ThinkPart 内容、' +
      'ToolCall/ToolResult 工具调用、status/control 事件过滤、SubagentEvent 子代理镜像跳过）并持久化；' +
      '标题取 state.json custom_title > 首问；重复导入同一会话会幂等跳过。' +
      '返回新会话 id（或批量统计）与明细。',
  }))
  // REQ-59 外部 agent/mode prompt → DSH skills 资产（第 14 个工具）：非会话导入，
  // 独立注册。收集 pi/opencode 的自定义 agent / mode prompt / skill，转换为
  // `$DSH_AGENTS_HOME/skills/<name>/SKILL.md` bundle（provenance frontmatter）。
  // 缺省 dry-run 预览（plan 清单零副作用）；apply:true 才写盘。
  ctx.tools.register(defineTool({
    name: 'import_agents',
    description:
      '把 pi（~/.pi/agent/{agents,prompts}）与 opencode（~/.config/opencode/{agents,skill}）的' +
      '自定义 agent / mode prompt / skill 转换为 DSH 持久化 skill 资产：' +
      '$DSH_AGENTS_HOME/skills/<name>/SKILL.md（$DSH_AGENTS_HOME 缺省 ~/.agents）。' +
      '缺省 dry-run：只返回 write/complete/skip 规划清单（零副作用）；apply:true 才落盘。' +
      '语义：同名冲突加 -pi/-opencode 后缀消歧、内容相同幂等跳过、已带 kind:dsh 的源不重复导入、' +
      'bundle 目录缺 SKILL.md 时原地补全（保留既有 scripts/ 等）。返回规划/落盘明细。',
    parameters: {
      apply: {
        type: 'boolean',
        description: '可选：true 时实际写盘（缺省 false = dry-run 预览，零副作用）。',
      },
      piRoot: {
        type: 'string',
        description: '可选：pi 根目录（默认 ~/.pi/agent）。',
      },
      opencodeRoot: {
        type: 'string',
        description: '可选：opencode 配置根（默认 ~/.config/opencode）。',
      },
      agentsHome: {
        type: 'string',
        description: '可选：DSH user-agents 根（默认 $DSH_AGENTS_HOME 或 ~/.agents），skills 写到其下 skills/。',
      },
      preview: {
        type: 'boolean',
        description: '可选：dry-run 别名（与缺省行为一致，显式声明零副作用）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          planned: { type: 'integer', required: true },
          applied: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                source: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                action: { type: 'string', enum: ['write', 'complete', 'skip'], required: true },
                reason: { type: 'string' },
                target: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async execute(args) {
      return runAgentsImport(ctx, args)
    },
  }))
  // dsh 源（第 14 个导入源）：DSH 自身会话日志
  // $DSH_HOME/sessions/<encoded-workspace>/<session-id>/session.jsonl(.zstd)。
  // .zstd 由系统 zstd 解压后走同一转换器；目录递归收集 session.jsonl(.zstd)。
  ctx.tools.register(makeImportTool(ctx, {
    format: 'dsh',
    toolName: 'import_dsh',
    sourceLabel: 'DSH',
    convert: convertDshJsonl,
    readText: readDshText,
    collect: collectDshFiles,
    registryDir,
    pathDescription: 'DSH 会话日志 session.jsonl / session.jsonl.zstd 的文件路径，或包含这些文件的会话目录（默认根 ~/.dsh/sessions，目录递归收集）。',
    description:
      '从 DeepSeek Harness（DSH）自身的会话日志导入历史对话为可继续的 DSH 会话。' +
      'path 可以是单个 session.jsonl 或 session.jsonl.zstd 文件，也可以是包含多个会话日志的目录（默认扫描 ~/.dsh/sessions）。' +
      '保留 turn/step/user/assistant/tool 核心事件并重排 seq；流式 chunk 与运行时状态事件不导入；' +
      '重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  // 本地 JSONL 会话文件：任意 .jsonl 路径，转换器按路径特征 + 内容自动识别
  // dsh / claude / codex / cursor / reasonix / pi / openclaw / hermes，也可用
  // format 参数强制指定。不是第 15 个「来源」——面板来源列表仍保持 14 个。
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_local_jsonl',
    sourceLabel: 'Local JSONL',
    convert: convertLocalJsonl,
    registryDir,
    pathDescription: '本地会话 JSONL 文件的路径，或包含多个 .jsonl 的目录路径。',
    extraParameters: {
      format: {
        type: 'string',
        enum: ['dsh', 'claude', 'codex', 'cursor', 'reasonix', 'pi', 'openclaw', 'hermes'],
        description: '可选：强制按指定格式解析；缺省自动识别（路径特征 + 首条有效会话结构）。',
      },
    },
    description:
      '从本地任意 JSONL 会话文件导入历史对话为可继续的 DSH 会话。' +
      '自动识别 dsh / claude / codex / cursor / reasonix / pi / openclaw / hermes 格式，' +
      '识别失败时可用 format 参数强制指定；目录模式递归扫描 .jsonl，每个文件独立导入。' +
      '重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  // REQ-16 反向导出：第 17 个工具，独立注册（导出流程与导入状态机完全不同）。
  ctx.tools.register(defineTool({
    name: 'export_claude',
    description:
      '把 DSH 会话日志（只读，不 load/prepare、不改写历史事件）序列化为 Claude Code JSONL 并写入 ' +
      '<outputDir>/<slug>/<uuid>.jsonl，可被真实 Claude Code --resume 续聊。' +
      '参数：sessionId 必填；cwd 可选（默认取会话 header.cwd，两者皆无则报错）；' +
      'outputDir 可选（默认 ~/.claude/projects）；dryRun 可选（只序列化不写盘）。' +
      'user/assistant/tool_result 按 seq 顺序映射，tool_result 挂在声明其 tool_use 的 assistant 上（' +
      '并行结果扇出同一 assistant）；中断会话末尾补发空 tool_result；孤儿结果丢弃并计数；' +
      '非人类注入跳过计数。返回目标文件路径、记录数与 mapping（sourceSessionId → 新 uuid，imports registry 预留）。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: '要导出的 DSH 会话 id（必填）。',
      },
      cwd: {
        type: 'string',
        description: '可选：覆盖导出记录的 cwd（默认取会话 header.cwd；两者皆无则报错）。',
      },
      outputDir: {
        type: 'string',
        description: '可选：Claude Code projects 根目录（默认 ~/.claude/projects），文件写到 <outputDir>/<slug>/<uuid>.jsonl。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：true 时不写盘，只序列化并返回目标路径与统计。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          sessionId: { type: 'string', required: true },
          sourceSessionId: { type: 'string', required: true },
          filePath: { type: 'string', required: true },
          slug: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          recordCount: { type: 'integer', required: true },
          title: { type: 'string' },
          dryRun: { type: 'boolean', required: true },
          mapping: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              sourceSessionId: { type: 'string', required: true },
              sessionUuid: { type: 'string', required: true },
              slug: { type: 'string', required: true },
              filePath: { type: 'string', required: true },
              turns: { type: 'integer', required: true },
              messages: { type: 'integer', required: true },
              toolCalls: { type: 'integer', required: true },
              toolResults: { type: 'integer', required: true },
              droppedToolResults: { type: 'integer', required: true },
              skippedInjections: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.dryRun ? '导出预览（dryRun，未写盘）：' : '已导出：')
          + '会话 ' + value.sourceSessionId + ' → ' + value.filePath
          + '（' + value.recordCount + ' 条记录、' + value.mapping.toolCalls + ' 次工具调用）',
      }],
    },
    async execute(args) {
      return exportClaudeSession(ctx, args, { registryDir })
    },
  }))
  // REQ-36 反向同步（双向同步桥 B 第一步）：第 18 个工具，把 DSH 会话新增轮次
  // 增量写回 Claude Code JSONL（目标 = 导入源文件或 export_claude 副本）。写回
  // 核心在 lib/backfill.mjs（纯逻辑 + ctx 注入，零 DSH 依赖）；uuid 工厂经
  // syncClaudeSession 的 args.uuid 注入（测试确定性），工具 schema 不暴露它。
  ctx.tools.register(defineTool({
    name: 'sync_to_claude',
    description:
      '反向同步（REQ-36）：把 DSH 会话新增完整轮次增量写回 Claude Code JSONL，' +
      '供真实 Claude Code --resume 续聊。目标 target:"source"（默认）写回导入源文件，' +
      'target:"copy" 写回上次 export_claude 导出的副本（需先导出）。' +
      '守卫不静默覆盖：源文件缩小（sourceShrunk）、被外部修改（source-modified-externally）、' +
      '文件尾 uuid 与写回水印失配（tail-mismatch）、并发写者（write-version-mismatch）一律跳过并上报；' +
      'force:true 跳过三闸并以当前文件重锚定（水印 + 链尾）。' +
      '只写由 turn/end 闭合的完整轮（半开进行中轮次不写，报 incompleteFinalTurn）；' +
      'dryRun 只计算不写盘。返回 status: synced | no-new-turns | skipped 与写回水印。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: '要写回的 DSH 会话 id（必须是由本插件导入的会话，带 session/imported 标记）。',
      },
      target: {
        type: 'string',
        description: "可选：写回目标 'source'（默认，导入源文件）| 'copy'（export_claude 导出的副本，需先导出）。",
      },
      force: {
        type: 'boolean',
        description: '可选：true 时跳过三闸守卫并以当前文件重锚定（水印 + 链尾），可能覆盖外部修改；默认 false。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：true 时完整计算（含格式预检）但不写盘、不更新 registry。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          status: { type: 'string', required: true, enum: ['synced', 'no-new-turns', 'skipped'] },
          sessionId: { type: 'string', required: true },
          sourcePath: { type: 'string', required: true },
          target: { type: 'string', required: true, enum: ['source', 'copy'] },
          filePath: { type: 'string', required: true },
          appendedTurns: { type: 'integer' },
          appendedEvents: { type: 'integer' },
          appendedRecords: { type: 'integer' },
          conflictDetected: { type: 'string', enum: ['source-modified-externally', 'tail-mismatch', 'write-version-mismatch'] },
          sourceShrunk: { type: 'boolean' },
          storedShrunk: { type: 'boolean' },
          incompleteFinalTurn: { type: 'boolean' },
          precheckFailed: { type: 'boolean' },
          rollbackError: { type: 'string' },
          reason: { type: 'string' },
          precheck: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              recordCount: { type: 'integer' },
              lastUuid: { type: 'string' },
              errors: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    line: { type: 'integer', required: true },
                    error: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          dryRun: { type: 'boolean', required: true },
          writeback: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionUuid: { type: 'string', required: true },
              filePath: { type: 'string', required: true },
              lastWrittenSeq: { type: 'integer', required: true },
              lastWrittenTurn: { type: 'integer' },
              prevUuid: { type: 'string' },
              lastSize: { type: 'integer', required: true },
              lastVersion: { type: 'string', required: true },
              writtenAt: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => {
        const where = value.target === 'copy' ? '导出副本' : '源文件'
        if (value.status === 'skipped') {
          let why
          if (value.sourceShrunk) why = '源文件缩小（sourceShrunk），跳过写回'
          else if (value.conflictDetected === 'source-modified-externally') why = '源文件被外部修改（size/version 变化），跳过写回'
          else if (value.conflictDetected === 'tail-mismatch') why = '文件尾 uuid 与写回水印失配（tail-mismatch），跳过写回'
          else if (value.conflictDetected === 'write-version-mismatch') why = '并发写者已改动文件（write-version-mismatch），跳过写回'
          else if (value.storedShrunk) why = 'DSH 会话日志比写回水印短（storedShrunk），跳过写回'
          else if (value.precheckFailed) why = '写回预检失败（格式校验不通过），已回滚'
          else why = value.reason || '跳过写回'
          return [{ type: 'text', text: '会话 ' + value.sessionId + ' ' + why + '（' + where + '）。' }]
        }
        if (value.status === 'no-new-turns') {
          return [{ type: 'text', text: '会话 ' + value.sessionId + ' 无新增完整轮次'
            + (value.incompleteFinalTurn ? '（存在进行中的半开轮次，闭合后再同步）' : '')
            + '（' + where + '）。' }]
        }
        return [{ type: 'text', text: (value.dryRun ? '写回预览（dryRun，未写盘）：' : '已写回：')
          + '会话 ' + value.sessionId + ' → ' + value.filePath
          + '（' + value.appendedTurns + ' 轮、' + value.appendedEvents + ' 条事件、' + value.appendedRecords + ' 条记录'
          + (value.conflictDetected || value.sourceShrunk ? '，force 覆盖守卫：' + (value.conflictDetected || 'sourceShrunk') : '')
          + '）。' }]
      },
    },
    async execute(args) {
      return syncClaudeSession(ctx, args, { registryDir })
    },
  }))
  // REQ-33 导入识别 / 撤回（只读）：第 19/20 个工具。平台无 delete 面
  //（sessionPersistence.remove / fs.removeFile 未提供，见 lib/retract.mjs 段落）——
  // list_imported_sessions 只读识别（标记权威 + registry 兜底），retract_import
  // 移除 registry 记录 + 引导手动删工件，绝不调用任何删除。
  ctx.tools.register(defineTool({
    name: 'list_imported_sessions',
    description:
      '只读列出本插件导入的全部 DSH 会话（REQ-33）：按会话日志首事件 session/imported 标记筛选' +
      '（标记是权威信号；日志读不到时用 imports registry 的 dshId 集合兜底），无标记会话不出现。' +
      '每个命中会话返回 sessionId / title（session/title 事件，无显式标题则省略）/ sourcePath / ' +
      'artifactPath（sessionPersistence.locate 报工件路径）/ importedAt。' +
      '零副作用：不落盘、不写 registry、不调用任何删除。返回 { total, sessions }。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                sourcePath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                artifactPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                importedAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '已识别导入会话 ' + value.total + ' 个' + (value.total === 0 ? '' : '\n' + value.sessions.map((s) =>
          '  - ' + s.sessionId + (s.title ? '《' + s.title + '》' : '') + ' ← ' + s.sourcePath
          + '\n    工件路径：' + (s.artifactPath || '无（后端无单会话工件）')).join('\n')),
      }],
    },
    async execute() {
      return listImportedSessions(ctx, registryDir)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'retract_import',
    description:
      '撤回（只读引导，REQ-33）：识别导入会话并移除其 imports registry 记录，输出手动删除工件路径。' +
      '绝不删除会话或工件（平台 sessionPersistence 无 delete 面，本插件不调用任何删除）。' +
      '入参 sessionId 或 sourcePath 二选一：sessionId 从会话日志 session/imported 标记定位源文件' +
      '（标记留在日志，重复撤回幂等）；sourcePath 直接按 registry 幂等键移除。' +
      'registry 记录移除后，按引导删除工件副本再重导即全新导入（副本仍在时重导按 legacy 回填基线幂等跳过）。' +
      '返回 removed:true 与 manualDelete 引导' +
      '（工件路径由 sessionPersistence.locate 给出）。',
    parameters: {
      sessionId: {
        type: 'string',
        description: '要撤回的 DSH 会话 id（与 sourcePath 二选一；从日志标记 / registry 定位源文件）。',
      },
      sourcePath: {
        type: 'string',
        description: '要撤回的源文件路径（与 sessionId 二选一；直接按 registry 幂等键移除记录）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true, const: true },
          sourcePath: { type: 'string', required: true },
          artifactPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          wasRegistered: { type: 'boolean', required: true },
          manualDelete: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '已撤回：registry 记录 ' + value.sourcePath + ' 已移除'
          + (value.wasRegistered ? '' : '（此前已移除，幂等）') + '。\n' + value.manualDelete,
      }],
    },
    async execute(args) {
      return retractImport(ctx, args, registryDir)
    },
  }))
  // REQ-25/REQ-40 会话发现：第 21 个工具，只读扫描（发现核心在 lib/discovery.mjs，
  // host 适配见 lib/discovery-host.mjs；30s TTL 缓存进程内共享 + 持久化 mtime 书签
  // 跨进程免重扫）。零副作用：不写库、不 create/append，registry 只读 loadImports 供
  // importStatus 标注（书签文件是缓存元数据，非会话数据）。
  ctx.tools.register(defineTool({
    name: 'scan_discover',
    description:
      '只读扫描本机 14 种外部聊天记录格式的已知数据根（Claude Code / Codex / Cursor / ' +
      'Gemini CLI / Reasonix / opencode / zcode / Grok Build / OpenClaw / Pi Coding Agent / ' +
      'Hermes / Kimi CLI / ChatGPT 导出 / DSH 会话日志），返回结构化会话索引（format / sessionId / title / project / ' +
      'createdAt / lastActiveAt / messageCount / sourcePath / importStatus），供批导入前预览。' +
      'path 可选：给定时在该根下按格式探测（目录或单文件）；缺省扫全部格式的默认数据根。' +
      'format 可选：只扫指定格式（chatgpt 无自动根，需 path 显式指向 conversations.json；dsh 默认根为 ~/.dsh/sessions）。' +
      'query 可选：按标题 / 项目 / 路径子串过滤（忽略大小写）。' +
      '进程内 30s TTL 缓存：同 key 30 秒内重复扫描直接命中，不重读源文件。' +
      '持久化 mtime/size 书签（scan-cache.json）：跨进程重启后未变文件免重扫。' +
      '只读工具：不写库、不 create/append、不修改任何会话或 registry。返回 { sessions, total }。',
    parameters: {
      path: {
        type: 'string',
        description: '可选：扫描根（目录或单文件，如 ~/.claude/projects、某个 .jsonl 或 conversations.json）。缺省扫全部格式的默认数据根。',
      },
      format: {
        type: 'string',
        enum: FORMATS,
        description: '可选：只扫指定格式；缺省按路径探测全部格式。',
      },
      query: {
        type: 'string',
        description: '可选：按标题 / 项目 / 路径子串过滤（忽略大小写）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                format: { type: 'string', enum: FORMATS, required: true },
                sessionId: { type: 'string', required: true },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                project: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                messageCount: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                sourcePath: { type: 'string', required: true },
                importStatus: { type: 'string', enum: ['imported', 'partial', 'not-imported', 'archived'], required: true },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const byFormat = {}
        for (const s of value.sessions) byFormat[s.format] = (byFormat[s.format] || 0) + 1
        const formatBits = Object.entries(byFormat).map(([f, n]) => f + ' ' + n)
        const imported = value.sessions.filter((s) => s.importStatus === 'imported').length
        const partial = value.sessions.filter((s) => s.importStatus === 'partial').length
        const archived = value.sessions.filter((s) => s.importStatus === 'archived').length
        const pending = value.sessions.filter((s) => s.importStatus === 'not-imported').length
        const statusBits = ['已导入 ' + imported]
        if (partial) statusBits.push('部分 ' + partial)
        if (archived) statusBits.push('已归档 ' + archived)
        statusBits.push('未导入 ' + pending)
        return [{
          type: 'text',
          text: '扫描完成：共发现 ' + value.total + ' 个会话（' + formatBits.join('、') + '；'
            + statusBits.join('、') + '）' + (args.query ? '（query=' + args.query + '）' : ''),
        }]
      },
    },
    async execute(args) {
      return runScanDiscover(ctx, args, registryDir)
    },
  }))
}
