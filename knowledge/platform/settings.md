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
  - frontend/hooks/useRuntimeSettings.ts
  - frontend/hooks/useUpdateRuntimeSettings.ts
  - frontend/hooks/useRuntimeProjectionSync.ts
  - shared/settings-runtime.ts
  - server/routes/user-preferences.ts
  - frontend/hooks/useUserPreferences.ts
  - frontend/hooks/useUserPreferencesChangeSync.ts
  - frontend/lib/api/settings.ts
  - frontend/routes/admin/index.tsx
  - frontend/routes/admin/runtime.tsx
  - frontend/routes/settings.tsx
  - frontend/routes/settings/agent.tsx
  - frontend/routes/settings/index.tsx
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
  - shared/data-directory-security.ts
  - server/routes/settings.ts
  - server/lib/__tests__/settings-docs.test.ts
  - server/lib/__tests__/settings-file-lock.test.ts
  - server/lib/__tests__/settings-manager-fields.test.ts
  - server/lib/__tests__/settings-address-watcher.test.ts
  - server/lib/__tests__/tls.test.ts
  - server/routes/__tests__/tls-routes.test.ts
  - server/routes/__tests__/data-directory-security.test.ts
keywords:
  - 设置页
  - settings.json
  - NARRAFORK_HOME
  - /api/settings
  - /api/settings/tls
  - /api/settings/data-directory-security
  - /api/user-preferences
  - SETTING_DOCS
  - saveSettings
  - reloadSettings
  - withSettingsFileLock
  - settingsUpdateLock
  - 数据目录权限
  - 用户偏好
  - 设置向导
  - setupWizardCompleted
  - HTTPS 证书
  - autoReissue
  - installationId
  - UPDATE_SOURCE_CHANGED
status: draft
verified_at: 4d69bf50aa11b8bfaf6cc4a12a71f118ace320d2
---
# 设置与数据目录

所有后端代码通过 `settings` 单例读取配置；配置持久化在数据目录下的 `settings.json`，数据目录由 `NARRAFORK_HOME` 决定。

## 关键规则
- 数据目录：`NARRAFORK_HOME` 环境变量（trim 后非空）否则 `~/.narrafork`；每次调用时读取，便于测试预加载覆盖。`getNarraforkPath(...segments)` 在其下拼路径（`server/lib/narrafork-home.ts`）。
- 目录内容（由代码里的 `getNarraforkPath` 调用可见，非完整清单）：`settings.json`、`narrafork.db`（`db/connection.ts:getDbPath`）、`provider-keys.json`、`plugins/`、`uploads/`、`tls/`、`updates/`、`tree-snapshots/`、`file-change-blobs/`、`worktree-requests/`、`restart-recovery.json`、`db-integrity-state.json`、`fts-repair.json` 等。
- `settings` 是模块加载时同步读取的单例（`server/lib/settings/index.ts:settings`）；因此 `serve.ts` 在 try 内才 import 它，settings.json 不可读会变成启动问题（`settingsUnreadable`）而非裸异常。
- 加载：`DEFAULTS`（`settings/defaults.ts`）与文件内容 `deepMerge`；文件不存在则以默认值创建（权限 0600，目录 0700，win32 除外）。允许 JSONC（注释、尾逗号），下次保存会改写为纯 JSON（`parseSettingsText`）。加载中包含大量旧键迁移与废弃键清理（`stripObsoleteSettingsKeys`）。
- 保存 `saveSettings`：先校验保留策略等并规范化，再在 `withSettingsFileLock`（`settings.lock` 目录锁，等待 2 秒、15 秒视为陈旧）内「写临时文件再 rename」；保存时保留管理器面板单独改过的字段（`preserveExternalManagerFields`）。写完后把新值原地覆盖到单例上并递增 `getSettingsRevision()`、通知 `subscribeSettingsChanges` 的监听者。
- 实例设置与用户偏好是两套：`settings` 是整个实例共享的状态，只有管理员能 `PATCH /api/settings`（`settingsUpdateLock` 串行化，先 `updateSettingsSchema` 校验，`expectedUpdateSettingsKey` 与当前更新源不符返回 409 `UPDATE_SOURCE_CHANGED`）；`GET /api/settings` 对管理员与普通用户返回不同视图（`buildSettingsResponse(settings, { admin })`）。每个用户自己的偏好在 `user_preferences` 表，经 `/api/user-preferences`（`routes/user-preferences.ts`，校验在 `validators/settings.ts:updateUserPreferencesSchema`），前端 `useUserPreferences` 读写，`user_preferences:changed` 事件 → WS `user_preferences_changed` → `useUserPreferencesChangeSync` 让各标签页失效重取。
- 会话 UI 用 `GET /api/settings/runtime`：`settings/runtime.ts:buildRuntimeSettings` 从配置与只读运行时事实直接白名单构造（模型标识、reasoning/反思/压缩/提醒参数、outline、requestEvidence、revision），响应上限 8 KiB，不调用完整 `buildSettingsResponse`，不带 providers、prompt、密钥/头部、完整模型目录或额度图。管理员额外得到小型更新源与 `updateSettingsKey`；`PATCH /api/settings?view=runtime` 保持原管理员写入与冲突前置条件，只改变返回视图。
- runtime 的 `summaryModelAvailable` 是纯只读三态：缓存配置可证为 true/false，未观察的 auto/未固定聚合/插件等返回 null，不调用执行 resolver 或以候选首项推导就绪；只有明确 false 才强制摘要模型设置。设置/插件等变化通过小型 revision 标记失效，未知不伪装成失败（`settings/runtime-readiness.ts`）。
- `/api/user-preferences` 读偏好行走读 Worker（`prefsRead`：`worker-required`、带请求 signal、`maxRows: 1`，不回退主线程）；所有写合并 JSON 列的路由（完整 PATCH、`graph-viewports`、`plugin-overlays`、Spec 布局等）都持 `userPreferencesLock`，锁内读到的值不会被别的写覆盖（`routes/user-preferences.ts`）。
- 用户 UI 偏好用 `GET/PATCH /api/user-preferences/ui`（本地兼容 `?view=ui`）：路由最先分支，SQL 显式选 UI 列，不读取整行或 legacy tabs/enrichTabs；白名单包含外观/语言/输入队列/通知开关/导航与工具栏，排除命令正文、网关、webhook/secret、全会话 Spec 布局与日报。实际合并 DTO 写前校验，读写响应预算 64 KiB；完整编辑接口保留。
- 前端 `useUserPreferences` 使用独立 `[user-preferences, ui, userId, authGeneration]` 与 30 秒 stale；完整编辑页用 `useUserPreferencesDetail/useUpdateUserPreferencesDetail`，瘦 DTO 不写进完整缓存，未载入字段不靠默认值保存。认证代际变化取消并移除旧偏好/身份查询；账户偏好事件使 UI/detail/当前 Spec 布局一起失效。runtime 用独立 `[settings-runtime, authGeneration]`（30 秒 stale/60 秒 GC），更新成功只写该瘦缓存；鉴权外壳的 `useRuntimeProjectionSync` 接 settings/catalog 标记与重连失效，换认证取消旧读并移除旧 runtime/options，关闭菜单不因失效发 GET。缓存键及单飞身份只包含非秘密代际，不序列化原始凭据。
- WS 首连仅给已登录非公开分享发送 `settings_runtime_changed {revision,initial:true}`；`useRuntimeProjectionSync` 把 initial revision 当待核对下界，无数据/HTTP 在途时先等该 GET 完成，同版不强制第二 GET，落后才补读。普通 settings/catalog 标记合并 burst，一批取消旧初读，读中变更补尾读；旧 token 的 runtime/settings/options 不参与失效。真实 reconnect 调 `resetEpoch` 清最高 revision/initial 下界与待刷标记，并用 epoch fence 退休旧队列和在途后续动作；新进程 revision 可从 100 降至 0 后继续接受 1，不能沿用旧高水位压掉新配置（`useModelCatalog.runtime.test.tsx`）。
- 单会话 Spec 布局 `GET /api/user-preferences/spec-tab-layout?narratorId=` 在 SQL `json_extract` 只取该 key，PATCH 在用户锁内用 `json_set` 原位合并，不把历史大 map 带到 JS；路径用 JSON 编码保留 id 的字面含义。前端缓存按认证代际/user/narrator 隔离，保持串行保存最新布局；更多见[会话外框](../frontend/narrator-ui/session-chrome.md)。
- 设置向导是否完成存在 `settings.setupWizardCompleted`；首次读取时若为空，从 `user_preferences.setup_wizard_completed` 迁移并写回，之后不再扫库（`routes/user-preferences.ts:instanceSetupWizardCompleted`）。向导步骤 `WIZARD_STEPS = provider → basic → deps → network → complete`（`frontend/components/settings/SetupWizard.tsx`）。
- 外部直接改 `settings.json`（管理器面板、手工编辑）的两条生效通道：`settings-file-watcher.ts` 监听数据目录（不是文件，因为保存是原子 rename）并重载配置；`settings-address-watcher.ts` 比较监听地址与当前运行配置，不一致才触发 HTTP 监听器热重绑，避免 PATCH 保存的同一次变更重绑两次。管理器面板写的字段（监听地址、品牌等）在服务自己保存时由 `settings-manager-fields.ts:preserveExternalManagerFields` 保留，只有服务自己没改过该字段时才保留磁盘值。
- 数据目录安全检查：`inspectApplicationDataDirectory` 沿祖先链（≤128 层）检查权限与属主，预算 5 秒；超预算报 `unknown` 而不是权限错误；`GET /api/settings/data-directory-security`（管理员得完整路径，其他人得精简视图）；`POST /api/settings/data-directory-security/repair` 仅管理员、要求 `{ confirmed: true }`、不接受路径参数、请求体 ≤1KB，且每次都按数据库里的当前角色重新授权；非 Windows 且仅叶子目录权限问题才可自动修复（`lib/data-directory-security.ts`、`routes/data-directory-security.ts`）。同一检查也用于写入准入（`requireApplicationDataDirectory`）。
- 内置 HTTPS：证书和 CA 放在 `tls/`；`reissueBuiltinTlsOnStartup` 在绑定 HTTPS 之前执行，只处理内置证书（路径、CA 签发关系都吻合、无口令），在 SAN 变化、有效期超过 825 天或剩余不足 30 天时重签叶子证书且保留 CA；外部证书和 CA 绝不动（`lib/tls.ts`）。自定义 SAN 最多 `MAX_CUSTOM_SANS = 50`。管理接口在 `/api/settings/tls`（状态、SAN、生成、重建 CA、下载 `ca.pem`，`routes/tls.ts`），前端 `TlsSection`。
- `installationId`/`claudeDeviceId` 存在 settings 的 `clientFingerprint` 下，首次访问时惰性生成，`regenerateInstallationId` 可轮换（`lib/installation-id.ts`）。
- 前端设置页：`/settings` 布局（`routes/settings.tsx`）里 `useInstanceSettings` 持有整份实例设置草稿并经 Context 分发给各子页（`settings/agent|server|…`），保存走 `settingsApi.updateSettings`（`lib/api/settings.ts`）；`/admin` 与 `/admin/runtime` 只是重定向到 `/settings/providers`、`/settings/runtime`；非管理员访问管理员页面被重定向到 `/settings/profile`。
- 提供商密钥不落在 settings.json：保存时由 `withoutProviderKeys` 剥离，存入独立密钥库并在加载时回灌（`provider-keys-projection.ts`、`syncProviderKeys`/`hydrateProviderKeys`）；搜索头部密钥同理（`search-header-secrets.ts`）。
- 热重载：`reloadSettings` 全有或全无——文件无效时保留运行中配置并记错误；`reloadSettingsIfChanged` 用上次读写的文本比较，跳过自己刚写的内容。
- 密钥文件是否加密跟随 `secrets.encrypt`，变更时重写（`settings/index.ts` 监听器）。

## 从哪读起
- `server/lib/settings/index.ts`：加载、迁移、保存、单例。
- `server/lib/settings/defaults.ts`：默认值与 `SETTING_DOCS`。
- `server/lib/settings/types.ts`：`NarraForkSettings` 类型。
- `server/lib/narrafork-home.ts`：数据目录解析。

## 改它时
- 改轻投影：`frontend/lib/api/settings.test.ts`、`tests/server/routes/user-preferences.test.ts` 与 `useUserPreferencesChangeSync.test.tsx` 覆盖预算、源头白名单、单 Spec JSON 点读/原位写、身份切换与 UI/detail 分离；不得用瘦缓存默认值回写未加载字段。runtime/model 的三态/不路由测试见[模型目录](../agent/model-catalog/catalog.md)。
- 新增设置项：`settings/types.ts`（类型）、`settings/defaults.ts`（默认值 + `SETTING_DOCS` 文档，`settings-docs.test.ts` 要求每个可编辑叶子都有文档，缺了会失败）、`routes/settings.ts` 的 `updateSettingsSchema`（管理员可写才加）、`useInstanceSettings` 与对应设置页；废弃旧键放进 `stripObsoleteSettingsKeys`。
- 新增会落盘的敏感值：必须像提供商密钥那样在保存时剥离、走独立密钥库，不要留在 `settings.json`。
- 改保存流程：`settings-file-lock.test.ts`（目录锁）、`settings-manager-fields.test.ts`（保留管理器字段）、`settings-address-watcher.test.ts`；保存必须保持「写临时文件再 rename」，否则两个 watcher 都会失效（它们监听目录）。
- 改 TLS：`tls.test.ts`、`routes/__tests__/tls-routes.test.ts`；证书有效期不得超过 825 天（Safari 会拒绝）。
- 改数据目录检查：`routes/__tests__/data-directory-security.test.ts`；`unknown` 状态不得被呈现为权限问题。
- 代理设置的专门规则见 [出站网络与代理](network.md)。

## 相关
- [启动与进程](boot.md)
- [出站网络与代理](network.md)：`settings.proxy` 与前端代理页。
