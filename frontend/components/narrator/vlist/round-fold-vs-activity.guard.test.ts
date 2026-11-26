/**
 * round-fold-vs-activity.guard.test.ts — 整轮折叠与 activity 分组不能同时生效。
 *
 * 两层折叠会互相吃掉内容：activity 分组先把连续的工具调用打成一个 trace 单元，
 * 整轮折叠再把「轮首之后 → 最终回复之前」的元素收进 pill。那个 trace 单元自带
 * 边界、不在折叠区间内 —— 于是读者点开 pill 只看到文字，这一轮的工具过程整个
 * 消失，也点不开。
 *
 * 实测就是这样：某轮 pill 的 `folded` 里 5 个元素全是 markdown、零个工具卡，
 * 而同一份数据里这一轮有 33 个 tool 块。
 *
 * 所以「折叠开着 → 分组关掉」是一条承重规则，用源码守卫钉住它。
 */

import { describe, expect, it } from "bun:test";

const readLayoutSource = () =>
	Bun.file(new URL("./pretext-document-layout.ts", import.meta.url)).text();

describe("整轮折叠 vs activity 分组", () => {
	it("折叠开着时 activity 分组必须关闭", async () => {
		const source = await readLayoutSource();
		// 分组开关必须同时看 lod 与「折叠是否生效」。
		expect(source).toMatch(
			/activityGroupingEnabled\s*=\s*options\.lod\s*<=\s*2\s*&&\s*!roundFoldingActive/,
		);
	});

	it("分组调用用的是这个组合开关，而不是裸的 lod 判断", async () => {
		const source = await readLayoutSource();
		expect(source).toMatch(/groupRenderUnits\(segments,\s*activityGroupingEnabled/);
	});

	it("折叠是否生效只看显式传入的开关，不看档位（未传 roundFold 的调用方保持原有 L1/L2 分组）", async () => {
		const source = await readLayoutSource();
		// 只有显式传了 `roundFold: { enabled: true }` 才算折叠生效；缺省 = 不折叠。
		expect(source).toMatch(/roundFoldingActive\s*=\s*options\.roundFold\?\.enabled\s*===\s*true/);
	});
});

describe("低 LOD 的工具调用要逐张出卡片（折叠要求）", () => {
	it("adapter 在 keepToolCards 时绕过低 LOD 的计数行折叠", async () => {
		const source = await Bun.file(
			new URL("../../../../shared/pretext-layout/segment-adapter.ts", import.meta.url),
		).text();
		// 这一行是承重的：只按 lod 判断时，L1/L2 会把整批工具压成
		// `tool-run-count`，整轮折叠收走的就是那条没有明细的计数行。
		expect(source).toMatch(/ctx\.lod\s*>=\s*3\s*\|\|\s*ctx\.keepToolCards\s*===\s*true/);
	});

	it("布局层在折叠开启时把 keepToolCards 传下去", async () => {
		const source = await readLayoutSource();
		expect(source).toMatch(/keepToolCards:\s*roundFoldingActive/);
	});
});
