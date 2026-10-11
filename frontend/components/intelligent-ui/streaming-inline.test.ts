/**
 * A `render` call must become UI in the chat from its first streamed chunk, through the
 * whole pipeline the live list uses (tool chunk fold → synthetic message → segment →
 * adapter → classify → measure), not only in the classifier.
 *
 * Two properties are easy to lose along that chain and both are checked here: the row
 * must repaint for every chunk (a stale measure-cache entry would freeze the UI at an
 * earlier prefix), and its height must not move while the markup grows (the list lays
 * rows out arithmetically; a row that grew mid-stream would shove the conversation).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { installCanvasStub } from "../narrator/vlist/measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

async function load() {
	const [chunks, helpers, segments, layout] = await Promise.all([
		import("../narrator/vlist/streaming-tool-chunks"),
		import("../narrator/narrator-message-helpers"),
		import("../narrator/message/message-segments"),
		import("../narrator/vlist/pretext-document-layout"),
	]);
	return { ...chunks, ...helpers, ...segments, ...layout };
}
type Mod = Awaited<ReturnType<typeof load>>;
type Store = ReturnType<Mod["createStreamingToolStore"]>;

interface Body {
	kind: string;
	text?: string;
	live?: boolean;
	contentPx?: number;
	title?: string;
	kit?: { state: string; request?: { id: string; kind: string; state: string } };
	runtime?: string;
	revision?: string;
}

function row(mod: Mod, store: Store) {
	const message = mod.buildStreamingMsg({
		streamingBlocks: [{ type: "text", text: "Here are the plans" }] as never,
		toolChunksMsg: mod.buildTopLevelStreamingChunksMsg(mod.streamingToolChunks(store), "n1", null),
		narratorId: "n1",
	});
	if (!message) throw new Error("expected a streaming row");
	// Same revision on every call: this is one streaming turn, not a reload.
	const built = mod.buildPretextDocumentLayout(
		[message] as never,
		{
			layoutRevision: "L",
			documentRevision: "one-turn",
			lod: 5,
			widthBucket: "800",
			contentWidth: 800,
			viewportHeight: 900,
			gap: 4,
			segmentGap: 12,
			topPadding: 16,
			bottomPadding: 16,
			resolveToolCategory: () => "generic",
			resolveToolColor: () => "gray",
			resolveToolSummary: () => "ui",
		} as never,
	);
	const item = built.items.find((entry) => entry.spec.kind === "tool-call");
	if (!item) throw new Error("expected a tool-call row");
	const data = item.spec.data as {
		detail?: { sections: Array<{ body: Body }> };
		status?: string;
	};
	return {
		body: data.detail?.sections[0]?.body,
		sections: data.detail?.sections.length ?? 0,
		height: (item.measured as { height: number }).height,
		// What the row will actually paint from, cache hit or not.
		painted: JSON.stringify(item.measured),
		opts: item.spec.opts as { preferOpen?: boolean },
	};
}

const SOURCE =
	'<Stack gap="sm"><Title order={4}>Plans</Title><Badge>Active</Badge><Button onClick={sendPrompt("Compare")}>Compare</Button></Stack>';

function stream(mod: Mod, store: Store, upTo: number, from = 0) {
	mod.applyStreamingToolChunk(store, {
		toolUseId: "ui1",
		toolName: "IntelligentUI",
		inputCharsTotal: 60 + upTo,
		streamingField: { name: "source", delta: SOURCE.slice(from, upTo), startsField: from === 0 },
	} as never);
}

describe("render streams into the chat", () => {
	test("the card exists, open and sized, before any markup has arrived", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolChunk(store, {
			toolUseId: "ui1",
			toolName: "IntelligentUI",
			inputCharsTotal: 48,
			extractedFields: { action: "render", title: "Plans", size: "lg" },
		} as never);
		// Nothing renderable yet: still an ordinary tool card, not an empty frame.
		expect(row(mod, store).body?.kind).not.toBe("intelligent-ui");
		stream(mod, store, 8);
		const first = row(mod, store);
		expect(first.body).toMatchObject({
			kind: "intelligent-ui",
			text: SOURCE.slice(0, 8),
			live: true,
			contentPx: 580,
			title: "Plans",
		});
		// Default-open at every density: a folded card would hide the answer.
		expect(first.opts.preferOpen).toBe(true);
		expect(first.height).toBeGreaterThan(580);
	});

	test("every chunk repaints, and the row never changes height while it streams", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolChunk(store, {
			toolUseId: "ui1",
			toolName: "IntelligentUI",
			inputCharsTotal: 40,
			extractedFields: { action: "render", size: "sm" },
		} as never);
		let height: number | undefined;
		let previous = 0;
		for (let upTo = 12; upTo <= SOURCE.length; upTo = Math.min(SOURCE.length, upTo + 17)) {
			stream(mod, store, upTo, previous);
			previous = upTo;
			const current = row(mod, store);
			expect(current.body?.text).toBe(SOURCE.slice(0, upTo));
			// The measured row carries THIS prefix, not a cached earlier one.
			expect(current.painted).toContain(JSON.stringify(SOURCE.slice(0, upTo)).slice(1, -1));
			height ??= current.height;
			expect(current.height).toBe(height);
			if (upTo === SOURCE.length) break;
		}
		expect(row(mod, store).body?.contentPx).toBe(240);
	});

	test("the finished call keeps the same row: only `live` clears, then the result's kit notice lands", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolChunk(store, {
			toolUseId: "ui1",
			toolName: "IntelligentUI",
			inputCharsTotal: 40,
			extractedFields: { action: "render", title: "Plans" },
		} as never);
		stream(mod, store, 40);
		const streaming = row(mod, store);
		expect(streaming.body?.contentPx).toBe(400);

		mod.applyStreamingToolStarted(store, {
			toolUseId: "ui1",
			toolName: "IntelligentUI",
			input: { action: "render", title: "Plans", source: SOURCE },
		} as never);
		const settled = row(mod, store);
		expect(settled.body?.text).toBe(SOURCE);
		// Complete markup is parsed strictly; a still-`live` flag would hide its errors.
		expect(settled.body?.live).toBeUndefined();
		expect(settled.height).toBe(streaming.height);

		mod.applyStreamingToolCompleted(store, {
			toolUseId: "ui1",
			status: "success",
			output: "Rendered inline",
			metadata: {
				intelligentUiInline: { version: 1, kit: "builtin" },
				intelligentUiKit: {
					state: "builtin",
					request: { id: "req-42", kind: "build", state: "pending" },
				},
			},
		} as never);
		const done = row(mod, store);
		expect(done.body?.kit).toEqual({
			state: "builtin",
			request: { id: "req-42", kind: "build", state: "pending" },
		});
		// The notice arrives with no change to the markup. What the row paints from must
		// carry it, or the user is never shown the confirmation.
		expect(done.painted).toContain("req-42");
		expect(done.height).toBe(streaming.height);
	});

	test("a failed render shows its error text, not an empty frame", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolStarted(store, {
			toolUseId: "ui1",
			toolName: "IntelligentUI",
			input: { action: "render", source: "<Nope />" },
		} as never);
		expect(row(mod, store).body?.kind).toBe("intelligent-ui");
		mod.applyStreamingToolCompleted(store, {
			toolUseId: "ui1",
			status: "error",
			output: "Nothing was rendered. Unknown tags: <Nope>.",
		} as never);
		const failed = row(mod, store);
		expect(failed.body?.kind).not.toBe("intelligent-ui");
		expect(failed.painted).toContain("Unknown tags");
	});

	test("a kit build waiting for confirmation is a card to act on, not output text", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolStarted(store, {
			toolUseId: "ui1",
			toolName: "IntelligentUI",
			input: { action: "kit_build" },
		} as never);
		mod.applyStreamingToolCompleted(store, {
			toolUseId: "ui1",
			status: "success",
			output: "The component kit build is waiting for the user's confirmation",
			metadata: {
				intelligentUiKit: {
					state: "unbuilt",
					request: { id: "req-7", kind: "build", state: "pending" },
				},
			},
		} as never);
		const waiting = row(mod, store);
		expect(waiting.body).toMatchObject({ kind: "intelligent-ui", kit: { state: "unbuilt" } });
		expect(waiting.body?.text).toBeUndefined();
		expect(waiting.sections).toBe(1);
	});

	test("the finished call records which runtime drew it, so old UI outlives a later kit", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolStarted(store, {
			toolUseId: "ui1",
			toolName: "IntelligentUI",
			input: { action: "render", source: SOURCE },
		} as never);
		// Still running: nothing recorded yet, the workspace's current kit applies.
		expect(row(mod, store).body?.runtime).toBeUndefined();
		mod.applyStreamingToolCompleted(store, {
			toolUseId: "ui1",
			status: "success",
			output: "Rendered inline",
			metadata: { intelligentUiInline: { version: 1, kit: "builtin" } },
		} as never);
		const done = row(mod, store);
		expect(done.body?.runtime).toBe("builtin");
		expect(done.painted).toContain('"runtime":"builtin"');
		// Only the two runtimes the host knows; anything else in metadata is ignored.
		mod.applyStreamingToolCompleted(store, {
			toolUseId: "ui1",
			status: "success",
			output: "Rendered inline",
			metadata: { intelligentUiInline: { version: 1, kit: "https://evil.example/x.js" } },
		} as never);
		expect(row(mod, store).body?.runtime).toBeUndefined();
	});

	test("a refused or stopped call shows no UI, whatever markup it carried", async () => {
		for (const status of ["denied", "cancelled", "error"]) {
			const mod = await load();
			const store = mod.createStreamingToolStore();
			mod.applyStreamingToolStarted(store, {
				toolUseId: "ui1",
				toolName: "IntelligentUI",
				input: { action: "render", source: SOURCE },
			} as never);
			mod.applyStreamingToolCompleted(store, {
				toolUseId: "ui1",
				status,
				output: status === "error" ? "Nothing was rendered" : undefined,
				// A kit prompt on a call that did not run is not offered either.
				metadata: {
					intelligentUiKit: {
						state: "builtin",
						request: { id: "r", kind: "build", state: "pending" },
					},
				},
			} as never);
			expect(row(mod, store).body?.kind).not.toBe("intelligent-ui");
		}
	});

	test("input that is not a render never becomes an inline frame", async () => {
		const mod = await load();
		for (const input of [
			{ action: "show", path: "x", source: SOURCE },
			{ action: "render", source: 42 },
			{ action: "render" },
			{ action: "kit_status" },
		]) {
			const store = mod.createStreamingToolStore();
			mod.applyStreamingToolStarted(store, {
				toolUseId: "ui1",
				toolName: "IntelligentUI",
				input,
			} as never);
			expect(row(mod, store).body?.kind).not.toBe("intelligent-ui");
		}
	});
});
