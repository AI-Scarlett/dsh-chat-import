// sync.test.mjs — 双向增量同步：配置、Codex/Grok 往返、入站巡检、出站写回
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeCodexJsonl } from '../lib/export/codex.mjs'
import { serializeGrokbuildJsonl, buildGrokSummary } from '../lib/export/grokbuild.mjs'
import { convertCodexJsonl, convertGrokbuildJson } from '../convert.mjs'
import {
  loadSyncConfig,
  saveSyncConfig,
  saveOutboundMap,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_SESSIONS_PER_RUN,
} from '../lib/sync-config.mjs'
import { runSyncOnce, stopSyncTimer } from '../lib/sync-loop.mjs'
import { registerSyncRoutes } from '../lib/sync-panel.mjs'
import { clearScanCache } from '../lib/discovery.mjs'

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-sync-home-'))
  clearScanCache()
})

afterEach(() => {
  stopSyncTimer()
})

function ev(type, seq, data, extra = {}) {
  return { type, seq, time: 1_700_000_000_000, data, ...extra }
}

function sampleEvents() {
  return [
    ev('session/imported', 0, { tool: 'dsh', sourceId: 'native-1', importedAt: 1 }, { ignorable: true }),
    ev('turn/start', 1, { turn: 1 }),
    ev('user/message', 2, {
      id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' }),
    ev('assistant/message', 3, {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
    }, { surfaceOp: 'append' }),
    ev('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
    ev('session/title', 5, { title: '测试会话', messageSeqs: [], source: { kind: 'user' } }),
  ]
}

test('sync 配置默认关闭，保存后能读回开关', async () => {
  const dir = join(process.env.DSH_HOME, 'dsh-chat-import')
  const fresh = await loadSyncConfig(dir)
  assert.equal(fresh.inbound.enabled, false)
  assert.equal(fresh.outbound.enabled, false)
  assert.equal(fresh.intervalMs, DEFAULT_INTERVAL_MS)
  assert.equal(fresh.maxSessionsPerRun, DEFAULT_MAX_SESSIONS_PER_RUN)
  const saved = await saveSyncConfig(dir, {
    inbound: { enabled: true, formats: ['claude'] },
    outbound: { enabled: true, targets: ['codex', 'grokbuild'] },
    intervalMs: 30_000,
    maxSessionsPerRun: 7,
  })
  assert.equal(saved.inbound.enabled, true)
  assert.deepEqual(saved.inbound.formats, ['claude'])
  assert.deepEqual(saved.outbound.targets, ['codex', 'grokbuild'])
  const again = await loadSyncConfig(dir)
  assert.equal(again.inbound.enabled, true)
  assert.equal(again.intervalMs, 30_000)
  assert.equal(again.maxSessionsPerRun, 7)
})

test('Codex 往返：DSH 事件 → rollout JSONL → convertCodexJsonl 保住用户轮', () => {
  const events = sampleEvents()
  const out = serializeCodexJsonl({
    meta: { id: 'native-1', createdAt: 1_700_000_000_000, cwd: '/tmp/proj' },
    events,
    sessionUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    cwd: '/tmp/proj',
  })
  assert.match(out.jsonl, /session_meta/)
  const back = convertCodexJsonl(out.jsonl, { sourcePath: '/tmp/rollout.jsonl' })
  assert.equal(back.turns.length, 1)
  assert.equal(back.turns[0].prompt, '你好')
})

test('Grok 往返：DSH 事件 → chat_history + summary → convertGrokbuildJson', () => {
  const events = sampleEvents()
  const out = serializeGrokbuildJsonl({
    meta: { id: 'native-1', createdAt: 1_700_000_000_000, cwd: '/tmp/proj' },
    events,
  })
  const summary = JSON.stringify(buildGrokSummary({
    sessionUuid: '01a0048c-c8aa-7911-8be8-5959ab1fd2ec',
    cwd: '/tmp/proj',
    title: '测试会话',
    createdAt: 1_700_000_000_000,
    numMessages: 2,
  }))
  const back = convertGrokbuildJson(summary, out.jsonl, { sourcePath: '/tmp/grok-sess' })
  assert.equal(back.turns.length, 1)
  assert.equal(back.turns[0].prompt, '你好')
})

function makeRealCtx(root) {
  const sessions = new Map()
  const metrics = { listSnapshots: 0, readFrom: 0 }
  const persistence = {
    async list() { return [...sessions.values()].map((s) => s.meta) },
    async listSnapshots() {
      metrics.listSnapshots++
      return [...sessions.values()].map((s) => ({
        header: s.meta,
        revision: 'memory:' + s.meta.id + ':' + s.events.length,
      }))
    },
    async create(meta) { sessions.set(meta.id, { meta, events: [] }) },
    async append(id, events) {
      const s = sessions.get(id)
      for (const ev of events) s.events.push(ev)
    },
    async inspect(id) { return sessions.get(id) },
    async readFrom(id, fromSeq = 0) {
      metrics.readFrom++
      const s = sessions.get(id)
      return { meta: s.meta, events: s.events.slice(fromSeq) }
    },
  }
  const webRoutes = []
  const versionOf = (p) => {
    try {
      const s = statSync(p)
      return 'v' + s.size + '-' + Math.trunc(s.mtimeMs)
    } catch {
      return 'missing'
    }
  }
  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      try {
        const s = statSync(target.targetKey)
        return s.isDirectory()
          ? { type: 'directory', size: 0, version: versionOf(target.targetKey), mtimeMs: s.mtimeMs }
          : { type: 'file', size: s.size, version: versionOf(target.targetKey), mtimeMs: s.mtimeMs }
      } catch {
        return undefined
      }
    },
    async readText(target) { return readFileSync(target.targetKey, 'utf8') },
    async writeText(target, content, options) {
      if (options && options.kind === 'replaceIfVersion') {
        if (versionOf(target.targetKey) !== options.version) {
          throw Object.assign(new Error('FS_STALE_VERSION'), { code: 'FS_STALE_VERSION' })
        }
      }
      if (options && options.kind === 'createIfAbsent' && existsSync(target.targetKey)) {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
      mkdirSync(join(target.targetKey, '..'), { recursive: true })
      writeFileSync(target.targetKey, content)
      return { operation: 'update', version: versionOf(target.targetKey) }
    },
    async listDir(target) {
      return readdirSync(target.targetKey, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        target: { targetKey: join(target.targetKey, e.name), displayPath: join(target.targetKey, e.name) },
      }))
    },
    processPath(target) { return target.targetKey },
  }
  const ctx = {
    fs,
    sessionPersistence: persistence,
    webServer: { register(def) { webRoutes.push(def); return () => {} } },
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'webServer') return ctx.webServer
      if (name === 'workspaceRegistry') return { resolveByPath: async () => null, create: async () => ({ attachSession: async () => {} }), archivedSessionIds: [] }
      return undefined
    },
    inject(_list, cb) { return cb(ctx) },
    on() { return () => {} },
    effect() { return () => {} },
  }
  return { ctx, persistence, sessions, webRoutes, metrics, root }
}

test('入站巡检：未导入 Claude 文件 → imported，再跑一轮 → skipped', async () => {
  const home = process.env.DSH_HOME
  const srcDir = join(home, 'claude-src')
  mkdirSync(srcDir, { recursive: true })
  const file = join(srcDir, 'sess-sync-001.jsonl')
  writeFileSync(file, [
    JSON.stringify({ sessionId: 'sess-sync-001', type: 'user', cwd: join(home, 'proj'), message: { role: 'user', content: '增量问题' } }),
    JSON.stringify({ sessionId: 'sess-sync-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '增量回答' }] } }),
  ].join('\n') + '\n')
  const { ctx, sessions } = makeRealCtx(home)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: true, formats: ['claude'] },
    outbound: { enabled: false, targets: ['claude'] },
  })
  const first = await runSyncOnce(ctx, registryDir, { path: srcDir })
  assert.equal(first.ok, true)
  assert.equal(first.inbound.imported, 1)
  assert.equal(sessions.size, 1)
  const second = await runSyncOnce(ctx, registryDir, { path: srcDir })
  assert.equal(second.inbound.imported, 0)
  assert.ok(second.inbound.skipped >= 1)
})

test('出站写回：原生 DSH 会话落到 Codex 副本，再增量追加', async () => {
  const home = process.env.DSH_HOME
  const outRoot = join(home, 'codex-out')
  mkdirSync(outRoot, { recursive: true })
  const { ctx, persistence } = makeRealCtx(home)
  const events = sampleEvents()
  await persistence.create({ id: 'native-sync', createdAt: 1_700_000_000_000, cwd: join(home, 'proj') })
  await persistence.append('native-sync', events)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: false, formats: ['claude'] },
    outbound: { enabled: true, targets: ['codex'], roots: { codex: outRoot } },
  })
  const first = await runSyncOnce(ctx, registryDir)
  assert.equal(first.ok, true)
  assert.equal(first.outbound.synced, 1)
  assert.equal(first.outbound.mapWrites, 1)
  const mapping = JSON.parse(readFileSync(join(registryDir, 'outbound.json'), 'utf8'))
  const filePath = mapping.mappings['native-sync'].codex.filePath
  assert.ok(existsSync(filePath))
  const firstText = readFileSync(filePath, 'utf8')
  assert.match(firstText, /你好/)

  await persistence.append('native-sync', [
    ev('turn/start', 6, { turn: 2 }),
    ev('user/message', 7, {
      id: 'u2', role: 'user', content: [{ type: 'text', text: '第二问' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' }),
    ev('assistant/message', 8, {
      turn: 2, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '第二答' }] },
    }, { surfaceOp: 'append' }),
    ev('turn/end', 9, { turn: 2, reason: { kind: 'completed' } }),
  ])
  const second = await runSyncOnce(ctx, registryDir)
  assert.equal(second.outbound.synced, 1)
  assert.equal(second.outbound.mapWrites, 1)
  const nextText = readFileSync(filePath, 'utf8')
  assert.match(nextText, /第二问/)
  assert.ok(nextText.length > firstText.length)
})

test('rc.8 revision：723 个未变化会话不读取完整日志，也不重写映射', async () => {
  const home = process.env.DSH_HOME
  const { ctx, persistence, metrics } = makeRealCtx(home)
  const mappings = {}
  for (let i = 0; i < 723; i++) {
    const id = 'stable-' + i
    await persistence.create({ id, createdAt: 1_700_000_000_000 + i, cwd: join(home, 'proj') })
    mappings[id] = { codex: { sourceRevision: 'memory:' + id + ':0', filePath: join(home, 'out', id + '.jsonl') } }
  }
  const registryDir = join(home, 'dsh-chat-import')
  await saveOutboundMap(registryDir, { mappings })
  await saveSyncConfig(registryDir, {
    inbound: { enabled: false, formats: ['claude'] },
    outbound: { enabled: true, targets: ['codex'] },
  })

  const result = await runSyncOnce(ctx, registryDir)
  assert.equal(result.ok, true)
  assert.equal(result.outbound.sessions, 723)
  assert.equal(result.outbound.candidates, 0)
  assert.equal(result.outbound.processed, 0)
  assert.equal(result.outbound.unchanged, 723)
  assert.equal(result.outbound.mapWrites, 0)
  assert.equal(metrics.readFrom, 0)
})

test('首次 revision 迁移每轮最多处理 25 个会话，剩余会话延后', async () => {
  const home = process.env.DSH_HOME
  const { ctx, persistence, metrics } = makeRealCtx(home)
  for (let i = 0; i < 30; i++) {
    const id = 'bootstrap-' + i
    await persistence.create({ id, createdAt: 1_700_000_000_000 + i, cwd: join(home, 'proj') })
    await persistence.append(id, sampleEvents())
  }
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: false, formats: ['claude'] },
    outbound: { enabled: true, targets: ['codex'] },
  })

  const result = await runSyncOnce(ctx, registryDir, { dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.outbound.sessions, 30)
  assert.equal(result.outbound.candidates, 30)
  assert.equal(result.outbound.processed, DEFAULT_MAX_SESSIONS_PER_RUN)
  assert.equal(result.outbound.deferred, 5)
  assert.equal(result.outbound.mapWrites, 0)
  assert.equal(metrics.readFrom, DEFAULT_MAX_SESSIONS_PER_RUN)
  assert.equal(existsSync(join(registryDir, 'outbound.json')), false)
})

test('/api-import/sync GET 返回默认关闭状态', async () => {
  const { ctx, webRoutes } = makeRealCtx(process.env.DSH_HOME)
  const registryDir = join(process.env.DSH_HOME, 'dsh-chat-import')
  registerSyncRoutes(ctx, ctx.webServer, registryDir)
  const route = webRoutes.find((r) => r.path === '/api-import/sync')
  assert.ok(route)
  const chunks = []
  const req = { method: 'GET', async *[Symbol.asyncIterator]() {} }
  const res = {
    writeHead() {},
    end(body) { chunks.push(body) },
  }
  await route.handler(req, res)
  const data = JSON.parse(chunks[0])
  assert.equal(data.ok, true)
  assert.equal(data.config.inbound.enabled, false)
  assert.equal(data.config.outbound.enabled, false)
  assert.equal(data.config.maxSessionsPerRun, DEFAULT_MAX_SESSIONS_PER_RUN)
})
