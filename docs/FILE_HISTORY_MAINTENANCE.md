# 离线文件历史维护

本工具让文件历史绑定到现存 `file-change-source.json` 与 `file-change-blobs` 的物理身份。维护只在管理员已经停止实例、停用自动拉起机制后进行；工具不会停止、接管、启动服务，也不会修改启动脚本或版本软链。

## 数据影响与空间

`--apply --confirm-discard-file-history` 会在一个 SQLite 事务中使旧文件预览、树快照、回退计划及依赖快照的 Git 基线过期，并清理关联 catalog/reservation 逻辑计量。工作区实际文件、Git 状态、会话、消息、操作身份与归属记录保留。source 文件、blob 根目录及 blob 实物保持原位，因此旧 blob 仍占磁盘；预算归零不是释放磁盘。

**提交后旧文件历史不能恢复。** 工具不备份、复制、导出数据库或 WAL/SHM，也不执行 VACUUM、整库校验或消息扫描。对于约 40GB 数据库，不要求额外容纳数据库副本；正常事务日志和同步保护始终保留，仍必须有足够的事务临时空间。默认要求至少 1GiB 可用空间，`--min-free-bytes` 可设置实际维护窗口阈值（最低 16MiB）；这不是最坏事务空间估算，空间耗尽仍会导致失败。不要关闭日志或删除 WAL/SHM。

## 1. 独立 SSH 终端停用启动循环

不要在承载当前 AI 会话的终端或 Agent 工具中执行生产维护。先在独立 SSH 终端调查当前部署，并记录准备手动启动的**固定版本二进制绝对路径**、必要运行环境与端口：

```sh
ps -eo user,pid,ppid,pgid,lstart,comm --forest
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} pane_pid=#{pane_pid} command=#{pane_current_command}'
# 将下列数字替换为本次核验得到的 PID；不要使用历史 PID。
readlink -e /proc/实例PID/exe
readlink -e /proc/循环ShellPID/exe
ps -p 循环ShellPID,实例PID -o user,pid,ppid,pgid,lstart,comm
```

不要将完整环境、命令行、凭据粘贴到日志或会话。必要环境应由管理员在自己的终端保留。

当前部署的 `/home/project/narrafork/start.sh` 在 tmux 中用 `while true` 拉起实例；它每轮选择较新二进制，并有 TERM 后 SIGKILL 的逻辑。**只停止实例子进程会触发重新拉起。** 操作员必须先结束经核验的启动循环，并确认 tmux、systemd、容器策略、cron 或其他拉起者均已停用：

1. 重新检查循环 shell 的 PID、开始时间、真实可执行文件、PPID/PGID 和所属 tmux pane。
2. 只向这个固定 shell PID 单独发送 `kill -TERM 循环ShellPID`，等待并确认 shell 真正退出。若没有退出，停止后续操作并排查；不要先停实例。
3. 重新核验实例 PID 的开始时间、真实二进制与归属，然后单独执行 `kill -TERM 实例PID`；等待实例优雅退出并再次检查。
4. 确认没有第二实例或其他进程持有此数据目录；不能证明退出就不要维护。不要强杀、按进程名批量结束、发送负 PGID、盲按 Ctrl-C、结束整个 tmux server，或手动删除锁文件。

本说明中的信号是管理员独立执行的停机步骤，不是维护脚本行为。脚本只会在取消/超时后终止它自己创建的计算子进程，绝不向服务、旧锁持有者或其他进程发信号。

禁止使用 `NARRAFORK_ALLOW_MULTIPLE`、`NARRAFORK_FORCE_UNLOCK` 或其他绕过实例锁的启动方式。`--confirm-auto-restart-disabled` 是管理员对停用全部自动拉起机制的事实声明，不替代工具的实例锁与 `/proc` 检查。

## 2. 执行维护

要求 Linux、本机文件系统、现存的 canonical 绝对路径，以及能够完整读取所有进程 fd/maps 的 root 权限。数据目录和 blob 根必须是当前所有者的私有 0700 目录，数据库/source/已有 WAL/SHM 等须为私有普通单链接文件。source 与 blob 根缺失、软链接、未知旧锁、权限不足、`/proc` 受限或观察超限均会拒绝；工具不会初始化缺失对象、迁移 schema 或修正权限。

以下命令仅作管理员手动执行示例。核对路径与待启动实例一致，再在独立 SSH 终端运行。运行时固定为项目现成 Bun 1.4.3，不依赖系统 Bun，也不自动安装或升级。

### 只读预检（默认模式）

```sh
PATH="/home/project/narrafork-private/dist/build-runtime-bun-1.4.3/package/bin:$PATH" /home/project/narrafork-private/dist/build-runtime-bun-1.4.3/package/bin/bun /home/project/narrafork-private/scripts/repair-file-history.ts --data-dir /root/.narrafork --database /root/.narrafork/narrafork.db --confirm-auto-restart-disabled --check
```

默认省略 `--check` 也只预检。预检成功只表示检查完成，不表示旧历史已修复或可以启动；预检报告的 `startupAllowed` 为 false。预检与验证不会修改业务数据，但会创建私有维护锁和有界摘要报告。正常关闭 SQLite 只读连接不会主动 checkpoint。所有模式都必须离线。

### 一条命令完成事务修复及定向校验

```sh
PATH="/home/project/narrafork-private/dist/build-runtime-bun-1.4.3/package/bin:$PATH" /home/project/narrafork-private/dist/build-runtime-bun-1.4.3/package/bin/bun /home/project/narrafork-private/scripts/repair-file-history.ts --data-dir /root/.narrafork --database /root/.narrafork/narrafork.db --confirm-auto-restart-disabled --apply --confirm-discard-file-history
```

命令检查实际 schema、全部已知 blob 引用根、未决操作与维护资格，持有启动兼容的 `narrafork.lock` 及工具互斥，在打开连接、事务与提交前后复核身份和其他持有者，然后单事务失效旧引用、重绑预算，再定向验证结果。未知状态或结构不会被强制清除。

默认时限 30 分钟，可用 `--timeout-ms` 在 1 秒至 24 小时之间明确调整。进程观察另有每轮 15 秒、32768 PID、262144 fd 总量及每个 maps 2MiB 的硬上限，超限失败而不是认为已离线。进度只输出阶段和数量。

### 单独验证

```sh
PATH="/home/project/narrafork-private/dist/build-runtime-bun-1.4.3/package/bin:$PATH" /home/project/narrafork-private/dist/build-runtime-bun-1.4.3/package/bin/bun /home/project/narrafork-private/scripts/repair-file-history.ts --data-dir /root/.narrafork --database /root/.narrafork/narrafork.db --confirm-auto-restart-disabled --verify
```

摘要报告位于 `/root/.narrafork/file-history-maintenance/repair-*.json`，目录 0700、单文件 0600、至多 8KiB；只记录模式、阶段、数量、提交状态及固定错误码，不保存消息正文、原 source ID 或凭据。每次维护打印本次报告的精确路径。不要把单纯存在报告或出现中间阶段当作成功；必须同时核对退出码为 0 和最终成功报告。

## 3. 成功后手动启动固定版本

先确认 `--apply` 返回成功、定向验证通过，所有维护进程已经退出。不要使用 `latest` 软链，也不要调用会自动更新版本和强杀进程的原 `start.sh`。使用停机前记录并重新核验的固定二进制绝对路径，保留管理员核对过的必要运行环境与端口；首次加 `--no-auto-resume`：

```sh
# 将占位路径替换为实际核验的版本化二进制；不要直接执行占位命令。
/已核验目录/narrafork-明确版本 --no-auto-resume
```

`--no-auto-resume` 保留恢复与审批清单，但首次不自动继续代理/工具。

确认健康后，由管理员新建一个明确的测试文件并做一次受控变更，验证**新的**文件历史可以产生；旧历史预览/回退计划应已过期。该人工功能验证不属于离线工具，工具不会为测试写入工作区或运行真实回退。

## 4. 失败、中断与提交不明

- 所有失败都保持停机，保留报告，先检查固定错误码、提交状态、空间与锁身份。
- 未提交事务由 SQLite 正常日志回滚；不要删除数据库、WAL、SHM 或 journal，不要用文件覆盖“恢复”。
- 提交后验证/报告/释放锁失败，或子进程异常退出、Ctrl-C、终端断线、超时，可能已提交，必须按“禁止启动，需检查”处理。不要将重复 `--apply` 当作通用恢复；在已证明离线的条件下单独运行 `--verify`。
- 正常退出只释放自己的令牌与 inode。中断可能保留有效维护锁；工具只会在进程身份被严格证明已结束、目录和载荷都匹配时回收已知锁。未知、空、不合规或被替换的锁须管理员调查，工具不抢占或破坏证据。
- `/proc` 不可完整观察、另有持有者、目录/source/锁身份变化、未决文件操作、保留中的 reservation、工作区执行/隔离 lease、执行中的回退、未知触发器或引用结构都会阻止维护；不存在 force 开关。
- 报告失败不能改写提交事实。报告可能停在 `before_commit` 或 `after_commit`，此时不能宣称已经回滚或已经安全启动。

开发验证仅使用隔离 fixture 数据，不代表生产数据库已经执行维护。生产命令必须由管理员在确认停机后另行运行。
