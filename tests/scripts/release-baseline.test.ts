import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeFileIdentity,
	findPreviousVersionBinary,
	getBaselineMismatch,
	requirePublishedBaseline,
	selectPublishedBaseline,
} from "../../server/lib/release-baseline";
import { applyZstdPatch, generateZstdPatch } from "../../server/lib/zstd-patch";

describe("release baseline integrity", () => {
	test("selects the newest lower platform-specific version", () => {
		const directory = mkdtempSync(join(tmpdir(), "nf-release-baseline-"));
		try {
			for (const version of ["0.5.8", "0.5.9", "0.5.10"]) {
				writeFileSync(join(directory, `narrafork-${version}-linux-x64`), version);
			}
			writeFileSync(join(directory, "narrafork-0.5.10-linux-x64-baseline"), "other");

			const previous = findPreviousVersionBinary(directory, "narrafork-0.5.11-linux-x64", "0.5.11");
			expect(previous?.version).toBe("0.5.10");
			expect(previous?.path.endsWith("narrafork-0.5.10-linux-x64")).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("returns null when the dist path is missing or is not a directory", () => {
		const directory = mkdtempSync(join(tmpdir(), "nf-release-baseline-missing-"));
		try {
			const missing = join(directory, "missing");
			const filePath = join(directory, "not-a-directory");
			writeFileSync(filePath, "binary");

			expect(findPreviousVersionBinary(missing, "narrafork-0.5.11-linux-x64", "0.5.11")).toBeNull();
			expect(
				findPreviousVersionBinary(filePath, "narrafork-0.5.11-linux-x64", "0.5.11"),
			).toBeNull();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("selects the highest stable or beta baseline strictly below the target", () => {
		const selected = selectPublishedBaseline("0.5.11", [
			{
				version: "0.5.9",
				channel: "beta",
				file: { filename: "narrafork-0.5.9-linux-x64", size: 9, sha512: "beta" },
			},
			{
				version: "0.5.10",
				channel: "stable",
				file: { filename: "narrafork-0.5.10-linux-x64", size: 10, sha512: "stable" },
			},
			{
				version: "0.5.11",
				channel: "beta",
				file: { filename: "narrafork-0.5.11-linux-x64", size: 11, sha512: "target" },
			},
		]);
		expect(selected?.version).toBe("0.5.10");
	});

	test("rejects a local older guess when the exact published baseline is missing", () => {
		const published = [
			{
				version: "0.5.10",
				channel: "stable" as const,
				file: { filename: "narrafork-0.5.10-linux-x64", size: 10, sha512: "published" },
			},
		];
		expect(() =>
			requirePublishedBaseline("0.5.11", "narrafork-0.5.11-linux-x64", published, [
				"narrafork-0.5.9-linux-x64",
			]),
		).toThrow(/0\.5\.10.*missing from dist/i);
		expect(
			requirePublishedBaseline("0.5.11", "narrafork-0.5.11-linux-x64", published, [
				"narrafork-0.5.10-linux-x64",
			]),
		).toEqual(published[0]);
	});

	test("allows a fresh checkout when neither online channel has a platform baseline", () => {
		expect(requirePublishedBaseline("0.5.11", "narrafork-0.5.11-linux-x64", [], [])).toBeNull();
	});

	test("reports when a local baseline differs from the published identity", () => {
		const directory = mkdtempSync(join(tmpdir(), "nf-release-identity-"));
		try {
			const filePath = join(directory, "baseline");
			writeFileSync(filePath, "overwritten");
			const actual = computeFileIdentity(filePath);
			const mismatch = getBaselineMismatch(actual, {
				filename: "narrafork-0.5.10-linux-x64",
				size: 8,
				sha512: createHash("sha512").update("published").digest("base64"),
			});
			expect(mismatch).toContain("expected size");
			expect(mismatch).toContain("actual sha512");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("records the source identity in new patches and replays successfully", () => {
		const oldBuffer = Buffer.from("published-source-binary".repeat(4096));
		const newBuffer = Buffer.from("new-target-binary".repeat(4096));
		const { patch, meta } = generateZstdPatch(oldBuffer, newBuffer, {
			fromVersion: "0.5.10",
			toVersion: "0.5.11",
		});

		expect(meta.oldFileSize).toBe(oldBuffer.length);
		expect(meta.oldFileSha512).toBe(createHash("sha512").update(oldBuffer).digest("base64"));
		expect(applyZstdPatch(oldBuffer, patch, meta)).toEqual(newBuffer);
	});
});
