import { beforeAll, describe, expect, it } from "bun:test";
import type { NarratorMsg } from "../narrator-panel-types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextDocumentLayout, createLongestPrefixLookup } from "./pretext-document-layout";

beforeAll(() => {
	installCanvasStub();
});

function message(id: string, seq: number, role: "user" | "assistant", text: string): NarratorMsg {
	return {
		id,
		narratorId: "n1",
		seq,
		role,
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		children: [],
		parentToolUseId: null,
		createdAt: "2026-07-23T00:00:00.000Z",
	} as unknown as NarratorMsg;
}

function historyFixture(count: number): NarratorMsg[] {
	return Array.from({ length: count }, (_, index) => {
		if (index % 17 === 0) {
			return {
				...message(`compact-${index}`, index, "assistant", ""),
				role: "system",
				contentJson: [
					{
						type: "compact",
						subtype: "plan",
						summary: `Plan checkpoint ${index}\n${"detailed summary ".repeat(30)}`,
					},
				],
				contentText: null,
			} as unknown as NarratorMsg;
		}
		if (index % 13 === 0) {
			return {
				...message(`tool-${index}`, index, "assistant", ""),
				contentJson: [
					{
						type: "tool_use",
						id: `tool-use-${index}`,
						name: "Read",
						input: { file_path: `/workspace/very/long/path/${index}/file.ts` },
						inputJson: { file_path: `/workspace/very/long/path/${index}/file.ts` },
						status: "completed",
					},
				],
				contentText: null,
				toolCalls: [
					{
						toolUseId: `tool-use-${index}`,
						toolName: "Read",
						inputJson: { file_path: `/workspace/very/long/path/${index}/file.ts` },
						status: "completed",
					},
				],
			} as unknown as NarratorMsg;
		}
		const role = index % 3 === 0 ? "user" : "assistant";
		const text =
			index % 11 === 0
				? `# Long response ${index}\n\n${"A paragraph with markdown and `code`. ".repeat(120)}`
				: index === count - 1
					? "Streaming tail with a currently partial final sentence"
					: `Message ${index}: ${"content ".repeat((index % 9) + 1)}`;
		return message(`message-${index}`, index, role, text);
	});
}

describe("buildPretextDocumentLayout", () => {
	it("creates one exact layout manifest from the complete ordered message input", () => {
		const built = buildPretextDocumentLayout(
			[message("m0", 0, "user", "hello"), message("m1", 1, "assistant", "# answer\n\nbody")],
			{
				layoutRevision: "layout-1",
				documentRevision: 1,
				lod: 5,
				widthBucket: "860",
				contentWidth: 860,
				topPadding: 16,
				bottomPadding: 16,
				gap: 4,
			},
		);
		expect(built.manifest.items.length).toBeGreaterThan(0);
		expect(built.manifest.items.every((item) => item.height > 0)).toBe(true);
		expect(built.index.totalHeight).toBeGreaterThan(32);
		expect(built.manifest.items.some((item) => item.sourceMessageIds.includes("m0"))).toBe(true);
		expect(built.manifest.items.some((item) => item.sourceMessageIds.includes("m1"))).toBe(true);
	});

	it("includes the versioned prune boundary in the exact layout", () => {
		const built = buildPretextDocumentLayout(
			[message("m0", 0, "user", "older"), message("m1", 1, "assistant", "newer")],
			{
				layoutRevision: "layout-pruned",
				documentRevision: 2,
				lod: 5,
				widthBucket: "860",
				contentWidth: 860,
				pruneBoundaryMessageId: "m0",
				pruneDividerLabel: "Pruned context",
			},
		);
		const divider = built.items.find((item) => item.spec.kind === "prune-divider");
		expect(divider?.spec.data).toEqual({ label: "Pruned context" });
	});

	it("is deterministic for a 95-message mixed history with long, tool, compact, and tail content", () => {
		const input = historyFixture(95);
		const options = {
			layoutRevision: "layout-mixed-95",
			documentRevision: 95,
			lod: 5 as const,
			widthBucket: "860",
			contentWidth: 860,
			topPadding: 16,
			bottomPadding: 16,
			gap: 4,
		};
		const first = buildPretextDocumentLayout(input, options);
		const second = buildPretextDocumentLayout(input, options);
		expect(second.index.totalHeight).toBe(first.index.totalHeight);
		expect(second.manifest.items).toEqual(first.manifest.items);
		expect(first.manifest.items.some((item) => item.kind === "tool-call")).toBe(true);
		expect(first.manifest.items.some((item) => item.kind === "plan-card")).toBe(true);
		expect(first.manifest.items.some((item) => item.height > 500)).toBe(true);
		expect(first.index.itemIndicesForSourceSeq(94).length).toBeGreaterThan(0);
	});

	it("builds one finite exact manifest for a 451-message history", () => {
		const built = buildPretextDocumentLayout(historyFixture(451), {
			layoutRevision: "layout-mixed-451",
			documentRevision: 451,
			lod: 3,
			widthBucket: "720",
			contentWidth: 720,
			topPadding: 12,
			bottomPadding: 20,
			gap: 4,
		});
		expect(built.manifest.items.length).toBeGreaterThan(0);
		expect(
			built.manifest.items.every((item) => Number.isFinite(item.height) && item.height >= 0),
		).toBe(true);
		expect(built.index.totalHeight).toBeGreaterThan(0);
		expect(built.index.itemIndicesForSourceMessageId("message-450").length).toBeGreaterThan(0);
	});

	it("allows low LOD activity items to span multiple source messages", () => {
		const built = buildPretextDocumentLayout(
			[message("m0", 0, "assistant", "thinking"), message("m1", 1, "assistant", "more thinking")],
			{
				layoutRevision: "layout-l2",
				documentRevision: 2,
				lod: 2,
				widthBucket: "860",
				contentWidth: 860,
			},
		);
		expect(built.manifest.items.length).toBeGreaterThan(0);
		expect(built.manifest.items.every((item) => Number.isFinite(item.height))).toBe(true);
	});

	// ── Source attribution must not depend on document size ─────────────────────
	//
	// The owner lookup used to scan EVERY registered key for each item whose spec
	// key was not an exact match, making a rebuild O(items x keys). That is the
	// budget a live streaming rebuild needs, so the scan was replaced by a
	// probe-by-registered-length lookup. These two tests pin the replacement:
	// attribution stays identical as the document grows, and the growth stays
	// linear rather than quadratic.
	it("attributes derived items to the same source messages regardless of document size", () => {
		const options = {
			layoutRevision: "layout-attr",
			documentRevision: "attr",
			lod: 5 as const,
			widthBucket: "860",
			contentWidth: 860,
			topPadding: 16,
			bottomPadding: 16,
			gap: 4,
		};
		const small = buildPretextDocumentLayout(historyFixture(40), options);
		const large = buildPretextDocumentLayout(historyFixture(240), options);
		const attribution = (built: ReturnType<typeof buildPretextDocumentLayout>) =>
			new Map(built.manifest.items.map((item) => [item.itemKey, [...item.sourceMessageIds]]));
		const smallAttribution = attribution(small);
		const largeAttribution = attribution(large);
		// Every item of the small document also exists in the large one (the fixture
		// is a prefix-stable generator), with byte-identical source attribution.
		expect(smallAttribution.size).toBeGreaterThan(0);
		for (const [itemKey, sourceIds] of smallAttribution) {
			expect(largeAttribution.get(itemKey)).toEqual(sourceIds);
		}
		// No item may fall back to the synthetic `layout:<seq>` placeholder: that is
		// what a failed owner lookup produces.
		for (const item of large.manifest.items) {
			expect(item.sourceMessageIds.some((id) => id.startsWith("layout:"))).toBe(false);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Owner attribution complexity
//
// The rebuild used to resolve each derived spec key by scanning EVERY registered
// owner key — O(items x keys), ~38ms of a ~49ms rebuild at 1600 items, i.e. the
// whole budget a live streaming rebuild needs.
//
// These tests guard the replacement DETERMINISTICALLY. A timing assertion was
// tried first and rejected: measured standalone, the old scan's 200 -> 800 cost
// ratio is ~4.3x and the new lookup's ~2.0x, so any threshold loose enough to
// survive CI noise also passes the bug. The invariant that actually separates them
// is the per-item PROBE COUNT, which is exact and clock-free.
// ─────────────────────────────────────────────────────────────────────────────
describe("createLongestPrefixLookup", () => {
	/** Owner keys in the shapes buildSourceResolver registers. */
	function ownerRegistry(count: number): Map<string, string> {
		const registry = new Map<string, string>();
		for (let index = 0; index < count; index++) {
			if (index % 13 === 0) {
				const toolKey = `tool-tool-use-${index}`;
				registry.set(toolKey, toolKey);
				registry.set(`toolrun-summary-${toolKey}`, toolKey);
				registry.set(`toolrun-count-${toolKey}`, toolKey);
				continue;
			}
			registry.set(`message-${index}`, `message-${index}`);
		}
		return registry;
	}

	/** The previous implementation, kept here purely as the equivalence oracle. */
	function scanEveryKey(registry: ReadonlyMap<string, string>, specKey: string) {
		let ownerKey = "";
		for (const key of registry.keys()) {
			if (key.length > ownerKey.length && specKey.startsWith(key)) ownerKey = key;
		}
		return ownerKey ? registry.get(ownerKey) : undefined;
	}

	it("returns the same owner as a full scan for every derived key shape", () => {
		const registry = ownerRegistry(120);
		const lookup = createLongestPrefixLookup(registry);
		const probes: string[] = [];
		for (let index = 0; index < 120; index++) {
			if (index % 13 === 0) {
				probes.push(`tool-tool-use-${index}`, `tool-tool-use-${index}#dup1`);
				probes.push(`toolrun-summary-tool-tool-use-${index}`);
				continue;
			}
			probes.push(`message-${index}`, `message-${index}-b0`, `message-${index}-b11`);
		}
		// Plus the shapes that must resolve to NOTHING.
		probes.push("", "m", "unknown-key", "message-", "tool-", "activity-nope-0");
		for (const specKey of probes) {
			expect(lookup.resolve(specKey)).toBe(scanEveryKey(registry, specKey));
		}
	});

	it("prefers the longest registered prefix when owner keys nest", () => {
		// `tool-tX` is a prefix of `tool-tXY`: a derived key of the longer id must
		// not be attributed to the shorter one.
		const registry = new Map([
			["tool-tX", "short"],
			["tool-tXY", "long"],
		]);
		const lookup = createLongestPrefixLookup(registry);
		expect(lookup.resolve("tool-tXY#dup1")).toBe("long");
		expect(lookup.resolve("tool-tX#dup1")).toBe("short");
	});

	it("bounds per-item probes by key SHAPE, not by document size", () => {
		// This is the complexity claim: the probe count per lookup is the number of
		// distinct registered key lengths, which is a property of the key shapes. A
		// 4x larger document must not widen it. (The old scan's per-item cost was
		// the full key count, which grows ~4x here.)
		const small = createLongestPrefixLookup(ownerRegistry(200));
		const large = createLongestPrefixLookup(ownerRegistry(800));
		expect(large.probeLengths.length).toBeLessThanOrEqual(small.probeLengths.length + 2);
		// And the bound must be far below the registry size it replaced.
		expect(large.probeLengths.length * 8).toBeLessThan(ownerRegistry(800).size);
	});
});
