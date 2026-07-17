# NarraFork 插件系统：数据模型与核心接入

> 文档定位：定义插件安装/启用/授权记录、贡献注册表、Provider Registry、配置与 secret scope、namespaced storage、审计、运行时状态和核心接入方式。本文是目标数据模型设计，不代表本轮已经修改 `server/db/schema.ts`、迁移文件或运行时代码。
>
> 与其他文档的关系：`01-requirements-and-boundaries.md` 定义插件边界；`02-host-architecture.md` 定义 Plugin Manager/Capability Broker/Runtime Supervisor；`06-events-query-and-permissions.md` 定义公共事件、Query、Command 和权限语义；`04-server-rpc-and-provider.md` 定义 provider RPC 与 Provider Registry 适配层。

## 0. 标记约定

- **[当前事实]**：当前仓库代码、schema 或既有设计已经确认。
- **[设计建议]**：建议实现的目标数据模型或核心接入方式。
- **[假设]**：为形成可执行方案而采用的暂定前提。
- **[待决策]**：需要后续 ADR、安全评审或发布策略确认。

## 1. 现有数据与配置基线

### 1.1 核心数据库

- **[当前事实]** 当前业务数据位于 `~/.narrafork/narrafork.db`，由 Bun SQLite + Drizzle 管理；schema 主键普遍使用 nanoid 文本，外键删除策略已在各表中明确声明。
- **[当前事实]** 现有核心表包括 `projects`、`chapters`、`chapter_edges`、`narrators`、`narrator_messages`、`narrator_message_refs`、`narrator_tool_calls`、`api_requests`、`background_tasks`、`hooks`、`workspaces`、`remote_devices`、知识库表和缓存表等。
- **[当前事实]** 叙述者消息正文在 `narrator_messages.contentJson/contentText`，工具输入输出在 `narrator_tool_calls.inputJson/outputJson`，provider 原始 dump 在 `api_requests.rawDumpJson`；这些字段属于大字段/敏感字段，列表 API 不应默认读取。
- **[当前事实]** `narrators.messageVersion` 是叙述者消息变更的单调计数；`narrator_message_refs(narratorId, seq)` 提供消息游标分页；`chapter_edges` 和各领域表有面向资源的索引。
- **[当前事实]** 现有 `hooks` 表已经把命令/HTTP hook 配置持久化到核心 DB，并由 `hook-service` 执行；插件系统不应把 hook 表当作通用插件注册表，也不应让插件直接写入该表。
- **[当前事实]** 现有 `knowledge_grants` 采用 `principalType/principalId + grantType + level/tag` 表达知识库双轴授权；插件授权需要独立命名空间和 capability 语义，不能复用知识库授权表来表示插件权限。

### 1.2 文件型 settings

- **[当前事实]** `server/lib/settings/index.ts` 将 `settings.json` 深度合并到内存 singleton，加载时执行历史迁移，保存时通过临时文件 + rename 原子替换并递增 `settingsRevision`。
- **[当前事实]** `server/lib/settings/types.ts` 的 `NarraForkSettings` 同时包含核心 server/agent/chapters、多个 provider 数组、MCP、搜索、VNet、更新、认证和 secret-like 字段；`settingsRoutes` 已有各 provider 的 mask/restore 逻辑。
- **[设计建议]** 插件安装状态、授权、运行时状态、插件配置、secret、provider instance 和插件私有 storage 不加入 `NarraForkSettings`，避免扩大同步文件、破坏核心 settings 迁移、让插件配置混入核心设置或在 GET 时误泄露。
- **[设计建议]** `settingsRoutes.patch` 继续只负责核心 settings；插件配置使用专门的异步 DB/API 门面，并复用“掩码值不覆盖真实 secret”的交互语义，但不复用整个 `NarraForkSettings` schema。

### 1.3 数据库性能基线

- **[当前事实]** CLAUDE.md 禁止主线程执行无界 `.all()`、大范围聚合、全库扫描、FTS rebuild、`VACUUM` 和长事务；列表必须有限字段、游标分页和 `LIMIT n + 1`。
- **[当前事实]** Bun HTTP/WS、SQLite、JSON 序列化、同步 FS/crypto/zlib 共用主线程；高频 WS 事件必须合并/节流/backpressure，子进程输出和文件读取必须有硬上限与超时。
- **[设计建议]** 插件表的每个列表索引必须对应实际过滤/排序，摘要查询不得包含 `manifestJson`、`configJson`、`ciphertext`、`valueJson`、完整审计 payload、模型 metadata 大对象或运行时 stderr。

## 2. 数据模型原则

- **[设计建议] 稳定身份与发布版本分离**：`pluginId` 是 Manifest 身份；`packageId` 是不可变包；`providerInstanceId`、`contributionId` 和 storage/config scope 是宿主生成或校验的稳定引用。
- **[设计建议] 期望状态与运行状态分离**：管理员希望插件启用，不等于运行时已经 active；兼容失败、quarantine、启动失败和运行中断都应保留诊断。
- **[设计建议] 安装、授权、配置、secret、私有数据、审计和运行时记录分表保存；卸载时可独立撤销或保留。
- **[设计建议] 插件不直接读写核心表，不拥有核心事务内的 SQL；核心服务通过 DTO/Command 代理实现原子业务动作。
- **[设计建议] 所有插件相关 JSON 都要有 schemaVersion、byte limit、深度/数组限制和迁移版本；JSON 只是字段载体，不等于无上限 blob。
- **[设计建议] scope 使用受控枚举 `global/user/project/workspace/chapter/narrator/device/provider`，scopeId 由宿主从请求上下文绑定，插件不能任意拼接另一用户或资源 ID。
- **[假设]** v1 使用核心 SQLite 保存插件元数据和小型 namespaced storage；插件包、日志尾部和大附件放在宿主管理的文件目录，不塞进 SQLite 大字段。
- **[待决策]** 插件 secret 的密钥来源采用 OS keyring、独立本机 master key，还是部署级外部 secret manager；下文只规定数据不可明文落库，不预先锁定具体密钥实现。

## 3. 建议的数据表

以下为逻辑 schema。字段类型使用 `text`、`integer`、`boolean`、`json` 等描述；真正落地时必须修改 `server/db/schema.ts` 后运行 `bun run db:generate`，禁止手写 `drizzle/`。

### 3.1 `plugin_packages`：不可变安装包目录

**[设计建议]** 一行代表一个已经被宿主接收并完成静态检查的包版本，不代表该版本正在运行。

```text
plugin_packages
  id                 text PK                         -- packageId
  plugin_id          text NOT NULL
  version            text NOT NULL
  package_hash       text NOT NULL                  -- sha256:...
  manifest_json      json NOT NULL                  -- 受限大小，禁止 secret
  signature_json     json                            -- 签名/来源摘要
  source             text NOT NULL                   -- local/uploaded/builtin
  artifact_rel_path  text NOT NULL                  -- 宿主相对路径，不对插件回显绝对路径
  compatibility     text NOT NULL                   -- unknown/compatible/incompatible
  trust_tier         text NOT NULL                   -- T1/T2/T3
  install_status     text NOT NULL                   -- staged/installed/retained/rejected
  installed_by       text FK users.id NULL
  installed_at       text NOT NULL
  created_at         text NOT NULL
```

- **[设计建议]** 唯一索引 `(plugin_id, version, package_hash)`；索引 `(plugin_id, install_status, installed_at)`。
- **[设计建议]** `artifact_rel_path` 只能由宿主解析到 `~/.narrafork/plugins/<pluginId>/versions/<version>/` 下，不能接受插件提交的绝对路径、`..` 或符号链接逃逸。
- **[设计建议]** 包目录不可变；升级通过新目录 + 原子 current 指针，不覆盖正在运行的目录。
- **[设计建议]** `manifest_json` 只存静态声明和校验后的元数据；provider config schema、UI asset metadata、event filter schema 都受独立大小限制。
- **[当前事实]** 当前仓库没有插件包表；本表是新增设计，不应与现有 `skills` 文件扫描或 MCP server 配置混用。

### 3.2 `plugin_installations`：安装、启用和兼容状态

**[设计建议]** 一行代表一个稳定 `pluginId` 的宿主控制面状态。

```text
plugin_installations
  plugin_id              text PK
  current_package_id     text FK plugin_packages.id NULL
  desired_state          text NOT NULL              -- disabled/enabled/uninstalling
  compatibility_state    text NOT NULL              -- unknown/compatible/incompatible
  runtime_state          text NOT NULL              -- inactive/starting/active/degraded/failed/quarantine
  source                 text NOT NULL              -- local/uploaded/builtin
  trust_tier             text NOT NULL
  enabled_at             text NULL
  disabled_at            text NULL
  quarantine_until       text NULL
  crash_count_window     integer NOT NULL DEFAULT 0
  last_error_code        text NULL
  last_error_summary     text NULL                 -- 脱敏、有长度上限
  last_health_at         text NULL
  created_at             text NOT NULL
  updated_at             text NOT NULL
```

- **[设计建议]** `pluginId` 不能因升级改变；重新安装同一 ID 应先经过兼容/签名检查，不能静默替换另一来源。
- **[设计建议]** `desiredState = enabled` 只表示允许响应激活，不保证立即 spawn；`incompatible`、`quarantine` 会阻止自动激活。
- **[设计建议]** `runtimeState` 是最近一次宿主观察的摘要，不替代 `plugin_runtime_records` 的逐次运行记录。
- **[设计建议]** 对 `last_error_summary`、quarantine reason 和 crash counters 做长度/频率限制，避免错误风暴把 settings 页面或 DB 填满。

### 3.3 `plugin_lifecycle_operations`：安装/升级/卸载 journal

**[设计建议]** 记录可恢复的控制面操作，主机崩溃后能判断继续、回滚或隔离。

```text
plugin_lifecycle_operations
  id                 text PK                         -- operationId
  plugin_id          text NOT NULL
  operation          text NOT NULL                   -- install/enable/disable/upgrade/rollback/uninstall/purge
  state              text NOT NULL                   -- pending/running/succeeded/failed/rolled_back
  from_package_id    text NULL
  to_package_id      text NULL
  initiated_by       text FK users.id NULL
  correlation_id     text NOT NULL
  journal_json       json NOT NULL                   -- 阶段标记，受限大小
  error_code         text NULL
  error_summary      text NULL
  started_at         text NOT NULL
  updated_at         text NOT NULL
  completed_at       text NULL
```

- **[设计建议]** 索引 `(plugin_id, started_at)`、`(state, updated_at)`。
- **[设计建议]** journal 只保存阶段、hash、ID、状态和有界错误摘要，不保存 secret、完整 stderr 或包正文。
- **[设计建议]** 每个 pluginId 使用异步互斥，升级/卸载不能与同一插件的 enable、grant 或 provider refresh 并行写状态。

### 3.4 `plugin_runtime_records`：运行实例与 generation

**[设计建议]** 一行代表一次 runtime generation，便于将迟到消息、崩溃和资源峰值绑定到具体实例。

```text
plugin_runtime_records
  id                 text PK                         -- runtimeId
  plugin_id          text NOT NULL
  package_id         text FK plugin_packages.id NOT NULL
  generation         integer NOT NULL
  runner             text NOT NULL                   -- local-process/podman/other
  pid                integer NULL
  status             text NOT NULL                   -- starting/active/draining/exited/crashed/killed
  activation_reason  text NULL
  started_at         text NOT NULL
  last_heartbeat_at  text NULL
  exited_at          text NULL
  exit_code          integer NULL
  signal             text NULL
  stderr_summary     text NULL                       -- ring buffer摘要，限长
  queue_bytes_peak   integer NOT NULL DEFAULT 0
  in_flight_peak     integer NOT NULL DEFAULT 0
  protocol_errors    integer NOT NULL DEFAULT 0
  created_at         text NOT NULL
```

- **[设计建议]** 唯一约束 `(plugin_id, generation)`；索引 `(plugin_id, started_at)`、`(status, last_heartbeat_at)`。
- **[设计建议]** runtime 表不保存完整 stdout；stdout 仅用于 RPC framing，stderr 进入有界 ring buffer。
- **[设计建议]** `pid`、容器 ID、绝对路径等诊断信息只对管理员返回，不交给普通插件或 UI panel。

### 3.5 `plugin_contributions`：静态贡献注册表

**[设计建议]** 注册表保存 Manifest 校验后的静态贡献，运行时只挂宿主代理，不保存插件导出的函数。

```text
plugin_contributions
  id                 text PK                         -- host contribution row id
  plugin_id          text NOT NULL
  package_id         text FK plugin_packages.id NOT NULL
  contribution_id    text NOT NULL                   -- 插件内 local id
  full_id            text NOT NULL                   -- <pluginId>/<contributionId>
  kind               text NOT NULL                   -- provider/tool/command/event/view/schedule/storage
  display_name       text NOT NULL
  descriptor_json    json NOT NULL                   -- schema、topic、UI 元数据等
  status             text NOT NULL                   -- available/disabled/incompatible/unavailable
  unavailable_reason text NULL
  created_at         text NOT NULL
  updated_at         text NOT NULL
```

- **[设计建议]** 唯一索引 `(plugin_id, contribution_id, kind)` 和 `full_id`；索引 `(kind, status)`。
- **[设计建议]** `full_id` 命名空间必须与核心命令/主题/provider prefix 分开检查；不能依赖“后注册覆盖先注册”。
- **[设计建议]** 插件禁用或崩溃时保留 contribution 行并更新 `status`，使 UI、模型选择器和布局可以显示“不可用原因”。

### 3.6 `plugin_grants`：安装授权与 scope

**[设计建议]** 授权是插件安装状态之外的独立记录；签名可信、官方来源和安装成功都不自动产生 grant。

```text
plugin_grants
  id                   text PK
  plugin_id            text NOT NULL
  contribution_id      text NULL
  capability            text NOT NULL               -- query.read / command.invoke / event.subscribe / ...
  scope_type           text NOT NULL                -- global/user/project/workspace/chapter/narrator/device/provider
  scope_id             text NULL
  constraints_json     json NULL                    -- topic、field、path、rate、model 等白名单
  granted_by           text FK users.id NOT NULL
  granted_at           text NOT NULL
  expires_at           text NULL
  revoked_at           text NULL
  revoke_reason        text NULL
  created_at           text NOT NULL
  updated_at           text NOT NULL
```

- **[设计建议]** 索引 `(plugin_id, revoked_at, capability)`、`(scope_type, scope_id)`、`(contribution_id, capability)`。
- **[设计建议]** `scope_id` 必须在服务层验证归属；例如 `projectId` 必须存在，`narratorId` 必须属于允许的 project，`providerInstanceId` 必须属于该插件或允许的公共 provider。
- **[设计建议]** 允许 grant 到 contribution，也允许安装级 grant；高风险能力应优先绑定具体 contribution，避免“插件内任意代码”共享宽授权。
- **[设计建议]** 授权撤销后立即使缓存失效、取消事件订阅、拒绝新调用和撤销 secret lease；不等待插件主动释放。

### 3.7 `plugin_event_subscriptions`：后端公共事件订阅

**[设计建议]** 后端插件的 Manifest 静态订阅和运行期订阅都要有宿主记录；UI iframe 的临时订阅可只存在 session 内，但同样受 grant 和队列限制。

```text
plugin_event_subscriptions
  id                 text PK
  plugin_id          text NOT NULL
  contribution_id    text NULL
  topic              text NOT NULL
  filter_json        json NULL                       -- 受限 typed filter
  scope_type         text NOT NULL
  scope_id           text NULL
  delivery_mode      text NOT NULL                   -- live/snapshot_live
  status             text NOT NULL                   -- active/paused/revoked
  last_delivery_at   text NULL
  last_error_code    text NULL
  created_at         text NOT NULL
  updated_at         text NOT NULL
```

- **[设计建议]** 唯一索引 `(plugin_id, contribution_id, topic, scope_type, scope_id)`；索引 `(plugin_id, status)`、`(topic, status)`。
- **[设计建议]** 不把 `deliverySeq` 当作永久 cursor 存在这里；v1 没有公共事件全局日志，恢复依赖 Query 对账。
- **[设计建议]** 如果未来启用 durable event log，再增加独立 `plugin_event_offsets(subscriptionId, logPartition, cursor, updatedAt)`，不要改变现有订阅表含义。

### 3.8 `plugin_configs`：普通配置 scope

**[设计建议]** 配置与 secret 分开；配置 API 只返回 schema 允许的普通字段和 secret placeholder。

```text
plugin_configs
  id                 text PK
  plugin_id          text NOT NULL
  scope_type         text NOT NULL                -- global/user/project/workspace/narrator/provider
  scope_id           text NULL
  schema_version     integer NOT NULL
  config_json        json NOT NULL                -- 严禁明文 secret 字段
  revision           integer NOT NULL DEFAULT 1
  updated_by         text FK users.id NULL
  created_at         text NOT NULL
  updated_at         text NOT NULL
```

- **[设计建议]** 唯一索引 `(plugin_id, scope_type, scope_id)`；查询必须按 pluginId + scope 走索引，不能读取某插件全部 config 再在内存过滤。
- **[设计建议]** `config_json` 只保存 JSON Schema 中标记为非 secret 的字段；secret 字段保存 `{ "configured": true, "secretRef": "..." }` 这种非敏感摘要，真实值在 `plugin_secrets`。
- **[设计建议]** 每次写配置使用 `expectedRevision` 乐观并发控制；冲突返回 `CONFIG_CONFLICT`，不静默覆盖另一用户的配置。
- **[假设]** provider instance 的非 secret 配置可以引用一条或多条 `plugin_configs`；如果 provider 需要跨 scope 合并，合并顺序由宿主定义为 global → user → provider，并在发给插件前生成临时快照。

### 3.9 `plugin_secrets`：secret scope 与短期 lease

**[设计建议]** secret 记录只保存密文或外部 vault 引用，永不保存明文；插件只能通过 Secret Broker 在获准调用期间获得短期值。

```text
plugin_secrets
  id                 text PK
  plugin_id          text NOT NULL
  scope_type         text NOT NULL                -- global/user/project/provider
  scope_id           text NULL
  name               text NOT NULL                -- schema property name
  storage_kind       text NOT NULL                -- encrypted_db/os_keyring/external
  ciphertext         text NULL                    -- storage_kind=encrypted_db 时使用
  external_ref       text NULL                    -- 不含 secret 内容的 opaque ref
  key_version        text NULL
  fingerprint        text NULL                    -- 仅用于变更检测，非可逆值
  created_by         text FK users.id NULL
  created_at         text NOT NULL
  updated_at         text NOT NULL
  revoked_at         text NULL
```

- **[设计建议]** 唯一索引 `(plugin_id, scope_type, scope_id, name)`；`fingerprint` 使用不可逆摘要，只用于判断 provider cache 是否需要清理。
- **[设计建议]** Secret Broker 按 `pluginId + secretRef + requestId + deadline` 发放临时 lease；lease 到期、调用取消、插件禁用、权限撤销或 runtime generation 改变时失效。
- **[设计建议]** secret 不进入命令行参数、环境变量快照、普通日志、审计正文、PublicEvent、Query response 或 UI iframe bootstrap。
- **[当前事实]** 当前核心 settings/provider 配置仍有一些 0600 文件中的明文 key/secret；插件设计不应扩大这种暴露面，也不应在本轮未经迁移方案就声称已经替换核心 provider secret 存储。
- **[待决策]** `encrypted_db` 的主密钥来源、轮换和备份恢复策略需由安全/部署文档确定；在此之前，Secret Broker 必须支持“不可用即拒绝调用”，不能 fallback 为明文。

### 3.10 `plugin_storage_entries`：namespaced key-value storage

**[设计建议]** v1 只提供 JSON key-value，不提供 SQL、任意文件路径、blob 拼接或跨插件 join。

```text
plugin_storage_entries
  id                 text PK
  plugin_id          text NOT NULL
  scope_type         text NOT NULL                -- session/device/user/workspace/narrator
  scope_id           text NULL
  key                text NOT NULL
  value_json         json NOT NULL
  value_bytes        integer NOT NULL
  revision           integer NOT NULL DEFAULT 1
  etag               text NOT NULL
  expires_at         text NULL
  created_at         text NOT NULL
  updated_at         text NOT NULL
```

- **[设计建议]** 唯一索引 `(plugin_id, scope_type, scope_id, key)`；索引 `(plugin_id, scope_type, scope_id, updated_at)` 和 `(plugin_id, scope_type, scope_id, key)`。
- **[设计建议]** 宿主强制 namespace，插件不能在 key 中写入另一个 pluginId/userId；key 使用 UTF-8 1–256 bytes，禁止 `..`、控制字符和保留前缀。
- **[设计建议]** `list()` 只返回 key、valueBytes、revision、updatedAt 摘要；只有 `get()` 才按需读取 value，避免列表页读取大 JSON。
- **[设计建议]** `set/delete` 支持 `expectedRevision` 或 `ifMatch`；冲突返回 `STORAGE_CONFLICT`，不进行隐式 last-write-wins。
- **[设计建议]** session scope 只存在内存，不写该表；device scope 可由 UI adapter 选择浏览器存储，但服务端 user/workspace/narrator scope 必须服从同一 quota 和审计规则。
- **[设计建议]** 文件、图片、raw dump、模型缓存和超过单值上限的数据使用宿主受控附件 API；不能通过把 base64 放入 `value_json` 绕过 quota。

### 3.11 `plugin_storage_migrations`：插件私有数据版本

**[设计建议]** 插件数据迁移与核心 schema migration 分离，插件不能自行执行核心 SQL。

```text
plugin_storage_migrations
  id                 text PK
  plugin_id          text NOT NULL
  from_version       integer NOT NULL
  to_version         integer NOT NULL
  state              text NOT NULL                -- pending/running/succeeded/failed/rolled_back
  checksum           text NOT NULL
  progress_json      json NULL                    -- 有界、可恢复 checkpoint
  error_summary      text NULL
  started_at         text NOT NULL
  updated_at         text NOT NULL
  completed_at       text NULL
```

- **[设计建议]** 同一插件只能有一个 active storage migration；升级前先 staging，迁移完成并健康检查成功后才切换 package current。
- **[设计建议]** 迁移 API 只提供受限的 batch get/set/delete、旧版本读取和 checkpoint；批次大小、总字节和总耗时必须有硬上限。
- **[设计建议]** 不可逆迁移必须在升级确认前提示管理员，并在 journal 中记录备份/放弃回滚状态。

### 3.12 `plugin_provider_instances`：Provider Registry 的实例配置

**[设计建议]** provider type 来自 contribution，provider instance 由宿主创建并绑定配置 scope；不能把 provider type 与用户的一组 API key 混成一行静态 Manifest。

```text
plugin_provider_instances
  id                    text PK                 -- providerInstanceId
  plugin_id             text NOT NULL
  contribution_row_id   text FK plugin_contributions.id NOT NULL
  provider_type_id      text NOT NULL           -- <pluginId>/<localProviderId>
  provider_prefix       text NOT NULL           -- 用户可改，宿主校验唯一
  display_name          text NOT NULL
  config_scope_type     text NOT NULL           -- global/user/provider
  config_scope_id       text NULL
  disabled              boolean NOT NULL DEFAULT false
  catalog_version       text NULL
  catalog_stale         boolean NOT NULL DEFAULT true
  last_catalog_refresh  text NULL
  last_error_code       text NULL
  created_by             text FK users.id NULL
  created_at             text NOT NULL
  updated_at             text NOT NULL
```

- **[设计建议]** 唯一索引 `provider_type_id`、`provider_prefix`（按大小写不敏感规则检查）、`(plugin_id, display_name)`；索引 `(plugin_id, disabled)`。
- **[设计建议]** 现有 `settingsRoutes.patch` 已检查 custom provider prefix 冲突；Provider Registry 接入时应把核心 settings provider、compatible API provider 和 executable plugin provider 一并检查，禁止“谁后注册谁覆盖”。
- **[设计建议]** provider instance config 通过 `plugin_configs + plugin_secrets` 解析；宿主每次 `RemoteProviderAdapter` 调用生成临时配置快照，插件不持有核心 settings singleton。

### 3.13 `plugin_provider_models`：last-known model catalog

**[设计建议]** 模型目录使用行式存储，避免 `getVisibleModels` 为了一个模型读取完整 JSON。

```text
plugin_provider_models
  id                    text PK
  provider_instance_id  text NOT NULL
  model_id              text NOT NULL           -- 裸 modelId，可含冒号
  display_name          text NOT NULL
  description           text NULL
  context_window        integer NULL
  max_output_tokens     integer NULL
  capabilities_json     json NOT NULL
  metadata_json         json NULL
  deprecated             boolean NOT NULL DEFAULT false
  catalog_version       text NULL
  fetched_at             text NOT NULL
  stale_at               text NULL
  updated_at             text NOT NULL
```

- **[设计建议]** 唯一索引 `(provider_instance_id, model_id)`；索引 `(provider_instance_id, deprecated, model_id)`、`(provider_instance_id, updated_at)`。
- **[设计建议]** `listModels` 使用 cursor + limit，默认 100、硬上限 200；刷新通过后台任务/激活触发，不能在设置列表请求同步启动插件或访问上游网络。
- **[设计建议]** Provider Registry 保留 last-known-good catalog；插件暂时不可用时 UI 可显示 `stale=true`，实际 chat/generate 前仍需检查 runtime 和配置有效性。
- **[设计建议]** `sessionMode` 未声明时按 `stateful` 处理，避免在未知情况下重放可能已被上游消费的请求；该字段来自 `capabilities_json` 的严格 DTO，不由插件运行时任意覆盖。

### 3.14 `plugin_operations`：公共 Query/Command/Provider operation

**[设计建议]** 记录跨进程异步操作的状态摘要；不把所有流事件和结果正文永久写入核心表。

```text
plugin_operations
  id                  text PK                   -- operationId
  plugin_id           text NOT NULL
  contribution_id     text NULL
  kind                text NOT NULL             -- query/command/provider/event/storage
  method_id           text NOT NULL
  invocation_kind     text NOT NULL             -- user/plugin_background/system
  user_id             text FK users.id NULL
  scope_type          text NULL
  scope_id            text NULL
  idempotency_hash    text NULL
  status              text NOT NULL             -- accepted/running/succeeded/failed/cancelled/unknown
  result_summary_json json NULL                 -- 受限摘要/引用
  error_code          text NULL
  error_summary       text NULL
  request_bytes       integer NOT NULL DEFAULT 0
  response_bytes      integer NOT NULL DEFAULT 0
  started_at          text NOT NULL
  updated_at          text NOT NULL
  completed_at        text NULL
```

- **[设计建议]** `idempotency_hash` 只存不可逆摘要；命令结果如需重取，使用 operation detail Query 或受控 result reference，不把大结果塞进该表。
- **[设计建议]** status=`unknown` 表示宿主超时/插件崩溃后无法确认副作用；不得自动把它改成 failed 并重放有副作用命令。
- **[设计建议]** 长期历史按保留策略清理；清理任务必须分页/分批运行，不能在请求路径全表扫描。

### 3.15 `plugin_audit_log`：跨边界审计

**[设计建议]** 审计记录“谁以什么插件身份对什么资源做了什么”，不保存 secret 或无界 payload。

```text
plugin_audit_log
  id                 text PK
  plugin_id          text NULL
  runtime_id         text NULL
  request_id         text NULL
  correlation_id     text NOT NULL
  user_id            text FK users.id NULL
  principal_kind     text NOT NULL              -- user/plugin_background/system
  operation_kind     text NOT NULL              -- query/command/event/storage/secret/grant/lifecycle
  method_id          text NOT NULL
  capability         text NULL
  resource_type      text NULL
  resource_id        text NULL
  scope_type         text NULL
  scope_id           text NULL
  outcome            text NOT NULL              -- allowed/denied/succeeded/failed/timeout/cancelled/overflow
  duration_ms        integer NULL
  request_bytes      integer NOT NULL DEFAULT 0
  response_bytes     integer NOT NULL DEFAULT 0
  redacted_summary   json NULL
  created_at         text NOT NULL
```

- **[设计建议]** 索引 `(plugin_id, created_at)`、`(user_id, created_at)`、`(operation_kind, created_at)`、`(outcome, created_at)`、`(resource_type, resource_id, created_at)`。
- **[设计建议]** `redacted_summary` 只能是固定字段 allowlist、长度上限和哈希；不记录 API key、secret、JWT、完整正文、完整命令、完整文件内容、完整 tool input/output 或原始 provider response。
- **[设计建议]** 权限拒绝、授权撤销、secret lease、命令决定、事件 overflow、插件协议错误、超时和未知结果必须审计；普通高频状态事件只记录聚合计数或采样，避免审计表成为事件日志替代品。
- **[设计建议]** 审计 Query 仅管理员或拥有 audit capability 的主体可用，并使用 cursor 分页；列表默认只读摘要。

### 3.16 可选 `plugin_event_log`：未来可靠事件扩展

- **[设计建议]** v1 不新增全局 PublicEvent log，不向插件承诺跨重启补发；使用资源 Query + `resyncHint` 对账。
- **[假设]** 如果未来确实需要 at-least-once/可重放事件，再单独增加 append-only `plugin_event_log`：保存已脱敏 envelope、topic、partition、globalCursor、retentionUntil，并以后台 writer/批量写入方式接入，不能在 `eventBus.emit()` 同步写 SQLite。
- **[设计建议]** durable event log 仍需按插件授权过滤，不能因为事件已落库就允许插件读取其他用户资源；过期、压缩、重放和 poison event 要有独立运维策略。
- **[待决策]** 是否需要可靠事件、保留多久、按 topic 还是按项目分区，以及 SQLite 是否足以承载容量，必须在真实使用量和压测后决定。

## 4. 关联、删除和保留策略

### 4.1 外键与多态 scope

- **[设计建议]** `plugin_packages`、`plugin_contributions`、`plugin_runtime_records`、`plugin_provider_instances` 等实体之间使用明确 FK；用户、项目、工作区、章节、叙述者等 scope 采用 `scope_type + scope_id`，由服务层按白名单校验。
- **[设计建议]** 用户删除时，user-scoped config/storage/grant/audit 的处理要有明确策略：默认删除个人数据和授权，但保留不含个人正文的安装/包/生命周期审计摘要；project/workspace/narrator scope 按对应 onDelete 策略清理或转为 orphan。
- **[设计建议]** 插件卸载不默认删除 `plugin_storage_entries`、`plugin_configs` 的普通数据或布局引用；默认撤销 secret/grant、停止 runtime、移除 active contribution，保留可诊断的 orphan 数据。
- **[设计建议]** 只有管理员显式执行 `purge` 才删除插件包、私有 storage、配置和审计中的可删除部分；purge 必须二次确认、记录 operation journal，并不可逆地标记完成。
- **[待决策]** 默认保留期限、回滚包数量、审计保留期限和用户删除后的 orphan 数据清理时间需要发布策略确认。

### 4.2 包文件与 DB 记录一致性

**[设计建议]** 包文件目录和 DB 记录采用“DB journal + 文件 staging + 原子 current 指针”策略：

```text
~/.narrafork/plugins/
  <pluginId>/
    versions/<version>-<hash>/        # 不可变包目录
    current                         # 宿主原子切换的版本引用
    staging/<operationId>/
    data/                            # 插件运行时私有工作目录，不等同于 storage API
    logs/                            # 有界/轮转日志，不是协议 stdout
```

- **[设计建议]** 所有目录位于 NarraFork home 下，不使用会被任务超时清理的 `/tmp` 作为持久数据目录；staging 也要有清理和总空间上限。
- **[设计建议]** DB 只保存逻辑 ID、hash、相对路径和状态；运行时环境由宿主根据当前 package 记录构造，插件不能从参数中选择另一版本目录。
- **[设计建议]** 发现 DB/package 不一致时进入 `degraded` 或 `incompatible`，先阻止激活并给出诊断；不在启动请求路径做全盘扫描或自动执行未知代码。

## 5. 核心接入设计

### 5.1 启动顺序与 `server/app.ts`

**[设计建议]** 保持现有“核心先可用、非关键子系统异步恢复”的启动风格：

1. 完成核心 DB 初始化和 migration。
2. 加载核心 settings、认证和 provider 配置。
3. 恢复 Plugin Manager journal，标记上一次未结束 runtime 为 exited/lost。
4. 只扫描包、Manifest、签名和兼容性，不执行插件代码。
5. 构建 `plugin_contributions`、grants 和 Provider Registry 静态索引。
6. 核心 HTTP/WS 先可用，再异步激活声明了 `onStartup` 或被调用的插件。
7. provider/tool/command/event/view 按激活事件懒启动。

- **[设计建议]** `server/app.ts` 只静态挂载宿主路由，例如 `/api/plugins` 管理/诊断、`/api/plugins/:id/query`、`/api/plugins/:id/command` 和必要的 asset/bridge 路由；插件不能动态注册 Hono route、middleware、全局 error handler 或认证顺序。
- **[设计建议]** 插件管理路由位于全局 `requireAuth` 之后；安装、启用、授权、升级、卸载和 purge 使用 `requireAdmin` 或更细的 admin capability。普通 Query/Command 仍须按当前 user/resource ACL 再检查。
- **[设计建议]** UI iframe 不直接请求这些 API；`05-ui-bridge-and-dockview.md` 的 HostUiBridge 绑定 session 后由宿主代理请求，服务端仍再次校验 pluginId、userId、scope 和 grant。

### 5.2 Event Gateway 与现有 `eventBus`

**[设计建议]** 增加核心内部 `PublicEventGateway`，但不改变 `eventBus` 的公共类型：

```text
core service eventBus.emit()
  → PublicEventGateway.onAny()
  → typed mapper / redaction
  → SubscriptionRegistry 查找候选订阅
  → capability + resource authorization
  → coalesce/throttle/filter
  → per-subscription bounded queue
  → Runtime Supervisor / UI Bridge async delivery
```

- **[设计建议]** 使用类似 `narrator-ws.ts` 的 hot-reload guard，避免 Bun --hot 重载重复注册监听器，造成事件重复、DB 查询 N 倍和队列膨胀。
- **[设计建议]** mapper 只读取 event 已携带的 ID/状态和少量索引字段；若需补充 DTO，排入异步有限查询，不在 `eventBus.emit()` 同步路径做消息树 hydration、raw dump 读取或大 JSON stringify。
- **[设计建议]** 单个插件订阅队列溢出时发送一次 `narrafork.events.overflow` 控制通知，暂停普通事件并要求插件调用 resync Query；不能把 overflow 传播成核心 WS 全局 reload。
- **[设计建议]** 内部 `narrator:ws_broadcast` 和 `narrator:message_broadcast` 继续服务现有 gateway/IM/WS consumer；PublicEventGateway 只选取经过白名单映射的语义事件，不能从所有 narrator WS frame 自动转发。

### 5.3 Query Gateway

**[设计建议]** Query handler 采用“稳定 queryId → Zod input schema → capability/resource check → service/query DTO → projection/redaction → page envelope”的链路：

```text
plugin/UI call
  → resolve PluginPrincipal + InvocationPrincipal
  → parse strict schema
  → check query capability and scope
  → call core query facade
  → select finite columns / indexed cursor
  → map Public DTO
  → audit summary
```

- **[设计建议]** Query facade 可以调用现有 `chapterService`、`narratorService`、`reviewService`、`skillService` 等，但只能返回公共 DTO；不得把 service 方法表暴露成动态 `serviceName/methodName`。
- **[设计建议]** 叙述者消息 Query 默认使用 `narrator_message_refs.seq` cursor，返回 message id、role、时间、状态、content length/hasContent 等摘要；正文、tool input/output、raw dump 必须是单独 capability、单独 detail Query 和独立 byte limit。
- **[设计建议]** 章节 graph Query 必须允许按 project、边类型、节点 cursor 或子图范围限制，不能在请求路径执行无上限全图聚合。
- **[设计建议]** settings Query 只提供宿主声明的 public projection；不能把 `settings` singleton 或所有 provider config 原样 JSON 化返回。

### 5.4 Command Gateway

**[设计建议]** Command facade 只注册业务意图，例如：

| commandId | 作用 | 默认要求 |
|---|---|---|
| `narrafork.narrator.sendMessage` | 向已授权 narrator 发送消息 | user scope、文本/附件限量、可触发核心权限流程 |
| `narrafork.narrator.interrupt` | 中断 narrator turn | narrator control capability |
| `narrafork.permission.decide` | allow/deny 已存在请求 | 当前用户确有该 narrator 控制权；不能伪造 requestId |
| `narrafork.chapter.create` | 创建章节 | project write + Git/资源上限 |
| `narrafork.chapter.fork` | 从章节 fork | chapter write + Git 操作授权 |
| `narrafork.chapter.merge` | 发起合并 | merge capability；返回 async operation |
| `narrafork.review.create` | 创建 review 章节 | project/chapter write |
| `narrafork.routine.set` | 启用/禁用例程 | user/project settings write |
| `narrafork.provider.instance.validate` | 校验 provider 配置 | provider admin/secret use；不持久化插件回显的 secret |
| `narrafork.provider.instance.refreshCatalog` | 异步刷新模型目录 | provider use + rate limit |
| `narrafork.plugin.enable/disable` | 改变插件期望状态 | admin only，不允许插件后台自授予 |

- **[设计建议]** `narrafork.settings.patchCore` 不作为普通插件命令开放；核心 settings 的权限和重启副作用过宽，若未来开放必须按字段 capability 分组，而不是允许任意 JSON patch。
- **[设计建议]** `permission.decide` 必须复用核心 `resolvePermissionOrDangerReflection` 语义，绑定宿主解析的 userId/actor；插件只能代表用户提交决定，不能把自身 grant 伪装成用户 allow。
- **[设计建议]** Command handler 负责 Zod 校验、资源归属、核心服务事务/回滚、幂等键、审计和事件发布；插件只得到结果 DTO 或 operationId。
- **[设计建议]** 高风险命令继续进入 NarraFork 现有权限模式、danger reflection、hook 和设备目标冻结链路；“插件已获 `command.invoke`”不能绕过工具权限、项目 ACL 或用户确认。

### 5.5 Provider Registry 接入

**[设计建议]** Provider Registry 在核心内统一三种来源：

```text
Compatible API provider (settings custom/openai/anthropic/gemini/...)
Executable plugin provider (plugin_provider_instances + RemoteProviderAdapter)
```

接入 `resolveProviderAndModel` 的顺序：

1. 宿主先处理默认模型、summary 模型和 aggregation。
2. 按完整模型值第一个冒号解析 `providerPrefix`，后面的内容保持 opaque `modelId`。
3. Registry 查找 builtin/compatible/plugin entry，并检查 disabled、授权和兼容状态。
4. plugin entry 解析 `providerInstanceId`、配置 scope 和 secret lease，构造 `RemoteProviderAdapter`。
5. 返回给 Agent Loop 的 `provider` 仍保持 prefix 兼容现有 `AgentConfig`；内部审计同时记录 `providerTypeId`、`providerInstanceId` 和 package/runtime generation。
6. provider chat/generate 的取消、流控、usage、错误和 sessionMode 映射遵循 `04-server-rpc-and-provider.md`，工具执行始终回到核心 Agent Loop。

- **[设计建议]** `getVisibleModels`、`getContextWindow`、`providerOrder`、`hiddenModels` 和 aggregation 继续由宿主统一处理；插件模型目录来自 `plugin_provider_models` 的 last-known cache，不在同步 UI 列表请求中启动网络调用。
- **[设计建议]** provider prefix 保存前复用 settings 当前的 reserved/cross-provider conflict 检查，并扩展到 plugin registry；prefix 改名以 `providerInstanceId` 为依据迁移宿主内模型引用，插件不直接修改 `NarraForkSettings`。
- **[设计建议]** provider config 的 schema 与 plugin installation config 分离；Manifest/provider describe 只声明 schema，实际普通值在 `plugin_configs`，secret 在 `plugin_secrets`。
- **[待决策]** plugin provider instance 的配置范围是全局共享、按用户隔离，还是允许两者并存，需结合小团队部署和 provider 账单归属确定；模型目录表可同时支持三种 scope。

### 5.6 Config、Secret 和 settings 的核心边界

- **[设计建议]** 新增独立 `PluginConfigService`，提供 `get/patch/validate/reset`；每次 patch 绑定 pluginId + scope + expectedRevision，严格拒绝未知字段和 secret 明文写入 `config_json`。
- **[设计建议]** 普通配置可在管理员设置页显示，但只显示 schema 允许的字段；secret 字段显示 `configured/masked/fingerprint`，保存时空值或 mask placeholder 表示“保留原值”，与 `settingsRoutes` 当前行为一致。
- **[设计建议]** `settings/index.ts` 的同步文件读写不应被插件 Query/Command 直接调用；插件配置写入 DB 用异步/小事务，必要时通过 config changed event 通知 Provider Registry 刷新。
- **[设计建议]** 核心 settings 中的 provider 配置和插件 provider 配置可以在 UI 上统一展示，但存储、授权、审计和 secret lifecycle 必须可区分；不能因为 UI 合并展示就合并物理 JSON。
- **[设计建议]** config/secret 变更后清理 provider model/quota cache，撤销旧 secret lease，要求 active provider instance 使用新配置重新校验；不得在旧 credential 和新 prefix 之间留下不可解释缓存。

### 5.7 Storage Broker

**[设计建议]** Storage Broker 将 `plugin_storage_entries` 封装为以下有限 API：

```ts
storage.get({ scope, key })
storage.set({ scope, key, value, expectedRevision? })
storage.delete({ scope, key, expectedRevision? })
storage.list({ scope, prefix?, cursor?, limit? })
storage.getQuota({ scope })
```

- **[设计建议]** Broker 在进入 DB 前绑定 namespace、scope resource、quota、expiry 和 JSON schema；插件不能提交 SQL、table name、raw path 或另一个 pluginId。
- **[设计建议]** `list` 使用 cursor + limit，不先执行无界 COUNT；`limit` 默认 50、上限 100，返回 `hasMore/nextCursor`。
- **[设计建议]** storage write 使用单行/小批量事务；跨 scope 批量写不保证与核心业务原子，跨命令工作流使用 operationId、幂等和补偿。
- **[设计建议]** storage 访问记录摘要审计，值正文不进入普通审计；越过单值/总额 quota 时返回结构化 `STORAGE_QUOTA_EXCEEDED`。

## 6. 迁移、升级和回滚策略

### 6.1 核心 schema migration

**[设计建议]** 任何新增/修改核心插件表遵循项目既有唯一流程：

```text
修改 server/db/schema.ts
  → bun run db:generate
  → 代码评审检查 schema/index/FK/性能
  → bun run db:migrate
  → 启动 Plugin Manager
```

- **[当前事实]** CLAUDE.md 明确禁止手动修改 `drizzle/`，禁止未经授权删除 `~/.narrafork/narrafork.db*` 或整个 drizzle 目录；本轮只写设计文档，不会修改这些文件。
- **[设计建议]** 首批 migration 只做 additive tables/indexes，避免重写 `narrator_messages`、`contentJson`、`api_requests.rawDumpJson` 等大表；如需 FK/enum 变更，分成可回滚的小步骤。
- **[设计建议]** 核心 migration 不执行插件代码、不读取插件包、不调用网络、不运行 provider validate；DB migration 完成后才恢复 Plugin Manager。
- **[设计建议]** migration 失败先修复迁移顺序、外键/锁和 SQL；不要自动删除数据库。大表回填、索引重建和清理任务放后台 job/subprocess，避免阻塞 Bun 主线程。

### 6.2 插件包升级

**[设计建议]** 升级采用两阶段 journal：

```text
staging 新包
  → hash/signature/Manifest/Host API/RPC/平台兼容检查
  → 读取 storage migration 声明
  → desired state = upgrading，拒绝新调用
  → drain/cancel 旧 runtime
  → 执行可恢复 plugin storage migration
  → 原子切换 current/package
  → 受限 health activation
  → 成功提交 journal；失败恢复旧 package/grant/runtime
```

- **[设计建议]** 一次只允许一个 active package 写同一插件 storage；不做 v1 蓝绿双写。
- **[设计建议]** 授权默认按 `pluginId + contributionId + capability` 继承，但如果新版本新增高风险 capability，必须重新请求 grant；不能因为同 ID 升级自动扩大权限。
- **[设计建议]** 升级失败保留新包为 rejected/retained，保留旧包用于回滚；diagnostics 不包含 secret/完整日志。
- **[设计建议]** storage migration 不可逆时，升级 UI 必须显式提示；没有备份或可逆 checkpoint 时不能宣称“自动回滚数据”。

### 6.3 禁用和卸载

- **[设计建议] 禁用**：停止新激活 → 暂停订阅和新调用 → cancel/drain → 撤销 runtime lease/secret lease → 停止进程 → 标记 contribution unavailable；保留包、配置、storage、布局占位和审计。
- **[设计建议] 卸载**：先按禁用流程处理，再撤销 grant/secret、移除 active registry、删除可执行包和缓存；默认保留 namespaced storage/config/audit 摘要，等待显式 purge。
- **[设计建议] 强制卸载**：可以跳过插件 deactivate，但不能跳过宿主授权撤销、进程终止、事件退订、provider registry 移除和 journal 写入。
- **[设计建议]** UI/Dockview 中引用已卸载 contribution 时显示 missing placeholder，不静默删除布局；重新安装同 ID 且 contribution 匹配时原位恢复。

## 7. 性能、容量与可靠性上限

以下是 v1 实现基线，数字是安全上限/默认值，不是允许插件自行提高的协商值。

| 对象 | 默认/硬上限 | 处理规则 |
|---|---:|---|
| Manifest/descriptor | 1 MiB | 静态检查，超限不执行 |
| Query/Command request | 256 KiB | 进入 JSON/Zod 前拒绝 |
| Query response | 1 MiB | 大数据改用分页/受控附件 |
| 单 PublicEvent envelope | 256 KiB | mapper 截断/拒绝，不发送完整正文 |
| 单订阅事件队列 | 256 events 或 1 MiB | 状态合并；仍溢出发 overflow/resync |
| 单插件所有事件队列 | 8 MiB | 高水位停发 credit，硬上限失败低优先级流 |
| 控制事件保留 | 4 events 或 64 KiB | cancel/error/done/overflow 不被普通流饿死 |
| 公共事件速率 | 默认 100 events/s/plugin | progress/state 可合并；持续违规隔离 |
| Query 默认 page size | 50 | 硬上限 100；model catalog 可 200 |
| Storage 单值 | 64 KiB | 超限返回 quota/payload error |
| Storage 每插件每 scope | 1 MiB | 不含 session memory；超限拒绝写入 |
| Storage list | 100 items/page | cursor + `LIMIT n + 1` |
| 普通 Query timeout | 15 s | 取消并审计 timeout |
| 普通 Command timeout | 30 s | 长任务返回 operationId |
| 有副作用核心 Command | 60 s soft / 宿主硬 deadline | 超时返回 unknown，不自动重放 |
| PublicEvent filter | 20 predicates、深度 3 | 禁止任意表达式/函数 |
| 审计摘要 | 16 KiB/record | 字段 allowlist + 截断标志 |
| 插件 stderr | 1 MiB ring buffer/process | 丢弃最旧内容，不阻塞协议 |
| DB 小事务 | 单资源/有限行 | 禁止在事件发布路径批量扫全库 |

- **[设计建议]** 上限按 UTF-8 bytes 计算，不按 JavaScript `string.length` 猜测；JSON depth、数组长度、对象 key 数也要单独限制。
- **[设计建议]** Query/Command/Storage 的超时、取消、响应上限和队列等待时间都纳入 `plugin_operations`/audit；队列等待也计入调用方 deadline。
- **[设计建议]** 事件节流顺序是：先授权/范围，再 filter，再按事件类 coalesce/throttle，最后入队；不能先把未授权事件入共享队列再过滤，避免侧信道和无谓内存。
- **[设计建议]** 高频 state 事件按 `(pluginId, subscriptionId, topic, resourceId)` 合并为最新值；progress 事件按时间窗口或百分比采样；permission、command result、lifecycle terminal 状态不得静默丢弃。
- **[设计建议]** 所有列表 Query 采用显式 columns；不得为了方便把 Drizzle `select()` 全行返回给插件，尤其排除 `contentJson`、`outputJson`、`rawDumpJson`、secret ciphertext、stderr 和完整 metadata。

## 8. 审计、诊断与可观测性

- **[设计建议]** 管理员状态页至少展示：pluginId/package/version、兼容性、desired/runtime state、trust tier、grants 摘要、provider instances、runtime generation、PID/runner（管理员）、激活原因、在途数、队列 bytes、最近错误、重启预算和 storage quota。
- **[设计建议]** 每次跨边界 Query/Command/Secret/Storage/Event delivery 记录 requestId、correlationId、pluginId、contribution、capability、scope、principal kind、duration、bytes、outcome；敏感输入只记字段名/哈希/长度。
- **[设计建议]** 诊断区分核心慢、插件慢、上游 provider 慢、队列拥塞、权限拒绝、DB busy、协议错误和取消不响应；不要把所有错误都归为 `INTERNAL_ERROR`。
- **[设计建议]** `plugin_audit_log` 不替代业务审计或公共事件 log；业务命令仍由核心服务写必要的 user/action provenance，插件审计只记录跨边界视角。
- **[设计建议]** 公开给插件的错误使用稳定 code、retryable、operationId/diagnosticId 和有界 message；不得泄露 SQL、绝对路径、密钥来源、JWT 或其他插件的存在细节。

## 9. 测试与验收重点

### 9.1 数据模型

- **[设计建议]** 安装、重复安装、enable/disable、升级 journal 崩溃恢复、回滚、卸载保留和 purge 二次确认都有幂等测试。
- **[设计建议]** 所有 scope 组合验证用户/项目/章节/叙述者归属；删除用户、项目、章节、插件时检查 FK/orphan/secret revoke 行为。
- **[设计建议]** config revision 冲突、masked secret 保留、secret lease 过期、grant 撤销和 provider cache purge 都有测试。
- **[设计建议]** storage 单值/总额 quota、cursor、TTL、并发条件写和迁移 checkpoint 都有边界测试。
- **[设计建议]** Provider Registry 对 builtin、compatible API、plugin prefix 冲突、disabled provider、stale catalog、模型多级冒号和 stateful 默认值有回归测试。

### 9.2 核心运行时

- **[设计建议]** 事件 mapper 不会把 `NarratorServerMessage`、tool input/output、raw dump、container log、browser URL 或 secret 放入 PublicEvent。
- **[设计建议]** eventBus listener 在 Bun --hot 重载后只注册一次；插件处理异常不会阻塞内部 emit、HTTP、WS 或通知服务。
- **[设计建议]** snapshot fence、catch-up buffer overflow、事件 coalesce、resync Query 和 grant revoke 中途退订均有测试。
- **[设计建议]** Query 大字段默认不读取；分页使用 cursor + `LIMIT n + 1`；慢查询、DB busy、插件超时、取消不响应和 late response 都能被审计。
- **[设计建议]** 高风险 Command 不能绕过核心 permission handler、danger reflection、hook、设备目标冻结或 user/admin authority；未知副作用结果不会自动重放。

## 10. 实现切分与待决策

### 10.1 建议实现阶段

1. **[设计建议] 基础数据层**：新增 plugin package/install/lifecycle/grant/contribution/runtime 表和 Plugin Manager 状态读取；只做静态 catalog 与管理员诊断。
2. **[设计建议] Query/Command Gateway**：实现 strict schema、Capability Broker、有限 DTO、cursor、operation、audit；先接 project/chapter/narrator/review 的只读摘要。
3. **[设计建议] Event Gateway**：接入白名单 mapper、脱敏、订阅、snapshot fence、bounded queue、coalesce、overflow/resync；先接 chapter/narrator lifecycle。
4. **[设计建议] Config/Storage/Secret**：实现 scope、revision、quota、migration journal 和 secret lease；不改核心 settings provider 物理存储。
5. **[设计建议] Provider Registry**：接入 `plugin_provider_instances/models`、模型目录缓存和 `RemoteProviderAdapter`；保持现有 builtin/compatible provider 行为不变。
6. **[设计建议] UI Bridge/诊断整合**：将相同 PublicEvent/Query/Command 门面接入 `05-ui-bridge-and-dockview.md` 的 HostUiBridge，并实现 missing/disabled/denied/incompatible 占位。

### 10.2 待决策清单

- **[待决策]** v1 是否需要 durable PublicEvent log；本文默认 at-most-once + Query resync。
- **[待决策]** plugin secret 的 master key/OS keyring/external vault 选型、备份和轮换。
- **[待决策]** provider instance 是全局、按用户，还是两者并存；shared provider secret 的账单与授权归属。
- **[待决策]** plugin audit、operation、package 和 storage 的默认保留期限、空间上限和压缩策略。
- **[待决策]** Podman/local process 对不同 capability 的默认 runner 和 resource limit 是否在数据模型中持久化为 policy scope。
- **[待决策]** 是否允许 plugin Command 在某些场景代表多个用户执行；本文建议不允许，后台执行必须使用独立安装级 grant。
- **[待决策]** 是否开放受控附件/文件 handle API；在开放前，PublicEvent/Query/Storage 均不得承载大文件或 base64 blob。

## 11. 设计结论

- **[设计建议]** 插件公共数据面由 PublicEvent、Query、Command 三个 DTO 门面组成，所有调用都经过 plugin principal、invocation principal、scope、capability、Zod/JSON Schema、限额、脱敏和审计。
- **[设计建议]** 原始 `eventBus` 和 narrator WS 继续是核心内部接口；Event Gateway 只发布白名单语义事件，默认在线 at-most-once，溢出后通过 Query resync。
- **[设计建议]** 安装/启用/运行/授权/配置/secret/storage/provider/audit 分表且生命周期独立；卸载默认撤销运行权限但保留可诊断的私有数据。
- **[设计建议]** Provider Registry 统一 builtin、compatible API 和 executable plugin provider；plugin provider 的 prefix、model catalog、config/secret scope 与现有 settings provider 冲突检查保持一致。
- **[设计建议]** 所有新增核心表必须走 `schema.ts → db:generate → db:migrate`，插件代码不能进入核心 migration 或核心事务；大数据、事件日志、模型目录刷新和清理都必须遵守主线程性能规则。
