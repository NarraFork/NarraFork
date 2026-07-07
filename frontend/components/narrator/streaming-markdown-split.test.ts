import { describe, expect, test } from "bun:test";
import { hasUnclosedFence, splitStableAndTail } from "./streaming-markdown-split";

/** Invariant that must always hold: prefix + tail reconstructs the (LF) text. */
function expectReconstructs(text: string, prevPrefix = "") {
	const { stablePrefix, tail } = splitStableAndTail(text, prevPrefix);
	expect(stablePrefix + tail).toBe(text.replace(/\r\n?/g, "\n"));
	return { stablePrefix, tail };
}

describe("splitStableAndTail — basics", () => {
	test("empty / short text has no stable prefix", () => {
		expect(splitStableAndTail("")).toEqual({ stablePrefix: "", tail: "" });
		expect(splitStableAndTail("hello")).toEqual({ stablePrefix: "", tail: "hello" });
	});

	test("single block (no blank line) stays entirely in tail", () => {
		const { stablePrefix, tail } = expectReconstructs("one long paragraph still being written");
		expect(stablePrefix).toBe("");
		expect(tail).toBe("one long paragraph still being written");
	});

	test("two blocks: buffer keeps both in tail (need >2 blocks to seal)", () => {
		// With BUFFER_BLOCKS=2, we drop the last 2 blocks; two blocks => nothing sealed.
		const text = "para one\n\npara two";
		const { stablePrefix, tail } = expectReconstructs(text);
		expect(stablePrefix).toBe("");
		expect(tail).toBe(text);
	});

	test("three blocks: first block seals, last two buffered in tail", () => {
		const text = "para one\n\npara two\n\npara three";
		const { stablePrefix, tail } = expectReconstructs(text);
		expect(stablePrefix).toBe("para one\n\n");
		expect(tail).toBe("para two\n\npara three");
	});

	test("four blocks: two seal", () => {
		const text = "a\n\nb\n\nc\n\nd";
		const { stablePrefix, tail } = expectReconstructs(text);
		expect(stablePrefix).toBe("a\n\nb\n\n");
		expect(tail).toBe("c\n\nd");
	});
});

describe("splitStableAndTail — fenced code", () => {
	test("blank lines inside a fenced code block are not boundaries", () => {
		const text = [
			"intro para",
			"",
			"```js",
			"const a = 1;",
			"",
			"const b = 2;",
			"```",
			"",
			"after",
		].join("\n");
		const { stablePrefix, tail } = expectReconstructs(text);
		// Blocks: "intro para" / fenced code / "after" = 3 blocks. The blank line
		// INSIDE the fence must NOT create an extra boundary — otherwise part of
		// the fence would leak into the sealed prefix. Only "intro para" seals;
		// the fence stays intact in the tail.
		expect(stablePrefix).toBe("intro para\n\n");
		expect(tail).toBe("```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter");
	});

	test("closed fence + enough following blocks seals the fence", () => {
		const text = ["intro", "", "```js", "x", "", "y", "```", "", "middle", "", "tail para"].join(
			"\n",
		);
		const { stablePrefix, tail } = expectReconstructs(text);
		// Blocks: "intro" / fenced code / "middle" / "tail para" = 4 blocks. Drop
		// the last 2 => seal "intro" + the (closed, intact) fenced code block.
		expect(stablePrefix).toBe("intro\n\n```js\nx\n\ny\n```\n\n");
		expect(tail).toBe("middle\n\ntail para");
	});

	test("unclosed fence is never sealed", () => {
		const text = ["a", "", "b", "", "```js", "still", "", "writing"].join("\n");
		const { tail } = expectReconstructs(text);
		// The unclosed fence swallows everything after it; blank inside must not seal.
		expect(tail).toContain("```js");
		expect(tail).toContain("writing");
	});
});

describe("splitStableAndTail — back-off for risky last blocks", () => {
	test("last kept block being a list backs off", () => {
		// Blocks: "intro", list, "p3", "p4". Drop last 2 => candidate seals after
		// the list. But last kept = list => back off to seal only "intro".
		const text = ["intro", "", "- item a", "- item b", "", "p3", "", "p4"].join("\n");
		const { stablePrefix, tail } = expectReconstructs(text);
		expect(stablePrefix).toBe("intro\n\n");
		expect(tail).toContain("- item a");
	});

	test("last kept block being a table backs off", () => {
		const text = ["intro", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "p3", "", "p4"].join(
			"\n",
		);
		const { stablePrefix } = expectReconstructs(text);
		expect(stablePrefix).toBe("intro\n\n");
	});
});

describe("splitStableAndTail — definition guard disables splitting", () => {
	test("link reference definition in prefix disables split", () => {
		const text = [
			"[ref]: https://example.com",
			"",
			"para two",
			"",
			"para three",
			"",
			"para four",
		].join("\n");
		const { stablePrefix, tail } = expectReconstructs(text);
		// Prefix would contain [ref]: => disable splitting entirely.
		expect(stablePrefix).toBe("");
		expect(tail).toBe(text.replace(/\r\n?/g, "\n"));
	});

	test("footnote definition in prefix disables split", () => {
		const text = ["[^n]: a footnote", "", "b", "", "c", "", "d"].join("\n");
		const { stablePrefix } = expectReconstructs(text);
		expect(stablePrefix).toBe("");
	});

	test("definition only in tail is fine (split still allowed)", () => {
		const text = ["a", "", "b", "", "c", "", "[ref]: https://x.com"].join("\n");
		const { stablePrefix, tail } = expectReconstructs(text);
		// Blocks: a / b / c / [ref] = 4. Drop last 2 => seal "a" + "b". The [ref]
		// definition sits in the tail (last block), so the prefix has no
		// definition and splitting is allowed.
		expect(stablePrefix).toBe("a\n\nb\n\n");
		expect(tail).toContain("[ref]:");
	});
});

describe("splitStableAndTail — monotonicity & reset", () => {
	test("prefix only grows as text is appended", () => {
		const step1 = "a\n\nb\n\nc";
		const r1 = splitStableAndTail(step1, "");
		expect(r1.stablePrefix).toBe("a\n\n");

		const step2 = "a\n\nb\n\nc\n\nd";
		const r2 = splitStableAndTail(step2, r1.stablePrefix);
		expect(r2.stablePrefix).toBe("a\n\nb\n\n");
		// Prefix grew and still starts with the previous prefix.
		expect(r2.stablePrefix.startsWith(r1.stablePrefix)).toBe(true);
	});

	test("monotonic guard prevents prefix from shrinking", () => {
		// Simulate a pathological recompute that would shrink; guard keeps prev.
		const prev = "a\n\nb\n\n";
		const text = "a\n\nb\n\nc\n\nd";
		const { stablePrefix } = splitStableAndTail(text, prev);
		expect(stablePrefix.startsWith(prev)).toBe(true);
		expect(stablePrefix.length).toBeGreaterThanOrEqual(prev.length);
	});

	test("reset: new text not starting with prev prefix recomputes fresh", () => {
		const prev = "old content\n\nmore\n\n";
		const text = "totally different\n\nsecond\n\nthird\n\nfourth";
		const { stablePrefix, tail } = expectReconstructs(text, prev);
		// prev is not a prefix of text => guard dropped; normal split applies.
		expect(stablePrefix).toBe("totally different\n\nsecond\n\n");
		expect(tail).toContain("fourth");
	});
});

describe("splitStableAndTail — CRLF handling", () => {
	test("CRLF is normalised and reconstruction uses LF", () => {
		const text = "a\r\n\r\nb\r\n\r\nc\r\n\r\nd";
		const { stablePrefix, tail } = splitStableAndTail(text, "");
		expect(stablePrefix + tail).toBe("a\n\nb\n\nc\n\nd");
		expect(stablePrefix).toBe("a\n\nb\n\n");
	});
});

describe("splitStableAndTail — headings and mixed content", () => {
	test("ATX headings seal safely", () => {
		const text = ["# Title", "", "## Section", "", "body para", "", "more body"].join("\n");
		const { stablePrefix, tail } = expectReconstructs(text);
		// Blocks: "# Title" / "## Section" / "body para" / "more body" = 4. Drop
		// last 2 => seal the two headings' worth of leading blocks.
		expect(stablePrefix).toBe("# Title\n\n## Section\n\n");
		expect(tail).toBe("body para\n\nmore body");
	});
});

describe("hasUnclosedFence", () => {
	test("plain text has no fence", () => {
		expect(hasUnclosedFence("just some words")).toBe(false);
	});

	test("closed fence returns false", () => {
		expect(hasUnclosedFence("```js\nconst a = 1;\n```")).toBe(false);
	});

	test("open (unterminated) fence returns true", () => {
		expect(hasUnclosedFence("intro\n\n```js\nconst a = 1;")).toBe(true);
	});

	test("tilde fence closing needs matching marker", () => {
		expect(hasUnclosedFence("~~~\ncode")).toBe(true);
		expect(hasUnclosedFence("~~~\ncode\n~~~")).toBe(false);
	});
});
