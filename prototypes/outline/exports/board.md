<!-- 由 prototypes/outline/outline.py export 生成（第 113 个提交）。真相源是 data/log.jsonl，不要手改。 -->

# 任务看板

### 待办（41）
- [p/G8CCrUUY] 「创建人」指 agent 的创建者，还是计划的创建者？ ‹Q1·执行：human:owner·管理：agent:main·#提问› ← 问题
- [p/8NPAfqiW] D1 的例外改成「转成提议、不打断 agent」，可以吗？ ‹Q2·执行：human:owner·管理：agent:main·#提问› ← 问题
- [p/t5G1F2nN] 代批授权：只能逐个计划授权，还是允许责任人设一个会话级默认值？ ‹Q3·执行：human:owner·管理：agent:main·#提问› ← 问题
- [p/iGqfdydQ] 规划阶段默认只读（像现在的计划模式），还是默认宽松？ ‹Q4·执行：human:owner·管理：agent:main·#提问› ← 问题
- [p/7XCKKkng] 主题页要不要标准结构（概述、职责、关键决策、坑、不变量、试过的方案），做成内置模板？ ‹Q5·执行：human:owner·管理：agent:main·#提问› ← 问题
- [p/shELx7W7] 块选择模式与移动端手势的交互细节 ‹Q7·管理：agent:main·#提问 #P0› ← 问题
- [p/uBFCt3q3] 超长页：占位节点按需替换够不够，还是只靠折叠与聚焦？以 P0 性能数据为准 ‹Q8·管理：agent:main·#提问 #P0› ← 问题
- [p/OL2RTQbp] 知识库旧修订：迁移时只迁当前状态，旧修订只读保留多久？ ‹Q9·管理：agent:main·#提问 #P4› ← 问题
- [p/3bxAuIFU] 标签：属性里的字符串数组，还是像 Obsidian 一样每个标签对应一页？ ‹Q10·管理：agent:main·#提问› ← 问题
- [p/UMJvCvWQ] 一个需求跨多个仓库时，项目空间怎么对应多个 projects 行？ ‹Q11·管理：agent:main·#提问› ← 问题
- [p/XzYozzQg] 探索组的对比视图要不要内置「方案 / 结果 / 代价」模板？ ‹Q12·管理：agent:main·#提问 #P4› ← 问题
- [p/ciIOhsMN] 团队任务树什么时候放项目空间、什么时候放会话空间，要不要让用户选？ ‹Q14·管理：agent:main·#提问 #P2› ← 问题
- [p/zNm6LqxY] 可领取池除了「自动领取默认关闭」，要不要按团队配置更多策略？ ‹Q15·管理：agent:main·#提问 #P2› ← 问题
- [p/5gWCGnt3] agent 的在场信息在界面上怎么显示才不吵？ ‹Q16·管理：agent:main·#提问 #P1b› ← 问题
- [p/ydKe7oMn] P0 设计与验证 ‹P0·管理：human:owner› ← 路线图
- [p/gPDU0vgb] 大纲编辑器与实时协同原型，按设计文档 §7.8 的清单验收 ‹管理：human:owner› ← P0
- [p/BFv4Byng] 按时间点读取的性能基准（SQLite 与 PG） ‹管理：human:owner› ← P0
- [p/wBqGEPp7] db-worker 向量扫描基准 ‹管理：human:owner› ← P0
- [p/5QM1KHbG] agent 使用结构化编辑工具的实测：Python 原型已经覆盖了一部分 ‹管理：human:owner› ← P0
- [p/aTj0jdv3] 确认 D6–D15 的建议 ‹管理：human:owner·等前置：P-1› ← P0
- [p/bd2Egjgc] P1a 核心存储、大纲编辑器（先单人，建在协同协议上）、时间机器最小版、会话读权限 ‹P1a·管理：human:owner·等前置：P0› ← 路线图
- [p/kDh2CgDg] P1b 多人实时协同：页订阅、页实时会话、在场信息、大纲事务、agent 的三方合并 ‹P1b·管理：human:owner·等前置：P1a› ← 路线图
- [p/f7vElM5K] P2 替换 spec://，落地多 agent 协作、两档计划与计划模式改造 ‹P2·管理：human:owner·等前置：P1a› ← 路线图
- [p/yxk3tBVg] P3 检索（embedding、rerank、混合检索）、真值维护、计划结项 ‹P3·管理：human:owner·等前置：P2› ← 路线图
- [p/pJciER7x] P4 层（提议、探索、记忆确认、Bot 隔离）与知识库迁移 ‹P4·管理：human:owner·等前置：P3› ← 路线图
- [p/2Ywkt58i] P5 视图编辑器、图谱与图谱时间机器、模板、实体合并、只读导出 ‹P5·管理：human:owner·等前置：P4› ← 路线图
- [p/OdnlnA0S] 表格是否正式进块体？设计文档已把表格写进块体，但标着「表格待定」（§7.7）；单元格里能不能换行（docs 样本里唯一… ‹Q17·执行：human:owner·管理：agent:main·#提问 #P0› ← 问题
- [p/4Z6Wizxz] 提及 `[[…]]` 怎么写：存短 id 还是别名（人和 agent 都用别名，原型正文里存的就是别名，见 [[p/b… ‹Q18·执行：human:owner·管理：agent:main·#提问 #P0› ← 问题
- [p/Gg3kqVYm] 嵌入 `![[…]]` 做成行内节点（设计文档 §7.7 现在这么写），还是只能独占一块？ ‹Q19·执行：human:owner·管理：agent:main·#提问 #P0› ← 问题
- [p/mrNkT2jT] 块内要不要支持数学和图片？不支持的话写入时就得转义，否则只读视图（MarkdownContent）照样会渲染 ‹Q20·执行：human:owner·管理：agent:main·#提问 #P0› ← 问题
- [p/JsCuWe1O] 段内单换行：保留为软换行（显示成空格），还是统一规范成硬换行？ ‹Q21·执行：human:owner·管理：agent:main·#提问 #P0› ← 问题
- [p/i4dnplQK] agent 写入列表、多段等方言外的结构时怎么办：拒绝、拆成子块，还是转义成普通文本？ ‹Q22·执行：human:owner·管理：agent:main·#提问 #P0› ← 问题
- [p/iRCYt4KJ] 块内转义用哪种策略：最小转义（好读，对 agent 写入的改动少，但要对三个解析器做模糊测试），还是 Tiptap 式… ‹Q23·执行：human:owner·管理：agent:main·#提问 #P0› ← 问题
- [p/e4GX76E5] 标题级别用 1–6 还是 1–3？分隔线要不要做成块体（docs 样本里 `---` 有 135 处）？ ‹Q24·执行：human:owner·管理：agent:main·#提问 #P0› ← 问题
- [p/aygA8oG9] 任务反思：采纳 Q13 的调研建议吗？建议是不改成可选，等 P2 补齐四个缺口后，把门禁、两个决策工具、`spec_p… ‹Q25·执行：human:owner·管理：agent:main·#提问 #P2› ← 问题
- [p/E3mTuA2I] `/goal` 建的任务默认按草稿还是按已批准处理？调研建议默认按已批准：`/goal` 是用户在说「务必完成」；按草… ‹Q26·执行：human:owner·管理：agent:main·#提问 #P2› ← 问题
- [p/jrRCI1E3] Spec 文件以什么方式编辑：继续以所见即所得为主（补上表格、任务列表、图片扩展，长期保留检测），还是改成源码优先、所… ‹Q27·执行：human:owner·管理：agent:main·#提问› ← 问题
- [p/DszXEDMJ] 检测到编辑器保不住的语法（表格、HTML、图片、任务列表、脚注、front matter）时怎么处理：禁止在所见即所得… ‹Q28·执行：human:owner·管理：agent:main·#提问› ← 问题
- [p/FUd5vw6c] Tiptap 版本：整套 @tiptap/* 升到 3.32.0（修好单元格里竖线转义和 `<br>`，但要回归 In… ‹Q29·执行：human:owner·管理：agent:main·#提问› ← 问题
- [p/2npkqyKh] 非 .md 的 spec 文件（agent 建的 .json、.yaml 等）和 behavior_fence，是否一… ‹Q30·执行：human:owner·管理：agent:main·#提问› ← 问题
- [p/aPJZmbvr] 数据恢复：要不要做 spec 的历史查看和恢复功能？要不要先离线排查一遍现有数据库里被 UI 保存吞掉表格的记录？ ‹Q31·执行：human:owner·管理：agent:main·#提问› ← 问题

### 进行中（2）
- [p/H0a1nXuL] 大纲系统路线图：建成知识、记忆与任务的统一平台 ‹路线图·管理：human:owner›
- [p/DrYdFrth] P-1 Python 原型与自用：先用原型承载这份计划，真实推进，从使用中发现问题 ‹P-1·执行：agent:main·管理：human:owner› ← 路线图

### 受阻（1）
- [p/sdn8PPim] 用原型推进剩下的决策，用的过程中把问题记到「原型发现」 ‹执行：agent:main·管理：human:owner·等：等负责人回答收件箱里的 20 条提问（每条都带建议，可以一次采纳）› ← P-1

### 完成（14）
- [p/sxbH6X7b] 块内 markdown 方言支持哪些行内语法和块体？规范写法怎么定？ ‹Q6·执行：agent:w-dialect·管理：agent:main·#提问 #P0› ← 问题
- [p/WxOgq9RU] 任务反思是否保留为可选的完成证据核查？ ‹Q13·执行：agent:w-reflection·管理：agent:main·#提问 #P2› ← 问题
- [p/vIkPD0xT] 真相源放哪里？ ‹执行：human:owner·管理：agent:main·#提问› ← 已回答
- [p/Z50dD22z] 要不要多人实时协同编辑同一个块？ ‹执行：human:owner·管理：agent:main·#提问› ← 已回答
- [p/8jNsS3fV] 每块一个编辑器可以吗？ ‹执行：human:owner·管理：agent:main·#提问› ← 已回答
- [p/Q9jT9DZk] agent 能不能批准计划和变更？ ‹执行：human:owner·管理：agent:main·#提问› ← 已回答
- [p/uHnUVJL1] 搭原型：块、链接、提交、时间机器、任务、两档计划、变更请求、断言与锚点 ‹执行：agent:main·管理：human:owner› ← P-1
- [p/NVqKvrzA] 把这次的计划录进原型 ‹执行：agent:main·管理：human:owner› ← P-1
- [p/RsN47wP2] 时间机器的 HTML 查看器：静态页，拖时间轴看大纲怎么变 ‹执行：agent:main·管理：human:owner› ← P-1
- [p/SYEAKBsz] 多 agent 试用：子代理领任务、写结果、提交验收，管理者代批 ‹执行：agent:main·管理：human:owner› ← P-1
- [p/dtLLZ8zT] 新鲜度检查对着最新的 main 跑一次（先 fetch） ‹执行：agent:main·管理：human:owner› ← P-1
- [p/eYUSIhDP] 把原型发现整理回设计文档 ‹执行：agent:main·管理：human:owner› ← P-1
- [p/UV8qXrr2] 设计文档讨论稿 ‹管理：human:owner› ← P0
- [p/5nB0TYwk] 核实：在 SpecMarkdownEditor 里编辑含表格的 spec 文件并保存，表格会不会丢；属实就给出修复方案… ‹执行：agent:w-table·管理：agent:main·#核实› ← 现状spec

