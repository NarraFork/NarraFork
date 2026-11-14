# P0 · Design Token 层：策划与落地方案（自审修订版）

> 目标：把「颜色/字号/圆角/间距」从散落的字面量收敛为可验证的单一来源，**不改布局、不改交互**。
> 适用范围：`frontend/`。后端与业务逻辑零改动。
> 本版已按 Mantine 9.5.1 源码逐条核对，修订记录见 §0.2。

---

## 0. 结论先行

### 0.1 架构：一句话，方向不可反

```
--nf-ink-*        原始色值（全仓唯一允许写 hex 的地方）
     │  createTheme.colors + tokens.css 语义槽位覆写
     ▼
--mantine-color-* 公共旋钮（Mantine / OLED / 插件主题都往这里写）
     │  var() 别名
     ▼
--nf-surface-* --nf-text-* --nf-line-* --nf-status-*   组件只消费这一层
```

三条硬约束：

1. **不新建第二套命名。** 仓库已有 14 个公开语义名（`frontend/components/plugins/host-tokens.ts:51`）。P0 是把它们背后的取值来源统一，而不是另起一套。
2. **派生方向只能是「palette → Mantine → 语义层」。** 反过来会同时打断 OLED（`styles/oled.css:9`）、插件主题（服务端编译成 `--mantine-*` 覆盖）和插件 iframe 的 token 读取（读的是 `--mantine-*` 的 computed value）。
3. **PR1 零视觉变化。** 先重构后调色，否则 review 无法区分「结构对了」和「颜色好看了」。

### 0.2 自审修订记录（相对初版）

| # | 初版的问题 | 严重度 | 修订 |
|---|---|---|---|
| 1 | 主张正文改成 13px，但 **Mantine 默认 `md` 就是 16px**，`size="xs"` 是 12px。改成 `11/12/13/16/20` 会让正文**变小**，与 issue 里「字太小」的主张相反 | 高 | 字号五档**保持 Mantine 现值**（12/14/16/18/20），P0 只统一字体栈/行高/数字样式；「正文用大一档」是 P2 的**用法迁移**，不是改刻度 |
| 2 | 重定义 `radius` 五档 + `defaultRadius: "xs"`，会让 `radius="sm"` 从 4px 变 6px，且删掉 `lg/xl` 会让现有 `radius="lg"` 组件回退 | 高 | PR1 **完全不动** radius 映射，只新增 `--nf-radius-plane/control/overlay` 三个语义别名 |
| 3 | `colors.dark` 的 10 项数组按视觉顺序写，但 Mantine 的槽位是语义的：`0=text, 2=dimmed, 4=border, 5=hover, 6=default, 7=body`。照初版写会让 `--mantine-color-default` 变成 `#39404F`（本该是边框色） | 高 | 改用**单调 ink 阶**，再在 tokens.css 里精确覆写 7 个语义槽位；不依赖数组下标猜语义 |
| 4 | 没处理「`default-border` 同时用于表单控件边框和 Card 边框」这一冲突：WCAG 要求控件边界 ≥3:1，但装饰性卡片边框要克制 | 中 | 显式取舍：`default-border` 取 3.39:1 满足控件；288 处 `withBorder` 卡片会更明显，列为 P2 的清理项并写进风险表 |
| 5 | 没写 `light-dark()` 的前提（需要 `color-scheme`），一旦不成立整层会错在浅色 | 中 | 已核对：Mantine 在 `styles.css:349/481` 设置了 `--mantine-color-scheme` 与 `color-scheme`，前提成立 |
| 6 | 担心 `fontSizes` 传 `var()` 会被 JS 当数值解析 | 中 | 已核对：`fontSizes` 只用于生成 CSS 变量（`v8-css-variables-resolver.mjs:137`）和 `fontSizeResolver` 拼 `var(...)`（`font-size-resolver.mjs:13`），不会 parse，`var()` 安全 |
| 7 | 语义层里直接写了 hex（`--nf-action-*`），违反自己「hex 只出现在 palette」的规则 | 低 | 补 `--nf-action-*` 到 palette，语义层只做引用 |
| 8 | 浅色 `--nf-status-live` 只有 3.97:1，直接当文字色不达 AA | 低 | 拆成「图形色 / 文字色」两个 token，文字用更深的一档 |
| 9 | 漏了阅读器排版的交互：`--nf-type-*` 由 `typography-css-vars.ts` 发布，`nf-type-scope` 会把 Mantine 字号变量映射成用户设置值 | 中 | 新增 §5.3 说明二者关系与验收项 |
| 10 | 漏了 `spacing` 不能加自定义键：组件 `p="md"` 只认 `xs..xl` | 低 | 明确：`spacing` 映射保持 5 个键，8 档间距只作为 `--nf-space-*` 供 CSS 使用 |
| 11 | 守卫脚本说检查 `fontSize` 字面量，但白名单只按 hex 设计 | 低 | 分两级：hex 硬失败，`fontSize` 先只告警 |

交付物：1 个新样式文件 + 1 个主题文件补丁 + 1 个守卫脚本 + 3 个 PR。

### 0.3 实现期间发现的两个浏览器事实（改变了写法）

用 headless Chrome 探测真实计算值（`getComputedStyle`）时发现，方案里原计划依赖 `light-dark()` 来写语义层，**在 Chromium 上不成立**：

| 事实 | 探测结果 | 影响 | 采用的写法 |
|---|---|---|---|
| `light-dark()` 写在**自定义属性**里时永远取第一个（浅色）分支 | `color-scheme` 计算值为 `dark`，但 `--x: light-dark(#111, #eee)` 报 `#111` | 整个语义层会静默用浅色值 | 语义 token 按 scheme **各写一遍**，不用 `light-dark()` |
| `light-dark()` 写在**普通属性**里时，若 `color-scheme` 来自 `var()`，仍按浅色解析 | `getComputedStyle(...).colorScheme === "dark"`，但 `background: light-dark(#121212, #fefefe)` 渲染成 `#fefefe` | 仓库现有的 `light-dark()` 用法（`components/git/GitSplitDiff.module.css`）在深色下会拿到浅色分支 | token 层用**字面量**声明 `color-scheme: dark/light`（Mantine 用的是 `var(--mantine-color-scheme)`，不生效） |

第二条同时解释了为什么 `tokens.css` 里要显式写 `color-scheme`：即使不去覆盖 Mantine，也要让普通属性里的 `light-dark()` 正常工作。这两点都写进了 `tokens.css` 的注释。

---

## 1. 现状（实测，作为设计前提）

| 事实 | 位置 | 意味着什么 |
|---|---|---|
| 已有 14 个语义 token：`color-body` / `color-text` / `color-surface` / `color-border` / `color-primary` / `radius` / `spacing` / `font` … | `frontend/components/plugins/host-tokens.ts:51` | 语义词汇表已存在，但**只服务插件 iframe**，宿主自己不用 |
| 值不是映射表，而是从 live document 读 `--mantine-*` 的 computed value | 同上 `readHostTokens()` | 刻意契约：OLED / 插件主题靠覆写 Mantine 变量生效，P0 必须保住 |
| 主题只有 `primaryColor` / `defaultRadius` / 一个 `slate` 调色板 | `frontend/lib/mantine-theme.ts:13` | 没有 `fontSizes` / `lineHeights` / `spacing` / 语义色 |
| OLED 覆写 `--mantine-color-body` | `frontend/styles/oled.css:9` | 语义层必须经由 Mantine 变量 |
| 插件主题编译成作用域化的 `--mantine-*` 覆盖 | `server/services/plugin-catalog.ts` → `theme-compiler` | 对第三方是公开契约，不能破 |
| 排除测试后仍有 168 种唯一 hex、290 处字面量；18 个 CSS Module + 13 个全局 CSS | `frontend/` | 无统一来源 |
| `size="xs"` 2570 次 > `size="sm"` 1745 次 | `frontend/` | 密度默认值反了：`xs`（12px）成了正文 |
| 组件里写死 `fontSize: 12`(23) / `13`(11) / `11`(9) / `10`(3) | `frontend/` | 绕过刻度的地方多 |

**对 issue 初稿的修正**：原稿说「没有 token 层」不准确。准确说法是：有一个只为插件服务的最小语义集，宿主样式不走它，且值单向来自 Mantine。

### 1.1 Mantine 9.5.1 的默认刻度（本方案的事实基线）

| 刻度 | 默认值 |
|---|---|
| `fontSizes` | xs 12 / sm 14 / md 16 / lg 18 / xl 20（rem） |
| `lineHeights` | xs 1.4 / sm 1.45 / md 1.55 / lg 1.6 / xl 1.65 |
| `radius` | xs 2 / sm 4 / md 8 / lg 16 / xl 32（`defaultRadius: "sm"` = 4px，仓库现状） |
| `spacing` | xs 10 / sm 12 / md 16 / lg 20 / xl 32 |
| 深色语义槽位 | `text=dark-0` `body=dark-7` `default=dark-6` `default-hover=dark-5` `default-border=dark-4` `dimmed=dark-2` `placeholder=dark-3` |

这意味着：issue 里「10–12px 满屏」是**用法问题**（大量正文写成 `size="xs"` = 12px），不是刻度定小了。P0 不动刻度，P2 改用大一号。

---

## 2. 设计计划（四个轴）

### 2.1 主题定位（brief）

- **产品**：自托管 AI 会话工作台，多模型、多会话、可并行。
- **受众**：同时盯 3–10 个 agent 的开发者，宽屏、长会话、信息密集。
- **界面的首要职责**：一眼看出「哪个会话在动、哪个在等我、哪个挂了」。
- **不是** SaaS 仪表盘。近亲是 IDE、终端多路复用器、日志查看器。

设计隐喻：**工作台的面板与刻度线**（planes & rules），不是卡片。

### 2.2 色彩

**① 中性色用带蓝相的 ink，不用纯灰。**
理由不是好看，是可信：界面主要内容是代码、diff、终端、日志，它们本身在终端配色体系里。纯灰外壳 + 彩色内容会让两侧互不隶属；蓝相 ink（饱和度 3–6%）让外壳和内容像同一块材质，同时不和 indigo 主色抢。

**② 强调色拆成两个角色。**

| 角色 | 用在哪 | 不用在哪 |
|---|---|---|
| `action` | 用户意图：主按钮、焦点环、当前选中 | 系统状态 |
| `status/*` | 系统状态：live / waiting / attention / danger | 按钮与链接 |

`status/*` 沿用 `mantine-theme.ts:17-36` 注释已写的规则（蓝=等待、橙=需要你、灰=空闲），P0 只把规则变成 token，不新造语义。

### 2.3 排版

- **字体栈**：继续用系统 UI 字体，不引入 webfont——自托管产品要在离线/内网/低带宽可用，webfont 的收益抵不过失败模式。但 **CJK 必须显式排序**（中文是主语言）。
- **密码字体只给标识符**：路径、ID、哈希、命令用 mono；**不给**小号标签用 mono（最常见的"AI 生成感"来源之一）。
- **五档字号保持 Mantine 现值**，P0 只补字体栈 + 行高 + 数字样式。
- **表格数字**：计数、耗时、token 数一律 `tabular-nums`。截图里 `593.3 / 265,180 / 25.8k` 在流式输出时宽度会跳。

> 与初版的关键差别：不再把正文改成 13px。13px 这个数字来自组件里 `fontSize: 13` 的字面量分布，不是刻度；改刻度会让全站变小。真正要改的是**哪些地方用了 `xs`**。

### 2.4 层级概念（P0 只定义，不重排布局）

```
┌──────────────────────────────────────────────┐ canvas  #0B0E14  ← 工作区底色
│ ┌────────────┐ ┌───────────────────────────┐ │
│ │ pane       │ │ pane                      │ │ pane    #191D26  (1.15:1)
│ │ #191D26    │ │ ┌───────────────────────┐ │ │
│ │            │ │ │ raised                │ │ │ raised  #22262F  (1.14:1)
│ │ ── rule ── │ │ │ #22262F               │ │ │ rule    ≈2.0:1（混色）
│ └────────────┘ │ └───────────────────────┘ │ │
│                └───────────────────────────┘ │
└──────────────────────────────────────────────┘
```

关键取舍：**不要指望单靠底色区分深色界面上的层。** 深色下相邻表面的对比度有物理上限，做到 1.5:1 以上就会发灰显脏。所以：

- 表面之间：≥ 1.12:1，只用于**分组**；
- 真正的边界交给 `--nf-line`（由 `default-border` 混出 ≈2.0:1，装饰用）和 `--nf-line-strong`（3.39:1，可交互边界，符合 WCAG 1.4.11）。

`--nf-line` 用 `color-mix()` 从 `--mantine-color-default-border` 派生，而不是直接取 palette——这样它会自动跟随 OLED 与插件主题，不会出现"换了主题但分隔线没变"。仓库已在用 `color-mix`（`components/narrator/vlist/vlist-morph-driver.ts:135`）。

这一条要写进 tokens.css 注释，否则后续一定有人"把层调清楚"把界面调灰。

### 2.5 圆角与间距

圆角按**角色**分，不按尺寸分（和「SaaS 卡片套件」最直接的区别）：

| 角色 | token | 值 | 对象 |
|---|---|---|---|
| 平面 | `--nf-radius-plane` | 0 | 面板、分区、条带 |
| 控件 | `--nf-radius-control` | 4px（= `--mantine-radius-sm`） | 按钮、输入、标签 |
| 浮层 | `--nf-radius-overlay` | 8px（= `--mantine-radius-md`） | 菜单、弹层、Modal |

**P0 不改 Mantine 的 radius 映射**（改了会连带改变 `radius="sm"` 的语义，属于视觉变更）。语义别名只用于新代码和 CSS Module。

间距：Mantine 的 `spacing` 只能有 5 个键（组件 `p="md"` 只认 `xs..xl`），所以 8 档间距只作为 `--nf-space-1..8` 提供，不塞进 Mantine。

### 2.6 运动

P0 只定义三档时长（120 / 180 / 240ms）+ 一条缓动，并把 `prefers-reduced-motion` 兜底写进 token 层。具体动效留给 P2。

---

## 3. 自评：差点滑进模板默认的地方

| 差点变成 | 为什么是默认 | 改成了什么 |
|---|---|---|
| 近黑底（#0B0B0B/#111）+ 单一高饱和强调色 | AI 生成界面的第一号特征 | 蓝相 ink（饱和 3–6%）+ 强调色按职责拆两个角色 |
| 所有容器同一圆角 + 统一柔和阴影 | SaaS 卡片套件的典型特征 | 圆角按角色三档、禁装饰性阴影，边界交给 rule |
| 深色下靠底色分层 | 深色物理上做不到，最后一定变灰 | 表面只分组，边界交给可验证的 rule/rule-strong |
| 小号元信息统一用 mono | 像命令行的"假技术感" | mono 只给标识符；数字用 tabular-nums 而非 mono |
| 每个区块加全大写小标签（eyebrow） | 模板特征 | 不加 |

保留的"默认"是经过判断的：系统字体栈（离线可用）、不用装饰性渐变、不做编号标记（内容不是序列）。

---

## 4. Token 规格

### 4.1 调色板（唯一允许出现 hex 的层）

**Dark（ink，单调递减亮度）**

| 名 | 值 | 用途 | 相对 pane 实测 |
|---|---|---|---|
| `ink-950` | `#0B0E14` | canvas / body | 1.15:1（作画布） |
| `ink-900` | `#191D26` | pane / default | 基准 |
| `ink-850` | `#22262F` | raised / hover | 1.14:1 |
| `ink-800` | `#2C3240` | overlay | 1.32:1 |
| `ink-700` | `#39404F` | 装饰线基色 | 1.62:1 |
| `ink-600` | `#657086` | line-strong（控件边界） | **3.39:1** |
| `ink-300` | `#8A93A5` | text-muted / dimmed / placeholder | **5.46:1** |
| `ink-200` | `#B7BFCE` | text-secondary | **9.12:1** |
| `ink-100` | `#E7EBF3` | text | **14.12:1** |

**Light（paper）**

| 名 | 值 | 用途 | 相对白实测 |
|---|---|---|---|
| `paper-50` | `#F6F7F9` | canvas | 1.07:1 |
| `paper-0` | `#FFFFFF` | pane | 基准 |
| `paper-100` | `#EEF1F5` | raised | 1.13:1 |
| `paper-200` | `#E6EAF1` | overlay | 1.21:1 |
| `paper-300` | `#D8DEE8` | rule | 1.35:1 |
| `paper-500` | `#7E8A9E` | line-strong | **3.49:1** |
| `paper-600` | `#5E6878` | text-muted | **5.63:1** |
| `paper-700` | `#414A5A` | text-secondary | **8.93:1** |
| `paper-900` | `#141821` | text | **17.76:1** |

**动作色（补齐 palette，避免语义层出现裸 hex）**

| 名 | dark | light |
|---|---|---|
| `action-fill` | `#5060DB` | `#4459D8` |
| `action-fill-hover` | `#5A6AE0` | `#4A5FDD` |
| `action-text` | `#A0AEF7` | `#3A50B8` |
| `action-subtle` | `#1E2236` | `#EDF0FE` |

**状态色（图形 / 文字分开）**

| 状态 | dark 图形 | dark 文字 | light 图形 | light 文字 |
|---|---|---|---|---|
| live | `#46C6BC` (8.08:1) | `#7FD8D2` (11.2:1) | `#0F8F86` (3.97:1) | `#0B7268` (5.2:1) |
| wait | `#7D95B8` (5.51:1) | 同左 | `#5A739A` (4.82:1) | 同左 |
| attention | `#F0A93E` (8.39:1) | 同左 | `#96600B` (5.28:1) | 同左 |
| danger | `#F0555A` (4.94:1) | 同左 | `#C2262B` (5.82:1) | 同左 |

> 浅色 `live` 图形色只有 3.97:1，够 WCAG 的非文本 3:1，但不够文字 4.5:1——所以文字必须换深一档。这是初版漏掉的。

### 4.2 语义层（三种状态）

| token | dark | light |
|---|---|---|
| `--nf-surface-canvas` | `var(--mantine-color-body)` | 同左 |
| `--nf-surface` | `var(--mantine-color-default)` | 同左 |
| `--nf-surface-raised` | `ink-850` | `paper-100` |
| `--nf-surface-overlay` | `ink-800` | `paper-200` |
| `--nf-line` | `color-mix(in srgb, var(--mantine-color-default-border) 62%, var(--nf-surface))` | 同左（实测 2.09:1） |
| `--nf-line-strong` | `var(--mantine-color-default-border)` | 同左 |
| `--nf-text` | `var(--mantine-color-text)` | 同左 |
| `--nf-text-secondary` | `ink-200` | `paper-700` |
| `--nf-text-muted` | `var(--mantine-color-dimmed)` | 同左 |

`--nf-surface-canvas` / `--nf-surface` / `--nf-line-strong` / `--nf-text` / `--nf-text-muted` **必须**指向 Mantine 变量而不是直接指向 palette，否则 OLED 和插件主题在这一层断链。

### 4.3 Mantine 语义槽位覆写（PR2 的核心）

| 槽位 | dark | light | 说明 |
|---|---|---|---|
| `--mantine-color-body` | `ink-950` | `paper-0` | |
| `--mantine-color-default` | `ink-900` | `paper-0` | |
| `--mantine-color-default-hover` | `ink-850` | `paper-100` | |
| `--mantine-color-default-border` | `ink-600` | `paper-500` | **3.39 / 3.49:1**，见 §8 取舍 |
| `--mantine-color-dimmed` | `ink-300` | `paper-600` | |
| `--mantine-color-placeholder` | `ink-300` | `paper-600` | 默认是 dark-3(2.69:1)，文字不达标 |
| `--mantine-color-text` | `ink-100` | `paper-900` | |

---

## 5. 落地

### 5.1 新文件 `frontend/styles/tokens.css`

> **PR1 落 palette 段、标量段与语义层**（语义层只读 `--mantine-*`，不覆写，无视觉影响）；
> 两段「语义槽位」（`--mantine-color-*` 覆写）属于 **PR2**。这里给出完整形态是为了让 review 一次看到终态。
>
> 实际落地的文件与下面这版有两处不同，原因见 §0.3（`light-dark()` 在自定义属性里不可用、
> `color-scheme` 必须写字面量）：语义 token 按 scheme 各写一遍；`color-scheme` 显式声明。

```css
/*
 * 设计 token 的唯一来源。全仓 hex 只允许出现在本文件的 palette 段。
 *
 * 派生方向（不可反）：
 *   palette(hex) → --mantine-* → 语义 token → 组件
 * 反过来会同时打断 OLED(styles/oled.css) 与插件主题（服务端编译的 --mantine-* 覆盖），
 * 表现为"换了主题但某些区域不变色"——而且颜色只是差一点，不会被当成 bug 报。
 *
 * 导入顺序：必须在 @mantine/core/styles.css 之后、oled.css 之前（见 main.tsx）。
 * light-dark() 依赖 color-scheme；Mantine 已在 styles.css 的
 * :root[data-mantine-color-scheme] 里设置了它（9.5.1 第 349 / 481 行），前提成立。
 */

:root {
	/* ---- palette: dark ---- */
	--nf-ink-950: #0b0e14;
	--nf-ink-900: #191d26;
	--nf-ink-850: #22262f;
	--nf-ink-800: #2c3240;
	--nf-ink-700: #39404f;
	--nf-ink-600: #657086;
	--nf-ink-300: #8a93a5;
	--nf-ink-200: #b7bfce;
	--nf-ink-100: #e7ebf3;

	/* ---- palette: light ---- */
	--nf-paper-50: #f6f7f9;
	--nf-paper-0: #ffffff;
	--nf-paper-100: #eef1f5;
	--nf-paper-200: #e6eaf1;
	--nf-paper-300: #d8dee8;
	--nf-paper-500: #7e8a9e;
	--nf-paper-600: #5e6878;
	--nf-paper-700: #414a5a;
	--nf-paper-900: #141821;

	/* ---- palette: action / status ---- */
	--nf-action-fill: #5060db;
	--nf-action-fill-hover: #5a6ae0;
	--nf-action-text: #a0aef7;
	--nf-action-subtle: #1e2236;
	--nf-live: #46c6bc;
	--nf-live-text: #7fd8d2;
	--nf-wait: #7d95b8;
	--nf-attention: #f0a93e;
	--nf-danger: #f0555a;

	/* ---- 标量 ---- */
	--nf-radius-plane: 0;
	--nf-radius-control: var(--mantine-radius-sm);   /* 4px，不改语义 */
	--nf-radius-overlay: var(--mantine-radius-md);   /* 8px */
	--nf-space-1: 2px;
	--nf-space-2: 4px;
	--nf-space-3: 8px;
	--nf-space-4: 12px;
	--nf-space-5: 16px;
	--nf-space-6: 24px;
	--nf-space-7: 32px;
	--nf-space-8: 48px;
	--nf-font-ui: ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC",
		"Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
	--nf-font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", monospace;
	--nf-numeric: tabular-nums;
	--nf-dur-fast: 120ms;
	--nf-dur-base: 180ms;
	--nf-dur-slow: 240ms;
	--nf-ease: cubic-bezier(0.2, 0, 0, 1);
}

/* ---- 语义槽位：dark ---- */
:root[data-mantine-color-scheme="dark"] {
	--mantine-color-body: var(--nf-ink-950);
	--mantine-color-default: var(--nf-ink-900);
	--mantine-color-default-hover: var(--nf-ink-850);
	--mantine-color-default-border: var(--nf-ink-600);
	--mantine-color-dimmed: var(--nf-ink-300);
	--mantine-color-placeholder: var(--nf-ink-300);
	--mantine-color-text: var(--nf-ink-100);

	--nf-live: #46c6bc;
	--nf-live-text: #7fd8d2;
	--nf-wait: #7d95b8;
	--nf-attention: #f0a93e;
	--nf-danger: #f0555a;
}

/* ---- 语义槽位：light ---- */
:root[data-mantine-color-scheme="light"] {
	--mantine-color-body: var(--nf-paper-50);
	--mantine-color-default: var(--nf-paper-0);
	--mantine-color-default-hover: var(--nf-paper-100);
	--mantine-color-default-border: var(--nf-paper-500);
	--mantine-color-dimmed: var(--nf-paper-600);
	--mantine-color-placeholder: var(--nf-paper-600);
	--mantine-color-text: var(--nf-paper-900);

	--nf-live: #0f8f86;
	--nf-live-text: #0b7268;
	--nf-wait: #5a739a;
	--nf-attention: #96600b;
	--nf-danger: #c2262b;
}

/* ---- 语义层：只读 Mantine，保证 OLED / 插件主题能传导 ---- */
:root {
	--nf-surface-canvas: var(--mantine-color-body);
	--nf-surface: var(--mantine-color-default);
	--nf-surface-raised: light-dark(var(--nf-paper-100), var(--nf-ink-850));
	--nf-surface-overlay: light-dark(var(--nf-paper-200), var(--nf-ink-800));
	--nf-line: color-mix(in srgb, var(--mantine-color-default-border) 62%, var(--nf-surface));
	--nf-line-strong: var(--mantine-color-default-border);
	--nf-text: var(--mantine-color-text);
	--nf-text-secondary: light-dark(var(--nf-paper-700), var(--nf-ink-200));
	--nf-text-muted: var(--mantine-color-dimmed);

	--nf-action: var(--nf-action-fill);
	--nf-action-hover: var(--nf-action-fill-hover);
}

@media (prefers-reduced-motion: reduce) {
	:root {
		--nf-dur-fast: 0ms;
		--nf-dur-base: 0ms;
		--nf-dur-slow: 0ms;
	}
}
```

### 5.2 主题文件：PR1 不动，PR2 接主题

**修正（实现时发现）**：初版说 PR1 顺带接上 `fontFamily`。这不成立——字体栈一换就在 Linux 上真实改变渲染（Mantine 默认栈含 Roboto/Helvetica，我们的栈含 Noto CJK SC），不满足「零视觉变化」。所以 PR1 **`mantine-theme.ts` 一行不改**，字体栈与深色色阶在 PR2 接：

```ts
// PR2：
export const mantineTheme = createTheme({
	// ...
	fontFamily: "var(--nf-font-ui)",
	fontFamilyMonospace: "var(--nf-font-mono)",
	// 深色中性色阶（0=text · 2=dimmed · 3=placeholder · 4=border · 5=hover
	//              6=default · 7=body），见文件内注释
	colors: { dark: [/* ink 阶 10 档 */] },
	// fontSizes / lineHeights / spacing 仍然不传：传了就等于改刻度
});
```

PR1 唯一的代码改动是 `frontend/main.tsx` 里加一行 CSS 导入。这也是它能做到"零视觉变化"的前提：新文件里没有任何消费者，且不覆写任何 `--mantine-*`。

### 5.3 与阅读器排版的关系（初版遗漏）

`frontend/lib/typography-css-vars.ts` 会把用户的「外观 · 排版」设置发布成 `--nf-type-*` 到 `<html>`，`styles/typography-scope.css` 再把它映射到 `--mantine-font-size-{xs,sm,…}`，且只作用于 `.nf-type-scope` 容器。

因此：

- P0 不动 `--nf-type-*`，也不改字号刻度 → 两者无冲突；
- 若未来改字号刻度，必须确认 `.nf-type-scope` 内的映射仍然以用户设置为准，不能被全局刻度覆盖；
- 验收里加一条：把「排版」调到最大/最小后，正文尺寸仍然生效。

### 5.4 导入顺序（`frontend/main.tsx`）

```ts
import "@mantine/core/styles.css";          // 1. Mantine 基础（含 color-scheme 与语义槽位）
// ...其它 mantine 样式
import "@frontend/styles/tokens.css";       // 2. palette + 槽位覆写（必须在这里）
import "@frontend/styles/oled.css";         // 3. OLED 覆写（在 tokens 之后）
// ...其余全局样式不变
```

顺序错了（尤其 tokens.css 放到 oled.css 之后）会导致 OLED 失效。`oled.css` 的选择器特异性更高，正常情况下仍会胜出，但顺序是双保险。

### 5.5 守卫 `scripts/check-style-tokens.ts`

```ts
// 两级：
//  - hex 字面量：白名单外 → 失败
//  - fontSize 数字字面量：先只告警（存量大，硬失败会立刻堵死 CI）
const ALLOW = [
	"styles/tokens.css",
	"components/terminal/terminal-theme.ts",      // 终端配色是内容不是主题
	"components/settings/BrandingSection.tsx",    // 用户自定义品牌色
];
```

接进 CI，与 `biome check` 并列，建议单独一个 PR。

### 5.6 迁移映射（存量 Top 命中）

| 现值 | 量 | 新 token |
|---|---|---|
| `#1a1b1e` | 9 | `var(--nf-surface-canvas)` |
| `#242424` | 4 | `var(--nf-surface-canvas)`（Monaco 兜底） |
| `#1f2a37` / `#c6e6ff` | 8 | `var(--nf-line)`，用 `light-dark()` 合成一条 |
| `#868e96` | 3 | `var(--nf-text-muted)` |
| `#c0caf5` / `#7d95b8` | 11 | `--nf-wait` 或 `--nf-live`（按语义确认） |
| `fontSize: 12/13/11/10` | 46 | Mantine `size`，或 `var(--mantine-font-size-*)` |

---

## 6. PR 拆分

| PR | 内容 | 视觉变化 | 可回滚性 |
|---|---|---|---|
| **PR1** | 新增 `frontend/styles/tokens.css`（palette + 标量 + 语义层，**不覆写任何 `--mantine-*`**）+ `main.tsx` 加一行导入（位置在 Mantine 样式之后、`oled.css` 之前） | **严格为零** | 删文件 + 删一行导入即可 |
| **PR2** | 打开槽位覆写（§4.3）+ `colors.dark` 换 ink 阶 + 迁移 Top 20 字面量 | 有，需前后截图 | revert 单 PR |
| **PR3** | 守卫脚本 + CI + 存量清理 | 无 | 移除 CI job |

PR1 的验收方式是"零变化"：先合并、观察一个版本，确认无回归后再开 PR2。这也让 PR1 可以独立 review 结构。

> 初版把"槽位覆写"放在 PR1 里，与"零视觉变化"自相矛盾——已在修订中拆开。

---

## 7. 验收标准

- [ ] `frontend/styles/tokens.css` 是唯一含 hex 的样式文件（终端配色与品牌色除外，且在白名单内）
- [ ] 语义 token 全部经 `--mantine-*` 派生；**三种情况**下随动：切 light/dark、开 OLED、启用插件主题（附截图）
- [ ] 插件 iframe 的 14 个 token 值不变：`bun test --isolate frontend/components/plugins/host-tokens.test.ts`
- [ ] 对比度脚本输出满足：正文 ≥4.5、元信息 ≥4.5、可交互边界 ≥3、装饰线 ≥1.5
- [ ] 「外观 · 排版」调到最大/最小后，正文尺寸仍按用户设置生效
- [ ] `bunx @biomejs/biome check .` 通过，且**不新增警告**（fresh clone 基线：0 error / 551 warning）
- [ ] `bunx tsgo --noEmit`：注意 fresh clone 上 `frontend/routeTree.gen.ts` 尚不存在，会先出现一批 `TS2345` 假错误；需先跑一次 `bun run dev:frontend` 或 `bun run build` 生成它，再判断是否有新增类型错误
- [ ] PR2 附每页前后对比截图（会话页 / 侧边栏 / 工作区 / 仪表盘 / 设置页）

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `default-border` 同时管表单控件和 Card 边框，取 3.39:1 会让 288 处 `withBorder` 变明显 | 中 | 明确取舍：控件合规优先；P2 把装饰性卡片边框显式改成 `--nf-line`；PR2 截图里逐页确认 |
| `colors.dark` 一改，全站深色同时变化 | 高 | 只在 PR2 做；按页面出前后对比；changelog 标注为视觉变更 |
| 语义层派生方向写反 | OLED / 插件主题局部失效，且像"颜色差一点" | 文件头注释 + 三态截图验收 |
| `tokens.css` 被放到 `oled.css` 之后 | OLED 失效 | 导入顺序写进注释 + 验收项 |
| Mantine 小版本升级改了变量名 | 映射静默失效 | 守卫加一条：读 `getComputedStyle` 校验 7 个槽位非空 |
| 后人"把深色层调清楚" | 界面发灰 | 把「表面只分组、边界交给 rule」写进注释，并附实测对比度 |

---

## 9. 已知限制

1. 本机环境已就绪：Bun 1.4.4、依赖已装（1261 packages）、Biome 基线 0 error / 551 warning。但 PR2 的「好看」最终仍要由你在本机看截图确认。
2. `--nf-status-*` 与 `mantine-theme.ts` 里已有的 `slate` 调色板有重叠：建议保留 `slate`，新增 `--nf-wait` 作为别名，不删旧值。
3. 方案里的对比度均由 WCAG 公式对 sRGB 计算，未考虑 OLED 屏幕上的视觉差异与色觉障碍模拟；如需完整 a11y，另起一个「配色可访问性审计」任务。

---

## 附录：issue 初稿需同步的一句

原文：

> 把 surface 阶梯拉开到肉眼可辨（建议 ≥ 1.5:1），边框提到 2:1 左右。

建议改成：

> 表面阶梯保持克制（≥1.12:1 只用于分组），真正的边界交给 `rule`（≈1.6:1）与 `rule-strong`（≥3:1，符合 WCAG 1.4.11）。深色下硬拉底色对比会让界面发灰。

---

## 10. 实施记录（已完成）

| 提交 | 内容 |
|---|---|
| `957268e94` | PR1：`tokens.css` 落地 + `main.tsx` 导入顺序（零视觉变化） |
| `853a4c580` | PR2a：ink 深色色阶 + CJK 字体栈 + 语义层按 scheme 拆分 |
| （本次） | PR2b：字面量迁移；PR3：守卫脚本 + CI + 对比度校验 |

### 10.1 本轮实际改动

- **字面量迁移**：diff hunk 配色从两处重复（`DiffContent.tsx`、`GitSplitDiff.module.css`）收敛为
  `--nf-diff-hunk-*`；outline 里 4 处「白字压在调用方传入的颜色上」改为 `--nf-on-solid`；
  终端分栏手柄色改用 `--mantine-primary-color-filled`；`index.html` / `vite.config.ts` /
  `useAuthenticatedAppearance.ts` 的 theme-color 与新画布色对齐（`#0b0e14` / `#f6f7f9`）。
- **守卫脚本** `scripts/check-style-tokens.ts`：
  - 先剥注释再扫描，避免把 `React #185` 这类引用当成颜色；
  - `var(--x, #fallback)` 放行（这类兜底只有在变量缺失时才会用到）；
  - 白名单按文件/目录给出理由；
  - **对比度门槛**一并校验（13 组，正文/元信息 ≥4.5、可交互边界 ≥3、主按钮白字 ≥4.5）；
  - `fontSize` 数字先只告警（存量 48 处），`FONT_SIZE_IS_AN_ERROR` 一个开关即可转成硬失败。
- **CI**：`biome check` 之后新增 `bun run check:tokens`。
- **`.gitignore`**：`scripts/*` 是黑名单 + 白名单结构，新脚本被默认忽略；已补
  `!scripts/check-style-tokens.ts`，否则 CI 上根本没有这个文件。

### 10.2 验收证据

```
bun run check:tokens        1513 files scanned, 0 colour violations, 48 font-size warnings
                            contrast: 13/13 pass
biome                       0 error / 551 warning（与改动前一致）
tsgo                        仅 vscode-extension 缺 @types/vscode（既有）
bun test --isolate frontend/components/plugins/host-tokens.test.ts   12 pass
bun test --isolate frontend/lib/mantine-theme.test.tsx               1 pass
```

浏览器实测（headless Chrome，读 `getComputedStyle`）：

| 场景 | `--nf-surface-canvas` | 结论 |
|---|---|---|
| 深色默认 | `#0b0e14` | 新 ink 画布 |
| 浅色 | `#f6f7f9` | 新 paper 画布 |
| OLED | `#000000` | 跟随 Mantine 覆写 ✓ |
| 模拟插件主题 | `#123456` | 跟随 `--mantine-*` 覆写 ✓ |

守卫脚本做了故障注入验证：写入一个 `#ff00aa` 的字面量 → 退出码 1 且精确定位到行；
注释里的 `#185` 与 `var(..., #1a1b1e)` 兜底不误报；清理后退出码 0。

### 10.3 已知差距（不阻塞本轮验收）

1. **浅色模式的控件边框仍是 Mantine 默认**：浅色下 `--paper-border-color` / `--input-bd` 读的是
   `gray-3` / `gray-4`（约 1.5:1），没有经过 `--mantine-color-default-border`。要修必须在
   `components.*` 层覆盖 Input/Paper 的 `borderColor`，而 Mantine 的错误态也走同一个变量，
   风险是把校验红边一并盖掉。留作独立 PR，带表单错误态回归测试。
2. **48 处内联 `fontSize` 数字**仍未迁移到字号刻度（守卫只告警）。它们与「正文该用哪一档」的
   用法迁移是同一件事，建议和 P2 一起做。
3. `MediaAttachment` 的 `#111` 信件式留边在深浅两套下都保持一个固定观影底色，已列入白名单。
