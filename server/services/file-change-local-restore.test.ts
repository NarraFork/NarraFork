import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { KnownFileChangeState } from "@shared/file-change-protocol";
import { testEnvironment } from "../../tests/preload";
import { localBackend } from "../lib/agent/execution/local-backend";
import { createFileChangeIdentity, type FileChangeScopeIdentity } from "./file-change-identity";
import {
	type LocalFileRestoreInput,
	preflightLocalFileRestore,
	restoreLocalFile,
	setLocalRestoreSemanticsForTests,
} from "./file-change-local-restore";
import { withFileWrite } from "./file-write-queue";

let root: string;
const restores: (() => void)[] = [];
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(join(testEnvironment.isolatedHome, "restore-")));
});
afterEach(async () => {
	restores
		.splice(0)
		.reverse()
		.forEach((restore) => {
			restore();
		});
	setLocalRestoreSemanticsForTests(null);
	await fs.rm(root, { recursive: true, force: true });
});
function state(
	value: string | null,
	mode = process.platform === "win32" ? 0o666 : 0o640,
): KnownFileChangeState {
	return value === null
		? { kind: "absent" }
		: {
				kind: "regular",
				mode,
				blob: { algorithm: "sha256", digest: hash(value), sizeBytes: Buffer.byteLength(value) },
			};
}
async function input(
	before: string | null,
	desired: string | null,
	name = "file.txt",
): Promise<LocalFileRestoreInput> {
	const path = join(root, name);
	if (before !== null) {
		await fs.writeFile(path, before);
		await fs.chmod(path, 0o640);
	}
	const scope: FileChangeScopeIdentity = {
		id: "scope",
		sourceInstanceId: "source",
		deviceId: "local",
		workspaceInstanceId: "workspace",
		pathFlavor: localBackend.pathFlavor as "posix" | "windows",
		canonicalRoot: root,
	};
	return {
		mutationId: randomUUID(),
		requestDigest: hash("attempt"),
		backend: localBackend,
		scope,
		identity: createFileChangeIdentity(scope, {
			deviceId: "local",
			pathFlavor: scope.pathFlavor,
			lexicalPath: path,
			canonicalPath: path,
			objectRole: "referent",
		}),
		expected: state(before),
		desired: state(desired),
		signal: new AbortController().signal,
		authorize: async () => {},
		assertCurrent: () => {},
		onDispatch: () => {},
		readBlob: async (ref) => {
			if (desired === null || hash(desired) !== ref.digest) throw new Error("missing");
			return Buffer.from(desired);
		},
	};
}

describe("single-file restore", () => {
	test.each([
		["before", "after"],
		[null, "created"],
		["before", null],
		["same", "same"],
		[null, null],
	] as const)("restores %s to %s", async (before, desired) => {
		const request = await input(before, desired);
		const result = await restoreLocalFile(request);
		await result.whenSettled;
		expect(result.reason).toBe(before === desired ? "no_change" : "verified");
		expect(result.status).toBe(before === desired ? "not_dispatched" : "applied");
		if (desired === null)
			await expect(fs.lstat(request.identity.canonicalPath)).rejects.toMatchObject({
				code: "ENOENT",
			});
		else expect(await fs.readFile(request.identity.canonicalPath, "utf8")).toBe(desired);
	});
	test("mode-only uses the verified descriptor", async () => {
		const request = await input("same", "same");
		const mode = process.platform === "win32" ? 0o444 : 0o600;
		request.desired = state("same", mode);
		expect((await restoreLocalFile(request)).status).toBe("applied");
		expect((await fs.stat(request.identity.canonicalPath)).mode & 0o7777).toBe(mode);
	});
	test("Windows read-only mode changes retain explicit representable modes", async () => {
		setLocalRestoreSemanticsForTests("win32");
		const request = await input("same", "same");
		await fs.chmod(request.identity.canonicalPath, 0o666);
		request.expected = state("same", 0o666);
		request.desired = state("same", 0o444);
		expect((await restoreLocalFile(request)).status).toBe("applied");
		expect((await fs.stat(request.identity.canonicalPath)).mode & 0o7777).toBe(0o444);
	});
	test("Windows read-only deletion and unrepresentable execute bits fail before IO", async () => {
		setLocalRestoreSemanticsForTests("win32");
		const request = await input("same", null);
		await fs.chmod(request.identity.canonicalPath, 0o444);
		request.expected = state("same", 0o444);
		expect((await restoreLocalFile(request)).reason).toBe("permission_denied");
		request.desired = state("same", 0o777);
		request.readBlob = async () => Buffer.from("same");
		const invalidMode = await restoreLocalFile(request);
		expect(invalidMode.status).toBe("not_dispatched");
		expect(invalidMode.reason).toBe("unsupported_object");
		expect(await fs.readFile(request.identity.canonicalPath, "utf8")).toBe("same");
	});
	test("preflight leaves content unchanged", async () => {
		const request = await input("before", "after");
		let dispatches = 0;
		request.onDispatch = () => {
			dispatches++;
		};
		const result = await preflightLocalFileRestore(request);
		await result.whenSettled;
		expect(result.reason).toBe("preflight_verified");
		expect(dispatches).toBe(0);
		expect(await fs.readFile(request.identity.canonicalPath, "utf8")).toBe("before");
	});
	test("changed content and mode refuse before dispatch", async () => {
		const request = await input("before", "after");
		await fs.writeFile(request.identity.canonicalPath, "external");
		const result = await restoreLocalFile(request);
		expect(result.status).toBe("not_dispatched");
		expect(result.reason).toBe("expected_mismatch");
		expect(await fs.readFile(request.identity.canonicalPath, "utf8")).toBe("external");
	});
	test("authorization is checked again immediately before IO", async () => {
		const request = await input("before", "after");
		request.authorize = async (guard) => {
			if (guard.phase === "before_dispatch") throw new Error("revoked");
		};
		const result = await restoreLocalFile(request);
		expect(result.reason).toBe("authorization_failed");
		expect(result.status).toBe("not_dispatched");
	});
	test("replacement during authorization is detected", async () => {
		const request = await input("before", "after");
		request.authorize = async (guard) => {
			if (guard.phase === "before_dispatch") {
				await fs.rename(request.identity.canonicalPath, join(root, "original"));
				await fs.writeFile(request.identity.canonicalPath, "before");
			}
		};
		const result = await restoreLocalFile(request);
		expect(result.status).toBe("not_dispatched");
		expect(result.reason).toBe("expected_mismatch");
	});
	test("verified no-op reads the live object but never requires an archived desired body", async () => {
		const request = await input("unarchived external", "unarchived external");
		let reads = 0;
		request.readBlob = async () => {
			reads++;
			throw new Error("archive unavailable");
		};
		const result = await restoreLocalFile(request);
		await result.whenSettled;
		expect(result).toMatchObject({ status: "not_dispatched", reason: "no_change" });
		expect(result.observation?.state).toEqual(request.expected);
		expect(reads).toBe(0);
		await fs.writeFile(request.identity.canonicalPath, "changed after preview");
		const changed = await restoreLocalFile(request);
		await changed.whenSettled;
		expect(changed).toMatchObject({ status: "not_dispatched", reason: "expected_mismatch" });
		expect(reads).toBe(0);
	});
	test("corrupt desired bytes refuse before dispatch", async () => {
		const request = await input("before", "after");
		request.readBlob = async () => Buffer.from("wrong");
		const result = await restoreLocalFile(request);
		expect(result.status).toBe("not_dispatched");
		expect(result.reason).toBe("blob_invalid");
	});
	test("symlink target and hardlinks are refused", async () => {
		const request = await input("before", "after");
		await fs.link(request.identity.canonicalPath, join(root, "hardlink"));
		expect((await restoreLocalFile(request)).reason).toBe("unsupported_object");
		await fs.unlink(join(root, "hardlink"));
		await fs.rename(request.identity.canonicalPath, join(root, "real"));
		await fs.symlink(join(root, "real"), request.identity.canonicalPath);
		expect((await restoreLocalFile(request)).status).toBe("not_dispatched");
	});
	test("new files use exclusive creation after last guard", async () => {
		const request = await input(null, "after");
		request.authorize = async (guard) => {
			if (guard.phase === "before_dispatch")
				await fs.writeFile(request.identity.canonicalPath, "external");
		};
		expect((await restoreLocalFile(request)).status).toBe("not_dispatched");
		expect(await fs.readFile(request.identity.canonicalPath, "utf8")).toBe("external");
	});
	test("creates bounded missing parents", async () => {
		const request = await input(null, "after", "a/b/file");
		request.createParents = true;
		expect((await restoreLocalFile(request)).status).toBe("applied");
		expect(await fs.readFile(request.identity.canonicalPath, "utf8")).toBe("after");
	});
	test("cancellation before start leaves file unchanged", async () => {
		const request = await input("before", "after");
		request.signal = AbortSignal.abort();
		expect((await restoreLocalFile(request)).status).toBe("not_dispatched");
		expect(await fs.readFile(request.identity.canonicalPath, "utf8")).toBe("before");
	});
	test("timeout reports unknown while queue retains actual IO lifetime", async () => {
		const request = await input("before", null);
		request.timeoutMs = 15;
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const unlink = fs.unlink;
		const spy = spyOn(fs, "unlink").mockImplementation(async (path) => {
			entered.resolve();
			await gate.promise;
			return unlink(path);
		});
		restores.push(() => spy.mockRestore());
		// Expire the real restore deadline only after unlink has started. A wall-clock
		// 15ms race can otherwise abort preflight, leaving `entered` unresolved on CI.
		const realSetTimeout = globalThis.setTimeout;
		let expire: (() => void) | undefined;
		const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const [callback, delay, ...callbackArgs] = args;
			const timer = realSetTimeout(callback, delay, ...callbackArgs);
			if (delay === request.timeoutMs && typeof callback === "function") {
				clearTimeout(timer);
				expire = () => callback(...callbackArgs);
			}
			return timer;
		}) as typeof setTimeout);
		restores.push(() => timerSpy.mockRestore());
		const response = Promise.withResolvers<Awaited<ReturnType<typeof restoreLocalFile>>>();
		const first = withFileWrite(request.identity, async () => {
			const result = await restoreLocalFile(request);
			response.resolve(result);
			await result.whenSettled;
		});
		let secondStarted = false;
		let second: Promise<void> | undefined;
		try {
			await Promise.race([
				entered.promise,
				response.promise.then((result) => {
					throw new Error(`Restore finished before IO: ${result.status}/${result.reason}`);
				}),
			]);
			if (!expire) throw new Error("Restore deadline was not registered");
			expire();
			const result = await response.promise;
			expect(result.status).toBe("uncertain_after_dispatch");
			expect(result.reason).toBe("timeout");
			expect(result.ioPending).toBe(true);
			second = withFileWrite(request.identity, () => {
				secondStarted = true;
			});
			await Promise.resolve();
			expect(secondStarted).toBe(false);
		} finally {
			gate.resolve();
			await first;
			await second;
		}
		expect(secondStarted).toBe(true);
	});
});
