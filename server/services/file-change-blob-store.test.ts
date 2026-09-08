import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmod,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { FILE_CHANGE_LIMITS, type FileChangeBlobRef } from "@shared/file-change-protocol";
import {
	type FileChangeBlobLease,
	type FileChangeBlobRelease,
	type FileChangeBlobSource,
	FileChangeBlobStore,
	FileChangeBlobStoreError,
} from "./file-change-blob-store";

let sandbox: string;
let root: string;
let store: FileChangeBlobStore;

beforeEach(async () => {
	if (process.env.NARRAFORK_TEST !== "1")
		throw new Error("Run with the repository's isolated bunfig preload");
	sandbox = await mkdtemp(join(await realpath(tmpdir()), "file-change-blob-test-"));
	root = join(sandbox, "blobs");
	store = new FileChangeBlobStore({ root, minimumFreeBytes: 0 });
});

afterEach(async () => {
	await rm(sandbox, { recursive: true, force: true });
});

function refFor(bytes: Uint8Array): FileChangeBlobRef {
	return {
		algorithm: "sha256",
		digest: createHash("sha256").update(bytes).digest("hex"),
		sizeBytes: bytes.byteLength,
	};
}

function pathFor(ref: FileChangeBlobRef): string {
	return join(root, "sha256", ref.digest.slice(0, 2), ref.digest);
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function temporaryNames(): Promise<string[]> {
	return (await exists(join(root, ".tmp"))) ? readdir(join(root, ".tmp")) : [];
}

async function* fromChunks(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
	for (const chunk of chunks) yield chunk;
}

async function installObject(ref: FileChangeBlobRef, bytes: Uint8Array): Promise<void> {
	await mkdir(dirname(pathFor(ref)), { recursive: true, mode: 0o700 });
	await writeFile(pathFor(ref), bytes, { mode: 0o600 });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toMatchObject({ name: "FileChangeBlobStoreError", code });
}

describe("FileChangeBlobStore bytes and bounds", () => {
	test("construction is lazy, including the default isolated home", async () => {
		expect(await exists(root)).toBe(false);
		const defaultRoot = getNarraforkPath("file-change-blobs");
		const existed = await exists(defaultRoot);
		new FileChangeBlobStore();
		expect(await exists(defaultRoot)).toBe(existed);
		expect(await exists(root)).toBe(false);
		expect("delete" in store).toBe(false);
		expect("remove" in store).toBe(false);
	});

	test.each([
		["empty", new Uint8Array()],
		["binary", new Uint8Array([0, 255, 128, 13, 10, 0, 192, 175])],
		["CRLF", Buffer.from("first\r\nsecond\r\nlast\r")],
		["UTF-8", Buffer.from("字节，不是文本转换\r\n")],
	] as const)("preserves %s exactly", async (_label, bytes) => {
		const ref = await store.putBytes(bytes, { expectedSize: bytes.byteLength });
		expect(ref).toEqual(refFor(bytes));
		expect(await store.readBytes(ref)).toEqual(new Uint8Array(bytes));
		expect(await readFile(pathFor(ref))).toEqual(Buffer.from(bytes));
		expect(await temporaryNames()).toEqual([]);
	});

	test("respects byte-view offsets and copies producer-owned chunks before async IO", async () => {
		const underlying = new Uint8Array([91, 0, 255, 13, 10, 92]);
		const view = underlying.subarray(1, 5);
		const wanted = new Uint8Array(view);
		let probes = 0;
		const copying = new FileChangeBlobStore({
			root,
			minimumFreeBytes: 0,
			getAvailableBytes: async () => {
				if (++probes === 2) view.fill(7);
				return 1_000_000n;
			},
		});
		const ref = await copying.putBytes(view, { expectedSize: wanted.length });
		expect(ref).toEqual(refFor(wanted));
		expect(await copying.readBytes(ref)).toEqual(wanted);
	});

	test("putBytes splits large inputs and output pulls never exceed 1 MiB", async () => {
		const bytes = new Uint8Array(2 * FILE_CHANGE_LIMITS.streamChunkBytes + 19).fill(0xa7);
		const ref = await store.putBytes(bytes, { expectedSize: bytes.length });
		const reader = (await store.openReadStream(ref)).getReader();
		const hash = createHash("sha256");
		let total = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				expect(chunk.value.byteLength).toBeLessThanOrEqual(FILE_CHANGE_LIMITS.streamChunkBytes);
				total += chunk.value.byteLength;
				hash.update(chunk.value);
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
		expect(total).toBe(bytes.length);
		expect(hash.digest("hex")).toBe(ref.digest);
	});

	test("accepts exactly 32 MiB streamed in bounded chunks", async () => {
		const chunk = new Uint8Array(FILE_CHANGE_LIMITS.streamChunkBytes).fill(0x81);
		const hash = createHash("sha256");
		async function* source() {
			for (let size = 0; size < FILE_CHANGE_LIMITS.blobBytes; size += chunk.length) {
				hash.update(chunk);
				yield chunk;
			}
		}
		const ref = await store.putStream(source(), { expectedSize: FILE_CHANGE_LIMITS.blobBytes });
		expect(ref.sizeBytes).toBe(FILE_CHANGE_LIMITS.blobBytes);
		expect(ref.digest).toBe(hash.digest("hex"));
		expect((await stat(pathFor(ref))).size).toBe(FILE_CHANGE_LIMITS.blobBytes);
		expect(await temporaryNames()).toEqual([]);
	});

	test("rejects over-limit admission before touching disk or consuming a source", async () => {
		let consumed = false;
		async function* source() {
			consumed = true;
			yield new Uint8Array();
		}
		await expectCode(
			store.putStream(source(), { expectedSize: FILE_CHANGE_LIMITS.blobBytes + 1 }),
			"too_large",
		);
		expect(consumed).toBe(false);
		expect(await exists(root)).toBe(false);
	});

	test("rejects a chunk above 1 MiB without publishing a prefix", async () => {
		const bytes = new Uint8Array(FILE_CHANGE_LIMITS.streamChunkBytes + 1);
		await expectCode(
			store.putStream(fromChunks(bytes), { expectedSize: bytes.length }),
			"chunk_too_large",
		);
		expect(await exists(pathFor(refFor(bytes)))).toBe(false);
		expect(await temporaryNames()).toEqual([]);
	});

	test.each([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid expectedSize %s before IO", async (expectedSize) => {
		await expectCode(store.putStream(fromChunks(), { expectedSize }), "invalid_input");
		expect(await exists(root)).toBe(false);
	});

	test("rejects missing expectedSize and non-byte values", async () => {
		await expectCode(
			store.putBytes(new Uint8Array(), {} as { expectedSize: number }),
			"invalid_input",
		);
		await expectCode(
			store.putBytes("text" as unknown as Uint8Array, { expectedSize: 4 }),
			"invalid_input",
		);
		await expectCode(
			store.putStream(fromChunks("text" as unknown as Uint8Array), { expectedSize: 4 }),
			"invalid_input",
		);
		expect(await temporaryNames()).toEqual([]);
	});

	test.each([
		0, 2, 4,
	])("requires exact expectedSize, not just an upper bound (%s)", async (expectedSize) => {
		const bytes = new Uint8Array([1, 2, 3]);
		await expectCode(store.putStream(fromChunks(bytes), { expectedSize }), "size_mismatch");
		await expectCode(store.putBytes(bytes, { expectedSize }), "size_mismatch");
		expect(await exists(pathFor(refFor(bytes)))).toBe(false);
		expect(await temporaryNames()).toEqual([]);
	});

	test("checks expectedDigest before publication", async () => {
		const bytes = Buffer.from("expected bytes");
		await expectCode(
			store.putBytes(bytes, { expectedSize: bytes.length, expectedDigest: "0".repeat(64) }),
			"hash_mismatch",
		);
		expect(await exists(pathFor(refFor(bytes)))).toBe(false);
		expect(await temporaryNames()).toEqual([]);
		const ref = await store.putBytes(bytes, {
			expectedSize: bytes.length,
			expectedDigest: refFor(bytes).digest,
		});
		expect(ref).toEqual(refFor(bytes));
	});

	test.each([
		"../escape",
		"F".repeat(64),
		"g".repeat(64),
		"0".repeat(63),
		`${"a".repeat(64)}\n`,
		`${"a".repeat(64)}\r\n`,
		null,
		123,
	])("rejects malformed expectedDigest %s before IO", async (expectedDigest) => {
		await expectCode(
			store.putBytes(new Uint8Array(), {
				expectedSize: 0,
				expectedDigest: expectedDigest as string,
			}),
			"invalid_ref",
		);
		expect(await exists(root)).toBe(false);
	});

	test("uses the caller's smaller read budget and never creates missing storage during reads", async () => {
		const ref = refFor(Buffer.from("bytes"));
		await expectCode(store.readBytes(ref, { maxBytes: 4 }), "too_large");
		await expectCode(
			store.openReadStream(ref, { maxBytes: FILE_CHANGE_LIMITS.blobBytes + 1 }),
			"too_large",
		);
		await expectCode(store.readBytes(ref), "not_found");
		expect(await exists(root)).toBe(false);
	});
});

describe("FileChangeBlobStore publication and filesystem safety", () => {
	test.skipIf(process.platform === "win32")(
		"creates 0700 directories and 0600 temporary/published files",
		async () => {
			const bytes = Buffer.from("private bytes");
			let temporaryMode: number | undefined;
			async function* source() {
				yield bytes;
				const names = await temporaryNames();
				expect(names.length).toBe(1);
				temporaryMode = (await stat(join(root, ".tmp", names[0]))).mode & 0o777;
			}
			const ref = await store.putStream(source(), { expectedSize: bytes.length });
			expect(temporaryMode).toBe(0o600);
			expect((await stat(pathFor(ref))).mode & 0o777).toBe(0o600);
			for (const path of [root, join(root, ".tmp"), join(root, "sha256"), dirname(pathFor(ref))]) {
				expect((await stat(path)).mode & 0o777).toBe(0o700);
			}
		},
	);

	test("duplicate publication verifies and reuses the original inode", async () => {
		const bytes = Buffer.from("same object");
		const ref = await store.putBytes(bytes, { expectedSize: bytes.length });
		const before = await stat(pathFor(ref), { bigint: true });
		const duplicate = await store.putBytes(bytes, { expectedSize: bytes.length });
		const after = await stat(pathFor(ref), { bigint: true });
		expect(duplicate).toEqual(ref);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeNs).toBe(before.mtimeNs);
		expect(await temporaryNames()).toEqual([]);
	});

	test("concurrent stores publishing the same hash are idempotent and only one accounts a new object", async () => {
		const bytes = new Uint8Array(FILE_CHANGE_LIMITS.streamChunkBytes).fill(42);
		const releases: FileChangeBlobRelease[] = [];
		const stores = Array.from(
			{ length: 12 },
			() =>
				new FileChangeBlobStore({
					root,
					minimumFreeBytes: 0,
					admission: {
						reserve: () => ({
							release: (result) => {
								releases.push(result);
							},
						}),
					},
				}),
		);
		const refs = await Promise.all(
			stores.map((instance) => instance.putBytes(bytes, { expectedSize: bytes.length })),
		);
		for (const ref of refs) expect(ref).toEqual(refFor(bytes));
		expect(releases.length).toBe(12);
		expect(releases.filter((result) => result.published).length).toBe(1);
		expect(await store.readBytes(refs[0])).toEqual(bytes);
		expect(await temporaryNames()).toEqual([]);
	});

	test.each([
		"same-sized corruption",
		"wrong-sized corruption",
	])("never overwrites %s at an existing hash", async (kind) => {
		const bytes = Buffer.from("correct");
		const ref = refFor(bytes);
		const corrupt = Buffer.from(kind === "same-sized corruption" ? "corrupt" : "short");
		await installObject(ref, corrupt);
		const inode = (await stat(pathFor(ref), { bigint: true })).ino;
		const code = corrupt.length === ref.sizeBytes ? "hash_mismatch" : "size_mismatch";
		await expectCode(store.putBytes(bytes, { expectedSize: bytes.length }), code);
		await expectCode(store.openReadStream(ref), code);
		expect(await readFile(pathFor(ref))).toEqual(corrupt);
		expect((await stat(pathFor(ref), { bigint: true })).ino).toBe(inode);
		expect(await temporaryNames()).toEqual([]);
	});

	test("rejects directories at a blob path without deleting them", async () => {
		const bytes = Buffer.from("directory collision");
		const ref = refFor(bytes);
		await mkdir(pathFor(ref), { recursive: true, mode: 0o700 });
		await expectCode(store.putBytes(bytes, { expectedSize: bytes.length }), "unsafe_object");
		await expectCode(store.readBytes(ref), "unsafe_object");
		expect((await lstat(pathFor(ref))).isDirectory()).toBe(true);
		expect(await temporaryNames()).toEqual([]);
	});

	test("rejects a symlink at a blob path and preserves its external target", async () => {
		const bytes = Buffer.from("symlink collision");
		const ref = refFor(bytes);
		const outside = join(sandbox, "outside.bin");
		await writeFile(outside, bytes, { mode: 0o600 });
		await mkdir(dirname(pathFor(ref)), { recursive: true, mode: 0o700 });
		await symlink(outside, pathFor(ref));
		await expectCode(store.readBytes(ref), "unsafe_object");
		await expectCode(store.putBytes(bytes, { expectedSize: bytes.length }), "unsafe_object");
		expect((await lstat(pathFor(ref))).isSymbolicLink()).toBe(true);
		expect(await readFile(outside)).toEqual(bytes);
		expect(await temporaryNames()).toEqual([]);
	});

	test.each([
		"root",
		"ancestor",
		"temporary",
		"shard",
	])("rejects a symlink in the %s directory", async (kind) => {
		const bytes = Buffer.from("must remain private");
		const ref = refFor(bytes);
		const outside = join(sandbox, "outside");
		await mkdir(outside, { mode: 0o700 });
		if (kind === "root") await symlink(outside, root, "dir");
		else if (kind === "ancestor") {
			const ancestor = join(sandbox, "alias");
			await symlink(outside, ancestor, "dir");
			store = new FileChangeBlobStore({ root: join(ancestor, "blobs"), minimumFreeBytes: 0 });
		} else {
			await mkdir(join(root, "sha256"), { recursive: true, mode: 0o700 });
			await symlink(
				outside,
				kind === "temporary" ? join(root, ".tmp") : dirname(pathFor(ref)),
				"dir",
			);
		}
		await expectCode(store.putBytes(bytes, { expectedSize: bytes.length }), "invalid_path");
		expect(await readdir(outside)).toEqual([]);
	});

	test("rechecks directories on subsequent calls instead of trusting a cached initialization", async () => {
		const bytes = Buffer.from("already initialized");
		const ref = await store.putBytes(bytes, { expectedSize: bytes.length });
		const outside = join(sandbox, "outside");
		await mkdir(outside, { mode: 0o700 });
		await rm(dirname(pathFor(ref)), { recursive: true });
		await symlink(outside, dirname(pathFor(ref)), "dir");
		await expectCode(store.readBytes(ref), "invalid_path");
		await expectCode(store.putBytes(bytes, { expectedSize: bytes.length }), "invalid_path");
		expect(await readdir(outside)).toEqual([]);
	});

	test("rejects unsafe root parameters synchronously", () => {
		for (const unsafe of [
			"relative",
			`${sandbox}/../escape`,
			`${sandbox}/./blobs`,
			`${root}\0x`,
			sep,
		]) {
			expect(() => new FileChangeBlobStore({ root: unsafe })).toThrow(FileChangeBlobStoreError);
		}
		expect(() => new FileChangeBlobStore({ root: null as unknown as string })).toThrow(
			FileChangeBlobStoreError,
		);
	});

	test.skipIf(process.platform === "win32")(
		"fails closed on non-private storage or objects",
		async () => {
			await mkdir(root, { mode: 0o755 });
			await chmod(root, 0o755);
			await expectCode(store.putBytes(new Uint8Array(), { expectedSize: 0 }), "invalid_path");
			await chmod(root, 0o700);
			const ref = await store.putBytes(new Uint8Array(), { expectedSize: 0 });
			await chmod(pathFor(ref), 0o644);
			await expectCode(store.readBytes(ref), "unsafe_object");
		},
	);

	test("rejects malicious refs without creating storage or invoking accessor getters", async () => {
		const valid = refFor(new Uint8Array());
		const invalid: unknown[] = [
			null,
			[],
			"digest",
			{},
			{ ...valid, algorithm: "sha1" },
			{ ...valid, filePath: "/escape" },
			Object.defineProperty({ ...valid }, "path", { value: "/escape", enumerable: false }),
			{ ...valid, [Symbol("path")]: "/escape" },
		];
		for (const digest of [
			"../escape",
			"/etc/passwd",
			"..\\escape",
			"F".repeat(64),
			"a".repeat(63),
			"a".repeat(65),
			`${"a".repeat(63)}\0`,
			`${"a".repeat(64)}\n`,
			`${"a".repeat(64)}\r\n`,
			"%2e%2e",
			"界".repeat(64),
		]) {
			invalid.push({ ...valid, digest });
		}
		for (const sizeBytes of [
			-1,
			0.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			FILE_CHANGE_LIMITS.blobBytes + 1,
		]) {
			invalid.push({ ...valid, sizeBytes });
		}
		let accessed = false;
		invalid.push({
			...valid,
			get digest() {
				accessed = true;
				return valid.digest;
			},
		});
		invalid.push(Object.create(valid));
		for (const value of invalid) {
			await expectCode(store.readBytes(value as FileChangeBlobRef), "invalid_ref");
			await expectCode(store.openReadStream(value as FileChangeBlobRef), "invalid_ref");
		}
		expect(accessed).toBe(false);
		expect(await exists(root)).toBe(false);
	});

	test("snapshots a valid ref before asynchronous work", async () => {
		const bytes = Buffer.from("stable reference");
		const ref = { ...(await store.putBytes(bytes, { expectedSize: bytes.length })) };
		const result = store.readBytes(ref);
		ref.digest = "../../outside";
		ref.sizeBytes = 100_000_000;
		expect(await result).toEqual(new Uint8Array(bytes));
	});
});

describe("FileChangeBlobStore failure cleanup, cancellation and accounting", () => {
	test("honors the shared minimum free-space guard, including expected bytes", async () => {
		const bytes = Buffer.from("disk budget");
		const guarded = new FileChangeBlobStore({
			root,
			getAvailableBytes: async () => BigInt(FILE_CHANGE_LIMITS.minimumFreeBytes + bytes.length - 1),
		});
		await expectCode(guarded.putBytes(bytes, { expectedSize: bytes.length }), "insufficient_space");
		expect(await temporaryNames()).toEqual([]);
		const exact = new FileChangeBlobStore({
			root,
			minimumFreeBytes: 8,
			getAvailableBytes: async () => BigInt(8 + bytes.length),
		});
		expect(await exact.putBytes(bytes, { expectedSize: bytes.length })).toEqual(refFor(bytes));
	});

	test("rechecks disk headroom while writing and cleans only its temporary object", async () => {
		const previous = Buffer.from("keep published");
		const previousRef = await store.putBytes(previous, { expectedSize: previous.length });
		await writeFile(join(root, ".tmp", "other-writer.tmp"), "other writer", { mode: 0o600 });
		let probes = 0;
		const shrinkingDisk = new FileChangeBlobStore({
			root,
			minimumFreeBytes: 10,
			getAvailableBytes: async () => (++probes < 3 ? 100n : 10n),
		});
		await expectCode(
			shrinkingDisk.putStream(fromChunks(new Uint8Array([1]), new Uint8Array([2])), {
				expectedSize: 2,
			}),
			"insufficient_space",
		);
		expect(await temporaryNames()).toEqual(["other-writer.tmp"]);
		expect(await store.readBytes(previousRef)).toEqual(new Uint8Array(previous));
	});

	test.each([
		"ENOSPC",
		"EDQUOT",
	])("handles real filesystem write rejection %s and releases its lease", async (code) => {
		const probe = await open(join(sandbox, "prototype-probe"), "w", 0o600);
		const write = spyOn(Object.getPrototypeOf(probe), "write").mockRejectedValueOnce(
			Object.assign(new Error("write failed"), { code }),
		);
		const releases: FileChangeBlobRelease[] = [];
		const guarded = new FileChangeBlobStore({
			root,
			minimumFreeBytes: 0,
			admission: {
				reserve: () => ({
					release: (result) => {
						releases.push(result);
					},
				}),
			},
		});
		try {
			await expectCode(guarded.putBytes(new Uint8Array([1]), { expectedSize: 1 }), "disk_full");
			expect(write).toHaveBeenCalledTimes(1);
		} finally {
			write.mockRestore();
			await probe.close();
		}
		expect(await temporaryNames()).toEqual([]);
		expect(releases).toEqual([{ ref: null, published: false }]);
	});

	test("retries partial writes without dropping or duplicating bytes", async () => {
		const probe = await open(join(sandbox, "prototype-probe"), "w", 0o600);
		const prototype = Object.getPrototypeOf(probe) as {
			write(
				buffer: Uint8Array,
				offset: number,
				length: number,
				position: number,
			): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
		};
		const original = prototype.write;
		const write = spyOn(prototype, "write").mockImplementation(function (
			this: FileHandle,
			buffer,
			offset,
			length,
			position,
		) {
			return original.call(this, buffer, offset, Math.min(length, 13), position);
		});
		const bytes = Buffer.from(
			"a partial write still has to preserve every byte including binary \0 and CRLF\r\n",
		);
		let ref: FileChangeBlobRef;
		try {
			ref = await store.putBytes(bytes, { expectedSize: bytes.length });
			expect(write.mock.calls.length).toBeGreaterThan(1);
		} finally {
			write.mockRestore();
			await probe.close();
		}
		expect(ref).toEqual(refFor(bytes));
		expect(await store.readBytes(ref)).toEqual(new Uint8Array(bytes));
	});

	test.each([
		"stat",
		"sync",
	] as const)("cleans its temp when the first file %s fails", async (method) => {
		const probe = await open(join(sandbox, "prototype-probe"), "w", 0o600);
		const failure = Object.assign(new Error(`${method} failed`), { code: "EIO" });
		const call = spyOn(Object.getPrototypeOf(probe), method).mockRejectedValueOnce(failure);
		try {
			await expect(store.putBytes(new Uint8Array([1]), { expectedSize: 1 })).rejects.toBe(failure);
		} finally {
			call.mockRestore();
			await probe.close();
		}
		expect(await temporaryNames()).toEqual([]);
	});

	test("never unlinks a replacement placed at its former temporary name", async () => {
		let replacedPath = "";
		async function* source() {
			yield new Uint8Array([1]);
			const [name] = await temporaryNames();
			replacedPath = join(root, ".tmp", name);
			await rename(replacedPath, join(sandbox, "detached-own-temp"));
			await writeFile(replacedPath, "another writer's file", { mode: 0o600 });
			throw new Error("producer failed after replacement");
		}
		await expect(store.putStream(source(), { expectedSize: 2 })).rejects.toBeInstanceOf(
			AggregateError,
		);
		expect(await readFile(replacedPath, "utf8")).toBe("another writer's file");
		expect(await readFile(join(sandbox, "detached-own-temp"))).toEqual(Buffer.from([1]));
	});

	test("stream failures preserve the producer error and remove the partial file", async () => {
		const failure = new Error("producer failed");
		async function* source() {
			yield new Uint8Array([1, 2]);
			throw failure;
		}
		await expect(store.putStream(source(), { expectedSize: 4 })).rejects.toBe(failure);
		expect(await temporaryNames()).toEqual([]);
	});

	test("pre-aborted operations consume nothing, reserve nothing and create no directory", async () => {
		const controller = new AbortController();
		controller.abort("already cancelled");
		let reservations = 0;
		const guarded = new FileChangeBlobStore({
			root,
			minimumFreeBytes: 0,
			admission: {
				reserve: () => {
					reservations++;
					return { release() {} };
				},
			},
		});
		await expectCode(
			guarded.putBytes(new Uint8Array(), { expectedSize: 0, signal: controller.signal }),
			"aborted",
		);
		await expectCode(
			guarded.readBytes(refFor(new Uint8Array()), { signal: controller.signal }),
			"aborted",
		);
		expect(reservations).toBe(0);
		expect(await exists(root)).toBe(false);
	});

	test("aborts pending web-stream pulls, unlocks input and releases admission", async () => {
		const entered = Promise.withResolvers<void>();
		const controller = new AbortController();
		let cancelled = 0;
		let released = 0;
		const source = new ReadableStream<Uint8Array>(
			{
				pull() {
					entered.resolve();
					return new Promise<void>(() => {});
				},
				cancel() {
					cancelled++;
				},
			},
			{ highWaterMark: 0 },
		);
		const guarded = new FileChangeBlobStore({
			root,
			minimumFreeBytes: 0,
			admission: {
				reserve: () => ({
					release() {
						released++;
					},
				}),
			},
		});
		const pending = guarded.putStream(source, { expectedSize: 1, signal: controller.signal });
		await entered.promise;
		controller.abort();
		await expectCode(pending, "aborted");
		expect(cancelled).toBe(1);
		expect(source.locked).toBe(false);
		expect(released).toBe(1);
		expect(await temporaryNames()).toEqual([]);
	});

	test("timeout does not wait for an uncooperative iterator's next or return", async () => {
		let returned = 0;
		const source: FileChangeBlobSource = {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
				return: () => {
					returned++;
					return new Promise<IteratorResult<Uint8Array>>(() => {});
				},
			}),
		};
		await expectCode(store.putStream(source, { expectedSize: 1, timeoutMs: 60 }), "timeout");
		expect(returned).toBe(1);
		expect(await temporaryNames()).toEqual([]);
	});

	test("an endless sequence of empty chunks cannot starve the timeout", async () => {
		async function* emptyForever() {
			while (true) yield new Uint8Array();
		}
		await expectCode(
			store.putStream(emptyForever(), { expectedSize: 0, timeoutMs: 60 }),
			"timeout",
		);
		expect(await temporaryNames()).toEqual([]);
	});

	test("aborting one writer preserves a concurrent same-hash publication and unrelated temp", async () => {
		const bytes = Buffer.from("concurrently shared");
		const paused = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const controller = new AbortController();
		async function* source() {
			yield bytes;
			paused.resolve();
			await resume.promise;
		}
		const pending = store.putStream(source(), {
			expectedSize: bytes.length,
			signal: controller.signal,
		});
		await paused.promise;
		await writeFile(join(root, ".tmp", "other-writer.tmp"), "untouched", { mode: 0o600 });
		const other = new FileChangeBlobStore({ root, minimumFreeBytes: 0 });
		const ref = await other.putBytes(bytes, { expectedSize: bytes.length });
		controller.abort();
		await expectCode(pending, "aborted");
		resume.resolve();
		expect(await store.readBytes(ref)).toEqual(new Uint8Array(bytes));
		expect(await temporaryNames()).toEqual(["other-writer.tmp"]);
	});

	test("stream reads detect equal-size tampering after open and before EOF", async () => {
		const bytes = new Uint8Array(FILE_CHANGE_LIMITS.streamChunkBytes + 1).fill(33);
		const ref = await store.putBytes(bytes, { expectedSize: bytes.length });
		const reader = (await store.openReadStream(ref)).getReader();
		try {
			const first = await reader.read();
			expect(first.value?.byteLength).toBe(FILE_CHANGE_LIMITS.streamChunkBytes);
			const handle = await open(pathFor(ref), "r+");
			try {
				await handle.write(new Uint8Array([34]), 0, 1, bytes.length - 1);
			} finally {
				await handle.close();
			}
			await expectCode(reader.read(), "hash_mismatch");
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	});

	test("an abandoned read stream expires and explicit cancellation is safe", async () => {
		const ref = await store.putBytes(new Uint8Array([1]), { expectedSize: 1 });
		const stream = await store.openReadStream(ref, { timeoutMs: 60 });
		await new Promise((resolve) => setTimeout(resolve, 90));
		const reader = stream.getReader();
		await expectCode(reader.read(), "timeout");
		reader.releaseLock();
		const cancellable = await store.openReadStream(ref);
		await cancellable.cancel();
		expect(await store.readBytes(ref)).toEqual(new Uint8Array([1]));
	});

	test("read abort propagates the cancellation reason through a typed error", async () => {
		const ref = await store.putBytes(new Uint8Array([1]), { expectedSize: 1 });
		const controller = new AbortController();
		const reader = (await store.openReadStream(ref, { signal: controller.signal })).getReader();
		controller.abort("cancel delivery");
		await expect(reader.read()).rejects.toMatchObject({
			code: "aborted",
			cause: "cancel delivery",
		});
		reader.releaseLock();
	});

	test("admission reserves before consuming input and releases once for success, dedup and failure", async () => {
		let active = 0;
		const sizes: number[] = [];
		const releases: FileChangeBlobRelease[] = [];
		const guarded = new FileChangeBlobStore({
			root,
			minimumFreeBytes: 0,
			admission: {
				reserve: ({ expectedSize, signal }) => {
					expect(signal.aborted).toBe(false);
					active++;
					sizes.push(expectedSize);
					return {
						release: async (result) => {
							active--;
							releases.push(result);
						},
					};
				},
			},
		});
		async function* source() {
			expect(active).toBe(1);
			yield new Uint8Array([1]);
		}
		const ref = await guarded.putStream(source(), { expectedSize: 1 });
		await guarded.putStream(source(), { expectedSize: 1 });
		await expectCode(guarded.putStream(source(), { expectedSize: 2 }), "size_mismatch");
		expect(active).toBe(0);
		expect(sizes).toEqual([1, 1, 2]);
		expect(releases).toEqual([
			{ ref, published: true },
			{ ref, published: false },
			{ ref: null, published: false },
		]);
	});

	test("admission rejection happens before directory creation", async () => {
		const quotaError = new Error("catalog quota exceeded");
		const guarded = new FileChangeBlobStore({
			root,
			admission: {
				reserve() {
					throw quotaError;
				},
			},
		});
		await expect(guarded.putBytes(new Uint8Array(), { expectedSize: 0 })).rejects.toBe(quotaError);
		expect(await exists(root)).toBe(false);
	});

	test("a lease arriving after cancellation is still released exactly once", async () => {
		const reservation = Promise.withResolvers<FileChangeBlobLease>();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const outcomes: FileChangeBlobRelease[] = [];
		const controller = new AbortController();
		const guarded = new FileChangeBlobStore({
			root,
			admission: {
				reserve() {
					entered.resolve();
					return reservation.promise;
				},
			},
		});
		const pending = guarded.putBytes(new Uint8Array(), {
			expectedSize: 0,
			signal: controller.signal,
		});
		await entered.promise;
		controller.abort();
		await expectCode(pending, "aborted");
		reservation.resolve({
			release(result) {
				outcomes.push(result);
				released.resolve();
			},
		});
		await released.promise;
		expect(outcomes).toEqual([{ ref: null, published: false }]);
		expect(await exists(root)).toBe(false);
	});

	test("catalog release failure never removes a published object", async () => {
		const bytes = Buffer.from("must outlive catalog failure");
		let outcome: FileChangeBlobRelease | undefined;
		const guarded = new FileChangeBlobStore({
			root,
			minimumFreeBytes: 0,
			admission: {
				reserve: () => ({
					release(result) {
						outcome = result;
						throw new Error("catalog unavailable");
					},
				}),
			},
		});
		await expect(guarded.putBytes(bytes, { expectedSize: bytes.length })).rejects.toBeInstanceOf(
			AggregateError,
		);
		expect(outcome).toEqual({ ref: refFor(bytes), published: true });
		expect(await store.readBytes(refFor(bytes))).toEqual(new Uint8Array(bytes));
		expect(await temporaryNames()).toEqual([]);
	});

	test.each([
		0,
		-1,
		Number.POSITIVE_INFINITY,
		0.1,
		2_147_483_648,
	])("rejects invalid timeout %s before IO", async (timeoutMs) => {
		await expectCode(
			store.putBytes(new Uint8Array(), { expectedSize: 0, timeoutMs }),
			"invalid_input",
		);
		expect(await exists(root)).toBe(false);
	});
});
