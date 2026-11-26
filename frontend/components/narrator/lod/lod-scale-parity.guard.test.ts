/**
 * lod-scale-parity.guard.test.ts — LOD 的两份类型定义必须同步。
 *
 * 同一套档位在两个地方各写了一遍，且**都在用**：
 *   - `frontend/components/narrator/lod/RenderLodCtx.ts` — UI 侧（指示器、手势、存储）；
 *   - `shared/pretext-layout/prepared-block.ts` — 高度模型侧（measure 函数签名）。
 *
 * 它们没有互相 import（shared 是 DOM-free 内核，不能依赖前端），所以加档时
 * 只改一处会让两边结构不兼容：TS 会在**跨两份定义的调用点**报错，但那种错误
 * 出现在 guard 测试或某个 adapter 里，而不是在你改的那一行 —— 找起来很绕。
 * 加 L6 时就实际踩到过（`every-call-addressable.guard.test.ts` 编译失败）。
 *
 * 这里直接从源码读上限值比对，把「两边一起改」变成一条 CI 断言。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// This file lives at frontend/components/narrator/lod/, so three levels up is
// `frontend/`. Frontend paths resolve against it; the shared kernel needs the
// repository root above it.
const FRONTEND_ROOT = join(import.meta.dir, "..", "..", "..");
const REPO_ROOT = join(FRONTEND_ROOT, "..");

function read(relative: string): string {
	return readFileSync(join(FRONTEND_ROOT, relative), "utf8");
}

function readRepo(relative: string): string {
	return readFileSync(join(REPO_ROOT, relative), "utf8");
}

/** 从源码里取 `MAX_RENDER_LOD: RenderLod = N` 的数字。 */
function frontendMax(): number {
	const source = read("components/narrator/lod/RenderLodCtx.ts");
	const match = source.match(/MAX_RENDER_LOD:\s*RenderLod\s*=\s*(\d+)/);
	expect(match).not.toBeNull();
	return Number(match![1]);
}

/** 从源码里取共享 RenderLod 联合类型里出现过的最大值。 */
function sharedUnionMax(): number {
	const source = readRepo("shared/pretext-layout/prepared-block.ts");
	const match = source.match(/export type RenderLod =([^;]+);/);
	expect(match).not.toBeNull();
	const numbers = match![1]!.match(/\d+/g) ?? [];
	expect(numbers.length).toBeGreaterThan(0);
	return Math.max(...numbers.map(Number));
}

/** 默认档位也必须一致（否则同一会话在两个子系统里初始细节不同）。 */
function frontendDefault(): number {
	const source = read("components/narrator/lod/RenderLodCtx.ts");
	const match = source.match(/DEFAULT_RENDER_LOD:\s*RenderLod\s*=\s*(\d+)/);
	expect(match).not.toBeNull();
	return Number(match![1]);
}

function sharedDefault(): number {
	const source = readRepo("shared/pretext-layout/prepared-block.ts");
	const match = source.match(/DEFAULT_RENDER_LOD:\s*RenderLod\s*=\s*(\d+)/);
	expect(match).not.toBeNull();
	return Number(match![1]);
}

describe("LOD scale parity (two definitions, one scale)", () => {
	test("上限一致", () => {
		expect(frontendMax()).toBe(sharedUnionMax());
	});

	test("默认档位一致", () => {
		expect(frontendDefault()).toBe(sharedDefault());
	});

	test("前端每一档都在共享联合类型里（不出现‘UI 能选但高度模型没有’的档）", () => {
		const source = read("components/narrator/lod/RenderLodCtx.ts");
		const match = source.match(/export type RenderLod =([^;]+);/);
		expect(match).not.toBeNull();
		const frontendLevels = (match![1]!.match(/\d+/g) ?? []).map(Number);

		const sharedSource = readRepo("shared/pretext-layout/prepared-block.ts");
		const sharedMatch = sharedSource.match(/export type RenderLod =([^;]+);/);
		const sharedLevels = new Set((sharedMatch![1]!.match(/\d+/g) ?? []).map(Number));

		for (const level of frontendLevels) {
			expect(sharedLevels.has(level)).toBe(true);
		}
	});

	test("与上游一致的 1..5（整轮折叠不再是最高档）", () => {
		// 曾经为了「不折整轮」在第 6 档硬加了一个全展开档，结果档位比上游多一档、
		// 且 L5 想折叠没得折。折叠现在是独立开关，档位回到上游的 1..5。
		expect(frontendMax()).toBe(5);
		expect(sharedUnionMax()).toBe(5);
	});
});
