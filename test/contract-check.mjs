/**
 * 契约检查：拿**真实的 DSH 包**验证本插件依赖的三条外部契约。
 *   运行：node test/contract-check.mjs
 *
 * 自测（selftest.mjs）用的是伪造环境，能证明我们自己的逻辑对；这个脚本回答的是
 * 另一个问题："我们手工拼出来的东西，官方真的认吗？" 它检查：
 *   ① 官方 normalizeSessionTitle 接受我们清洗后的标题（不会被判空）
 *   ② 官方 createUserMessage 产出的消息形状与 buildLlmRequest 的一致
 *   ③ 官方 BlockAssembler 对 text-delta/finish 分片的处理，与我们 applyChunk 的结果一致
 *
 * 找不到 DSH 安装目录时**跳过**（退出码 0）：这只是加固检查，不是安装前提。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { applyChunk, buildLlmRequest, normalizeTitle, pickRoute } from '../lib/retitle.js'

/**
 * 找 DSH 安装目录：`DSH_CHECKOUT` 覆盖 → 从当前 Node 安装前缀推断。
 * 不写死版本号目录（`/opt/node-v24.14.1/...` 这种路径换台机器就不对了）。
 */
function detectDshDir() {
  if (process.env.DSH_CHECKOUT) return process.env.DSH_CHECKOUT
  const prefix = path.resolve(path.dirname(process.execPath), '..')
  for (const rel of ['lib/node_modules', 'lib64/node_modules']) {
    const candidate = path.join(prefix, rel, '@deepseek-ai', 'dsh')
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
}

const DSH_DIR = detectDshDir()
const DSH_PACKAGES = path.join(DSH_DIR, 'node_modules', '@deepseek-ai')

async function loadDshPackage(name) {
  const file = path.join(DSH_PACKAGES, name, 'lib', 'index.js')
  return import(pathToFileURL(file).href)
}

let pass = 0
const ok = (label) => { pass += 1; console.log(`  ✅ ${label}`) }

let sessionTitle
let llm
try {
  sessionTitle = await loadDshPackage('dsh-session-title')
  llm = await loadDshPackage('dsh-llm')
} catch (err) {
  console.log(`\n跳过契约检查：读不到 DSH 包（${err?.message ?? err}）`)
  console.log(`可用 DSH_CHECKOUT=<dsh 安装目录> 指定路径。\n`)
  process.exit(0)
}

console.log('\n契约检查（对真实 DSH 包）')

// ① 官方标题归一化接受我们的输出
{
  const samples = ['会话改名插件', 'DSH 插件：手动重命名', normalizeTitle('标题：**会话改名插件**。')]
  for (const sample of samples) {
    const accepted = sessionTitle.normalizeSessionTitle(sample, 80)
    assert.ok(accepted.length > 0, `官方判空：${sample}`)
    assert.ok(Buffer.byteLength(accepted, 'utf8') <= 80)
  }
  const rejected = sessionTitle.normalizeSessionTitle(normalizeTitle('   \u0000 '), 80)
  assert.equal(rejected.length, 0, '纯控制字符应被判空（我们正是靠这个提前拦掉）')
  ok('官方 normalizeSessionTitle 接受我们的标题、拒绝空标题')
}

// ② 消息形状一致
{
  const ours = buildLlmRequest({
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    items: [{ seq: 1, role: 'human', text: '你好' }],
    system: 'sys',
    sessionId: 'session-contract',
    config: { maxOutputTokens: 64 },
  }).messages[0]

  const theirs = llm.createUserMessage({
    content: ours.content,
    source: ours.source,
  })

  assert.deepEqual(Object.keys(ours).sort(), Object.keys(theirs).sort(), '字段集合应与官方 createUserMessage 一致')
  assert.equal(ours.role, theirs.role)
  assert.deepEqual(ours.source, theirs.source)
  assert.deepEqual(ours.content, theirs.content)
  assert.equal(typeof ours.id, 'string')
  assert.equal(typeof theirs.id, 'string', '官方消息带 id；我们手工补的也是字符串 id')
  ok('buildLlmRequest 的消息形状与官方 createUserMessage 一致')
}

// ③ 分片处理一致
{
  const chunks = [
    { type: 'text-delta', index: 0, text: '会话' },
    { type: 'text-delta', index: 0, text: '改名' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const assembler = new llm.BlockAssembler()
  const ours = { text: '', finish: null }
  for (const chunk of chunks) {
    assembler.push(chunk)
    applyChunk(ours, chunk)
  }
  const theirText = assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('')
  assert.equal(ours.text, theirText, '我们的拼接结果应与官方汇编器一致')
  assert.equal(assembler.finish.kind, 'stop')
  assert.equal(ours.finish.kind, 'stop')
  ok('applyChunk 与官方 BlockAssembler 对同一分片流的结果一致')
}

// ④ 挂载声明里的兜底 provider/model 与代码默认值不漂移
{
  const fs = await import('node:fs')
  const yaml = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const pick = (key) => {
    const match = new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm').exec(yaml)
    return match ? match[1] : ''
  }
  const route = pickRoute({ config: { provider: pick('provider'), model: pick('model') } })
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-flash' }, 'cordis.patch.yml 里的兜底路由')
  assert.equal(pick('routePrefix'), '/dsh-session-retitle')
  ok('cordis.patch.yml 的兜底路由/前缀与代码默认值一致')
}

console.log(`\n契约检查通过：${pass} 项\n`)
