---
id: platform.network
title: 出站网络与代理
summary: 服务端发出的请求：代理策略与 no_proxy 规则、启动时中和环境代理、outboundFetch 的重放规则、TLS 握手错误、局域网监听地址、诊断信息脱敏。
anchors:
  - server/routes/tls.ts
  - server/lib/net/diagnostic-redaction.ts
  - server/lib/net/lan-addresses.ts
  - server/lib/net/listen-host.ts
  - server/lib/net/no-proxy.ts
  - server/lib/net/outbound-fetch.ts
  - server/lib/net/proxy-env.ts
  - server/lib/net/proxy.ts
  - server/lib/net/tls-transport-error.ts
  - shared/proxy-settings.ts
  - shared/server-host.ts
  - frontend/lib/proxy.ts
  - frontend/routes/settings/proxy.tsx
  - tests/server/lib/net-proxy.test.ts
  - tests/server/lib/net-no-proxy-rules.test.ts
  - tests/server/lib/proxy-env.test.ts
keywords:
  - 代理设置
  - 不走代理
  - no_proxy
  - noProxyRules
  - HTTPS_PROXY
  - settings.proxy
  - outboundFetch
  - resolveProxyForUrl
  - INVALID_OUTBOUND_PROXY_URL
  - UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL
  - UNKNOWN_CERTIFICATE_VERIFICATION_ERROR
  - auto-lan
  - 局域网地址
  - redactDiagnosticUrl
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---

# 出站网络与代理

服务端发给外部（模型提供商、WebFetch、网关、更新等）的请求都由 `settings.proxy` 这一份全局策略决定走不走代理；本页还包括 TLS 握手错误的重放判断、监听地址解析和诊断信息脱敏。

## 关键规则
- 启动最先中和环境代理：`server/index.ts` 在其他逻辑之前调用 `neutralizeAmbientProxyEnv`，把 `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY`（大小写两套）快照后写成空串；用赋值不用 `delete`，因为只有赋值能到达 Bun 原生环境（`proxy-env.ts`）。幂等，二次调用不覆盖快照。
- 「系统」模式读快照而非实时环境（`ambientSystemProxy`：HTTPS → HTTP → ALL）；用户驱动的子进程（终端、dtach、容器、更新）用 `envWithAmbientProxy` 恢复原值，NarraFork 自己的出站请求不得用它。
- 全局策略 `getOutboundProxy`：`system` 读快照；`custom` 取 `settings.proxy.url`；其余（含无配置）直连。逐处覆盖 `resolveOverride`：`default` 回落全局，`direct`/`system`/`custom` 各自处理（`proxy.ts`）。
- 豁免只会让目标直连，不会强制走代理；`explainProxyBypass` 按顺序判断：回环/本机地址 → 环境 `NO_PROXY` 快照（支持 `*`、后缀、前导点）→ `settings.proxy.noProxyRules`；入口是 `resolveProxyForUrl`/`applyProxyExemptions`，所有渠道经此继承豁免（`proxy.ts`）。
- 规则匹配（`no-proxy.ts:matchNoProxyRules`）：
  - `regex` 规则先于 `wildcard`，同类内按列表顺序首个命中即止。
  - 停用（`enabled: false`）和无法编译的正则被跳过，不会因坏规则而放弃代理。
  - 候选依次是完整 URL、小写主机名、有显式端口时的 `host:port`。
  - 不含 `* ? /` 和 `://` 的是经典 NO_PROXY 主机条目：精确或任意点分子域，带端口则端口必须相等。
- 规则数上限 `MAX_NO_PROXY_RULES = 200`，单条 ≤ 500 字符，正则在保存时编译校验（`shared/proxy-settings.ts`）。`PATCH /api/settings` 的 `proxy` 整体替换，但缺省 `noProxyRules` 时保留已存列表，显式 `[]` 才清空（`routes/settings.ts:mergeProxySettingsPatch`）。
- 只支持 HTTP/HTTPS 代理：无协议的地址补 `http://`；非法地址抛 `INVALID_OUTBOUND_PROXY_URL`，其他协议抛 `UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL`，不会悄悄改直连（`outbound-fetch.ts:OutboundProxyConfigurationError`）。
- `outboundFetch` 走 Bun 原生 fetch：有 `proxyUrl` 传该地址，否则传 `proxy: false` 明确直连；`tlsRejectUnauthorized === false` 才关证书校验；不加 `Connection: close`，连接复用交给 Bun（有测试守着，`outbound-fetch-connection-reuse.test.ts`）。
- 重放（`retryPolicy`，默认 `never`）最多重试一次，且调用方中止不重放：
  - TLS 握手以 `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` 失败：请求字节尚未送出，除 `never` 外不论方法都重放；过期、自签、主机名不符等有具体码的证书错误不重放（`tls-transport-error.ts`，`tls-transport-error.test.ts`、`outbound-fetch-tls-retry.test.ts`）。
  - 其他瞬时传输错误（ECONNRESET 等码或消息模式）：仅当策略允许该方法才重放，`idempotent-only` 只放行 GET/HEAD/PUT/DELETE/OPTIONS/TRACE，POST 不重放。
  - 请求体是 `ReadableStream`，或非可重放方法的 `Request` 带体，则没有重放分支。
- 监听地址：配置值 `auto-lan` 表示取第一块 RFC1918 私网 IPv4（`lan-addresses.ts`），没有或检测失败回落 `localhost`；绑定失败时对 `auto-lan` 再退一次 `localhost`，显式地址的失败照常抛出（`listen-host.ts`，`listen-host.test.ts`）。持久化的仍是 `auto-lan` 而非具体 IP。
- 诊断脱敏（`diagnostic-redaction.ts`）：URL 去掉账号密码和 hash，查询值除 `api-version`/`version` 外全部打码；头部只有白名单（含 `retry-after`、`request-id`、`*ratelimit*`）显示值，其余为 `********`；文本中的 Bearer/Basic、`api_key=`、JWT、`nfs_` 令牌打码，文本上限 4000 字符；`verbose` 输出上限 64 KiB。

## 从哪读起
- `server/lib/net/proxy.ts:resolveProxyForUrl`：每个渠道求代理的统一入口。
- `server/lib/net/outbound-fetch.ts:outboundFetch`：传输、重放、verbose。
- `server/lib/net/no-proxy.ts` 头部注释的优先级与语法；`shared/proxy-settings.ts` 的校验。
- 前端：`frontend/routes/settings/proxy.tsx`（设置页）、`frontend/lib/proxy.ts`（策略摘要与规则校验再导出）。

## 改它时
- 新增出站渠道：用 `resolveProxyForUrl(url, override)` 求代理再交给 `outboundFetch`，不要自己读环境变量；子进程要继承用户代理时用 `envWithAmbientProxy`。
- 改 `noProxyRules` 的形状：同步 `shared/proxy-settings.ts`（zod + `MAX_*`）、`routes/settings.ts` 的 `updateSettingsSchema`/`mergeProxySettingsPatch`、前端 `settings/proxy.tsx`；测试 `tests/server/lib/net-no-proxy-rules.test.ts`、`net-proxy.test.ts`、`proxy-env.test.ts`。
- 改重放或 TLS 判断：`outbound-fetch-tls-retry.test.ts` 钉着「握手错误可重放、确定性证书错误不重放、POST 不因模糊 ECONNRESET 重放」。
- 不变量：规则只豁免不启用代理；回环地址永远直连；新增脱敏白名单项要确认值不含凭据。

## 相关
- [启动与进程](boot.md)：入口先于一切中和代理变量。
- [设置与数据目录](settings.md)
