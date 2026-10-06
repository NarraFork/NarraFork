# API request dump 溢写到文件（requestDumps）

request dump 回答的是「我们到底发了什么、上游回了什么」，所以它必须完整——但完整就意味着大（含重放历史和内联图片时动辄数 MB），而主线程性能规则禁止让 SQLite 行无上限增长。两个要求只在「dump 存在数据库里」时冲突，因此按大小分流：

- **行内只留有界的头部 + 指针。** `server/lib/api-request-dump-store.ts` 的 `RAW_DUMP_INLINE_MAX_BYTES`（当前 512KiB）是**行预算**，与 `agent.requestDumpMaxSize`（运维想保留多少 dump）是两件事；早期把两者混为一谈，导致 5MB 的 dump 在 32MB 默认值下从不溢写、整块进了 `raw_dump_json`。超过行预算时行里只保留可读的 head 和 `RawDumpSpillPointer`（带 `inlineTruncated`，让前端能说明「这是头部，完整内容需下载」）。
- **完整 dump 落到 `~/.narrafork/request-dumps/`**（目录名即 `REQUEST_DUMP_SPILL_DIR`），文件名含时间戳 + requestId + 随机短 id（同毫秒两次写入不能互相覆盖，那正好毁掉别人在收集的证据）。写入有硬字节上限、失败清理和有界重试；具体数值以代码为准，不要在别处复制。
- **该目录可以安全删除，运行时不会读回。** 产品逻辑不依赖这些文件，删除只损失「下载较早 dump 的完整内容」这一项能力。溢写文件数量本身也有上限（`MAX_REQUEST_DUMP_SPILL_FILES`），旧文件按 mtime 淘汰。
- **下载路由 `GET /api/usage-history/:id/raw-dump`** 在行里有 spill 指针时直接流式返回文件（不在主线程解析再重新包装）；**文件被裁剪或手工删除时回落到行内 head 而不是 404**——用户至少拿到残存部分和解释缺失原因的指针。任何走「返回行而非文件」的分支都会先剥掉指针里的绝对路径（路径含宿主 OS 账号名，而 dump 会被转发给协助排查的人）。
- **存储扫描含 `requestDumps` 分类**（`server/services/storage-service.ts`），与 shares、worktrees、treeSnapshots 并列。
- **隐私定位：** dump 是请求的逐字副本，凭据已由 `sanitizeHeaders` 掩码，但消息正文是**故意保留**的（不看正文无法诊断被拒的请求）。按会话数据对待，不要当普通日志。
