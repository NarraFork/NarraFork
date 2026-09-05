/**
 * pretext-payload-projection.height-neutral.test.ts
 *
 * The server shrinks the exact-layout page with two TRANSPORT-ONLY projections
 * (`stripRedundantToolCallRows`, `elideEncryptedReasoning` in
 * server/services/narrator-messages.ts). They exist to cut a first screen measured
 * at 283KB-1.3MB, and they are only admissible while the layout they feed is
 * IDENTICAL — the exact list measures every item in the loaded window, so any
 * projection that moved a measured input would move committed rows.
 *
 * The server-side unit tests pin the projections' own shape. This one closes the
 * loop from the other end: it runs BOTH payload shapes through the real layout
 * pipeline and asserts every item's height, the total height and each item key
 * match exactly. If someone later projects away a field the measure layer reads,
 * this test is what catches it — a server-side shape assertion could not.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { NarratorMsg } from "../narrator-panel-types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextDocumentLayout } from "./pretext-document-layout";

beforeAll(() => {
	installCanvasStub();
});

const BUILD_OPTIONS = {
	layoutRevision: "r1",
	documentRevision: "d1",
	lod: 5 as const,
	widthBucket: "860",
	contentWidth: 860,
	viewportHeight: 720,
	pruneBoundaryMessageId: null,
};

const CIPHERTEXT = "c".repeat(20_000);
const SIGNATURE = "s".repeat(3_000);
/**
 * The projected form `stripProviderMetadata` emits: the whole replay object is
 * gone and only the display bit remains (see server/services/narrator-messages.ts).
 */
const PROJECTED_METADATA = { hasEncryptedReasoning: true };

const TOOL_INPUT = { command: "bun test", description: "run the suite" };
const TOOL_OUTPUT = { _text: `line one\nline two\n${"output text ".repeat(40)}` };

/**
 * A window exercising every shape the projections touch: a tool call (whose row is
 * dropped), an encrypted-only reasoning run, a partially-encrypted one and a
 * signature-bearing one (whose `providerMetadata` is removed), plus plain text
 * either side as a control.
 *
 * The tool block mirrors what `enrichToolUseBlocks` produces, since both
 * projections run after it.
 *
 * `metadata` builds the block's `providerMetadata`, so a caller can supply either
 * the real replay object or the projected form and compare the two layouts.
 */
function fixture(opts: {
	withToolRows: boolean;
	metadata: (itemId: string) => Record<string, unknown> | undefined;
	signedMetadata: Record<string, unknown> | undefined;
}): NarratorMsg[] {
	const base = {
		narratorId: "n1",
		children: [],
		parentToolUseId: null,
		createdAt: "2026-07-23T00:00:00.000Z",
	};
	const toolRow = {
		id: "tc-1",
		toolUseId: "tu-1",
		toolName: "Bash",
		inputJson: TOOL_INPUT,
		outputJson: TOOL_OUTPUT,
		status: "success",
		durationMs: 42,
		createdAt: "2026-07-23T00:00:00.000Z",
		sideCars: [],
	};
	return [
		{
			...base,
			id: "m-text",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: `a user question ${"with more words ".repeat(8)}` }],
			contentText: "a user question",
			toolCalls: [],
		},
		{
			...base,
			id: "m-reasoning-only",
			seq: 1,
			role: "assistant",
			contentJson: [{ type: "reasoning", text: "", providerMetadata: opts.metadata("r-1") }],
			contentText: null,
			toolCalls: [],
		},
		{
			...base,
			id: "m-reasoning-partial",
			seq: 2,
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: `visible reasoning ${"body text ".repeat(20)}` },
				{ type: "reasoning", text: "", providerMetadata: opts.metadata("r-2") },
			],
			contentText: null,
			toolCalls: [],
		},
		{
			...base,
			id: "m-reasoning-signed",
			seq: 3,
			role: "assistant",
			contentJson: [
				{
					type: "reasoning",
					text: `signed thinking ${"more words ".repeat(15)}`,
					// Signature-only metadata drives NOTHING in either renderer, so the
					// projection removes it without leaving a flag behind.
					providerMetadata: opts.signedMetadata,
				},
			],
			contentText: null,
			toolCalls: [],
		},
		{
			...base,
			id: "m-tool",
			seq: 4,
			role: "assistant",
			contentJson: [
				{
					type: "tool_use",
					id: "tu-1",
					name: "Bash",
					input: TOOL_INPUT,
					// Written by enrichToolUseBlocks — this is the copy the renderer reads.
					inputJson: TOOL_INPUT,
					outputJson: TOOL_OUTPUT,
					status: "success",
					durationMs: 42,
					tcId: "tc-1",
					tcCreatedAt: "2026-07-23T00:00:00.000Z",
					sideCars: [],
				},
			],
			contentText: null,
			toolCalls: opts.withToolRows ? [toolRow] : [],
		},
		{
			...base,
			id: "m-answer",
			seq: 5,
			role: "assistant",
			contentJson: [{ type: "text", text: `## heading\n\n${"answer prose ".repeat(30)}` }],
			contentText: "answer prose",
			toolCalls: [],
		},
	] as unknown as NarratorMsg[];
}

function layoutOf(messages: NarratorMsg[]) {
	// A distinct documentRevision per build so the second one cannot simply be
	// served from the measure cache — the heights must be recomputed to be compared.
	return buildPretextDocumentLayout(messages, {
		...BUILD_OPTIONS,
		documentRevision: `d-${Math.random()}`,
	});
}

/** The payload as it exists in the database: full replay metadata, tool rows present. */
function unprojected(): NarratorMsg[] {
	return fixture({
		withToolRows: true,
		metadata: (itemId) => ({ openai: { itemId, reasoningEncryptedContent: CIPHERTEXT } }),
		signedMetadata: { anthropic: { signature: SIGNATURE, blockIndex: 1 }, signatureSource: "anthropic" },
	});
}

/** The payload as it goes on the wire after both server-side projections. */
function projected(): NarratorMsg[] {
	return fixture({
		withToolRows: false,
		metadata: () => PROJECTED_METADATA,
		signedMetadata: undefined,
	});
}

describe("exact-layout payload projections are height-neutral", () => {
	it("produces identical item heights, keys and total height", () => {
		const full = layoutOf(unprojected());
		const wire = layoutOf(projected());

		expect(wire.index.totalHeight).toBe(full.index.totalHeight);
		expect(wire.items.length).toBe(full.items.length);
		expect(wire.items.map((item) => item.spec.key)).toEqual(
			full.items.map((item) => item.spec.key),
		);
		expect(wire.items.map((item) => item.measured.height)).toEqual(
			full.items.map((item) => item.measured.height),
		);
	});

	it("places every item at the same offset (no row can shift)", () => {
		// Equal heights alone would not prove this: gaps and dividers also contribute,
		// so the committed start/end of every row is compared directly.
		const full = layoutOf(unprojected());
		const wire = layoutOf(projected());
		expect(full.index.itemStarts.length).toBeGreaterThan(0);
		expect(wire.index.itemStarts).toEqual(full.index.itemStarts);
		expect(wire.index.itemEnds).toEqual(full.index.itemEnds);
	});

	it("still renders a real (non-empty) layout, so the comparison is meaningful", () => {
		// Guards against the test passing because both sides measured nothing.
		const wire = layoutOf(projected());
		expect(wire.items.length).toBeGreaterThan(3);
		expect(wire.index.totalHeight).toBeGreaterThan(0);
	});

	it("is height-invariant to providerMetadata on THIS path, in any form", () => {
		// Documents an asymmetry worth knowing when changing either renderer.
		//
		// The vlist adapter derives a reasoning row from `thinking`/`text` only
		// (`reasoningData` in shared/pretext-layout/segment-adapter.ts) and never reads
		// `providerMetadata`, so on the exact path the metadata cannot affect height in
		// any form — including being absent entirely.
		//
		// The CHUNKED renderer is different: `MessageBubble` calls
		// `getReasoningEncryptionState` and substitutes a lock-icon placeholder for an
		// encrypted-only run. That is the only reason the server's projection keeps a
		// `hasEncryptedReasoning` flag instead of deleting the object outright — the
		// flag is what makes the same payload safe for BOTH renderers.
		const forms: Array<Record<string, unknown> | undefined> = [
			{ openai: { itemId: "r", reasoningEncryptedContent: CIPHERTEXT } },
			PROJECTED_METADATA,
			undefined,
		];
		const heights = forms.map(
			(metadata) =>
				layoutOf(
					fixture({ withToolRows: false, metadata: () => metadata, signedMetadata: metadata }),
				).index.totalHeight,
		);
		expect(new Set(heights).size).toBe(1);
	});
});
