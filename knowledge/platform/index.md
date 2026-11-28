---
id: platform
title: 运行平台
summary: 后端进程怎么启动、怎么接请求、怎么在线程之间分工，以及所有后端代码都要遵守的性能与隔离规则。
anchors:
  - server/index.ts
  - server/app.ts
  - server/http-dispatcher.ts
  - server/lib/worker-runtime/
keywords:
  - 后端架构
  - Bun.serve
  - 单线程
  - 主线程阻塞
  - 启动顺序
  - NARRAFORK_HOME
  - 优雅关闭
  - 性能规则
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 运行平台

后端是单个 Bun 进程。`server/index.ts` 按标志选择角色（管理器、服务、各类子进程入口），服务角色经 `serve.ts` 先起启动状态页再加载 `main.ts`；`main.ts` 等待数据库就绪、绑定端口，之后所有请求进入 `http-dispatcher.ts`：WebSocket 升级在这里验证令牌，其余交给 `app.ts` 的 Hono 路由。

各部分怎么配合：
- 服务之间不直接互相调用的部分通过事件总线解耦，WebSocket 通道订阅总线事件再广播给浏览器。
- 配置来自 `settings` 单例，数据都放在 `NARRAFORK_HOME` 下；设置在模块加载时同步读取，所以启动序列把它放在 try 里统一处理失败。
- 因为 HTTP、WS、SQLite 共用一个 JS 线程，重活（大范围读库、目录扫描、编译、diff）放 Worker 池或子进程；Worker 失败就让任务失败，不回主线程重跑。主线程规则与 Worker 规则是同一个问题的两面。
- 终端是平台能力的一个例子：PTY、缓冲和 WebSocket 通道都在服务进程内，部分终端（dtach）可在重启后重新接上。
- 所有业务错误统一为 `AppError` 家族，由 `app.onError` 序列化，请求体用 Zod 校验。

## 下面有什么

- [启动与进程](boot.md)：入口、启动顺序、迁移、关闭；manager 进程与运行时。
- [HTTP 路由与 WebSocket](http-ws.md)：Hono 路由注册、鉴权中间件、请求分发、WebSocket 订阅模型。
- [事件总线](event-bus.md)：服务之间的类型化事件，服务到 WebSocket 广播的解耦。
- [设置与数据目录](settings.md)：settings.json 单例与保存/重载、数据目录布局与权限检查、内置 HTTPS 证书、实例设置与用户偏好、设置页。
- [Worker 隔离](workers.md)：Worker 运行时、读池就绪门、编译产物里的 Worker 登记，以及 Worker 故障时不得回退主线程的规则与守卫测试。
- [主线程性能规则](main-thread.md)：主线程上的约束与观测手段（锁等待、子进程限流、背压、事件循环监控、CPU profile、SQL 追踪）；Worker 运行时见 Worker 隔离。
- [终端运行时](terminal.md)：PTY 抽象（Bun.Terminal / bun-pty）、dtach、终端生命周期。
- [错误与校验](errors-validation.md)：AppError 子类与全局序列化、Zod 校验器目录约定。
- [实例锁、完整性与重启恢复](instance-recovery.md)：单实例锁、正常关闭标记、SQLite 完整性检查与修复、进程重启和更新后的恢复。
- [出站网络与代理](network.md)：代理策略与 no_proxy 规则、启动时中和环境代理变量、outboundFetch 的重放规则、TLS 握手错误、局域网监听地址、诊断信息脱敏。
- [操作系统集成](os-integration.md)：在文件管理器中定位（Windows 的 narrafork:// 协议激活）、关闭后钩子、操作系统关机命令。
- [后端通用工具](utils.md)：没有业务归属的小工具：互斥锁、HMR 安全的全局状态、UTF-8 字节预算、附件头、ZIP、slug、服务端文案表。
- [无人值守模式](unattended-mode.md)：布防后实例持续空闲，就走管理员关闭流程停掉 NarraFork 并关机；任何不确定都按“有活”处理。
