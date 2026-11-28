# 可选插件来源与更新

## 兼容边界

来源是独立的可选分发元数据，不是 Manifest 必填项，不改变 Manifest v1、`narrafork.rpc/1` 或宿主 Host API 的原有版本维护机制。旧插件无需新增字段，仍可安装、启用、配置、运行和手动上传升级。缺失来源文件表示没有来源；损坏或错配的来源只产生来源诊断，不使有效插件无法运行。

插件根目录可附带 `plugin-source.json`：

```json
{
  "schemaVersion": 1,
  "pluginId": "io.example.plugin",
  "source": {
    "type": "website",
    "updateApi": "https://plugins.example/v1/plugins/io.example.plugin/latest",
    "homepage": "https://example.com/plugins"
  }
}
```

`homepage` 可不填写。未设置时插件名称是普通文字，不从 GitHub 仓库、发布者网址或 API 地址猜测链接；有效主页使用安全 HTTP(S) 外链打开。来源文件最大 16 KiB，只接受有界普通文件，严格验证 UTF-8、身份、字段和路径。

三种来源：

- `github`：`owner`、`repo`、`assetName`（允许 `{version}` 模板），可选 `metadataAsset`、`checksumAsset`、`homepage`。使用公开稳定 Release，不借用 NF 登录或平台凭据。包摘要来自 Release asset digest 或同次发行的校验资产；缺少可验证摘要不能自动更新。
- `website`：`updateApi`，可选 `downloadOrigins`、`homepage`；默认只允许同来源 origin 下载，显式 CDN origin 最多 8 个。非回环 HTTP 必须明确批准，不能自动更新。
- `local`：宿主可信目录中的 `builtinId`，可选 `homepage`。不是任意磁盘目录扫描，也不能凭外部包的声明冒认内置身份。

管理员可覆盖或清除包声明的来源；绑定具有 revision。自动更新默认关闭。升级保留既有来源和用户选择，新包不能偷偷换源或打开自动更新。无来源时检查/来源更新不可用，旧上传安装流程不受影响。

## 网站更新协议

客户端调用 `GET updateApi`，可附加 `pluginId`、`currentVersion`、`hostVersion`、原版本维护机制给出的 `hostApiVersion`、`os`、`arch`、`channel=stable`。这些值不是凭据，不携带平台令牌。服务器返回：

```json
{
  "schemaVersion": 1,
  "pluginId": "io.example.plugin",
  "latest": {
    "version": "1.2.3",
    "publishedAt": "2026-11-14T00:00:00Z",
    "artifact": {
      "url": "https://plugins.example/assets/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.nfplugin",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "size": 123456
    },
    "compatibility": { "hostApi": ">=1.0 <2", "os": ["win32", "linux", "darwin"], "arch": ["x64", "arm64"] },
    "notes": "普通文字更新说明"
  }
}
```

`latest:null` 表示无发行版；不使用远端的 `updateAvailable` 布尔值。版本由 NF 自行比较，拒绝降级、非法 SemVer、ID 错配、错误摘要/大小、危险 URL/重定向和不兼容包。完整契约在 [shared/plugin-source.ts](../../shared/plugin-source.ts)。响应最大 64 KiB，说明最多 4096 字符，原 archive 最大 100 MiB。原 ZIP SHA-256 与 PackageStore 的解包内容 hash 是不同身份层，不能混用。

SHA-256 证明下载完整性，不证明发布者身份。HTTPS/hash 不替代 `signature.json`、受信 keyring 或宿主 SBOM/签名策略；来源服务不得降低宿主已有信任要求。

## 可部署的参考服务

参考实现是独立的 Bun/Hono 程序，不挂载到 NF 当前进程。只从显式的**公开发行目录**提供上述接口与内容寻址下载。目录必须有 `public-plugin-source.json` 标识；发布器只初始化新的/空的目录，拒绝把非空配置或安装目录当成公开源。

先构建插件归档，再发布（参数均为 `--key=value`）：

```sh
bun scripts/publish-plugin-source.ts --archive="plugins/provider-quota/dist/provider-quota.nfplugin" --root=".narrafork/public-plugin-feed" --plugin-id=io.narrafork.provider-quota --origin=http://127.0.0.1:8910
bun scripts/plugin-source-server.ts --root=".narrafork/public-plugin-feed" --port=8910
```

随后可以将网站来源设为 `http://127.0.0.1:8910/v1/plugins/io.narrafork.provider-quota/latest`，并显式勾选「允许 HTTP 手动操作」（`allowInsecureHttp:true`）；HTTP 不允许自动更新。回环 HTTP 仅用于本机/隔离测试；公开部署用 HTTPS 反向代理，例如：

```sh
bun scripts/plugin-source-server.ts --root="/srv/public-plugin-feed" --host=0.0.0.0 --port=8910 --origin=https://plugins.example
```

`/srv` 等父目录需由操作员预先创建。公共 origin 必须明确配置，不信任请求 `Host` 生成包地址；服务器不提供目录列表、任意文件读取或写入 API。下载只接受 SHA-256 文件名，按固定大小流式返回，响应有取消和 120 秒期限；反向代理应再配置请求速率/并发限制。所有路径、链接、文件身份、大小和 JSON 读取都有边界。

发布器在专属子进程中执行 ZIP/Manifest/入口/包内容检查、摘要、SBOM 和可选签名验证，不执行插件代码或安装脚本；不存在主线程计算回退。子进程最长 120 秒，stdout/stderr 各最多 32 KiB，临时安装目录独占，不使用 NF 用户数据库。解包额外收紧为 128 MiB/10000 文件。

签名包需要显式公开 keyring 文件；启用强制签名可追加 `--require-signature=true --keyring="/private/plugin-public-keys.json"`。keyring 是有界的公开键数组：`[{"keyId":"publisher-1","publicKey":"-----BEGIN PUBLIC KEY-----...","pluginIds":["io.example.plugin"]}]`；允许 `revokedAt`，拒绝私钥。签名身份、完整性和信任都验证，不能用包自带公钥作为信任根。

发行目录形状：

```text
public-plugin-source.json
assets/<archive-sha256>.nfplugin
plugins/<pluginId>/latest.json
```

包先静态验证，再不可覆盖地发布内容寻址资产，最后原子替换 `latest.json`。同版本不同内容和 stable 降级拒绝，失败保留旧 latest。每个插件有独占发布锁；进程崩溃遗留锁不自动抢占，操作员确认生产者停止后再处理。没有 `plugin-source.json` 的旧包也可以发布。

实现入口：[server/lib/plugins/source-feed.ts](../../server/lib/plugins/source-feed.ts)、[scripts/publish-plugin-source.ts](../../scripts/publish-plugin-source.ts)、[scripts/plugin-source-server.ts](../../scripts/plugin-source-server.ts)。真实发布与 HTTP 回归见 [tests/scripts/plugin-source-reference.test.ts](../../tests/scripts/plugin-source-reference.test.ts)。

## 更新生命周期和内置额度插件

更新候选绑定稳定安装身份、当前包、来源 revision 和过期时间；客户端不能提交任意下载 URL/hash。下载、包校验、权限判断完成前旧插件不动。正常更新保留权限、配置、安装身份和启停选择；新增权限或 runner/信任变化转管理员确认，不自动授权。提交前可取消，提交后返回实际结果；切换或激活失败恢复旧版本和状态。来源修改/清除、卸载使旧候选失效，自动任务不能重装已卸载插件。

关闭更新服务时先同步阻止新调度并取消仍可取消的任务；已越过提交边界的工作继续由原 owner 等待实际结果。关闭有 125 秒总预算，超时、Worker 退出未确认或摘要落盘失败会显式令关闭步骤失败，不伪报成功、不释放尚未退出资源的并发槽；重复 stop 返回同一 Promise。哈希/包处理仅由隔离 Worker 执行，Worker 故障不会触发宿主主线程重算。

`io.narrafork.provider-quota` 是本地内置来源的**普通可安装包**，不是旧只读 builtin 目录。首次默认安装启用，禁用/卸载/撤权记忆在重启后保留。插件页的内置目录可直接重新安装，无需寻找归档；此显式操作仍经过包验证和正常权限生命周期。当前随附版本为 `1.0.3`，可选 local 来源不设置主页。

NF 升级后，本地来源检查只采用当前程序携带的可信 descriptor 版本，不扫描随意磁盘路径，不自动降级用户安装的较新版本。自动更新仍默认关闭。来源与更新管理属于独立管理员 HTTP API，不新增插件运行时 Host API 方法。
