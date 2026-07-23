import { describe, expect, mock, test } from "bun:test";

// narrator-messages.ts sits in a load-time import cycle
// (narrator-messages → websocket/narrator-ws → narrator-service → narrator-messages)
// which throws "narratorMessageQueries before initialization" if imported directly
// in a test. truncateToolIO itself is a pure function with no ws/service deps, so we
// break the cycle by mocking the only symbol narrator-messages pulls from
// narrator-ws (broadcastToNarrator). This keeps narrator-messages.ts UNCHANGED —
// no touching the OFF-shared file just to make it testable.
mock.module("../../websocket/narrator-ws", () => ({
	broadcastToNarrator: () => {},
}));

const { truncateToolIO } = await import("../narrator-messages");

/**
 * Regression coverage for the tool-IO truncation projection that runs on BOTH the
 * full and lod message-loading paths (i.e. it is on the OFF path too).
 *
 * The headline case pins a real regression that was found + fixed by byte-diff
 * during the vlist work: when the "LOD projection" pure helpers were inlined back
 * into narrator-messages.ts, the Bash branch of extractHeaderHints lost its
 * `description` extraction. That meant a long Bash tool_use whose inputJson gets
 * truncated would drop `_hints.description` — degrading the collapsed tool-card
 * header on the shared/OFF path. extractHeaderHints is module-private, so we
 * exercise it through the public truncateToolIO API (which is exactly how the
 * message list consumes it).
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

const LONG = "x".repeat(3000); // exceeds the 2000-char truncation threshold

describe("truncateToolIO — Bash header hints regression", () => {
	test("truncated Bash input keeps description/command/timeout hints", () => {
		const out = truncateToolIO(
			bashMsg({
				command: "echo hello && run-something",
				description: "run the greeting script",
				timeout: 5000,
				// padding to push the serialized input past maxLen
				_pad: LONG,
			}),
		);
		const tc = out[0].toolCalls[0];
		expect(tc.inputJson._truncated).toBe(true);
		const hints = tc.inputJson._hints;
		expect(hints).toBeDefined();
		// The regression: description must survive truncation for the card header.
		expect(hints.description).toBe("run the greeting script");
		expect(hints.command).toBe("echo hello && run-something");
		expect(hints.timeout).toBe(5000);
	});

	test("long command/description are clipped to 100 chars in hints", () => {
		const out = truncateToolIO(
			bashMsg({
				command: "c".repeat(250),
				description: "d".repeat(250),
				_pad: LONG,
			}),
		);
		const hints = out[0].toolCalls[0].inputJson._hints;
		expect(hints.command.length).toBe(100);
		expect(hints.description.length).toBe(100);
	});

	test("short Bash input is left untouched (no truncation, no hints)", () => {
		const input = { command: "ls", description: "list files", timeout: 1000 };
		const out = truncateToolIO(bashMsg(input));
		expect(out[0].toolCalls[0].inputJson).toEqual(input);
	});
});

describe("truncateToolIO — general behavior", () => {
	test("spec://tasks.json Write input is never truncated (task-card needs full input)", () => {
		const bigTasks = { file_path: "spec://tasks.json", content: LONG };
		const out = truncateToolIO([
			{
				id: "m2",
				role: "assistant",
				toolCalls: [{ toolUseId: "t2", toolName: "Write", inputJson: bigTasks, status: "success" }],
				children: [],
			},
		]);
		expect(out[0].toolCalls[0].inputJson).toEqual(bigTasks);
	});

	test("large outputJson is truncated to a preview placeholder", () => {
		const out = truncateToolIO([
			{
				id: "m3",
				role: "assistant",
				toolCalls: [
					{
						toolUseId: "t3",
						toolName: "Bash",
						inputJson: { command: "ls" },
						outputJson: LONG,
						status: "success",
					},
				],
				children: [],
			},
		]);
		expect(out[0].toolCalls[0].outputJson._truncated).toBe(true);
	});

	test("recurses into child tool trees", () => {
		const out = truncateToolIO([
			{
				id: "parent",
				role: "assistant",
				toolCalls: [],
				children: bashMsg({ command: "x", description: "child bash", _pad: LONG }),
			},
		]);
		const childTc = out[0].children[0].toolCalls[0];
		expect(childTc.inputJson._truncated).toBe(true);
		expect(childTc.inputJson._hints.description).toBe("child bash");
	});
});
