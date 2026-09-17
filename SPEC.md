# Git 管理扩展到所有 Git 工作目录叙述者

## 1. 目标与文档状态

本分支目标：将 Git 管理扩展到所有实际工作目录位于 Git 工作树中的叙述者，不再要求其绑定叙事线（Chapter）。叙事线未来可能移除，因此只能作为兼容适配层，不能作为新架构的必需实体。

本文为实现与验收规格，并记录截至 2026-09-17 的分支实现与自动化验收结果。本文保存在仓库根目录的实体 `SPEC.md`，不使用 `spec://` 虚拟目录。

核心原则：**Git 能力属于工作目录；叙述者提供访问入口；叙事线只是可选关联。**

本次验收只更新本文档，不修改业务代码、不执行 Git 写操作、不创建提交。自动化测试均使用隔离 HOME、临时数据库和临时 Git 仓库；未停止、重启或接管常驻 NarraFork 服务。

## 2. 已核实的现状

| 位置 | 现状与问题 |
| --- | --- |
| `server/services/git-workspace.ts` | 已有工作区抽象与 narrator/path 解析，但 narrator 解析优先章节目录，且未完整覆盖 `contextProjectId` 回落。它既不验证 Git 工作树，也未将仓库子目录统一到工作树根目录。 |
| `server/services/narrator-cwd.ts`、`server/services/narrator-session.ts` | 会话优先使用显式 `narrator.cwd`，之后使用章节工作树、项目目录及最终默认目录。Git 目标必须与实际执行上下文一致。 |
| `server/routes/git.ts` | 管理接口仍以 `chapterId` 路由和鉴权，提交、reset 的后续同步依赖章节。 |
| `frontend/hooks/useGit.ts`、`frontend/lib/api/git.ts` | API 参数、查询缓存与失效逻辑绑定章节。 |
| `frontend/components/chapter/GitPanel.tsx` | 面板及变更、历史、stash 子面板以 `chapterId` 为必需参数。 |
| `frontend/components/narrator/ChapterBar.tsx`、`MobileToolPanelHost.tsx`、`dock/panels.tsx` | Git 入口与宿主需解除章节门槛。 |
| `server/lib/narrator-access.ts` | 已有叙述者 read/write 鉴权桥接，应复用而非另建身份判断。 |
| `remote-executor/internal/handlers/git.go` | 存在远程 status/diff 处理函数；仅此不足以证明远程支持完整 Git 管理。 |

## 3. 范围

### 3.1 必须覆盖

- 有章节的叙述者，保留现有 Git 使用体验。
- 无章节但有显式工作目录的独立叙述者。
- 无章节、有 `contextProjectId`、使用项目默认目录的叙述者。
- 有章节但显式 `cwd` 指向其他目录的叙述者，以实际工作目录为准。
- 普通仓库、独立 Git worktree、仓库子目录、子模块或嵌套仓库中的叙述者。
- 多个叙述者指向同一工作树，以及同一仓库下不同 worktree 的情况。
- 子代理等叙述者类型不因类型被硬编码排除；存在可访问页面及可解析执行上下文时，使用相同的 Git 能力判定。
- 非 Git 目录、目录失效、无权限、Git 不可用等正常不可用状态。

- 远程设备上的叙述者：用户已确认本分支包含远程完整支持，与本机覆盖相同的既有 Git 管理能力，具体要求见第 12 节。

### 3.2 功能对齐

复用现有 Git 管理能力，不为独立叙述者提供缩水版本：

| 能力 | 要求 |
| --- | --- |
| 状态 | 当前分支、HEAD、已暂存/未暂存/未跟踪文件及现有统计。 |
| Diff | 暂存区与工作区文件差异、现有二进制及大文件提示。 |
| 暂存 | 单文件、文件集合、全部暂存及取消暂存。 |
| 提交 | 输入提交信息、AI 生成提交信息、使用当前操作用户的 Git 身份。 |
| 历史 | 现有提交历史浏览及分页。 |
| 丢弃 | 现有文件级和全部丢弃操作，保留危险操作确认。 |
| Stash | 列表、保存、pop、drop 及冲突反馈。 |
| Reset | 现有 soft/hard reset，保留确认与错误处理。 |
| 修改来源 | 复用现有工作区修改视图；不得把整个共享工作区的变更归属于当前叙述者。 |

### 3.3 非目标

- 不在本次删除叙事线、故事网络或项目模型。
- 不为非 Git 目录自动执行 init、clone 或创建分支。
- 不借本次扩展新增完整的远程仓库管理、fetch/pull/push、分支管理、rebase 或合并编排。
- 不重写修改归因、快照和回退算法；只修改接入所需的工作区标识与适配。
- 不继续开发 Ruler；仅保持现有入口兼容。
- 不改变共享工作树中 Git index 和工作区本来就共享的语义，不承诺叙述者级隔离。

## 4. 工作目录与工作区模型

### 4.1 工作目录来源

1. 从服务端可信的叙述者记录及执行上下文解析设备和有效 `cwd`，不接受客户端任意路径作为管理入口。
2. 复用会话的目录选择规则，显式 `cwd` 必须优先于章节 worktree；支持独立叙述者的项目默认目录。
3. 已运行会话与保存配置不一致时，不能让 Git 面板悄悄切换到另一个仓库。响应需标识所用工作区，目录变更后重新解析，并拒绝针对旧工作区的写请求。
4. 会话默认目录也只能通过同样的 Git 探测和授权后获得能力；不能仅因目录是 home 就假定它是仓库，也不能未经授权向上扩大操作范围。
5. 单次 Bash 中的临时 `cd` 不修改叙述者工作目录，不触发面板目标切换。
6. 目录不存在时返回明确不可用状态，不回落到进程 cwd、另一章节或另一个仓库。

### 4.2 Git 工作树探测

- 通过 Git 实际判定是否位于工作树，不用“目录下存在 `.git` 文件夹”替代。
- 支持 `.git` 为文件的 worktree 和子模块。
- 子目录解析到包含它的最近 Git 工作树根目录；嵌套仓库与子模块不跳到外层仓库。
- 面板管理单位为整个工作树，不是 `cwd` 子树；显示叙述者 cwd 与实际 Git 根目录，危险操作明确提示作用范围。
- 若访问策略只允许某个子目录而不允许整个工作树，不能自动扩大授权；工作树级管理应返回受限状态。
- bare repository 不作为工作树管理；返回明确原因。
- 未产生首个提交、detached HEAD、无 upstream 均是有效状态，不依赖章节 base branch 才能显示面板。
- 不自动修改 `safe.directory` 或其他 Git 配置来绕过错误。

### 4.3 标识和数据契约

工作区描述至少表达以下概念，具体类型名可随现有代码约定调整：

- `workspaceKey`：设备标识 + 规范化的实际工作树根目录；服务端生成，不作为授权凭证。
- `deviceId`：本机与远程设备明确区分，不同设备同名路径不是同一工作区。
- `cwd`：叙述者有效工作目录。
- `rootPath`：Git 实际工作树根目录；执行命令用原始有效路径，不把仅用于比较的大小写折叠路径传给 Git。
- `repositoryKey`：需要协调共享 refs/stash 时使用的仓库标识，与 worktree 身份区分。
- `state`：ready、not_git、missing_directory、git_unavailable、access_denied、device_offline、unsupported 等明确状态。
- `capabilities`：当前调用者可用的读写功能；只读与无 Git 能力不是同一状态。
- 可选来源信息：`narratorId`、`chapterId`、`projectId`，不得成为底层 Git 执行的必需参数。

同一设备同一工作树的不同子目录共享工作区状态；同一仓库的不同 worktree 分开维护 HEAD/index/工作区状态。stash 等仓库共享资源的变动应刷新相关 worktree。

## 5. 后端接口与兼容

### 5.1 接口组织

建议以 `/api/narrators/:id/git` 为新入口：

- `GET /workspace`：解析能力、目标目录和不可用原因。
- 复用现有语义提供 `/status`、`/modifications`、`/diff`、`/log`、`/stash/list`。
- 复用现有语义提供 `/stage`、`/unstage`、`/commit`、`/discard`、`/stash`、`/reset`、`/ai-commit-message`。

接口路径是推荐实现方式；必须满足的架构要求是：叙述者入口先鉴权，再解析工作区，最后调用不依赖章节的共享服务。

- 不复制一份完整的 chapter Git 路由业务逻辑。
- 旧章节入口继续存在，适配到同一服务。旧入口仍表示该章节的工作树，不借用其他叙述者的 cwd。
- 查询参数校验、分页、错误、截断信息保持兼容，必要变化需同步更新类型与测试。
- 写请求携带用户看到的工作区标识；服务端重新解析并核对。目标已变更时返回冲突并要求刷新，不在新目标上执行旧操作。
- 不将前端传来的 `workspaceKey`、路径或章节 ID 直接当作 Git 执行目标。

### 5.2 章节副作用退为适配层

- Git 提交成功不依赖存在 Chapter 或章节提交记录。
- 仅当实际 Git 工作树与关联章节一致时，才执行相应章节的提交同步等既有副作用。
- 显式 cwd 指向其他仓库时，不把提交登记到原章节，也不使用原章节 base branch 推导当前仓库状态。
- 后续同步失败不得伪装成 Git 提交未成功，避免用户重试制造重复操作。

## 6. 权限与安全

- 新入口复用叙述者 ACL；涉及项目、设备和路径时继续执行既有相应授权，不因改成 narrator ID 路由而绕过限制。
- 读取需 read；修改 index、工作区、提交历史或 stash 需 write。AI 生成提交信息保留现有写级门槛及模型调用限制，本次不借重构放宽权限。
- 独立叙述者指向受保护的项目仓库时，不能成为绕过项目读写权限的入口。
- 能访问叙述者不自动代表能访问同一目录下其他私有叙述者的标题、消息或归因详情；修改来源返回遵循现有访问策略，未授权主体脱敏。
- 所有 diff/文件操作使用相对 Git 根目录的路径，统一拦截越界、绝对路径、NUL、平台盘符/UNC 等危险输入；处理符号链接时不得跟随到授权根之外。
- Git 参数使用参数数组及必要的参数边界，不能把用户输入拼成 shell 命令。
- 读缓存不能绕过每次请求的授权；权限相关响应不跨用户复用。前端退出登录或权限变化后清除相应缓存。
- 危险操作保留确认，不把“当前叙述者”误表述为“只会修改当前叙述者的文件”。

## 7. 前端入口与交互

- Git 入口按已解析的工作区能力显示，不再以 `chapterId` 是否存在判断。
- 覆盖桌面 Dock、移动端工具面板，以及现有可分离面板宿主。
- 面板与其子面板接收工作区/访问上下文，不要求章节；必要时保留旧 props 包装层以渐进迁移。
- 没有章节时仍能看到分支、状态和 Git 入口，不要求渲染 ChapterBar 才能打开。
- 非 Git 目录不伪装成“没有改动”；目录缺失、权限不足、设备离线与 Git 缺失分别提示，支持重试探测。
- cwd 切换后清空旧文件选择、diff、确认弹窗及未完成操作目标，防止把旧路径应用到新仓库。
- 只读用户可以查看允许的内容，写按钮隐藏或禁用并说明原因。
- 延续文件筛选、文件树、文件夹展开偏好、修改来源展示及快捷入口；偏好按工作区隔离，旧偏好能安全迁移则迁移。
- 新增文案同时提供英文和简体中文。

## 8. 缓存、刷新与资源边界

- Git 状态等工作区事实不再以 `chapterId` 为唯一缓存标识；同一工作树不同叙述者保持一致。
- 完成暂存、丢弃、提交、reset、stash 后统一刷新受影响的 status、diff、修改来源、log、stash，不留下旧 diff 或旧归因。
- 外部编辑器、命令行 Git 和叙述者工具修改应通过既有 watcher/事件或有界轮询反映；无章节不能导致刷新链路失效。
- 复用同一工作区的监听，面板关闭/订阅解除后释放资源，避免每个叙述者重复启动 watcher。
- 普通面板查询最多保持现有 30 秒轮询级别；写操作完成后主动失效刷新，不等待下一次轮询。
- Git 子进程、远程 RPC 和 AI 请求必须设置超时、输出字节上限及取消处理；复用已有预算常量，新增预算集中定义并测试。
- 超限时返回明确截断/分页信息，不能在内存完整收集输出后再截断；写操作的失败/超时不得自动盲目重试。
- 共享工作树的写入遵循既有 Git 并发协调；共享 refs/stash 的操作需考虑同仓库不同 worktree。锁冲突快速返回可理解错误。
- 日志记录操作类型、耗时和安全的工作区标识，不输出完整 diff、凭据或无关私有信息。
- 不在主线程引入同步全库/全目录扫描；不新增无界缓存、查询或长事务。

## 9. 实施顺序与完成条件

以下检查表按当前实现与实际验收证据更新：

- [x] S1：统一有效 cwd/执行设备解析与工作树探测，完成根目录、子目录、worktree、路径变化和不可用状态测试。
- [x] S2：抽取不依赖章节的共享 Git 管理服务，新增叙述者鉴权入口并保留章节适配；通过读写权限与路径隔离测试。
- [x] S3：迁移 API 客户端、hooks、缓存及刷新链路，实现同工作树共享和不同工作树隔离。
- [x] S4：接入桌面、移动端与可分离面板，覆盖独立叙述者、只读和不可用状态；补齐双语文案。
- [x] S5：适配提交同步、修改来源及文件偏好，验证不错误关联章节、不泄露其他叙述者信息。
- [x] S6：远程完整 Git 管理代码已完成；隔离执行器、临时仓库及真实独立 CLI + loopback WebSocket 完整读写流程通过，满足第 12.3 节验收要求。生产远程设备与 Windows 实机未人工验证，作为已知验证边界记录。
- [x] S7：针对性后端/前端/宿主/远程执行器测试、受影响文件 Biome、`bunx tsgo --noEmit` 与指定 Vite 构建均已执行并记录。

原则上不为本次新增强制 workspace 数据表。若实现确需 schema 变更，应说明持久化必要性，并通过 `schema.ts` 与 `bun run db:generate` 生成迁移，不手改迁移文件。

## 10. 验收矩阵

| 场景 | 通过条件 |
| --- | --- |
| 独立叙述者 + 仓库根目录 | 无 Chapter 也能使用第 3.2 节全部既有能力。 |
| 独立叙述者 + 仓库子目录 | 定位正确根目录；路径与 diff 对齐；明确操作整个工作树。 |
| contextProjectId + 无显式 cwd | 使用与会话一致的项目目录。 |
| 有章节 + 显式 cwd 覆盖 | 操作显式目录；不写入原章节的提交记录。 |
| 章节休眠或工作目录缺失 | 与会话解析一致；明确显示目标/失败原因，不静默选择另一仓库。 |
| 同工作树多个叙述者 | 任一入口操作后，其他入口查询/刷新得到一致状态，归因不只保留当前叙述者。 |
| 同仓库不同 worktree | HEAD/index/工作区不混用，stash 等共享资源正确刷新。 |
| worktree、子模块、嵌套仓库 | `.git` 文件不影响识别；使用最近所属工作树。 |
| 无首个提交、detached HEAD、无 upstream | 页面可用，历史为空或相应信息缺省，不报整页错误。 |
| 非 Git 目录、Git 缺失、bare repo | 显示准确不可用原因，无自动 init/配置修改。 |
| cwd 或设备在页面打开后改变 | 旧请求不能写入新工作区；重新解析后恢复正确状态。 |
| 只读或无权用户 | 服务端拒绝越权请求；仅禁用前端按钮不算通过。 |
| 通过独立叙述者访问受保护项目 | 无法绕过项目/设备/路径权限。 |
| 路径穿越、符号链接、平台路径、Git 参数输入 | 请求不能越过授权边界或形成命令/参数注入。 |
| 大 diff、大状态列表、慢 Git、并发写入 | 有界输出/超时，截断可见，取消和锁冲突可处理，不阻塞普通请求。 |
| 外部编辑器或 CLI 改动 | 不依赖章节即可刷新状态，关闭面板后无监听泄漏。 |
| 桌面、移动端、可分离面板 | 入口、目标身份与操作能力一致。 |
| 旧章节 Git 入口 | 原有操作与主要测试通过，没有复制出两套业务实现。 |
| 远程叙述者 + Git 工作目录 | 第 3.2 节全部能力在目标设备执行，操作不要求 Chapter。 |
| 本机与远程设备存在同名路径 | 状态、缓存、归因与写操作严格隔离，远程失败不回落本机。 |
| 远程设备离线、断连或旧版本 | 明确提示，写入结果不确定时先核验而非盲目重试；升级至支持版本后完整可用。 |
| 设备权限或 OAuth grant 被撤销 | 后续读取及写入均被拒绝，已有缓存或已打开的面板不能绕过撤销。 |

测试中的 commit/reset/discard/stash 必须使用临时测试仓库，不在用户工作区执行破坏性验收。不停止、重启或接管承载当前会话的 NarraFork 进程。

## 11. 完成判定

完整交付必须满足：本机与远程设备的独立叙述者端到端可用、Git 核心不再需要 Chapter、既有章节入口兼容、权限与工作区隔离测试通过，以及第 10 节验收结果有证据。不能以“新增一个入口”或“能看到状态”代替完整完成。

远程完整支持已纳入本分支验收，不得将远程统一标为 unsupported 后宣称完成。unsupported 只用于旧设备版本或实际缺失能力等明确兼容状态。

## 12. 已确认：本分支包含远程完整支持

用户通过 Ask 已选择“包含远程完整支持”。远程设备不是后续迭代占位，必须与本机覆盖第 3.2 节的全部既有能力。

### 12.1 执行与能力

- 通过既有设备执行后端接入 Git 探测、状态、diff、暂存、取消暂存、提交、历史、丢弃、stash 和 reset，不仅复用现有 status/diff RPC 就算完成。
- AI 提交信息使用目标设备的有界 diff，遵守已有模型调用和权限策略；最终提交仍在目标设备执行。
- 修改来源以设备和工作树联合定位；缺少可信证据时明确未知，不把本机或另一设备的记录拼接到当前工作区。
- 提交使用当前操作用户身份，不因远程执行而意外改用服务器或设备的默认身份；不永久修改设备全局 Git 配置。
- 设备与目录来自可信执行上下文，默认设备切换时重新解析。Git 面板不自动枚举或操作会话偶尔访问过的其他设备目录。
- 旧执行器缺少能力时明确提示升级或不支持；受支持版本必须提供完整管理。能力判断不能仅靠设备在线与否。

### 12.2 安全与故障

- 所有 Git 子进程在目标设备执行。远程设备离线、RPC 失败或目录不存在时，禁止回落到服务器上的同名路径。
- 使用目标设备的平台路径规则，不能按服务器操作系统规范化远程路径。
- 复用设备与路径授权；涉及 OAuth/grant-owned 叙述者时，实施前阅读 `docs/OPEN_API.md` 并保留 grant 范围、冻结的设备授权及即时撤销约束。
- 每个远程请求具备超时、输出上限与取消机制；断连后写入结果不确定时先重新查询核验，不自动重放提交、stash pop 或 reset。
- 本机与远程同名路径在状态、归因、缓存、事件和互斥协调中全部隔离；同一设备同一工作树仍共享状态。

### 12.3 远程验收证据

- 针对执行后端路由、授权拒绝、断连、输出截断、写入结果不确定等场景提供自动化测试。
- 使用受控测试设备或隔离执行器及临时仓库跑通完整读写流程，记录执行器版本和结果；不得在真实用户仓库执行破坏性测试。
- 仅用本机后端模拟成功响应不足以证明完整远程支持；无法获得真实远程验证条件时明确记录未完成的验收，不把该项标为通过。

## 13. 实施记录（2026-09-17）

- 新增以叙述者为入口的 Git 工作区解析与管理路由；工作区身份由设备与实际 Git 根目录共同生成，写请求使用服务端重新解析的 `workspaceKey` 防止目标漂移。
- Git 管理核心抽取为不依赖 Chapter 的共享服务；旧章节路由保留原有无 `workspaceKey` 契约并适配同一实现。显式 cwd 覆盖章节目录时，不错误触发原章节提交同步。
- 本机与远程工作区均覆盖探测、状态、diff、暂存、取消暂存、提交、历史、丢弃、stash、reset 和 AI 提交信息所需的有界 diff；远程执行器发布 `git.workspace.v1` 能力。
- 路径策略在 Git probe 前执行；`access_denied` 响应清空私有 cwd、Git 根目录和稳定工作区标识。写操作在锁内重新授权。预取消 modifications 请求只做源 Chapter/Narrator 基本 ACL，统一返回空历史与空归因；仅 `scope=uncommitted` 附带取消态 `currentDiff`，且不启动 Git probe/RPC。
- 修改归因按设备与 Git 根目录隔离，支持同仓库 sibling cwd 映射、私有叙述者身份脱敏和远程 Windows 路径大小写折叠；归因 scope 数量与探测时间均有界。
- 前端 Git API、hooks、缓存和失效链路改用工作区目标；桌面 Dock、移动端和可分离面板均可从独立叙述者打开。不可用状态、只读能力、工作区切换清理、权限撤销清缓存及英/中文案已接入。
- 未新增数据库表或迁移；未修改真实数据库、真实用户仓库或常驻服务。

## 14. 验收命令与结果（2026-09-17 最终复验）

### 14.1 后端 Git、路由、旧章节兼容与归因

```bash
bun test server/lib/agent/__tests__/track-file-change-location.test.ts server/services/git-workspace.test.ts server/services/remote-git-service.test.ts server/services/device-remote-backend.git.test.ts server/services/git-current-diff-view.test.ts server/services/git-untracked-directory.test.ts server/services/git-commit-boundaries.test.ts server/services/git-status-cache-bound.test.ts server/services/git-commit-boundary-cache.test.ts server/services/__tests__/git-service-diff-conflict.test.ts server/services/__tests__/git-identity-commit.test.ts server/services/__tests__/git-service-log-index.test.ts server/services/__tests__/git-service-worktree-lock.test.ts server/routes/__tests__/project-acl-gate.test.ts
```

结果：**178 pass，0 fail，14 个文件，653 次断言**。覆盖独立叙述者完整写流程、旧章节路由契约、项目 ACL、路径穿越/符号链接、工作区漂移、锁内重授权、probe 前拒绝、`access_denied` 脱敏、预取消零 Git probe/RPC 且不返回历史归因、远程 Windows 大小写归因、sibling cwd 归因、未出生仓库及提交身份。

### 14.2 前端 Git 与宿主

```bash
bun test frontend/components/chapter/GitPanel.test.tsx frontend/lib/api/git.test.ts frontend/components/narrator/chapter-bar-git-trigger.test.ts frontend/components/chapter/git-folder-prefs.test.ts frontend/components/chapter/git-status-filter.test.ts
```

结果：**76 pass，0 fail，5 个文件，239 次断言**。覆盖独立叙述者、不可用状态、只读、目标切换、权限撤销、工作区缓存隔离/共享、偏好迁移与 API 写目标固定。

```bash
bun test tests/frontend/host-bridge.test.ts tests/server/services/host-provider-host-hints.test.ts tests/server/services/host-hints-catalog-refresh.test.ts tests/server/services/plugin-host-dispatcher.test.ts tests/server/integration/plugins/plugin-to-host-dispatcher.e2e.test.ts
```

结果：**53 pass，0 fail，5 个文件，98 次断言**。

### 14.3 远程执行器与真实 CLI/WebSocket 自动化流程

```bash
go test -count=1 -v ./internal/handlers ./internal/transport ./internal/rpc ./cmd/narrafork-executor
```

结果：通过。`TestGitWorkspaceRemoteLifecycle` 实际构建并启动隔离的 `narrafork-executor` CLI，经 loopback WebSocket、Dispatcher 与 Git 子进程完成完整读写流程；记录的执行器为 `version=dev platform=linux/amd64 shell=false`。取消、超时、断连不重放写入、输出截断、子模块、worktree、detached HEAD、未出生仓库和路径拒绝测试通过。

```bash
go test -count=1 ./...
```

结果：最终复验通过；`cmd/narrafork-executor`、`internal/buildinfo`、`internal/config`、`internal/handlers`、`internal/rpc`、`internal/transport` 全部通过，`internal/wire` 无测试文件。

### 14.4 Biome、类型检查与构建

```bash
bunx @biomejs/biome check server/app.ts server/routes/git.ts server/services/git-service.ts server/services/git-management-service.ts server/services/git-workspace.ts server/services/git-workspace-access.ts server/services/git-workspace-attribution.ts server/services/remote-git-service.ts server/services/device-remote-backend.ts server/services/workspace-modification-view.ts server/services/git-workspace.test.ts server/services/remote-git-service.test.ts server/services/device-remote-backend.git.test.ts server/lib/agent/execution/backend.ts server/lib/agent/execution/rpc-types.ts server/lib/agent/execution/git-workspace-rpc.ts server/lib/agent/tools/track-file-change.ts server/lib/agent/__tests__/track-file-change-location.test.ts shared/git-workspace.ts
```

结果：**Checked 19 files，No fixes applied**。

P2 收尾后补充复验：

```bash
bunx @biomejs/biome check server/routes/git.ts server/services/git-workspace.test.ts server/services/git-current-diff-view.test.ts
```

结果：**Checked 3 files，No fixes applied**。

```bash
bunx @biomejs/biome check frontend/components/chapter/GitChangesTab.tsx frontend/components/chapter/GitCommitsTab.tsx frontend/components/chapter/GitFileDiff.tsx frontend/components/chapter/GitPanel.test.tsx frontend/components/chapter/GitPanel.tsx frontend/components/chapter/GitStashTab.tsx frontend/components/narrator/ChapterBar.tsx frontend/components/narrator/MobileToolPanelHost.tsx frontend/components/narrator/NarratorPanel.tsx frontend/components/narrator/dock/panels.tsx frontend/components/narrator/workspace/workspace-dock.tsx frontend/hooks/useGit.ts frontend/hooks/useGitFolderPrefs.ts frontend/hooks/useGitStatusFilter.ts frontend/lib/api/git.test.ts frontend/lib/api/git.ts frontend/locales/en/git.json frontend/locales/zh-CN/git.json
```

结果：**Checked 18 files，No fixes applied**。

```bash
bunx tsgo --noEmit
```

结果：退出码 0，无输出。

```bash
bunx --bun vite build --config frontend/vite.config.ts --configLoader native
```

结果：**成功，12365 个模块，约 1 分 10 秒**；仅有既有的大 chunk 与插件耗时警告。产物写入被 Git 忽略的 `dist/frontend/`，未进入工作区变更列表。

## 15. 验证边界与未执行的人工场景

- S6 已按第 12.3 节允许的隔离执行器、临时仓库和真实独立 CLI + loopback WebSocket 完整流程验收通过；该结论不宣称已经验证生产部署环境。
- 未在 Windows 实机执行。远程 Windows 路径语义和大小写隔离已有 TypeScript 自动化覆盖，但这不是 Windows 文件系统、junction、Git for Windows 或真实执行器部署验证；Go 套件中的 Windows junction 测试在 Linux 上跳过。
- 未在生产远程设备执行 commit/reset/discard/stash 等破坏性人工流程，也未人工验证设备升级、长期断网重连或生产代理链路；这些是额外的部署验证边界，不是第 12.3 节规定的完成前置条件。
- 测试启动日志中的 `SETTING_DOCS missing entries` 为既有提示，不影响本次命令结果；Vite 的大 chunk 与插件耗时警告同样未导致构建失败。
