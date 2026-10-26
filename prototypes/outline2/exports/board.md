<!-- 由 prototypes/outline2/outline.py export 生成（第 372 个提交）。真相源是 data/log.jsonl，不要手改。 -->

# 任务看板

### 进行中（2）
- [p/H0a1nXuL] [/] 大纲系统路线图：建成知识、记忆与任务的统一平台
- [p/DrYdFrth] [/] P-1 Python 原型与自用：先用原型承载这份计划，真实推进，从使用中发现问题 @agent:main ← 路线图

### 待办（15）
- [p/ydKe7oMn] [ ] P0 设计与验证 ← 路线图
- [p/bd2Egjgc] [ ] P1a 核心存储、大纲编辑器（先单人，建在协同协议上）、时间机器最小版、会话读权限 ‹等前置：P0› ← 路线图
- [p/kDh2CgDg] [ ] P1b 多人实时协同：页订阅、页实时会话、在场信息、大纲事务、agent 的三方合并 ‹等前置：P1a› ← 路线图
- [p/f7vElM5K] [ ] P2 替换 spec://，落地多 agent 协作、两档计划与计划模式改造 ‹等前置：P1a› ← 路线图
- [p/yxk3tBVg] [ ] P3 检索（embedding、rerank、混合检索）、真值维护、计划结项 ‹等前置：P2› ← 路线图
- [p/pJciER7x] [ ] P4 层（提议、探索、记忆确认、Bot 隔离）与知识库迁移 ‹等前置：P3› ← 路线图
- [p/2Ywkt58i] [ ] P5 视图编辑器、图谱与图谱时间机器、模板、实体合并、只读导出 ‹等前置：P4› ← 路线图
- [p/sdn8PPim] [ ] 用原型推进剩下的决策，用的过程中把问题记到「原型发现」 @agent:main ← P-1
- [p/aTj0jdv3] [ ] 确认 D6–D15 的建议 ‹等前置：P-1› ← P0
- [p/erXdou0A] [ ] 核实：公开分享链接能不能看到会话里注入的知识内容 ← 调研：知识库现在怎么检索、注入、
- [p/12SC55ZX] [ ] 实测 compact、fork、回退时注入内容和 `knowledge_injection_events` 账本的表现（现在是读代码推断） ← 调研：知识库现在怎么检索、注入、
- [p/lElgFPJW] [ ] 在 PG 后端上跑一遍检索和 ACL 的探针（这次只跑了 SQLite） ← 调研：知识库现在怎么检索、注入、
- [p/CJUTlph7] [ ] 端到端验证两个推断：Task 派发的子代理初始 prompt 也会被扫；pass 重启时可能陆续注入超过 3 条 ← 调研：知识库现在怎么检索、注入、
- [p/6yOuvxoQ] [ ] 把 SQL 谓词版 ACL 在大知识库上的性能放进 P0 基准 ← 调研：知识库现在怎么检索、注入、
- [p/cp4IAr6P] [ ] 真机测输入法和移动端软键盘：§6.9 第 2 项，以及 Safari、iOS、Android 和 macOS、Windows 上的真实输入法；先看组合中收到不经输入法的 Enter 会不会拆块 ← P1a

### 完成（18）
- [p/5nB0TYwk] [x] 核实：在 SpecMarkdownEditor 里编辑含表格的 spec 文件并保存，表格会不会丢；属实就给出修复方案（来自 Q6 调研的顺带发现 [[p/f3TO9Yre]]） @agent:w-table ← 现状spec
- [p/uHnUVJL1] [x] 搭原型：块、链接、提交、时间机器、任务、两档计划、变更请求、断言与锚点 @agent:main ← P-1
- [p/NVqKvrzA] [x] 把这次的计划录进原型 @agent:main ← P-1
- [p/RsN47wP2] [x] 时间机器的 HTML 查看器：静态页，拖时间轴看大纲怎么变 @agent:main ← P-1
- [p/SYEAKBsz] [x] 多 agent 试用：子代理领任务、写结果、提交验收，管理者代批 @agent:main ← P-1
- [p/dtLLZ8zT] [x] 新鲜度检查对着最新的 main 跑一次（先 fetch） @agent:main ← P-1
- [p/eYUSIhDP] [x] 把原型发现整理回设计文档 @agent:main ← P-1
- [p/UV8qXrr2] [x] 设计文档讨论稿 ← P0
- [p/gPDU0vgb] [x] 大纲编辑器与实时协同原型，按设计文档 §6.9 的清单验收 ‹待整理› ← P0
- [p/BFv4Byng] [x] 按时间点读取的性能基准（SQLite 与 PG） ‹待整理› ← P0
- [p/wBqGEPp7] [x] db-worker 向量扫描基准 ‹待整理› ← P0
- [p/5QM1KHbG] [x] agent 使用结构化编辑工具的实测：Python 原型已经覆盖了一部分 ‹待整理› ← P0
- [p/8PsVaMVZ] [x] 第三轮：按第二版改原型（复选框任务、锁定、待确认、依据从运行记录挂接、代码锚点），重跑同类任务，对比协调成本、命令数和查帮助次数 @agent:main ← P-1
- [p/N5cdiUhM] [x] 调研：一个需求跨多个仓库时，会话、工作目录和项目现在怎么对应，多工作区以后该怎么对应 @agent:w-xrepo ← Q11
- [p/lPnCUsBy] [x] 整理试跑：整理 agent（较便宜的模型）只看 `settle` 的输出，把 Q11 的调研整理进事实树 @agent:main ← P-1
- [p/ccBGXE4T] [x] 调研：知识库现在怎么检索、注入、过滤权限；换成大纲的混合检索和「相关知识」视图时，哪些行为要保留、哪些是缺陷 @agent:w-kb ← P3
- [p/Vww0RyM1] [x] 第四轮：专注调研知识库检索与注入 → 派活的会话记摘要、提问、遗留 → 整理 agent 放进事实树 → 新起一个 agent 测找不找得到 @agent:main ← P-1
- [p/LxVmXH4D] [x] 清积压：四个整理 agent 把 12 个旧任务和刚回答的 37 条提问整理进事实树 @agent:main ‹待整理› ← P-1

