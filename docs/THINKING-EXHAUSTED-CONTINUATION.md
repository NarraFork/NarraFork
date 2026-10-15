# 思考耗尽型截断续跑（Thinking-exhausted continuation）

叙述者频繁出现「你上一条回复因 completion token 限制被截断，请从中断处继续。」时的排查与修复记录。
首次排查：2026-10-15，叙述者 `TN3HqPQeu5D_ILAHxyhzg`。

## 现象

- 模型 `像素星空 Claude:claude-haiku-5-5`（Anthropic 协议，端点 `/messages`）
- 该提示每约 5 分钟出现一次，连续 6+ 次；每次请求耗时 4m32s–4m54s，费用 $0.029–$0.042

## 证据

### 上游面板（像素星空）

- 每条请求输出恒为 **64,000 tokens**（正好是输出上限）
- 输入 4 tokens（缓存命中），输出速度 ~220 tok/s → 64000 / 220 ≈ 290s，与总耗时可对上

### NarraFork 数据库

```sql
select created_at, output_tokens, input_tokens, cached_input_tokens, cache_creation_input_tokens
from api_requests where narrator_id = 'TN3HqPQeu5D_ILAHxyhzg' order by created_at desc limit 12;
```

- 12 条里 11 条 `output_tokens = 64000`
- assistant 消息 `content_text` 为 null；`content_json` 里只有一个 reasoning 块：
  `text: ""`、`rawTextLength: 0`、`signature` ≈ **200 KB**
  （正常 signature 是数百字节；200 KB 说明思考内容被编码进了 signature）
- 即：模型把整个输出预算花在了无法显示的思考上，可见产出为零

### 跨模型对照（近 3 天）

| 模型 | assistant 消息 | reasoning 文本为空 | 比例 |
|---|---|---|---|
| 像素星空 Claude:claude-haiku-5-5 | 42 | 42 | **100%** |
| CommandCode:deepseek/deepseek-v4.1-flash | 1138 | 2 | 0.2% |
| 像素星空 GPT:gpt-6-luna | 608 | 3 | 0.5% |
| 像素星空 DS:deepseek-v4.1-flash | 512 | 2 | 0.4% |

```sql
select n.model, count(*) c,
       sum(case when coalesce(json_extract(m.content_json, '$[0].rawTextLength'), -1) = 0 then 1 else 0 end) empty_raw
from narrator_messages m join narrators n on n.id = m.narrator_id
where m.role = 'assistant' and m.created_at > '2026-10-13'
  and json_valid(m.content_json) and m.content_json like '%reasoning%'
group by n.model order by c desc;
```

## 根因

### 主因：上游通道不转发 thinking 明文

NarraFork 解析 `thinking_delta` 的代码本身正常（`server/lib/agent/anthropic-provider.ts` 依次接受
`delta.thinking` / `delta.reasoning_content` / `delta.text`），其它通道都能拿到明文；
只有「像素星空 Claude」100% 拿不到——只收到超大的 `signature`。
推测上游把思考内容编码进了 signature 并丢弃了明文事件。

### 放大因素：NarraFork 的截断续跑不区分有无可见产出

`stop_reason=max_tokens` 一律注入「从中断处继续」，但这种情况**没有中断处可续**：
模型再想一轮，再次撞上限。每轮最多 3 次（`MAX_TURN_INTERRUPTION_RETRIES`），
叠加轮间的自动续跑，形成每 5 分钟一轮的循环。

## 修复

`server/services/turn-continuation-decisions.ts` 的 `planTurnInterruption` 新增分支：

- **判定**：`interruptedReason === "completion_limit"` 且 `hadToolUses === false` 且 `finalText` 为空
- **处理**：首次注入 `tool.thinkingExhaustedContinue`（明确要求「不要再展开思考，直接说出结论或下一步动作」）；
  再次出现同样结果则直接 `stop`，不再烧掉一整轮输出预算
- 判定要求字段显式存在（`=== false` / `!== undefined`），未提供这两个字段的旧调用方行为不变

配套改动：

- `server/lib/i18n.ts`：新增 `tool.thinkingExhaustedContinue` 中英文案 + key 类型
- `server/services/subagent-executor.ts`：`planSubagentInterruption` 入参类型同步放宽
- 测试：`turn-continuation-decisions.test.ts` 新增两例；`subagent-interrupt.test.ts` 的调用补字段

## 复修指引（再次出现时按序核对）

1. **先看模型是否真的零产出**（最关键）
   ```sql
   select id, role, created_at, substr(content_json, 1, 220)
   from narrator_messages where narrator_id = '<ID>' order by created_at desc limit 10;
   ```
   - `rawTextLength: 0` 且 `content_text` 为 null → 符合本文档描述，继续第 2 步
   - `rawTextLength > 0`（有明文）却仍循环 → **不是**这个原因，需要重新排查
2. **看请求计数**
   ```sql
   select created_at, output_tokens, input_tokens from api_requests
   where narrator_id = '<ID>' order by created_at desc limit 12;
   ```
   `output_tokens` 恒等于上限 → 思考耗尽成立
3. **看提示文案**：若注入的仍是「从中断处继续」而非「把全部输出预算消耗在内部思考上……」
   → 修复未生效（检查 exe 是否包含该改动），或走了别的续跑路径
4. **换通道对照**：同一模型换另一个中转，若正常 → 确认是上游通道问题

### 复修入口

| 文件 | 位置 |
|---|---|
| `server/services/turn-continuation-decisions.ts` | `planTurnInterruption`（判定与提示选择） |
| `server/lib/i18n.ts` | `tool.thinkingExhaustedContinue`（文案） |
| `server/services/subagent-executor.ts` | `planSubagentInterruption`（子代理侧入口） |

## 已知未解决

- **根治需要上游转发 `thinking_delta` 明文**；本修复只是让这种情况不再无限循环，并给模型一次直接产出的机会
- 每次请求的 ~200 KB signature 仍会进入历史并回放，本修复未处理（可能推高上下文占用与成本）
- 若上游长期如此，可考虑在适配层识别「该通道 thinking 明文恒为空」并降低其思考预算或改用非 thinking 模型
