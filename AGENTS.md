# AGENTS.md

项目技术约定见 [CLAUDE.md](CLAUDE.md)，构建流程见 [docs/BUILD.md](docs/BUILD.md)。

本项目 AI 涉及动态变更分组时，加载项目级 `git-changelists` Skill；未自动发现时直接读 [.agents/skills/git-changelists/SKILL.md](.agents/skills/git-changelists/SKILL.md)，并按动作先读 [docs/GIT_STAGING_LISTS.md](docs/GIT_STAGING_LISTS.md)。定位目标 worktree 的实际 Git-dir，使用离线 `changelists` CLI 初始化、同步与移组；独立只读查询使用 `narrafork/changelists/changelists.sqlite` 的稳定视图，按 generation/observationId 核对版本，不直接 SQL 写归属。每个改动单元只有一个所属组，同一文件的不同块可分组；初始化、同步与移组不改写工作文件或普通 Git 暂存区。提交及删除组须明确授权，原生暂存、ITA 或冲突非空时拒绝分组提交；结果未知时保留操作证据，按 operationId 恢复，不自动重复提交。离线操作无需启动 NarraFork 服务或打开主数据库。
