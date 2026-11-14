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
