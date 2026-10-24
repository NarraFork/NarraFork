# 大纲原型

在动手做正式系统之前，用一个最小的 Python 原型把 `docs/OUTLINE_KNOWLEDGE-DESIGN.md` 的模型跑起来，拿真实工作试用，从使用中发现设计问题。

- 单文件、只用标准库：`outline.py`（Python ≥ 3.11）。
- **真相源是 `data/log.jsonl`**：只追加的提交日志。所有状态都由回放日志得到；时间机器就是「回放到第 N 个提交为止」。
- `exports/` 下的 markdown 只是视图，由 `python3 outline.py export` 生成，不要手改。
- `data/.local/` 是本地缓存（agent 的读取记录、新鲜度检查结果），不入库。

原型只实现验证设计所需的部分：块、类型、链接、空间、提交、时间机器、任务与领取、两档计划与变更请求、代批与责任人、提议（个人空间、D1 例外）、断言与代码锚点、新鲜度、检索、提问与批量回答、报告挂回、注意范围、提炼候选、归档。没有实时协同、embedding、ACL，也不真的执行命令（「执行」级别只记录）。

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

每个命令都以某个参与者的身份执行：`--as agent:main`，或者环境变量 `OUTLINE_ACTOR`，默认 `agent:main`。每次写入都会回显「以谁的身份写入」。

- **子代理开工前先设好自己的身份**：`export OUTLINE_ACTOR=agent:<名字>`。不设的话，读写都算在 agent:main 头上，连读取记录（并发检查用）也会记错。
- `human:owner` 是项目负责人。**agent 只有在负责人明确说了的时候，才用 `--as human:owner` 代为记录**（比如负责人在对话里说「批准」「按建议回答」）。
- 子代理先登记：`python3 outline.py actor agent:<名字> --creator agent:main`。它的责任人沿创建链上溯到人。
- 三件事分开记，不再共用一个「代」字：
  - **作者**：`--as` 的身份，内容算谁的；
  - **代记人**：`--by agent:<自己>`（或 `OUTLINE_RECORDED_BY`），替别人把内容记进大纲时写上自己。协调者替专注 agent 记它报告里的结论、替负责人记他在对话里的决定，都用这个；
  - **责任人**：系统沿创建链自动算出，不用写。
- `log` 和 `export` 显示成「agent:w-dialect，由 agent:steward 代记（责任人 human:owner）」。

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

- **别名**：`alias=Q?` 自动取下一个空号（Q27、Q28……），同一批里的多条依次编号。别名在空间内唯一，重复会报错；已删除的块不占用别名。
- `--md` 带 `--after` 时，所有顶层条目依次接在它后面。续行里的空行和代码块原样保留，代码块里以 `- ` 开头的行不算新条目。
- 正文里行内代码中的 `[[…]]` 是字面文字，不算提及。

大纲行的写法：`- [类型:状态或立场] 正文 {#标签 键=值 角色=目标}`。类型有 `note`（默认）、`task`、`assert`、`view`。`#标签` 只在这一次插入里有效，用来互相引用。

链接目标：块地址（`p/xxxx`、别名、`#标签`），或者外部地址 `code:路径#符号`、`grep:正则@路径`、`file:路径`、`url:`、`commit:`、`tool:`、`chat:`、`report:`、`human:`、`space:空间`、`ws:设备:目录`。

- `based_on` 指向代码时会记下指纹，之后用 `fresh` 检查是否过期。符号支持 TS/JS 和 Python 的声明。还没合进 main 的文件（比如这个原型自己）加 `--ref HEAD`，`fresh` 之后也按 HEAD 检查。
- `file:` 证据会记下内容指纹，仓库里的文件再记提交号。指向仓库外的临时文件会提示：报告类的文件先用 `attach` 放进大纲。
- 断言带了 `evidence` 或 `based_on` 就直接是「采纳」；agent 写的、没有依据的记为「假设」。

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

## 提问与回答

```bash
python3 outline.py add p/问题 "[task] 要不要 X？ {alias=Q? owner=human:owner tags=提问,P0}"
python3 outline.py add p/Q27 "[task] 调研 X {owner=agent:w-x}"          # 需要先调研：在提问下建调研子任务
python3 outline.py add p/Q27 "[assert] 建议：做 X，因为 … {tags=建议 evidence=…}"   # 调研完写建议
python3 outline.py --as human:owner answer Q27 Q28 Q30                 # 负责人：一次采纳多条建议
python3 outline.py --as human:owner answer Q29 --text "不做，因为 …"     # 不同意的单独回答
```

- 提问的执行者是做决定的人（通常是 `human:owner`），不是调研的 agent。调研是提问下的子任务；调研做完，在提问下写一条带 `tags=建议` 的块，提问就会带着建议出现在负责人的收件箱里，收件箱末尾给出一次全部采纳的命令。
- 人的提问只能由本人回答；agent 转述时用 `--as human:owner --by agent:<自己>`。
- 回答写成提问下的「回答」子块，提问标为完成，回答作为证据；采纳的建议如果是断言，立场变成「采纳」。

## 报告挂回

```bash
python3 outline.py --as agent:w-x --by agent:steward attach p/<任务> 报告.md
```

把专注 agent 的 markdown 报告转成任务下的一棵子树：标题成为父块，段落、表格、代码块、引用各成一块，列表按缩进嵌套，紧跟在段落后面的列表挂在那个段落下面。原来指向这个文件的 `file:` 链接会改指到挂好的块，报告文件之后删掉也没关系。

## 注意范围

```bash
python3 outline.py scope show agent:w-x                          # 它的泡，以及最近读过的范围外内容
python3 outline.py scope add agent:w-x p/<页> --level 修改       # 级别：关注 / 修改 / 执行
python3 outline.py scope add agent:w-x ws:staging-a:/srv --level 执行 --until 30m
python3 outline.py scope rm agent:w-x p/<页>                      # 缩小范围不需要批准
```

- 范围是 agent 会话空间（`s.<名字>`）里别名为「范围」的页，泡就是这页上的「涉及」链接，链接上写级别和期限。没有范围页的 agent 不受限制；有了之后，只能在泡内和自己的会话空间里直接写。
- 泡外可以读、可以搜，结果标「范围外」，读过什么会记下来给上级看。泡外写入会自动转成「扩大范围」请求，附上这次操作；批准后泡加上，操作也执行。
- 谁来批：从派它的会话开始沿创建链往上，第一个自己的范围覆盖新泡的 agent 批；都不行就由人批。工作区的「执行」只有人，或自己明确有这一级的上级能给。期限从批准时算起。
- agent 自己加「关注」级别的泡直接生效（只影响注入和路由）；自己加「修改」「执行」要批。范围页上的泡只能用 `scope` 命令改。

## 知识

```bash
python3 outline.py fresh [--fetch]          # 按各锚点建立时的 ref 检查（默认 origin/main）；--fetch 先拉最新 main
python3 outline.py verify p/<断言> fresh|update|refuted [--evidence ...]   # 假设复核成立、带上证据就变成采纳
python3 outline.py candidates p/<计划根>     # 结项：提炼候选（结论、负面知识、遗留、过程）
python3 outline.py archive p/<计划根>
```

## 给 agent 的约定

- 开工先 `export OUTLINE_ACTOR=agent:<名字>`。
- 先 `read` 再 `edit`；读取记录在本地缓存里，用来做并发检查。
- 写知识时尽量带上 `based_on`（代码锚点）和 `evidence`；有依据的结论直接采纳，没有的记为「假设」。
- 被转成提议、变更请求或扩大范围请求时，命令会告诉你交给了谁；先做不受影响的部分，不用等。
- 用原型时发现的问题，记到项目空间的「原型发现」页里（见 `pages`），不要只写在对话里。
