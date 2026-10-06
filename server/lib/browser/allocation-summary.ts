import type { Protocol } from "devtools-protocol";
import { MemoryProfileError, PROFILE_LIMITS } from "./memory-profile-constants";

export interface AllocationHotspot {
	functionName: string;
	url: string;
	line: number | null;
	column: number | null;
	selfBytes: number;
	inclusiveBytes: number;
	flags: string[];
}
export interface AllocationSummary {
	status: "ok" | "incomplete" | "failed" | "scope_unavailable";
	warnings: string[];
	flags: string[];
	nodeCount: number | null;
	sampleCount: number | null;
	estimatedSelfBytes: number | null;
	estimatedSampleBytes: number | null;
	hotspots: AllocationHotspot[];
}

export function failedAllocationSummary(): AllocationSummary {
	return {
		status: "failed",
		warnings: ["Allocation analysis failed; reduce duration or increase the sampling interval."],
		flags: [],
		nodeCount: null,
		sampleCount: null,
		estimatedSelfBytes: null,
		estimatedSampleBytes: null,
		hotspots: [],
	};
}

function bytes(value: number): number {
	if (!Number.isFinite(value) || value < 0) throw new MemoryProfileError("allocation_invalid");
	return value;
}
function bounded(value: string, flags: string[]): string {
	// UTF-8 budget, not UTF-16 length: summaries also contain non-ASCII URLs/names.
	let result = "";
	let length = 0;
	for (const char of value) {
		length += Buffer.byteLength(char);
		if (length > 128) {
			flags.push("text_truncated");
			return `${result}…`;
		}
		result += char;
	}
	return result;
}

/** CDP ordinals are sample sequence numbers, never timestamps. Runs only in the worker. */
export function analyzeAllocations(
	profile: Protocol.HeapProfiler.SamplingHeapProfile,
): AllocationSummary {
	try {
		if (!profile?.head || !Array.isArray(profile.samples))
			throw new MemoryProfileError("allocation_invalid");
		if (profile.samples.length > PROFILE_LIMITS.allocationSamples)
			throw new MemoryProfileError("allocation_samples_limit");
		const nodes: Array<{ node: Protocol.HeapProfiler.SamplingHeapProfileNode; parent: number }> =
			[];
		const ids = new Set<number>();
		const pending = [{ node: profile.head, parent: -1 }];
		let total = 0;
		while (pending.length) {
			const entry = pending.pop();
			if (!entry) break;
			const { node } = entry;
			if (!node || !Number.isSafeInteger(node.id) || ids.has(node.id) || !node.callFrame)
				throw new MemoryProfileError("allocation_invalid");
			if (!Array.isArray(node.children)) throw new MemoryProfileError("allocation_invalid");
			if (nodes.length + pending.length + node.children.length >= PROFILE_LIMITS.allocationNodes)
				throw new MemoryProfileError("allocation_nodes_limit");
			ids.add(node.id);
			total = bytes(total + bytes(node.selfSize));
			const index = nodes.length;
			nodes.push(entry);
			for (const child of node.children) pending.push({ node: child, parent: index });
		}
		let sampleBytes = 0;
		let missingSampleStack = false;
		for (const sample of profile.samples) {
			sampleBytes = bytes(sampleBytes + bytes(sample.size));
			if (!ids.has(sample.nodeId)) missingSampleStack = true;
		}
		const inclusive = nodes.map(({ node }) => node.selfSize);
		for (let i = nodes.length - 1; i >= 0; i--) {
			const parent = nodes[i]?.parent ?? -1;
			if (parent >= 0) inclusive[parent] = bytes((inclusive[parent] ?? 0) + (inclusive[i] ?? 0));
		}
		const hotspots = nodes
			.map(({ node }, index) => ({ node, index }))
			.filter(({ node }) => node.selfSize > 0)
			.sort((a, b) => b.node.selfSize - a.node.selfSize || a.node.id - b.node.id)
			.slice(0, 20)
			.map(({ node, index }): AllocationHotspot => {
				const frame = node.callFrame;
				const flags: string[] = [];
				if (!frame.functionName) flags.push("anonymous_stack");
				if (!frame.url) flags.push("missing_or_native_stack");
				return {
					functionName: bounded(frame.functionName || "(anonymous)", flags),
					url: bounded(frame.url || "", flags),
					line:
						Number.isSafeInteger(frame.lineNumber) && frame.lineNumber >= 0
							? frame.lineNumber + 1
							: null,
					column:
						Number.isSafeInteger(frame.columnNumber) && frame.columnNumber >= 0
							? frame.columnNumber + 1
							: null,
					selfBytes: node.selfSize,
					inclusiveBytes: inclusive[index] ?? node.selfSize,
					flags: [...new Set(flags)],
				};
			});
		const warnings = [
			"Sampling estimates include collected objects when both collected-by-GC options were enabled; not exact total allocated bytes or retained heap.",
			"Small allocations and missing/anonymous/native stacks may be absent; sample ordinals are not timestamps. Inclusive rows must not be summed.",
			"Allocation hotspots and GC in the same window are correlation, not causation; no source-map resolution.",
		];
		if (missingSampleStack) warnings.push("Some samples reference unavailable stack nodes.");
		return {
			status: missingSampleStack ? "incomplete" : "ok",
			warnings,
			flags: ["sampling_estimates", "may_include_gc_collected_objects", "ordinal_not_timestamp"],
			nodeCount: nodes.length,
			sampleCount: profile.samples.length,
			estimatedSelfBytes: total,
			estimatedSampleBytes: sampleBytes,
			hotspots,
		};
	} catch (error) {
		if (error instanceof MemoryProfileError) throw error;
		throw new MemoryProfileError("allocation_invalid");
	}
}
