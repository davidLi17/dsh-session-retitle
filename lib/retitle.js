/**
 * dsh-session-retitle —— 纯逻辑层（零依赖、无副作用、可单测）
 *
 * 这里只做三件事，全部是纯函数：
 *   1. 从会话事件里抽出"给人看的素材"（人类消息 + 助手回复要点）；
 *   2. 把素材整理成一次标题生成的模型请求（系统提示 + 一条 plugin 用户消息）；
 *   3. 把模型输出收拾成一个合法标题（去引号/前缀/控制字符，按字节预算截断）。
 *
 * 刻意不 import 任何 @deepseek-ai/* 包：插件以 link: 安装在工作区，
 * Node 从插件真实路径解析不到 DSH 的内部包，硬依赖会在启动时炸掉整个实例。
 * 需要 DSH 内部对象（llm / sessions / sessionTitle）时一律由 index.js 探测后注入。
 */
import { randomUUID } from 'node:crypto'

export const DEFAULT_CONFIG = {
  routePrefix: '/dsh-session-retitle',
  maxTitleBytes: 80,
  maxDigestBytes: 8000,
  maxDigestItems: 16,
  timeoutMs: 45000,
  provider: '',
  model: '',
  humanItemChars: 800,
  assistantItemChars: 600,
  maxOutputTokens: 512,
}

/**
 * 请求用途标记。**必须**用官方的 `session-title`：
 * dsh-llm-deepseek 里有 `if (options.purpose === "session-title") return { thinking: "disabled" }`，
 * 官方标题 provider 正是靠它关掉思考，才敢只给 64 个输出 token。
 * 2026-09-16 踩的坑：本插件最初用自定义 purpose "session-retitle"，适配器不认、思考照开，
 * 而本机默认 reasoningEffort=high —— 64 token 全被 reasoning 吃掉，正文一个字都没写就被判
 * max-tokens，按钮连报 4 次"模型输出被 maxTokens 截断，未得到完整标题"。
 */
export const TITLE_PURPOSE = 'session-title'

const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** 合并用户配置：只接受明确给出的字段，其余走默认值。 */
export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG }
  if (raw === null || typeof raw !== 'object') return config
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof DEFAULT_CONFIG[key] === 'number') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) config[key] = Math.floor(value)
      continue
    }
    config[key] = String(value)
  }
  // 兜底路由必须成对出现，只有一半就当作没配
  if ((config.provider && !config.model) || (!config.provider && config.model)) {
    config.provider = ''
    config.model = ''
  }
  return config
}

/** 按 UTF-8 字节预算截断字符串，绝不切坏代理对。 */
export function truncateUtf8(text, maxBytes) {
  if (typeof text !== 'string' || text.length === 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/** 抽一条消息里的纯文本（只认 text block，工具的图片/文件块一律忽略）。 */
export function extractText(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 斜杠命令、空行、纯符号这类噪音不算"会话内容"。 */
function isNoise(text) {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length === 0) return true
  if (/^\/[a-z][\w-]*(\s|$)/u.test(compact) && compact.length < 80) return true
  if (/^[\p{P}\p{S}\s]+$/u.test(compact)) return true
  return false
}

/**
 * 把会话日志折叠成给模型看的素材。
 * @param events - session.snapshotEvents() 的事件数组（时间正序）。
 * @param config - normalizeConfig() 的结果。
 * @returns 有序条目、计数与体积，便于面板/日志核对。
 */
export function collectDigest(events, config = DEFAULT_CONFIG) {
  const list = Array.isArray(events) ? events : []
  const picked = []
  let humanCount = 0
  let assistantCount = 0
  let skipped = 0

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i]
    if (!event || typeof event !== 'object') continue
    let role = null
    let raw = ''
    if (event.type === 'user/message') {
      const data = event.data
      if (!data || data.source?.kind !== 'user') { skipped += 1; continue }
      role = 'human'
      raw = extractText(data)
    } else if (event.type === 'assistant/message') {
      const message = event.data?.message
      role = 'assistant'
      raw = extractText(message)
    } else {
      continue
    }
    if (isNoise(raw)) { skipped += 1; continue }
    const limit = role === 'human' ? config.humanItemChars : config.assistantItemChars
    const text = truncateUtf8(raw.replace(/\s+/g, ' ').trim(), limit)
    if (role === 'human') humanCount += 1
    else assistantCount += 1
    picked.push({ seq: typeof event.seq === 'number' ? event.seq : null, role, text })
    if (picked.length >= config.maxDigestItems) break
  }

  picked.reverse()

  // 总量预算：超了就从头丢（保留最近的对话）
  let bytes = Buffer.byteLength(JSON.stringify(picked), 'utf8')
  while (picked.length > 1 && bytes > config.maxDigestBytes) {
    picked.shift()
    bytes = Buffer.byteLength(JSON.stringify(picked), 'utf8')
  }

  return {
    items: picked,
    humanCount,
    assistantCount,
    skipped,
    bytes,
    truncated: picked.length >= config.maxDigestItems,
  }
}

/** 标题生成的中文系统提示：要求单行纯文本，避免模型"解释一通"。 */
export function buildSystemPrompt() {
  return [
    '你在给一个 AI 编程助手会话起名字。',
    '输入是一个 JSON 数组，按时间顺序记录会话内容：role 为 human 的是用户消息，role 为 assistant 的是助手回复。',
    '请概括这个会话到底在做什么。',
    '只输出标题本身：一行纯文本，不要引号、不要前缀（如"标题："）、不要解释、不要 Markdown、不要代码、不要句号。',
    '用会话的主要语言（通常是中文），10 个汉字以内，最多不超过 20 字。',
  ].join('\n')
}

/** 把素材塞进一条用户消息里（JSON 包裹，用户文本撑不破结构）。 */
export function buildUserText(items) {
  return `根据这个 JSON 数组生成会话标题：\n${JSON.stringify(items)}`
}

/** 深冻结：DSH 的模型请求对象按约定是只读快照。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * 构造一次标题模型调用的请求参数。
 * 消息形状对齐官方 @deepseek-ai/dsh-llm 的 createUserMessage()：
 * `{ id, role, content[], source:{kind:'plugin',plugin} }`。
 */
export function buildLlmRequest({ route, items, system, sessionId, config }) {
  return deepFreeze({
    provider: route.provider,
    model: route.model,
    messages: [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: buildUserText(items) }],
      source: { kind: 'plugin', plugin: 'dsh-session-retitle' },
    }],
    system,
    maxTokens: config.maxOutputTokens,
    sessionId,
    purpose: TITLE_PURPOSE,
  })
}

/**
 * 决定这次标题生成走哪套模型（候选里的第一个）：
 *   ① 会话自己的 request/header 配置（最贴合该会话正在用的模型）
 *   ② 官方 agent-default-model 的当前选择
 *   ③ 插件配置里的兜底 provider/model
 * @returns `{provider, model}`，都拿不到时返回 null（调用方报错，不编造）。
 */
export function pickRoute(options = {}) {
  return routeCandidates(options)[0] ?? null
}

/**
 * 列出可依次尝试的模型路由（去重、按优先级）：
 *   ① 会话自己的 request/header ② 官方 agent-default-model ③ 插件配置兜底。
 *
 * 为什么要"候选"而不是"选中一个"：会话日志里可能留着**当前部署已经没有 adapter**
 * 的 provider（2026-09-16 实测遇到 `deepseek-vision`），这时应当回退到可用路由，
 * 而不是把错误甩给按钮。
 * @returns 候选数组，可能为空（三个来源都没给出完整 provider/model）。
 */
export function routeCandidates({ headerConfig, defaultSelection, config } = {}) {
  const seen = new Set()
  const out = []
  for (const source of [headerConfig, defaultSelection, config]) {
    const provider = typeof source?.provider === 'string' ? source.provider.trim() : ''
    const model = typeof source?.model === 'string' ? source.model.trim() : ''
    if (!provider || !model) continue
    const key = `${provider}\u0000${model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ provider, model })
  }
  return out
}

/**
 * 把模型输出收拾成一条能直接落进 session/title 的标题。
 * @returns 规范化后的标题；完全不可用时返回空串（调用方当作失败处理）。
 */
export function normalizeTitle(raw, maxBytes = DEFAULT_CONFIG.maxTitleBytes) {
  if (typeof raw !== 'string') return ''
  let text = raw.replace(CONTROL_RE, '')
  // 只取第一段非空行：模型偶尔会多输出一行解释
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) || ''
  text = line
  // 剥掉"标题：/Title:"这类前缀
  text = text.replace(/^(?:会话)?标题\s*[:：]\s*/u, '').replace(/^(?:session\s+)?title\s*[:：]\s*/iu, '')
  // 剥掉成对引号与 Markdown 包装
  text = text.replace(/^[`"'“”‘’《》「」【】]+/u, '').replace(/[`"'“”‘’《》「」【】]+$/u, '')
  text = text.replace(/^[#>*\-\s]+/u, '').replace(/\*\*|__|`/g, '')
  // 收尾的句号/分号没意义
  text = text.replace(/[。；;：:，,、]+$/u, '')
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  // 先按字符数兜一层（CJK 场景），再按字节预算兜一层
  const chars = Array.from(text)
  if (chars.length > 40) text = chars.slice(0, 40).join('')
  text = truncateUtf8(text, maxBytes).trim()
  return text
}

/** 从 chunk 里取文本增量；不认识的 chunk 一律忽略（协议演进时也不会崩）。 */
export function applyChunk(state, chunk) {
  if (!chunk || typeof chunk !== 'object') return
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') state.text += chunk.text
  else if (chunk.type === 'finish') state.finish = chunk.reason ?? chunk.finish ?? null
}

/** 把 finish reason 翻译成人话；正常结束返回 null。 */
export function finishError(finish) {
  if (finish === null || finish === undefined) return null
  const kind = typeof finish === 'object' ? finish.kind : String(finish)
  if (kind === 'stop') return null
  if (kind === 'error' || kind === 'aborted') {
    const failure = typeof finish === 'object' ? finish.failure : undefined
    return new Error(`模型调用未完成（${kind}）：${failure?.message ?? '无详情'}`)
  }
  if (kind === 'max-tokens') return new Error('模型输出被 maxTokens 截断，未得到完整标题')
  if (kind === 'tool-calls') return new Error('模型意外请求了工具调用，标题生成中止')
  return new Error(`模型返回了未支持的结束原因：${String(kind)}`)
}
