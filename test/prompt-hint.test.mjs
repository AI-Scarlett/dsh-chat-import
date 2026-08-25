// v0.4 session hint: scoped, no startup discovery, no registry writes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSessionHint } from '../lib/prompt-hint.mjs'

function makeCtx() {
  const listeners = new Map()
  const ctx = {
    // Any accidental startup I/O fails the test immediately.
    fs: new Proxy({}, { get() { throw new Error('session hint must not access fs') } }),
    sessionPersistence: new Proxy({}, { get() { throw new Error('session hint must not access persistence') } }),
    on(event, handler) { listeners.set(event, handler); return () => {} },
  }
  return { ctx, listeners }
}

function fire(env, cwd, context) {
  return env.listeners.get('agent/session-start')({
    agent: { session: { header: { cwd } }, ctx: { systemPrompt: { context } } },
  })
}

test('same-project hint registers a scoped tool instruction with zero startup I/O', () => {
  const env = makeCtx()
  const contexts = []
  registerSessionHint(env.ctx, '/must-not-be-written')
  fire(env, '/synthetic/project', (definition) => contexts.push(definition))
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].name, 'chat-import-project-sharing-hint')
  assert.match(contexts[0].text, /project_sessions_list/)
  assert.match(contexts[0].text, /project_session_read/)
  assert.match(contexts[0].text, /import_\*/)
})

test('same-project hint skips sessions without cwd', () => {
  const env = makeCtx()
  const contexts = []
  registerSessionHint(env.ctx)
  fire(env, undefined, (definition) => contexts.push(definition))
  assert.equal(contexts.length, 0)
})

test('DSH_PROJECT_SESSION_HINT=0 and legacy alias disable the hint', () => {
  const originalNew = process.env.DSH_PROJECT_SESSION_HINT
  const originalOld = process.env.DSH_IMPORT_SESSION_HINT
  try {
    for (const name of ['DSH_PROJECT_SESSION_HINT', 'DSH_IMPORT_SESSION_HINT']) {
      delete process.env.DSH_PROJECT_SESSION_HINT
      delete process.env.DSH_IMPORT_SESSION_HINT
      process.env[name] = '0'
      const env = makeCtx()
      const contexts = []
      registerSessionHint(env.ctx)
      fire(env, '/synthetic/project', (definition) => contexts.push(definition))
      assert.equal(contexts.length, 0)
    }
  } finally {
    if (originalNew === undefined) delete process.env.DSH_PROJECT_SESSION_HINT
    else process.env.DSH_PROJECT_SESSION_HINT = originalNew
    if (originalOld === undefined) delete process.env.DSH_IMPORT_SESSION_HINT
    else process.env.DSH_IMPORT_SESSION_HINT = originalOld
  }
})
