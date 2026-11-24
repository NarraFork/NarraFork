---
id: platform
title: 运行平台
summary: 后端进程怎么启动、怎么接请求、怎么在线程之间分工，以及所有后端代码都要遵守的性能与隔离规则。
anchors: []
status: stub
verified_at: null
---
# 运行平台

> 待填写：后端进程怎么启动、怎么接请求、怎么在线程之间分工，以及所有后端代码都要遵守的性能与隔离规则。

## 下面有什么

- [启动与进程](boot.md)：入口、启动顺序、迁移、关闭；manager 进程与运行时。
- [HTTP 路由与 WebSocket](http-ws.md)：Hono 路由注册、鉴权中间件、请求分发、WebSocket 订阅模型。
- [事件总线](event-bus.md)：服务之间的类型化事件，服务到 WebSocket 广播的解耦。
- [设置与数据目录](settings.md)：settings.json 单例、NARRAFORK_HOME 下的目录布局。
- [Worker 隔离](workers.md)：哪些工作放 Worker/子进程，Worker 故障时不得回退主线程的规则。
- [主线程性能规则](main-thread.md)：SQLite、JSON、同步 IO 都在主线程；列表不读大字段、游标分页、子进程限流、WebSocket 节流。
- [终端运行时](terminal.md)：PTY 抽象（Bun.Terminal / bun-pty）、dtach、终端生命周期。
- [错误与校验](errors-validation.md)：AppError 子类与全局序列化、Zod 校验器目录约定。
