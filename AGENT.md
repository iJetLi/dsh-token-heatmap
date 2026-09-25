# AGENT.md — dsh-token-heatmap

DSH（DeepSeek Harness）web 插件：新会话（hero）屏上的 GitHub 风格每日 token 用量热力图，可选年份视图、绿/蓝配色与显示开关（设置 → 插件 → 插件配置），含今日/本月/累计统计。

## 快速命令

- 校验：`npm run check`（`node --check` 全部 lib）
- 测试：`npm test`（`scripts/smoke.mjs` + `settings-smoke.mjs` + `rc1-session-smoke.mjs`）
- 发布：推送 tag `vX.Y.Z` → GitHub Actions（OIDC Trusted Publisher）自动 `npm publish`。**不要手动 npm publish**；版本号与 tag 必须同步 bump。

## 结构

- `lib/index.js` — 服务端 half（cordis plugin，`inject: ["webServer","sessions","sessionPersistence","settings"]`）
  - `apply()`：注册官方 `session/event` 监听器实时折叠每个 usage 事件进缓存（不依赖 hero 屏挂载，绕过 rc.1 枚举限制）；启动时一次性补折叠已存在 live 会话
  - `collectUsage()`：**主路径=渲染 session/event 实时折叠的缓存**（请求时再做一次 live 增量同步兜底）；**可选增强**：若存在第三方插件 `@linxin666/dsh-usage` 的台账 `<DSH_HOME>/dsh-usage/usage-ledger.json`（设置→使用统计 数据源，完整实时，`renderLedger()` 转换），则直接采用——该文件是第三方插件内部文件而非 DSH 契约，仅检查 `days` 形状（不校验 version），格式不符告警并回退；该文件仅在 @linxin666/dsh-usage 安装并启用时存在，其按 retainDays（默认 180、最大 730）修剪旧天数
  - 缓存：`<DSH_HOME>/storages/token-heatmap-cache.json`（原子写，单飞锁 `withLock`）；测试用临时 `DSH_HOME`
  - 路由：`GET /api/token-heatmap/usage`、`GET|POST /api/token-heatmap/config`（loopback-only）
  - settings：namespace **`"token-heatmap"` 字面量**（0.1.2 起 `dsh-settings` 不再导出 `settingsNamespace()`），同时是 profile patch 的 entry id。**两版注册方式不同**（见「兼容性」的跨版本兼容层）：0.1.5 走 `settings.register()`，0.1.7 走导出的 `Config`（volatile 字段）+ `settings.configure({auto:false}, ctx.fiber)`；读写统一用 `settings.describe()` / `settings.update()`
  - `Config` 导出：**仅供 0.1.7 投影配置表单**，volatile 标记写作 `extra("volatile", true)`（0.1.5 的 schemastery 3.18.2 无 `.volatile()`）；0.1.5 上 cordis 只会把它解析成 `ctx.config` 默认值，本插件不读 `ctx.config`
  - 迁移：`migrateLegacyConfig()` 一次性导入旧 `storages/token-heatmap-config.json`（**仅 0.1.5 分支调用**；0.1.7 由 DSH 自身的 `importLegacyDocument` 搬迁 `settings.yaml`）
- `lib/usage.js` — 纯函数：`applyUsageDelta`（replace-last-sample 语义）/ `createUsageState` / `foldUsage` / `renderUsage` / 按本地日聚合
- `lib/config.js` — 纯函数：`DEFAULT_CONFIG` / `parseConfig`（布尔 + 短字符串 shape 约束）
- `lib/client.js` — 浏览器 half：**手写 `window.__ModuleLoader__.load({id, factory})` bundle，无构建步骤**；React 组件（`require("react")` / `require("react/jsx-runtime")`）；CSS 走 `data-plugin-css` 通道
  - `conversation.input.dock`（list slot，id `token-heatmap`，order 10）——两版共用，hero 屏输入卡上方全宽条目
  - 配置卡 = `settings.plugins.tab`（list slot，id `token-heatmap`，order 40，`label` 走 `NS` 字典的 `settingsTabLabel`）——**两版交集插槽**（`ui-settings-plugins` 在 0.1.5/0.1.7 都声明它），一次注册同时服务两版。刻意**不用** `settings.plugin.item`（仅 0.1.5）或 `plugins.bundle.config`（仅 0.1.7，且要求官方 `ui-plugin-manager` 包已安装——从 0.1.5 时代装起的 profile 没有它，插槽不存在）
- `scripts/*.mjs` — 自包含 smoke（mock ctx / mock settings scope / 临时 DSH_HOME）；`compat-smoke.mjs` 驱动两版形态的 mock，用抛错哨兵证明每版只走一条分支

## 兼容性（重要，改代码前必读）

- 适配 **DSH 0.1.5-rc.3 与 0.1.7-rc.2**（两版并存兼容），`dsh.compatibility.dshReleases` 精确逐版本声明（DSH STORE 契约；范围声明无效）；`engines.dsh: ^0.1.2-rc.1` 与 9 项 lockstep peer 未改——`^0.1.2-rc.1` = `>=0.1.2-rc.1 <0.2.0` 已覆盖两个目标版本
- `dsh.client.inject` 必须是 **rc.1 模块图存在**的包（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`）
- `engines.dsh: ^0.1.2-rc.1`；`peerDependencies` 声明 lockstep `@deepseek-ai/dsh-*` 宿主包（dsh-market 据此显示"宿主要求"）
- **rc.1 破坏性变更备忘**：
  - live session 无 `.events` 数组 → `session.seq` + `session.eventAt(seq)`（0 基，官方 `dsh-token-meter` 读法）
  - **hero 判断：`session.blank`（布尔，true=新会话）**；旧版用 `composerPhase === "blank"`——client 里已双兼容（`heroBlank`），改时别丢掉
  - **`sessionPersistence` 在 rc.1 不再提供会话枚举**（`list`/`listSnapshots` 已移除）→ 0.1.6 起 `apply()` 注册官方 `session/event` 监听器实时折叠 live 会话 usage（不依赖 hero 屏挂载，彻底绕过该限制）；可选增强：若存在第三方 `@linxin666/dsh-usage` 台账 `dsh-usage/usage-ledger.json` 则直接采用（第三方插件内部文件，非 DSH 契约，仅检查 `days` 形状）；旧版（有 `list`）仍走完整持久化增量路径
  - **fork 会话会双计父会话 usage**（0.1.7 修复）：fork 子会话的 header `isSeeded=true`，其前 `inheritedEventCount` 个事件是从父会话复制的**父的** usage，父会话折叠时已计过。折叠必须从 fork 切点开始（只读官方 `session.header.isSeeded` + `session.inheritedEventCount`，两版逐行一致），否则同一批 token 被计两次（实测 09-14 由 8.34 亿虚增到 13.15 亿）。**注意 `isSeeded=false` 的 resume 会话不是 fork**——它的 constructor seed 是自己的历史，必须全折；只有 `isSeeded=true` 才跳过。`CACHE_VERSION` 为 2
- **跨版本兼容层（0.1.5 / 0.1.7 必读）**：`inject` 只能写两版交集——服务端 `["webServer","sessions","sessionPersistence","settings"]`、客户端 `["slots","locale","connection","remote"]`（**绝不能**写 `settingsScope`，它 0.1.7 已改名 `configForms`，写进去会让 fiber 永久 pending）。train 差异一律走 `apply()` 里的 `ctx.inject([...], cb)` 条件分支：cordis 对未 inject 的服务抛 `cannot get property ... without inject`，**不要**用 try/catch 吞它。服务端按 `typeof ctx.settings.register === "function"` 分流（0.1.5 注册 namespace；0.1.7 走 `Config` 导出 + `settings.configure({auto:false}, ctx.fiber)`），读写只用两版都有的 `describe()` / `update()`（`settings.get(ns)` 在 0.1.7 不存在）。**schemastery 3.18.2（0.1.5）没有 `.volatile()`**，volatile 标记必须写 `schema.extra("volatile", true)`。客户端配置卡统一注册到**两版交集插槽** `settings.plugins.tab`（list slot：id/order/label）——**不要**用 `settings.plugin.item`（仅 0.1.5）或 `plugins.bundle.config`（仅 0.1.7，且要求官方 `@deepseek-ai/dsh-client-ui-plugin-manager` 已安装；从 0.1.5 时代装起的 profile 缺这个包，插槽根本不存在，`ctx.slots.inject` 会永久 pending）
- **persisted 折叠只用 `list()`**：`listSnapshots()` 与 `readFrom()` 在**两个 tag 的 `SessionPersistence` 源码里都不存在**（只有 `create/open/flush/stat/list`），旧代码调用它们导致每次请求 warn 后被吞。现只收集 `persistedIds`，行为与清理前等价（`persistedIds.add` 本就先于 `readFrom` 执行），故 `CACHE_VERSION` 维持 2。`forkCutOfEvents()`（扫 `session/end-seed`）随之一并删除；fork 切点在 live 路径只读官方字段（见上一条）
- **DSH STORE 的 protectedDsh 信号**（客户端访问内置 UI/统计）是设计使然，README 已披露，保持现状

## 修改守则

- 服务端读 session 事件**必须走 `liveSessionEvents()`**（不要直接碰 `session.events`）
- 不要试图"恢复" persisted 会话的事件折叠——`SessionPersistence` 在两版都只有 `create/open/flush/stat/list`，**没有** `listSnapshots` / `readFrom`。只能枚举 id（`list()`）用于判断会话是否存在，读日志的路径不存在；降级保留缓存是有意为之
- **改动 `inject` 前先确认两版都有该服务**（见「兼容性」的跨版本兼容层）；train 专属服务一律放进 `apply()` 的 `ctx.inject([...], cb)` 分支
- client 保持手写 bundle 格式与 `data-plugin-css` 通道；组件是 React 组件（返回 JSX 元素，不要返回 DOM 节点）
- 新测试加入 `package.json` 的 `"test"` 链；改完必须 `npm run check && npm test` 全绿
- 提交用 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:`），原子提交；改动涉及运行时契约时同步 bump 版本 + README「兼容性」小节
- 本地仓库有 codegraph 索引（`.codegraph/`，已 gitignore），可先用 codegraph 探索再改
