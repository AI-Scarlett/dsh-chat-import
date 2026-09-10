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
  // Only converter output enters here, never a raw DSH artifact. The converter
  // deliberately stays at format 0; this boundary stamps the installed host's
  // current format and keeps the pure conversion layer independent of DSH.
  const vocabulary = new Set(['session/imported', 'turn/start', 'step/start',
    'system/message', 'user/message', 'assistant/message', 'tool/call', 'tool/result',
    'step/end', 'turn/end', 'session/title'])
  if (converted.meta.version !== 0 || converted.events.some((event, seq) =>
    event.seq !== seq || !vocabulary.has(event.type) || event.data?.stream !== undefined)) {
    // Native DSH V3 imports carry their assistant stream in the message payload;
    // all other converter output must remain the bounded synthesized vocabulary.
    const nativeV3 = converted.meta.sourceFormatVersion === 3
    if (!nativeV3 || converted.events.some((event, seq) =>
      event.seq !== seq || !vocabulary.has(event.type) ||
      (event.type !== 'assistant/message' && event.data?.stream !== undefined))) {
      throw new Error('Unsupported synthesized import format; refusing to rewrite session history')
    }
  }
  const header = Object.fromEntries(['version', 'id', 'createdAt', 'cwd', 'agentPreset', 'parentSession', 'origin']
    .filter(key => converted.meta[key] !== undefined).map(key => [key, converted.meta[key]]))
  const nativeV3 = converted.meta.sourceFormatVersion === 3
  const artifact = nativeV3
    ? { meta: { ...header, version: 3, isSeeded: false, delegationDepth: 0 }, events: converted.events }
    : upgradeSynthesizedToV3(converted, header)
  return { ...converted, ...artifact }
}

function remapReferences(event, map, delta = 0) {
  const next = { ...event }
  if (Array.isArray(event.sourceEventSeqs)) {
    next.sourceEventSeqs = event.sourceEventSeqs.map(seq => map.has(seq) ? map.get(seq) : seq).map(seq => seq + delta)
  }
  if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
    const start = event.surfaceOp.startSeq ?? event.surfaceOp.start
    const end = event.surfaceOp.endSeq ?? event.surfaceOp.end
    const startSeq = (map.has(start) ? map.get(start) : start) + delta
    const endSeq = (map.has(end) ? map.get(end) : end) + delta
    next.surfaceOp = { op: 'replace', startSeq, endSeq }
  }
  if (event.type === 'session/title' && Array.isArray(event.data?.messageSeqs)) {
    next.data = { ...event.data, messageSeqs: event.data.messageSeqs.map(seq => (map.has(seq) ? map.get(seq) : seq) + delta) }
  }
  return next
}

function upgradeSynthesizedToV3(converted, header) {
  const source = converted.events
  const stepIndex = source.findIndex(event => event.type === 'step/start')
  const insertAt = stepIndex < 0 ? -1 : stepIndex + 1
  const map = new Map(source.map((event, index) => [event.seq, index + (insertAt >= 0 && index >= insertAt ? 1 : 0)]))
  const events = []
  for (const [index, event] of source.entries()) {
    if (index === insertAt) {
      const step = source[stepIndex]?.data ?? { turn: 1, step: 1 }
      events.push({
        type: 'system/message',
        seq: index,
        time: source[stepIndex].time,
        data: {
          turn: step.turn,
          step: step.step,
          message: {
            id: `import:${header.id}:system`,
            role: 'system',
            content: [],
            source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
          },
        },
        surfaceOp: 'append',
      })
    }
    const next = remapReferences(event, map)
    next.seq = map.get(event.seq)
    if (next.type === 'assistant/message') {
      next.data = { ...next.data, stream: Array.isArray(next.data?.stream) ? next.data.stream : [] }
    }
    events.push(next)
  }
  return { meta: { ...header, version: 3, isSeeded: false, delegationDepth: 0 }, events }
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
