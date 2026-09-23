import { describe, expect, spyOn, test } from "bun:test";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import {
	createFileChangeLocalIo,
	fileChangeLocalIo,
	LOCAL_FILE_PARENT_DEPTH_LIMIT,
	type LocalFileApplyInput,
	type LocalFileHandle,
	type LocalFileSyscalls,
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
			expect(await fileChangeLocalIo.apply(input)).toMatchObject({
				kind: "not_applied",
				error: expect.any(Error),
			});
			expect(await readFile(input.canonicalPath, "utf8")).toBe("original");
		});
	});

	test("onDispatch cancellation exits before truncating the original", async () => {
		await withFile("original", async (input, controller) => {
			input.onDispatch = () => controller.abort();
			expect(await fileChangeLocalIo.apply(input)).toMatchObject({
				kind: "not_applied",
				error: expect.any(Error),
			});
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
				expect(await fileChangeLocalIo.apply(input)).toMatchObject({
					kind: "applied",
					error: null,
				});
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
				expect(await fileChangeLocalIo.apply(input)).toMatchObject({
					kind: "applied",
					error: null,
				});
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
			expect(await fileChangeLocalIo.apply(input)).toMatchObject({
				kind: "not_applied",
				error: expect.any(Error),
			});
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
				if (++guards === 4) controller.abort();
				input.signal.throwIfAborted();
			};
			expect(await fileChangeLocalIo.apply(input)).toMatchObject({
				kind: "parent_only",
				error: expect.any(Error),
				parentEffects: { createdPaths: [join(parent, ".."), parent], possiblePaths: [] },
			});
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

function errno(code: string): Error & { code: string } {
	return Object.assign(new Error(code), { code });
}

/** In-memory syscall model: never touches /spec, and has no UID-dependent failures. */
function controlledIo(initial: string | null = null, parents: string[] = []) {
	const controller = new AbortController();
	const dirs = new Set(["/", ...parents]);
	const files = new Map<string, { bytes: Buffer; ino: bigint }>();
	const path = "/spec/nested/target";
	if (initial !== null) {
		dirs.add("/spec");
		dirs.add("/spec/nested");
		files.set(path, { bytes: Buffer.from(initial), ino: 100n });
	}
	const calls: string[] = [];
	const mutations: string[] = [];
	const opens: number[] = [];
	let hook: (event: string) => void | Promise<void> = () => {};
	const event = async (operation: string, target = path) => {
		const key = `${operation}:${target}`;
		calls.push(key);
		await hook(key);
	};
	const stat = (target: string): BigIntStats => {
		const file = files.get(target);
		if (!file && !dirs.has(target)) throw errno("ENOENT");
		return {
			...statFixture(101n),
			ino: file?.ino ?? 1n,
			size: BigInt(file?.bytes.length ?? 0),
			mode: 0o644n,
			nlink: 1n,
			isFile: () => !!file,
			isDirectory: () => dirs.has(target),
			isSymbolicLink: () => false,
		} as BigIntStats;
	};
	const syscalls: LocalFileSyscalls = {
		async lstat(target) {
			await event("lstat", target);
			return stat(target);
		},
		async mkdir(target) {
			await event("mkdir", target);
			if (dirs.has(target) || files.has(target)) throw errno("EEXIST");
			if (!dirs.has(join(target, ".."))) throw errno("ENOENT");
			dirs.add(target);
			mutations.push(`mkdir:${target}`);
			await event("mkdir:done", target);
		},
		async open(target, flags) {
			opens.push(flags);
			const creates = (flags & constants.O_CREAT) !== 0;
			const readOnly = !creates && (flags & constants.O_RDWR) === 0;
			const stage = creates ? "create" : readOnly ? "read" : "existing";
			await event(`open:${stage}`, target);
			if (creates) {
				if (!(flags & constants.O_EXCL)) throw new Error("Expected exclusive creation");
				if (files.has(target) || dirs.has(target)) throw errno("EEXIST");
				if (!dirs.has(join(target, ".."))) throw errno("ENOENT");
				files.set(target, { bytes: Buffer.alloc(0), ino: 100n });
				mutations.push(`create:${target}`);
			}
			const entry = files.get(target);
			if (!entry) throw errno("ENOENT");
			await event(`open:${stage}:done`, target);
			const scope = readOnly ? "read" : "target";
			const handle: LocalFileHandle = {
				async stat() {
					await event(`stat:${scope}`, target);
					return stat(target);
				},
				async read(buffer, offset, length, position) {
					await event(`read:${scope}`, target);
					const bytesRead = Math.min(length, entry.bytes.length - position);
					buffer.set(entry.bytes.subarray(position, position + bytesRead), offset);
					return { bytesRead };
				},
				async truncate(length) {
					await event("truncate", target);
					entry.bytes = entry.bytes.subarray(0, length);
					mutations.push(`truncate:${target}`);
					await event("truncate:done", target);
				},
				async write(buffer, offset, length, position) {
					await event("write", target);
					// Short successful writes ensure the loop is genuinely exercised.
					const bytesWritten = Math.min(length, 4);
					const bytes = Buffer.alloc(Math.max(entry.bytes.length, position + bytesWritten));
					bytes.set(entry.bytes);
					bytes.set(buffer.subarray(offset, offset + bytesWritten), position);
					entry.bytes = bytes;
					mutations.push(`write:${target}`);
					await event("write:done", target);
					return { bytesWritten };
				},
				async sync() {
					await event("sync", target);
					await event("sync:done", target);
				},
				async close() {
					await event(`close:${scope}`, target);
					await event(`close:${scope}:done`, target);
				},
			};
			return handle;
		},
	};
	const io = createFileChangeLocalIo(syscalls);
	const input: LocalFileApplyInput = {
		backend: {} as ExecutionBackend,
		canonicalPath: path,
		lexicalPath: path,
		before:
			initial === null
				? { bytes: null, mode: null, identity: null }
				: { bytes: Buffer.from(initial), mode: 0o644, identity: localObjectIdentity(stat(path)) },
		nextBytes: Buffer.from("replacement"),
		signal: controller.signal,
		assertTarget: async () => {
			await event("guard");
		},
		onDispatch: () => calls.push(`dispatch:${path}`),
	};
	return {
		io,
		input,
		controller,
		calls,
		mutations,
		opens,
		dirs,
		files,
		setHook(next: typeof hook) {
			hook = next;
		},
	};
}

describe("controlled syscall stage evidence", () => {
	test("close failure before any target mutation preserves not_applied and the primary error", async () => {
		const f = controlledIo("original", ["/spec", "/spec/nested"]);
		const guardError = new Error("validation refused before truncate");
		const closeError = new Error("descriptor close failed");
		let opened = false;
		f.setHook((event) => {
			if (event === `open:existing:done:${f.input.canonicalPath}`) opened = true;
			if (opened && event === `guard:${f.input.canonicalPath}`) throw guardError;
			if (event === `close:target:${f.input.canonicalPath}`) throw closeError;
		});
		const result = await f.io.apply(f.input);
		expect(result.kind).toBe("not_applied");
		expect(result.error).toBe(guardError);
		expect(f.mutations).toEqual([]);
		expect(f.calls).toContain(`close:target:${f.input.canonicalPath}`);
	});
	test("first mkdir /spec EACCES is not_applied with registration but no mutation", async () => {
		const f = controlledIo();
		const failure = errno("EACCES");
		f.setHook((event) => {
			if (event === "mkdir:/spec") throw failure;
		});
		expect(await f.io.apply(f.input)).toEqual({
			kind: "not_applied",
			error: failure,
			parentEffects: { createdPaths: [], possiblePaths: [] },
		});
		expect(f.calls).toContain(`dispatch:${f.input.canonicalPath}`);
		expect(f.mutations).toEqual([]);
		expect(f.opens).toEqual([]);
		expect([...f.dirs]).toEqual(["/"]);
	});

	test("deleted file-only footprint anchor during discovery is not recreated", async () => {
		const f = controlledIo(null, ["/spec", "/spec/nested"]);
		const failure = new Error("Write parent identity changed after range admission");
		let guards = 0;
		f.input.assertTarget = async () => {
			guards++;
			if (!f.dirs.has("/spec/nested")) throw failure;
		};
		f.setHook((event) => {
			// The frozen file-only footprint had /spec/nested as its anchor.
			// This external deletion happens after the initial guard, during read.
			if (event === `lstat:${f.input.canonicalPath}`) f.dirs.delete("/spec/nested");
		});
		expect(await f.io.apply(f.input)).toEqual({
			kind: "not_applied",
			error: failure,
			parentEffects: { createdPaths: [], possiblePaths: [] },
		});
		expect(guards).toBe(2);
		expect(f.mutations).toEqual([]);
		expect(f.opens).toEqual([]);
		expect(f.calls.some((event) => event.startsWith("mkdir:"))).toBe(false);
		expect(f.dirs.has("/spec/nested")).toBe(false);
	});

	test("anchor replacement after one mkdir prevents the next mkdir", async () => {
		const f = controlledIo();
		const failure = new Error("Admission anchor was replaced");
		let anchorUnchanged = true;
		f.input.assertTarget = async () => {
			if (!anchorUnchanged) throw failure;
		};
		f.setHook((event) => {
			if (event === "mkdir:done:/spec") anchorUnchanged = false;
		});
		expect(await f.io.apply(f.input)).toEqual({
			kind: "parent_only",
			error: failure,
			parentEffects: { createdPaths: ["/spec"], possiblePaths: [] },
		});
		expect(f.mutations).toEqual(["mkdir:/spec"]);
		expect(f.calls).not.toContain("mkdir:/spec/nested");
		expect(f.opens).toEqual([]);
	});

	test("one successful mkdir then EACCES is parent_only, never opening target", async () => {
		const f = controlledIo();
		const failure = errno("EACCES");
		f.setHook((event) => {
			if (event === "mkdir:/spec/nested") throw failure;
		});
		expect(await f.io.apply(f.input)).toEqual({
			kind: "parent_only",
			error: failure,
			parentEffects: { createdPaths: ["/spec"], possiblePaths: [] },
		});
		expect(f.mutations).toEqual(["mkdir:/spec"]);
		expect(f.opens).toEqual([]);
	});

	test.each([
		"mkdir:/spec",
		"mkdir:done:/spec",
		"mkdir:/spec/nested",
	])("uncertain parent syscall preserves its exact possible entry (%s)", async (failureStage) => {
		const f = controlledIo();
		const failure = errno("EIO");
		f.setHook((event) => {
			if (event === failureStage) throw failure;
		});
		expect(await f.io.apply(f.input)).toEqual({
			kind: "parent_only",
			error: failure,
			parentEffects: {
				createdPaths: failureStage.endsWith("/nested") ? ["/spec"] : [],
				possiblePaths: [failureStage.endsWith("/nested") ? "/spec/nested" : "/spec"],
			},
		});
		expect(f.opens).toEqual([]);
	});

	test.each([
		"EACCES",
		"EEXIST",
	])("O_EXCL rejection %s is not_applied when parents already exist", async (code) => {
		const f = controlledIo(null, ["/spec", "/spec/nested"]);
		const failure = errno(code);
		f.setHook((event) => {
			if (event.startsWith("open:create:")) throw failure;
		});
		expect(await f.io.apply(f.input)).toEqual({
			kind: "not_applied",
			error: failure,
			parentEffects: { createdPaths: [], possiblePaths: [] },
		});
		expect(f.opens[0] & constants.O_EXCL).not.toBe(0);
		expect(f.mutations).toEqual([]);
	});

	test("O_EXCL EACCES after mkdir retains parent_only evidence", async () => {
		const f = controlledIo();
		const failure = errno("EACCES");
		f.setHook((event) => {
			if (event === `open:create:${f.input.canonicalPath}`) throw failure;
		});
		expect(await f.io.apply(f.input)).toEqual({
			kind: "parent_only",
			error: failure,
			parentEffects: { createdPaths: ["/spec", "/spec/nested"], possiblePaths: [] },
		});
		expect(f.files.size).toBe(0);
	});

	test("unrecognized O_EXCL failure remains unknown even when target is absent", async () => {
		const f = controlledIo(null, ["/spec", "/spec/nested"]);
		f.setHook((event) => {
			if (event === `open:create:${f.input.canonicalPath}`) throw errno("EIO");
		});
		expect((await f.io.apply(f.input)).kind).toBe("target_mutation_unknown");
		expect(f.files.size).toBe(0);
	});

	test.each(["EACCES", "EIO"])("nontruncating existing open %s cannot mutate", async (code) => {
		const f = controlledIo("original");
		const failure = errno(code);
		f.setHook((event) => {
			if (event === `open:existing:${f.input.canonicalPath}`) throw failure;
		});
		expect(await f.io.apply(f.input)).toMatchObject({ kind: "not_applied", error: failure });
		expect(f.opens.every((flags) => (flags & (constants.O_TRUNC | constants.O_CREAT)) === 0)).toBe(
			true,
		);
		expect(f.mutations).toEqual([]);
	});

	test.each([
		"truncate",
		"write:done",
		"sync",
		"close:target",
	])("%s failure is unknown, even with a permission errno", async (stage) => {
		const f = controlledIo("original");
		const failure = errno("EACCES");
		f.setHook((event) => {
			if (event === `${stage}:${f.input.canonicalPath}`) throw failure;
		});
		expect(await f.io.apply(f.input)).toMatchObject({
			kind: "target_mutation_unknown",
			error: failure,
		});
		expect(f.calls).toContain(`close:target:${f.input.canonicalPath}`);
		if (stage === "write:done")
			expect(f.files.get(f.input.canonicalPath)?.bytes.toString()).toBe("repl");
	});

	test("close failure cannot replace the primary partial-write error", async () => {
		const f = controlledIo("original");
		const primary = new Error("partial write");
		f.setHook((event) => {
			if (event.startsWith("write:done:")) throw primary;
			if (event.startsWith("close:target:")) throw new Error("close");
		});
		expect(await f.io.apply(f.input)).toMatchObject({
			kind: "target_mutation_unknown",
			error: primary,
		});
	});

	test("guard EACCES after creation is not mistaken for syscall rejection", async () => {
		const f = controlledIo();
		const failure = errno("EACCES");
		let guards = 0;
		f.input.assertTarget = async () => {
			if (++guards === 5) throw failure;
		};
		expect(await f.io.apply(f.input)).toMatchObject({
			kind: "target_mutation_unknown",
			error: failure,
		});
		expect(f.files.get(f.input.canonicalPath)?.bytes).toEqual(Buffer.from(f.input.nextBytes));
	});

	test("mkdir EEXIST validates a concurrent directory without claiming its creation", async () => {
		const f = controlledIo();
		f.setHook((event) => {
			if (event === "mkdir:/spec") f.dirs.add("/spec");
		});
		expect(await f.io.apply(f.input)).toEqual({
			kind: "applied",
			error: null,
			parentEffects: { createdPaths: ["/spec/nested"], possiblePaths: [] },
		});
	});

	test("mkdir EEXIST for a non-directory stops without opening target", async () => {
		const f = controlledIo();
		f.setHook((event) => {
			if (event === "mkdir:/spec") f.files.set("/spec", { bytes: Buffer.alloc(0), ino: 101n });
		});
		expect((await f.io.apply(f.input)).kind).toBe("not_applied");
		expect(f.mutations).toEqual([]);
		expect(f.opens).toEqual([]);
	});

	test("depth above 128 is rejected before any mkdir/open", async () => {
		const f = controlledIo();
		f.input.canonicalPath = `/${Array.from({ length: LOCAL_FILE_PARENT_DEPTH_LIMIT + 1 }, () => "a").join("/")}/target`;
		expect(await f.io.apply(f.input)).toMatchObject({
			kind: "not_applied",
			error: expect.objectContaining({ message: "Parent directory depth exceeds 128" }),
		});
		expect(f.mutations).toEqual([]);
		expect(f.opens).toEqual([]);
	});

	test("128 parents have a bounded complete description", async () => {
		const f = controlledIo();
		f.input.canonicalPath = `/${Array.from({ length: LOCAL_FILE_PARENT_DEPTH_LIMIT }, () => "a").join("/")}/target`;
		const result = await f.io.apply(f.input);
		expect(result.kind).toBe("applied");
		expect(result.parentEffects.createdPaths).toHaveLength(128);
		expect(result.parentEffects.possiblePaths).toEqual([]);
	});

	test.each([
		"bytes",
		"identity",
	])("post-close %s replacement remains unknown despite cancellation", async (replacement) => {
		const f = controlledIo("original");
		f.setHook((event) => {
			if (event === `close:target:done:${f.input.canonicalPath}`) {
				f.controller.abort();
				const entry = f.files.get(f.input.canonicalPath);
				if (!entry) throw new Error("missing fixture");
				if (replacement === "bytes") entry.bytes = Buffer.from("foreign");
				else entry.ino++;
			}
		});
		expect((await f.io.apply(f.input)).kind).toBe("target_mutation_unknown");
	});

	test("successful short-write loop completes before reporting applied", async () => {
		const f = controlledIo("original");
		expect((await f.io.apply(f.input)).kind).toBe("applied");
		expect(f.files.get(f.input.canonicalPath)?.bytes).toEqual(Buffer.from(f.input.nextBytes));
		expect(f.calls.filter((event) => event.startsWith("write:done:"))).toHaveLength(3);
		expect(f.calls.at(-1)).toBe(`close:read:done:${f.input.canonicalPath}`);
	});
});

describe("controlled cancellation across every IO stage", () => {
	test.each([
		["guard", null, "not_applied"],
		["mkdir:done:/spec", null, "parent_only"],
		["mkdir:done:/spec/nested", null, "parent_only"],
		["open:existing:done", "original", "not_applied"],
		["read:target", "original", "not_applied"],
		["open:create:done", null, "applied"],
		["truncate:done", "original", "applied"],
		["write:done", "original", "applied"],
		["sync:done", "original", "applied"],
		["close:target:done", "original", "applied"],
	] as const)("cancel at %s returns %s/%s", async (stage, initial, kind) => {
		const f = controlledIo(initial);
		const reason = new Error(`cancel at ${stage}`);
		f.setHook((event) => {
			if (event === (stage.includes("/spec") ? stage : `${stage}:${f.input.canonicalPath}`))
				f.controller.abort(reason);
		});
		const result = await f.io.apply(f.input);
		expect(result.kind).toBe(kind);
		expect(result.error).toBe(kind === "applied" ? null : reason);
		if (kind === "applied") {
			expect(f.files.get(f.input.canonicalPath)?.bytes).toEqual(Buffer.from(f.input.nextBytes));
			expect(f.calls).toContain(`sync:done:${f.input.canonicalPath}`);
			expect(f.calls).toContain(`close:target:done:${f.input.canonicalPath}`);
		} else if (kind === "parent_only") {
			expect(f.files.size).toBe(0);
			expect(f.opens).toEqual([]);
		} else {
			expect(f.mutations).toEqual([]);
		}
	});

	test.each([
		"open:create",
		"truncate",
		"write",
		"sync",
		"close:target",
	])("cancellation awaits pending %s and final cleanup instead of racing IO", async (stage) => {
		const f = controlledIo(stage === "open:create" ? null : "original");
		let release!: () => void;
		let entered!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		f.setHook(async (event) => {
			if (event === `${stage}:${f.input.canonicalPath}`) {
				entered();
				await pending;
			}
		});
		let settled = false;
		const apply = f.io.apply(f.input).then((result) => {
			settled = true;
			return result;
		});
		await started;
		f.controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		expect((await apply).kind).toBe("applied");
		expect(f.files.get(f.input.canonicalPath)?.bytes).toEqual(Buffer.from(f.input.nextBytes));
		expect(f.calls.at(-1)).toBe(`close:read:done:${f.input.canonicalPath}`);
	});

	test("cancellation cannot race a pending mkdir or erase its completed effects", async () => {
		const f = controlledIo();
		let release!: () => void;
		let entered!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		f.setHook(async (event) => {
			if (event === "mkdir:/spec") {
				entered();
				await pending;
			}
		});
		let settled = false;
		const apply = f.io.apply(f.input).then((result) => {
			settled = true;
			return result;
		});
		await started;
		f.controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		expect(await apply).toMatchObject({
			kind: "parent_only",
			parentEffects: { createdPaths: ["/spec"], possiblePaths: [] },
		});
		expect(f.opens).toEqual([]);
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
