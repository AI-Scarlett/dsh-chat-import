import { persistenceFor } from './persistence.mjs'
// lib/export-tool.mjs — export_claude 反向导出（REQ-16）：把 DSH 会话日志只读
// 序列化为 Claude Code JSONL。只消费 sessionPersistence（list + readFrom）+ fs
// （resolve + writeText），绝不 load/prepare、绝不改写会话日志（append-only 只读
// 来源）。文件写到 <outputDir>/<slug>/<uuid>.jsonl（新 uuid v4 铸键 + createIfAbsent
// 不覆盖双保险；dryRun 不写盘）。uuid 工厂可注入（测试确定性），默认 randomUUID。
// 导入会话（日志带 session/imported 标记）导出成功后把 mapping 落进 imports
// registry（record.exports = [mapping]），供 REQ-36 sync_to_claude 的 target:'copy'
// 定位写回副本；原生会话无 sourcePath 键，不落库（mapping 仍在返回值里）。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { slugifyClaudeCwd, serializeClaudeJsonl } from '../export.mjs'
import { loadImports, rememberImport, unwrapRecord } from './imports.mjs'

export async function exportClaudeSession(ctx, args, { uuid = randomUUID, registryDir } = {}) {
  const sp = persistenceFor(ctx)
  if (!sp || typeof sp.list !== 'function' || typeof sp.readFrom !== 'function') {
    throw new Error('sessionPersistence 不可用（需要 list + readFrom）')
  }
  const headers = await sp.list()
  const header = headers.find((h) => h.id === args.sessionId)
  if (!header) throw new Error('会话不存在: ' + args.sessionId)
  const { meta, events } = await sp.readFrom(args.sessionId, 0)
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : header.cwd
  if (typeof cwd !== 'string' || !cwd) {
    throw new Error('导出需要 cwd：会话 header 无 cwd 且未提供 cwd 参数')
  }
  const sessionUuid = uuid()
  const slug = slugifyClaudeCwd(cwd)
  const out = serializeClaudeJsonl({ meta, events, sessionUuid, cwd, version: args.version, gitBranch: args.gitBranch }, { uuid })
  const filePath = join(args.outputDir || join(homedir(), '.claude', 'projects'), slug, sessionUuid + '.jsonl')
  if (args.dryRun !== true) {
    const target = await ctx.fs.resolve(filePath)
    await ctx.fs.writeText(target, out.jsonl, { kind: 'createIfAbsent', displayPath: filePath })
  }
  const mapping = {
    sourceSessionId: args.sessionId,
    sessionUuid,
    slug,
    filePath,
    turns: (events ?? []).filter((e) => e && e.type === 'turn/start').length,
    messages: (events ?? []).filter((e) => e && (e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')).length,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    droppedToolResults: out.droppedToolResults,
    skippedInjections: out.skippedInjections,
  }
  // 导入会话（带 session/imported 标记）导出成功后把 mapping 落进 registry
  // （exports[0] 即 REQ-36 写回副本映射）；原生会话无 sourcePath 键，跳过
  if (registryDir && args.dryRun !== true) {
    const first = Array.isArray(events) && events.length > 0 ? events[0] : undefined
    if (first && first.type === 'session/imported' && first.data && typeof first.data.sourcePath === 'string') {
      const reg = await loadImports(registryDir)
      const record = unwrapRecord(reg.imports[first.data.sourcePath])
      if (record) await rememberImport(registryDir, first.data.sourcePath, { ...record, exports: [mapping] })
    }
  }
  return {
    mode: 'single',
    sessionId: sessionUuid,
    sourceSessionId: args.sessionId,
    filePath,
    slug,
    cwd,
    recordCount: out.recordCount,
    ...(out.title ? { title: out.title } : {}),
    dryRun: args.dryRun === true,
    mapping,
  }
}
