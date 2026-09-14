# 服务端 RPC 与模型供应商插件协议

## 1. 文档定位

本文设计 NarraFork 模型供应商插件的服务端协议，重点覆盖：

- JSON-RPC 2.0 over stdio 的进程通信；
- 协议版本协商与兼容策略；
- `provider.describe`、`provider.validateConfig`、`provider.listModels`、
  `provider.chat`、`provider.generate`、`provider.cancel`、`provider.search`；
- 文本、推理、工具调用、usage、error、done 的流式事件；
- `AbortSignal`、超时、取消、背压、输出上限和进程故障；
- `RemoteProviderAdapter` 到现有 `ProviderAdapter`、Agent Loop 的映射；
- provider/model 标识符规则；
- 兼容 API 配置与可执行供应商插件的分层。

本文不修改当前源码，也不要求本阶段立即实现数据库结构、设置页面或插件安装流程。
Manifest、权限授予、沙箱和安装包格式由插件系统其他设计文档统一；本文只定义与这些部分的接口边界。

### 1.1 状态标记

本文使用以下标记明确区分信息性质：

- **当前事实**：来自当前仓库代码或测试的行为。
- **设计建议**：本文建议未来实现采用的协议或架构。
- **设计假设**：为完成本设计暂时采用、但需要与其他设计文档对齐的前提。
- **待决策**：在实现前仍需产品、架构或安全层确认的事项。

---

## 2. 当前代码事实与约束

### 2.1 `ProviderAdapter` 不是纯网络客户端接口

**当前事实**：`server/lib/agent/provider.ts` 中的 `ProviderAdapter` 同时负责四类工作：

1. 把 NarraFork 工具定义转换成供应商工具格式：`formatTools`；
2. 把数据库消息转换成供应商历史格式：`buildHistory`；
3. 在 Agent Loop 中增量维护历史：`injectSystemPrompt`、`pushUserTurn`、
   `pushAssistantTurn`、`formatToolResult`；
4. 执行模型请求：`chat`、`generate`、`generateWithMeta`、
   `generateWithHistory`。

`history`、`tools`、`toolResults` 在现有接口中都是 `unknown[]`，实际内容由各适配器自行约定。
因此不能简单地把当前 `ProviderAdapter` 的每个方法都变成跨进程 RPC：其中多项方法是同步方法，
也位于 Agent Loop 的高频路径中。

**设计结论**：`RemoteProviderAdapter` 应在宿主进程内完成规范化 history、tool 和 tool result 的构造；
插件进程只负责把规范化请求翻译为供应商专有协议，并把专有响应翻译为规范化流事件。
这样不需要增加 `provider.formatTools`、`provider.buildHistory` 等 RPC 方法，也不会把数据库消息原样暴露给插件。

### 2.2 Agent Loop 对供应商流的关键依赖

**当前事实**：`server/lib/agent/loop.ts` 当前依赖以下行为：

- 每次请求前通过 `resolveProviderAndModel` 得到适配器和有效模型；
- provider/model 在运行时切换时会重新构造适配器和工具格式，并要求调用方重建 history；
- `chat` 返回 `AsyncGenerator<ParsedStreamEvent>`；
- `ChatParams.signal` 是实际请求的取消信号；
- provider 应在“请求已组装、即将交给上游传输”时调用 `onRequestStart`；
- 首个有意义事件超时由 Agent Loop 管理，而不是由具体 provider 重复实现；
- 文本、推理、工具参数可以增量到达；
- 工具调用一旦完整，Agent Loop 可能在模型仍继续输出时提前执行工具；
- 相同 `toolUseId` 会去重；
- 中断时，已经完成的 eager tool result 仍要先持久化；
- stateless provider 可由 Agent Loop 原地重试；stateful provider 不应在内层盲目重放；
- 工具已经开始执行后遇到可重试流错误时，不能再次重放同一模型请求；
- 空响应、只有推理的死回合、不完整工具参数、上下文溢出、输出上限和瞬态错误具有不同恢复路径；
- provider 的一次流结束不等于 Agent Loop 完成；只有当前轮没有工具调用时，Agent Loop 才产生自身的
  `AgentEvent { type: "done" }`。

**设计结论**：插件流的 `done` 只能表示“本次上游模型请求结束”，绝不能直接映射成 Agent Loop 的
`done`。是否继续执行工具、进入下一轮或结束叙述，仍由 Agent Loop 决定。

### 2.3 当前流事件已经包含的语义

**当前事实**：`ParsedStreamEvent` 已覆盖：

- 文本和文本输出顺序；
- 完整工具调用和流式工具参数；
- 推理文本、推理顺序和供应商续接元数据；
- redacted thinking；
- token usage、context usage、metering；
- message/conversation/response ID；
- credential ID；
- invalid state、queue/quota 状态；
- stop reason；
- 当前内置 provider 还支持原生 web search 和 image generation 事件。

**设计建议**：供应商插件协议 v1 先把文本、推理、工具调用、usage、error、done 定义为必需核心，
把原生 web search、image generation、queue/quota 等定义为可选扩展能力。插件不能用未知字段偷偷改变
Agent Loop 语义。

### 2.4 provider 与 model 标识现状

**当前事实**：

- 模型值采用 `provider:model`；
- `parseModelId` 只按第一个冒号拆分，因此 model 部分可以继续包含冒号；
- provider 配置有稳定 `id`，同时有用户可修改的 `prefix`；
- `prefix` 修改时，现有代码会迁移默认模型、摘要模型、聚合、隐藏模型、上下文窗口等引用；
- 显式指定但未配置的 provider 会报错，不会静默回退；相关行为已有测试保护；
- `__default__`、`__summary__`、`__agg__:` 是宿主侧元模型语义，不能发送给上游插件；
- 模型聚合的 priority/balanced 路由由宿主负责，插件只看到最终选中的具体 provider/model。

**设计结论**：插件协议必须区分稳定 provider instance ID、用户路由 prefix 和插件返回的裸 model ID，
不能把三者合并成一个可变字符串。

### 2.5 MCP stdio 的可复用经验

**当前事实**：当前 MCP 实现已经支持：

- `command`、`args`、`cwd`、`env` 的 stdio 子进程配置；
- stdout 作为协议通道、stderr 使用 pipe；
- 连接和发现阶段超时；
- 断开后的有限次自动重连；
- `AbortSignal` 向远程调用传播；
- 配置变化后重连；
- 每个 MCP server 独立管理连接和状态。

**设计建议**：供应商插件进程管理可复用相同的生命周期思想，但不直接复用 MCP 协议对象。
模型流比普通工具调用持续更久、吞吐更高，并且会触发 eager tool execution，因此需要额外的操作 ID、
流序号、credit 背压和更严格的终止语义。

### 2.6 相关测试体现的兼容要求

**当前事实**：现有测试已经覆盖并约束：

- 禁用或未知 provider 必须明确失败；
- provider prefix 与默认模型/聚合解析；
- `AbortSignal` 中断时保留已完成工具结果；
- 工具参数可跨 chunk，JSON 转义也可能跨 chunk；
- 工具开始执行后，截断流不能自动重放；
- 只有推理的响应不应形成空 assistant message；
- 没有名称的“幽灵”工具 chunk 不算可持久化输出；
- usage、reasoning、工具顺序和供应商签名来源需要保存；
- retryable 与 hard quota/context overflow 等错误必须分类，而不是只依赖错误字符串。

**设计结论**：远程插件接入不能绕开上述 Agent Loop 行为；新增测试应以同一组契约验证
`RemoteProviderAdapter`。

---

## 3. 目标、非目标与信任边界

### 3.1 目标

**设计建议**：协议应满足：

1. 任意语言可实现，不要求插件使用 Bun/TypeScript；
2. 插件进程不能在 NarraFork 服务端进程内执行任意 JavaScript；
3. 支持长时间、多事件、可取消的流式模型请求；
4. 支持同一进程内有限并发，同时避免无界缓存；
5. 插件可以实现专有认证、模型发现、请求格式和响应解析；
6. Agent Loop 保留工具执行、权限审批、重试、历史持久化和结束判断的所有权；
7. 兼容 API 配置继续使用宿主内置适配器，不被迫包装成可执行插件；
8. 协议错误、供应商错误、取消和进程崩溃可以被稳定区分。

### 3.2 非目标

**设计建议**：v1 不提供以下能力：

- 插件直接访问数据库、Drizzle、原始 `eventBus`、内部 service 或 JWT；
- 插件直接执行 NarraFork 工具；
- 插件自行决定工具权限；
- 插件修改 Agent Loop 的轮次、重试或 compact 策略；
- 将 npm 包动态 `import` 到 NarraFork 服务端进程；
- 在 provider RPC 中传递任意宿主对象、函数或 `AbortSignal` 本体；
- 用 RPC 传输未经限制的原始请求/响应 dump；
- v1 核心协议承诺二进制附件、原生搜索和图像生成输出。

### 3.3 信任边界

**设计假设**：可执行供应商插件是独立 OS 进程。它能读取宿主明确传给它的配置、请求上下文和模型内容，
也能主动发起网络请求；是否进一步用 Podman、低权限用户或文件系统隔离，由安全设计文档决定。

**设计建议**：默认不向插件传递真实 `cwd`。当前 `ChatParams.cwd` 主要属于宿主执行上下文，
供应商插件若需要工作区遥测，应在 Manifest 中声明权限，并由宿主只传递经过授权的 workspace metadata。
模型正常推理不应依赖读取宿主文件系统。

---

## 4. 分层架构

### 4.1 总体调用链

**设计建议**：

```text
Agent Loop
  -> Provider Registry
      -> BuiltinProviderAdapter
      -> CompatibleApiProviderAdapter
      -> RemoteProviderAdapter
           -> ProviderProcessManager
                -> JSON-RPC 2.0 / stdio
                     -> executable provider plugin
                          -> vendor API / local model runtime
```

Provider Registry 对上统一返回现有 `ProviderAdapter`。Agent Loop 不需要知道适配器是在进程内还是进程外。

### 4.2 兼容 API 与可执行插件分层

**设计建议**：保留三个明确层级。

| 层级 | 典型场景 | 执行位置 | 协议转换位置 | 风险与成本 |
| --- | --- | --- | --- | --- |
| 内置 provider | Codex 等核心集成 | NarraFork 进程 | 内置适配器 | 核心维护，权限最高 |
| 兼容 API provider | OpenAI/Anthropic/Gemini 兼容端点 | NarraFork 进程 | 现有通用适配器 | 无额外可执行代码，优先选择 |
| 可执行 provider 插件 | 专有 SDK、OAuth、私有流协议、本地推理桥 | 独立进程 | 插件进程 | 需安装、授权、隔离和进程管理 |

**设计结论**：

- “填写 base URL/API key/兼容协议”属于兼容 API 层；
- “安装一个可执行文件并运行供应商逻辑”属于插件层；
- 宿主不能因为某个兼容 API 配置失败就自动下载或执行插件；
- 插件也不应伪装成兼容 API 配置，以绕过可执行代码权限提示；
- 两层最终都注册到 Provider Registry，因此默认模型、聚合、隐藏模型、排序和上下文窗口可以复用；
- UI 必须明确显示 provider 来源类型。

---

## 5. 标识符与模型目录

### 5.1 标识符层次

**设计建议**：定义以下标识符。

| 名称 | 示例 | 稳定性 | 所有者 | 用途 |
| --- | --- | --- | --- | --- |
| `pluginId` | `com.acme.ai` | 随插件身份稳定 | Manifest | 插件包身份 |
| `providerTypeId` | `com.acme.ai/main` | 随插件贡献稳定 | 插件 + 宿主规范化 | 指定插件中的 provider 类型 |
| `providerInstanceId` | `p_8chars` | 配置生命周期内稳定 | 宿主 | 关联配置、状态、审计和 prefix 迁移 |
| `providerPrefix` | `acme` | 用户可修改 | 用户/宿主 | 模型路由前缀 |
| `modelId` | `reasoning:model-v2` | 由 provider 目录定义 | 插件 | provider 内的裸模型 ID |
| 完整模型值 | `acme:reasoning:model-v2` | 由 prefix + modelId 组成 | 宿主 | 与现有 settings/Agent Loop 兼容 |

`providerTypeId` 的建议构造为 `${pluginId}/${localProviderId}`。一个可执行进程可以在
`provider.describe` 中声明多个 provider type；多数插件只返回一个。

### 5.2 字符与冲突规则

**设计建议**：

- `localProviderId`：`[a-z][a-z0-9._-]{0,63}`；
- `providerPrefix`：1–32 个可见 ASCII 字符，禁止冒号、空白、控制字符；
- prefix 应按大小写不敏感规则检查唯一性，但持久化时保留用户输入；
- `providerPrefix` 不能使用 `__agg__`、`__default__`、`__summary__` 等保留字；
- `modelId` 是 provider 内 opaque string，UTF-8 最大 256 bytes，可以包含冒号；
- `modelId` 禁止空字符串、控制字符和宿主元模型占位符；
- 完整模型值始终由宿主拼接，插件不得返回已经带用户 prefix 的值；
- alias 只用于输入兼容，不作为新持久化值；宿主应保存目录返回的 canonical `modelId`。

**当前事实保持**：完整模型值仍按第一个冒号拆分，因此多级 channel 模型仍可表达。

### 5.3 prefix 修改

**设计建议**：prefix 修改以稳定 `providerInstanceId` 为依据，继续迁移所有宿主侧模型引用。
插件只接收新的 prefix，不参与修改 NarraFork settings。

### 5.4 模型描述

**设计建议**：`provider.listModels` 返回：

```ts
interface ProviderModelDescriptor {
	id: string; // 裸 modelId，不含 providerPrefix
	displayName: string;
	description?: string;
	aliases?: string[];
	contextWindow?: number;
	maxOutputTokens?: number;
	deprecated?: boolean;
	deprecationMessage?: string;
	capabilities: {
		chat: boolean;
		generate: boolean;
		streaming: boolean;
		tools: boolean;
		parallelToolCalls?: boolean;
		inputImages?: boolean;
		reasoning?: boolean;
		reasoningEfforts?: Array<"none" | "low" | "medium" | "high" | "xhigh" | "max">;
		// stateless 才允许 Agent Loop 在未执行工具时原地重试同一请求。
		sessionMode: "stateless" | "stateful";
	};
	metadata?: Record<string, JsonValue>;
}
```

**设计建议**：插件未声明 `sessionMode` 时，宿主按 `stateful` 处理。这是保守默认值，避免在未知情况下
重复提交已经被上游消费的请求。

---

## 6. 进程模型与生命周期

### 6.1 默认进程粒度

**设计建议**：默认每个启用的 `providerInstanceId` 启动一个长驻插件进程，而不是所有实例共享一个进程。
理由：

- 配置和密钥边界清晰；
- prefix/模型目录缓存互不污染；
- 某一实例超时需要强制终止时，不影响其他实例；
- 与当前每个 MCP server 独立连接的管理方式一致；
- stateful session 和 credential affinity 更容易管理。

插件 Manifest 可以声明支持共享 worker，但 v1 宿主不必实现共享进程优化。

### 6.2 stdio 分工

**设计建议**：

- stdin：宿主发给插件的 JSON-RPC frame；
- stdout：插件发给宿主的 JSON-RPC frame，禁止普通日志；
- stderr：插件日志；
- stdout 出现非协议字节视为协议错误；
- stderr 使用有界 ring buffer，供诊断查看，但不能无限积累；
- 命令、参数、cwd、环境变量由安装和安全层生成，不能由 provider 配置任意拼接 shell 字符串。

### 6.3 状态机

**设计建议**：

```text
stopped
  -> starting
  -> describing
  -> ready
  -> degraded       // 单次调用失败，进程仍可用
  -> restarting     // 非预期退出或协议错误
  -> disabled       // 用户禁用或连续失败熔断
```

进程非预期退出时：

- 所有未完成 operation 以 transport/process error 结束；
- 宿主不得在进程管理层自动重放 `provider.chat`；
- 是否重试由 Agent Loop 根据 stateful、是否已产生工具调用等条件决定；
- 重启采用有限次数指数退避；
- 连续协议违规应熔断，而不是无限重启。

---

## 7. JSON-RPC 2.0 over stdio

### 7.1 双层版本

**设计建议**：区分：

- JSON-RPC envelope 固定为 `"jsonrpc": "2.0"`；
- NarraFork Provider RPC 协议初始版本为 `"1.0"`。

Provider RPC 版本只使用 `major.minor`：

- major 不同：不兼容，拒绝启用；
- 同 major、插件 minor 较低：宿主只能使用插件已声明能力；
- 同 major、插件 minor 较高：插件必须保持旧字段语义，并允许宿主忽略新增可选字段；
- 删除字段、改变既有字段语义或改变事件顺序要求必须升 major；
- 新增可选方法、字段或事件能力可以升 minor。

### 7.2 frame 格式

**设计建议**：不使用“一行一个 JSON”的 NDJSON。采用长度前缀 frame，以支持大 history、JSON 内换行和
稳定的字节上限。

```text
Content-Length: <UTF-8 body byte length>\r\n
Content-Type: application/json; charset=utf-8\r\n
\r\n
<one JSON-RPC object>
```

规则：

1. `Content-Length` 必需，按 UTF-8 bytes 计算；
2. header 名大小写不敏感；
3. header 以 `\r\n\r\n` 结束；
4. body 必须是单个 JSON-RPC request、response 或 notification object；
5. v1 禁止 JSON-RPC batch；
6. parser 必须支持 header/body 被拆成任意数量的 stdio chunk；
7. 一个 stdio chunk 可以包含多个完整 frame；
8. body 未达到声明长度前不得尝试 JSON parse；
9. 超长 header、非法长度、无效 UTF-8、无效 JSON 都是协议错误；
10. 插件的多个并发 operation 必须通过单一写锁串行写 stdout frame，禁止字节交叉。

示例：

```text
Content-Length: 104\r\n
Content-Type: application/json; charset=utf-8\r\n
\r\n
{"jsonrpc":"2.0","id":"rpc_1","method":"provider.describe","params":{"protocolVersions":["1.0"]}}
```

### 7.3 JSON-RPC ID 与 operation ID

**设计建议**：

- JSON-RPC `id` 只关联一次 request/response；
- `operationId` 关联一个长时间流式操作；
- `operationId` 由宿主生成，在同一进程生命周期内唯一，建议格式
  `op_<random-or-monotonic-id>`；
- `provider.chat`/`provider.generate` 的 JSON-RPC response 只表示“已接受操作”；
- 后续内容通过 `provider.event` notification 发送；
- `provider.cancel` 使用 `operationId`，不依赖 JSON-RPC 的 `$/cancelRequest`。

这种设计避免让一个长时间未返回的 JSON-RPC request 同时承担流完成和取消语义，也便于统一处理 chat
与 generate。

### 7.4 接受边界

**设计建议**：

- 在返回 `{ accepted: true }` 前，插件应完成参数结构检查、provider type 检查、插件自身的并发策略检查
  （必要时排队/节流或返回 busy）和明显的 model/config 检查；
- 接受前失败使用 JSON-RPC error response；
- 接受后失败必须发送 `provider.event` 的 `error`，随后发送 `done`；
- 宿主必须先登记 operation，再写入请求，以免插件快速回事件时出现未登记竞态；
- 插件应先回复 accepted，再开始上游请求和流事件。

---

## 8. 握手与 `provider.describe`

### 8.1 请求

**设计建议**：进程启动后第一个业务请求必须是 `provider.describe`。

```json
{
  "jsonrpc": "2.0",
  "id": "rpc_1",
  "method": "provider.describe",
  "params": {
    "protocolVersions": ["1.0"],
    "host": {
      "name": "narrafork",
      "version": "<host-version>",
      "platform": "linux",
      "arch": "x64"
    },
    "limits": {
      "maxInboundFrameBytes": 1048576,
      "maxOperationOutputBytes": 25165824
    }
  }
}
```

`host` 字段仅用于兼容判断和诊断，插件不能依赖未声明的内部版本细节。

### 8.2 响应

```ts
interface ProviderDescribeResult {
	selectedProtocolVersion: "1.0" | string;
	plugin: {
		id: string;
		name: string;
		version: string;
	};
	providers: Array<{
		localId: string;
		displayName: string;
		description?: string;
		configSchema: Record<string, JsonValue>; // JSON Schema 2020-12 子集
		defaultModelId?: string;
		capabilities: {
			validateConfig: true;
			listModels: true;
			chat: true;
			generate: boolean;
			reasoningContinuation?: boolean;
			inputImages?: boolean;
			mayLeakXmlToolCalls?: boolean;
		};
		limits?: {
			maxConcurrentChat?: number;
			maxConcurrentGenerate?: number;
			maxConfigBytes?: number;
			maxModelPageSize?: number;
		};
	}>;
}
```

**设计建议**：

- 宿主根据 Manifest 中的 `pluginId` 与响应中的 plugin ID 做一致性校验；
- `providerTypeId` 由宿主使用 `${pluginId}/${localId}` 构造；
- `configSchema` 只描述 provider instance 配置，不描述插件安装配置；
- secret 字段使用 JSON Schema `writeOnly: true` 和扩展
  `"x-narrafork-secret": true`；宿主亦接受 `format: "password"`，三种标记等价，由
  `isSecretSchemaNode` 统一识别（历史上只识别 `format: "password"`，导致按本文写法声明的密钥
  被当作普通字段写入 `state.json` 明文，已修复并有回归测试）；
- 只有顶层 string 属性会被当作 secret，嵌套 secret 不支持：扁平键名保证
  `provider.<contributionId>.<field>` 可预测；
- 响应不得包含密钥默认值；
- secret 的实际下发方式见 26 节 D-04（已决策：按请求在 `config` 中注入解析值）；
- `maxConcurrent*` 未声明时，插件侧对 chat/generate 各采用默认并发 1；这只是插件自身的业务并发策略，
  不是宿主的请求准入限制；
- `mayLeakXmlToolCalls` 默认 false，v1 强烈建议插件始终发送结构化工具事件。

### 8.3 版本不兼容

**设计建议**：没有可选协议版本时返回：

```json
{
  "jsonrpc": "2.0",
  "id": "rpc_1",
  "error": {
    "code": -32001,
    "message": "No compatible NarraFork provider protocol version",
    "data": {
      "supported": ["2.0"],
      "requested": ["1.0"]
    }
  }
}
```

---

## 9. 配置校验：`provider.validateConfig`

### 9.1 请求

```ts
interface ValidateConfigParams {
	protocolVersion: string;
	providerTypeId: string;
	providerInstanceId: string;
	config: Record<string, JsonValue>;
	mode: "syntax" | "connectivity";
	modelId?: string;
}
```

- `syntax`：不得发起不必要的网络请求，只做格式、字段组合和本地依赖检查；
- `connectivity`：允许尝试认证、端点和可选模型检查；
- 宿主先执行 `configSchema` 校验，再调用插件语义校验；
- 传给插件的是解析后的临时配置，插件不得把原配置回显到日志或响应。

### 9.2 响应

```ts
interface ValidateConfigResult {
	valid: boolean;
	issues: Array<{
		severity: "error" | "warning" | "info";
		code: string;
		path?: string; // JSON Pointer，例如 /apiKey
		message: string;
		retryable?: boolean;
	}>;
	capabilities?: Record<string, JsonValue>;
}
```

**设计建议**：不允许插件返回“修正后的完整 config”，避免密钥被意外复制或覆盖。若需要建议值，
用 issue 或单独的非 secret capability 字段表达。

---

## 10. 模型发现：`provider.listModels`

### 10.1 请求

```ts
interface ListModelsParams {
	protocolVersion: string;
	providerTypeId: string;
	providerInstanceId: string;
	config: Record<string, JsonValue>;
	cursor?: string;
	limit: number;
	refresh?: boolean;
	query?: string;
}
```

### 10.2 响应

```ts
interface ListModelsResult {
	models: ProviderModelDescriptor[];
	nextCursor?: string;
	catalogVersion?: string;
	cacheTtlMs?: number;
	stale?: boolean;
}
```

**设计建议**：

- 默认 page size 100，上限 200；
- 插件不得一次返回无上限模型数组；
- `catalogVersion` 用于去重和缓存，不作为 model ID；
- 宿主保存 last-known-good 目录，插件暂时不可用时可以显示 stale 模型，但在实际调用前仍需确认实例可用；
- `refresh: true` 代表用户显式刷新，可触发网络请求；
- 自动刷新应遵守 TTL，避免设置页高频调用供应商；
- `getVisibleModels` 当前是同步读取路径，未来 Provider Registry 应读取异步维护的模型目录缓存，而不是在
  UI 列表请求路径同步启动插件或访问网络。

---

## 10A. Web 搜索：`provider.search`（已实现）

服务 `contributes.searchProviders` 声明的搜索源。宿主把每个搜索贡献注册成 `lib/search` 的一条通道，由
`server/lib/search/router.ts` 在 WebSearch 工具执行时按用户配置的通道顺序调用。

### 10A.1 请求

```ts
interface ProviderSearchParams {
	protocolVersion: string;
	/** 搜索贡献的局部 ID。 */
	contributionId: string;
	/** 绑定 provider 贡献的配置，含已解析的明文 secret。 */
	config?: Record<string, JsonValue>;
	query: string;
	/** 仅在宿主以明确研究目的调用时出现。 */
	purpose?: string;
	allowedDomains?: string[];
	blockedDomains?: string[];
	recencyDays?: number;
	maxResults?: number;
	locale?: string;
}
```

字段与宿主内部的 `SearchRequest`（`server/lib/search/types.ts`）逐一对应。**不下发** `signal`、
`parentNarratorId`、`parentToolUseId`、`cwd`：取消由 RPC 层的 `$/cancelRequest` 承载，后三个是宿主的
subagent 上下文，插件无权也无需知道。

`providerTypeId` / `providerInstanceId` 也**不下发**：它们标识宿主侧的注册项，插件已经知道自己在服务哪个
贡献。有测试专门钉这一点。

### 10A.2 响应

```ts
interface ProviderSearchResult {
	/** 已渲染的答案。当 results 存在时可省略，宿主可自行渲染。 */
	text?: string;
	results?: Array<{
		title?: string;
		url?: string;
		snippet?: string;
		publishedAt?: string;
		source?: string;
	}>;
}
```

结果字段与宿主的 `SearchResultItem` 对齐，因此只返回结构化 `results` 也可以 —— 宿主用与内置 adapter 相同
的 `renderSearchResults` 渲染。

**必须至少带 `text` 或非空 `results`。** 空响应会被拒绝（`INVALID_RESPONSE`），因为它会被记为「一次成功
但没有内容的搜索」，让 router 的回退链停在一条什么都没找到的通道上，比直接失败更糟。

### 10A.3 语义与约束

**刻意是 unary 的，不同于 `provider.chat`**：没有 accepted/event/done 三段式，没有 operation ID。宿主搜索
层对每条通道只等待一个结果，失败就换下一条，所以流式协议没有可流入之处。若将来需要增量结果，那应是一个新
方法，而不是扩展这一个。

与 `commands.invoke` 一样，这是 **Host→Plugin** 方法：不进 `PLUGIN_TO_HOST_REQUEST_METHODS`，也不进 iframe
方法清单，因此冻结那两份列表的 parity 断言不受影响。

超时取 `min(manifest.limits.timeoutMs, 宿主 unaryTimeoutMs)`：manifest 只能要求比宿主更短的时间，不能更长，
否则一个插件就能把搜索通道占用到超出宿主预算。

响应大小同理，取 `min(manifest.limits.maxOutputBytes, 宿主 maxUnaryResponseBytes)`（后者 1 MB）。声明更小的
预算会被强制执行 —— 它是插件对自己的承诺，而不只是一条备注；声明更大的值无效。

凭据投递方式与 `provider.chat` 相同（宿主每次请求解析 vault 并放进 `config`），但字段属于**绑定的 provider
贡献** —— 搜索贡献没有自己的 vault 命名空间，理由见 `03-manifest-and-packaging.md` §3.5.7。

---

## 10B. 宿主提示：`hostHints` 参数（已实现）

### 10B.1 概述

宿主在每个 provider RPC 方法的请求参数中附加一个可选的 `hostHints` 对象，将宿主侧的环境配置
传达给进程外插件。这是**单向下发**——插件只读取，不回写，也不在响应中确认。

```ts
interface ProviderHostHints {
	outbound?: { proxyUrl?: string };
	concurrency?: { maxConcurrentUpstream?: number };
}
```

### 10B.2 覆盖的方法

`hostHints` 作为可选字段出现在以下方法的请求参数中：

| 方法 | 场景 | 实现位置 |
| --- | --- | --- |
| `provider.chat` | 对话流 | `plugin-provider-adapter-factory.ts` `injectHints()` |
| `provider.generate` | 轻量生成 | 同上 |
| `provider.listModels` | 模型目录刷新 | `plugin-provider-catalog-refresh.ts` `refreshLocked()` |
| `provider.search` | Web 搜索 | `plugin-search-registry.ts` `execute()` |
| `provider.validateConfig` | 配置校验（参数类型已定义） | 当前无调用方触发远程 RPC validateConfig |

**`provider.describe` 不携带 hostHints**：握手发生在业务调用之前，代理配置在描述阶段尚无意义。

### 10B.3 字段语义

#### `outbound.proxyUrl`

宿主全局代理设置的 HTTP(S) 代理 URL。插件应将其用于所有上游 API 连接。

- **安全级别：secret**。代理 URL 可能包含 userinfo（`http://user:pass@host:port`），
  因此具有与 API 密钥同等的保密等级。
- **禁止**出现在：日志、诊断 dump（`ProviderRpcDiagnostics`）、WebSocket/SSE 广播、
  `provider.event` 流事件、前端可见的任何响应 payload。
- **缺失语义**：字段不存在 = 宿主无代理策略，插件使用自身默认值。
  空字符串永远不会被发送（协议约束 `min(1)`）。
- **来源**：`getOutboundProxy()`——读取宿主的全局 proxy 设置，不含 provider 专有覆盖。

#### `concurrency.maxConcurrentUpstream`

协作式并发提示，建议插件限制自身到上游 API 的最大并发连接数。

- **性质：提示，非强制**。宿主无法阻止插件超出此值（插件进程自主发起 TCP 连接）。
- **与 `descriptor.limits.maxConcurrentChat` / `maxConcurrentGenerate` 的区别**：
  - `maxConcurrent*`（descriptor 中）是插件声明并负责执行的 provider 业务/上游并发策略，包含插件侧
    排队、节流和 busy 判定；宿主不会据此拒绝请求；
  - `maxConcurrentUpstream`（hostHints 中）是宿主可选下发的协作提示，供插件调整自己的上游连接池。
- **不要与宿主通用 IPC 预算混淆**：`maxInFlightOperations`、frame/queue/request/response bytes
  等预算由宿主 RPC client 强制执行，用来保护 transport/runtime 资源；它们不代表某个 provider 的
  上游业务并发。
- **当前状态：宿主不下发此字段**。原因：宿主当前唯一可用的值就是插件自己声明的 provider 并发策略，
  将其回送给插件是纯噪音。真正有价值的场景是"插件与宿主内置路径共享同一上游账号额度"——此时宿主需要
  知道内置路径正在消耗多少并发，而该信息来自 provider 专有的并发控制状态，不应注入通用插件协议。
  当跨路径并发预算协调机制存在后，此字段将成为下发载体。

### 10B.4 向后兼容

- `hostHints` 是**完全可选**的。旧插件忽略未知字段即可正常工作。
- 宿主在无信息可传达时**省略整个字段**（不发送空对象），减少线路噪音。
- 内部 schema 使用 `.strict()` 阻止宿主意外注入未定义的键。
- 新增子字段只需升 minor 版本。

### 10B.5 接线全景

```text
plugin-platform-services.ts
  └─ resolveProviderHostHints()        // 读 getOutboundProxy()，per-call 最新值
       ├─ → createPluginProviderAdapterFactory({ resolveHostHints })
       │      └─ PooledProviderRpcClient.injectHints()  → chat/generate
       ├─ → PluginProviderCatalogRefresher({ resolveHostHints })
       │      └─ refreshLocked()                        → listModels
       └─ → PluginSearchRegistry({ resolveHostHints })
              └─ execute()                              → search
```

---

## 11. 宿主与插件之间的规范化请求模型

### 11.1 JSON 类型

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
```

跨进程数据必须是 JSON 值。`undefined`、`BigInt`、函数、循环引用、`Error` 实例和宿主类实例都禁止出现。

### 11.2 规范化内容块

**设计建议**：

```ts
type ProviderContentBlock =
	| { type: "text"; text: string; outputIndex?: number }
	| {
			type: "image";
			mediaType: string;
			dataBase64: string;
			name?: string;
	  }
	| {
			type: "reasoning";
			text: string;
			outputIndex?: number;
			continuation?: {
				source: string;
				format: string;
				data: JsonValue;
			};
	  }
	| {
			type: "redacted_reasoning";
			data: string;
			outputIndex?: number;
			source?: string;
	  }
	| {
			type: "tool_call";
			toolUseId: string;
			name: string;
			input: Record<string, JsonValue>;
			outputIndex?: number;
			continuation?: JsonValue;
	  }
	| {
			type: "tool_result";
			toolUseId: string;
			name?: string;
			content: Array<
				| { type: "text"; text: string }
				| { type: "image"; mediaType: string; dataBase64: string; name?: string }
			>;
			isError: boolean;
	  }
	| {
			type: "web_search";
			id: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
	  }
	| {
			type: "image_generation";
			id: string;
			revisedPrompt?: string;
			outputIndex?: number;
	  };

interface ProviderMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: ProviderContentBlock[];
	messageId?: string;
}
```

**设计建议**：插件根据目标 API 把上述规范化结构转换成 Anthropic user/tool-result block、OpenAI tool role、
Responses item、Gemini function result 等供应商格式。宿主不把 `DbMessage`、`contentJson` 或数据库字段名直接发送给插件。

### 11.3 工具定义

```ts
interface ProviderToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, JsonValue>;
}
```

`RemoteProviderAdapter.formatTools` 在宿主侧调用现有 JSON Schema 转换逻辑，并输出该结构。
Zod schema 不跨进程传输。

**设计建议**：

- 插件只能从本次请求提供的工具名中选择；
- 插件不能注册或执行新工具；
- 插件不能改变工具 schema；
- tool call input 必须是 JSON object；
- 工具权限仍由 NarraFork 的 permission handler 决定。

### 11.4 chat 请求

```ts
interface ProviderChatParams {
	protocolVersion: string;
	operationId: string;
	providerTypeId: string;
	providerInstanceId: string;
	providerPrefix: string;
	config: Record<string, JsonValue>;
	modelId: string;
	conversation: {
		conversationId: string;
		stickySessionKey?: string;
		resetUpstreamSession?: boolean;
	};
	request: {
		history: ProviderMessage[];
		current: {
			text: string;
			images?: Array<{ mediaType: string; dataBase64: string }>;
			toolResults: ProviderContentBlock[];
		};
		tools: ProviderToolDefinition[];
		options?: {
			reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
			serviceTier?: string;
			metadata?: Record<string, JsonValue>;
			locale?: string;
		};
	};
	streamWindow: {
		maxUnackedEvents: number;
		maxUnackedBytes: number;
		terminalReserveEvents: number;
		terminalReserveBytes: number;
	};
}
```

**设计建议**：`config` 在每次请求中显式传入，避免插件进程存在不可见的“当前配置”状态。
进程可以按 `providerInstanceId` 和配置摘要缓存连接，但本次参数始终是权威值。

### 11.5 chat 接受响应

```json
{
  "jsonrpc": "2.0",
  "id": "rpc_20",
  "result": {
    "accepted": true,
    "operationId": "op_42"
  }
}
```

插件返回 accepted 后，通过 `provider.event` 推送事件。

---

## 12. 轻量生成：`provider.generate`

### 12.1 统一方法

**设计建议**：`generate`、`generateWithMeta`、`generateWithHistory`、
`generateWithHistoryWithMeta` 在 RPC 层统一成 `provider.generate`。

```ts
interface ProviderGenerateParams {
	protocolVersion: string;
	operationId: string;
	providerTypeId: string;
	providerInstanceId: string;
	providerPrefix: string;
	config: Record<string, JsonValue>;
	modelId: string;
	request:
		| {
				mode: "prompt";
				text: string;
				systemInstruction?: string;
		  }
		| {
				mode: "history";
				systemInstruction: string;
				content: string;
				locale?: string;
		  };
	options?: {
		reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	};
	streamWindow: ProviderChatParams["streamWindow"];
}
```

响应同样只是 `{ accepted: true, operationId }`。即使供应商上游不支持流式，插件也必须至少发送一个
`text.delta`，然后发送 usage 和 done。这样 `RemoteProviderAdapter` 只有一套取消、背压和错误处理逻辑。

**设计建议**：generate 操作禁止工具调用。收到 `tool_call.*` 事件应视为插件协议错误。

---

## 13. 流式通知：`provider.event`

### 13.1 通用 envelope

```ts
interface ProviderEventNotification {
	jsonrpc: "2.0";
	method: "provider.event";
	params: {
		protocolVersion: string;
		operationId: string;
		seq: number;
		event: ProviderStreamEvent;
	};
}
```

规则：

- `seq` 从 1 开始，严格递增；
- 每个 operation 独立计数；
- 重复、倒序或跳号都视为协议错误；
- 所有事件都必须在 accepted 之后发送；
- `done` 是最后一个事件；
- `done` 后的任何事件都被丢弃并记为协议违规；
- 插件进程退出但 operation 未收到 done，宿主合成 process error，而不是合成成功 done。

### 13.2 事件联合类型

```ts
type ProviderStreamEvent =
	| {
			type: "request_started";
			credentialId?: string;
			upstreamRequestId?: string;
			reasoningSource?: string;
	  }
	| {
			type: "text.delta";
			text: string;
			outputIndex?: number;
	  }
	| {
			type: "reasoning.delta";
			blockId: string;
			text: string;
			outputIndex?: number;
			metadata?: ReasoningContinuation;
	  }
	| {
			type: "reasoning.metadata";
			blockId: string;
			outputIndex?: number;
			metadata: ReasoningContinuation;
	  }
	| {
			type: "reasoning.redacted";
			data: string;
			outputIndex?: number;
			source?: string;
	  }
	| {
			type: "tool_call.start";
			toolUseId: string;
			name: string;
			outputIndex?: number;
			continuation?: JsonValue;
	  }
	| {
			type: "tool_call.delta";
			toolUseId: string;
			argumentsDelta: string;
	  }
	| {
			type: "tool_call.end";
			toolUseId: string;
	  }
	| {
			type: "tool_call.complete";
			toolUseId: string;
			name: string;
			input: Record<string, JsonValue>;
			outputIndex?: number;
			continuation?: JsonValue;
	  }
	| {
			type: "usage";
			usage: ProviderUsage;
	  }
	| {
			type: "error";
			error: ProviderOperationError;
	  }
	| {
			type: "done";
			status: "completed" | "cancelled" | "failed";
			stopReason:
				| "end_turn"
				| "tool_use"
				| "max_output_tokens"
				| "content_filter"
				| "cancelled"
				| "error"
				| "unknown";
			messageId?: string;
			conversationId?: string;
			responseId?: string;
			credentialId?: string;
			usage?: ProviderUsage;
	  };

interface ReasoningContinuation {
	source: string;
	format: string;
	data: JsonValue;
}
```

### 13.3 `request_started`

**设计建议**：插件在完成供应商请求组装、即将执行网络/本地推理调用前发送。
`RemoteProviderAdapter` 收到后调用 `ChatParams.onRequestStart`。

如果插件在首个可见内容前未发送 `request_started`，适配器可在首个内容事件到来时补调用
`onRequestStart`，同时记录协议警告。不能在 `provider.chat` 请求刚写入 stdin 时就调用，因为此时插件可能仍在本地
校验或尚未构造上游请求。

### 13.4 文本事件

**设计建议**：

- `text.delta.text` 必须是增量文本，不得重复发送累计全文；
- 空字符串禁止；
- `outputIndex` 表示供应商原生内容块顺序；
- 同一文本块的 `outputIndex` 应稳定；
- 插件应合并过小 token delta，建议每 10–25ms 或累计 4–16KiB 发送一次，避免每 token 一个进程消息。

映射：

```ts
{ type: "text.delta", text, outputIndex }
  -> ParsedStreamEvent { text, textOutputIndex: outputIndex }
```

### 13.5 推理事件

**设计建议**：

- `blockId` 在一次 operation 内唯一，用于把 metadata-only 事件关联到同一推理块；
- `reasoning.delta.text` 是增量文本；
- 续接签名、encrypted content、thought signature 等放在 `ReasoningContinuation.data`；
- `source` 必须稳定标识签名的上游来源，不能只写宽泛的协议名；
- 不支持续接的插件省略 metadata；
- opaque metadata 单项必须有严格大小上限。

**实现缺口**：当前 `ReasoningProviderMetadata` 只显式定义 OpenAI、Anthropic、Gemini 字段。
实现插件协议时建议增加通用字段，例如：

```ts
plugin?: {
	providerTypeId: string;
	source: string;
	format: string;
	data: JsonValue;
};
```

这属于未来源码实现要求，不在本文档任务中修改。

### 13.6 工具调用事件

**设计建议**：支持两种等价表示，但同一个 `toolUseId` 只能选择一种。

流式：

```text
tool_call.start -> 0..N tool_call.delta -> tool_call.end
```

非流式：

```text
tool_call.complete
```

映射：

| 插件事件 | `ParsedStreamEvent` |
| --- | --- |
| `tool_call.start` | `toolUseChunk { toolUseId, name, input: "", outputIndex }` |
| `tool_call.delta` | `toolUseChunk { toolUseId, input: argumentsDelta }` |
| `tool_call.end` | `toolUseChunk { toolUseId, stop: true }` |
| `tool_call.complete` | `toolUses: [{ toolUseId, name, input, outputIndex }]` |

规则：

- `toolUseId` 非空、一次 operation 内唯一、UTF-8 最大 128 bytes；
- `name` 必须匹配本次请求提供的工具；
- `argumentsDelta` 是 JSON object 的原始字符串片段；
- JSON 转义可以跨 chunk，插件不能假设 chunk 边界与字符/字段边界一致；
- `tool_call.end` 前参数必须形成一个 JSON object；
- 插件不得重复发送 complete 和 start/delta/end；
- done 时仍未 end 的调用保持为不完整调用，让 Agent Loop 的 orphaned tool-call 恢复逻辑处理；
- 插件不能等待 NarraFork 工具执行结果后再发 done；工具执行发生在 Agent Loop 下一阶段。

### 13.7 usage 事件

```ts
interface ProviderUsage {
	// 当前上下文占用；包括缓存 token 时应与供应商语义一致。
	promptTokens?: number;
	// 未命中缓存、按普通输入计费的 token。
	inputTokens?: number;
	completionTokens?: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheCreation5mTokens?: number;
	cacheCreation1hTokens?: number;
	contextWindow?: number;
	contextUsagePercentage?: number;
	metering?: {
		unit: string;
		unitPlural: string;
		usage: number;
	};
}
```

**设计建议**：

- usage 是截至当前时刻的累计 snapshot，不是 delta；
- 同一字段后续 snapshot 不应下降，供应商明确修正除外；
- done 中的 usage 是最终值；
- `contextUsagePercentage` 应限制在 0–100；
- token 字段必须是非负安全整数；
- 插件无法提供 usage 时可以省略，由现有 Agent Loop 估算；
- 适配器把 token 字段映射到 `ParsedStreamEvent.usage`，把百分比映射到
  `contextUsagePercentage`，把 metering 映射到 `metering`。

### 13.8 error 事件

```ts
interface ProviderOperationError {
	classification: "api" | "transport" | "invalid_state" | "protocol" | "cancelled";
	code: string;
	message: string;
	reason?: string;
	statusCode?: number;
	retryable?: boolean;
	phase?: "prepare" | "connect" | "request" | "stream" | "parse" | "cancel";
	requestId?: string;
	providerRequestId?: string;
	responseSnippet?: string;
	responseHeaders?: Record<string, string>;
	details?: Record<string, JsonValue>;
}
```

**设计建议**：

- error message 面向用户和日志，必须脱敏；
- `responseSnippet` 有独立小上限，禁止返回完整 HTML/JSON body；
- `responseHeaders` 只允许安全白名单；
- accepted 后发生错误时先发 error，再发 failed done；
- 同一 operation 可以有非终止 warning，但 v1 不用 error 表达 warning；
- `classification: protocol` 表示插件自身生成了无效供应商事件，通常不可重试并可能触发进程重启；
- `classification: cancelled` 只用于插件自己检测到取消；宿主主动 abort 时以宿主 signal 为准。

### 13.9 done 事件

**设计建议**：

- 每个 accepted operation 必须且只能发送一个 done；
- done 之后不得再发 text/reasoning/tool/usage/error；
- `status: failed` 前必须有 error；
- `status: cancelled` 的 stopReason 必须是 cancelled；
- `status: completed` 可以没有文本，这时现有 Agent Loop 会执行空响应恢复；
- `stopReason: max_output_tokens` 由适配器转换为现有 completion-limit invalid state，
  使 Agent Loop 产生 `output_truncated`；
- done 中的 message/conversation/response ID 映射到最后一个 `ParsedStreamEvent`；
- done 只结束 provider 的 `AsyncGenerator`，不直接生成 Agent Loop 的 done。

---

## 14. 取消：`provider.cancel` 与 `AbortSignal`

### 14.1 请求

```ts
interface ProviderCancelParams {
	protocolVersion: string;
	operationId: string;
	reason: "user_abort" | "timeout" | "output_limit" | "shutdown" | "superseded";
	message?: string;
}
```

### 14.2 响应

```ts
interface ProviderCancelResult {
	operationId: string;
	state: "cancelling" | "already_done" | "unknown_operation";
}
```

### 14.3 语义

**设计建议**：

1. `RemoteProviderAdapter.chat/generate` 在开始时监听 `AbortSignal`；
2. signal 已 aborted 时，不启动 operation，直接抛 `AbortError`；
3. signal 后续 abort 时，立即发送一次 `provider.cancel`；
4. cancel 是幂等操作；
5. 插件必须中止其上游 HTTP、WebSocket、本地推理或 SDK 请求；
6. 插件仍需发送 `done { status: "cancelled" }`；
7. cancel response 与 done 可以任意先后到达；
8. 宿主收到 cancelled done 后，以 `AbortError` 结束远程 generator；
9. Agent Loop 看到自己的 signal 已 aborted，会先 flush 已接收内容和已完成工具结果，再输出 `Aborted`；
10. 超过取消宽限期仍未 done 时，宿主终止该 provider instance 进程。

**设计建议**：插件 RPC 读取循环必须与上游请求并发运行。插件不能在处理 `provider.chat` 时阻塞主线程，
否则无法及时读取 `provider.cancel` 和流量控制通知。

---

## 15. 超时模型

### 15.1 分层超时

**设计建议**：不同阶段使用不同超时，不使用一个超长全局 timeout 覆盖全部行为。

| 阶段 | 建议默认值 | 触发动作 |
| --- | ---: | --- |
| 进程启动到 describe 完成 | 10s | 终止进程，标记启动失败 |
| 普通 RPC response | 5s | 当前 RPC 失败；必要时重启进程 |
| `validateConfig(connectivity)` | 30s | 取消校验，不禁用既有可用实例 |
| `listModels` | 30s | 返回 stale cache 或错误 |
| chat/generate accepted | 5s | operation 未成立，RPC 失败 |
| accepted 到 `request_started` | 30s | cancel，标记 prepare/dispatch timeout |
| 首个有意义模型事件 | 复用 Agent Loop `firstTokenTimeoutMs` | Agent Loop cancel/retry |
| 首事件后的流空闲 | 120s | cancel，标记 stream idle timeout |
| 单 operation 绝对时长 | 30min | cancel，防止永久占用 |
| cancel 到 done | 2s | 进入强制终止宽限期 |
| cancel 到 kill | 5s | 终止 provider instance 进程 |

**设计建议**：

- Agent Loop 已有首事件超时，RemoteProviderAdapter 不再设置重复的“首 token”计时器；
- `request_started` 之前的 timeout 属于插件准备阶段；
- `request_started` 之后由 Agent Loop 的首事件 timeout 接管；
- usage、request_started 等控制事件不应被当作可见首 token；
- text、reasoning、有名称的 tool call start/complete 才是核心有意义事件；
- 超时统一通过 `provider.cancel` 传播，再根据超时阶段构造结构化 diagnostics。

---

## 16. 背压与流量控制

### 16.1 为什么仅依靠 OS pipe 不够

**当前事实**：provider 事件会进入 Agent Loop，工具调用还可能触发异步执行。若插件持续高速输出，而宿主
只把 stdout 全量读入数组，主线程内存和 JSON 解析开销都会失控。

**设计建议**：同时使用两层背压：

1. OS 层：插件写 stdout 时必须等待运行时的 drain/backpressure；宿主写 stdin 也必须等待；
2. 协议层：每个 operation 使用 event/byte credit window。

### 16.2 初始 credit

`provider.chat`/`provider.generate` 的 `streamWindow` 建议默认：

```json
{
  "maxUnackedEvents": 64,
  "maxUnackedBytes": 262144,
  "terminalReserveEvents": 2,
  "terminalReserveBytes": 65536
}
```

普通事件消耗 normal credit。error/done 可以使用 terminal reserve，避免 normal credit 耗尽后无法结束。

### 16.3 ACK 通知

宿主在 `RemoteProviderAdapter` 消费并释放事件后发送：

```json
{
  "jsonrpc": "2.0",
  "method": "provider.streamAck",
  "params": {
    "protocolVersion": "1.0",
    "operationId": "op_42",
    "throughSeq": 18,
    "grantEvents": 16,
    "grantBytes": 65536
  }
}
```

规则：

- ACK 是 notification，不要求 response；
- credit 在事件从 per-operation queue 被消费后归还，而不是 stdout parser 刚读到时归还；
- byte 数按完整 `provider.event` JSON body 的 `Content-Length` 计算；
- 插件必须记录每个已发事件的实际 body bytes；
- 插件不得超过未确认 event 或 byte credit；
- 终止 operation 后，不再发送 ACK；
- 插件忽略 credit 持续输出时，宿主先 cancel，再终止进程并记录协议违规。

### 16.4 队列设计

**设计建议**：

- 每 operation 一个有界事件队列；
- 进程级另有总队列上限，避免多个 operation 各自占满；
- stdout reader 只做 frame 校验、JSON parse、路由和轻量计数；
- 不在 stdout reader 中执行模型历史转换、工具执行或大对象深拷贝；
- 插件应合并小 delta；
- 宿主可对 text/reasoning delta 做有限时间窗口合并，但不能跨 tool/event 顺序边界。

---

## 17. 字节上限与资源上限

### 17.1 建议默认值

**设计建议**：所有上限按 UTF-8 bytes 计算。

| 对象 | 建议默认上限 | 处理方式 |
| --- | ---: | --- |
| frame header | 8KiB | 协议错误并终止进程 |
| describe/validate/listModels frame | 1MiB | RPC 失败 |
| chat/generate 请求 frame | 32MiB | 请求前失败，不静默截断 history |
| 请求 frame 硬上限 | 64MiB | 不允许插件协商提高 |
| 单个 `provider.event` frame | 256KiB | operation 协议错误 |
| 单 text/reasoning/tool delta | 64KiB | 要求插件拆分 |
| 单 operation 文本累计 | 8MiB | cancel，报告 output limit |
| 单 operation 推理累计 | 8MiB | cancel，报告 output limit |
| 单工具参数累计 | 2MiB | 终止该 operation |
| 所有工具参数累计 | 8MiB | 终止该 operation |
| 单推理 continuation metadata | 64KiB | 丢弃 metadata 并报协议错误 |
| error response snippet | 16KiB | 截断并标记 truncated |
| stderr ring buffer | 1MiB/进程 | 丢弃最旧内容 |
| stderr 单行 | 64KiB | 截断单行 |
| operation 事件数 | 100,000 | cancel，防止无限细碎事件 |
| listModels 单页 | 200 models | 要求分页 |

### 17.2 上限触发语义

**设计建议**：

- 输入 history 超限时，RPC 层不得自行删除旧消息；应让上层 compact/prune 后重试；
- 输出超限时，宿主发送 `provider.cancel(reason="output_limit")`；
- 已经接收的部分文本和推理仍按 Agent Loop 的 partial content 路径保存；
- 工具参数超限或非法时不得执行该工具；
- 插件在 cancel 后继续输出的内容被丢弃；
- 多次违反上限的进程进入熔断状态；
- v1 不通过 JSON-RPC frame 返回无限 base64 图像；图像生成输出应由后续二进制/文件句柄扩展处理。

---

## 18. 错误模型

### 18.1 JSON-RPC envelope 错误

**设计建议**：保留标准错误码：

- `-32700` Parse error；
- `-32600` Invalid Request；
- `-32601` Method not found；
- `-32602` Invalid params；
- `-32603` Internal error。

自定义错误码：

| 错误码 | 含义 |
| ---: | --- |
| `-32001` 协议版本不兼容 |
| `-32002` provider type/instance 未初始化或不存在 |
| `-32003` 配置无效 |
| `-32004` 模型不存在或不可用 |
| `-32005` 并发额度已满/进程 busy |
| `-32006` operationId 冲突 |
| `-32007` frame/请求大小超限 |
| `-32008` 权限不足 |
| `-32009` 插件或上游暂不可用 |

这些错误只用于 operation accepted 之前或普通 unary RPC。

### 18.2 accepted 后的 operation 错误

**设计建议**：`RemoteProviderAdapter` 按以下规则映射：

| 插件错误 | 适配器行为 | Agent Loop 结果 |
| --- | --- | --- |
| host signal 已 abort | 发送 cancel，抛 `AbortError` | flush partial 后 `Aborted` |
| context overflow | 产生 `invalidState`/typed context error | `context_length_exceeded` |
| max output | 在 done 时产生 completion-limit invalid state | `output_truncated` |
| hard quota/payment | typed API error/invalid state | 不按普通瞬态错误盲目重试 |
| retryable transport/API，尚无工具调用 | 抛带 diagnostics 的 typed error | stateless 时可由 Agent Loop 重试 |
| retryable transport/API，工具已开始 | 产生 retryable `invalidState`，不抛自动重试错误 | Agent Loop 保留工具结果并停止重放 |
| malformed plugin event | non-retryable protocol error | operation 失败，进程可重启/熔断 |
| process exit | transport/process error | 根据是否已产生工具调用选择上述两条路径 |

**关键设计结论**：进程崩溃发生在工具调用事件之后时，适配器必须知道“已有工具调用暴露给 Agent Loop”，
并禁止把错误当作可以原地重放的普通异常。否则 eager tool 可能执行两次。

### 18.3 diagnostics 映射

**设计建议**：插件错误映射到现有 `ApiRequestDiagnostics`：

```ts
{
	schema: "narrafork.error-diagnostics.v1",
	source: classification === "protocol" ? "parser" : "provider",
	phase,
	statusCode,
	code,
	reason,
	message,
	requestId,
	providerRequestId,
	provider: providerPrefix,
	model: `${providerPrefix}:${modelId}`,
	transport: "plugin-stdio",
	retryable,
	responseHeaders,
	responseSnippet
}
```

宿主补充 provider/model/transport，插件不能伪造另一个 provider instance 的身份。

---

## 19. `RemoteProviderAdapter` 设计

### 19.1 构造参数

```ts
interface RemoteProviderAdapterOptions {
	providerTypeId: string;
	providerInstanceId: string;
	providerPrefix: string;
	config: Record<string, JsonValue>;
	descriptor: ProviderDescribeResult["providers"][number];
	modelCatalog: ReadonlyMap<string, ProviderModelDescriptor>;
	processManager: ProviderProcessManager;
}
```

### 19.2 对现有 `ProviderAdapter` 的映射

| `ProviderAdapter` 方法/字段 | `RemoteProviderAdapter` 行为 |
| --- | --- |
| `formatTools` | 宿主同步转换为 `ProviderToolDefinition[]`；不发 RPC |
| `buildHistory` | 宿主把 `DbMessage` 转成 `ProviderMessage[]` 和规范化 trailing tool result；不发 RPC |
| `getActiveReasoningSource` | 返回当前 operation 最近声明的 reasoning source；无动态 source 时返回 provider instance 稳定 source |
| `injectSystemPrompt` | 在规范化 history 前部插入/替换 system message；不发 RPC |
| `chat` | 创建 operation，调用 `provider.chat`，把 `provider.event` 转成 `ParsedStreamEvent` |
| `formatToolResult` | 返回规范化 `tool_result` block；不发 RPC |
| `pushUserTurn` | 把 tool result、image、text 追加到规范化 history；不发 RPC |
| `pushAssistantTurn` | 按 outputIndex 追加 text/reasoning/tool call 等 block；不发 RPC |
| `generate` | 调用 `provider.generate`，累计 text，返回字符串 |
| `generateWithMeta` | 同上，并转换最终 usage/context/metering |
| `generateWithHistory` | 使用 generate 的 `mode: "history"` |
| `generateWithHistoryWithMeta` | 与上一项共用实现并返回 meta |
| `mayLeakXmlToolCalls` | 来自 descriptor；默认 false |

### 19.3 `buildHistory`

**设计建议**：为远程 provider 新增一个宿主侧的 canonical history builder。它应：

- 只读取传入的 `DbMessage` 快照；
- 保留 user/assistant/system、tool call/tool result 顺序；
- 保留 `outputIndex`；
- 保留允许重放的 reasoning continuation；
- 通过 reasoning source 检查丢弃来自不兼容上游的签名；
- 把无效或只有空内容的 assistant message 过滤掉；
- 将尾部未配对 tool result 放入 `trailingToolResults`；
- 不把数据库 ID、narrator 权限、用户 JWT、原始 sidecar 存储结构暴露给插件；
- 复用现有 plan body 精简和 history rebuild 入口。

### 19.4 `chat` 的 async generator

**设计建议**：伪代码如下：

```ts
async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
	if (params.signal.aborted) throw abortError(params.signal.reason);

	const operation = processManager.createOperation({
		kind: "chat",
		signal: params.signal,
	});

	await processManager.request("provider.chat", buildChatParams(operation, params), {
		timeoutMs: CHAT_ACCEPT_TIMEOUT_MS,
	});

	let requestStarted = false;
	let exposedToolCall = false;

	try {
		for await (const event of operation.events()) {
			switch (event.type) {
				case "request_started":
					requestStarted = true;
					params.onRequestStart?.({ credentialId: event.credentialId });
					break;
				case "text.delta":
					ensureRequestStartedFallback();
					yield { text: event.text, textOutputIndex: event.outputIndex };
					break;
				case "tool_call.start":
				case "tool_call.complete":
					exposedToolCall = true;
					yield mapToolEvent(event);
					break;
				case "reasoning.delta":
				case "reasoning.metadata":
					yield mapReasoningEvent(event);
					break;
				case "usage":
					yield mapUsage(event.usage);
					break;
				case "error":
					handleOperationError(event.error, { exposedToolCall });
					break;
				case "done":
					yield* mapDoneMetadata(event);
					return;
			}
		}
	} finally {
		operation.dispose();
	}
}
```

实际实现还必须处理 cancel grace、credit ACK、输出计数、process exit 和 late event 丢弃。

### 19.5 reasoning source

**设计建议**：默认 source：

```text
plugin:<providerTypeId>:<providerInstanceId>
```

若插件会在同一实例内路由到多个不能共享签名的上游 channel，必须在 `request_started` 或 reasoning metadata 中
提供更细 source，例如：

```text
plugin:com.acme.ai/main:p123:region-a-account-2
```

source 是兼容性身份，不应包含 token、邮箱等敏感信息。

### 19.6 request dump

**设计建议**：RemoteProviderAdapter 写入宿主 request dump 的只应是：

- provider RPC 请求的脱敏摘要；
- event 类型、seq、大小和有界预览；
- 插件错误 diagnostics；
- stderr 的有界尾部。

插件不应默认把供应商原始响应全量通过 RPC 发回。若未来需要下载原始 dump，应设计独立、受权限控制、
有大小上限的诊断文件接口。

---

## 20. Provider Registry 与现有解析逻辑接入

### 20.1 Registry 条目

**设计建议**：

```ts
interface ProviderRegistryEntry {
	kind: "builtin" | "compatible-api" | "executable-plugin";
	providerInstanceId: string;
	providerPrefix: string;
	displayName: string;
	disabled: boolean;
	createAdapter(): ProviderAdapter;
	getModels(): readonly ProviderModelDescriptor[];
	getModel(modelId: string): ProviderModelDescriptor | undefined;
}
```

### 20.2 `resolveProviderAndModel`

**设计建议**：

1. 宿主先完成 `__default__`、`__summary__`、聚合路由；
2. 按完整模型值第一个冒号得到 prefix/modelId；
3. Provider Registry 按 prefix 查实例；
4. 显式 prefix 不存在或实例 disabled 时继续明确报错；
5. executable entry 创建 `RemoteProviderAdapter`；
6. 返回的 `ProviderResolution.provider` 仍使用 provider prefix，以兼容现有 AgentConfig 和事件；
7. 同时在内部保留稳定 `providerInstanceId` 用于状态和审计。

### 20.3 模型目录和上下文窗口

**设计建议**：

- `getVisibleModels` 合并 Registry 的 last-known model catalog；
- `providerOrder`、`hiddenModels`、聚合和 disabled provider 继续由宿主统一处理；
- `getModelContextWindow` 优先读取 model descriptor，其次 provider 默认值，最后使用宿主 fallback；
- `usesStatefulModel` 对插件模型读取 `sessionMode`；
- model descriptor 不可用时按 stateful 处理；
- `reasoningEfforts` 用于 UI 和请求前 clamp，但最终插件仍需校验。

### 20.4 provider 冲突

**设计建议**：builtin、compatible API、executable plugin 的 prefix 必须处于同一唯一命名空间。
不能依赖“谁后注册谁覆盖”。配置保存前就应拒绝冲突。

**待决策**：是否允许用户显式把某个内置 provider 禁用后，将其原 prefix 让给插件。本文建议仍禁止，
以避免重新启用内置 provider 时产生不稳定路由；如需替代，应使用不同 prefix。

---

## 21. 并发、重试与故障恢复

### 21.1 并发

**设计建议**：

- `descriptor.limits.maxConcurrentChat` / `maxConcurrentGenerate` 是插件声明的 provider 业务并发策略；未声明时，
  插件侧对 chat/generate 各采用默认并发 1；
- 插件负责按自身策略排队、节流或快速返回 busy，并将排队等待计入调用方 timeout；宿主不因
  `descriptor.limits.maxConcurrent*` 超额而拒绝请求；
- 宿主只强制执行通用 IPC 资源安全预算，例如 `maxInFlightOperations`、frame/queue/request/response bytes、
  operation timeout 和 output limits；这些预算与 provider-specific 上游并发相互独立；
- 插件返回 `-32005` 时，宿主按 busy/unavailable 分类；
- 同一个 operation 的事件严格有序，不要求不同 operation 之间有全局顺序；
- stateful session 是否允许同一 `stickySessionKey` 并发由插件自己的 provider 策略决定，默认行为由插件实现。

### 21.2 重试所有权

**设计结论**：

- 插件可以在“尚未产生任何外部可见事件”时执行供应商 SDK 自带的安全连接重试；
- 插件不得在已经发送 text/reasoning/tool event 后静默重放整个上游请求；
- RemoteProviderAdapter 不自动重放 `provider.chat`；
- Agent Loop 保留应用层重试所有权；
- 插件必须正确声明 stateful/stateless；
- 工具调用已暴露后，任何进程/传输错误都按“不重放”路径处理。

### 21.3 late event

**设计建议**：取消、超时或模型切换后，宿主把 operation 标为 closed。随后到达的旧 operation event：

- 不进入 Agent Loop；
- 不归还 normal credit；
- 记录有限次数警告；
- 持续发送 late event 的插件被视为协议违规。

---

## 22. 安全与隐私接口边界

**设计建议**：

- config secret 不进入命令行参数；
- RPC logger 只记录字段名、摘要和 byte length，不记录 config 值；
- `metadata.user_id` 等标识只在用户设置或供应商契约确实需要时传递；
- 默认不传用户 ID、项目 ID、chapter ID、真实 cwd；
- `conversationId` 和 `stickySessionKey` 作为供应商会话技术标识，不赋予任何宿主权限；
- 插件收到的工具定义只包含 name/description/schema，不包含 execute 函数、权限规则或内部 metadata；
- 工具结果只包含需要发给模型的内容，不包含权限审批者、数据库行或内部审计字段；
- error details 必须做深度脱敏和大小限制；
- 插件不能要求宿主把 JWT 或内部 API token 写入 provider config。

---

## 23. 测试设计与验收标准

### 23.1 frame 与 JSON-RPC

应新增测试：

- header/body 被逐字节拆分仍能解析；
- 单 chunk 含多个 frame；
- UTF-8 多字节字符的 Content-Length；
- 非法长度、负数、超长 header、body 超限；
- stdout 混入日志；
- JSON-RPC response 与 notification 交错；
- 未知 method 和错误码；
- v1 禁止 batch。

### 23.2 版本与 describe

应新增测试：

- 选择共同最高 minor；
- major 不兼容；
- pluginId/localId 不一致；
- 重复 provider type；
- 非法 config schema；
- 未声明 `maxConcurrent*` 时由插件侧使用 chat/generate 各为 1 的默认 provider 并发策略；这不改变宿主通用 IPC 预算。

### 23.3 `RemoteProviderAdapter` 契约

应复用或仿照现有 provider mock 测试验证：

- text.delta 映射；
- reasoning delta + metadata-only 事件；
- tool_call 参数跨 chunk、转义跨 chunk；
- complete 与 streaming 工具调用去重；
- usage/context/metering 映射；
- empty done 触发 Agent Loop 空响应恢复；
- reasoning-only done 触发现有死回合恢复；
- max output stop reason 产生 `output_truncated`；
- done 不直接结束含工具调用的 Agent Loop；
- runtime model/provider switch 后重新构造 adapter 和 history；
- prefix 含模型多级冒号时解析正确。

### 23.4 取消和超时

应新增测试：

- signal 在请求前已 aborted；
- accepted 前 abort；
- request_started 前 abort；
- 首 token timeout 触发 cancel；
- 流式中断保留 partial text/reasoning；
- eager tool 已完成时中断仍保留 tool result；
- cancel 幂等；
- cancel response 与 cancelled done 乱序；
- 插件不响应 cancel 时按宽限期 kill；
- kill 只影响当前 provider instance。

### 23.5 背压与上限

应新增测试：

- credit 耗尽后插件暂停；
- ACK 后恢复；
- byte credit 与 event credit 分别生效；
- terminal reserve 能发送 error/done；
- 插件超 credit 被终止；
- text/reasoning/tool 参数累计上限；
- 超大 listModels 分页；
- stderr ring 丢弃旧内容而不增长；
- 高频小 delta 被合并或受到事件总数限制。

### 23.6 进程故障与重试边界

应新增测试：

- 工具调用前进程退出，stateless 模型可进入 Agent Loop retry；
- 工具调用后进程退出，不重放请求；
- failed done 缺少 error 被识别为协议错误；
- done 后继续发事件被丢弃；
- seq 重复、倒序、跳号；
- 重启后旧 operation event 不会进入新会话；
- 连续协议错误触发熔断。

### 23.7 兼容 API 回归

应继续运行现有 provider resolution、custom API migration、aggregation、history、abort、reasoning 和 error
handling 测试，确保加入 Registry 后：

- 兼容 API provider 行为不变；
- 显式未知 provider 仍失败；
- prefix 迁移仍覆盖全部模型引用；
- 聚合 priority/balanced 规则不变；
- 插件 provider 不改变内置 provider 的默认优先级。

---

## 24. 建议默认协议摘要

**设计建议**：实现 v1 时采用以下默认值：

- Provider RPC：`1.0`；
- JSON-RPC：`2.0`；
- 传输：Content-Length framed stdio；
- 进程粒度：每 provider instance 一个长驻进程；
- chat/generate：accepted response + `provider.event` 流；
- 取消：显式 `provider.cancel`；
- 流序号：每 operation 从 1 严格递增；
- 背压：64 events / 256KiB normal credit + 2 events / 64KiB terminal reserve；
- 未声明 session mode：按 stateful；
- 未声明 `maxConcurrent*` 时，插件侧 provider 并发默认 chat 1、generate 1；
- stdout 只允许协议，日志只走 stderr；
- `RemoteProviderAdapter` 在宿主侧构造 canonical history/tools；
- 工具执行、权限、重试和 Agent Loop done 判断始终归宿主；
- 兼容 API 优先使用现有内置适配器，可执行插件只用于不能由兼容层表达的供应商。

---

## 25. 设计假设

1. **设计假设**：Manifest 能提供稳定 `pluginId`、可执行入口和所需权限。
2. **设计假设**：插件配置存储层能区分普通字段与 secret 字段，并在调用时向插件提供解析后的临时值。
3. **设计假设**：Provider Registry 将成为 builtin、兼容 API 和可执行插件的统一解析入口。
4. **设计假设**：模型目录可异步刷新并缓存，因此现有同步模型列表读取不必在请求路径启动子进程或访问网络。
5. **设计假设**：实现阶段允许扩展 `ReasoningProviderMetadata`，以保存插件 opaque continuation metadata。
6. **设计假设**：v1 的主要输出是文本、推理和工具调用；二进制生成物使用后续扩展。

---

## 26. 待决策项

### D-01：provider type ID 与 Manifest contribution ID 的最终拼接格式

**本文建议**：`${pluginId}/${localProviderId}`。

需要与 Manifest 文档统一，避免其他文档使用 `pluginId:providerId` 或重复引入 provider UUID。

### D-02：真实工作目录是否可传给供应商插件

**本文建议**：默认不传；只有 Manifest 权限和用户授权同时允许时，才传经过规范化的 workspace metadata。

需要安全文档确定权限名、路径脱敏和容器内路径映射。

### D-03：每实例进程还是共享插件进程

**本文建议**：v1 每 provider instance 一个进程；共享进程作为后续优化。

共享进程会显著增加密钥隔离、强制取消、并发公平和故障域复杂度。

### D-04：secret 的实际注入方式

**[已决策]** 采用「每次 RPC 在 `config` 中发送解析后的 secret」。

实现位置：

- `server/services/plugin-provider-credential-resolver.ts` —— 唯一的解析入口。按
  `providerInstanceId` 取该 provider 自己 schema 声明的 secret 字段，与非密 config 合并后
  作为 `ProviderBaseParams.config` 下发。
- 接入点：`plugin-provider-adapter-factory.ts`（chat/generate）与
  `plugin-provider-catalog-refresh.ts`（listModels）共用同一个 resolver，因此模型枚举与对话
  使用同一套凭据。
- 接线：`plugin-platform-services.ts`。

约束（均有回归测试）：

- **每次调用现场解析，不缓存**：轮换密钥或禁用插件在下一次请求即生效，不需重启。
- **未配置的 secret 字段不出现在 `config` 里**（而非空串），使插件能区分「未配置」与
  「配置为空」。
- **只下发该 provider 自己声明的字段**：键名为 `provider.<contributionId>.<field>`，插件无法
  拿到兄弟 provider 或其他插件的凭据，也没有任何列举能力。
- **日志深度脱敏**：这是本方案成立的前提。解析结果不得进入日志、错误详情或诊断；解析失败
  只记录字段名。`plugin-provider-credential-resolver.test.ts` 与
  `plugin-provider-credential-e2e.test.ts` 会捕获一次真实 chat 期间的全部日志并断言其中不含
  密钥值。

未采用「专用 secret channel + 引用」与「容器 secret/file descriptor」：两者都需要插件侧主动
申请，而本方案由宿主单向推送，插件不具备申请动作，攻击面更小。`plugin-secret-broker` 的租约
机制保留给未来确有主动申请需求的场景，本路径不经过它。

secret 字段的声明写法见 8.2 节（`writeOnly: true` + `"x-narrafork-secret": true`）；
`format: "password"` 亦被接受，三种写法由
`isSecretSchemaNode`（`plugin-provider-config-service.ts`）统一识别。

### D-04b：插件声明的 command 如何被调用（已决策）

**[已决策]** 新增 Host→Plugin 方法 **`commands.invoke`**。

背景：Manifest 一直支持 `contributes.commands[].handler: "server"`，但没有任何消费方。
`commands.execute`（插件 UI 调用的方法）解析的是**宿主自己的** `CommandRegistry`，其条目是宿主函数，
因此插件声明的 command 无法被路由——是死代码。

实现：

- `commands.invoke` 与 `tools.invoke` 同形（宿主发起、插件应答），带超时、输入/输出字节上限、取消。
  参数为 `{ contributionId, input?, context: { requestId, correlationId?, deadlineAt?, idempotencyKey? } }`。
- `server/services/plugin-command-registry.ts` 从 manifest 注册 `handler: "server"` 条目；
  `handler: "ui"` 的条目也被记录，但调用时报「由 UI 处理、没有后端」，与「不存在该 command」区分开。
- `PluginUiHost.command()` 在宿主 `CommandRegistry` **未命中时**才回落到插件注册表，因此插件无法用
  同名 id 遮蔽宿主 command（有专门回归测试）。
- 结果 schema 为 `{ output?, secretWrites? }`。`secretWrites` 的语义与限制见 07 号文档 §13。

**不影响既有清单**：`commands.invoke` 是新增的**另一个方向**的方法，不进
`PLUGIN_TO_HOST_REQUEST_METHODS`，也不进 iframe 的 `PLUGIN_UI_BACKEND_METHODS`；冻结这两个清单相等的
contract parity 断言未改动。

### D-05：prefix 与内置 provider 的冲突策略

**本文建议**：所有来源共用唯一命名空间，即使内置 provider 当前 disabled，也不允许插件占用其保留 prefix。

### D-06：插件推理 continuation 的持久化字段

**本文建议**：为 `ReasoningProviderMetadata` 增加通用 `plugin` 字段，并用 `source` 阻止跨上游重放签名。

需要确认数据库 `contentJson` 的兼容迁移不需要 schema 变更，以及前端是否展示该 metadata。

### D-07：v1 是否包含原生 web search 和 image generation 输出

**本文建议**：核心 v1 不承诺；规范化 history 可以保留对应 block，实时事件放入后续 capability extension。

### D-08：绝对 operation timeout 是否允许 provider 覆盖

**本文建议**：插件只能声明更小建议值，不能提高宿主硬上限；用户可在宿主设置内调整软上限。

### D-09：Content-Length framing 是否由官方 SDK 封装

**本文建议**：至少提供 TypeScript 参考 SDK 和跨语言协议测试 fixture。否则各插件自行实现 framing、credit 和取消，
很容易产生不兼容实现。
