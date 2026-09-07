import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { convertClaudeJsonl } from '../convert.mjs'
import { persistenceFor, persistSession, prepareSessionForHost } from '../lib/persistence.mjs'
import { readSharedSession } from '../lib/project-share.mjs'

test('handle imports flush before releasing ownership and release on append failure', async () => {
  for (const fail of [false, true]) {
    const calls = []
    const service = {
      open() {},
      async create() { calls.push('create'); return {
        async append() { calls.push('append'); if (fail) throw new Error('write failed') },
        async flush() { calls.push('flush') },
        async close() { calls.push('close') },
      } },
    }
    const result = persistSession({ sessionPersistence: service }, { meta: { id: 'synthetic' }, events: [] })
    if (fail) await assert.rejects(result, /write failed/)
    else await result
    assert.deepEqual(calls, fail ? ['create', 'append', 'close'] : ['create', 'append', 'flush', 'close'])
  }
})

test('busy handle ownership is surfaced without appending or trying legacy writes', async () => {
  let appended = false
  await assert.rejects(persistSession({ sessionPersistence: {
    async open(id, access) { assert.equal(access, 'write'); throw new Error('SESSION_ALREADY_OWNED') },
    async append() { appended = true },
  } }, { id: 'busy', events: [] }), /SESSION_ALREADY_OWNED/)
  assert.equal(appended, false)
})

test('new list snapshots and read handles retain old export/read interfaces', async () => {
  let closed = 0
  const header = { id: 'one', cwd: '/synthetic' }
  const service = {
    async list() { return [{ header, revision: '1', eventCount: 1 }] },
    async open(id, access) {
      assert.equal(id, 'one'); assert.equal(access, 'read')
      return { header, async read(offset) { return offset === 0 ? [{ seq: 0 }] : [] }, async close() { closed++ } }
    },
  }
  const adapter = persistenceFor({ sessionPersistence: service })
  assert.deepEqual(await adapter.list(), [header])
  assert.equal((await adapter.listSnapshots())[0].header.id, 'one')
  assert.deepEqual(await adapter.readFrom('one', 0), { meta: header, events: [{ seq: 0 }] })
  assert.equal(closed, 1)
})

test('project sharing validates the current project before reading and closes the handle on refusal', async () => {
  let closed = 0
  let read = false
  const ctx = { fs: { async resolve(path) { return { targetKey: path } } }, sessionPersistence: {
    async open() { return { header: { id: 'one', cwd: '/other-project' },
      async read() { read = true; return [] }, async close() { closed++ },
    } },
  } }
  await assert.rejects(readSharedSession(ctx, { source: 'dsh', sessionId: 'one', projectKey: '/project' }, {}), /PROJECT_CHANGED/)
  assert.equal(read, false)
  assert.equal(closed, 1)
})

test('project sharing pages a v2 log through a read handle and omits reasoning', async () => {
  const events = [
    { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'world' }] } } },
  ]
  let closed = false
  const ctx = { fs: { async resolve(path) { return { targetKey: path } } }, sessionPersistence: {
    async open(id, access) { assert.equal(access, 'read'); return {
      header: { id, cwd: '/project' }, async read(offset, length) { assert.ok(length <= 256); return events.slice(offset, offset + length) },
      async close() { closed = true },
    } },
  } }
  const result = await readSharedSession(ctx, { source: 'dsh', sessionId: 'one', projectKey: '/project' }, {})
  assert.deepEqual(result.messages, [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'world' }])
  assert.equal(closed, true)
})

test('synthesized v2 imports match the official migration including tool references', async t => {
  let catalog
  try { catalog = (await import('@deepseek-ai/dsh-session-format-catalog')).sessionFormatCatalog } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    t.skip('optional official format catalog is absent in this test installation'); return
  }
  for (const name of ['sess-simple-001.jsonl', 'sess-tool-001.jsonl', 'sess-multi-001.jsonl']) {
    const converted = convertClaudeJsonl(await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8'), {})
    converted.meta.cwd = '/synthetic-project'
    const before = JSON.stringify(converted)
    const migrated = await prepareSessionForHost({ sessionPersistence: { open() {} } }, converted)
    const shift = (events, delta) => events.map(event => ({ ...event, seq: event.seq + delta,
      ...(event.sourceEventSeqs ? { sourceEventSeqs: event.sourceEventSeqs.map(seq => seq + delta) } : {}),
      ...(event.type === 'session/title' ? { data: { ...event.data, messageSeqs: event.data.messageSeqs.map(seq => seq + delta) } } : {}),
    }))
    const official = catalog.migrate(JSON.parse(JSON.stringify({
      header: { ...migrated.meta, version: 0 },
      events: shift(converted.events.slice(1), -1), inheritedEventCount: 0,
    })))
    assert.deepEqual(migrated.events.slice(1), shift(official.events, 1))
    assert.deepEqual(migrated.meta, official.header)
    assert.equal(migrated.meta.version, catalog.currentVersion)
    assert.equal(migrated.events[0].type, 'session/imported')
    assert.equal(JSON.stringify(converted), before)
    for (const [seq, event] of migrated.events.entries()) {
      assert.equal(event.seq, seq)
      if (event.type === 'tool/result') for (const source of event.sourceEventSeqs ?? []) assert.equal(migrated.events[source].type, 'tool/call')
    }
  }
})

test('v2 synthesis is self-contained and refuses unsynthesized history', async () => {
  const converted = convertClaudeJsonl(await readFile(new URL('fixtures/sess-simple-001.jsonl', import.meta.url), 'utf8'), {})
  const ctx = { sessionPersistence: { open() {} } }
  const result = await prepareSessionForHost(ctx, converted)
  assert.equal(result.meta.version, 2)
  assert.deepEqual(result.events.find(event => event.type === 'assistant/message').data.stream, [])
  assert.equal(result.meta.sourceId, undefined)
  assert.equal(await prepareSessionForHost({ sessionPersistence: {} }, converted), converted)
  await assert.rejects(prepareSessionForHost(ctx, { ...converted, events: [{ seq: 0, type: 'assistant/chunk' }] }), /Unsupported synthesized/)
})
