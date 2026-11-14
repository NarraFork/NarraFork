# 主题色设置：实现方案

> 目标：让用户选「背景/面板色」和「强调色」，带预设 + 自定义，实时生效、刷新保留。
> 现状：`styles/tokens.css` 已是唯一色源；OLED 与插件主题都靠改 `<html>` 上的属性 + CSS 变量。

---

## 0. 结论先行

| 层 | 实现方式 | 为什么 |
|---|---|---|
| **背景/中性色** | 只改 CSS 变量（`--nf-ink-*` / `--nf-paper-*` + `--mantine-color-dark-*`） | 表面色本来就只经变量流转，切换是一次 style recalc，**零 React 重渲染**，和 OLED 同一套机制 |
| **强调色** | 必须重建 Mantine 主题（`createTheme({ primaryColor })`） | Mantine 的 `--mantine-color-indigo-light` 是 JS 里算好的 `rgba()`、`-contrast` 是 `getPrimaryContrastColor()` 的结果；只覆盖 CSS 变量会留下不同步的派生值（浅底、outline-hover、对比色全部错） |

两条硬约束：

1. **自定义色不许直接当底色用**。用户选什么颜色都行，但**亮度阶梯固定**，只换色相/彩度——否则对比度必然塌。
2. **优先级写死并显示在 UI 上**：插件主题 > OLED（只改画布）> 用户主题 > 默认。

---

## 1. 数据模型

```ts
// frontend/lib/palette-presets.ts
export interface PaletteChoice {
  neutral: string;   // 预设 id，或 "custom"
  neutralCustom?: string;  // #rrggbb，neutral === "custom" 时生效
  accent: string;    // 预设 id | "custom" | "default"
  accentCustom?: string;
}
```

存储：**localStorage**（与 OLED 完全一致），键 `narrafork_palette`，值 JSON。
理由：外观设置现在就是按设备存的（`narrafork_oled`、typography 也是），不需要数据库迁移，也不需要处理旧快照导入。

> 如果要跨设备同步，那要另开：`user_preferences` 加列 + `/api/user/preferences` + 迁移 + `data-portability` 兼容。**本次建议不做**。

首屏防闪：`main.tsx` 里照抄 `applyInitialPluginTheme()` 的做法，在 React 挂载前把 `data-nf-palette` 和自定义变量写到 `<html>`，否则刷新时会有一次默认色闪动。

---

## 2. 预设清单

直接用刚才 mock 里你挑过的那些，一套预设同时定义 dark 与 light 两个方案：

```ts
{
  id: "default",   name: "默认 · 蓝黑 / 冷白",  dark: {...}, light: {...}
}
```

| id | 名称 | dark canvas / pane | light canvas / pane |
|---|---|---|---|
| `default` | 默认 | `#0b0e14` / `#191d26` | `#f6f7f9` / `#ffffff` |
| `graphite` | 石墨 | `#16181d` / `#1f2229` | `#eef1f6` / `#ffffff` |
| `midnight` | 藏青 | `#10131f` / `#191e2e` | `#f1f5fc` / `#ffffff` |
| `tokyo` | 东京夜 | `#1a1b26` / `#24283b` | `#f1f4fb` / `#ffffff` |
| `warm` | 暖炭 / 暖纸 | `#191714` / `#221e1a` | `#faf8f4` / `#ffffff` |
| `forest` | 墨绿 | `#0f1714` / `#17211d` | `#f0f5f2` / `#ffffff` |
| `contrast` | 高对比 | `#0b0e14` / `#20252f` | `#e8ecf2` / `#ffffff` |

强调色预设：`indigo`（现状）、`blue`、`teal`、`green`、`amber`、`violet`、`rose`。

---

## 3. 自定义颜色算法

用户的输入只有一个颜色，要生成 **9 阶中性色 + 10 阶强调色**。做法是 **OKLCH：锁亮度，换色相**。

### 3.1 为什么不是「调亮调暗」

直接对用户色做明度缩放，会让不同色相在同样亮度下对比度差出一大截（黄色和蓝色在相同 L 下 Y 差很多），守卫里的对比度门槛必然被踩。锁 L 阶梯则相反：颜色怎么换，层级关系不变。

### 3.2 现有阶梯（实测 OKLCH，已转好，直接写进代码）

| 阶 | 用途 | L | C | H |
|---|---|---|---|---|
| ink-950 | 画布 | 0.163 | 0.014 | 264 |
| ink-900 | 面板 | 0.231 | 0.019 | 266 |
| ink-850 | 抬升 | 0.269 | 0.018 | 266 |
| ink-800 | 浮层 | 0.317 | 0.027 | 267 |
| ink-700 | 装饰线 | 0.371 | 0.028 | 265 |
| ink-600 | 控件边界 | 0.544 | 0.037 | 264 |
| ink-300 | 元信息 | 0.662 | 0.029 | 264 |
| ink-200 | 次要文字 | 0.803 | 0.023 | 263 |
| ink-100 | 正文 | 0.939 | 0.012 | 265 |

浅色同一套思路（paper-50 → paper-900，L 从 0.976 到 0.209）。

### 3.3 生成规则

1. 用户色 → OKLCH，取 `H`；`C` 取 `min(用户 C, 0.035)`，下限 0.008（避免纯灰失去材质感）。
2. 按上表固定 `L` 生成 9 阶，转回 sRGB。
3. **校验**：用与 `scripts/check-style-tokens.ts` 相同的对比度函数跑 13 组门槛；
   任一组不达标，就在 ±0.02 范围内微调该阶的 L（最多 20 次迭代），保证结果一定合规。
4. 强调色：固定 10 阶 L（0.95 → 0.25），`C` 取 0.12–0.19（按色相做 gamut 裁剪），
   要求 `白字 on 第 6 阶 ≥ 4.5:1`、`第 5 阶 on 深色面板 ≥ 4.5:1`。

sRGB ↔ OKLCH 转换自己写（约 60 行），不引第三方包——这个仓库对依赖很克制。

---

## 4. 优先级与冲突

```
插件主题  >  OLED(canvas=#000)  >  用户主题  >  默认
```

- **插件主题启用时**：外观面板里的主题色设置**灰显**并给出说明（插件主题是完整设计，混搭只会两败俱伤）。
- **OLED 开启时**：只把 canvas 压成 `#000`，面板/边框跟随用户主题（`oled.css` 已经是这个分工）。
- 用户主题只影响 `--nf-*` 与 `--mantine-color-dark-*` / paper 槽位，**不碰**状态色（live/wait/attention/danger）——那四个是语义，不该被主题改。

---

## 5. UI（设置 → 外观）

```
主题
  [浅色 | 深色 | 自动]              ← 现有 ThemeSwitcher
  [ ] OLED 纯黑
  插件主题: [无 ▼]                  ← 现有

  主题色                          ← 新增
  ┌──────┐ ┌──────┐ ┌──────┐
  │ 默认 │ │ 石墨 │ │ 藏青 │  …   每个卡片画出「画布+面板」两色块
  └──────┘ └──────┘ └──────┘
  自定义  [■ #16181d]  （Mantine ColorInput，可手输 hex）

  强调色
  ● ● ● ● ● ● ●   6 个色点 + [自定义]
```

交互细节：

- 点选即时生效（设置页本身就是预览），不需要「保存」按钮。
- 自定义背景只允许「低彩度」区间的输入：ColorInput 旁边给一个彩度滑杆（0–0.05），默认取 0.02，避免用户把自己的界面调成荧光色。
- 顶部给一行「恢复默认」。

---

## 6. 文件清单

| 文件 | 改动 |
|---|---|
| `frontend/lib/palette-presets.ts` | 新增：预设表、OKLCH 转换、阶梯生成、对比度自校正 |
| `frontend/lib/palette-apply.ts` | 新增：把生成结果写到 `<html>`（照 `typography-css-vars.ts` 的订阅模式）|
| `frontend/hooks/usePalettePref.ts` | 新增：读 localStorage + 跨标签同步（可复用 `useLocalPref` 的 storage 事件机制）|
| `frontend/hooks/useAuthenticatedAppearance.ts` | 应用属性/变量 |
| `frontend/main.tsx` | 首屏前置应用，避免闪色 |
| `frontend/App.tsx`（或 `CoreProviders.tsx`）| 强调色变更时用 `createAppTheme()` 重建 Mantine 主题 |
| `frontend/components/settings/ThemeColorCard.tsx` | 新增 UI |
| `frontend/components/settings/AppearanceSection.tsx` | 插入新卡片 |
| `frontend/locales/{en,zh-CN}/settings.json` | 文案 |
| `frontend/styles/tokens.css` | 预设的静态回退块（JS 未执行时的首帧） |
| `scripts/check-style-tokens.ts` | 白名单加 `lib/palette-presets.ts`；对比度校验扩展到所有预设 |

测试：

- `palette-presets.test.ts`：六种色相（0/60/120/180/240/300）生成的阶梯 **L 单调**、13 组对比度全过、极端输入（纯黑/纯白/荧光黄）不抛错。
- `palette-apply.test.ts`：写变量、订阅、清理（用 jsdom 或 browser test）。

---

## 7. 分阶段

| 阶段 | 内容 | 视觉影响 |
|---|---|---|
| **P1** | 背景预设 + 本机存储 + 设置 UI | 有（可选主题） |
| **P2** | 自定义背景（OKLCH + 彩度滑杆） | 有 |
| **P3** | 强调色（JS 主题重建） | 有 |
| **P4（可选）** | 跨设备同步（上服务端） | 无 |

P1 就能满足「几个预设 + 自己设置」的大部分诉求，P3 是很多人口中的「主题色」本体，建议一起做。

---

## 8. 验收标准

- [ ] 切换预设：无闪烁、无布局跳动，`check:tokens` 的对比度门槛在**每个预设**下都通过
- [ ] 刷新后保持；两个标签页切换互相同步
- [ ] OLED 开启时画布仍为纯黑，面板跟随用户主题
- [ ] 插件主题启用时，主题色区域灰显并说明原因
- [ ] 自定义极端颜色（#000、#fff、#ff0）不会产生任何低于门槛的组合
- [ ] 切主题不会触发整棵树重渲染（背景色路径）；强调色路径允许一次重渲染

---

## 9. 需要你定的三件事

1. **「主题色」指哪个？** 背景/面板色、强调色（按钮/选中/链接），还是两个都要？我建议两个都做（P1+P3）。
2. **存本机还是跟账号？** 本机零成本（推荐，和 OLED 一致）；跨设备同步要动数据库和导入导出。
3. **预设要哪几套？** 上面 7 套可以全留，也可以砍到 4 套（默认/石墨/暖炭/墨绿）少占地方。

---

## 10. 实施记录

已实现 P1–P3（背景预设、自定义背景、强调色），存储沿用 localStorage。

| 文件 | 内容 |
|---|---|
| `frontend/lib/palette-presets.ts` | 纯函数：OKLCH 转换、固定 L 阶梯生成、对比度自校正、预设表、`parsePaletteChoice` 容错 |
| `frontend/lib/palette-apply.ts` | 写 `<html>` 变量、localStorage 读写、跨标签订阅、首屏 `applyInitialPalette()` |
| `frontend/hooks/usePaletteChoice.ts` | `useSyncExternalStore`（按原始字符串缓存快照，避免每帧新对象） |
| `frontend/components/CoreProviders.tsx` | 强调色经 `createTheme` 重建；中性色不参与 |
| `frontend/components/settings/ThemeColorCard.tsx` | 预设色块 + 自定义 + 恢复默认；插件主题启用时禁用并说明 |
| `frontend/main.tsx` | 挂载前应用，避免刷新闪色 |
| locales | 22 个键（中英同步） |

### 与方案的两处偏差（有意）

1. **没做彩度滑杆**。自定义只取用户色的**色相**，彩度固定为实测值。理由：让用户把彩度拉到 0.05 以上只会得到荧光屏，而我们的色阶本来就靠 L 控制层级，彩度可变只会增加破坏机会。
2. **`--mantine-color-dark-8/9` 由 canvas 推导**（L × 0.877 / 0.742），没往 `tokens.css` 里加两个公开 token。这两个槽位只服务 `color="dark.8"` 和 filled 变体，不值得扩大 token 面。

### 验证

- `bun test --isolate frontend/lib/palette-presets.test.ts`：7 项，380 断言（7 套预设 × 对比度门槛、12 种色相的自定义、极端输入 #000/#fff/#ff0、解析容错、OKLCH 往返）
- headless Chrome 实测：预设 `tokyo` + 强调色 `teal` → `--nf-ink-950=#0c0d17`、`--mantine-color-dark-7` 同步、`--mantine-primary-color-filled=#107a7a`、按钮实际渲染 `rgb(16,122,122)`；恢复默认后全部回滚
- `check:tokens` 通过；biome 0 error / 551 warning；tsgo 仅剩既有 1 个 vscode 错误

### 10.1 默认调色板换成 Radix Slate（2026-11）

反馈「默认色不好看」后，调研了三个有对比度体系支撑的方案并全部做成预设：

| 来源 | 特点 | 落点 |
|---|---|---|
| **Radix Colors**（slate） | 12 阶语义化、专为 UI 设计、对比度经过验证 | **成为新默认** |
| GitHub Primer | 开发者最眼熟，面板层次偏克制 | 预设 `github` |
| Catppuccin（Mocha / Latte） | 社区流行，柔和 | 预设 `catppuccin` |

采用的改动（不是照抄）：

1. **边框换成可达 3:1 的权重**。Radix 第 7 阶在深色下只有 1.72:1，Catppuccin Latte 的边框 2.99:1、`subtext0` 4.37:1——直接照搬会踩我们自己的门槛，所以边框/文字各上调一档（Radix 3.46:1，Catppuccin 3.31:1 / 5.53:1）。
2. **画布压暗一档**。GitHub（1.09:1）和 Catppuccin（1.07:1）的面板与画布太接近，按我们的「面板要浮起来」标准压到 1.12:1。
3. 旧配色保留为预设 `classic`，一键切回。

新默认的关键数值（相对面板 `#212225`）：正文 13.70:1、元信息 7.64:1、控件边界 3.46:1、面板/画布 1.19:1。

---

## 11. 自定义背景图（壁纸）

和主题色同一套存储与开关位置（设置 → 外观 → 背景图），只存 URL，不上传、不落盘。

### 11.1 结构

```
body     图片 + 遮罩渐变（fixed，铺满视口）
#root    半透明底色 + backdrop-filter 模糊底图（文字主要落在这层之上）
面板     再实一档的 --mantine-color-default，图片只从边缘透出
```

三个可调参数，默认 **面板不透明度 80% / 遮罩 40% / 模糊 10px**。模糊不是装饰：清晰照片垫在正文下面，字号再大也难读；模糊保留色彩与氛围，遮罩控制强度。

### 11.2 实现时踩的两个坑（都已修，写进注释）

1. **`html::before` 不显示**。负 z-index 的根元素伪元素会被画在 canvas 之下，图片加载正常、computed style 也正常，但一个像素都不出。改用 `body` 的背景层。
2. **选择器特异性**。Mantine 在 `:root[data-mantine-color-scheme="dark"]`（0,2,0）上设 `--mantine-color-body`，而 `html[data-nf-bg="on"]` 只有（0,1,1），于是底色仍是不透明，图片被完全盖住。必须写成 `:root[data-mantine-color-scheme][data-nf-bg="on"]`（0,3,0）。这个失败尤其隐蔽——图片在 DevTools 里能选中，计算样式也正确。

### 11.3 安全与格式

- 只接受 `http(s)`：`javascript:` 是注入面，`data:` 会撑爆 localStorage 配额。
- URL 里的引号/反斜杠直接拒绝，写入前再转义一次，避免闭合 `url("…")` 声明。
- PNG / JPEG / WebP / SVG / GIF 都由浏览器原生处理；动图会持续耗电，已在文案里提示。
- 远端图每次打开都会请求该地址；离线或链接失效时自动退回纯色背景。

### 11.4 验证

- `bun test --isolate frontend/lib/app-background.test.ts`：4 项（协议白名单、引号注入、数值钳制与非法 URL 自动禁用、变量写入/清除）
- headless Chrome 实测：纯红测试图在 55%/无遮罩下中心像素 `(148,8,9)`，确认图层真的在画；渐变图在 80/40/10 下背景可见、卡片仍可读
- biome 0 error、tsgo 仅剩既有 1 个、`check:tokens` 通过、i18n 覆盖率 100%

### 10.2 「预设全是黑的」：三个叠加原因

截图反馈十个色块都是一团黑。查下来是三个问题叠在一起，单独任何一个都不会这么糟：

1. **literal 分支从未生效**。`resolvePalette` 里那段 `if (preset.literal)` 是后加的补丁，锚点没匹配上但脚本照样打印了成功，于是 `GitHub` / `Catppuccin` / `经典蓝黑` 一直在按 hue 现算，根本没用到各自的原始色值。→ 已补上，并加了回归测试断言三者的 `ink-950` 等于其字面值。
2. **生成用的亮度阶梯还是旧默认的**。新默认换成 Radix 后，阶梯没跟着换，导致石墨/藏青/东京夜等全部压在同一个黑度上。→ 按新默认重算了 OKLCH 阶梯。
3. **彩度不够，色相不可见**。新阶梯本身几乎是中性（画布 C≈0.004），再乘预设强度（1.25/1.6）也只有 0.005–0.006，人眼根本分辨不出。→ 给深色表面加彩度下限 0.012（浅色 0.006），纯灰预设强度为 0 时仍保持中性；用户选灰色也不会被强行染色。

**色块本身也改版了**：原来只画"画布+面板"两块色，而这两级本来就只差 1.1–1.2:1，缩略图里等于没有信息。现在画成一个微型窗口——画布底、内嵌面板、面板里再放一条正文条和一条次要文字条，色相和层级同时可读。

### 11.5 壁纸不显示 / 图标错位：原因与修法

**壁纸不显示**——不是网络问题，是防盗链：

```
curl 无 Referer        → 200
curl 带 localhost Referer → 403
```

浏览器请求 CSS `background-image` 时一定会发 Referer，而 CSS 没有关闭它的手段；图床因此返回 403，且**背景图加载失败是完全静默的**，界面只剩纯色，看起来就像"功能没生效"。

改法：把壁纸从 CSS 背景换成 `<img referrerpolicy="no-referrer">` 图层。逐元素关闭 Referer 是绕开这类防盗链的唯一办法，也不需要改动整个文档的 referrer 策略。附带好处是 `<img>` 有 `onload/onerror`——加载失败现在会在设置页显示明确提示，而不是让人对着空白猜。

**图标错位**——`backdrop-filter` 的副作用。之前给 `#root` 加了 `backdrop-filter: blur()`，而带 `filter`/`backdrop-filter` 的元素会成为所有 `position: fixed` 后代的包含块，应用内的悬浮按钮、通知、工具条于是相对 `#root` 而不是视口定位，全部偏移。图片本身已经用 `filter: blur()` 模糊了，这层是多余的，直接删掉。

### 11.6 本地文件

- 选图后写入 IndexedDB（localStorage 5MB 配额放不下壁纸），刷新后自动读回
- 运行时用 `URL.createObjectURL` 提供，替换时 `revokeObjectURL`，不泄漏
- 只存一张，重新选图会覆盖；"清除"会同时删掉 blob 与偏好
- 本地文件不经过网络，不受防盗链、离线、域名失效影响

### 11.7 切源丢配置 / 弹层透明 / 重新加载

1. **网络↔本地切回来就不显示**：选本地文件时把 `url` 清成了空串，切回「网络地址」自然无图可加载；切源还无条件 `enabled: false`。改为 `switchBackgroundSource()`：两个来源各自保留配置，`enabled` 跟随新来源是否有效。已加回归测试（6 项）。
2. **弹层跟着变透明**：之前把全局 `--mantine-color-body` 改成了半透明，而 Modal / Menu / Dropdown / Tooltip 都 portal 到 `<body>` 读同一个变量——它们下面不是面板而是壁纸，于是弹窗也变成半透明，很难读。改成只让 `#root` 半透明（作用域限于外壳），`--mantine-color-body` 保持不透明；面板仍走 `--mantine-color-default` 的混合值。
3. **重新加载按钮**：URL 输入框后新增「重新加载」，带 `nf_reload=<nonce>` 参数，避免浏览器直接命中缓存导致"点了没反应"。

### 11.8 重新加载没有生效 + 界面空白

**重新加载不刷新**：nonce 原本存在按钮所在组件的 state 里，但壁纸会被**两个** hook 实例应用（应用外壳的 `CoreProviders` 和设置卡片）。父级实例后运行、用不带 nonce 的 URL 覆盖了子级刚设置的那次，于是看起来"点了没反应"。改成把 `reloadKey` 存进偏好本身：所有实例读到同一个值，后续任何设置变化也不会把它冲掉（已加单测）。

**界面空白**：不是功能逻辑，是我当时正在改的中间版本被 Vite HMR 推到了浏览器——那一版里 `syncWallpaperLayer` 引用了一个尚未定义的 `options`，运行时抛错直接打穿了整棵树。两处加固：
- 壁纸的应用逻辑全部包进 `.catch()`，失败只置为 `status="error"`，绝不让异常冒到 React；
- 这道 effect 挂在包住所有路由的 provider 上，任何抛出都会白屏，所以这里不允许 throw。

遇到空白时先强刷一次（Cmd/Ctrl+Shift+R），清掉 HMR 留下的旧模块。

### 11.9 浅色下"壁纸不显示" / 界面被洗白

两张截图都指向同一件事：**浅色模式下壁纸看得见，但被冲淡到看起来不存在**，而加载失败时连兜底底色都没有。

1. **失败兜底**：图层加载失败时原本 `display:none`，于是剩下的只有"透明的 body + 62% 的外壳"，下面直接是浏览器白底——整个界面被洗白。现在图层始终保留（它同时负责铺画布底色），失败时只隐藏 `<img>`；并给 `<html>` 加了画布底色的硬兜底。
2. **浅色配比**：同一套遮罩/不透明度在深色下合适，浅色下会把照片冲成一片白。改为按 scheme 调整（CSS `calc`，不依赖 JS）：浅色外壳 +12%、面板 +10%、遮罩 +12%。
3. **状态可见**：设置卡片新增「状态：已加载 / 加载失败 / 加载中 / 未启用」。之前"加载失败"和"图片太淡看不出来"是完全一样的观感，只能靠猜。

### 11.10 进到真实应用里看，浅色被冲成一片白

光靠组件探针不够——**用隔离副本里的临时账号登录了真实应用**截图后才发现：浅色模式下卡片是 90% 白叠在亮照片上，读起来像"界面没了"；而顶栏用的是不透明的 `--mantine-color-body`，主区域却半透明，两者层级不一致。

最终浅色配比：面板 96%（近乎不透明，文字清晰）、外壳 74%（照片透出）、遮罩 30%（比深色更低——浅色叠加遮罩只会把照片冲得更白）。

同时加了「强度：淡 / 中 / 浓」快捷档（一键设定 不透明度/遮罩/模糊 三个值），不必为了"看得见"逐个拖滑杆。

> 排查方式记录：在隔离库中建临时账号 → 用 `/api/auth/login` 取 token → 页面写入 localStorage 后用带 user-data-dir 的 headless Chrome 截图。用完删除账号与种子页。

### 11.11 只有会话页不显示壁纸

根因：会话页由 **dockview** 承载，面板背景来自 `--dv-group-view-background-color`，该变量在
`components/dockview/theme.css` 里被设成 `var(--mantine-color-body)`。而我为了修"弹窗透明"，
把 `--mantine-color-body` 改成了**不透明**——于是仪表盘（透明容器）能看到壁纸，会话页（dockview 面板）
被整块盖住。全仓另有约 35 处组件直接以 `--mantine-color-body` 作背景，同理。

修法：
1. `--mantine-color-body` 重新半透明，并同步 `--dv-group-view-background-color`；
2. 弹层改由 **ARIA 角色**钉成不透明（`[role="dialog"|"menu"|"listbox"|"tooltip"]`）——
   角色属性是稳定契约，Mantine 生成的类名不是；
3. 默认值上调到 68% / 20% / 6px：之前的 80/40/10 是按"尽量不打扰 UI"调的，在浅色 + 亮照片下
   等同于"没生效"。强度档可以一键收回。

验证：在真实会话页截图，浅色与深色下壁纸均可见，弹窗仍不透明。

### 11.12 再降白度：透明度已经榨不出效果

在浅色 + 白底照片下，把面板透明度从 90% 降到 74% 几乎看不出变化——因为照片本身是白的，透过去还是白。真正有效的是给表面掺入少量墨色（仍属中性，不染色）：

- 面板：`pane 92% + ink-950 8%`（#fcfcfd → 约 #e9e9eb）
- 画布：`canvas 95% + ink-950 5%`
- 遮罩：`canvas 85% + ink-950 15%`

这三处只在"开壁纸 + 浅色"时生效，面板文字仍保持约 13:1，不开壁纸时浅色主题完全不变。

---

## 12. 自审记录（本轮）

逐模块复查 + 用 CDP 驱动真实浏览器验证后，发现并修复三个问题，另有几项确认为非问题。

### 已修

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | 壁纸被**两个 hook 实例**各应用一次（`CoreProviders` + 设置卡片），本地文件每次都新建 objectURL | 后一次 `revoke` 掉前一次正在加载的 URL，图片可能变空白 | `syncWallpaperLayer` 增加按配置去重（key 含 reloadKey），复用同一 in-flight promise |
| 2 | `applyBackground` 判断可用性时**只看 URL** | 本地文件来源（url 为空）会移除 `data-nf-bg`，图片加载了却被不透明外壳盖住——本地壁纸从来没生效过 | 按 source 分支判断；文件来源看 `fileName`。加回归测试 |
| 3 | 同名文件重新选择不刷新 | 去重 key 相同 → 换图无反应 | 选文件时同时 bump `reloadKey` |

问题 2 是这轮最重要的：**「本地文件」这个功能从上线起就没真正生效过**，之前的截图验证全都只覆盖了 URL 来源。

### 验证过、确认不是问题

- `calc(100% + 6%)` 作为 `color-mix` 权重合法（字面量 `106%` 才非法），极端透明度不会产生无效背景
- 强度档位都在合法区间（55–100 / 0–90 / 0–24）
- `reloadKey` 经解析、切源、改滑杆都不会丢
- 所有新增 i18n 键中英齐全且都被引用

### 已知限制（未处理，接受）

1. **照片过亮时对比度不可保证**：遮罩/不透明度都是用户可调的，最差组合（遮罩 0 + 面板 55%）下正文可能低于 AA。要根治需要按图片亮度自动算遮罩，成本高于收益。
2. **整屏模糊是一次滤镜绘制**，低端设备在超大窗口下可能掉帧；`blur=0` 可关闭。
3. 插件主题启用时只禁用了主题色卡片，壁纸仍会生效——两者叠加属于用户自选，不再额外拦截。
4. 公开分享页没走首屏预应用（`main.tsx` 里对 public share 跳过），访问者会看到一次默认色 → 壁纸的过渡。
