# Changelog

本项目的版本变更记录保存在此文件中。

## [Unreleased]

## [0.0.8] - 2026-03-11

### Added
- 三级黑名单目录系统（全局/项目/叙述者级别），限制 AI 访问敏感目录
- Git clone SSE 流式传输，支持进度条实时显示
- 终端工具（Terminal Tool），AI agent 可直接与 PTY 终端交互
- PathInput 组件，支持路径自动补全和内联创建目录

### Changed
- 设置页面重构为分区组件（About/Agent/Appearance/Models/Notification 等）
- 快进合并检测 + 可靠的 unmerge（通过 preMergeTargetSha 追踪）
- 标题生成加权最近消息，提高标题相关性
- trunk 角色仅限 root chapter

### Fixed
- Code review 修复 — 7 个已验证问题
- 错误边界 + 全局 mutation 错误处理器（i18n）
- SSE reader 在流完成时正确取消
- 合并 DB 失败返回 warning 而非 500
- 离开叙述者重置 interrupted 状态
- Plan mode deny 反馈（i18n）
- 工具使用流式去重（内置网关适配器）

## [0.0.7] - 2026-03-10

### Added
- 消息编辑与重新生成功能，支持一键重试和从任意消息重新生成
- 编辑确认弹窗，区分章节绑定与独立叙述者的 keep/rollback 选项
- 输入历史导航，支持上下箭头键浏览历史输入

### Changed
- 终端进程查询从 wmic 迁移到 powershell，增加 git bash 支持

### Fixed
- Windows shell 检测和进程处理改进
- 终止按钮改为前端定时器驱动，不依赖 WS 推送
- 终止按钮移到 LazyCollapse 外部，无需展开即可见
- toolCallData 构建缺少 startedAt 和 _longRunning 字段
- Windows 上 Git for Windows 进程泄漏 + Redisson 风格看门狗续期机制

## [0.0.6] - 2026-03-10

### Added
- MCP 自动重连机制（指数退避，最多 3 次）及连接/工具发现超时（30s）
- MCP 监听 ToolListChangedNotification 动态刷新工具列表
- MCP rawJsonSchema 旁路：直接传递原始 JSON Schema 给 AI 提供商，避免 Zod round-trip 丢失信息
- MCP 工具执行支持 image/resource 等多种内容类型
- MCP 导入支持 JetBrains 单服务器格式及 type 字段检测
- 图导航聚焦：从叙述者页面返回图时自动聚焦对应章节节点
- 叙述者页面最小化按钮快速返回图
- 子代理继承父叙述者的 whitelist 目录
- zodToJsonSchema 扩展：支持 ZodAny/ZodUnknown/ZodNullable

### Changed
- PWA 迁移到 injectManifest 策略，自定义 Service Worker
- SW 激活时主动检测版本不匹配并通知客户端
- NarraFlow 增量合并优化：仅更新实际变化的节点，保留拖拽位置和对象引用
- 图轮询间隔从 30s 调整为 60s（WS 事件已覆盖大部分场景）
- 中断清理从 fire-and-forget 改为 await，避免竞态
- hot reload guard 防止 Bun --hot 模式下错误触发启动恢复
- 路径越界拒绝使用专用提示消息

### Fixed
- MCP reconnectAttempts 计数器在重连时正确保留
- NarraFlow focusAppliedRef 在 focusChapterId 变化时重置
- MCP 表单 onChange 提取 e.currentTarget.value 避免 React 合成事件池化问题
- scheduleReconnect 的 async 回调增加 try/catch 防止 unhandled rejection
- abort 后允许 error 事件通过以触发 onErrorCleanup 清理孤立工具调用
- MCP 优雅关闭：shutdown 时清理所有连接和重连定时器

## [0.0.5] - 2026-03-10

### Added
- Codex 原生 web_search 支持（OpenAI Responses API）
- Edit 工具返回 startLine/endLine 行号元数据
- Read 工具 force_full 模式增加 100k 字符上限
- MCP 外部服务器初始化和工具桥接（server/lib/mcp/）
- 终端图形节点（TerminalNode/TerminalEdge）和图形状态持久化
- 设置向导（SetupWizard）和依赖检测（DependencyStatus）
- 依赖服务（dependency-service）和依赖路由
- dtach 终端分离会话服务
- ProcessSnapshot 批量进程查询优化
- 例程管理页面增强

### Changed
- ApiError 类型化错误（携带 HTTP status）
- getMessagesAround 分页改进（bounded window + hasMoreAfter）
- 重试策略扩展（500/502 状态码、Bun 错误码）

### Fixed
- 叙述者错误消息持久化为 system message
- recent tabs 标题实时同步
- 跨平台路径正斜杠规范化
- ripgrep 可用性检查和日志
- 叙述者工具调用失败时显示错误消息
- 生产模式检测改进（前端构建存在性判断）
- Windows 资产路径反斜杠规范化
- 编译二进制检测改进（含 Windows 支持）
- MCP 服务器 PATCH 路由输入校验

## [0.0.4] - 2026-03-08

### Added
- 推理翻译（reasoning translation）— Anthropic provider 重构
- 放宽的 Plan 模式（relaxed plan mode）
- StoryNetwork → NarraFlow 重命名 + 全新图组件（DraftNode、LassoSelection、SelectionToolbar）
- 版本更新横幅（VersionUpdateBanner）+ 版本检查 hook
- React Flow 控件样式优化

### Changed
- 缓存断点优化（cache breakpoint optimization）
- i18n 修复（多命名空间）

### Fixed
- 嵌入 wasm 文件支持单可执行文件模式
- tree-sitter 语言加载器 uint8array 支持

## [0.0.3] - 2026-03-08

### Added
- 合并摘要生成与追踪系统
- 合并摘要卡片组件（含创建者信息和合并轮次指示器）
- 取消合并（unmerge）确认对话框
- PowerShell 支持
- 叙述者白名单目录管理（whitelist dirs）
- bash-analyze 增强：包管理器命令过滤、重定向写操作检测
- 合并前收集合并上下文（merge context）
- 语言感知的合并摘要上下文

### Changed
- 跨平台路径工具替换 node:path
- 白名单路径权限语义收紧 + 大小写不敏感去重

### Fixed
- 数据库迁移错误恢复（duplicate column、drizzle wrapped sqlite errors、already-exists）
- 迁移恢复改为实际执行 SQL 而非仅标记 hash
- 取消合并时保留历史合并摘要卡片

## [0.0.2] - 2026-03-07

### Added
- 全局技能管理和例程页面
- 技能集成到斜杠命令菜单
- 章节删除功能（保留对话记录）
- Fork 成功后导航提示
- 叙述者标题回退逻辑改进
- 压缩继承的 compact 标记
- 自适应图边连接点（adaptive edge handles），基于节点位置动态计算
- 命令参数编辑器 UI（CommandParamHelper）
- DiffView/HighlightedCode 使用 shiki 语法高亮
- 取消合并（unmerge）章节功能
- 状态颜色和 i18n 键集中管理
- Windows 兼容性：平台层、终端运行时抽象、跨平台修复
- Windows x64 构建支持
- CLI 端口和主机配置标志
- Git Bash 支持（login-shell wrapping）
- Windows shell 支持（平台感知工具命名）
- 平台检测和文件系统浏览 API
- 文件系统浏览器和目录选择器（DirectoryPicker）
- 图节点内嵌叙述者面板，可直接在节点内对话
- 节点拖拽调整大小（NodeResizeControl），展开状态持久化
- 例程系统（routine-service、builtin-routines、routines 路由 + 前端 UI）
- 版本信息注入 health 接口
- RecentTabs 支持右键/中键关闭
- 故事网络中的章节 fork 弹窗
- 版本系统 + 嵌入式版本生成
- 为 narrator 增加 Fast Mode 配置与持久化
- 为 OpenAI Provider 恢复 `apiMode: "codex"` 选项
- Git 改动列表补充 staged/unstaged 维度的单文件行数统计
- Provider 设置支持 context window 覆盖及 prefix 改名迁移
- RecentTabs 重构：拖拽、并发安全

### Changed
- ExitPlanMode result 不再返回计划全文，添加 prune 保护
- 章节删除逻辑简化
- 默认权限模式改为 acceptEdits，showOutputStats 默认开启
- 统一 Codex 模式 provider 的运行时判定逻辑
- 优化 Git 状态摘要的解析逻辑

### Fixed
- WebSocket 绕过 Vite 代理（Bun node:http 101 升级问题）
- 聊天面板修复
- 通知音效播放修复
- Mantine 主题感知 CSS 变量用于 CommandPopover 选中项
- 图删除后缓存失效
- fresh 继承模式跳过消息 refs 复制
- reasoning encrypted_content 落库与 prune 配对问题
- plan mode 手动切换时的状态一致性
- storyGraph 缓存在章节变更时失效
- 消息块删除传递原始 contentJson 索引
- deleteMessageBlock COW 时复制保留的 tool_calls 并检查跨 narrator 引用
- subagent 缓冲消息保留 parentToolUseId、commandText、createdBy
- useAvatarBlobUrl acquire/release 不对称导致的双重 release
- unmerge 回退到 git revert（当目标分支已前进时）
- unmerge 冲突时中止 revert 并返回有意义的错误
- Windows 上 bash detached 模式禁用
- Windows 上 PATH 环境变量确保设置
- narrator 派生、分叉与 subagent 路径中 fastMode 未正确继承
- Git Changes 面板 staged/unstaged 行数重复显示总改动

## [0.0.1] - 2026-03-06

### Added
- 初始版本：NarraFork AI 协作编程平台
- Phase 1-5 核心功能实现
- 项目设计文档和终端系统（dtach PTY 后端 + xterm.js 前端）
- 章节分叉、合并和批量合并（多客户端同步）
- JWT 认证和用户账户系统
- 容器生命周期管理（安全加固）
- 搜索、MCP、会话、图可视化
- fork-at-message UI、自动休眠调度、批量合并 UI
- 国际化支持（英文 + 简体中文）
- PWA 支持、认证守卫、WebSocket 增强
- 叙述者面板、设置页面、章节 UI
- 收藏路由、项目创建向导
- 叙述者图片支持、子代理树
- 会话管理 UI、项目创建向导
- 数据库归档/待办字段、用户偏好表、FTS trigram 迁移
- 缓冲消息、反馈队列、快速标题、弹性修复
- 内联权限、DiffView、CodeBlockWithActions
- 数据库启动完整性检查、FTS 重建、语言偏好
- 服务端消息树、i18n 提示词、终端 PTY
- SDK Plan 模式支持
- 自定义 Agent Loop 架构（替代 claude-agent-sdk）
- 多提供商支持（Anthropic、OpenAI、内置网关）
- WebSearch 工具
- 多 Token 管理器、模型列表、结构化日志
- 会话分支（conversation branches）→ 重构为 narrator_message_refs
- 子代理（subagent）支持：explore/plan/general 三种类型
- Task 工具、改进的 edit/grep、输出截断
- 章节-叙述者生命周期解耦
- Bash 工具重写（child_process、killTree、流式输出）
- tree-sitter AST bash 命令分析（灾难性命令检测）
- Git 自动提交（AI 生成消息）和 git 状态追踪
- 工具流式输出、耗时计时器
- 章节模式下禁止 git 切换/修改其他分支
- 流式工具执行与增量消息持久化
- AI 驱动的 AskUserQuestion 答案建议
- 子代理 fork/continue、上下文裁剪/压缩、截断处理
- 最近标签页、遗留编码、OpenAI 早期执行、上下文溢出自动压缩
- Phase 6a 章节系统重构基础层
- 章节提交（chapter_commits）提升为一等实体
- WebSocket 心跳（ping/pong）
- 多 OpenAI provider 支持（Responses API 和 Codex 模式）
- 故事网络 UX 改进和提交详情弹窗
- OLED 模式和 PWA 支持
- Git 面板、容器管理、自动提交阈值、在线状态追踪
- sessions→narrators 路由迁移、容器管理重写（rootless podman）
- 项目要求 git 仓库、项目数据库备份、快照系统改进
- 斜杠命令系统（/command 自动补全，用户和项目级别）
- 技能系统、WS 健壮性、企业环境检测、认证加固
- 统一容器代理服务（基于子域名的反向代理）
- Reasoning Effort、Anthropic 和 Codex 支持
- 最近标签页实时状态指示器 + agent loop 网络重试增强
