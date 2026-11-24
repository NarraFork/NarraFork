import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type PluginUpdateErrorCode,
	pluginSourceSchema,
	type ResolvedPluginRelease,
} from "@shared/plugin-source";
import { getNarraforkPath } from "../../lib/narrafork-home";
import { WorkerCleanupError } from "../../lib/worker-runtime/lifecycle";
import {
	downloadPluginArchive,
	hashPluginArchive,
	type PluginHashWorker,
} from "../plugin-source-download";
import { PluginSourceFailure } from "../plugin-source-resolvers";

const source = pluginSourceSchema.parse({
	type: "website",
	updateApi: "https://plugins.example/latest",
	downloadOrigins: ["https://cdn.example/"],
});
const bytes = new TextEncoder().encode("A test plugin archive ".repeat(4_000));
const digest = async (content: Uint8Array<ArrayBuffer>) =>
	Buffer.from(await crypto.subtle.digest("SHA-256", content)).toString("hex");
let root: string;
let release: ResolvedPluginRelease;
beforeEach(async () => {
	const parent = getNarraforkPath("source-download-tests");
	await mkdir(parent, { recursive: true });
	root = await mkdtemp(join(parent, "run-"));
	release = {
		pluginId: "io.example.plugin",
		version: "1.2.3",
		sha256: await digest(bytes),
		size: bytes.byteLength,
		artifact: { type: "http", url: "https://plugins.example/test.nfplugin" },
	};
});
afterEach(async () => {
	mock.restore();
	await rm(root, { recursive: true, force: true });
});
function options(response: Response) {
	return {
		signal: new AbortController().signal,
		stagingRoot: root,
		transport: { key: "public", isCurrent: () => true, fetch: mock(async () => response) },
		getBuiltin: () => undefined,
	};
}
async function failure(promise: Promise<unknown>, code: PluginUpdateErrorCode) {
	try {
		await promise;
		throw new Error("Expected failure");
	} catch (error) {
		expect(error).toBeInstanceOf(PluginSourceFailure);
		expect((error as PluginSourceFailure).code).toBe(code);
	}
}

describe("streamed plugin source archive download", () => {
	test("writes a private staging file, verifies SHA in a Worker and cleans only its own staging", async () => {
		const ctx = options(
			new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }),
		);
		const progress: number[] = [];
		const mainHash = spyOn(crypto, "createHash").mockImplementation(() => {
			throw new Error("Forbidden hash on the main thread");
		});
		const archive = await downloadPluginArchive(source, release, {
			...ctx,
			onProgress: (count) => progress.push(count),
		});
		expect(await readFile(archive.path)).toEqual(Buffer.from(bytes));
		expect(mainHash).not.toHaveBeenCalled();
		expect(progress.at(-1)).toBe(bytes.byteLength);
		expect(ctx.transport.fetch).toHaveBeenCalledTimes(1);
		await archive.cleanup();
		expect(await readdir(root)).toEqual([]);
	});

	test("rejects wrong hash while preserving every preexisting installed file", async () => {
		await writeFile(join(root, "old-installed-package.txt"), "untouched");
		await failure(
			downloadPluginArchive(
				source,
				{ ...release, sha256: "0".repeat(64) },
				options(new Response(bytes)),
			),
			"hash_mismatch",
		);
		expect(await readFile(join(root, "old-installed-package.txt"), "utf8")).toBe("untouched");
		expect(await readdir(root)).toEqual(["old-installed-package.txt"]);
	});

	test("rejects declared size, oversized streaming and truncated archive bodies", async () => {
		for (const response of [
			new Response(bytes, { headers: { "content-length": String(bytes.byteLength + 1) } }),
			new Response(bytes.subarray(1)),
			new Response(new Uint8Array(bytes.byteLength + 1)),
		])
			await failure(downloadPluginArchive(source, release, options(response)), "size_mismatch");
		expect(await readdir(root)).toEqual([]);
	});

	test("rejects requests exceeding the 100 MiB hard budget before any network or allocation", async () => {
		const ctx = options(new Response(bytes));
		await failure(
			downloadPluginArchive(source, { ...release, size: 100 * 1024 * 1024 + 1 }, ctx),
			"invalid_release",
		);
		expect(ctx.transport.fetch).not.toHaveBeenCalled();
	});

	test("follows only explicitly approved origins and never forwards credentials", async () => {
		const ctx = options(new Response(bytes));
		ctx.transport.fetch.mockImplementationOnce(
			async () =>
				new Response(null, {
					status: 302,
					headers: { Location: "https://cdn.example/test.nfplugin" },
				}),
		);
		const archive = await downloadPluginArchive(source, release, ctx);
		expect(ctx.transport.fetch).toHaveBeenCalledTimes(2);
		const raw = JSON.stringify(ctx.transport.fetch.mock.calls);
		expect(raw).not.toMatch(/Authorization|Bearer|Cookie|nfs_/i);
		await archive.cleanup();
		await failure(
			downloadPluginArchive(
				source,
				release,
				options(
					new Response(null, {
						status: 302,
						headers: { Location: "https://evil.example/test.nfplugin" },
					}),
				),
			),
			"unsafe_url",
		);
	});

	test("parent cancellation covers an abort-ignoring stream and removes staged bytes", async () => {
		const ctx = options(new Response(new ReadableStream({ pull: () => new Promise(() => {}) })));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new PluginSourceFailure("cancelled")), 10);
		await failure(
			downloadPluginArchive(source, release, { ...ctx, signal: controller.signal }),
			"cancelled",
		);
		clearTimeout(timer);
		expect(await readdir(root)).toEqual([]);
	});

	test("local archives are checked against the current descriptor and still hashed in a Worker", async () => {
		const localSource = { type: "local" as const, builtinId: release.pluginId };
		const ctx = options(new Response(bytes));
		const local = { ...release, artifact: { type: "local" as const, builtinId: release.pluginId } };
		const archive = await downloadPluginArchive(localSource, local, {
			...ctx,
			getBuiltin: () => ({
				pluginId: release.pluginId,
				version: release.version,
				displayName: "Builtin",
				source: localSource,
				load: async () => ({ bytes, sha256: release.sha256 }),
			}),
		});
		expect(await readFile(archive.path)).toEqual(Buffer.from(bytes));
		expect(ctx.transport.fetch).not.toHaveBeenCalled();
		await archive.cleanup();
	});
});

describe("archive hash Worker fault injection never falls back to main-thread work", () => {
	function worker(event?: "error" | "exit" | "message", value?: unknown): PluginHashWorker {
		const emitter = new EventEmitter() as EventEmitter & { terminate(): Promise<number> };
		emitter.terminate = mock(async () => {
			queueMicrotask(() => emitter.emit("exit", 0));
			return 0;
		});
		if (event) queueMicrotask(() => emitter.emit(event, value));
		return emitter;
	}
	test("creation failure or an explicitly disabled worker fails without local hashing", async () => {
		const mainHash = spyOn(crypto, "createHash");
		for (const message of ["creation failed", "worker disabled"]) {
			await failure(
				hashPluginArchive("unused-path", {
					signal: new AbortController().signal,
					workerFactory: () => {
						throw new Error(message);
					},
				}),
				"apply_failed",
			);
		}
		expect(mainHash).not.toHaveBeenCalled();
	});

	test("worker crash, exit and invalid success messages are explicit errors", async () => {
		const mainHash = spyOn(crypto, "createHash");
		for (const [event, value] of [
			["error", new Error("worker crash")],
			["exit", 0],
			["message", { sha256: "bad", size: 10 }],
		] as const) {
			await failure(
				hashPluginArchive("unused-path", {
					signal: new AbortController().signal,
					workerFactory: () => worker(event, value),
				}),
				"apply_failed",
			);
		}
		expect(mainHash).not.toHaveBeenCalled();
	});

	test("termination failure remains an owned isolation error and never falls back to main-thread hashing", async () => {
		const stalled = worker();
		stalled.terminate = mock(async () => {
			throw new Error("native termination not confirmed");
		});
		const mainHash = spyOn(crypto, "createHash");
		await expect(
			hashPluginArchive("unused-path", {
				signal: new AbortController().signal,
				timeoutMs: 5,
				closeTimeoutMs: 5,
				workerFactory: () => stalled,
			}),
		).rejects.toBeInstanceOf(WorkerCleanupError);
		expect(stalled.terminate).toHaveBeenCalledTimes(1);
		expect(mainHash).not.toHaveBeenCalled();
	});

	test("timeout and cancellation terminate the worker without returning a zero hash", async () => {
		const stalled = worker();
		await failure(
			hashPluginArchive("unused-path", {
				signal: new AbortController().signal,
				timeoutMs: 10,
				workerFactory: () => stalled,
			}),
			"apply_failed",
		);
		expect(stalled.terminate).toHaveBeenCalledTimes(1);
		const cancelled = worker();
		const controller = new AbortController();
		const pending = hashPluginArchive("unused-path", {
			signal: controller.signal,
			workerFactory: () => cancelled,
		});
		controller.abort(new PluginSourceFailure("cancelled"));
		await failure(pending, "cancelled");
		expect(cancelled.terminate).toHaveBeenCalledTimes(1);
	});
});
