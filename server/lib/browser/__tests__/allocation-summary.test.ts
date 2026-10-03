import { describe, expect, test } from "bun:test";
import type { Protocol } from "devtools-protocol";
import { analyzeAllocations, failedAllocationSummary } from "../allocation-summary";
import { MemoryProfileError, PROFILE_LIMITS } from "../memory-profile-constants";

function node(
	id: number,
	selfSize = 0,
	children: Protocol.HeapProfiler.SamplingHeapProfileNode[] = [],
	frame: Partial<Protocol.Runtime.CallFrame> = {},
): Protocol.HeapProfiler.SamplingHeapProfileNode {
	return {
		id,
		selfSize,
		children,
		callFrame: {
			functionName: `fn${id}`,
			scriptId: "1",
			url: "https://example.test/app.js",
			lineNumber: 0,
			columnNumber: 2,
			...frame,
		},
	};
}
function profile(head = node(1)): Protocol.HeapProfiler.SamplingHeapProfile {
	return { head, samples: [] };
}

describe("allocation sampling summaries", () => {
	test("iterative self/inclusive totals, recursive frames, 1-based coordinates and ordinal not time", () => {
		const input = profile(
			node(1, 0, [node(2, 100, [node(3, 50, [], { functionName: "fn2" })]), node(4, 30)]),
		);
		input.samples = [
			{ nodeId: 2, size: 75, ordinal: 9_999_999 },
			{ nodeId: 3, size: 25, ordinal: 1 },
		];
		const result = analyzeAllocations(input);
		expect(result.status).toBe("ok");
		expect(result.estimatedSelfBytes).toBe(180);
		expect(result.estimatedSampleBytes).toBe(100);
		expect(result.nodeCount).toBe(4);
		expect(result.sampleCount).toBe(2);
		expect(
			result.hotspots.map(({ selfBytes, inclusiveBytes }) => [selfBytes, inclusiveBytes]),
		).toEqual([
			[100, 150],
			[50, 50],
			[30, 30],
		]);
		expect(result.hotspots[0]).toMatchObject({ line: 1, column: 3 });
		expect(JSON.stringify(result)).not.toContain("9999999");
		expect(result.warnings.join(" ")).toContain("collected objects");
		expect(result.warnings.join(" ")).toContain("not timestamps");
	});

	test("anonymous/native/missing stack and absent source coordinates are explicit", () => {
		const result = analyzeAllocations(
			profile(node(1, 10, [], { functionName: "", url: "", lineNumber: -1, columnNumber: -1 })),
		);
		expect(result.hotspots[0]).toMatchObject({
			functionName: "(anonymous)",
			url: "",
			line: null,
			column: null,
			flags: ["anonymous_stack", "missing_or_native_stack"],
		});
	});

	test("unavailable sampled stack is incomplete rather than fabricated", () => {
		const input = profile();
		input.samples.push({ size: 10, nodeId: 999, ordinal: 1 });
		expect(analyzeAllocations(input).status).toBe("incomplete");
	});

	test("top 20 and UTF8 truncation keep summary well below 12KiB", () => {
		const children = Array.from({ length: 25 }, (_, i) =>
			node(i + 2, i + 1, [], {
				functionName: "中文🙂".repeat(300),
				url: `https://业务.test/${"路径🙂".repeat(300)}`,
			}),
		);
		const result = analyzeAllocations(profile(node(1, 0, children)));
		expect(result.hotspots).toHaveLength(20);
		expect(result.hotspots[0]?.selfBytes).toBe(25);
		expect(result.hotspots.every((hotspot) => hotspot.flags.includes("text_truncated"))).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12 * 1024);
		expect(JSON.stringify(result)).not.toContain("�");
	});

	test("50k-deep tree is processed without recursion; one extra node refused", () => {
		let head = node(PROFILE_LIMITS.allocationNodes, 1);
		for (let i = PROFILE_LIMITS.allocationNodes - 1; i >= 1; i--) head = node(i, 1, [head]);
		const result = analyzeAllocations(profile(head));
		expect(result.nodeCount).toBe(PROFILE_LIMITS.allocationNodes);
		expect(result.estimatedSelfBytes).toBe(PROFILE_LIMITS.allocationNodes);
		expect(result.hotspots[0]?.inclusiveBytes).toBe(PROFILE_LIMITS.allocationNodes);
		expect(() => analyzeAllocations(profile(node(0, 1, [head])))).toThrow("allocation_nodes_limit");
	});

	test("100k sample boundary accepted; over-budget refused before traversal", () => {
		const input = profile();
		input.samples = Array.from({ length: PROFILE_LIMITS.allocationSamples }, (_, ordinal) => ({
			nodeId: 1,
			size: 1,
			ordinal,
		}));
		expect(analyzeAllocations(input).sampleCount).toBe(PROFILE_LIMITS.allocationSamples);
		input.samples.push({ nodeId: 1, size: 1, ordinal: 100_001 });
		expect(() => analyzeAllocations(input)).toThrow("allocation_samples_limit");
	});

	test("cycles, duplicate ids, missing data and bad sizes give generic errors without body", () => {
		const cycle = node(1);
		cycle.children.push(cycle);
		for (const input of [
			profile(cycle),
			profile(node(1, 0, [node(1)])),
			profile(node(1, -1)),
			profile(node(1, Number.NaN)),
			{ secret: "PRIVATE-CANARY" },
		]) {
			try {
				analyzeAllocations(input as Protocol.HeapProfiler.SamplingHeapProfile);
				throw new Error("expected failure");
			} catch (error) {
				expect(error).toBeInstanceOf(MemoryProfileError);
				expect(String(error)).not.toContain("PRIVATE-CANARY");
			}
		}
	});

	test("failed summary has null measurements, not apparent zero allocations", () => {
		expect(failedAllocationSummary()).toMatchObject({
			status: "failed",
			nodeCount: null,
			estimatedSelfBytes: null,
			hotspots: [],
		});
	});
});
