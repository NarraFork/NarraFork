# 动态变更分组与独立 SQLite

变更分组（ChangeList）把当前工作区改动按任务分配。每个改动单元只有一个所属组；同一文件的不同修改块可以属于不同组。后续编辑会继续追踪归属，而不是冻结一份文件版本。

SQLite 保存组与归属，Git 和工作文件提供实际内容。普通 Git 暂存区使用自己的原生 index：初始化、同步、移组和切换活动组不改写它，也不改写工作文件。分组提交有独立的提交保护，见 §7。

本文供应用与外部 AI 使用同一协议。命令不依赖 HTTP、常驻服务或 NarraFork 主数据库；写入统一使用 NarraFork 离线 CLI，SQLite 客户端只用于读取。命令模板不是授权：提交及删除组仍须用户明确授权。本功能用于本地工作区，远端继续使用普通 Git。

## 1. 定位实际 Git-dir

确认目标设备、仓库和授权文件范围，在目标 worktree 执行：

```sh
git rev-parse --show-toplevel
git rev-parse --absolute-git-dir
```

把真实路径分别记为 `ROOT` 和 `ACTUAL_GIT_DIR`。linked worktree 的 `.git` 可以是指针文件；存储属于它指向的实际 Git-dir，不是 common-dir，也不是主仓库的 `.git`。

定位前清除外来的 `GIT_DIR`、`GIT_COMMON_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、对象目录、动态配置和 pathspec 覆盖。内核使用绑定目标仓库的 Git 环境，以进程级选项禁用 split index、fsmonitor 和可选锁，不修改用户配置。不要向 CLI 注入私有 index 或对象目录。

```text
<actual Git-dir>/narrafork/changelists/
  changelists.sqlite          分组、归属、追踪内容与恢复记录
  changelists.sqlite-wal      SQLite WAL（运行期间可能存在）
  changelists.sqlite-shm      SQLite 共享内存（运行期间可能存在）
  operations/<operationId>/  提交候选 index、锁与故障证据
```

数据库及其运行文件、追踪内容、操作临时文件都在实际 Git-dir 内，不放在工作目录 `.narrafork/` 或主数据库。Git 对象及候选保护引用由目标仓库管理。不要手工编辑内部表、候选 index、操作记录或保护引用。

## 2. 初始化与动态归属

- 首次初始化创建活动组 `Changes`，从当前 HEAD 和工作文件观察改动，并把当前所有改动归入该组。初始化不复制原生 index 的暂存状态，也不清空它。
- 有效数据库可重复初始化；不会重新建组、清空归属或改变组 ID。未知格式、损坏数据库、缺失内容或未完成观察都明确报错，不能删除数据库后假装初始化成功。
- 每个工作区始终有一个活动组。普通新增修改、继续编辑已有修改块时，本轮实际受影响、需要重建的修改区域归观察时的活动组。切换前先完成同步，只刷新或切换活动组不重排已有修改。
- 未触及的旧修改保留原组，包括手工移组后的归属；前方插入或删除只移动显示坐标。区域划分沿用实际 diff，重复文本、相邻修改或零宽删除可能合并成一个重建区域，此时整个区域归目标组，不承诺逐次击键追踪。恢复到 HEAD 的部分退出当前改动集合。
- 外部 HEAD 变化时，可靠重映射的旧归属保留，已被新 HEAD 吸收的部分退出。新基准下无法可靠区分来源的剩余差异进入“未分组”；文本归属重叠无法安全保留细粒度归属时，按文件保守重算，该文件在新 HEAD 下剩余的本地单元一起进入“未分组”。其他可靠文件保留，能证明文件基准未变的编辑按普通编辑处理，不能证明来源的新路径或同时变化保守进入未分组；自动整理不切换活动组。
- 可验证的 `MERGE_HEAD` 存在且 HEAD 尚未变化时，本轮新建或重建的区域保守进入未分组，包括期间混入的人工编辑；未触及旧块保留原组，标记消失后的普通编辑恢复采用活动组。观察使用实际 Git-dir 内有界、稳定读取的标记证据，发布前再次核验；真实 Git 未合并冲突仍拒绝。HEAD 未变且没有可靠标记的 squash 等输出无法仅从内容辨认，按普通编辑处理，`SQUASH_MSG` 不作为可靠来源证明。
- “未分组”按固定 ID `__narrafork_unassigned__` 懒创建，默认存储名为 `Unassigned`，界面默认显示为“未分组”或 `Unassigned`。用户自定义改名保留，普通同名组仍是不同身份；本地化显示名不写回存储。该组可按普通规则改名或删除；后续需要兜底时可重新启用固定身份，但不恢复已经移出的旧成员。此机制不升级数据库 schema。
- `move` 改变归属，不复制内容。指定文件默认只移动来源组在该文件内的单元，不带走其他组的块；全范围必须明确选择。同组移动在完成版本、权限、组和选择范围校验后返回无副作用结果，不生成新观察；界面的移动目标禁用当前组。未分组可作为普通组移动或提交。
- 删除非活动组时，在同一事务把所属单元移回活动组，再移除组信息。当前活动组不可删除；先切换到保留的组。删除不删除工作文件，不撤销改动，不修改原生 index。

文本替换同时包含删除和插入，删除块即使在工作内容中宽度为零也仍是单元。二进制、symlink、gitlink 和不能可靠拆分的内容作为不可拆分项，实际变化时采用本轮目标组，未变化时保留归属。mode、创建/删除、rename 与文本内容分别判断，文本编辑不顺带移动未变化的结构项；空文本文件不等于删除路径。

改名与编辑可以一起追踪：观察器使用 Git `-M50%` 配对改名前后路径，延续 fileId 及可靠的旧文本单元归属；无法证明唯一配对时按独立删除/新增处理，不能安全投影时明确拒绝。路径 `rename` 与文本单元可分组：先提交改名时，剩余文本投影到新路径；先提交文本时，只更新 HEAD 的旧路径，改名仍待提交。两种顺序都保留未选单元，不把整文件当前版本混入候选。

CRLF 等标准 Git attributes 规范化后，以 Git blob 内容追踪和合成提交；工作文件原字节保持不变。自定义 clean filter 或 `working-tree-encoding` 使用整文件不可拆分归属；已跨组的文件不能因此自动合并成一组，不能可靠观察时保留原结果并报告失败。

磁盘上已有的旧分组 JSON、index、内部目录及保护引用保持原样；新功能不读取、不导入、不删除，也不从它们恢复归属。不要把这些文件当作当前分组入口。

## 3. SQLite 只读查询

稳定查询入口为 `v_changelists`、`v_changes`、`v_workspace_state`。普通列表只读这些视图的摘要列，不加载内容快照大字段。表结构属于内核实现，外部 AI 不直接 SQL 写入归属、活动组、generation 或恢复记录。

完整数据库以 SQLite `application_id = 0x4e46434c`（NFCL，十进制 `1313227596`）和 `user_version = 1` 识别格式。NFCL 配合 `user_version = 0` 只表示本格式的初始化保留标记，且必须没有用户表；仅显式 `init` 可恢复原子建表至 v1。读取遇该标记返回 `GIT_STAGING_INITIALIZATION_INCOMPLETE`，不补建或改写数据库。不支持的格式、已存在的不支持表及损坏数据均明确拒绝，不能猜测转换或删库重建。每个 worktree 使用自己的数据库，不能通过 common-dir 共享归属。

稳定视图列名采用 snake_case；CLI JSON 字段采用 camelCase。范围为半开区间，单元身份必须同时绑定观察版本。

| 视图 | 列 |
| --- | --- |
| `v_workspace_state` | `generation`, `observation_id`, `active_list_id`, `head_oid`, `head_tree`, `scanned_at`, `state`, `reason` |
| `v_changelists` | `id`, `name`, `active`, `generation`, `observation_id`, `file_count`, `unit_count`, `added`, `removed`, `needs_review_count` |
| `v_changes` | `generation`, `observation_id`, `file_id`, `path`, `old_path`, `unit_id`, `kind`, `list_id`, `list_name`, `base_start`, `base_end`, `work_start`, `work_end`, `added`, `removed`, `needs_review`, `review_reason` |

`active` 是 SQLite 的 0/1 值。schema v1、稳定视图列和必要 DTO 字段继续兼容旧数据：正常新观察的 `needs_review`、`needs_review_count` 为 0，`review_reason` 为 NULL；API 的 `needsReview`、`needsReviewCount` 为 false/0，可选 `reviewReason` 省略。这些字段只作读取兼容，不构成人工归属确认流程。独立 SQLite 查询在旧库执行正常 `sync` 升级前仍可能读到旧值，不能把它们当作新观察的提交门槛，也不能通过改写视图或直接 SQL 清零来代替同步。

未完成首次观察时 `observation_id`、HEAD 或扫描时间可为 NULL，空的 `v_changes` 不代表工作区没有改动。创建库时先登记 `Changes` 与 `uninitialized`/generation 0，只有完整扫描发布后才形成可用于归属写入的 observation。

内部 schema 用外键及身份/路径索引维护一致性：

| 表 | 职责 |
| --- | --- |
| `workspace_state` / `change_lists` | 单工作区发布指针、活动组、generation 与组名称 |
| `observations` / `observation_files` | 完整观察及其文件版本映射；草稿不作为当前结果 |
| `file_snapshots` | 不可变文件身份、基准与工作内容、mode、对象身份 |
| `change_units` / `tracking_lines` | 版本内单元归属、范围、行身份与历史兼容字段 |
| `commit_operations` | 提交预约、预期 tree、commit OID、状态、`fence_token` 及恢复证据文件路径与摘要 |

这些内部表用于内核诊断，不是外部写接口。查询列表使用稳定视图，不扫描 `base_bytes`、`work_bytes`、`ownership_json` 或完整恢复证据。

### Bun 只读连接

本例无需安装 `sqlite3`。先完成 §1 的定位，令 `DB` 指向目标数据库，使用独立只读连接：

```sh
DB="$ACTUAL_GIT_DIR/narrafork/changelists/changelists.sqlite"
bun -e 'import { Database } from "bun:sqlite";
const db = new Database(process.argv[1], { readonly: true });
try {
  db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 100;");
  const result = db.transaction(() => ({
    workspace: db.query("SELECT * FROM v_workspace_state LIMIT 1").all(),
    lists: db.query("SELECT * FROM v_changelists LIMIT 200").all(),
    changes: db.query("SELECT * FROM v_changes LIMIT 200").all(),
  }))();
  console.log(JSON.stringify(result, null, 2));
} finally { db.close(); }' "$DB"
```

三次查询在同一短读事务中执行，避免混用两个 generation。`LIMIT 200` 是有界预览，不证明全部文件或修改块已列完。需要完整结果时按视图的稳定身份列分页，并在同一读取版本内核验完成条件。

### SQLite 客户端

已安装 SQLite 命令行工具时可使用：

```sh
sqlite3 -readonly "$DB" '
PRAGMA query_only = ON;
PRAGMA busy_timeout = 100;
BEGIN;
SELECT * FROM v_workspace_state LIMIT 1;
SELECT * FROM v_changelists LIMIT 200;
SELECT * FROM v_changes LIMIT 200;
COMMIT;'
```

WAL、SHM 与数据库作为同一存储处理。**不要使用 `immutable=1`**，它可能忽略尚在 WAL 中的已提交结果；不要只复制主文件来制作运行中的数据库备份。锁忙时结束本次读取，稍后重新打开短读事务，不长时间持有连接或阻塞 writer。

## 4. 观察版本与同步

读命令默认查询最后一次完成的观察，不自动扫描工作区。服务停止后，数据库也不会自行变新；读取成功不是“内容实时”的证明。

摘要与动作结果包含 `generation`、`observationId`，摘要同时提供 `initialized`、`activeListId`、`scannedAt` 和 `state`。`state` 为 `uninitialized`、`ready`、`stale`、`incomplete`、`conflict` 或 `recovering`。`ready` 表示已发布完整观察；可提交性仍取决于来源新鲜度和真实 Git 状态。结合扫描时间、HEAD 与需要的文件内容判断新鲜度；即使记录为 `ready`，服务停止后仍可能已有尚未观察的外部编辑。

执行移组、切换、改名、删除或提交前，先显式同步并读取版本；写入携带 `expectedGeneration` 与 `observationId`。旧版本或并发写入被拒绝时，重新同步、读取并重新确认目标范围，不把旧 unit ID 自动套到新内容。

扫描、文件读取、diff 和 Git 子进程在短 SQL 事务外完成，发布时核对来源身份及 generation，一次提交完整观察。变化文件可写不可见草稿；完整发布前旧观察继续可读。失败、超限或不完整扫描保留上一完整归属并标记状态，不能把未扫描的成员当作已删除。

正常 `sync` 自动归一化旧观察的兼容标记，单独进行兼容升级时保留当时的组、内容及单元身份，未编辑的未分组内容仍留在原处；确有新编辑则采用 §2 的自动归属规则。只对需要升级的文件绕过复用快路径，公开单元和内部文本/结构记录一起归一化，通过草稿、来源复核及 generation/observation CAS 原子发布，不改历史快照。第二次无变化同步保持幂等。有未完成提交或恢复时先按原 `operationId` 处理，普通同步不能绕过预约或改写其源观察与证据。

SQLite 使用 WAL、外键约束、短 busy timeout 及有截止时间的异步重试。正常打开默认只读，实际 SQL 写事务才升级为写连接；写连接使用 `PERSIST_WAL` 保留 WAL，避免 Worker 关闭、重连触发反复 checkpoint 和删除运行文件。内容、归属与兼容状态均未变的重复 `sync`，以及摘要与文件读取，不改写数据库/WAL 或 generation。

一个 worktree 的写入通过同一内核协调并核对版本；移组和删除跨组更新属于一个事务，不能用各组独立文件锁替代。提交预约阻止普通归属写入越过未完成提交。外部 CLI 写入后的 generation 是刷新依据，不能只监视主文件 mtime 而忽略 WAL。

运行实例与 CLI 需加载实现新归属规则的同版代码。保留 v1 是读取和恢复格式兼容，不保证旧写入程序维持新归属策略，避免混版写入。

## 5. 离线命令

源码入口为 `bun server/index.ts changelists --workspace "$ROOT" <命令>`；打包后的等价入口为 `narrafork changelists --workspace "$ROOT" <命令>`。从源码运行时使用 NarraFork 仓库内的入口路径，`--workspace` 指向实际操作的仓库。它在服务和 manager 初始化前分流，不监听端口，不打开主库，不启动实例。

成功写 stdout JSON `{ "ok": true, "result": ... }`；错误写 stderr JSON `{ "ok": false, "error": { "code": "...", "message": "..." } }` 并以退出码 1 结束。动作结果包含 `outcome`（`applied`/`partial`）、`generation`、`observationId`、`affectedListIds`，以及适用时的 `listId`、`operationId`、`commitOid`、`reason`。不能只凭退出码忽略 `partial`。读取不隐式执行 `sync`。

| 命令 | 参数 |
| --- | --- |
| `init` / `sync` | 初始化并观察 / 显式刷新；无需预期版本 |
| `list` | 只读摘要及所有组 ID |
| `files` | `--list ID [--cursor CURSOR] [--limit N] [--filter AM]` |
| `diff` | `--list ID --path PATH [--old-path OLD_PATH]` |
| `create` | `--name NAME`；返回 `result.listId` |
| `rename` | `--list ID --name NAME` |
| `activate` | `--list ID` |
| `move` | `--from ID --to ID`，再选一种下述范围 |
| `delete` | `--list ID`；需明确授权且不是当前活动组 |
| `commit` | `--list ID --message MESSAGE`；需明确授权 |
| `recover` | `--operation OPERATION_ID`；核对原操作证据 |

除 `init`/`sync` 外，所有写命令（包括 `recover`）必须携带 `--generation N --observation ID`。读取当前结果后再填写版本，不从示例复制。

```sh
bun server/index.ts changelists --workspace "$ROOT" init
bun server/index.ts changelists --workspace "$ROOT" sync
bun server/index.ts changelists --workspace "$ROOT" list
bun server/index.ts changelists --workspace "$ROOT" files --list "$FROM" --limit 200
bun server/index.ts changelists --workspace "$ROOT" diff --list "$FROM" --path "$FILE_PATH"
bun server/index.ts changelists --workspace "$ROOT" create --name "$NAME" \
  --generation "$GENERATION" --observation "$OBSERVATION"
```

每次写入后使用返回或重新查询的版本，再执行下一个写入。移组范围只选一种：

- `--unit ID`，可重复，移动当前观察中来源组拥有的明确单元。
- `--path PATH`，可重复，移动来源组在这些文件中的单元。
- `--paths-file FILE`，读取 UTF-8 JSON 字符串数组；`FILE` 为 `-` 时从 stdin 读取。
- `--paths0-file FILE`，读取每项以 NUL 结尾的字面路径；`FILE` 为 `-` 时从 stdin 读取。
- `--all`，明确移动来源组的全部单元，包括未加载页面，不带走其他组的归属。

按状态或目录移动完整范围时可用 `--filter AM`、`--directory relative/dir`，内核按来源组及当前观察匹配，不依赖已展开文件。筛选不能扩大授权范围。

```sh
bun server/index.ts changelists --workspace "$ROOT" move \
  --from "$FROM" --to "$TO" --paths-file "$PATHS_JSON" \
  --generation "$GENERATION" --observation "$OBSERVATION"
```

`PATHS_JSON` 的内容示例（实际路径以授权文件为准）：

```json
["src/login.ts", "中文 空格\t换行\n文件.txt", ":(glob)*.txt"]
```

结构化动作也可用 `--json-input FILE`（或 `-` 从 stdin）传入。JSON 对应共享动作 DTO，包含 `action`、动作字段、`expectedGeneration` 和 `observationId`，不传 `workspaceKey` 或提交身份；与重复命令行动作参数混用会拒绝。例如 `move` 使用 `fromListId`、`toListId` 及 `unitIds`、`paths` 或 `all: true`，不能手写 SQL 代替内核校验。输入数量、字节上限与路径校验仍生效。

常用顺序：定位 → `init` 或 `sync` → `list` → `files`/`diff` → 选择文件或单元 → `move` → 核验归属。所有组选择使用 ID，而不是用可重复的组名当身份。

## 6. 文件块选择与结果核验

组摘要包含 `id`、`name`、`snapshotVersion`、`active`、`fileCount`、`unitCount`、`added`、`removed` 和 `needsReviewCount`。`snapshotVersion` 是该组局部内容的 hash；组名或其他组发生变化时，未变内容的组保留该值。它由 CLI/内核返回，不是稳定 SQLite 视图列，也不能代替写动作的全局 `generation`/`observationId`。同一文件可同时出现在多个组的文件清单中，不能把各组文件数直接相加当作工作区唯一文件数。

修改单元包含 `id`、`fileId`、`path`、可选 `oldPath`、`kind`、`listId`、`baseStart`/`baseEnd`、`workStart`/`workEnd`、`added`/`removed`、`needsReview` 及可选 `reviewReason`。单元 ID 是不透明字符串，与观察版本共同确定可操作对象；不能套用组 ID 的字符规则、当作磁盘路径或自行拼装。显示 diff 的 hunk 不一定等于一个归属单元，不能按 hunk 文本或行号猜 ID。

`files` 页和 diff 返回组内 `snapshotVersion`，文件游标还绑定相同的状态筛选。同一组、局部内容 hash 及筛选条件一致，实际 offset 连续的页才可合并；其他组写入使全局版本变化时，当前组内容未变的游标仍可用。以实际返回条数推算下一位置，不用请求 limit 猜测。只有末页 `complete: true`、`nextCursor: null`，并确认前页连续后，集合才完整。

页内 `generation`/`observationId` 记录本次读取的全局观察；执行写动作前仍须取得当前全局版本，不能因局部 hash 未变就复用过期动作版本。全组操作必须交给内核处理完整范围，不能只提交已展开或已加载的页。

diff 预览可以截断；提交候选必须从完整基准及选中单元合成，不能拿展示 diff 当 patch。统计区分文本、二进制和 gitlink，未知、失败、截断或加载中不冒充零。

移组后重新读来源组、目标组及版本，确认每个选中单元仅属于目标组，未选中的其他组单元仍保留。初始化、同步、移组、切换和删除完成后，应核对工作文件与原生 index 均未被改写。

## 7. 提交与恢复

### 提交授权与候选

提交前取得用户对目标组与提交说明的明确授权。加载 Skill、同步、创建组或移组不是提交授权。使用同一内核的 `commit` 命令，不自行安装候选为原生 index，不直接运行绕过协议的低层提交命令。

1. 调用者先显式同步并按当前版本确认目标组，确保观察完整、来源新鲜，且不存在阻塞提交的冲突或未完成操作。未分组与普通组采用同一提交条件，取得用户授权后可直接提交。旧观察须先经正常同步完成兼容升级，不能仅在界面隐藏字段来绕过内部状态一致性要求。`commit` 本身不隐式执行 `sync`；内核在登记预约前及调用 Git 提交前各做批量只读来源复核，内容、mode 或路径陈旧时返回 STALE 错误，需显式 `sync` 后重新选择，不静默替换用户已选范围。
2. 检查 merge、cherry-pick、revert、rebase、sequencer 及 HEAD 状态。原生 index 有任何暂存、部分暂存、intent-to-add（ITA）或未合并冲突时拒绝，保留其原字节；不能先清空它来让组提交通过。
3. 登记提交预约，记录预期 HEAD、generation、观察身份、候选保护及操作证据。以 HEAD 基准加所选组单元合成完整 blob，用临时 index 构造精确候选；工作文件和其他组单元不混入候选。
4. 使用原生 index 锁并复核 HEAD、原生 index 原字节和内容身份；正常执行 `git commit`，保留 hooks、签名及身份配置，不跳过 hooks、不关闭签名。
5. 核对真实 commit OID、父提交、引用目标和 tree，之后同步原生 index，并根据候选的来源映射重新投影剩余归属。保留组 ID、名称、其他组改动以及提交期间出现的新编辑，不能直接清空整组或恢复工作文件。

外部 HEAD 变化先按 §2 重新观察并自动分组。完整观察发布前核对 HEAD、工作内容、路径、原生 index、合并标记与 generation；失败草稿不发布可见空组。用户用当前 `generation`/`observationId` 选择真实单元执行普通移组或提交。提交与恢复投影继续严格使用来源映射，不能套用普通编辑的活动组/未分组分类策略；真实 Git 未合并、进行中的合并或其他 Git 操作、读取失败、超限、错误提交映射或恢复证据仍拒绝。跨组路径删除、创建项与内容拆组等防止丢改动的原子性保护继续生效。

### 故障与恢复

Git 和 SQLite 不是一个事务。跨两者的操作依靠持久记录、`operations/<operationId>/` 证据与 `refs/narrafork/changelist-operations/` 下的候选保护引用恢复；不要把 SQL 回滚理解成 Git 提交回滚。操作目录保存候选 index、适用时的 `native-before.index`、`mappings.json` 及按当前 token 命名的 `commit-<fenceToken>.receipt.json`。SQL 和 receipt 只保存大字段文件的路径及 SHA256；恢复前复核原生备份与映射文件摘要。不能只保留候选文件就删除数据库、备份、映射、receipt 或保护引用。

- hook 拒绝或非零退出不证明没有 commit。核对 HEAD、候选、原生 index 和操作记录后再判断。
- hook 改变 tree、HEAD 漂移、进程中断或结果未知时保留证据、候选及必要锁，不自动再次提交、不回滚用户改动、不删除锁来强行继续。
- 已有 `commitOid`，或记录为未知但能严格证明当前 HEAD、tree、父提交及引用目标与预约候选一致时，按原 `operationId` 执行 `recover`；恢复绝不调用 `git commit`。无法证明候选关系则保留证据并拒绝，不猜测成功。
- 恢复从经过 SHA256 核验的原生 index 副本和提交前后 tree 构造待安装 index。真实 index 已与结果字节及原 mode 一致时，确认安装完成并继续收尾；尚未安装时，真实原生 index 必须仍与原字节、mode 一致，遗留锁的 `dev:ino` 必须属于本操作。短事务内再次核对 token、HEAD、index 与锁身份后，用独立候选 inode 原子替换 index 并保留原 mode，不复用或写入仍可能被旧生产者持有的锁 inode。外部 index 或锁变化时拒绝，不覆盖现有内容。
- 原生 index 已安装、数据库收尾失败时，直接按原来源映射观察并投影剩余归属，不重新提交。`finished` 操作重复恢复返回原 `commitOid`；`rejected` 操作明确拒绝。
- lease 只用于调度，不是生产者已退出的证明。有效 lease 拒绝并发恢复；已捕获失败释放 lease 后可立即恢复。恢复以 CAS 更换 `fence_token`；启动 Git 提交、发布原生 index、发布 SQL 观察或收尾状态前，都在短事务核对当前 token。旧生产者失去 token 后不可发布、标状态或删除锁；生产者暂停在 SQLite 临界区时，恢复以 busy 明确拒绝。lease 过期也不能按 PID 或时间抢占外部锁。无法验证证据时停止相关写入并保留错误状态。
- 删除非活动组也须明确授权，并告知其改动将移回活动组、组信息将移除。该动作在 SQL 事务中完成，不递归清理数据库、操作目录或旧磁盘文件。

确认属于可恢复收尾后，先用 `list` 读取当前版本，再执行原操作的恢复命令：

```sh
bun server/index.ts changelists --workspace "$ROOT" recover \
  --operation "$OPERATION_ID" \
  --generation "$GENERATION" --observation "$OBSERVATION"
```

交付记录组 ID、动作、generation、observationId、受影响组与明确结果；提交额外记录 `commitOid`，恢复记录 `operationId`。不要把未知结果报成成功或空组。

## 8. 授权与资源边界

- workspaceKey、组 ID、unit ID 和 generation 是标识及并发保护，不是权限凭据。离线 CLI 与应用都必须在已授权设备、仓库和文件范围内使用。
- 路径相对 ROOT，以结构化 JSON 数组或 NUL 清单传入。空格、tab、换行与形似 pathspec 的文件名按独立字面路径处理；不用字符串拼接 shell，不按行拆分路径，不把目录或 glob 当作精确授权。
- 拒绝绝对路径、空组件、`.`/`..`、`.git` 组件、NUL、孤立代理码点及越界路径。中间目录不得经 symlink 跳出根；最终 symlink 作为 Git 条目处理，不跟随读取仓库外内容。Windows 还拒绝路径中的 `:` 和 `\`。
- 旧内部 `.narrafork/git-staging/` 不属于可选文件范围；其他 `.narrafork` 用户文件仍按正常路径规则处理。
- 文本观察预算为单文件 2 MiB/10 万行、单次 64 MiB，单文件 diff 500 ms 并限制编辑长度。达到上限时保留完整旧归属并报告 `incomplete`；已经跨组的文件不能静默改成整文件单组。
- Git 输出、文件列表、分页、预览、index 读取、超时与取消均有界。不要通过取消 limit、扩大无界事务或读取全部内容大字段来规避失败。
- 观察和 Git 工作在 Worker 执行；Worker 创建、运行、超时、禁用或取消失败均明确失败，不回退服务主线程。只读 SQLite 示例是有界独立子进程，不启动服务。

## 9. 验证

技能发现、协议链接及真实离线命令验证位于 [tests/server/services/git-changelists-skill.test.ts](../tests/server/services/git-changelists-skill.test.ts)：

```sh
bun test --isolate ./tests/server/services/git-changelists-skill.test.ts
bunx @biomejs/biome check tests/server/services/git-changelists-skill.test.ts
```

测试只在临时仓库写 Git 和分组数据，运行真实 CLI、独立只读 SQLite 查询与特殊文件名操作，核对 HEAD、原生部分暂存及工作文件不变，并确认无需主服务或主数据库。真实仓库的初始化、同步、提交或删除不能用作试运行。

## 可复制到其他项目的 AGENTS 入口

> 涉及动态变更分组时加载项目级 `git-changelists` Skill，并按动作读取《动态变更分组与独立 SQLite》。定位目标 worktree 实际 Git-dir，通过同一内核的离线 CLI 初始化、同步和修改分组；只读查询使用 `narrafork/changelists/changelists.sqlite` 的稳定视图。按 generation 与 observationId 核对新鲜度及写入版本，所选改动单元移动后只保留一个归属，同一文件的不同块可以分组。初始化、同步与移组不改写工作文件或普通 Git 暂存区。提交及删除组须明确授权；原生暂存、ITA 或冲突非空时拒绝分组提交。结果未知时保留 operationId、候选与锁，只按协议恢复，不自动重复提交。
