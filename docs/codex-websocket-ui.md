# Codex Responses WebSocket UI 使用指南

## 概述

管理面板中的 Codex 开关控制的是 Responses WebSocket 传输。

开启后：

- Codex 优先使用 Responses WebSocket
- 不可用时自动回退到 HTTP
- 现有会话不会被强制中断，新请求会使用新的配置

## 功能位置

**路径：** 管理面板 → Providers → Codex

你会看到如下控制项：

```text
┌─────────────────────────────────────────────────────┐
│ 使用 Responses WebSocket          [实验性]          │
│ 使用 Responses WebSocket 而非 HTTP 连接到 Codex    │
│ （实验性功能，不可用时会自动回退 HTTP）             │
│                                    [开关] [保存]    │
└─────────────────────────────────────────────────────┘
```

## 使用步骤

1. 打开管理面板
2. 进入 Providers
3. 找到 Codex 区域
4. 打开「使用 Responses WebSocket」开关
5. 点击保存

保存后，新请求会优先尝试 WebSocket 传输。

## 代理说明

Codex 的全局代理配置同时作用于：

- HTTP Responses 请求
- Responses WebSocket 握手与后续传输

示例：

- `http://proxy.example.com:8080`
- `https://proxy.example.com:8443`
- `socks5://proxy.example.com:1080`

## 故障说明

如果 WebSocket 不可用，通常会表现为：

- 服务端不支持 WebSocket upgrade
- 代理不支持 WebSocket
- 网络环境阻断 WebSocket

此时 NarraFork 会自动切回 HTTP，无需手动关闭开关。

## 调试

可以使用下面的脚本手动验证连接：

```bash
bun scripts/test-codex-websocket.ts
```

带代理：

```bash
bun scripts/test-codex-websocket.ts --proxy=http://proxy.example.com:8080
```
