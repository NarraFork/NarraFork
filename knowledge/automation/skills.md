---
id: automation.skills
title: 技能
summary: 项目级技能库。
anchors:
  - server/services/skill-service.ts
  - server/services/skill-directory-sync.ts
  - server/services/skill-github-import.ts
  - server/services/skill-link-download.ts
  - server/services/skill-write-scope.ts
  - server/routes/skills.ts
  - server/lib/agent/tools/skill.ts
  - frontend/hooks/useSkills.ts
  - server/lib/validators/skills.ts
keywords:
  - /api/skills
  - SKILL.md
  - SKILL.md.disabled
  - skill_directory_caches
  - SKILL_LINK_PRIVATE_HOST
  - SKILL_GITHUB_LIMIT
  - validateImportedSkillPath
  - Skill 工具
  - 技能导入
  - $NARRAFORK_HOME/skills
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 技能

技能是磁盘上的目录，里面有带 YAML frontmatter 的 `SKILL.md`（可带附属文件）。服务端不把技能存进数据库，而是按叙述者上下文扫描若干根目录，叙述者通过 Skill 工具按名字加载。

## 关键规则
- 三类根：`global`（用户主目录）、`project`（项目的 gitPath）、`workspace`（叙述者 cwd 所在的 git 根，没有 git 则 cwd 本身）；路径相同的根只保留一个（`skill-service.ts:resolveSkillRootsForContext`）。
- 每个根下依次扫描 `.narrafork/skills`、`.narrafork/skill`、`.claude/skills`、`.agents/skills`、`.codex/skills`；扫主目录时还加 `$NARRAFORK_HOME/skills` 和 `$CODEX_HOME/skills`（`getSkillSearchDirs`）。同名技能后者覆盖前者，项目层覆盖全局层（`loadAllSkills`）。
- 禁用靠把文件改名为 `SKILL.md.disabled`（`toggleGlobalSkill`；加载时两种文件名都识别）。
- 限额：每个根最多 200 个技能，描述截断到 1000 字符，附属文件最多 20 个、深 2 层；摘要刷新 TTL 15s；`skill_directory_caches` 表缓存目录扫描结果，最长保留 7 天，最多 200 个根，每小时清理一次（`SKILL_SUMMARY_REFRESH_TTL_MS`、`cleanupSkillDirectoryCaches`）。
- 写入位置：全局技能写 `$NARRAFORK_HOME/skills/`，项目技能写 `<project>/.narrafork/skills/`（`createGlobalSkill`、`createProjectSkill`）。创建通过 `withFileWrite` 的固定本地键串行化，只串行本地提交，不含网络下载（`skill-write-scope.ts`）。
- 导入：`POST /api/skills/import?projectId=` 与 `/global/import`（后者需管理员）接受 GitHub 目录链接或下载链接；GitHub 导入限额：URL 2048 字符、SKILL.md 200KB、单文件 1MiB、最多 100 个文件、总 10MiB、深度 8、并发 4；整体超时 45s（`GITHUB_SKILL_IMPORT_LIMITS`、`SKILL_IMPORT_TIMEOUT_MS`）。导入路径必须通过 `validateImportedSkillPath`。
- 路由全部要求登录；项目级接口必须带 `projectId`，读需 read 权限，写需 write 权限；全局技能的导入/按链接更新需管理员（`routes/skills.ts`）。
- 项目例程可覆盖内置技能（`applyProjectRoutineSkillOverrides`），与[例程](routines.md)相连。

- 按链接导入（`skill-link-download.ts`）：只接受公网地址，私网/保留网段报 `SKILL_LINK_PRIVATE_HOST`，URL ≤2048 字符，SKILL.md ≤200000 字节（`SKILL_LINK_LIMIT`），最多 3 次重定向、HTTPS 不得降到 HTTP（`SKILL_LINK_REDIRECT`），必须是 UTF-8 文本（`SKILL_LINK_ENCODING`），HTML 页面被拒（`SKILL_LINK_HTML`）；GitHub 目录链接走 `skill-github-import.ts`（错误码 `SKILL_GITHUB_URL/PATH/LIMIT/METADATA/ABORTED`）。
- 前端：`useSkills.ts` 以查询键 `skills`（带 `projectId`）缓存并在写入后失效；校验在 `validators/skills.ts`。

## 从哪读起
- `server/services/skill-service.ts`：扫描、解析、缓存、CRUD；`skillService` 对象是对外入口。
- `server/lib/agent/tools/skill.ts`：叙述者侧的 Skill 工具。
- `server/services/skill-directory-sync.ts`：替换技能目录时的快照与原子替换。

## 改它时
- 加技能搜索根或文件名约定：`getSkillSearchDirs`/`resolveSkillRootsForContext` 与 `skill-directory-sync.ts`、`skill_directory_caches` 缓存一起改；`skill-load-bounds.test.ts`、`skill-disable-precedence.test.ts`、`skill-narrafork-home.test.ts`、`skill-directory-sync.test.ts` 断言限额、禁用优先级与目录。
- 改导入：`skill-github-import.test.ts`、`skill-link-download.test.ts`、`skill-import-install.test.ts`、`skill-url-update.test.ts`、`server/routes/__tests__/skill-import.test.ts`。
- 技能创建必须走 `skill-write-scope.ts` 的写入范围（`withFileWrite` 固定本地键），只串行本地提交，不含下载。
- 不变量：技能不入库；禁用靠改名 `SKILL.md.disabled`；导入路径必须过 `validateImportedSkillPath`；导入全程有超时（45s）。

## 相关
- [例程与可选工具](routines.md)
