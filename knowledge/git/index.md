---
id: git
title: 代码仓库
summary: git 服务、状态与暂存、会话 worktree、分支与引用查询。
anchors: []
keywords:
  - git
  - 工作区
  - /api/narrators/:id/git
  - gitService
  - git status
  - git worktree
  - 提交
  - 分支
  - 暂存
  - 变更列表
  - GitPanel
  - Git 面板
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 代码仓库

这一块是服务端对 git 仓库的全部操作，围绕「叙述者的工作区」组织：路由 `/api/narrators/:id/git/*` 由服务端解析工作区，不信任客户端路径。

- 读状态（[git 服务与状态](service-status.md)）是基础：`gitService` 封装子进程，状态查询单飞、缓存、有界；大列表分页并在 Worker 中处理。
- 在状态之上，[暂存与变更列表](staging.md)把未提交改动按列表归属，并支持按列表提交，同样只在 Worker 中执行。
- [分支与引用查询](refs.md)是一组共享的只读引用函数和身份解析，被 `gitService` 与 worktree 服务共用，也决定提交署名。
- [会话 worktree](worktrees.md)管理 linked worktree 的资源登记、创建与受保护的删除，删除前用引用查询判断是否会丢历史。

共同约束：子进程都有超时和输出上限；worktree 服务与团队 worktree 在不受信的检出里跑 git 时用 [外部进程加固](../security/hardening.md) 里的配置（暂存子进程自带一组 `-c` 覆盖，不用那份配置，见 [暂存与变更列表](staging.md)）；不允许在 Worker 失败时回退到主线程。

## 下面有什么

- [git 服务与状态](service-status.md)：git 调用封装、状态缓存与分页、差异视图。
- [暂存与变更列表](staging.md)：暂存列表、变更列表归属与提交。
- [会话 worktree](worktrees.md)：worktree 资源、创建与删除（唯一删除通道）、叙事线遗留目录。
- [分支与引用查询](refs.md)：引用解析、合并基、祖先、领先落后、身份。
- [工作区归属与监听](workspace-watch.md)：git 工作区的访问范围、改动归属、文件监听，以及 git 管理服务。
