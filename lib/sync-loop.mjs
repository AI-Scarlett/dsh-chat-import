/* global setInterval, clearInterval */
// lib/sync-loop.mjs — 双向增量同步编排（控制面板 + 定时巡检）
//
// 入站：对开启的来源跑 discover → importDiscoveryItem（复用幂等 / 续写状态机）。
// 出站：把 DSH 会话增量写回 Claude / Codex / Grok。导入源走源文件；原生会话
// 在对应 agent 默认根下落一份副本（outbound.json 记映射）。
// 默认关闭；apply 时不启定时器，避免测试进程挂起。只有面板打开开关才巡检。

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { discoverSessions } from './discovery.mjs'
import { makeDiscoveryHost } from './discovery-host.mjs'
import { loadImports, rememberImport, unwrapRecord, archivedSessionIds } from './imports.mjs'
import { resolveImportBudget } from './budget.mjs'
import { importTranscript } from './import-core.mjs'
import { importGrokbuildSession } from './import-variants.mjs'
import { syncClaudeSession } from './backfill.mjs'
import { serializeClaudeJsonl, serializeClaudeJsonlTail, tailClaudeEvents, verifyClaudeJsonl, slugifyClaudeCwd } from '../export.mjs'
import { serializeCodexJsonl, serializeCodexJsonlTail, verifyCodexJsonl } from './export/codex.mjs'
import { serializeGrokbuildJsonl, serializeGrokbuildJsonlTail, verifyGrokbuildJsonl, buildGrokSummary } from './export/grokbuild.mjs'
import { convertClaudeJsonl, convertCodexJsonl, convertGrokbuildJson } from '../convert.mjs'
import {
  loadSyncConfig, saveSyncConfig, loadOutboundMap, saveOutboundMap, SYNC_FORMATS,
} from './sync-config.mjs'

const FORMAT_SOURCE = {
  claude: 'claude-code',
  codex: 'codex',
  grokbuild: 'grokbuild',
}

const TOOL_FORMAT = {
  'claude-code': 'claude',
  claude: 'claude',
  codex: 'codex',
  grokbuild: 'grokbuild',
}

const lastStatus = {
  running: false,
  lastRunAt: null,
  lastError: null,
  inbound: null,
  outbound: null,
}

let timer = null
let timerCtx = null
let timerRegistryDir = null

function homeDir() {
  return process.env.HOME || homedir()
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function localStamp(ms) {
  const d = new Date(ms || Date.now())
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds())
}

export function encodeGrokCwd(cwd) {
  return encodeURIComponent(String(cwd || ''))
}

export function defaultCodexPath(sessionUuid, createdAt, home = homeDir(), root) {
  const d = new Date(createdAt || Date.now())
  const y = d.getFullYear()
  const m = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const base = root || join(home, '.codex', 'sessions')
  return join(base, String(y), m, day, 'rollout-' + localStamp(d.getTime()) + '-' + sessionUuid + '.jsonl')
}

export function defaultClaudePath(sessionUuid, cwd, home = homeDir(), root) {
  const base = root || join(home, '.claude', 'projects')
  return join(base, slugifyClaudeCwd(cwd || home), sessionUuid + '.jsonl')
}

export function defaultGrokDir(sessionUuid, cwd, home = homeDir(), root) {
  const base = root || join(home, '.grok', 'sessions')
  return join(base, encodeGrokCwd(cwd || home), sessionUuid)
}

function sessionTitle(events, fallback) {
  for (const ev of events || []) {
    if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title.trim()) {
      return ev.data.title.trim()
    }
  }
  return fallback || ''
}

function importedMarker(events) {
  const first = Array.isArray(events) && events[0]
  if (!first || first.type !== 'session/imported' || !first.data) return null
  return first.data
}

function outboundPaths(map) {
  const set = new Set()
  const mappings = map && map.mappings && typeof map.mappings === 'object' ? map.mappings : {}
  for (const entry of Object.values(mappings)) {
    if (!entry || typeof entry !== 'object') continue
    for (const slot of Object.values(entry)) {
      if (!slot || typeof slot !== 'object') continue
      if (typeof slot.filePath === 'string') set.add(slot.filePath)
      if (typeof slot.dirPath === 'string') set.add(slot.dirPath)
    }
  }
  return set
}

function stageOutbound(mapState, sessionId, targetFormat, mapping) {
  const current = mapState.map.mappings[sessionId]
  const entry = current && typeof current === 'object' ? current : {}
  mapState.map.mappings[sessionId] = { ...entry, [targetFormat]: mapping }
  mapState.dirty = true
}

function sourceRevisionOf(revision) {
  return typeof revision === 'string' ? revision : String(revision)
}

async function ensureParent(filePath) {
  await mkdir(dirname(filePath), { recursive: true })
}

async function writeNew(ctx, filePath, content) {
  await ensureParent(filePath)
  const target = await ctx.fs.resolve(filePath)
  await ctx.fs.writeText(target, content, { kind: 'createIfAbsent', displayPath: filePath })
}

async function appendFile(ctx, filePath, existing, tail, verify) {
  const target = await ctx.fs.resolve(filePath)
  const stat = await ctx.fs.stat(target)
  if (!stat || stat.type !== 'file') throw new Error('写回目标不存在: ' + filePath)
  const newContent = existing.endsWith('\n') ? existing + tail : existing + '\n' + tail
  const check = verify(newContent)
  if (!check.ok) return { ok: false, precheck: check }
  const outcome = await ctx.fs.writeText(target, newContent, { kind: 'replaceIfVersion', version: stat.version })
  return { ok: true, content: newContent, version: outcome && outcome.version, size: newContent.length }
}

function countTurns(events) {
  let n = 0
  for (const ev of events || []) if (ev && ev.type === 'turn/start') n++
  return n
}

function lastTurnOf(events) {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.type === 'turn/end' && ev.data && typeof ev.data.turn === 'number') return ev.data.turn
  }
  return countTurns(events)
}

async function inboundOnce(ctx, registryDir, config, { home, path } = {}) {
  const formats = config.inbound.enabled ? config.inbound.formats : []
  const summary = { scanned: 0, imported: 0, appended: 0, skipped: 0, failed: 0, errors: [] }
  if (formats.length === 0) return summary
  const registry = await loadImports(registryDir)
  const outbound = await loadOutboundMap(registryDir)
  const skipPaths = outboundPaths(outbound)
  const budgetInfo = await resolveImportBudget(ctx, {})
  const host = makeDiscoveryHost(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const sessions = []
  for (const format of formats) {
    const found = await discoverSessions({
      format,
      host,
      home,
      path: formats.length === 1 ? path : undefined,
      imports: registry.imports,
      cacheDir: registryDir,
      archivedIds,
    })
    for (const s of found.sessions || []) {
      if (!skipPaths.has(s.sourcePath)) sessions.push(s)
    }
  }
  summary.scanned = sessions.length
  for (const s of sessions) {
    try {
      const args = { path: s.sourcePath, force: false, budget: budgetInfo.budget, budgetSource: budgetInfo.source }
      const target = await ctx.fs.resolve(s.sourcePath)
      const out = s.format === 'grokbuild'
        ? await importGrokbuildSession(ctx, target, args, { registryDir })
        : await importTranscript(ctx, target, args, s.format === 'codex' ? convertCodexJsonl : convertClaudeJsonl, { registryDir })
      if (out.mode === 'batch') {
        summary.imported += out.imported || 0
        summary.appended += out.appended || 0
        summary.skipped += (out.alreadyImported || 0) + (out.skipped || 0)
        summary.failed += out.failed || 0
      } else if (out.status === 'imported') summary.imported++
      else if (out.status === 'appended') summary.appended++
      else if (out.status === 'failed') summary.failed++
      else summary.skipped++
    } catch (err) {
      summary.failed++
      if (summary.errors.length < 8) {
        summary.errors.push({ sourcePath: s.sourcePath, error: String((err && err.message) || err) })
      }
    }
  }
  return summary
}

async function serializeFull(format, payload) {
  if (format === 'claude') return serializeClaudeJsonl(payload)
  if (format === 'codex') return serializeCodexJsonl(payload)
  return serializeGrokbuildJsonl(payload)
}

async function serializeTail(format, payload) {
  if (format === 'claude') return serializeClaudeJsonlTail(payload)
  if (format === 'codex') return serializeCodexJsonlTail(payload)
  return serializeGrokbuildJsonlTail(payload)
}

function verifyOf(format) {
  if (format === 'claude') return verifyClaudeJsonl
  if (format === 'codex') return verifyCodexJsonl
  return verifyGrokbuildJsonl
}

async function convertExisting(format, ctx, mapping) {
  if (format === 'grokbuild') {
    const dir = mapping.dirPath
    const chatTarget = await ctx.fs.resolve(join(dir, 'chat_history.jsonl'))
    const chatStat = await ctx.fs.stat(chatTarget)
    if (!chatStat || chatStat.type !== 'file') return { missing: true }
    const summaryTarget = await ctx.fs.resolve(join(dir, 'summary.json'))
    let summaryText = '{}'
    try { summaryText = await ctx.fs.readText(summaryTarget) } catch { /* 仅有历史、无 summary */ }
    const chatText = await ctx.fs.readText(chatTarget)
    return { converted: convertGrokbuildJson(summaryText, chatText, {}), chatText, summaryText, dir, stat: chatStat }
  }
  const target = await ctx.fs.resolve(mapping.filePath)
  const stat = await ctx.fs.stat(target)
  if (!stat || stat.type !== 'file') return { missing: true }
  const text = await ctx.fs.readText(target)
  const converted = format === 'claude' ? convertClaudeJsonl(text, {}) : convertCodexJsonl(text, {})
  return { converted, text, stat }
}

async function seedMapping(ctx, format, header, meta, events, sourcePath, roots = {}) {
  const sessionUuid = randomUUID()
  const cwd = header.cwd || meta.cwd || homeDir()
  if (format === 'claude') {
    return { filePath: sourcePath || defaultClaudePath(sessionUuid, cwd, homeDir(), roots.claude), sessionUuid, lastWrittenSeq: 0, lastWrittenTurn: 0 }
  }
  if (format === 'codex') {
    return { filePath: sourcePath || defaultCodexPath(sessionUuid, header.createdAt || meta.createdAt, homeDir(), roots.codex), sessionUuid, lastWrittenSeq: 0, lastWrittenTurn: 0 }
  }
  const dir = sourcePath || defaultGrokDir(sessionUuid, cwd, homeDir(), roots.grokbuild)
  return { dirPath: dir, filePath: join(dir, 'chat_history.jsonl'), sessionUuid, lastWrittenSeq: 0, lastWrittenTurn: 0 }
}

async function writeGrokSummary(ctx, mapping, header, meta, events, dryRun) {
  const summary = buildGrokSummary({
    sessionUuid: mapping.sessionUuid,
    cwd: header.cwd || meta.cwd || '',
    title: sessionTitle(events, header.title),
    createdAt: meta.createdAt || header.createdAt,
    updatedAt: Date.now(),
    numMessages: (events || []).filter((e) => e && (e.type === 'user/message' || e.type === 'assistant/message')).length,
  })
  const path = join(mapping.dirPath, 'summary.json')
  if (dryRun) return
  await ensureParent(path)
  const target = await ctx.fs.resolve(path)
  const stat = await ctx.fs.stat(target)
  const text = JSON.stringify(summary, null, 2) + '\n'
  if (!stat || stat.type !== 'file') {
    await ctx.fs.writeText(target, text, { kind: 'createIfAbsent', displayPath: path })
  } else {
    try {
      await ctx.fs.writeText(target, text, { kind: 'replaceIfVersion', version: stat.version })
    } catch {
      // 摘要刷新失败不阻断历史写回
    }
  }
}

async function outboundOne(ctx, registryDir, mapState, header, targetFormat, revision, dryRun, roots = {}, mappingSeed) {
  const sp = ctx.get('sessionPersistence')
  const { meta, events } = await sp.readFrom(header.id, 0)
  const marker = importedMarker(events)
  const originFormat = marker && marker.tool ? TOOL_FORMAT[marker.tool] : null
  const entry = (mapState.map.mappings[header.id] && typeof mapState.map.mappings[header.id] === 'object')
    ? mapState.map.mappings[header.id]
    : {}
  let mapping = mappingSeed || entry[targetFormat]
  if (mapping && typeof mapping === 'object') mapping = { ...mapping }
  const sourcePath = marker && typeof marker.sourcePath === 'string' ? marker.sourcePath : null
  const useSource = originFormat === targetFormat && sourcePath
  const sourceRevision = sourceRevisionOf(revision)

  if (targetFormat === 'claude' && useSource && !dryRun) {
    try {
      const out = await syncClaudeSession(ctx, { sessionId: header.id, target: 'source', dryRun }, { registryDir })
      if (out.status === 'synced' || out.status === 'no-new-turns') {
        stageOutbound(mapState, header.id, targetFormat, { ...(mapping || {}), sourceRevision })
      }
      return { format: targetFormat, sessionId: header.id, ...out }
    } catch (err) {
      return { format: targetFormat, sessionId: header.id, status: 'failed', error: String((err && err.message) || err) }
    }
  }

  if (!mapping) {
    mapping = await seedMapping(ctx, targetFormat, header, meta || header, events, useSource ? sourcePath : null, roots)
  }

  const cwd = header.cwd || (meta && meta.cwd) || homeDir()
  const payloadBase = { meta, sessionUuid: mapping.sessionUuid, cwd }

  if (!mapping.lastWrittenSeq) {
    const existingSeed = await convertExisting(targetFormat, ctx, mapping)
    if (!existingSeed.missing) {
      const fileEvents = existingSeed.converted && Array.isArray(existingSeed.converted.events)
        ? existingSeed.converted.events.length
        : 0
      mapping = {
        ...mapping,
        lastWrittenSeq: fileEvents > 0 ? fileEvents : events.length,
        lastWrittenTurn: existingSeed.converted && Array.isArray(existingSeed.converted.turns)
          ? existingSeed.converted.turns.length
          : lastTurnOf(events),
        lastSize: (existingSeed.chatText !== undefined ? existingSeed.chatText : existingSeed.text || '').length,
        writtenAt: Date.now(),
      }
      if (!dryRun) stageOutbound(mapState, header.id, targetFormat, mapping)
    } else {
      let full
      try {
        full = await serializeFull(targetFormat, { ...payloadBase, events })
      } catch (err) {
        return { format: targetFormat, sessionId: header.id, status: 'skipped', reason: String((err && err.message) || err) }
      }
      if (dryRun) {
        return { format: targetFormat, sessionId: header.id, status: 'synced', dryRun: true, filePath: mapping.filePath, appendedRecords: full.recordCount }
      }
      if (targetFormat === 'grokbuild') {
        await ensureParent(mapping.filePath)
        await writeNew(ctx, mapping.filePath, full.jsonl)
        await writeGrokSummary(ctx, mapping, header, meta || header, events, dryRun)
      } else {
        await writeNew(ctx, mapping.filePath, full.jsonl)
      }
      const next = {
        ...mapping,
        lastWrittenSeq: events.length,
        lastWrittenTurn: lastTurnOf(events),
        lastSize: full.jsonl.length,
        writtenAt: Date.now(),
        sourceRevision,
      }
      stageOutbound(mapState, header.id, targetFormat, next)
      return { format: targetFormat, sessionId: header.id, status: 'synced', filePath: mapping.filePath, appendedTurns: countTurns(events), appendedRecords: full.recordCount, dryRun: false }
    }
  }

  const existing = await convertExisting(targetFormat, ctx, mapping)
  if (existing.missing) {
    return outboundOne(ctx, registryDir, mapState, header, targetFormat, revision, dryRun, roots, {
      ...mapping,
      lastWrittenSeq: 0,
      lastWrittenTurn: 0,
    })
  }
  if (mapping.lastSize && existing.stat && existing.stat.size < mapping.lastSize) {
    return { format: targetFormat, sessionId: header.id, status: 'skipped', sourceShrunk: true, filePath: mapping.filePath }
  }
  const tail = tailClaudeEvents(events, { fromSeq: mapping.lastWrittenSeq })
  if (tail.events.length === 0) {
    if (!dryRun) stageOutbound(mapState, header.id, targetFormat, { ...mapping, sourceRevision })
    return { format: targetFormat, sessionId: header.id, status: 'no-new-turns', filePath: mapping.filePath, dryRun, ...(tail.droppedIncompleteTurn ? { incompleteFinalTurn: true } : {}) }
  }
  let piece
  try {
    piece = await serializeTail(targetFormat, { ...payloadBase, events: tail.events })
  } catch (err) {
    return { format: targetFormat, sessionId: header.id, status: 'skipped', reason: String((err && err.message) || err) }
  }
  if (dryRun) {
    return { format: targetFormat, sessionId: header.id, status: 'synced', dryRun: true, filePath: mapping.filePath, appendedTurns: countTurns(tail.events), appendedRecords: piece.recordCount }
  }
  const body = existing.chatText !== undefined ? existing.chatText : existing.text
  if (targetFormat === 'grokbuild') {
    await ensureParent(mapping.filePath)
    const target = await ctx.fs.resolve(mapping.filePath)
    const stat = await ctx.fs.stat(target)
    const newContent = (body || '').endsWith('\n') || !body ? (body || '') + piece.jsonl : body + '\n' + piece.jsonl
    const check = verifyGrokbuildJsonl(newContent)
    if (!check.ok) return { format: targetFormat, sessionId: header.id, status: 'skipped', precheckFailed: true, precheck: check }
    if (!stat || stat.type !== 'file') await writeNew(ctx, mapping.filePath, newContent)
    else await ctx.fs.writeText(target, newContent, { kind: 'replaceIfVersion', version: stat.version })
    await writeGrokSummary(ctx, mapping, header, meta || header, events, dryRun)
  } else {
    const appended = await appendFile(ctx, mapping.filePath, body || '', piece.jsonl, verifyOf(targetFormat))
    if (!appended.ok) return { format: targetFormat, sessionId: header.id, status: 'skipped', precheckFailed: true, precheck: appended.precheck }
  }
  const next = {
    ...mapping,
    lastWrittenSeq: events.length,
    lastWrittenTurn: lastTurnOf(tail.events),
    lastSize: (body || '').length + piece.jsonl.length,
    writtenAt: Date.now(),
    sourceRevision,
  }
  stageOutbound(mapState, header.id, targetFormat, next)
  if (useSource && sourcePath) {
    const rec = unwrapRecord((await loadImports(registryDir)).imports[sourcePath])
    if (rec && rec.kind === 'single') {
      await rememberImport(registryDir, sourcePath, {
        ...rec,
        turns: lastTurnOf(events),
        events: events.length,
        sizeBytes: next.lastSize,
      })
    }
  }
  return {
    format: targetFormat,
    sessionId: header.id,
    status: 'synced',
    filePath: mapping.filePath,
    appendedTurns: countTurns(tail.events),
    appendedRecords: piece.recordCount,
    dryRun: false,
  }
}

async function outboundOnce(ctx, registryDir, config, dryRun) {
  const targets = config.outbound.enabled ? config.outbound.targets : []
  const summary = {
    sessions: 0,
    candidates: 0,
    processed: 0,
    deferred: 0,
    unchanged: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    mapWrites: 0,
    results: [],
  }
  if (targets.length === 0) return summary
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.listSnapshots !== 'function' || typeof sp.readFrom !== 'function') {
    return { ...summary, failed: 1, results: [{ status: 'failed', error: 'sessionPersistence 不可用（rc.8 需要 listSnapshots + readFrom）' }] }
  }
  const snapshots = await sp.listSnapshots()
  const mapState = { map: await loadOutboundMap(registryDir), dirty: false }
  summary.sessions = snapshots.length
  const candidates = []
  for (const snapshot of snapshots) {
    const entry = mapState.map.mappings[snapshot.header.id]
    const revision = sourceRevisionOf(snapshot.revision)
    const pendingTargets = targets.filter((format) => {
      const mapping = entry && typeof entry === 'object' ? entry[format] : undefined
      return !mapping || mapping.sourceRevision !== revision
    })
    if (pendingTargets.length === 0) summary.unchanged++
    else candidates.push({ header: snapshot.header, revision, targets: pendingTargets })
  }
  summary.candidates = candidates.length
  const limit = config.maxSessionsPerRun
  const selected = candidates.slice(0, limit)
  summary.processed = selected.length
  summary.deferred = candidates.length - selected.length
  for (const candidate of selected) {
    for (const format of candidate.targets) {
      try {
        const one = await outboundOne(
          ctx,
          registryDir,
          mapState,
          candidate.header,
          format,
          candidate.revision,
          dryRun,
          config.outbound.roots || {},
        )
        if (one.status === 'synced') summary.synced++
        else if (one.status === 'failed') summary.failed++
        else summary.skipped++
        if (summary.results.length < 40) summary.results.push(one)
      } catch (err) {
        summary.failed++
        if (summary.results.length < 40) {
          summary.results.push({ format, sessionId: candidate.header.id, status: 'failed', error: String((err && err.message) || err) })
        }
      }
    }
  }
  if (mapState.dirty && !dryRun) {
    await saveOutboundMap(registryDir, mapState.map)
    summary.mapWrites = 1
  }
  return summary
}

export async function runSyncOnce(ctx, registryDir, { dryRun = false, home, path } = {}) {
  if (lastStatus.running) return { ok: false, error: '同步正在进行', ...lastStatus }
  lastStatus.running = true
  lastStatus.lastError = null
  try {
    const config = await loadSyncConfig(registryDir)
    const inbound = await inboundOnce(ctx, registryDir, config, { home, path })
    const outbound = await outboundOnce(ctx, registryDir, config, dryRun)
    const lastRun = { at: Date.now(), inbound, outbound, dryRun }
    await saveSyncConfig(registryDir, { ...config, lastRun })
    lastStatus.lastRunAt = lastRun.at
    lastStatus.inbound = inbound
    lastStatus.outbound = outbound
    return { ok: true, config: await loadSyncConfig(registryDir), inbound, outbound, dryRun }
  } catch (err) {
    lastStatus.lastError = String((err && err.message) || err)
    return { ok: false, error: lastStatus.lastError }
  } finally {
    lastStatus.running = false
  }
}

export function getSyncStatus() {
  return { ...lastStatus, timerActive: timer !== null, formats: SYNC_FORMATS }
}

export function stopSyncTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export async function startSyncTimer(ctx, registryDir) {
  timerCtx = ctx
  timerRegistryDir = registryDir
  stopSyncTimer()
  const config = await loadSyncConfig(registryDir)
  if (!config.inbound.enabled && !config.outbound.enabled) return config
  timer = setInterval(() => {
    runSyncOnce(timerCtx, timerRegistryDir).catch((err) => {
      lastStatus.lastError = String((err && err.message) || err)
    })
  }, config.intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return config
}

export function registerSyncLoop(ctx, registryDir) {
  startSyncTimer(ctx, registryDir).catch((err) => {
    console.warn('[dsh-chat-import] 同步定时器启动失败：' + String((err && err.message) || err))
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => stopSyncTimer())
  }
}

export { FORMAT_SOURCE, lastStatus }
