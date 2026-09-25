# dsh-token-heatmap 兼容 DSH 0.1.5-rc.3 与 0.1.7-rc.2 — 设计

- 日期：2026-09-25
- 状态：已批准，待实现
- 目标版本：`dsh-v0.1.5-rc.3`、`dsh-v0.1.7-rc.2`（DSH 源码位于 `D:\jet\code\js\deepseek-harness`）

## 1. 背景与问题

插件当前适配 0.1.2 版本线（`0.1.2-alpha.4` / `alpha.5` / `rc.1`）。在 0.1.7-rc.2 上无法激活，在 0.1.5-rc.3 上部分功能异常。需要同时兼容这两个版本，且两版的配置功能要对齐。

根因由两个 tag 的源码逐点比对得出。

### 1.1 致命契约断裂（0.1.7-rc.2）

| # | 契约点 | 0.1.5-rc.3 | 0.1.7-rc.2 | 插件现状 |
|---|---|---|---|---|
| 1 | `ctx.settings.register(ns, schema, options)` | 存在（`SettingsProvider`，返回 `SettingsScope`） | **不存在**（实现类换成 `SettingsForms`，只有 `describe` / `update` / `replace` / `mutate` / `configure`，且无 `get(ns)`） | `lib/index.js` 的 `apply()` 直接调用 → `TypeError` → 服务端半侧整体不激活 |
| 2 | 客户端注入服务 | `settingsScope` | **改名为 `configForms`**（`ctx.configForms.get(ns)`） | `lib/client.js` 的 `inject` 含 `settingsScope` → fiber 永久 pending → 浏览器半侧完全不加载 |
| 3 | 配置卡插槽 | `settings.plugin.item`（keyed，key = settings namespace） | **该插槽已删除**；改为 `ui-plugin-manager` 的 `plugins.item` / `plugins.bundle.config` / `plugins.row.config` | 注册到不存在的插槽 |
| 4 | 配置 schema 来源 | 运行时 `settings.register()` | 来自 **Loader entry 的 `Config` 导出**，字段须标 volatile，`ns` = profile entry id | 无 `Config` 导出 |
| 5 | `.volatile()` 字段标记 | schemastery 3.18.2 **无此方法** | schemastery 3.18.4 有 | — |

### 1.2 既有缺陷（两个版本都坏）

- `persistence.listSnapshots()` 与 `persistence.readFrom()` 在**两个 tag 的源码里都不存在**。`SessionPersistence` 只有 `create` / `open` / `flush` / `stat` / `list`。因此 `lib/index.js` 的 persisted 折叠分支每次请求都会抛错 → `warn` → 被 `catch` 吞掉。
- `lib/client.js` 的 `reload: () => scope.load()`：`load()` 在两版的 scope 接口上都不存在（只存在于内部 mirror），重试按钮点击即抛 `scope.load is not a function`。

### 1.3 两版一致、无需改动 ✅

`session/event` 事件签名、`webServer.register`、`conversation.input.dock` 插槽、`sessionPersistence.list()`、`session.blank`、`session.seq` / `eventAt()`、`header.isSeeded`、`Session.inheritedEventCount`、cordis 的 `Config` 解析（`vendor/cordis/src/fiber.ts` 两版无 diff）。

## 2. 关键事实（决定实现方式）

1. **客户端 scope 接口两版几乎逐字段一致** —— `SettingsScope`（0.1.5）与 `ConfigForm`（0.1.7）都提供 `getSnapshot()` / `subscribe(listener)` / `set(field, value)` / `unset(field)` / `mutate(ops, revision)`，且 snapshot 形状同为 `{ status, value, base, user, revision, writable, mode }`，`status` 取值同为 `'loading' | 'ready' | 'unavailable'`。→ **`createConfigStore` 可零改动复用**。
2. **`Config` 导出在 cordis 层两版实现完全相同** → 插件可无条件导出 `Config`：0.1.7 必需，0.1.5 上退化为 `ctx.config` 的默认值（本插件不读 `ctx.config`，无害）。
3. **`extra()` 在两版 schemastery 都存在**，而 `.volatile()` 的实现就是 `this.extra('volatile', true)`。→ 用 `extra("volatile", true)` 即可双版安全。
4. **`ctx.settings.describe()` 两版都在**，且都返回含 `ns` 与 `value` 的 descriptor。→ 读取配置的统一入口。
5. **cordis 显式禁止未 inject 就访问服务**（`cannot get property "settingsScope" without inject`），所以版本分支必须走 `ctx.inject(deps, cb)` 条件注入，不能靠 `try/catch` 兜服务解析异常。
6. **`persistedIds.add(meta.id)` 在 `readFrom` 之前执行** → 清理死代码后淘汰语义与现状等价（见 4.3）。
7. **`forkCutOf()` 依赖的 `header.isSeeded` 与 `inheritedEventCount` 两版逐行一致** → fork 双计修复在 live 主路径上不受影响。

## 3. 架构决策

**采用方案 A：静态交集 + `ctx.inject` 条件分支。**

`export const inject` 只声明两版都存在的服务；版本差异全部下沉到 `apply()` 体内的两路 `ctx.inject(deps, cb)`。服务缺席的那一路永久处于 pending —— 这是 cordis 原生降级语义，不报错、不阻塞、不需要捕获本该避免的异常。

已否决的备选：

- **方案 B（运行时能力探测 + `try/catch`）** —— 依赖捕获 `cannot get property ... without inject` 这类服务解析异常，脆弱且会掩盖真实故障。
- **方案 C（双入口文件）** —— manifest 不支持运行时选版，实际要发两个包，维护成本翻倍，与"手写 bundle、无构建步骤"的现状冲突。

## 4. 详细设计

### 4.1 服务端 `lib/index.js`

**`inject` 保持不变**：`["webServer", "sessions", "sessionPersistence", "settings"]` —— 这已是两版交集（`settings` 这个服务名两版相同，只是实现类换了）。

**新增 `Config` 导出**：

```js
const volatileField = (schema) => schema.extra("volatile", true);   // 不用 .volatile()：0.1.5 的 schemastery 没有它
export const Config = z.object({
  enabled:     volatileField(z.boolean().default(true)),
  colorScheme: volatileField(z.string().min(1).max(32).default("green")),
});
```

**`apply()` 按能力分流**（同一份 `inject`，分支在体内）：

```js
function apply(ctx) {
  // ... 两版共用：路由、session/event 折叠、启动补折叠（均不动）
  if (typeof ctx.settings.register === "function") {
    // 0.1.5-rc.3 及更早
    ctx.settings.register(SETTINGS_NAMESPACE, TokenHeatmapSettingsSchema);
    migrateLegacyConfig(ctx);
  } else {
    // 0.1.7-rc.2：Config 导出已由 Loader 投影；仅声明不自动生成 Settings 分区页面
    ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), "token-heatmap: settings presentation");
  }
}
```

| | 0.1.5-rc.3 | 0.1.7-rc.2 |
|---|---|---|
| namespace 注册 | `settings.register("token-heatmap", Schema)` | Loader 从 `Config` 导出 + entry id `token-heatmap` 自动投影 |
| legacy 迁移 | 跑 `migrateLegacyConfig()`（读 `settings.yaml`） | 跳过 —— DSH 自己的 `importLegacyDocument` 已把同名 section 写进 profile patch |
| 读 | `settings.describe().find(ns).value` | 同左 |
| 写 | `settings.update(ns, patch)` | 同左 |

> 弃用 `ctx.settings.get(ns)` —— 它在 0.1.7 不存在。改走两版交集 `describe()`。

**路由、`session/event` 实时折叠、启动补折叠、回环围栏**：全部两版共用，不改动。

### 4.2 客户端 `lib/client.js`

**`inject` 改为两版交集**：`["slots", "locale", "connection", "remote"]`（去掉 `settingsScope`）。

**`apply()` 拆两路条件注入**，各自先建 store、再注册插槽（保持现有顺序，`configStore` 不会为 `null`）：

```js
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "token-heatmap: dictionaries");
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock", id: "token-heatmap", order: 10, locale: NS,
  }, TokenHeatmap));

  ctx.inject(["settingsScope"], (child) => {                    // 0.1.5 分支
    configStore = createConfigStore(child.settingsScope.bind({ namespace: SETTINGS_NS }));
    child.slots.inject("settings.plugin.item", () => child.slots.register({
      name: "settings.plugin.item", key: SETTINGS_NS, order: 30, locale: NS,
    }, TokenHeatmapSettingsCard));
  });

  ctx.inject(["configForms"], (child) => {                      // 0.1.7 分支
    configStore = createConfigStore(child.configForms.get(SETTINGS_NS));
    child.effect(() => child.configForms.whileServed([SETTINGS_NS], (served) =>
      served.has(SETTINGS_NS)
        ? child.slots.inject("plugins.bundle.config", () => child.slots.register({
            name: "plugins.bundle.config", key: "@kidli1412/dsh-token-heatmap", locale: NS,
          }, TokenHeatmapSettingsCard))
        : () => {}));
  });
}
```

- 运行时只会有一路成立 → `configStore` 只被赋值一次。
- 0.1.7 用 `whileServed` 对应 0.1.5 的"Host 实际 serve 该 namespace 才渲染卡片"约定。
- 配置卡落点选 **`plugins.bundle.config`**（key = 包名）而非 `plugins.row.config`（key = `包名#row id`）：本插件是单 row 的 bundle，配置应显示在 bundle 描述与 rows 之间，语义更贴合。
- 包名 key `@kidli1412/dsh-token-heatmap` **在客户端硬编码**，与现有 `SETTINGS_NS = "token-heatmap"` 的做法一致 —— 浏览器端 bundle 无法 import 自身 `package.json`（client bundle purity gate），且插件经 `link:` 或 npm 安装时包名恒定。该值必须与 `package.json` 的 `name` 保持同步，两者之一改动时须同时核对。

**卡片组件**：签名从 `{ t }` 放宽为 `{ t, view }`。

- 0.1.5 不传 `view` → 照常渲染。
- 0.1.7 `view === "summary"` → 返回 `null`，让包描述兜底；`view === "page"` → 照常渲染。插件卡片自带保存控件，符合 `plugins.bundle.config` 中 `form` prop 可选（"forms with their own save controls"）的约定。

**兜底**：热力图组件与卡片读 `configStore` 时改用 `configStore ?? defaultStore`，防两版服务都缺席时崩溃。

### 4.3 死代码清理（行为等价，可证明）

`collectUsage()` 中 `listSnapshots` / `readFrom` 分支整体移除，改为只用 `list()` 收集 `persistedIds`：

```js
const canEnumeratePersisted = persistence !== void 0 && typeof persistence.list === "function";
if (canEnumeratePersisted) {
  for (const meta of await persistence.list()) persistedIds.add(meta.id);
} else if (persistence !== void 0) {
  ctx.logger.warn("token-heatmap: sessionPersistence exposes no list() enumeration on this DSH; persisted-only history will not refresh");
}
```

**等价性论证**：现状下 `persistedIds.add(meta.id)` 先于 `readFrom` 执行，所以 `readFrom` 抛错只会让该会话的 `state` 不被更新、但仍被计入 `persistedIds` 而不被淘汰。清理后 `state` 同样不被更新、同样计入 `persistedIds`。→ 淘汰行为与缓存内容完全一致，只消除每请求的噪声 `warn`。

因此 **`CACHE_VERSION` 保持 2**，无需强制重折已污染缓存。缓存里的 `revision` 字段停止写入（`serializeSession` 已有 `=== undefined` 不写的分支），`parseSession` 保留读取以兼容既有缓存。

同时移除 **`forkCutOfEvents()`** —— 它只服务 persisted 路径，且因外层 `readFrom` 先抛错而从未真正执行到。

### 4.4 修复 `scope.load()`

`reload: () => scope.load()` 改为 `reload: () => { notify(); }` —— 重算 snapshot 并广播。两版的 mirror 本就在 `settings/document-updated` 与 `connection/reset` 上自动刷新，按钮无需真的重新拉取，但点击必须有响应且不抛错。

### 4.5 manifest（`package.json`）

| 字段 | 现值 | 改动 |
|---|---|---|
| `dsh.compatibility.dshReleases` | `0.1.2-alpha.4` / `alpha.5` / `rc.1` | **替换为** `0.1.5-rc.3`、`0.1.7-rc.2`（DSH STORE 契约要求逐版本精确声明，范围声明无效） |
| `engines.dsh` | `^0.1.2-rc.1` | 不改 —— `>=0.1.2-rc.1 <0.2.0` 已覆盖两者 |
| `peerDependencies`（9 项） | `^0.1.2-rc.1` | 不改 —— 同上，且 9 个包名在两版均存在 |
| `version` | `0.1.7` | → **`0.1.8`**（历史版本号跟随 DSH 版本线：`v0.1.5` 对应 DSH 0.1.5。本次在 0.1.7 之上增加对 0.1.5-rc.3 的回归兼容与跨版本架构层，属增量演进，取 `0.1.8`；不取 `0.2.0` 因为没有破坏既有 API） |

**不新增** `dsh-client-ui-plugin-manager` peer：0.1.5 根本没有该包会导致解析失败；且插件对它只有 `ctx.slots` 动态注册，无运行时 import。

## 5. 测试与验证

1. `npm run check && npm test` 全绿（AGENT.md 硬性要求）。
2. 新增 smoke 覆盖：
   - `Config` 导出形状：两字段均带 `meta.volatile === true`，schema 可 `toJSON()`；
   - 读取走 `describe().find(ns)?.value`，descriptor 缺失时回落到默认值；
   - 两路 `ctx.inject` 分支互斥（模拟 0.1.5 只有 `settingsScope`、0.1.7 只有 `configForms` 两种上下文）；
   - 死代码清理后 `persistedIds` 淘汰语义不变（有 `list()` 时已缓存会话不被淘汰）；
   - `reload()` 不抛错。
3. 新测试加入 `package.json` 的 `"test"` 链。
4. 兼容性声明与 AGENT.md、README 的「兼容性」小节同步更新。

## 6. 风险与已知限制

- 0.1.5 运行时会多一个永久 pending 的 `configForms` fiber（反之亦然）—— cordis 常态，无害。
- 两版配置**存储位置不同**：0.1.5 → `<DSH_HOME>/settings.yaml`；0.1.7 → profile `cordis.patch.yml` 的 entry `config:` 字段。0.1.5 → 0.1.7 升级时由 DSH 的 `importLegacyDocument` 自动搬运（前提是 entry id 为 `token-heatmap`，插件自带 patch 正是该 id）；反向降级需手动搬。
- 0.1.2 版本线不再声明 —— 未在本次验证范围内。
- persisted 会话的历史增量刷新仍不可用（原能力在 rc.1 后已由官方移除，本设计只清理死代码、不恢复该能力）。

## 7. 实现期变更（2026-09-25）

### 7.1 配置卡落点改为 `settings.plugins.tab`

原设计（第 4.2 节）让两条版本分支各注册版本专属插槽：0.1.5 用 `settings.plugin.item`，0.1.7 用 `plugins.bundle.config`。**实机验证推翻了这一点**：

- profile 的 composition **包含** `ui-plugin-manager` 行（`dsh --profile web --dump-config` 可见，未被 `disabled`）
- 但 `@deepseek-ai/dsh-client-ui-plugin-manager` **未安装**：从 profile 解析得 `MODULE_NOT_FOUND`，且 `profiles/node_modules/@deepseek-ai/` 的 `client-ui-*` 列表中并无它——该 profile 的依赖是 0.1.5 时代装的，0.1.7 新增的这个包从未被装上
- 因此 `plugins.bundle.config` 插槽在运行时**不存在**，`ctx.slots.inject` 会永久 pending，配置卡不渲染。**这是 mock 测试无法发现的**：mock 只验证代码调用了哪个插槽名，不验证插槽是否真的有人声明

改用 `settings.plugins.tab`：由官方 `ui-settings-plugins` 在 **0.1.5 与 0.1.7 都声明**（该包在 profile 中已安装，其 bundle 含此插槽名），因此一次注册同时服务两版，配置卡成为 设置 → 插件 下的独立页签。这也让客户端少一条版本差异——插槽不再是变量，只剩 settings 服务绑定是变量。

随之的调整：

- 组件去掉 `view: 'summary' | 'page'` 分支（那是 `plugins.bundle.config` 的协议）；根元素由 `<li>` 改为 `<div>`（tab 面板无 `<ul>` 父级）；`open` 初始为 `true`（tab 正文即页面内容，默认折叠会把该页签唯一的内容藏起来）
- 字典新增 `settingsTabLabel`（zh/en）
- 客户端不再需要硬编码包名（`PACKAGE_NAME` 移除）；两条分支各自绑定 settings scope 后调用同一个 `registerSettingsTab(child)`
- `compat-smoke.mjs` 断言改为：两版注册**同一**插槽、都不触碰任一版本专属插槽、注册项具备 list slot 的 id/order/label 且 label 走字典

### 7.2 计划中的其它实现期修正

- **`Config.toJSON()` 形状**：它返回扁平引用表 `{uid, refs}`，不是嵌套 `dict`。`settings-smoke.mjs` 的断言改走 `Config.dict`。
- **volatile 的运行时效果**：`extra("volatile", true)` 在 schemastery 3.18.4（0.1.7）上会把解析结果变成 `Volatile<T>` 响应式包装（`{ get(), [cosmokit.volatile.write] }`），而在 3.18.2（0.1.5）上只是惰性 meta、输出仍是普通值。断言用 unwrap 辅助同时接受两种形状，使同一份 smoke 可在两版依赖下运行。
- **rc1 smoke 的 mock**：计划给的 `list: async () => []` 会让枚举成为权威，从而按设计清掉先前用例累积的缓存会话，破坏该用例 `total === 4200` 的断言。改用一个**不含 `list`** 的真实 API 形状（`stat`）来测「无枚举」路径。
- **Windows 路径**：`new URL(...).pathname` 在 Windows 上产生 `/D:/...`，再经 `pathToFileURL` 会得到 `D:\D:\...`。`compat-smoke.mjs` 改为直接 `import(new URL("../lib/client.js", import.meta.url).href)`。

### 7.3 旁证

本次调查在 DSH 启动日志中发现另一个第三方插件报出与根因 #1 完全相同的故障，佐证了诊断：

```
@goodandready/dsh-agent-loop-guard
TypeError: sctx.settings.register is not a function
  at lib/index.js:154
```
