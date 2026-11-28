---
id: engineering
title: 工程与发布
summary: 开发命令与代码规范、测试、构建、发布与更新、第三方许可。
anchors: []
keywords:
  - package.json
  - scripts/
  - CI
  - ci.yml
  - release.yml
  - bun test
  - bun build --compile
  - vite build
  - biome
  - tsgo
  - GitHub Release
  - update-server
  - 发布
  - 构建
  - 测试
  - 许可
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 工程与发布

这一块讲“代码怎么被开发、检查、打包、发出去”。入口都是 `package.json:scripts`：开发与检查命令见[开发命令与代码规范](commands-style.md)；`bun test --isolate` 与 CI 的四分片全量测试见[测试](testing.md)；`vite build` 加 `bun build --compile` 把前端、迁移、更新日志、许可证清单、内置插件嵌进单文件可执行程序，见[构建与打包](build.md)，其中的许可证清单规则见[第三方许可](licenses.md)；`scripts/release.ts` + `release.yml` 把构建好的程序发布成 GitHub Release，再由更新服务器镜像、客户端取更新，见[发布与更新](release.md)。

配合方式：同一份 `.github/workflows/ci.yml`（静态检查、构建与类型检查、测试分片）既是每个 PR 的门禁，也被 `release.yml` 的 verify 作业复用，所以“能合并”和“能发布”的检查是同一套；构建脚本消费 `changelogs/`、`licenses/`、`drizzle*/` 生成嵌入模块；发布物的格式（补丁、索引、更新身份）由 `shared/` 里的协议文件同时约束 `scripts/`、`server/` 与 `update-server/`。

## 下面有什么

- [开发命令与代码规范](commands-style.md)：bun 命令、Biome、tsgo、禁用 npx、路径别名。
- [测试](testing.md)：--isolate、CI 四分片、守卫测试、浏览器测试。
- [构建与打包](build.md)：前端构建、跨平台可执行文件。
- [发布与更新](release.md)：release 脚本、changelog、stable 增量包、更新服务器。
- [第三方许可](licenses.md)：新增依赖时的许可要求。
