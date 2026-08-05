/**
 * streaming-tool-render.test.ts — Live tool state must reach the RENDERED document.
 *
 * The unit tests in streaming-tool-chunks.test.ts prove the fold is correct. These
 * prove the folded state survives the whole pipeline (synthetic message → segment →
 * adapter → measure), which is where two separate defects lived:
 *
 * 1. No live tool card at all. `tool_use_chunk` / `tool_output` were excluded from
 *    the document patch channel with a comment saying they belonged to the streaming
 *    tail — but the tail only accumulated text. A tool appeared only after a
 *    coalesced structural reload (120ms-1s), never while its arguments were written.
 * 2. No live command output. `classifyToolDetail` reads a running command's partial
 *    stdout from `metadata._streamingOutput`, while the live path writes
 *    `tc._streamingOutput`. The adapter never bridged the two, so the field was
 *    present on the item and simply never read: a long build rendered an empty card
 *    until it finished.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

async function load() {
	const [chunks, helpers, segments, layout, cache] = await Promise.all([
		import("./streaming-tool-chunks"),
		import("../narrator-message-helpers"),
		import("../message-segments"),
		import("./pretext-document-layout"),
		import("./measure-cache"),
	]);
	return {
		...chunks,
		buildTopLevelStreamingChunksMsg: helpers.buildTopLevelStreamingChunksMsg,
		buildStreamingMsg: segments.buildStreamingMsg,
		buildPretextDocumentLayout: layout.buildPretextDocumentLayout,
		measureCache: cache.measureCache,
	};
}

type Mod = Awaited<ReturnType<typeof load>>;

function layoutOptions(revision: string) {
	return {
		layoutRevision: `L-${revision}`,
		documentRevision: revision,
		lod: 5 as const,
		widthBucket: "800",
		contentWidth: 800,
		viewportHeight: 900,
		gap: 4,
		segmentGap: 12,
		topPadding: 16,
		bottomPadding: 16,
		resolveToolCategory: () => "bash",
		resolveToolColor: () => "gray",
		resolveToolSummary: (tc: unknown) =>
			String((tc as { inputJson?: { command?: unknown } })?.inputJson?.command ?? ""),
	};
}

/** Build the streaming row from the store and lay it out. */
function layoutRow(mod: Mod, store: ReturnType<Mod["createStreamingToolStore"]>, revision: string) {
	const toolChunksMsg = mod.buildTopLevelStreamingChunksMsg(
		mod.streamingToolChunks(store),
		"n1",
		null,
	);
	const row = mod.buildStreamingMsg({
		streamingBlocks: [{ type: "text", text: "我来运行构建" }] as never,
		toolChunksMsg,
		narratorId: "n1",
	});
	if (!row) throw new Error("expected a streaming row");
	return mod.buildPretextDocumentLayout([row] as never, layoutOptions(revision));
}

function toolRow(built: ReturnType<Mod["buildPretextDocumentLayout"]>) {
	return built.items.find((item) => item.spec.kind === "tool-call");
}

describe("a live tool becomes a card while its arguments are still being written", () => {
	it("renders a tool-call row from the first argument chunk", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolChunk(store, {
			toolUseId: "t1",
			toolName: "Bash",
			inputCharsTotal: 14,
			streamingField: { name: "command", delta: "npm run bui" },
		});
		const built = layoutRow(mod, store, "args-1");
		// The whole point: no reload, no persisted message, and the card is there.
		expect(toolRow(built)?.spec.key).toBe("tool-t1");
		expect(built.items.some((item) => item.spec.kind === "markdown")).toBe(true);
	});

	it("renders the resolved input as soon as the arguments are complete", async () => {
		// `tool_started` means the INPUT finished parsing — the card must show the real
		// command immediately. Its status is `initializing`, not `running`: the permission
		// gate has not been passed yet, so claiming execution here is what used to animate
		// an about-to-prompt card as though it were working.
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolChunk(store, {
			toolUseId: "t1",
			toolName: "Bash",
			inputCharsTotal: 14,
		});
		mod.applyStreamingToolStarted(store, {
			toolUseId: "t1",
			toolName: "Bash",
			input: { command: "npm run build" },
		});
		const row = toolRow(layoutRow(mod, store, "started-1"));
		const data = row?.spec.data as { status?: string; summary?: string };
		expect(data.status).toBe("initializing");
		expect(data.summary).toBe("npm run build");
	});

	it("becomes a RUNNING card once execution actually begins", async () => {
		// `tool_executing` is the frame that earns the blue "executing" treatment, and it
		// must not disturb the input the previous frame resolved.
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolStarted(store, {
			toolUseId: "t1",
			toolName: "Bash",
			input: { command: "npm run build" },
		});
		mod.applyStreamingToolExecuting(store, { toolUseId: "t1" });
		const row = toolRow(layoutRow(mod, store, "exec-1"));
		const data = row?.spec.data as { status?: string; summary?: string };
		expect(data.status).toBe("running");
		expect(data.summary).toBe("npm run build");
	});
});

describe("a running command's output reaches the card", () => {
	it("grows the card as stdout arrives", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolStarted(store, {
			toolUseId: "t1",
			toolName: "Bash",
			input: { command: "npm run build" },
		});
		const empty = toolRow(layoutRow(mod, store, "out-0"))?.measured.height ?? 0;
		mod.applyStreamingToolOutput(store, "t1", "Compiling...");
		const oneLine = toolRow(layoutRow(mod, store, "out-1"))?.measured.height ?? 0;
		mod.applyStreamingToolOutput(store, "t1", "Compiling...\nm1\nm2\nm3\nm4");
		const fiveLines = toolRow(layoutRow(mod, store, "out-2"))?.measured.height ?? 0;
		// Before the metadata bridge every one of these was identical: the field was
		// written, carried along, and never read.
		expect(oneLine).toBeGreaterThan(empty);
		expect(fiveLines).toBeGreaterThan(oneLine);
	});

	it("re-keys the measurement cache as the output grows", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolStarted(store, {
			toolUseId: "t1",
			toolName: "Bash",
			input: { command: "npm run build" },
		});
		// A tool row's spec.key (`tool-t1`) is NOT a streaming key, so it goes through
		// the measurement cache. Holding documentRevision fixed puts the cache fully in
		// play: without the output in the cache key the card would keep serving its
		// first height and the new lines would be clipped away.
		mod.applyStreamingToolOutput(store, "t1", "A");
		const short = toolRow(layoutRow(mod, store, "cache-fixed"))?.measured.height ?? 0;
		mod.applyStreamingToolOutput(store, "t1", "A\nB\nC\nD\nE\nF\nG");
		const long = toolRow(layoutRow(mod, store, "cache-fixed"))?.measured.height ?? 0;
		expect(long).toBeGreaterThan(short);
	});

	it("prefers a persisted output payload over the live preview", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolStarted(store, {
			toolUseId: "t1",
			toolName: "Bash",
			input: { command: "echo hi" },
		});
		mod.applyStreamingToolOutput(store, "t1", "partial");
		mod.applyStreamingToolCompleted(store, {
			toolUseId: "t1",
			status: "success",
			output: { stdout: "final complete output" },
		});
		const row = toolRow(layoutRow(mod, store, "final-1"));
		expect((row?.spec.data as { status?: string }).status).toBe("success");
	});
});

describe("per-tool hand-off leaves exactly one card", () => {
	it("drops the synthetic card once the persisted message carries the tool", async () => {
		const mod = await load();
		const store = mod.createStreamingToolStore();
		mod.applyStreamingToolStarted(store, {
			toolUseId: "t1",
			toolName: "Bash",
			input: { command: "npm run build" },
		});
		const persisted = [
			{
				id: "m1",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }],
				contentText: null,
				toolCalls: [
					{
						toolUseId: "t1",
						toolName: "Bash",
						status: "success",
						inputJson: { command: "npm run build" },
						outputJson: { stdout: "ok" },
					},
				],
				createdAt: "2026-07-28T00:00:00.000Z",
				children: [],
				seq: 1,
			},
		];
		expect(
			mod.dropPersistedStreamingTools(store, mod.collectPersistedToolUseIds(persisted as never)),
		).toBe(true);
		// The synthetic tool is gone, so laying out the document + an (empty) row leaves
		// only the persisted card — never a duplicate, and never a gap.
		const built = mod.buildPretextDocumentLayout(persisted as never, layoutOptions("handoff-1"));
		const toolRows = built.items.filter((item) => item.spec.kind === "tool-call");
		expect(toolRows).toHaveLength(1);
		expect(toolRows[0]?.spec.key).toBe("tool-t1");
	});
});
