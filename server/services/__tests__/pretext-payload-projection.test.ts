import { afterAll, describe, expect, mock, test } from "bun:test";

// narrator-messages.ts sits in a load-time import cycle
// (narrator-messages → websocket/narrator-ws → narrator-service → narrator-messages)
// which throws "narratorMessageQueries before initialization" if imported directly
// in a test. The projections under test are pure functions with no ws/service deps,
// so we break the cycle by mocking the only symbol narrator-messages pulls from
// narrator-ws (broadcastToNarrator).
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	broadcastToNarrator: () => {},
}));

afterAll(() => {
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

const { stripRedundantToolCallRows, stripProviderMetadata, enrichToolUseBlocks } = await import(
	"../narrator-messages"
);

const {
	getReasoningEncryptionState,
	hasEncryptedReasoningMetadata,
	// biome-ignore lint/suspicious/noExplicitAny: shared module has no server-side types
} = (await import("@shared/pretext-layout/reasoning-segments")) as any;

/**
 * Transport-only projections for the exact-layout page (`getPretextDocumentPage`).
 *
 * Both exist to shrink a first screen that measured 283KB-1.3MB, and both are only
 * defensible while they are HEIGHT-NEUTRAL: the vlist measures every item in the
 * loaded window, so a projection that changed any measured input would move
 * committed rows. These tests pin the two properties that make them safe:
 *
 *   1. the tool rows are pure duplicates of the ENRICHED blocks, so the
 *      `ToolCallData` the measure layer consumes is byte-identical without them;
 *   2. `providerMetadata` is replay state the browser can neither display nor send
 *      back, EXCEPT for one presence bit that drives a rendered placeholder — so
 *      the whole object goes and that bit is preserved as a flag.
 */

function toolCallRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "tc-1",
		toolUseId: "tu-1",
		toolName: "Bash",
		inputJson: { command: "echo hi" },
		outputJson: { _text: "hi" },
		status: "success",
		durationMs: 12,
		createdAt: "2026-07-23T00:00:00.000Z",
		errorMessage: null,
		...overrides,
	};
}

function messageWithTool(overrides: Record<string, unknown> = {}) {
	return {
		id: "m-1",
		role: "assistant",
		contentJson: [
			{ type: "text", text: "before" },
			{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "echo hi" } },
		],
		toolCalls: [toolCallRow()],
		children: [],
		...overrides,
	};
}

describe("stripRedundantToolCallRows", () => {
	test("drops the rows while leaving the enriched tool_use block intact", () => {
		const enriched = enrichToolUseBlocks([messageWithTool()]);
		const block = enriched[0].contentJson[1];
		const stripped = stripRedundantToolCallRows(enriched);

		expect(stripped[0].toolCalls).toEqual([]);
		// The block is the copy the renderer actually reads — it must survive whole.
		expect(stripped[0].contentJson[1]).toEqual(block);
		expect(stripped[0].contentJson[1].inputJson).toEqual({ command: "echo hi" });
		expect(stripped[0].contentJson[1].outputJson).toEqual({ _text: "hi" });
		expect(stripped[0].contentJson[1].status).toBe("success");
	});

	test("every field the row carried is still reachable on the block", () => {
		// This is the invariant the whole projection rests on. `segmentMessages` reads
		// `block.<field> ?? tc?.<field>`, with `id`/`createdAt` landing as
		// `tcId`/`tcCreatedAt`, so a field on the row but not the block would be lost.
		const enriched = enrichToolUseBlocks([messageWithTool()]);
		const block = enriched[0].contentJson[1];
		const row = toolCallRow();
		const blockNameFor = (field: string) =>
			field === "id" ? "tcId" : field === "createdAt" ? "tcCreatedAt" : field;

		for (const [field, value] of Object.entries(row)) {
			if (value == null) continue;
			if (field === "toolUseId" || field === "toolName") continue; // block.id / block.name
			expect(block[blockNameFor(field)]).not.toBeUndefined();
		}
	});

	test("recurses into child (subagent) message trees", () => {
		const enriched = enrichToolUseBlocks([
			messageWithTool({ children: [messageWithTool({ id: "m-child" })] }),
		]);
		const stripped = stripRedundantToolCallRows(enriched);
		expect(stripped[0].children[0].toolCalls).toEqual([]);
		expect(stripped[0].children[0].contentJson[1].outputJson).toEqual({ _text: "hi" });
	});

	test("leaves a message with no tool rows untouched by reference", () => {
		const plain = [{ id: "m-1", role: "assistant", contentJson: [{ type: "text", text: "hi" }] }];
		expect(stripRedundantToolCallRows(plain)[0]).toBe(plain[0]);
	});

	test("removes the duplicated payload bytes from the wire", () => {
		const big = "x".repeat(4000);
		const enriched = enrichToolUseBlocks([
			messageWithTool({ toolCalls: [toolCallRow({ outputJson: { _text: big } })] }),
		]);
		const before = JSON.stringify(enriched).length;
		const after = JSON.stringify(stripRedundantToolCallRows(enriched)).length;
		// The body is now carried once (on the block) instead of twice.
		expect(after).toBeLessThan(before - big.length);
	});
});

describe("stripProviderMetadata", () => {
	const ciphertext = "c".repeat(20_000);
	const signature = "s".repeat(3_000);

	function reasoningMessage(blocks: unknown[]) {
		return { id: "m-1", role: "assistant", contentJson: blocks, toolCalls: [], children: [] };
	}

	test("removes the whole object, keeping only the presence flag", () => {
		const stripped = stripProviderMetadata([
			reasoningMessage([
				{
					type: "reasoning",
					text: "",
					providerMetadata: { openai: { itemId: "r-1", reasoningEncryptedContent: ciphertext } },
				},
			]),
		]);
		// itemId and the ciphertext are both replay-only: the browser can neither use
		// nor return them, so nothing but the display bit survives.
		expect(stripped[0].contentJson[0].providerMetadata).toEqual({ hasEncryptedReasoning: true });
	});

	test("removes signature metadata that carries no display bit at all", () => {
		// anthropic.signature / gemini.thoughtSignature measured 33KB across the six
		// largest narrators and drive nothing in the UI, so they leave no flag behind.
		const stripped = stripProviderMetadata([
			reasoningMessage([
				{
					type: "reasoning",
					text: "visible thinking",
					providerMetadata: { anthropic: { signature, blockIndex: 2 }, signatureSource: "anthropic" },
				},
			]),
		]);
		expect(stripped[0].contentJson[0].providerMetadata).toBeUndefined();
		expect(stripped[0].contentJson[0].text).toBe("visible thinking");
	});

	test("keeps the client's PRESENCE check true — the height-critical property", () => {
		// This bit drives MessageBubble's lock-icon placeholder and the substituted
		// body. A bare deletion would flip it to false and drop a rendered row.
		const block = {
			type: "reasoning",
			text: "",
			providerMetadata: { openai: { reasoningEncryptedContent: ciphertext } },
		};
		const stripped = stripProviderMetadata([reasoningMessage([block])]);
		expect(hasEncryptedReasoningMetadata(block)).toBe(true);
		expect(hasEncryptedReasoningMetadata(stripped[0].contentJson[0])).toBe(true);
	});

	test("preserves the encryption STATE for every mix of visible text", () => {
		// "only" renders the placeholder AS the body; "partial" appends a lock line.
		// Both must be identical before and after the projection.
		const encryptedOnly = [
			{
				type: "reasoning",
				text: "",
				providerMetadata: { openai: { reasoningEncryptedContent: ciphertext } },
			},
		];
		const partial = [
			{ type: "reasoning", text: "visible summary" },
			{
				type: "reasoning",
				text: "",
				providerMetadata: { openai: { reasoningEncryptedContent: ciphertext } },
			},
		];
		for (const blocks of [encryptedOnly, partial]) {
			const before = getReasoningEncryptionState(blocks);
			const after = getReasoningEncryptionState(
				stripProviderMetadata([reasoningMessage(blocks)])[0].contentJson,
			);
			expect(after).toBe(before);
		}
		expect(getReasoningEncryptionState(encryptedOnly)).toBe("only");
		expect(getReasoningEncryptionState(partial)).toBe("partial");
	});

	test("never touches the reasoning TEXT, which is what gets measured", () => {
		const stripped = stripProviderMetadata([
			reasoningMessage([
				{
					type: "reasoning",
					text: "the visible reasoning body",
					providerMetadata: { openai: { reasoningEncryptedContent: ciphertext } },
				},
			]),
		]);
		expect(stripped[0].contentJson[0].text).toBe("the visible reasoning body");
	});

	test("drops replay metadata even when there is no ciphertext to flag", () => {
		const stripped = stripProviderMetadata([
			reasoningMessage([
				{ type: "reasoning", text: "body", providerMetadata: { openai: { itemId: "r-1" } } },
			]),
		]);
		expect(stripped[0].contentJson[0].providerMetadata).toBeUndefined();
	});

	test("leaves blocks without provider metadata untouched by reference", () => {
		const message = reasoningMessage([{ type: "text", text: "hi" }]);
		expect(stripProviderMetadata([message])[0]).toBe(message);
	});

	test("recurses into child (subagent) message trees", () => {
		const child = reasoningMessage([
			{
				type: "reasoning",
				text: "",
				providerMetadata: { openai: { reasoningEncryptedContent: ciphertext } },
			},
		]);
		const stripped = stripProviderMetadata([{ ...reasoningMessage([]), children: [child] }]);
		expect(stripped[0].children[0].contentJson[0].providerMetadata).toEqual({
			hasEncryptedReasoning: true,
		});
	});

	test("removes the replay bytes from the wire", () => {
		const tree = [
			reasoningMessage([
				{
					type: "reasoning",
					text: "",
					providerMetadata: {
						openai: { itemId: "r-1", reasoningEncryptedContent: ciphertext },
						anthropic: { signature },
					},
				},
			]),
		];
		const before = JSON.stringify(tree).length;
		const after = JSON.stringify(stripProviderMetadata(tree)).length;
		expect(before - after).toBeGreaterThan(ciphertext.length + signature.length - 100);
	});
});
