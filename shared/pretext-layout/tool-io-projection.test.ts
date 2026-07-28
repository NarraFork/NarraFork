import { describe, expect, it } from "bun:test";
import {
	collectTruncatedLeaves,
	hasTruncatedLeaf,
	projectToolIO,
	readLeafText,
	stringifyForDisplay,
	TOOL_IO_BUDGETS,
} from "./tool-io-projection";

/** Small budget so fixtures stay readable. */
const SMALL = { leafBudget: 10 };

function longText(length: number, char = "x"): string {
	return char.repeat(length);
}

describe("projectToolIO — zero-copy fast path", () => {
	it("returns the SAME reference when nothing needs truncating", () => {
		const input = { file_path: "/a/b.ts", offset: 3, nested: { ok: true, list: [1, "two"] } };
		expect(projectToolIO(input, SMALL)).toBe(input);
	});

	it("passes primitives and null through untouched", () => {
		expect(projectToolIO(null, SMALL)).toBe(null);
		expect(projectToolIO(undefined, SMALL)).toBe(undefined);
		expect(projectToolIO(42, SMALL)).toBe(42);
		expect(projectToolIO(true, SMALL)).toBe(true);
		expect(projectToolIO("short", SMALL)).toBe("short");
	});

	it("truncates a bare string payload at the ROOT (the common output shape)", () => {
		const out = projectToolIO(longText(50), SMALL) as {
			_truncated: boolean;
			preview: string;
			fullLength: number;
		};
		expect(out._truncated).toBe(true);
		expect(out.preview).toBe(longText(10));
		expect(out.fullLength).toBe(50);
	});
});

describe("projectToolIO — sibling fields survive", () => {
	it("keeps _metadata alongside a truncated _text (the structured-card regression)", () => {
		const metadata = { action: "search", results: [{ id: "m1", snippet: "hit" }] };
		const out = projectToolIO({ _text: longText(50), _metadata: metadata }, SMALL) as Record<
			string,
			unknown
		>;
		// The whole point: metadata is a sibling, not swallowed by a root wrapper.
		expect(out._metadata).toEqual(metadata);
		expect(readLeafText(out._text)).toBe(longText(10));
	});

	it("keeps short header fields readable next to a truncated body", () => {
		const out = projectToolIO(
			{ file_path: "/a/b.ts", content: longText(50), timeout: 5000 },
			SMALL,
		) as Record<string, unknown>;
		expect(out.file_path).toBe("/a/b.ts");
		expect(out.timeout).toBe(5000);
		expect(hasTruncatedLeaf(out.content)).toBe(true);
	});

	it("gives old_string and new_string INDEPENDENT budgets", () => {
		const out = projectToolIO(
			{ old_string: longText(50, "o"), new_string: longText(50, "n") },
			SMALL,
		) as Record<string, unknown>;
		// Under the old root wrapper the first field starved the second entirely.
		expect(readLeafText(out.old_string)).toBe(longText(10, "o"));
		expect(readLeafText(out.new_string)).toBe(longText(10, "n"));
	});

	it("truncates oversized array elements while keeping the array shape", () => {
		const out = projectToolIO({ items: ["ok", longText(50)] }, SMALL) as {
			items: unknown[];
		};
		expect(out.items).toHaveLength(2);
		expect(out.items[0]).toBe("ok");
		expect(readLeafText(out.items[1])).toBe(longText(10));
	});
});

describe("projectToolIO — markdown budget", () => {
	it("gives a `plan` field the larger markdown budget", () => {
		const plan = longText(20_000);
		const out = projectToolIO({ plan }, { leafBudget: 8 * 1024 }) as Record<string, unknown>;
		// 20K fits inside the 32K markdown budget, so it is kept whole.
		expect(out.plan).toBe(plan);
	});

	it("clamps a plan that exceeds even the markdown budget", () => {
		const plan = longText(TOOL_IO_BUDGETS.markdownLeaf + 100);
		const out = projectToolIO({ plan }, { leafBudget: 8 * 1024 }) as Record<string, unknown>;
		expect(readLeafText(out.plan)?.length).toBe(TOOL_IO_BUDGETS.markdownLeaf);
	});

	it("does NOT inflate a plan on a small (broadcast) budget beyond an explicit override", () => {
		// A WS broadcast asks for 2000; the markdown default must not silently make
		// this leaf 32K, but an explicit override is honoured.
		const plan = longText(20_000);
		const broadcast = projectToolIO({ plan }, { leafBudget: 2000, markdownBudget: 2000 }) as Record<
			string,
			unknown
		>;
		expect(readLeafText(broadcast.plan)?.length).toBe(2000);
	});

	it("treats a non-plan markdown-ish field with the normal leaf budget", () => {
		const out = projectToolIO({ _text: longText(50) }, SMALL) as Record<string, unknown>;
		expect(readLeafText(out._text)?.length).toBe(10);
	});
});

describe("projectToolIO — already-projected input", () => {
	it("passes an existing wrapper through without re-slicing", () => {
		const wrapper = { _truncated: true as const, preview: longText(50), fullLength: 900 };
		const out = projectToolIO({ body: wrapper }, SMALL) as Record<string, unknown>;
		// fullLength must keep describing the ORIGINAL payload, not the preview.
		expect(out.body).toBe(wrapper);
	});
});

describe("projectToolIO — guards", () => {
	it("bounds recursion depth", () => {
		// Build a chain deeper than maxDepth with a long string at the bottom.
		let node: Record<string, unknown> = { deep: longText(50) };
		for (let i = 0; i < TOOL_IO_BUDGETS.maxDepth + 4; i++) node = { next: node };
		// Must terminate and produce a finite result.
		const out = projectToolIO(node, SMALL);
		expect(typeof out).toBe("object");
		expect(stringifyForDisplay(out).length).toBeGreaterThan(0);
	});

	it("bounds array element count", () => {
		const items = Array.from({ length: TOOL_IO_BUDGETS.maxArrayElements + 50 }, () => "v");
		const out = projectToolIO({ items }, SMALL) as { items: unknown[] };
		expect(out.items).toHaveLength(TOOL_IO_BUDGETS.maxArrayElements);
	});

	it("bounds object key count", () => {
		const record: Record<string, string> = {};
		for (let i = 0; i < TOOL_IO_BUDGETS.maxObjectKeys + 50; i++) record[`k${i}`] = "v";
		const out = projectToolIO(record, SMALL) as Record<string, unknown>;
		expect(Object.keys(out)).toHaveLength(TOOL_IO_BUDGETS.maxObjectKeys);
	});

	it("survives a cyclic structure", () => {
		const node: Record<string, unknown> = { name: "root" };
		node.self = node;
		expect(() => projectToolIO(node, SMALL)).not.toThrow();
	});

	it("projects a DAG (same object in two sibling slots) in BOTH places", () => {
		const shared = { body: longText(50) };
		const out = projectToolIO({ a: shared, b: shared }, SMALL) as Record<
			string,
			Record<string, unknown>
		>;
		// A visited-set that never releases would leave the second slot untruncated.
		expect(hasTruncatedLeaf(out.a)).toBe(true);
		expect(hasTruncatedLeaf(out.b)).toBe(true);
	});

	it("enforces the aggregate total budget across many in-budget leaves", () => {
		// 40 leaves × 10 chars = 400, over a 100-char total.
		const items = Array.from({ length: 40 }, () => longText(10));
		const out = projectToolIO({ items }, { leafBudget: 10, totalBudget: 100 }) as {
			items: unknown[];
		};
		let sum = 0;
		for (const item of out.items) sum += readLeafText(item)?.length ?? 0;
		expect(sum).toBeLessThanOrEqual(100);
	});

	it("keeps fullLength describing the original when squeezing for the total budget", () => {
		const out = projectToolIO(
			{ a: longText(60, "a"), b: longText(60, "b") },
			{ leafBudget: 50, totalBudget: 20 },
		) as Record<string, { fullLength: number; preview: string }>;
		expect(out.a.fullLength).toBe(60);
		expect(out.b.fullLength).toBe(60);
		expect(out.a.preview.length + out.b.preview.length).toBeLessThanOrEqual(20);
	});

	it("clamps a nonsensical leaf budget instead of disabling truncation", () => {
		const out = projectToolIO(longText(50), { leafBudget: -5 }) as { preview: string };
		expect(out.preview.length).toBe(1);
	});
});

describe("hasTruncatedLeaf", () => {
	it("finds a wrapper at the root", () => {
		expect(hasTruncatedLeaf({ _truncated: true, preview: "p", fullLength: 9 })).toBe(true);
	});

	it("finds a wrapper NESTED in an object (the root-probe blind spot)", () => {
		expect(hasTruncatedLeaf({ a: { b: { _truncated: true, preview: "p", fullLength: 9 } } })).toBe(
			true,
		);
	});

	it("finds a wrapper nested in an array", () => {
		expect(hasTruncatedLeaf({ list: [1, { _truncated: true, preview: "p", fullLength: 9 }] })).toBe(
			true,
		);
	});

	it("returns false for untruncated payloads and primitives", () => {
		expect(hasTruncatedLeaf({ a: "x", b: [1, 2] })).toBe(false);
		expect(hasTruncatedLeaf(null)).toBe(false);
		expect(hasTruncatedLeaf("plain")).toBe(false);
		expect(hasTruncatedLeaf(undefined)).toBe(false);
	});

	it("rejects a malformed wrapper (no preview string)", () => {
		expect(hasTruncatedLeaf({ _truncated: true, fullLength: 9 })).toBe(false);
	});

	it("survives a cyclic structure", () => {
		const node: Record<string, unknown> = {};
		node.self = node;
		expect(hasTruncatedLeaf(node)).toBe(false);
	});
});

describe("collectTruncatedLeaves", () => {
	it("reports one entry per truncated leaf with sizes and paths", () => {
		const projected = projectToolIO(
			{ old_string: longText(30, "o"), new_string: longText(40, "n"), file_path: "/a" },
			SMALL,
		);
		const leaves = collectTruncatedLeaves(projected);
		expect(leaves).toHaveLength(2);
		expect(leaves.map((l) => l.path)).toEqual(["old_string", "new_string"]);
		expect(leaves.map((l) => l.fullLength)).toEqual([30, 40]);
		expect(leaves.every((l) => l.previewLength === 10)).toBe(true);
	});

	it("formats array paths with indices", () => {
		const projected = projectToolIO({ items: ["ok", longText(30)] }, SMALL);
		expect(collectTruncatedLeaves(projected)[0]?.path).toBe("items[1]");
	});

	it("uses an empty path when the payload IS the leaf", () => {
		const projected = projectToolIO(longText(30), SMALL);
		expect(collectTruncatedLeaves(projected)[0]?.path).toBe("");
	});

	it("returns an empty list for an untruncated payload", () => {
		expect(collectTruncatedLeaves({ a: "x" })).toEqual([]);
	});
});

describe("readLeafText", () => {
	it("returns a string verbatim", () => {
		expect(readLeafText("plain")).toBe("plain");
		expect(readLeafText("")).toBe("");
	});

	it("returns the preview of a wrapper", () => {
		expect(readLeafText({ _truncated: true, preview: "cut", fullLength: 99 })).toBe("cut");
	});

	it("returns undefined for anything else", () => {
		expect(readLeafText(undefined)).toBeUndefined();
		expect(readLeafText(null)).toBeUndefined();
		expect(readLeafText(42)).toBeUndefined();
		expect(readLeafText({ a: 1 })).toBeUndefined();
	});
});

describe("stringifyForDisplay", () => {
	it("never leaks a wrapper's STRUCTURE into the dump", () => {
		const projected = projectToolIO({ file_path: "/a", content: longText(30) }, SMALL);
		const text = stringifyForDisplay(projected);
		expect(text).not.toContain("_truncated");
		expect(text).not.toContain("fullLength");
		expect(text).not.toContain("preview");
		// The preview text itself IS shown, marked as elided.
		expect(text).toContain(longText(10));
		expect(text).toContain("…");
		expect(text).toContain("/a");
	});

	it("renders a bare-string payload's wrapper as text", () => {
		const projected = projectToolIO(longText(30), SMALL);
		expect(stringifyForDisplay(projected)).toBe(`"${longText(10)}…"`);
	});

	it("pretty-prints an untruncated object like JSON.stringify does", () => {
		const value = { a: 1, b: "two" };
		expect(stringifyForDisplay(value)).toBe(JSON.stringify(value, null, 2));
	});

	it("bounds the RESULT length when maxChars is given", () => {
		const value = { body: longText(500, "z") };
		expect(stringifyForDisplay(value, 40).length).toBe(40);
	});

	it("does not throw on a cyclic structure", () => {
		const node: Record<string, unknown> = { name: "n" };
		node.self = node;
		expect(() => stringifyForDisplay(node)).not.toThrow();
	});
});
