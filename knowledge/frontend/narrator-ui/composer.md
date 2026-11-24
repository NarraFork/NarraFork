---
id: frontend.narrator-ui.composer
title: 输入框与交互
summary: 输入框、草稿与附件、发送与排队、斜杠控制命令、状态栏控件。
anchors:
  - frontend/components/narrator/composer/*.tsx
  - frontend/components/narrator/composer/*.ts
  - frontend/components/narrator/interaction/use-*
  - frontend/components/narrator/interaction/[!u]*
  - frontend/components/narrator/CreateNarratorModal.tsx
  - frontend/components/narrator/CreateNarratorLazyModal.tsx
  - frontend/components/narrator/ProjectPromptModal.tsx
  - frontend/components/narrator/NarratorInteractionArea.tsx
  - frontend/hooks/useCommands.ts
  - frontend/hooks/useInputHistory.ts
  - frontend/hooks/useInputMenu.ts
  - frontend/hooks/usePromptOptimize.ts
  - frontend/hooks/usePromptOptimizeTask.ts
  - frontend/hooks/useResizableBottomSpacing.ts
  - frontend/lib/composer-append-queue.ts
  - frontend/lib/dashboard-composer-focus.ts
  - frontend/lib/image-actions.ts
  - frontend/lib/prompt-optimize-tasks.ts
  - server/lib/composer-document.ts
  - server/lib/speech-settings.ts
  - server/lib/validators/speech-requests.ts
  - server/lib/validators/speech.ts
  - server/routes/speech.ts
  - server/services/speech/
  - shared/composer-document.ts
  - shared/speech.ts
keywords:
  - NarratorComposer
  - InlineComposerEditor
  - 草稿
  - 排队消息
  - 队列模式
  - queueMode
  - 打断
  - /fork
  - /compact
  - /new
  - 引用选中文本
  - 文件引用
  - narrafork_draft
  - 权限模式
  - 快速模式
  - 新建叙述者
  - QueuedMessagesPanel
  - PendingAgentMessagesPanel
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 输入框与交互

面板底部的输入区：`NarratorInteractionArea` 把排队消息面板、他人 Agent 待处理消息面板、上传进度、状态栏（权限模式/模型/快速模式/反思开关等）和 `NarratorComposerRow` 拼在一起。输入框编辑器内核是基于 ProseMirror（`@tiptap/pm`）的 `InlineComposerEditor`，内容模型是 `@shared/composer-document` 的 `ComposerDocument`。

## 关键规则
- 草稿以服务端为准：`NarratorComposer.tsx` 在输入后防抖 800ms（`INPUT_DRAFT_SYNC_DEBOUNCE_MS`）调 `api.updateNarratorDraft`；超过 `MAX_NARRATOR_DRAFT_CHARS`（200000，`shared/narrator-limits.ts`）直接抛错不同步；账号/叙述者作用域不符或尚未从服务端读到修订号时也抛错。
- 本地镜像（`narrator-draft-storage.ts`）：key 为 `narrafork_draft_<len>:<userId>:<narratorId>`（用户 id 带长度前缀防碰撞），经 session-store 写入；只镜像不超过 `MAX_LOCAL_DRAFT_MIRROR_CHARS`=16000 的草稿，更长的仍同步到服务端但不落本地。本机未同步草稿若落后于服务端，会作为 `staleLocal` 提供给用户选择，不会自动覆盖。
- 未发送附件：图片/文本文件/媒体以 Blob 存 IndexedDB `narrafork-draft-image-attachments`（v3，`draft-image-attachments.ts`）：单文件 ≤20MB，保留 3 天，总量 ≤100MB，记录数 ≤20（中断发送保留的记录 ≤8）；写入同时触发淘汰，读取不续期。
- 可发送判定（`composer-send-gate.ts:hasSendableComposerContent`）：有非空白文本，或有任一附件（图片、文本文件、媒体、文件引用）即可；纯附件草稿是完整一轮。
- 引用选中文本不是独立字段：作为规范 blockquote 存在于输入文本里（`composer-quotes.ts`，预览取前 36 字符），草稿、队列编辑、失败恢复都当普通文本。
- 发送（`interaction/use-narrator-send.ts:handleSendWithMode`）按叙述者状态分支：
  - 空闲：直接发送。
  - 空闲但正在 compact：服务端决定排队；`turn` = 等待，其余模式 = 立即运行。
  - 忙碌且 `turn`：普通队列，等当前一轮结束。
  - 忙碌且 `tool`：优先队列，当前工具调用结束后插入。
  - 忙碌且 `interrupt`：优先队列并立即打断。
  - `QueueMode` 三值定义在 `composer/SendOptionsSplitButton.tsx`；Enter 键绑定的队列行为由 `enterQueueMode` 决定。
- 斜杠控制命令只在文档仅含文本/换行时识别：
  - `/fork`、`/compact`：不进模型输入、不排队，只清文本、保留附件并触发 fork/compact 动作；带文件引用则抛错。
  - `/new [首条消息]`：忙碌时走 `turn` 队列（不打断）；空闲时用当前叙述者的 model/systemPrompt/permissionMode/reasoningEffort/cwd 等创建新叙述者，带文件引用则抛错。
- 排队消息：`queue-message-mode.ts:queuedMessageMode` 取 `queueMode`，缺省时 `priority` 为真则 `tool` 否则 `turn`；拖拽排序只重排 `turn` 项（`moveQueuedTurn`）。
- 停止按钮长按 600ms 才触发打断，提前松开只提示（`use-interrupt-long-press.ts`）。
- Enter 归属（`interaction/enter-ownership.ts`）：输入框、按钮、链接、菜单、对话框、终端等自己的 Enter 不被面板级快捷键（等待中的权限、Enter 回到输入框）抢走；权限按钮条例外（`data-perm-button-bar`）。
- `PendingAgentMessagesPanel`：显示其他 Agent 发给本会话、尚未被任何一轮读取的消息，用户选择恢复或丢弃（失败/被停止的会话不会被 Agent 消息自动重启）。

## 从哪读起
- `composer/NarratorComposer.tsx`（约 2000 行）：草稿同步、附件、发送入口；`composer/InlineComposerEditor.tsx`：编辑器。
- `interaction/use-narrator-send.ts`：发送/排队/控制命令；`use-queued-message-actions.ts`：队列增删改与重排。
- `interaction/use-status-bar-props.tsx`、`use-permission-mode-control.ts`、`use-fast-mode-control.tsx`、`use-model-selection.ts`：状态栏各控件。
- `NarratorInteractionArea.tsx`：区域装配；`CreateNarratorModal.tsx`：新建叙述者表单（预加载见 `CreateNarratorLazyModal.tsx`）。

## 改它时
- 改草稿格式要同步 `INPUT_DRAFT_STORAGE_VERSION` 与旧 key 清理（`cleanupLegacyNarratorInputStorage`）。
- 新增队列模式：`QueueMode`、`queuedMessageMode`、`use-narrator-send.ts` 的分支和服务端接口一起改。
- 改 IndexedDB 附件结构要升 `DB_VERSION`；v1→v2 曾因跨账号读取而丢弃旧库，v3 保留旧库按默认值读取。
- 相关测试：`interaction/use-narrator-send*.test.tsx`、`use-queued-message-actions.test.tsx`、`enter-ownership.test.ts`、`CreateNarratorModal.*.test.tsx`、`draft-attachments-lru.test.ts`。

## 相关
- [工具卡片](tool-cards.md)：权限审批与提问卡片
- [会话外框](session-chrome.md)：模型选择菜单与头部
- [消息列表](message-list.md)
