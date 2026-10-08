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
- **Tests (1/4…4/4)**：下载构建产物，验证测试 preload 的数据隔离，再使用 Bun 原生 `--shard=1/4` 至 `4/4` 执行完整测试集，每片均带 `--isolate`。`scripts/run-ci-tests.ts` 原样转交 native 参数，仅将测试进程 stdout/stderr 接到独占常规日志文件、由父进程有界分块转发，避免固定 Bun 1.4.2 隔离上下文 stdio sink 回收时误操作 `spawnSync` 私有 poll 的运行时缺陷；不重试、不筛选测试、不改变单例时限，整片 watchdog 为 30 分钟、总日志预算 64MiB，取消和超限均失败。矩阵 `fail-fast: false`，保留各片失败、原始日志和唯一命名的 JUnit 报告，不设置 `continue-on-error`。正常结束时生成报告，失败也尝试上传；预检失败或超时可能没有报告，仍不能算通过。
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

### 从干净检出验证

依次执行冻结安装、资产检查、Biome、i18n、前端构建、扩展子项目冻结安装、`bunx tsgo --noEmit`、测试 preload 守卫和全仓隔离测试。不要从个人工作区复制 `node_modules`、`dist`、`routeTree.gen.ts`、迁移软链接或设置文件补齐缺失项。

在绝对路径包含 `.worktrees` 的本地 worktree 中，Biome 的 `!**/.worktrees` 排除可能使根目录检查处理 0 文件，不能把它当作通过。本地验证可使用临时配置，仅移除该路径排除并关闭 VCS 忽略，保留全部代码检查规则和其余排除；必须核对实际处理文件数大于零。正式 CI 的普通 checkout 使用原配置。

如果在工作区内建立临时干净检出，先完成外层全仓测试，副本存在期间只从副本根目录运行测试，清理本次创建的副本后再运行外层测试，避免递归发现重复测试。存量检查/测试失败必须记录并修复，不能靠自动重试、缩小扫描范围或跳过断言把门禁染绿。

## Release CI 与默认 CI 的区别

- `ci.yml` 同时支持 `workflow_call`。发布调用传入固定的完整 commit SHA，三类源任务使用相同 SHA；普通 PR 仍检查 GitHub 提供的 merge SHA，不因为发布复用而改为 PR head。两种调用并发组隔离。
- `release.yml` 默认手动 build-only，先运行同样的静态检查、build/typecheck 和完整四分片，再对八个平台构建最终二进制并进行原生 smoke。后端测试没有被二进制 smoke 替代。
- smoke 不在源码开发目录运行应用，不依赖项目 node_modules；独立 HOME/数据库、loopback 端口、`--no-auto-resume`。必须真实完成启动、前端、数据库、watcher 和 PTY 检查，才能产生成功 `smoke.json`。失败日志可保留，但不能代替成功结果。
- 发布恢复依赖源 run 的逐项成功 job 与精确 artifact digest，并重新核对 bundle 内容。仅“有 artifact”或“有 JUnit”都不是成功证明。构建失败、smoke 失败、取消、必需 job 跳过不能发布。
- 新测试入口为 `tests/scripts/release-ci-*.test.ts` 和 `tests/scripts/ci-build-*.test.ts`。本地 fixture/mock 测试不证明托管 runner 原生二进制可运行；上线前仍需完整的 `publish=false` 运行。所有测试子集均加 `--isolate`。
- 原生 smoke 不证明 x64-baseline 已在无 AVX2 CPU 验证，也不包含 macOS Developer ID/公证或 Windows Authenticode。默认 CI 的 opt-in 数据库/专用镜像边界保持不变。
