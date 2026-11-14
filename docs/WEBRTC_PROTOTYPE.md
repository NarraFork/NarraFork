# WebRTC M1 原型操作说明

本文描述 **M1 独立技术原型及其历史实测记录**；下面的原型命令不加载真实用户数据库，也不部署官方公网服务。后续 M2 已另行接入真实 NF 核心业务和普通设置页的远程访问管理，不要把 fixture 账户、JWT 或原型启动方式用于真实实例。

## M2 与本原型的区别

M2 使用默认关闭的可选 peer、真实 opaque `nfs_` 会话（含管理员密码与 TOTP/备用码）、私有 dispatcher 桥接和同源码双构建。可用范围为项目、叙述者历史/聊天/审批、SSE 与小附件；terminal、outline、插件/Webview、SSO/passkey/注册、大文件等明确禁用，普通 HTTP/WS 不变。

真实 Go/Pion→NF app/隔离 SQLite→Chromium 的业务验证位于 `tests/remote-access/production-browser.integration.test.ts` 与 `production-approval.integration.test.ts`；production UI 的资源/网络边界另行验收。测试不启动生产 `server/main.ts`，不改真实数据库，也不重启现有 NF。配对不等于登录；前端必须依据 NF 应用身份匹配托管版本，不按 peer 版本或 latest 加载。

本地构建、随主发布产物和托管契约见 [构建指南](BUILD.md)、[发布说明](RELEASE.md) 与 [当前设计](WEBRTC_REMOTE_ACCESS_DESIGN.md)。以下 M1 阶段范围和异地记录保留其当时含义，不将历史原型结果冒充 M2 公网部署或 Windows 原生验收。

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

## domepc ↔ laptop 异地实测（2026-11-06 UTC）

结论：**这次网络条件下未建立直连，不是成功的异地业务验收。**

- B：domepc / Windows，使用独立 Bun fixture + 交叉编译的 Go peer。C：laptop / Linux，实际运行隔离的 Microsoft Edge。A：独立限时 TLS/WSS 协调服务与 STUN-only；使用已有放行且空闲端口，不重启现有服务、不修改防火墙或系统证书库。
- A 的测试证书仅由 B 的独立 signal CA 配置和 C 的单证书 SPKI 测试 pin 信任；前端使用实例指纹测试域名并由浏览器本次启动参数解析，不表示正式 DNS/TLS/PWA 部署已经完成。
- B 的 ICE 候选限定到物理网卡 IP，排除了既有虚拟组网和 WSL 地址；测试没有 TURN、VPN 路径或 HTTP 业务回退。两个物理出口观察到的公网 IPv4 不同。
- TLS 连通、B 签名注册、A/B/C offer/answer 与候选交换，以及两端到 A 的 STUN Binding 探测均通过。
- IPv4 专项：浏览器对 B 公网 srflx 候选的快照显示 `requestsSent=119`、`responsesReceived=0`，没有 nominated/succeeded 候选对。
- 双栈专项：B 公网 IPv6 候选已进入浏览器候选对检查；使用浏览器默认双栈策略时，两个 IPv6 候选对快照各显示 `requestsSent=60`、`responsesReceived=0`，IPv4 候选对也无响应，仍未建立 DataChannel。
- 因连接未建立，业务文件吞吐、A 断线后继续业务与 B 撤权的**异地**验证未执行；既有本机通过结果不能替代这部分。

这些现象表明此次端到端 ICE 检查没有拿到对端应答，但不足以判定某端一定是对称 NAT，也未区分终端/路由器防火墙、NAT 映射过滤或其他网络策略。两端能访问 STUN，不等于两端之间 UDP 必然可达。下一步应单独检查端到端 UDP/IPv6 与终端防火墙，或在用户显式接受业务中继的前提下另测 TURN；本次没有静默改变策略。

本次修正与回归：
- 协调服务的非 loopback 监听必须显式启用且提供 TLS 证书/私钥，公网明文依旧拒绝。
- Go 增加独立 `signalCAFile`（64KiB 上限、保留主机名校验），以及物理 ICE IP/接口白名单与 UDP4/UDP6 筛选，不影响本机 bridge 的信任。
- 首轮跨机测试在 ICE 之前触发了短期票据未来上界的秒级时差边界；未来上界由 60 秒改为 65 秒，已过期仍拒绝，签名/目标/单次重放检查不变。新增分项安全错误码及边界回归，不记录原始票据。
- 重启 Windows 测试实例读取原状态曾返回 `config_rejected`；本次用新建隔离身份继续，未把旧身份复用/Windows 权限持久化兼容性算作已验证。
- 修改后 `bun test --isolate tests/remote-access`：80 项通过、0 失败；`bunx tsgo --noEmit`、Go race/vet 通过。这些是代码/本机回归，不代表异地直连成功。

清理：已停止本次自有 A 协调/STUN 监听与 B peer/fixture，删除 domepc 和 laptop 的测试目录、邀请、身份与浏览器配置。未触碰用户原有浏览器会话或其他 NarraFork 进程。

## 后续根因对照与默认隐私策略下的成功验证（同次异地排查）

上节“未直连”是当时仅配置 IPv4 STUN 的结果，不代表两端公网 IPv6 本身不可达。后续对照已找到候选发现配置缺口，并验证了一条不关闭浏览器隐私保护的可用路径。

### 独立于 WebRTC 的网络证据

- 两端各使用一个持续存活、绑定物理 IP 的普通 UDP socket。没有禁用防火墙、添加入站放行规则、使用 VPN 或 TURN。
- 原始 IPv6 双向互发：每端各收到 20 个探测包、20 个 ack，证明当时的物理 IPv6 UDP 路径可用。
- laptop 同一个 IPv4 socket 访问 A 同一公网 IP 的两个 STUN 端口，稳定得到不同外部端口；domepc 的这组对照映射端口相同。这只证明该目的端点对照中的映射差异，不扩张为完整 NAT 类型分类。
- Windows PktMon 在仅配置 IPv4 STUN 的默认 WebRTC 对照中没有观察到对应对端的 Rx；独立 IPv6 UDP 和成功的 ICE 对照中则有实际双向包迹。抓包只限定本次对端/诊断 UDP，停止后恢复为无捕获、无过滤器。

### 候选暴露方式的对照

| 浏览器设置 | STUN 配置 | 结果 |
|---|---|---|
| 默认 mDNS 隐私保护 | 仅 IPv4 STUN | 失败，无选中候选对 |
| 仅隔离 profile 关闭 mDNS（诊断） | 仅 IPv4 STUN | 约 3.2 秒成功，选中两端物理公网 IPv6 host/host |
| 恢复默认 mDNS，复用配对 grant | 仅 IPv4 STUN | 再次失败，重现候选检查无应答 |
| 默认 mDNS 隐私保护 | IPv4 STUN + 可经 IPv6 访问的 STUN | 约 3.1 秒成功，出现浏览器公网 IPv6 srflx 候选并完成直连 |

最后一组使用显式配置的公共 IPv6 STUN 入口作诊断，并非 TURN，也未把它写成产品硬编码默认依赖。默认模式下，浏览器 host 地址仍是 `.local`，新增的 IPv6 srflx 地址与成功选中 host 候选使用同一个 UDP 端口；因此这里修复的是可交换 IPv6 候选的发现，不是要求关闭 mDNS。

在这一默认模式成功会话中，签名 answer/pin 校验、实例管理员登录、项目查询、1 MiB 下载、128 KiB 上传（均校验 SHA-256）、中文 SSE、真实逻辑 WebSocket 订阅全部通过；无 relay 候选、无业务 HTTP 回退，选中 B 的物理公网 IPv6。下载约 513 ms、上传约 149 ms，仅是本次样本，不是性能承诺。

### 调查结论与修正方向

- 已确认的主要配置问题：原型只提供 IPv4 STUN；浏览器默认 mDNS 隐藏 host 地址，native peer 跨网络不能靠该 `.local` 名称可靠获得浏览器公网 IPv6端点。补充 IPv6 STUN 后，可交换的 IPv6候选使直接路径建立。
- IPv4 仍有目的端口相关映射及本次端到端不达的问题；本次成功走 IPv6，没有证明 IPv4 NAT 打洞已解决，也没有证明任意严格 NAT 都可达。
- 产品方向是让官方 STUN 支持 IPv4/IPv6 双栈，并显式协商/提供两个地址族的探测入口；不是默认禁用浏览器隐私设置，更不是把第三方服务静默设为依赖。仅 IPv4 的网络仍可能需要用户可选中继或明确连接失败。
- 代码审查另发现整体 20 秒/未 hello 20 秒预算包含收集与协商，可能过早截断 checking；这是独立的可改进项，不足以解释本次零应答，也未把延长超时当作已验证根因修复。

诊断结束后已关闭自有 A/B/C 测试进程、监听、抓包，并删除隔离目录、邀请、身份、浏览器 profile 和私钥。没有更改两端防火墙规则、系统证书库、用户浏览器设置或运行中的 NarraFork。
