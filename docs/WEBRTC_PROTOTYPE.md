# WebRTC M1 原型操作说明

这是独立技术原型，不是现有 NarraFork 的远程访问开关。不加载真实用户数据库，不修改生产 HTTP/WS，也不部署官方公网服务。

## 启动

要求：仓库锁定的 Bun 依赖、Go 1.26.1（当前独立模块声明）、支持 WebRTC 的浏览器。

```bash
bun install --frozen-lockfile
bun scripts/webrtc-prototype.ts
```

脚本交叉编排一个本机协调服务 A、私有 fixture B 与 Go/Pion peer；端口随机。输出调试网页地址和**私有邀请文件路径**，不打印邀请秘密或 JWT。邀请文件位于脚本自己创建的工作区临时目录，权限为 0600。停止后清理该目录、邀请和该次 B 的身份，不停止任何已有 NarraFork。

1. 打开输出的调试网页地址。
2. 本地读取私有邀请文件，把 JSON 粘贴到页面；附加指纹填写 JSON 的 instanceId。
3. 明确勾选 localhost 开发模式，点击“配对连接”。
4. 点击“隔离 fixture 登录”。`admin / prototype-admin` 只是受私有桥接保护的 fixture 测试账户，不是 NarraFork 默认账户。
5. 验证项目列表、SSE、逻辑 socket、小资源、multipart 上传及双候选统计。
6. Ctrl-C 只关闭此次脚本创建的进程。已配对浏览器在**同一次原型运行中**可用保存的 grant 重连；脚本停止清理 B 身份后不能继续使用旧 grant。

实现入口：[编排脚本](scripts/webrtc-prototype.ts)、[浏览器客户端](remote-prototype/client.ts)、[流式 transport](remote-prototype/transport.ts)、[私有 fixture](remote-prototype/fixture.ts)、[协调服务](remote-coordinator/index.ts)、[Go peer 配置与注册](remote-peer/runtime.go)。协议合同和向量：[contract.json](shared/remote-access/contract.json)、[vectors.json](shared/remote-access/vectors.json)。

## 验证

```bash
bun test --isolate tests/remote-access
# Go 检查从 remote-peer 目录执行：
go test ./...
go test -race ./...
go vet ./...
```

真实浏览器测试查找本机 Chromium/Chrome 或 Puppeteer 缓存；也可显式设置 `NF_TEST_CHROMIUM_PATH` 或 `PUPPETEER_EXECUTABLE_PATH`。浏览器缺失会失败，不静默跳过。测试使用隔离状态、fixture 和自有进程，不重启现有服务器。

跨语言黄金向量使用公开的 P-256 scalar=1 **测试密钥**，不得作为任何运行时身份；运行时密钥来自密码学随机数。需要有意更新向量时运行 [生成器](scripts/generate-webrtc-vectors.ts)，签名自身随机但公钥/指纹/输入/帧确定。

## 安全与数据路径

- 仅 STUN/host/srflx/prflx，拒绝 TURN/relay，无 HTTP 业务回退。
- 邀请只用一次；后续发现 capability 与浏览器公钥 grant 独立，保存在该实例 origin。
- pairing secret、业务 JWT 和密码只经 RTC，不经 A 信令；A 没有通用业务转发消息。
- Go 只访问固定 loopback fixture，所有 HTTP/WS 都验证私有桥接 capability；不是任意内网 URL/端口代理。
- 回应头先返回，body/SSE 分块；credit/backpressure、取消、帧/队列/输入上限有效。写请求断链后不自动重放。
- A 离线/发现租约过期不主动关闭仍获 B 授权的 RTC；B grant 撤销、B session 过期/校验失败关闭 peer。
- M1 fixture 的主动 session 撤销经私有 `revoke-session` pipe 事件关闭匹配 peer，不影响其他 session/connect grant；本地到期时钟和有界定期重新验证兜底。生产实例事件推送属于 M2，不宣称已实现即时的所有账号事件传播。
- 官方提供前端 JS 仍处于信任边界；直连不是“官方绝对无法读取客户端数据”的保证。

## STUN 与真实 NAT

[stun-only.conf](remote-coordinator/stun-only.conf) 是 coturn 的**本机**样例，默认不暴露公网、不开放 TURN allocation。只有操作者确认公网监听、流量限额与防滥用策略后才用于公网实验；原型脚本不会启动 coturn、修改 TLS/防火墙或已有服务。

编排库支持 `startPrototype({ stunUrls: ["stun:你的测试服务器:3478"] })`；Go peer 的 stdin 配置支持 `stunUrls` 与公网 WSS 信令 URL。默认脚本只跑本机闭环，不伪装异地部署。

本机 Chromium/Pion 测试只能证明 RTC 互操作与业务传输。真实 NAT 验证还需要：
- 可控公网 A 的 HTTPS/WSS 地址、证书、STUN 和授权部署条件；
- 分属不同真实网络的 B 与 C（可加双层 NAT/移动 CGNAT）；
- 两端选中候选与传输统计，及 A 的控制面字节/业务 payload 观测。

UDP 阻断环境必须记录明确失败；严格 NAT 不保证直连。未具备上述条件前，不写“打洞成功率”、不声称异地访问已完成。

## 本阶段不覆盖

生产 NarraFork 业务/数据库集成、正式子域 DNS/TLS 与 PWA、ICE restart、SSO/passkey/MFA 全链路、插件/任意 iframe/Webview、匿名分享、完整媒体 Range、大文件/断点续传、普通用户权限和多平台原生分发。

独立 Go 模块已锁定 Pion v4.2.23；它的传递依赖中包含 TURN 协议包不等于运行中配置了 TURN。进入正式分发前必须按 [许可证要求](docs/LICENSES.md) 登记所有实际随产物分发的 Go 模块及协议/NOTICE，不能把本阶段原型构建当作生产发布。

完整架构和阶段边界见 [设计文档](docs/WEBRTC_REMOTE_ACCESS_DESIGN.md)。

## 本次本机验收记录

- `bun test --isolate tests/remote-access`：78 项通过、0 失败（8 个测试文件）。其中 [真实 Chromium/Pion/Bun 验收](tests/remote-access/browser.integration.test.ts) 覆盖 9 项业务/生命周期场景。
- 已验证 JSON/HEAD/续签响应头、中文 SSE 分片、分块二进制与 multipart、真实逻辑 WS、取消释放、慢消费者仍可交互、grant 重连与非管理员拒绝、精确 session 撤销、A 租约过期/离线继续直连与 B grant 撤销关闭。
- A 信令不含 pairing secret/业务 JWT/密码；业务文件传输期间 A 的控制面字节不随 payload 同比增长。
- 真实 Chromium 另验证黄金向量、双 origin 存储隔离及不可导出的持久 CryptoKey；不是正式 PWA 验收。
- 本机前端构建、全项目 `bunx tsgo --noEmit`、修改文件 Biome、Go `go test -race -count=5 ./...` / `go vet ./...` 通过。
- 本次修复了跨端 GET 隐式 EOF、请求/响应头策略、撤权事件、取消晚到帧和重复停止提前退出问题，并增加回归。
- [源码忽略规则](.gitignore) 显式收录两条原型脚本并排除私有运行目录，防止入口缺失或秘密误提交；[进程与收录守卫](tests/remote-access/supervisor.test.ts) 已覆盖。

范围声明：以上只证明本机原型；真实异地 NAT/公网 STUN/UDP 阻断、生产应用与 PWA、RSS/压力测试、多平台原生运行仍未完成。未部署公网服务、未发布或提交代码。
