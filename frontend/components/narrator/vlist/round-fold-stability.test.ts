/**
 * round-fold-stability.test.ts — 折叠配置的**引用稳定性**守卫。
 *
 * 这是本轮实测踩到的真 bug：`useNarratorRounds` 用 `?? []` 返回空数组字面量，
 * 每次渲染都是新引用 → 下游 `roundDurationByMessageId` 重算 → `roundFoldOptions`
 * 变化 → `usePretextDocument` 判定配置变了 → 重建文档 → 再渲染 → 又是新引用。
 * 结果就是 React #185「Maximum update depth exceeded」，整个会话页面变成错误页。
 *
 * 这类缺陷用类型检查、单测、乃至手工点几下都抓不到（只在真实数据 + 真实重渲染
 * 链路上才炸），所以在这里用源码断言把两条铁律钉死：
 *   1. hook 的空值必须是**模块级常量**；
 *   2. 折叠配置必须由 `useMemo` 产出，不能是 buildOptions 里的字面量。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VLIST_DIR = join(import.meta.dir);

function read(relative: string): string {
	return readFileSync(join(VLIST_DIR, relative), "utf8");
}

describe("useNarratorRounds 的空值引用必须稳定", () => {
	const source = read("round-rail/useNarratorRounds.ts");

	test("定义了模块级 EMPTY_ROUNDS 常量", () => {
		expect(source).toContain("const EMPTY_ROUNDS");
	});

	test("⚠️ 不用 `?? []` 字面量（每次渲染新引用 → React #185）", () => {
		// 允许出现在注释里，但不允许出现在返回语句里。
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("//"))
			.join("\n");
		expect(code).not.toContain("?? []");
	});

	test("rounds 走 EMPTY_ROUNDS", () => {
		expect(source).toMatch(/rounds:\s*query\.data\?\.rounds\s*\?\?\s*EMPTY_ROUNDS/);
	});
});

describe("折叠配置的引用必须稳定", () => {
	const source = read("PretextExactMessageList.tsx");

	test("折叠配置由 useMemo 产出（roundFoldOptions）", () => {
		expect(source).toContain("const roundFoldOptions = useMemo");
	});

	test("⚠️ buildOptions 里传的是稳定引用，不是字面量", () => {
		// 反例：`roundFold: { enabled: ..., isLiveSpec: (spec) => ... }` 会每帧新建。
		expect(source).toContain("roundFold: roundFoldOptions");
	});

	test("useMemo 依赖包含索引派生的用量表", () => {
		// 用量表变了但 useMemo 不重算，折叠条就会停在旧时长 / 旧 token 上。
		// isSubagent 同在依赖里：它决定切轮判据，切换会话类型必须重建。
		expect(source).toMatch(
			/\[roundFoldingEnabled, isSubagent, roundPinnedOpen, roundPreviewOpen, roundUsageByMessageId\]/,
		);
	});
});
