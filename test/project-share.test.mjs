import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  LOCATOR_TTL_MS, createProjectLocatorStore, registerProjectShareTools,
} from '../lib/project-share.mjs'
import { clearScanCache } from '../lib/discovery.mjs'

const j = (value) => JSON.stringify(value)

function makeFs() {
  const target = async (path) => {
    const absolute = resolve(String(path))
    try { return await realpath(absolute) } catch { return absolute }
  }
  return {
    async resolve(path) {
      const key = await target(path)
      return { targetKey: key, displayPath: key }
    },
    async stat(fsTarget) {
      try {
        const info = await stat(fsTarget.targetKey)
        return {
          type: info.isDirectory() ? 'directory' : (info.isFile() ? 'file' : 'other'),
          size: info.size,
          mtimeMs: info.mtimeMs,
          version: 'v-' + info.size + '-' + info.mtimeMs,
        }
      } catch { return undefined }
    },
    async readText(fsTarget) { return readFile(fsTarget.targetKey, 'utf8') },
    async streamText(fsTarget) {
      const text = await readFile(fsTarget.targetKey, 'utf8')
      return (async function * chunks() {
        for (let i = 0; i < text.length; i += 37) yield text.slice(i, i + 37)
      })()
    },
    async listDir(fsTarget) {
      const entries = await readdir(fsTarget.targetKey, { withFileTypes: true })
      return Promise.all(entries.map(async (entry) => {
        const key = await target(join(fsTarget.targetKey, entry.name))
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : (entry.isFile() ? 'file' : 'other'),
          target: { targetKey: key, displayPath: key },
        }
      }))
    },
  }
}

function execFor(project, id = 'current-dsh') {
  return {
    signal: new globalThis.AbortController().signal,
    agent: { id, session: { header: { id, cwd: project } } },
  }
}

async function fixture() {
  clearScanCache()
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-share-'))
  const home = join(root, 'home')
  const project = join(root, 'workspace', 'same-project')
  const otherProject = join(root, 'workspace', 'other-project')
  const codexDir = join(home, '.codex', 'sessions', '2026', '08', '25')
  const claudeDir = join(home, '.claude', 'projects', 'same-project')
  await Promise.all([mkdir(project, { recursive: true }), mkdir(otherProject, { recursive: true }),
    mkdir(codexDir, { recursive: true }), mkdir(claudeDir, { recursive: true })])

  const codexId = '019c-project-share-codex'
  const codexPath = join(codexDir, 'rollout-' + codexId + '.jsonl')
  await writeFile(codexPath, [
    j({ type: 'session_meta', timestamp: '2026-08-25T01:00:00Z', payload: { id: codexId, cwd: project } }),
    j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }] } }),
    j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<system-reminder>also hidden</system-reminder>' },
      { type: 'input_text', text: 'Codex 做到一半，请继续修复登录，不要暴露 sk-abcdefghijklmnopqrstuvwxyz' },
    ] } }),
    j({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'PRIVATE_REASONING' }] } }),
    j({ type: 'response_item', payload: { type: 'function_call_output', output: 'PRIVATE_TOOL_OUTPUT' } }),
    j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成路由，下一步补测试。' }] } }),
  ].join('\n'))

  const otherCodexPath = join(codexDir, 'rollout-other.jsonl')
  await writeFile(otherCodexPath, [
    j({ type: 'session_meta', payload: { id: 'other-codex', cwd: otherProject } }),
    j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '不应该出现' }] } }),
  ].join('\n'))

  const claudeId = 'claude-project-share'
  const claudePath = join(claudeDir, claudeId + '.jsonl')
  await writeFile(claudePath, [
    j({ sessionId: claudeId, cwd: project, type: 'user', timestamp: '2026-08-25T02:00:00Z', message: { role: 'user', content: '继续完成 Claude 任务，密钥 sk-claudeabcdefghijklmnopqrstuvwxyz' } }),
    j({ sessionId: claudeId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已留下清晰交接。' }, { type: 'tool_use', input: { secret: 'PRIVATE' } }] } }),
    j({ sessionId: claudeId, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'PRIVATE_CLAUDE_TOOL_OUTPUT' }] } }),
  ].join('\n'))

  const dshId = 'dsh-sibling'
  const dshSession = {
    meta: { id: dshId, cwd: project, createdAt: Date.parse('2026-08-25T03:00:00Z') },
    events: [
      { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'DSH 里的交接问题' }] } },
      { seq: 1, type: 'user/message', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'PRIVATE_DSH_INJECTION' }] } },
      { seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'PRIVATE_DSH_TOOL_OUTPUT' }] } } },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'DSH 交接答案' }] } } },
    ],
  }
  const persistence = {
    async listSnapshots() {
      return [
        { header: dshSession.meta, revision: 'r1' },
        { header: { id: 'current-dsh', cwd: project, createdAt: Date.now() }, revision: 'r2' },
        { header: { id: 'different-dsh', cwd: otherProject, createdAt: Date.now() }, revision: 'r3' },
      ]
    },
    async inspect(id) {
      if (id !== dshId) throw new Error('unexpected inspect')
      return dshSession
    },
    async create() { throw new Error('sharing must not create a session') },
    async append() { throw new Error('sharing must not append a session') },
  }
  const registered = []
  const ctx = {
    fs: makeFs(),
    sessionPersistence: persistence,
    tools: { register(def) { registered.push(def); return () => {} } },
  }
  registerProjectShareTools(ctx, join(root, 'cache'), { home })
  return {
    ctx, registered, project, otherProject, codexId, codexPath, claudeId, dshId,
  }
}

function tool(fx, name) {
  const found = fx.registered.find((definition) => definition.name === name)
  assert.ok(found, 'missing tool ' + name)
  return found
}

test('same-project list returns opaque locators only and excludes other projects/current DSH', async () => {
  const fx = await fixture()
  const definition = tool(fx, 'project_sessions_list')
  const value = await definition.execute({}, execFor(fx.project))
  assert.equal(value.total, 3)
  assert.deepEqual(value.sessions.map((row) => row.source).sort(), ['claude', 'codex', 'dsh'])
  assert.ok(value.sessions.every((row) => /^ps_[^.]+\.[A-Za-z0-9_-]+$/.test(row.locator)))
  assert.ok(value.sessions.every((row) => !('sourcePath' in row) && !('projectPath' in row)))
  assert.doesNotMatch(value.sessions.map((row) => row.title).join('\n'), /sk-claude/)
  validateJsonSchemaValue(definition.output.schema, value)
})

test('on-demand Codex read is bounded, redacted, and excludes reasoning/tool output', async () => {
  const fx = await fixture()
  const list = await tool(fx, 'project_sessions_list').execute({ sources: ['codex'] }, execFor(fx.project))
  const value = await tool(fx, 'project_session_read').execute({
    locator: list.sessions[0].locator, messageLimit: 4, charLimit: 4000,
  }, execFor(fx.project))
  assert.equal(value.source, 'codex')
  assert.deepEqual(value.messages.map((message) => message.role), ['user', 'assistant'])
  const text = value.messages.map((message) => message.text).join('\n')
  assert.match(text, /继续修复登录/)
  assert.match(text, /\[REDACTED_SECRET\]/)
  assert.doesNotMatch(text, /PRIVATE_REASONING|PRIVATE_TOOL_OUTPUT|sk-abcdefghijklmnopqrstuvwxyz/)
  validateJsonSchemaValue(tool(fx, 'project_session_read').output.schema, value)
})

test('Claude and DSH readers expose only user/assistant text', async () => {
  const fx = await fixture()
  const list = await tool(fx, 'project_sessions_list').execute({ sources: ['claude', 'dsh'] }, execFor(fx.project))
  for (const source of ['claude', 'dsh']) {
    const row = list.sessions.find((session) => session.source === source)
    const value = await tool(fx, 'project_session_read').execute({ locator: row.locator }, execFor(fx.project))
    const text = value.messages.map((message) => message.text).join('\n')
    assert.ok(text.length > 0)
    assert.doesNotMatch(text, /PRIVATE_CLAUDE_TOOL_OUTPUT|PRIVATE_DSH_TOOL_OUTPUT|PRIVATE_DSH_INJECTION/)
  }
})

test('locator is bound to the caller project and source identity is revalidated', async () => {
  const fx = await fixture()
  const listing = await tool(fx, 'project_sessions_list').execute({ sources: ['codex'] }, execFor(fx.project))
  const locator = listing.sessions[0].locator
  await assert.rejects(
    tool(fx, 'project_session_read').execute({ locator }, execFor(fx.otherProject)),
    /PROJECT_SESSION_LOCATOR_INVALID/,
  )
  const raw = await readFile(fx.codexPath, 'utf8')
  await writeFile(fx.codexPath, raw.replace(fx.codexId, 'changed-session-id'))
  await assert.rejects(
    tool(fx, 'project_session_read').execute({ locator }, execFor(fx.project)),
    /PROJECT_SESSION_IDENTITY_CHANGED/,
  )
})

test('opaque locators expire without persistent storage', () => {
  let now = 10
  const store = createProjectLocatorStore({ now: () => now })
  const locator = store.issue({ source: 'codex', sessionId: 's', projectKey: 'p' })
  assert.equal(store.resolve(locator, 'p').sessionId, 's')
  now += LOCATOR_TTL_MS + 1
  assert.throws(() => store.resolve(locator, 'p'), /PROJECT_SESSION_LOCATOR_INVALID/)
  assert.equal(store.size, 0)
})

test('Tool cards are deterministic on replay, malformed logged args use undefined fallback, and metadata stays JSON-bounded', async () => {
  const fx = await fixture()
  const listTool = tool(fx, 'project_sessions_list')
  const readTool = tool(fx, 'project_session_read')

  const callArgs = { sources: ['codex'], limit: 1 }
  assert.deepEqual(listTool.presentCall(callArgs), listTool.presentCall(callArgs))
  assert.equal(listTool.presentCall({ sources: ['malformed-source'] }), undefined)
  assert.equal(readTool.presentCall({ locator: 42 }), undefined)

  const listValue = await listTool.execute(callArgs, execFor(fx.project))
  const listMeta = listTool.output.presentationMeta(callArgs, listValue)
  assert.doesNotThrow(() => JSON.stringify(listMeta))
  const completed = { content: [], isError: false, meta: listMeta }
  assert.deepEqual(
    listTool.presentResult(callArgs, completed),
    listTool.presentResult(callArgs, completed),
  )

  const bounded = await readTool.execute({
    locator: listValue.sessions[0].locator, messageLimit: 1, charLimit: 1000,
  }, execFor(fx.project))
  assert.equal(bounded.messages.length, 1)
  assert.ok(bounded.messages[0].text.length <= 1000)
  const readMeta = readTool.output.presentationMeta({}, bounded)
  assert.doesNotThrow(() => JSON.stringify(readMeta))
})
