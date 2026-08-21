/**
 * Guard: never ask "is this PAYLOAD truncated" with a root-level probe.
 *
 * Tool IO truncation is FIELD-LEVEL: the `{_truncated, preview, fullLength}`
 * wrapper sits on the oversized string LEAF, so an object payload's root stays a
 * plain object. Probing the root therefore always answers "complete" — and because
 * the wrapper shape itself never changed, TypeScript cannot flag it. Every such
 * probe fails SILENTLY, which is what makes this worth a guard rather than a
 * comment:
 *
 *   - `LazyDetailRenderer.hasTruncatedData` kept a root probe through the
 *     field-level migration, so `needsFetch` was permanently false: the chunked
 *     card offered "load full content" and clicking it did nothing.
 *   - `SubagentCard` had the same shape and was fixed. (The Pixi renderer's
 *     `pixi-message-model` carried it too, but that renderer has been deleted.)
 *
 * The right question is `hasTruncatedLeaf(payload)` (recursive). `isTruncated(x)`
 * remains correct for asking whether ONE value is a leaf.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Modules that consume a tool call's inputJson / outputJson. */
const PAYLOAD_CONSUMERS = [
	"ToolCallInspector.tsx",
	"narrator-message-helpers.ts",
	"vlist/segment-adapter.ts",
	"vlist/vlist-selection.ts",
	"vlist/PretextExactMessageList.tsx",
];

/**
 * A root-level `_truncated` read off a payload identifier, with or without an
 * intervening cast: `outputJson?._truncated`, `(x.inputJson as Foo)._truncated`.
 *
 * Deliberately keyed on the payload NAMES rather than on `_truncated` in general,
 * so the legitimate single-value leaf guards (`val?._truncated`,
 * `record._truncated`) do not trip it.
 */
const ROOT_PROBE = /\b(?:inputJson|outputJson)\s*(?:as\s+[^)]*\))?\s*\??\._truncated/;

function read(relativePath: string): string {
	return readFileSync(join(import.meta.dir, relativePath), "utf8");
}

/** Source lines that are not comments (a comment may legitimately cite the shape). */
function codeLines(source: string): Array<{ line: number; text: string }> {
	return source
		.split("\n")
		.map((text, index) => ({ line: index + 1, text }))
		.filter(({ text }) => {
			const trimmed = text.trim();
			return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
		});
}

describe("field-level truncation: no root-level payload probes", () => {
	it("no payload consumer asks the truncation question at the root", () => {
		const offenders: string[] = [];
		for (const file of PAYLOAD_CONSUMERS) {
			for (const { line, text } of codeLines(read(file))) {
				if (ROOT_PROBE.test(text)) offenders.push(`${file}:${line} → ${text.trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("guard self-check: the pattern matches the shape that caused the bug", () => {
		// The exact expression LazyDetailRenderer carried.
		expect(
			ROOT_PROBE.test(
				"return toolCall.inputJson?._truncated === true || toolCall.outputJson?._truncated === true;",
			),
		).toBe(true);
		// The cast variant SubagentCard carried.
		expect(
			ROOT_PROBE.test("(toolCall.outputJson as Record<string, unknown>)._truncated === true"),
		).toBe(true);
	});

	it("guard self-check: legitimate single-value leaf guards are NOT flagged", () => {
		expect(
			ROOT_PROBE.test("return val?._truncated === true && typeof val?.preview === 'string';"),
		).toBe(false);
		expect(ROOT_PROBE.test("(value as { _truncated?: unknown })._truncated === true")).toBe(false);
		expect(ROOT_PROBE.test("record._truncated === true")).toBe(false);
	});
});

/**
 * The POSITIVE half of the guard.
 *
 * The negative rule above only says nobody probes the root; it cannot say that the
 * "does this row need its full payload" decision is asked correctly at all. That
 * half used to be covered by two assertions naming `LazyDetailRenderer` and
 * `SubagentCard` — both deleted with the chunked renderer, and the assertions went
 * with them. What remained would stay green even if the vlist stopped asking the
 * question entirely, which is the same class of silent failure the file exists for
 * (the "load full content" affordance simply never appears).
 *
 * The vlist asks it through `truncatedLeafCount`, the measure layer's count of
 * truncated LEAVES — the field-level answer, derived once during measurement rather
 * than re-probed at paint time.
 */
describe("field-level truncation: the question IS asked, via the leaf count", () => {
	const SHELL = read("vlist/PretextExactMessageList.tsx");

	it("gates the full-payload fetch on truncatedLeafCount, for tool cards", () => {
		// `<= 0` (not `!truncated`): the count is the signal, and a card with zero
		// truncated leaves must not request a fetch.
		expect(SHELL).toMatch(/truncatedLeafCount\s*<=\s*0\s*\)\s*continue/);
	});

	it("folds the leaf count into the measure cache key", () => {
		// Without this the post-fetch card would keep hitting the pre-fetch entry and
		// the row would never repaint with the full payload — the count would stay above
		// zero forever, so the affordance would appear to do nothing.
		const cache = read("vlist/measure-cache.ts");
		expect(cache).toContain("truncatedLeafCount");
	});

	it("the recursive leaf probe is still the exported way to ask about a payload", () => {
		// `hasTruncatedLeaf` is the correct question for a raw payload (tool-display
		// uses it). If it disappeared, a future consumer would have nothing to reach for
		// but the root probe the rule above forbids.
		const projection = readFileSync(
			join(import.meta.dir, "..", "..", "..", "shared", "pretext-layout", "tool-io-projection.ts"),
			"utf8",
		);
		expect(projection).toMatch(/export function hasTruncatedLeaf\(/);
	});
});
