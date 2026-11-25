# PR 标题

feat(plugins): 额度查询插件化、可选来源更新与原版升级兼容

# PR 正文

## 摘要

将 Custom API 提供商的额度查询从宿主厂商实现迁到独立、可安装和可卸载的 `io.narrafork.provider-quota@1.0.3`；增加插件的可选来源元数据、显式检查/更新和内置包重装。保留原版用户的配置、凭据及启停、撤权、卸载决定，不通过更换插件 ID 绕过授权。

功能提交为 `2a8042ea838039c0373aec7aa0cfe82faae1b8ca`，基于 `7a77c8306ac68d10ed1e09e6619ef14dfac3f935`。本轮后续变更补齐原版到候选版的真实升级验收、可复现脚本及说明；不改生产数据库结构，也不改变主程序发布版本。

> 本地验收只覆盖上述固定基准及候选，不表示已整合浮动 `main` 的所有后续提交。交付前只读核对的 `main` 为 `35942c331661e92be2253f55b4e68e33bf1a5803`，相对验收基准前进 745 个提交。未自动合并这些变更；合并前仍须审查与当前目标的交叉差异并运行 CI。

## 背景与目标

原版额度路径与宿主实现耦合，插件分发和更新缺乏可验证的统一流程；同时，单纯在新程序中安装、卸载和重启并不能证明原版用户能升级。

本 PR 要达成：

1. 厂商协议属于独立额度插件，宿主只提供有界的授权连接和规范化额度读接口。
2. 老插件未声明来源时继续兼容，不会因新字段而强制联网或失去安装、配置和使用能力。
3. 更新候选绑定包和安装身份，保留用户选源、授权和禁用决定。
4. 实际启动未修改的原版程序，再让候选程序使用同一份数据，验证无需重新注册、登录或填写 Key。

## 主要变更

### 独立额度插件与统一展示

- 将 DeepSeek、Kimi Coding、OpenCode Go、Sub2API / New API 的 Key 额度及 New API 站点账户查询放入独立归档。
- 通过 `quotaSources` 贡献额度，不暴露为 Agent tool，不注册额外模型或 provider。
- 新增统一额度快照、分页读接口和变更提示；兼容旧余额读入口，避免存在第二条绕过插件权限的查询路径。
- 区分 summary/detail、required/alternative/none、实际零、未知、无限额、过期及来源不可用。账户更换、撤权或卸载时不保留属于旧身份的额度。
- 金额摘要不叠加不同币种，细项不重复参与额度判断；窗口和到期由统一面板展示。

### 来源与更新

- 可选 `plugin-source.json` 支持 GitHub Release、网站 API、可信本地来源。
- 未声明 homepage 时不把仓库地址、发布者文本或 API 地址猜成可点击主页。
- 手动检查、候选确认、安装进度和取消各有状态；自动更新默认关闭，权限或信任变化转为人工确认。
- 旧包无来源仍可安装和运行，已安装包缺来源不等于插件失效。
- 内置额度归档是普通包，用户可卸载并显式重装；卸载或撤权不被后台更新恢复。

### 授权、凭据和生命周期

- 原始 API Key、站点令牌和用户 ID 留在宿主，插件使用短期连接引用；查询绑定 provider、Key/账户、配置、runtime、包及 grant 代次。
- 站点账户只访问保存根下的 `/api/user/self`，不携带推理自定义认证头，不把站点令牌加入推理 Key 池。
- 旧拆分设置客户端在同一身份改名时保留其无法表达的站点配置；统一客户端更换站点、账户或明确清空时不复用原令牌。
- 包解压、摘要和信任核验保留 Worker 隔离，不通过主线程 fallback 绕过故障。
- 发布归档和内容寻址缓存不共享可变文件；冻结构建的归档与元数据一致。
- 停止接收新工作与实际退出分开。来源写入、RPC 迟到工作和审计未结束时仍保留所有权，不提前交实例锁。

## 原版升级：真实成品验收

### 方法

用 Bun 1.4.3 分别构建未修改的原版 `7a77c8306` 和候选 `2a8042ea8`。两者宿主版本均为 0.9.15，但内嵌 commit 和程序摘要不同；测试从不只凭版本号认定升级成功。

每个场景在独占 HOME、SQLite 和回环端口启动原版，使用真实 API 创建数据。原版优雅关闭后只替换测试运行目录的程序文件，不复制数据库、不手写插件状态、不重新录入 Key。随后启动候选并再次正常重启。

### 验收矩阵

| 原版选择 | 升级后及第二次启动 | 通过检查数 |
| --- | --- | ---: |
| 已启用 | 新额度包可运行；旧账户、会话、模型及 Key 继续可用 | 16 |
| 已停用 | 不安装替代插件，不发出额度请求 | 9 |
| 已撤权 | 不因新 ID 恢复授权，不展示旧缓存 | 9 |
| 已卸载 | 通过旧安装 authority 的撤销记录保留拒绝，不擅自恢复 | 9 |

43 项全部通过。12 次服务启动最终均观察到正常退出码 0 和关闭句柄，四个隔离数据目录清理成功。专用 Edge 在测试结束后受控退出，没有操作正在承载会话的服务。

具体断言包括：

- SQLite 的文件身份未变化；旧登录 token 继续有效。
- 账户 ID、中文偏好、会话 ID/标题/模型、默认模型保留。
- 两个推理 Key 的 ID、顺序、禁用标记保留；独立站点配置仍能查询。
- 新安装身份与旧安装不同，新的 grant 不是旧 grant 的复制；仅含预期的两项 system 默认能力。
- 测试上游钱包从 USD 31.27 改为 USD 42.56，以实际新 HTTP 调用和快照校验排除旧缓存假通过。
- 证据浏览器页只在原版建立登录，候选阶段不注入 token、不由测试清缓存。核对它实际加载新版入口并显示新额度。
- 停用、撤权、卸载场景的快照为 unavailable，无数据、无来源，且没有新增上游额度 HTTP。

旧版尚无新的卸载 tombstone；真实“已卸载”场景由其 revoked 安装 authority 继承为拒绝，不要求旧数据具有新格式。

## 本轮交付文件

- [升级探针](../../scripts/smoke-provider-quota-upgrade.ts)：接收两份带 sidecar 的成品；校验实际健康身份、优雅关停、文件归属、同库迁移和浏览器前端版本。
- [探针契约测试](../../tests/scripts/smoke-provider-quota-upgrade.test.ts)：输入、ready 状态、文件身份、独立授权、升级页不重新注入登录。
- [通用冒烟](../../scripts/smoke-provider-quota.ts)：增加 `seedSession: false`，只供升级证据页使用，原有调用默认行为不变。
- `.gitignore` 显式纳入新脚本，避免干净克隆遗漏测试依赖。
- [详细验收说明](13-quota-plugin-main-integration-plan.md)：成品身份、复现命令、非通过记录和验证边界。

## 验证情况

| 检查 | 实际结果 |
| --- | --- |
| 本轮迁移、来源、余额路由、真实插件 E2E、额度 view 和来源 UI，6 个完整文件，`--isolate` | 274 pass / 0 fail；2,085 条断言 |
| 升级探针与通用冒烟契约，2 个完整文件，`--isolate` | 22 pass / 0 fail；188 条断言 |
| 原版成品 → 候选成品的四场景原地升级 | 43/43，四份报告 `finalAcceptance=true` |
| 本轮候选成品额度完整冒烟 | 56/56，真实 Edge，清理通过 |
| 本轮候选成品来源更新完整冒烟 | 12/12，真实 Edge，清理通过 |
| 改动的 TS 脚本及测试 Biome | 通过 |
| 功能候选的 Git 交付字节全仓 Biome | 7,329 文件，0 error，552 warning，5 info |
| 独立额度插件类型检查 | 已通过 |
| 宿主整仓 TypeScript | **未完成**：整仓超时，分批与单根保留共享声明探针内存不足，0/21 批通过 |
| 全仓测试、其他平台及 PostgreSQL 升级 | 未在本地运行，交给相应 CI / 专项验收 |

套件有交叉覆盖，不把以上行相加为一个没有重复的通过总数。部分隔离测试在退出时有临时 HOME 的 EBUSY 告警，真实成品的进程关闭和清理有独立证据。

维护者明确允许本次本地提交不等待宿主类型检查。这不是类型通过结论，不删除、屏蔽或放宽 CI 的任何检查。

### 复现

```sh
bun test --isolate \
  tests/server/services/plugin-manager.test.ts \
  server/services/__tests__/plugin-source-service.test.ts \
  server/routes/__tests__/provider-balances.test.ts \
  tests/server/integration/plugins/plugin-provider-quota.e2e.test.ts \
  frontend/components/narrator/model/provider-quota-view.test.ts \
  frontend/components/plugins/PluginSourceUpdatesPanel.test.tsx

bun test --isolate \
  tests/scripts/smoke-provider-quota-upgrade.test.ts \
  tests/scripts/smoke-provider-quota.test.ts

bun scripts/smoke-provider-quota-upgrade.ts \
  --binary="/path/to/original.exe" \
  --candidate="/path/to/candidate.exe" \
  --archive="/path/to/provider-quota.nfplugin" \
  --out="/existing/evidence/new-run" \
  --browser="/path/to/chrome-or-edge"
```

原生脚本的每个成品须有同名 `.metadata.json`，输出父目录已存在、输出目录尚不存在。每场景最长 8 分钟；只接受自己的进程和测试文件，资源超限、恢复失败或清理失败均不能通过。

## 截图说明

截图均由真实 Edge 与测试账户生成，凭据字段未明文展示，地址均为测试回环服务。交付附图：

1. `01-original-wallet.png`：原版站点钱包 USD 31.27。
2. `02-upgraded-plugin.png`：候选 `io.narrafork.provider-quota@1.0.3` 正常运行。
3. `03-upgraded-wallet.png`：同一账户升级后的实时钱包 USD 42.56。
4. `website-update-en.png`：无来源的旧格式示例插件绑定网站来源后，通过真实 UI 更新到 1.0.2，仍保持运行及原授权。

图片通过独立附件交付，不把测试 HOME、原数据库、日志或大二进制提交进仓库，也不将临时下载 URL 固化到长期文档。

## 风险与范围限制

- **已证明无需重新配置的数据就地升级，不代表所有历史版本都能全自动更新。** 本轮不调用发布、上传、自动下载或生产管理器替换流程。
- 同一 0.9.15 版本本身不构成自动更新候选，正式发布仍需正常版本提升和元数据。
- Windows 0.9.13 / 0.9.14 的旧管理器首次升级可能需要手动启动新 exe，见 [发布说明](../RELEASE.md#windows-管理器更新交接)。不能用本次手动替换测试掩盖这一历史限制。
- 旧目录式插件在无系统 Bun 的原版环境有 hello 超时；旧余额由原版宿主查询路径实际验证，本验收不声称旧 runtime 无故障。
- 启用测试使用 `--no-auto-resume`；不声称验证活动 Agent 的自动续跑、迁移后数据库降级或断电回滚。
- 新类型或平台回归仍可能由 CI 暴露；不得把 local commit 或运行测试等同于合并批准。

## 合并与发布前清单

- [x] 复审额度与来源边界、凭据和用户选择继承。
- [x] 运行本轮变更相关的隔离回归。
- [x] 用真正的原版与候选成品验证四种原地升级场景。
- [x] 校验并分享不含明文凭据的升级截图。
- [ ] 目标分支的完整类型检查和测试 CI 通过。
- [ ] 若目标 `main` 已前进，重新检查冲突和交叉修改，不沿用固定旧基准的合并结论。
- [ ] 正式发布时按现有流程生成更高版本的成品、可信元数据和各平台验收记录。
