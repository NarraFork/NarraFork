---
id: platform.utils
title: 后端通用工具
summary: 没有业务归属的小工具：互斥锁、HMR 安全的全局状态、UTF-8 字节预算、附件头、ZIP 读取与解压、slug、服务端文案表。
anchors:
  - server/lib/platform-path.ts
  - server/lib/sql-like.ts
  - server/lib/async-mutex.ts
  - server/lib/avatar-colors.ts
  - server/lib/content-disposition.ts
  - server/lib/hot-safe.ts
  - server/lib/i18n.ts
  - server/lib/slug.ts
  - server/lib/utf8-budget.ts
  - server/lib/words.ts
  - server/lib/zip-archive.ts
  - server/lib/__tests__/async-mutex.test.ts
  - server/lib/__tests__/content-disposition.test.ts
  - server/lib/__tests__/utf8-budget.test.ts
  - tests/server/lib/zip-archive.test.ts
keywords:
  - AsyncMutex
  - PathKeyedMutex
  - worktreeLock
  - hotSafe
  - hotOnce
  - hotTimer
  - utf8Bytes
  - sliceToUtf8Budget
  - withinUtf8Budget
  - buildAttachmentDisposition
  - Content-Disposition
  - ZipArchiveError
  - extractZipArchive
  - slugify
  - generateWordSlug
  - randomAvatarColor
  - getToolMessage
  - 服务端文案
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---

# 后端通用工具

`server/lib/` 下几个没有业务归属、被很多服务共用的小模块。它们大多是为了避开一个具体的坑而存在，注释里写了坑是什么，改之前先读。

## 关键规则
- `AsyncMutex`（`async-mutex.ts`）：按 key 的进程内 FIFO 互斥，`acquire(key, fn)` 排队执行；`tryAcquire(key, fn, timeoutMs)` 超时返回 `{ acquired: false, waitedMs }` 而不是执行，且只在真正拿到锁时才入队，超时放弃不会提前放开排在后面的人。仅限单进程。
- `PathKeyedMutex`：以目录路径为 key，内部用 `normalizePathForComparison` 规范化；调用方传原始路径，规范化后的值只作 key，绝不当 cwd 传给 git（大小写折叠在区分大小写的文件系统上有破坏性）。`worktreeLock` 是 worktree 写操作唯一的互斥，`git-service` 的写方法拿它，调用它们时不得已持有它；锁顺序只允许 `worktreeLock` → 影子仓库锁，没有运行时断言，只靠评审和 `git-service-worktree-lock.test.ts`。`narratorTraitsLock`、`narratorDraftLock` 也在此导出。
- `hot-safe.ts`：把状态钉在 `globalThis` 的 `Symbol.for(key)` 上，让 `bun --hot` 重新求值模块时不丢状态也不重复：`hotSafe`（惰性创建持久对象）、`hotTimer`/`hotTimerClear`（替换 interval，先清旧的）、`hotOnce`（`process.on("exit")`、事件总线监听这类只能注册一次的动作）。key 全局共享，同名即同一份。
- `utf8-budget.ts`：`String.length` 是 UTF-16 单元数，对中文会把字节上限放大约 3 倍，所以凡与 `*_BYTES` 比较都用 `utf8Bytes`/`withinUtf8Budget`/`sliceToUtf8Budget`。`utf8Bytes` 对含孤立代理项的串走 `Buffer.from` 精确计数（孤立代理项按 3 字节 U+FFFD 写出）；`sliceToUtf8Budget` 切到半个代理对时丢掉孤儿，结果保证合法且不超预算；`maxBytes < 0` 表示无上限（仅 `withinUtf8Budget`）。
- `content-disposition.ts:buildAttachmentDisposition`：同时输出 ASCII 回退 `filename` 和 RFC 5987 `filename*`；去掉控制字符、引号、路径分隔符以及 `;`、`,`，只留 basename，空或 `.`/`..` 退回 `download`，长度上限 120。非 ASCII 字符在回退名里换成 `_`（保留扩展名）。目前调用方是 `routes/fs.ts`。
- `zip-archive.ts`：无依赖的 ZIP 读取与解压（store + deflate，可选 ZIP64，基于 `node:zlib`，不再外调 `unzip`）。先读中央目录再落盘；默认上限 10000 个条目、单文件 50 MiB、总计 500 MiB、中央目录 16 MiB（`DEFAULT_MAX_*`）；条目名拒绝反斜杠、绝对路径、`..` 和空段（`.` 段丢弃，`normalizeZipEntryName`）；逐条流式解压并校验 CRC-32 与大小，超限中途中止；符号链接和特殊条目默认拒绝而不是静默跳过，也永不创建。用户：插件包（`plugin-package-store.ts`）、知识包激活、编辑器文档面板。
- `slug.ts:slugify`：NFKD 去变音符，保留 Unicode 字母和数字（CJK 保留），其余折成 `-`，小写，截 30 字符，空则 `entry`。
- `words.ts:generateWordSlug`：形容词-动名词-名词随机组合（用 `randomBytes` 取随机数），用于计划文件 ID（`narrator-plan-mode.ts`、`narrator-service.ts` 在 plan 模式起会话时、`narrator-session.ts` 切入 plan 权限模式时）。
- `avatar-colors.ts:randomAvatarColor`：十二色调色板里随机取一，所有账号创建路径（注册、SSO、管理员创建）共用。
- `i18n.ts`：服务端文案表，key 带命名空间 `tool.*`、`gateway.*`、`sidecar.*`；`t(key, locale, params)` 缺 key 原样返回 key，缺语言回落英文，占位符 `{name}` 逐个替换。`getToolMessage*` 是 `tool.*` 的类型化入口，`getUserLanguage`/`getUserReplyInLanguage` 读 `user_preferences`（懒加载数据库依赖）。这是后端写进对话或网关的文案，不是前端 i18n 命名空间。

## 从哪读起
- `server/lib/async-mutex.ts` 末尾的锁层级注释。
- `server/lib/utf8-budget.ts`：头部说明了为什么不能用 `.length`。
- `server/lib/zip-archive.ts`：`readZipArchive` → `extractZipArchive`。

## 改它时
- 新增 `tool.*` 文案：在 `messages` 加 en 与 zh-CN 两份，并把 key 补进 `ToolMessageKey` 联合；没有守卫测试，漏掉 zh-CN 会静默回落英文。
- 改 `utf8-budget.ts`：`utf8-budget.test.ts` 钉着 CJK 不超预算、不留孤立代理项、预算落在代对中间时整字丢弃。
- 改附件头：`content-disposition.test.ts` 钉着头注入、分隔符和 CJK 回退；ZIP：`tests/server/lib/zip-archive.test.ts`；锁：`async-mutex.test.ts`。
- 在 `--hot` 下会重复执行的模块级定时器、监听器和 Map 一律走 `hot-safe.ts`，否则热重载后会有两份。

## 相关
- [主线程性能规则](main-thread.md)：字节上限与大输入的约束。
- [操作系统集成](os-integration.md)：钩子表用 `hotSafe`。
