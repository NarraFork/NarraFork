# cline-external：Cline 作为外部插件

## 定位

`examples/plugins/cline-external/` 把 Cline 实现为一个进程外的供应商插件，**与内置实现并存**。

（`server/lib/agent/cline-provider.ts`、`server/lib/cline-auth.ts`、`server/routes/cline.ts`、
`frontend/components/providers/ClineSection.tsx`）一行未改，也未被插件引用——因此未来取代内置时
只需删掉内置侧，不需要额外迁移。

| | 内置 | cline-external |
|---|---|---|
| provider prefix | `cline` | `cline-ext` |
| 凭据存储 | `~/.narrafork/cline-credentials.json` | 宿主 secret vault |
| OAuth 登录 | `/api/cline/auth/*` + ClineSection（React，674 行） | 插件自己的 iframe（原生 DOM） |
| 登录路径 | 浏览器回调 + 粘贴回调 URL | 两条都有 |
| 模型池 | `~/.narrafork/cline-models.json` | 插件数据目录缓存 |
| 已启用模型 | `settings.clineProviders[].enabledModels` | vault secret（见「决策 A」） |
| 余额/推荐模型 | REST 端点 | `handler:"server"` 命令 |
| 运行位置 | 宿主进程内 | 独立子进程 |

## 功能对等矩阵

内置前端调用 15 个端点，本插件用 10 个命令 + 2 个 provider 方法覆盖 13 个：

| 插件能力 | 覆盖的内置端点 |
|---|---|
| `status` | `GET /status` |
| `auth.browser` | `POST /auth/browser` |
| `auth.cancel` | `POST /auth/cancel` |
| `auth.callback` | `POST /auth/callback` |
| `auth.logout` | `POST /auth/logout` |
| `balance` | `GET /balance`、`POST /user-info/refresh`（合并：balance 自动补 userId） |
| `recommended-models` | `GET /recommended-models` |
| `models.refresh` | `POST /models/refresh`、`POST /providers/:id/models/refresh` |
| `models.search` | `GET /pool/search`、`GET /pool/count` |
| `config.setEnabledModels` | `POST /enabled-models` |
| （`provider.listModels`） | `GET /models`、`GET /providers/:id/models` |
| （`provider.chat`/`generate`） | 对话路径 |

**不做的 2 个，及理由**：

- `POST /global-proxy` —— 写的是**宿主全局** `settings.proxy`。`07-security-and-sandbox.md` §6.2
  明文禁止插件覆盖宿主代理策略，插件通过 `hostHints` 继承宿主代理即可。
- 多 provider 实例（内置的 `settings.clineProviders[]` 是数组）—— 插件贡献是单实例的。
  一个 Cline 账号对应一份订阅，多实例的实际用途是配不同 baseUrl，可通过 `baseUrl` 配置字段满足。

## 两个必须先定死的设计决策

这两处都是「后端写 A、前端/宿主读 B」的读写错位风险，在计划评审阶段各出现过一次，
所以都有专门的回归测试钉住。

### 决策 A：`enabledModels` 借用 secret 通道

**问题**：用户在 iframe 里选完模型，`provider.listModels` 必须能读到。但插件命令能写的持久化
只有两个：`storage.set` 和 `secretWrites`。而宿主**只把 secret 注入回 provider 请求的 config**，
不注入 storage。

**选定方案**：`enabledModels` 声明为 configSchema 的 secret 字段，命令用 `secretWrites` 写
`provider.cline.enabledModels`，宿主注入回 `config`，`listModels` 直接读 `config.enabledModels`。
闭环的每一环都已核实：

| 环节 | 依据 |
|---|---|
| 命令能写这个 key | `plugin-command-secret-writes.ts` 的 `parseProviderSecretKey` 只要求 `provider.<contributionId>.<field>`，field 部分不受约束 |
| 宿主会注入回 config | `plugin-provider-credential-resolver.ts` 的 `resolve()` 对每个 secret 字段做 `getSecret` 并合并 |
| 标为 secret 才会被注入 | `secretFieldsOf` 只收 `type:"string"` 且 `isSecretSchemaNode` 为真的顶层属性 |

**因此它必须是 `type: "string"`**（存 JSON 数组的序列化字符串）。声明成 `type: "array"`
更自然，但 `secretFieldsOf` 会静默跳过非 string 属性，注入链断掉且无任何报错。
`cline-external-enabled-models.test.ts` 用宿主真实的
`secretFieldsOf` → `applyCommandSecretWrites` → `PluginSecretVault` →
`PluginProviderCredentialResolver` → `buildCatalog` 全链路钉住这一点。

**代价（如实记录）**：
- 它不是机密。借用 secret 通道是因为这是当前契约下唯一可行路径——`config.write_self` 在
  `plugin-host-services.ts` 里没有对应方法，未实现。
- 宿主配置表单会把它渲染成不回显的密码框，用户只能从插件 iframe 编辑。
- 将来宿主实现 `config.set` 后应迁回普通 config 字段；届时上述测试会因字段不再是 secret 而失败，
  这正是希望的：迁移应是一次有意识的改动，而不是悄悄漂移。

### 决策 B：`listModels` 返回已启用集，不实现分页

OpenRouter 有 300+ 模型。全部灌进宿主模型选择器会淹没其他 provider，所以用户选子集，
`listModels` 只返回这个子集——与内置用 `enabledModels` 做的收窄相同。

**因此不实现分页**。协议支持 `cursor`/`limit`，宿主也会跟随 `nextCursor`
（`plugin-provider-catalog-refresh.ts`），但返回集上界由人的选择决定，永远填不满一页。
为一个填不满单页的列表写分页，是永不执行的代码。全量池改由 `models.search` /
`recommended-models` 两个命令承担，这也是 iframe 里搜索和选择本来就走的路径。

超出 `maxModelPageSize`（manifest 声明 50）时截断并记日志。
`maxModelPageSize` 与代码里的 `MAX_MODELS` 是两份声明（前者是宿主读的数据，后者是代码执行的约束），
`cline-external-models.test.ts` 断言两者一致。


都是那个插件的实际缺陷，不复制，并在代码注释里注明原因：

**1. 命令不读 `input.config`。** `commands.invoke` 只转发 `{contributionId, input, context}`
（`plugin-command-registry.ts`），iframe 的 `commands.execute` 参数是 `.strict()` 的
`{commandId, input, idempotencyKey, expectedVersion}`——**没有任何字段能承载 config**。
它的 e2e 测试手工传了 `{config, ...input}`，所以测不出来。
本插件所有命令走 `secrets.get` 自取，`cline-external-commands.e2e.test.ts` 的 harness
**故意从不在 input 里放 config**。

**2. `provider.generate` 独立实现。** 宿主的 `ProviderGenerateParams` 是
`{mode:"prompt"|"history", ...}`，与 chat 的 `{history, current, tools}` 结构不同。
两种 generate 形态都没有这个字段，等于发空 prompt。

**3. 「hostHints 缺失」= 无代理，不是「宿主没表态」。** 已核实
`plugin-provider-adapter-factory.ts` 的 `injectHints()` 与
`plugin-platform-services.ts` 的 `resolveProviderHostHints()`：宿主只在**有**代理时构建 hints
（`if (!proxyUrl) return undefined`），且只在非空时附加字段。所以宿主**从不发送
present-but-empty 的 hostHints**，缺失是它表达「无代理」的唯一方式。
后果是真实 bug：用过一次代理后，从宿主设置里删除代理，插件会在整个进程生命周期内继续把
上游流量走那个已删除的代理。这正是它自己注释描述的失败，却守在不可能到达的分支上。

## 已验证（自动化）

8 个测试文件，168 项，全部绿：

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `cline-external-history.test.ts` | 31 | 规范格式 → OpenAI messages：文本/图片/工具调用配对/reasoning 丢弃/`"."` 续跑标记/空 assistant 跳过 |
| `cline-external-event-mapping.test.ts` | 33 | SSE → PluginStreamEvent，**每个事件都对宿主真实 `providerStreamEventSchema` 校验**（`.strict()`，能挡住臆造字段）；跨 chunk 的 JSON 转义、usage-only chunk、finish_reason 各分支、错误分类 |
| `cline-external-auth.test.ts` | 22 | 回调 URL 解析（含尾部签名）、过期判定、两个 base URL 的区分、EADDRINUSE 识别 |
| `cline-external-credentials.test.ts` | 22 | 凭据解析、config 注入、刷新的 invalid/failed 语义、refresh token 轮换采纳 |
| `cline-external-models.test.ts` | 14 | 决策 B：只返回已启用集、不带 `nextCursor`、`buildCatalog` **完全不打网络**、截断阈值与 manifest 一致 |
| `cline-external-enabled-models.test.ts` | 11 | 决策 A 全链路，全部用宿主真实服务 |
| `cline-external-commands.e2e.test.ts` | 20 | 真实子进程 + 真实 `PluginHostDispatcher`，命令走 `secrets.get`；`browserAuth` 三态；探测不占用端口 |
| `cline-external-ui-contract.test.ts` | 15 | 读**构建产物**断言 iframe/后端字段名一致：命令 id、`browserAuth` 三值、无 `browserAuthAvailable`、UI 不含 `secrets.*` |

`cline-external-ui-contract.test.ts` 是为这类错误专设的：iframe 边界两侧都是 `unknown`，
字段名错位类型检查抓不到，只会表现为「按钮永远不出现」。

**自动化测试期间发现并修掉的真实缺陷**：manifest 的 `configSchema` 写成了完整 JSON Schema
文档（带 `type`/`properties` 外层）。`parseManifest` 接受它，但
`providerRegistrationsFromManifest` 会再包一层，导致
`PluginProviderRegistry.register` 报 `schema node must be JSON object or boolean` ——
插件根本注册不上。manifest 的 `configSchema` 必须是**裸的 properties map**。

## 未验证

- **不打真实上游**（避免 CI 依赖账号与配额）。代价是上游协议漂移不会被 CI 发现。
- **未在运行中的 NarraFork 里跑过**。项目铁律禁止重启承载当前会话的进程，
  所以下列需要人工确认。

### 需要手工验证

1. 设置页出现 `Cline (External)` 供应商，badge 为 `plugin`
2. 「浏览器登录」跳转 Cline 授权页，回调后 iframe 显示登录态；内置 Cline 已占 19876 时
   显示端口占用提示而非静默失败
3. 「粘贴回调 URL」路径同样能登录成功
4. 「余额」返回真实美元数字
5. 推荐/免费模型列表加载；搜索框能在全量池里搜到模型；选中若干模型保存后
   `cline-ext:<model>` 出现在模型选择器（这条同时验证决策 A 在真实宿主里闭环）
6. 完成一次真实对话，含工具调用与多轮
7. 对话中 token 用量与上下文占用在前端可见
8. 图片输入可用
9. 中断对话（interrupt）能正确取消
10. 重启后凭据与已选模型仍生效
11. 登出后 provider 显示为未配置，重新登录恢复
12. 内置 `cline` 供应商行为完全不变

## 已知差距与风险

**1. 监听 loopback 端口是新开的先例。** 见 `07-security-and-sandbox.md` §6.3。
`permissions.network` 无运行时强制，所以技术上可行；风险面已收窄（只绑 `127.0.0.1`、
只在登录期间、5 分钟超时、`deactivate` 必关），Podman 下不可用并如实上报为
`browserAuth: "unsupported"`。代价是这条先例存在，后续插件可以引用它申请同类能力。

**2. `browserAuth` 探测只在探测那一刻有效。** 内置适配器可能在探测后立刻占用端口。
所以探测**只决定 UI 显示什么**，权威答案永远来自 `auth.browser` 里真实的 bind，
失败时返回 `PORT_IN_USE`。`port_busy` 状态下按钮保持可点（端口占用是瞬时的，
禁用会把可恢复情况变成死路）。

**3. reasoning 块被丢弃。** OpenAI chat/completions 的历史里没有 thinking 块的位置，
OpenRouter 也不要求回传。内置实现同样丢弃（`ClineMessage._reasoningBlocks` 与
`pushAssistantTurn` 的同名参数都带下划线=未使用）。这是与内置一致的行为，不是新增损失，
也是 manifest 声明 `reasoningContinuation: false` 的原因——声明 true 会让宿主
期待插件回传它给不出的东西。

**4. OAuth 解析逻辑存在两份**（内置 + 插件）。上游协议变更需要改两处。
这个代价在「未来取代内置」的目标下是递减的——内置删掉后就只剩一份。
不复用 `server/lib/cline-auth.ts` 是因为它 import `narraforkDir`（宿主家目录），
插件用了就等于碰宿主状态，且会把内置模块锁死成「插件也依赖」，反而妨碍删除。

**5. 两个 Cline provider 会同时出现在设置页**（`cline` 与 `cline-ext`），
也提供 A/B 对照。

**6. 不做 web 搜索贡献。** Cline 没有对应的托管搜索能力，内置也没有 `cline:*` 搜索通道。

**7. 全量模型池只在插件 iframe 内可见**（决策 B 的结果），不进宿主模型选择器。

## 构建

```bash
bun run build:plugin cline-external        # 构建产物
bun scripts/build-plugin.ts --check        # 校验所有插件产物与源码一致
```

产物（`server/index.js`、`ui/provider-settings.iife.js`）提交进仓库，与其他示例插件一致：
`validate-plugin-release.ts` 需要现成产物做 runtime 校验，插件运行器也直接 spawn 该文件。

> `PLUGIN_BUILDS` 派生列表，不再需要在 `package.json` 里逐个列出——那种写法在加入第二个
> 插件的当下就会过期）。
>
