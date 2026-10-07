import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	MAX_RELEASE_BINARY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	parseReleasePatchName,
	validateReleasePatchMetadata,
} from "./release-patch";

const sha512 = (value: string) => createHash("sha512").update(value).digest("base64");
const metadata = {
	fromVersion: "1.0.0",
	toVersion: "1.1.0",
	oldFileSize: 128,
	oldFileSha512: sha512("old"),
	newFileSize: 256,
	newFileSha512: sha512("new"),
	stableEnd: 64,
	newTailSize: 192,
	patchSize: 8,
	mode: "patch-from" as const,
};
const binary = "narrafork-1.1.0-linux-x64-baseline";

describe("CI zstd patch asset contract", () => {
	test("recognizes current build and multibase filenames without guessing base versions", () => {
		expect(parseReleasePatchName(binary, `${binary}.zstd-patch`)).toEqual({});
		expect(parseReleasePatchName(binary, `${binary}.from-1.0.0.zstd-patch`)).toEqual({
			fromVersion: "1.0.0",
		});
		expect(parseReleasePatchName(binary, `${binary}.from-1.0.0-beta.10.zstd-patch`)).toEqual({
			fromVersion: "1.0.0-beta.10",
		});
	});
	test.each([
		`${binary}.from-01.0.0.zstd-patch`,
		`${binary}.from-../evil.zstd-patch`,
		`${binary}.from-1.0.0.zstd-patch.meta.json`,
		`${binary}.zstd-patch.meta.json`,
		"narrafork-1.1.0-linux-x64.zstd-patch",
		`${binary}.from-1.0.0-beta.01.zstd-patch`,
	])("ignores non-matching or unsafe filename %s", (filename) => {
		expect(parseReleasePatchName(binary, filename)).toBeNull();
	});
	test("validates existing zstd metadata and returns only known fields", () => {
		expect(
			validateReleasePatchMetadata({ ...metadata, url: "https://evil.example/patch" }),
		).toEqual(metadata);
		expect(validateReleasePatchMetadata({ ...metadata, mode: undefined }).mode).toBeUndefined();
		expect(validateReleasePatchMetadata({ ...metadata, mode: "dictionary" }).mode).toBe(
			"dictionary",
		);
	});
	test.each([
		{ fromVersion: "1.1.0" },
		{ fromVersion: "2.0.0" },
		{ toVersion: "bad" },
		{ oldFileSize: 0 },
		{ oldFileSize: -1 },
		{ oldFileSize: MAX_RELEASE_BINARY_BYTES + 1 },
		{ newFileSize: Number.POSITIVE_INFINITY },
		{ newFileSize: 1.5 },
		{ newFileSize: MAX_RELEASE_BINARY_BYTES + 1 },
		{ patchSize: 0 },
		{ patchSize: MAX_RELEASE_PATCH_BYTES + 1 },
		{ patchSize: "8" },
		{ oldFileSha512: undefined },
		{ oldFileSha512: "bad" },
		{ newFileSha512: "bad" },
		{ stableEnd: -1 },
		{ stableEnd: 129 },
		{ stableEnd: 0.5 },
		{ newTailSize: -1 },
		{ newTailSize: 193 },
		{ mode: "unexpected" },
	])("rejects invalid patch field %j", (change) => {
		expect(() => validateReleasePatchMetadata({ ...metadata, ...change })).toThrow();
	});
	test.each([
		{ fromVersion: "1.0.1" },
		{ toVersion: "1.2.0" },
		{ patchSize: 9 },
		{ newFileSize: 257 },
		{ newFileSha512: sha512("different") },
	])("rejects sidecar that contradicts its release identity %j", (expected) => {
		expect(() => validateReleasePatchMetadata(metadata, expected)).toThrow("asset identity");
	});
	test("public metadata cannot trigger unbounded numeric SemVer parsing", () => {
		expect(() =>
			validateReleasePatchMetadata({ ...metadata, fromVersion: `${"9".repeat(129)}.0.0` }),
		).toThrow();
		expect(
			parseReleasePatchName(binary, `${binary}.from-${"9".repeat(129)}.0.0.zstd-patch`),
		).toBeNull();
	});
	test("allows a zero tail and retains maximum safe sizes", () => {
		const value = {
			...metadata,
			oldFileSize: MAX_RELEASE_BINARY_BYTES,
			newFileSize: MAX_RELEASE_BINARY_BYTES,
			stableEnd: MAX_RELEASE_BINARY_BYTES,
			newTailSize: 0,
			patchSize: MAX_RELEASE_PATCH_BYTES,
		};
		expect(validateReleasePatchMetadata(value).newTailSize).toBe(0);
	});
	for (const value of [null, [], "metadata", 1]) {
		test(`rejects non-object metadata ${JSON.stringify(value)}`, () => {
			expect(() => validateReleasePatchMetadata(value)).toThrow("object");
		});
	}
});
