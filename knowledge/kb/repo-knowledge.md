---
id: knowledge.repo-knowledge
title: 仓库知识树
summary: 本目录：放什么、格式、事实来源、何时更新。
anchors:
  - knowledge/README.md
  - knowledge/index.md
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 仓库知识树

`knowledge/` 是仓库自带的知识库：按主题组织、描述"当前代码实际怎么工作"，随代码一起提交、评审、合并，某个提交上的知识描述的就是该提交上的代码。约定的完整文本见 `knowledge/README.md`，这里只摘要。

## 关键规则
- 放什么：功能的职责与边界、代码实际遵守的规则（不变量、上限、顺序、失败行为）及其执行位置、关键入口、与其他部分的关系。不放：进行中的任务/计划、调查过程、从 `docs/` 或代码注释抄来的说法。
- 事实只以代码为准（实现、表结构、路由、测试）；`docs/` 与注释只是线索，必须回到实现核实；核实不了就不写，或明标「未核实」。有测试守着的规则更可信。
- 结构：目录即层次；有下级的节点是目录加 `index.md`，叶子是单个 `.md`；顶层按主题而非代码目录划分，顶层只由人或整理者调整。
- 每个文件有 YAML 头：`id`（稳定，移动改名不变，链接用它）、`title`、`summary`、`anchors`（依据的代码，必须真实存在）、`status`（stub / draft / verified）、`verified_at`（最近按代码核对时的提交）。
- 叶子正文：开头一两句说明，然后「关键规则」「从哪读起」「相关」；第一版每个叶子 15–40 行，代码引用写成 `path:函数名` 或 `path:行`。`index.md` 写这一块的整体构成与配合，并保留下级列表。
- 更新：改动合并前，在同一个 PR 里核对 anchors 覆盖到改动路径的节点；节点与代码不一致时以代码为准并更新 `verified_at`；新功能需要新节点就加在最合适的主题下，放不进现有主题则提出来，不随手加顶层。

## 从哪读起
- `knowledge/README.md`：约定全文。
- `knowledge/index.md`：顶层主题列表。
- 本树当前的顶层主题目录：agent、automation、collaboration、data、engineering、files、frontend、git、knowledge、narrator、platform、remote、security。

## 相关
- [团队知识库](knowledge-base.md)：产品功能，与本仓库知识树是两回事（前者是运行时的团队知识，后者是给开发者读的代码知识）。
- [大纲](outline.md)
