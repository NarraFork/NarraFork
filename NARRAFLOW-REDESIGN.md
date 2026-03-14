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

### 自适应 LOD（Level of Detail）

LOD 系统的目标：从宏观鸟瞰到微观细节的**连续平滑过渡**，内容感知（活跃区间获得更多视觉权重），任何缩放级别下渲染的 DOM 节点数有上限。详见下方「自适应 LOD 细节设计」章节。

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

## 自适应 LOD 细节设计

### 缩放级别分层（Zoom Tiers）

将连续的 scale 值划分为 5 个语义层级，每层定义渲染内容和交互能力：

```
┌─────────────┬──────────┬──────────────────────────────────────────────────┐
│ 层级         │ scale 范围│ 渲染内容                                         │
├─────────────┼──────────┼──────────────────────────────────────────────────┤
│ L0 鸟瞰      │ < 0.25   │ 聚合刻度块 + 热力色带（活跃密度）+ 无文字          │
│ L1 概览      │ 0.25–0.6 │ 聚合刻度块 + 区间徽章（章节数）+ 活跃指示点        │
│ L2 浏览      │ 0.6–1.2  │ 单个刻度线 + SHA 标签 + 折叠卡片（标题+状态）      │
│ L3 工作      │ 1.2–2.0  │ 单个刻度线 + 完整标签 + 展开卡片 + 连接线          │
│ L4 聚焦      │ > 2.0    │ 单个刻度线 + commit message + 叙述者面板内嵌       │
└─────────────┴──────────┴──────────────────────────────────────────────────┘
```

层级之间不是硬切换，而是通过 `lodProgress` 实现渐变：

```typescript
interface ZoomTier {
  id: "L0" | "L1" | "L2" | "L3" | "L4";
  minScale: number;
  maxScale: number;
}

const ZOOM_TIERS: ZoomTier[] = [
  { id: "L0", minScale: 0,    maxScale: 0.25 },
  { id: "L1", minScale: 0.25, maxScale: 0.6  },
  { id: "L2", minScale: 0.6,  maxScale: 1.2  },
  { id: "L3", minScale: 1.2,  maxScale: 2.0  },
  { id: "L4", minScale: 2.0,  maxScale: Infinity },
];

// 返回当前层级 + 向下一层级的过渡进度 [0, 1]
function getZoomTierInfo(scale: number): { tier: ZoomTier; progress: number } {
  for (let i = ZOOM_TIERS.length - 1; i >= 0; i--) {
    if (scale >= ZOOM_TIERS[i].minScale) {
      const tier = ZOOM_TIERS[i];
      const range = (tier.maxScale === Infinity
        ? tier.minScale * 2 : tier.maxScale) - tier.minScale;
      const progress = Math.min(1, (scale - tier.minScale) / range);
      return { tier, progress };
    }
  }
  return { tier: ZOOM_TIERS[0], progress: 0 };
}
```

渐变规则：当 `progress > 0.7` 时开始淡入下一层级的元素，`progress < 0.3` 时开始淡出当前层级的元素。这创造了一个 0.3 宽的混合区间，避免突然出现/消失。

具体渐变行为：
- L0→L1：聚合块逐渐分裂为独立刻度，热力色带淡出，徽章淡入
- L1→L2：聚合刻度分裂为单个刻度线，SHA 标签淡入，折叠卡片从 0 高度展开
- L2→L3：折叠卡片扩展为展开卡片（宽度动画），连接线淡入
- L3→L4：展开卡片进一步扩展为叙述者面板，commit message 替换 SHA

### Commit 聚合引擎（Commit Aggregation）

上千个 commit 在 L0/L1 级别不应全部渲染为独立刻度线。引入 `CommitCluster`，将连续的无关 commit 聚合为一个视觉块。

#### 聚合数据结构

```typescript
interface CommitCluster {
  startSha: string;       // 聚合块中第一个 commit
  endSha: string;         // 聚合块中最后一个 commit
  count: number;          // 包含的 commit 数量
  startIndex: number;     // 在 ticks 数组中的起始索引
  endIndex: number;       // 在 ticks 数组中的结束索引
  hasSegments: boolean;   // 是否包含有 chapter 关联的 commit
  activeCount: number;    // 包含的活跃 chapter 数
  worldPos: number;       // 世界坐标位置（取中点）
  worldSize: number;      // 世界坐标宽度
}
```

#### 聚合策略

根据缩放级别动态调整聚合粒度：

```typescript
function getClusterMinScreenSize(scale: number): number {
  if (scale < 0.25) return 40;  // L0: 每块至少 40px → 大量聚合
  if (scale < 0.6) return 20;   // L1: 每块至少 20px → 中等聚合
  return 0;                      // L2+: 不聚合，显示单个刻度
}
```

聚合规则：
- 有 segment 的 commit（即有 chapter 关联的）**不参与聚合**，始终独立显示
- 贪心合并：从左向右扫描，将连续的无 segment commit 合并，直到累积屏幕宽度 ≥ `minScreenSize` 或遇到 segment commit

#### 聚合块渲染

| 层级 | 渲染方式 |
|------|---------|
| L0 | 矩形色块，高度 = `min(14, 4 + count * 0.5)` px，颜色按活跃密度映射（灰→indigo 渐变） |
| L1 | 矩形色块 + 右上角小数字标签（commit 数量），有 segment 的块额外显示活跃指示点 |
| L2+ | 不聚合，正常渲染单个刻度线 |

#### 热力色带（L0 专属）

L0 级别，尺子轨道背景渲染一条连续的热力色带，反映时间线上的活跃密度：

```typescript
interface HeatSegment {
  startX: number;
  endX: number;
  intensity: number; // 0–1，基于该区间内的活跃 chapter 密度
}
```

- 将整条尺子等分为 N 个采样窗口（N = 屏幕宽度 / 4px）
- 每个窗口的 `intensity` = 窗口内活跃 chapter 数 / 窗口内总 chapter 数
- 用 CSS `linear-gradient` 渲染，避免额外 DOM
- 颜色映射：`intensity 0` → `transparent`，`0.5` → `indigo-9 @ 20%`，`1.0` → `indigo-6 @ 50%`

### 弹性间距 v2（Elastic Layout v2）

#### 内容感知的展开尺寸

展开尺寸不再是固定 400px，而是根据区间内 chapter 数量动态计算：

```typescript
function computeExpandedSize(params: {
  chapterCount: number;
  hasOpenPanel: boolean;
  openPanelWidth: number;
}): number {
  const CARD_SLOT = 220 + 16; // NODE_WIDTH + gap
  const PADDING = 40;

  if (params.hasOpenPanel) {
    return Math.max(params.openPanelWidth + CARD_SLOT + PADDING, 500);
  }

  // 1-3 个 chapter: 单行；4-8: 4列；9+: 5列
  const cols = Math.min(
    params.chapterCount,
    params.chapterCount <= 3 ? params.chapterCount
      : params.chapterCount <= 8 ? 4 : 5,
  );
  return Math.max(400, cols * CARD_SLOT + PADDING);
}
```

#### 折叠态密度感知间距

折叠间距随缩放连续变化，`computeElasticLayout` 接收 `scale` 参数：

```typescript
function getCollapsedGap(scale: number): number {
  if (scale < 0.25) return 20;                              // L0: 极紧凑
  if (scale < 0.6) return 40 + (scale - 0.25) / 0.35 * 40; // L1: 40→80 线性插值
  return 80;                                                 // L2+: 标准
}
```

#### 展开/折叠 Spring 动画

展开/折叠不再瞬间跳变，通过 spring 物理模型平滑过渡：

```typescript
interface AnimatedSegment {
  fromSha: string;
  currentSize: number;  // 当前动画中的尺寸（每帧更新）
  targetSize: number;   // 目标尺寸
  velocity: number;     // 动画速度（px/frame）
}

function springStep(
  current: number, target: number, velocity: number,
): { value: number; velocity: number } {
  const STIFFNESS = 0.15;
  const DAMPING = 0.75;
  const PRECISION = 0.5; // px

  const displacement = target - current;
  const springForce = displacement * STIFFNESS;
  const dampingForce = velocity * DAMPING;
  const newVelocity = (velocity + springForce) * (1 - dampingForce * 0.01);
  const newValue = current + newVelocity;

  if (Math.abs(displacement) < PRECISION && Math.abs(newVelocity) < PRECISION) {
    return { value: target, velocity: 0 };
  }
  return { value: newValue, velocity: newVelocity };
}
```

`computeElasticLayout` 升级为 `computeElasticLayoutAnimated`，接收 `animatedSizes: Map<string, AnimatedSegment>` 参数，由 rAF 循环维护动画状态。动画中的区间使用 `currentSize`，静止区间使用 `computeExpandedSize()` 或 `getCollapsedGap()`。

### 数据加载与缓存策略

#### 分层数据模型

```
┌──────────────────────────────────────────────────────────┐
│ Layer 0: Commit Skeleton（骨架层）                        │
│ 内容：commit SHA + shortSha + date + 是否有 segment 标记  │
│ 加载：首屏加载，向两端无限滚动续取                          │
│ 缓存：staleTime = 5min（commit 历史很少变化）              │
│ 大小：每条 ~80 bytes，1000 条 ≈ 80KB                      │
├──────────────────────────────────────────────────────────┤
│ Layer 1: Segment Summary（摘要层）                        │
│ 内容：每个 segment 的 chapter 数量、活跃数、角色分布        │
│ 加载：随骨架层一起返回（即 segments 数组）                  │
│ 缓存：staleTime = 30s（活跃状态可能变化）                  │
│ 大小：每个 segment ~120 bytes                             │
├──────────────────────────────────────────────────────────┤
│ Layer 2: Segment Detail（详情层）                         │
│ 内容：chapter 完整信息、位置、叙述者状态、边关系            │
│ 加载：区间展开时按需加载                                   │
│ 缓存：活跃区间 staleTime = 15s，历史区间 staleTime = 5min │
│ 大小：每个 chapter ~500 bytes                             │
└──────────────────────────────────────────────────────────┘
```

#### 无限滚动 Commit 加载

替换固定 200 条 limit，改为基于视口的双向无限加载：

```typescript
interface CommitWindow {
  loadedStart: number;   // 已加载的最旧 commit 索引
  loadedEnd: number;     // 已加载的最新 commit 索引
  totalCount: number;    // 主分支总 commit 数（后端首次返回）
  pageSize: number;      // 每次加载的页大小（默认 200）
}
```

触发条件：当视口边缘距离已加载范围的边界 < 2 页时触发预取。

后端 `/ruler` 接口扩展：

```
GET /projects/:id/ruler?cursor=<sha>&direction=older|newer&limit=200

响应新增字段：
{
  commits, segments, activeChapters,
  totalCommitCount: number,
  oldestLoadedIndex: number,
  newestLoadedIndex: number,
}
```

前端使用 `useInfiniteQuery` 管理分页，`getNextPageParam` / `getPreviousPageParam` 基于 index 判断是否还有更多数据。

#### 智能预取

基于用户滚动方向和速度预取即将进入视口的区间详情：

```typescript
interface PrefetchState {
  lastViewCenter: number;  // 上一帧的视口中心位置
  velocity: number;        // 滚动速度（px/frame，指数移动平均）
  queue: Set<string>;      // 预取队列
}
```

每次 camera 变化时：
1. 计算速度（EMA：`velocity = old * 0.7 + raw * 0.3`）
2. 预测 500ms 后的视口位置（`predictedCenter = current + velocity * 30`）
3. 找到预测位置附近 ±1000px 内的展开区间
4. 如果数据未缓存，触发 `queryClient.prefetchQuery()`

#### 差异化缓存策略

```typescript
function getSegmentStaleTime(segment: RulerSegment): number {
  if (segment.activeChapterCount > 0) return 15_000;  // 活跃：15s
  return 5 * 60 * 1000;                                // 历史：5min
}
```

历史区间额外启用 `placeholderData: keepPreviousData`，允许使用过期数据（后台刷新）。

#### 内存回收

定期检查（每 60 秒）：
- 已折叠且不在视口 ±3 屏范围内的区间 → 从 `queryClient` 移除
- 展开中的区间不回收
- 保留最近 5 分钟内访问过的区间（LRU）

### 递归子尺子的深度感知 LOD

#### 聚焦栈模型

用户的注意力在嵌套层级间形成一个栈，只有栈顶附近的层级完整渲染：

```typescript
interface FocusStack {
  path: Array<{
    chapterId: string | null;  // 主尺子为 null
    depth: number;
  }>;
  focusDepth: number;  // 当前聚焦深度（栈顶索引）
}
```

聚焦规则：
- 点击子尺子内的 chapter 卡片 → 该子尺子的深度成为 `focusDepth`
- 点击主画布空白区域 → `focusDepth` 回退到 0
- 展开子尺子 → `focusDepth` 自动推进到新层级
- 折叠子尺子 → `focusDepth` 回退到父层级

#### 深度感知渲染规则

每个层级根据与 `focusDepth` 的距离决定渲染模式：

```typescript
type SubRulerRenderMode = "full" | "compact" | "indicator" | "hidden";

function getSubRulerRenderMode(
  layerDepth: number,
  focusDepth: number,
): SubRulerRenderMode {
  const distance = Math.abs(layerDepth - focusDepth);
  if (distance === 0) return "full";
  if (distance === 1) return "compact";
  if (distance === 2) return "indicator";
  return "hidden";
}
```

| 模式 | 尺子轨道 | 刻度 | 卡片 | 面板 | 交互 |
|------|---------|------|------|------|------|
| full | 完整高度(36px) | 全部 | 展开/折叠 | 可打开 | 完整 |
| compact | 缩小高度(20px) | 聚合 | 仅标题 | 禁用 | 点击聚焦 |
| indicator | 细线(4px) | 无 | 无 | 无 | 点击聚焦 |
| hidden | 不渲染 | — | — | — | — |

#### 层级过渡动画

```typescript
const LAYER_TRANSITION_DURATIONS: Record<string, number> = {
  "full→compact": 250,
  "compact→full": 200,
  "compact→indicator": 200,
  "indicator→compact": 150,
  "indicator→hidden": 150,
  "hidden→indicator": 100,
};
```

过渡期间的插值行为：
- `full→compact`：轨道高度 36→20px，卡片高度收缩到标题行，面板淡出
- `compact→indicator`：轨道高度 20→4px，卡片淡出，刻度淡出
- `indicator→hidden`：细线淡出（opacity 1→0）

#### 子尺子的独立 LOD

子尺子复用主尺子的 Zoom Tier 体系，但有两个修正：

1. **有效缩放** = 主画布 scale × 子尺子自身的相对缩放（子尺子可能被容器约束缩小）
2. **LOD 层级上限**受 `renderMode` 约束：compact 模式最高 L2，indicator 模式固定 L0

```typescript
function getEffectiveZoomTier(
  canvasScale: number,
  renderMode: SubRulerRenderMode,
): ZoomTier {
  const baseTier = getZoomTierInfo(canvasScale).tier;
  if (renderMode === "compact"
    && (baseTier.id === "L3" || baseTier.id === "L4")) {
    return ZOOM_TIERS[2]; // L2
  }
  if (renderMode === "indicator") return ZOOM_TIERS[0]; // L0
  return baseTier;
}
```

#### 面包屑导航

深层嵌套时，在画布顶部显示面包屑路径：

```
主分支 › feature-auth › auth-ui › login-form
```

- 点击任意层级 → `focusDepth` 跳转到该层级，更深的层级折叠为 indicator/hidden
- 当前聚焦层级高亮显示
- 固定在画布顶部，不随滚动移动（z-index 高于内容层）
- 超过 4 层时，中间层级折叠为 `...`，只显示首尾两层 + 当前聚焦层

### 渲染预算与性能控制

#### DOM 节点预算

任何缩放级别下，可见区域内的 DOM 节点数有上限：

```typescript
interface RenderBudget {
  maxTickElements: number;      // 尺子轨道内的最大刻度/聚合块数
  maxCardElements: number;      // 画布内的最大卡片数
  maxPanelElements: number;     // 最大展开的叙述者面板数
  maxConnectorLines: number;    // 最大 SVG 连接线数
}

function getRenderBudget(scale: number): RenderBudget {
  if (scale < 0.6) return {     // L0/L1
    maxTickElements: 200, maxCardElements: 0,
    maxPanelElements: 0, maxConnectorLines: 0,
  };
  if (scale < 1.2) return {     // L2
    maxTickElements: 300, maxCardElements: 50,
    maxPanelElements: 0, maxConnectorLines: 30,
  };
  if (scale < 2.0) return {     // L3
    maxTickElements: 200, maxCardElements: 30,
    maxPanelElements: 4, maxConnectorLines: 30,
  };
  return {                       // L4
    maxTickElements: 100, maxCardElements: 15,
    maxPanelElements: 2, maxConnectorLines: 15,
  };
}
```

#### 优先级排序

当可见元素超过预算时，按优先级裁剪：

```typescript
function computeCardPriority(
  chapter: SegmentChapter,
  distanceFromViewCenter: number,
  viewportMainSize: number,
): number {
  let score = 0;

  // 状态权重
  if (chapter.status === "active") score += 100;
  else if (chapter.status === "merged") score += 20;
  else score += 10;

  // 叙述者活跃度
  if (chapter.narratorStatus === "streaming") score += 50;
  else if (chapter.narratorStatus === "thinking") score += 40;
  else if (chapter.narratorStatus === "idle") score += 10;

  // 角色权重
  if (chapter.role === "review") score += 15;
  if (chapter.role === "trunk") score += 10;

  // 距离衰减
  const normalizedDistance = distanceFromViewCenter / viewportMainSize;
  score *= Math.max(0.1, 1 - normalizedDistance * 0.5);

  return score;
}
```

裁剪流程：计算所有可见元素的优先级分数 → 按分数降序排列 → 取前 N 个（N = 预算上限）→ 被裁剪的元素不渲染 DOM，但保留在 `cardRegistry` 中（OffscreenBubbles 仍可指示其存在）。

#### 帧率监控与自适应降级

```typescript
interface PerformanceMonitor {
  frameTimes: number[];    // 最近 60 帧的帧时间 (ms)
  degradeLevel: number;    // 0=无降级, 1=轻度, 2=重度
}
```

- 计算 P95 帧时间
- P95 > 32ms → 升级降级等级
- P95 < 18ms 且当前有降级 → 降低降级等级

| 等级 | 措施 |
|------|------|
| 0 | 正常渲染 |
| 1 | 禁用连接线动画，卡片阴影简化为 border，预算减半 |
| 2 | 禁用所有动画（spring→instant），禁用热力色带，预算再减半 |

#### 双轴虚拟化

当前实现已有 cross-axis culling（`CARD_CROSS_MULTIPLIER`），补充 main-axis culling，实现完整的双轴虚拟化：

```typescript
function cullCards(
  cards: LayoutCard[],
  viewMainStart: number, viewMainEnd: number,
  viewCrossStart: number, viewCrossEnd: number,
  mainBuffer: number, crossBuffer: number,
): LayoutCard[] {
  return cards.filter(card => {
    const mainVisible = card.mainEnd >= viewMainStart - mainBuffer
                     && card.mainStart <= viewMainEnd + mainBuffer;
    const crossVisible = card.crossEnd >= viewCrossStart - crossBuffer
                      && card.crossStart <= viewCrossEnd + crossBuffer;
    return mainVisible && crossVisible;
  });
}
```

### 自动展开/折叠策略 v2

#### 展开条件矩阵

```typescript
function shouldAutoExpand(
  segment: RulerSegment,
  scale: number,
  isInViewport: boolean,
  manuallyCollapsed: boolean,
): { shouldExpand: boolean; reason: string } {
  // 用户手动折叠的区间不自动展开（尊重用户意图）
  if (manuallyCollapsed) return { shouldExpand: false, reason: "manually_collapsed" };
  if (!isInViewport) return { shouldExpand: false, reason: "out_of_viewport" };

  // 有活跃 chapter 的区间：阈值更低
  if (segment.activeChapterCount > 0) {
    return { shouldExpand: scale >= 1.0, reason: "active_threshold" };
  }
  // 纯历史区间：需要更高缩放
  return { shouldExpand: scale >= 1.6, reason: "history_threshold" };
}
```

#### 折叠条件

```typescript
function shouldAutoCollapse(
  segment: RulerSegment,
  scale: number,
  isInViewport: boolean,
  hasOpenPanel: boolean,
): boolean {
  if (hasOpenPanel) return false;           // 有打开面板的区间不折叠
  if (!isInViewport) return true;           // 滚出视口 → 延迟折叠（由调用方处理）
  if (segment.activeChapterCount > 0) return scale < 0.7;  // 活跃区间
  return scale < 1.2;                       // 历史区间
}
```

#### 折叠延迟与防抖

区间滚出视口后不立即折叠，进入延迟队列（默认 2 秒）。如果在延迟期间区间重新进入视口，取消折叠。

```typescript
class CollapseDelayQueue {
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  scheduleCollapse(fromSha: string, onCollapse: () => void, delayMs = 2000) {
    if (this.pending.has(fromSha)) return;
    this.pending.set(fromSha, setTimeout(() => {
      this.pending.delete(fromSha);
      onCollapse();
    }, delayMs));
  }

  cancelCollapse(fromSha: string) {
    const timer = this.pending.get(fromSha);
    if (timer) { clearTimeout(timer); this.pending.delete(fromSha); }
  }

  dispose() {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
```

### LOD 实施计划

分三个阶段、22 个任务递进实施。每个阶段可独立交付。所有新文件位于 `frontend/components/ruler/`。

#### 文件变更汇总

| 操作 | 文件 | 预估行数变化 |
|------|------|-------------|
| 新建 | `ruler/zoom-tiers.ts` | +60 |
| 新建 | `ruler/commit-cluster.ts` | +80 |
| 新建 | `ruler/spring.ts` | +40 |
| 新建 | `ruler/focus-stack.ts` | +50 |
| 新建 | `ruler/render-budget.ts` | +80 |
| 新建 | `ruler/RulerBreadcrumb.tsx` | +60 |
| 修改 | `ruler/elastic-layout.ts` | 107→180 |
| 修改 | `ruler/RulerFlow.tsx` | 1458→1750 |
| 修改 | `ruler/SegmentCanvas.tsx` | 888→940 |
| 修改 | `ruler/SubRuler.tsx` | 262→320 |
| 修改 | `hooks/useRuler.ts` | 54→90 |
| 修改 | `lib/api.ts` | +3 |
| 修改 | `server/routes/ruler.ts` | 485→530 |
| 修改 | `server/services/git-service.ts` | +15 |
| **合计** | **14 个文件** | **+891 行** |

#### 依赖关系

```
Phase 1 (可并行):
  T1 zoom-tiers.ts ──┐
  T3 commit-cluster.ts ──┤
  T2 elastic-layout.ts ──┼── T4 RulerFlow 集成 ── T5 ClusterTick
                         └── T6 SegmentCanvas

Phase 2 (依赖 Phase 1):
  T7 spring.ts ── T8 elastic-layout 动画版 ── T9 RulerFlow spring
  T10 后端 cursor 分页 ── T11 useRulerInfinite ── T12 智能预取
  T13 差异化缓存 (独立)
  T14 自动展开/折叠 v2 (依赖 T2)

Phase 3 (依赖 Phase 2):
  T15 focus-stack.ts ── T16 SubRuler 深度感知 ── T17 聚焦栈集成
  T18 面包屑导航 (依赖 T15)
  T19 render-budget.ts ── 集成到 SegmentCanvas
  T20 帧率监控 (独立)
  T21 热力色带 (依赖 T3)
  T22 内存回收 (依赖 T11)
```

#### Phase 1: 基础 LOD 框架

**T1: 新增 `zoom-tiers.ts`**（新建，~60 行）

导出：
- `ZoomTier` 接口（id, minScale, maxScale）
- `ZOOM_TIERS` 常量数组（L0–L4 五级）
- `getZoomTierInfo(scale)` → `{ tier, progress }`（progress 为层级内的过渡进度 0–1）
- `getTransitionOpacity(progress, fadeInAt=0.7, fadeOutAt=0.3)` → 层级间渐变透明度

被 RulerFlow、SegmentCanvas、SubRuler、commit-cluster 引用。

**T2: 改造 `elastic-layout.ts`**（107→~140 行）

- 新增导出 `getCollapsedGap(scale): number` — L0: 20px, L1: 40→80 线性插值, L2+: 80px
- 新增导出 `computeExpandedSize({ chapterCount, hasOpenPanel, openPanelWidth }): number` — 内容感知的展开尺寸
- `computeElasticLayout()` 新增可选参数 `scale`（默认 1，向后兼容），内部 `COLLAPSED_GAP` 替换为 `getCollapsedGap(scale)`
- `COLLAPSED_GAP` 保留导出（供 `checkAutoExpand` 的 collapsed-state 位置估算）
- 调用方 `RulerFlow.tsx` L942、`SubRuler.tsx` L80 追加 `scale` 参数

**T3: 新增 `commit-cluster.ts`**（新建，~80 行）

导出：
- `CommitCluster` 接口（startSha, endSha, count, startIndex, endIndex, hasSegments, activeCount, worldPos, worldSize）
- `getClusterMinScreenSize(scale)` — L0: 40px, L1: 20px, L2+: 0（不聚合）
- `clusterCommits(ticks, segmentBySha, scale)` — 贪心聚合：有 segment 的 commit 不参与聚合，连续无 segment commit 合并直到屏幕宽度 ≥ minScreenSize
- `computeHeatmap(clusters, totalWidth)` → `HeatSegment[]`（L0 热力色带数据，T21 使用）

**T4: 改造 `RulerFlow.tsx` — Zoom Tier 集成**（多处小改动）

- 导入 `getZoomTierInfo`、`clusterCommits`
- 新增 `tierInfo = useMemo(() => getZoomTierInfo(scale), [scale])` 和 `zoomTier = tierInfo.tier.id`
- Commit 聚合：L0/L1 时调用 `clusterCommits()`，尺子轨道渲染区域根据 `zoomTier` 决定渲染 clusters 还是 visibleTicks
- 刻度标签：`showLabel={scale > 0.4}` → `showLabel={zoomTier !== "L0"}`
- 区间卡片：L0/L1 时不渲染 `SegmentCanvas`
- `computeElasticLayout` 调用追加 `scale` 参数
- 传递 `zoomTier` prop 给 `SegmentCanvas`

**T5: 新增 `RulerClusterTick` 组件**（RulerFlow.tsx 底部，~50 行）

memo 组件，渲染聚合块：
- 矩形色块，高度 `min(14, 4 + count * 0.5)` px
- 颜色按活跃密度映射（灰→indigo）
- 有 segment 时显示活跃指示点
- L1 额外显示 commit 数量标签

**T6: 改造 `SegmentCanvas.tsx` — Zoom Tier 感知**（小改动）

- Props 新增 `zoomTier?: string`（默认 "L2"）
- L2：卡片只显示标题+状态，不允许打开面板，不渲染连接线
- L3：当前行为（展开卡片+连接线）
- L4：当前行为 + 自动展开面板

#### Phase 2: 动画与智能加载

**T7: 新增 `spring.ts`**（新建，~40 行）

导出：
- `AnimatedSegment` 接口（fromSha, currentSize, targetSize, velocity）
- `springStep(current, target, velocity)` → `{ value, velocity }`
- 常量：`STIFFNESS=0.15`, `DAMPING=0.75`, `PRECISION=0.5`（~200ms 到达 90%，无过冲）

**T8: 改造 `elastic-layout.ts` — 动画版本**（~140→180 行）

- 新增导出 `computeElasticLayoutAnimated(commitShas, segments, expandedSegments, animatedSizes, scale)`
- 内部逻辑：优先使用 `animatedSizes.get(sha).currentSize`，其次 `computeExpandedSize()`，最后 `getCollapsedGap(scale)`
- 原 `computeElasticLayout` 保留（SubRuler 等简单场景继续使用）

**T9: 改造 `RulerFlow.tsx` — Spring 动画集成**（~60 行新增）

- 新增 `animatedSizesRef = useRef<Map<string, AnimatedSegment>>(new Map())`
- 新增 `useEffect` 监听 `expandedSegments` 变化，为新展开/折叠的区间创建 `AnimatedSegment` 条目（展开：currentSize=collapsedGap→targetSize=expandedSize；折叠：反向）
- 新增 `runSpringAnimation` 函数：rAF 循环调用 `springStep` 更新每个 `AnimatedSegment`，调用 `scheduleLightRender`，全部收敛后 `setCamera` 触发 React 重渲染
- Layout 计算从 `computeElasticLayout` 切换到 `computeElasticLayoutAnimated`

**T10: 后端 `/ruler` 接口扩展 — cursor 分页**（ruler.ts +45 行, git-service.ts +15 行）

`git-service.ts` 新增：
- `getCommitCount(worktreePath, branch?)` → `git rev-list --count <branch>`

`ruler.ts` GET `/:id/ruler` 扩展：
- 新增查询参数：`cursor`（SHA）、`direction`（"older"|"newer"）
- 有 `cursor` 时：用 `git log` 的 `--ancestry-path` 或 skip 定位到 cursor 位置
- 响应新增字段：`totalCommitCount`、`oldestLoadedIndex`、`newestLoadedIndex`
- 无 `cursor` 时行为不变（向后兼容）

**T11: 改造 `useRulerData` → `useRulerInfinite`**（useRuler.ts 54→~90 行）

- `RulerData` 接口新增可选字段：`totalCommitCount?`, `oldestLoadedIndex?`, `newestLoadedIndex?`
- 新增 `useRulerInfinite(projectId)` 使用 `useInfiniteQuery`，`getNextPageParam`/`getPreviousPageParam` 基于 index 判断
- 新增 `flattenRulerPages(pages)` 合并多页 commits/segments
- `api.ts` 的 `getRulerData` 方法签名扩展 `opts` 新增 `cursor?`, `direction?`
- `RulerFlow.tsx` 切换到 `useRulerInfinite`，新增视口边缘检测调用 `fetchNextPage`/`fetchPreviousPage`

**T12: 智能预取**（RulerFlow.tsx +40 行）

- 新增 `prefetchStateRef`（lastViewCenter, velocity, queue）
- 在 `setCamera` 回调中调用 `updatePrefetch()`
- 逻辑：EMA 速度计算 → 预测 500ms 后视口位置 → 遍历展开区间 → 预测位置 ±1000px 内未缓存的区间触发 `queryClient.prefetchQuery`

**T13: 差异化缓存策略**（SegmentCanvas.tsx ~10 行改动）

- 新增 `getSegmentStaleTime(segment)` — 活跃区间 15s，历史区间 5min
- `useQuery` 的 `staleTime: 30_000` → `staleTime: getSegmentStaleTime(segment)`
- 历史区间追加 `placeholderData: keepPreviousData`

**T14: 自动展开/折叠 v2**（RulerFlow.tsx 替换 checkAutoExpand）

- 删除 `AUTO_EXPAND_SCALE=1.4` 和 `AUTO_COLLAPSE_SCALE=0.9`
- 新增 `shouldAutoExpand(segment, scale, isInViewport, manuallyCollapsed)` — 活跃区间阈值 1.0，历史区间阈值 1.6，尊重用户手动折叠
- 新增 `shouldAutoCollapse(segment, scale, isInViewport, hasOpenPanel)` — 有面板不折叠，活跃区间 <0.7 折叠，历史区间 <1.2 折叠
- 重写 `checkAutoExpand`：遍历 segments 调用上述函数
- 新增 `manuallyCollapsedRef` 跟踪用户手动折叠的区间，`toggleSegment` 中更新
- 新增 `CollapseDelayQueue` 实例：滚出视口的区间延迟 2 秒折叠，重新进入视口时取消

#### Phase 3: 深度感知与性能

**T15: 新增 `focus-stack.ts`**（新建，~50 行）

导出：
- `FocusStack` 接口（path: `Array<{ chapterId: string | null; depth: number }>`, focusDepth: number）
- `useFocusStack()` — React state hook，提供 `pushFocus(chapterId)`, `popFocus()`, `jumpTo(depth)`, `focusDepth`
- `getSubRulerRenderMode(layerDepth, focusDepth)` → `"full"|"compact"|"indicator"|"hidden"`（距离 0=full, 1=compact, 2=indicator, 3+=hidden）

**T16: 改造 `SubRuler.tsx` — 深度感知渲染**（262→~320 行）

- Props 新增 `renderMode?: SubRulerRenderMode`（默认 "full"）、`onFocusRequest?: () => void`
- 渲染模式分支：
  - `hidden` → return null
  - `indicator` → 4px 细线 + 活跃徽章，点击触发 `onFocusRequest`
  - `compact` → 轨道高度 20px，刻度使用聚合，卡片只显示标题，面板禁用
  - `full` → 当前行为
- 删除 `opacity = Math.max(0.4, 1 - depth * 0.15)`，改为 renderMode 驱动（full=1, compact=0.85, indicator=0.6）

**T17: 改造 `RulerFlow.tsx` + `SegmentCanvas.tsx` — 聚焦栈集成**（~30 行）

- `RulerFlow.tsx`：导入 `useFocusStack`，组件顶部调用，传递给 `SegmentCanvas`
- `SegmentCanvas.tsx`：Props 新增 `focusDepth?`，`SubRuler` 调用处传递 `renderMode={getSubRulerRenderMode(depth + 1, focusDepth)}`，子尺子展开时调用 `focusStack.pushFocus`

**T18: 新增 `RulerBreadcrumb.tsx`**（新建，~60 行）

- 固定在画布顶部（position absolute, z-index 20）
- 渲染 `focusStack.path` 为面包屑：`主分支 › feature-auth › auth-ui`
- 点击任意层级 → `jumpTo(depth)`
- 当前聚焦层高亮（indigo badge）
- 超过 4 层时中间折叠为 `...`
- 在 `RulerFlow.tsx` 的 canvas 区域内渲染（segment headers 层之后）

**T19: 新增 `render-budget.ts`**（新建，~80 行）

导出：
- `RenderBudget` 接口（maxTickElements, maxCardElements, maxPanelElements, maxConnectorLines）
- `getRenderBudget(scale)` — L0/L1: cards=0, L2: cards=50/panels=0, L3: cards=30/panels=4, L4: cards=15/panels=2
- `computeCardPriority(chapter, distanceFromViewCenter, viewportMainSize)` → number（状态权重 + 叙述者活跃度 + 角色权重 + 距离衰减）
- `applyBudget(cards, budget, viewCenter, viewportSize)` → 裁剪后的卡片数组

集成：`SegmentCanvas.tsx` 的 `laid` 数组在渲染前经过 `applyBudget` 过滤。被裁剪的元素保留在 `cardRegistry` 中供 OffscreenBubbles 指示。

**T20: 帧率监控 + 自适应降级**（RulerFlow.tsx +40 行）

- 新增 `performanceMonitorRef`（frameTimes: number[], degradeLevel: 0|1|2）
- 在 `scheduleLightRender` 的 rAF 回调中记录帧时间，调用 `updatePerformanceMonitor()`
- P95 > 32ms → 升级降级；P95 < 18ms → 降低降级
- `degradeLevel` 通过 prop 传递给 `SegmentCanvas`
- 等级 1：禁用连接线动画，卡片阴影简化为 border，预算减半
- 等级 2：禁用所有动画（spring→instant），禁用热力色带，预算再减半

**T21: 热力色带（L0）**（RulerFlow.tsx +30 行，commit-cluster.ts 已含 `computeHeatmap`）

- 在尺子轨道 `Box` 内，`zoomTier === "L0"` 时渲染额外 `Box`
- 背景使用 CSS `linear-gradient`，颜色停靠点从 `HeatSegment[]` 生成
- 颜色映射：intensity 0 → transparent, 0.5 → indigo-9@20%, 1.0 → indigo-6@50%

**T22: 内存回收**（RulerFlow.tsx +25 行）

- 新增 `useEffect` 设置 60 秒 interval
- 回调中遍历 `queryClient` 的 `["rulerSegment", projectId, *]` 查询
- 已折叠且不在视口 ±3 屏范围内的区间 → `queryClient.removeQueries`
- 展开中的区间不回收
- 组件卸载时清除 interval

---

## 核心原则

- 主分支是不可动摇的时间线
- 所有工作都是从它分出去、再合回来的临时分支
- Review 是合并前的质量关卡
- 历史永远向前推进，不可修改
- 画布围绕弹性尺子组织，注意力自然聚焦在当前活跃的工作上，历史按需展开
