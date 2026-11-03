# 供应商导入（导入码 / 一键链接 / 从网站导入）

状态：v1 已实现，待发布

适用范围：自定义 API 供应商（Anthropic Messages / OpenAI Responses / Completions 兼容 / Gemini 兼容）。NUG、Codex 等平台供应商不在范围内。

本文同时是给 **API 网关 / 中转站维护者** 的接入说明：照第 7 节放一个按钮或一个静态文件，用户就能把你的服务一键导入 NarraFork。

---

## 1. 三种入口

| | 方案一：导入码 | 方案二A：完整链接 | 方案二B：短链接 | 方案三：从网站导入 |
|---|---|---|---|---|
| 触发 | 用户把码粘贴进 NF | 网关网站上点按钮 | 网关网站上点按钮 | 用户在 NF 里输入域名 |
| 配置来源 | 码内自带 | 链接内自带 | 网站 `.well-known` 文件 | 网站 `.well-known` 文件 |
| Key 来源 | 码内可带 | 链接内可带 | 链接内可带 | 用户手填 |
| 网站需放配置文件 | 否 | 否 | 是 | 是 |
| 来源可验证 | 否 | 否 | 是 | 是 |

所有入口共用同一份 JSON（第 2 节），最终进入同一个确认页 `/settings/providers/import`。**任何入口都不会自动保存**，必须由管理员在确认页确认。

这与添加供应商页的「从本机导入」相互独立：后者读取运行 NarraFork 的机器上其他工具的配置，经 `/api/provider-import/local/*` 处理；本文的网关导入使用 `/api/settings/provider-import/*`。

---

## 2. 导入 JSON（v1）

```json
{
  "v": 1,
  "issuer": { "name": "Geek2API", "url": "https://www.example.com" },
  "keyUrl": "https://www.example.com/console/keys",
  "providers": [
    {
      "id": "claude",
      "name": "Geek2API Claude",
      "protocol": "anthropic-messages",
      "baseUrl": "https://api.example.com",
      "baseUrls": ["https://hk.example.com"],
      "prefix": "geek2api",
      "defaultModel": "claude-sonnet-4-5",
      "userAgentMode": "claude-code",
      "endpointPolicy": { "strategy": "sticky" },
      "apiKey": "sk-..."
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `v` | 是 | 固定为 `1` |
| `issuer.name` / `issuer.url` | 否 | 仅用于显示，不代表可信 |
| `keyUrl` | 否 | 获取 Key 的页面，确认页显示“去获取 Key” |
| `providers` | 是 | 1–10 个 |
| `providers[].id` | 否 | 短链接用 `provider=<id>` 引用；`[a-z0-9_-]`，≤ 64 |
| `providers[].name` | 是 | ≤ 100 |
| `providers[].protocol` | 是 | `anthropic-messages` / `openai-responses` / `completions-compatible` / `gemini-compatible` |
| `providers[].baseUrl` | 是 | 主地址，仅 `https://`（或 `http://`），不得含用户名密码 |
| `providers[].baseUrls` | 否 | 备用地址，≤ 16，同样的路径结构 |
| `providers[].prefix` | 否 | 建议前缀；冲突时自动改名 |
| `providers[].defaultModel` | 否 | 不带前缀的模型名 |
| `providers[].geminiTransport` | 否 | `generate-content` / `interactions` |
| `providers[].userAgentMode` | 否 | `narrafork` / `claude-code` / `codex`（不支持 `custom`） |
| `providers[].endpointPolicy` | 否 | 多地址策略，见设置页“备用地址” |
| `providers[].apiKey` | 否 | **只在导入码、完整链接中有效**；从网站拉取的配置中出现会被丢弃并警告 |

**白名单**：以上之外的字段一律丢弃，并在确认页列出“已忽略字段”。以下字段即使出现也**明确不导入**：`tlsRejectUnauthorized`、`proxy`、`extraHeaders`、`customUserAgent`、`disabled`。

---

## 3. 导入码

```
NFP1.<payload>.<check>
```

- `payload` = UTF-8 JSON 的 base64url（RFC 4648 §5，无 `=` 填充）。
- `check` = 对 `payload` 字符串（ASCII）计算 CRC-32（IEEE 802.3，与 zlib 相同），转为小写 base36，左侧补 `0` 至 7 位。**只用于发现复制不全或损坏，不提供任何安全性。**
- 解码后 JSON 不超过 16 KB。
- 解析前会删除所有空白字符，聊天软件折行后的码可以直接粘贴。

## 4. 一键链接

浏览器需要先在 NF 的导入页点击“注册为 web+narrafork 链接处理程序”（Chrome / Edge / Firefox 桌面版支持；Safari、多数手机浏览器不支持）。

### 4.1 完整链接（方案二A）

```
web+narrafork://import#NFP1.<payload>.<check>
```

`#` 之后就是一个导入码。

### 4.2 短链接（方案二B）

```
web+narrafork://import?domain=www.example.com#key=sk-xxx&provider=claude&label=%E5%B7%A5%E4%BD%9C
```

| 参数 | 位置 | 说明 |
|---|---|---|
| `domain` | 查询 | **完整主机名**，不做缩写推断；按第 5 节规则拉取，但只拉这一个主机 |
| `key` | 片段 | 填入拉取到的供应商；URL 编码 |
| `provider` | 片段 | 只把 Key 用于 `id` 匹配的那一个；省略时用于全部 |
| `label` | 片段 | 区分同一网关的多个 Key；名称显示为 “Geek2API · 工作” |

### 4.3 Key 为什么在 `#` 之后

- 片段不会随请求发给网关服务器，也不会出现在 Referer 中。
- NF 注册的处理地址为 `<NF 地址>/settings/providers/import#link=%s`，片段同样不会发到 NF 服务器。导入页读取后立即用 `history.replaceState` 清掉地址栏，不写入 localStorage / sessionStorage。
- 兼容：导入页也接受 `?link=`（部分浏览器若不支持片段模板时使用），读取后同样立即清除。

### 4.4 没注册处理程序时

点击 `web+narrafork:` 链接不会有任何反应。建议在按钮旁放一个“复制导入码”，内容就是完整链接 `#` 之后那一段。

---

## 5. 从网站导入（方案三）与短链接的拉取规则

固定路径：

```
https://<host>/.well-known/narrafork-provider.json
```

### 5.1 输入如何变成探测地址

| 用户输入 | 依次探测 |
|---|---|
| `www.example.com` 或 `api.example.com`（非注册域本身） | 只探测该主机 |
| `example.com`（就是注册域本身，含 `.com.cn` 等多级后缀） | `example.com` → `www.example.com` |
| `example`（无点、仅字母数字连字符） | `example.com` → `www.example.com`（只补 `.com`） |
| `https://x.y/path/conf.json`（路径以 `.json` 结尾） | 原样拉取该 URL |
| `https://www.example.com/pricing`（其它带路径的网址） | 去掉路径，按主机名规则处理 |

- 大小写、末尾点、首尾空白会被规范化；国际化域名转为 punycode。
- `localhost` 等保留名、IP 地址不接受。
- 短链接的 `domain` 只探测那一个主机，不补 `www`。

### 5.2 拉取限制

- 只用 HTTPS；服务端发起请求，走 NF 的全局代理策略。
- 每个地址：超时 5 秒，响应体上限 64 KB，不带 Cookie。
- SSRF 防护：拒绝解析到回环、内网、链路本地等地址的主机（复用插件安装的检查）。**已知限制**：检查时的 DNS 解析与实际请求时的解析是两次独立查询，DNS 重绑定可以绕过；DNS 查询失败时也会放行，交由请求本身报错。该接口仅管理员可用且需手动输入域名，修复需要固定解析结果并兼容代理。
- 重定向最多 3 次，且**只允许同一注册域内**（如 `example.com` ↔ `www.example.com`）。跨域重定向视为失败，因为“配置来自用户输入的域名”这个保证会失效。

### 5.3 什么时候换下一个候选，什么时候停

| 结果 | 处理 |
|---|---|
| 连接失败 / DNS 失败 / 超时 / 404 / 其它非 2xx | 记录原因，换下一个候选 |
| 返回 HTML（常见于单页网站把未知路径都返回首页） | 视为“没有配置文件”，换下一个候选 |
| 拿到 JSON，但格式或校验不通过 | **停止**，报告具体错误（通常是站长写错了） |
| 拿到合法配置 | 停止，进入确认页 |

全部失败时列出每个尝试过的地址和原因。

---

## 6. 确认页与冲突处理

确认页显示：来源（“来自 www.example.com ✓” 或 “来源未验证”）、每个供应商的主地址与备用地址（域名高亮）、前缀、Key（打码显示，可修改）、已忽略字段，以及固定提示：

> 使用该供应商时，你的对话和代码都会发送到上面这些域名。请确认你信任它们。

| 情况 | 默认处理 |
|---|---|
| 前缀被占用 | 自动改为 `prefix-2`、`prefix-3`… |
| 主地址相同（供应商已存在） | 默认新增独立供应商；也可选择只替换现有供应商的 Key |
| 主地址相同、Key 相同 | 提示已存在，可跳过 |
| 没有 Key | 允许导入，之后在设置页补填 |

导入后不会设为默认模型，也不修改已有配置（除非选择了“替换 Key”）。可以选择“导入为禁用状态”。

**Key 验证**：确认页加载后，对导入内容自带的每个供应商 Key 在服务端用尚未保存的配置拉一次模型列表，结果显示在对应输入框下方（“✓ N 个模型” / “✗ 原因”）；修改 Key 后可点“验证 Key”重新验证。验证失败只提示、不阻止导入（有些网关屏蔽模型列表但仍可对话）。每次最多验证 40 个 Key，并发 4，每个 15 秒超时。

**导入后拉取模型**：服务端返回拿到 Key 的供应商 ID 清单，导入页逐个调用标准的刷新模型接口（禁用状态导入也照常拉取），并汇总提示每个的模型数；失败的单独列出原因，提示不会自动消失。

---

## 7. 网关接入示例

### 7.1 生成导入码与完整链接（浏览器或 Node.js）

```js
function crc32(text) {
  let crc = -1;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i);
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function toBase64Url(json) {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function narraforkImportCode(config) {
  const payload = toBase64Url(JSON.stringify(config));
  return `NFP1.${payload}.${crc32(payload).toString(36).padStart(7, "0")}`;
}

const code = narraforkImportCode({
  v: 1,
  issuer: { name: "Geek2API", url: "https://www.example.com" },
  providers: [{
    name: "Geek2API Claude",
    protocol: "anthropic-messages",
    baseUrl: "https://api.example.com",
    apiKey: userKey,
  }],
});
const fullLink = `web+narrafork://import#${code}`;
```

### 7.2 短链接

```js
const shortLink =
  "web+narrafork://import?domain=www.example.com" +
  `#key=${encodeURIComponent(userKey)}&provider=claude&label=${encodeURIComponent("工作")}`;
```

### 7.3 静态配置文件

把第 2 节的 JSON（**不含 `apiKey`**）放到 `https://<你的域名>/.well-known/narrafork-provider.json`，以 `application/json` 返回即可。由 NF 服务端拉取，不需要配置 CORS。

---

## 8. 实现位置

| 内容 | 文件 |
|---|---|
| 格式、编解码、输入识别、域名候选 | `shared/provider-import.ts` |
| 服务端拉取（SSRF / 重定向 / 限流） | `server/lib/provider-import-fetch.ts` |
| 接口 `/api/settings/provider-import/{fetch,preview,check,commit}` | `server/routes/provider-gateway-import.ts` |
| 确认页 | `frontend/components/providers/ProviderImportPage.tsx`、`frontend/routes/settings/providers.import.tsx` |
