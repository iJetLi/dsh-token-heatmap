# AGENT.md — dsh-token-heatmap

DSH（DeepSeek Harness）web 插件：新会话（hero）屏上的 GitHub 风格每日 token 用量热力图，**年视图 / 月视图可切换**、六套配色与默认视图设置（设置 → 插件 → 插件配置），含今日/本月/累计统计。

## 快速命令

- 校验：`npm run check`（`node --check` 全部 lib）
- 测试：`npm test`（`scripts/smoke.mjs` + `cache-recovery-smoke.mjs` + `settings-smoke.mjs` + `rc1-session-smoke.mjs` + `compat-smoke.mjs`）
- 发布：推送 tag `vX.Y.Z` → GitHub Actions（OIDC Trusted Publisher）自动 `npm publish`。**不要手动 npm publish**；版本号与 tag 必须同步 bump。

## 结构

- `lib/index.js` — 服务端 half（cordis plugin，`inject: ["webServer","sessions","sessionPersistence","settings"]`）
  - `apply()`：注册官方 `session/event` 监听器实时折叠每个 usage 事件进缓存（不依赖 hero 屏挂载）；启动时一次性补折叠已存在 live 会话
  - `collectUsage()`：**主路径=请求时增量同步 live 会话**；stored 会话**只枚举 id、不读日志**（`list()` / `listSnapshots()`，仅用于区分"仍存在"与"已删除"以免缓存被误删），历史来自已折叠的缓存天数 + `session/event` 实时折叠。**绝不要恢复 stored 日志读取**：两种接口（`readFrom()` / `open()`+`read()`）都返回**整份日志**，在几百个 stored 会话 / 几百 MB 历史下会让端点永久挂起并拖垮同进程其他插件（实测：端点不返回、CPU 打满、兄弟 RPC 报 `signal timed out`）。`dsh-usage`（设置 → 使用统计）从不碰 `sessionPersistence`、只折实时流，同一份数据下始终秒开——这就是正确形状
  - **fork 切点**：只用 `forkCutOf()`（live，`header.isSeeded === true` → `session.inheritedEventCount`），存在 per-session `state.skipUntil`，live 折叠 / `session/event` 监听统一从 `max(consumed, skipUntil)` 开始；切点新发现或不一致就 `resetFold()` 重折。**fork 子会话的前缀是父会话的 usage，父会话折叠时已计过**，从 0 折会双计（2026-09-14 实测 8.34 亿 → 13.15 亿）；`isSeeded=false` 的 resume 不是 fork，必须整份折（stored 日志不再读取，故无需 `forkCutOfEvents()`）
  - 缓存：`<DSH_HOME>/storages/token-heatmap-cache.json`（原子写，单飞锁 `withLock`）；**这是历史的唯一载体**（stored 日志永不重读），启动时 `loadCache()` 把 live 文档 + 覆盖前的 `<cache>.bak` + 同版本 `<cache>.<pid>.<ms>.tmp` 快照合并自愈（`lib/cache.js`）；测试用临时 `DSH_HOME`
  - 路由：`GET /api/token-heatmap/usage`、`GET|POST /api/token-heatmap/config`（loopback-only）
  - settings namespace：**`"token-heatmap"` 字面量**（0.1.2 起 `dsh-settings` 不再导出 `settingsNamespace()`）
  - 迁移：`migrateLegacyConfig()` 一次性导入旧 `storages/token-heatmap-config.json`
- `lib/usage.js` — 纯函数：`applyUsageDelta`（replace-last-sample 语义）/ `createUsageState` / `foldUsage` / `renderUsage` / 按本地日聚合
- `lib/config.js` — 纯函数：`DEFAULT_CONFIG` / `parseConfig`（短字符串 shape 约束 + `defaultView` 枚举；0.1.x 的 `enabled` 已废弃、读到即忽略）
- `lib/cache.js` — 缓存文档模型（纯函数，无 cordis / 无 fs）：`parseSession` / `serializeSession`、`parseCacheDocument` / `serializeCacheDocument`、`mergeCacheDocuments`（**启动恢复**：按 SESSION 取最完整的记录决定游标、天数取**并集**，并集比胜出记录更宽时标 `kind:"merged"` 触发重折）、`isMoreComplete` / `sessionScore` / `mergeImproves`；`CACHE_VERSION` 定义在此
- `lib/client.js` — 浏览器 half：**手写 `window.__ModuleLoader__.load({id, factory})` bundle，无构建步骤**；React 组件（`require("react")` / `require("react/jsx-runtime")`）；CSS 走 `data-plugin-css` 通道
  - **只注册 `conversation.input.dock`**（list slot，id `token-heatmap`，order 10）——hero 屏输入卡上方全宽条目（**无显示开关**：hero 屏始终渲染）。0.4.0 起**不注册 `settings.plugin.item`**：设置页里没有本插件的卡片，配置改在卡片内（见下），若哪天要恢复就得同时带上 `key: SETTINGS_NS`（keyed slot 契约）
  - `TokenHeatmapInlineSettings` —— ⚙（`S.gear`，标题行最右端）弹出的**悬浮设置面板**：portal 到 `document.body`、`position:fixed`、`z-index:1100`，锚在 ⚙ 上方 8px 居中、按视口钳制 12px（`placePanel()`，与 dsh-session-cost 的统计 pill 弹层同一套做法与同一组 token：`--dsw-specific-menu` + `--dsw-elevation-prominent` + `--dsw-elevation-stroke-color`）；内容是标题/分隔线/配色 6 色板/默认视图年月分段/底部图例与说明；关闭方式为点外部 pointerdown、Esc、再点 ⚙（监听绑定在 `TokenHeatmap` 上，面板只负责画）。**点击即时写入 settings scope**（无草稿/保存；`pending` 乐观回显，失败显示 `settingsSaveFailed`）
  - bundle 里 `require("react-dom")` 只服务这个 portal（官方模块图一直提供 react-dom）；`scripts/smoke.mjs` 的 fakeRequire 会跨 profiles / repo 两棵 node_modules 解析它
  - 排布：`标题 · 统计… · ‹ › 步进器 · 年|月分段 … 刷新 · ⚙`（步进器和分段按钮成对，刷新与 ⚙ 收在行尾）
  - 视图：`buildGrid()`（年，53 列 × 7 行）/ `buildMonthGrid()`（月，7 列 × 5–6 行 + 日号），`levelOf()` 绝对阈值分档，`shiftMonthKey()` 月游标步进；默认视图来自 `defaultView` 设置
- `scripts/*.mjs` — 自包含 smoke（mock ctx / mock settings scope / 临时 DSH_HOME）+ 文档截图工具链（见「修改守则」）；`compat-smoke.mjs` 驱动两版形态的 mock（`register`/`configure`、`settingsScope`/`configForms`），用抛错哨兵证明每版只走一条分支
- `scripts/rebuild-from-logs.mjs` — **离线从会话日志重建每日用量**（缓存是历史唯一载体，一旦丢失只能靠日志重算）。`--from` 只报告可信区间（实测 2026-09-26 起与官方 `dsh-usage` ledger 逐日吻合；9/22~9/25 因 fork 标记形态不同会偏大，9/13 前 v3/v0 日志会偏小），`--ledger` 逐日对账，`--write` 把重建结果叠加回缓存文档。fork 切点从日志里的 `session/end-seed {inherited:true}` 推导（header 只有 `isSeeded`、没有 `inheritedEventCount`）
- `scripts/cache-lock-smoke.mjs` — 跨进程锁的回归（**驱动真实子进程**，因为该缺陷只存在于进程间）：8 个并发写者不丢会话、不留锁文件、陈旧锁可回收且由接管者释放。**写测试时必须验证鉴别力**：把 `lib/index.js` stash 掉应失败（实测无锁丢 1~3 个写者），否则测试等于没写

## 兼容性（重要，改代码前必读）

- 适配 **DSH 0.1.5-rc.3 与 0.1.7-rc.2**（两版并存兼容），`dsh.compatibility.dshReleases` 精确逐版本声明（DSH STORE 契约；范围声明无效）；`engines.dsh: ^0.1.2-rc.1` 与 9 项 lockstep peer 未改——`^0.1.2-rc.1` = `>=0.1.2-rc.1 <0.2.0` 已覆盖两个目标版本
- `dsh.client.inject` 必须是 **rc.1 模块图存在**的包（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`）
- `engines.dsh: ^0.1.2-rc.1`；`peerDependencies` 声明 lockstep `@deepseek-ai/dsh-*` 宿主包（dsh-market 据此显示"宿主要求"）
- **rc.1 破坏性变更备忘**：
  - live session 无 `.events` 数组 → `session.seq` + `session.eventAt(seq)`（0 基，官方 `dsh-token-meter` 读法）
  - **hero 判断：`session.blank`（布尔，true=新会话）**；旧版用 `composerPhase === "blank"`——client 里已双兼容（`heroBlank`），改时别丢掉
  - **`sessionPersistence` 只用来枚举，不要用来读日志**：快照列表换过两代拼写——0.1.2 线是 `listSnapshots()`，0.1.3-alpha.2 起是 `list()`（两者都带 `revision`），探测两条是对的。但**日志读取绝不能做**：`readFrom(id, fromSeq)`（0.1.2 线）与 `open(id,"read")`/`handle.read()`（0.1.3+）都返回**整份日志**。曾因此导致每个请求重读几百 MB、端点永久挂起、CPU 打满并让同进程其他插件 RPC 超时（`signal timed out`）。`state.consumed` 存的是 **seq 不是 index**（这一点在 live 路径仍成立）
  - `session/event` 监听器与 `collectUsage` 共用同一份内存缓存与 per-session `consumed` 游标，不要在其中一方重置状态而不重置另一方
  - **fork 的切点也必须三条路径一致**：`state.skipUntil` 是 per-session 的 fork 切点，`apply()` 的 `session/event` 守卫、`collectUsage` 的 live 折叠、启动时的首次补折叠都读同一份；只改其中一条会让同一批 token 被计两次或少计
  - **缓存格式版本**：per-session 折叠状态的字段变了（如 0.4.1 的 `skipUntil`）就必须 bump `CACHE_VERSION`，否则旧缓存里已双计的天数会留着且与新折叠口径混在一起
- **settings 的两半各管什么（重要）**：Host 侧注册**必须保留**——官方 `settings` 服务的 `get`/`update`/`describe` 只对**已注册** namespace 生效，它就是 settings.yaml 的校验与持久化管道；但**注册方式按版本分流**（见下条），0.1.7 上根本没有 `register()`。client 侧的 `settings.plugin.item` 注册只是"设置页那张卡"，0.4.0 起已移除（配置改在卡片 ⚙ 面板里，见上）。别为了"删设置"把 Host 注册也删了
- **跨版本兼容层（0.1.5 / 0.1.7 必读）**：`inject` 只能写两版交集——服务端 `["webServer","sessions","sessionPersistence","settings"]`、客户端 `["slots","locale","connection","remote"]`（**绝不能**写 `settingsScope`，它 0.1.7 已改名 `configForms`，写进去会让 fiber 永久 pending）。train 差异一律走 `apply()` 里的 `ctx.inject([...], cb)` 条件分支：cordis 对未 inject 的服务抛 `cannot get property ... without inject`，**不要**用 try/catch 吞它。服务端按 `typeof ctx.settings.register === "function"` 分流（0.1.5 注册 namespace + 迁移旧文档；0.1.7 走本模块导出的 `Config` + `settings.configure({auto:false}, ctx.fiber)`，`settings.yaml` 由 DSH 自身的 `importLegacyDocument` 搬到 profile entry 的 `config:`），读写只用两版都有的 `describe()` / `update()`（`settings.get(ns)` 在 0.1.7 不存在）。**schemastery 3.18.2（0.1.5）没有 `.volatile()`**，volatile 标记必须写 `schema.extra("volatile", true)`（在 3.18.4 上等价，且会把解析结果包成 `Volatile<T>`，由 0.1.7 的 `plainConfig()` 解包）。客户端两条分支各自把 `configStore` 绑到 `settingsScope.bind({namespace})` 或 `configForms.get(ns)`——两者快照与写入接口一致，`createConfigStore` 原样复用；`configStore` 必须有兜底 scope，因为设置服务现在是**异步**条件注入，而输入卡插槽注册在前
- **`reload()` 不要调 `scope.load()`**：两版的 scope 都没有 `load()`（刷新在 settings 包内部的 describe mirror 上），用 `createConfigStore` 里的 `notify()` 重算本地快照
- **DSH STORE 的 protectedDsh 信号**（客户端访问内置 UI/统计）是设计使然，README 已披露，保持现状

## 修改守则

- 服务端读 session 事件**必须走 `liveSessionEvents()`**（不要直接碰 `session.events`）
- **缓存是历史的唯一载体**：stored 日志永不重读，所以 `storages/token-heatmap-cache.json` 一丢就是永久丢失（2026-10-08 实测：49 天 / 590 个会话被一个 4 天的小缓存覆盖）。`loadCache()` 必须继续合并 live 文档 + `<cache>.bak` + 所有**同版本** `<cache>.<pid>.<ms>.tmp` 快照；**不要把 version 不匹配的快照并进来**（v1 的天数可能含 fork 前缀），覆盖前的 `.bak` 复制（30s 节流）也不要去掉
- **`consumed` 与 `days` 必须同源**：合并时只能用"更完整记录"自己的游标，天数取并集后必须标 `kind:"merged"`——否则 `collectUsage` 会用旧游标永久跳过那段历史，或把已折叠的区间再折一遍（双计）
- **`resetFold()` 绝不能清空 `days`**：它返回被保留的旧天数，调用方折完必须 `state.days = mergeRefoldedDays(state.days, preserved)` 合并回去。因为恢复来的天数常常**超出本进程内存日志能覆盖的范围**（日志被截断/压缩，或只是个短的实时尾巴），清空后重折读到的比删掉的少 → 刚恢复的历史当场蒸发（实测：快照的 09-01/09-02 共 10000 tokens 在 live 会话被重折后只剩 333）。`mergeRefoldedDays` 按天**替换**（重折能复现的天以重折为准，不能复现的保留），所以不会双计
- **`saveCache()` 写前必须重新合并磁盘文档**：内存里的 map 只是本进程的视图，web 与 desktop 共享同一个 `<DSH_HOME>`。旧实现直接写内存态，实测两进程场景：B 加载 4 天缓存 → A 写入 53 天 → B 再保存，A 的 53 天被整个抹掉。合并让保存变成"追加"（本进程已知的会话以本进程为准，只有磁盘知道的会话透传）
- **淘汰结果必须传给 `saveCache(ctx, cache, evicted)`**：否则刚被 `stat()` 证明不存在的会话会在同一次保存里被磁盘合并**复活**，形成"删了又回来"的死循环（实测复现）。`evicted` 里的 id 会被排除在写出的文档之外
- **淘汰必须写进 tombstone（`<cache>.evicted`）**：恢复与淘汰天然对立——证明会话不存在会把它从 live 文档移除，但下一次 `backupBeforeOverwrite` 会把**仍含它的旧文档**复制成 `.bak`，下次启动合并时又读回来（实测：A 淘汰 → 全新 B 启动保存 → 会话复活）。tombstone 是"决定"而不是"文档"，`loadCache` 与 `saveCache` 都必须让它在所有副本之上生效
- **`seenHere` 必须按 storage 目录作用域、`loadedCache` 必须按文档路径作用域**：两者都是模块级单例，而它们描述的是某个具体 `DSH_HOME` 下的文档。换 home（测试逐用例换、多 profile 宿主）时若不重置，旧 home 的文档会被写进新 home、旧 home 折过的会话会在新 home 被误判"见过"而淘汰（实测）。淘汰的最终删除点还要**再校验一次** `seenHere`——删除是不可逆步骤，不能只依赖候选列表构建时的过滤
- **锁必须带持有者身份**：`acquireCacheLock` 用 `writeFile(..., {flag:"wx"})` **一次**完成创建+写 token（先建空文件再写会留下"锁存在但内容为空"的窗口）；陈旧锁接管是**原地改写 token**（不能先 unlink 再建，那会留下"完全无锁"的窗口），并且**返回成功**而不是重试排他创建（文件还在，`wx` 永远失败）；`releaseCacheLock` 必须 `readFile` 校验 token 才删——否则陈旧锁的原持有者会删掉**接管者**的锁，第三方随即进入临界区（实测：互斥退化为无锁，正是丢 49 天的机制）。`LOCK_STALE_MS=30s`（一次保存约 5ms）、`LOCK_WAIT_MS=5s`、`LOCK_POLL_MS=25ms`
- **`session/event` 监听器不得让 `consumed` 跳过未折叠区间**：`seq > from` 时先回补 `eventsInRange(session, from, seq)`（上限 `MAX_GAP_EVENTS`）再折当前事件，`consumed` 只写 `seq + 1`
- **stored 会话的"已消失"判定只能靠 `stat(id)`**：`list()` **不是**"现存全集"——它只枚举 header 为**当前格式版本**的日志，历史格式被静默跳过（实测 2026-10-12：805 个 stored 会话里只列出 610，静默丢掉 136 个 v3 + 59 个 v0，而它们**恰好全是 8/15~9/25 的会话**，这就是"最早的天数先消失"的原因）。`stat(id)` 按 id 定位并走迁移目录读历史格式，是唯一可靠的存在性判据；探测失败（抛错）时保留、只对**探测上限 `EVICTION_PROBE_LIMIT`** 内的 id 探测
- 不要试图在 rc.1 上"恢复" persisted 会话枚举——官方没有公开 API，降级路径是有意为之
- client 保持手写 bundle 格式与 `data-plugin-css` 通道；组件是 React 组件（返回 JSX 元素，不要返回 DOM 节点）
- 新增视图/格子渲染必须同时改 `buildGrid`（年）与 `buildMonthGrid`（月）两条路径，并在 `scripts/smoke.mjs` 补对应几何断言（列=周一起、越界格为 null、level 与 `levelOf` 一致）
- settings 字段：`colorScheme` 只约束 shape（新色板要能存进旧服务端），`defaultView` 是枚举（未知值没有渲染器可回退）——加字段时想清楚属于哪种，并同步 `lib/config.js` / `lib/index.js` schema / client `createConfigStore` 三处 + 对应 smoke。**删字段**（如 0.3.0 删掉的 `enabled`）时：schema 移除该键即可，schemastery 会把未声明键原样透传（旧 `settings.yaml` 的键留着但没人读）；只有当该字段出现在回环兼容 API 的响应里才需要保留常量占位（`serveConfig` 的 `enabled: true`），否则旧客户端会改行为
- 文档截图（`docs/预览-新版会话页.jpg` / `月视图.jpg` / `年视图.jpg` / `卡片设置面板.jpg`）改 UI 后需重拍，工具链在 `scripts/`：`docs-screenshot-auth.mjs`（用 `~/.dsh/.credentials.yaml` 里的 browser-session secret 现签回环登录 cookie）→ `docs-screenshot.mjs`（CDP 驱动 headless 浏览器加载运行中的 `dsh web`，截整页 + 年/月/⚙ 三张卡片状态）→ `docs-screenshot-crop.mjs`（用系统 Edge/Chrome 无头渲染成 README 尺寸的裁切图，再用 System.Drawing/ImageMagick 转 JPEG 落到 `docs/`；`THM_VIEW=month` 用于 card-a 恰好是月视图时）。**不需要手工同步**（见下条），但注意 ⚙ 里切过「默认视图」后，`shot-card-a/b` 哪张是年、哪张是月会翻转
- **本机是开发模式（junction 链接）**：`~/.dsh/profiles/web/package.json` 里本插件是 `link:C:/Projects/DSH/dsh-token-heatmap`，`node_modules/@kidli1412/dsh-token-heatmap` 是指向本仓库的 **Junction**。所以**改仓库即改运行时**：编辑 `lib/client.js` 后服务端的 HMR 轮询会在 ~1s 内重算 bundle rev，硬刷新浏览器就能看到（实测：写入标记 → 1s 后新 rev 里已含该标记）。推论：① 不要再往 profile 复制文件——`Copy-Item` 会报 "Cannot overwrite the item … with itself"；② `git checkout -- lib/client.js` 会**立刻改变正在运行的 GUI**（仓库文件就是运行时文件），回滚工作区前先确认；③ 唯一需要重启 `dsh web` 的是 Host half（`lib/index.js` 的 settings schema / 路由 / 折叠逻辑），客户端 half 不用
- 新测试加入 `package.json` 的 `"test"` 链；改完必须 `npm run check && npm test` 全绿
- 提交用 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:`），原子提交；改动涉及运行时契约时同步 bump 版本 + README「兼容性」小节
- 本地仓库有 codegraph 索引（`.codegraph/`，已 gitignore），可先用 codegraph 探索再改
