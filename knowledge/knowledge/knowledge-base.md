---
id: knowledge.knowledge-base
title: 团队知识库
summary: 分级 + 分 tag 授权、写时复制版本、个人条目与发布评审、知识图谱链接、知识包、关键词注入。
anchors:
  - server/services/knowledge/
  - server/services/knowledge-acl.ts
  - server/services/knowledge-service.ts
  - server/services/knowledge-branch-service.ts
  - server/services/knowledge-link-service.ts
  - server/services/knowledge-injection.ts
  - server/services/knowledge-pack-service.ts
  - server/services/knowledge-pack-activation-service.ts
  - server/services/knowledge-audit.ts
  - server/services/knowledge-notify.ts
  - server/routes/knowledge.ts
  - server/routes/knowledge-packs.ts
  - server/lib/agent/tools/knowledge.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 团队知识库

集合（`knowledge_collections`）里放条目（`knowledge_entries`），条目正文以只增的修订（`knowledge_revisions`）保存；读写受"密级 + 受控 tag"双轴授权约束；个人条目经"发布申请"评审后并入全局条目；条目间可建有向链接；另有"知识包"（压缩档）。

## 关键规则
- 写时复制：每次编辑追加一条修订（版本号单调递增，`contentHash`），`knowledge_entries.current_revision_id` 指向最新，`current_content` 是供 FTS 触发器用的冗余拷贝（`schema.ts` 注释，`knowledge-service.ts:addRevision`）。
- 双轴读授权（`knowledge-acl.ts:canRead`）：admin 直通；先过集合门（`canReadCollection`：集合 owner，或 clearance ≥ 集合密级且持有集合全部受控 tag）；再看条目——条目 owner 直通，否则 clearance ≥ 条目密级（条目未设则继承集合 `defaultLevel`）且条目受控 tag ⊆ 已授予 tag。拥有条目不能绕过集合门。
- 失败即关闭：未知密级名（被删、拼错）按"无限高"处理，只有 admin/owner 能读（`rankOf`）；密级名→rank 缓存 30 秒，改密级后要 `invalidateLevelCache`。
- 授权来源：`knowledge_grants`（grantType 为 clearance / tag / review，可带 `collectionId` 限定集合；集合级授权不外溢到别的集合，`effectiveCapsForCollection`）。批量解析全体用户权限有 200 用户上限，超出退化为只有 admin（`BATCH_CAPS_USER_LIMIT`、`knowledge-notify.ts`）。
- 写权限分层：直接追加主线修订需 admin / 条目 owner / 写授权 / 集合 owner（`canDirectWriteEntry`），否则报错并提示走草稿评审；改密级、受控 tag、评审 tag 只有 admin（HTTP 面）或条目 owner（`isEntryOwnerOrAdmin`），写授权不等于改可见性的权力；评审需 admin / owner / 持有该条目全部评审 tag 的 review 授权，无评审 tag 时仅 admin/owner（`canReview`）。无权读集合时一律 NotFound，避免泄露存在性。
- 个人条目与发布：个人条目状态只有 active / archived（可关联全局条目，带三方合并基线；也可独立）；发布申请在 `knowledge_submissions`，状态 pending / approved / rejected / changes_requested / conflict / withdrawn / superseded，rejected 为终态，作者改动或 rebase 个人条目会把未决申请自动置 superseded（`knowledge-branch-service.ts`、`knowledge/write-store.ts` 的状态集常量）。合并冲突进入 conflict，需 `resolveConflict`。
- 链接：`knowledge_entry_links`，类型 related / expands / supersedes / depends_on / parent / mention / custom，`(from,to,linkType)` 去重，可钉到目标修订；管理权限等同源条目可读，目标也须可读；图遍历最多 200 节点、每跳最多 1000 条链接（`knowledge-link-service.ts`）。
- 自动注入：条目作者声明的 `keywordsJson` 命中用户消息/工具输出时才被注入，未设关键词永不注入（仍可用 KnowledgeSearch 找到）；`settings.knowledge.injectMode` 为 `off` 时整体关闭，默认 `summary`（`knowledge-injection.ts:resolveInjections`、`settings/defaults.ts`）。
- 存储后端：读写经 `knowledge/store.ts` 的端口，默认 SQLite，只有精确值 `postgres` 才选 PG，读写后端必须一致，不一致启动即报错。搜索走 `server/services/search/` 的后端抽象。
- 知识包：`knowledge_packs`（tar.gz/zip 档案、sha256、可继承某条目 ACL 或用自身密级/tag）；激活时在子进程解压（60s 超时、输出 256KB 上限），把解压目录登记为叙述者白名单目录并记录 `knowledge_pack_activations`，列表最多回报 200 个文件（`knowledge-pack-activation-service.ts`）。
- 审计与通知：授权变更写追加式审计，只记录密级名、tag id 与布尔值，写失败不影响主操作（`knowledge-audit.ts`）；评审相关推送只发 id 类失效信号，不含标题正文，客户端经带 ACL 的 HTTP 重取，不进通知中心表（`knowledge-notify.ts`）。
- Agent 工具：KnowledgeSearch / KnowledgeRead / KnowledgeLibrary / KnowledgeCreate / KnowledgeEdit / KnowledgeReview / KnowledgeAdmin（`server/lib/agent/tools/knowledge*.ts`）。

## 从哪读起
- `server/services/knowledge-acl.ts`：权限判定。
- `server/services/knowledge-service.ts`：集合/条目/修订/搜索。
- `server/services/knowledge-branch-service.ts`：个人条目、发布申请、评审。
- `server/routes/knowledge.ts`：HTTP 面。
- 测试：`server/services/__tests__/knowledge-acl.test.ts`、`knowledge-review-lifecycle.test.ts`、`knowledge-drift-rebase.test.ts`、`knowledge-pack.test.ts`。

## 相关
- [大纲](outline.md)
- [项目](../collaboration/projects.md)：项目内知识仍受自身 ACL 约束。
