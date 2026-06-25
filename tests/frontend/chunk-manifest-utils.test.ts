import { describe, expect, it } from "bun:test";
import {
	decodeManifestTuples,
	firstDirtyManifestIndex,
	sameManifestEntry,
} from "../../frontend/components/narrator/chunk-manifest-utils";
import type { ChunkManifestEntry, ChunkManifestTuple } from "../../frontend/lib/api";

function entry(id: string, firstSeq: number, lastSeq: number, count: number): ChunkManifestEntry {
	return { id, firstSeq, lastSeq, count };
}

describe("decodeManifestTuples", () => {
	it("展开紧凑元组为条目", () => {
		const tuples: ChunkManifestTuple[] = [
			["a", 0, 19, 20],
			["b", 20, 29, 10],
		];
		expect(decodeManifestTuples(tuples)).toEqual([entry("a", 0, 19, 20), entry("b", 20, 29, 10)]);
	});
});

describe("sameManifestEntry", () => {
	it("全字段一致才相等", () => {
		expect(sameManifestEntry(entry("a", 0, 19, 20), entry("a", 0, 19, 20))).toBe(true);
		expect(sameManifestEntry(entry("a", 0, 19, 20), entry("a", 0, 19, 19))).toBe(false);
		expect(sameManifestEntry(undefined, entry("a", 0, 19, 20))).toBe(false);
	});
});

describe("firstDirtyManifestIndex — 尾对齐窗口比较", () => {
	it("尾部完全一致时返回 null（无脏块）", () => {
		const prev = [entry("a", 0, 19, 20), entry("b", 20, 39, 20)];
		const next = [entry("a", 0, 19, 20), entry("b", 20, 39, 20)];
		expect(firstDirtyManifestIndex(prev, next)).toBeNull();
	});

	it("next 在前部新增更旧 chunk（窗口向上扩展）不算脏", () => {
		const prev = [entry("b", 20, 39, 20), entry("c", 40, 49, 10)];
		// 向上扩展，前面多了更旧的 chunk a，尾部 b/c 不变。
		const next = [entry("a", 0, 19, 20), entry("b", 20, 39, 20), entry("c", 40, 49, 10)];
		expect(firstDirtyManifestIndex(prev, next)).toBeNull();
	});

	it("尾块 count 变化（追加消息）返回需重载的边界", () => {
		const prev = [entry("a", 0, 19, 20), entry("b", 20, 38, 19)];
		// 尾块 b 多了一条消息：count 19 → 20，lastSeq 38 → 39。
		const next = [entry("a", 0, 19, 20), entry("b", 20, 39, 20)];
		// 尾块 ni=1 变化 → 返回 max(0, 1-1)=0（回退一个块覆盖跨块插入）。
		expect(firstDirtyManifestIndex(prev, next)).toBe(0);
	});

	it("中部块变化返回其前一个块下标", () => {
		const prev = [
			entry("a", 0, 19, 20),
			entry("b", 20, 39, 20),
			entry("c", 40, 59, 20),
			entry("d", 60, 69, 10),
		];
		// 块 b 的 id 变了（mid-history 插入/删除导致 id 偏移），c/d 尾部不变。
		const next = [
			entry("a", 0, 19, 20),
			entry("b2", 20, 39, 20),
			entry("c", 40, 59, 20),
			entry("d", 60, 69, 10),
		];
		// 反向走到 ni=1 处首次不同 → 返回 max(0, 1-1)=0。
		expect(firstDirtyManifestIndex(prev, next)).toBe(0);
	});

	it("历史变短（next 比 prev 少块）时把新前部当作重载边界", () => {
		const prev = [entry("a", 0, 19, 20), entry("b", 20, 39, 20), entry("c", 40, 49, 10)];
		const next = [entry("b", 20, 39, 20), entry("c", 40, 49, 10)];
		expect(firstDirtyManifestIndex(prev, next)).toBe(0);
	});
});
