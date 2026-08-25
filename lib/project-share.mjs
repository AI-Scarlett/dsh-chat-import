// lib/project-share.mjs — same-project, on-demand session sharing.
//
// This is deliberately not an importer. Listing reads metadata only; reading one selected
// session streams its source and returns a bounded user/assistant excerpt. Source paths never
// enter the model-visible result. Short-lived opaque locators bind a source session to the
// caller's canonical project identity and are revalidated before every read.

import { createHmac, randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { discoverSessions, isInjectedTitle } from './discovery.mjs'
import { makeDiscoveryHost } from './discovery-host.mjs'

export const PROJECT_SHARE_SOURCES = ['codex', 'claude', 'dsh']
export const DEFAULT_PROJECT_SHARE_SOURCES = ['codex', 'claude', 'dsh']
export const LOCATOR_TTL_MS = 10 * 60 * 1000
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024

const MAX_LOCATORS = 200
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 50
const DEFAULT_MESSAGE_LIMIT = 12
const MAX_MESSAGE_LIMIT = 24
const DEFAULT_CHAR_LIMIT = 12000
const MAX_CHAR_LIMIT = 24000
const MAX_MESSAGE_CHARS = 4000
const MAX_JSONL_LINE_CHARS = 4 * 1024 * 1024

function abortIfNeeded(signal) {
  if (signal && signal.aborted) {
    const err = new Error('PROJECT_SESSION_ABORTED')
    err.code = 'PROJECT_SESSION_ABORTED'
    throw err
  }
}

function safeInt(value, fallback, min, max) {
  return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === 'object' && block.type !== 'tool_result')
      .map((block) => typeof block.text === 'string' ? block.text : '')
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

function userContentText(content) {
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === 'object' && block.type !== 'tool_result')
      .map((block) => typeof block.text === 'string' ? block.text : '')
      .filter((text) => text.trim() && !isInjectedTitle(text))
      .join('\n')
  }
  let text = contentText(content)
  // Some providers prepend a tagged injected block to the real prompt in one string.
  // Remove only closed, known wrapper blocks; an unclosed/unknown injected prefix still
  // fails closed in makeCollector through isInjectedTitle().
  text = text.replace(
    /<(environment_context|system-reminder|user_instructions|local-command-caveat|permissions)\b[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  )
  return text.trim()
}

function safeText(text) {
  let out = String(text ?? '')
  const before = out
  const home = homedir()
  if (home) out = out.split(home).join('$HOME')
  // Common credential shapes only. We do not inspect environment values or return matched text.
  out = out
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_SECRET]')
    .replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, '[REDACTED_AUTH]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}['"]?/gi, '$1=[REDACTED_SECRET]')
  return { text: out, redacted: out !== before }
}

function makeCollector({ query, messageLimit, charLimit }) {
  const messages = []
  const q = String(query ?? '').trim().toLowerCase()
  let totalMessages = 0
  let redactedSecrets = 0
  let croppedMessages = 0
  const push = (role, raw) => {
    let text = String(raw ?? '').trim()
    if (!text || (role === 'user' && isInjectedTitle(text))) return
    const safe = safeText(text)
    text = safe.text
    if (safe.redacted) redactedSecrets += 1
    if (q && !text.toLowerCase().includes(q)) return
    totalMessages += 1
    if (text.length > MAX_MESSAGE_CHARS) {
      text = text.slice(0, MAX_MESSAGE_CHARS - 1) + '…'
      croppedMessages += 1
    }
    messages.push({ role, text })
    if (messages.length > messageLimit) messages.shift()
  }
  const finish = () => {
    let chars = messages.reduce((sum, message) => sum + message.text.length, 0)
    let charTrimmed = false
    while (messages.length > 1 && chars > charLimit) {
      chars -= messages[0].text.length
      messages.shift()
      charTrimmed = true
    }
    if (messages.length === 1 && chars > charLimit) {
      messages[0] = { ...messages[0], text: messages[0].text.slice(0, charLimit - 1) + '…' }
      chars = messages[0].text.length
      charTrimmed = true
    }
    return {
      messages,
      totalMessages,
      redactedSecrets,
      truncated: totalMessages > messages.length || croppedMessages > 0 || charTrimmed,
    }
  }
  return { push, finish }
}

function consumeCodex(record, collector, identity) {
  if (!record || typeof record !== 'object') return
  if (record.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
    if (typeof record.payload.id === 'string') identity.sessionId = record.payload.id
    if (typeof record.payload.cwd === 'string') identity.projectPath = record.payload.cwd
    return
  }
  const item = record.type === 'response_item' && record.payload && typeof record.payload === 'object'
    ? record.payload
    : null
  if (!item || item.type !== 'message') return
  if (item.role === 'user') collector.push('user', userContentText(item.content))
  if (item.role === 'assistant') {
    const text = Array.isArray(item.content)
      ? item.content
        .filter((block) => block && block.type === 'output_text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      : ''
    collector.push('assistant', text)
  }
}

function consumeClaude(record, collector, identity) {
  if (!record || typeof record !== 'object') return
  if (typeof record.sessionId === 'string' && !identity.sessionId) identity.sessionId = record.sessionId
  if (typeof record.cwd === 'string' && !identity.projectPath) identity.projectPath = record.cwd
  if (record.type === 'user' && record.message && record.message.role === 'user') {
    collector.push('user', userContentText(record.message.content))
  }
  if (record.type === 'assistant' && record.message && record.message.role === 'assistant') {
    const text = Array.isArray(record.message.content)
      ? record.message.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      : contentText(record.message.content)
    collector.push('assistant', text)
  }
}

async function forEachJsonLine(ctx, sourcePath, signal, visit) {
  const target = await ctx.fs.resolve(sourcePath, { signal })
  const info = await ctx.fs.stat(target, signal)
  if (!info || info.type !== 'file') throw new Error('PROJECT_SESSION_SOURCE_UNAVAILABLE')
  if (typeof info.size === 'number' && info.size > MAX_SOURCE_BYTES) {
    throw new Error('PROJECT_SESSION_SOURCE_TOO_LARGE')
  }
  const stream = await ctx.fs.streamText(target, signal)
  let buffer = ''
  let scannedBytes = 0
  let scannedRecords = 0
  let malformedLines = 0
  let droppingOversizedLine = false
  const consume = (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      visit(JSON.parse(trimmed))
      scannedRecords += 1
    } catch {
      malformedLines += 1
    }
  }
  for await (const chunk of stream) {
    abortIfNeeded(signal)
    scannedBytes += Buffer.byteLength(chunk, 'utf8')
    if (scannedBytes > MAX_SOURCE_BYTES) throw new Error('PROJECT_SESSION_SOURCE_TOO_LARGE')
    let rest = chunk
    if (droppingOversizedLine) {
      const newline = rest.indexOf('\n')
      if (newline === -1) continue
      malformedLines += 1
      droppingOversizedLine = false
      rest = rest.slice(newline + 1)
    }
    buffer += rest
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      if (line.length > MAX_JSONL_LINE_CHARS) malformedLines += 1
      else consume(line)
      buffer = buffer.slice(newline + 1)
    }
    if (buffer.length > MAX_JSONL_LINE_CHARS) {
      buffer = ''
      droppingOversizedLine = true
    }
  }
  if (droppingOversizedLine) malformedLines += 1
  else if (buffer.trim()) consume(buffer)
  return { scannedBytes, scannedRecords, malformedLines, target }
}

async function canonicalProjectKey(ctx, projectPath, signal) {
  if (typeof projectPath !== 'string' || !projectPath) throw new Error('PROJECT_SESSION_PROJECT_REQUIRED')
  return String((await ctx.fs.resolve(projectPath, { signal })).targetKey)
}

function callerProjectPath(exec) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    && exec.agent.session.header.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('PROJECT_SESSION_CALLER_HAS_NO_PROJECT')
  return cwd
}

function extractDshEvent(event, collector) {
  if (!event || typeof event !== 'object') return
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  if (event.type === 'user/message'
    && (!data.source || data.source.kind === 'user')) collector.push('user', userContentText(data.content))
  if (event.type === 'assistant/message' && data.message) {
    collector.push('assistant', contentText(data.message.content))
  }
}

export async function readSharedSession(ctx, record, args, signal) {
  const messageLimit = safeInt(args.messageLimit, DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT)
  const charLimit = safeInt(args.charLimit, DEFAULT_CHAR_LIMIT, 1000, MAX_CHAR_LIMIT)
  const collector = makeCollector({ query: args.query, messageLimit, charLimit })
  let scannedRecords = 0
  let malformedLines = 0

  if (record.source === 'dsh') {
    const inspected = await ctx.sessionPersistence.inspect(record.sessionId, signal)
    if (!inspected || !inspected.meta) throw new Error('PROJECT_SESSION_SOURCE_UNAVAILABLE')
    const freshProjectKey = await canonicalProjectKey(ctx, inspected.meta.cwd, signal)
    if (freshProjectKey !== record.projectKey) throw new Error('PROJECT_SESSION_PROJECT_CHANGED')
    for (const event of inspected.events || []) extractDshEvent(event, collector)
    scannedRecords = Array.isArray(inspected.events) ? inspected.events.length : 0
  } else {
    const identity = {}
    const stats = await forEachJsonLine(ctx, record.sourcePath, signal, (item) => {
      if (record.source === 'codex') consumeCodex(item, collector, identity)
      else consumeClaude(item, collector, identity)
    })
    scannedRecords = stats.scannedRecords
    malformedLines = stats.malformedLines
    if (identity.sessionId !== record.sessionId) throw new Error('PROJECT_SESSION_IDENTITY_CHANGED')
    const freshProjectKey = await canonicalProjectKey(ctx, identity.projectPath, signal)
    if (freshProjectKey !== record.projectKey) throw new Error('PROJECT_SESSION_PROJECT_CHANGED')
  }

  const excerpt = collector.finish()
  return {
    status: 'ok',
    source: record.source,
    sessionId: record.sessionId,
    title: record.title,
    mode: args.query ? 'search' : 'tail',
    messages: excerpt.messages,
    scannedRecords,
    malformedLines,
    redactedSecrets: excerpt.redactedSecrets,
    truncated: excerpt.truncated,
  }
}

export function createProjectLocatorStore({ now = () => Date.now() } = {}) {
  const secret = randomBytes(32)
  const records = new Map()
  const prune = () => {
    const stamp = now()
    for (const [locator, record] of records) {
      if (record.expiresAt <= stamp) records.delete(locator)
    }
    while (records.size >= MAX_LOCATORS) records.delete(records.keys().next().value)
  }
  return {
    issue(record) {
      prune()
      const nonce = randomBytes(16).toString('base64url')
      const digest = createHmac('sha256', secret)
        .update(record.source + '\0' + record.sessionId + '\0' + record.projectKey + '\0' + nonce)
        .digest('base64url')
        .slice(0, 24)
      const locator = 'ps_' + nonce + '.' + digest
      records.set(locator, { ...record, expiresAt: now() + LOCATOR_TTL_MS })
      return locator
    },
    resolve(locator, projectKey) {
      prune()
      const record = records.get(locator)
      if (!record || record.projectKey !== projectKey || record.expiresAt <= now()) {
        throw new Error('PROJECT_SESSION_LOCATOR_INVALID')
      }
      return { ...record }
    },
    get size() { return records.size },
  }
}

async function listExternalSessions(ctx, source, projectKey, registryDir, signal, home) {
  abortIfNeeded(signal)
  const found = await discoverSessions({
    format: source,
    home,
    host: makeDiscoveryHost(ctx),
    cacheDir: registryDir,
    includeProjectPath: true,
  })
  const matches = []
  for (const session of found.sessions) {
    if (!session.projectPath) continue
    try {
      if (await canonicalProjectKey(ctx, session.projectPath, signal) === projectKey) matches.push(session)
    } catch {
      // Missing or inaccessible historical cwd: it cannot prove same-project identity.
    }
  }
  return matches
}

async function listDshSessions(ctx, projectKey, currentSessionId, signal) {
  const snapshots = await ctx.sessionPersistence.listSnapshots(signal)
  const matches = []
  for (const snapshot of snapshots || []) {
    const header = snapshot && snapshot.header
    if (!header || header.id === currentSessionId || !header.cwd) continue
    try {
      if (await canonicalProjectKey(ctx, header.cwd, signal) !== projectKey) continue
      matches.push({
        format: 'dsh', sessionId: header.id, title: null, projectPath: header.cwd,
        createdAt: header.createdAt, lastActiveAt: header.createdAt, sourcePath: null,
      })
    } catch {
      // Fail closed when a stored cwd no longer resolves.
    }
  }
  return matches
}

export function registerProjectShareTools(ctx, registryDir, { home } = {}) {
  const locators = createProjectLocatorStore()

  ctx.tools.register(defineTool({
    name: 'project_sessions_list',
    description:
      '列出当前 DSH 会话所在项目中的其他 agent 会话（Codex / Claude Code / DSH）。' +
      '只读取元数据，不导入、不复制、不启动第三方代码；项目通过宿主文件系统的规范身份精确匹配。' +
      '返回短时有效的不透明 locator，需要继续某项任务时再交给 project_session_read 按需读取有界上下文。',
    parameters: {
      sources: {
        type: 'array',
        items: { type: 'string', enum: PROJECT_SHARE_SOURCES },
        description: '可选来源，默认 codex、claude、dsh。',
      },
      query: { type: 'string', description: '可选：按标题或会话 id 过滤。' },
      limit: { type: 'integer', description: '返回数量，默认 20，执行时限制在 1–50。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          project: { type: 'string', required: true },
          expiresInMs: { type: 'integer', required: true },
          sessions: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                source: { type: 'string', enum: PROJECT_SHARE_SOURCES, required: true },
                sessionId: { type: 'string', required: true },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                createdAt: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
                lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
                locator: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.sessions.length === 0
          ? '当前项目没有发现其他可共享会话。'
          : '同项目会话 ' + value.sessions.length + ' 个（未导入完整历史）：\n'
            + value.sessions.map((session, index) =>
              (index + 1) + '. [' + session.source + '] '
              + (session.title || session.sessionId) + '\nlocator: ' + session.locator).join('\n'),
      }],
      presentationMeta: (_args, value) => ({ total: value.total }),
    },
    presentCall: () => ({ card: 'generic', title: '查找同项目会话', kind: 'search' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? '查找同项目会话失败' : '已查找同项目会话',
    }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const projectPath = callerProjectPath(exec)
      const projectKey = await canonicalProjectKey(ctx, projectPath, exec.signal)
      const selected = Array.isArray(args.sources) && args.sources.length
        ? [...new Set(args.sources)]
        : DEFAULT_PROJECT_SHARE_SOURCES
      const all = []
      for (const source of selected) {
        abortIfNeeded(exec.signal)
        const rows = source === 'dsh'
          ? await listDshSessions(ctx, projectKey, exec.agent && exec.agent.id, exec.signal)
          : await listExternalSessions(ctx, source, projectKey, registryDir, exec.signal, home)
        all.push(...rows)
      }
      const query = String(args.query ?? '').trim().toLowerCase()
      const filtered = query
        ? all.filter((session) => [session.title, session.sessionId]
          .some((value) => typeof value === 'string' && value.toLowerCase().includes(query)))
        : all
      filtered.sort((a, b) => (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0))
      const limit = safeInt(args.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT)
      const sessions = filtered.slice(0, limit).map((session) => {
        const safeTitle = session.title ? safeText(session.title).text : null
        return {
          source: session.format,
          sessionId: session.sessionId,
          title: safeTitle,
          createdAt: Number.isSafeInteger(session.createdAt) ? session.createdAt : null,
          lastActiveAt: Number.isSafeInteger(session.lastActiveAt) ? session.lastActiveAt : null,
          locator: locators.issue({
            source: session.format,
            sessionId: session.sessionId,
            title: safeTitle,
            sourcePath: session.sourcePath,
            projectKey,
          }),
        }
      })
      return {
        total: filtered.length,
        project: String(projectPath).split(/[\\/]/).filter(Boolean).pop() || projectPath,
        expiresInMs: LOCATOR_TTL_MS,
        sessions,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'project_session_read',
    description:
      '按需读取 project_sessions_list 返回的一个同项目会话。' +
      '只提取有界的 user/assistant 文本，排除推理、工具结果、系统注入和插件上下文，并对常见凭据形态做脱敏。' +
      '不创建 DSH 会话副本；只有返回的有界片段会成为当前会话的工具结果。',
    parameters: {
      locator: { type: 'string', required: true, description: 'project_sessions_list 返回的短时 locator。' },
      query: { type: 'string', description: '可选：只返回包含该关键词的最近消息。' },
      messageLimit: { type: 'integer', description: '默认 12，执行时限制在 1–24 条。' },
      charLimit: { type: 'integer', description: '默认 12000，执行时限制在 1000–24000 字符。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok'], required: true },
          source: { type: 'string', enum: PROJECT_SHARE_SOURCES, required: true },
          sessionId: { type: 'string', required: true },
          title: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          mode: { type: 'string', enum: ['tail', 'search'], required: true },
          messages: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                role: { type: 'string', enum: ['user', 'assistant'], required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          scannedRecords: { type: 'integer', required: true },
          malformedLines: { type: 'integer', required: true },
          redactedSecrets: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已按需读取 [' + value.source + '] ' + (value.title || value.sessionId)
          + '；未导入完整历史。\n'
          + (value.messages.length
            ? value.messages.map((message) => (message.role === 'user' ? '用户' : '助手') + '：' + message.text).join('\n\n')
            : '未找到符合条件的可共享文本。')
          + (value.truncated ? '\n\n（结果已按上限截断）' : ''),
      }],
      presentationMeta: (_args, value) => ({ source: value.source, messages: value.messages.length }),
    },
    presentCall: () => ({ card: 'generic', title: '按需读取项目会话', kind: 'read' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? '读取项目会话失败' : '已读取项目会话片段',
    }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const projectKey = await canonicalProjectKey(ctx, callerProjectPath(exec), exec.signal)
      const record = locators.resolve(args.locator, projectKey)
      return readSharedSession(ctx, record, args, exec.signal)
    },
  }))
}
