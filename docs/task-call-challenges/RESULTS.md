# 同步程序化工具调用：Luna low / Gemini Flash low 诊断结果

> 本文保留优化前基线。后续流程/description 的完整两轮结果见 [优化对照报告](OPTIMIZATION_RESULTS.md)。当前 API.md 已更新，当时模型实际收到的文本以 [v1 输入快照](results/challenge-inputs-v1.json) 为准。

## 结论

**两个模型都能使用同步 Task 对象和真实的原生 Eval 调用；主要障碍不是 await、对象语法或循环，而是业务动作选择、帮助覆盖和验收的已读条件。**

它们在预算内都到达了六题的目标业务状态。Luna 在验收题中先误用 finish，再漏掉新 Eval 中的 read，经过宿主拒绝后才完成；因此不能说它全程正确。

这是固定六题、每模型一条主轨迹的小样本诊断，不是模型排名、生产工具集成验收或安全测试。

## 实验配置

- 模型：`nugjp:codex:gpt-5.6-luna`、`nug2:antigravity:gemini-3.7-flash`。
- 主轮：`2026-09-06T09-34-44-554Z`；两边各六题。
- 复验：`2026-09-06T09-53-49-584Z`；修正帮助缺口后，两边一起补跑第四题。
- 只给 [API.md](API.md) 和对应 challenge，不给架构设计、fixtures、评分器或参考程序。
- 唯一原生工具为 Eval；每次接收模型生成的 TS 后，在无网络、只读根、限 CPU/内存/PID 的 Podman 容器里实际执行同步对象模拟器。
- 全部模型请求均记录了准确路由、`effort=low` 和仅有 Eval 的工具列表。没有中途替换模型。
- 最多 5 次模型响应 / 6 次 Eval；每请求 120s。没有将模型正文中的代码块当作已执行操作。

## 主轮结果（按统一修正后的评分规则）

“严格完成”要求目标状态、返回值与顺序正确，且没有尝试题目禁止的业务动作。“业务达成”另统计被保护机制拒绝后最终修正的情况，不代表全程没有错误。

| 指标 | GPT-5.6-Luna low | Gemini 3.7 Flash low |
|---|---:|---:|
| 严格完成 | 5/6 | 6/6 |
| 纠正后业务目标达成 | 6/6 | 6/6 |
| 首次 Eval 可执行 | 6/6 | 6/6 |
| 第一次 Eval 即完成整题 | 2/6 | 1/6 |
| Eval 总调用数 | 17 | 17 |
| 帮助调用数 | 1 | 4 |
| await/async 等契约误用 | 0 | 0 |
| `.ref` / `tasks.start(task.ref)` 用法 | 未出现 | 未出现 |

**注意：Gemini 主轮第四题碰到了模拟器的帮助缺口，因此该题帮助次数/轮次不用于效率比较。** 它仍成功记录了实际测试错误并将任务设为 blocked；修正环境后的结果见下表。

首次 Eval 通常只是读取自然语言验收要求，不能把“没有一次做完整题”解释成不会使用接口。业务状态也不由最终自然语言总结决定，而由容器内实际状态与调用 trace 确认。

### 按题结果

| 题目 | Luna | Gemini Flash | 观察 |
|---|---|---|---|
| [01 当前分派任务](01-current-task.md) | 通过，3 Eval | 通过，2 Eval | 都先测试后报告，正确得到 submitted 而非越过验收 |
| [02 建立父子计划](02-plan-tree.md) | 通过，1 Eval | 通过，1 Eval | 都用一次 add(children) 创建计划，保持 todo |
| [03 归档分页查询](03-archived-pages.md) | 通过，1 Eval | 通过，3 Eval | 都拿到四个匹配 key；Luna 一段循环完成，Flash 额外复核了筛选结果 |
| [04 测试失败](04-test-failure.md) | 通过，3 Eval | 达成，5 Eval；帮助夹具有缺口 | 都最终记录真实失败原因，没有报完成 |
| [05 目标变更](05-changed-contract.md) | 通过，4 Eval | 通过，3 Eval | 都没有用旧测试结果覆盖新目标，重新读取 acceptance 后停止 |
| [06 验收子代理](06-review-handoff.md) | 修正后达成，5 Eval；严格不通过 | 通过，3 Eval | Luna 先 finish 被拒，再 accept 因未重读被拒，最后 read+accept 成功 |

### 第四题配对复验

API/challenge 文本与模拟数据保持不变，只补全已发布方法的帮助；没有向某个模型单独提示答案。

| 模型 | 结果 | Eval | 帮助 | 未预设错误 |
|---|---|---:|---:|---|
| Luna low | 严格通过 | 3 | 0 | 无 |
| Gemini Flash low | 严格通过 | 5 | 1 | 无 |

复验确认正确帮助可用且两边仍能完成。单次采样下轮次并未显著减少，不能据此宣称帮助补全带来稳定的速度提升。

## 三个关键发现

### 1. 同步对象写法已经可用，不需要先教异步编程

两边都能使用 task.read / task.finish / task.block 和对象返回值。没有 await、Promise、手工 ref 管理造成的失败。

Luna 的分页程序在一次 Eval 中完成全部页读取；原始代码如下，未替它修正：

```ts
const p = tasks.list({ agent: "qa", relation: "participated", archived: "only", search: "回归" }); const out = []; let page = p; for (;;) { page.items.forEach(t => out.push(t.key)); if (!page.hasMore) break; page = page.next(); } return out;
```

这支持继续沿同步对象接口推进，但没有与原生独立工具做 A/B，不能据此声称必然更省 token 或更少模型往返。

### 2. 业务动作比语法更容易混淆

Luna 在第六题已经读到 submitted，却尝试：

```ts
const t = tasks.get("T21", {archived:"include"}); return t.finish("验收通过：键盘可访问与对比度检查均通过。");
```

宿主拒绝后，它查帮助并使用 accept，但在新的 Eval 中没有重新 read，又被拒绝。最后在同一个 Eval 中 read+accept 才成功。错误操作没有实际越权生效。

建议：

- submitted 的管理者视图应直接给出“查看提交 / 验收 / 打回”动作提示，不只显示状态词。
- 错误反馈给出正确动作的最短用法，避免只说“查询帮助”。
- 验收仍绑定确实读过的提交版本，不为降低难度而自动把 finish 当成 accept。
- 跨 Eval 的已读凭据是否可安全复用，可另做设计/对照实验；本轮没有放宽该规则。

### 3. 帮助和评分器本身也需要测试

v1 的 help("task.block") 返回 UNKNOWN_HELP，这属于模拟器缺口，不应归咎于模型。生产帮助应从已发布方法定义生成，所有公开方法都能查询。

初版评分器只接受裸状态字符串，但原题并未要求这种格式。Luna 返回 `{finish: ..., status: "submitted"}`、Flash 返回 `{status: "blocked", details: ...}` 都符合业务要求，因此统一增加了顶层 status 对象支持，并保留了原始评分文件。

这只是修正格式误判，**没有**放宽“先测试后报告”“不得越权”“必须分页”或“旧目标不能完成”的约束。原始代码没有被主助手修补后再算作模型成功。

## 可复核证据

- [主轮原始 manifest](results/2026-09-06T09-34-44-554Z-manifest.json)
- [主轮统一重评分](results/2026-09-06T09-34-44-554Z-analysis.json)
- [第四题配对复验 manifest](results/2026-09-06T09-53-49-584Z-manifest.json)
- [第四题复验分析](results/2026-09-06T09-53-49-584Z-analysis.json)
- [初版模拟器/评分器源码快照](results/2026-09-06T09-34-44-554Z-sources-before-correction.json)
- [复验源码快照](results/2026-09-06T09-53-49-584Z-sources.json)
- [模型实际收到的 API 与 challenge 文本](results/challenge-inputs-v1.json)
- [Luna 的验收题完整轨迹](results/2026-09-06T09-34-44-554Z-luna-6.json)

原始 JSON 中的 `finalPass` 是初版自动评分，可能包含已说明的格式误判；以 analysis.json 的重评分及本报告解释为准，原记录不覆盖。

运行方式与评分定义见 [PROTOCOL.md](PROTOCOL.md)。已校准 6 个参考程序、6 个错误反例、3 个状态对象返回、task.block 帮助回归和 async 拒绝。

## 限制与下一轮建议

- 模拟 Eval 验证的是对象语义和模型工具调用，不验证生产 Worker/SAB、真实数据库、真实文件工具或审批恢复。
- 两个模型经不同网关协议调用；token 统计保存在原始数据中，但不适合直接据此比较思考强度或成本。
- 仅单次主轨迹，缺少多种随机种子、复杂输入和长期会话；不形成模型能力排名。
- 接下来优先测试“上下文动作提示 + 完整帮助”的效果，再增加跨回合变量误用、部分提交、超时恢复和更多真实工具适配。不要直接以本次 6/6 的最终业务达成率宣布接口已经足够简单。
