# 发布与更新服务器

## Changelog 与发布工作流

项目使用 `changelogs/` 目录持久化每个版本的双语更新日志，构建时嵌入二进制。

1. **生成 Changelog：** 使用 `/release` 技能（或手动创建），输出到 `changelogs/v{version}.json`：
   ```json
   {
     "version": "0.2.0",
     "date": "2026-04-01",
     "en": "## New Features\n\n- ...",
     "zh-CN": "## 新功能\n\n- ..."
   }
   ```
2. **发布新版本：** `bun scripts/release.ts <version>` — 自动从 `changelogs/v{version}.json` 读取 changelog（也可 `--changelog=<file>` 手动指定），执行版本 bump → git tag → 跨平台编译 → 上传更新服务器。
3. **构建嵌入：** `scripts/build-cross-platform.ts` 会扫描 `changelogs/*.json` 生成 `server/generated/embedded-changelog.ts`，编译二进制后无需文件系统即可读取。
4. **运行时读取：** `server/lib/changelog.ts` 双模式 — 开发时读文件系统，编译二进制读嵌入数据。API 端点 `GET /api/changelog`（公开，无需认证）。
5. **前端查看：** 设置页 About 区域有「查看更新日志」链接，跳转到 `/changelog` 页面（Timeline 组件，按版本倒序，根据语言切换内容）。

## 正式版（stable）直达增量包

构建只会生成「紧邻上一个版本 → 当前版本」这一条 patch，这对逐版本跟进的 beta 用户是对的，但正式版用户只跟 stable，中间隔着一堆 beta 版本时会被迫连续应用多个 patch。因此**一个版本成为正式版时，额外生成并上传「上一个正式版 → 该版本」的直达 patch**：

- **以 stable 身份发布**（版本号形如 `x.y.0`）：`bun scripts/release.ts <version>` 上传完成后自动补齐。
- **beta 晋升为 stable**：`bun scripts/promote-release.ts <version>` 改完 channel 后自动补齐。
- 实现位于 `scripts/lib/stable-baseline-patch.ts`（基线选择为纯函数，便于测试），patch 生成走 `generateZstdPatchToFile`（文件到文件，不把 ~140MB 二进制读进 JS 堆）。
- 直达包**追加**存储为 `.from-<version>.zstd-patch`，不会覆盖已有的 patch，原有升级路径保持可用。
- 上传前校验本地目标二进制与基线二进制的 size+sha512 必须与服务器已发布的完全一致，避免用被改动过的本地文件生成 patch。
- 补包失败或缺少本地二进制时**只告警不中断**（多步 patch chain 仍然可用）；要跳过这一步用 `--skip-stable-patch`。
- 前提：`dist/` 里需要有上一个正式版和当前版本**两个平台二进制**，且与线上发布版本字节一致。

## 发布目标服务器（生产 vs 个人测试）

- **正常发布（生产）：** `bun scripts/release.ts <version>` 默认读取 `~/.narrafork/update-server.json`，上传到生产更新服务器 `https://narrafork-update.b.domexie.cn`。这是所有正式版本的发布路径，**不要改动**。
- **个人测试发布：** 用于只给自己测试的版本，走独立的测试更新服务器，不影响生产。发布时通过环境变量覆盖服务器地址和令牌：
  ```bash
  # 令牌明文存于 ~/.narrafork/update-server-test.json（权限 600，不提交仓库）
  NF_UPDATE_SERVER=https://nfupdatetest.domexie.cn \
  NF_UPDATE_TOKEN=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.narrafork/update-server-test.json","utf8")).token)') \
  bun scripts/release.ts <version> --platform=windows-x64
  ```
  说明：`--platform=windows-x64` 按需选择平台；`--dry-run` 只构建不上传；`--upload-only` 复用现有 `dist/` 只上传。
- **客户端测试：** 在设置页把「更新服务器」填 `https://nfupdatetest.domexie.cn`，通道选 `beta`（个人测试版本通常发到 beta 通道），即可检查到测试版本。测试完成后记得改回生产服务器。

## 个人测试更新服务器（常驻服务）

测试更新服务器由 systemd 常驻托管，避免进程被关导致域名 502（历史上用后台任务跑会因超时被杀）。

- **域名：** `https://nfupdatetest.domexie.cn`（宝塔 nginx/openresty 反代到 `127.0.0.1:17780`，vhost 配置 `/www/server/panel/vhost/nginx/nfupdatetest.domexie.cn.conf`，复用 `*.domexie.cn` 泛域名证书）
- **systemd 服务名：** `narrafork-update-test`（系统单元 `/etc/systemd/system/narrafork-update-test.service`，`User=fulcrum`、`Restart=always`、开机自启）
  ```bash
  systemctl status narrafork-update-test      # 查看状态
  sudo systemctl restart narrafork-update-test # 改了数据/配置后重启（release-cache 是内存缓存，需重启重载 meta.json）
  journalctl -u narrafork-update-test -n 50    # 或看 ~/.narrafork/update-test/service.log
  ```
- **数据目录：** `~/.narrafork/update-test/`（`config.json` + `data/products/narrafork/releases/<version>/...`），持久化，不放 `/tmp`
- **令牌：** 测试服务器专用上传令牌明文存于 `~/.narrafork/update-server-test.json`（权限 600，**不提交仓库**）；`config.json` 内只存 sha256 哈希
- **注意：** 该测试服务器与本机（`127.0.0.1:17780`）绑定；直接修改 `data/` 下的 `meta.json` 后必须 `systemctl restart narrafork-update-test` 才会生效（内存缓存）。
