import { describe, expect, it, spyOn } from "bun:test";
import { sha256 as nobleSHA256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	copyStreamingEditInput,
	createStreamingEditOrigin,
	fingerprintStreamingEditOld,
	handoffStreamingEditOrigin,
	readStreamingEditOrigin,
	STREAMING_EDIT_ORIGIN_MAX_CODE_UNITS,
	validateStreamingEditOrigin,
} from "./streaming-edit-origin";

const input = {
	file_path: "/a.ts",
	old_string: `head\n${"same-tail".repeat(2500)}`,
	new_string: "new",
};
const metadata = { startLine: 42, endLine: 43, matchStatus: "matched" };
const origin = createStreamingEditOrigin("edit", input, metadata);
if (!origin) throw new Error("missing fixture origin");

describe("streaming Edit origin fingerprint", () => {
	it("matches UTF16LE including surrogate halves and scratch-boundary CRLF", () => {
		for (const text of ["abc", "\ud800\udc00\ud800\r\nx\rz", `${"x".repeat(4095)}\r\ny`]) {
			const normalized = text.replaceAll("\r\n", "\n");
			expect(fingerprintStreamingEditOld(text)).toBe(
				bytesToHex(nobleSHA256(Buffer.from(normalized, "utf16le"))),
			);
		}
		expect(fingerprintStreamingEditOld("a\r\nb")).toBe(fingerprintStreamingEditOld("a\nb"));
		expect(fingerprintStreamingEditOld("a\rb")).not.toBe(fingerprintStreamingEditOld("a\nb"));
	});
	it("checks the ORIGINAL code-unit budget, not normalized length or UTF8 bytes", () => {
		const max = STREAMING_EDIT_ORIGIN_MAX_CODE_UNITS;
		expect(fingerprintStreamingEditOld("界".repeat(max))).toHaveLength(64);
		expect(fingerprintStreamingEditOld("\r\n".repeat(max / 2))).toHaveLength(64);
		expect(fingerprintStreamingEditOld(`${"\r\n".repeat(max / 2)}x`)).toBeUndefined();
		expect(
			createStreamingEditOrigin("edit", { ...input, old_string: "x".repeat(max + 1) }, metadata),
		).toBeUndefined();
		expect(
			validateStreamingEditOrigin(origin, "edit", { ...input, old_string: "x".repeat(max + 1) }),
		).toBeUndefined();
	});
	it("binds full text, tool id, path, device and replace_all", () => {
		expect(validateStreamingEditOrigin(origin, "edit", input)).toBe(origin);
		for (const changed of [
			{ ...input, old_string: `HEAD\n${input.old_string.slice(5)}` },
			{ ...input, file_path: "/b.ts" },
			{ ...input, device: "remote" },
			{ ...input, replace_all: true },
		])
			expect(validateStreamingEditOrigin(origin, "edit", changed)).toBeUndefined();
		expect(validateStreamingEditOrigin(origin, "another", input)).toBeUndefined();
		expect(
			validateStreamingEditOrigin(origin, "edit", {
				...input,
				old_string: input.old_string.replaceAll("\n", "\r\n"),
			}),
		).toBe(origin);
		expect(createStreamingEditOrigin("edit", input, metadata, "remote")).toBeUndefined();
	});
	it("rejects unmatched and illegal start/end line evidence", () => {
		for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "42"]) {
			expect(readStreamingEditOrigin({ ...origin, startLine: bad })).toBeUndefined();
		}
		for (const bad of [0, -1, 41, 42.5, Infinity]) {
			expect(readStreamingEditOrigin({ ...origin, endLine: bad })).toBeUndefined();
		}
		expect(readStreamingEditOrigin({ ...origin, matchStatus: "unmatched" })).toBeUndefined();
	});
	it("hashes once at handoff, shares validation across adapters, never trusts input metadata", () => {
		const spy = spyOn(nobleSHA256, "create");
		try {
			const raw = {
				...input,
				_streamingMetadata: { startLine: 999 },
				_streamingEditOrigin: origin,
			};
			const started = handoffStreamingEditOrigin("edit", raw, origin) as Record<string, unknown>;
			expect(started._streamingMetadata).toMatchObject({ startLine: 42 });
			expect(handoffStreamingEditOrigin("edit", raw, origin)).toBe(started);
			const rendered = copyStreamingEditInput(started, { _streamingFieldRanges: {} });
			expect(handoffStreamingEditOrigin("edit", rendered)).toBe(rendered);
			for (const changed of [{ device: "remote" }, { _streamingMetadata: { startLine: 999 } }]) {
				const late = copyStreamingEditInput(started, changed);
				expect(handoffStreamingEditOrigin("edit", late, undefined, started)).not.toHaveProperty(
					"_streamingMetadata",
				);
			}
			expect(spy).toHaveBeenCalledTimes(1);
			const updated = { ...input, old_string: "other" };
			const invalid = handoffStreamingEditOrigin("edit", updated, undefined, started);
			expect(invalid).not.toHaveProperty("_streamingMetadata");
			expect(handoffStreamingEditOrigin("edit", updated, undefined, started)).toBe(invalid);
			expect(spy).toHaveBeenCalledTimes(2);
			const rejected = handoffStreamingEditOrigin(
				"edit",
				{ ...input },
				{ ...origin, startLine: 0 },
				started,
			);
			expect(handoffStreamingEditOrigin("edit", rejected, undefined, started)).not.toHaveProperty(
				"_streamingMetadata",
			);
			expect(handoffStreamingEditOrigin("edit", raw)).not.toHaveProperty("_streamingMetadata");
			expect(handoffStreamingEditOrigin("edit", raw)).not.toHaveProperty("_streamingEditOrigin");
		} finally {
			spy.mockRestore();
		}
	});
});
