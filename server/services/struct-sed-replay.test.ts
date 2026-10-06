/**
 * StructSed's replay branch in `applyToolCall`.
 *
 * The load-bearing assertion here is that an unreplayable call THROWS. Before this branch
 * existed, `applyToolCall` fell through to `return currentContent` for any unrecognised
 * tool name, which meant a StructSed edit was reconstructed as though it had never
 * happened — while the Write/Edit calls around it replayed normally. The result was a
 * plausible-looking file with one edit silently missing, which is worse than a failed
 * revert: nothing reports it.
 */

import { describe, expect, test } from "bun:test";
import { applyToolCall, ReplayDivergedError } from "./file-state-rebuild";

const CLASS = "class A {\n\tfoo() {\n\t\treturn 1;\n\t}\n}\n";

function call(inputJson: unknown, toolName = "StructSed") {
	return {
		toolUseId: "tu-1",
		toolName,
		inputJson,
		status: "success",
		messageId: "m-1",
		seq: 1,
		createdAt: new Date().toISOString(),
	};
}

describe("replaying each command", () => {
	test("replace", () => {
		expect(
			applyToolCall(
				CLASS,
				call({
					command: "replace",
					content: "bar() {\n\treturn 2;\n}",
					resolvedStartLine: 2,
					resolvedEndLine: 4,
				}),
			),
		).toBe("class A {\n\tbar() {\n\t\treturn 2;\n\t}\n}\n");
	});

	test("delete", () => {
		expect(
			applyToolCall(CLASS, call({ command: "delete", resolvedStartLine: 2, resolvedEndLine: 4 })),
		).toBe("class A {\n}\n");
	});

	test("insert", () => {
		expect(
			applyToolCall(
				"a\nb\n",
				call({ command: "insert", content: "x", resolvedStartLine: 2, resolvedEndLine: 2 }),
			),
		).toBe("a\nx\nb\n");
	});

	test("append", () => {
		expect(
			applyToolCall(
				"a\nb\n",
				call({ command: "append", content: "x", resolvedStartLine: 1, resolvedEndLine: 1 }),
			),
		).toBe("a\nx\nb\n");
	});

	test("substitute", () => {
		expect(
			applyToolCall(
				"x\nx\n",
				call({
					command: "substitute",
					pattern: "x",
					replacement: "y",
					flags: "g",
					resolvedStartLine: 1,
					resolvedEndLine: 2,
				}),
			),
		).toBe("y\ny\n");
	});

	test("replay uses the recorded range, not a re-resolved symbol", () => {
		// The symbol is recorded for readability but must not drive replay: by rebuild
		// time the content differs and a same-named symbol may live elsewhere.
		const moved = "// inserted line\nclass A {\n\tfoo() {\n\t\treturn 1;\n\t}\n}\n";
		expect(
			applyToolCall(
				moved,
				call({
					command: "delete",
					symbol: "A.foo",
					resolvedStartLine: 2,
					resolvedEndLine: 4,
				}),
			),
		).toBe("// inserted line\n\t}\n}\n");
	});

	test("CRLF input keeps CRLF output", () => {
		const out = applyToolCall(
			"a\r\nb\r\n",
			call({ command: "delete", resolvedStartLine: 1, resolvedEndLine: 1 }),
		);
		expect(out).toBe("b\r\n");
	});
});

describe("divergence throws instead of silently skipping", () => {
	test("a range past the reconstructed content throws", () => {
		expect(() =>
			applyToolCall("a\n", call({ command: "delete", resolvedStartLine: 50, resolvedEndLine: 50 })),
		).toThrow(ReplayDivergedError);
	});

	test("a missing line range throws rather than replaying nothing", () => {
		expect(() => applyToolCall(CLASS, call({ command: "delete" }))).toThrow(ReplayDivergedError);
	});

	test("a missing command throws", () => {
		expect(() => applyToolCall(CLASS, call({ resolvedStartLine: 1, resolvedEndLine: 1 }))).toThrow(
			ReplayDivergedError,
		);
	});

	test("an unknown command throws", () => {
		expect(() =>
			applyToolCall(CLASS, call({ command: "teleport", resolvedStartLine: 1, resolvedEndLine: 1 })),
		).toThrow(ReplayDivergedError);
	});

	test("replace without recorded content throws", () => {
		expect(() =>
			applyToolCall(CLASS, call({ command: "replace", resolvedStartLine: 1, resolvedEndLine: 1 })),
		).toThrow(ReplayDivergedError);
	});

	test("substitute without pattern throws", () => {
		expect(() =>
			applyToolCall(
				CLASS,
				call({ command: "substitute", replacement: "y", resolvedStartLine: 1, resolvedEndLine: 1 }),
			),
		).toThrow(ReplayDivergedError);
	});

	test("a missing baseline throws", () => {
		expect(() =>
			applyToolCall(null, call({ command: "delete", resolvedStartLine: 1, resolvedEndLine: 1 })),
		).toThrow(ReplayDivergedError);
	});

	test("an invalid substitute pattern throws", () => {
		expect(() =>
			applyToolCall(
				"a\n",
				call({
					command: "substitute",
					pattern: "([",
					replacement: "y",
					resolvedStartLine: 1,
					resolvedEndLine: 1,
				}),
			),
		).toThrow(ReplayDivergedError);
	});
});

describe("unrelated tools are unaffected", () => {
	test("a genuinely unknown tool still passes content through", () => {
		// Only file-modifying tools need a branch; a Read call in the history is correctly
		// a no-op for reconstruction.
		expect(applyToolCall("a\n", call({ file_path: "x" }, "Read"))).toBe("a\n");
	});

	test("null input is a no-op", () => {
		expect(applyToolCall("a\n", call(null))).toBe("a\n");
	});
});
