// lib/import-core.mjs — 共享导入编排（标准单文件 / 目录批量状态机 + 标准预览）
//
// 所有标准形态来源（Claude / Codex / Cursor / Gemini / Reasonix / Pi / OpenClaw
// 以及 hermes .jsonl 回退）共用的编排：importTranscript（REQ-24 状态机入口：
// stat → registry 短路径判定 → 读取转换 → decideSingle 决策落盘 → 归组）、
// importDirectory（目录批量，逐文件走同一状态机）、runDecision（执行决策并落盘）、
// attachToWorkspace / warmProjection（归组 + 投影缓存预热）。kimi 的 wire.jsonl
// 单文件也走 importTranscript（经 import-variants.mjs 的 importKimiFile）。
// REQ-17 dry-run 预览的共享件也在此：isPreview / previewEntry / previewTranscript /
// previewDirectory。依赖 ctx（host 服务），非纯函数；不 import 任何 DSH 包。

import { dirname } from 'node:path'
import { persistSession } from './persistence.mjs'
import { markTrimmedSource } from './budget.mjs'
import {
  loadImports, rememberImport, unwrapRecord, listPersistedIds, archivedSessionIds,
  argsFingerprint, isSessionIdChange, decideSingle,
} from './imports.mjs'

// REQ-26：把转换层的畸形行明细 / secrets 位置 / permission 计数附加到公开结果。
// decideItem（lib/imports.mjs）只透传固定字段，这三个字段在此补透；非空才附加
//（schema 均为可选字段，空值不占键）。
export function attachReq26(out, res) {
  if (out.skippedLines && out.skippedLines.length > 0) res.skippedLines = out.skippedLines
  if (out.secrets && out.secrets.length > 0) res.secrets = out.secrets
  if (out.permissionCount && out.permissionCount > 0) res.permissionCount = out.permissionCount
  return res
}

// 把导入的会话挂到其 cwd 对应的工作区（否则会显示为"未分组"）。
// REQ-39-lite 可见性回退：cwd 在本地不存在/不可解析（realpath 拒绝——跨机器迁移
// transcript 的常见情况）时，改用源文件所在目录（源本身是目录则用它自己）归组，
// 避免导入会话全部堆进「未分组」导致在工作区找不到。所有候选都失败才放弃归组。
export async function attachToWorkspace(ctx, meta, sourcePath) {
  const wr = ctx.get('workspaceRegistry')
  if (!wr || typeof wr.resolveByPath !== 'function') return false
  const candidates = []
  if (meta.cwd) candidates.push(meta.cwd)
  if (sourcePath) {
    try {
      const target = await ctx.fs.resolve(sourcePath)
      const info = await ctx.fs.stat(target)
      candidates.push(info && info.type === 'directory' ? sourcePath : dirname(sourcePath))
    } catch {
      // 源路径 stat 失败（已删除等）：跳过源目录回退，仅剩 cwd 候选
    }
  }
  for (const path of candidates) {
    try {
      let ws = await wr.resolveByPath(path)
      if (!ws) ws = await wr.create(path)
      await ws.attachSession(meta.id)
      return true
    } catch (err) {
      console.error('workspace attach failed for ' + path + ':', String((err && err.message) || err))
    }
  }
  return false
}

// 预热投影缓存：冷读一次持久化会话并回写，让侧边栏无需打开会话即可显示
// 标题/模型等元数据（否则列表先显示 cwd 目录名，点开后才出现真实标题）。
// 失败不影响导入结果，仅记录日志。
export async function warmProjection(ctx, sessionId) {
  const projectionCache = ctx.get('sessionProjectionCache')
  if (!projectionCache || typeof projectionCache.coldSnapshot !== 'function') return false
  try {
    await projectionCache.coldSnapshot(sessionId)
    return true
  } catch (err) {
    console.error('projection warm-up failed:', String((err && err.message) || err))
    return false
  }
}

// 执行 decideSingle / decideMulti 返回的决策并落盘；剥离 __ 载荷后返回公开结果。
// create 时才归组（append 续写不重复 attachToWorkspace）；persisted 就地更新供批量
// 内 id 避让；__record（新导入记录）经 rememberImport 写回 registry。
export async function runDecision(ctx, decision, registryDir, sourcePath, persisted) {
  if (decision.__action === 'create') {
    const { __meta, __events } = decision
    await persistSession(ctx, { meta: __meta, events: __events })
    await attachToWorkspace(ctx, __meta, sourcePath)
    await warmProjection(ctx, __meta.id)
    persisted.add(__meta.id)
  } else if (decision.__action === 'append') {
    await persistSession(ctx, { id: decision.__targetId, events: decision.__tailEvents })
  } else if (decision.__action === 'multi') {
    for (const c of decision.__creates) {
      await persistSession(ctx, { meta: c.meta, events: c.events })
      await attachToWorkspace(ctx, c.meta, sourcePath)
      await warmProjection(ctx, c.meta.id)
      persisted.add(c.meta.id)
    }
    for (const a of decision.__appends) {
      await persistSession(ctx, { id: a.targetId, events: a.events })
    }
  }
  if (decision.__record) await rememberImport(registryDir, sourcePath, decision.__record)
  const pub = {}
  for (const [k, v] of Object.entries(decision)) {
    if (!k.startsWith('__')) pub[k] = v
  }
  return pub
}

// 解析单个 transcript（REQ-24 状态机入口）：stat → registry 短路径判定 → 读取转换 →
// decideSingle 决策落盘 → 归组。幂等键 = sourcePath（fs 服务归一化路径）。persisted
// 可传入共享快照（批量模式），缺省按需取一次。
export async function importTranscript(ctx, target, args, convert, { registryDir, persisted, fingerprintKeys = [], readText } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[sourcePath])
  // 同路径若已是多会话源导入（kind:'multi'，子表结构不适用于单会话状态机）→ 视作
  // 无记录重导；撞 id 由 persisted 避让 / legacy 回填兜底。
  if (known && known.kind !== 'single') known = null
  // 记录指向的会话已不存在（被删 / DSH_HOME 迁移）或被归档（隐藏但仍占 id）
  // → 视作无记录重导（归档会话保留，重导建后缀新副本）
  if (known && (!known.dshId || !persistedSet.has(known.dshId) || archivedIds.has(known.dshId))) known = null
  const fingerprint = argsFingerprint(args, fingerprintKeys)

  // S3 短路径（不 readText）：force / 显式 sessionId 变更需读文件建副本，不在此跳过
  if (known && args.force !== true && !isSessionIdChange(args, known.dshId)) {
    if (typeof known.args === 'string' && fingerprint !== known.args) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', argsChanged: true }
    }
    // REQ-37：预算变化（文件未变）→ 跳过并报告（同 argsChanged 语义）；需要按新预算
    // 导入用 force:true。budget 为 index 层解析后的实际预算（registry 记录同一口径）。
    if (typeof known.budget === 'number' && known.budget !== args.budget) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', budgetChanged: true }
    }
    if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
      // 未变：短路径跳过（不 readText），重复导入同一会话幂等
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported' }
    }
  }

  const raw = readText ? await readText(ctx, target) : await ctx.fs.readText(target)
  const out = markTrimmedSource(convert(raw, { ...args, sourcePath }), args)
  // 无可导入内容（空文件 / 非目标格式 / 辅助 transcript）：计入 skipped，不落盘空会话
  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return attachReq26(out, res)
  }
  const decision = await decideSingle(ctx, { known, converted: out, stat, args, fingerprint, persisted: persistedSet, sourcePath, budget: args.budget, archivedIds })
  return attachReq26(out, await runDecision(ctx, decision, registryDir, sourcePath, persistedSet))
}

// 递归收集目录下的 .jsonl 文件。顺序依赖 ctx.fs.listDir 的名称排序契约（mock host
// 按名排序，真实 fs 服务同契），collector 自身不做二次排序。
export async function collectJsonlFiles(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive) await collectJsonlFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && /\.jsonl$/i.test(entry.name) && !isSidecarJsonl(entry.name)) {
      out.push(entry.target)
    }
  }
}

// 会话主 transcript 的伴生 JSONL（事件日志 / 冲突日志 / 守护文件）不是会话本身，
// 目录批量扫描时排除（Reasonix V2 的 <id>.events.jsonl 是 WAL，非主 transcript）。
export function isSidecarJsonl(name) {
  return /\.(events|conflicts|guardian)\.jsonl$/i.test(name)
}

// 递归收集目录下的 .json 文件（ChatGPT 导出）。顺序依赖 ctx.fs.listDir 的名称排序
// 契约（同 collectJsonlFiles）。
export async function collectJsonFiles(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive) await collectJsonFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && /\.json$/i.test(entry.name)) {
      out.push(entry.target)
    }
  }
}

// 把单文件结果归一为批量 results 条目（skipReason → reason；可选字段原样带过）。
export function batchItem(path, single) {
  const item = {
    path,
    status: single.status,
    sessionId: single.sessionId,
    turns: single.turns,
    messages: single.messages,
    toolCalls: single.toolCalls,
    skipped: single.skipped,
  }
  for (const k of ['skipReason', 'error', 'appendedTurns', 'appendedEvents', 'appendedSkipped', 'sourceShrunk', 'changedInPlace', 'argsChanged', 'budgetChanged', 'backfilled', 'droppedBoundaryResults', 'forceImported', 'trimmed', 'skippedLines', 'secrets', 'permissionCount']) {
    if (single[k] !== undefined) item[k === 'skipReason' ? 'reason' : k] = single[k]
  }
  return item
}

// 批量导入：把目录下匹配 pattern 的文件都作为独立会话导入（每个文件走
// importTranscript 状态机，共享 persisted 快照与 registry 目录）。
// deriveArgs(target) 允许按文件派生转换参数（可 async；Cursor 取文件名 composer id，
// Reasonix 读同目录 meta.json 拿 workspace/summary）；collect 默认收集 .jsonl。
export async function importDirectory(ctx, dirTarget, args, { convert, sourceLabel, deriveArgs, collect, registryDir, fingerprintKeys = [], readText }) {
  const files = []
  const collector = collect || collectJsonlFiles
  await collector(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  const persisted = await listPersistedIds(ctx)
  for (const target of files) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const derived = deriveArgs ? await deriveArgs(target) : {}
      // 展开 args（含 REQ-37 预算 budget/budgetSource），deriveArgs 可覆盖
      const single = await importTranscript(ctx, target, { ...args, ...derived, force: args.force === true }, convert, { registryDir, persisted, fingerprintKeys, readText })
      if (single.status === 'imported') imported++
      else if (single.status === 'appended') appended++
      else if (single.status === 'already-imported') alreadyImported++
      else skipped++
      const item = batchItem(path, single)
      if (item.status === 'skipped' && !item.reason) item.reason = 'not a ' + sourceLabel + ' transcript (no user turns)'
      results.push(item)
    } catch (err) {
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: files.length, imported, alreadyImported, appended, skipped, failed, results }
}

// ── REQ-17 导入 dry-run 预览（preview / dryRun 别名）────────────────────────
// preview=true 时照常 resolve / readText / convert（拿到 meta/turns/title/messages/
// toolCalls/skipped 等统计），但绝不 create/append、绝不写 imports registry、绝不
// attachToWorkspace（零副作用）；也不触发增量续写 / 幂等 registry 读写——预览分支
// 完全绕开 loadImports / listPersistedIds / decideSingle / decideMulti / runDecision，
// 只做只读转换 + 统计。返回结构与正式导入同源（同 mode/total/results 骨架），只加
// preview:true 标记、去掉写入态字段（sessionId/status/alreadyImported 等）。
export function isPreview(args) {
  return !!(args && (args.preview === true || args.dryRun === true))
}

// 把转换输出压成预览条目：标题 / cwd / 时间 / 规模 / 跳过明细。与正式结果同口径
//（turns/messages/toolCalls/skipped 同 decideItem base 的来源），无值字段不占键。
// 跳过语义对齐 importTranscript：无可导入内容时该文件计 1 次跳过（正式 skipped 结果
// 即 hardcode skipped:1，不看转换层的畸形行计数）。
export function previewEntry(out) {
  const noContent = !out.meta || (Array.isArray(out.turns) && out.turns.length === 0 && Array.isArray(out.events) && out.events.length === 0)
  const entry = {
    turns: Array.isArray(out.turns) ? out.turns.length : 0,
    messages: out.messages || 0,
    toolCalls: out.toolCalls || 0,
    skipped: noContent ? 1 : (out.skipped || 0),
  }
  if (out.title) entry.title = out.title
  if (out.meta && typeof out.meta.cwd === 'string' && out.meta.cwd) entry.cwd = out.meta.cwd
  if (out.meta && typeof out.meta.createdAt === 'number') entry.createdAt = out.meta.createdAt
  if (out.skipReason) entry.skipReason = out.skipReason
  return entry
}

// 标准单文件预览：readText + convert（与 importTranscript 同源），零副作用。
export async function previewTranscript(ctx, target, args, convert, { readText } = {}) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const raw = readText ? await readText(ctx, target) : await ctx.fs.readText(target)
  const out = markTrimmedSource(convert(raw, { ...args, sourcePath }), args)
  return previewEntry(out)
}

// 标准目录预览：逐文件 readText + convert（与 importDirectory 同源），零副作用。
export async function previewDirectory(ctx, dirTarget, args, { convert, deriveArgs, collect, readText } = {}) {
  const files = []
  const collector = collect || collectJsonlFiles
  await collector(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  for (const target of files) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const derived = deriveArgs ? await deriveArgs(target) : {}
      const raw = readText ? await readText(ctx, target) : await ctx.fs.readText(target)
      const out = markTrimmedSource(convert(raw, { ...args, ...derived, sourcePath: path }), args)
      results.push({ path, ...previewEntry(out) })
    } catch (err) {
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: files.length, results }
}
