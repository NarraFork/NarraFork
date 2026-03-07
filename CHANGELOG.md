# Changelog

本项目的版本变更记录保存在此文件中。

## [Unreleased]

## [0.0.2] - 2026-03-07

### Added
- 为 narrator 增加了 Fast Mode 配置与持久化能力，并在 Codex 模式模型上提供前端开关。
- 为 OpenAI Provider 配置页恢复 `apiMode: "codex"` 选项，并支持配置可选的 ChatGPT Account ID。
- 为 Git 改动列表补充 staged / unstaged 维度的单文件行数统计。

### Changed
- 统一了 Codex 模式 provider 的运行时判定逻辑，使自定义 OpenAI provider 在 `apiMode: "codex"` 下也能使用 Codex 相关控制项。
- 优化了 Git 状态摘要的解析逻辑，正确处理未跟踪文件、rename 场景与分区统计。
- 在 Provider 设置存在未保存修改时，刷新模型列表会先提示保存，避免覆盖或混淆状态。

### Fixed
- 修复了 narrator 派生、分叉与 subagent 路径中 `fastMode` 未正确继承的问题。
- 修复了 Git Changes 面板里 staged / unstaged 行数重复显示总改动的问题。
- 修复了 `apiMode: "codex"` 相关描述与实现不一致的问题。

## [0.0.1]

### Added
- 初始版本。
