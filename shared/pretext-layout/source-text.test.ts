import { describe, expect, it } from "bun:test";
import {
	appendSourceText,
	createSourceText,
	isSourceTextRange,
	nextSourceEpoch,
	normalizeSourceText,
	reconcileSourceText,
	safeSourceSliceStart,
	trimSourceText,
} from "./source-text";

const position = (text: string) => {
	const normalized = normalizeSourceText(text);
	const lines = normalized.split("\n");
	return { offset: normalized.length, line: lines.length - 1, column: lines.at(-1)?.length ?? 0 };
};

describe("bounded source coordinates", () => {
	it("keeps normalized offsets, lines and partial-first-line columns across chunk boundaries", () => {
		const text = "alpha\r\nbeta😀long\rgamma\n尾部\r\nlast";
		for (const size of [1, 2, 7, 31]) {
			for (const limit of [1, 4, 16, 16_000]) {
				let source = createSourceText("", { epoch: "stream", originKnown: false });
				let received = "";
				for (let offset = 0; offset < text.length; offset += size) {
					const delta = text.slice(offset, offset + size);
					received += delta;
					source = appendSourceText(source, delta, limit);
					const normalized = normalizeSourceText(received);
					const retained = normalizeSourceText(source.text);
					const start = normalized.length - retained.length;
					const first = position(normalized.slice(0, start));
					const end = position(received);
					expect(source.text.length).toBeLessThanOrEqual(limit);
					expect(normalized.endsWith(retained)).toBe(true);
					expect(source.range).toMatchObject({
						epoch: "stream",
						originKnown: false,
						startOffset: start,
						startLine: first.line,
						startColumn: first.column,
						endOffset: end.offset,
						endLine: end.line,
						endColumn: end.column,
					});
				}
			}
		}
	});

	it("advances a 16k tail's first column without changing that line's identity", () => {
		const start = createSourceText("a".repeat(15_999), { epoch: "edit" });
		const source = appendSourceText(start, "bcdef", 16_000);
		expect(source.text).toHaveLength(16_000);
		expect(source.range).toMatchObject({
			epoch: "edit",
			startOffset: 4,
			startLine: 0,
			startColumn: 4,
			endColumn: 16_004,
		});
		expect(start.range.startOffset).toBe(0);
	});

	it("counts a CR/LF arriving in separate chunks as one normalized newline", () => {
		const first = appendSourceText(createSourceText("a", { epoch: "e" }), "\r", 16_000);
		const second = appendSourceText(first, "\nb", 16_000);
		expect(first.range).toMatchObject({ endOffset: 2, endLine: 1, endColumn: 0 });
		expect(second.text).toBe("a\r\nb");
		expect(second.range).toMatchObject({ epoch: "e", endOffset: 3, endLine: 1, endColumn: 1 });
	});

	it("never starts a retained window inside CRLF or a surrogate pair", () => {
		expect(safeSourceSliceStart("a\r\nb", 2)).toBe(3);
		expect(safeSourceSliceStart("a😀b", 2)).toBe(3);
		expect(trimSourceText(createSourceText("a😀b", { epoch: "e" }), 2).text).toBe("b");
		expect(trimSourceText(createSourceText("a\r\nb", { epoch: "e" }), 2).text).toBe("b");
	});
});

describe("complete-source verification", () => {
	it("keeps a known epoch through eviction and exact-position full completion", () => {
		const full = "head\r\nabcdef\r\ntail";
		const preview = createSourceText(full, { epoch: "known", limit: 8 });
		const complete = reconcileSourceText(preview, `${full}!`, { epoch: "unused" });
		expect(preview.range.startOffset).toBeGreaterThan(0);
		expect(complete.text).toBe(`${full}!`);
		expect(complete.range).toMatchObject({
			epoch: "known",
			startOffset: 0,
			originKnown: true,
			complete: true,
		});
		expect(complete.range.remap).toBeUndefined();
	});

	it("translates an unknown observed tail, including its first line's column", () => {
		const preview = createSourceText("XYZ\r\ntail", { epoch: "unknown", originKnown: false });
		const complete = reconcileSourceText(preview, "header\nabcXYZ\ntail", { epoch: "unused" });
		expect(complete.range.epoch).not.toBe(preview.range.epoch);
		expect(complete.range.remap).toEqual({
			fromEpoch: "unknown",
			fromStartOffset: 0,
			fromEndOffset: 8,
			fromStartLine: 0,
			offsetDelta: 10,
			lineDelta: 1,
			columnDelta: 3,
		});
		const repeated = reconcileSourceText(complete, complete.text, { epoch: "unused" });
		expect(repeated.range).toEqual(complete.range);
	});

	it("only confirms the entire suffix, not a repeated matching line in the middle", () => {
		const preview = createSourceText("same\ntail", { epoch: "e", originKnown: false });
		const middle = reconcileSourceText(preview, "same\ntail\nother", { epoch: "unused" });
		expect(middle.range.epoch).not.toBe("e");
		expect(middle.range.remap).toBeUndefined();
		const suffix = reconcileSourceText(preview, "same\ntail\nsame\ntail", { epoch: "unused" });
		expect(suffix.range.remap?.offsetDelta).toBe(10);
		expect(suffix.range.remap?.lineDelta).toBe(2);
	});

	it("never silently shifts a known-position mismatch or an empty unknown preview", () => {
		const known = createSourceText("abc", { epoch: "e" });
		expect(
			reconcileSourceText(known, "prefixabc", { epoch: "unused" }).range.remap,
		).toBeUndefined();
		const empty = createSourceText("", { epoch: "e", originKnown: false });
		expect(reconcileSourceText(empty, "abc", { epoch: "unused" }).range).toMatchObject({
			epoch: "e:v1",
			originKnown: true,
		});
	});

	it("bounds epoch representation and validates metadata before consuming it", () => {
		let epoch = "tool:field";
		for (let i = 0; i < 1_000; i++) epoch = nextSourceEpoch(epoch);
		expect(epoch).toBe("tool:field:v1000");
		expect(isSourceTextRange(createSourceText("a", { epoch }).range)).toBe(true);
		expect(isSourceTextRange({ epoch, startOffset: 0 })).toBe(false);
		expect(isSourceTextRange({ ...createSourceText("a", { epoch }).range, endOffset: -1 })).toBe(
			false,
		);
	});
});
