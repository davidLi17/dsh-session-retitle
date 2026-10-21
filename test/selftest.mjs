/**
 * dsh-session-retitle 自测：不依赖正在运行的 DSH。
 *   运行：node test/selftest.mjs
 *
 * 覆盖三层：
 *   ① 纯函数（素材抽取 / 标题清洗 / 路由选择 / chunk 收集）
 *   ② host 路由（假 ctx + 假服务，把 /rename 的每条分支都跑一遍）
 *   ③ 客户端注册（假 window.__ModuleLoader__ + 假 react，验证按钮挂到了正确的插槽）
 */
import assert from 'node:assert/strict'

import mod, { createStatus, retitleOnce, RetitleError } from '../lib/index.js'
import {
  applyChunk,
  collectDigest,
  extractText,
  finishError,
  normalizeConfig,
  normalizeTitle,
  pickRoute,
  truncateUtf8,
} from '../lib/retitle.js'

let pass = 0
const ok = (label) => { pass += 1; console.log(`  ✅ ${label}`) }

// ---------------------------------------------------------------- 假环境

const humanMsg = (seq, text) => ({
  type: 'user/message',
  seq,
  time: Date.now(),
  data: { id: `m${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const pluginMsg = (seq, text) => ({
  type: 'user/message',
  seq,
  data: { id: `p${seq}`, source: { kind: 'plugin' }, content: [{ type: 'text', text }] },
})
const assistantMsg = (seq, text) => ({
  type: 'assistant/message',
  seq,
  data: { message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text }] } },
})
const toolResult = (seq) => ({
  type: 'tool/result',
  seq,
  data: { message: { id: `t${seq}`, role: 'tool', content: [{ type: 'text', text: 'bash 输出一大坨' }] } },
})

function makeSession(id, events, route = { provider: 'deepseek-official', model: 'deepseek-flash' }) {
  return {
    id,
    snapshotEvents: () => events,
    requestHeader: () => ({ config: route }),
  }
}

/** 造一个能装下 attachRoutes 的最小 ctx。 */
function makeCtx({ services = {}, fenced = false } = {}) {
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const connection = { requestRejection: () => (fenced ? 403 : false) }
  let injectCb = null
  const scoped = { get: (name) => (name === 'webServer' ? webServer : name === 'connection' ? connection : services[name]) }
  const ctx = {
    get: (name) => (name === 'webServer' ? webServer : name === 'connection' ? connection : services[name]),
    inject: (deps, cb) => { injectCb = cb },
    set: () => {},
  }
  return { ctx, routes, runInject: () => injectCb && injectCb(scoped) }
}

function makeReq(body, method = 'POST') {
  const buf = Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8')
  return {
    method,
    async *[Symbol.asyncIterator]() { if (buf.length > 0) yield buf },
  }
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.writableEnded = true },
  }
}

/** 取一条已注册路由（按 path），找不到就炸 —— 说明注册本身挂了。 */
function routeOf(routes, path) {
  const route = routes.find((item) => item.path === path)
  assert.ok(route, `未注册路由 ${path}（已注册：${routes.map((r) => r.path).join(', ')}）`)
  return route
}

async function callRoute(routes, path, body, method = 'POST') {
  const res = makeRes()
  await routeOf(routes, path).handler(makeReq(body, method), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { res, json }
}

const stopFinish = { type: 'finish', reason: { kind: 'stop' } }
function makeLlm(text, { chunks = 1, throwAt = null, finish = stopFinish } = {}) {
  const captured = { calls: 0, options: null }
  return {
    captured,
    async *stream(options) {
      captured.calls += 1
      captured.options = options
      if (throwAt !== null) throw new Error(throwAt)
      const step = Math.ceil(text.length / chunks)
      for (let i = 0; i < text.length; i += step) {
        yield { type: 'text-delta', index: 0, text: text.slice(i, i + step) }
      }
      yield finish
    },
  }
}

function makeServices({
  events = [humanMsg(1, '帮我写一个 DSH 插件，按会话内容改会话名')],
  text = '会话改名插件',
  fenced = false,
  sessionRoute = { provider: 'deepseek-official', model: 'deepseek-flash' },
  ...rest
} = {}) {
  const session = makeSession('session-demo', events, sessionRoute)
  const llm = makeLlm(text)
  const renamed = []
  const sessionTitle = {
    rename: (target, title) => { renamed.push({ id: target.id, title }); return { title, source: { kind: 'user' } } },
  }
  const services = {
    sessions: { get: (id) => (id === 'session-demo' ? session : undefined) },
    sessionTitle,
    llm,
    ...rest,
  }
  return { services, session, llm, renamed, sessionTitle }
}

/** 插件兜底路由配置（对应 cordis.patch.yml 里的 provider/model）。 */
const FALLBACK_CONFIG = { provider: 'deepseek-official', model: 'deepseek-flash' }

/** 一个"某些 provider 没有 adapter"的假模型服务，用于验证路由回退。 */
function makeFlakyLlm({ badProviders = [], text = '回退后的标题' } = {}) {
  const captured = { calls: 0, options: [] }
  return {
    captured,
    async *stream(options) {
      captured.calls += 1
      captured.options.push(options)
      if (badProviders.includes(options.provider)) {
        throw new Error(`no adapter registered for provider "${options.provider}"`)
      }
      yield { type: 'text-delta', index: 0, text }
      yield stopFinish
    },
  }
}

// ---------------------------------------------------------------- ① 纯函数

console.log('1) 配置与工具函数')
{
  const config = normalizeConfig({ maxDigestChars: 1234.7, provider: 'x', model: '', nope: 1 })
  assert.equal(config.maxDigestChars, 1234, '小数应向下取整')
  assert.equal(config.provider, undefined, '旧的兜底模型配置不再生效')
  assert.equal(config.model, undefined)
  assert.equal(config.routePrefix, '/dsh-session-retitle', '未给出的字段走默认值')
  assert.equal(normalizeConfig(null).timeoutMs, 45000, 'null 配置不应炸')
  ok('normalizeConfig：默认值 + 非法值忽略 + 忽略旧兜底路由')

  assert.equal(truncateUtf8('一二三', 6), '一二', '按字节截断不能切坏中文')
  assert.equal(truncateUtf8('abcdef', 4), 'abcd')
  assert.equal(truncateUtf8('', 10), '')
  ok('truncateUtf8：UTF-8 字节预算内截断')

  assert.equal(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(extractText({ content: 'nope' }), '', 'content 不是数组时返回空串')
  ok('extractText：只取文本块，忽略图片/文件')
}

console.log('2) 会话素材抽取')
{
  const config = normalizeConfig({})
  const digest = collectDigest([
    humanMsg(1, '第一条需求'),
    assistantMsg(2, '我准备这么做'),
    pluginMsg(3, '插件注入的快照，不算会话内容'),
    toolResult(4),
    humanMsg(5, '/compact'),
    assistantMsg(6, ''),
    humanMsg(7, '第二条需求：要求手动更新'),
  ], config)

  assert.deepEqual(digest.items.map((item) => item.role), ['human', 'assistant', 'human'], '只保留人与助手')
  assert.deepEqual(digest.items.map((item) => item.seq), [1, 2, 7], '按时间正序')
  assert.equal(digest.humanCount, 2)
  assert.equal(digest.assistantCount, 1)
  assert.ok(digest.skipped >= 3, `斜杠命令/插件快照/工具结果/空文本都应被跳过，实际 skipped=${digest.skipped}`)
  ok('collectDigest：只收人类消息与助手回复，噪音全挡掉')

  const many = []
  for (let i = 1; i <= 30; i += 1) many.push(humanMsg(i, `第 ${i} 条消息内容`))
  const capped = collectDigest(many, normalizeConfig({ maxDigestItems: 5 }))
  assert.equal(capped.items.length, 5, '应受 maxDigestItems 限制')
  assert.equal(capped.items.at(-1).seq, 30, '保留最近的对话')
  assert.equal(capped.truncated, true)
  ok('collectDigest：条数上限生效且保留最近内容')

  const long = collectDigest([humanMsg(1, '啊'.repeat(5000))], normalizeConfig({ maxDigestChars: 300 }))
  assert.equal(long.chars, 300)
  assert.equal(Array.from(long.items[0].text).length, 300)
  ok('collectDigest：总量字节预算生效')
}

{
  const events = Array.from({ length: 14 }, (_, i) => i % 2 ? assistantMsg(i, '回复' + i) : humanMsg(i, '消息' + i))
  const digest = collectDigest(events, normalizeConfig())
  assert.equal(digest.items.length, 10)
  assert.equal(digest.items[0].seq, 4)
  const unicode = collectDigest([humanMsg(1, '旧消息'), assistantMsg(2, '😀中'.repeat(6000))], normalizeConfig())
  assert.equal(unicode.chars, 10000)
  assert.equal(unicode.items.length, 1)
  assert.equal(Array.from(unicode.items[0].text).length, 10000)
  assert.ok(!unicode.items[0].text.includes('\uFFFD'))
  const boundary = collectDigest([humanMsg(1, '旧'.repeat(9000)), assistantMsg(2, '新'.repeat(2000))], normalizeConfig())
  assert.deepEqual(boundary.items.map(x => Array.from(x.text).length), [8000, 2000])
  assert.equal(boundary.humanCount, 1)
  assert.equal(boundary.assistantCount, 1)
  ok('10条消息与10000 Unicode字符预算、单条超长和边界截断')
}

console.log('3) 标题清洗与路由选择')
{
  assert.equal(normalizeTitle('标题：**会话改名插件**。'), '会话改名插件')
  assert.equal(normalizeTitle('  "DSH 插件开发"\n这里是解释'), 'DSH 插件开发', '只取第一行')
  assert.equal(normalizeTitle('Title: session retitle'), 'session retitle')
  assert.equal(normalizeTitle('\u202e暗标\u0000控制符'), '暗标控制符')
  assert.equal(normalizeTitle('   '), '', '空标题应返回空串')
  assert.equal(normalizeTitle('一二三四五六七八九十'.repeat(5)).length <= 40, true, '字符数兜底')
  assert.ok(Buffer.byteLength(normalizeTitle('汉字'.repeat(100)), 'utf8') <= 80, '字节预算兜底')
  ok('normalizeTitle：去前缀/引号/Markdown/控制字符 + 双重预算')

  const route = pickRoute({
    headerConfig: { provider: 'p1', model: 'm1' },
    defaultSelection: { provider: 'p2', model: 'm2' },
    config: { provider: 'p3', model: 'm3' },
  })
  assert.deepEqual(route, { provider: 'p1', model: 'm1' }, '会话自带路由优先')
  assert.deepEqual(
    pickRoute({ headerConfig: null, defaultSelection: { provider: 'p2', model: 'm2' }, config: { provider: 'p3', model: 'm3' } }),
    { provider: 'p2', model: 'm2' },
  )
  assert.deepEqual(pickRoute({ config: { provider: 'p3', model: 'm3' } }), { provider: 'p3', model: 'm3' })
  assert.equal(pickRoute({ headerConfig: { provider: 'p1' } }), null, '半个路由不算路由')
  assert.equal(pickRoute({}), null)
  ok('pickRoute：会话路由 → 默认模型 → 插件兜底，拿不到就返回 null')

  const state = { text: '', finish: null }
  applyChunk(state, { type: 'text-delta', text: '你' })
  applyChunk(state, { type: 'reasoning-delta', text: '思考中' })
  applyChunk(state, { type: 'text-delta', text: '好' })
  applyChunk(state, { type: 'finish', reason: { kind: 'stop' } })
  applyChunk(state, { type: '外星协议' })
  assert.equal(state.text, '你好', '只收 text-delta')
  assert.equal(finishError(state.finish), null, 'stop 是正常结束')
  assert.ok(finishError({ kind: 'error', failure: { message: '配额用完' } }) instanceof Error)
  assert.ok(finishError({ kind: 'max-tokens' }) instanceof Error)
  ok('applyChunk / finishError：分片拼接与结束原因翻译')
}

// ---------------------------------------------------------------- ② host 路由

console.log('4) host 路由：/rename 主流程')
{
  const { services, llm, renamed } = makeServices({ text: '会话改名插件' })
  const { ctx, routes, runInject } = makeCtx({ services })
  mod.apply(ctx, {})
  runInject()
  assert.equal(routes.length, 2, `应注册 2 条路由，实际 ${routes.length}`)

  const { res, json } = await callRoute(routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.title, '会话改名插件')
  assert.equal(json.source, 'llm')
  assert.equal(json.applied, true)
  assert.equal(llm.captured.calls, 1, '应正好调一次模型')
  assert.deepEqual(renamed, [{ id: 'session-demo', title: '会话改名插件' }], '应交给官方 sessionTitle.rename')

  const options = llm.captured.options
  assert.equal(options.provider, 'deepseek-official', '路由应取自会话 request/header')
  assert.equal(options.model, 'deepseek-flash')
  assert.equal(options.purpose, 'session-title', 'purpose 必须是官方槽位，适配器才会关闭思考（2026-09-16 max-tokens 事故的根因）')
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].role, 'user')
  assert.equal(options.messages[0].source.plugin, 'dsh-session-retitle', '消息来源须标明插件身份')
  assert.ok(options.system.includes('标题'), '系统提示应说明任务')
  assert.ok(Array.isArray(options.messages[0].content))
  assert.ok(options.signal, '应带取消信号')
  ok('/rename：读内容 → 调模型 → 官方 rename，返回规范化标题')

  // 手动指定名字：不调模型
  const manual = makeServices()
  const manualCtx = makeCtx({ services: manual.services })
  mod.apply(manualCtx.ctx, {})
  manualCtx.runInject()
  const manualResult = await callRoute(manualCtx.routes, '/dsh-session-retitle/rename', {
    sessionId: 'session-demo',
    title: '我自己起的名字',
  })
  assert.equal(manualResult.json.title, '我自己起的名字')
  assert.equal(manualResult.json.source, 'user')
  assert.equal(manual.llm.captured.calls, 0, '手动改名不应调用模型')
  ok('/rename：带上 title 时直接落盘，不花模型调用')

  // dryRun：只建议不改名
  const dry = makeServices({ text: '只建议不改' })
  const dryCtx = makeCtx({ services: dry.services })
  mod.apply(dryCtx.ctx, {})
  dryCtx.runInject()
  const dryResult = await callRoute(dryCtx.routes, '/dsh-session-retitle/rename', {
    sessionId: 'session-demo',
    dryRun: true,
  })
  assert.equal(dryResult.json.title, '只建议不改')
  assert.equal(dryResult.json.applied, false)
  assert.equal(dry.renamed.length, 0, 'dryRun 不应改名')
  ok('/rename：dryRun 只返回建议标题')

  // 回归：输出被 max-tokens 截断，但截断前已经拿到了标题文本 → 必须采用，不能报错
  const trunc = makeServices()
  trunc.services.llm = makeLlm('会话改名插件', { finish: { type: 'finish', reason: { kind: 'max-tokens' } } })
  const truncCtx = makeCtx({ services: trunc.services })
  mod.apply(truncCtx.ctx, {})
  truncCtx.runInject()
  const truncResult = await callRoute(truncCtx.routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
  assert.equal(truncResult.res.statusCode, 200, '有标题文本时不应因 max-tokens 失败')
  assert.equal(truncResult.json.title, '会话改名插件')
  assert.equal(truncResult.json.warnings.length, 1, '应留下一条非致命警告')
  assert.deepEqual(trunc.renamed, [{ id: 'session-demo', title: '会话改名插件' }])
  ok('输出被 max-tokens 截断但已有标题 → 采用 + 警告（2026-09-16 事故回归用例）')

  // 回归：会话自带路由没有 adapter（实测遇到 deepseek-vision）→ 回退到兜底路由
  const fb = makeServices({ sessionRoute: { provider: 'deepseek-vision', model: 'deepseek-vision' } })
  fb.services.llm = makeFlakyLlm({ badProviders: ['deepseek-vision'], text: '回退后的标题' })
  const fbCtx = makeCtx({ services: fb.services })
  mod.apply(fbCtx.ctx, FALLBACK_CONFIG)
  fbCtx.runInject()
  const fbResult = await callRoute(fbCtx.routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
  assert.equal(fbResult.res.statusCode, 502)
  assert.equal(fb.services.llm.captured.calls, 1, '不能静默切换模型')
  assert.equal(fb.renamed.length, 0, '失败保留旧标题')
  ok('目标会话模型失败不降级、不改名')

  // 两个候选都不可用 → 如实报错，不改名
  const dead = makeServices({ sessionRoute: { provider: 'deepseek-vision', model: 'deepseek-vision' } })
  dead.services.llm = makeFlakyLlm({ badProviders: ['deepseek-vision', 'deepseek-official'] })
  const deadCtx = makeCtx({ services: dead.services })
  mod.apply(deadCtx.ctx, FALLBACK_CONFIG)
  deadCtx.runInject()
  const deadResult = await callRoute(deadCtx.routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
  assert.equal(deadResult.res.statusCode, 502)
  assert.equal(deadResult.json.error.code, 'llm-failed')
  assert.equal(dead.services.llm.captured.calls, 1, '只调用目标会话模型')
  assert.equal(dead.renamed.length, 0)
  ok('所有候选路由都不可用 → 502，且不改名')
}

console.log('5) host 路由：失败分支')
{
  const cases = [
    { label: '缺 sessionId → 400', body: {}, status: 400, code: 'bad-request' },
    { label: '会话不在内存 → 404', body: { sessionId: 'session-other' }, status: 404, code: 'session-not-live' },
  ]
  for (const item of cases) {
    const { services } = makeServices()
    const { ctx, routes, runInject } = makeCtx({ services })
    mod.apply(ctx, {})
    runInject()
    const { res, json } = await callRoute(routes, '/dsh-session-retitle/rename', item.body)
    assert.equal(res.statusCode, item.status, item.label)
    assert.equal(json.ok, false)
    assert.equal(json.error.code, item.code, item.label)
    ok(item.label)
  }

  // 没有可用内容
  {
    const { services } = makeServices({ events: [] })
    const { ctx, routes, runInject } = makeCtx({ services })
    mod.apply(ctx, {})
    runInject()
    const { res, json } = await callRoute(routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
    assert.equal(res.statusCode, 409)
    assert.equal(json.error.code, 'no-content')
    ok('会话没有可命名内容 → 409 no-content')
  }

  // 模型报错
  {
    const { services, renamed } = makeServices()
    services.llm = makeLlm('', { throwAt: '模型网关 502' })
    const { ctx, routes, runInject } = makeCtx({ services })
    mod.apply(ctx, {})
    runInject()
    const { res, json } = await callRoute(routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
    assert.equal(res.statusCode, 502)
    assert.equal(json.error.code, 'llm-failed')
    assert.equal(renamed.length, 0, '模型失败时不能改名')
    ok('模型调用失败 → 502，且不改名')
  }

  // 输出了文字但最终报错，不得拿半截标题覆写。
  {
    const { services, renamed } = makeServices()
    services.llm = makeLlm('不应写入', { finish: { type: 'finish', reason: { kind: 'error', failure: { message: 'failed' } } } })
    await assert.rejects(() => retitleOnce({ services, sessionId: 'session-demo', config: normalizeConfig() }))
    assert.equal(renamed.length, 0)
    ok('模型带文本错误终止也保留旧标题')
  }

  // 模型返回空文本
  {
    const { services } = makeServices()
    services.llm = makeLlm('   ')
    const { ctx, routes, runInject } = makeCtx({ services })
    mod.apply(ctx, {})
    runInject()
    const { res, json } = await callRoute(routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
    assert.equal(res.statusCode, 502)
    assert.equal(json.error.code, 'empty-title')
    ok('模型输出为空 → 502 empty-title')
  }

  // 一个字都没有 + 被 max-tokens 截断（就是 2026-09-16 线上那次）：必须报出截断原因
  {
    const { services, renamed } = makeServices()
    services.llm = makeLlm('', { finish: { type: 'finish', reason: { kind: 'max-tokens' } } })
    const { ctx, routes, runInject } = makeCtx({ services })
    mod.apply(ctx, {})
    runInject()
    const { res, json } = await callRoute(routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
    assert.equal(res.statusCode, 502)
    assert.equal(json.error.code, 'llm-failed')
    assert.match(json.error.message, /maxTokens/, '错误信息要点明 maxTokens 截断')
    assert.equal(renamed.length, 0)
    ok('无任何输出且被 max-tokens 截断 → 502，错误信息点明原因')
  }

  // 服务缺失
  {
    const { ctx, routes, runInject } = makeCtx({ services: { sessions: { get: () => undefined } } })
    mod.apply(ctx, {})
    runInject()
    const { res, json } = await callRoute(routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
    assert.equal(res.statusCode, 503)
    assert.equal(json.error.code, 'title-service-unavailable')
    ok('本部署没挂 session-title 服务 → 503，按钮只报错')
  }

  // 信任栅栏
  {
    const { services } = makeServices()
    const { ctx, routes, runInject } = makeCtx({ services, fenced: true })
    mod.apply(ctx, {})
    runInject()
    const { res } = await callRoute(routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
    assert.equal(res.statusCode, 403, '栅栏拒绝时必须 403')
    ok('信任栅栏拒绝 → 403（fail-closed，不裸奔）')
  }

  // 方法错误 / 请求体过大 / 坏 JSON
  {
    const { services } = makeServices()
    const { ctx, routes, runInject } = makeCtx({ services })
    mod.apply(ctx, {})
    runInject()
    const getResult = await callRoute(routes, '/dsh-session-retitle/rename', undefined, 'GET')
    assert.equal(getResult.res.statusCode, 405)
    ok('GET /rename → 405')

    const res2 = makeRes()
    await routeOf(routes, '/dsh-session-retitle/rename').handler(makeReq({ sessionId: 'x'.repeat(20000) }), res2)
    assert.equal(res2.statusCode, 413, '超大请求体应被拒')
    ok('超大请求体 → 413')

    const badRes = makeRes()
    await routeOf(routes, '/dsh-session-retitle/rename').handler(makeReq(undefined), badRes)
    assert.equal(badRes.statusCode, 400)
    ok('空请求体 → 400 bad-request')
  }

  // 并发保护：同一会话请求还没结束就再点一次 → 429，不并发烧模型、不互相覆盖标题
  {
    let unblock
    const gate = new Promise((resolve) => { unblock = resolve })
    const s = makeServices()
    s.services.llm = {
      async *stream() {
        await gate
        yield { type: 'text-delta', index: 0, text: '慢标题' }
        yield stopFinish
      },
    }
    const { ctx, routes, runInject } = makeCtx({ services: s.services })
    mod.apply(ctx, {})
    runInject()
    const first = callRoute(routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await callRoute(routes, '/dsh-session-retitle/rename', { sessionId: 'session-demo' })
    assert.equal(second.res.statusCode, 429, '并发请求应被挡住')
    assert.equal(second.json.error.code, 'already-running')
    unblock()
    const firstResult = await first
    assert.equal(firstResult.res.statusCode, 200, '第一个请求应正常完成')
    assert.equal(firstResult.json.title, '慢标题')
    ok('同一会话并发请求 → 第二次 429')
  }
}

console.log('6) host 路由：状态接口')
{
  const { services } = makeServices()
  const { ctx, routes, runInject } = makeCtx({ services })
  mod.apply(ctx, {})
  runInject()
  await callRoute(routes, '/dsh-session-retitle/rename', { sessionId: 'session-missing' })
  const { res, json } = await callRoute(routes, '/dsh-session-retitle/status', undefined, 'GET')
  assert.equal(res.statusCode, 200)
  assert.equal(json.plugin.name, 'dsh-session-retitle')
  assert.equal(json.runtime.caps.sessions, 'ok')
  assert.equal(json.runtime.caps.sessionTitle, 'ok')
  assert.equal(json.runtime.caps.llm, 'ok')
  assert.equal(json.config.routePrefix, '/dsh-session-retitle')
  assert.ok(json.runtime.byCode['session-not-live'] >= 1, '错误台账应记下错误码计数')
  assert.ok(json.runtime.recentErrors.length >= 1, '应保留最近错误原文')
  assert.equal(json.runtime.recentErrors[0].code, 'session-not-live')
  ok('/status：能力探测 + 生效配置 + 错误台账（byCode / recentErrors）')
}

console.log('7) retitleOnce 直接调用（不经 HTTP）')
{
  const { services } = makeServices()
  const status = createStatus()
  const result = await retitleOnce({ services, sessionId: 'session-demo', config: normalizeConfig({}), status })
  assert.equal(result.title, '会话改名插件')
  assert.equal(status.ok, 1)
  assert.ok(status.last.sessionId === 'session-demo')
  await assert.rejects(
    () => retitleOnce({ services, sessionId: 'nope', config: normalizeConfig({}), status }),
    (err) => err instanceof RetitleError && err.code === 'session-not-live',
  )
  ok('retitleOnce：可独立调用，状态计数正确')
}

// ---------------------------------------------------------------- ③ 客户端

console.log('8) 客户端插件：注册到会话头部动作区')
{
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  await import('../lib/client.js')
  assert.ok(loaded, '客户端脚本应调用 window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-session-retitle')

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  const clientModule = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`客户端不允许依赖 ${name}`)
  })
  assert.equal(typeof clientModule.apply, 'function')
  assert.deepEqual(clientModule.inject, ['slots'])

  const registrations = []
  const ctx = {
    slots: {
      inject: (target, cb) => { registrations.push({ target, cb }) },
      register: (definition, component) => { registrations.push({ definition, component }) },
    },
  }
  clientModule.apply(ctx)
  assert.equal(registrations[0].target, 'conversation.session.header.actions', '应挂在会话头部动作区')
  registrations[0].cb()
  const registration = registrations.find((item) => item.definition)
  assert.equal(registration.definition.name, 'conversation.session.header.actions')
  assert.equal(registration.definition.id, 'session-retitle')
  assert.equal(typeof registration.component, 'function', '组件应是一个函数')
  const menuSlot = registrations.find((item) => item.target === 'sidebar.workspaces.session.menu.item')
  assert.ok(menuSlot)
  menuSlot.cb()
  assert.ok(registrations.some((item) => item.definition?.name === 'sidebar.workspaces.session.menu.item'))
  assert.ok(registrations.some((item) => item.target === 'shell.overlay'))
  let releaseFetch
  let opened = false
  let released = false
  let requestedId
  globalThis.fetch = async (_url, options) => {
    assert.ok(opened, '等历史 ready 后才请求')
    requestedId = JSON.parse(options.body).sessionId
    await new Promise((resolve) => { releaseFetch = resolve })
    return { ok: true, json: async () => ({ ok: true, title: '测试标题' }) }
  }
  const quick = clientModule.__test.createQuickRename({ sessions: {
    using: async (id, options, operation) => {
      assert.equal(id, 'inactive-B')
      assert.equal(options.source, 'workspaceOperation')
      opened = true
      try { return await operation() } finally { released = true }
    },
  } })
  let closed = false
  let menuTarget
  const MenuAction = clientModule.__test.createMenuAction((id) => { menuTarget = id })
  const menu = MenuAction({ sessionId: 'inactive-B', useMenuOpenState: () => [true, () => { closed = true }] })
  menu.props.onClick()
  assert.equal(closed, true)
  assert.equal(menuTarget, 'inactive-B')
  const first = quick('inactive-B')
  await Promise.resolve()
  assert.equal(requestedId, 'inactive-B', '不读取 active session')
  assert.ok(clientModule.__test.pending.has('inactive-B'))
  await quick('inactive-B')
  assert.equal(released, false)
  releaseFetch()
  await first
  assert.equal(released, true)
  assert.equal(clientModule.__test.pending.size, 0)
  const failed = clientModule.__test.createQuickRename({ sessions: { using: async () => { throw new Error('open failed') } } })
  await failed('failed')
  assert.equal(clientModule.__test.pending.size, 0, '失败释放 busy')
  delete globalThis.fetch
  ok('客户端按钮注册在 conversation.session.header.actions')
}

console.log('9) 客户端主题跟随（2026-09-16 明暗不跟随的修复）')
{
  /** 造一个够用的假 document：能注入 <style>、能读主题标记与 CSS 变量。 */
  function makeFakeDocument({ dark = false, vars = true } = {}) {
    const byId = new Map()
    const makeEl = (tag) => ({
      tagName: tag,
      id: '',
      textContent: '',
      children: [],
      appendChild(child) { this.children.push(child); if (child.id) byId.set(child.id, child) },
      getAttribute() { return null },
      setAttribute() {},
      hasAttribute() { return false },
      classList: { contains: () => false },
    })
    const head = makeEl('head')
    const documentElement = makeEl('html')
    const body = {
      hasAttribute: (name) => (dark && name === 'data-ds-dark-theme'),
      getAttribute: () => null,
      classList: { contains: () => false },
    }
    return {
      head,
      body,
      documentElement,
      createElement: makeEl,
      getElementById: (id) => byId.get(id) || null,
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (name) => (vars && name === '--dsw-alias-label-primary' ? ' #f9fafb' : ''),
          backgroundColor: dark ? 'rgb(20,20,20)' : 'rgb(255,255,255)',
        }),
        matchMedia: () => ({ matches: dark, addEventListener() {}, removeEventListener() {} }),
      },
    }
  }

  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  globalThis.document = makeFakeDocument({ dark: false })
  await import(`../lib/client.js?theme=${Date.now()}`)
  const mod = loaded.factory((name) => {
    if (name === 'react') return { createElement: () => ({}), useState: () => [undefined, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) }
    throw new Error(`客户端不允许依赖 ${name}`)
  })
  const t = mod.__test

  // ① 样式表必须用 DSH 真实的变量族，且不能再出现旧的自造变量
  for (const name of ['--dsw-alias-label-primary', '--dsw-alias-border-l2', '--dsw-specific-menu', '--dsw-alias-interactive-bg-hover']) {
    assert.ok(t.SHEET.includes(name), `样式表应使用 DSH 变量 ${name}`)
  }
  assert.ok(!t.SHEET.includes('--dsh-bg-elevated'), '不应再出现不存在的 --dsh-bg-elevated')
  assert.ok(!/background:\s*#fff/i.test(t.SHEET), '面板背景不应写死白色')
  assert.ok(t.SHEET.includes('Canvas'), '最后兜底应是 CSS 系统色')
  assert.ok(t.SHEET.includes(':hover'), '悬停态交给 CSS（内联写不了 hover）')
  ok('样式表走 DSH 变量 + 系统色兜底，且已清掉自造的 --dsh-* 变量与写死白色')

  // ② 主题检测
  assert.equal(t.detectTheme(makeFakeDocument({ dark: true })), 'dark', 'DSH 的 data-ds-dark-theme 应被识别')
  assert.equal(t.detectTheme(makeFakeDocument({ dark: false })), 'light')
  assert.equal(t.detectTheme({ body: null, documentElement: null }), 'light', '拿不到 DOM 时保守返回 light')
  ok('detectTheme：识别 DSH 暗色标记，拿不到 DOM 时保守')

  // ③ 变量可用性探测
  assert.equal(t.dswVariablesAvailable(makeFakeDocument({ vars: true })), true)
  assert.equal(t.dswVariablesAvailable(makeFakeDocument({ vars: false })), false, '变量缺失时应能探测到（走自带色板）')
  ok('dswVariablesAvailable：区分"变量可用"与"需兜底色板"')

  // ④ 自带色板明暗分明（变量缺失时的第二层保险）
  const dark = t.paletteFor('dark')
  const light = t.paletteFor('light')
  assert.notEqual(dark.panel, light.panel)
  assert.notEqual(dark.text, light.text)
  assert.ok(t.fallbackStyles('dark').panel.color === dark.text, '暗色兜底应用暗色文字')
  assert.ok(t.fallbackStyles('light').panel.background === light.panel)
  ok('paletteFor / fallbackStyles：明暗两套色板分明')

  // ⑤ 样式注入幂等（apply 可能被多次调用）
  const doc = makeFakeDocument({})
  assert.equal(t.ensureStylesheet(doc), true)
  assert.equal(t.ensureStylesheet(doc), true)
  assert.equal(doc.head.children.length, 1, '同一个 id 只应注入一次')
  assert.equal(doc.getElementById(t.STYLE_ID).textContent, t.SHEET)
  ok('ensureStylesheet：按 id 幂等注入，不重复插 <style>')
}

console.log(`\n全部通过：${pass} 项\n`)
