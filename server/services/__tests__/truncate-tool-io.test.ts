import { afterAll, describe, expect, mock, test } from "bun:test";

// narrator-messages.ts sits in a load-time import cycle
// (narrator-messages → websocket/narrator-ws → narrator-service → narrator-messages)
// which throws "narratorMessageQueries before initialization" if imported directly
// in a test. truncateToolIO itself is a pure function with no ws/service deps, so we
// break the cycle by mocking the only symbol narrator-messages pulls from
// narrator-ws (broadcastToNarrator). This keeps narrator-messages.ts UNCHANGED —
// no touching the OFF-shared file just to make it testable.
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	broadcastToNarrator: () => {},
}));

afterAll(() => {
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

const { truncateToolIO, truncateJson, DEFAULT_TOOL_IO_BUDGET, EXACT_TOOL_IO_BUDGET } = await import(
	"../narrator-messages"
);

/**
 * Coverage for the tool-IO projection that runs on EVERY message-loading path.
 *
 * The projection is FIELD-LEVEL: oversized string leaves become
 * `{_truncated, preview, fullLength}` wrappers while the object structure and all
 * short fields survive. It replaced a root-level wrapper that stringified the
 * whole payload, which had four consequences these tests pin down:
 *
 *   1. `_metadata` was dropped (a sibling of the truncated `_text`), so every
 *      structured card silently degraded to a generic JSON dump.
 *   2. `_text` could not be unwrapped, so previews showed literal JSON.
 *   3. Header fields had to travel through a hand-maintained `_hints` whitelist —
 *      the source of the regression the previous version of this file guarded
 *      (a lost Bash `description`). Field-level projection removes the whitelist
 *      entirely, so that class of bug can no longer exist.
 *   4. An Edit's old_string/new_string shared one budget.
 */

// biome-ignore lint/suspicious/noExplicitAny: dynamic tool tree fixtures
type Tree = any[];

function bashMsg(inputJson: unknown): Tree {
	return [
		{
			id: "m1",
			role: "assistant",
			toolCalls: [{ toolUseId: "t1", toolName: "Bash", inputJson, status: "success" }],
			children: [],
		},
	];
}

function toolMsg(toolName: string, inputJson?: unknown, outputJson?: unknown): Tree {
	return [
		{
			id: "m1",
			role: "assistant",
			toolCalls: [{ toolUseId: "t1", toolName, inputJson, outputJson, status: "success" }],
			children: [],
		},
	];
}

/** Exceeds the default 2000-char per-leaf budget. */
const LONG = "x".repeat(3000);

describe("file-reference display projection", () => {
	test("lists and child/WS summaries omit snapshots but keep context and locator", () => {
		const snapshot = {
			type: "file_reference",
			reference: { id: "ref", deviceId: "A", path: "/repo/a.ts", label: "a.ts" },
			snapshotText: "hidden file body".repeat(8192),
			snapshotHash: "hash",
			capturedAt: "2026-09-07T00:00:00Z",
		};
		const context = { deviceId: "B", cwd: "/repo" };
		const child = { role: "user", contentText: "review", contentJson: [snapshot] };
		const tree = [
			{
				role: "assistant",
				contentJson: [{ type: "text", text: "src/a.ts", fileReferenceContext: context }],
				children: [child],
			},
			child,
		];
		const projected = truncateToolIO(tree);
		expect(projected[0].contentJson[0].fileReferenceContext).toEqual(context);
		for (const message of [projected[0].children[0], projected[1]]) {
			expect(message.contentJson).toEqual([
				{ type: "file_reference", reference: snapshot.reference },
			]);
			expect(message.contentText).toBe("review");
		}
		expect(JSON.stringify(projected)).not.toContain("hidden file body");
		expect(JSON.stringify(projected)).not.toContain("snapshotText");
		// Display projection must not mutate the row used by details/history/model replay.
		expect(child.contentJson[0]).toBe(snapshot);
		expect(snapshot.snapshotText.length).toBeGreaterThan(100_000);
	});
});

describe("truncateToolIO — header fields survive without _hints", () => {
	test("truncated Bash input keeps command/description/timeout as PLAIN fields", () => {
		const out = truncateToolIO(
			bashMsg({
				command: "echo hello && run-something",
				description: "run the greeting script",
				timeout: 5000,
				// padding to push the payload past the budget
				_pad: LONG,
			}),
		);
		const input = out[0].toolCalls[0].inputJson;
		// The whole point of field-level projection: these are readable fields, not
		// entries in a `_hints` map that every new tool must remember to populate.
		expect(input.command).toBe("echo hello && run-something");
		expect(input.description).toBe("run the greeting script");
		expect(input.timeout).toBe(5000);
		expect(input._hints).toBeUndefined();
		// Only the oversized leaf became a wrapper.
		expect(input._pad._truncated).toBe(true);
		expect(input._pad.fullLength).toBe(3000);
	});

	test("header fields are NOT clipped to 100 chars any more", () => {
		const command = "c".repeat(250);
		const description = "d".repeat(250);
		const out = truncateToolIO(bashMsg({ command, description, _pad: LONG }));
		const input = out[0].toolCalls[0].inputJson;
		// The old `_hints` path clipped these to 100; a real field under the leaf
		// budget is now carried whole.
		expect(input.command).toBe(command);
		expect(input.description).toBe(description);
	});

	test("short Bash input is left untouched (same reference, zero copy)", () => {
		const input = { command: "ls", description: "list files", timeout: 1000 };
		const out = truncateToolIO(bashMsg(input));
		expect(out[0].toolCalls[0].inputJson).toBe(input);
	});
});

describe("truncateToolIO — sibling fields survive truncation", () => {
	test("_metadata survives a truncated _text (the structured-card regression)", () => {
		const metadata = { action: "search", results: [{ id: "m1", snippet: "a hit" }] };
		const out = truncateToolIO(
			toolMsg("Recall", { action: "search" }, { _text: LONG, _metadata: metadata }),
		);
		const output = out[0].toolCalls[0].outputJson;
		// Under the root wrapper this was gone, and the card degraded to a JSON dump.
		expect(output._metadata).toEqual(metadata);
		expect(output._text._truncated).toBe(true);
		expect(output._text.preview.length).toBe(DEFAULT_TOOL_IO_BUDGET);
	});

	test("an Edit's old_string and new_string get INDEPENDENT budgets", () => {
		const out = truncateToolIO(
			toolMsg("Edit", {
				file_path: "/a/b.ts",
				old_string: "o".repeat(3000),
				new_string: "n".repeat(3000),
			}),
		);
		const input = out[0].toolCalls[0].inputJson;
		expect(input.file_path).toBe("/a/b.ts");
		expect(input.old_string.preview).toBe("o".repeat(DEFAULT_TOOL_IO_BUDGET));
		expect(input.new_string.preview).toBe("n".repeat(DEFAULT_TOOL_IO_BUDGET));
	});
});

describe("truncateToolIO — skip rules are preserved", () => {
	test("spec://tasks.json Write input is never truncated (task card needs full input)", () => {
		const bigTasks = { file_path: "spec://tasks.json", content: LONG };
		const out = truncateToolIO(toolMsg("Write", bigTasks));
		expect(out[0].toolCalls[0].inputJson).toEqual(bigTasks);
	});

	test("ExitPlanMode is skipped entirely (input AND output)", () => {
		const input = { plan: LONG };
		const out = truncateToolIO(toolMsg("ExitPlanMode", input, LONG));
		expect(out[0].toolCalls[0].inputJson).toEqual(input);
		expect(out[0].toolCalls[0].outputJson).toBe(LONG);
	});

	test("Agent/Task/Send inputs are skipped but their outputs are projected", () => {
		for (const toolName of ["Agent", "Task", "Send"]) {
			const input = { prompt: LONG };
			const out = truncateToolIO(toolMsg(toolName, input, LONG));
			expect(out[0].toolCalls[0].inputJson).toEqual(input);
			expect(out[0].toolCalls[0].outputJson._truncated).toBe(true);
		}
	});
});

describe("truncateToolIO — general behavior", () => {
	test("a large bare-string outputJson is truncated at the root", () => {
		const out = truncateToolIO(toolMsg("Bash", { command: "ls" }, LONG));
		const output = out[0].toolCalls[0].outputJson;
		// A bare string payload IS the leaf, so the wrapper still lands at the root.
		expect(output._truncated).toBe(true);
		expect(output.fullLength).toBe(3000);
	});

	test("recurses into child tool trees with the same budget", () => {
		const out = truncateToolIO([
			{
				id: "parent",
				role: "assistant",
				toolCalls: [],
				children: bashMsg({ command: "x", description: "child bash", _pad: LONG }),
			},
		]);
		const childInput = out[0].children[0].toolCalls[0].inputJson;
		expect(childInput.description).toBe("child bash");
		expect(childInput._pad._truncated).toBe(true);
	});

	test("honours an explicit larger budget (the exact-layout path)", () => {
		const body = "y".repeat(5000);
		const out = truncateToolIO(toolMsg("Read", { file_path: "/a" }, body), EXACT_TOOL_IO_BUDGET);
		// 5000 < 8K, so the exact-layout path keeps the body whole.
		expect(out[0].toolCalls[0].outputJson).toBe(body);
	});
});

describe("truncateJson — budget defaults", () => {
	test("defaults to the conservative broadcast budget", () => {
		expect(DEFAULT_TOOL_IO_BUDGET).toBe(2000);
		const out = truncateJson(LONG);
		expect(out.preview.length).toBe(2000);
	});

	test("a small explicit budget is NOT overridden by the markdown budget", () => {
		// A WS broadcast asking for 2000 must not ship a 32K plan.
		const out = truncateJson({ plan: "p".repeat(20_000) }, 2000);
		expect(out.plan.preview.length).toBe(2000);
	});

	test("passes null/undefined through", () => {
		expect(truncateJson(null, 2000)).toBe(null);
		expect(truncateJson(undefined, 2000)).toBe(undefined);
	});

	test("the exact-layout budget is the shared 8K leaf constant", () => {
		expect(EXACT_TOOL_IO_BUDGET).toBe(8 * 1024);
	});
});
