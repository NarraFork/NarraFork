import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../lib/logger";
import type { RevertSelectionResult } from "./revert-selection-service";
import type { TransactionManifestRequest } from "./revert-transaction-manifest-worker";
import {
	RevertTransactionError,
	revertManifestWorkerEntryPoint,
	revertManifestWorkerSpecifiers,
	runRevertManifestWorker,
} from "./revert-transaction-worker";

// The compare action tests exact equality, independent of selection schema validation.
const selection = { metadataDigest: "fixed" } as RevertSelectionResult;
const request: TransactionManifestRequest = {
	action: "compare",
	fixed: selection,
	current: selection,
};
const realWorker = new URL("./revert-transaction-manifest-worker.ts", import.meta.url).href;
const ready = 'parentPort.postMessage({ type: "revert-manifest-worker-ready", version: 1 });';
let root: string;
let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "revert-worker-test-"));
	warn = spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(async () => {
	warn.mockRestore();
	await rm(root, { recursive: true, force: true });
});

async function fixture(name: string, source: string): Promise<string> {
	const path = join(root, `${name}.ts`);
	await writeFile(path, `import { parentPort } from "node:worker_threads";\n${source}`);
	return pathToFileURL(path).href;
}
const signal = () => AbortSignal.timeout(10_000);

describe("revert manifest worker resolution", () => {
	test("source uses TypeScript; compiled builds probe bounded JavaScript entries", () => {
		expect(
			revertManifestWorkerSpecifiers(false, "file:///workspace/server/services/jobs.ts"),
		).toEqual(["file:///workspace/server/services/revert-transaction-manifest-worker.ts"]);
		expect(revertManifestWorkerSpecifiers(true, "file:///$bunfs/root/narrafork")).toEqual([
			"file:///$bunfs/root/services/revert-transaction-manifest-worker.js",
			"file:///$bunfs/root/server/services/revert-transaction-manifest-worker.js",
			"file:///$bunfs/root/revert-transaction-manifest-worker.js",
		]);
	});
	test("Windows embedded entries preserve forward-slash virtual keys", () => {
		for (const root of ["file:///B:/~BUN/root/", "file:///B:/%7EBUN/root/"]) {
			expect(
				revertManifestWorkerSpecifiers(true, `${root}narrafork.exe`).map(
					revertManifestWorkerEntryPoint,
				),
			).toEqual([
				"B:/~BUN/root/services/revert-transaction-manifest-worker.js",
				"B:/~BUN/root/server/services/revert-transaction-manifest-worker.js",
				"B:/~BUN/root/revert-transaction-manifest-worker.js",
			]);
		}
	});
	test("ordinary file URLs and Linux virtual URLs retain URL handling", () => {
		for (const specifier of [
			"file:///C:/workspace%20name/worker.ts",
			"file:///workspace/worker.ts",
			"file:///$bunfs/root/services/worker.js",
		]) {
			const entry = revertManifestWorkerEntryPoint(specifier);
			expect(entry).toBeInstanceOf(URL);
			expect(String(entry)).toBe(specifier);
		}
	});
});

describe("revert manifest worker lifecycle", () => {
	test("real source worker acknowledges readiness before comparing", async () => {
		await expect(runRevertManifestWorker<boolean>(request, signal())).resolves.toBe(true);
		expect(warn).not.toHaveBeenCalled();
	});
	test("missing pre-ready entry can fall through to the real worker", async () => {
		await expect(
			runRevertManifestWorker(request, signal(), {
				specifiers: [pathToFileURL(join(root, "missing.ts")).href, realWorker],
			}),
		).resolves.toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
	});
	test("startup probing is bounded to three candidates", async () => {
		const missing = pathToFileURL(join(root, "missing.ts")).href;
		await expect(
			runRevertManifestWorker(request, signal(), {
				specifiers: [missing, missing, missing, realWorker],
			}),
		).rejects.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_WORKER_FAILED" });
		expect(warn).toHaveBeenCalledTimes(3);
	});
	test("synchronous entry errors are sanitized and can probe the next entry", async () => {
		await expect(
			runRevertManifestWorker(request, signal(), { specifiers: ["not-a-url", realWorker] }),
		).resolves.toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
	});
	test("startup exceptions are logged with bounded details, not exposed to callers", async () => {
		const secret = `${root}/${"sensitive".repeat(300)}`;
		const specifier = await fixture("startup-error", `throw new Error(${JSON.stringify(secret)});`);
		await expect(
			runRevertManifestWorker(request, signal(), { specifiers: [specifier] }),
		).rejects.toMatchObject({
			code: "REVERT_TRANSACTION_MANIFEST_WORKER_FAILED",
			message: "Local revert transaction refused: MANIFEST_WORKER_FAILED",
		});
		expect(warn).toHaveBeenCalledTimes(1);
		const details = warn.mock.calls[0]?.[1];
		expect(String(details?.error)).toContain(root);
		expect(String(details?.error).length).toBeLessThanOrEqual(1024);
		expect(String(details?.specifier).length).toBeLessThanOrEqual(1024);
	});
	test("early exit is refused without hanging", async () => {
		const specifier = await fixture("early-exit", "parentPort.close();");
		await expect(
			runRevertManifestWorker(request, signal(), { specifiers: [specifier] }),
		).rejects.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_WORKER_EXITED" });
	});
	test("no request is dispatched before a valid readiness handshake", async () => {
		const marker = join(root, "dispatched");
		const specifier = await fixture(
			"wrong-handshake",
			`import { writeFileSync } from "node:fs";
parentPort.on("message", () => writeFileSync(${JSON.stringify(marker)}, "dispatched"));
parentPort.postMessage({ value: true });`,
		);
		await expect(
			runRevertManifestWorker(request, signal(), { specifiers: [specifier] }),
		).rejects.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_WORKER_PROTOCOL" });
		expect(await Bun.file(marker).exists()).toBe(false);
	});
	test("startup timeout terminates the worker without dispatch", async () => {
		const marker = join(root, "dispatched");
		const specifier = await fixture(
			"never-ready",
			`import { writeFileSync } from "node:fs";
parentPort.on("message", () => writeFileSync(${JSON.stringify(marker)}, "dispatched"));`,
		);
		await expect(
			runRevertManifestWorker(request, signal(), { specifiers: [specifier], readyTimeoutMs: 100 }),
		).rejects.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_WORKER_TIMEOUT" });
		expect(await Bun.file(marker).exists()).toBe(false);
	});
	test("an already-cancelled request never starts a worker", async () => {
		const marker = join(root, "started");
		const specifier = await fixture(
			"should-not-start",
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "started");`,
		);
		const reason = new Error("cancelled before start");
		await expect(
			runRevertManifestWorker(request, AbortSignal.abort(reason), { specifiers: [specifier] }),
		).rejects.toBe(reason);
		expect(await Bun.file(marker).exists()).toBe(false);
		expect(warn).not.toHaveBeenCalled();
	});
	test("cancellation during startup does not try the next candidate", async () => {
		const specifier = await fixture("waiting", 'parentPort.on("message", () => {});');
		await expect(
			runRevertManifestWorker(request, AbortSignal.timeout(100), {
				specifiers: [specifier, realWorker],
			}),
		).rejects.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_CANCELLED" });
		expect(warn).not.toHaveBeenCalled();
	});
	test("real validation rejection is returned, not retried", async () => {
		await expect(
			runRevertManifestWorker(
				{ ...request, current: { ...selection, metadataDigest: "changed" } },
				signal(),
				{ specifiers: [realWorker, realWorker] },
			),
		).rejects.toMatchObject({ code: "REVERT_TRANSACTION_SELECTION_STALE" });
		expect(warn).not.toHaveBeenCalled();
	});
	for (const kind of ["validation", "crash", "exit", "malformed", "sensitive-error"] as const) {
		test(`post-ready ${kind} failure never dispatches twice`, async () => {
			const marker = join(root, "executions");
			const action = {
				validation: 'parentPort.postMessage({ error: "SELECTION_STALE" });',
				crash: 'throw new Error("crashed after dispatch");',
				exit: "process.exit(1);",
				malformed: "parentPort.postMessage(null);",
				"sensitive-error": `parentPort.postMessage({ error: ${JSON.stringify(`${root}/private manifest text`)} });`,
			}[kind];
			const specifier = await fixture(
				kind,
				`import { appendFileSync } from "node:fs";
parentPort.on("message", () => {
 appendFileSync(${JSON.stringify(marker)}, "x");
 ${action}
});
${ready}`,
			);
			const code = {
				validation: "SELECTION_STALE",
				crash: "MANIFEST_WORKER_FAILED",
				exit: "MANIFEST_WORKER_EXITED",
				malformed: "MANIFEST_WORKER_PROTOCOL",
				"sensitive-error": "INVALID_MANIFEST",
			}[kind];
			await expect(
				runRevertManifestWorker(request, signal(), { specifiers: [specifier, specifier] }),
			).rejects.toMatchObject({
				code: `REVERT_TRANSACTION_${code}`,
				message: `Local revert transaction refused: ${code}`,
			});
			expect(await readFile(marker, "utf8")).toBe("x");
			expect(warn).not.toHaveBeenCalled();
		});
	}
	test("cancellation after dispatch terminates without retrying", async () => {
		const marker = join(root, "executions");
		const controller = new AbortController();
		const watcher = watch(root, (_event, name) => {
			if (name === "executions") controller.abort();
		});
		try {
			const specifier = await fixture(
				"cancel-after-dispatch",
				`import { appendFileSync } from "node:fs";
parentPort.on("message", () => appendFileSync(${JSON.stringify(marker)}, "x"));
${ready}`,
			);
			await expect(
				runRevertManifestWorker(request, AbortSignal.any([controller.signal, signal()]), {
					specifiers: [specifier, specifier],
				}),
			).rejects.toBeInstanceOf(RevertTransactionError);
			expect(controller.signal.aborted).toBe(true);
			expect(await readFile(marker, "utf8")).toBe("x");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			watcher.close();
		}
	});
});
