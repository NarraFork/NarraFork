---
id: knowledge.repo-knowledge
title: 仓库知识树
summary: 本目录：放什么、格式、事实来源、何时更新。
anchors:
  - scripts/knowledge.ts
  - tests/scripts/knowledge.test.ts
  - knowledge/README.md
  - knowledge/index.md
keywords:
  - knowledge/README.md
  - scripts/knowledge.ts
  - bun scripts/knowledge.ts
  - 知识树
  - 锚点
  - anchors
  - 过期节点
  - stale
  - 覆盖率
  - 改它时
status: draft
verified_at: 2e6441ad0
---
# 仓库知识树

`knowledge/` 是仓库自带的知识库：按主题组织、描述"当前代码实际怎么工作"，随代码一起提交、评审、合并，某个提交上的知识描述的就是该提交上的代码。约定的完整文本见 `knowledge/README.md`，这里只摘要。它是给开发者和 agent 读的，不是运行时功能。

## 关键规则
- 放什么：功能的职责与边界、代码实际遵守的规则（不变量、上限、顺序、失败行为）及其执行位置、关键入口、与其他部分的关系。不放：进行中的任务/计划、调查过程、从 `docs/` 或代码注释抄来的说法。
- 事实只以代码为准（实现、表结构、路由、测试）；`docs/` 与注释只是线索，必须回到实现核实；核实不了就不写，或明标「未核实」。有分支的规则每个分支单独写一行。
- 结构：目录即层次；有下级的节点是目录加 `index.md`，叶子是单个 `.md`；顶层按主题而非代码目录划分，顶层只由人或整理者调整。
- 每个文件有 YAML 头：`id`（稳定，移动改名不变，链接用它）、`title`、`summary`、`anchors`、`keywords`、`status`（stub / draft / verified）、`verified_at`。
- 叶子正文：开头一两句说明，然后「关键规则」「从哪读起」「改它时」「相关」；`index.md` 写这一块的整体构成与配合，并保留下级列表。
- 锚点：文件、以 `/` 结尾的目录、或 glob；只统计 `server/`、`frontend/`、`shared/` 下的 `.ts/.tsx/.go`，排除测试、`.browser.`、`.fixture.`、fixtures 目录、`.d.ts`、`routeTree.gen.ts`（`scripts/knowledge.ts:SOURCE_ROOTS`、`NOT_SOURCE`）。一个锚点匹配的源文件超过 40 个（`BROAD_ANCHOR_FILES`）时 `check` 报错，且这种锚点不计入覆盖率。
- 过期按 git 判断：节点文件最后一次提交之后，若有提交改了它的锚点，就是过期（`stale()`），节点与代码在同一提交里一起改则不算；未提交的节点文件（工作区有改动）不参与判断。判断用的是这些提交实际改过的路径（`git log --name-only --no-renames --diff-merges=combined`，合并提交只算合并结果与每个父提交都不同的文件），所以删除文件、改名的旧路径、花括号 glob、以及锚在 `knowledge/` 自身文件上的锚点都会被算到；`affected` 同样不合并改名（`--no-renames`），也不过滤 `knowledge/` 路径；但「没有节点覆盖的改动文件」只列工作区里还存在的文件（改名的旧路径不算缺口）。
- `find` 的评分：id、title 5 分，keywords 4 分，summary 3 分，anchors 2 分，正文 1 分；单个词按它命中的最强字段计；只有一个含 `/` 或 `.` 的参数时按路径匹配锚点（精确 10、目录前缀 6）。所以 `keywords` 比正文更容易被搜到。
- `check` 检查：`knowledge/` 下除 README 外每个 `.md` 都必须有节点头部（否则报「no node header」）、头部必填项（id、title、summary、status）、状态取值、id 唯一、锚点必须真实存在、正文里的相对 `.md` 链接、每个目录有 `index.md` 且列出全部下级、锚点不过宽。节点路径一律用正斜杠（`repoPath`），CRLF 换行与 LF 一样解析，所以 Windows 检出结果相同。它不检查 `keywords`、`verified_at` 是否填写，也不检查「改它时」是否存在。
- 更新：改动合并前跑 `affected`，在同一个 PR 里核对被碰到的节点并更新 `verified_at`；新功能需要新节点就加在最合适的主题下，放不进现有主题则提出来，不随手加顶层。

## 从哪读起
- `knowledge/README.md`：约定全文。
- `knowledge/index.md`：顶层主题列表。
- `scripts/knowledge.ts`：`find | affected | stale | coverage | check` 五个子命令；测试在 `tests/scripts/knowledge.test.ts`。
- 本树当前的顶层目录：agent、automation、collaboration、data、engineering、files、flows、frontend、git、kb、narrator、platform、remote、security（`kb/` 的节点 id 仍以 `knowledge.` 开头）。

## 改它时
- 改 `scripts/knowledge.ts` 的解析或判定（头部格式、锚点语法、上限）：同步 `tests/scripts/knowledge.test.ts` 与 `knowledge/README.md` 的约定，并让现有节点仍通过 `bun scripts/knowledge.ts check`。
- 移动或改名节点文件：`id` 不变，同时改父级 `index.md` 里的下级列表行和其他节点的相对链接，否则 `check` 报错。
- 移动源文件：全仓搜索旧路径，节点锚点指向不存在的路径会让 `check` 失败。

## 相关
- [团队知识库](knowledge-base.md)：产品功能，与本仓库知识树是两回事（前者是运行时的团队知识，后者是给开发者读的代码知识）。
- [大纲](outline.md)
