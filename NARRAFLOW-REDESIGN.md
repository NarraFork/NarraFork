# NarraFlow 重设计方案

## 设计理念

抛弃现有的自由 DAG 章节关系图，转为以主分支 commit 时间线为脊柱的分支拓扑图。

核心隐喻：**主分支是一把固定在屏幕边缘的尺子，commit 是刻度。所有开发工作从某个刻度分出，可能再分出更多分支，最终可能合回主尺子。**

---

## 核心概念

### 弹性尺子（Elastic Ruler）

- 主分支的 commit 序列构成一把尺子，固定在屏幕的某一边缘（上/下/左/右，用户可配置）
- 尺子的"轨道"钉在边缘不动，但刻度随画布平移和缩放同步滚动（类似 DAW 时间轴）
- 刻度间距是弹性的、不均匀的：
  - 未展开的区间紧凑显示
  - 展开的区间撑开，两侧内容随之挤开
  - 多个区间同时展开时，间距累加
- 间距计算纯前端完成，后端只提供 commit 序列和区间数据

### 区间（Segment）

- 定义：主尺子上两个 commit 之间，只要中间有 chapter 关联，就构成一个可展开区间
- 区间是 LOD（Level of Detail）的基本单元
- 展开后的区间拥有独立的虚拟坐标空间，用户可在其中自由排列节点，位置持久化到数据库

### 递归子尺子（Recursive Sub-Rulers）

- 分支（chapter）展开后，如果其自身有子分支，可以显示一把子尺子（该分支的 commit 序列）
- 子尺子复用同一套"尺子 + 弹性区间 + LOD"机制
- 子尺子在画布内容区，跟随滚动（不固定在边缘）
- 嵌套层数深时，外层（宏观）尺子渐进隐藏，只保留当前聚焦层级附近的尺子可见

### LOD 数据加载策略

- **默认加载**：主分支 commit 骨架 + 正在活跃（active）的 chapter 标记
- **不加载**：dormant/merged/abandoned 的 chapter 详情，后端不发送
- **按需加载**：用户展开某个区间时，前端请求该区间的完整数据（历史 chapter、子分支等）
- 活跃 chapter 在紧凑态下，以尺子刻度旁的小徽章/指示器形式可见，点击可展开所在区间

---

## Git 操作在尺子上的表现

### 分支与合并

| 操作 | 尺子表现 |
|------|---------|
| fork（创建分支） | 从主尺子某个刻度分出一条线，进入区间的画布空间 |
| merge commit | 分支从刻度 A 分出，回到刻度 B（合并 commit），有明确的分出点和合入点 |
| fast-forward | 分支的 commit 直接成为主尺子的刻度，无合并 commit |
| squash merge | 分支的多个 commit 压缩为主尺子上的一个刻度，原始 commit 链消失 |

### 可逆操作 — 在界面上体现，提供操作入口

- reset — 刻度可以"退回"，用户能看到并选择撤销
- revert — 尺子上出现一个新的"撤销"刻度
- merge — 可以 revert 掉合并 commit

### 不可逆操作 — 不追踪历史，直接反映 git 当前状态

- rebase — SHA 变了，系统从 git 刷新，尺子刻度更新，不留痕迹
- squash merge — 压缩刻度出现在主尺子上，原分支信息随 chapter 归档
- force push — 刷新即可
- interactive rebase — 子尺子整体刷新

### Chapter 与 Commit 的关联

- 主要通过**分支名**关联，而非 SHA（因为 rebase 会改 SHA，但分支名不变）
- 分支名在 rebase 前后不变，通过 `git log <branch_name>` 始终能拿到当前 commit 列表
- SHA 作为辅助索引用于精确定位

### 合并后的 Chapter 生命周期

| 合并方式 | Chapter 处理 |
|---------|-------------|
| merge commit | 区间内保留为历史记录，可展开回顾完整 commit 和会话 |
| fast-forward | commit 融入主尺子，chapter 保留，可回顾 |
| squash merge | chapter 自动归档，会话保留价值低（原始 commit 链已丢失），刻度上留标注链接到归档摘要 |

---

## Chapter 生命周期

### 树状结构约束

新 NarraFlow 下，chapter 关系是**树状**而非图状：
- 一个 chapter 只能有一个父节点（fork 来源）
- 分支可以合回主分支，但这是"向前推进"的操作（在主尺子上产生新刻度），不是修改历史
- 历史只能复刻，不能修改

### 合并即冻结

chapter 一旦确定合并目标位置，立即冻结：
- worktree 删除
- git 分支删除
- 只保留会话记录和 commit 快照作为只读归档
- 不可逆，不存在 unmerge

如果合并后发现 bug，流程是：从主分支当前 HEAD fork 新 chapter → 做 revert commit 或手动修复 → 合回主分支。修复永远是向前的新分支。

### 状态机

`active → merged(frozen)` 或 `active → abandoned`，没有复杂的中间态。

---

## Review 机制

### Review Node

从源 chapter 的最新状态 fork 出一个 review 专用临时节点：
- 有自己的 worktree（可写，用于跑测试）
- 叙述者无前文（避免先入为主），只能看到 diff 和相关文件
- 可以读文件、跑测试、搜索代码库
- 不应修改业务代码

### Git 状态约束

review 叙述者每轮输出后，系统自动核查 git 状态：
- 如果与源 commit 不一致（有文件变更），自动 `git reset --hard` + `git clean -fd`
- 注入消息告知叙述者文件已回退，继续 agent loop 让其重新输出
- 审查结论必须基于原始代码得出，不是基于自己改过的版本

### 三条路径

review 结论输出后，用户可选择：

1. **继续对话** — 保持当前状态，与 review 叙述者继续聊，细化发现
2. **发回源节点** — review 叙述者转换为源 chapter 叙述者的 subagent，源节点拿到审查结果继续改进，还可以通过 ContinueTask 追问审查者细节
3. **转正为 Chapter** — review 节点升级为正式 chapter（从源 chapter fork），开始动手改代码

---

## 使用体验

### 日常开发

打开项目，看到一把横贯屏幕边缘的尺子 — 主分支的 commit 时间线。大部分区间紧凑，只有几个地方有小徽章在闪，那是正在活跃的 chapter。

点击徽章，区间撑开，里面是 chapter 节点，叙述者正在工作。可以展开看对话，也可以拖拽调整位置。旁边可能还有同事昨天开的 chapter，已经合回主分支 — 安静地躺在区间里作为历史记录。

在尺子最新的 commit 刻度上右键 → Fork，新 chapter 分出来，AI 叙述者开始工作。同事在另一个刻度上也开了 chapter 修 bug，两个 chapter 各占一段区间，互不干扰。

### 分支嵌套

feature chapter 越做越大，叙述者建议拆分。从 feature 的某个 commit 再 fork 出子 chapter 处理 UI 部分。feature 的 commit 线上出现一把小尺子，子 chapter 挂在上面。

子 chapter 完成后合回 feature，feature 再合回主分支。主尺子上出现新的合并刻度。画布上是清晰的层级结构 — 主尺子 → feature 子尺子 → UI 子子尺子。

钻进子尺子看细节时，主尺子渐渐淡出，只保留当前聚焦层级附近的尺子可见。退出来时，子尺子折叠回紧凑区间。

### Review 流程

feature 做完，不急着合并。右键 chapter → Request Review。系统 fork 出 review 节点，黄色虚线边框，全新叙述者开始审查。

审查者看不到 feature 叙述者的任何对话 — 只看到 diff 和代码。它读文件、跑测试、搜索代码库，输出结论。如果验证过程中改了文件，系统自动 reset 并让它重新输出。审查者的手必须是干净的。

结论出来后三个选择：细化发现、发回源节点让 feature 叙述者修改、或者转正为 chapter 自己动手修。

### 探索对比

不确定用 Redis 还是 Memcached 做缓存。从同一个 commit 刻度 fork 出两个 exploration chapter，各自实现一个方案。

两个 chapter 在同一段区间里并排显示。展开各自的叙述者面板对比进展，分别 Request Review 让 AI 独立评估。选定方案后合回主分支，另一个 abandon，折叠进历史。

### 外部 Git 操作

同事在命令行做了 rebase，SHA 全变了。刷新 NarraFlow，尺子刻度自动更新 — 系统不追踪 rebase 历史，直接反映 git 当前状态。chapter 通过分支名关联，不会断链。

### 大型项目

主分支有上千个 commit，但尺子是紧凑的 — 只有活跃 chapter 附近的区间有徽章。点击徽章撑开区间，其他保持紧凑。

想看三个月前的历史，滚动尺子到那个时间段，展开区间，按需加载数据。看完折叠，内存释放。

---

## 核心原则

- 主分支是不可动摇的时间线
- 所有工作都是从它分出去、再合回来的临时分支
- Review 是合并前的质量关卡
- 历史永远向前推进，不可修改
- 画布围绕弹性尺子组织，注意力自然聚焦在当前活跃的工作上，历史按需展开
