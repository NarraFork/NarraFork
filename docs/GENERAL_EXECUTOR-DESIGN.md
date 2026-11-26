# 通用执行器设计

> 状态：已确认方向，第一期实现中（分支 `claude/upbeat-galileo-dteo9f`）。
> 调研基线：`main` @ `9166435a`。文中 `path:line` 相对仓库根目录。
> 前置：Watch 重启续接已在 [NarraFork/NarraFork#697](https://github.com/NarraFork/NarraFork/pull/697) 合入；本设计解决的是它做不到的部分——让终端和后台命令本身跨 NarraFork 重启继续运行，并让文本观察不漏输出。

## 0. 摘要

把现有 Go 远端执行器（`remote-executor/`）演进为**通用执行器**：本地和远端用同一个执行内核，只是接入方式不同。

已确认的四个决策：

| # | 决策 | 结论 |
|---|---|---|
| 1 | 本地进程模型 | 默认由 NarraFork 以**脱离的进程**启动执行器（Linux 用 `systemd-run --user --scope`，Windows 脱离 Job）；另提供**用户级服务安装**作为可选项 |
| 2 | 终端渲染位置 | **执行器只持有 PTY 和带序号的原始输出日志；xterm 渲染与 Watch 匹配留在 NarraFork。** 不在 Go 里实现终端模拟器 |
| 3 | 升级移交 | 不作为前置条件。后期：Unix 移交文件句柄，Windows 让旧版本跑完存量会话 |
| 4 | 第一期范围 | 只做终端、后台 Bash、Watch；文件和 Git 操作保持原样 |

职责边界：**NarraFork 管会话、权限与编排；执行器管真实进程、终端和输出事实。**

## 1. 现状与问题

| 问题 | 位置 |
|---|---|
| 远端 PTY 生命周期绑定在一次 RPC 上：`exec.CommandContext(ctx)`，连接取消即杀进程 | `remote-executor/internal/handlers/pty_unix.go:40` |
| PTY 注册表按连接隔离，重连拿到的是新表 | `remote-executor/internal/handlers/handlers.go:54-59`、`internal/transport/client.go:108-122` |
| 命令执行同样绑定 RPC，并有超时 | `remote-executor/internal/handlers/exec.go:22-43` |
| Windows PTY 只是占位，直接报不支持 | `remote-executor/internal/handlers/pty_windows.go` |
| 本地终端依赖 dtach 才能跨 NarraFork 重启；没有 dtach 时随进程结束 | `server/terminal/dtach-service.ts`、`server/services/terminal-service.ts` |
| 本地终端输出只在 NarraFork 内存/快照里，停机期间的输出无法补看；带文本的 Watch 只能报中断 | `server/terminal/buffer-manager.ts`、`server/services/watch-restart.ts` |

## 2. 目标与非目标

**目标**
- 执行器接受的终端会话**归执行器所有**：连接断开只是脱离（detach），停止必须显式请求。
- 每个会话有一份**带递增序号的原始输出日志**；客户端可以"从序号 N 开始"重新附着，拿到中间漏掉的字节；超出保留范围时明确报告缺口。
- 输入可安全重试：带写入 ID 的写入在执行器端去重，重发不会让命令执行两次。
- 旧协议（`pty.*`、`exec.start`）语义不变，新能力通过 capability 协商启用。

**非目标（本设计不承诺）**
- 执行器自身崩溃或整机重启后，原进程继续运行。此时只保证已落盘的输出和退出事实可读（第二步之后）。
- 在 Go 里复现 xterm 的渲染语义。
- 任意版本之间的会话热移交。

## 3. 架构

```text
NarraFork 后端（可重启）
  ├─ xterm headless 渲染 + Watch 匹配（不变）
  ├─ 会话记录：terminalId ↔ (deviceId, sessionId, 已消费序号)
  └─ 重连：session.attach(sessionId, since=已消费序号)
              │  WebSocket + HMAC（现有传输）
              ▼
Go 执行器（远端设备上的常驻服务 / 本地脱离进程）
  ├─ 传输层：每连接一份状态（不变）
  ├─ 普通请求：fs / git / editor（不变，仍随请求取消）
  └─ 会话管理器（新增，进程级，与连接无关）
       ├─ 会话：PTY + 进程 + 退出事实
       └─ 输出日志：字节序号、有界保留、缺口检测
```

关键变化只有一个：**会话管理器是进程级单例**，在 `main` 里创建，传给所有连接的分发器；不再挂在 `ConnectionScoped()` 的每连接状态上。

## 4. 会话模型

### 4.1 会话

| 字段 | 说明 |
|---|---|
| `sessionId` | 由调用方提供（与旧 `ptyId` 一样），执行器拒绝重复；格式 `[A-Za-z0-9_-]{1,128}` |
| `kind` | `pty`（终端）；`exec`（后台 Bash：无终端，stdout/stderr 同一管道，stdin 为空，特性 `session.exec.v1`） |
| `cmd` / `cwd` / `env` / `cols` / `rows` | 同 `pty.open`，`cwd` 仍经 PathGuard 校验 |
| `state` | `running` → `exited`；不可逆 |
| `exitCode` / `exitedAt` | 退出事实，进程退出后写入一次 |
| `startedAt` | 启动时间 |

### 4.2 输出日志与序号

- **序号 = 字节偏移**：会话自启动以来输出的第 N 个字节的序号是 N。单调递增，从 0 开始，不会重用。
- 日志是**有界保留**的：只保留最近 `retainBytes` 字节（默认 4 MiB/会话）。最早保留的序号记为 `firstSeq`，下一个要写入的序号记为 `endSeq`。
- PTY 读取线程只往日志追加，**永远不等待任何消费者**。慢消费者只会落后，落后到被淘汰时收到缺口，不会反压到 PTY，也不会让 shell 卡住。
- 日志在内存中（环形缓冲）供读取，同时写入磁盘分段文件（第一期第四步，格式见 §7），执行器重启后从磁盘恢复。

### 4.3 附着（attach）

`session.attach { sessionId, since }` 是一个长时间运行的流式 RPC：

1. 若 `since < firstSeq`：先发一个 `session.gap` 帧 `{from: since, to: firstSeq}`，然后从 `firstSeq` 开始发数据。
2. 若 `since > endSeq`：报错（客户端声称看过不存在的数据，说明它连错了会话或会话已被替换）。
3. 之后按顺序发 `session.data` 帧，数据**严格连续**，客户端用"起始序号 + 已收字节数"自行计算序号。
4. 中途如果消费者落后到被淘汰，再发一个 `session.gap` 帧后继续。
5. 会话退出且数据发完后，发 `session.exit` 帧，RPC 返回 `{exitCode, endSeq}`。
6. 客户端取消 RPC 或连接断开 = **只脱离**，会话继续运行。

同一会话允许多个附着者（例如 NarraFork 重启瞬间新旧连接短暂并存），各自独立推进。

## 5. 协议

所有新方法通过 capability 特性 `session.durable.v1` 协商；不支持时 NarraFork 继续用旧 `pty.*`。`kind:"exec"` 另需 `session.exec.v1`（同一执行器同时声明；只有 `session.durable.v1` 的执行器仍走 `exec.start`）。

| 方法 | 参数 | 结果 | 说明 |
|---|---|---|---|
| `session.open` | `sessionId, kind:"pty", cmd?, cwd, env?, cols?, rows?`；或 `kind:"exec", command, cwd, env?, freshEnv?, timeoutMs?` | `{sessionId, startedAt}` | 启动后立即返回，不再阻塞到退出；`exec` 的 `timeoutMs` 由执行器自己计时 |
| `session.attach` | `sessionId, since` | 流：`session.gap` / `session.data` / `session.exit`；结果 `{exitCode, endSeq}` | 见 §4.3 |
| `session.write` | `sessionId, dataB64, writeId?` | `{duplicate: bool}` | `writeId` 在每会话最近 256 个内去重 |
| `session.resize` | `sessionId, cols, rows` | `{}` | |
| `session.kill` | `sessionId, release?` | `{}` | 显式停止整个 PTY 会话（含作业控制建的进程组）；`release` 为真时退出一记录就释放，已退出会话立即释放 |
| `session.info` | `sessionId` | 会话状态 + `firstSeq/endSeq` | |
| `session.list` | — | 会话摘要数组（有上限） | 重连后对账用 |
| `session.release` | `sessionId` | `{}` | 已退出会话的日志可以释放 |

流帧复用现有 `rpc_stream`（`channel` + `chunkB64`）：`session.data` 的 chunk 是原始字节；`session.gap` / `session.exit` 的 chunk 是小 JSON。

### 5.1 资源上限（执行器端强制）

| 项 | 默认 |
|---|---|
| 每会话日志保留 | 4 MiB |
| 会话总数（含已退出未释放） | 64 |
| 已退出会话自动释放 | 退出后 24 小时 |
| 单次写入 | 1 MiB |
| 每次流帧数据 | 32 KiB |
| 每会话写入去重表 | 256 个 `writeId` |

## 6. 故障语义

| 故障 | 结果 |
|---|---|
| NarraFork 重启 / 连接断开 | 会话继续；重连后 `attach(since)` 补齐，超出保留则收到缺口 |
| 消费者过慢 | PTY 不受影响；消费者收到缺口 |
| 写入请求超时后重试 | 带 `writeId` 时执行器去重，不会重复执行 |
| 执行器进程崩溃 | 会话中的进程随之结束（PTY 主端关闭）；重启后的执行器从磁盘恢复会话：已退出的照常可读（含退出码），运行中的标为 `lost`，可读到截至崩溃已写盘的输出，attach 结果带 `lost: true` |
| 整机重启 | 同上（最后一段未 fsync 的输出可能缺失，读者看到的是记录到的末尾） |
| 日志磁盘写满或写失败 | 会话继续运行，该会话停止写盘（内存里照常可读），`info` 报告 `storageError`；不假装完整 |

NarraFork 侧对应展示：缺口在终端里显示为一行提示（"有 N 字节输出未保留"），Watch 文本匹配遇到缺口时报告"观察有缺口"而不是"未匹配"。

## 7. 磁盘格式（已实现，`remote-executor/internal/session/store.go`）

```text
<stateDir>/<设备名>-<注册哈希>/sessions/<sessionId>/
  meta.json          会话元数据与退出事实（原子替换写）
  seg-<firstSeq>.log 输出分段，每段 ≤ 1 MiB，按序号命名
```

- 分段只追加；淘汰时整段删除，`firstSeq` 取最早存活分段的名字。
- `meta.json` 用"写临时文件 → fsync → rename"更新；分段写入按段 fsync，不逐字节 fsync（不承诺断电不丢最近输出）。
- `stateDir`：Linux `$XDG_STATE_HOME/narrafork-executor`（缺省 `~/.local/state/...`），macOS `~/Library/Application Support/...`，Windows `%LOCALAPPDATA%\...`；可用 `--state-dir`、`NARRAFORK_EXECUTOR_STATE_DIR` 或配置 `stateDir` 覆盖；系统级 systemd 服务的账户没有家目录，单元里用 `StateDirectory=` 并指向 `/var/lib/narrafork-executor`。子目录按注册区分（服务器地址、直连监听地址与设备名的哈希），同一账户和状态目录下的不同注册——即使设备同名——互不恢复、也就不会读到对方的会话。
- 启动时读回每个会话目录：`meta.json` 有退出事实的恢复为已退出；没有的（执行器停止时仍在运行）恢复为 `lost`，并立即把发现时间写回 `meta.json`，所以多次重启不会刷新它的 24 小时 TTL。只读最近 4 MiB 和最后一段连续分段；读不了的目录删除。
- 读者声称看过的字节超过已写盘的末尾（断电前未落盘的输出）时，`lost` 会话直接返回结束，不报错。
- 释放、TTL 到期、`kill { release }` 都会删掉目录；磁盘占用上限约为会话数上限 × (4 MiB + 1 段)。
- 写盘失败（写入、fsync、关闭出错，磁盘满、目录被删）只让该会话停止记录输出，退出事实仍照常记录，`meta.json` 标 `outputIncomplete`，`info.storageError` 报告（恢复后也报告）。启动时某个会话的记录写不回（只读、满盘）不影响其他会话恢复，该会话带存储错误照常恢复。能写盘时执行器声明特性 `session.journal.disk.v1`。

## 8. NarraFork 侧改造

**远端终端**（第一期第二步，已实现）
- 新运行时 `server/terminal/remote-session.ts`：设备支持 `session.durable.v1` 时 `terminal-service` 改用它（`session.open` + `session.attach`），不支持时仍走 `runtime-remote.ts` 的 `pty.open`。
- 会话 ID 固定为 `nf-term-<终端id>`，存进新增的可空列 `terminals.executor_session_id`（SQLite 0266、PG 0083）。
- **已消费序号不存数据库，而是和缓冲快照存在一起**（`.buf` 的 `streamSeq` 字段）：`BufferManager` 只记录 xterm 已解析的位置，所以快照内容和序号严格对应，重启续读不重复、不遗漏。快照没有这个字段时丢弃快照、从 0 重放。
- 设备断线时等 `device:status` 上线后 `attach(since)` 续读；输入带 `writeId` 顺序发送。
- 停止与释放由持久记录驱动：终端关闭、或 shell 退出且最终状态已落盘之后，写一行 `executor_session_cleanups`，发 `session.kill { release: true }`，执行器确认后才删记录；设备每次上线重试。独立于终端行，删行、重启、离线都不丢。
- `session.open` 回复丢失时等设备回来重发，"already exists" 即接管；仍不确定则写清理记录。
- 缺口先通知文本 Watch（缺口前已有输出照常匹配，未匹配的报告"可能错过"），期间后续输出暂存。
- NarraFork 关闭时只脱离、不杀；启动时 `recoverOnStartup` 恢复这些终端（设备不在线也恢复，等设备上线）。

**远端后台 Bash**（第一期第三步，已实现）
- 设备同时声明 `session.durable.v1` 与 `session.exec.v1` 时，后台 Bash（`task` 与 `service`）改用 `session.open { kind:"exec" }`；前台 Bash 仍走 `exec.start`。旧路径的超时是 RPC 超时（默认 120 秒），会话路径用后台任务自己的超时，执行器端同时强制。
- 会话 ID 固定为 `nf-bash-<taskId>`；打开前把 `{deviceId, sessionId, timeoutMs, startedAt}` 写进 `background_tasks.executor_session_json`（SQLite 0268、PG 0085）。
- 输出只在内存里，所以重启接管时从序号 0 重放执行器仍保留的部分（最多 4 MiB，更早的以缺口提示标明）；剩余超时按 `startedAt + timeoutMs` 计算。
- 停止与释放复用终端的持久清理记录（`executor_session_cleanups`）：取消/超时先写记录再停止读取，不等设备，`session.kill` 等 open 有结果后才发；自然结束在任务终态写入后才释放。执行器对还在启动的会话收到 kill 时记下、进程一起来就停。
- `session.open` 回复丢失时不重发（执行器若已重启会把命令再跑一遍），用 `session.info` 对账：在就接管，不在就记清理意图并报启动未确认。
- 超时以执行器为准：退出结果带 `timedOut`；NarraFork 自己的计时延后 30 秒兜底，所以重启时已过期限但按时完成的命令仍算完成。
- NarraFork 关机（含 SIGTERM）只脱离，不停止命令，行保持 running，下次启动重新附着；与远端终端一致。
- 执行器已没有该会话（执行器重启）时任务以失败结束，并在输出里说明原因。

**本地终端**（第二期）
- NarraFork 启动时查找/拉起本地执行器（决策 1），通过本机回环 + 一次性令牌连接。
- 本地终端与后台 Bash 走执行器会话；dtach 降级为不可用时的兜底，最终移除。

**Watch**
- 重启后，有会话 ID 的终端 Watch（含文本 Watch）可以续接：从 Watch 登记时的序号重放到 xterm 后继续匹配；遇到缺口报告"有缺口"。
- 这一步替换 #697 里"文本 Watch 一律报中断"的限制。

## 9. 分期

**第一期：远端执行器的持久会话**
1. ✅ 执行器端会话核心：进程级会话管理器、内存输出日志与序号、`session.*` 方法、`session.durable.v1` 特性、Go 单元与集成测试。旧方法不动。实现见 `remote-executor/internal/session/`、`remote-executor/internal/handlers/session*.go`；TS 侧协议类型已同步到 `server/lib/agent/execution/rpc-types.ts`。
2. ✅ NarraFork 远端终端改用会话协议：断线/重启后补齐输出；终端行记录会话 ID，续读位置随缓冲快照保存。
3. ✅ 后台 Bash（`kind:"exec"`）走同一会话核心，替换 `exec.start` 的长 RPC：断线不中断，重启后重新附着。
4. ✅ 日志落盘（§7）：执行器崩溃或重启后，会话输出与退出事实仍可读，运行中的会话报告 `lost`。

**第二期：本地模式**——拉起本地执行器，本地终端与后台 Bash 迁移，替代 dtach。

**第三期：Windows ConPTY**——用 `golang.org/x/sys/windows` 薄封装 `CreatePseudoConsole`，进程与 Job 由执行器持有。

**第四期：升级不中断**——Unix 通过 Unix socket 传递 PTY 主端句柄；Windows 旧版本跑完存量会话后退出。

## 10. 测试

- Go：日志的序号/淘汰/缺口单元测试；会话生命周期（启动、写入、去重、resize、kill、退出事实）；附着从任意序号续读、慢消费者收到缺口、取消附着不影响会话、多附着者。
- 传输：连接断开后会话存活，新连接 `attach(since)` 拿到断开期间的输出（`internal/transport` 集成测试）。
- NarraFork：远端终端在模拟设备重连后补齐输出；缺口提示；旧执行器（无特性）继续走 `pty.*`。
