import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyZstdPatchToFile, generateZstdPatch, type ZstdPatchMeta } from "../zstd-patch";

/**
 * The server applies patches file-to-file so a ~100MB binary never becomes synchronous work on
 * the request thread. These tests cover that path: success, the guards that must reject a bad
 * payload, and cancellation.
 */
describe("file-based zstd patch application", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "nf-zstd-file-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function makeBinaries(): { oldPath: string; newBytes: Buffer; meta: ZstdPatchMeta } {
		// Compressible content with a divergent tail, close to how a real binary patches.
		const head = Buffer.alloc(256 * 1024, 0xab);
		const oldBytes = Buffer.concat([head, Buffer.alloc(32 * 1024, 0x01)]);
		const newBytes = Buffer.concat([head, Buffer.alloc(48 * 1024, 0x02)]);
		const oldPath = join(dir, "old.bin");
		writeFileSync(oldPath, oldBytes);
		const { patch, meta } = generateZstdPatch(oldBytes, newBytes, {
			fromVersion: "1.0.0",
			toVersion: "1.1.0",
		});
		writeFileSync(join(dir, "patch.zst"), patch);
		return { oldPath, newBytes, meta };
	}

	test("reconstructs the new binary and reports its verified digest", async () => {
		const { oldPath, newBytes, meta } = makeBinaries();
		const outputPath = join(dir, "out.bin");

		const result = await applyZstdPatchToFile({
			oldFilePath: oldPath,
			patchFilePath: join(dir, "patch.zst"),
			outputFilePath: outputPath,
			meta,
			maxOutputBytes: 16 * 1024 * 1024,
		});

		expect(result.sizeBytes).toBe(newBytes.length);
		expect(result.sha512).toBe(meta.newFileSha512);
		expect(Buffer.compare(readFileSync(outputPath), newBytes)).toBe(0);
	});

	test("refuses a target larger than the caller's byte ceiling before doing any work", async () => {
		const { oldPath, meta } = makeBinaries();
		await expect(
			applyZstdPatchToFile({
				oldFilePath: oldPath,
				patchFilePath: join(dir, "patch.zst"),
				outputFilePath: join(dir, "out.bin"),
				meta,
				maxOutputBytes: 1024,
			}),
		).rejects.toThrow(/exceeds the 1024-byte limit/);
	});

	test("rejects a size mismatch between the produced file and the declared metadata", async () => {
		const { oldPath, meta } = makeBinaries();
		await expect(
			applyZstdPatchToFile({
				oldFilePath: oldPath,
				patchFilePath: join(dir, "patch.zst"),
				outputFilePath: join(dir, "out.bin"),
				meta: { ...meta, newFileSize: meta.newFileSize + 1 },
			}),
		).rejects.toThrow(/file size mismatch/);
	});

	test("rejects a digest mismatch so a tampered payload is never placed", async () => {
		const { oldPath, meta } = makeBinaries();
		await expect(
			applyZstdPatchToFile({
				oldFilePath: oldPath,
				patchFilePath: join(dir, "patch.zst"),
				outputFilePath: join(dir, "out.bin"),
				meta: { ...meta, newFileSha512: Buffer.alloc(64, 9).toString("base64") },
			}),
		).rejects.toThrow(/SHA512 mismatch/);
	});

	test("an aborted signal stops the work instead of running to completion", async () => {
		const { oldPath, meta } = makeBinaries();
		const controller = new AbortController();
		controller.abort();

		await expect(
			applyZstdPatchToFile({
				oldFilePath: oldPath,
				patchFilePath: join(dir, "patch.zst"),
				outputFilePath: join(dir, "out.bin"),
				meta,
				signal: controller.signal,
			}),
		).rejects.toThrow();
	});

	test("surfaces a bounded diagnostic when the CLI cannot read its inputs", async () => {
		const { meta } = makeBinaries();
		await expect(
			applyZstdPatchToFile({
				oldFilePath: join(dir, "missing-old.bin"),
				patchFilePath: join(dir, "missing-patch.zst"),
				outputFilePath: join(dir, "out.bin"),
				meta,
			}),
		).rejects.toThrow(/zstd CLI decompression failed/);
	});
});
