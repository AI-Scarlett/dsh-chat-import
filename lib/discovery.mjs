// lib/discovery.mjs — REQ-25/REQ-40 会话发现索引：13 种格式统一 discover + 30s TTL 扫描缓存
// + 持久化 mtime/size 书签
//
// 轻依赖：源文件与 DB I/O 都经注入的 host 接口（stat / readHead / readText /
// readDir / readSessions），本模块不 import node:sqlite 或任何 DSH 服务，可独立单测
// （mock host）。index.mjs 负责把 ctx.fs 与 lib/{opencode,zcode,hermes}.mjs 的
// readXxxDb 适配成 host 注入（SQLite 复用既有读取器，不重写）。importStatus 由调用方把
// lib/imports.mjs loadImports 的 imports 映射传入，本模块只做纯查询，不碰 registry 文件。
// 书签文件（scan-cache.json）读写走 node:fs/promises（原子写），目录由调用方经 cacheDir
// 参数传入（index.mjs 传 $DSH_HOME/dsh-chat-import，与 imports.json 同目录）——本模块
// 不硬编码任何路径。
//
// discoverSessions({ path?, format?, query?, home?, host, imports?, cache?, cacheDir?,
// includeProjectPath? })：
//   - path 缺省：扫全部格式的默认数据根（见 defaultRoots）；给出目录 → 在该根下按格式
//     探测；给出单文件 → 按扩展名/路径特征探测可消费该文件的格式。chatgpt 无自动根，
//     只有 path 显式指向 conversations.json（或含它的目录）时才参与发现。
//   - format：限定只扫一种格式（绕过路径探测，但各格式扫描器仍按自身结构自拒）。
//   - query：按 title / project / sourcePath 子串过滤（忽略大小写，REQ-40）。
//   - cacheDir：提供时启用持久化 mtime/size 书签（见下）；缺省只走进程内 TTL 缓存。
//   - 结果按 lastActiveAt ?? createdAt 降序（对齐 cc-switch scan_sessions），返回
//     { sessions, total }；每项 { format, sessionId, title, project, createdAt,
//     lastActiveAt, messageCount, sourcePath, importStatus }（未知字段为 null）。
//
// 扫描缓存两层：
//   1. 进程内 30s TTL（Map<key,{ts,data}>，key = `<format>|<目标路径>`），同 key 30s 内
//      命中不重扫（不重读源文件）。createScanCache 可注入 now 供测试控制过期；默认缓存
//      模块级共享，clearScanCache() 供测试隔离。
//   2. 持久化 mtime/size 书签（REQ-40，cacheDir 提供时启用）：<cacheDir>/scan-cache.json
//      —— 按 format 分表，<sourcePath> → { mtimeMs, sizeBytes, entries }。扫描对每个
//      源文件先 stat + 查书签：mtime+size 未变 → 复用 entries（不读源内容）；变化/缺失
//      → 重读并更新书签。
//      跨进程重启后未变文件免重扫；30s 进程内命中不查盘，过期后才查盘书签再决定是否
//      重读。多文件源（grokbuild 会话目录、openclaw 伴生 sessions.json、kimi 的
//      wire.jsonl + state.json）的 mtimeMs 为复合串。写盘原子写（temp+fsync+rename）、
//      损坏/缺失按空书签处理、写失败不影响扫描结果。
//
// 标题提取（REQ-40）：读文件头 HEAD_MAX_BYTES，取首条真实 user 文本；命中注入前缀
// （<environment_context> / <system-reminder> / <user_instructions> / # Files mentioned /
// The user is asking about / <local-command-caveat> 等）或纯工具结果的 user 消息跳过，
// 避免系统注入当标题。归一（折叠空白 + 80 字符截断 + …）对齐 REQ-27 各源同款规则。
// 项目名（REQ-40）：优先记录内 cwd/directory 的 basename，否则按源目录布局正则提取
// （layoutProject：claude projects/<encoded>、codex sessions/YYYY/MM、reasonix
// projects/<slug>、grokbuild sessions/<project>、openclaw agents/<agent>、gemini
// history/<slot>、cursor projects/<slug>）。
//
// 消息数（REQ-40）：按源能力——DB 源（opencode/zcode/hermes db）取消息数；gemini/chatgpt
// 反正整读（顺带计数）；claude/codex/cursor/reasonix/grokbuild/openclaw/hermes-jsonl
// 及 pi/kimi 只读文件头、不整读，messageCount 为 null。

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

export const FORMATS = [
  'claude', 'codex', 'cursor', 'gemini', 'reasonix', 'opencode',
  'zcode', 'grokbuild', 'openclaw', 'pi', 'hermes', 'kimi', 'chatgpt', 'dsh',
]

export const SCAN_TTL_MS = 30000
export const TITLE_MAX_LEN = 80
export const TITLE_ELLIPSIS = '…'
export const HEAD_MAX_BYTES = 256 * 1024

// ── 默认数据根（path 缺省时扫描全部；chatgpt 无自动根）────────────────────
export function defaultRoots({ home = homedir() } = {}) {
  // grokbuild 双根：sessions + archived_sessions（cc-switch session_roots 同款）
  return {
    claude: join(home, '.claude', 'projects'),
    codex: join(home, '.codex', 'sessions'),
    cursor: join(home, '.cursor', 'projects'),
    gemini: join(home, '.gemini', 'history'),
    reasonix: join(home, '.reasonix', 'sessions'),
    opencode: join(home, '.local', 'share', 'opencode', 'opencode.db'),
    zcode: join(home, '.zcode', 'cli', 'db', 'db.sqlite'),
    grokbuild: [join(home, '.grok', 'sessions'), join(home, '.grok', 'archived_sessions')],
    openclaw: join(home, '.openclaw', 'agents'),
    pi: join(home, '.pi', 'agent', 'sessions'),
    hermes: join(home, '.hermes'),
    kimi: join(home, '.kimi', 'sessions'),
    chatgpt: null,
    dsh: join(home, '.dsh', 'sessions'),
  }
}

// ── 30s TTL 扫描缓存 ────────────────────────────────────────────────────
export function createScanCache({ ttlMs = SCAN_TTL_MS, now = () => Date.now() } = {}) {
  const map = new Map()
  return {
    get(key) {
      const hit = map.get(key)
      if (!hit) return undefined
      if (now() - hit.ts < ttlMs) return hit.data
      map.delete(key)
      return undefined
    },
    set(key, data) { map.set(key, { ts: now(), data }) },
    clear() { map.clear() },
    get size() { return map.size },
  }
}

// 默认缓存：进程内共享（同 key 30s 内命中不重扫）。测试用 clearScanCache 隔离。
const scanCache = createScanCache()
export function clearScanCache() { scanCache.clear() }

// ── 持久化 mtime/size 书签（REQ-40）───────────────────────────────────────
// <cacheDir>/scan-cache.json：{ version, bookmarks: { <format>: { <sourcePath>:
// { mtimeMs, sizeBytes, entries } } } }。按 format 分表——同一源文件会被多种格式探测
//（无 format 的目录/文件探测），各格式提取结果不同，书签必须按格式隔离。entries = 该
// 源文件导出的会话条目（makeEntry 结果，importStatus 由 discoverSessions 统一填充，不
// 入书签）；多文件源的 mtimeMs 为复合串（grokbuild 会话目录两文件、openclaw 伴生
// sessions.json）。懒加载：进程内 30s TTL 命中时完全不碰盘，首次 get/remember 才读文件。
export const SCAN_CACHE_FILE = 'scan-cache.json'
// v2 adds the internal projectPath field used by project-session sharing. Old cache rows
// only contain the display basename, which is not safe enough for exact project matching.
const SCAN_CACHE_VERSION = 2

// 原子写：同目录 temp + fsync + rename（复刻 lib/imports.mjs 的 writeAtomic）。
async function writeAtomic(filePath, data) {
  const tmp = join(dirname(filePath), '.' + randomUUID() + '.tmp')
  try {
    const handle = await open(tmp, 'wx')
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, filePath)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

// 进程内写串行链：并发扫描不互相覆盖（同 imports registry 模式）。
let cacheWriteChain = Promise.resolve()

// 直接读盘（等待未决写完成后读）：缺失返回空；损坏/版本不符按空书签处理（告警）。
async function readScanCache(cacheDir) {
  await cacheWriteChain.catch(() => {})
  try {
    const parsed = JSON.parse(await readFile(join(cacheDir, SCAN_CACHE_FILE), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.version === SCAN_CACHE_VERSION
      && parsed.bookmarks && typeof parsed.bookmarks === 'object' && !Array.isArray(parsed.bookmarks)) {
      return parsed.bookmarks
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[dsh-chat-import] scan-cache 损坏，按空书签处理：' + String((err && err.message) || err))
    }
  }
  return {}
}

function writeScanCache(cacheDir, data) {
  const run = cacheWriteChain.then(async () => {
    await mkdir(cacheDir, { recursive: true })
    await writeAtomic(join(cacheDir, SCAN_CACHE_FILE), JSON.stringify(data, null, 2) + '\n')
  })
  cacheWriteChain = run.catch(() => {})
  return run
}

// 书签 store：按 format 分表（同源文件被多格式探测时互不串扰）。get（mtime+size 命中
// → entries 副本 / null；未命中 → undefined）、remember（更新 + 标脏）、save（仅脏时
// 原子写盘；写失败保留脏标记供下次重试）。
async function createBookmarkStore(cacheDir) {
  let map = null
  let dirty = false
  const ensure = async () => {
    if (map === null) map = await readScanCache(cacheDir)
    return map
  }
  const table = async (format) => {
    const m = await ensure()
    if (!m[format] || typeof m[format] !== 'object') m[format] = {}
    return m[format]
  }
  return {
    async get(format, sourcePath, fp) {
      const t = await table(format)
      const bm = t[sourcePath]
      if (!bm || bm.mtimeMs !== fp.mtimeMs || bm.sizeBytes !== fp.sizeBytes) return undefined
      return bm.entries === null ? null : bm.entries.map((e) => ({ ...e }))
    },
    async remember(format, sourcePath, fp, entries) {
      const t = await table(format)
      t[sourcePath] = { mtimeMs: fp.mtimeMs, sizeBytes: fp.sizeBytes, entries }
      dirty = true
    },
    async save() {
      if (map === null || !dirty) return
      await writeScanCache(cacheDir, { version: SCAN_CACHE_VERSION, bookmarks: map })
      dirty = false
    },
  }
}

// 单源书签探测：fingerprint（mtimeMs+sizeBytes）命中 → 复用 entries，不读源内容；
// 未命中 → probe() 重读提取并写回书签（按 format 分表）。probe 返回 null（hermes db
// 不可用等）也入书签，调用方按 null 处理。bm 为 null（未开持久化）时直接 probe，行为
// 与旧版一致。
async function probeSource(bm, format, sourcePath, fp, probe) {
  if (!bm) return probe()
  const hit = await bm.get(format, sourcePath, fp)
  if (hit !== undefined) return hit
  const entries = await probe()
  await bm.remember(format, sourcePath, fp, entries)
  return entries
}

// ── 通用助手（纯函数）───────────────────────────────────────────────────
function pathSegments(p) {
  return String(p ?? '').split(/[\\/]/).filter((s) => s.length > 0)
}
function basenameOf(p) {
  const s = pathSegments(p)
  return s[s.length - 1] ?? ''
}
// 取父目录：标签回退（项目名）与 kimiWorkDir 自底向上找 kimi.json 都用它；host 侧
// stat/readText 会归一分隔符，故此处归一后拼接安全（与 import-variants 的 parentOf 同语义）。
function dirnameOf(p) {
  const s = pathSegments(p)
  s.pop()
  return s.join('/')
}

// 同目录伴生文件路径：保留原分隔符（host 给的同目录子项路径必须原样可查）。
function siblingPath(filePath, suffixName) {
  const m = String(filePath).match(/[\\/][^\\/]+$/)
  return m ? filePath.slice(0, m.index + 1) + suffixName : filePath
}

// 递归收集匹配文件（目录缺失/不可读 → 空，发现阶段静默跳过该根）。
async function walkFiles(host, dir, out, match) {
  const entries = await host.readDir(dir)
  if (!entries) return
  for (const e of entries) {
    if (e.type === 'directory') await walkFiles(host, e.path, out, match)
    else if (e.type === 'file' && match(e.name)) out.push(e)
  }
}

// JSONL 头解析：畸形/截断行跳过（发现阶段只取元数据，不整读、不做行级明细）。
function parseJsonlHead(head) {
  const recs = []
  for (const line of String(head ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try { recs.push(JSON.parse(t)) } catch { /* 截断尾行/畸形行跳过 */ }
  }
  return recs
}

// 注入过滤前缀（REQ-40：首行命中即视为系统注入，不当标题）。空文本也视为注入。
const INJECT_MARKERS = [
  '<environment_context>', '<system-reminder>', '<user_instructions>',
  '<local-command-caveat>', '<command-name>', '<permissions>',
  '# AGENTS.md', '# Files mentioned', 'The user is asking about',
  '# Context from my IDE setup:',
]
export function isInjectedTitle(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  const lower = t.toLowerCase()
  return INJECT_MARKERS.some((m) => lower.startsWith(m.toLowerCase()))
}

// 标题归一（REQ-27 同款规则）：折叠空白、80 字符截断加省略号；空白返回 ''。
export function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// content → 纯文本：string 原样；block 数组取各 block 的 text 字段（tool_result 不算
// 用户提问，跳过）——input_text/output_text 块自带 text，无需按类型分支；{text} 对象取 text。
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_result') continue
      if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text)
    }
    return parts.join('\n')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

// 首条真实 user 文本（注入过滤 + 归一）；无 → null。
function firstUserTitle(recs, extract) {
  for (const rec of recs) {
    const text = extract(rec)
    const t = String(text ?? '').trim()
    if (!t || isInjectedTitle(t)) continue
    return normalizeTitle(t)
  }
  return null
}

// 时间戳 → 毫秒：数字 >1e12 为毫秒原样、否则秒 ×1000；RFC3339 字符串解析
//（对齐 cc-switch parse_timestamp_to_ms / lib/convert/hermes parseHermesTime）。
function parseTimeValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : Math.trunc(v) * 1000
  if (typeof v === 'string' && v) {
    const n = Date.parse(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function firstString(recs, pick) {
  for (const r of recs) {
    const v = pick(r)
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

function firstNumber(recs, pick) {
  for (const r of recs) {
    const v = pick(r)
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

// 项目名：记录内 cwd/directory basename 优先，否则布局正则回退。
function projectFromRecord(cwd, layoutFallback) {
  const base = cwd ? basenameOf(cwd) : ''
  return base || layoutFallback() || null
}

// 结构化条目（未知字段统一 null，保证 schema 稳定）。
function makeEntry({ format, sessionId, title, project, projectPath, createdAt, lastActiveAt, messageCount, sourcePath }) {
  const intOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)
  return {
    format,
    sessionId,
    title: title || null,
    project: project || null,
    projectPath: projectPath || null,
    createdAt: intOrNull(createdAt),
    lastActiveAt: intOrNull(lastActiveAt),
    messageCount: intOrNull(messageCount),
    sourcePath,
    importStatus: null, // discoverSessions 统一填充（本模块不做 registry I/O）
  }
}

// ── 项目名布局正则（REQ-40：按源目录布局提取）───────────────────────────
export function layoutProject(sourcePath, format) {
  const p = String(sourcePath ?? '').replace(/\\/g, '/')
  switch (format) {
    case 'claude': {
      const m = p.match(/\/projects\/([^/]+)\/[^/]+\.jsonl$/i)
      return m ? m[1] : null
    }
    case 'cursor': {
      const m = p.match(/\/projects\/([^/]+)\/agent-transcripts\//i)
      return m ? m[1] : null
    }
    case 'reasonix': {
      const m = p.match(/\/projects\/([^/]+)\//i)
      return m ? m[1] : null
    }
    case 'grokbuild': {
      const m = p.match(/\/(?:sessions|archived_sessions)\/([^/]+)\/[^/]+$/)
      return m ? m[1] : null
    }
    case 'openclaw': {
      const m = p.match(/\/agents\/([^/]+)\/sessions\//)
      return m ? m[1] : null
    }
    case 'codex': {
      const m = p.match(/\/sessions\/(\d{4})\/(\d{2})\//)
      return m ? m[1] + '/' + m[2] : null
    }
    case 'gemini': {
      const m = p.match(/\/history\/([^/]+)\/chats\//)
      return m ? m[1] : null
    }
    case 'dsh': {
      // $DSH_HOME/sessions/<encoded-workspace>/<session-id>/session.jsonl(.zstd)
      const m = p.match(/\/sessions\/([^/]+)\/[^/]+\/session\.jsonl(?:\.zstd)?$/i)
      if (!m) return null
      try {
        return decodeURIComponent(m[1].replace(/~/g, '%'))
      } catch {
        return m[1]
      }
    }
    default:
      return null
  }
}

// ── 各格式扫描器（自拒：结构不匹配返回 []）──────────────────────────────

// claude：~/.claude/projects/<slug>/<sessionId>.jsonl，只取主 transcript
//（fileStem == sessionId；agent-* 子代理/辅助 transcript 跳过）。
async function scanClaude(host, target, bm) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    if (stem.startsWith('agent-')) continue
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'claude', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const sessionId = firstString(recs, (r) => r && r.sessionId)
      if (!sessionId || sessionId !== stem) return []
      const cwd = firstString(recs, (r) => r && r.cwd)
      const createdAt = firstNumber(recs, (r) => (r && r.timestamp !== undefined ? parseTimeValue(r.timestamp) : undefined))
      const title = firstUserTitle(recs, (r) => (r && r.type === 'user' && r.message && r.message.role === 'user' ? contentText(r.message.content) : ''))
      return [makeEntry({
        format: 'claude', sessionId, title,
        project: projectFromRecord(cwd, () => layoutProject(file.path, 'claude')),
        projectPath: cwd,
        createdAt, lastActiveAt: st.mtimeMs, messageCount: null, sourcePath: file.path,
      })]
    })
    out.push(...entries)
  }
  return out
}

// codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（首记录 session_meta 为格式签名）。
async function scanCodex(host, target, bm) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'codex', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const meta = recs.find((r) => r && r.type === 'session_meta' && r.payload && typeof r.payload === 'object')
      if (!meta) return []
      const payload = meta.payload
      const sessionId = typeof payload.id === 'string' && payload.id ? payload.id : uuidFromName(file.name)
      if (!sessionId) return []
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined
      const createdAt = parseTimeValue(meta.timestamp) ?? parseTimeValue(payload.timestamp)
      const title = firstUserTitle(recs, (r) => (r && r.type === 'response_item' && r.payload && r.payload.type === 'message' && r.payload.role === 'user' ? contentText(r.payload.content) : ''))
      return [makeEntry({
        format: 'codex', sessionId, title,
        project: projectFromRecord(cwd, () => layoutProject(file.path, 'codex')),
        projectPath: cwd,
        createdAt, lastActiveAt: st.mtimeMs, messageCount: null, sourcePath: file.path,
      })]
    })
    out.push(...entries)
  }
  return out
}

function uuidFromName(name) {
  const m = String(name).match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
  return m ? m[0] : undefined
}

// cursor：~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
//（布局签名：路径含 agent-transcripts 且 fileStem == 父目录名）。
async function scanCursor(host, target, bm) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    if (!/agent-transcripts/i.test(file.path)) continue
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    if (stem !== basenameOf(dirnameOf(file.path))) continue
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'cursor', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      // 首条 user 文本（剥 <user_query> 包裹；无时间戳 → createdAt null）
      const title = firstUserTitle(recs, (r) => (r && r.role === 'user' ? String(contentText(r.message && r.message.content)).replace(/<\/?user_query>/g, '') : ''))
      return [makeEntry({
        format: 'cursor', sessionId: stem, title,
        project: layoutProject(file.path, 'cursor'),
        createdAt: null, lastActiveAt: st.mtimeMs, messageCount: null, sourcePath: file.path,
      })]
    })
    out.push(...entries)
  }
  return out
}

// gemini：~/.gemini/history/<slot>/chats/session-*.json（顶层
// { sessionId, startTime, directories, messages: [{ type, content, ... }] }）。
async function scanGemini(host, target, bm) {
  const files = []
  await walkFiles(host, target, files, (name) => /^session-.+\.json$/i.test(name))
  const out = []
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'gemini', file.path, fp, async () => {
      const raw = await host.readText(file.path)
      if (raw === null || raw === '') return []
      let chat
      try { chat = JSON.parse(raw) } catch { return [] }
      if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) return []
      const stem = basenameOf(file.name).replace(/\.json$/i, '')
      const sessionId = typeof chat.sessionId === 'string' && chat.sessionId ? chat.sessionId : stem
      const title = firstUserTitle(chat.messages, (m) => (m && m.type === 'user' ? geminiPartsText(m.content) : ''))
      const dir = Array.isArray(chat.directories) && chat.directories.length > 0 ? chat.directories[0] : undefined
      const msgCount = chat.messages.filter((m) => m && (m.type === 'user' || m.type === 'gemini')).length
      return [makeEntry({
        format: 'gemini', sessionId, title,
        project: projectFromRecord(dir, () => layoutProject(file.path, 'gemini')),
        createdAt: parseTimeValue(chat.startTime), lastActiveAt: st.mtimeMs, messageCount: msgCount, sourcePath: file.path,
      })]
    })
    out.push(...entries)
  }
  return out
}

function geminiPartsText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
    .join('\n')
}

// reasonix：~/.reasonix/sessions/desktop-*.jsonl（含 subagent-sub-*），排除
// .events/.conflicts/.guardian 伴生；会话 id = 文件 stem；project 走 projects/<slug> 布局。
function isReasonixSidecar(name) {
  return /\.(events|conflicts|guardian)\.jsonl$/i.test(name)
}
async function scanReasonix(host, target, bm) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name) && !isReasonixSidecar(name))
  const out = []
  for (const file of files) {
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    if (!/^(desktop|subagent)-/.test(stem)) continue
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'reasonix', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      if (!recs.some((r) => r && typeof r === 'object' && r.role === 'user')) return []
      const title = firstUserTitle(recs, (r) => (r && r.role === 'user' && typeof r.content === 'string' ? r.content : ''))
      const createdAt = firstNumber(recs, (r) => (r && typeof r.createdAt === 'number' ? r.createdAt : undefined))
      return [makeEntry({
        format: 'reasonix', sessionId: stem, title,
        project: layoutProject(file.path, 'reasonix'),
        createdAt: createdAt ?? reasonixStemTime(stem), lastActiveAt: st.mtimeMs, messageCount: null, sourcePath: file.path,
      })]
    })
    out.push(...entries)
  }
  return out
}

// reasonixStemTime 镜像（lib/convert/reasonix.mjs 的导出，本地内联避免引入
// convert 依赖链）：stem 内嵌桌面会话创建时刻（本地时间），转录无时间戳时回退。
function reasonixStemTime(stem) {
  const m = String(stem || '').match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  const month = +m[2]
  const day = +m[3]
  const hour = +m[4]
  const minute = +m[5]
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  const t = new Date(+m[1], month - 1, day, hour, minute)
  return Number.isNaN(t.getTime()) ? null : t.getTime()
}

// opencode / zcode：SQLite 一库多会话，经 host.readSessions 复用 lib 读取器
//（不重写 SQL）；目标为目录时定位固定库文件名（无递归，对齐 import 目录模式）。
async function scanSqlite(host, format, target, dbName, bm) {
  const st = await host.stat(target)
  if (!st) return []
  let dbPath = target
  if (st.type === 'directory') {
    const candidate = join(target, dbName)
    const cst = await host.stat(candidate)
    if (!cst || cst.type !== 'file') return []
    dbPath = candidate
  } else if (!new RegExp(dbName.replace(/\./g, '\\.') + '$', 'i').test(target)) {
    return []
  }
  const dbStat = await host.stat(dbPath)
  if (!dbStat) return []
  const fp = { mtimeMs: dbStat.mtimeMs, sizeBytes: dbStat.size }
  return probeSource(bm, format, dbPath, fp, async () => {
    const sessions = await host.readSessions(format, dbPath)
    if (!sessions) return []
    return sessions.map((s) => makeEntry({
      format, sessionId: s.id, title: normalizeTitle(s.title),
      project: s.directory ? basenameOf(s.directory) : null,
      createdAt: s.createdAt, lastActiveAt: s.lastActiveAt, messageCount: s.messageCount, sourcePath: dbPath,
    }))
  })
}
function scanOpencode(host, target, bm) { return scanSqlite(host, 'opencode', target, 'opencode.db', bm) }
function scanZcode(host, target, bm) { return scanSqlite(host, 'zcode', target, 'db.sqlite', bm) }

// grokbuild：~/.grok/sessions/<project>/<session_id>/（含 archived_sessions/），
// 会话目录 = 含 summary.json 的目录（不再下钻）；标题 generated_title >
// session_summary > 首条 user 文本；lastActiveAt = summary/chat_history mtime 取大。
async function walkGrokbuildSessions(host, dir, out) {
  const entries = await host.readDir(dir)
  if (!entries) return
  for (const e of entries) {
    if (e.type !== 'directory') continue
    const sumPath = join(e.path, 'summary.json')
    const st = await host.stat(sumPath)
    if (st && st.type === 'file') out.push(e.path)
    else await walkGrokbuildSessions(host, e.path, out)
  }
}
async function scanGrokbuild(host, target, bm) {
  const dirs = []
  await walkGrokbuildSessions(host, target, dirs)
  const out = []
  for (const dir of dirs) {
    const sst = await host.stat(join(dir, 'summary.json'))
    if (!sst) continue
    const cst = await host.stat(join(dir, 'chat_history.jsonl'))
    // 会话目录 = 双文件复合指纹（任一文件变化 → 重读；mtimeMs 为复合串）
    const fp = {
      mtimeMs: sst.mtimeMs + '|' + (cst ? cst.mtimeMs : ''),
      sizeBytes: sst.size + (cst ? cst.size : 0),
    }
    const entries = await probeSource(bm, 'grokbuild', dir, fp, async () => {
      const sumRaw = await host.readText(join(dir, 'summary.json'))
      if (sumRaw === null) return []
      let summary
      try { summary = JSON.parse(sumRaw) } catch { return [] }
      if (!summary || typeof summary !== 'object') return []
      const info = summary.info && typeof summary.info === 'object' ? summary.info : {}
      const sessionId = typeof info.id === 'string' && info.id ? info.id : basenameOf(dir)
      const explicit = typeof summary.generated_title === 'string' && summary.generated_title.trim()
        ? summary.generated_title
        : (typeof summary.session_summary === 'string' && summary.session_summary.trim() ? summary.session_summary : '')
      const chatRaw = await host.readHead(join(dir, 'chat_history.jsonl'), HEAD_MAX_BYTES)
      const recs = chatRaw ? parseJsonlHead(chatRaw) : []
      const title = normalizeTitle(explicit) || firstUserTitle(recs, (r) => (r && r.type === 'user' ? contentText(r.content) : ''))
      const createdAt = parseTimeValue(summary.created_at) ?? parseTimeValue(summary.updated_at) ?? parseTimeValue(summary.last_active_at)
      const mtimes = [cst && cst.mtimeMs, sst && sst.mtimeMs].filter((v) => typeof v === 'number')
      return [makeEntry({
        format: 'grokbuild', sessionId, title,
        project: basenameOf(dirnameOf(dir)) || layoutProject(dir, 'grokbuild'),
        createdAt, lastActiveAt: mtimes.length ? Math.max(...mtimes) : null, messageCount: null, sourcePath: dir,
      })]
    })
    out.push(...entries)
  }
  return out
}

// openclaw：~/.openclaw/agents/<agent>/sessions/*.jsonl；同目录 sessions.json 索引
// 提供 displayName 作标题（内联 openclawDisplayNames 语义，避免引 convert 依赖链）。
async function openclawNames(indexJson) {
  const map = new Map()
  let index
  try { index = JSON.parse(indexJson) } catch { return map }
  if (!index || typeof index !== 'object') return map
  for (const entry of Object.values(index)) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.sessionId === 'string' && typeof entry.displayName === 'string' && entry.displayName.trim()) {
      map.set(entry.sessionId, entry.displayName.trim())
    }
  }
  return map
}
async function scanOpenclaw(host, target, bm) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  const nameCache = new Map()
  for (const file of files) {
    if (!/\bagents\b.*\bsessions\b/i.test(file.path)) continue
    const indexPath = siblingPath(file.path, 'sessions.json')
    const st = await host.stat(file.path)
    if (!st) continue
    const ist = await host.stat(indexPath)
    // 标题可能来自伴生 sessions.json → fingerprint 含伴生文件（任一变化 → 重读）
    const fp = {
      mtimeMs: st.mtimeMs + '|' + (ist ? ist.mtimeMs : ''),
      sizeBytes: st.size + (ist ? ist.size : 0),
    }
    const entries = await probeSource(bm, 'openclaw', file.path, fp, async () => {
      let names = nameCache.get(indexPath)
      if (names === undefined) {
        names = await openclawNames(await host.readText(indexPath))
        nameCache.set(indexPath, names)
      }
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      if (!recs.some((r) => r && typeof r === 'object' && (r.type === 'session' || r.type === 'message'))) return []
      const sessRec = recs.find((r) => r && r.type === 'session')
      const sessionId = sessRec && typeof sessRec.id === 'string' && sessRec.id
        ? sessRec.id
        : basenameOf(file.name).replace(/\.jsonl$/i, '')
      const title = names.get(sessionId)
        || firstUserTitle(recs, (r) => (r && r.type === 'message' && r.message && r.message.role === 'user' ? contentText(r.message.content) : ''))
      const cwd = sessRec && typeof sessRec.cwd === 'string' ? sessRec.cwd : undefined
      const createdAt = sessRec ? parseTimeValue(sessRec.timestamp) : undefined
      return [makeEntry({
        format: 'openclaw', sessionId, title,
        project: projectFromRecord(cwd, () => layoutProject(file.path, 'openclaw')),
        createdAt, lastActiveAt: st.mtimeMs, messageCount: null, sourcePath: file.path,
      })]
    })
    out.push(...entries)
  }
  return out
}

// pi：~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl（树形条目）。格式签名 =
// 会话头 type:"session" 带 version（1|2|3）字段——与 hermes/openclaw 的 session 头区分。
// 标题：活动路径上最后的 session_info.name，缺省回退首条真实 user 文本（只读文件头）。
async function scanPi(host, target) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const head = await host.readHead(file.path, HEAD_MAX_BYTES)
    if (head === null || head === '') continue
    const recs = parseJsonlHead(head)
    const header = recs.find((r) => r && r.type === 'session' && typeof r.version === 'number')
    if (!header) continue
    const sessionId = typeof header.id === 'string' && header.id ? header.id
      : basenameOf(file.name).replace(/\.jsonl$/i, '')
    let name = ''
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i]
      if (r && r.type === 'session_info' && typeof r.name === 'string' && r.name.trim()) {
        name = r.name.trim()
        break
      }
    }
    const title = normalizeTitle(name) || firstUserTitle(recs, (r) => (r && r.type === 'message' && r.message && r.message.role === 'user' ? contentText(r.message.content) : ''))
    const cwd = typeof header.cwd === 'string' ? header.cwd : undefined
    const createdAt = parseTimeValue(header.timestamp)
    const st = await host.stat(file.path)
    out.push(makeEntry({
      format: 'pi', sessionId, title,
      project: projectFromRecord(cwd, () => null),
      createdAt, lastActiveAt: st && st.mtimeMs, messageCount: null, sourcePath: file.path,
    }))
  }
  return out
}

// hermes：~/.hermes/state.db（复用 readHermesDb，权威索引）→ 恒批量；db 不可用时回退
// 递归扫 sessions/*.jsonl（flat {role,content,ts} / nested {type:"session"|"message"}）。
function hermesUserText(r) {
  if (!r || typeof r !== 'object') return ''
  if (r.type === 'message' && r.message && typeof r.message === 'object' && r.message.role === 'user') return contentText(r.message.content)
  if (r.role === 'user') return contentText(r.content)
  return ''
}
async function scanHermes(host, target, bm) {
  const st = await host.stat(target)
  if (!st) return []
  let dbPath = null
  if (st.type === 'file') {
    if (!/state\.db$/i.test(target)) return []
    dbPath = target
  } else {
    const candidate = join(target, 'state.db')
    const cst = await host.stat(candidate)
    if (cst && cst.type === 'file') dbPath = candidate
  }
  if (dbPath) {
    const dbStat = await host.stat(dbPath)
    if (!dbStat) return []
    const fp = { mtimeMs: dbStat.mtimeMs, sizeBytes: dbStat.size }
    // probe 返回 null = 非 hermes 库（readSessions 不可用）→ 也入书签，回退扫 jsonl
    const dbEntries = await probeSource(bm, 'hermes', dbPath, fp, async () => {
      const sessions = await host.readSessions('hermes', dbPath)
      if (sessions === null) return null
      return sessions.map((s) => makeEntry({
        format: 'hermes', sessionId: s.id, title: normalizeTitle(s.title),
        project: s.directory ? basenameOf(s.directory) : null,
        createdAt: s.createdAt, lastActiveAt: s.lastActiveAt, messageCount: s.messageCount, sourcePath: dbPath,
      }))
    })
    if (dbEntries !== null) return dbEntries
  }
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const fst = await host.stat(file.path)
    if (!fst) continue
    const fp = { mtimeMs: fst.mtimeMs, sizeBytes: fst.size }
    const entries = await probeSource(bm, 'hermes', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      if (!recs.some((r) => r && typeof r === 'object' && (r.role === 'user' || r.type === 'session' || r.type === 'message'))) return []
      const sessRec = recs.find((r) => r && r.type === 'session')
      const sessionId = sessRec && typeof sessRec.id === 'string' && sessRec.id
        ? sessRec.id
        : basenameOf(file.name).replace(/\.jsonl$/i, '')
      const explicitTitle = sessRec && typeof sessRec.title === 'string' && sessRec.title.trim() ? sessRec.title : ''
      const title = explicitTitle || firstUserTitle(recs, hermesUserText)
      const cwd = sessRec && typeof sessRec.cwd === 'string' ? sessRec.cwd : undefined
      const createdAt = firstNumber(recs, (r) => {
        if (!r || typeof r !== 'object') return undefined
        const v = r.timestamp ?? r.ts ?? (r.message && typeof r.message === 'object' ? r.message.ts : undefined)
        return v !== undefined ? parseTimeValue(v) : undefined
      })
      return [makeEntry({
        format: 'hermes', sessionId, title: normalizeTitle(title),
        project: projectFromRecord(cwd, () => null),
        createdAt, lastActiveAt: fst.mtimeMs, messageCount: null, sourcePath: file.path,
      })]
    })
    out.push(...entries)
  }
  return out
}

// kimi：~/.kimi/sessions/<workdir-md5>/<session-id>/wire.jsonl（会话目录 = 含
// wire.jsonl 的目录；subagents/ 子代理 wire 不发现）。标题 = state.json custom_title
// > 首个 TurnBegin user_input；cwd 经 ~/.kimi/kimi.json（md5 映射）解析；project =
// cwd basename > hash 目录名；createdAt = 首条记录 timestamp；messageCount 只读文件头、
// 恒为 null（不整读，无法统计 TurnBegin 数）。
async function walkKimiSessions(host, dir, out) {
  const entries = await host.readDir(dir)
  if (!entries) return
  for (const e of entries) {
    if (e.type !== 'directory') continue
    const wirePath = join(e.path, 'wire.jsonl')
    const st = await host.stat(wirePath)
    if (st && st.type === 'file') out.push(e.path)
    else await walkKimiSessions(host, e.path, out)
  }
}

// kimi.json workdir 映射（自底向上找 ≤6 层）：目录名 = md5(path) 或 `<kaos>_<md5>`。
async function kimiWorkDir(host, sessionDir, hashDirName) {
  if (!hashDirName) return null
  let dir = dirnameOf(sessionDir)
  for (let i = 0; i < 6; i++) {
    const metaPath = join(dir, 'kimi.json')
    if (await host.stat(metaPath)) {
      try {
        const meta = JSON.parse(await host.readText(metaPath))
        for (const wd of (meta && Array.isArray(meta.work_dirs) ? meta.work_dirs : [])) {
          if (!wd || typeof wd.path !== 'string' || !wd.path) continue
          const hex = createHash('md5').update(wd.path, 'utf8').digest('hex')
          const kaos = typeof wd.kaos === 'string' && wd.kaos ? wd.kaos : 'local'
          if (hex === hashDirName || (kaos + '_' + hex) === hashDirName) return wd.path
        }
      } catch {
        // kimi.json 损坏：无 cwd 映射（发现阶段不致命）
      }
      return null
    }
    const next = dirnameOf(dir)
    if (next === dir) return null
    dir = next
  }
  return null
}

// TurnBegin/SteerInput 的 user_input → 文本（str 或 ContentPart 数组取 text）。
function kimiUserInputText(input) {
  return contentText(input)
}

async function scanKimi(host, target, bm) {
  const dirs = []
  const selfWire = join(target, 'wire.jsonl')
  const selfStat = await host.stat(selfWire)
  if (selfStat && selfStat.type === 'file') dirs.push(String(target))
  await walkKimiSessions(host, target, dirs)
  const out = []
  for (const dir of dirs) {
    const wirePath = join(dir, 'wire.jsonl')
    const wst = await host.stat(wirePath)
    if (!wst) continue
    const statePath = join(dir, 'state.json')
    const sst = await host.stat(statePath)
    // 标题可能来自伴生 state.json → fingerprint 含伴生文件（任一变化 → 重读）
    const fp = {
      mtimeMs: wst.mtimeMs + '|' + (sst ? sst.mtimeMs : ''),
      sizeBytes: wst.size + (sst ? sst.size : 0),
    }
    const entries = await probeSource(bm, 'kimi', dir, fp, async () => {
      let customTitle = ''
      if (sst) {
        try {
          const state = JSON.parse(await host.readText(statePath))
          if (state && typeof state.custom_title === 'string' && state.custom_title.trim()) customTitle = state.custom_title.trim()
        } catch {
          // state.json 损坏：标题回退 wire
        }
      }
      const head = await host.readHead(wirePath, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      if (!recs.some((r) => r && typeof r === 'object' && r.message && r.message.type === 'TurnBegin')) return []
      const title = customTitle || firstUserTitle(recs, (r) => {
        const m = r && typeof r === 'object' ? r.message : null
        if (!m || typeof m !== 'object' || m.type !== 'TurnBegin') return ''
        return kimiUserInputText(m.payload && typeof m.payload === 'object' ? m.payload.user_input : '')
      })
      const createdAt = firstNumber(recs, (r) => {
        const m = r && typeof r === 'object' ? r.message : null
        if (!m || typeof m !== 'object') return undefined
        return r.timestamp !== undefined ? parseTimeValue(r.timestamp) : undefined
      })
      const hashDirName = basenameOf(dirnameOf(dir))
      const cwd = await kimiWorkDir(host, dir, hashDirName)
      return [makeEntry({
        format: 'kimi', sessionId: basenameOf(dir), title,
        project: projectFromRecord(cwd, () => hashDirName),
        createdAt, lastActiveAt: wst.mtimeMs, messageCount: null, sourcePath: dir,
      })]
    })
    out.push(...entries)
  }
  return out
}

// chatgpt：无自动根；path 显式指向 conversations.json（或含它的目录）时解析
//（顶层 JSON 数组，每会话 { id, title, create_time, mapping }）。整文件多会话 →
// 书签按文件存全部 entries。
async function scanChatgpt(host, target, bm) {
  const st = await host.stat(target)
  if (!st) return []
  let file = target
  if (st.type === 'directory') {
    const candidate = join(target, 'conversations.json')
    const cst = await host.stat(candidate)
    if (!cst || cst.type !== 'file') return []
    file = candidate
  } else if (!/\.json$/i.test(target)) {
    return []
  }
  const fst = await host.stat(file)
  if (!fst) return []
  const fp = { mtimeMs: fst.mtimeMs, sizeBytes: fst.size }
  return probeSource(bm, 'chatgpt', file, fp, async () => {
    const raw = await host.readText(file)
    if (raw === null || raw === '') return []
    let list
    try { list = JSON.parse(raw) } catch { return [] }
    if (!Array.isArray(list)) return []
    const out = []
    for (const conv of list) {
      if (!conv || typeof conv !== 'object' || typeof conv.id !== 'string') continue
      const mapping = conv.mapping && typeof conv.mapping === 'object' ? conv.mapping : {}
      let lastTs
      let count = 0
      for (const node of Object.values(mapping)) {
        if (!node || typeof node !== 'object' || !node.message || typeof node.message !== 'object') continue
        const author = node.message.author && typeof node.message.author === 'object' ? node.message.author : {}
        const role = typeof author.role === 'string' ? author.role : ''
        if (role === 'user' || role === 'assistant') count++
        const t = parseTimeValue(node.message.create_time)
        if (t !== undefined && (lastTs === undefined || t > lastTs)) lastTs = t
      }
      out.push(makeEntry({
        format: 'chatgpt', sessionId: conv.id,
        title: typeof conv.title === 'string' && conv.title.trim() ? normalizeTitle(conv.title) : null,
        project: null,
        createdAt: parseTimeValue(conv.create_time), lastActiveAt: lastTs, messageCount: count, sourcePath: file,
      }))
    }
    return out
  })
}

// dsh：$DSH_HOME/sessions/<encoded-workspace>/<session-id>/session.jsonl(.zstd)。
// .zstd 用系统 zstd 解压后取头；session 首行提供 id/cwd/createdAt，session/title
// 事件优先作标题，否则回退首条真实 user 文本。
async function scanDsh(host, target, bm) {
  const files = []
  await walkFiles(host, target, files, (name) => /^session\.jsonl(?:\.zstd)?$/i.test(name))
  const out = []
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'dsh', file.path, fp, async () => {
      let text
      if (/\.zstd$/i.test(file.path)) {
        try {
          text = execFileSync('zstd', ['-dc', file.path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
        } catch {
          return []
        }
      } else {
        text = await host.readText(file.path)
      }
      const recs = parseJsonlHead(text)
      const sessionRec = recs.find((r) => r && r.type === 'session' && typeof r.id === 'string' && r.id)
      if (!sessionRec) return []
      const titleRec = [...recs].reverse().find((r) => r && r.type === 'session/title' && r.data && typeof r.data.title === 'string')
      const title = titleRec
        ? normalizeTitle(titleRec.data.title)
        : firstUserTitle(recs, (r) => (r && r.type === 'user/message' && r.data && Array.isArray(r.data.content) ? contentText(r.data.content) : ''))
      const messageCount = recs.filter((r) => r && (r.type === 'user/message' || r.type === 'assistant/message' || r.type === 'tool/result')).length
      return [makeEntry({
        format: 'dsh', sessionId: sessionRec.id, title,
        project: projectFromRecord(sessionRec.cwd, () => layoutProject(file.path, 'dsh')),
        createdAt: Number.isFinite(sessionRec.createdAt) ? sessionRec.createdAt : parseTimeValue(sessionRec.createdAt),
        lastActiveAt: st.mtimeMs, messageCount, sourcePath: file.path,
      })]
    })
    out.push(...entries)
  }
  return out
}

const SCANNERS = {
  claude: scanClaude,
  codex: scanCodex,
  cursor: scanCursor,
  gemini: scanGemini,
  reasonix: scanReasonix,
  opencode: scanOpencode,
  zcode: scanZcode,
  grokbuild: scanGrokbuild,
  openclaw: scanOpenclaw,
  pi: scanPi,
  hermes: scanHermes,
  kimi: scanKimi,
  chatgpt: scanChatgpt,
  dsh: scanDsh,
}

// 单格式扫描：单个数据根读取失败（权限/损坏）只跳过该格式，不拖垮整次发现
//（host 的 stat/readText/readDir 已把常见缺失归一为 null；此处兜底异常）。
// bm 为可选持久化书签 store（REQ-40；缺省走纯扫描）。
export async function scanFormat(host, format, target, bm) {
  const fn = SCANNERS[format]
  if (!fn) return []
  try {
    return await fn(host, target, bm)
  } catch {
    // 该格式扫描抛错（个别根损坏等）→ 返回空，其余格式不受影响
    return []
  }
}

// 单文件路径 → 可消费它的候选格式（按扩展名 + 路径特征；无特征时回退探测
// claude/codex/cursor/reasonix/openclaw/hermes 六种通用 JSONL 格式，扫描器按结构
// 自拒）。pi 需路径特征（/pi/agent/sessions/）不入回退；kimi 是目录形态（wire.jsonl
// 在会话目录内），单文件回退也不覆盖它。
function fileFormatsForPath(path) {
  const lower = String(path).toLowerCase()
  if (/\/session\.jsonl(?:\.zstd)?$/.test(lower)) return ['dsh']
  if (/\.jsonl$/i.test(lower)) {
    const fmts = []
    if (/\bagent-transcripts\b/.test(lower)) fmts.push('cursor')
    if (/(^|[\\/])rollout-/.test(lower)) fmts.push('codex')
    if (/(^|[\\/])(desktop|subagent)-/.test(lower)) fmts.push('reasonix')
    if (/\.claude[\\/]/.test(lower)) fmts.push('claude')
    if (/\bagents\b.*\bsessions\b/.test(lower)) fmts.push('openclaw')
    if (/\.pi[\\/]agent[\\/]sessions[\\/]/.test(lower)) fmts.push('pi')
    if (/\.hermes[\\/]/.test(lower)) fmts.push('hermes')
    if (/\.kimi[\\/]sessions[\\/]/.test(lower)) fmts.push('kimi')
    return fmts.length > 0 ? fmts : ['claude', 'codex', 'cursor', 'reasonix', 'openclaw', 'hermes']
  }
  if (/\.json$/i.test(lower)) return ['gemini', 'chatgpt']
  if (/\.db$/i.test(lower)) {
    if (/opencode\.db$/i.test(lower)) return ['opencode']
    if (/db\.sqlite$/i.test(lower)) return ['zcode']
    if (/state\.db$/i.test(lower)) return ['hermes']
    return ['opencode', 'zcode', 'hermes']
  }
  return []
}

// 目标展开：path 缺省 → 默认根（grokbuild 双根展开，chatgpt 无根跳过）；
// path 目录 → format 指定则单格式、否则全部格式探测；path 文件 → 扩展名探测。
async function buildTargets({ path, format, roots, host }) {
  const targets = []
  const push = (fmt, target) => { if (target !== null && target !== undefined) targets.push([fmt, String(target)]) }
  if (path) {
    const st = await host.stat(path)
    if (!st) return []
    if (st.type === 'file') {
      const fmts = format ? [format] : fileFormatsForPath(path)
      for (const f of fmts) push(f, path)
      return targets
    }
    const fmts = format ? [format] : FORMATS
    for (const f of fmts) push(f, path)
    return targets
  }
  const fmts = format ? [format] : FORMATS
  for (const f of fmts) {
    const root = roots[f]
    if (Array.isArray(root)) {
      for (const r of root) push(f, r)
    } else {
      push(f, root)
    }
  }
  return targets
}

// importStatus：查 imports registry（调用方 loadImports 后传入的 imports 映射）。
// single 源（claude/codex/.../hermes-jsonl）路径命中 → imported；multi 源
//（opencode/zcode/hermes-db/chatgpt）按会话 id 查子表——命中 → imported、子表非空但
// 本会话不在 → partial（源已部分导入）、否则 not-imported。archivedIds（可选，Set/
// 数组）为 workspaceRegistry 的全局归档集：记录关联的会话已被归档（隐藏但仍占 id）
// → 'archived'（重新导入会建后缀新副本），供面板/scan_discover 显示可重导而非已导入。
export function resolveImportStatus(imports, sourcePath, sessionId, archivedIds) {
  const archived = archivedIds instanceof Set ? archivedIds
    : Array.isArray(archivedIds) ? new Set(archivedIds) : null
  const isArchived = (id) => archived !== null && typeof id === 'string' && archived.has(id)
  const record = imports && typeof imports === 'object' ? imports[sourcePath] : undefined
  if (record === undefined) return 'not-imported'
  if (typeof record === 'string') return isArchived(record) ? 'archived' : 'imported' // 旧版纯字符串记录
  if (!record || typeof record !== 'object') return 'not-imported'
  if (record.kind === 'multi') {
    const sub = record.conversations || record.sessions
    if (sub && typeof sub === 'object') {
      const own = sub[sessionId]
      if (typeof own === 'string') return isArchived(own) ? 'archived' : 'imported' // 旧版子表字符串记录
      if (own && typeof own === 'object' && typeof own.dshId === 'string') {
        return isArchived(own.dshId) ? 'archived' : 'imported'
      }
      if (Object.keys(sub).length > 0) return 'partial'
    }
    return 'not-imported'
  }
  if (typeof record.dshId === 'string') return isArchived(record.dshId) ? 'archived' : 'imported'
  return 'imported'
}

function matchQuery(s, query) {
  const q = String(query).trim().toLowerCase()
  if (!q) return true
  return [s.title, s.project, s.sourcePath].some((v) => typeof v === 'string' && v.toLowerCase().includes(q))
}

/** 会话发现主入口：见文件头契约。返回 { sessions, total }（按最近活跃降序）。
 * archivedIds（可选）为已归档会话 id 集合，传给 resolveImportStatus 标注 'archived'
 *（调用方从 workspaceRegistry.archivedSessionIds 取，见 lib/imports.mjs 的
 * archivedSessionIds 助手；缺省不标注，行为与旧版一致）。 */
export async function discoverSessions({
  path, format, query, home, host, imports, cache, cacheDir, archivedIds,
  includeProjectPath = false,
} = {}) {
  if (!host || typeof host.stat !== 'function' || typeof host.readHead !== 'function'
    || typeof host.readText !== 'function' || typeof host.readDir !== 'function') {
    throw new Error('discoverSessions 需要 host（stat/readHead/readText/readDir/readSessions）')
  }
  const roots = defaultRoots({ home })
  const targets = await buildTargets({ path, format, roots, host })
  const ttlCache = cache ?? scanCache
  // 持久化书签懒加载：30s 内 TTL 全命中时不碰盘；save 只在有更新时原子写
  const bmStore = cacheDir ? await createBookmarkStore(String(cacheDir)) : null
  const all = []
  for (const [fmt, target] of targets) {
    const key = fmt + '|' + target
    let entries = ttlCache.get(key)
    if (entries === undefined) {
      entries = await scanFormat(host, fmt, target, bmStore)
      ttlCache.set(key, entries)
    }
    all.push(...entries)
  }
  if (bmStore) {
    try {
      await bmStore.save()
    } catch (err) {
      // 书签写盘失败只影响下次缓存，不影响本次扫描结果
      console.warn('[dsh-chat-import] scan 书签写盘失败（不影响本次扫描）：' + String((err && err.message) || err))
    }
  }
  const reg = imports && typeof imports === 'object' ? imports : {}
  const sessions = all.map((e) => {
    const session = { ...e, importStatus: resolveImportStatus(reg, e.sourcePath, e.sessionId, archivedIds) }
    if (!includeProjectPath) delete session.projectPath
    return session
  })
  const filtered = query ? sessions.filter((s) => matchQuery(s, query)) : sessions
  filtered.sort((a, b) => (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0))
  return { sessions: filtered, total: filtered.length }
}
