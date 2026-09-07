# 同步程序化调用：对照实验协议

当前默认是 `task-call-v4` 实验候选，不代表模型易用性已全部通过。优化前后完整结果见 [优化对照报告](OPTIMIZATION_RESULTS.md)，原基线见 [RESULTS.md](RESULTS.md)。

## 范围

比较 `nugjp:codex:gpt-5.6-luna` 与 `nug2:antigravity:gemini-3.7-flash`，请求 reasoning effort 均为 low。模型名称和实际发出的 effort 字段写入实验结果；不静默换模型。

每个模型/题目使用独立上下文与同一份初始数据，只提供 API.md、当前题目和一个原生 Eval 工具。不提供架构文档、参考答案或评分代码。

Eval 是受限同步对象模拟器，真实执行模型生成的 TS；不调用生产任务数据库或真实 Bash/Read。每次执行在新建、无网络、只读根、限内存/CPU/PID 的 Podman 容器中，只有 runner 文件只读挂载和 stdin 模拟数据，无应用凭据。

本实验评估接口理解、程序化调用和工具错误恢复，不重复评估 SharedArrayBuffer RPC 的吞吐，也不是生产执行器安全验收。模型服务调用在宿主侧进行，与代码执行容器分离。

## 固定预算与评分

- 每题最多 5 次模型响应、6 次 Eval；单次模型请求 120s，响应与代码有字节上限。
- 模型只能调用 Eval；文字中的代码块不当作已执行操作。
- 同一题跨 Eval 保留模拟任务数据，不保留 JS 变量；最终按实际数据、调用顺序和返回值评分。
- 首轮成功：第一次 Eval 后已达到本题目标；最终成功：在预算内达到目标。
- 帮助调用正常计数，不算工具错误；首轮查询/帮助未立即完成任务会使首轮成功为 false，这是指标定义而非违规。
- 模型错误、模拟器/传输问题、上游请求失败分开报告。预设的测试失败/版本冲突不算模型接口错误。
- 保留未经助手改写的 code、Eval 输出、调用 trace、最终状态、通过/失败理由及必要 usage；不保存 API 密钥、请求头或思考内容。

## 场景

1. 对象读取 → 测试 → 分派任务提交，区分 submitted 与 done。
2. 父子计划原子创建，不把计划误当执行。
3. 超出默认范围的归档搜索与分页，不恢复历史。
4. 工具异常后记录阻塞，不假报完成。
5. 测试过程中目标变化，拒绝旧结果后重新读取，不强行覆盖。
6. 根据说明/动作提示或按需帮助选择验收方法，绑定已读提交，不改派或冒称完成。

## 可复现性

runner 与隐藏 fixtures/评分器位于 `tests/task-call-challenges/`。先用固定参考程序验证测试夹具和关键反例，再调用模型；模型永远看不到参考程序。

冻结本轮 API/challenge/fixture 的内容 hash。当前驱动还在模型请求前保存完整输入和源码快照，核对实际 wire 上的 guide、description、code schema 与 low/Eval 声明，并检测运行中源码漂移。若发现夹具错误，保留原始运行并将其标为 harness-invalid；修复后重跑相关两组，不把修复算成某个模型的恢复成功。

方法说明、help 和 Eval description 由 `contract.ts` 共同提供，API.md 由其生成；self-test 和模型运行前都检查生成内容一致。help 定义作为可信 JSON 输入送入容器，不挂载宿主配置、评分器或参考程序。新增公开方法必须通过实际方法枚举与帮助目录比对。

主轮每题每模型一次，是诊断性小样本，不构成模型排名或总体成功率的统计结论。修正夹具后仅对受影响题目配对补跑，结果单列，不混成“最佳成绩”。

## 运行与审计

```bash
# 修改共同契约后重新生成，避免文档/工具/帮助分叉
bun tests/task-call-challenges/run.ts --write-api
bun tests/task-call-challenges/run.ts --self-test
bun tests/task-call-challenges/run.ts
bun tests/task-call-challenges/run.ts --case=4
bun tests/task-call-challenges/analyze.ts docs/task-call-challenges/results/<run>-manifest.json
# 重算旧轨迹的新增诊断指标时，写新路径，不覆盖旧分析
bun tests/task-call-challenges/analyze.ts docs/task-call-challenges/results/<old>-manifest.json --output=docs/task-call-challenges/results/<comparison>-baseline-analysis.json
```

真实模型实验需要已配置的上述 NUG 路由、Podman 和脚本中固定的 Bun 容器镜像。脚本使用 `--pull=never`，不会自动换镜像；启动时先检查 Podman 与固定镜像，依赖缺失时在付费请求前失败。API 客户端不导入会启动应用数据库的完整 provider，不需要也不允许解除生产实例锁。

### 默认离线测试与显式容器验证

```bash
# 默认入口：固定脚本、评分负例、离线 SSE、脱敏和路径测试，无需 Podman 或真实模型配置
bun test tests/task-call-challenges

# 真实容器回放与隔离验证必须显式开启；不会自动拉取镜像
NF_TASK_CHALLENGES_PODMAN=1 bun test --timeout 60000 tests/task-call-challenges/delivery.test.ts

# 固定镜像须由管理员预先准备/导入；确认当前宿主存储包含准确 ID
podman image exists 0d36aaa2c1ad7cccd2dc0cf7fba4efb11ea7193023cecb1c27a84463c9ba01aa

# 自定义 rootless HOME 或 storage.conf 时，在同一配置下检查镜像和运行测试
HOME=/path/to/podman-home CONTAINERS_STORAGE_CONF=/path/to/storage.conf podman image exists 0d36aaa2c1ad7cccd2dc0cf7fba4efb11ea7193023cecb1c27a84463c9ba01aa
NF_TASK_CHALLENGES_PODMAN=1 NF_TASK_CHALLENGES_PODMAN_HOME=/path/to/podman-home CONTAINERS_STORAGE_CONF=/path/to/storage.conf bun test --timeout 60000 tests/task-call-challenges/delivery.test.ts
```

普通测试中的 VM 求值只执行仓库内可信固定脚本，不是生产模型执行器。真实模型的 `executeEval` 始终使用受限 Podman，缺失依赖时不会退回宿主运行。未启用容器验证时，容器用例显示 skip，不能据此宣称容器隔离测试通过。`run.ts --self-test` 是另一条显式容器验证入口。

Podman 预检查、启动和清理共用同一子进程环境。仅 Podman CLI 的 HOME 依次取 `NF_TASK_CHALLENGES_PODMAN_HOME`、测试 preload 保存的 `NARRAFORK_ORIGINAL_HOME`、当前 HOME；保留 `CONTAINERS_STORAGE_CONF`、`XDG_DATA_HOME`、`XDG_RUNTIME_DIR` 等已有配置。测试主进程的 HOME/NARRAFORK_HOME 仍保持隔离，容器内部 HOME 仍为 `/tmp`，不得为了读取镜像而关闭全局 preload。

代码执行镜像为 Bun 1.3.13-debian，镜像 ID 固定在结果中；模拟器在容器中运行 node:vm。它验证同步对象语义，不是此前 Bun 1.3.14 的 Worker/SAB RPC 原型。模型入口使用 Responses / Anthropic Messages 两种网关协议，均只声明 Eval；Gemini 请求 max_tokens=4096、thinking.budget_tokens=1024、output_config.effort=low，Luna 请求 reasoning.effort=low。记录请求字段不等于独立验证网关内部的后端调度。

结果文件不保存思考内容、密钥或请求头。主轮源码、API/challenge 输入有单独快照；原始结果不覆盖，重评分写到 analysis.json。

## 显式交付同期对照（V5，可选实验）

常规 `run.ts` 和生成的 API.md 仍使用 V4。`profiles.ts` 从冻结的 V4 输入建立 A 对照，B 仅增加实验用 `deliver(value, summary?)` 及简短说明；没有输出 schema 校验、自动解包或按评分提前停止。

- return 用于观察；deliver 把所需 value 与可选 summary 分开封存。只有模型明确调用并且脚本正常结束，宿主才终结操作阶段，不再请求模型。
- 交付不等于 task.finish/accept，不修改任务生命周期或权限。错误答案、过早交付仍按原评分失败。
- 正文最多 64 KiB UTF-8，summary 最多 2000 个 JS 字符。交付后 RPC、重复交付、封存时重入或被吞掉的交付错误不能构成成功交付；此前成功业务调用不回滚。同一响应中交付后额外的 Eval 记录为未执行/协议冲突。
- 首阶段：第 3、5 题 × 两个模型 × A/B × 各 2 次；每个模型/题目按 A-B-B-A 交错，共 16 条独立轨迹。轨迹内预算与 low 不变。
- 只有 8 条 B 都严格通过、干净交付且无接口错误/基础设施失败/源码漂移，才追加两个模型各六题一次；最大 28 条。未达门槛不扩跑，不挑最好成绩。
- 统计原严格评分与交付采用率/正确交付率；不能用“采用交付的样本全通过”代替全部 B 轨迹的成功率。省掉最终自然语言响应带来的机械性请求减少单独说明。

```bash
# 默认运行离线 SSE、交付边界、原六题语义与评分负例；冻结运行器的真实容器回放需上面的 opt-in
bun test tests/task-call-challenges
bun tests/task-call-challenges/run.ts --self-test
# 自动保存 profiles、源码、调用 ID、原始轨迹和按 A/B 分组的 comparison
bun tests/task-call-challenges/delivery-experiment.ts
```

此入口产生 `*-delivery-manifest.json` / `*-delivery-comparison.json`。不要直接用按模型合并的通用 analyze.ts 汇总混合 A/B manifest；否则会丢失条件分组。当前模型结果见优化报告末尾的显式交付章节，未胜出的 profile 保持实验 opt-in。

## 一致性说明同期对照（V6，可选实验）

```bash
bun test tests/task-call-challenges
bun tests/task-call-challenges/delivery-experiment.ts --coherent
```

- 本入口 A 是 `2026-09-06T13-35-40-408Z-delivery` 输入中冻结的 V5，B 是重新组织的 V6；**两组都支持同样的 deliver**。不再把 A 误记为没有交付能力。
- 只统一 guide、native/code description、help、workflow note 和目标变化反馈；不新增方法、改变 IIFE/外层 return 取值、放宽状态/权限或改变字节限额。默认 V4 不变，原 V4/V5 入口也保留。
- V6 区分“需要模型判断新资料的观察”与“本轮可答复的阶段性交付”；受阻或等待确认也可交付，不要求业务状态先变 done。说明不在旧文案末尾叠加，长度不得超过冻结 V5。
- 同样按 16 条 A-B-B-A、B 全部干净通过才追加 12 条的门槛运行，保存 `*-coherent-delivery-manifest.json` / `*-coherent-delivery-comparison.json`。两组均统计交付采用率和正确交付率，不能只看已采用子集。
- 运行前保留原 33 项测试，并校准 V5/V6 的正常/失败/目标变化交付、错误码与生命周期、IIFE 行为一致；文本差异单独允许。
- 胜过 V5 仅表明胜过上一轮增量说明，不能直接宣布胜过默认 V4。整个一致性说明包是一项干预，不能把效果归因到其中某一个词。

## 全场景资格验证与用户交接

```bash
bun test tests/task-call-challenges
bun tests/task-call-challenges/run.ts --self-test
bun tests/task-call-challenges/delivery-experiment.ts --qualify
```

- 本模式冻结 V6 的完整 profile，不修改候选文案；两模型 low，全六题各两次，第一轮 1→6、第二轮 6→1，共 24 条独立轨迹。
- 满意门槛为 24/24 按原业务规则严格通过并有效终止。正确的显式交付、正确 Eval 结果之后的自然 end_turn 都合法，不强制 100% 使用 deliver，允许预算内自行纠错。
- 不把预算耗尽、max_tokens/length 截断、未知结束原因、没有执行或最后一个 Eval 的未处理错误当成功。保留上游原始 stop reason，即使响应含工具调用、标准化后显示 tool_use，也不能掩盖截断。
- 资格判断不影响模型何时停止，不自动修正返回形状，也不更改旧 V5/V6 扩跑门槛或历史结论。只有正常完成的当前结果能通过；中途曾达标不算最终成功。
- 保存独立的 `*-qualification-manifest.json` / `*-qualification-comparison.json`，将原业务评分、有效终止和显式交付采用率分开记录。未达到标准时保留失败，针对证据修正后另行冻结完整候选，不挑选补测最优值。
- 按用户最新交接要求，达标后调用 AskUserQuestion，等待用户整理其他未提交改动并明确继续；资格通过本身不授权修改生产代码，也不是上线许可。

## 修正评分器与历史制品

当前修正评分器使用独立的 `GRADER_VERSION`（`task-call-grader-v2`），新 episode/manifest 记录该版本，manifest 同时记录当前 graderHash；不能把修正后的评分等同于历史冻结评分。第一题现在校验真实指定测试及版本证据和 read→Bash→finish 顺序，第二题拒绝额外测试，第四题要求 read→失败测试→block。公开 list 不再泄露用于生成 trace 的内部操作名称。

旧 V4/V5/V6 的题面、公开契约、初始 fixture 与结果文件不修改。新实验允许修正评分器源码，但仍校验冻结源码快照的原 graderHash、题面文本与逐题初始 fixtureHash。A/B 同期实验使用同一份修正评分器；扩跑规则本身保持原样，历史成绩不自动重写。

新 manifest 使用相对其所在目录的制品路径。读取旧绝对路径时，只定位到当前 manifest 目录的同名随附制品，即使旧 checkout 仍存在也不读取它；缺失时直接报错。搬迁时应一并复制 results 目录中的 manifest、输入/源码快照和逐题记录。

分析器默认写入 `*-analysis-task-call-grader-v2.json`，也可通过 `--output=<新文件>` 指定其他新路径；目标已存在时拒绝覆盖。报告同时保留原始与当前评分器版本/哈希及原始通过字段，重评分不能覆盖原始记录。

## 已发现的评分/夹具修正

- 原题 01/04/06 没有要求“裸字符串”，所以状态字符串、顶层带 status 字段的对象都应接受。初版评分器只认字符串造成误报；已统一修正并增加回归校准。题 03 明确要求数组、题 05 明确要求 acceptance 文本，保持原规则。
- v1 模拟器遗漏 help("task.block")，原第四题的帮助/轮次效率不能用于公平比较。补齐公开方法帮助后，对两个模型一起复测第四题。
- 分开报告严格完成与纠正后业务达成。后者允许先被权限/状态保护拦截再改正，但不称为全程正确；不放宽实际业务状态和操作顺序要求。
- 原 scripts 目录被仓库忽略，驱动已移到 tests/task-call-challenges，未修改 .gitignore。对这六个实验文件执行了定向 Biome 格式化；仍有动态 JSON 类型等 86 项 warning，不称为零警告或生产级实现。参考程序、错误反例与额外契约校准均实际执行。
