# 消息角色迁移指南

## 概述

本次迁移将 `narrator_messages.role` 字段从混乱的语义重构为清晰的三角色模型：

- `role: "user"` — 真实用户消息（模型可见）
- `role: "sys"` — 系统注入的上下文消息（模型可见）
- `role: "disp"` — 纯 UI 展示消息（模型不可见）

## 迁移步骤

### 1. 代码已更新

以下文件已经更新以支持新的角色系统：

**后端**:
- `server/db/schema.ts` - 添加 `"sys"` 和 `"disp"` 到 role enum
- `server/services/narrator-service.ts` - 重命名方法和更新实现
  - `persistInfoMessage` → `persistDisplayMessage` (写入 `role: "disp"`)
  - `persistSystemMessage` 改为写入 `role: "sys"` (之前是 `"user"`)
- `server/lib/agent/*-provider.ts` - 更新 `buildHistory` 过滤逻辑

**前端**:
- `frontend/components/narrator/useNarratorPanelWS.ts` - 更新消息类型检查

### 2. 数据迁移（可选但推荐）

如果你的数据库中有现有的 `role='system'` 消息，运行以下命令将它们迁移为 `role='disp'`：

```bash
bun server/db/migrate-role-to-disp.ts
```

这会将所有 `role='system'` 的消息改为 `role='disp'`，使它们不再进入模型上下文。

### 3. 验证迁移

运行测试脚本检查迁移状态：

```bash
bun server/db/test-role-migration.ts
```

这会显示：
- 是否还有旧的 `role='system'` 消息
- 新的 `role='disp'` 和 `role='sys'` 消息数量
- 各角色的消息分布统计

## 行为变化

### 之前

- `persistSystemMessage` 写入 `role: "user"`，模型能看到
- `persistInfoMessage` 写入 `role: "system"`，模型看不到（被过滤）
- 方法名和实际行为不一致

### 之后

- `persistSystemMessage` 写入 `role: "sys"`，模型能看到
- `persistDisplayMessage` 写入 `role: "disp"`，模型看不到（被过滤）
- 方法名和实际行为一致

## 兼容性

- 保留了 `"system"` 在 enum 中，避免旧数据报错
- 如果不执行数据迁移，旧的 `role='system'` 消息仍然会被过滤掉（模型看不到）
- 前端会正确处理所有角色类型

## 后续清理

迁移稳定后（1-2 个版本后），可以：

1. 从 schema 中移除 `"system"` enum 值
2. 删除迁移脚本
3. 添加更多类型安全的 builder 函数
