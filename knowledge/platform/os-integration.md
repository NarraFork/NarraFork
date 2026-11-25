---
id: platform.os-integration
title: 操作系统集成
summary: 在文件管理器中定位（Windows 的 narrafork:// 协议激活）、关闭后钩子、操作系统关机命令等与宿主系统打交道的部分。
anchors:
  - shared/browser-paths.ts
  - server/lib/windows-child-job.ts
  - server/lib/win-env.ts
  - server/lib/shell-exec.ts
  - server/services/file-clipboard.ts
  - server/lib/post-shutdown-hooks.ts
  - server/lib/power-off.ts
  - server/lib/reveal-protocol-client.ts
  - server/lib/reveal-protocol-registration.ts
  - server/lib/reveal-protocol.ts
  - server/lib/__tests__/post-shutdown-hooks.test.ts
  - server/lib/__tests__/power-off.test.ts
  - server/lib/__tests__/reveal-protocol.test.ts
  - server/routes/__tests__/fs-reveal.test.ts
keywords:
  - 在文件管理器中显示
  - POST /api/fs/reveal
  - /api/reveal-protocol
  - narrafork://
  - protocolUrl
  - issueRevealToken
  - registerPostShutdownHook
  - runPowerOff
  - resolvePowerOffPlan
  - powerOffCommand
  - HKCU Software Classes narrafork
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---

# 操作系统集成

服务是后台进程，要让宿主系统做事（弹出文件管理器、关机）有几处需要特殊处理：Windows 下用自定义协议拿到前台权限，关机则放在优雅关闭之后、`process.exit` 之前。

## 关键规则
- 定位文件 `POST /api/fs/reveal`（`routes/fs.ts`）：路径必须存在且是文件或目录。分支：
  - Windows 且请求来自本机地址（`isLocalMachineAddress(getClientIp(c))`）且协议注册成功：不在服务端启动，返回一次性 `protocolUrl`，由浏览器打开 `narrafork://reveal/<token>`。
  - Windows 的远程浏览器、或协议注册失败：服务端直接 `explorer`（文件用 `/select,`）。
  - macOS：`open -R <文件>` 或 `open <目录>`；Linux：`xdg-open` 文件所在目录或目录本身；其他平台抛 `ValidationError`。
  - 启动失败（如缺 xdg-utils）转成 `AppError` 而不是未处理的子进程错误；不加 `windowsHide`，否则文件管理器窗口看起来没反应。
- 协议 URI 不带路径：只带 10 秒有效的一次性令牌（`issueRevealToken`/`claimRevealToken`，进程内 Map，认领即删，过期返回 null），服务端地址写在注册表命令行的 `--reveal-server=` 里，网页无法指向别的服务器（`reveal-protocol.ts`）。
- 令牌认领端点 `POST /api/reveal-protocol/:token` 注册在全局会话认证之前，令牌本身就是凭证；未知或过期返回 404（`server/app.ts`）。
- 注册表 `HKCU\Software\Classes\narrafork`（无需管理员权限）在每次签发令牌前重新核对：命令不一致才改写，所以 exe 搬家、换端口、别的实例后注册都会被修正（`reveal-protocol-registration.ts:ensureRevealProtocolRegistered`）；源码运行时命令里带 bun 本身和入口脚本。
- 协议客户端是 Windows 专用短命进程：`server/index.ts` 在 `./main` 之前分流（`parseRevealActivation(argv)`），不碰设置、数据库、端口；释放控制台、向服务端认领路径（5 秒超时，`rejectUnauthorized: false` 因为回环自签证书）、`AllowSetForegroundWindow` 后拉起 explorer，失败只记 warn，最后 `exit(0)`（`reveal-protocol-client.ts`）。
- 关闭后钩子：`registerPostShutdownHook(key, hook|null)`，同 key 覆盖，所以热重载不会叠加（用 `hotSafe` 存）；`runPostShutdownHooks` 共用一个 10 秒期限，永不 reject，抛错或超时只记日志（`post-shutdown-hooks.ts`）。
- 钩子只在 `main.ts` 的管理员关闭处理里、且 `canRunCleanShutdownHooks`（优雅关闭结果 `clean` 且原因与请求原因一致）时运行；当前唯一注册者是无人值守模式（见 [无人值守模式](unattended-mode.md)）。
- 关机命令 `resolvePowerOffPlan`：自定义命令优先（Windows `cmd.exe /c`，其余 `/bin/sh -c`，空、超 500 字符或含控制字符判为 `invalid-custom-command`）；否则 Windows 用 `%SystemRoot%\System32\shutdown.exe /s /t 0` 的绝对路径（避免 PATH 里的 MSYS 垫片吞掉请求）；macOS `osascript` 的 System Events；Linux 依次 `systemctl poweroff`、`shutdown -h now`；其他平台 `unsupported-platform`。
- `runPowerOff` 永不抛错，总预算默认 8 秒按候选数均分；退出码 0 即成功，超时先杀再记；全部失败时返回尝试记录并记 warn。它只回答“用什么命令、成没成功”，何时关机由无人值守服务决定。

## 从哪读起
- `server/lib/reveal-protocol.ts`（令牌与 URI）、`reveal-protocol-registration.ts`（注册表）、`reveal-protocol-client.ts`（客户端）。
- `server/routes/fs.ts` 的 `/reveal` 处理函数。
- `server/lib/power-off.ts`、`post-shutdown-hooks.ts`。

## 改它时
- 改协议 URI、令牌 TTL 或注册命令格式：`server/lib/__tests__/reveal-protocol.test.ts` 钉着令牌一次性、过期、命令格式；`routes/__tests__/fs-reveal.test.ts` 只覆盖 Linux 分支、启动失败和非法路径，Windows 协议分支没有路由测试。
- 协议客户端文件名被 `server/services/file-change-physical-audit.test.ts` 里的入口白名单正则引用，改名要同步。
- 新增关闭后钩子必须用唯一 key，且不得假设能成功：`post-shutdown-hooks.test.ts` 要求抛错不拒绝、挂起受期限约束。
- 新增平台关机命令：`power-off.test.ts` 按平台钉着命令列表；自定义命令仍要经 `customCommandIsUsable`。

## 相关
- [无人值守模式](unattended-mode.md)
- [启动与进程](boot.md)：入口分流与优雅关闭。
