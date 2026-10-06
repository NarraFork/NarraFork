# Dynamic Spec：同步对象编排与团队任务系统

> 状态：交互契约已按冻结 V6 完成资格验证（24/24）。同步执行底座与默认关闭的只读 Eval 已实现，真实 Read 复用原权限/设备执行链并持久化子调用。尚未启用任何真实 narrator，也未接入任务写入口；团队任务持久化、写操作、UI 和跨平台驱动仍待实施。
> Agent 默认只获得 §2.1 的简短说明，其余接口按需帮助，不能把本文全部注入提示词。Schema 变更必须先修改 `server/db/schema.ts`，再运行 `bun run db:generate`；禁止手改 `drizzle/`。

## 1. 已确定的方案与边界

**Agent 操作同步任务对象；专用 Worker 等待 RPC；宿主异步执行并统一校验。** 不要求 agent 判断何时写 await，也不通过改写所有函数/回调来模拟同步。

```text
Agent 的 Eval 代码
  Task / TaskCollection / tools 对象（在 vm 内创建）
       ⇅ 有界共享内存，同步 RPC
  Broker（异步等待、转发，不阻塞应用事件循环）
       ⇅ 经过认证的宿主调用
  统一调用网关 → 任务领域服务 / 原工具执行管线
       ↓
  持久任务、来源、事件、回执与运行意图
```

必须保持的约束：

- **一份 team 任务树，多种视图。** 主代理默认看概要；子代理默认看自己的任务，也可按需查看同 team 全局或其他成员。读取范围不决定修改权限。
- **任务长期保留，通常归档而不删除。** 默认查询排除归档；显式历史查询可找到任务、子树、成果和来源。限制一次加载的量，不以小规模条数限制累计历史。
- **任务树、成员关系、展示工作集、执行资格互相独立。** 少展示不能漏调度；结束一个 run 不等于删除成员或任务。
- **创建来源由宿主隐性、不可变地记录。** 模型不填写 tool call、消息位置、版本、租约或幂等键。
- **同步只是调用方式，不是事务或权限保证。** 普通调用逐次提交；受保护承诺、验收、工具审批与取消仍由宿主处理。
- **Worker/vm 不单独承担不可信代码的安全隔离。** 外层执行环境必须满足 §10 的准入条件，不能静默降级成拥有宿主全部能力的裸 eval。

本期不做任意 npm 程序执行、完整异步 JavaScript 宿主、隐式并行、任意历史时点回放或通用 DAG 工作流引擎。既有直接工具、UI、插件和 External API 是同一服务的适配入口，不再引入另一套任务状态。

## 2. Agent 接口：拿到对象就操作对象

### 2.1 默认使用说明

当前任务由宿主明确绑定为 `task`；列表入口为 `tasks`。代码按普通同步顺序执行，方法返回实际结果或抛错。

以下是独立用法，不是一段依次执行的程序：

```ts
tasks.list();                           // 当前相关任务的树状概要
task.read();                            // 展开当前任务的说明/结果
task.children.add("补充边界测试");         // 在当前任务下拆分工作
task.finish("测试已通过");                // 报告完成了自己的工作
task.block("缺少测试账号");               // 记录受阻原因
```

新建并自行执行一项工作：

```ts
const check = tasks.add("补充测试");
check.start();
// 通过 tools 中已启用的工具开展工作。
check.finish("相关测试已通过");
```

先区分当前是在执行、验收还是查询，不让模型从状态词自行猜动作：

| 场景 | 最短正确流程 |
|---|---|
| 执行自己的工作 | 读取必要要求 → 操作并验证 → `finish(summary)`；测试失败记录真实错误并 `block` |
| 负责人验收他人提交 | **实际验收的同一次 Eval、同一个对象** `read()` → 核对最新结果与验收要求 → 满足后 `accept()`；不能用 finish |
| 只查询或制定计划 | 查询/分页或创建 todo 即可，不额外开始、提交或恢复历史任务 |

确定的顺序步骤放在同一次 Eval；需要模型理解新信息时用外层 return 观察，准备答复本轮结果时推荐 `deliver(value, summary?)` 明确封存。value 只放用户要求的值，说明另放 summary。完成、真实受阻、等待确认或只读查询都可交付阶段结果，不要求任务先变 done。

正确 Eval 结果之后的模型正常自然 end_turn 也是合法兼容终态，不必为了补 deliver 重新执行工作；预算耗尽、截断、未知结束或最后一个工具错误未处理不算正常终止。结束本轮答复不会取消持久任务、撤销后续调度或解除 protected。任务数据未变且目标已达成就结束，不为展示状态而重复测试、提交或查询，也不为省调用省掉必要验证。

合并脚本中的 catch 要按失败调用/错误码分流：实际测试失败才记录阻塞，提交目标变更则重读要求并返回、不自动改生命周期。不能把测试与提交的全部异常一律当作测试失败。

默认只看概要，详情和下一页按需展开。finish 返回自管任务 done 或分派任务 submitted；后者是本轮执行工作的提交，不代表负责人已验收。归档不删除；结果未确定时不盲目重建或重试。

宿主真正启动已分派任务时可自动记录 doing，子代理不必为了记账再 start。创建、读取或改变界面焦点不触发开工。

### 2.2 集合、任务与页面对象

| 对象 | 常用接口 | 语义 |
|---|---|---|
| TaskCollection | `list(options?)` | 返回有界 TaskPage；默认主代理看 team，子代理看自身分派范围 |
| TaskCollection | `get(key, options?)` | 定位一次已有任务，返回 Task 对象；key 不是授权令牌 |
| TaskCollection | `add(text, options?)` | 创建并返回 Task；可带 children 字符串数组，作为一次有界原子创建 |
| Task | `read()` | 按需读取详情并更新本对象的已读快照；大内容分段返回 |
| Task | `start()` | 开始当前有资格执行的任务，不新建 agent，不自动解除暂停 |
| Task | `finish(summary)` | 自管工作映射到提交并验收；分派工作映射到提交待验收 |
| Task | `block(reason, options?)` | 记录阻塞；显式提供 waitFor 才建立对应等待描述 |
| Task | `children` | 子任务集合，不是无限加载的数组 |
| TaskPage | `items / hasMore / next()` | items 仅含当前页；next 保留查询上下文，不要求 agent 拼 cursor |

`Task.key/text/status/paused/archived` 是只读概要快照，不允许直接给 status、owner 或 protected 赋值。读取这些字段不产生隐藏 RPC；start/finish/block 成功后更新并返回当前 Task 对象，read 返回有界详情并刷新该对象。对象携带内部句柄和已读版本，模型不提取 ref 再传回管理器。

- `task` 在 Eval 开始时绑定到明确的执行上下文，不跟随 UI 焦点或“最近读过的任务”变化；没有唯一目标时返回选择提示，不猜第一条任务。
- 主代理 `tasks.add` 默认创建根任务；子代理默认在本次分派根下创建。指定父节点用 `parent.children.add(...)`，不手填父 ID。
- `tasks.get("T7")` 的可读 key 在其 team 内长期唯一，归档后不复用；内部仍用不可变 taskId。跨 team 定位必须独立授权。
- 对象只在本次 Eval 中有效；跨回合保留 key，重新取得对象。不得依赖 Worker 堆长期存活。
- 句柄由宿主绑定到 taskId、读取上下文与观察版本；它不替代权限。伪造对象、句柄或 key 不能扩大访问范围。

### 2.3 视图、历史与按需帮助

```ts
tasks.list({ scope: "team" });
tasks.list({ agent: "frontend" });
tasks.list({ agent: "frontend", relation: "participated", archived: "include" });
tasks.list({ archived: "only", search: "权限" });
tasks.get("T7", { archived: "include" }).read();
```

scope 与 agent 选择互斥；子树通过 Task.children 查询。人员关系为 current（默认执行者）、creator、participated，已结束成员仍可查历史。归档选项为 exclude（默认）、include、only。

页面只返回当前命中项；用于定位的祖先路径单独标记为上下文，不混进命中计数。树中的每个折叠点区分未加载、部分加载、已加载；当前页结束不代表整棵树没有更多节点。显式历史查询取得的对象保留对应读取上下文，不需要先恢复任务才能看正文。

进阶能力以对象方法提供：`task.accept/revise/archive/restore/pause/resume/reopen/update/moveTo/delegate/history/origin`。默认不注入整张方法表，统一用同步的 `help("task.archive")` 等入口按需查询；负责人验收流程直接提示 accept，不强迫先查目录。尚未实现的方法不得出现在运行时目录或动作提示中。

- 方法签名、简短语义、Eval description 和按需帮助来自同一份公开契约；API 说明由其生成。测试同时枚举实际公开方法并核对帮助覆盖，防止声明与实现各自漂移。
- `read()` 合并有界概要与详情，并返回 `workflow: { kind, actions, note }`。提示由真实角色、任务状态和权限范围推导，不基于题号或评分条件；只在展开时返回，列表继续保持概要。actions 是可选动作，不是新待办清单或授权令牌，执行时仍重新校验。
- accept 绑定本次 Eval、同一个对象已读到的具体提交；另一对象、上一 Eval、列表或自动刷新都不替换验收凭据。提交变化时要求重新 read 并核对，不自动验收未知结果。
- delegate 自动携带本对象身份，仍走现有 Agent 的可用性、权限和启动流程，不要求 agent 手动建立成员、assignment 或 intent。
- `add(text, { children: [...] })` 由宿主原子创建；一般循环不是事务。首版不要求 agent 学习通用 batch builder 或 DraftRef。
- 每个动作输出任务 key、真实业务状态、必要说明和下一步；内部版本、回执、事件序号只在 trace/调试详情中。

### 2.4 Eval 的结果与代码范围

- 支持类型注解、普通变量、函数、条件、同步循环、map/forEach 和 try/catch。可信 Worker 层剥除 TS 类型，不自动插入 await。
- 默认编排模式不支持 async/await、模块导入、定时器或 Promise 后台工作；语法与能力检查提供同步替代提示，不能默默忽略不支持的代码。检查不充当安全沙箱。
- 单次工具/对象调用自动展示其结果；组合脚本可显式 return 筛选后的数据，保留调用方要求的状态/数组/文本形状。状态取自对象，不编造 finished 等值。没有显式结果时可展示最后一个完成调用的摘要，不回灌全部中间结果。
- `tools.*` 的原生失败结果规范化成 vm 本地错误，未捕获时停止后续语句；不能把失败当空数据继续执行。
- 合并调用不等于统一错误处理。catch 必须按失败调用/错误码分流：真实执行失败可记录阻塞；`CONTRACT_CHANGED` 重读最新要求并返回，不自动改变生命周期；`READ_REQUIRED` 在执行验收的同次 Eval 对该对象重新读取核验。不能把覆盖测试与提交的整个 try 的所有异常一律转为 block。
- 错误反馈说明失败动作、当前情形、本次是否修改和正确下一步；“本次未修改”不代表此前调用被回滚。提示不包含无条件验收未知结果的可复制脚本，也不自动重跑或撤销用户工作。
- 对象预览与序列化只使用缓存；进入结果封装阶段后网关关闭新 RPC，不能让 getter/toJSON 触发额外业务调用。最终结果在 vm 内、受预算约束地序列化，宿主不调用用户对象的 getter/toJSON。
- 任一 Eval 结束或取消后拒绝新的 RPC；不支持的异步代码不得在结束后继续产生宿主副作用。

## 3. 执行器与同步 RPC 协议

### 3.1 Runtime 分层

同步代理对象在 vm 内创建，异步领域 SDK 只存在于宿主。RPC 是二者之间唯一的能力通道。

```text
应用进程：调用网关 / coreTasks / 原工具执行器
       ⇅ 经过绑定、限流的异步 IPC
执行环境：Broker（Atomics.waitAsync）
       ⇅ SharedArrayBuffer 邮箱
专用 Worker：vm / Task 代理（Atomics.wait）
```

Broker 与 Worker 必须在同一进程内共享 SAB；不假定 SAB 能直接跨进程传递。功能测试可将 Broker 放在独立测试进程的主线程，生产按 §10 选择符合隔离策略的执行环境。

一次 Eval 使用一个 Worker、一个新 vm context 和一组邮箱，不复用用户对象或微任务状态。默认串行，每个 Worker 同时只有一个在途 RPC；需要并发时另接显式宿主并发能力，不把 Promise.all 当作隐式并行。

启动顺序：

1. 可信 bootstrap 在空 vm context 中创建 SAB、编码器、RPC 函数、Task/页面对象工厂。
2. SAB 向外交给 Worker/Broker，共享底层字节；不把宿主的函数、Promise、Error、对象或缓冲区包装对象注回 vm。
3. 宿主建立不可由请求帧覆盖的 RunContext：actor、team、外层 tool call、当前任务、预算、停止状态。
4. 通过字节协议传入有界初始数据，在 vm 内重建对象；完成握手后才运行用户代码。
5. 每次调用返回真实值或重建 vm 本地错误；所有关键决定在宿主完成。

### 3.2 邮箱布局与所有权

生产协议与 PoC 区分：采用独立请求区、响应区和终态控制位，不能用同一个状态格同时表示响应就绪与取消。

| 区域 | 内容与约束 |
|---|---|
| 固定头部 | magic、protocolVersion、帧序号、长度；只作协议检查，不作身份认证 |
| 请求槽 | Worker 写，Broker 复制；`EMPTY → WRITING → READY → READING → EMPTY` |
| 响应槽 | Broker 写，Worker 复制；`EMPTY → WRITING → READY → READING → EMPTY` |
| 唤醒计数 | 分开的 requestSignal、responseSignal；在发布、消费和取消时递增并 notify |
| 终态控制 | cancel/close 与数据槽状态独立，单向终结；响应路径绝不清除取消标记 |

初版使用有界 UTF-16 code units 编码 JSON，与功能 PoC 一致，避免注入宿主编码构造器。容量以字节配置，length 明确以 code units 表示；必须验证非负、对齐和上界。

发布/消费算法：

1. 生产者 CAS 取得 EMPTY 槽，写完整 payload、length、sequence，再以 Atomics 发布 READY 并 notify。
2. 消费者先取得 READY 槽的所有权，复制到自己持有的有界输入，再检查完整 JSON、schema、sequence 和方法；后续 await 不再读取共享参数。
3. 请求复制后可释放请求槽，但宿主的 inFlight 状态要保留到响应消费；任何额外并发请求按协议拒绝。
4. Broker 异步执行授权调用，只有本 run/sequence 仍有效且响应槽可用时才发布结果。
5. Worker 校验 sequence、终态和长度，复制响应并在 vm 内解码，确认消费后返回结果；域内对象更新其观察快照。

等待必须采用“读取唤醒计数 → 检查条件 → 按旧计数 wait/waitAsync → 循环重查”，防止检查与等待之间丢失通知。Broker 正确处理 waitAsync 的 `{ async, value }` 返回结构，不做忙等。Worker 阻塞时不能依赖自己的 onmessage 接收响应。

共享字节仍是不可信输入。槽所有权约束合法双方，不能证明恶意写入者不篡改内存；宿主只执行复制后经严格校验的数据，身份与权限取自自身 RunContext。

### 3.3 请求、响应与对象重建

请求包含协议版本、sequence、receiver handle、公开方法名和数据参数；不接受 actor、user、namespace、来源位置或权限覆盖字段。调用网关将 handle 解为当前 run 内的对象身份，并再次检查实际对象权限。

响应只承载 JSON-safe 值、受控对象描述符、资源引用或错误：

- 只有网关签发且属于当前 run 的受控描述符才由 vm 工厂重建为 Task/页面/Job；不能按任意工具正文中的 type 字段自动复活对象。方法闭包保存句柄，宿主对象不跨 realm。
- 错误传 code、有限 message、提交结果与建议，在 vm 内 new Error；完整堆栈和回执留在宿主。
- 大文本、图片、二进制和超大结果返回有权限的分页/资源引用，不能截断后标为完整结果。
- Task 的概要是观察快照，不是 live 数据库对象。read 刷新该对象，成功修改更新其缓存；过期对象不能静默覆盖较新状态。
- 宿主只按已发布的方法集合执行，不开放任意 service 名称、SQL、模块加载或数据库连接。

### 3.4 取消、超时和迟到结果

- 宿主先将自己的 RunContext 标为停止，再设置共享终态并 notify 两个方向；仅设置 AbortSignal 不能唤醒 Atomics.wait。
- Worker 在发布前、每次醒来、消费前检查终态。取消是粘性的，迟到响应不能把取消覆盖为成功。
- RPC 超时、协议损坏等致命错误关闭该 Eval 通道，不复用邮箱继续发新命令；普通业务拒绝可被 try/catch 捕获后继续。
- 取消停止等待、撤销尚未提交的审批/调用资格，并向实际前台工具传播取消。已提交副作用仍然提交；明确启动的后台任务不因 Eval 结束自动被取消。
- 用户代码可绕过 SDK 无限循环或阻塞另一块内存，所以还需独立总 deadline、真实终止及内存限制，不能依赖协作取消或 vm timeout 覆盖所有情况。
- evalRunId 只标识本次脚本；task executionRunId 标识有资格推进任务的执行段，可跨多次 Eval。二者不能混用。

## 4. 统一调用网关与工具集成

网关从外层真实调用捕获身份、所属 team、来源和执行资格。每次子调用重新求当前工具可用性、权限、任务资格与停止状态；执行设备/路径在该次子调用执行前解析并固定，不能由脚本伪造身份。

| 调用类别 | 路径 | 提交与审计 |
|---|---|---|
| 任务查询 | 权限过滤后的有界查询 | 记录调用摘要/观察版本，不复制全部对话 |
| 任务修改 | prepare → 必需审查 → applyTaskOps | 同事务写任务、origin/event、receipt 与必要运行意图 |
| 真实工具 | 原工具执行管线 | 保留每次权限/反思、输入输出、设备、快照与错误 |
| 分派/后台操作 | 已授权工具 + durable intent | 返回受控 Job 对象；等待与停止是不同操作 |

关键接入约束：

- 外层 Eval 是编排边界，不跨整段脚本持有 worktree/narrator 的写锁或 SQLite 事务，避免内部工具/子代理无法取得锁。各子调用按原规则获得其需要的锁和执行 lease。
- 文件快照在实际 Write/Edit/Bash 等子调用边界捕获，不能只给整个 Eval 做一次前后差分，也不能重复归因邻居的文件修改。
- 每个真实工具子调用持久化独立调用记录；新增 nullable `parentCallId` 和调用序号或等价关联，不能假定现有工具表已有 parentToolUseId。
- 子调用是外层 assistant 消息下的执行 trace，不伪造模型发出的额外 tool_use/result 消息。模型只收到最终摘要/选定结果，UI 可按需展开子调用。
- 任务字段操作记领域事件，不为每个字段伪造工具调用。任务在 Eval 内创建时，以外层真实 tool call + RPC/operation 序号定位来源。
- Agent 的嵌套限制、只读模式、可选工具列表、用户审批、行为护栏首调用授权等继续生效；脚本内部调用不是新的用户回合。
- 反思/审批在事务与写锁外等待，批准绑定操作摘要及相关版本；取消/超时后的批准不能恢复已失效的执行资格。

## 5. 任务权限与生命周期

### 5.1 角色

team 主代理/显式 accountable 成员为管理者 M，当前 assignee 为执行者 E，同 team 其余成员为读取者 R。有权管理该 team 的用户请求 U 可明确代办并留痕，不能伪造 E 的执行报告。安装插件的信任不自动变成用户授权。

| 操作 | M | E | R |
|---|---|---|---|
| 读共享任务/历史 | 允许 | 允许 | 允许 |
| 读来源会话/私有资料 | 独立鉴权 | 独立鉴权 | 独立鉴权 |
| 新建根任务、改目标、移动、转交 | 管理范围内 | 仅自己同时是 M 的任务 | 拒绝 |
| 在已分派范围拆普通子任务 | 管理范围内 | 有 task-edit 能力时允许 | 拒绝 |
| start / block / finish | 仅自己同时是 E 的任务；他人工作走管理动作 | 当前执行资格内 | 拒绝 |
| 验收、打回、取消、归档、恢复 | 管理范围内 | 仅自己同时是 M 的任务 | 拒绝 |
| 设立/解除 protected | 明确用户依据及必要审查 | 不因分派获得权限 | 拒绝 |

子代理自己拆出的执行子任务默认由其自管，但不能移出授权子树或改写上层目标。review/search 可取得狭窄 task.report 能力，不因此获得代码写入或任务管理权。扩大查询范围不扩大修改权。

### 5.2 状态转换

执行状态为 `todo | doing | blocked | submitted | done | cancelled`。归档、显式暂停与运行资格独立保存；任务树不等于 agent 树，也不隐含执行依赖。

| 动作 | 前置条件 | 结果 |
|---|---|---|
| add | 父链允许新工作且有创建权 | todo；创建与 origin 原子提交 |
| start | todo、当前资格有效、未暂停；宿主确认开工也走此动作 | doing；同一有效执行已 doing 时可返回无变更 |
| block | todo/doing，提供原因 | blocked；未指定等待对象时记 unspecified，产生一次待分类事项 |
| finish | 当前 E，doing，目标版本有效、必需后代已终结 | 同时为 M 时原子提交并验收到 done，否则 submitted；M 不能用此动作替他人验收 |
| accept / revise | submitted，针对已读且仍有效的 submission | done / todo；打回保留报告并撤销旧运行资格 |
| reopen | done/cancelled，原因明确，父链允许 | todo + paused；当前完成标记清除，旧完成事实保留在历史 |
| cancel | 有管理权、后代已妥善处理、承诺审查通过 | cancelled；撤销资格，不隐式取消后代 |
| pause / resume | 无维护冲突；恢复前旧执行已收束 | 保留/清除显式暂停；原 doing 已停则回 todo，blocked/submitted 保留语义 |
| transfer / delegate | 旧执行已收束，或尚未被 claim | 新分派代数；delegate 另走真实 Agent 启动，不重复造执行者 |
| archive / restore | 满足 §9 的条件 | 修改归档可见性，不等于完成或启动 |

不变量：

- `done/cancelled` 父项下不能新增/重开活动子项；先显式重开必要父链。
- 完成与父级取消检查所有后代的权威未终结计数，不只看当前页、未归档项或展示摘要。归档但仅暂停的后代仍是未终结工作。
- `openDescendantCount/protectedOpenDescendantCount` 不含自身；小操作在同事务沿有界祖先链维护，大结构变更走 job。未知/修复中的计数不能当零。
- 修改目标/验收条件增加 contractVersion，并使旧执行/提交待重新确认；新目标不能套用旧结果直接验收。
- 结果绑定 assignmentVersion、executionRunId、contractVersion；失联/转交后不得刷新这些值冒充新执行者。撤销资格不能回收已经发生的外部副作用。
- 暂停禁止新的执行和 E 报告，但不阻止 U/M 管理有效提交或明确取消；维护屏障只允许持有当前 job epoch 的协调器写入。
- 任何退出、失联、归档、compact 都不得自动解除 protected。普通创建不默认建立承诺。

## 6. 默认视图、懒加载与独立调度

### 6.1 查询规则

主代理默认看到未归档根任务及焦点的两层概要；子代理默认看到自身分派范围及少量祖先上下文。所有成员可显式查看同 team 全景、指定成员或子树；跨 team 和私有引用另行授权。

- 列表从数据库就只读概要列。结果、验收条件、历史、来源、文档正文分别按需加载。
- 普通 tree/list/get/children/search/history/origin 默认 exclude 归档；历史访问必须显式选择 include/only，且不触发恢复或续跑。内部完整性判断、管理快照不套用展示过滤。
- 带关键词、归档或人员条件的查询在整个授权范围找匹配项，不能只查当前可见根节点而漏掉深层归档任务。
- 每个集合 cursor 独立，按稳定排序键加 taskId 定位。结构分页只随相关子项增删、排序、归档等失效；无关兄弟状态/摘要刷新不能使全团队分页重来。
- 带动态状态过滤的查询声明 live-page 或快照语义，不能拼接不同版本后声称完整；过期时只重载相应集合。
- 历史搜索先索引标题/短摘要及结构过滤，详情索引后续显式增加。索引后台维护并返回水位，不在请求中 rebuild 或退回全库大扫描。

### 6.2 长期资料与工作集

| 数据 | 保存方式 | 默认加载 |
|---|---|---|
| 任务概要 | 稳定行、状态、父子关系、负责人、归档标记 | 有界树/列表 |
| 说明、验收、成果 | 独立内容 revision，大附件只保引用 | 定点展开 |
| 任务历史与来源 | 事件、不可变来源坐标 | 不默认 join 正文 |
| 架构设计/接口契约 | 独立 spec 文档及 revision，任务通过 links 关联 | 小索引与必要摘要 |
| 当前工作集 | focus、固定入口、展示已读游标 | compact/重启后重建 |

归档任务不删除设计文档或其他任务的引用；摘要不替代原文。index.md 只作短导航，不无限追加执行日志。摘要带 basedOnRevision/asOf，过期不能作为验收或授权依据。

Worker、缓存和 WebSocket 都不是数据真相。缓存按权限、查询范围、归档过滤和相关版本分开并有容量限制；compact 只恢复工作集及导航，不把全量历史灌回 prompt。

### 6.3 调度不读“当前页面”

`selectDisplayWorkingSet` 与 `selectEligibleActions` 是独立查询。调度器从持久任务、分派和待验收记录选择动作：

- 未显示、未固定、未加载的任务仍参与调度；扫描预算耗尽返回 morePending，不能当作无事可做。
- 归档、显式暂停、等待仍有效执行者的任务按规则排除；M 处理验收/失联，不与 E 重复执行。
- 确定性顺序加有界焦点偏好，定期照顾更早候选，避免历史任务饥饿。
- blocked 可带 dependency/user/external/investigation 等等待描述；事件只是复查机会，依赖取消不等于条件满足。无事件源时不无限轮询，循环等待转为管理事项。
- 全局 off、用户中断、权限和运行预算优先；protectedOnly 判断持久承诺及其可执行推进动作，不判断当前页有没有 protected。

## 7. 持久模型与隐性来源

### 7.1 逻辑记录

以下可按既有存储能力组合，不要求每个概念独立建表：

| 记录 | 必需内容 |
|---|---|
| Team/成员 | 稳定 namespace、所属用户/项目、当前主代理、成员及 membershipVersion；退出后保留身份 stub |
| Task | taskId、长期唯一 key、parentId、排序、text、状态、保护/暂停/归档、管理者/执行者、观察版本 |
| 版本/完整性 | version、contractVersion、childrenVersion、assignmentVersion、当前 run/submission、权威后代计数 |
| Details/links | 说明与成果 revision；任务到文档/产物及其版本的关联 |
| Origin | §7.2 的不可变创建现场 |
| Events/receipts | 有界字段变更或内容 revision 引用、提交结果、幂等输入 hash |
| Assignments/submissions | 分派历史、不可变提交与证据、原执行/目标代数 |
| Intents/checkpoints/jobs | 待运行意图、消费进度、维护 epoch、租约和重试位置 |
| Working set | 仅展示焦点与游标，不充当调度队列 |

管理者/执行者引用持久成员身份，活跃 narrator 绑定可以失效，不级联删除历史。textHash 仅用于提示/检索，不作为身份唯一约束。

必要索引覆盖：team 内未归档同级枚举、执行者+状态、归档时间、task 事件序号、team 事件序号、来源 toolCall/message 反查、活动 job/过期租约。查询使用 cursor + limit + 1，不先全量 COUNT，不读取详情后再裁剪。具体索引须用真实数据与执行计划验证。

### 7.2 创建来源

任务创建与 origin/event 同事务提交；值由可信调用上下文和已持久化的调用/消息记录取得，不从“最新一条消息”猜测，也不允许脚本提交覆盖字段。

```text
sourceKind: agent | user_ui | plugin | external_api | system | import
creatorNarratorIdSnapshot / actorUserIdSnapshot / createdAt
originConversationId
sourceToolCallIdSnapshot / sourceToolUseIdSnapshot
sourceMessageIdSnapshot / sourceMessageRefIdSnapshot
sourceSeqAtCreation / sourceBlockIndexAtCreation
triggerMessageIdSnapshot（能确定时）
outerEvalToolCallIdSnapshot / RPC sequence / operationId / operationIndex
requestId / 可选的内容版本或 hash
```

- taskId 表示稳定任务身份；toolCallId 是数据库调用记录 ID，toolUseId 是协议 ID，不能只保存后者。seq/block index 仅作创建时位置快照。
- Eval 中多次创建共享外层消息/调用，但 RPC/operation 位置不同；真正由子工具创建时也记录对应子调用。
- 重命名、移动、转交、归档、恢复不改 origin；后续变更各自留事件。消息共享、fork、编辑/COW 用额外导航映射，不改写原始事实。
- 不可变坐标不随源消息/工具删除被清空；可导航 FK 可 set null 并标记失效。保坐标不等于保全文，原文被明确删除后不得承诺还原。
- UI/API/导入没有 tool call 时如实置空；旧数据来源未知时标明未知，不能把迁移动作冒充原始创建现场。
- 默认对象/列表不带这些字段。origin 按需读取，并分别检查任务权限和源会话权限。

## 8. 提交、幂等与运行恢复

### 8.1 修改管线

宿主完成：规范化输入 → 解析对象句柄 → 当前权限/状态/维护屏障检查 → 必需的反思/审批 → 短事务内重查版本和资格 → 写任务、origin/event、receipt、必要 intent → 通知消费者。

只对命令依赖的观察版本进行校验；summaryVersion/lastViewed 等缓存变化不构成业务冲突。标题歧义、权限缺失、目标变化都不能通过“自动刷新后覆盖”修复。大型任务不能在普通事务里无上限展开。

原子性单位是一次领域命令及明确的复合动作，例如创建父子任务、自管 finish。循环、多次 RPC、跨文件/网络工具不构成全局事务；发生错误要显示已提交部分。

### 8.2 回执和重试

- 宿主用 evalRunId + RPC sequence，必要时再加子操作序号建立调用身份；将解析后的目标和参数规范化 hash 与 receipt 绑定。
- 同身份同输入的传输重试返回原 receipt；同身份不同输入拒绝。新的 Eval 是新意图，不按相同标题自动去重。
- 提交成功响应丢失，先查原 receipt；不能重新运行整段脚本。结果未知时保持 unknown，不说“未提交，请重新创建”。
- 未决回执不得 TTL 淘汰；完成后可只留输入 hash、结果引用与提交状态等最小凭据。缓存淘汰不能令旧请求再次执行。
- 默认只给 agent 简短原因与下一步；冲突让对象 read，失效分派交管理者处理，权限拒绝不建议扩大 scope，分页过期只重载对应集合。

### 8.3 持久事件与派发

复用任务事件作为可靠变更源，消费者持有独立 checkpoint；展示已读游标不能代表调度已处理。消费采用至少一次投递和幂等动作标识；先持久化待执行意图，再确认事件。

`delegate` 经原 Agent 审批流程建立 intent，至少保存 taskId、assignment/contract 版本、预留 narratorId、executionRunId、来源、状态和 leaseEpoch。

- pending → claimed 通过 CAS；claim 即占用执行资格。启动前再次检查权限、停止状态及任务代数。
- 重试查询预留运行身份，不新建第二份 agent；claimed/started 尚未收束时不得强行转交。
- 租约过期不证明远程工作已结束。不能确认时转 lost 并暂停，交管理者处理，不盲目重跑有副作用的工作。
- 任务提交后、通知前崩溃，由事件消费者补处理；WebSocket 仅加速通知，不保证送达。
- UI 可丢弃过量旧通知后重载；调度消费者须证明旧事件被当前状态覆盖或先重建候选索引，不能直接跳过未处理工作。
- 任何恢复动作重查 off/暂停/撤权；不恢复任意 JS 堆，不自动重放整段脚本，不承诺外部工具 exactly-once。

## 9. 归档、保留与 fork

### 9.1 归档规则

完成与归档独立：done 仍可在默认查询出现；归档后保留任务、结构、成果、事件和来源，但退出默认视图与调度。

- 默认 archive 只处理符合条件的工作。普通未完成项必须明确选择暂停并说明原因；正在执行的工作先收束；开放 protected 必须先经明确用户决策/审查妥善处理。
- restore 只恢复可见性，保留暂停；不自动启动 agent。恢复仍有归档祖先的节点时，需明确恢复必要祖先，否则拒绝。
- 非叶节点归档明确覆盖子树，不能留下藏在归档父项下的活动任务。恢复某批次不得带出更早独立归档的分支。
- 不按天数/数量静默删除或归档未完成任务。存储有配额、告警和备份策略；物理 purge 只能是独立明确的用户管理操作。

### 9.2 大子树维护 job

小范围有界事务；大范围采用 `queued → validating → quiescing → applying → completed`，另有 failed/cancelled，并返回 partial 信息。

- 先取得持久子树屏障，再验证范围、权限和承诺；只有明确允许暂停的普通工作才能进入 quiescing。
- 屏障与 worker lease 分开，覆盖新派发、结构变化及影响资格的修改；读取仍可用。每批提交同时推进检查点。
- 归档自叶到根，恢复自根到叶。接管增加 epoch，旧 worker 的写入被拒绝；完成/失败/取消由可信协调器释放屏障，不只靠 finally。
- watchdog 按活动 job/过期 lease 索引工作。重试有预算；不可恢复时保存 partial 结果并清除失去执行者的屏障，不能永久锁死子树。
- applying 中取消保留已提交部分；撤销它们走独立 restore job，不做巨大同步回滚。因维护停止过的执行不随屏障释放自动重启。

### 9.3 固定 fork 时点

首版采用**稳定读取快照 → 后台物化复制**，不增加通用 task MVCC/COW 引擎。

1. 后台独立只读连接固定数据库快照，记录 task sourceEventSeq=S 及文档 revision 集合；S 是实际捕获时点，不是请求入队时间。
2. 同一读取事务内分页流式导出完整任务/关系/详情/来源/历史及可读文档版本到私有 staging artifact，附 manifest 与校验。设置捕获时间、字节、磁盘/WAL 预算。
3. artifact 完整持久化后才 snapshot_ready；从它分批导入目标 namespace，校验完成后原子发布 ready，之前拒绝业务使用。
4. 捕获未完成就失败：明确报错，新捕获是新的尝试/新 S。artifact 完整后的中断才可从同一快照和检查点继续。
5. 目标 task 实例使用新 ID，保留 sourceTaskId → targetTaskId 映射及原 origin，重映射树和内部链接；历史事件导入不触发旧派发/唤醒。
6. 文档版本复制到目标保留边界，避免源 namespace 删除破坏目标。私有资料另行鉴权；发布前重新检查授权，不能用 staging 绕过撤权。

目标执行绑定重新确认，不继续使用源 team 的活跃子代理，也不解除未完成承诺。源消息全文不自动复制，来源导航仍需原权限。完成导入后 artifact 是可清理缓存，不是任务唯一副本。

本期保证 fork 时快照，不保证任意旧消息时刻的任务状态。会话从历史消息 fork 时明确显示任务快照时点；要求历史 task 状态却没有对应快照时拒绝，不能暗用当前状态代替。

## 10. 安全、资源与功能证据

### 10.1 执行环境准入

Worker/vm 负责同步编程模型，不单独承担安全边界。生产启用模型代码前，驱动必须通过相应平台的权限与资源策略：

- 可复用插件的 runner、RPC 分帧、资源控制与取消设施，但使用绑定当前 narrator 的权限，不继承插件安装时的管理员信任。
- local-process 的超时/env 过滤不等于文件系统/网络隔离。需要强隔离时优先复用受约束容器或有等价 OS 限制的执行进程；无合格驱动就明确不可用，不裸跑在应用进程。
- 禁止向 vm 注入宿主可调用对象；裁剪不需要的环境/异步能力，阻止模块加载和动态代码生成。AST/关键词检查不是安全保证，需对内建可达能力作专项测试。
- 总 deadline、计算超时、合法 RPC 取消、进程级强制终止和硬内存限制分别验收。Atomics.wait 的协作唤醒不能覆盖恶意循环、另一块内存等待或 OOM。
- 确认线程/进程真正退出并回收资源，不能把调用 terminate 或收到 close 当作已证明回收。只终止本次执行环境，不停止承载应用/agent loop 的进程。
- 用户代码的结果/异常/日志在受预算的执行环境内编码；主线程只处理有界、经 schema 校验的数据。

### 10.2 初始预算（待目标环境压测）

| 项 | 初始上限/策略 |
|---|---|
| Eval 源码 | 64 KiB |
| 共享邮箱 | 请求 64 KiB、响应 256 KiB，控制区独立；默认一条在途 RPC |
| 单次 Eval | 最多 100 次宿主调用、100 个 task ops、累计传输 8 MiB |
| 时间 | 默认总 wall deadline 120s，含等待；显式延长受策略限制，初始硬上限 10min；每工具还受自身剩余预算限制 |
| Worker 数量 | 实例/用户/团队都有并发与排队上限；已超时且尚未确认退出的执行仍占额度，不无限补建 |
| 页面/树 | 默认每页 20、最多 100；默认深度 2，单次深度最多 8，总节点最多 200；树结构深度另限 32 |
| 详情与历史 | 正文单页建议 32 KiB，事件默认 50 条；不自动取源对话与大输出 |
| 提示词 | 简短对象说明 + 有界工作集；初始工作提醒预算约 1,200 tokens |
| 历史与导出 | 累计历史不设小条数上限；归档、fork、索引、导出走可取消 job，并配置独立磁盘/时间预算 |

内存硬上限必须来自已验证的外层机制，不能把 Worker smol 或一次 OOM 试验当作配额。等待审批仍占用资源和总时间；长工作使用明确 Job 句柄，不能无限挂起 Worker。

### 10.3 已验证到哪一步

功能 PoC：Bun 1.3.14 / Linux x64，独立 Bun 子进程、内存 Blob Worker，外层 12s 截止。以 Map 模拟任务服务，每普通 RPC 人为延迟 20ms，未访问真实任务数据库或工具。

首个生产底座切片（2026-09-10）已落在 `server/lib/agent/programmatic/`：强类型协议/有界 JSON、独立 SAB mailbox、只读宿主 gateway、VM 同步 runtime、NDJSON wire、rootless Podman 驱动和 service 编排。实际 Podman 环境为 Linux、rootless、cgroup v2、seccomp；固定本地镜像使用 `--pull=never`，显式禁用自动 mounts.conf、网络、能力、镜像 volume，并在发送用户源码前由宿主 inspect 核验实际配置。

验证结果：底座定向测试 261 pass / 11 skip / 0 fail；真实 Podman 集成 10/10，通过同步循环与异步只读宿主调用、授权拒绝、取消和迟到 Promise 额度保留、无限循环/Atomics.wait、输出上限、交付后调用阻断及全局隔离。首切片目前只提供可被宿主显式调用的底座，不注册 Eval 工具，不连接真实任务数据库，不开放 Bash/Write/Task 修改或任意 service/SQL；尚未完成真实任务授权、持久化 origin/event/receipt、审批/UI/WS、跨平台驱动和正式生产启用。

全仓类型检查仍受并行改动中的 [RenderToolCall.timing.test.tsx](../frontend/components/narrator/vlist/render/RenderToolCall.timing.test.tsx#L45) 一项既有错误阻断；本切片自身类型与定向检查已通过。该结果不是整体仓库验收或上线许可。

| 检查 | 已观察结果 |
|---|---|
| 同步对象/回调 | 无 await 的 add/start/finish、map/forEach 正常；3 个任务依次到 done |
| 返回值与错误 | 实际 Task/数组值可立即使用；宿主错误在 vm 内以本地 Error 捕获 |
| 宿主响应 | 11 次 RPC 的异步等待期间心跳执行 19 次 |
| 协作取消 | 合法等待被唤醒并抛错，1 个迟到响应被丢弃 |
| 时间 | 普通用例约 253ms，含约 220ms 模拟延迟，不是吞吐/开销基准 |

该 PoC 使用较简单的单槽协议。本文的双槽所有权、取消竞态、权限集成、强制退出、内存隔离和跨平台行为是待验收设计，不能从 PoC 推定已通过。

另有 [同步对象模型 challenge 与流程优化实验](task-call-challenges/OPTIMIZATION_RESULTS.md)：Luna low / Flash low 的验收动作选择和多个场景的往返次数改善，但 V4 的最终返回形状、达标后结束仍不稳定，两边严格通过均为 5/6。后续显式 `deliver(value, summary?)` 的 16 条同期对照中，V4 为 7/8、交付版为 5/8；新增机制未被稳定采用，故未扩跑或列入默认 SDK。原代码重放还确认了当前实验包装器中 IIFE 的内部 return 不等于 Eval 外层 return，最后表达式/观察/交付契约仍需独立验证。

随后对同一交付机制统一说明的 V6 在第 3/5 题的 16 条同期对照中，业务严格通过从冻结 V5 的 6/8 升至 8/8，Eval 从 22 降至 17；显式交付为 7/8。缺少的一条已正确返回并自然结束，不是业务失败，但仍未满足预登记的 8/8 干净交付扩跑门槛。因此尚未进行全六题模型回归，不自动替换默认 V4。后续应独立判断是否保留自然结束兼容路径，避免把 API 使用率代替用户结果正确性。

之后在新的资格验证中事先允许正确自然结束兼容路径，保持冻结 V6 输入、原题与原评分不变，全六场景各两次、两模型 low 共 24 条轨迹全部业务正确且有效终止（22 次显式交付、2 次自然结束，60 次 Eval）。这达到本轮交互契约的满意标准；54 项离线测试、265 个断言通过。生产实施按用户最新指示暂停，收敛后需通过 AskUserQuestion 交接并等待其明确继续。

这些测试使用 Bun 1.3.13-debian 容器内的模拟 SDK，不是上述 Worker/SAB 或生产 SDK；交互资格通过不等于生产权限、持久化、隔离、恢复或跨平台安全准入通过。

## 只读 Eval 试用入口（默认关闭）

管理员在服务启动环境中设置两项，缺少任何一项都会禁用：

```text
NF_READONLY_EVAL_IMAGE=<已预装的不可变本地镜像64位ID>
NF_READONLY_EVAL_NARRATORS=<允许试用的narrator ID，逗号分隔，最多16个>
```

随后在指定 narrator 按现有可选工具机制加载 `Eval`（`/load Eval`）。仅 Linux rootless Podman、cgroup v2、seccomp 且实际容器配置核验通过时运行；不自动拉镜像，也不降级为宿主裸执行。配置只是准入，Read 仍要经过该会话原有权限、设备、只读策略和运行时授权检查。此次未替用户设置环境、加载真实 narrator 或重启服务。

```ts
const result = tools.Read({ file_path: "/work/example.txt", offset: 1, limit: 40 });
return result.output;
```

第一版仅支持文本 Read，默认100行、最多200行；返回 `{output,bounded:true}` 表示有界视图，不能据此声称是完整文件。图片/PDF/notebook扩展名或非文本结果拒绝；大输出需缩小读取范围。不开放 Bash、Write、Edit、Agent、任务修改或嵌套 Eval。`deliver` 只结束当前 Eval，不提前结束主 Agent Loop 或解除持久任务。

子调用在原工具调用表单独落行，绑定真实父数据库ID/attempt和序号；不伪造模型消息。执行前、拒绝/失败/取消后均留记录。没有新增表、迁移或 UI。更新门关闭时内部 Read 立即拒绝，避免父 lease 等子调用、更新又等父 lease 的死锁。若仅子 signal 取消而人工权限请求已打开，会等原审批返回后收尾，但不会继续执行读取；这期间资源额度仍保留。

源码检查已替换关键词正则：Babel AST 在隔离 Worker 内解析并检查完整函数边界，拒绝异步、模块和闭合包装逃逸，允许注释/字符串中的关键词。解析器以文本嵌入发布产物，显式依赖 `@babel/parser@7.29.0`。此前 `typeof require` 的失败由转译器常量折叠造成，不能据此断言 fetch 泄露；现以实际模块调用与全局属性访问测试验证。VM仅是纵深防御，不能替代容器隔离。

本次验证：只读工具5项（含实际隔离读取/配置撤销）、内部审计桥8项、原执行器及注册60项均通过；源码检查与真实容器回归34项通过。TypeScript与定向Biome检查通过。测试数据库位于独立测试目录，没有迁移运行中的用户数据库。

## 11. 接入、迁移与交付顺序

### 11.1 接入位置

| 现有部分 | 必要改动 |
|---|---|
| `spec-vfs-service` / `spec-task-service` | 从任务 blob 转为统一领域服务；V2 tasks.json 是只读投影 |
| Agent 工具注册与执行管线 | 增加 Eval、同步对象 bootstrap、方法目录、子调用 parentCallId/序号；逐工具复用权限/快照/截断 |
| narrator/subagent executor、continuation | 显式任务上下文、执行代数、独立持久调度；不依赖展示页 |
| 插件/public API/路由 | 同一 mutation 服务与可信来源捕获，不保留独立全量覆写旁路 |
| SpecPanel、消息/WS | 按需树和详情、真实作用域、可展开调用 trace、简短业务反馈 |
| schema/存储与迁移 | 持久成员、任务、来源、事件/回执、运行意图；不随短命 narrator/消息级联删除 |

实际消息位置来自 `narrator_tool_calls.id/messageId/toolUseId` 与 `narrator_message_refs`，而不是只靠 seq。现有工具表没有通用 parentToolUseId 列；新增关联须正常生成迁移，不能仅修改渲染代码假设它存在。

### 11.2 保留边界与旧入口

- Team 数据身份长期稳定，root narrator 仅是管理/导航关系。删除 root 后暂停该 team，由有权用户接管或归档；不级联清空任务与文档。
- 结束一次 run 撤销执行资格，但可保留成员读权；显式移除成员才撤权，历史身份 stub 与来源仍保留。
- 清空展示工作集不取消调度、不删任务；重置个人草稿不影响 team；归档任务不清设计/行为护栏。
- V2 不沿用旧 `spec/reset` 的整 namespace 清空语义。旧 reset/含糊 clear 返回具体可用操作，不能静默转成归档整树。
- V2 任务通过对象命令修改，不对裁剪视图反投影。普通文档继续版本化读写，但不能把任务管理权自动等同于所有文档写权限。

| VFS 路径 | 共享与写入边界 |
|---|---|
| `spec://tasks.json` / `spec://team/tasks.md` | viewer 视图 / team 概要，Read/Grep 可用，任务内容只读 |
| `spec://index.md` / `spec://designs/*` | team 可读，默认由主代理/有权用户编辑；其他写入须明确文档授权 |
| `spec://notes/<stable-member-key>/*` | 团队协作笔记由对应成员写入；真正私有草稿不挂到共享目录 |
| `spec://behavior_fence` | 对整个 team 生效；agent 默认只读；主代理仍须明确用户要求及回合首工具调用授权，子代理不转授该授权 |

迁移个人 spec 文件时保留其原可见性，不能因为目录改为 team 共享就自动公开旧私有内容。

### 11.3 切换与分期

1. **契约与传输**：固定对象接口、方法 schema、邮箱/取消状态测试；驱动安全准入独立进行。
2. **领域与持久层**：任务/来源/事件/回执、角色转换、归档与 fork；旧 namespace 保持 legacy 契约，先不向旧客户端暴露新状态。
3. **端到端适配**：接真实任务服务和工具管线，主/子代理、UI、插件/API 验证读写、迟到结果、重启与边界。
4. **按 team 发布**：`legacy → staging_v2 → v2`。切换前仍以原存储作为唯一写入依据；后台准备后用短维护屏障固定末尾 revision，应用有界尾差、校验，再原子切换。
5. **长期验证与扩展**：历史搜索、备份/导出、热点分页、真实模型易用性；更多工具按能力逐项接入，不增加 agent 的异步规则。

必须先有可用的新写入口和安全驱动，才把 tasks.json 改为只读。在安全工具边界完成活跃会话的 SDK/方法能力、提示、continuation 与 compact 规则更新；不能给仍使用旧提示的会话封掉唯一写入口。

协议区分 taskSchemaVersion、sdkVersion、protocolVersion，描述由共同方法定义生成。旧整体覆写不得将 submitted/cancelled 翻译成 done 或把未显示任务当删除。旧数据来源不明保留 legacy revision 并标未知，不按同名任务补造历史。

V2 尚无新写入时可放弃 staging 回到 legacy；V2 已有写入后采用向前修复，不能直接切回旧 blob 丢掉新历史。未完成准备或超预算时延后切换，不扩大主线程事务。

## 12. 验收清单与参考

下列为上线验收，不是本次文档检查的完成声明：

| 维度 | 必须验证的结果 |
|---|---|
| 易用性 | 目标弱模型只读简短对象说明即可完成典型工作；不写 await、不传版本/ref、不学状态矩阵；记录首次正确率、往返/token 与错误恢复率 |
| 对象与懒加载 | 拿到对象后直接操作；未加载不是空，页面末尾不是全树完成；只读属性不产生隐藏写入/无限 RPC |
| 邮箱正确性 | 通知先到、超时、取消与响应同时发生、重复/乱序帧、越界长度、伪造句柄均不造成错误执行或覆盖终态 |
| 隔离与资源 | VM 全局/原型/返回对象/异步入口测试，恶意循环/原子等待/OOM/输出洪泛；确认真正退出且应用仍可服务 |
| 权限与版本 | 同 team 扩展读取不扩写权；旧执行、旧目标、旧提交被拒绝；私有来源不因任务共享或 fork 泄露 |
| 任务完整性 | 创建与来源原子；归档/暂停后代不能使父项假完成；开放 protected 无法通过退出/归档规避 |
| 幂等与恢复 | 提交后响应/通知丢失可恢复；claim 后状态不明不启动第二份；job 接管拒绝旧 epoch，取消保留真实 partial |
| 长期运行 | 至少十万条归档测试数据下验证有界查询；页外可执行任务仍被发现，compact/重启不灌入全历史 |
| Fork | 父持续写入时目标来自同一 S，初始化前不可用；文档/历史独立保留，旧执行不自动复活 |
| 兼容与管理 | 新写入口未就绪不封旧入口；个人重置/删除 narrator 不清 team；新状态不被旧协议误报 |

后端测试通过不等于 agent 易用性通过；传输 PoC 通过不等于安全准入通过。所有性能数字需在固定 Bun/平台版本与真实数据上记录，不能沿用烟雾测试作保证。

参考：
- [MDN：Atomics.waitAsync 的返回结构与非阻塞语义](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync)
- [Bun：Workers、共享通信与终止语义](https://bun.com/docs/runtime/workers)
- [Bun：node:vm 不作为安全机制](https://bun.com/reference/node/vm)
