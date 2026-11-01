# 测试注意事项

## 测试隔离（`--isolate`）

`bun test` 默认让所有测试文件共享一个 global 和 module registry。linkedom 的 `parseHTML()` 每次返回新 window，但 `window.HTMLElement.prototype` 是**模块级单例**——多个 window 共用同一个原型对象。因此测试里给它装几何 stub（linkedom 没有布局引擎，不伪造就测不了滚动/测量）实际是进程级改动，`afterEach` 不还原就会泄漏给后续测试文件。

受害者是那些断言"我的代码完全不读几何"的测试（如 `ContentScrollbars.test.tsx` 把 `clientWidth` 定义成读了就抛错）：它们在自己从没装过的 stub 上失败，报错 `Forbidden geometry read: ...`。**中弹名单取决于文件枚举顺序**，所以一次目录重命名就能让受害集合整体改变，看起来像重构引入了回归。

诊断特征：**单个文件跑全绿、混在一起跑失败**。遇到这种就先加 `--isolate` 复跑，再判断是否真回归。

- `bun run test` 已默认带 `--isolate`（等价于 `bun test --isolate`）；CI 中的 `bun test` 也已加上。
- `--isolate` 让每个文件拿到全新 global 并清空 module registry，历史本机测量的耗时约 2.5 倍（136s → 346s；不代表当前全仓耗时）。赶时间且只关心自己那几个文件时可用 `bun run test:fast`（无隔离），但**判断"是否有回归"必须以 `--isolate` 的结果为准**。
- `bunfig.toml` 不支持 `isolate` 键，只能通过 CLI 传入；`--parallel` 隐含 `--isolate`，不要与 `--no-isolate` 并用。
- 隔离不是万能：它救不了"文件路径写错"这类问题（见下方"源码文本守卫"）。

## 源码文本守卫（`readFileSync` 类测试）

约 250+ 个测试文件用 `readFileSync` / `Bun.file` 把**源码当纯文本**读进来做断言（其中约 20 个显式命名 `*.guard.test.ts`）。存在的理由是真实的：`NarratorPanel` 这类组件挂着 query、WS 订阅和滚动容器，单元测试挂载不起来；而"某段代码**不存在**"（如 vlist 之外不得静态 import vlist）本就是模块图性质，运行时观察不到。

代价是**这些路径对 TypeScript 和打包器完全不可见**——它们只是字符串。移动或重命名文件时：

- `bun run build` 和 `bunx tsgo --noEmit` 都会通过，因为业务 import 已修好；
- 而守卫测试在文件顶层 `readFileSync` 直接抛 ENOENT，**整个测试文件挂掉**。

后果不对称：这类守卫的唯一职责就是"防止某个不变量被悄悄改掉"，它自己失效等于保险丝被拔掉，且过程无声。`--isolate` 对此无效。

因此**移动 `frontend/components/narrator/` 等目录下的文件后，必须全仓搜索旧路径字符串**，而不是只看类型检查和构建是否通过。

改这类断言时的原则：
- 断言指向的逻辑若已搬家，应把断言**改指新宿主**（必要时拆成两处分别验证"上游转发"与"下游归属"），而不是删掉或放宽它。
- 断言"某段代码**存在**"（如 `toContain("if (dockOpenFilePanel) return ...")`）是把实现细节抄了一份，重构必然同步失败，且验证的是"文本长这样"而非"行为正确"。这类应优先改造成真实行为测试——逻辑一旦抽成 hook 就可以直接调用测试。

## 中断与重启恢复

Ctrl+C 停止服务器后，下次启动默认继续被中断的前台、后台及嵌套子代理。
已开始执行但未保存最终结果的普通工具会记录“执行结果未知，可能已产生副作用”，不会自动重执行；
人工审批继续等待，自动反思可重试，人工接管的反思继续等用户决定。
只丢弃明确未完成的文本／推理块，保留已完成输出与工具历史。

只启动服务器、不自动继续代理或工具时，传入 `--no-auto-resume`：

```sh
bun server/index.ts --no-auto-resume
# 打包后的可执行文件：
./narrafork --no-auto-resume
```

该参数保留审批和恢复清单；可以手动“继续”指定会话。未消费的清单必须跨越再次 Ctrl+C，且保持原 continuation epoch。

恢复测试使用隔离数据库和临时数据目录，不中断承载当前会话的服务器。至少覆盖：

- `--no-auto-resume` 启动 → 再次信号停机 → 默认冷启动，审批身份和恢复资格不丢失。
- 工具结果已保存、owner 尚未继续的停机窗口，不重复执行工具或覆盖成功结果。
- 原执行 owner 的 partial 被 fork 共享时，输出清理／完成只隔离 sibling 快照，保留真实工具 PK、审批、continuation 和 Agent origin。
- 通过实际 `executePersistedToolCall` 恢复审批；批准前零执行，批准后只执行一次，sibling 的工具快照与输出不改变。
- 历史 COW 工具行不获得自动恢复授权，不放宽 `prepareToolCallAttempt` 的身份与已启动守卫。
## GitHub 通用 CI

`.github/workflows/ci.yml` 在所有 PR、main 更新和手动运行时执行，不做路径过滤。固定 Bun 版本与根目录 `packageManager` 一致，依赖安装使用 `--frozen-lockfile`。

- **Static checks**：SQLite 迁移资产检查、全仓 Biome、i18n 检查。
- **Build and typecheck**：先构建前端（Vite 自动生成 `routeTree.gen.ts`），再运行 TypeScript。根目录测试导入 VS Code 扩展的类型接口，因此还需按 `vscode-extension/bun.lock` 安装该子项目的类型依赖。
- **Tests (1/4…4/4)**：下载构建产物，验证测试 preload 的数据隔离，再使用 Bun 原生 `--shard=1/4` 至 `4/4` 执行完整测试集，每片均带 `--isolate` 和固定的 `--parallel=2`。Bun 按 `.github/test-timings.json` 中的历史文件耗时均衡分片、优先调度慢文件；它只是调度提示，不是文件清单，新增或缺少提示的测试仍由 Bun 自动发现。`scripts/run-ci-tests.ts` 有界校验后将提示独占复制到 `artifacts/ci-test-timings.json`，`--update-timings` 仅更新该片的 artifact；不写回仓库基线，不执行自建文件过滤，也不使用共享同文件状态的 `--concurrent`/`--no-isolate`。runner 原样转交白名单内 native 参数（仍兼容旧五参数），将 stdout/stderr 接到独占常规日志文件、由父进程有界分块转发，保留针对 Bun 1.4.2 隔离上下文 stdio sink 回收时误操作 `spawnSync` 私有 poll 的规避（当前固定 Bun 1.4.3，不假定升级已修复该缺陷）；不重试、不筛选测试、不改变单例时限，整片 watchdog 为 30 分钟、总日志预算 64MiB，取消和超限均失败。矩阵 `fail-fast: false`，保留各片失败、原始日志、唯一命名的 JUnit 和耗时报告，不设置 `continue-on-error`。正常结束时生成报告，失败也尝试上传；预检失败或超时可能没有报告，仍不能算通过。
- **CI Gate**：只有以上任务全部成功才成功；失败、取消或跳过都不能变成通过。启用合并保护时选择该检查；仅增加 workflow 不会自动修改仓库保护规则。

### SQLite 历史资产

`drizzle/*.sql`、`drizzle/meta/_journal.json` 和历史 `*_snapshot.json` 必须随仓库提供。普通数据库测试会回放完整历史，部分升级守卫还直接读取具体历史 SQL/快照；重新生成一个当前 schema 的初始迁移不能替代历史链。

本次纳入的是主仓库现有生成资产，逐文件 SHA-256 比对确认字节未变。资产检查脚本 `scripts/check-sqlite-migration-assets.ts` 只读验证 journal/SQL 对应关系、JSON 可解析性和禁用的旧内容（包括 JSON 解码后的键和值）。生成锁、pending/validated receipt 不入库。后续结构变更仍须修改 schema 后通过 `bun run db:generate` 生成；禁止为了测试通过而手工重写历史。

### 测试前置条件与可选测试

- 创建仓库内 `.narrafork` 临时工作目录；测试 preload 会把应用 HOME 和数据库路径隔离到临时目录，不使用真实用户数据库。
- 需要 `git`、`ripgrep`、`zstd` 和 Podman；PG harness 使用 `docker.io/library/postgres:17-alpine`。用运行测试的同一用户准备 rootless 镜像，不能使用 `sudo podman pull` 把镜像拉进另一个存储。
- 浏览器必须实际能够启动。设置 `NF_TEST_CHROMIUM_PATH`（前端 browser suites）和 `PUPPETEER_EXECUTABLE_PATH`（后端 browser pool），CI 启动 headless Chrome 探针，不能仅因浏览器缺失而算通过。
- `dist/frontend/index.html` 必须存在，防止构建后 PWA/品牌测试因为没有产物而跳过。
- 通用 CI 不启用 `PG_INTEGRATION`、`NF_PG_HARNESS_INTEGRATION`、`NF_REFERENCE_COST_PG_URL`、`NF_PROGRAMMATIC_TEST_IMAGE` 或 `NF_TASK_CHALLENGES_PODMAN` 等现有 opt-in。它们有独立的数据库/专用镜像前提，不代表已由默认门禁验收。无 opt-in 的真实 PG baseline 仍运行，不排除 `pg-*`、`integration`、`browser` 或 `e2e` 文件。

### 预迁移 SQLite 模板

`tests/preload.ts` 会用 `tests/sqlite-template.ts` 把一份已完成启动流程的数据库复制到隔离目录，再由 `@server/db` 照常执行完整启动（锁、标记、按哈希迁移、ensureColumns、回填、FTS），只是迁移已全部存在。此前每个导入数据库的测试文件都要重放约 200 条迁移（约 0.6–0.8s），4 vCPU 上占全仓时间的显著部分。

- 缓存键是 `drizzle/*.sql`、`_journal.json`、`server/db/**/*.ts`（非测试）和 Bun 版本的内容哈希；任何改动都会生成新模板，不会复用旧结构。
- 模板由子进程构建、写临时文件后原子 rename；并发 worker 要么看到完整模板，要么各自构建。构建失败自动回退为逐文件迁移。
- 模板不带 clean-shutdown 标记，测试库仍走 unclean 启动分支；`tests/sqlite-template.test.ts` 守护这一点和缓存键。
- 自行设置 `NARRAFORK_HOME` 的测试不受影响。`NF_TEST_SQLITE_TEMPLATE=0` 关闭模板，`NF_TEST_SQLITE_TEMPLATE_DIR` 改变模板目录（默认 `$TMPDIR/narrafork-test-templates`）。
- 缓存键还包含 `tests/sqlite-template.ts`（构建配方）和 `bun.lock`（Drizzle/迁移器版本），改动任一都会重建模板。
- preload 把结果记在 `testEnvironment.sqliteSeed`（`seeded` / `disabled` / `unavailable` / `explicit-home`）；守卫测试按这个结果断言，关闭或构建失败时不会误报。

### 每例的空 schema 库

需要“每个用例一个全新空库”的服务测试不要逐条回放 `sqlite_master` 里的约 550 条 DDL（每次 30–35ms）。改用 `tests/sqlite-schema-image.ts`：

- `openSchemaCopyInMemory(isolatedTemplate)` 返回内存库；`openSchemaCopyAt(isolatedTemplate, path)` 写出文件后打开（文件必须不存在）。
- 镜像每个进程只构建一次，定义集合与原先的回放查询相同（同样排除 FTS 表、不含任何行）。连接级 PRAGMA（WAL、synchronous、foreign_keys、busy_timeout）不在文件镜像里，调用方照旧在自己的句柄上设置。
- `tests/sqlite-schema-image.test.ts` 守护：sqlite_master 定义、`user_version`/`application_id`、文件库 WAL PRAGMA 与逐条回放一致，且副本之间互不共享行。

### 请求准备与工具加载的快照夹具

会走真实 Prefix Epoch 请求准备或工具加载的集成测试，必须使用文件数据库：快照 worker 通过独立连接读写，不能访问 `getTestDb()` 的 `:memory:` 连接。可直接使用 preload 隔离的 `server/db`，保留真实持久化链路；不要仅为通过测试 mock 掉快照或修改生产实现支持内存库。

每次 `cleanDb(sqlite)` / 全表重置以及测试结束前，先 `await closePrefixSnapshotStore()`，等待 worker 退出并清理缓存。否则旧 manifest 缓存仍引用已删快照，后续用例会在进入 provider 前失败，表现为 token、发送者、中断或回调断言连锁失败。只测试纯查询的内存夹具无需迁移，不能全局修改 `getTestDb()` 的默认模式。

### 等待生产超时的用例

单例耗时紧贴整秒（如 15.01s、30.9s）通常是在等一个生产超时或预算，而不是在干活。测的是“预算到期后的行为”时，用 spy 把真实函数包一层、只把预算参数调小，并断言 spy 确实被调用，避免缩短失效后悄悄退回长等待。已这样处理：`interruptAndWaitForIdle` 的 15s、`tryCaptureHot` 的 4s、`RevertTransactionService` 的 30s cleanup 预算。

### Worker 线程的导入图

每个 worker 线程都会重新求值自己的模块图。worker 入口只要间接导入了 `@server/lib/settings`，就会额外付出约 200ms（settings 会顺带校验 model catalog），线上每个任务也一样。worker 只需要纯函数时，导入不依赖 settings 的模块（例如 `encoding-core.ts`，不要用 `encoding.ts`）。

### 本地复现 CI 的 CPU 受限条件

公开仓库的 `ubuntu-24.04` runner 只有 4 vCPU，每片又以 `--parallel=2` 同时跑重型真实 IO 测试。本机多核时能过的时序假设，在这里常被饿死。复现时把每片绑定到 4 个核心：

```sh
taskset -c 0-3 bun test --isolate --only-failures --shard=3/4 --parallel=2 \
  --timings=artifacts/ci-test-timings.json
```

只复现单个文件时，可以同时在相同核心上跑几个空转进程制造竞争。已确认的 CPU 受限型缺陷模式：

- **零预算并不等于“一定进入后台”**：`tryCaptureHot({ budgetMs: 0 })` 的同一个零预算也会与之前的异步磁盘探测赛跑，负载高时直接返回 null 而不登记 warm-up。断言“正在进行的 warm-up”之前要先确认它确实存在（见 `worktree-tree-snapshot.test.ts` 的 `promoteToWarmup`）。
- **夹具不要用同步子进程**：`Bun.spawnSync` 一旦不返回，会阻塞整个 worker，文件里剩余用例全部以 5s 超时 + `killed 1 dangling process` 失败，看起来像十几个无关回归。夹具用 `safeSpawn` 并设置 `timeout`。
- **不要对随机 ID 做字符前缀断言**：nanoid 以某个字母开头的概率约 1/64，跑够次数必然失败。要断言“是新副本”，就和源 ID 比较。

### 浏览器测试的传输预算与多视图交互

- **对齐传输预算**：为测试 HTTP 服务器显式配置有上限的 `idleTimeout`，与客户端请求预算协调，并保留请求 deadline、UI 等待和整例测试截止。原始文件编辑器夹具使用 `EDITOR_IO_TIMEOUT_MS / 1000` 配置服务器秒级预算，让合法的大文件预检在 CI 负载下完成传输。
- **锁定同一交互目标**：多个视图各自异步加载时，保存等待得到的可用元素句柄，点击该句柄，并在它所属的同一面板内验证结果。例如草稿恢复测试应对同一个候选面板完成等待 Restore 可用、点击 Restore、验证 export-only 状态。
- **复现并发负载**：将相关浏览器测试绑定到 CI 对应的可用核心，使用 `--isolate --parallel=2` 并行验证，结合服务器日志、请求耗时和界面状态定位竞态；修复后保留原有业务断言与整体时间预算。

### 测试耗时与准备复用

- 优先比较同机器、同参数的**文件总 wall time**，同时核对退出码、用例/断言、fixture 调用次数和峰值内存；不能仅把成本转移到 `beforeAll` 后拿单例时间宣布提速。历史 CI 报告用于定位热点，不冒充同机 A/B。
- preload 只缓存默认配置的固定顶层键，避免每例为取键而深拷贝全部 DEFAULTS；`afterEach` 仍完整恢复隔离 snapshot，缺失分支也从 snapshot 修复，不改成浅恢复。
- 归档恢复测试可复用一次真实构造的合法 ZIP 输入；每例的 Buffer、entries、元数据、闭包和输出目录仍独立。恶意 ZIP 与特殊 plan 必须按原路径真实构造，不能 hardlink、共享可写状态或减少负向覆盖。
- 已模拟的计时场景可推进实际注册的 callbacks，避免固定 sleep；必须同步控制需要的时间源，保留 React `act`、重试次数、fallback 和 timer/spy 清理。真实浏览器、数据库、持久化与大型边界场景不能为提速伪装为纯 mock。
- 原生计时基线格式为 `{ "version": 1, "files": { "relative/file.test.ts": 1200 } }`，单位毫秒。四片报告中的更新结果可以合并校准；过期、缺失提示不改变测试发现。不要将某一片的结果直接覆盖为全仓文件白名单。

### 从干净检出验证

依次执行冻结安装、资产检查、Biome、i18n、前端构建、扩展子项目冻结安装、`bunx tsgo --noEmit`、测试 preload 守卫和全仓隔离测试。不要从个人工作区复制 `node_modules`、`dist`、`routeTree.gen.ts`、迁移软链接或设置文件补齐缺失项。

在绝对路径包含 `.worktrees` 的本地 worktree 中，Biome 的 `!**/.worktrees` 排除可能使根目录检查处理 0 文件，不能把它当作通过。本地验证可使用临时配置，仅移除该路径排除并关闭 VCS 忽略，保留全部代码检查规则和其余排除；必须核对实际处理文件数大于零。正式 CI 的普通 checkout 使用原配置。

如果在工作区内建立临时干净检出，先完成外层全仓测试，副本存在期间只从副本根目录运行测试，清理本次创建的副本后再运行外层测试，避免递归发现重复测试。存量检查/测试失败必须记录并修复，不能靠自动重试、缩小扫描范围或跳过断言把门禁染绿。

## 更新代理与辅助分发回归

- 更新代理覆盖复用 `default/direct/system/custom`，测试必须实际检查传输选项、逐跳 NO_PROXY、非法配置不直连、代理变化立即重试、响应体 deadline 和父取消；不能只断言 UI 有一个字段。`sourceIdentity`、preparedId 和已调度 epoch 在代理变化后保持不变。
- helper tests 使用 fixture/mock 或测试专属 loopback，不访问真实 GitHub工具或个人更新服务器。覆盖 manifest 64KiB、binary32MiB、流式无限 body、size/hash/架构、缓存来源/tag/摘要隔离、同次准备切源迟到、并发取消及临时文件清理。版本探测只能执行已核验托管工具，或用户管理的 PATH 工具；不能用自动安装掩盖缺资产。
- executor tests 验证票据冻结精确来源/版本/协议/平台/digest，下载不刷新 manifest；安装脚本不携带代理凭据。独立 helpers-release 默认 build-only、publisher 经 Environment、公开不可变，主发布就绪检查只读取新产物自身的依赖声明，旧 bundle 不编造依赖。
- 定向入口包括 `server/lib/net/__tests__/update-fetch.test.ts`、`shared/helper-distribution.test.ts`、`server/lib/__tests__/helper-distribution-runtime.test.ts`、`server/services/__tests__/update-helper-transport.test.ts` 和 `tests/scripts/helper-release*.test.ts`。全部加 `--isolate`；本地模拟不等于六平台托管 runner native smoke，更不等于辅助资产已公开上线。

## Release CI 与默认 CI 的区别

- `ci.yml` 同时支持 `workflow_call`。发布调用传入固定的完整 commit SHA，三类源任务使用相同 SHA；普通 PR 仍检查 GitHub 提供的 merge SHA，不因为发布复用而改为 PR head。两种调用并发组隔离。
- `release.yml` 默认手动 build-only，先运行同样的静态检查、build/typecheck 和完整四分片，再对八个平台构建最终二进制并进行原生 smoke。后端测试没有被二进制 smoke 替代。
- smoke 不在源码开发目录运行应用，不依赖项目 node_modules；独立 HOME/数据库、loopback 端口、`--no-auto-resume`。必须真实完成启动、前端、数据库、watcher 和 PTY 检查，才能产生成功 `smoke.json`。失败日志可保留，但不能代替成功结果。
- 发布恢复依赖源 run 的逐项成功 job 与精确 artifact digest，并重新核对 bundle 内容。仅“有 artifact”或“有 JUnit”都不是成功证明。构建失败、smoke 失败、取消、必需 job 跳过不能发布。
- 测试入口包括 `tests/scripts/release-ci-*.test.ts`、`tests/scripts/ci-build-*.test.ts`、`tests/scripts/build-repository.test.ts`、`tests/scripts/github-release-summary.test.ts`、`tests/scripts/update-index.test.ts`、`shared/update-index.test.ts` 和 `server/services/__tests__/github-update-index.test.ts`。覆盖 fork 身份、概要预算、原子索引/CAS、404 唯一回退、缓存取消与延迟说明；repair 必须证明无 build/Release 资产写入。所有子集均加 `--isolate`。
- 本地 fixture/mock 不证明托管 runner 原生二进制可运行，也不证明 GitHub 已写入索引。上线前仍需完整的 `publish=false` 验收；真正发布成功还要求 index commit/generation 读回确认。旧全仓测试报告只属于其源码清单，不能作为新索引实现的验收证据。
- 原生 smoke 不证明 x64-baseline 已在无 AVX2 CPU 验证，也不包含 macOS Developer ID/公证或 Windows Authenticode。默认 CI 的 opt-in 数据库/专用镜像边界保持不变。
