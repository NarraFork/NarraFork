import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type BinaryLike, createHash, type Encoding, type Hash } from "node:crypto";
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

	test("legacy decompression bounds native output before checking the reconstructed file", async () => {
		const oldPath = join(dir, "old.bin");
		writeFileSync(oldPath, Buffer.alloc(128));
		const patchFilePath = join(dir, "oversized.zst");
		const patch = Bun.zstdCompressSync(Buffer.alloc(4096));
		writeFileSync(patchFilePath, patch);
		await expect(
			applyZstdPatchToFile({
				oldFilePath: oldPath,
				patchFilePath,
				outputFilePath: join(dir, "out.bin"),
				meta: {
					fromVersion: "1.0.0",
					toVersion: "1.1.0",
					stableEnd: 0,
					newTailSize: 8,
					patchSize: patch.length,
					newFileSize: 8,
					newFileSha512: "unused",
					mode: "dictionary",
				},
			}),
		).rejects.toThrow(/larger than 8 bytes/);
	});
	test("legacy empty tail remains valid under the native output ceiling", async () => {
		const bytes = Buffer.alloc(8, 7);
		const oldFilePath = join(dir, "old.bin");
		writeFileSync(oldFilePath, bytes);
		const patch = Bun.zstdCompressSync(Buffer.alloc(0));
		const patchFilePath = join(dir, "empty.zst");
		writeFileSync(patchFilePath, patch);
		const result = await applyZstdPatchToFile({
			oldFilePath,
			patchFilePath,
			outputFilePath: join(dir, "out.bin"),
			meta: {
				fromVersion: "1.0.0",
				toVersion: "1.1.0",
				stableEnd: bytes.length,
				newTailSize: 0,
				patchSize: patch.length,
				newFileSize: bytes.length,
				newFileSha512: createHash("sha512").update(bytes).digest("base64"),
				mode: "dictionary",
			},
		});
		expect(result.sizeBytes).toBe(bytes.length);
	});
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

	test("CLI decompression stops before its output can exceed the declared binary size", async () => {
		const { oldPath, meta } = makeBinaries();
		const outputFilePath = join(dir, "bounded.bin");
		await expect(
			applyZstdPatchToFile({
				oldFilePath: oldPath,
				patchFilePath: join(dir, "patch.zst"),
				outputFilePath,
				meta: { ...meta, newFileSize: 8, newTailSize: 8, stableEnd: 0, mode: "patch-from" },
				maxOutputBytes: 16 * 1024 * 1024,
			}),
		).rejects.toThrow(/exceeds the 8-byte limit/);
		expect(readFileSync(outputFilePath).length).toBeLessThanOrEqual(8);
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

	test.each([
		"user cancel",
		"overall deadline",
	])("stops reading during reconstructed-file hashing: %s", async (reason) => {
		const { oldPath, meta } = makeBinaries();
		const controller = new AbortController();
		const prototype = Object.getPrototypeOf(createHash("sha512")) as Hash;
		const originalUpdate = prototype.update;
		let chunksHashed = 0;
		const update = spyOn(prototype, "update").mockImplementation(function (
			this: Hash,
			data: BinaryLike,
			inputEncoding?: Encoding,
		) {
			chunksHashed++;
			if (chunksHashed === 1)
				controller.abort(
					new DOMException(reason, reason === "overall deadline" ? "TimeoutError" : "AbortError"),
				);
			return Reflect.apply(
				originalUpdate,
				this,
				inputEncoding === undefined ? [data] : [data, inputEncoding],
			) as Hash;
		});
		try {
			await expect(
				applyZstdPatchToFile({
					oldFilePath: oldPath,
					patchFilePath: join(dir, "patch.zst"),
					outputFilePath: join(dir, "hash-cancelled.bin"),
					meta,
					signal: controller.signal,
					maxOutputBytes: 16 * 1024 * 1024,
				}),
			).rejects.toThrow();
			expect(controller.signal.aborted).toBe(true);
			// The fixture spans several stream chunks: the former signal-less hash read all of them.
			expect(chunksHashed).toBe(1);
		} finally {
			update.mockRestore();
		}
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
