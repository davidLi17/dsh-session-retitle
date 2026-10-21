/**
 * dsh-session-retitle —— host 侧插件
 *
 * 职责：给浏览器端「重命名」按钮提供一个后端接口，一次调用完成
 *   「读本会话内容 → 让模型起个中文短标题 → 写回会话名」。
 *
 * 刻意划窄的边界（为了扛住 DSH 升级）：
 *   ✅ 只注册两条自己的 HTTP 路由（/rename、/status），挂在 ctx.webServer 上
 *   ✅ 只在用户点按钮时干活：不轮询、不写文件、不注册 provider、不碰别人的会话
 *   ✅ 服务（sessions / llm / sessionTitle / agentDefaultModel）逐个探测，
 *      缺任何一个都只让按钮报错，绝不阻塞 DSH 启动
 *   ❌ 不自己 append session/title —— 走官方 SessionTitleService.rename()，
 *      归一化、长度上限、user 来源固定（不再被自动命名覆盖）都由官方负责
 *
 * 安全：与 dsh-agent-memory 面板同样的信任栅栏 —— 所有路由先过
 * ctx.get('connection').requestRejection(req)，栅栏不可用时 fail-closed。
 */
import {
  applyChunk,
  buildLlmRequest,
  buildSystemPrompt,
  collectDigest,
  finishError,
  normalizeConfig,
  normalizeTitle,
  routeCandidates,
} from './retitle.js'

export const PLUGIN_VERSION = '0.1.2'

const MAX_BODY_BYTES = 16 * 1024

/** 带 HTTP 语义的插件错误：终端用户能在按钮上看到 message。 */
export class RetitleError extends Error {
  constructor(code, message, http = 400) {
    super(message)
    this.name = 'RetitleError'
    this.code = code
    this.http = http
  }
}

/** 运行状态：给 /status 用，也便于出问题时自证"到底哪一步没就绪"。 */
export function createStatus() {
  return {
    loadedAt: new Date().toISOString(),
    requests: 0,
    ok: 0,
    failed: 0,
    last: null,
    lastError: null,
    /** 按错误码计数：出问题时一眼看出是"会话没打开"还是"模型不可用"。 */
    byCode: {},
    /** 最近 5 条错误（新→旧），带时间与原文。 */
    recentErrors: [],
    caps: {},
  }
}

/** 在任意 ctx 上尽力取一个服务，取不到返回 undefined（绝不抛）。 */
export function resolveService(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch { /* 继续尝试属性直取 */ }
  try {
    return ctx ? ctx[name] : undefined
  } catch { return undefined }
}

/** 读取并解析 JSON 请求体，带体积上限。 */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limit) throw new RetitleError('payload-too-large', `请求体超过 ${limit} 字节`, 413)
    chunks.push(buf)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new RetitleError('bad-json', '请求体必须是一个 JSON 对象', 400)
    }
    return parsed
  } catch (err) {
    if (err instanceof RetitleError) throw err
    throw new RetitleError('bad-json', '请求体不是合法 JSON', 400)
  }
}

/**
 * 核心动作：为一个活着的会话生成/接受标题，并交给官方的 sessionTitle 服务落盘。
 * 依赖以 services 显式传入，方便自测时替换。
 * @returns `{ title, source, route, digest }`（dryRun 时不含落盘结果）。
 */
export async function retitleOnce({ services, sessionId, title, dryRun = false, config, status }) {
  const sessions = services.sessions
  const sessionTitle = services.sessionTitle
  const llm = services.llm

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new RetitleError('bad-request', '缺少 sessionId', 400)
  }
  if (!sessions || typeof sessions.get !== 'function') {
    throw new RetitleError('sessions-unavailable', '会话服务不可用（sessions.get 缺失）', 503)
  }
  if (!sessionTitle || typeof sessionTitle.rename !== 'function') {
    throw new RetitleError('title-service-unavailable', '会话改名服务不可用（本部署未挂载 session-title）', 503)
  }

  const session = sessions.get(sessionId)
  if (!session) {
    throw new RetitleError('session-not-live', `会话 ${sessionId} 当前不在内存中（只有打开着的会话能被改名）`, 404)
  }

  let finalTitle = ''
  let source = 'user'
  let route = null
  let digest = null
  /** 非致命提示（如"输出被 max-tokens 截断，但已采用截断前的标题"）。 */
  const warnings = []

  const explicit = typeof title === 'string' ? normalizeTitle(title, config.maxTitleBytes) : ''
  if (explicit) {
    finalTitle = explicit
  } else {
    if (!llm || typeof llm.stream !== 'function') {
      throw new RetitleError('llm-unavailable', '模型服务不可用（llm.stream 缺失）', 503)
    }
    let events = []
    try {
      events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    } catch { events = [] }
    digest = collectDigest(events, config)
    if (digest.items.length === 0) {
      throw new RetitleError('no-content', '这个会话里还没有可用来起名的内容（先聊几句再试）', 409)
    }

    let headerConfig
    try {
      headerConfig = session.requestHeader?.()?.config
    } catch { headerConfig = undefined }
    // 只使用目标会话的模型；不可用时保留旧标题，不静默切换模型。
    const candidates = routeCandidates({ headerConfig })
    if (candidates.length === 0) {
      throw new RetitleError('no-model-route', '目标会话尚未记录模型，请先在该会话发送一条消息后再试', 503)
    }

    let lastFailure = null
    for (let attemptIndex = 0; attemptIndex < candidates.length; attemptIndex += 1) {
      const attempt = candidates[attemptIndex]
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`标题生成超过 ${config.timeoutMs}ms`)), config.timeoutMs)
      const state = { text: '', finish: null }
      let thrown = null
      try {
        const request = buildLlmRequest({
          route: attempt,
          items: digest.items,
          system: buildSystemPrompt(),
          sessionId,
          config,
        })
        for await (const chunk of llm.stream({ ...request, signal: controller.signal })) {
          applyChunk(state, chunk)
          if (controller.signal.aborted) break
        }
      } catch (err) {
        thrown = err
      } finally {
        clearTimeout(timer)
      }

      if (controller.signal.aborted) {
        throw new RetitleError('timeout', `标题生成超时（${config.timeoutMs}ms）`, 504)
      }
      if (thrown !== null) {
        // 超时不重试：已经等满了一个 timeout，再换一个路由只会让按钮等更久。
        if (controller.signal.aborted) {
          throw new RetitleError('timeout', `标题生成超时（${config.timeoutMs}ms）`, 504)
        }
        lastFailure = new RetitleError('llm-failed', `模型调用失败：${thrown?.message ?? thrown}`, 502)
        warnings.push(`${attempt.provider}/${attempt.model}：${lastFailure.message}`)
        continue
      }

      // 宽容收尾：只要模型已经吐出可用的标题文本就采用它 ——
      // 结束原因不完美（例如 max-tokens 截断）不该把已经拿到的好标题丢掉。
      const terminal = finishError(state.finish)
      const finishKind = typeof state.finish === 'object' ? state.finish?.kind : state.finish
      if (terminal && finishKind !== 'max-tokens') {
        throw new RetitleError('llm-failed', terminal.message, 502)
      }
      const candidateTitle = normalizeTitle(state.text, config.maxTitleBytes)
      if (candidateTitle) {
        if (attemptIndex > 0) {
          warnings.push(`会话自带路由 ${candidates[0].provider}/${candidates[0].model} 不可用，已回退到 ${attempt.provider}/${attempt.model}`)
        }
        if (terminal) warnings.push(terminal.message)
        finalTitle = candidateTitle
        route = attempt
        lastFailure = null
        break
      }

      lastFailure = terminal
        ? new RetitleError('llm-failed', terminal.message, 502)
        : new RetitleError('empty-title', '模型没有给出可用的标题（输出为空）', 502)
      warnings.push(`${attempt.provider}/${attempt.model}：${lastFailure.message}`)
    }

    if (!finalTitle) throw lastFailure ?? new RetitleError('llm-failed', '模型没有给出可用的标题', 502)
    source = 'llm'
  }

  if (dryRun) {
    return {
      title: finalTitle,
      source,
      route,
      digest: digest ? { items: digest.items.length, humanCount: digest.humanCount, assistantCount: digest.assistantCount, bytes: digest.bytes } : null,
      warnings,
      applied: false,
    }
  }

  let snapshot
  try {
    snapshot = sessionTitle.rename(session, finalTitle)
  } catch (err) {
    throw new RetitleError('rename-rejected', `改名被拒绝：${err?.message ?? err}`, 502)
  }
  if (status) {
    status.ok += 1
    status.last = { at: new Date().toISOString(), sessionId, title: snapshot?.title ?? finalTitle, source, warnings }
  }
  return {
    title: snapshot?.title ?? finalTitle,
    source,
    route,
    digest: digest ? { items: digest.items.length, humanCount: digest.humanCount, assistantCount: digest.assistantCount, bytes: digest.bytes } : null,
    warnings,
    applied: true,
  }
}

/** 把 plugin 错误翻译成 JSON 响应；未知错误记成 500 并保留原文。 */
function sendError(res, err, status) {
  const known = err instanceof RetitleError
  const http = known ? err.http : 500
  const body = {
    ok: false,
    error: {
      code: known ? err.code : 'internal',
      message: known ? err.message : `插件内部错误：${err?.message ?? err}`,
    },
  }
  try {
    res.statusCode = http
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.setHeader?.('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch { /* 响应已经发出就放弃 */ }
  if (status) {
    const entry = { at: new Date().toISOString(), code: body.error.code, message: body.error.message }
    status.failed += 1
    status.lastError = entry
    try {
      status.byCode[entry.code] = (status.byCode[entry.code] ?? 0) + 1
      status.recentErrors.unshift(entry)
      if (status.recentErrors.length > 5) status.recentErrors.length = 5
    } catch { /* 统计失败不影响响应 */ }
  }
}

/** 组装并注册两条路由（rename / status）。 */
export function attachRoutes({ scoped, root, config, status }) {
  const webServer = resolveService(scoped, 'webServer') || resolveService(root, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    status.caps.webServer = 'unavailable: webServer.register 缺失'
    throw new Error('webServer.register 不可用（DSH 接口变化或非 web 环境）')
  }
  status.caps.webServer = 'ok'

  const connectionOf = () => resolveService(scoped, 'connection') || resolveService(root, 'connection')

  /** 信任栅栏：宁可按钮报 403，也不让改名接口对外裸奔。 */
  const rejected = (req, res) => {
    try {
      const connection = connectionOf()
      if (!connection || typeof connection.requestRejection !== 'function') return true
      const code = connection.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      return true
    }
  }

  const register = (route) => {
    const inner = route.handler
    return webServer.register({
      ...route,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        try {
          await inner(req, res)
        } catch (err) {
          sendError(res, err, status)
        }
      },
    })
  }

  const prefix = config.routePrefix

  /** 同一会话同一时刻只允许一个改名请求：连点按钮不该并发烧模型，也不该互相覆盖标题。 */
  const inFlight = new Set()

  const disposers = []
  disposers.push(register({
    kind: 'exact',
    path: `${prefix}/rename`,
    handler: async (req, res) => {
      status.requests += 1
      if (String(req.method || 'POST').toUpperCase() !== 'POST') {
        throw new RetitleError('method-not-allowed', '只接受 POST', 405)
      }
      const body = await readJsonBody(req)
      const key = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : ''
      if (key && inFlight.has(key)) {
        throw new RetitleError('already-running', '这个会话的上一次改名还在处理中，请稍候', 429)
      }
      if (key) inFlight.add(key)
      try {
        const services = {
          sessions: resolveService(root, 'sessions'),
          sessionTitle: resolveService(root, 'sessionTitle'),
          llm: resolveService(root, 'llm'),
          agentDefaultModel: resolveService(root, 'agentDefaultModel'),
        }
        const result = await retitleOnce({
          services,
          sessionId: body.sessionId,
          title: body.title,
          dryRun: body.dryRun === true,
          config,
          status,
        })
        res.statusCode = 200
        res.setHeader?.('content-type', 'application/json; charset=utf-8')
        res.setHeader?.('cache-control', 'no-store')
        res.end(JSON.stringify({ ok: true, ...result }))
      } finally {
        if (key) inFlight.delete(key)
      }
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${prefix}/status`,
    handler: (req, res) => {
      const services = {
        sessions: resolveService(root, 'sessions'),
        sessionTitle: resolveService(root, 'sessionTitle'),
        llm: resolveService(root, 'llm'),
      }
      const payload = {
        ok: true,
        plugin: { name: 'dsh-session-retitle', version: PLUGIN_VERSION },
        runtime: {
          ...status,
          caps: {
            ...status.caps,
            sessions: services.sessions && typeof services.sessions.get === 'function' ? 'ok' : 'unavailable',
            sessionTitle: services.sessionTitle && typeof services.sessionTitle.rename === 'function' ? 'ok' : 'unavailable',
            llm: services.llm && typeof services.llm.stream === 'function' ? 'ok' : 'unavailable',
          },
        },
        config: { ...config },
      }
      res.statusCode = 200
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.setHeader?.('cache-control', 'no-store')
      res.end(JSON.stringify(payload, null, 2))
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* 卸载失败不影响 DSH */ }
    }
  }
}

export default {
  name: 'dsh-session-retitle',
  // 不把任何服务作为硬依赖：缺了也不阻止 DSH 启动。
  inject: [],
  apply(ctx, rawConfig = {}) {
    const config = normalizeConfig(rawConfig)
    const status = createStatus()
    status.caps.plugin = `ok: v${PLUGIN_VERSION}`

    // webServer 重建时会再次回调：只挂一次，避免重复注册同一路径。
    let attached = false
    const attach = (scoped) => {
      if (attached) return
      try {
        attachRoutes({ scoped, root: ctx, config, status })
        attached = true
        status.caps.routes = `ok: ${config.routePrefix}/rename, ${config.routePrefix}/status`
      } catch (err) {
        status.caps.routes = `unavailable: ${err?.message ?? err}`
      }
    }

    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer', 'connection'], attach)
        status.caps.routes = 'pending: 等 webServer/connection 就绪'
      } else {
        attach(ctx)
      }
    } catch (err) {
      status.caps.routes = `unavailable: ${err?.message ?? err}`
    }

    try { ctx.set?.('sessionRetitleStatus', status) } catch { /* 可选服务 */ }
    try {
      console.log(`[dsh-session-retitle] v${PLUGIN_VERSION} 已加载：${config.routePrefix}/rename`)
    } catch { /* ignore */ }
  },
}
