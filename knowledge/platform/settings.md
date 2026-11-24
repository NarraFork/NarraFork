---
id: platform.settings
title: 设置与数据目录
summary: settings.json 单例、NARRAFORK_HOME 下的目录布局。
anchors:
  - server/lib/settings/
  - server/lib/narrafork-home.ts
  - server/lib/settings-file-lock.ts
  - server/db/connection.ts
  - frontend/components/DataDirectorySecurityAlert.tsx
  - frontend/components/settings/AboutSection.tsx
  - frontend/components/settings/ServerSystemSection.tsx
  - frontend/components/settings/SetupAssistantAuthorizationModal.tsx
  - frontend/components/settings/SetupWizard.tsx
  - frontend/components/settings/TlsSection.tsx
  - frontend/hooks/useInstanceSettings.ts
  - frontend/hooks/useUserPreferences.ts
  - frontend/hooks/useUserPreferencesChangeSync.ts
  - frontend/lib/api/settings.ts
  - frontend/lib/proxy.ts
  - frontend/routes/admin/index.tsx
  - frontend/routes/admin/runtime.tsx
  - frontend/routes/settings.tsx
  - frontend/routes/settings/agent.tsx
  - frontend/routes/settings/index.tsx
  - frontend/routes/settings/proxy.tsx
  - frontend/routes/settings/runtime.tsx
  - frontend/routes/settings/server.tsx
  - frontend/routes/settings/workspace.tsx
  - server/lib/data-directory-security.ts
  - server/lib/installation-id.ts
  - server/lib/settings-address-watcher.ts
  - server/lib/settings-file-watcher.ts
  - server/lib/settings-manager-fields.ts
  - server/lib/tls.ts
  - server/lib/validators/settings.ts
  - server/routes/data-directory-security.ts
  - server/services/user-preferences-service.ts
  - shared/data-directory-security.ts
  - shared/proxy-settings.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 设置与数据目录

所有后端代码通过 `settings` 单例读取配置；配置持久化在数据目录下的 `settings.json`，数据目录由 `NARRAFORK_HOME` 决定。

## 关键规则
- 数据目录：`NARRAFORK_HOME` 环境变量（trim 后非空）否则 `~/.narrafork`；每次调用时读取，便于测试预加载覆盖。`getNarraforkPath(...segments)` 在其下拼路径（`server/lib/narrafork-home.ts`）。
- 目录内容（由代码里的 `getNarraforkPath` 调用可见，非完整清单）：`settings.json`、`narrafork.db`（`db/connection.ts:getDbPath`）、`provider-keys.json`、`plugins/`、`uploads/`、`tls/`、`updates/`、`tree-snapshots/`、`file-change-blobs/`、`worktree-requests/`、`restart-recovery.json`、`db-integrity-state.json`、`fts-repair.json` 等。
- `settings` 是模块加载时同步读取的单例（`server/lib/settings/index.ts:settings`）；因此 `serve.ts` 在 try 内才 import 它，settings.json 不可读会变成启动问题（`settingsUnreadable`）而非裸异常。
- 加载：`DEFAULTS`（`settings/defaults.ts`）与文件内容 `deepMerge`；文件不存在则以默认值创建（权限 0600，目录 0700，win32 除外）。允许 JSONC（注释、尾逗号），下次保存会改写为纯 JSON（`parseSettingsText`）。加载中包含大量旧键迁移与废弃键清理（`stripObsoleteSettingsKeys`）。
- 保存 `saveSettings`：先校验保留策略等并规范化，再在 `withSettingsFileLock`（`settings.lock` 目录锁，等待 2 秒、15 秒视为陈旧）内「写临时文件再 rename」；保存时保留管理器面板单独改过的字段（`preserveExternalManagerFields`）。写完后把新值原地覆盖到单例上并递增 `getSettingsRevision()`、通知 `subscribeSettingsChanges` 的监听者。
- 提供商密钥不落在 settings.json：保存时由 `withoutProviderKeys` 剥离，存入独立密钥库并在加载时回灌（`provider-keys-projection.ts`、`syncProviderKeys`/`hydrateProviderKeys`）；搜索头部密钥同理（`search-header-secrets.ts`）。
- 热重载：`reloadSettings` 全有或全无——文件无效时保留运行中配置并记错误；`reloadSettingsIfChanged` 用上次读写的文本比较，跳过自己刚写的内容。
- 密钥文件是否加密跟随 `secrets.encrypt`，变更时重写（`settings/index.ts` 监听器）。

## 从哪读起
- `server/lib/settings/index.ts`：加载、迁移、保存、单例。
- `server/lib/settings/defaults.ts`：默认值与 `SETTING_DOCS`。
- `server/lib/settings/types.ts`：`NarraForkSettings` 类型。
- `server/lib/narrafork-home.ts`：数据目录解析。

## 相关
- [启动与进程](boot.md)
