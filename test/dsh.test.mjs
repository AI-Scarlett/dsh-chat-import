import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat, readFile, readdir, open, rm } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertDshJsonl } from '../lib/convert/dsh.mjs'
import { discoverSessions } from '../lib/discovery.mjs'

const SESSION_LINES = [
  { type: 'session', id: 'session-dsh-test', cwd: '/tmp/proj', createdAt: 1700000000000 },
  { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: 1700000000000, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 2, time: 1700000000000, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
  { type: 'assistant/message', seq: 3, time: 1700000000000, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] } } },
  { type: 'step/end', seq: 4, time: 1700000000000, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 5, time: 1700000000000, data: { turn: 1 } },
  { type: 'session/title', seq: 6, time: 1700000000000, data: { title: 'DSH 导入测试' } },
]
const RAW = SESSION_LINES.map((l) => JSON.stringify(l)).join('\n')

test('convertDshJsonl 保留核心事件并重排 seq', () => {
  const out = convertDshJsonl(RAW, { sourcePath: '/tmp/proj/session.jsonl' })
  assert.equal(out.meta.id, 'import-session-dsh-test')
  assert.equal(out.meta.cwd, '/tmp/proj')
  assert.equal(out.turns.length, 1)
  assert.equal(out.title, 'DSH 导入测试')
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.events[0].type, 'session/imported')
  assert.equal(out.events[0].data.tool, 'import_dsh')
  assert.ok(out.events.every((e) => Number.isFinite(e.seq)))
  assert.deepEqual(out.events.slice(1, 3).map((e) => e.type), ['turn/start', 'step/start'])
})

test('convertDshJsonl 读取 DSH V3 物理行日志并保留 system、stream 与引用', () => {
  const rows = [
    { type: 'session', version: 3, id: 'v3-session', cwd: '/tmp/proj', createdAt: 1700000000000 },
    { type: 'permission/preset', data: { preset: 'danger-full-access' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'system/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'sys-1', role: 'system', content: [], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } } },
    { type: 'user/message', surfaceOp: 'append', data: { id: 'u-1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
    { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a-1', role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, stream: [{ type: 'chunk', chunk: { type: 'block-end', block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } } }] } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' } },
    { type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [7], data: { turn: 1, step: 1, message: { id: 't-1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }], source: { kind: 'tool', callId: 'call-1' } } } },
    { type: 'session/title', data: { title: 'V3 标题', messageSeqs: [5] } },
  ]
  const out = convertDshJsonl(rows.map(row => JSON.stringify(row)).join('\n'), { sourcePath: '/tmp/proj/session.jsonl' })
  assert.equal(out.meta.version, 0)
  assert.equal(out.meta.sourceFormatVersion, 3)
  assert.equal(out.events.find(event => event.type === 'system/message').data.message.id, 'sys-1')
  const assistant = out.events.find(event => event.type === 'assistant/message')
  assert.equal(assistant.data.stream.length, 1)
  const result = out.events.find(event => event.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [assistant.seq])
  assert.deepEqual(out.events.find(event => event.type === 'session/title').data.messageSeqs, [out.events.find(event => event.type === 'user/message').seq])
})

test('discoverSessions format=dsh 发现 session.jsonl 会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-test-'))
  const dir = join(root, 'sessions', 'encoded', 'session-dsh-test')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  await writeFile(file, RAW + '\n')
  const host = {
    async stat(path) {
      try {
        const s = await stat(path)
        return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        return null
      }
    },
    async readHead(path, bytes) {
      const fh = await open(path, 'r')
      try {
        const b = Buffer.alloc(Math.min(bytes, 64 * 1024))
        const { bytesRead } = await fh.read(b, 0, b.length, 0)
        return b.subarray(0, bytesRead).toString('utf8')
      } finally {
        await fh.close()
      }
    },
    async readText(path) {
      try { return await readFile(path, 'utf8') } catch { return null }
    },
    async readDir(path) {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', path: join(path, e.name) }))
    },
    async readSessions() { return [] },
  }
  try {
    const found = await discoverSessions({ format: 'dsh', path: join(root, 'sessions'), host, imports: {} })
    assert.equal(found.total, 1)
    assert.equal(found.sessions[0].format, 'dsh')
    assert.equal(found.sessions[0].sessionId, 'session-dsh-test')
    assert.equal(found.sessions[0].title, 'DSH 导入测试')
    assert.equal(found.sessions[0].messageCount, 2)
    assert.equal(found.sessions[0].sourcePath, file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
