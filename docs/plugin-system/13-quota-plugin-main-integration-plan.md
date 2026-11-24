# 额度插件与插件来源：主线整合及验收记录

本记录针对 `7a77c830` 上的候选变更。2026-11-24 构建的 Windows x64 成品已通过额度与来源的真实浏览器验收；宿主 TypeScript 检查单独验收，不由构建或冒烟测试替代。

## 1. 执行范围与固定基线

- 候选分支：`nf/quota-main-7a77c830`；固定验收基准：`NarraFork/NarraFork` 的 `7a77c8306ac68d10ed1e09e6619ef14dfac3f935`。此记录不覆盖随后可能新增的主线提交。
- 迁移使用独立工作树和索引。原分支 `nf/quota-plugin-extract-extend-api-7383d3ba99` 的 HEAD `accc3c2588c67fc0ba89216898391e9ba1518987`、MERGE_HEAD `e440c30aad6f937f44a93d0bb5b3c55b4575d24f` 及 488 项状态路径均由快照复核，未改写原树。
- 宿主版本 0.9.15，Bun 1.4.3；沿用 Manifest v1、`narrafork.rpc/1` 及既有 Host API 版本管理。
- 验证不停止或重启承载会话的服务，不使用业务数据库，不手工改写迁移历史。生成文件、测试日志、二进制和私有快照不作为源码变更提交。

## 2. 总体目标

1. 将额度查询从旧的宿主内置查询路径迁移到普通可安装插件 `io.narrafork.provider-quota@1.0.3`。
2. 支持 GitHub Release、网站 API 和本地可信内置来源，并提供检查更新、手动更新、受控自动更新和内置包重装。
3. 在额度查询中保持 Custom API provider、逐 Key、站点账户、配置代次、runtime 代次和权限 grant 的隔离。
4. 将上游 main 的 WorkerHandle/WorkerPool、Windows Worker 路径、HMR owner、插件关闭屏障、overlay 和 NUG OAuth secret 投影完整保留下来。
5. 修复已确认的额度展示、构建资产可变、来源服务关闭、包 staging Worker 混入状态存储等问题。
6. 形成能够真实合并进 `main` 的候选树，并以新代码重新验证；不以旧提交的历史验收记录替代本轮验证。

## 3. 计划一：将功能迁移到固定主线，不重写原分支

以已核对的内容基线 `f71282f6b87d4443b5963b6512385d7c879e6836` 枚举出 257 个有效变更路径：222 个与快照精确一致，27 个自动三方合并结果经独立回放核对，8 个逐项合并。后续修复和验收均在新树进行。

人工合并点是 `pooled-provider.ts`、`provider.ts`、`compiled-worker.ts` 及其守卫、`main.ts`、`update-recovery-service.test.ts`、`modeltrace-service.ts` 和 `narrator-ws-types.ts`。合并后还用行为测试检查自动合并未能证明的额度目标切换、WS 热加载和凭据保存语义。
- 已保留 main 的新增能力：
  - plugin overlay/global-scope 贡献点
  - appearance/preferences 相关变更
  - NUG OAuth secret 独立投影
  - `WorkerHandle`、通用 WorkerPool 和关闭生命周期
  - Windows plugin launcher/Job 处理
  - shutdown recovery、资源退出屏障和状态/journal 预算修复
- 已删除冲突中的旧宿主额度引擎、旧共享额度契约和旧 catalog-only quota 包；旧 ID `com.narrafork.apikey-quota` 仅作为迁移识别符保留，不再作为运行时执行路径。

### 本次验收的边界

相对固定主线的 265 个变更路径已与迁移清单逐项核对：257 项无遗漏，另 8 项用于关停、编译态 Worker 和包完整性修复及其测试。9 个删除项均列在原迁移清单内，只涉及退役的目录式额度包、旧引擎、传输层及契约。候选树没有未合并项或额外未跟踪文件。最终暂存时仍须核对实际内容；交付前单独复核远端进展，不宣称验证了其他基准。

### 验收标准

- `git diff --name-only --diff-filter=U` 为空。
- 所有冲突标记搜索为空。
- `main` 的 overlay、Worker lifecycle、凭据投影和恢复语义仍存在。
- 额度查询不恢复旧宿主引擎、不恢复 Agent tool 暴露、不恢复主线程 fallback。

## 4. 计划二：额度插件化与权限/凭据隔离

### 目标

把额度查询实现为独立插件，并让宿主只提供有界、可撤销、绑定 runtime/安装身份的连接代理。

### 已完成

- 新增独立包 `io.narrafork.provider-quota@1.0.3`。
- 支持的额度来源包括：
  - DeepSeek 官方余额
  - Kimi Coding
  - OpenCode Go
  - Sub2API / New API 推理 Key 额度
  - New API 站点账户额度
- 额度来源只处理保存的 Custom API provider，不接管 Codex、Command Code、TokenDance、NUG 或其他 provider 插件。
- 插件通过 `quotaSources` 声明，不注册模型、不注册 provider、不作为 Agent tool。
- 插件请求上游只能通过宿主的 `provider.connection.request`，并要求 live `quota.provide` 与 `provider.connection.request` grant。
- API Key、站点 token、用户 ID 和自定义认证头留在宿主；插件只收到短期 reference 和非秘密 target 信息。
- 站点账户请求固定到保存站点根的 `/api/user/self`，不带 query，不跨 origin，不跟随携带凭据的 redirect，不继承推理自定义 headers。
- 查询绑定 provider/config/runtime/package/grant 代次；禁用、卸载、升级、回滚和授权撤销会取消在途查询。
- 旧插件选择迁移保留 `enabled/disabled/revoked/removed` 语义，但不复活旧插件运行路径。

### 设置兼容与端到端验证

旧客户端只提交拆分的 provider 数组，不能表达站点字段。仅在相同提供商 ID、有效推理站点根未变且原额度站点有效时保留原站点配置。统一客户端传回掩码时，仅同一有效额度站点与同一账户可复用已存令牌；明确清空或删除不恢复，也不改变推理 Key 的独立存储。

[设置路由回归](../../server/routes/__tests__/provider-balances.test.ts) 22 项通过。独立归档的查询、请求、运行时、打包及[真实插件生命周期](../../tests/server/integration/plugins/plugin-provider-quota.e2e.test.ts)共 91 项通过，覆盖真实 RPC、撤权、卸载、升级和回滚后的迟到回复。

### 验收标准

- 插件不声明 Agent 工具；额度贡献使用 `quotaSources`。
- tools.invoke 被拒绝，额度通过内部 command/RPC 入口执行。
- 权限撤销后不会继续查询，迟到响应不会写入新代次。
- 站点 token 与推理 Key 不混用，snapshot 不会跨 Key/provider 污染。

## 5. 计划三：通用额度协议与前端展示

### 目标

修复 DeepSeek 明细导致的误判和重复摘要，并让 Sub2API 订阅周期使用通用窗口渲染，不增加宿主品牌分支。

### 已完成

在 [shared/provider-quota.ts](../../shared/provider-quota.ts) 和插件协议中增加了两个可选语义：

- `display: "summary" | "detail"`
  - 缺省保持旧行为：进入摘要。
  - `detail` 只进入详情，不进入余额摘要。
- `quota: "required" | "alternative" | "none"`
  - 缺省等同 `required`。
  - `required` 独立约束额度状态。
  - 同一 snapshot 中的 `alternative` 形成单一来源声明替代池；任一正额或 unlimited 即可用，全部已知且耗尽才 exhausted，未知值阻止错误推断。
  - `none` 仅作说明，不参与额度判定。
  - 不从 id/label/unit 推断分组，不跨 currency 求和。

DeepSeek：

- 总余额输出为 `summary + alternative`。
- Granted / topped-up 输出为 `detail + none`。
- 保留精确十进制 `remainingText`。
- 拒绝重复 currency、科学计数法、无限值、超大值和非法字符。

Sub2API：

- 将日、周、月、5 小时等周期输出到通用 `windows[]`。
- 保留旧 amount 作为 detail 投影，避免旧 DTO 断裂。
- 没有可信 reset 时间时保持 `resetAt: null`。
- 只使用真实 expiry，不从 windowStart 推算到期。

前端：

- 通用额度 view 支持 amount pool、detail rows、窗口、真实 expiry、unlimited 和 unavailable。
- 已过期额度不再显示过期的进度条，改为明确的 Expired/已到期状态，同时保留详情数据。
- `buildProviderQuotaView` 支持调用方传入 `now`；NarratorPanel、ProviderBalanceStatus、provider badge 计算已接入公共时钟。
- 金额摘要保留精确文本，不把小正数四舍五入成耗尽。
- 英文和简体中文文案已补齐。

### 新树验证

- 额度面板、provider 草稿及来源管理共 7 个文件、141 项隔离测试通过。实际零、未知、无限额、来源不可用和过期各自独立；中英文、管理员与普通用户均有覆盖。
- 浮层、API 事件、凭据池及独立加密投影另有 7 个文件、50 项通过，含 NUG OAuth 客户端密钥不进入推理 Key 池。
- Windows 成品的真实浏览器展示和账户切换以第 10 节的本次产物为准。

## 6. 计划四：插件来源、更新和内置重装

### 目标

提供可选来源元数据和管理员更新管理，同时不改变旧插件兼容性、不扩大权限、不自动恢复用户卸载决定。

### 已完成

- 支持可选 `plugin-source.json`，来源可以是：
  - GitHub Release
  - 网站 update API
  - 本地可信 descriptor
- 缺少来源时旧插件继续正常安装、启用、配置和运行，不产生网络请求。
- homepage 可选；缺少 homepage 时不猜测 GitHub、publisher 或 API 地址。
- 更新候选绑定 pluginId、安装 UUID、当前 hash、来源 revision、版本、摘要和 expiry。
- 下载有大小、响应、超时、redirect origin、hash 和取消边界。
- 自动更新默认关闭；新增 capability、runner、网络、文件、process、secret 或信任变化时转人工确认。
- 更新保留既有配置、权限、启停状态和安装身份；卸载不会被自动更新解释为需要重装。
- 内置 Provider Quota 是普通可安装 archive，允许卸载；插件页可显式重装。
- 新增独立参考发布服务、发布 CLI、内容寻址资产和 latest API 文档。
- 来源服务已改为 HMR 单 owner；`stop()` 幂等并返回同一 Promise；提交前可取消，提交后等待真实结果；哈希 Worker 退出失败会保留 owner 并显式失败。

### 新树验证

来源与热加载组合 98 项通过。来源绑定、禁用状态更新、校验和不符时保留原包、重启后来源及失败摘要恢复、卸载，均由同一 Windows 成品的来源冒烟实际验证。首次清理失败与随后复验的区别见第 10 节。

## 7. 计划五：构建资产不可变性

### 目标

修复 canonical `dist` 与内容寻址缓存共享 inode 导致的可变缓存问题。

### 已完成

- `plugins/provider-quota/build.ts` 使用独占 lock 和 staging。
- 完整 archive 在 staging 中完成并校验后再发布。
- `scripts/build-bundled-plugins.ts` 将归档复制到独立 SHA-256 内容寻址缓存，不再让缓存与 canonical dist 共享 inode。
- metadata 也以内容寻址路径冻结。
- collector 使用私有 `.narrafork` build 输出，避免 local-runtime 构建改写插件 dist 或 generated 文件。
- generator 对 generated module 使用临时文件 + fsync + rename。
- 未知旧锁不自动删除；发布失败保留旧结果和恢复证据。

### 新树验证

[构建资产专项](../../tests/scripts/build-bundled-plugins.test.ts) 19 项通过：包括发布竞争、损坏拒绝、元数据和归档一致性、缓存独立性，以及移除外部材料后加载真实内嵌归档。[冻结运行时回归](../../server/runtime-assets.compiled.test.ts) 3 项通过，用 A/B/A 三次启动验证不同构建的归档字节隔离。

## 8. 计划六：包 staging Worker 与状态存储隔离

### 目标

避免 `plugin-state-store.ts` 被作为 Worker 入口导入时注册包 staging 消息处理器；保持所有 ZIP、签名和 SBOM 工作在隔离 Worker，不允许主线程 fallback。

### 已完成

- 新增 [server/services/plugin-package-stage-protocol.ts](../../server/services/plugin-package-stage-protocol.ts)。
- 新增 [server/services/plugin-package-stage-worker.ts](../../server/services/plugin-package-stage-worker.ts)。
- `plugin-state-store.ts` 不再注册 package staging `parentPort` handler。
- `server/lib/compiled-worker.ts` 已把入口从 `services/plugin-state-store.ts` 改为 `services/plugin-package-stage-worker.ts`。
- package Worker 有：
  - 16 MiB buffered input 上限
  - 2 MiB response 上限
  - 64 KiB control 上限
  - 120 秒总预算
  - startup/exit timeout
  - staging → verify 顺序
  - signature/SBOM trust policy
  - 真实 Worker exit owner
- 失败、超时、禁用、创建异常和终止失败均显式失败，不在主线程执行包计算。

### 新树验证

[Windows 编译态 Worker 探针](../../server/lib/compiled-worker.compiled.test.ts)在同一 exe 中分别运行包暂存和 DOCX 预览，核对业务输出及两个线程实际退出；含该探针的 6 文件组合 84 项通过。包 Worker 在提交和激活边界重算已安装文件的内容摘要，变化即拒绝；这不构成对外部并发写入的原子封存。包、管理器与运行时等 6 文件的完整性回归 234 项通过。

## 9. 计划七：上游 main 的 Worker、凭据和退出生命周期

### 目标

保留 固定主线的 Worker runtime 和退出屏障，同时把额度插件/来源任务接入同一生命周期。

### 已完成

- DB Worker 池使用 main 的 `connectCompiledWorker`、`WorkerHandle` 和 Windows virtual path 规范化。
- credential pool 的 selection、cooldown、affinity、quota exhaustion 语义已保留。
- PluginManager 使用 HMR 单 owner、runtime event drain、uncertain Worker owner 和关闭失败传播。
- manager 单独调用的默认超时并非宿主停机预算。宿主先同步停止接单，再按主线业务 30 秒、全局 50 秒预算排空；reader 关闭前和交锁前分别检查真实剩余工作。
- RPC 超时或取消不释放仍在执行的宿主处理、审计、状态写入或进程所有权。来源摘要的调用方先超时，也不会使底层写入提前视为结束。有未排空工作时不写干净关停标记、不提前交锁。
- 已激活的 runtime 可在 `stopProducers()` 后继续服务，新的 activation/restart 被拒绝，显式 shutdown 才关闭。关停、dispatcher、RPC 和 runtime 组合 124 项通过。

## 10. 本次 Windows 构建与真实浏览器验收

在候选树用冻结依赖依次构建前端、规范插件归档、本地 runtime 和 Windows x64 可执行文件。路由树由正常构建生成。下列摘要标识实际测试文件，不是发布声明。

| 实际文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| Provider Quota 1.0.3 归档 | 75,527 | `5491feaad8e0d35a92b9f49edfc24eb02c618d0fc6710fdca3a235c486c7a24f` |
| 归档元数据 | 189 | `69d9cc15b159ccfeba231b8c9d29dcf58f76803cdd6f2bc386ce51ee5f746577` |
| 本地 runtime（内嵌前端） | 202,358,272 | `473eb43208f0d144b938c96ecbbfadfd55b90fe98cdfaa53fb4055afb8fe68d2` |
| `narrafork-0.9.15-windows-x64.exe` | 205,557,760 | `f40e4176d4f2c49599477ebf93b6807695f341f568512fedb6a9554e7f961a18` |

规范归档、私有构建输出、内容寻址缓存逐字节一致；规范文件与缓存不共享文件身份，内嵌模块引用同一摘要。两组冒烟用同一份发行格式 exe 和归档，分别创建独立 HOME、数据库、端口和 Edge 配置，无源码、`node_modules` 或系统 Bun 回退。

| 原生验收 | 结果 | 清理证据 |
| --- | --- | --- |
| [额度](../../scripts/smoke-provider-quota.ts) | 56/56，`finalAcceptance=true` | 4 个受管进程均观察到退出并关闭，独立 HOME 清理成功 |
| [插件来源](../../scripts/smoke-plugin-sources.ts) | 第二次 12/12，`finalAcceptance=true` | 3 个受管进程均观察到退出并关闭，独立 HOME 清理成功 |

首次来源冒烟通过了重启后的来源绑定与 `hash_mismatch` 摘要恢复，但最后清理测试 HOME 失败，**该次不通过**。同一成品在新隔离目录完整复验，未放宽超时或清理要求。冒烟报告已改为显示实际失败阶段和脱敏的底层原因；相关报告与夹具测试 17 项通过。各套隔离测试有重叠，不相加为总通过数。

## 11. 静态检查与提交条件

- 已通过：冻结安装根目录与扩展依赖；262 个 SQLite 迁移及 261 份快照校验；样式规则和双语检查。样式脚本有 48 条非阻塞字号提醒，翻译检查有额外键提示。
- 全仓 Biome 2.4.12 已通过：按 Git 实际交付字节检查 7,329 个文件，包括当时尚未暂存的修复。退出码 0，0 个错误、552 个警告、5 条提示；未放宽规则，也未重写整仓换行。
- 独立插件按自己的 `tsconfig.json` 类型检查通过。宿主整仓检查超时；随后对 6,713 个根文件分 21 批检查，第一批因内存不足退出。缩至一个根文件并保留共享声明后仍内存不足。宿主类型检查未完成，0/21 批通过。
- 按维护者决定，本次本地提交不再等待宿主类型检查；不把这项检查记为通过，也不改变 CI 的检查要求。提交范围限于已审查的候选变更，不推送、不创建 PR、不发布。
