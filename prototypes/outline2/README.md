# 大纲原型（第二版）

按设计文档第二版（`docs/OUTLINE_KNOWLEDGE-DESIGN.md`）实现，用来跑第三轮试用。第一版和它的两轮试用记录在 `../outline/`。

- 真相源是 `data/log.jsonl`：只追加的提交日志。第一个提交是从第一版导入的当前状态，不带历史。
- `exports/` 是生成的视图，不要手改。

## 开工

```bash
cd prototypes/outline2
export OUTLINE_ACTOR=agent:<你的名字>    # 派你的会话会告诉你名字
```

## 常用的五个命令

```bash
python3 outline.py read <地址> [-d 深度]     # 读一页或一棵子树
python3 outline.py search 关键词 …           # 检索
python3 outline.py add <父> --md - <<'EOF'    # 用 markdown 大纲写，一次写多条
- 一条结论。提到代码就写位置，比如 `server/routes/spec.ts:183`
- [ ] 一个任务 @agent:x
  depends:: [[另一个任务的标题]]
EOF
python3 outline.py edit <地址> --box x        # 勾复选框
python3 outline.py ask <父> "问题" --option 甲 --option 乙 --recommend 1 --reason "…" [--bundle 包名]
```

地址可以写短 id（`p/Ab3dEf9Q` 或 `Ab3dEf9Q`）、别名（`Q17`）或标题。

## 写法

- 列表项就是块，缩进就是层级。`[[标题或别名]]` 是链接，`![[…]]` 把别处的块嵌进来。同一次写入里的条目可以按标题互相链接。
- 任务就是复选框：`[ ]` 待办、`[/]` 进行中、`[x]` 完成、`[-]` 取消。`@agent:x`、`@human:owner` 是指派。
  - 勾成 `[/]` 就是开始做，也就是领取；别人正在做的会告诉你是谁。
  - 任务下一行可以写 `depends:: [[…]]`（前置）、`due:: 2026-11-01`、`alias:: Q?`（自动编号）、`tags:: a, b`。
- 提到代码就写位置：`路径:行号` 或 `路径#符号`。系统会把它变成锚点，挂上依据；代码以后变了，这块会标「代码已变」。依据不用自己写。
- 试过不行的方案、被推翻的结论：`outline.py invalid <地址> --reason "…"`。
- 需要人决定的事用 `ask`，附上你的建议和理由。相关的几条放进同一个决策包（`--bundle`），人可以一次回答一整包。已经有的提问，用 `ask Q11 --recommend "…" --reason "…"` 补上建议。

## 工具会告诉你的事

- `#N 已写入`：生效了。
- `已交给 X 确认（待确认 Pn）`：这次改动要别人点头，先做不受影响的部分。
- 读到的标记只在例外时出现：`等前置`、`等确认`、`代码已变`、`不成立`、`锁定`。

## 其他命令（按需）

| 命令 | 用途 |
|---|---|
| `pages` | 列出各空间的页 |
| `board [--under 地址]` | 任务看板 |
| `inbox` | 收件箱：待你确认的改动、等你回答的问题 |
| `digest [--since N]` | 汇报：这段时间变了什么、什么在等人 |
| `log` / `diff A B` / `backlinks 地址` | 提交记录、两个提交之间的变化、反链 |
| `edit 地址 "新正文"` / `mv` / `rm` | 改写、移动、删除 |
| `bundle 包名 Q1 Q2 …` | 把已有的几条提问编成决策包 |
| `fresh` / `recheck 地址 ok\|invalid` | 检查代码锚点；核实代码已变的块 |
| `lock 地址 [--delegate agent:x]` | 锁定一份计划（人、计划的作者或管理者）；锁定后改步骤先交给锁定人确认 |
| `pending [ID]` / `confirm ID` / `reject ID` | 待确认的改动 |
| `answer Q… \| --bundle 包名` | 回答提问（人用；不写 `--text` 就采纳建议） |

每个命令都有 `-h`。

## 系统命令（派活的会话和试用脚本用，不是给 agent 的）

`init`、`import-v1`、`actor`、`attach`（子代理结束时把报告挂到任务下）、`trace`（把子代理的运行记录挂到任务上）、`export`。
