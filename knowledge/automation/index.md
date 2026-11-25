---
id: automation
title: 扩展与自动化
summary: 技能、例程与可选工具、定时任务、插件系统、钩子、基准测试与容器。
anchors:
  - server/services/skill-service.ts
  - server/services/routine-service.ts
  - server/services/scheduled-task-service.ts
  - server/services/plugin-manager.ts
  - server/services/hook-service.ts
  - server/services/benchmark-service.ts
keywords:
  - 技能
  - 例程
  - 定时任务
  - 插件
  - 钩子
  - 基准测试
  - 扩展
  - 自动化
  - Skill
  - Routine
  - Hook
  - Plugin
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 扩展与自动化

这一块是让 NarraFork 自己或外部代码“替用户重复做事”的几套机制，彼此基本独立：

- 内容型扩展：[技能](skills.md)是磁盘上的 SKILL.md 目录，按全局/项目/工作区三类根扫描；[例程](routines.md)是代码内置清单，其中 skill 类例程启用时会落成技能，tool 类例程用 manual/auto/resident 三段式决定工具是否进会话。
- 触发型自动化：[定时任务](scheduled.md)按 cron 启动叙述者；[钩子](hooks.md)在工具调用、回合结束、需要关注等事件点执行命令或 HTTP，并可阻止 PreToolUse。
- 代码型扩展：[插件系统](plugins/index.md)以独立进程、清单声明贡献点、能力代理授权；运行、授权、提供商、贡献点各有子节点；插件可用 Podman 运行器。[基准测试与容器](benchmarks-containers.md)是另一处使用 Podman 的地方（SWE-bench 隔离），容器服务只做检测、安装与 compose 解析。
- 共同点：持久配置多落在设置文件、项目 chapterSettings 或专用表；管理类接口多要求管理员。

## 改它时
- 这一块各机制彼此独立，改某一机制先读对应子节点的「改它时」；跨机制的共同点只有配置落点（设置文件、项目 `chapterSettings`、专用表）和“管理类接口要求管理员”。

## 下面有什么

- [技能](skills.md)：项目级技能库。
- [例程与可选工具](routines.md)：manual / auto / resident 三段式、项目层覆盖。
- [定时任务](scheduled.md)：定时任务的存储、触发与运行记录。
- [插件系统](plugins/index.md)：插件包、运行时、能力代理、提供商插件、UI 插件（下分运行时、授权与密钥、提供商、贡献点四节）。
- [钩子](hooks.md)：钩子配置与触发。
- [基准测试与容器](benchmarks-containers.md)：基准测试服务、Podman 容器。
