import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { FILE_CHANGE_LIMITS, type KnownFileChangeState } from "@shared/file-change-protocol";
import { testEnvironment } from "../../tests/preload";
import { localBackend } from "../lib/agent/execution/local-backend";
import { createFileChangeIdentity, type FileChangeScopeIdentity } from "./file-change-identity";
import { localDirectoryIdentity, localObjectIdentity } from "./file-change-local-io";
import {
	LOCAL_RESTORE_LIMITS,
	type LocalFileRestoreInput,
	type LocalRestoreGuard,
	preflightLocalFileRestore,
	restoreLocalFile,
} from "./file-change-local-restore";
import type { WorkspaceRuntimeBinding, WorkspaceWriteLease } from "./workspace-write-coordinator";

// No application DB/runtime imports, mock modules, workspace locks or public routes.
// The journal/lease doubles below model the caller contract; ALL target IO is real
// and confined to the test preload's isolated HOME. Only leaf faults use spies.
let root: string;
const restorers: (() => void)[] = [];
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const raw = (value: string | Uint8Array) =>
	typeof value === "string" ? Buffer.from(value) : value;

beforeEach(async () => {
	expect(process.env.HOME).toBe(testEnvironment.isolatedHome);
	expect(process.env.NARRAFORK_TEST).toBe("1");
	const lexical = await fs.mkdtemp(join(testEnvironment.isolatedHome, "local-restore-"));
	root = (await localBackend.resolvePathIdentity(lexical)).canonicalPath;
});
afterEach(async () => {
	for (const restore of restorers.splice(0).reverse()) restore();
	await fs.rm(root, { recursive: true, force: true });
});

async function request(
	path: string,
	expectedBytes: Uint8Array | null,
	desiredBytes: Uint8Array | null,
	options: { expectedMode?: number; desiredMode?: number } = {},
) {
	const blobs = new Map<string, Uint8Array>();
	function state(bytes: Uint8Array | null, mode: number): KnownFileChangeState {
		if (bytes === null) return { kind: "absent" };
		const ref = { algorithm: "sha256" as const, digest: digest(bytes), sizeBytes: bytes.length };
		blobs.set(ref.digest, bytes);
		return { kind: "regular", mode, blob: ref };
	}
	const pathFlavor = localBackend.pathFlavor;
	if (pathFlavor === "spec") throw new Error("fixture requires a real local filesystem");
	const scope: FileChangeScopeIdentity = {
		id: "fixture-scope",
		sourceInstanceId: "fixture-source",
		deviceId: "local",
		workspaceInstanceId: "fixture-incarnation",
		pathFlavor,
		canonicalRoot: root,
	};
	const runtime: WorkspaceRuntimeBinding = {
		runtimeEpoch: "fixture-authority",
		runtimeGeneration: localBackend.runtimeGeneration,
	};
	const binding = { deviceId: "local", ...runtime, fencingToken: 7 };
	let currentRuntime: WorkspaceRuntimeBinding | null = runtime;
	let live = true;
	let intentDurable = true;
	let permitted = true;
	const pending = new Set<string>();
	const events: string[] = ["intent_durable"];
	const lease: WorkspaceWriteLease = {
		token: { id: Symbol("fixture-lease") },
		leaseId: "fixture-lease",
		ranges: [{ kind: "subtree", canonicalPath: root }],
		kind: "rollback",
		scope,
		scopeRevision: 1,
		executionBinding: binding,
		overlappedUncoordinatedActivity: false,
		get pendingMutationCount() {
			return pending.size;
		},
		assertCurrent(expected = binding) {
			if (!live || expected.fencingToken !== binding.fencingToken) throw new Error("lease lost");
		},
		registerMutation(id) {
			if (!intentDurable || pending.has(id)) throw new Error("not prepared or duplicate");
			events.push("registered");
			pending.add(id);
		},
		assertMutationPending(id) {
			lease.assertCurrent();
			if (!pending.has(id)) throw new Error("exact mutation not registered");
		},
		settle() {
			throw new Error("helper must not settle the caller journal");
		},
		markUncertain() {
			throw new Error("caller owns quarantine");
		},
	};
	const input: LocalFileRestoreInput = {
		mutationId: randomUUID(),
		requestDigest: digest("fixture durable intent"),
		backend: localBackend,
		lease,
		scope,
		identity: {
			...createFileChangeIdentity(scope, {
				deviceId: "local",
				pathFlavor: localBackend.pathFlavor,
				lexicalPath: path,
				canonicalPath: path,
				objectRole: "referent",
			}),
		},
		executionBinding: { ...binding },
		rootObjectIdentity: await localDirectoryIdentity(root),
		expectedObjectIdentity:
			expectedBytes === null ? null : localObjectIdentity(await fs.lstat(path, { bigint: true })),
		expected: state(expectedBytes, options.expectedMode ?? 0o640),
		desired: state(desiredBytes, options.desiredMode ?? 0o640),
		signal: new AbortController().signal,
		readRuntime: () => currentRuntime,
		async authorize(context) {
			if (!permitted) throw new Error("revoked");
			events.push(`authorize:${context.phase}`);
		},
		assertCurrent(context) {
			if (!intentDurable) throw new Error("intent not durable");
			expect(Object.isFrozen(context)).toBe(true);
			expect(Object.isFrozen(context.expected)).toBe(true);
			events.push(`guard:${context.phase}`);
		},
		onDispatch(context) {
			expect(intentDurable).toBe(true);
			lease.registerMutation(context.mutationId);
			events.push("dispatch");
		},
		async readBlob(ref, options) {
			expect(options.maxBytes).toBe(ref.sizeBytes);
			expect(options.maxBytes).toBeLessThanOrEqual(FILE_CHANGE_LIMITS.blobBytes);
			options.signal.throwIfAborted();
			const bytes = blobs.get(ref.digest);
			if (!bytes) throw new Error("blob missing");
			return bytes;
		},
	};
	return {
		input,
		path,
		events,
		blobs,
		lease,
		revoke: () => {
			permitted = false;
		},
		loseLease: () => {
			live = false;
		},
		loseIntent: () => {
			intentDurable = false;
		},
		changeRuntime: () => {
			currentRuntime = null;
		},
	};
}
async function fixture(
	before: string | Uint8Array | null = "before\r\n",
	after: string | Uint8Array | null = "after\n",
	options: { name?: string; expectedMode?: number; desiredMode?: number } = {},
) {
	const path = join(root, options.name ?? "file.dat");
	if (before !== null) {
		await fs.writeFile(path, raw(before));
		await fs.chmod(path, options.expectedMode ?? 0o640);
	}
	return request(
		path,
		before === null ? null : raw(before),
		after === null ? null : raw(after),
		options,
	);
}
function atGuard(
	input: LocalFileRestoreInput,
	work: (guard: LocalRestoreGuard) => Promise<void> | void,
) {
	const original = input.assertCurrent;
	input.assertCurrent = async (guard) => {
		await original(guard);
		await work(guard);
	};
}
function patchHandle(path: string, work: (file: fs.FileHandle) => void) {
	const original = fs.open;
	const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
		const file = await original(...args);
		if (args[0] === path) work(file);
		return file;
	});
	restorers.push(() => spy.mockRestore());
}
async function untouched(f: Awaited<ReturnType<typeof fixture>>, expected: string | Uint8Array) {
	const result = await restoreLocalFile(f.input);
	expect(result.status).toBe("not_dispatched");
	expect(result.stats.dispatches).toBe(0);
	expect(f.events).not.toContain("dispatch");
	expect(await fs.readFile(f.path)).toEqual(Buffer.from(raw(expected)));
	return result;
}

const supported = process.platform !== "win32";
describe.skipIf(!supported)("guarded local typed object restore", () => {
	test.each([
		"bytes",
		"mode",
		"delete",
		"create",
		"absent",
		"equal",
	])("%s preflight validates the original intent without dispatch", async (kind) => {
		const before = kind === "create" || kind === "absent" ? null : "before";
		const after =
			kind === "delete" || kind === "absent"
				? null
				: kind === "mode" || kind === "equal"
					? "before"
					: "desired";
		const f = await fixture(before, after, {
			name: kind === "create" ? "missing/parent/file" : "preflight",
			desiredMode: kind === "mode" ? 0o600 : 0o640,
		});
		f.input.createParents = kind === "create";
		const original = structuredClone({
			expected: f.input.expected,
			desired: f.input.desired,
			requestDigest: f.input.requestDigest,
			mutationId: f.input.mutationId,
		});
		const blobs: string[] = [];
		const readBlob = f.input.readBlob;
		f.input.readBlob = async (ref, options) => {
			blobs.push(ref.digest);
			return readBlob(ref, options);
		};
		let dispatchCalls = 0;
		f.input.onDispatch = () => {
			dispatchCalls++;
			throw new Error("preflight cannot dispatch");
		};
		atGuard(f.input, (guard) => {
			expect(guard.expected).toEqual(original.expected);
			expect(guard.desired).toEqual(original.desired);
			expect(guard.requestDigest).toBe(original.requestDigest);
			expect(guard.mutationId).toBe(original.mutationId);
		});
		const result = await preflightLocalFileRestore(f.input);
		await result.whenSettled;
		expect(result.status).toBe("not_dispatched");
		expect(result.reason).toBe("preflight_verified");
		expect(result.ioPending).toBe(false);
		expect(result.stats.dispatches).toBe(0);
		expect(result.stats.bytesWritten).toBe(0);
		expect(result.observation?.state).toEqual(original.expected);
		expect(dispatchCalls).toBe(0);
		expect(f.lease.pendingMutationCount).toBe(0);
		expect(f.events).toContain("authorize:before_dispatch");
		expect(f.events).toContain("guard:before_dispatch");
		expect(f.events).not.toContain("guard:after_dispatch");
		for (const state of [original.expected, original.desired])
			if (state.kind === "regular") expect(blobs).toContain(state.blob.digest);
		if (before !== null) {
			expect(await fs.readFile(f.path, "utf8")).toBe(before);
			expect((await fs.stat(f.path)).mode & 0o7777).toBe(0o640);
		} else expect(await fs.lstat(f.path).catch(() => null)).toBeNull();
		if (kind === "create")
			expect(await fs.lstat(join(root, "missing")).catch(() => null)).toBeNull();
	});

	test.each([
		"unsupported",
		"permission",
		"readonly",
		"missing_desired",
	])("last file %s preflight failure leaves earlier files untouched", async (fault) => {
		const first = await fixture("first-before", "first-desired", { name: "first" });
		const last = await fixture("last-before", "last-desired", {
			name: "last",
			expectedMode: fault === "readonly" ? 0o444 : 0o640,
		});
		// Model the caller's already-held shared lease, not two overlapping leases.
		last.input.lease = first.lease;
		if (fault === "unsupported") {
			await fs.rename(last.path, join(root, "last-old"));
			await fs.mkdir(last.path);
			await fs.writeFile(join(last.path, "child"), "keep child");
		}
		if (fault === "permission")
			atGuard(last.input, (guard) => {
				if (guard.phase === "before_dispatch") last.revoke();
			});
		if (fault === "missing_desired" && last.input.desired.kind === "regular")
			last.blobs.delete(last.input.desired.blob.digest);
		const firstResult = await preflightLocalFileRestore(first.input);
		await firstResult.whenSettled;
		expect(firstResult.reason).toBe("preflight_verified");
		const lastResult = await preflightLocalFileRestore(last.input);
		await lastResult.whenSettled;
		expect(lastResult.status).toBe("not_dispatched");
		expect(lastResult.reason).toBe(
			fault === "unsupported"
				? "unsupported_object"
				: fault === "permission"
					? "authorization_failed"
					: fault === "readonly"
						? "permission_denied"
						: "blob_invalid",
		);
		expect(await fs.readFile(first.path, "utf8")).toBe("first-before");
		expect((await fs.stat(first.path)).mode & 0o7777).toBe(0o640);
		expect(first.events).not.toContain("dispatch");
		expect(last.events).not.toContain("dispatch");
		expect(first.lease.pendingMutationCount).toBe(0);
		if (fault === "unsupported") {
			expect(await fs.readFile(join(root, "last-old"), "utf8")).toBe("last-before");
			expect(await fs.readFile(join(last.path, "child"), "utf8")).toBe("keep child");
		} else expect(await fs.readFile(last.path, "utf8")).toBe("last-before");
	});

	test.each([
		"bytes",
		"permission",
		"runtime",
		"blob",
	])("%s drift after preflight is rechecked by restore", async (drift) => {
		const f = await fixture("before", "desired");
		const preflight = await preflightLocalFileRestore(f.input);
		await preflight.whenSettled;
		expect(preflight.reason).toBe("preflight_verified");
		if (drift === "bytes") await fs.writeFile(f.path, "external");
		if (drift === "permission") f.revoke();
		if (drift === "runtime") f.changeRuntime();
		if (drift === "blob") f.blobs.clear();
		const result = await untouched(f, drift === "bytes" ? "external" : "before");
		await result.whenSettled;
		expect(result.reason).not.toBe("preflight_verified");
	});

	test("valid preflight does not consume the mutation or skip real restore checks", async () => {
		const f = await fixture("before", "desired");
		const preflight = await preflightLocalFileRestore(f.input);
		await preflight.whenSettled;
		expect(preflight.reason).toBe("preflight_verified");
		expect(f.lease.pendingMutationCount).toBe(0);
		const restored = await restoreLocalFile(f.input);
		await restored.whenSettled;
		expect(restored.status).toBe("applied");
		expect(f.events.filter((event) => event === "authorize:before_dispatch")).toHaveLength(2);
		expect(f.events.filter((event) => event === "dispatch")).toHaveLength(1);
		expect(await fs.readFile(f.path, "utf8")).toBe("desired");
	});

	test.each([
		["binary", Buffer.from([0, 255, 254, 0, 128, 13, 10])],
		["CRLF", Buffer.from("one\r\ntwo\r\n")],
		["GBK", Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 13, 10, 0xa1, 0xa3])],
	] as const)("%s raw roundtrip and explicit guarded compensation", async (_, bytes) => {
		const f = await fixture(bytes, "new\n", { desiredMode: 0o600 });
		const result = await restoreLocalFile(f.input);
		expect(result.status).toBe("applied");
		expect(result.reason).toBe("verified");
		expect(result.ioPending).toBe(false);
		expect(await fs.readFile(f.path)).toEqual(Buffer.from("new\n"));
		expect((await fs.stat(f.path)).mode & 0o7777).toBe(0o600);
		const compensation = await request(f.path, Buffer.from("new\n"), bytes, {
			expectedMode: 0o600,
		});
		expect(compensation.input.mutationId).not.toBe(f.input.mutationId);
		const restored = await restoreLocalFile(compensation.input);
		expect(restored.status).toBe("applied");
		expect(restored.observation?.raw).toEqual(new Uint8Array(bytes));
		expect(await fs.readFile(f.path)).toEqual(bytes);
		expect(restored).not.toHaveProperty("executionReceipt");
	});

	test("create is exclusive, applies measured mode, and delete retains parents", async () => {
		await fs.mkdir(join(root, "parent"));
		const f = await fixture(null, "created", { name: "parent/file", desiredMode: 0o444 });
		const result = await restoreLocalFile(f.input);
		expect(result.status).toBe("applied");
		expect((await fs.stat(f.path)).mode & 0o7777).toBe(0o444);
		const deletion = await request(f.path, Buffer.from("created"), null, { expectedMode: 0o444 });
		expect((await restoreLocalFile(deletion.input)).status).toBe("applied");
		expect(await fs.lstat(f.path).catch(() => null)).toBeNull();
		expect((await fs.stat(join(root, "parent"))).isDirectory()).toBe(true);
	});

	test("mode-only uses guarded fd without truncate/write, including read-only before", async () => {
		const f = await fixture("same bytes", "same bytes", {
			expectedMode: 0o444,
			desiredMode: 0o750,
		});
		const inode = (await fs.stat(f.path)).ino;
		patchHandle(f.path, (file) => {
			file.truncate = async () => {
				throw new Error("mode-only cannot truncate");
			};
			file.write = (async () => {
				throw new Error("mode-only cannot write");
			}) as typeof file.write;
		});
		expect((await restoreLocalFile(f.input)).status).toBe("applied");
		expect((await fs.stat(f.path)).ino).toBe(inode);
		expect((await fs.stat(f.path)).mode & 0o7777).toBe(0o750);
		expect(await fs.readFile(f.path, "utf8")).toBe("same bytes");
	});

	test("absent->absent including missing parents is positive no syscall, not an old receipt", async () => {
		const f = await fixture(null, null, { name: "missing/parent/file" });
		const result = await restoreLocalFile(f.input);
		expect(result.status).toBe("not_dispatched");
		expect(result.reason).toBe("no_change");
		expect(result.observation?.state).toEqual({ kind: "absent" });
		expect(f.events).not.toContain("dispatch");
		expect(await fs.lstat(join(root, "missing")).catch(() => null)).toBeNull();
	});

	test("equal regular state is also a no-dispatch observation, not confirmation of earlier IO", async () => {
		const f = await fixture("same", "same");
		expect((await restoreLocalFile(f.input)).reason).toBe("no_change");
		expect(f.events).not.toContain("dispatch");
	});

	test("registers durable intent then once-only dispatch before truncate", async () => {
		const f = await fixture();
		patchHandle(f.path, (file) => {
			const original = file.truncate.bind(file);
			file.truncate = async (size) => {
				expect(f.events.slice(-2)).toEqual(["registered", "dispatch"]);
				expect(f.lease.pendingMutationCount).toBe(1);
				f.events.push("truncate");
				return original(size);
			};
		});
		expect((await restoreLocalFile(f.input)).status).toBe("applied");
		expect(f.events[0]).toBe("intent_durable");
		expect(f.events.filter((event) => event === "dispatch")).toHaveLength(1);
		// Caller still owns durable finalization, even after positive IO verification.
		expect(f.lease.pendingMutationCount).toBe(1);
	});

	test("an unrelated pending mutation count cannot authorize this mutation", async () => {
		const f = await fixture();
		f.lease.registerMutation("unrelated");
		f.input.onDispatch = () => {};
		expect(f.lease.pendingMutationCount).toBe(1);
		await untouched(f, "before\r\n");
	});

	test("caller may register the exact mutation before invoking the helper", async () => {
		const f = await fixture();
		f.lease.registerMutation(f.input.mutationId);
		f.input.onDispatch = () => {
			f.events.push("applying_durable");
		};
		expect((await restoreLocalFile(f.input)).status).toBe("applied");
		expect(f.events.filter((event) => event === "registered")).toHaveLength(1);
		expect(f.events).toContain("applying_durable");
	});

	test.each([
		"intent",
		"registration",
		"throwing_hook",
		"async_hook",
	])("%s barrier failure never writes", async (failure) => {
		const f = await fixture();
		if (failure === "intent") f.loseIntent();
		if (failure === "registration") f.input.onDispatch = () => {};
		if (failure === "throwing_hook")
			f.input.onDispatch = () => {
				throw new Error("journal disk full");
			};
		if (failure === "async_hook") f.input.onDispatch = async () => {};
		await untouched(f, "before\r\n");
	});

	test.each([
		"unknown",
		"symlink",
		"null_mode",
		"missing_blob",
		"hash",
		"size",
		"oversized",
		"oversized_adapter",
	])("%s is rejected before any dispatch", async (failure) => {
		const f = await fixture();
		if (failure === "unknown")
			f.input.desired = {
				kind: "unknown",
				reason: "capture_failed",
			} as unknown as KnownFileChangeState;
		else if (failure === "symlink" && f.input.desired.kind === "regular")
			f.input.desired = { kind: "symlink", target: f.input.desired.blob, mode: 0o777 };
		else if (f.input.desired.kind === "regular") {
			if (failure === "null_mode") f.input.desired.mode = null;
			if (failure === "missing_blob") f.blobs.delete(f.input.desired.blob.digest);
			if (failure === "hash") f.blobs.set(f.input.desired.blob.digest, Buffer.from("wrong!"));
			if (failure === "size") f.input.desired.blob.sizeBytes++;
			if (failure === "oversized")
				f.input.desired.blob.sizeBytes = FILE_CHANGE_LIMITS.blobBytes + 1;
			if (failure === "oversized_adapter") f.input.readBlob = async () => new Uint8Array(1024);
		}
		await untouched(f, "before\r\n");
	});

	test("deletion requires its expected raw blob, even without desired bytes", async () => {
		const f = await fixture("before", null);
		f.blobs.clear();
		expect((await untouched(f, "before")).reason).toBe("blob_invalid");
	});

	test.each([
		"content",
		"mode",
		"rebuild",
		"hardlink",
		"readonly",
	])("%s drift is refused before dispatch", async (change) => {
		const f = await fixture();
		if (change === "content") await fs.writeFile(f.path, "someone else");
		if (change === "mode") await fs.chmod(f.path, 0o600);
		if (change === "readonly") await fs.chmod(f.path, 0o444);
		if (change === "hardlink") await fs.link(f.path, join(root, "second-link"));
		if (change === "rebuild") {
			await fs.rename(f.path, join(root, "original"));
			await fs.writeFile(f.path, "before\r\n", { mode: 0o640 });
		}
		await untouched(f, change === "content" ? "someone else" : "before\r\n");
	});

	test.each([
		"symlink",
		"directory",
	])("target %s is never followed or recursively removed", async (kind) => {
		const f = await fixture("before", null);
		const old = join(root, "old");
		await fs.rename(f.path, old);
		if (kind === "symlink") await fs.symlink(old, f.path);
		else {
			await fs.mkdir(f.path);
			await fs.writeFile(join(f.path, "child"), "preserve");
		}
		expect((await restoreLocalFile(f.input)).status).toBe("not_dispatched");
		expect(await fs.readFile(old, "utf8")).toBe("before");
		expect(f.events).not.toContain("dispatch");
		if (kind === "directory")
			expect(await fs.readFile(join(f.path, "child"), "utf8")).toBe("preserve");
		else expect((await fs.lstat(f.path)).isSymbolicLink()).toBe(true);
	});

	test("a symlink parent is not followed even when its destination has matching bytes", async () => {
		await fs.mkdir(join(root, "parent"));
		const f = await fixture("before", null, { name: "parent/file" });
		await fs.rename(join(root, "parent"), join(root, "moved"));
		await fs.symlink(join(root, "moved"), join(root, "parent"));
		expect((await restoreLocalFile(f.input)).status).toBe("not_dispatched");
		expect(await fs.readFile(join(root, "moved/file"), "utf8")).toBe("before");
	});

	test("root incarnation cannot be replaced with an identical-looking workspace", async () => {
		const f = await fixture();
		const moved = `${root}-moved`;
		await fs.rename(root, moved);
		try {
			await fs.mkdir(root);
			await fs.writeFile(f.path, "before\r\n", { mode: 0o640 });
			await untouched(f, "before\r\n");
			expect(await fs.readFile(join(moved, "file.dat"), "utf8")).toBe("before\r\n");
		} finally {
			await fs.rm(moved, { recursive: true, force: true });
		}
	});

	test.each([
		"bytes",
		"mode",
		"delete",
	])("last-guard rename+replacement preserves BOTH objects during %s restore", async (kind) => {
		const f = await fixture(
			"before",
			kind === "delete" ? null : kind === "mode" ? "before" : "after",
			{ desiredMode: kind === "mode" ? 0o700 : 0o640 },
		);
		const moved = join(root, "moved");
		atGuard(f.input, async (guard) => {
			if (guard.phase !== "before_dispatch") return;
			await fs.rename(f.path, moved);
			await fs.writeFile(f.path, "new owner", { mode: 0o600 });
		});
		await untouched(f, "new owner");
		expect(await fs.readFile(moved, "utf8")).toBe("before");
		expect((await fs.stat(moved)).mode & 0o7777).toBe(0o640);
		expect((await fs.stat(f.path)).mode & 0o7777).toBe(0o600);
	});

	test.each([
		"bytes",
		"mode",
		"permission",
		"runtime",
		"lease",
	])("%s changes in the last async guard are rechecked", async (change) => {
		const f = await fixture();
		atGuard(f.input, async (guard) => {
			if (guard.phase !== "before_dispatch") return;
			if (change === "bytes") await fs.writeFile(f.path, "last-guard content");
			if (change === "mode") await fs.chmod(f.path, 0o400);
			if (change === "runtime") f.changeRuntime();
			if (change === "lease") f.loseLease();
			if (change === "permission") f.revoke();
		});
		await untouched(f, change === "bytes" ? "last-guard content" : "before\r\n");
	});

	test("explicit authorization is re-run after blob loading", async () => {
		const f = await fixture();
		const original = f.input.readBlob;
		f.input.readBlob = async (...args) => {
			const bytes = await original(...args);
			f.revoke();
			return bytes;
		};
		expect((await untouched(f, "before\r\n")).reason).toBe("authorization_failed");
	});

	test.each([
		"file",
		"parent",
	])("%s access revocation after opening is checked again before dispatch", async (kind) => {
		const f = await fixture("before", kind === "parent" ? null : "after");
		let revoked = false;
		atGuard(f.input, (guard) => {
			if (guard.phase === "before_dispatch") revoked = true;
		});
		const original = fs.access;
		const spy = spyOn(fs, "access").mockImplementation(async (path, mode) => {
			if (revoked && path === (kind === "file" ? f.path : root))
				throw Object.assign(new Error("simulated ACL denial"), { code: "EACCES" });
			return original(path, mode);
		});
		restorers.push(() => spy.mockRestore());
		expect((await untouched(f, "before")).reason).toBe("permission_denied");
	});

	test.each([
		"fake_backend",
		"runtime",
		"scope",
		"relative_path",
		"range",
		"missing_guard",
		"budget",
	])("%s binding/input cannot dispatch", async (failure) => {
		const f = await fixture();
		if (failure === "fake_backend") f.input.backend = new Proxy(localBackend, {});
		if (failure === "runtime")
			f.input.executionBinding = {
				...f.input.executionBinding,
				runtimeEpoch: "requested-not-authority",
			};
		if (failure === "scope") f.input.scope = { ...f.input.scope, workspaceInstanceId: "invented" };
		if (failure === "relative_path")
			f.input.identity = { ...f.input.identity, lexicalPath: "relative" };
		if (failure === "range")
			f.input.identity = { ...f.input.identity, canonicalPath: join(root, "..", "outside") };
		if (failure === "missing_guard")
			f.input.assertCurrent = undefined as unknown as LocalFileRestoreInput["assertCurrent"];
		if (failure === "budget") f.input.timeoutMs = LOCAL_RESTORE_LIMITS.maxTimeoutMs + 1;
		await untouched(f, "before\r\n");
	});

	test("copies caller identity/states and blob bytes rather than retaining mutable input", async () => {
		const desired = Buffer.from("frozen bytes");
		const f = await fixture("before", desired);
		atGuard(f.input, (guard) => {
			if (guard.phase === "preflight") {
				f.input.identity = { ...f.input.identity, canonicalPath: join(root, "unintended") };
				f.input.desired = { kind: "absent" };
			}
			if (guard.phase === "before_dispatch") desired.fill(88);
		});
		expect((await restoreLocalFile(f.input)).status).toBe("applied");
		expect(await fs.readFile(f.path, "utf8")).toBe("frozen bytes");
		expect(await fs.lstat(join(root, "unintended")).catch(() => null)).toBeNull();
	});

	test("creates missing parents one at a time with a prior dispatch barrier", async () => {
		const f = await fixture(null, "nested", { name: "one/two/file" });
		f.input.createParents = true;
		const original = fs.mkdir;
		const spy = spyOn(fs, "mkdir").mockImplementation((async (
			...args: Parameters<typeof fs.mkdir>
		) => {
			expect(f.events).toContain("registered");
			expect(f.events).toContain("dispatch");
			expect(args[1]).toEqual({ mode: 0o700 });
			return original(...args);
		}) as typeof fs.mkdir);
		restorers.push(() => spy.mockRestore());
		expect((await restoreLocalFile(f.input)).status).toBe("applied");
		expect(await fs.readFile(f.path, "utf8")).toBe("nested");
		expect(f.events.filter((event) => event === "dispatch")).toHaveLength(1);
	});

	test("failed create after mkdir stays uncertain and never removes created parents", async () => {
		const f = await fixture(null, "nested", { name: "one/two/file" });
		f.input.createParents = true;
		let guarded = 0;
		atGuard(f.input, (guard) => {
			if (guard.phase === "before_dispatch" && ++guarded === 2)
				throw new Error("revoked after mkdir");
		});
		const result = await restoreLocalFile(f.input);
		expect(result.status).toBe("uncertain_after_dispatch");
		expect((await fs.stat(join(root, "one"))).isDirectory()).toBe(true);
		expect(await fs.lstat(join(root, "one/two")).catch(() => null)).toBeNull();
	});

	test("absent expectation never overwrites a file created by somebody else", async () => {
		const f = await fixture(null, "desired");
		atGuard(f.input, async (guard) => {
			if (guard.phase === "before_dispatch") await fs.writeFile(f.path, "somebody else");
		});
		await untouched(f, "somebody else");
	});

	test("O_EXCL protects a creation collision after the last absence check", async () => {
		const f = await fixture(null, "desired");
		const original = fs.open;
		const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
			if (args[0] === f.path) {
				expect(Number(args[1]) & constants.O_EXCL).not.toBe(0);
				await fs.writeFile(f.path, "racing creator");
			}
			return original(...args);
		});
		restorers.push(() => spy.mockRestore());
		expect((await restoreLocalFile(f.input)).status).toBe("uncertain_after_dispatch");
		expect(await fs.readFile(f.path, "utf8")).toBe("racing creator");
	});

	test.each([
		"cancel",
		"failure",
	])("partial write %s remains unknown without retry/compensation", async (fault) => {
		const next = new Uint8Array(LOCAL_RESTORE_LIMITS.ioChunkBytes * 2 + 3).fill(65);
		const f = await fixture("before", next);
		const abort = new AbortController();
		f.input.signal = abort.signal;
		let writes = 0;
		patchHandle(f.path, (file) => {
			const original = file.write.bind(file);
			file.write = (async (
				buffer: Uint8Array,
				offset: number,
				length: number,
				position: number,
			) => {
				writes++;
				if (writes === 2) throw new Error("disk write failed");
				const result = await original(buffer, offset, length, position);
				if (fault === "cancel") abort.abort();
				return result;
			}) as typeof file.write;
		});
		const result = await restoreLocalFile(f.input);
		expect(result.status).toBe("uncertain_after_dispatch");
		expect(result.observation).toBeNull();
		expect(await fs.readFile(f.path)).toEqual(
			Buffer.from(next.subarray(0, LOCAL_RESTORE_LIMITS.ioChunkBytes)),
		);
		expect(writes).toBe(fault === "cancel" ? 1 : 2);
	});

	test("post-write observation/authorization failure cannot use matching desired to confirm", async () => {
		const f = await fixture("before", "desired");
		atGuard(f.input, (guard) => {
			if (guard.phase === "after_dispatch") throw new Error("after unavailable");
		});
		const result = await restoreLocalFile(f.input);
		expect(result.status).toBe("uncertain_after_dispatch");
		expect(result.observation).toBeNull();
		expect(await fs.readFile(f.path, "utf8")).toBe("desired");
		const unrelatedNoop = await request(f.path, Buffer.from("desired"), Buffer.from("desired"));
		expect((await restoreLocalFile(unrelatedNoop.input)).reason).toBe("no_change");
		expect(result.status).toBe("uncertain_after_dispatch");
	});

	test("after drift is observed but preserves third-party content", async () => {
		const f = await fixture();
		atGuard(f.input, async (guard) => {
			if (guard.phase === "after_dispatch") await fs.writeFile(f.path, "third party");
		});
		const result = await restoreLocalFile(f.input);
		expect(result.status).toBe("uncertain_after_dispatch");
		expect(result.observation?.raw).toEqual(new Uint8Array(Buffer.from("third party")));
		expect(await fs.readFile(f.path, "utf8")).toBe("third party");
	});

	test("delete followed by external recreate does not delete the newcomer", async () => {
		const f = await fixture("before", null);
		atGuard(f.input, async (guard) => {
			if (guard.phase === "after_dispatch") await fs.writeFile(f.path, "recreated");
		});
		expect((await restoreLocalFile(f.input)).status).toBe("uncertain_after_dispatch");
		expect(await fs.readFile(f.path, "utf8")).toBe("recreated");
	});

	test("exclusive create then replacement at final guard does not modify either object", async () => {
		const f = await fixture(null, "desired");
		let guards = 0;
		atGuard(f.input, async (guard) => {
			if (guard.phase !== "before_dispatch" || ++guards !== 2) return;
			await fs.rename(f.path, join(root, "moved"));
			await fs.writeFile(f.path, "external", { mode: 0o444 });
		});
		expect((await restoreLocalFile(f.input)).status).toBe("uncertain_after_dispatch");
		expect(await fs.readFile(join(root, "moved"), "utf8")).toBe("");
		expect(await fs.readFile(f.path, "utf8")).toBe("external");
		expect((await fs.stat(f.path)).mode & 0o7777).toBe(0o444);
	});

	test("duplicate invocation with old expected refuses rather than providing durable idempotency", async () => {
		const f = await fixture();
		expect((await restoreLocalFile(f.input)).status).toBe("applied");
		const count = f.events.filter((event) => event === "dispatch").length;
		const second = await restoreLocalFile(f.input);
		expect(second.status).toBe("not_dispatched");
		expect(second.reason).not.toBe("no_change");
		expect(f.events.filter((event) => event === "dispatch")).toHaveLength(count);
		expect(await fs.readFile(f.path, "utf8")).toBe("after\n");
	});

	test("compensation validates real after and never overwrites a later user's change", async () => {
		const f = await fixture();
		expect((await restoreLocalFile(f.input)).status).toBe("applied");
		const compensation = await request(f.path, Buffer.from("after\n"), Buffer.from("before\r\n"));
		await fs.writeFile(f.path, "user change");
		await untouched(compensation, "user change");
	});

	test.each([
		"blob",
		"authorization",
	])("%s timeout before dispatch is bounded and cannot resume writes", async (fault) => {
		const f = await fixture();
		const gate = Promise.withResolvers<Uint8Array>();
		f.input.timeoutMs = 30;
		if (fault === "blob") f.input.readBlob = () => gate.promise;
		else
			f.input.authorize = async () => {
				await gate.promise;
			};
		const result = await untouched(f, "before\r\n");
		expect(result.reason).toBe("timeout");
		expect(result.stats.elapsedMs).toBeLessThan(1000);
		expect(result.ioPending).toBe(true);
		let settled = false;
		void result.whenSettled.then(() => {
			settled = true;
		});
		await yieldToEventLoop();
		expect(settled).toBe(false);
		gate.resolve(Buffer.from("before\r\n"));
		await result.whenSettled;
		expect(settled).toBe(true);
		expect(f.events).not.toContain("dispatch");
	});

	test("in-flight write timeout returns unknown, closes late fd, and never issues another write", async () => {
		const f = await fixture(
			"before",
			new Uint8Array(LOCAL_RESTORE_LIMITS.ioChunkBytes * 2).fill(66),
		);
		const ack = Promise.withResolvers<void>();
		const closeStarted = Promise.withResolvers<void>();
		const closeAck = Promise.withResolvers<void>();
		let writes = 0;
		let closeCalls = 0;
		let closed = false;
		f.input.timeoutMs = 150;
		patchHandle(f.path, (file) => {
			const write = file.write.bind(file);
			const close = file.close.bind(file);
			file.write = (async (
				buffer: Uint8Array,
				offset: number,
				length: number,
				position: number,
			) => {
				writes++;
				const result = await write(buffer, offset, length, position);
				await ack.promise; // The kernel completion is not yet known to the helper.
				return result;
			}) as typeof file.write;
			file.close = async () => {
				closeCalls++;
				closeStarted.resolve();
				await closeAck.promise;
				await close();
				closed = true;
			};
		});
		const result = await restoreLocalFile(f.input);
		expect(result.status).toBe("uncertain_after_dispatch");
		expect(result.reason).toBe("timeout");
		expect(result.ioPending).toBe(true);
		expect(result.stats.elapsedMs).toBeLessThan(1000);
		expect(closed).toBe(false);
		let settled = false;
		void result.whenSettled.then(() => {
			settled = true;
		});
		await yieldToEventLoop();
		expect(settled).toBe(false);
		expect(closeCalls).toBe(0); // Never close/reuse the fd of still-running IO.
		ack.resolve();
		await closeStarted.promise;
		expect(closed).toBe(false);
		expect(settled).toBe(false); // Acknowledged write alone does not release resources.
		expect(f.lease.pendingMutationCount).toBe(1);
		closeAck.resolve();
		await result.whenSettled;
		expect(settled).toBe(true);
		expect(closed).toBe(true);
		expect(closeCalls).toBe(1);
		expect(result.status).toBe("uncertain_after_dispatch"); // Lifetime ended, outcome not upgraded.
		expect(f.lease.pendingMutationCount).toBe(1); // Helper never settles the durable caller journal.
		expect(writes).toBe(1);
		expect((await fs.readFile(f.path)).length).toBe(LOCAL_RESTORE_LIMITS.ioChunkBytes);
	});

	test.each([
		"existing",
		"create",
		"preflight",
	])("%s open returning after timeout is closed before whenSettled", async (kind) => {
		const f = await fixture(kind === "create" ? null : "before", "desired");
		const openAck = Promise.withResolvers<void>();
		let opens = 0;
		let writes = 0;
		let closed = false;
		f.input.timeoutMs = 100;
		const original = fs.open;
		const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
			const file = await original(...args);
			if (args[0] !== f.path) return file;
			opens++;
			const close = file.close.bind(file);
			file.close = async () => {
				await close();
				closed = true;
			};
			file.write = (async () => {
				writes++;
				throw new Error("late open cannot resume writes");
			}) as typeof file.write;
			await openAck.promise;
			return file;
		});
		restorers.push(() => spy.mockRestore());
		const result = await (kind === "preflight"
			? preflightLocalFileRestore(f.input)
			: restoreLocalFile(f.input));
		expect(result.status).toBe(kind === "create" ? "uncertain_after_dispatch" : "not_dispatched");
		expect(result.reason).toBe("timeout");
		expect(result.ioPending).toBe(true);
		expect(opens).toBe(1);
		expect(closed).toBe(false);
		let settled = false;
		void result.whenSettled.then(() => {
			settled = true;
		});
		await yieldToEventLoop();
		expect(settled).toBe(false);
		openAck.resolve();
		await result.whenSettled;
		expect(settled).toBe(true);
		expect(closed).toBe(true);
		expect(writes).toBe(0);
		expect(await fs.readFile(f.path, "utf8")).toBe(kind === "create" ? "" : "before");
	});

	test("late close failure rejects whenSettled without retrying or upgrading the uncertain result", async () => {
		const f = await fixture("before", "desired");
		const closeAck = Promise.withResolvers<void>();
		let closeCalls = 0;
		f.input.timeoutMs = 100;
		patchHandle(f.path, (file) => {
			const close = file.close.bind(file);
			file.close = async () => {
				closeCalls++;
				await closeAck.promise;
				await close(); // Always release this test-owned descriptor.
				throw new Error("close acknowledgement failed");
			};
		});
		const result = await restoreLocalFile(f.input);
		expect(result.status).toBe("uncertain_after_dispatch");
		expect(result.reason).toBe("timeout");
		expect(result.ioPending).toBe(true);
		expect(closeCalls).toBe(1);
		closeAck.resolve();
		await expect(result.whenSettled).rejects.toThrow("close acknowledgement failed");
		expect(closeCalls).toBe(1);
		expect(result.status).toBe("uncertain_after_dispatch");
		expect(f.lease.pendingMutationCount).toBe(1);
		expect(await fs.readFile(f.path, "utf8")).toBe("desired");
	});

	test("pre-cancelled signal and oversized sparse target never dispatch", async () => {
		const f = await fixture();
		f.input.signal = AbortSignal.abort();
		expect((await untouched(f, "before\r\n")).reason).toBe("cancelled");
		const g = await fixture("before", "after", { name: "large" });
		const file = await fs.open(g.path, "r+");
		await file.truncate(FILE_CHANGE_LIMITS.blobBytes + 1);
		await file.close();
		const result = await restoreLocalFile(g.input);
		expect(result.status).toBe("not_dispatched");
		expect(result.reason).toBe("budget_exceeded");
		expect(result.stats.bytesRead).toBe(0);
		expect((await fs.stat(g.path)).size).toBe(FILE_CHANGE_LIMITS.blobBytes + 1);
	});

	test("raw IO has bounded chunks and observation output", async () => {
		const before = new Uint8Array(FILE_CHANGE_LIMITS.streamChunkBytes + 17).fill(65);
		const after = new Uint8Array(before.length + 3).fill(66);
		const f = await fixture(before, after);
		let maxWrite = 0;
		patchHandle(f.path, (file) => {
			const write = file.write.bind(file);
			file.write = (async (
				buffer: Uint8Array,
				offset: number,
				length: number,
				position: number,
			) => {
				maxWrite = Math.max(maxWrite, length);
				return write(buffer, offset, length, position);
			}) as typeof file.write;
		});
		const result = await restoreLocalFile(f.input);
		expect(result.status).toBe("applied");
		expect(maxWrite).toBeLessThanOrEqual(LOCAL_RESTORE_LIMITS.ioChunkBytes);
		expect(result.observation?.raw?.byteLength).toBe(after.length);
		expect(result.stats.bytesWritten).toBe(after.length);
		expect(result.observation?.raw?.byteLength).toBeLessThanOrEqual(FILE_CHANGE_LIMITS.blobBytes);
	});

	test("POSIX literal backslash stays data in the same physical file", async () => {
		const f = await fixture("before", "after", { name: "literal\\name" });
		expect((await restoreLocalFile(f.input)).status).toBe("applied");
		expect(await fs.readFile(f.path, "utf8")).toBe("after");
	});

	test.skipIf(process.platform !== "linux")(
		"FIFO swap is nonblocking in an isolated child",
		async () => {
			if (process.env.NF_LOCAL_RESTORE_FIFO_CHILD !== "1") {
				const child = Bun.spawn(
					[
						process.execPath,
						"test",
						import.meta.path,
						"--test-name-pattern",
						"FIFO swap is nonblocking",
					],
					{
						env: { ...process.env, NARRAFORK_HOME: "", NF_LOCAL_RESTORE_FIFO_CHILD: "1" },
						stdout: "ignore",
						stderr: "ignore",
					},
				);
				// Only this explicitly spawned disposable test child may be terminated.
				const timer = setTimeout(() => child.kill(), 8000);
				try {
					expect(await child.exited).toBe(0);
				} finally {
					clearTimeout(timer);
				}
				return;
			}
			const f = await fixture("before", null); // Deletion opens O_RDONLY, which blocks on FIFO without NONBLOCK.
			const original = fs.open;
			const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
				if (args[0] === f.path) {
					expect(Number(args[1]) & constants.O_NONBLOCK).not.toBe(0);
					await fs.rename(f.path, join(root, "moved"));
					const child = Bun.spawn(["mkfifo", f.path], { stdout: "ignore", stderr: "ignore" });
					expect(await child.exited).toBe(0);
				}
				return original(...args);
			});
			restorers.push(() => spy.mockRestore());
			const result = await restoreLocalFile(f.input);
			expect(result.status).toBe("not_dispatched");
			expect(result.reason).toBe("unsupported_object");
			expect((await fs.lstat(f.path)).isFIFO()).toBe(true);
			expect(await fs.readFile(join(root, "moved"), "utf8")).toBe("before");
		},
	);
});
