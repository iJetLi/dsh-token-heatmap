# dsh-token-heatmap

DSH Web GUI 插件：在**新会话（hero）屏幕的输入框下方**显示一个 GitHub 风格的 token 用量热力图 —— **当前自然年（1月–12月）**每天的 token 用量，颜色深浅表示用量多少；同一行展示**今日 / 本月 / 累计** token 用量。

A DeepSeek Harness web plugin: a GitHub-style daily token-usage heatmap of the **current calendar year (Jan–Dec)** rendered **below the composer input card on the new-session screen only**, with today / this-month / all-time totals on the same line.

## 界面 / What you get

新会话屏幕输入框正下方出现一张统计卡（**只在新会话显示**；已对话的会话不显示）：

![热力图](docs/热力图.jpg)

- 📊 **自然年热力图**：GitHub 风格，覆盖所选自然年 1月–12月（可切换年份，`‹ 年份 ›` 选择器在统计行右侧，最多到当前年），列为周（周一起），行为星期（左侧标注一~日全部 7 天）；顶部月份标签按列跨度标注（左侧与格线对齐），今日之后的日期显示为空格。
- 🎨 **六套配色**：绿色（经典 GitHub 风格）、蓝色、橙色、红色、紫色、青色，可在 设置 → 插件 → 插件配置 切换；颜色按**绝对阈值**分档（按天 token 数，非相对排名）：0 / <1M / 1M–10M / 10M–100M / ≥100M 共 5 级，图例悬停显示各档范围；61M/天 显示为第 3 级。悬停任意格子显示日期与精确 token 数。
- 🔢 **统计行**（与标题同一行）：今日 / 本月 / 累计，悬停显示完整数值。
- 🔄 自动每 5 分钟刷新，窗口重新可见时也会刷新；行尾可手动刷新。
- ⚙️ **插件配置卡**（设置 → 插件 → **Token 热力图** 页签，两版同一入口）：
  - **显示热力图** 开关：关闭后新会话页面不再显示热力图卡片。
  - **配色方案**：绿色 / 蓝色 / 橙色 / 红色 / 紫色 / 青色，六个色板按钮即时预览。
  - 修改后需点"保存"（显示"未保存"徽标提示），"放弃修改"可丢弃草稿；配置按版本持久化——0.1.5 落 `<DSH_HOME>/settings.yaml` 的 `token-heatmap` 段，0.1.7 落 profile 的 `cordis.patch.yml` 中该条目（entry id 同为 `token-heatmap`）的 `config:` 字段（0.1.1 及更早版本存在 `<DSH_HOME>/storages/token-heatmap-config.json` 的旧配置会在启动时自动迁移）。

## 安装 / Install

需要 `web` profile 与 `pnpm`。DSH 兼容版本见下方「兼容性 / Compatibility」；运行于 `@deepseek-ai/dsh` **0.1.5-rc.3** 与 **0.1.7-rc.2**（两版并存兼容）。

从 npm 安装：

```powershell
dsh plugin --profile web add @kidli1412/dsh-token-heatmap
```

从 GitHub 安装：

```powershell
dsh plugin --profile web add github:KIDLi1412/dsh-token-heatmap
```

本地开发（手动，本地链接）：

```powershell
dsh plugin --profile web add "link:path/to/dsh-token-heatmap"
```

安装完成后**重启正在运行的 `dsh web`**，并在浏览器中硬刷新（Ctrl+Shift+R）。侧边栏无新增入口——统计卡直接出现在新会话输入框下方。卸载：

```powershell
dsh plugin --profile web remove @kidli1412/dsh-token-heatmap
```

## 工作原理 / How it works

- **服务端**（`lib/index.js` + `lib/usage.js` + `lib/config.js`）：作为 profile bundle 挂载，**实时折叠会话事件**（监听官方 `session/event`，每个 `assistant/chunk`/`assistant/message` 的 `usage` 事件即时写入缓存，不依赖 hero 屏挂载，绕过 rc.1 `sessionPersistence` 不再提供会话枚举的限制）；启动时一次性补折叠已存在的 live 会话（如 resumed 会话）；请求时 `collectUsage` 再做一次增量同步兜底。可选增强：若存在第三方插件 `@linxin666/dsh-usage` 的台账 `<DSH_HOME>/dsh-usage/usage-ledger.json`（设置 → 使用统计 的数据源，完整实时），则直接采用以恢复完整历史——该文件是第三方插件内部文件而非 DSH 契约，仅检查 `days` 形状（不校验 version），格式不符时告警并回退。该文件仅在 @linxin666/dsh-usage 安装并启用时存在；其按 retainDays（默认 180、最大 730）修剪旧天数，故以台账为源时 all-time 总量与旧日历年受该设置上限。同 `(turn, step)` 的重复样本按"替换"语义处理，归属后一天；按天、按模型聚合，缓存到 `<DSH_HOME>/storages/token-heatmap-cache.json`。通过回环受限端点 `GET /api/token-heatmap/usage` 提供；显示配置（开关 + 配色）按版本持有——0.1.5 由 `settings.register()` 的 `token-heatmap` namespace 落 `settings.yaml`，0.1.7 由插件的 `Config` 导出投影到 profile entry 的 `config:`（`cordis.patch.yml`），两版都经 `settings.describe()` 读、`settings.update()` 写；`GET/POST /api/token-heatmap/config` 作为回环兼容 API 读写同一份配置，0.1.1 及更早的 `token-heatmap-config.json` 文档在启动时一次性迁移。
- **客户端**（`lib/client.js`）：手写 `__ModuleLoader__` bundle，注册进会话 `conversation.input.dock` 列表插槽，仅当新会话 hero 屏（`session.blank`，旧版回退 `composerPhase === "blank"`）且配置开关开启时渲染。框架真正的"卡片下方"插槽 `conversation.composer.dock` 在 hero 屏被 `!hero` 门控禁用，因此本插件利用 `input.dock` 容器（flex 列）的 CSS `order` 把自己排到输入卡片**之后**。配置卡作为 **设置 → 插件** 分区下的独立页签（`settings.plugins.tab`）注册——该插槽由官方 `ui-settings-plugins` 在两版都声明，因此一个注册同时服务 0.1.5 与 0.1.7（0.1.5 专有的 `settings.plugin.item` 与 0.1.7 专有的 `plugins.bundle.config` 都不采用：后者还要求官方 `ui-plugin-manager` 已安装，从 0.1.5 时代装起的 profile 并不携带该包）。卡片经绑定到两版各自 settings 服务的 scope 读写配置。
- 语义与 `dsh-token-meter` 的 `tokenUsage` 投影一致（参考插件 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats)，MIT）。

## 说明 / Notes

- 仅回环地址可访问数据端点，凭据不外发；插件只读，不修改任何会话数据。
- 无会话/无工作区时（`input.dock` 需要会话上下文）统计卡不渲染。
- 服务端与客户端都随 `dsh web` 启动加载，因此新增/更新插件后需要重启。

## 兼容性 / Compatibility

- **DSH**：manifest 通过 `dsh.compatibility.dshReleases` 将 **`0.1.5-rc.3`** 与 **`0.1.7-rc.2`** 逐项声明为 `compatible`（DSH STORE 的精确逐版本兼容证据；仅范围声明不会恢复上架）。两版并存靠**能力分流**实现：`inject` 只声明两版交集的服务，`settingsScope`（0.1.5）与 `configForms`（0.1.7）经 `ctx.inject` 条件分支各走一路；配置 schema 由 `Config` 导出提供（0.1.7 投影成表单，0.1.5 上无害）。
- **Node**：`^22.19.0 || >=24.0.0`（与 DSH 一致）。
- **宿主要求（dsh-market 显示）**：`engines.dsh: ^0.1.2-rc.1`，并将运行时依赖的 lockstep 宿主包声明为 `peerDependencies`（`dsh-host-webserver` / `dsh-session` / `dsh-session-persistence` / `dsh-settings` 与客户端模块 `dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`，均为 `^0.1.2-rc.1`）；插件市场会据此显示"宿主要求"并判断与当前 DSH 是否匹配。
- **依赖**：`@deepseek-ai/dsh-settings` 自 0.1.3 起提升为 `^0.1.2-rc.1`、`@deepseek-ai/schemastery` 提升为 `^3.18.2`，与 DSH 0.1.2 版本线对齐。npm 的 prerelease 解析规则下 `^0.1.0-rc.7` 不会解析到 `0.1.2-rc.1`（只会装 `0.1.0-rc.8`），因此较低的范围会拉到与新版 DSH 不同 train 的 settings 副本。
- **0.1.4（DSH 0.1.2 适配）**：rc.1 起 live session 不再携带 `.events` 数组（改用 `session.seq` + `session.eventAt(seq)`，与官方 `dsh-token-meter` 相同），新会话判断从 `composerPhase === "blank"` 改为布尔 `session.blank`；`sessionPersistence` 在 rc.1 不再提供会话枚举（`listSnapshots` 已移除，仅剩 `list`），持久化历史的增量刷新降级为保留已有缓存、只累计 live 会话。客户端注入模块列表同步为新架构模块（见上）。
- **0.1.6（session/event 实时折叠 + 可选台账增强）**：`apply()` 注册官方 `session/event` 监听器，每个 usage 事件即时折叠进缓存，解决 rc.1 上 live 会话仅在 hero 屏挂载时才折叠而漏计同一日其他会话用量的问题（表现为当日总量偏小、历史天数丢失）；启动时一次性补折叠已存在的 live 会话（如 resumed 会话）。可选增强：若存在第三方插件 `@linxin666/dsh-usage` 的台账 `<DSH_HOME>/dsh-usage/usage-ledger.json`（设置 → 使用统计 的数据源，完整实时），则直接采用以恢复完整历史——该文件是第三方插件内部文件而非 DSH 契约，仅检查 `days` 形状（不校验 version），格式不符时告警并回退到 session/event 折叠。该文件仅在 @linxin666/dsh-usage 安装并启用时存在；其按 retainDays（默认 180、最大 730）修剪旧天数，故以台账为源时 all-time 总量与旧日历年受该设置上限。token 口径与该统计卡一致（input + output + cacheRead + cacheWrite，不含 reasoningTokens）。
- **0.1.7（fork 会话双计修复）**：DSH 的 fork 子会话（header `isSeeded=true`）日志以父会话事件的完整复制开头，其前 `inheritedEventCount` 个事件是**父会话**的 usage（父会话折叠时已计入）。此前折叠从 seq 0 读整份日志，导致同一批 token 被计两次——实测 2026-09-14 由 8.34 亿虚增到 13.15 亿。现折叠从 fork 切点开始，只读官方字段 `session.header.isSeeded` + `session.inheritedEventCount`（0.1.5-rc.3 与 0.1.7-rc.2 逐行一致）。`isSeeded=false` 的 resume 会话不是 fork（其 seed 是自己的历史），必须全折——只有 `isSeeded=true` 才跳过。
- **0.1.8（兼容 0.1.5-rc.3 + 0.1.7-rc.2）**：DSH 0.1.7 重写了 settings —— `ctx.settings` 不再提供 `register()` / `get(ns)`，客户端 `settingsScope` 改名 `configForms`，插件配置卡插槽 `settings.plugin.item` 被删除（0.1.7 官方改由插件管理页的 `plugins.bundle.config` 承接，但该插槽要求官方 `@deepseek-ai/dsh-client-ui-plugin-manager` 包在场——从 0.1.5 时代装起的 profile 缺这个包，插槽根本不存在），因此本插件改为注册**两版都声明的** `settings.plugins.tab`，配置卡成为 设置 → 插件 下的独立页签，两版同一入口。配置 schema 改从插件的 `Config` 导出投影。本版本把 `inject` 收敛为两版交集，服务端按能力分流、客户端按 `ctx.inject` 条件分支，**配置卡在两版均可正常使用**。schemastery 3.18.2（0.1.5 自带）没有 `.volatile()`，故 volatile 标记写作 `extra("volatile", true)`——在 3.18.4 上它同时把解析结果变成 `Volatile<T>` 响应式包装，正是 0.1.7 `plainConfig()` 解包的对象。同时清理 `listSnapshots()` / `readFrom()` 死代码——这两个方法在 0.1.5 与 0.1.7 的 `SessionPersistence` 里**都不存在**（只有 `create`/`open`/`flush`/`stat`/`list`），旧代码每次请求都会告警后失败（持久化历史的增量刷新仍不可用，官方已在 rc.1 移除该枚举能力），清理与原行为等价，缓存版本不变。另修复 `reload()` 调用两版都不存在的 `scope.load()` 导致的报错。

## License

MIT。聚合与回环端点实现参考了 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats)（MIT © Ychris12138）。
