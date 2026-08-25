// lib/prompt-hint.mjs — lightweight same-project handoff instruction.
//
// v0.4 intentionally performs no filesystem discovery and writes no hints registry during
// session startup. The model already has the two project-sharing tools; this scoped context
// only states when to prefer them over legacy full imports. Actual discovery stays on demand
// inside project_sessions_list.

const HINT_CONTEXT_NAME = 'chat-import-project-sharing-hint'

const HINT_TEXT = '当用户希望继续当前项目在 Codex、Claude Code 或其他 DSH 会话中未完成的任务时，'
  + '先用 project_sessions_list 查找精确同项目会话，再用 project_session_read 按需读取选中的有界片段。'
  + '除非用户明确要求迁移完整历史，不要调用 legacy import_* 工具创建会话副本。'

export function registerSessionHint(ctx) {
  // New name is primary; the old switch remains a compatibility alias.
  const enabled = () => process.env.DSH_PROJECT_SESSION_HINT !== '0'
    && process.env.DSH_IMPORT_SESSION_HINT !== '0'
  ctx.on('agent/session-start', ({ agent }) => {
    try {
      if (!enabled()) return
      const header = agent && agent.session && agent.session.header
      if (!header || typeof header.cwd !== 'string' || !header.cwd) return
      const systemPrompt = agent.ctx && agent.ctx.systemPrompt
      if (!systemPrompt || typeof systemPrompt.context !== 'function') return
      systemPrompt.context({
        name: HINT_CONTEXT_NAME,
        order: 500,
        text: HINT_TEXT,
      })
    } catch (err) {
      console.warn('[dsh-chat-import] 项目会话共享提示注入失败（不影响会话）：' + String((err && err.message) || err))
    }
  })
}
