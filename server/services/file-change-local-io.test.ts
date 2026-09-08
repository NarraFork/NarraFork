import { describe, expect, spyOn, test } from "bun:test";
import type { BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import {
	fileChangeLocalIo,
	type LocalFileApplyInput,
	LocalFileValidationError,
	localObjectIdentity,
} from "./file-change-local-io";

// Narrow signatures for the exact overloads used by the writer. Spies always
// delegate real IO, match this fixture's buffer/inode, and restore in finally.
interface IoPrototype {
	write(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
	stat(options: { bigint: true }): Promise<BigIntStats>;
	sync(): Promise<void>;
}

async function withFile(
	initial: string | null,
	run: (
		input: LocalFileApplyInput,
		controller: AbortController,
		proto: IoPrototype,
	) => Promise<void>,
) {
	const directory = await mkdtemp(join(tmpdir(), "file-change-local-io-"));
	try {
		const path = join(directory, "target");
		if (initial !== null) await writeFile(path, initial);
		const probe = await open(join(directory, "probe"), "w+");
		const proto = Object.getPrototypeOf(probe) as IoPrototype;
		await probe.close();
		const controller = new AbortController();
		await run(
			{
				// apply uses the supplied assertTarget guard, not backend methods.
				backend: {} as ExecutionBackend,
				lexicalPath: path,
				canonicalPath: path,
				before: await fileChangeLocalIo.read(path),
				nextBytes: Buffer.from("replacement"),
				signal: controller.signal,
				assertTarget: async () => {},
				onDispatch: () => {},
			},
			controller,
			proto,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("local file cancellation boundaries (real IO)", () => {
	test("already cancelled leaves the original untouched", async () => {
		await withFile("original", async (input, controller) => {
			controller.abort();
			await expect(fileChangeLocalIo.apply(input)).rejects.toThrow();
			expect(await readFile(input.canonicalPath, "utf8")).toBe("original");
		});
	});

	test("onDispatch cancellation exits before truncating the original", async () => {
		await withFile("original", async (input, controller) => {
			input.onDispatch = () => controller.abort();
			await expect(fileChangeLocalIo.apply(input)).rejects.toThrow();
			expect(await readFile(input.canonicalPath, "utf8")).toBe("original");
		});
	});

	test.each([
		"original",
		null,
	])("cancellation after first chunk still writes and syncs every byte (initial=%s)", async (initial) => {
		await withFile(initial, async (input, controller, proto) => {
			input.nextBytes = Buffer.alloc(150_001, 0x61);
			// Exercise positive short writes as well as the 64 KiB chunk boundary.
			const originalWrite = proto.write;
			let writes = 0;
			let target: unknown;
			const writeSpy = spyOn(proto, "write").mockImplementation(async function (
				this: IoPrototype,
				buffer,
				offset,
				length,
				position,
			) {
				const matches = buffer === input.nextBytes;
				const result = await originalWrite.call(
					this,
					buffer,
					offset,
					matches ? Math.min(length, 32 * 1024) : length,
					position,
				);
				if (matches) {
					target = this;
					writes++;
					controller.abort();
				}
				return result;
			});
			const originalSync = proto.sync;
			let synced = false;
			const syncSpy = spyOn(proto, "sync").mockImplementation(async function (this: IoPrototype) {
				await originalSync.call(this);
				if (this === target) synced = true;
			});
			try {
				// A cancelled lease may reject verification AFTER persistence.
				input.assertTarget = async () => input.signal.throwIfAborted();
				await expect(fileChangeLocalIo.apply(input)).rejects.toThrow();
				expect(writes).toBe(5);
				expect(synced).toBe(true);
				expect(await readFile(input.canonicalPath)).toEqual(Buffer.from(input.nextBytes));
			} finally {
				writeSpy.mockRestore();
				syncSpy.mockRestore();
			}
		});
	});

	test.each([
		"replacement",
		"",
	])("cancellation after exclusive creation persists new content %j", async (content) => {
		await withFile(null, async (input, controller, proto) => {
			input.nextBytes = Buffer.from(content);
			input.assertTarget = async () => input.signal.throwIfAborted();
			const originalStat = proto.stat;
			let target: unknown;
			const statSpy = spyOn(proto, "stat").mockImplementation(async function (
				this: IoPrototype,
				options,
			) {
				const stat = await originalStat.call(this, options);
				const entry = await lstat(input.canonicalPath, { bigint: true }).catch(() => null);
				if (entry && stat.ino === entry.ino && stat.dev === entry.dev) {
					target = this;
					controller.abort();
				}
				return stat;
			});
			const originalSync = proto.sync;
			let synced = false;
			const syncSpy = spyOn(proto, "sync").mockImplementation(async function (this: IoPrototype) {
				await originalSync.call(this);
				if (this === target) synced = true;
			});
			try {
				await expect(fileChangeLocalIo.apply(input)).rejects.toThrow();
				expect(controller.signal.aborted).toBe(true);
				expect(synced).toBe(true);
				expect(await readFile(input.canonicalPath, "utf8")).toBe(content);
			} finally {
				statSpy.mockRestore();
				syncSpy.mockRestore();
			}
		});
	});

	test("new file onDispatch cancellation does not create parents or file", async () => {
		await withFile(null, async (input, controller) => {
			const parent = join(input.canonicalPath, "nested");
			input.canonicalPath = join(parent, "file");
			input.lexicalPath = input.canonicalPath;
			input.onDispatch = () => controller.abort();
			await expect(fileChangeLocalIo.apply(input)).rejects.toThrow();
			await expect(lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	test("cancellation after mkdir leaves only parents, not an empty target", async () => {
		await withFile(null, async (input, controller) => {
			const parent = join(input.canonicalPath, "nested");
			input.canonicalPath = join(parent, "file");
			input.lexicalPath = input.canonicalPath;
			let guards = 0;
			input.assertTarget = async () => {
				if (++guards === 2) controller.abort();
				input.signal.throwIfAborted();
			};
			await expect(fileChangeLocalIo.apply(input)).rejects.toThrow();
			expect((await lstat(parent)).isDirectory()).toBe(true);
			await expect(lstat(input.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	test.each(["original", null])("empty output is saved (initial=%s)", async (initial) => {
		await withFile(initial, async (input) => {
			input.nextBytes = Buffer.alloc(0);
			await fileChangeLocalIo.apply(input);
			expect((await readFile(input.canonicalPath)).length).toBe(0);
		});
	});
});

/** Pure fixture: only fields used by the identity function, no real filesystem or DB. */
function statFixture(birthtimeNs: bigint): BigIntStats {
	return {
		dev: 7n,
		ino: 23n,
		birthtimeNs,
		// Positive modification times must not substitute for missing creation time.
		ctimeNs: 1_800_000_000_000_000_000n,
		mtimeNs: 1_800_000_000_000_000_000n,
	} as BigIntStats;
}

describe("local object incarnation identity", () => {
	test.each([0n, -1n])("rejects unavailable creation time %s even with dev/ino", (birthtimeNs) => {
		expect(() => localObjectIdentity(statFixture(birthtimeNs))).toThrow(LocalFileValidationError);
		expect(() => localObjectIdentity(statFixture(birthtimeNs))).toThrow("valid creation time");
	});

	test("positive creation times distinguish reused device/inode pairs", () => {
		expect(localObjectIdentity(statFixture(101n))).toBe("7:23:101");
		expect(localObjectIdentity(statFixture(102n))).not.toBe(localObjectIdentity(statFixture(101n)));
	});

	test("a changed reported birthtime is not normalized back to the old identity", () => {
		const initial = statFixture(101n);
		const changed = { ...initial, birthtimeNs: initial.ctimeNs };
		expect(localObjectIdentity(changed)).not.toBe(localObjectIdentity(initial));
	});

	test("creation time does not replace a missing device/inode identity", () => {
		const stat = { ...statFixture(101n), dev: 0n, ino: 0n };
		expect(() => localObjectIdentity(stat)).toThrow("does not expose an object identity");
	});
});
