# 大纲原型

在动手做正式系统之前，用一个最小的 Python 原型把 `docs/OUTLINE_KNOWLEDGE-DESIGN.md` 的模型跑起来，拿真实工作试用，从使用中发现设计问题。

- 单文件、只用标准库：`outline.py`（Python ≥ 3.11）。
- **真相源是 `data/log.jsonl`**：只追加的提交日志。所有状态都由回放日志得到；时间机器就是「回放到第 N 个提交为止」。
- `exports/` 下的 markdown 只是视图，由 `python3 outline.py export` 生成，不要手改。
- `data/.local/` 是本地缓存（agent 的读取记录、新鲜度检查结果），不入库。

原型只实现验证设计所需的部分：块、类型、链接、空间、提交、时间机器、任务与领取、两档计划与变更请求、代批与责任人、提议（个人空间、D1 例外）、断言与代码锚点、新鲜度、检索、提炼候选、归档。没有实时协同、embedding、ACL。

## 快速上手

```bash
cd prototypes/outline
python3 outline.py pages                 # 各空间的页
python3 outline.py read p/<短id> -d 3    # 读一棵子树（地址也可以用别名，例如 p/D1）
python3 outline.py board                 # 任务看板
python3 outline.py inbox                 # 负责人的收件箱：待决定、待验收、待回答、值得看一眼
python3 outline.py search 关键词 关键词   # 检索（默认不含否定、已被取代、归档）
python3 outline.py log -n 20             # 提交记录
python3 outline.py read p/<短id> --as-of 12   # 时间机器：第 12 个提交时的样子
python3 outline.py diff 10 20            # 两个提交之间的变化
python3 outline.py export                # 生成 exports/*.md
```

## 身份

每个命令都以某个参与者的身份执行：`--as agent:main`，或者环境变量 `OUTLINE_ACTOR`，默认 `agent:main`。

- `human:owner` 是项目负责人。**agent 只有在负责人明确说了的时候，才用 `--as human:owner` 代为记录**（比如负责人在对话里说「批准」）。
- 子代理先登记：`python3 outline.py actor agent:<名字> --creator agent:main`。它的责任人沿创建链上溯到人。
- 提交里会记下 `on_behalf_of`（责任人）。

## 写入

```bash
# 新建一页（在空间 p 顶层）
python3 outline.py add p/ "页标题"
# 在某个块下面新增一条，可以带类型、状态、属性和链接
python3 outline.py add p/<父> "[task] 做某事 {owner=agent:main tags=提问}"
python3 outline.py add p/<父> "[assert:accepted] 结论 {based_on=code:server/x.ts#fn evidence=tool:...}"
# 一次插入一段 markdown 大纲（标准输入）
python3 outline.py add p/<父> --md - <<'EOF'
- [task] 步骤一 {#s1}
- [task] 步骤二 {blocked_by=#s1}
  - 笔记，引用 [[#s1]]
  - 续行（不以「- 」开头）会并进上一条，表格、代码块就这么写
EOF
python3 outline.py edit p/<块> "新正文"          # 按你读到的版本检查；别人改过就拒绝
python3 outline.py set p/<块> tags=a,b alias=D1   # 设置属性；k= 表示删除
python3 outline.py mv p/<块> p/<新父> [--after p/<兄弟>]
python3 outline.py rm p/<块>
python3 outline.py link p/<块> based_on code:server/x.ts#fn   # 角色：mention embed based_on evidence supersedes blocked_by touches same_as source
```

大纲行的写法：`- [类型:状态或立场] 正文 {#标签 键=值 角色=目标}`。类型有 `note`（默认）、`task`、`assert`、`view`。`#标签` 只在这一次插入里有效，用来互相引用。

链接目标：块地址（`p/xxxx`、别名、`#标签`），或者外部地址 `code:路径#符号`、`grep:正则@路径`、`url:`、`commit:`、`tool:`、`chat:`、`report:`、`human:`。`based_on` 指向代码时会记下指纹，之后用 `fresh` 检查是否过期。

## 任务与计划

```bash
python3 outline.py task start p/<任务>               # 开始做即领取
python3 outline.py task block p/<任务> --reason "等 X"
python3 outline.py task done p/<任务> --evidence commit:abc123
python3 outline.py task accept p/<任务>               # 管理者或批准人验收
python3 outline.py --as human:owner plan approve p/<计划根> [--delegate agent:mgr]
python3 outline.py cr list | cr show CR1 | cr approve CR1 --note ... | cr reject CR1
```

- 计划默认是草稿，随情况改。人批准之后，骨架冻结：改步骤内容、加减步骤、取消或移动步骤，会自动转成变更请求，相关任务标为受阻；推进状态、在步骤下写笔记、把叶子步骤拆成子任务不受影响。
- 获授权的 agent 可以代批步骤层面的变更请求，但不能自批，也不能批目标和验收（计划根和它直接挂着的非任务块）。
- agent 写个人空间 `me`、删除或移动团队之外的人写的块、单次改动超过 50 个已有块，会转成提议，不打断 agent。

## 知识

```bash
python3 outline.py fresh [--fetch]          # 对照 origin/main 检查代码锚点；--fetch 先拉最新 main
python3 outline.py verify p/<断言> fresh|update|refuted [--evidence ...]
python3 outline.py candidates p/<计划根>     # 结项：提炼候选（结论、负面知识、遗留、过程）
python3 outline.py archive p/<计划根>
```

## 给 agent 的约定

- 先 `read` 再 `edit`；读取记录在本地缓存里，用来做并发检查。
- 写知识时尽量带上 `based_on`（代码锚点）和 `evidence`；没有依据的结论会被记为「假设」。
- 用原型时发现的问题，记到项目空间的「原型发现」页里（见 `pages`），不要只写在对话里。
