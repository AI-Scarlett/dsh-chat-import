// lib/sync-panel.mjs — 双向同步控制面板路由
//
// GET  /api-import/sync   读开关 / 间隔 / 上次巡检 / 定时器状态
// POST /api-import/sync   改开关 / 间隔 / 单轮会话上限，或立即跑一轮（runNow）

import { loadSyncConfig, patchSyncConfig, SYNC_FORMATS } from './sync-config.mjs'
import { getSyncStatus, runSyncOnce, startSyncTimer } from './sync-loop.mjs'

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(String(chunk))
  return JSON.parse(chunks.join('') || '{}')
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function registerSyncRoutes(ctx, ws, registryDir) {
  const replyStatus = async () => {
    const config = await loadSyncConfig(registryDir)
    return { ok: true, config, status: getSyncStatus(), formats: SYNC_FORMATS }
  }

  ws.register({
    kind: 'exact',
    path: '/api-import/sync',
    handler: async (req, res) => {
      try {
        const method = String(req.method || 'GET').toUpperCase()
        if (method === 'GET') {
          json(res, 200, await replyStatus())
          return
        }
        if (method !== 'POST') {
          json(res, 405, { ok: false, error: '只支持 GET / POST' })
          return
        }
        const body = await readBody(req)
        if (body.runNow === true) {
          const out = await runSyncOnce(ctx, registryDir, {
            dryRun: body.dryRun === true,
            path: typeof body.path === 'string' ? body.path : undefined,
          })
          json(res, out.ok === false ? 500 : 200, { ...(await replyStatus()), result: out })
          return
        }
        const patch = {}
        if (body.inbound && typeof body.inbound === 'object') patch.inbound = body.inbound
        if (body.outbound && typeof body.outbound === 'object') patch.outbound = body.outbound
        if (body.intervalMs !== undefined) patch.intervalMs = body.intervalMs
        if (body.maxSessionsPerRun !== undefined) patch.maxSessionsPerRun = body.maxSessionsPerRun
        await patchSyncConfig(registryDir, patch)
        await startSyncTimer(ctx, registryDir)
        json(res, 200, await replyStatus())
      } catch (err) {
        json(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  })
}
