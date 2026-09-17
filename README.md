# dsh-session-retitle

DSH（DeepSeek Harness）插件：**在会话头部加一个「重命名」按钮，手动触发时读取本会话内容、用当前模型起一个中文短标题，并写回会话名。**

补的是官方自动命名的空档：官方 `session-title-first-prompt-llm` 只在第一条消息时自动命名一次，之后聊偏了也不会改；本插件让你在**任何时刻**按一次按钮，用**整个会话的实际内容**重新起名，并且一旦手动改过，官方的自动命名不会再覆盖（`session/title` 的 `source.kind = user` 会被钉住）。

- 手动：只有你点按钮才会跑。不轮询、不后台常驻、不自动改你的会话名。
- 一次调用：读会话 → 调一次模型 → 写一条 `session/title`。
- 两条路：留空输入框 = 按内容自动起名；填了名字 = 直接用你给的名字（不花模型调用）。
- 跟随主题：界面颜色全部走 DSH 自己的 CSS 变量（`--dsw-alias-*`），明暗主题切换自动生效。
- 零运行时依赖：不 import 任何 `@deepseek-ai/*` 包，只发两条自己的 HTTP 路由。

## 安装

```bash
# 1) 备份 profile 三件套（回滚靠它）
P=<profile 目录>          # 例如 $DSH_HOME/profiles/web
S=$(date +%Y%m%d-%H%M%S)
cp -p $P/package.json        $P/package.json.bak-$S-prepluginupdate
cp -p $P/pnpm-lock.yaml      $P/pnpm-lock.yaml.bak-$S-prepluginupdate
cp -p $P/pnpm-workspace.yaml $P/pnpm-workspace.yaml.bak-$S-prepluginupdate

# 2) 安装。link: 指向源码目录：改代码只需重启，不用重装
dsh plugin --profile web add link:/path/to/dsh-session-retitle
#    也可以直接从 GitHub 装：dsh plugin --profile web add github:BPTumbleweed/dsh-session-retitle

# 3) 重启 dsh-web（host 与客户端插件都要重启才生效）
#    自己就跑在这个服务里的话，重启要交给脱离会话 cgroup 的瞬时单元执行
sudo systemd-run --on-active=40 --unit=dsh-retitle-restart-$(date +%Y%m%d-%H%M%S) --collect \
  /bin/bash /path/to/restart-and-selfcheck.sh
```

`dsh plugin` 需要 `pnpm` 在 `PATH` 上。重启会让 GUI 中断 35–45 秒，之后需要 **Ctrl+Shift+R 硬刷新**才会加载到新的客户端按钮。

## 验证

```bash
curl -s http://127.0.0.1:<端口>/dsh-session-retitle/status | head -40   # 期望 caps 全是 ok
```

（带认证的部署需要先拿到浏览器 cookie；未认证时该路由返回 401，属预期。）

界面上：打开任意会话 → 头部右侧出现「重命名」按钮 → 点开 → 直接点「自动起名」，几秒后顶部会话名变成模型起的标题；侧边栏列表同步更新。

失败时按钮旁会显示原因（例如"这个会话里还没有可用来起名的内容"）。

## 配置（profile 的 `cordis.patch.yml` 覆盖）

| 键 | 默认 | 说明 |
|---|---|---|
| `routePrefix` | `/dsh-session-retitle` | 路由前缀，与客户端常量 `window.__DSH_SESSION_RETITLE_PREFIX__` 对应 |
| `maxTitleBytes` | `80` | 标题字节预算（与官方 `session-title.maxTitleBytes` 对齐） |
| `maxDigestBytes` | `8000` | 送给模型的会话素材上限，超了从头丢（保留最近的对话） |
| `maxDigestItems` | `16` | 最多取多少条消息（人类消息 + 助手回复） |
| `timeoutMs` | `45000` | 标题模型调用超时 |
| `maxOutputTokens` | `512` | 标题模型的最大输出 token（请求带 `purpose=session-title`，deepseek 适配器会据此关思考） |
| `provider` / `model` | `deepseek-official` / `deepseek-flash` | 兜底路由：会话读不到 `request/header` 时才用 |

路由选择顺序：**会话自己的 `request/header` → 官方 `agent-default-model` 当前选择 → 插件配置兜底**；三者都拿不到就明确报错，不编造标题。

## 停用与回滚

```bash
# 临时停用：给 cordis.patch.yml 里的 dsh-session-retitle 条目加 disabled: true，然后重启
# 彻底移除：
dsh plugin --profile web remove dsh-session-retitle
# 三件套回滚：把 package.json / pnpm-lock.yaml / pnpm-workspace.yaml 还原成 .bak-<stamp>-prepluginupdate，再 pnpm install + 重启
```

插件不改任何已有文件、不写任何数据目录，移除后不会留下垃圾。

## 自测

```bash
node test/selftest.mjs         # 35 项：纯函数 + 假 ctx 路由分支 + 客户端插槽注册 + 主题跟随
node test/contract-check.mjs   # 4 项：拿真实 DSH 包验证消息形状/分片处理/官方标题归一化
```

`contract-check.mjs` 会去读本机安装的 DSH 包（用 `DSH_CHECKOUT=<dsh 安装目录>` 指定，或从当前 Node 安装前缀自动推断）；读不到就跳过（退出码 0）。

## 踩过的坑（2026-09-16）

**症状**：点「重命名」按钮，4 次里有 3～4 次报"模型输出被 maxTokens 截断，未得到完整标题"。

**根因**：本插件最初把请求的 `purpose` 写成自定义值 `session-retitle`，而 `dsh-llm-deepseek` 只在
`purpose === "session-title"` 时关闭思考（`thinking: disabled`）。适配器不认自定义 purpose → 思考照开，
本机默认 `reasoningEffort: high` → 给的 64 个输出 token 全被 reasoning 吃掉，正文一个字都没写就被判
`max-tokens`（官方标题 provider 敢用 64 token，正是因为它的 purpose 会被适配器关掉思考）。

**修复**（三处，已加回归用例）：
1. `purpose` 改为官方槽位 `session-title`；
2. `maxOutputTokens` 默认 64 → 512，给其他适配器/长标题留余量；
3. 宽容收尾：只要已经拿到可用的标题文本就采用（附带一条 `warnings`），只有"一个字都没有"时才
   把结束原因当失败报出来 —— 截断不该丢掉已经拿到的好标题。

**同一天发现的第二个坑**：有的会话日志里记着 `deepseek-vision` 这个 provider，而当前部署没有它的
adapter，按"选中一个路由就死磕"的写法必然失败。改为**候选路由依次尝试**：会话路由 → 官方默认模型 →
插件兜底，前一个不可用就换下一个，并在 `warnings` 里说明发生了回退。同时加了**同会话并发保护**
（连点按钮第二次返回 429）和 **`/status` 错误台账**（`byCode` 计数 + 最近 5 条 `recentErrors`）。

**第三个坑：暗色主题下白底白字**。按钮/气泡的颜色最初写成 `var(--dsh-bg-elevated, …)` ——
DSH 里**根本没有** `--dsh-*` 这族变量（它用的是 `--dsw-alias-*`，定义在 `dsh-client-ui-theme` 的
`:root{}` 与 `[data-ds-dark-theme]{}` 两组里，同名两套值），于是 `#fff` 兜底生效、面板在暗色下惨白。
改为三层保险：

1. **主**：颜色全走 `--dsw-alias-*`（`label-primary/secondary/tertiary`、`border-l1/l2`、`bg-layer-2`、
   `specific-menu`、`interactive-bg-hover`、`elevation-*`）—— 值随主题切换，浏览器自动重绘，零 JS；
2. **备**：运行时探测这些变量是否存在；不存在（DSH 以后改名）就用 `detectTheme()` 读到的明暗落自带色板；
3. **兜底**：CSS 系统色 `Canvas` / `CanvasText`，至少不会白底白字。

顺带把悬停/聚焦态从内联样式搬进注入的 `<style>`（内联写不了 `:hover`），并给气泡设 `color-scheme`，
让输入框的原生控件（光标、选区）也跟着主题走。

## 实现（为什么这么写）

```
lib/retitle.js   纯逻辑：会话事件 → 素材 → 模型请求 → 标题清洗（零依赖，可单测）
lib/index.js     host：两条 HTTP 路由（/rename、/status），探测 sessions/llm/sessionTitle
lib/client.js    客户端：会话头部动作区一个按钮 + 一个小气泡
```

- **不自己写 `session/title`**：改名交给官方 `SessionTitleService.rename()`，归一化、长度上限、`user` 来源钉住，全由官方负责；官方以后改规则，本插件自动跟上。
- **能力逐个探测**：`webServer` / `connection` / `sessions` / `llm` / `sessionTitle` 缺任何一个，只让按钮报错（503 + 原因），不阻塞 DSH 启动。
- **信任栅栏**：所有路由先过 `connection.requestRejection(req)`，栅栏不可用时 **fail-closed**（403），改名接口不会对外裸奔。
- **客户端薄到极致**：只注册一个按钮；插件 UI API（插槽 + React 运行时）是最容易被 DSH 升级打断的一层，最坏情况是按钮消失，不影响会话本体。
- **不依赖 DSH 内部包**：插件以 `link:` 装在 workspace，Node 从插件真实路径解析不到 `@deepseek-ai/*`，硬依赖会直接炸掉实例。消息对象按官方 `createUserMessage()` 的形状手工构造（`{id, role, content[], source:{kind:'plugin',plugin}}`）。

## 已知边界

- 只有**当前在内存里活着**的会话能改名（官方 `rename` 要求 `sessions.get(id) === session`）。历史归档会话点不到按钮，也就改不了。
- 素材只取人类消息与助手文本回复，工具结果/插件快照/斜杠命令都当噪音丢掉 —— 这是刻意的，避免把 `bash` 输出当成会话主题。
- 标题用会话主要语言（通常是中文），10 个汉字以内的提示词约束；模型不听话时由 `maxTitleBytes` 硬截断兜底。

## 授权

MIT © 2026 Kan Zheng &lt;202309068@uibe.edu.cn&gt;
