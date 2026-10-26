import { describe, expect, spyOn, test } from "bun:test";
import {
	composeReasoningTranslation,
	getValidReasoningTranslationParts,
	isReasoningTranslationBoundary,
	isReasoningTranslationId,
	MAX_REASONING_TRANSLATION_ID_LENGTH,
	MAX_REASONING_TRANSLATION_OUTPUT_BYTES,
	MAX_REASONING_TRANSLATION_SOURCE_BYTES,
	mergeReasoningTranslationParts,
	type ReasoningTranslationPart,
	readReasoningTranslationPatch,
} from "./reasoning-translation";

const part = (
	start: number,
	sourceText: string,
	translatedText = "译文",
	id = `p${start}`,
): ReasoningTranslationPart => ({
	id,
	generation: "g1",
	start,
	end: start + sourceText.length,
	sourceText,
	translatedText,
});

describe("reasoning translation source ranges", () => {
	test("bounds part IDs and generations by 256 UTF-16 code units, not UTF-8 bytes", () => {
		const generation = "界".repeat(MAX_REASONING_TRANSLATION_ID_LENGTH);
		const id = "😀".repeat(MAX_REASONING_TRANSLATION_ID_LENGTH / 2);
		const valid = { ...part(0, "a", "译", id), generation };
		expect(id.length).toBe(256);
		expect(new TextEncoder().encode(generation).byteLength).toBeGreaterThan(256);
		expect(isReasoningTranslationId(id)).toBe(true);
		expect(isReasoningTranslationId(generation)).toBe(true);
		expect(getValidReasoningTranslationParts("a", generation, [valid])).toEqual([valid]);
		for (const invalid of ["", "x".repeat(257), `${generation}x`, `${id}x`]) {
			expect(isReasoningTranslationId(invalid)).toBe(false);
			expect(
				getValidReasoningTranslationParts("a", generation, [{ ...valid, id: invalid }]),
			).toEqual([]);
			expect(
				getValidReasoningTranslationParts("a", invalid, [{ ...valid, generation: invalid }]),
			).toEqual([]);
		}
		expect(isReasoningTranslationId(null)).toBe(false);
	});

	test("rejects huge identities and oversized text lengths before UTF-8 encoding", () => {
		const huge = "x".repeat(32 * 1024 * 1024);
		const encode = spyOn(TextEncoder.prototype, "encode").mockImplementation(() => {
			throw new Error("oversized input reached UTF-8 encoder");
		});
		try {
			expect(getValidReasoningTranslationParts("a", "g1", [part(0, "a", "译", huge)])).toEqual([]);
			expect(
				getValidReasoningTranslationParts("a", huge, [{ ...part(0, "a"), generation: huge }]),
			).toEqual([]);
			const oversizedSource = "a".repeat(MAX_REASONING_TRANSLATION_SOURCE_BYTES + 1);
			expect(
				getValidReasoningTranslationParts(oversizedSource, "g1", [part(0, oversizedSource)]),
			).toEqual([]);
			expect(
				getValidReasoningTranslationParts("a", "g1", [
					part(0, "a", "a".repeat(MAX_REASONING_TRANSLATION_OUTPUT_BYTES + 1)),
				]),
			).toEqual([]);
			expect(encode).not.toHaveBeenCalled();
		} finally {
			encode.mockRestore();
		}
	});

	test("keeps UTF-16 half-open coordinates without splitting surrogate pairs", () => {
		const text = "A😀B";
		expect(isReasoningTranslationBoundary(text, 2)).toBe(false);
		expect(getValidReasoningTranslationParts(text, "g1", [part(1, "😀")])).toHaveLength(1);
		expect(getValidReasoningTranslationParts(text, "g1", [part(1, "\ud83d")])).toEqual([]);
		expect(isReasoningTranslationBoundary(text, 1.5)).toBe(false);
	});

	test("validates exact source, generation, identities and non-overlap", () => {
		const first = part(0, "abc");
		const second = part(3, "def");
		expect(
			getValidReasoningTranslationParts("abcdef", "g1", [
				second,
				first,
				part(1, "bc"),
				part(3, "def", "重复", first.id),
				{ ...second, sourceText: "wrong" },
				{ ...second, generation: "old" },
			]),
		).toEqual([first, second]);
	});

	test("enforces UTF-8 bytes independently of UTF-16 string lengths", () => {
		const source = "界".repeat(5462);
		expect(source.length).toBeLessThan(16 * 1024);
		expect(getValidReasoningTranslationParts(source, "g1", [part(0, source)])).toEqual([]);
		expect(
			getValidReasoningTranslationParts("a", "g1", [part(0, "a", "界".repeat(21846))]),
		).toEqual([]);
		expect(getValidReasoningTranslationParts("a", "g1", [part(0, "a", " ")])).toEqual([]);
	});

	test("composes completed fragments while retaining source whitespace, gaps and live tail", () => {
		const text = "  one\n\n two\n\n tail";
		expect(
			composeReasoningTranslation(text, "g1", [part(0, "  one\n\n", " 一 "), part(8, "two", "二")]),
		).toBe("  一\n\n 二\n\n tail");
		expect(composeReasoningTranslation(text, "old", [part(0, "  one\n\n")])).toBe(text);
	});

	test("merges independent parts idempotently and never replaces an accepted ID or range", () => {
		const first = part(0, "abc");
		const second = part(3, "def");
		const accepted = mergeReasoningTranslationParts("abcdef", "g1", [second], [first]);
		expect(accepted).toEqual([first, second]);
		expect(
			mergeReasoningTranslationParts("abcdef", "g1", accepted, [
				{ ...first, translatedText: "冲突" },
				part(1, "bc"),
			]),
		).toEqual(accepted);
	});

	test("normalizes patch parts without enumerating extra fields and shares the identity bound", () => {
		const input = part(0, "a");
		Object.defineProperty(input, "extra", {
			enumerable: true,
			get: () => {
				throw new Error("extra transport field was read");
			},
		});
		const patch = {
			narratorId: "view",
			ownerNarratorId: "owner",
			messageId: "m",
			blockId: "b",
			elementId: "e",
			blockRevision: 2,
			stateRevision: 9,
			translationGeneration: "g1",
			part: input,
		};
		const decoded = readReasoningTranslationPatch(patch);
		expect(decoded?.part).toEqual(part(0, "a"));
		expect(decoded?.part).not.toBe(input);
		expect(Object.keys(decoded?.part ?? {})).toEqual([
			"id",
			"generation",
			"start",
			"end",
			"sourceText",
			"translatedText",
		]);
		const generation = "界".repeat(MAX_REASONING_TRANSLATION_ID_LENGTH);
		const id = "😀".repeat(MAX_REASONING_TRANSLATION_ID_LENGTH / 2);
		expect(
			readReasoningTranslationPatch({
				...patch,
				translationGeneration: generation,
				part: { ...part(0, "a", "译", id), generation },
			}),
		).not.toBeNull();
		expect(
			readReasoningTranslationPatch({ ...patch, part: part(0, "a", "译", "x".repeat(257)) }),
		).toBeNull();
		expect(
			readReasoningTranslationPatch({
				...patch,
				translationGeneration: `${generation}x`,
				part: { ...part(0, "a"), generation: `${generation}x` },
			}),
		).toBeNull();
		expect(readReasoningTranslationPatch({ ...patch, elementId: "x".repeat(257) })).toBeNull();
		expect(
			readReasoningTranslationPatch({ ...patch, parentToolUseId: "x".repeat(257) }),
		).toBeNull();
	});

	test("decodes only complete bounded patch envelopes with independent body/state versions", () => {
		const patch = {
			narratorId: "view",
			ownerNarratorId: "owner",
			messageId: "m",
			blockId: "persistent-b",
			elementId: "element",
			blockRevision: 2,
			stateRevision: 9,
			translationGeneration: "g1",
			part: part(3, "def"),
		};
		expect(readReasoningTranslationPatch(patch)).toEqual(patch);
		expect(readReasoningTranslationPatch({ ...patch, blockRevision: 1.5 })).toBeNull();
		expect(readReasoningTranslationPatch({ ...patch, stateRevision: -1 })).toBeNull();
		expect(readReasoningTranslationPatch({ ...patch, translationGeneration: "other" })).toBeNull();
		expect(readReasoningTranslationPatch({ ...patch, elementId: undefined })).toBeNull();
	});
});
