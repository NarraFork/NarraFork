---
id: remote
title: 远程与设备
summary: 远程设备执行、远程访问、VS Code 插件。
anchors:
  - server/services/device-service.ts
  - server/services/remote-access-runtime.ts
  - vscode-extension/
keywords:
  - 远程设备
  - 远程执行
  - 远程访问
  - WebRTC
  - VS Code
  - remote-executor
  - remote-peer
  - /ws/device
  - /ws/vnet
  - narrafork-vscode
  - rdev_
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 远程与设备

这一块讲「本服务与其他机器、其他前端之间」的三条通路，方向各不相同：

- 设备与远程执行：服务端主动（或被动接受）连接装有 Go 执行器的机器，把叙述者的文件、命令、终端、传输工具调用转成 RPC 发过去。
- 远程访问：外部浏览器经 WebRTC 访问本实例；由一个 Go 子进程（remote-peer）承载连接，请求经受白名单限制的本机 bridge 进入应用。
- VS Code 插件：在编辑器 webview 里内嵌本服务自己的前端，靠服务端放行编辑器宿主 origin 的跨域规则工作。

三者共用服务端的鉴权体系（设备用自己的 rdev_ 令牌握手，远程访问与插件复用用户会话），但互不依赖对方的代码。

## 下面有什么

- [设备与远程执行](devices.md)：设备注册与连接、remote-executor、文件传输。
- [远程访问](remote-access.md)：WebRTC 远程访问。
- [VS Code 插件](vscode.md)：插件结构与和服务端的连接。
- [虚拟网络中转](vnet.md)：基于 WebSocket 中转的虚拟网络（/ws/vnet），与 WebRTC 远程访问无关。
