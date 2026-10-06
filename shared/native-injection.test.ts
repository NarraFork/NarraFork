import { describe, expect, it } from "bun:test";
import {
	coerceNativeInjectionBlock,
	contextBlockViews,
	injectionBlockViews,
	isNativeModelContextBlock,
	modelTextFromContentBlocks,
	type NativeInjectionBlock,
	normalizeLegacyInjectionBlock,
	normalizeNativeInjectionBlock,
} from "./native-injection";

describe("native injection block normalization", () => {
	const body = { kind: "prose", text: "hello" } as const;

	it("accepts and canonicalizes a native block with model text", () => {
		const input = {
			type: "system_injection" as const,
			source: "team_message",
			modelText: "model-facing copy",
			body,
		};
		const result = normalizeNativeInjectionBlock(input);
		expect(result).toEqual(input);
		expect(result).not.toBe(input);
	});

	it("normalizes supported legacy type spellings", () => {
		for (const type of ["sidecar", "side_car", "injection", "system-injection"]) {
			expect(normalizeLegacyInjectionBlock({ type, source: "legacy", body })).toEqual({
				type: "system_injection",
				source: "legacy",
				body,
			});
		}
	});

	it("accepts legacy body field aliases", () => {
		expect(normalizeNativeInjectionBlock({ type: "sidecar", source: "x", bodyJson: body })).toEqual(
			{
				type: "system_injection",
				source: "x",
				body,
			},
		);
		expect(
			normalizeNativeInjectionBlock({ type: "side_car", source: "x", sidecarBody: body }),
		).toEqual({
			type: "system_injection",
			source: "x",
			body,
		});
	});

	it("rejects malformed or unknown blocks", () => {
		for (const value of [
			null,
			{ type: "system_injection" },
			{ type: "system_injection", source: "x", body: { kind: "nope" } },
			{ type: "unknown", source: "x" },
		]) {
			expect(normalizeNativeInjectionBlock(value)).toBeUndefined();
		}
	});

	it("maps native and legacy physical blocks without swallowing arbitrary text", () => {
		const blocks = [
			{ type: "text", text: "model copy" },
			{ type: "system_injection", source: "bg_agent", body, modelText: "native copy" },
			{ type: "text", text: "unrelated" },
			{ type: "text", text: "legacy copy" },
			{ type: "system_injection", source: "team_message", body },
			{ type: "subagent_messages", messages: [] },
		];
		const views = injectionBlockViews(blocks);
		expect(views[0]?.sourceIndices).toEqual([1]);
		expect(views[1]?.sourceIndices).toEqual([3, 4]);
		expect(views[1]?.block.modelText).toBe("legacy copy");
		expect(views[1]?.sourceIndices).not.toContain(5);
	});

	it("keeps model projections in physical block order", () => {
		const blocks = [
			{ type: "text", text: "legacy text" },
			{ type: "system_injection", source: "native", modelText: "native text" },
		];
		expect(modelTextFromContentBlocks(blocks)).toBe("legacy text\nnative text");
		expect(isNativeModelContextBlock({ type: "merge_summary", modelText: "summary" })).toBe(true);
		expect(isNativeModelContextBlock({ type: "merge_summary" })).toBe(false);
	});

	it("maps direct structured cards without swallowing unrelated text", () => {
		const blocks = [
			{ type: "text", text: "card prompt" },
			{ type: "merge_summary", summary: "summary" },
			{ type: "text", text: "independent" },
		];
		const views = contextBlockViews(blocks);
		expect(views[0]?.sourceIndices).toEqual([0, 1]);
		expect(views[0]?.block.modelText).toBe("card prompt");
		expect(views).toHaveLength(1);
		const native = contextBlockViews([
			{ type: "merge_summary", modelText: "native summary", summary: "summary" },
		]);
		expect(native[0]?.sourceIndices).toEqual([0]);
		expect(native[0]?.block.modelText).toBe("native summary");
	});

	it("does not mutate input and exposes the coercion alias", () => {
		const input = { type: "sidecar", source: "x" };
		const result: NativeInjectionBlock | undefined = coerceNativeInjectionBlock(input);
		expect(result).toEqual({ type: "system_injection", source: "x" });
		expect(input).toEqual({ type: "sidecar", source: "x" });
	});
});
