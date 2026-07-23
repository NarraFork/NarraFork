import { beforeAll, describe, expect, it } from "bun:test";
import type { NarratorMsg } from "../narrator-panel-types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextDocumentLayout } from "./pretext-document-layout";

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
});
