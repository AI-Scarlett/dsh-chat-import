// Normalize the two public persistence contracts without changing the Host service.
export function persistenceFor(ctx) {
  const service = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
  if (!service || typeof service.open !== 'function') return service
  const readFrom = async (id, offset = 0, signal) => {
    const handle = await service.open(id, 'read', { signal })
    try {
      return { meta: handle.header, events: await handle.read(offset, undefined, { signal }) }
    } finally { await handle.close() }
  }
  return {
    list: async () => (await service.list()).map(snapshot => snapshot.header),
    listSnapshots: signal => service.list({ signal }),
    inspect: (id, signal) => readFrom(id, 0, signal),
    readFrom,
  }
}

export async function prepareSessionForHost(ctx, converted) {
  const service = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
  if (typeof service?.open !== 'function') return converted
  // Only synthesizeSession's import vocabulary enters here, never a raw DSH
  // artifact. Imported replies contain no captured stream; v2 represents that
  // honestly as stream: []. Keep the pure converter's legacy output unchanged.
  const vocabulary = new Set(['session/imported', 'turn/start', 'step/start',
    'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
    'turn/end', 'session/title'])
  if (converted.meta.version !== 0 || converted.events.some((event, seq) =>
    event.seq !== seq || !vocabulary.has(event.type) || event.data?.stream !== undefined)) {
    throw new Error('Unsupported synthesized import format; refusing to rewrite session history')
  }
  const header = Object.fromEntries(['version', 'id', 'createdAt', 'cwd', 'agentPreset', 'parentSession', 'origin']
    .filter(key => converted.meta[key] !== undefined).map(key => [key, converted.meta[key]]))
  const artifact = JSON.parse(JSON.stringify({
    meta: { ...header, version: 2, isSeeded: false, delegationDepth: 0 },
    events: converted.events.map(event => event.type === 'assistant/message'
      ? { ...event, data: { ...event.data, stream: [] } } : event),
  }))
  return { ...converted, ...artifact }
}

export async function persistSession(ctx, { meta, id = meta?.id, events }) {
  const service = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
  if (typeof service.open !== 'function') {
    if (meta) await service.create(meta)
    await service.append(id, events)
    return
  }
  const handle = meta ? await service.create(meta) : await service.open(id, 'write')
  try {
    await handle.append(events)
    await handle.flush()
  } finally {
    // Also release ownership after append/flush failure, so the user can retry.
    await handle.close()
  }
}
